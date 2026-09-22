use rusqlite::{params, Connection, OptionalExtension};
use serde_json::{json, Value};
use std::path::Path;

pub const KINDS: [&str; 6] = [
    "cases",
    "assets",
    "targets",
    "findings",
    "tasks",
    "relations",
];

pub fn open(path: &Path) -> Result<Connection, String> {
    let db = Connection::open(path).map_err(|_| "Cannot open development database")?;
    let version: i64 = db
        .query_row("PRAGMA user_version", [], |row| row.get(0))
        .map_err(|_| "Cannot inspect database version")?;
    if version > 2 {
        return Err("This library requires a newer client".into());
    }
    db.execute_batch(include_str!("../schema.sql"))
        .map_err(|_| "Cannot initialize database")?;
    Ok(db)
}

pub fn backlinks(db: &Connection, href: &str, asset_id: &str) -> Result<Vec<String>, String> {
    if href.len() > 500 || asset_id.len() > 100 {
        return Err("Invalid backlink query".into());
    }
    let quote = |value: &str| format!("\"{}\"", value.replace('"', "\"\""));
    let asset = format!("asset://{asset_id}");
    let query = format!("{} OR {}", quote(href), quote(&asset));
    let mut statement = db
        .prepare("SELECT id FROM note_search WHERE note_search MATCH ?1 AND kind='assets'")
        .map_err(|_| "Backlink index unavailable")?;
    let rows = statement
        .query_map([query], |row| row.get::<_, String>(0))
        .map_err(|_| "Backlink lookup failed")?;
    rows.collect::<Result<Vec<_>, _>>()
        .map_err(|_| "Backlink lookup failed".into())
}

pub fn index(db: &Connection) -> Result<Value, String> {
    let mut state = json!({"cases":[],"assets":[],"targets":[],"findings":[],"tasks":[],"relations":[],"reading":{},"lastLocation":null,"theme":"light"});
    let mut query = db
        .prepare("SELECT kind,metadata,body IS NOT NULL FROM records ORDER BY position")
        .map_err(|_| "Cannot read index")?;
    let rows = query
        .query_map([], |row| {
            Ok((
                row.get::<_, String>(0)?,
                row.get::<_, String>(1)?,
                row.get::<_, bool>(2)?,
            ))
        })
        .map_err(|_| "Cannot read index")?;
    for row in rows {
        let (kind, text, has_body) = row.map_err(|_| "Cannot read record")?;
        let mut record: Value = serde_json::from_str(&text).map_err(|_| "Invalid stored record")?;
        if has_body {
            record["_bodyPending"] = json!(true);
        }
        state[&kind]
            .as_array_mut()
            .ok_or("Invalid record type")?
            .push(record);
    }
    let mut kv = serde_json::Map::new();
    let mut query = db
        .prepare("SELECT key,value FROM kv")
        .map_err(|_| "Cannot read preferences")?;
    for row in query
        .query_map([], |row| {
            Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?))
        })
        .map_err(|_| "Cannot read preferences")?
    {
        let (key, value) = row.map_err(|_| "Cannot read preference")?;
        if key == "activity" {
            let activity: Value = serde_json::from_str(&value).map_err(|_| "Invalid activity")?;
            state["reading"] = activity["reading"].clone();
            state["lastLocation"] = activity["lastLocation"].clone();
        } else if key == "theme" {
            state["theme"] = json!(value);
        } else {
            kv.insert(key, json!(value));
        }
    }
    Ok(json!({"state": state, "kv":kv}))
}

pub fn apply(db: &mut Connection, operations: &[Value]) -> Result<(), String> {
    if operations.len() > 50000 {
        return Err("Too many changes".into());
    }
    let tx = db.transaction().map_err(|_| "Cannot begin save")?;
    for op in operations {
        if let Some(key) = op["key"].as_str() {
            let legacy_reading = key.starts_with("file-reading:");
            if key.len() > if legacy_reading { 8192 } else { 150 }
                || !(legacy_reading || key.starts_with("asset-ledger-") || key == "activity" || key == "theme")
            {
                return Err("Invalid preference key".into());
            }
            let value = op["value"].as_str().ok_or("Invalid preference value")?;
            tx.execute(
                "INSERT INTO kv VALUES(?1,?2) ON CONFLICT(key) DO UPDATE SET value=excluded.value",
                params![key, value],
            )
            .map_err(|_| "Cannot save preference")?;
            continue;
        }
        let kind = op["kind"]
            .as_str()
            .filter(|kind| KINDS.contains(kind))
            .ok_or("Invalid record type")?;
        let id = op["id"]
            .as_str()
            .filter(|id| !id.is_empty() && id.len() <= 100)
            .ok_or("Invalid record ID")?;
        if op["delete"] == true {
            tx.execute(
                "DELETE FROM records WHERE kind=?1 AND id=?2",
                params![kind, id],
            )
            .map_err(|_| "Cannot delete record")?;
        } else {
            let mut record = op["record"].clone();
            if record["id"] != id {
                return Err("Record ID mismatch".into());
            }
            let object = record.as_object_mut().ok_or("Invalid record")?;
            let body = object.remove("noteMarkdown");
            object.remove("_bodyPending");
            let body = body
                .map(|v| v.as_str().map(String::from).ok_or("Invalid note body"))
                .transpose()?;
            tx.execute("INSERT INTO records(kind,id,metadata,body,position) VALUES(?1,?2,?3,?4,?5)
                ON CONFLICT(kind,id) DO UPDATE SET metadata=excluded.metadata,body=CASE WHEN ?6 THEN excluded.body ELSE records.body END,position=excluded.position",
                params![kind,id,record.to_string(),body,op["position"].as_i64().unwrap_or(0),body.is_some()]).map_err(|_| "Cannot save record")?;
        }
    }
    tx.commit().map_err(|_| "Cannot commit changes".into())
}

pub fn body(db: &Connection, kind: &str, id: &str) -> Result<Value, String> {
    if !KINDS.contains(&kind) {
        return Err("Invalid record type".into());
    }
    let result: Option<Option<String>> = db
        .query_row(
            "SELECT body FROM records WHERE kind=?1 AND id=?2",
            params![kind, id],
            |row| row.get(0),
        )
        .optional()
        .map_err(|_| "Cannot read note")?;
    match result {
        Some(body) => Ok(json!(body)),
        None => Err("Note does not exist".into()),
    }
}

#[cfg(test)]
mod tests {
    #[test]
    fn legacy_file_reading_does_not_block_following_note_saves() {
        let mut db = open(Path::new(":memory:")).unwrap();
        let key = format!("file-reading:book:{}笔记.md", "嵌套目录/".repeat(30));
        apply(&mut db, &[
            json!({"key":key,"value":"300"}),
            json!({"kind":"assets","id":"image-note","record":{"id":"image-note","noteMarkdown":"![image](/attachments/example.png)"}}),
        ]).unwrap();
        assert_eq!(body(&db, "assets", "image-note").unwrap(), "![image](/attachments/example.png)");
        assert!(apply(&mut db, &[json!({"key":"arbitrary-preference","value":"x"})]).is_err());
    }
    #[test]
    fn empty_library_preserves_preferences_without_creating_records() {
        let mut db = rusqlite::Connection::open_in_memory().unwrap();
        db.execute_batch(include_str!("../schema.sql")).unwrap();
        super::apply(&mut db, &[serde_json::json!({"key":"theme","value":"dark"})]).unwrap();
        let index = super::index(&db).unwrap();
        assert_eq!(index["state"]["theme"], "dark");
        assert_eq!(index["state"]["cases"], serde_json::json!([]));
        assert_eq!(index["state"]["assets"], serde_json::json!([]));
    }
    use super::*;
    #[test]
    fn indexed_backlinks_track_transactional_body_changes() {
        let mut db = open(Path::new(":memory:")).unwrap();
        apply(&mut db, &[json!({"kind":"assets","id":"source","record":{"id":"source","noteMarkdown":"[中文](/cases/c/assets/target#heading)"}})]).unwrap();
        assert_eq!(
            backlinks(&db, "/cases/c/assets/target", "target").unwrap(),
            vec!["source"]
        );
        apply(&mut db, &[json!({"kind":"assets","id":"source","record":{"id":"source","noteMarkdown":"No reference remains"}})]).unwrap();
        assert!(backlinks(&db, "/cases/c/assets/target", "target")
            .unwrap()
            .is_empty());
    }
    #[test]
    fn incremental_records_and_atomic_rollback() {
        let mut db = open(Path::new(":memory:")).unwrap();
        apply(&mut db, &[json!({"kind":"assets","id":"a","position":0,"record":{"id":"a","title":"Synthetic","noteMarkdown":"中文 [link](/cases/c \"asset-ledger-link:v1:test\")"}})]).unwrap();
        let index = index(&db).unwrap();
        assert!(index["state"]["assets"][0].get("noteMarkdown").is_none());
        assert_eq!(index["state"]["assets"][0]["_bodyPending"], true);
        apply(
            &mut db,
            &[json!({"kind":"assets","id":"a","record":{"id":"a","title":"Renamed"}})],
        )
        .unwrap();
        assert!(body(&db, "assets", "a")
            .unwrap()
            .as_str()
            .unwrap()
            .starts_with("中文"));
        assert!(apply(
            &mut db,
            &[
                json!({"key":"theme","value":"dark"}),
                json!({"kind":"invalid","id":"x"})
            ]
        )
        .is_err());
        assert_eq!(super::index(&db).unwrap()["state"]["theme"], "light");
    }
}
