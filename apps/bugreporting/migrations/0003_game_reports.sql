CREATE TABLE game_report (
 id TEXT PRIMARY KEY,
 account_id INTEGER NOT NULL,
 created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
 completed_at TEXT,
 client TEXT NOT NULL CHECK (json_valid(client)),
 user_info TEXT CHECK (user_info IS NULL OR json_valid(user_info))
);
CREATE INDEX game_report_account_created ON game_report(account_id, created_at);
CREATE TABLE game_report_file (
 report_id TEXT NOT NULL REFERENCES game_report(id),
 filename TEXT NOT NULL,
 content_type TEXT NOT NULL,
 size INTEGER NOT NULL,
 object_key TEXT NOT NULL UNIQUE,
 PRIMARY KEY (report_id, filename)
);
