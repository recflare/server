CREATE TABLE bug_report (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    account_id INTEGER NOT NULL,
    created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
    payload TEXT NOT NULL CHECK (json_valid(payload))
);
CREATE INDEX bug_report_account_created ON bug_report (account_id, created_at);
