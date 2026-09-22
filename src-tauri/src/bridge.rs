use crate::{media::hash, Native};
use rusqlite::{params, OptionalExtension};
use serde_json::{json, Value};
use std::{
    sync::{Arc, Mutex, atomic::{AtomicBool, Ordering}},
    time::{Duration, Instant},
};
use tauri::{Emitter, Manager};
use hyper::{body::{Bytes, Incoming}, Method, Request as HttpRequest, Response};
use http_body_util::{BodyExt, Full, Limited};
use hyper_util::rt::{TokioIo, TokioTimer};
use tokio::sync::Semaphore;

struct Request {
    method: Method,
    url: String,
    headers: hyper::HeaderMap,
    body: Value,
}
impl Request {
    fn method(&self) -> &Method { &self.method }
    fn url(&self) -> &str { &self.url }
}
struct Bridge {
    app: tauri::AppHandle,
    expected_host: String,
    requests: Arc<Semaphore>,
    serial: Mutex<()>,
    pairing: AtomicBool,
}

type Failure = (u16, String);
fn failure(status: u16, message: &str) -> Failure {
    (status, message.into())
}
fn bounded(input: &Value, key: &str, max: usize, required: bool) -> Result<String, Failure> {
    let value = match input.get(key) {
        None if !required => "",
        Some(Value::String(s)) => s,
        _ => return Err(failure(400, "Invalid field")),
    };
    if value.encode_utf16().count() > max || (required && value.trim().is_empty()) {
        return Err(failure(400, "Field is empty or exceeds limit"));
    }
    Ok(value.into())
}
pub fn validate(input: &Value) -> Result<Value, Failure> {
    let id = bounded(input, "id", 80, true)?;
    if id.len() < 8
        || !id
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b == b'_' || b == b'-')
    {
        return Err(failure(400, "Invalid capture ID"));
    }
    let mode = input["mode"]
        .as_str()
        .filter(|s| ["asset", "tray"].contains(s))
        .ok_or(failure(400, "Invalid capture mode"))?;
    let url = url::Url::parse(&bounded(input, "url", 12000, true)?)
        .map_err(|_| failure(400, "Invalid URL"))?;
    if !["http", "https"].contains(&url.scheme())
        || !url.username().is_empty()
        || url.password().is_some()
    {
        return Err(failure(
            400,
            "Only HTTP(S) without credentials is supported",
        ));
    }
    let mut result = json!({"id":id,"mode":mode,"url":url.as_str(),"title":bounded(input,"title",1000,false)?,"text":bounded(input,"text",24000,false)?,"caseId":bounded(input,"caseId",100,mode=="asset")?,"targetId":if input["targetId"].is_null(){Value::Null}else{json!(bounded(input,"targetId",100,false)?)}});
    if !input["anchor"].is_null() {
        result["anchor"] = json!({"heading":bounded(&input["anchor"],"heading",1000,false)?,"exact":bounded(&input["anchor"],"exact",24000,false)?,"prefix":bounded(&input["anchor"],"prefix",200,false)?,"suffix":bounded(&input["anchor"],"suffix",200,false)?});
    }
    Ok(result)
}

pub(crate) fn dispatch(app: &tauri::AppHandle, method: &str, payload: Value) -> Result<Value, Failure> {
    let state = app.state::<Native>();
    if !state.ready.load(Ordering::SeqCst) {
        return Err(failure(503, "Client is starting"));
    }
    let id = uuid::Uuid::new_v4().to_string();
    let (tx, rx) = std::sync::mpsc::channel();
    state.pending.lock().unwrap().insert(id.clone(), tx);
    if app
        .emit_to(
            "main",
            "ledger-browser-request",
            json!({"id":id,"method":method,"payload":payload}),
        )
        .is_err()
    {
        state.pending.lock().unwrap().remove(&id);
        return Err(failure(503, "Client is unavailable"));
    }
    let received = rx.recv_timeout(Duration::from_secs(15));
    state.pending.lock().unwrap().remove(&id);
    let reply = received.map_err(|_| failure(503, "Client did not persist the request in time"))?;
    if reply["error"].is_object() {
        return Err(failure(
            reply["error"]["status"]
                .as_u64()
                .unwrap_or(503)
                .clamp(400, 599) as u16,
            reply["error"]["message"].as_str().unwrap_or("Save failed"),
        ));
    }
    Ok(reply["value"].clone())
}

fn header(request: &Request, key: &str) -> Option<String> {
    request.headers.get(key).and_then(|value| value.to_str().ok()).map(String::from)
}
fn origin_valid(origin: &str) -> bool {
    origin
        .strip_prefix("chrome-extension://")
        .is_some_and(|id| id.len() == 32 && id.bytes().all(|c| (b'a'..=b'p').contains(&c)))
}

fn handle(app: &tauri::AppHandle, request: &Request, origin: &str, pairing: &AtomicBool) -> Result<Value, Failure> {
    if header(request, "x-asset-ledger").as_deref() != Some("1") {
        return Err(failure(403, "Missing connection identity"));
    }
    let url = url::Url::parse(&format!("http://127.0.0.1{}", request.url()))
        .map_err(|_| failure(400, "Invalid URL"))?;
    let route = url
        .path()
        .strip_prefix("/bridge/v1")
        .filter(|s| s.starts_with('/'))
        .ok_or(failure(404, "Unknown route"))?;
    let state = app.state::<Native>();
    if route != "/pair" {
        let token = header(request, "authorization")
            .and_then(|h| h.strip_prefix("Bearer ").map(String::from))
            .ok_or(failure(401, "Pair this browser first"))?;
        let stored: Option<String> = state
            .db
            .lock()
            .unwrap()
            .query_row(
                "SELECT hash FROM connections WHERE origin=?1",
                [origin],
                |r| r.get(0),
            )
            .optional()
            .map_err(|_| failure(503, "Database unavailable"))?;
        if stored.as_deref() != Some(&hash(token.as_bytes())) {
            return Err(failure(401, "Pair this browser first"));
        }
    }
    let body = &request.body;
    match (route, request.method()) {
        ("/pair", &Method::POST) => {
            if !state
                .pairing
                .lock()
                .unwrap()
                .is_some_and(|until| Instant::now() < until)
            {
                return Err(failure(403, "Enable pairing in the client first"));
            }
            if pairing.swap(true, Ordering::SeqCst) { return Err(failure(429, "A pairing confirmation is already pending")); }
            struct PairGuard<'a>(&'a AtomicBool);
            impl Drop for PairGuard<'_> { fn drop(&mut self) { self.0.store(false,Ordering::SeqCst); } }
            let _guard = PairGuard(pairing);
            let code = body["code"]
                .as_str()
                .filter(|s| s.len() == 6 && s.bytes().all(|c| c.is_ascii_digit()))
                .ok_or(failure(400, "Six-digit pairing code required"))?;
            let window = app
                .get_webview_window("main")
                .ok_or(failure(503, "Main window unavailable"))?;
            let confirmed = (state.qa
                && std::env::var("ASSET_LEDGER_QA_CONSENT").as_deref()
                    == Ok("synthetic-extension"))
                || tauri::async_runtime::block_on(
                    rfd::AsyncMessageDialog::new()
                        .set_parent(&window)
                        .set_title("确认浏览器配对")
                        .set_description(format!(
                            "配对码：{code}\n扩展：{origin}\n请与浏览器显示的代码核对。"
                        ))
                        .set_buttons(rfd::MessageButtons::YesNo)
                        .show(),
                ) == rfd::MessageDialogResult::Yes;
            if !confirmed {
                return Err(failure(403, "Pairing cancelled"));
            }
            use rand::RngCore;
            let mut random = [0u8; 32];
            rand::rng().fill_bytes(&mut random);
            let token = random
                .iter()
                .map(|b| format!("{b:02x}"))
                .collect::<String>();
            state.db.lock().unwrap().execute("INSERT INTO connections(origin,hash) VALUES(?1,?2) ON CONFLICT(origin) DO UPDATE SET hash=excluded.hash",params![origin,hash(token.as_bytes())]).map_err(|_|failure(503,"Pairing could not be saved"))?;
            *state.pairing.lock().unwrap() = None;
            Ok(json!({"token":token}))
        }
        ("/context", &Method::GET) => dispatch(app, "context", json!({})),
        ("/tray", &Method::GET) => {
            let fields = url
                .query_pairs()
                .collect::<std::collections::HashMap<_, _>>();
            let offset = fields
                .get("offset")
                .and_then(|v| v.parse::<u32>().ok())
                .unwrap_or(0);
            let limit = fields
                .get("limit")
                .and_then(|v| v.parse::<u32>().ok())
                .unwrap_or(30)
                .clamp(1, 30);
            dispatch(app, "tray", json!({"offset":offset,"limit":limit}))
        }
        ("/capture", &Method::POST) => {
            let input = validate(&body)?;
            let id = input["id"].as_str().unwrap();
            let fingerprint = hash(input.to_string().as_bytes());
            let receipt: Option<(String, String)> = state
                .db
                .lock()
                .unwrap()
                .query_row(
                    "SELECT fingerprint,result FROM receipts WHERE origin=?1 AND id=?2",
                    params![origin, id],
                    |r| Ok((r.get(0)?, r.get(1)?)),
                )
                .optional()
                .map_err(|_| failure(503, "Cannot read receipt"))?;
            if let Some((existing, result)) = receipt {
                if existing != fingerprint {
                    return Err(failure(409, "Capture ID content conflict"));
                }
                return serde_json::from_str(&result).map_err(|_| failure(503, "Invalid receipt"));
            }
            let result = dispatch(app, "capture", input.clone())?;
            state
                .db
                .lock()
                .unwrap()
                .execute(
                    "INSERT INTO receipts VALUES(?1,?2,?3,?4)",
                    params![origin, id, fingerprint, result.to_string()],
                )
                .map_err(|_| failure(503, "Cannot save receipt"))?;
            Ok(result)
        }
        ("/tray/remove", &Method::POST) => dispatch(
            app,
            "tray-remove",
            json!({"id":bounded(&body,"id",100,true)?}),
        ),
        _ => Err(failure(404, "Unknown route")),
    }
}

async fn read_json<B>(body: B, duration: Duration) -> Result<Value, Failure>
where B: hyper::body::Body<Data = Bytes>, B::Error: Into<Box<dyn std::error::Error + Send + Sync>> {
    let collected = tokio::time::timeout(duration, Limited::new(body,128*1024).collect()).await
        .map_err(|_|failure(408,"Request body timed out"))?
        .map_err(|error| if error.is::<http_body_util::LengthLimitError>() {failure(413,"Request exceeds limit")} else {failure(400,"Cannot read request")})?;
    serde_json::from_slice(&collected.to_bytes()).map_err(|_|failure(400,"Invalid JSON"))
}

fn response(result: Result<Value,Failure>, origin: Option<&str>, options: bool) -> Response<Full<Bytes>> {
    let (status,value) = match result {
        Ok(value) => (if options {204} else {200},value),
        Err((status,message)) => (status,json!({"error":status,"message":message})),
    };
    let mut builder=Response::builder().status(status)
        .header("content-type","application/json; charset=utf-8")
        .header("cache-control","no-store").header("x-content-type-options","nosniff")
        .header("connection","close");
    if let Some(origin)=origin {
        builder=builder.header("access-control-allow-origin",origin).header("vary","Origin")
            .header("access-control-allow-methods","GET, POST, OPTIONS")
            .header("access-control-allow-headers","Authorization, Content-Type, X-Asset-Ledger, X-Asset-Ledger-Origin")
            .header("access-control-allow-private-network","true");
    }
    builder.body(Full::new(Bytes::from(if status==204 {String::new()} else {value.to_string()}))).unwrap()
}

async fn serve(bridge: Arc<Bridge>, incoming: HttpRequest<Incoming>) -> Result<Response<Full<Bytes>>,std::convert::Infallible> {
    let (parts,body)=incoming.into_parts();
    let mut request=Request { method:parts.method, url:parts.uri.path_and_query().map(|v|v.as_str()).unwrap_or("/").into(), headers:parts.headers, body:Value::Null };
    let origin=header(&request,"origin").or_else(|| if request.method==Method::GET {header(&request,"x-asset-ledger-origin")} else {None}).unwrap_or_default();
    if header(&request,"host").as_deref()!=Some(bridge.expected_host.as_str()) || !origin_valid(&origin) {
        return Ok(response(Err(failure(403,"Only paired browser extensions may connect")),None,false));
    }
    if request.method==Method::OPTIONS { return Ok(response(Ok(Value::Null),Some(&origin),true)); }
    let permit=match bridge.requests.clone().try_acquire_owned() {
        Ok(permit)=>permit,Err(_)=>return Ok(response(Err(failure(429,"Capture queue is busy")),Some(&origin),false)),
    };
    if request.method==Method::POST {
        if !header(&request,"content-type").is_some_and(|v|v.starts_with("application/json")) { return Ok(response(Err(failure(415,"JSON required")),Some(&origin),false)); }
        if header(&request,"content-length").and_then(|n|n.parse::<usize>().ok()).is_some_and(|n|n>128*1024) { return Ok(response(Err(failure(413,"Request exceeds limit")),Some(&origin),false)); }
        match read_json(body,Duration::from_secs(15)).await {
            Ok(value)=>request.body=value,Err(error)=>return Ok(response(Err(error),Some(&origin),false)),
        }
    }
    let state=bridge.clone(); let client_origin=origin.clone();
    let result=tauri::async_runtime::spawn_blocking(move || {
        let _permit=permit;
        if request.url=="/bridge/v1/pair" { handle(&state.app,&request,&client_origin,&state.pairing) }
        else { let _serial=state.serial.lock().unwrap(); handle(&state.app,&request,&client_origin,&state.pairing) }
    }).await.unwrap_or_else(|_|Err(failure(503,"Client is unavailable")));
    Ok(response(result,Some(&origin),false))
}

pub fn start(app: tauri::AppHandle) {
    let port=if app.state::<Native>().qa {std::env::var("ASSET_LEDGER_QA_BRIDGE_PORT").ok().and_then(|v|v.parse::<u16>().ok()).unwrap_or(4281)} else {4281};
    let listener=match std::net::TcpListener::bind(("127.0.0.1",port)) {
        Ok(listener)=>listener,Err(_)=>{*app.state::<Native>().bridge_error.lock().unwrap()=Some("Browser port 4281 is unavailable".into());return;}
    };
    if listener.set_nonblocking(true).is_err() { *app.state::<Native>().bridge_error.lock().unwrap()=Some("Browser listener could not start".into());return; }
    let bridge=Arc::new(Bridge {expected_host:format!("127.0.0.1:{}",listener.local_addr().unwrap().port()),app,requests:Arc::new(Semaphore::new(32)),serial:Mutex::new(()),pairing:AtomicBool::new(false)});
    tauri::async_runtime::spawn(async move {
        let listener=match tokio::net::TcpListener::from_std(listener) {Ok(listener)=>listener,Err(_)=>return};
        let connections=Arc::new(Semaphore::new(24));
        while let Ok((stream,_))=listener.accept().await {
            let Ok(permit)=connections.clone().try_acquire_owned() else {continue};
            let state=bridge.clone();
            tauri::async_runtime::spawn(async move {
                let _permit=permit;
                let service=hyper::service::service_fn(move |request|serve(state.clone(),request));
                let _=hyper::server::conn::http1::Builder::new().timer(TokioTimer::new())
                    .header_read_timeout(Duration::from_secs(10)).max_headers(32).max_buf_size(16*1024)
                    .serve_connection(TokioIo::new(stream),service).await;
            });
        }
    });
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn body_limits_and_deadlines_are_enforced() {
        struct Pending;
        impl hyper::body::Body for Pending {
            type Data = Bytes;
            type Error = std::convert::Infallible;
            fn poll_frame(self: std::pin::Pin<&mut Self>, _: &mut std::task::Context<'_>) -> std::task::Poll<Option<Result<hyper::body::Frame<Bytes>,Self::Error>>> { std::task::Poll::Pending }
        }
        let runtime=tokio::runtime::Builder::new_current_thread().enable_time().build().unwrap();
        runtime.block_on(async {
            assert_eq!(read_json(Full::new(Bytes::from_static(b"{}")),Duration::from_secs(1)).await.unwrap(),json!({}));
            assert_eq!(read_json(Full::new(Bytes::from(vec![0;128*1024+1])),Duration::from_secs(1)).await.unwrap_err().0,413);
            assert_eq!(read_json(Pending,Duration::from_millis(5)).await.unwrap_err().0,408);
        });
    }
    #[test]
    fn extension_identity_and_capture_limits() {
        assert!(origin_valid(
            "chrome-extension://aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
        ));
        assert!(!origin_valid("https://example.com"));
        let mut input = json!({"id":"capture_1","mode":"asset","url":"https://example.com","caseId":"c","text":"中文"});
        assert!(validate(&input).is_ok());
        input["text"] = json!("中".repeat(24001));
        assert!(validate(&input).is_err());
        input["text"] = json!("");
        input["url"] = json!("https://user:password@example.com");
        assert!(validate(&input).is_err());
    }
}
