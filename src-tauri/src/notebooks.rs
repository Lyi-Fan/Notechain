use crate::{media, Native};
use notify::{RecommendedWatcher, RecursiveMode, Watcher};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::{fs, io::{Read, Write}, path::{Component, Path, PathBuf}, sync::Mutex};
use tauri::{Emitter, Manager};

const MAX_NOTE: u64 = 16 * 1024 * 1024;
const MAX_IMAGE: u64 = 20 * 1024 * 1024;
static EARLY_OPEN: Mutex<Vec<PathBuf>> = Mutex::new(Vec::new());
#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Notebook { pub id: String, pub name: String, pub root: PathBuf, pub scopes: Vec<String> }
#[derive(Clone, Default, Serialize, Deserialize)]
pub struct Registry { version: u32, pub notebooks: Vec<Notebook> }
pub struct Notebooks {
    directory: PathBuf,
    registry: Mutex<Registry>,
    watcher: Mutex<Option<RecommendedWatcher>>,
    pub pending_open: Mutex<Option<Value>>,
    load_error: Option<String>,
}
fn error(e: impl std::fmt::Display) -> String { e.to_string() }
fn portable_path(path: &Path) -> String { path.components().map(|part| part.as_os_str().to_string_lossy()).collect::<Vec<_>>().join("/") }
fn windows_name(value: &str) -> bool {
    let stem = value.split('.').next().unwrap_or("").to_ascii_uppercase();
    !value.ends_with(['.', ' ']) && !value.chars().any(|c| c.is_control() || "<>:\"|?*".contains(c)) &&
        !["CON", "PRN", "AUX", "NUL", "CONIN$", "CONOUT$"].contains(&stem.as_str()) &&
        !((stem.starts_with("COM") || stem.starts_with("LPT")) && stem.chars().count() == 4 && stem.chars().last().is_some_and(|c| "123456789¹²³".contains(c)))
}
fn relative(value: &str) -> Result<PathBuf, String> {
    let path = PathBuf::from(value);
    if path.components().any(|part| !matches!(part, Component::Normal(_))) || value.contains('\\') ||
        path.components().any(|part| part.as_os_str().to_string_lossy().eq_ignore_ascii_case(".fan") || (cfg!(windows) && !windows_name(&part.as_os_str().to_string_lossy()))) {
        return Err("Invalid notebook-relative path".into());
    }
    Ok(path)
}
fn md(path: &Path) -> bool { path.extension().and_then(|s| s.to_str()).is_some_and(|s| s.eq_ignore_ascii_case("md") || s.eq_ignore_ascii_case("markdown")) }
fn image_folder(path: &Path, name: &str) -> bool {
    let name = name.to_lowercase();
    if !["attachments", "assets", "images", "img", "图片", "附件"].contains(&name.as_str()) && !name.ends_with(".assets") && !name.ends_with("_assets") { return false; }
    let mut pending = vec![path.to_path_buf()]; let mut visited = 0;
    while let Some(directory) = pending.pop() {
        let Ok(entries) = fs::read_dir(directory) else { return false; };
        for entry in entries {
            visited += 1; if visited > 2048 { return false; }
            let Ok(entry) = entry else { return false; };
            let Ok(kind) = entry.file_type() else { return false; };
            if kind.is_symlink() || md(&entry.path()) { return false; }
            if kind.is_dir() { pending.push(entry.path()); }
        }
    }
    true
}
fn image_path(root: &Path, relative: &Path) -> Result<PathBuf, String> {
    let mut path = root.to_path_buf();
    for component in relative.components() {
        let Component::Normal(name) = component else { return Err("Image path escapes the notebook".into()); };
        let name_text = name.to_string_lossy();
        if [".fan", ".git", ".obsidian"].iter().any(|hidden| name_text.eq_ignore_ascii_case(hidden)) || (cfg!(windows) && !windows_name(&name_text)) { return Err("Invalid image path".into()); }
        path.push(name);
        let metadata = fs::symlink_metadata(&path).map_err(error)?;
        if metadata.file_type().is_symlink() { return Err("Image links cannot traverse symbolic links".into()); }
        #[cfg(windows)]
        { use std::os::windows::fs::MetadataExt; if metadata.file_attributes() & 0x400 != 0 { return Err("Image links cannot traverse reparse points".into()); } }
    }
    let real = fs::canonicalize(&path).map_err(error)?;
    if !real.starts_with(root) || !real.is_file() { return Err("Image must be inside the opened notebook".into()); }
    Ok(real)
}
fn image_reference(source: &Path, reference: &str) -> Result<PathBuf, String> {
    let reference = reference.replace('\\', "/");
    let mut path = if reference.starts_with('/') { PathBuf::new() } else { source.parent().unwrap_or(Path::new("")).to_path_buf() };
    for component in Path::new(reference.trim_start_matches('/')).components() {
        match component {
            Component::Normal(name) => { if name.to_string_lossy().contains(':') { return Err("Invalid image reference".into()); } path.push(name); }
            Component::CurDir => {}
            Component::ParentDir => { if !path.pop() { return Err("Image reference escapes the notebook".into()); } }
            _ => return Err("Invalid image reference".into()),
        }
    }
    Ok(path)
}
fn local_image_reference(reference: &str) -> Result<String, String> {
    let reference = reference.replace('\\', "/");
    let path = if reference.get(..5).is_some_and(|prefix| prefix.eq_ignore_ascii_case("file:")) {
        if reference[5..].starts_with("////") { return Err("Remote file image URLs are not supported".into()); }
        let url = url::Url::parse(&reference).map_err(error)?;
        if url.host_str().is_some_and(|host| !host.eq_ignore_ascii_case("localhost")) { return Err("Remote file image URLs are not supported".into()); }
        url.path().to_string()
    } else { reference };
    let decoded = percent_encoding::percent_decode_str(&path).decode_utf8().map_err(error)?.replace('\\', "/");
    let decoded = if decoded.starts_with('/') && windows_drive_path(&decoded[1..]) { decoded[1..].to_string() } else { decoded };
    if decoded.is_empty() || decoded.starts_with("//") || decoded.starts_with("/??/") || decoded.chars().any(char::is_control) { return Err("Invalid local image reference".into()); }
    let components = if windows_drive_path(&decoded) { &decoded[3..] } else { &decoded };
    if components.contains(':') { return Err("Invalid local image reference".into()); }
    if (cfg!(windows) || windows_drive_path(&decoded)) && components.split('/').any(|part| !part.is_empty() && part != "." && part != ".." && !windows_name(part)) {
        return Err("Invalid Windows image path".into());
    }
    Ok(decoded)
}
fn windows_drive_path(path: &str) -> bool {
    let bytes = path.as_bytes();
    bytes.len() >= 3 && bytes[0].is_ascii_alphabetic() && bytes[1] == b':' && bytes[2] == b'/'
}
fn explicitly_referenced_image(source: &Path, reference: &str) -> Result<Option<PathBuf>, String> {
    // Foreign drive paths can still use the companion-folder fallback on macOS.
    if !cfg!(windows) && windows_drive_path(reference) { return Ok(None); }
    let reference = Path::new(reference);
    if reference.has_root() && !reference.is_absolute() { return Ok(None); }
    let path = if reference.is_absolute() { reference.to_path_buf() } else { source.parent().ok_or("Image source directory unavailable")?.join(reference) };
    let real = match fs::canonicalize(&path) {
        Ok(real) => real,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(e) => return Err(error(e)),
    };
    #[cfg(windows)]
    if !matches!(real.components().next(), Some(Component::Prefix(prefix)) if matches!(prefix.kind(), std::path::Prefix::Disk(_) | std::path::Prefix::VerbatimDisk(_))) {
        return Err("Image must resolve to a local disk file".into());
    }
    if !real.is_file() { return Err("Image must be a regular file".into()); }
    Ok(Some(real))
}
fn read_local_image(path: &Path) -> Result<Value, String> {
    use base64::Engine;
    let file = fs::File::open(path).map_err(error)?;
    let metadata = file.metadata().map_err(error)?;
    if !metadata.is_file() { return Err("Image must be a regular file".into()); }
    if metadata.len() > MAX_IMAGE { return Err("Image exceeds 20 MiB".into()); }
    // Bound the read even if the referenced file grows after its metadata was read.
    let mut bytes = Vec::new();
    file.take(MAX_IMAGE + 1).read_to_end(&mut bytes).map_err(error)?;
    let (_, mime) = media::inspect(&bytes)?;
    Ok(json!({"base64":base64::engine::general_purpose::STANDARD.encode(bytes),"mime":mime}))
}
fn image_under_root(root: &Path, reference: &str) -> Option<PathBuf> {
    let root = root.to_string_lossy().replace('\\', "/");
    let root = root.strip_prefix("//?/").unwrap_or(&root).trim_end_matches('/');
    let prefix = reference.get(..root.len())?;
    if !(prefix == root || (cfg!(windows) && prefix.eq_ignore_ascii_case(root))) { return None; }
    let relative = reference.get(root.len()..)?.strip_prefix('/')?;
    Some(PathBuf::from(relative))
}
fn companion_image_reference(source: &Path, reference: &str) -> Option<PathBuf> {
    if !windows_drive_path(reference) && !reference.starts_with('/') { return None; }
    let parts: Vec<_> = reference.split('/').collect();
    let folder = parts.iter().position(|part| {
        let name = part.to_ascii_lowercase();
        (name.ends_with(".assets") || name.ends_with("_assets")) && name.len() > 7
    })?;
    let suffix = &parts[folder..];
    if suffix.len() < 2 || suffix.iter().any(|part| part.is_empty() || *part == "." || *part == ".." || part.contains(':')) { return None; }
    let mut path = source.parent()?.to_path_buf();
    for part in suffix { path.push(part); }
    Some(path)
}
fn allowed(book: &Notebook, path: &Path, ancestors: bool) -> bool {
    book.scopes.iter().any(|scope| scope.is_empty() || path.starts_with(scope) || (ancestors && Path::new(scope).starts_with(path)))
}
fn scoped(book: &Notebook, value: &str, ancestors: bool) -> Result<PathBuf, String> {
    let rel = relative(value)?;
    if !allowed(book, &rel, ancestors) { return Err("This folder is not registered in the notebook".into()); }
    let root = fs::canonicalize(&book.root).map_err(error)?;
    let mut component_path = root.clone();
    for component in rel.components() {
        component_path.push(component.as_os_str());
        if fs::symlink_metadata(&component_path).map_err(error)?.file_type().is_symlink() {
            return Err("Symbolic links are not included in notebook folders".into());
        }
    }
    let full = root.join(&rel);
    let real = fs::canonicalize(&full).map_err(error)?;
    if !real.starts_with(&root) { return Err("Notebook path escapes its registered root".into()); }
    Ok(real)
}
fn text(path: &Path) -> Result<(Vec<u8>, String), String> {
    if !md(path) || !path.is_file() { return Err("Select a Markdown file".into()); }
    if fs::metadata(path).map_err(error)?.len() > MAX_NOTE { return Err("Markdown file exceeds 16 MB".into()); }
    let bytes = fs::read(path).map_err(error)?;
    let content = std::str::from_utf8(&bytes).map_err(|_| "Markdown file must use UTF-8")?.trim_start_matches('\u{feff}').replace("\r\n", "\n");
    Ok((bytes, content))
}
fn file_name(value: &str) -> Result<String, String> {
    let value = value.trim();
    if value.is_empty() || value.starts_with('.') || value.len() > 240 || value.chars().any(|c| c.is_control() || "/\\:".contains(c)) || (cfg!(windows) && !windows_name(value)) {
        return Err("Invalid file or folder name".into());
    }
    Ok(value.into())
}
impl Notebooks {
    pub fn new(profile: &Path) -> Result<Self, String> {
        let directory = profile.join(".fan");
        let index = directory.join("notebooks.json");
        let loaded = (|| -> Result<Registry, String> { Ok(if index.try_exists().map_err(error)? {
            if fs::metadata(&index).map_err(error)?.len() > 4 * 1024 * 1024 { return Err("Notebook registry exceeds limit".into()); }
            let value: Registry = serde_json::from_slice(&fs::read(index).map_err(error)?).map_err(error)?;
            if value.version != 1 { return Err("Unsupported notebook registry version".into()); }
            value
        } else { Registry { version: 1, notebooks: Vec::new() } }) })();
        let (registry, load_error) = match loaded {
            Ok(registry) => (registry, None),
            Err(error) => (Registry { version: 1, notebooks: Vec::new() }, Some(error)),
        };
        Ok(Self { directory, registry: Mutex::new(registry), watcher: Mutex::new(None), pending_open: Mutex::new(None), load_error })
    }
    fn persist(&self, registry: &Registry) -> Result<(), String> {
        if let Some(error) = &self.load_error { return Err(format!("Cannot read notebook registry: {error}")); }
        fs::create_dir_all(&self.directory).map_err(error)?;
        media::atomic_write(&self.directory.join("notebooks.json"), &serde_json::to_vec_pretty(registry).map_err(error)?)
    }
    fn book(registry: &Registry, id: &str) -> Result<Notebook, String> {
        registry.notebooks.iter().find(|b| b.id == id).cloned().ok_or("Notebook is not registered".into())
    }
    pub fn register(&self, selected: &Path, kind: &str) -> Result<Value, String> {
        let selected = fs::canonicalize(selected).map_err(error)?;
        if kind == "file" { text(&selected)?; } else if !selected.is_dir() { return Err("Select a folder".into()); }
        let mut registry = self.registry.lock().map_err(error)?;
        let existing = if kind == "notebook" {
            registry.notebooks.iter().position(|b| b.root == selected)
        } else {
            registry.notebooks.iter().enumerate().filter(|(_, b)| selected.starts_with(&b.root))
                .max_by_key(|(_, b)| b.root.components().count()).map(|(i, _)| i)
        };
        let mut next = registry.clone();
        let index = match existing {
            Some(index) => index,
            None => {
                let root = if kind == "notebook" { selected.clone() } else { selected.parent().ok_or("Folder has no notebook parent")?.to_path_buf() };
                let scope = portable_path(selected.strip_prefix(&root).map_err(error)?);
                next.notebooks.push(Notebook { id: uuid::Uuid::new_v4().to_string(), name: root.file_name().unwrap_or_default().to_string_lossy().into(), root, scopes: vec![scope] });
                next.notebooks.len() - 1
            }
        };
        let book = &mut next.notebooks[index];
        let path = portable_path(selected.strip_prefix(&book.root).map_err(error)?);
        relative(&path)?;
        if kind == "notebook" { book.scopes = vec![String::new()]; }
        else if !allowed(book, Path::new(&path), false) { book.scopes.push(path.clone()); }
        let result = json!({"notebook": book, "path": path, "kind": kind});
        self.persist(&next)?; *registry = next;
        Ok(result)
    }
    pub fn index(&self) -> Result<Value, String> {
        if let Some(error) = &self.load_error { return Err(format!("Cannot read notebook registry: {error}")); }
        let registry = self.registry.lock().map_err(error)?;
        Ok(json!({"notebooks": registry.notebooks, "registryPath": self.directory.join("notebooks.json")}))
    }
    pub fn children(&self, id: &str, value: &str) -> Result<Value, String> {
        let book = Self::book(&*self.registry.lock().map_err(error)?, id)?;
        let full = scoped(&book, value, true)?;
        let mut entries = Vec::new();
        for entry in fs::read_dir(full).map_err(error)? {
            let entry = entry.map_err(error)?;
            let name = entry.file_name().to_string_lossy().to_string();
            if name.starts_with('.') { continue; }
            let kind = entry.file_type().map_err(error)?;
            if kind.is_symlink() || (!kind.is_dir() && !md(&entry.path())) { continue; }
            if kind.is_dir() && image_folder(&entry.path(), &name) { continue; }
            let rel = Path::new(value).join(&name);
            if !allowed(&book, &rel, true) { continue; }
            entries.push(json!({"name": name, "path": portable_path(&rel), "kind": if kind.is_dir() { "directory" } else { "file" }}));
        }
        entries.sort_by_key(|v| (v["kind"] != "directory", v["name"].as_str().unwrap_or("").to_lowercase()));
        Ok(json!(entries))
    }
    pub fn read(&self, id: &str, value: &str) -> Result<Value, String> {
        let book = Self::book(&*self.registry.lock().map_err(error)?, id)?;
        relative(value)?;
        if !allowed(&book, Path::new(value), false) { return Err("File is not registered".into()); }
        let recovery = self.directory.join("recovery").join(format!("{}.json", media::hash(format!("{id}/{value}").as_bytes())));
        let draft: Option<Value> = fs::read(recovery).ok().and_then(|bytes| serde_json::from_slice(&bytes).ok());
        let path = match scoped(&book, value, false) {
            Ok(path) => path,
            Err(error) => {
                if let Some(draft) = &draft { return Ok(json!({"path": value, "content": draft["content"], "revision": draft["revision"], "draft": draft, "missing": true})); }
                return Err(error);
            }
        };
        let (bytes, content) = text(&path)?;
        Ok(json!({"path": value, "content": content, "revision": media::hash(&bytes), "draft": draft}))
    }
    pub fn save(&self, id: &str, value: &str, revision: &str, content: &str) -> Result<Value, String> {
        if content.len() as u64 > MAX_NOTE { return Err("Markdown file exceeds 16 MB".into()); }
        let mut registry = self.registry.lock().map_err(error)?;
        let book = Self::book(&registry, id)?;
        relative(value)?;
        if !allowed(&book, Path::new(value), false) { return Err("File is not registered".into()); }
        let recoveries = self.directory.join("recovery");
        fs::create_dir_all(&recoveries).map_err(error)?;
        let recovery = recoveries.join(format!("{}.json", media::hash(format!("{id}/{value}").as_bytes())));
        media::atomic_write(&recovery, &serde_json::to_vec(&json!({"path": value, "revision": revision, "content": content})).map_err(error)?)?;
        let path = scoped(&book, value, false)?;
        let (bytes, _) = text(&path)?;
        if media::hash(&bytes) != revision {
            let stem: String = path.file_stem().unwrap_or_default().to_string_lossy().chars().take(40).collect();
            let filename = format!("{stem}-conflict-{}.md", uuid::Uuid::new_v4());
            let copy = path.with_file_name(filename);
            let mut file = fs::OpenOptions::new().write(true).create_new(true).open(&copy).map_err(error)?;
            file.write_all(content.as_bytes()).and_then(|_| file.sync_all()).map_err(error)?;
            let relative = portable_path(copy.strip_prefix(&book.root).map_err(error)?);
            if !allowed(&book, Path::new(&relative), false) {
                let mut next = registry.clone();
                next.notebooks.iter_mut().find(|b| b.id == id).unwrap().scopes.push(relative.clone());
                self.persist(&next)?; *registry = next;
            }
            let _ = fs::remove_file(recovery);
            return Ok(json!({"path": relative, "revision": media::hash(content.as_bytes()), "conflict": true}));
        }
        let mut output = content.replace("\r\n", "\n");
        if bytes.windows(2).any(|pair| pair == b"\r\n") { output = output.replace('\n', "\r\n"); }
        if bytes.starts_with(&[0xef, 0xbb, 0xbf]) { output.insert(0, '\u{feff}'); }
        let permissions = fs::metadata(&path).map_err(error)?.permissions();
        if permissions.readonly() { return Err("File is read-only; save a copy instead".into()); }
        media::atomic_write(&path, output.as_bytes())?;
        fs::set_permissions(&path, permissions).map_err(error)?;
        let _ = fs::remove_file(recovery);
        Ok(json!({"path": value, "revision": media::hash(output.as_bytes()), "conflict": false}))
    }
    pub fn create(&self, id: &str, parent: &str, name: &str, kind: &str) -> Result<Value, String> {
        let mut registry = self.registry.lock().map_err(error)?;
        let book = Self::book(&registry, id)?;
        let directory = scoped(&book, parent, true)?;
        let mut name = file_name(name)?;
        if kind == "file" && !md(Path::new(&name)) { name.push_str(".md"); }
        let rel = portable_path(&Path::new(parent).join(&name));
        if kind == "directory" { fs::create_dir(directory.join(name)).map_err(error)?; }
        else if kind == "file" { fs::OpenOptions::new().write(true).create_new(true).open(directory.join(name)).map_err(error)?.sync_all().map_err(error)?; }
        else { return Err("Unknown entry kind".into()); }
        if !allowed(&book, Path::new(&rel), false) {
            let mut next = registry.clone();
            next.notebooks.iter_mut().find(|b| b.id == id).unwrap().scopes.push(rel.clone());
            self.persist(&next)?; *registry = next;
        }
        Ok(json!({"path": rel, "kind": kind}))
    }
    pub fn rename(&self, id: &str, value: &str, name: &str) -> Result<Value, String> {
        if value.is_empty() { return Err("Notebook root cannot be renamed here".into()); }
        let mut registry = self.registry.lock().map_err(error)?;
        let book = Self::book(&registry, id)?;
        let source = scoped(&book, value, false)?;
        let mut name = file_name(name)?;
        if source.is_file() && !md(Path::new(&name)) { name.push_str(".md"); }
        let target = source.with_file_name(&name);
        if target.exists() { return Err("A file or folder already uses that name".into()); }
        let destination = portable_path(&Path::new(value).with_file_name(name));
        let mut next = registry.clone();
        for scope in &mut next.notebooks.iter_mut().find(|b| b.id == id).unwrap().scopes {
            if let Ok(suffix) = Path::new(scope).strip_prefix(value) { *scope = portable_path(&Path::new(&destination).join(suffix)); }
        }
        fs::rename(&source, &target).map_err(error)?;
        if let Err(failure) = self.persist(&next) { let _ = fs::rename(&target, &source); return Err(failure); }
        *registry = next;
        Ok(json!({"path": destination}))
    }
    pub fn forget(&self, id: &str) -> Result<(), String> {
        let mut registry = self.registry.lock().map_err(error)?;
        let mut next = registry.clone();
        next.notebooks.retain(|book| book.id != id);
        self.persist(&next)?; *registry = next;
        Ok(())
    }
    pub fn image(&self, id: &str, value: &str) -> Result<Value, String> {
        use base64::Engine;
        let book = Self::book(&*self.registry.lock().map_err(error)?, id)?;
        let path = scoped(&book, value, false)?;
        if fs::metadata(&path).map_err(error)?.len() > 20 * 1024 * 1024 { return Err("Image exceeds 20 MB".into()); }
        let bytes = fs::read(path).map_err(error)?;
        let (_, mime) = media::inspect(&bytes)?;
        Ok(json!({"base64": base64::engine::general_purpose::STANDARD.encode(bytes), "mime": mime}))
    }
    pub fn resolve_image(&self, id: &str, source: &str, reference: &str, wiki: bool) -> Result<Value, String> {
        if reference.len() > 8192 { return Err("Image path is too long".into()); }
        let book = Self::book(&*self.registry.lock().map_err(error)?, id)?;
        let source_path = scoped(&book, source, false)?;
        if !md(&source_path) { return Err("Image source must be a Markdown note".into()); }
        let root = fs::canonicalize(&book.root).map_err(error)?;
        let source = source_path.strip_prefix(&root).map_err(error)?;
        let reference = local_image_reference(reference)?;
        if let Some(path) = explicitly_referenced_image(&source_path, &reference)? {
            return read_local_image(&path);
        }
        let relative = image_under_root(&root, &reference).map(Ok).unwrap_or_else(|| image_reference(source, &reference));
        let mut found = relative.ok().and_then(|path| image_path(&root, &path).ok());
        // Relocated Typora notebooks keep their named attachment directory beside the note.
        if found.is_none() {
            found = companion_image_reference(source, &reference).and_then(|path| image_path(&root, &path).ok());
        }
        if found.is_none() && wiki {
            let root_relative = image_reference(Path::new("note.md"), &reference)?;
            found = image_path(&root, &root_relative).ok();
            if found.is_none() && !reference.contains('/') {
                let mut directories = vec![root.clone()]; let mut matches = Vec::new(); let mut visited = 0;
                while let Some(directory) = directories.pop() {
                    for entry in fs::read_dir(&directory).map_err(error)? {
                        visited += 1; if visited > 20000 { return Err("Image search limit reached; use an explicit relative image path".into()); }
                        let entry = entry.map_err(error)?; let kind = entry.file_type().map_err(error)?;
                        if kind.is_symlink() || entry.file_name().to_string_lossy().starts_with('.') { continue; }
                        #[cfg(windows)]
                        { use std::os::windows::fs::MetadataExt; if entry.metadata().map_err(error)?.file_attributes() & 0x400 != 0 { continue; } }
                        let relative = entry.path().strip_prefix(&root).map_err(error)?.to_path_buf();
                        if kind.is_dir() {
                            if allowed(&book, &relative, true) || entry.path().starts_with(source_path.parent().unwrap()) || image_folder(&entry.path(), &entry.file_name().to_string_lossy()) { directories.push(entry.path()); }
                        } else if kind.is_file() && entry.file_name().to_string_lossy() == reference {
                            matches.push(image_path(&root, &relative)?);
                            if matches.len() > 1 { return Err("More than one image has this name; use its folder path in the embed".into()); }
                        }
                    }
                }
                found = matches.pop();
            }
        }
        let path = found.ok_or("Referenced image was not found")?;
        read_local_image(&path)
    }
    pub fn import_image(&self, id: &str, value: &str, bytes: &[u8]) -> Result<Value, String> {
        let book = Self::book(&*self.registry.lock().map_err(error)?, id)?;
        let file = scoped(&book, value, false)?;
        let (ext, _) = media::inspect(bytes)?;
        let directory = file.parent().ok_or("File parent unavailable")?.join("attachments");
        fs::create_dir_all(&directory).map_err(error)?;
        if fs::symlink_metadata(&directory).map_err(error)?.file_type().is_symlink() { return Err("Attachment folder cannot be a symbolic link".into()); }
        if !fs::canonicalize(&directory).map_err(error)?.starts_with(&book.root) { return Err("Attachment directory escapes notebook".into()); }
        let name = format!("{}.{}", media::hash(bytes), ext);
        if !directory.join(&name).exists() { media::atomic_write(&directory.join(&name), bytes)?; }
        let relative = portable_path(directory.strip_prefix(&book.root).map_err(error)?);
        let mut registry = self.registry.lock().map_err(error)?;
        if !allowed(&book, Path::new(&relative), false) {
            let mut next = registry.clone();
            next.notebooks.iter_mut().find(|b| b.id == id).unwrap().scopes.push(relative);
            self.persist(&next)?; *registry = next;
        }
        Ok(json!({"src": format!("attachments/{name}"), "name": name}))
    }
    pub fn watch(&self, app: tauri::AppHandle, id: &str) -> Result<(), String> {
        *self.watcher.lock().map_err(error)? = None;
        if id.is_empty() { return Ok(()); }
        let book = Self::book(&*self.registry.lock().map_err(error)?, id)?;
        let current = book.id.clone();
        let mut watcher = notify::recommended_watcher(move |event: Result<notify::Event, notify::Error>| {
            if event.is_ok() { let _ = app.emit("notebook-changed", json!({"id":current})); }
        }).map_err(error)?;
        for scope in &book.scopes {
            let path = scoped(&book, scope, false)?;
            if path.is_file() {
                watcher.watch(path.parent().ok_or("File parent unavailable")?, RecursiveMode::NonRecursive).map_err(error)?;
            } else { watcher.watch(&path, RecursiveMode::Recursive).map_err(error)?; }
        }
        *self.watcher.lock().map_err(error)? = Some(watcher);
        Ok(())
    }
}

fn field<'a>(input: &'a Value, key: &str) -> Result<&'a str, String> { input[key].as_str().ok_or_else(|| format!("Missing {key}")) }
async fn selected(app: &tauri::AppHandle, input: &Value, file: bool) -> Result<Option<PathBuf>, String> {
    if let Some(path) = input["selectedPath"].as_str() {
        if !app.state::<Native>().qa { return Err("Direct test paths require QA mode".into()); }
        let path = fs::canonicalize(path).map_err(error)?;
        if !path.starts_with(fs::canonicalize(&app.state::<Native>().directory).map_err(error)?) { return Err("Synthetic profile path required".into()); }
        return Ok(Some(path));
    }
    let window = app.get_webview_window("main").ok_or("Window unavailable")?;
    let initial = {
        let books = app.state::<Notebooks>();
        let registry = books.registry.lock().map_err(error)?;
        registry.notebooks.iter().find(|book| Some(book.id.as_str()) == input["id"].as_str()).or_else(|| registry.notebooks.last())
            .map(|book| book.root.join(relative(input["folder"].as_str().unwrap_or("")).unwrap_or_default()))
    };
    let mut dialog = rfd::AsyncFileDialog::new().set_parent(&window);
    if let Some(initial) = initial { dialog = dialog.set_directory(initial); }
    Ok(if file { dialog.add_filter("Markdown", &["md", "markdown"]).pick_file().await }
        else { dialog.pick_folder().await }.map(|file| file.path().to_path_buf()))
}
#[tauri::command]
pub async fn notebook(app: tauri::AppHandle, input: Value) -> Result<Value, String> {
    let action = field(&input, "action")?;
    if action == "saveCopy" {
        let content = field(&input, "content")?;
        if content.len() as u64 > MAX_NOTE { return Err("Markdown file exceeds 16 MB".into()); }
        let window = app.get_webview_window("main").ok_or("Window unavailable")?;
        let name = file_name(input["name"].as_str().unwrap_or("Note.md"))?;
        let Some(file) = rfd::AsyncFileDialog::new().set_parent(&window).set_file_name(name).add_filter("Markdown", &["md"]).save_file().await else { return Ok(Value::Null); };
        let path = file.path();
        if !md(path) { return Err("Use a .md or .markdown extension".into()); }
        media::atomic_write(path, content.as_bytes())?;
        let mut value = app.state::<Notebooks>().register(path, "file")?;
        value["revision"] = json!(media::hash(content.as_bytes()));
        return Ok(value);
    }
    if action == "open" || action == "createBook" {
        let kind = if action == "createBook" { "notebook" } else { field(&input, "kind")? };
        if !["notebook", "category", "file"].contains(&kind) { return Err("Unknown folder role".into()); }
        let Some(mut path) = selected(&app, &input, kind == "file").await? else { return Ok(Value::Null); };
        if action == "createBook" {
            path = path.join(file_name(field(&input, "name")?)?);
            fs::create_dir(&path).map_err(error)?;
        }
        return app.state::<Notebooks>().register(&path, kind);
    }
    if action == "watch" { app.state::<Notebooks>().watch(app.clone(), input["id"].as_str().unwrap_or(""))?; return Ok(Value::Null); }
    tauri::async_runtime::spawn_blocking(move || {
        let books = app.state::<Notebooks>();
        match field(&input, "action")? {
            "index" => books.index(),
            "pendingOpen" => Ok(books.pending_open.lock().map_err(error)?.take().unwrap_or(Value::Null)),
            "children" => books.children(field(&input, "id")?, input["path"].as_str().unwrap_or("")),
            "read" => books.read(field(&input, "id")?, field(&input, "path")?),
            "save" => books.save(field(&input, "id")?, field(&input, "path")?, field(&input, "revision")?, field(&input, "content")?),
            "create" => books.create(field(&input, "id")?, field(&input, "path")?, field(&input, "name")?, field(&input, "kind")?),
            "rename" => books.rename(field(&input, "id")?, field(&input, "path")?, field(&input, "name")?),
            "forget" => { books.forget(field(&input, "id")?)?; Ok(Value::Null) },
            "image" => books.image(field(&input, "id")?, field(&input, "path")?),
            "resolveImage" => books.resolve_image(field(&input, "id")?, field(&input, "path")?, field(&input, "reference")?, input["wiki"].as_bool().unwrap_or(false)),
            "importImage" => books.import_image(field(&input, "id")?, field(&input, "path")?, &serde_json::from_value::<Vec<u8>>(input["bytes"].clone()).map_err(error)?),
            "trash" => {
                let book = Notebooks::book(&*books.registry.lock().map_err(error)?, field(&input, "id")?)?;
                let value = field(&input, "path")?;
                if value.is_empty() { return Err("Notebook root cannot be trashed here".into()); }
                trash::delete(scoped(&book, value, false)?).map_err(error)?;
                Ok(Value::Null)
            }
            _ => Err("Unknown notebook action".into()),
        }
    }).await.map_err(error)?
}

pub fn open_file(app: &tauri::AppHandle, path: &Path) {
    if let Some(books) = app.try_state::<Notebooks>() {
        match books.register(path, "file") {
            Ok(value) => {
                *books.pending_open.lock().unwrap() = Some(value.clone());
                let _ = app.emit("notebook-open", value);
                if let Some(window) = app.get_webview_window("main") { let _ = window.show(); let _ = window.set_focus(); }
            }
            Err(error) => { let _ = app.emit("notebook-open-error", error); }
        }
    } else {
        let mut pending = EARLY_OPEN.lock().unwrap();
        if pending.len() < 32 { pending.push(path.to_path_buf()); }
    }
}
pub fn drain_open(app: &tauri::AppHandle) {
    let pending = std::mem::take(&mut *EARLY_OPEN.lock().unwrap());
    for path in pending { open_file(app, &path); }
}

#[cfg(test)]
mod tests {
    use super::*;
    struct Fixture { path: PathBuf, service: Notebooks }
    impl Fixture {
        fn new() -> Self {
            let path = std::env::temp_dir().join(format!("ledger-notebook-test-{}", uuid::Uuid::new_v4()));
            fs::create_dir_all(path.join("library/book/category/nested")).unwrap();
            fs::create_dir_all(path.join("library/book/unrelated")).unwrap();
            fs::write(path.join("library/book/category/nested/note.md"), "# Synthetic\n").unwrap();
            fs::write(path.join("library/book/unrelated/other.md"), "Do not scan").unwrap();
            let service = Notebooks::new(&path.join("profile")).unwrap();
            Self { path, service }
        }
        fn book(&self) -> String {
            self.service.register(&self.path.join("library/book"), "notebook").unwrap()["notebook"]["id"].as_str().unwrap().into()
        }
    }
    impl Drop for Fixture { fn drop(&mut self) { let _ = fs::remove_dir_all(&self.path); } }
    #[test]
    fn portable_paths_and_windows_device_names() {
        assert_eq!(portable_path(&Path::new("category").join("nested").join("note.md")), "category/nested/note.md");
        for name in ["CON", "nul.md", "LPT1.txt", "COM9", "CONIN$", "file:stream", "trailing.", "trailing ", "a?b", "a|b"] { assert!(!windows_name(name), "{name}"); }
        for name in ["中文笔记.md", "COM10.md", "[notes] & 'x'.md"] { assert!(windows_name(name), "{name}"); }
        for value in ["../note.md", "/note.md", "folder\\note.md", ".FAN/notebooks.json"] { assert!(relative(value).is_err()); }
    }
    #[test]
    fn imported_images_are_hidden_but_remain_resolvable_after_reopen() {
        let f = Fixture::new(); let id = f.book();
        let source = "category/nested/note.md";
        let imported = f.service.import_image(&id, source, include_bytes!("../icons/icon.png")).unwrap();
        assert!(!f.service.children(&id, "category/nested").unwrap().as_array().unwrap().iter().any(|entry| entry["name"] == "attachments"));
        let reopened = Notebooks::new(&f.path.join("profile")).unwrap();
        assert_eq!(reopened.resolve_image(&id, source, imported["src"].as_str().unwrap(), false).unwrap()["mime"], "image/png");
        fs::write(f.path.join("library/book/category/nested/attachments/Keep.md"), "A real note").unwrap();
        assert!(reopened.children(&id, "category/nested").unwrap().as_array().unwrap().iter().any(|entry| entry["name"] == "attachments"));
    }
    #[test]
    fn wiki_images_resolve_unique_names_and_reject_ambiguity() {
        let f = Fixture::new(); let id = f.book();
        fs::create_dir_all(f.path.join("library/book/附件")).unwrap();
        fs::write(f.path.join("library/book/附件/Pasted image 中文.png"), include_bytes!("../icons/icon.png")).unwrap();
        assert!(f.service.resolve_image(&id, "category/nested/note.md", "Pasted image 中文.png", true).is_ok());
        assert!(f.service.resolve_image(&id, "category/nested/note.md", "../../附件/Pasted%20image%20%E4%B8%AD%E6%96%87.png", false).is_ok());
        fs::write(f.path.join("library/book/unrelated/Pasted image 中文.png"), include_bytes!("../icons/icon.png")).unwrap();
        assert!(f.service.resolve_image(&id, "category/nested/note.md", "Pasted image 中文.png", true).unwrap_err().contains("More than one"));
        assert!(f.service.resolve_image(&id, "category/nested/note.md", "附件/Pasted image 中文.png", true).is_ok());
    }
    #[test]
    fn relocated_absolute_images_use_the_notes_companion_folder() {
        let f = Fixture::new(); let id = f.book();
        let folder = f.path.join("library/book/category/nested/报告.assets");
        fs::create_dir_all(folder.join("sub")).unwrap();
        fs::write(folder.join("1785287884999.png"), include_bytes!("../icons/icon.png")).unwrap();
        fs::write(folder.join("sub/含 空格.png"), include_bytes!("../icons/icon.png")).unwrap();
        let source = "category/nested/note.md";
        for reference in [
            r"C:\Archive\报告.assets\1785287884999.png",
            "C:/Archive/报告.assets/1785287884999.png",
            "file:///C:/Archive/报告.assets/1785287884999.png",
            "file:///C:/Archive/%E6%8A%A5%E5%91%8A.assets/sub/%E5%90%AB%20%E7%A9%BA%E6%A0%BC.png",
            "/old-notebook/报告.assets/1785287884999.png",
            "报告.assets/1785287884999.png",
        ] { assert_eq!(f.service.resolve_image(&id, source, reference, false).unwrap()["mime"], "image/png", "{reference}"); }
        assert!(f.service.resolve_image(&id, source, folder.join("1785287884999.png").to_str().unwrap(), false).is_ok());
        assert!(!f.service.children(&id, "category/nested").unwrap().as_array().unwrap().iter().any(|entry| entry["name"] == "报告.assets"));
    }
    #[test]
    fn companion_images_cannot_escape_or_guess_another_folder() {
        let f = Fixture::new(); let id = f.book();
        fs::create_dir_all(f.path.join("library/book/category/nested/报告.assets")).unwrap();
        fs::write(f.path.join("library/book/category/nested/1785287884999.png"), include_bytes!("../icons/icon.png")).unwrap();
        fs::write(f.path.join("library/book/category/nested/报告.assets/not-image.png"), "not an image").unwrap();
        for reference in ["C:/old/报告.assets/../1785287884999.png", "C:/old/报告.assets/%2e%2e/1785287884999.png", "C:/old/报告.assets/not-image.png", "C:/old/other.assets/1785287884999.png", "https://example.test/报告.assets/1785287884999.png", "file://remote/报告.assets/1785287884999.png"] {
            assert!(f.service.resolve_image(&id, "category/nested/note.md", reference, false).is_err(), "{reference}");
        }
    }
    #[cfg(unix)]
    #[test]
    fn relocated_images_do_not_follow_symlinked_companion_folders() {
        let f = Fixture::new(); let id = f.book();
        fs::create_dir_all(f.path.join("external")).unwrap();
        fs::write(f.path.join("external/image.png"), include_bytes!("../icons/icon.png")).unwrap();
        std::os::unix::fs::symlink(f.path.join("external"), f.path.join("library/book/category/nested/报告.assets")).unwrap();
        assert!(f.service.resolve_image(&id, "category/nested/note.md", "C:/old/报告.assets/image.png", false).is_err());
    }
    #[test]
    fn missing_or_non_image_references_are_rejected() {
        let f = Fixture::new(); let id = f.book();
        for reference in ["../../../outside.png", "../../.fan/secret.png", "javascript:alert(1)", "note.md"] {
            assert!(f.service.resolve_image(&id, "category/nested/note.md", reference, false).is_err(), "{reference}");
        }
    }
    #[test]
    fn explicit_external_images_are_read_only_and_take_precedence() {
        use base64::Engine;
        let f = Fixture::new(); let id = f.book(); let source = "category/nested/note.md";
        let folder = f.path.join("外部 图片/报告.assets");
        fs::create_dir_all(&folder).unwrap();
        let image = folder.join("中文 图片.png");
        let bytes = include_bytes!("../icons/icon.png"); fs::write(&image, bytes).unwrap();
        let companion = f.path.join("library/book/category/nested/报告.assets");
        fs::create_dir_all(&companion).unwrap(); fs::write(companion.join("中文 图片.png"), "must not choose the fallback").unwrap();
        let references = [image.to_string_lossy().into_owned(), url::Url::from_file_path(&image).unwrap().to_string(), "../../../../外部 图片/报告.assets/中文 图片.png".into()];
        for reference in references {
            let result = f.service.resolve_image(&id, source, &reference, false).unwrap();
            assert_eq!(result["base64"], base64::engine::general_purpose::STANDARD.encode(bytes));
        }
        assert_eq!(fs::read(&image).unwrap(), bytes);
        assert_eq!(fs::read_to_string(f.path.join("library/book").join(source)).unwrap(), "# Synthetic\n");
        assert!(f.service.save(&id, "../../external.md", "", "must not write outside").is_err());
    }
    #[test]
    fn local_images_reject_network_devices_protocols_and_streams() {
        for reference in [r"\\server\share\image.png", r"\\?\C:\image.png", r"\\.\PhysicalDrive0", r"\??\C:\image.png", "file://server/share/image.png", "file:////server/share/image.png", "%2f%2fserver/share/image.png", "C:/NUL.png", "C:/CON", "C:/image.png:stream", "C:relative.png", "javascript:alert(1)", "https://example.test/image.png", "data:image/png;base64,abc"] {
            assert!(local_image_reference(reference).is_err(), "{reference}");
        }
    }
    #[test]
    fn external_reads_enforce_image_format_size_and_dimensions() {
        let f = Fixture::new(); let id = f.book(); let source = "category/nested/note.md";
        let file = f.path.join("external.png"); fs::write(&file, "not an image").unwrap();
        assert!(f.service.resolve_image(&id, source, file.to_str().unwrap(), false).is_err());
        fs::File::create(&file).unwrap().set_len(MAX_IMAGE + 1).unwrap();
        assert!(f.service.resolve_image(&id, source, file.to_str().unwrap(), false).unwrap_err().contains("20 MiB"));
        let mut bytes = std::io::Cursor::new(Vec::new());
        image::RgbaImage::new(30001, 1).write_to(&mut bytes, image::ImageFormat::Png).unwrap();
        fs::write(&file, bytes.into_inner()).unwrap();
        assert!(f.service.resolve_image(&id, source, file.to_str().unwrap(), false).unwrap_err().contains("dimensions"));
        assert!(f.service.resolve_image(&id, source, f.path.to_str().unwrap(), false).is_err());
    }
    #[test]
    fn category_registers_parent_and_whitelists_only_selected_directory() {
        let f = Fixture::new();
        let opened = f.service.register(&f.path.join("library/book/category"), "category").unwrap();
        let id = opened["notebook"]["id"].as_str().unwrap();
        assert_eq!(opened["notebook"]["name"], "book");
        assert_eq!(opened["path"], "category");
        let entries = f.service.children(id, "").unwrap();
        assert_eq!(entries.as_array().unwrap().len(), 1);
        assert_eq!(entries[0]["name"], "category");
        assert!(f.service.read(id, "unrelated/other.md").is_err());
        assert!(f.service.read(id, "category/nested/note.md").is_ok());
        assert!(f.path.join("profile/.fan/notebooks.json").is_file());
        assert!(!f.path.join("library/book/.fan").exists());
    }
    #[test]
    fn nested_category_reuses_registered_notebook_and_home_open_expands_scope() {
        let f = Fixture::new();
        let first = f.service.register(&f.path.join("library/book/category"), "category").unwrap();
        let nested = f.service.register(&f.path.join("library/book/category/nested"), "category").unwrap();
        assert_eq!(first["notebook"]["id"], nested["notebook"]["id"]);
        assert_eq!(nested["path"], "category/nested");
        let all = f.service.register(&f.path.join("library/book"), "notebook").unwrap();
        assert_eq!(first["notebook"]["id"], all["notebook"]["id"]);
        assert_eq!(f.service.children(all["notebook"]["id"].as_str().unwrap(), "").unwrap().as_array().unwrap().len(), 2);
    }
    #[test]
    fn registry_reopens_without_walking_or_reading_notebook_directories() {
        let f = Fixture::new(); let id = f.book();
        fs::rename(f.path.join("library"), f.path.join("offline")).unwrap();
        let again = Notebooks::new(&f.path.join("profile")).unwrap();
        assert_eq!(again.index().unwrap()["notebooks"][0]["id"], id);
        assert!(again.children(&id, "").is_err());
    }
    #[test]
    fn saves_utf8_bom_and_crlf_without_changing_other_files() {
        let f = Fixture::new(); let id = f.book();
        let file = f.path.join("library/book/category/nested/note.md");
        fs::write(&file, "\u{feff}# Original\r\n\r\n").unwrap();
        let read = f.service.read(&id, "category/nested/note.md").unwrap();
        assert_eq!(read["content"], "# Original\n\n");
        f.service.save(&id, "category/nested/note.md", read["revision"].as_str().unwrap(), "# Edited\n").unwrap();
        assert_eq!(fs::read_to_string(file).unwrap(), "\u{feff}# Edited\r\n");
        assert_eq!(fs::read_to_string(f.path.join("library/book/unrelated/other.md")).unwrap(), "Do not scan");
    }
    #[test]
    fn external_edits_create_conflict_copy_without_overwriting_either_version() {
        let f = Fixture::new(); let id = f.book();
        let file = f.path.join("library/book/category/nested/note.md");
        let read = f.service.read(&id, "category/nested/note.md").unwrap();
        fs::write(&file, "External edit").unwrap();
        let result = f.service.save(&id, "category/nested/note.md", read["revision"].as_str().unwrap(), "Local edit").unwrap();
        assert_eq!(result["conflict"], true);
        assert_eq!(fs::read_to_string(file).unwrap(), "External edit");
        assert_eq!(f.service.read(&id, result["path"].as_str().unwrap()).unwrap()["content"], "Local edit");
    }
    #[test]
    fn missing_file_keeps_recovery_draft() {
        let f = Fixture::new(); let id = f.book();
        fs::remove_file(f.path.join("library/book/category/nested/note.md")).unwrap();
        assert!(f.service.save(&id, "category/nested/note.md", "old", "Unsaved edit").is_err());
        assert_eq!(fs::read_dir(f.path.join("profile/.fan/recovery")).unwrap().count(), 1);
    }
    #[test]
    #[cfg(unix)]
    fn traversal_and_symlink_escape_are_rejected() {
        use std::os::unix::fs::symlink;
        let f = Fixture::new(); let id = f.book();
        fs::write(f.path.join("outside.md"), "Outside").unwrap();
        symlink(f.path.join("outside.md"), f.path.join("library/book/escape.md")).unwrap();
        assert!(f.service.read(&id, "../../outside.md").is_err());
        assert!(f.service.read(&id, "escape.md").is_err());
        assert!(f.service.read(&id, "/outside.md").is_err());
        assert!(f.service.children(&id, ".fan").is_err());
        assert!(!f.service.children(&id, "").unwrap().to_string().contains("escape.md"));
    }
    #[test]
    fn creation_and_rename_preserve_registered_category_scope() {
        let f = Fixture::new();
        let opened = f.service.register(&f.path.join("library/book/category"), "category").unwrap();
        let id = opened["notebook"]["id"].as_str().unwrap();
        f.service.create(id, "", "New folder", "directory").unwrap();
        f.service.create(id, "New folder", "Note", "file").unwrap();
        assert!(f.service.create(id, "New folder", "Note", "file").is_err());
        f.service.rename(id, "New folder", "Renamed").unwrap();
        assert!(f.service.read(id, "Renamed/Note.md").is_ok());
        f.service.forget(id).unwrap();
        assert!(f.service.index().unwrap()["notebooks"].as_array().unwrap().is_empty());
        assert!(f.path.join("library/book/Renamed/Note.md").exists());
    }
    #[test]
    fn corrupt_registry_remains_intact_and_reports_an_error() {
        let f = Fixture::new();
        fs::create_dir_all(f.path.join("profile/.fan")).unwrap();
        fs::write(f.path.join("profile/.fan/notebooks.json"), "broken index").unwrap();
        let service = Notebooks::new(&f.path.join("profile")).unwrap();
        assert!(service.index().is_err());
        assert!(service.register(&f.path.join("library/book"), "notebook").is_err());
        assert_eq!(fs::read_to_string(f.path.join("profile/.fan/notebooks.json")).unwrap(), "broken index");
    }
    #[test]
    fn read_only_file_keeps_original_and_recovers_the_edit() {
        let f = Fixture::new(); let id = f.book();
        let path = f.path.join("library/book/category/nested/note.md");
        let original = f.service.read(&id, "category/nested/note.md").unwrap();
        let mut permissions = fs::metadata(&path).unwrap().permissions(); permissions.set_readonly(true); fs::set_permissions(&path, permissions).unwrap();
        assert!(f.service.save(&id, "category/nested/note.md", original["revision"].as_str().unwrap(), "Draft").is_err());
        let recovered = f.service.read(&id, "category/nested/note.md").unwrap();
        assert_eq!(recovered["content"], original["content"]);
        assert_eq!(recovered["draft"]["content"], "Draft");
    }
}
