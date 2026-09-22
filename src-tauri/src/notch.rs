use crate::Native;
use http_body_util::{BodyExt, Full, Limited};
use hyper::{body::{Bytes, Incoming}, Request, Response, Method};
use hyper_util::rt::{TokioIo, TokioTimer};
use serde_json::{json, Value};
use std::{io::Write, process::{Command, Stdio}, sync::{Mutex, Arc, atomic::{AtomicBool, Ordering}}, time::Duration};
use tauri::{Emitter, Manager};
use tokio::sync::{watch, Semaphore};

pub struct Notch {
    port: u16,
    token: Mutex<Option<String>>,
    changing: AtomicBool,
    serial: Mutex<()>,
    changes: watch::Sender<u64>,
}

pub fn changed(app: &tauri::AppHandle) {
    if let Some(state) = app.try_state::<Notch>() { state.changes.send_modify(|revision| *revision = revision.wrapping_add(1)); }
}

fn identity(app: &tauri::AppHandle) -> String {
    format!("{}{}", app.config().identifier, if app.state::<Native>().qa { ".synthetic" } else { "" })
}

fn atoll(app: &tauri::AppHandle, requests: Value) -> Result<(), String> {
    let bundled = app.path().resource_dir().map_err(|_| "Cannot locate Atoll helper")?.join("bin/ledger-atoll");
    let helper = if bundled.exists() { bundled } else {
        #[cfg(debug_assertions)]
        { std::path::PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("bin/ledger-atoll") }
        #[cfg(not(debug_assertions))]
        { return Err("Atoll helper is missing from the application bundle".into()); }
    };
    let mut child = Command::new(helper).stdin(Stdio::piped()).stdout(Stdio::piped()).stderr(Stdio::null()).spawn().map_err(|_| "Cannot start Atoll helper")?;
    let input = child.stdin.take().ok_or("Cannot contact Atoll helper")?;
    { let mut input = input; input.write_all(requests.to_string().as_bytes()).map_err(|_| "Cannot send Atoll request")?; }
    let output = child.wait_with_output().map_err(|_| "Cannot wait for Atoll")?;
    let replies: Value = serde_json::from_slice(&output.stdout).unwrap_or(Value::Null);
    if let Some(error) = replies.as_array().and_then(|items| items.iter().find_map(|item| item.get("error"))) {
        if error["code"] == -32601 { return Err("当前 Atoll 尚未包含原暂存区的账本联动改动，需要先安装修改版 Atoll".into()); }
        return Err(format!("Atoll: {}", error["message"].as_str().unwrap_or("Request rejected")));
    }
    if !output.status.success() { return Err("Atoll 未响应，请确认已启动并开启扩展服务".into()); }
    Ok(())
}

#[tauri::command]
pub async fn notch_connect(app: tauri::AppHandle, enabled: bool) -> Result<Value, String> {
    app.state::<Native>().db.lock().map_err(|_| "Database unavailable")?
        .execute("INSERT OR REPLACE INTO kv(key,value) VALUES('asset-ledger-atoll-autoconnect',?1)", [if enabled {"true"} else {"false"}])
        .map_err(|_| "Cannot save Atoll connection preference")?;
    connect(app, enabled).await
}

fn auto_connect_enabled(app: &tauri::AppHandle) -> bool {
    app.state::<Native>().db.lock().ok().and_then(|db| {
        db.query_row("SELECT value FROM kv WHERE key='asset-ledger-atoll-autoconnect'", [], |row| row.get::<_, String>(0)).ok()
    }).is_some_and(|value| value == "true")
}

pub fn auto_connect(app: tauri::AppHandle) {
    if !auto_connect_enabled(&app) { return }
    tauri::async_runtime::spawn(async move {
        for attempt in 0..12 {
            if attempt > 0 {
                tokio::time::sleep(Duration::from_secs((1u64 << attempt.min(5)).min(30))).await;
            }
            if !auto_connect_enabled(&app) { break }
            if app.state::<Notch>().token.lock().unwrap().is_some() { break }
            if connect(app.clone(), true).await.is_ok() {
                if !auto_connect_enabled(&app) { let _ = connect(app.clone(), false).await; }
                break;
            }
        }
    });
}

async fn connect(app: tauri::AppHandle, enabled: bool) -> Result<Value, String> {
    let state = app.state::<Notch>();
    if state.changing.swap(true, Ordering::SeqCst) { return Err("Atoll connection is changing".into()); }
    let handle = app.clone();
    let result = tauri::async_runtime::spawn_blocking(move || {
        let state = handle.state::<Notch>();
        let bundle = identity(&handle);
        if !enabled {
            *state.token.lock().unwrap() = None;
            changed(&handle);
            atoll(&handle, json!([{"method":"atoll.disconnectAssetLedger","params":{"bundleIdentifier":bundle}}]))?;
            return Ok(json!({"enabled":false}));
        }
        if state.port == 0 { return Err("刘海本地服务未启动".into()); }
        let token = format!("{}{}", uuid::Uuid::new_v4().simple(), uuid::Uuid::new_v4().simple());
        let endpoint = format!("http://127.0.0.1:{}", state.port);
        let library_id: String = handle.state::<Native>().db.lock().unwrap().query_row("SELECT value FROM kv WHERE key='asset-ledger-library-id'",[],|row|row.get(0)).map_err(|_|"Library unavailable")?;
        *state.token.lock().unwrap() = Some(token.clone());
        let result = atoll(&handle, json!([
            {"method":"atoll.requestAuthorization","params":{"bundleIdentifier":bundle}},
            {"method":"atoll.connectAssetLedger","params":{"bundleIdentifier":bundle,"endpoint":endpoint,"token":token,"libraryId":library_id}}
        ]));
        if result.is_err() { *state.token.lock().unwrap() = None; }
        result?;
        Ok(json!({"enabled":true}))
    }).await.map_err(|_| "Atoll task failed".to_string()).and_then(|result| result);
    state.changing.store(false, Ordering::SeqCst);
    let _ = app.emit("ledger-notch-status", notch_status(app.clone()));
    result
}

#[tauri::command]
pub fn notch_status(app: tauri::AppHandle) -> Value {
    json!({"enabled":app.state::<Notch>().token.lock().unwrap().is_some()})
}

#[tauri::command]
pub fn qa_notch_session(app: tauri::AppHandle) -> Result<Value,String> {
    if !app.state::<Native>().qa { return Err("QA mode is disabled".into()); }
    let state = app.state::<Notch>();
    let token = format!("{}{}",uuid::Uuid::new_v4().simple(),uuid::Uuid::new_v4().simple());
    *state.token.lock().unwrap() = Some(token.clone());
    Ok(json!({"endpoint":format!("http://127.0.0.1:{}",state.port),"token":token}))
}

#[tauri::command]
pub fn notch_show_main(app: tauri::AppHandle) -> Result<(), String> {
    let window = app.get_webview_window("main").ok_or("Main window unavailable")?;
    window.show().and_then(|_| window.set_focus()).map_err(|_| "Cannot show main window".into())
}

fn response(status: u16, mime: &str, bytes: Vec<u8>) -> Response<Full<Bytes>> {
    Response::builder().status(status).header("Content-Type", mime).header("Cache-Control", "no-store")
        .header("X-Content-Type-Options", "nosniff").header("Referrer-Policy", "no-referrer")
        .body(Full::new(Bytes::from(bytes))).unwrap()
}
fn json_response(status: u16, value: Value) -> Response<Full<Bytes>> { response(status, "application/json; charset=utf-8", value.to_string().into_bytes()) }
fn error(status: u16, message: &str) -> Response<Full<Bytes>> { json_response(status, json!({"error":status,"message":message})) }

async fn serve(app: tauri::AppHandle, request: Request<Incoming>) -> Result<Response<Full<Bytes>>, std::convert::Infallible> {
    let state = app.state::<Notch>();
    let expected = format!("127.0.0.1:{}", state.port);
    if request.headers().get("host").and_then(|value| value.to_str().ok()) != Some(expected.as_str()) { return Ok(error(403,"Invalid host")); }
    let path = request.uri().path().to_string();
    let session_token = state.token.lock().unwrap().clone();
    let authorized = session_token.as_ref().is_some_and(|token| request.headers().get("authorization").and_then(|value| value.to_str().ok()) == Some(format!("Bearer {token}").as_str()));
    if !authorized { return Ok(error(401,"刘海连接已关闭，请在账本中重新连接")); }
    if let Some(origin) = request.headers().get("origin") {
        if origin.to_str().ok() != Some(format!("http://{expected}").as_str()) { return Ok(error(403,"Invalid origin")); }
    }
    if request.method() != Method::POST || !["/api", "/changes"].contains(&path.as_str()) { return Ok(error(404,"Unknown route")); }
    if !request.headers().get("content-type").is_some_and(|value| value.as_bytes().starts_with(b"application/json")) { return Ok(error(415,"JSON required")); }
    let collected = match tokio::time::timeout(Duration::from_secs(10), Limited::new(request.into_body(), 128 * 1024).collect()).await {
        Ok(Ok(body)) => body.to_bytes(), _ => return Ok(error(413,"Request is too large or incomplete")),
    };
    let input: Value = match serde_json::from_slice(&collected) { Ok(input) => input, Err(_) => return Ok(error(400,"Invalid JSON")) };
    if path == "/changes" {
        let mut changes = state.changes.subscribe();
        if input["revision"].as_u64() == Some(*changes.borrow()) { let _ = tokio::time::timeout(Duration::from_secs(25), changes.changed()).await; }
        return Ok(json_response(200,json!({"revision":*changes.borrow()})));
    }
    let action = match input["action"].as_str().filter(|action| ["snapshot","capture","preview","open","insert","remove"].contains(action)) { Some(action) => action.to_string(), None => return Ok(error(400,"Unknown action")) };
    let payload = input.get("payload").cloned().unwrap_or(json!({}));
    if !payload.is_object() { return Ok(error(400,"Payload must be an object")); }
    if action == "capture" {
        let valid = payload["id"].as_str().is_some_and(|id| (8..=70).contains(&id.len()) && id.bytes().all(|ch| ch.is_ascii_alphanumeric() || ch == b'_' || ch == b'-'))
            && payload["text"].as_str().is_some_and(|text| !text.trim().is_empty() && text.encode_utf16().count() <= 24000);
        if !valid { return Ok(error(400,"摘录为空或超过 24,000 字符")); }
    }
    let handle = app.clone();
    let result = tauri::async_runtime::spawn_blocking(move || {
        let state = handle.state::<Notch>();
        let _guard = state.serial.lock().unwrap();
        if *state.token.lock().unwrap() != session_token { return Err((401,"Connection revoked".to_string())); }
        crate::bridge::dispatch(&handle, &format!("notch-{action}"), payload)
    }).await.unwrap_or_else(|_| Err((503,"Client unavailable".into())));
    Ok(match result { Ok(value) => json_response(200,value), Err((status,message)) => error(status,&message) })
}

pub fn start(app: &tauri::AppHandle) -> Result<(), String> {
    app.state::<Native>().db.lock().unwrap().execute("INSERT OR IGNORE INTO kv(key,value) VALUES('asset-ledger-library-id',?1)", [uuid::Uuid::new_v4().to_string()]).map_err(|_| "Cannot initialize library identity")?;
    let listener = std::net::TcpListener::bind(("127.0.0.1",0)).map_err(|_| "Cannot start notch listener")?;
    listener.set_nonblocking(true).map_err(|_| "Cannot initialize notch listener")?;
    let (changes, _) = watch::channel(0u64);
    app.manage(Notch { port: listener.local_addr().unwrap().port(), token: Mutex::new(None), changing: AtomicBool::new(false), serial: Mutex::new(()), changes });
    let handle = app.clone();
    tauri::async_runtime::spawn(async move {
        let Ok(listener) = tokio::net::TcpListener::from_std(listener) else { return };
        let permits = Arc::new(Semaphore::new(12));
        while let Ok((stream, _)) = listener.accept().await {
            let Ok(permit) = permits.clone().try_acquire_owned() else { continue };
            let app = handle.clone();
            tauri::async_runtime::spawn(async move {
                let _permit = permit;
                let service = hyper::service::service_fn(move |request| serve(app.clone(), request));
                let _ = hyper::server::conn::http1::Builder::new().timer(TokioTimer::new()).header_read_timeout(Duration::from_secs(10)).max_headers(32).max_buf_size(16*1024).serve_connection(TokioIo::new(stream),service).await;
            });
        }
    });
    Ok(())
}
