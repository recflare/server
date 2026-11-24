CREATE TABLE IF NOT EXISTS studio_editor_upload (
 id TEXT PRIMARY KEY, session_id TEXT NOT NULL, account_id INTEGER NOT NULL,
 room_id INTEGER NOT NULL, sub_room_id INTEGER NOT NULL, unity_asset_id TEXT NOT NULL,
 platform TEXT NOT NULL, kind TEXT NOT NULL, object_key TEXT NOT NULL, upload_id TEXT NOT NULL,
 size INTEGER NOT NULL, hash TEXT NOT NULL, state TEXT NOT NULL DEFAULT 'open',
 created_at TEXT NOT NULL,
 UNIQUE(session_id,platform,kind)
);
CREATE INDEX IF NOT EXISTS studio_editor_upload_account ON studio_editor_upload(account_id);
CREATE INDEX IF NOT EXISTS studio_editor_upload_created ON studio_editor_upload(created_at);
