#![cfg_attr(windows, windows_subsystem = "windows")]

mod bridge;
mod database;
mod desktop_profile;
mod control;
mod media;
#[cfg(target_os = "macos")]
mod notch;
#[cfg(target_os = "macos")]
mod window_chrome;
#[cfg(windows)]
mod pdf_windows;
mod notebooks;

use serde_json::{json, Value};
use std::{
    collections::HashMap,
    path::PathBuf,
    sync::{
        atomic::{AtomicBool, Ordering},
        Mutex,
    },
    time::{Duration, Instant},
};
use tauri::{Emitter, Manager};
use tauri_plugin_clipboard_manager::ClipboardExt;

pub struct Native {
    db: Mutex<rusqlite::Connection>,
    directory: PathBuf,
    pending: Mutex<HashMap<String, std::sync::mpsc::Sender<Value>>>,
    pairing: Mutex<Option<Instant>>,
    bridge_error: Mutex<Option<String>>,
    ready: AtomicBool,
    qa: bool,
    started: Instant,
    ready_ms: Mutex<Option<f64>>,
    pdf_busy: AtomicBool,
}

#[tauri::command]
fn load_index(state: tauri::State<Native>) -> Result<Value, String> {
    database::index(&*state.db.lock().map_err(|_| "Database unavailable")?)
}

#[tauri::command]
fn runtime_info(state: tauri::State<Native>) -> Value {
    json!({"qa":state.qa,"platform":std::env::consts::OS})
}

#[tauri::command]
fn write_clipboard(app: tauri::AppHandle, text: String) -> Result<(), String> {
    if text.len() > 8 * 1024 * 1024 {
        return Err("Clipboard text exceeds 8 MB".into());
    }
    app.clipboard()
        .write_text(text)
        .map_err(|_| "Cannot write the system clipboard".into())
}

#[tauri::command]
fn qa_enable_pairing(state: tauri::State<Native>) -> Result<(), String> {
    if !state.qa {
        return Err("QA mode is disabled".into());
    }
    *state.pairing.lock().unwrap() = Some(Instant::now() + Duration::from_secs(120));
    Ok(())
}

#[tauri::command]
fn search_assets(state: tauri::State<Native>, query: String) -> Result<Vec<String>, String> {
    if query.len() > 1000 {
        return Err("Search query exceeds limit".into());
    }
    let db = state.db.lock().map_err(|_| "Database unavailable")?;
    let indexed = query.chars().count() >= 3;
    let body_clause = if indexed {
        "rowid IN (SELECT rowid FROM note_search WHERE note_search MATCH ?2)"
    } else {
        "instr(lower(coalesce(body,'')),lower(?1))>0"
    };
    let sql=format!("SELECT id FROM records WHERE kind='assets' AND ({body_clause} OR instr(lower(coalesce(json_extract(metadata,'$.title'),'') || ' ' || coalesce(json_extract(metadata,'$.value'),'') || ' ' || coalesce(json_extract(metadata,'$.details'),'') || ' ' || coalesce(json_extract(metadata,'$.situation'),'')),lower(?1))>0)");
    let mut statement = db.prepare(&sql).map_err(|_| "Search unavailable")?;
    let phrase = format!("\"{}\"", query.replace('"', "\"\""));
    let parameters = if indexed {
        vec![query, phrase]
    } else {
        vec![query]
    };
    let rows = statement
        .query_map(rusqlite::params_from_iter(parameters), |row| {
            row.get::<_, String>(0)
        })
        .map_err(|_| "Search failed")?;
    rows.collect::<Result<Vec<_>, _>>()
        .map_err(|_| "Search failed".into())
}

#[tauri::command]
fn asset_backlinks(
    state: tauri::State<Native>,
    href: String,
    asset_id: String,
) -> Result<Vec<String>, String> {
    database::backlinks(
        &*state.db.lock().map_err(|_| "Database unavailable")?,
        &href,
        &asset_id,
    )
}

#[tauri::command]
fn save_changes(app: tauri::AppHandle, state: tauri::State<Native>, operations: Vec<Value>) -> Result<(), String> {
    database::apply(
        &mut *state.db.lock().map_err(|_| "Database unavailable")?,
        &operations,
    )?;
    #[cfg(target_os = "macos")]
    if operations.iter().any(|op| op["key"] == "asset-ledger-transfer-v1" || op.get("kind").is_some()) { notch::changed(&app); }
    #[cfg(not(target_os = "macos"))]
    let _ = app;
    Ok(())
}

#[tauri::command]
fn read_body(state: tauri::State<Native>, kind: String, id: String) -> Result<Value, String> {
    database::body(
        &*state.db.lock().map_err(|_| "Database unavailable")?,
        &kind,
        &id,
    )
}

#[tauri::command]
fn finish_quit(app: tauri::AppHandle) {
    app.state::<Native>().ready.store(false, Ordering::SeqCst);
    app.exit(0);
}

#[tauri::command]
fn read_image(state: tauri::State<Native>, src: String) -> Result<Value, String> {
    use base64::Engine;
    let (bytes, mime) = media::read(&state.directory.join("attachments"), &src)?;
    Ok(json!({"base64":base64::engine::general_purpose::STANDARD.encode(bytes),"mime":mime}))
}

#[tauri::command]
async fn import_image(
    app: tauri::AppHandle,
    bytes: Vec<u8>,
    name: String,
) -> Result<Value, String> {
    tauri::async_runtime::spawn_blocking(move || {
        media::import(
            &app.state::<Native>().directory.join("attachments"),
            &bytes,
            &name,
        )
    })
    .await
    .map_err(|_| "Image import failed")?
}

#[tauri::command]
async fn choose_images(app: tauri::AppHandle) -> Result<Value, String> {
    let window = app
        .get_webview_window("main")
        .ok_or("Main window unavailable")?;
    let selected = rfd::AsyncFileDialog::new()
        .set_parent(&window)
        .add_filter("Images", &["png", "jpg", "jpeg", "gif", "webp"])
        .pick_files()
        .await;
    let mut results = Vec::new();
    if let Some(files) = selected {
        for file in files {
            let meta = std::fs::metadata(file.path()).map_err(|_| "Cannot read selected image")?;
            if meta.len() > 20 * 1024 * 1024 {
                return Err("Image exceeds 20 MB".into());
            }
            results.push(import_image(app.clone(), file.read().await, file.file_name()).await?);
        }
    }
    Ok(json!(results))
}

#[tauri::command]
async fn export_pdf(app: tauri::AppHandle, title: String, html: String) -> Result<Value, String> {
    let clean: String = title
        .chars()
        .filter(|c| !c.is_control() && !['/', '\\', ':'].contains(c))
        .take(180)
        .collect();
    let html = media::pdf_html(&app.state::<Native>().directory.join("attachments"), &html)?;
    let window = app
        .get_webview_window("main")
        .ok_or("Main window unavailable")?;
    let file = rfd::AsyncFileDialog::new()
        .set_parent(&window)
        .set_file_name(format!("{clean}.pdf"))
        .add_filter("PDF", &["pdf"])
        .save_file()
        .await;
    let Some(file) = file else {
        return Ok(json!({"cancelled":true}));
    };
    perform_pdf(&app, html, file.path().to_path_buf()).await?;
    Ok(json!({"cancelled":false,"path":file.path()}))
}

async fn perform_pdf(
    app: &tauri::AppHandle,
    html: String,
    destination: PathBuf,
) -> Result<(), String> {
    if app.state::<Native>().pdf_busy.swap(true, Ordering::SeqCst) {
        return Err("A PDF export is already running".into());
    }
    struct ExportGuard(tauri::AppHandle);
    impl Drop for ExportGuard {
        fn drop(&mut self) {
            self.0
                .state::<Native>()
                .pdf_busy
                .store(false, Ordering::SeqCst);
        }
    }
    let _guard = ExportGuard(app.clone());
    #[cfg(windows)]
    { pdf_windows::export(app, html, destination).await }
    #[cfg(target_os = "macos")]
    {
    let helper = app
        .path()
        .resource_dir()
        .map_err(|_| "Cannot find PDF helper")?
        .join("bin/ledger-pdf");
    let helper = if helper.exists() {
        helper
    } else {
        #[cfg(debug_assertions)]
        {
        PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("bin/ledger-pdf")
        }
        #[cfg(not(debug_assertions))]
        { return Err("PDF helper is missing from the application bundle".into()); }
    };
    let directory = app.state::<Native>().directory.clone();
    tauri::async_runtime::spawn_blocking(move || {
        let id = uuid::Uuid::new_v4();
        let input = directory.join(format!("print-{id}.html"));
        let output = directory.join(format!("print-{id}.pdf"));
        media::atomic_write(&input, html.as_bytes())?;
        let result = (|| {
            let mut child = std::process::Command::new(helper)
                .arg(&input)
                .arg(&output)
                .stdout(std::process::Stdio::null())
                .stderr(std::process::Stdio::null())
                .spawn()
                .map_err(|_| "Cannot start native PDF helper")?;
            let deadline = Instant::now() + Duration::from_secs(50);
            loop {
                if let Some(status) = child.try_wait().map_err(|_| "Cannot wait for PDF helper")? {
                    if !status.success() {
                        return Err("Native PDF printing failed".into());
                    }
                    break;
                }
                if Instant::now() > deadline {
                    let _ = child.kill();
                    let _ = child.wait();
                    return Err("PDF printing timed out".into());
                }
                std::thread::sleep(Duration::from_millis(30));
            }
            let bytes = std::fs::read(&output).map_err(|_| "PDF output missing")?;
            if !bytes.starts_with(b"%PDF-") {
                return Err("Invalid PDF output".into());
            }
            media::atomic_write(&destination, &bytes)
        })();
        let _ = std::fs::remove_file(input);
        let _ = std::fs::remove_file(output);
        result
    })
    .await
    .map_err(|_| "PDF task failed")?
    }
}

#[tauri::command]
fn window_action(window: tauri::WebviewWindow, action: String) -> Result<(), String> {
    match action.as_str() {
        "minimize" => window.minimize(),
        "maximize" => {
            if window.is_maximized().unwrap_or(false) {
                window.unmaximize()
            } else {
                window.maximize()
            }
        }
        "close" => window.hide(),
        _ => return Err("Unknown window action".into()),
    }
    .map_err(|_| "Window operation failed".into())
}

#[tauri::command]
fn open_external(url: String) -> Result<(), String> {
    let parsed = url::Url::parse(&url).map_err(|_| "Invalid URL")?;
    if !["https", "http", "mailto"].contains(&parsed.scheme())
        || !parsed.username().is_empty()
        || parsed.password().is_some()
    {
        return Err("Unsupported external URL".into());
    }
    open::that_detached(url)
        .map_err(|_| "Cannot open URL")?;
    Ok(())
}

#[tauri::command]
async fn save_markdown(app: tauri::AppHandle, title: String, text: String) -> Result<(), String> {
    let clean: String = title
        .chars()
        .filter(|c| !c.is_control() && !['/', '\\', ':'].contains(c))
        .take(180)
        .collect();
    let window = app
        .get_webview_window("main")
        .ok_or("Main window unavailable")?;
    if let Some(file) = rfd::AsyncFileDialog::new()
        .set_parent(&window)
        .set_file_name(format!("{clean}.md"))
        .add_filter("Markdown", &["md"])
        .save_file()
        .await
    {
        media::atomic_write(file.path(), text.as_bytes())?;
    }
    Ok(())
}

#[tauri::command]
fn reply_browser(state: tauri::State<Native>, reply: Value) -> Result<(), String> {
    let id = reply["id"].as_str().ok_or("Missing request ID")?;
    if let Some(sender) = state
        .pending
        .lock()
        .map_err(|_| "Bridge unavailable")?
        .remove(id)
    {
        let _ = sender.send(reply);
    }
    Ok(())
}

#[tauri::command]
async fn manage_browser(app: tauri::AppHandle) -> Result<(), String> {
    if app.state::<Native>().bridge_error.lock().unwrap().is_some() {
        return Err("Browser port 4281 is unavailable".into());
    }
    let count: u32 = app
        .state::<Native>()
        .db
        .lock()
        .unwrap()
        .query_row("SELECT count(*) FROM connections", [], |row| row.get(0))
        .map_err(|_| "Cannot read connection count")?;
    let window = app
        .get_webview_window("main")
        .ok_or("Main window unavailable")?;
    let result = rfd::AsyncMessageDialog::new()
        .set_parent(&window)
        .set_title("浏览器连接")
        .set_description(format!(
            "已连接 {count} 个扩展。开启后，两分钟内在浏览器扩展中输入六位配对码。"
        ))
        .set_buttons(rfd::MessageButtons::YesNoCancelCustom(
            "开启配对".into(),
            "撤销全部连接".into(),
            "取消".into(),
        ))
        .show()
        .await;
    match result {
        rfd::MessageDialogResult::Custom(label) if label == "开启配对" => {
            *app.state::<Native>().pairing.lock().unwrap() =
                Some(Instant::now() + Duration::from_secs(120))
        }
        rfd::MessageDialogResult::Custom(label) if label == "撤销全部连接" => {
            app.state::<Native>()
                .db
                .lock()
                .unwrap()
                .execute("DELETE FROM connections", [])
                .map_err(|_| "Cannot revoke connections")?;
            *app.state::<Native>().pairing.lock().unwrap() = None;
        }
        _ => {}
    }
    Ok(())
}

#[tauri::command]
fn client_ready(app: tauri::AppHandle, state: tauri::State<Native>) -> Value {
    #[cfg(not(target_os = "macos"))]
    let _ = &app;
    state.ready.store(true, Ordering::SeqCst);
    let mut ready = state.ready_ms.lock().unwrap();
    let first = ready.is_none();
    let elapsed = *ready.get_or_insert_with(|| state.started.elapsed().as_secs_f64() * 1000.0);
    let result = json!({"qa":state.qa,"startupMs":elapsed,"bridgeError":state.bridge_error.lock().unwrap().clone()});
    if state.qa && first {
        let _ = media::atomic_write(
            &state.directory.join("qa-ready.json"),
            result.to_string().as_bytes(),
        );
    }
    #[cfg(target_os = "macos")]
    if first && !state.qa { notch::auto_connect(app); }
    result
}

#[tauri::command]
fn qa_report(state: tauri::State<Native>, report: Value) -> Result<(), String> {
    if !state.qa {
        return Err("QA mode is disabled".into());
    }
    media::atomic_write(
        &state.directory.join("qa-report.json"),
        report.to_string().as_bytes(),
    )
}

#[cfg(target_os = "macos")]
#[tauri::command]
fn qa_window_chrome(window: tauri::WebviewWindow, state: tauri::State<Native>) -> Result<Value, String> {
    if !state.qa { return Err("QA mode is disabled".into()); }
    window_chrome::align(&window)
}

#[tauri::command]
async fn qa_pdf(app: tauri::AppHandle, html: String) -> Result<(), String> {
    if !app.state::<Native>().qa {
        return Err("QA mode is disabled".into());
    }
    let directory = app.state::<Native>().directory.clone();
    let html = media::pdf_html(&directory.join("attachments"), &html)?;
    perform_pdf(&app, html, directory.join("qa-print.pdf")).await
}

fn main() {
    #[cfg(unix)]
    if std::env::args().nth(1).as_deref() == Some("graph") { std::process::exit(notechain::cli::execute(std::env::args().skip(1).collect())); }
    let started = Instant::now();
    let qa = cfg!(feature = "qa") && (std::env::args().any(|arg| arg == "--qa") || std::env::var("ASSET_LEDGER_QA").as_deref() == Ok("1"));
    if qa && std::env::var_os("ASSET_LEDGER_DEV_DATA").is_none() {
        panic!("QA requires an explicit synthetic data directory");
    }
    let builder = tauri::Builder::default()
        .register_asynchronous_uri_scheme_protocol("ledger-image", |context, request, responder| {
            let directory = context.app_handle().state::<Native>().directory.join("attachments");
            tauri::async_runtime::spawn_blocking(move || {
                let valid = request.uri().host() == Some("localhost") && request.method() == "GET";
                let result = if valid { media::read(&directory, &format!("/attachments{}", request.uri().path())) } else { Err("Invalid image request".into()) };
                let response = match result {
                    Ok((bytes, mime)) => tauri::http::Response::builder().status(200)
                        .header("Content-Type", mime).header("X-Content-Type-Options", "nosniff")
                        .header("Cache-Control", "private, max-age=31536000, immutable").body(bytes).unwrap(),
                    Err(_) => tauri::http::Response::builder().status(404)
                        .header("Cache-Control", "no-store").body(Vec::new()).unwrap(),
                };
                responder.respond(response);
            });
        })
        .plugin(tauri_plugin_clipboard_manager::init())
        .plugin(tauri_plugin_single_instance::init(|app,args,_| { for value in args.iter().skip(1) { if !value.starts_with('-') { notebooks::open_file(app, std::path::Path::new(value)); } } if let Some(window)=app.get_webview_window("main") {let _=window.show();let _=window.set_focus();} }))
        .setup(move |app| {
            #[cfg(unix)]
            use std::os::unix::fs::PermissionsExt;
            let directory = match std::env::var_os("ASSET_LEDGER_DEV_DATA") {
                Some(directory) => PathBuf::from(directory),
                None => desktop_profile::directory(&app.path().app_config_dir()?.join("desktop-profile.json"), app.path().app_data_dir()?)?,
            };
            std::fs::create_dir_all(directory.join("attachments"))?;
            #[cfg(unix)]
            std::fs::set_permissions(&directory,std::fs::Permissions::from_mode(0o700))?;
            let db = database::open(&directory.join("ledger.sqlite3"))?;
            app.manage(notebooks::Notebooks::new(&directory).map_err(std::io::Error::other)?);
            app.manage(Native{db:Mutex::new(db),directory:directory.clone(),pending:Mutex::new(HashMap::new()),pairing:Mutex::new(None),bridge_error:Mutex::new(None),ready:AtomicBool::new(false),qa,started,ready_ms:Mutex::new(None),pdf_busy:AtomicBool::new(false)});
            #[cfg(target_os = "macos")]
            notch::start(app.handle())?;
            let entry=if qa { std::env::var("ASSET_LEDGER_QA_ROUTE").ok().filter(|s|(s.starts_with("/cases/") || s.starts_with("/notebooks"))&&!s.contains('\\')).map(|s|s.trim_start_matches('/').to_string()).unwrap_or("index.html".into()) } else {"index.html".into()};
            let window = tauri::WebviewWindowBuilder::new(app,"main",tauri::WebviewUrl::App(entry.into()))
                .title(if qa { "Notechain - Test" } else { "Notechain" }).inner_size(1180.0,820.0).min_inner_size(680.0,480.0)
                .data_directory(directory.join("webview"))
                .disable_drag_drop_handler()
                .on_navigation(|url| matches!(url.scheme(),"tauri"|"http"|"https") && matches!(url.host_str(),Some("localhost"|"tauri.localhost"|"127.0.0.1")));
            #[cfg(target_os = "macos")]
            let window = window
                .data_directory(directory.join("webkit"))
                .title_bar_style(tauri::TitleBarStyle::Overlay)
                .hidden_title(true)
                .traffic_light_position(tauri::LogicalPosition::new(14.0, 27.0))
                .background_throttling(tauri::utils::config::BackgroundThrottlingPolicy::Disabled);
            #[cfg(windows)]
            let window = window.decorations(false);
            let window = window.build()?;
            notebooks::drain_open(app.handle());
            for argument in std::env::args().skip(1).filter(|arg| !arg.starts_with('-')) {
                notebooks::open_file(app.handle(), std::path::Path::new(&argument));
            }
            let handle=app.handle().clone();
            #[cfg(target_os = "macos")]
            window_chrome::install(&window).map_err(std::io::Error::other)?;
            #[cfg(target_os = "macos")]
            let chrome_window = window.clone();
            window.on_window_event(move |event| {
                #[cfg(target_os = "macos")]
                if matches!(event, tauri::WindowEvent::Resized(_) | tauri::WindowEvent::ScaleFactorChanged { .. } | tauri::WindowEvent::Focused(true)) {
                    window_chrome::schedule(&chrome_window);
                }
                if let tauri::WindowEvent::CloseRequested{api,..}=event { api.prevent_close(); let _=handle.emit_to("main","ledger-close",json!({"quit":cfg!(windows)})); }
            });
            bridge::start(app.handle().clone());
            control::start(app.handle())?;
            if qa {
                let handle=app.handle().clone();
                std::thread::spawn(move || loop {
                    if !handle.state::<Native>().ready.load(Ordering::SeqCst) { std::thread::sleep(Duration::from_millis(50)); continue; }
                    let command=directory.join("qa-command.json");
                    if let Ok(bytes)=std::fs::read(&command) {
                        let _=std::fs::remove_file(&command);
                        if let Ok(value)=serde_json::from_slice::<Value>(&bytes) {
                            if let (Some(id),Some(script))=(value["id"].as_str(),value["script"].as_str()) {
                                let script=format!("(async()=>{{{script}}})().then(value=>window.__ledgerTest.invoke('qa_report',{{report:{{id:{},value}}}})).catch(error=>window.__ledgerTest.invoke('qa_report',{{report:{{id:{},error:String(error),stack:error.stack}}}}));",json!(id),json!(id));
                                if let Some(window)=handle.get_webview_window("main") {let _=window.eval(script);}
                            }
                        }
                    }
                    std::thread::sleep(Duration::from_millis(50));
                });
            }
            Ok(())
        });
    macro_rules! commands {
        ($($platform:path),* $(,)?) => { tauri::generate_handler![notebooks::notebook,load_index,save_changes,read_body,read_image,import_image,choose_images,export_pdf,window_action,open_external,save_markdown,reply_browser,manage_browser,client_ready,qa_report,qa_pdf,finish_quit,runtime_info,search_assets,asset_backlinks,qa_enable_pairing,write_clipboard,$($platform),*] };
    }
    #[cfg(target_os = "macos")]
    let builder = builder.invoke_handler(commands!(qa_window_chrome,notch::notch_connect,notch::notch_status,notch::notch_show_main,notch::qa_notch_session));
    #[cfg(windows)]
    let builder = builder.invoke_handler(commands!());
    builder
        .build(tauri::generate_context!())
        .expect("Cannot initialize Notechain")
        .run(|app, event| match event {
            tauri::RunEvent::Exit => { if let Some(control) = app.try_state::<control::Control>() { control.cleanup(); } }
            #[cfg(target_os = "macos")]
            tauri::RunEvent::Opened { urls } => {
                for url in urls { if let Ok(path) = url.to_file_path() { notebooks::open_file(app, &path); } }
            }
            #[cfg(target_os = "macos")]
            tauri::RunEvent::Reopen { .. } => {
                if let Some(window) = app.get_webview_window("main") {
                    let _ = window.show();
                    let _ = window.set_focus();
                }
            }
            tauri::RunEvent::ExitRequested { api, .. }
                if app.state::<Native>().ready.load(Ordering::SeqCst) =>
            {
                api.prevent_exit();
                let _ = app.emit_to("main", "ledger-close", json!({"quit":true}));
            }
            _ => {}
        });
}
