PRAGMA journal_mode=WAL;
PRAGMA synchronous=FULL;
PRAGMA foreign_keys=ON;
BEGIN IMMEDIATE;
CREATE TABLE IF NOT EXISTS records(kind TEXT NOT NULL, id TEXT NOT NULL, metadata TEXT NOT NULL, body TEXT, position INTEGER NOT NULL, PRIMARY KEY(kind,id));
CREATE TABLE IF NOT EXISTS kv(key TEXT PRIMARY KEY, value TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS receipts(origin TEXT NOT NULL, id TEXT NOT NULL, fingerprint TEXT NOT NULL, result TEXT NOT NULL, PRIMARY KEY(origin,id));
CREATE TABLE IF NOT EXISTS connections(origin TEXT PRIMARY KEY, hash TEXT NOT NULL);
CREATE VIRTUAL TABLE IF NOT EXISTS note_search USING fts5(kind UNINDEXED, id UNINDEXED, body, content='records', content_rowid='rowid', tokenize='trigram');
CREATE TRIGGER IF NOT EXISTS records_search_insert AFTER INSERT ON records BEGIN
  INSERT INTO note_search(rowid,kind,id,body) VALUES(new.rowid,new.kind,new.id,new.body);
END;
CREATE TRIGGER IF NOT EXISTS records_search_delete AFTER DELETE ON records BEGIN
  INSERT INTO note_search(note_search,rowid,kind,id,body) VALUES('delete',old.rowid,old.kind,old.id,old.body);
END;
CREATE TRIGGER IF NOT EXISTS records_search_update AFTER UPDATE ON records WHEN old.body IS NOT new.body BEGIN
  INSERT INTO note_search(note_search,rowid,kind,id,body) VALUES('delete',old.rowid,old.kind,old.id,old.body);
  INSERT INTO note_search(rowid,kind,id,body) VALUES(new.rowid,new.kind,new.id,new.body);
END;
INSERT INTO note_search(note_search) SELECT 'rebuild' WHERE (SELECT user_version FROM pragma_user_version) < 2;
PRAGMA user_version=2;
COMMIT;
