use serde::Deserialize;
use std::{io, path::{Component, Path, PathBuf}};

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Profile {
    data_directory: PathBuf,
}

fn decode(bytes: &[u8]) -> io::Result<PathBuf> {
    let profile: Profile = notechain::json_io::decode(bytes)
        .map_err(|error| io::Error::new(io::ErrorKind::InvalidData, error))?;
    let directory = profile.data_directory;
    if !directory.is_absolute() || directory.parent().is_none()
        || directory.components().any(|component| component == Component::ParentDir) {
        return Err(io::Error::new(io::ErrorKind::InvalidData, "Data directory must be an absolute non-root path without parent traversal"));
    }
    Ok(directory)
}

pub fn directory(config: &Path, default: PathBuf) -> io::Result<PathBuf> {
    match std::fs::read(config) {
        Ok(bytes) => decode(&bytes),
        Err(error) if error.kind() == io::ErrorKind::NotFound => Ok(default),
        Err(error) => Err(error),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn explicit_profile_and_invalid_profile_do_not_fall_back_to_another_library() {
        let synthetic = std::env::temp_dir().join("synthetic-ledger");
        assert_eq!(decode(serde_json::json!({"dataDirectory":synthetic}).to_string().as_bytes()).unwrap(), synthetic);
        for input in [br#"{}"#.as_slice(), br#"{"dataDirectory":"relative"}"#, br#"{"dataDirectory":"/"}"#, br#"{"dataDirectory":"/tmp/../"}"#, b"invalid JSON"] {
            assert!(decode(input).is_err());
        }
    }
}
