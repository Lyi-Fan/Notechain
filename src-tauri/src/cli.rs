use crate::json_io;
use serde_json::{json, Value};
use std::{io::{BufRead, BufReader, Read, Write}, path::PathBuf, time::Duration};

const MAX_REQUEST: u64 = 2 * 1024 * 1024;
const HELP: &str = "Notechain CLI\n  ledger graph cases\n  ledger graph get CASE_ID [--sources ID,ID]\n  ledger graph generate CASE_ID [--reset-layout] [--preview]\n  ledger graph apply CASE_ID --file PATCH.json|- [--preview]\n\nOptions: --connection FILE, --output FILE\nInput: UTF-8 (with or without BOM), or BOM-marked UTF-16.\nOutput: one ASCII-safe JSON value on stdout; --output writes UTF-8 JSON to a file.\nThe desktop app must be running. Exit codes: 0 success, 1 failure.\nUse get to obtain IDs and revision before apply. apply is atomic; requestId is retry-safe.\nPatch fields: revision, requestId, nodes, edges, remove, positions, collapsed, restoreHidden.\nNote bodies are omitted unless --sources is supplied (maximum 20 IDs).";

pub fn execute(args: Vec<String>) -> i32 {
    match run(&args) { Ok(()) => 0, Err(message) => { eprintln!("{message}"); 1 } }
}

fn descriptor_path() -> Result<PathBuf, String> {
    if let Some(path) = std::env::var_os("ASSET_LEDGER_CONNECTION") { return Ok(path.into()); }
    #[cfg(windows)]
    let path = PathBuf::from(std::env::var_os("APPDATA").ok_or("APPDATA is unavailable; use --connection FILE")?).join("io.github.lyi-fan.notechain/control.json");
    #[cfg(not(windows))]
    let path = PathBuf::from(std::env::var_os("HOME").ok_or("HOME is unavailable; use --connection FILE")?).join("Library/Application Support/io.github.lyi-fan.notechain/control.json");
    Ok(path)
}

struct Command { request: Value, connection: Option<PathBuf>, output: Option<PathBuf> }

fn parse(args: &[String], input: &mut dyn Read) -> Result<Command, String> {
    let action = args.first().map(String::as_str).ok_or("Missing graph action")?;
    if !["cases", "get", "generate", "apply"].contains(&action) { return Err("Unknown graph action; use ledger --help".into()); }
    let mut request = json!({"action":action});
    let mut index = 1;
    if action != "cases" {
        request["caseId"] = json!(args.get(index).filter(|v| !v.starts_with('-')).ok_or("CASE_ID is required")?);
        index += 1;
    }
    let mut connection = None;
    let mut output = None;
    let mut seen = std::collections::HashSet::new();
    while index < args.len() {
        let option = args[index].as_str();
        if !seen.insert(option) { return Err(format!("Repeated option: {option}")); }
        match option {
            "--preview" if ["apply", "generate"].contains(&action) => request["preview"] = json!(true),
            "--reset-layout" if action == "generate" => request["resetLayout"] = json!(true),
            "--connection" | "--output" | "--sources" | "--file" => {
                index += 1;
                let value = args.get(index).filter(|v| !v.starts_with("--")).ok_or_else(|| format!("{option} needs a value"))?;
                match option {
                    "--connection" => connection = Some(PathBuf::from(value)),
                    "--output" => output = Some(PathBuf::from(value)),
                    "--sources" if action == "get" => request["sourceIds"] = json!(value.split(',').collect::<Vec<_>>()),
                    "--file" if action == "apply" => {
                        let mut bytes = Vec::new();
                        if value == "-" { input.take(MAX_REQUEST + 1).read_to_end(&mut bytes).map_err(|e| format!("Cannot read stdin: {e}"))?; }
                        else { std::fs::File::open(value).map_err(|e| format!("Cannot open patch file: {e}"))?.take(MAX_REQUEST + 1).read_to_end(&mut bytes).map_err(|e| format!("Cannot read patch: {e}"))?; }
                        if bytes.len() as u64 > MAX_REQUEST { return Err("Patch exceeds 2 MB".into()); }
                        request["patch"] = json_io::decode(&bytes)?;
                    }
                    _ => return Err(format!("{option} is not valid for {action}")),
                }
            }
            _ => return Err(format!("Unknown option: {option}")),
        }
        index += 1;
    }
    if action == "apply" && !request["patch"].is_object() { return Err("apply requires --file containing a JSON object".into()); }
    Ok(Command { request, connection, output })
}

fn exchange(stream: &mut (impl Read + Write), request: &Value) -> Result<Value, String> {
    let encoded = request.to_string();
    if encoded.len() as u64 >= MAX_REQUEST { return Err("Request exceeds 2 MB".into()); }
    writeln!(stream, "{encoded}").map_err(|_| "Cannot send request")?;
    let mut line = String::new();
    BufReader::new(stream.take(32 * 1024 * 1024 + 1)).read_line(&mut line).map_err(|_| "Request timed out or connection closed")?;
    if line.len() > 32 * 1024 * 1024 || !line.ends_with('\n') { return Err("Incomplete or oversized response".into()); }
    let response: Value = json_io::decode(line.as_bytes())?;
    if response["ok"] == true { Ok(response["value"].clone()) }
    else { Err(json_io::console_json(&response["error"])) }
}

fn run(args: &[String]) -> Result<(), String> {
    if args.is_empty() || matches!(args[0].as_str(), "help" | "--help" | "-h") || (args[0] == "graph" && (args.len() == 1 || matches!(args[1].as_str(), "help" | "--help" | "-h"))) { println!("{HELP}"); return Ok(()); }
    if args == ["--version"] { println!("ledger {}", env!("CARGO_PKG_VERSION")); return Ok(()); }
    if args[0] != "graph" { return Err("Unknown command; use ledger --help".into()); }
    let mut command = parse(&args[1..], &mut std::io::stdin().lock())?;
    let descriptor = match command.connection { Some(path) => path, None => descriptor_path()? };
    let connection: Value = json_io::decode(&std::fs::read(&descriptor).map_err(|_| "Open Notechain first, or select its descriptor with --connection FILE")?)?;
    let response = if connection["transport"] == "tcp" {
        let address: std::net::SocketAddr = connection["address"].as_str().ok_or("Missing address")?.parse().map_err(|_| "Invalid address")?;
        if !address.ip().is_loopback() { return Err("CLI connections must stay on this computer".into()); }
        command.request["token"] = connection.get("token").filter(|v| v.as_str().is_some_and(|s| s.len() >= 32)).ok_or("Missing local connection token")?.clone();
        let mut stream = std::net::TcpStream::connect_timeout(&address, Duration::from_secs(5)).map_err(|_| "Notechain is not running; open it first")?;
        stream.set_read_timeout(Some(Duration::from_secs(60))).map_err(|_| "Cannot set timeout")?;
        stream.set_write_timeout(Some(Duration::from_secs(5))).map_err(|_| "Cannot set timeout")?;
        exchange(&mut stream, &command.request)?
    } else {
        #[cfg(unix)]
        {
            let mut stream = std::os::unix::net::UnixStream::connect(connection["socket"].as_str().ok_or("Missing socket")?).map_err(|_| "Notechain is not running; open it first")?;
            stream.set_read_timeout(Some(Duration::from_secs(60))).map_err(|_| "Cannot set timeout")?;
            stream.set_write_timeout(Some(Duration::from_secs(5))).map_err(|_| "Cannot set timeout")?;
            exchange(&mut stream, &command.request)?
        }
        #[cfg(not(unix))]
        return Err("This connection descriptor belongs to another platform".into());
    };
    if let Some(path) = command.output { std::fs::write(path, format!("{response}\n")).map_err(|e| format!("Cannot write output: {e}"))?; }
    else { println!("{}", json_io::console_json(&response)); }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    fn args(values: &[&str]) -> Vec<String> { values.iter().map(|s| s.to_string()).collect() }
    #[test]
    fn stdin_patch_and_option_validation() {
        let mut input = &b"\xef\xbb\xbf{\"revision\":0,\"requestId\":\"test\"}"[..];
        let command = parse(&args(&["apply", "case-1", "--file", "-", "--preview"]), &mut input).unwrap();
        assert_eq!(command.request["patch"]["revision"], 0);
        assert_eq!(command.request["preview"], true);
        for invalid in [vec!["apply","id"], vec!["cases","--file","-"], vec!["get","id","--preview"], vec!["get","id","--output"], vec!["cases","--connection","one","--connection","two"]] {
            assert!(parse(&args(&invalid), &mut &b"{}"[..]).is_err());
        }
    }
    #[test]
    fn file_paths_are_literal_and_utf16_is_accepted() {
        let directory = std::env::temp_dir().join(format!("ledger-cli-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir(&directory).unwrap();
        let path = directory.join("中文 [a] '$&.json");
        let mut bytes = vec![0xff, 0xfe];
        for unit in "{\"text\":\"中文\"}".encode_utf16() { bytes.extend(unit.to_le_bytes()); }
        std::fs::write(&path, bytes).unwrap();
        let command = parse(&args(&["apply", "id", "--file", path.to_str().unwrap()]), &mut &b""[..]).unwrap();
        assert_eq!(command.request["patch"]["text"], "中文");
        std::fs::remove_dir_all(directory).unwrap();
    }
}
