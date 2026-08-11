-- Player-report storage. Like the relationship table (and unlike the JSON-blob
-- tables in this shared database), a report is genuinely columnar, so it gets a
-- normal relational table. Owned by the `api` worker; generated from
-- src/reports-db.ts (SCHEMA_DDL) — keep in sync.
--
-- One row per submitted report; nothing updates or dedupes them, so the table is
-- an append-only log of what players sent. `reporter_player_id` comes from the
-- caller's bearer token, everything else from the form body.

CREATE TABLE IF NOT EXISTS report (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  reporter_player_id INTEGER NOT NULL,
  reported_player_id INTEGER NOT NULL,
  report_category INTEGER NOT NULL DEFAULT 0,
  details TEXT,
  height_reporter REAL,
  height_reported REAL,
  room_id INTEGER,
  room_instance_type TEXT,
  created_at TEXT NOT NULL
  );
CREATE INDEX IF NOT EXISTS idx_report_reported ON report (reported_player_id);
CREATE INDEX IF NOT EXISTS idx_report_reporter ON report (reporter_player_id);
