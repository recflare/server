CREATE TABLE IF NOT EXISTS studio_artifact_upload (
 id TEXT PRIMARY KEY, build_id TEXT NOT NULL, lease TEXT NOT NULL,
 artifact TEXT NOT NULL, object_key TEXT NOT NULL, final_key TEXT NOT NULL, upload_id TEXT NOT NULL,
 size INTEGER NOT NULL, hash TEXT NOT NULL, state TEXT NOT NULL DEFAULT 'open',
 created_at TEXT NOT NULL,
 UNIQUE(build_id,lease,artifact)
);
