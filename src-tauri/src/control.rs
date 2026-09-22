use crate::{bridge, Native};
use serde_json::{json, Value};
use std::{io::{BufRead, BufReader, Read, Write}, path::PathBuf, sync::{Arc, Mutex, atomic::{AtomicUsize, Ordering}}, time::Duration};
use tauri::Manager;
#[cfg(unix)]
use std::os::unix::{fs::PermissionsExt, net::UnixListener};

const MAX_REQUEST: u64 = 2 * 1024 * 1024;
pub struct Control { directory: PathBuf, descriptor: PathBuf, identity: Value }
impl Control {
    pub fn cleanup(&self) {
        if std::fs::read(&self.descriptor).ok().and_then(|b| serde_json::from_slice::<Value>(&b).ok()).as_ref() == Some(&self.identity) {
            let _ = std::fs::remove_file(&self.descriptor);
        }
        #[cfg(unix)]
        { let _ = std::fs::remove_file(self.directory.join("control.sock")); }
        let _ = std::fs::remove_dir(&self.directory);
    }
}

pub fn start(app: &tauri::AppHandle) -> Result<(), Box<dyn std::error::Error>> {
    let state = app.state::<Native>();
    let config = if state.qa { state.directory.clone() } else { app.path().app_config_dir()? };
    std::fs::create_dir_all(&config)?;
    let token: Option<String>;
    let mut identity: Value;
    // Keep Unix socket paths short, including on macOS with long per-user temp paths.
    #[cfg(unix)]
    let directory = PathBuf::from(format!("/tmp/al-{}", uuid::Uuid::new_v4().simple()));
    #[cfg(windows)]
    let directory = config.join(format!("control-{}", uuid::Uuid::new_v4()));
    std::fs::create_dir(&directory)?;
    #[cfg(unix)]
    let listener = {
        std::fs::set_permissions(&directory, std::fs::Permissions::from_mode(0o700))?;
        let socket = directory.join("control.sock");
        let listener = UnixListener::bind(&socket)?;
        std::fs::set_permissions(&socket, std::fs::Permissions::from_mode(0o600))?;
        identity = json!({"version":1,"socket":socket});
        token = None;
        listener
    };
    #[cfg(windows)]
    let listener = {
        // Loopback plus a per-launch 256-bit capability avoids shell/pipe-name escaping.
        let listener = std::net::TcpListener::bind((std::net::Ipv4Addr::LOCALHOST, 0))?;
        token = Some(format!("{}{}", uuid::Uuid::new_v4().simple(), uuid::Uuid::new_v4().simple()));
        identity = json!({"version":2,"transport":"tcp","address":listener.local_addr()?.to_string(),"token":token});
        listener
    };
    identity["pid"] = json!(std::process::id());
    let descriptor = config.join("control.json");
    crate::media::atomic_write(&descriptor, identity.to_string().as_bytes())?;
    app.manage(Control { directory, descriptor, identity });
    let handle = app.clone();
    let active = Arc::new(AtomicUsize::new(0));
    let serial = Arc::new(Mutex::new(()));
    std::thread::spawn(move || {
        for connection in listener.incoming() {
            let Ok(mut stream) = connection else { continue };
            if active.fetch_add(1, Ordering::SeqCst) >= 8 { active.fetch_sub(1, Ordering::SeqCst); continue; }
            let count = active.clone(); let app = handle.clone(); let serial = serial.clone(); let token = token.clone();
            std::thread::spawn(move || {
                struct Guard(Arc<AtomicUsize>);
                impl Drop for Guard { fn drop(&mut self) { self.0.fetch_sub(1, Ordering::SeqCst); } }
                let _guard = Guard(count);
                let _ = stream.set_read_timeout(Some(Duration::from_secs(5)));
                let _ = stream.set_write_timeout(Some(Duration::from_secs(10)));
                let result = read_request(&mut stream).and_then(|mut request| {
                    if let Some(token) = token {
                        let supplied = request.as_object_mut().and_then(|o| o.remove("token"));
                        if supplied.as_ref().and_then(Value::as_str) != Some(token.as_str()) { return Err((401, "Invalid local connection token".into())); }
                    }
                    let _lock = serial.try_lock().map_err(|_| (429, "Another local request is running".into()))?;
                    bridge::dispatch(&app, "architecture", request)
                });
                let response = match result { Ok(value) => json!({"ok":true,"value":value}), Err((status,message)) => json!({"ok":false,"error":{"status":status,"message":message}}) };
                let _ = writeln!(stream, "{response}");
            });
        }
    });
    Ok(())
}

fn read_request(stream: &mut impl Read) -> Result<Value, (u16, String)> {
    let mut line = String::new();
    BufReader::new(stream.take(MAX_REQUEST + 1)).read_line(&mut line).map_err(|_| (400, "Cannot read request".into()))?;
    if line.len() as u64 > MAX_REQUEST || !line.ends_with('\n') { return Err((413, "Request must be a JSON line under 2 MB".into())); }
    serde_json::from_str(&line).map_err(|_| (400, "Invalid JSON".into()))
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn local_protocol_rejects_unterminated_and_invalid_json() {
        for (bytes, expected) in [(b"{}\n".as_slice(), 0), (b"{}".as_slice(), 413), (b"bad\n".as_slice(), 400)] {
            assert_eq!(read_request(&mut &bytes[..]).err().map(|error| error.0).unwrap_or(0), expected);
        }
    }
}
