use serde::de::DeserializeOwned;

// Windows PowerShell 5.1 redirection produces UTF-16; Set-Content UTF8 adds a BOM.
pub fn decode<T: DeserializeOwned>(bytes: &[u8]) -> Result<T, String> {
    let text = if bytes.starts_with(&[0xff, 0xfe]) || bytes.starts_with(&[0xfe, 0xff]) {
        if bytes.len() % 2 != 0 { return Err("Incomplete UTF-16 JSON file".into()); }
        let little = bytes[0] == 0xff;
        let units: Vec<u16> = bytes[2..].chunks_exact(2).map(|b| {
            if little { u16::from_le_bytes([b[0], b[1]]) } else { u16::from_be_bytes([b[0], b[1]]) }
        }).collect();
        String::from_utf16(&units).map_err(|_| "Invalid UTF-16 JSON file")?
    } else {
        String::from_utf8(bytes.strip_prefix(&[0xef, 0xbb, 0xbf]).unwrap_or(bytes).to_vec())
            .map_err(|_| "JSON must be UTF-8 or BOM-marked UTF-16")?
    };
    serde_json::from_str(&text).map_err(|error| format!("Invalid JSON: {error}"))
}

// ASCII JSON survives both legacy Windows console code pages and redirected output.
// JSON parsers restore the original Unicode, including supplementary characters.
pub fn console_json(value: &serde_json::Value) -> String {
    let mut output = String::new();
    for c in value.to_string().chars() {
        if c.is_ascii() { output.push(c); }
        else { for unit in c.encode_utf16(&mut [0; 2]) { output.push_str(&format!("\\u{unit:04x}")); } }
    }
    output
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::{json, Value};
    #[test]
    fn powershell_encodings_and_unicode_round_trip() {
        let value = json!({"path":"C:\\中文 笔记\\[a]'$&.md", "text":"中文🙂"});
        let text = value.to_string();
        let mut variants = vec![text.as_bytes().to_vec(), [b"\xef\xbb\xbf".as_slice(), text.as_bytes()].concat()];
        for little in [true, false] {
            let mut bytes = if little { vec![0xff,0xfe] } else { vec![0xfe,0xff] };
            for unit in text.encode_utf16() { bytes.extend(if little { unit.to_le_bytes() } else { unit.to_be_bytes() }); }
            variants.push(bytes);
        }
        for bytes in variants { assert_eq!(decode::<Value>(&bytes).unwrap(), value); }
        let output = console_json(&value);
        assert!(output.is_ascii());
        assert_eq!(decode::<Value>(output.as_bytes()).unwrap(), value);
        assert!(decode::<Value>(&[0xff,0xfe,0]).is_err());
        assert!(decode::<Value>(&[0xff,0xfe,0,0xd8]).is_err());
    }
}
