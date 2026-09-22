use base64::{engine::general_purpose::STANDARD, Engine};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::{fs, io::Write, path::Path};

pub fn hash(bytes: &[u8]) -> String {
    format!("{:x}", Sha256::digest(bytes))
}

pub fn inspect(bytes: &[u8]) -> Result<(&'static str, &'static str), String> {
    if bytes.is_empty() || bytes.len() > 20 * 1024 * 1024 {
        return Err("Image must be between 1 byte and 20 MB".into());
    }
    let format = image::guess_format(bytes).map_err(|_| "Unsupported image")?;
    let (ext, mime) = match format {
        image::ImageFormat::Png => ("png", "image/png"),
        image::ImageFormat::Jpeg => ("jpg", "image/jpeg"),
        image::ImageFormat::Gif => ("gif", "image/gif"),
        image::ImageFormat::WebP => ("webp", "image/webp"),
        _ => return Err("Only PNG, JPEG, GIF and WebP are supported".into()),
    };
    let reader = image::ImageReader::with_format(std::io::Cursor::new(bytes), format);
    let (width, height) = reader
        .into_dimensions()
        .map_err(|_| "Invalid image dimensions")?;
    if width == 0
        || height == 0
        || width > 30000
        || height > 30000
        || u64::from(width) * u64::from(height) > 100_000_000
    {
        return Err("Image dimensions exceed limits".into());
    }
    Ok((ext, mime))
}

pub fn atomic_write(path: &Path, bytes: &[u8]) -> Result<(), String> {
    #[cfg(unix)]
    use std::os::unix::fs::OpenOptionsExt;
    let temp = path.with_extension(format!("{}.tmp", uuid::Uuid::new_v4()));
    let result = (|| {
        let mut options = fs::OpenOptions::new();
        options.write(true).create_new(true);
        #[cfg(unix)]
        options.mode(0o600);
        let mut file = options
            .open(&temp)
            .map_err(|_| "Cannot create temporary file")?;
        file.write_all(bytes)
            .and_then(|_| file.sync_all())
            .map_err(|_| "Cannot write file")?;
        drop(file);
        fs::rename(&temp, path).map_err(|_| "Cannot publish file")?;
        #[cfg(unix)]
        if let Some(parent) = path.parent() {
            fs::File::open(parent)
                .and_then(|dir| dir.sync_all())
                .map_err(|_| "Cannot sync directory")?;
        }
        Ok(())
    })();
    if result.is_err() {
        let _ = fs::remove_file(temp);
    }
    result
}

pub fn import(directory: &Path, bytes: &[u8], name: &str) -> Result<Value, String> {
    let (ext, _) = inspect(bytes)?;
    let filename = format!("{}.{}", hash(bytes), ext);
    let target = directory.join(&filename);
    if target.exists() {
        if fs::read(&target).map_err(|_| "Cannot read existing attachment")? != bytes {
            return Err("Attachment integrity check failed".into());
        }
    } else {
        atomic_write(&target, bytes)?;
    }
    let name = name
        .rsplit(['/', '\\'])
        .next()
        .unwrap_or("image")
        .chars()
        .filter(|c| !c.is_control())
        .take(180)
        .collect::<String>();
    Ok(json!({"src":format!("/attachments/{filename}"),"name":name}))
}

pub fn read(directory: &Path, src: &str) -> Result<(Vec<u8>, &'static str), String> {
    let name = src
        .strip_prefix("/attachments/")
        .ok_or("Invalid attachment source")?;
    let (digest, ext) = name.split_once('.').ok_or("Invalid attachment ID")?;
    if digest.len() != 64
        || !digest
            .bytes()
            .all(|c| c.is_ascii_digit() || (b'a'..=b'f').contains(&c))
        || !["png", "jpg", "gif", "webp"].contains(&ext)
    {
        return Err("Invalid attachment ID".into());
    }
    let target = directory.join(name);
    let metadata = fs::symlink_metadata(&target).map_err(|_| "Attachment is missing")?;
    if !metadata.is_file() || metadata.len() > 20 * 1024 * 1024 {
        return Err("Invalid attachment file".into());
    }
    let bytes = fs::read(target).map_err(|_| "Cannot read attachment")?;
    let (actual, mime) = inspect(&bytes)?;
    if actual != ext || hash(&bytes) != digest {
        return Err("Attachment integrity check failed".into());
    }
    Ok((bytes, mime))
}

pub fn pdf_html(directory: &Path, html: &str) -> Result<String, String> {
    if html.trim().is_empty() || html.len() > 8 * 1024 * 1024 {
        return Err("PDF HTML must be between 1 byte and 8 MB".into());
    }
    let fragment = scraper::Html::parse_fragment(html);
    let mut replacements = Vec::new();
    for element in fragment.select(&scraper::Selector::parse("*").unwrap()) {
        if [
            "script", "iframe", "object", "embed", "base", "link", "meta", "style", "form",
        ]
        .contains(&element.value().name())
        {
            return Err("PDF contains unsupported markup".into());
        }
        let table_cell = matches!(element.value().name(), "th" | "td");
        if element
            .value()
            .attrs()
            .any(|(name, value)| name.starts_with("on") || name == "srcset" ||
                (name == "style" && !(table_cell && matches!(value, "text-align:left" | "text-align:right" | "text-align:center"))))
        {
            return Err("PDF contains active attributes".into());
        }
        if element.value().name() == "img" {
            let source = element
                .value()
                .attr("src")
                .ok_or("PDF image has no source")?;
            let source_path = source.strip_prefix("asset-ledger://app").unwrap_or(source);
            let (bytes, mime) = read(directory, source_path)?;
            replacements.push((
                source.to_string(),
                format!("data:{mime};base64,{}", STANDARD.encode(bytes)),
            ));
        }
    }
    let mut body = fragment.html();
    for (from, to) in replacements {
        body = body.replace(&format!("src=\"{from}\""), &format!("src=\"{to}\""));
    }
    Ok(format!("<!doctype html><html><head><meta charset=\"utf-8\"><meta http-equiv=\"Content-Security-Policy\" content=\"default-src 'none'; img-src data:; style-src 'unsafe-inline'\"><style>{}</style></head><body>{body}</body></html>", include_str!("../native/print.css")))
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn reject_paths_and_active_pdf() {
        assert!(read(Path::new("/tmp"), "/attachments/../../etc/passwd").is_err());
        assert!(inspect(b"not an image").is_err());
        assert!(pdf_html(Path::new("/tmp"), "<script>alert(1)</script>").is_err());
        assert!(pdf_html(Path::new("/tmp"), "<img src=\"https://example.com/a.png\">").is_err());
        assert!(pdf_html(Path::new("/tmp"), "<h1>中文</h1><p>synthetic</p>")
            .unwrap()
            .contains("中文"));
    }
    #[test]
    fn markdown_table_alignment_is_allowed_without_arbitrary_css() {
        assert!(pdf_html(Path::new("/tmp"), "<table><tr><th style=\"text-align:right\">中文</th></tr></table>").is_ok());
        assert!(pdf_html(Path::new("/tmp"), "<table><tr><td style=\"background:url(file:///etc/passwd)\">x</td></tr></table>").is_err());
    }
}
