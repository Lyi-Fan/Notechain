use crate::{media, Native};
use std::{path::PathBuf, sync::mpsc, time::Duration};
use tauri::Manager;
use webview2_com::{Microsoft::Web::WebView2::Win32::{ICoreWebView2Environment6, ICoreWebView2_7}, PrintToPdfCompletedHandler};
use windows::core::{HSTRING, Interface};

pub async fn export(app: &tauri::AppHandle, html: String, destination: PathBuf) -> Result<(), String> {
    let id = uuid::Uuid::new_v4();
    let directory = app.state::<Native>().directory.clone();
    let input = directory.join(format!("print-{id}.html"));
    let output = directory.join(format!("print-{id}.pdf"));
    media::atomic_write(&input, html.as_bytes())?;
    let result = render(app, &input, &output, &format!("pdf-{id}")).await;
    let result = result.and_then(|()| {
        let bytes = std::fs::read(&output).map_err(|_| "PDF output missing")?;
        if !bytes.starts_with(b"%PDF-") { return Err("Invalid PDF output".into()); }
        media::atomic_write(&destination, &bytes)
    });
    let _ = std::fs::remove_file(input);
    let _ = std::fs::remove_file(output);
    result
}

async fn render(app: &tauri::AppHandle, input: &std::path::Path, output: &std::path::Path, label: &str) -> Result<(), String> {
    let url = url::Url::from_file_path(input).map_err(|_| "Invalid PDF input path")?;
    let allowed = url.clone();
    let expected = url.clone();
    let output = output.to_path_buf();
    let (sender, receiver) = mpsc::channel::<Result<(), String>>();
    // The sanitized document has no scripts or network dependencies. This WebView
    // has no IPC capability and lives only until PrintToPdf completes or times out.
    let window = tauri::WebviewWindowBuilder::new(app, label, tauri::WebviewUrl::External(url))
        .data_directory(app.state::<Native>().directory.join("webview"))
        .visible(false).inner_size(794.0, 1123.0).skip_taskbar(true)
        .on_navigation(move |url| *url == allowed)
        .on_page_load(move |webview, payload| {
            if payload.event() != tauri::webview::PageLoadEvent::Finished || *payload.url() != expected { return; }
            let sender = sender.clone();
            let failure = sender.clone();
            let output = output.clone();
            let result = webview.with_webview(move |native| {
                let result = (|| -> windows::core::Result<()> {
                    unsafe {
                        let core: ICoreWebView2_7 = native.controller().CoreWebView2()?.cast()?;
                        let environment: ICoreWebView2Environment6 = native.environment().cast()?;
                        let settings = environment.CreatePrintSettings()?;
                        settings.SetPageWidth(8.2677)?;
                        settings.SetPageHeight(11.6929)?;
                        settings.SetShouldPrintBackgrounds(true)?;
                        settings.SetShouldPrintHeaderAndFooter(false)?;
                        let completed = sender.clone();
                        core.PrintToPdf(&HSTRING::from(output.as_os_str()), &settings,
                            &PrintToPdfCompletedHandler::create(Box::new(move |status, success| {
                                let result = status.map_err(|e| format!("WebView2 PDF failed: {e}"))
                                    .and_then(|()| if success { Ok(()) } else { Err("WebView2 could not print the document".into()) });
                                let _ = completed.send(result);
                                Ok(())
                            })))?;
                    }
                    Ok(())
                })();
                if let Err(error) = result { let _ = sender.send(Err(format!("Cannot start WebView2 printing: {error}"))); }
            });
            if let Err(error) = result { let _ = failure.send(Err(format!("Cannot access print WebView: {error}"))); }
        }).build().map_err(|e| format!("Cannot create PDF WebView: {e}"))?;
    let result = tauri::async_runtime::spawn_blocking(move || {
        receiver.recv_timeout(Duration::from_secs(50)).map_err(|_| "WebView2 PDF printing timed out".to_string())?
    }).await.map_err(|_| "PDF task failed".to_string()).and_then(|result| result);
    let _ = window.destroy();
    result
}
