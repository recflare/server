CREATE TABLE IF NOT EXISTS studio_cloud_build_job (
 cloud_build_id TEXT PRIMARY KEY,
 payload TEXT NOT NULL,
 status TEXT NOT NULL DEFAULT 'queued',
 lease_token TEXT,
 lease_until TEXT,
 attempts INTEGER NOT NULL DEFAULT 0,
 created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_studio_build_job_queue ON studio_cloud_build_job(status, created_at);
