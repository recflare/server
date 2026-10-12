CREATE TABLE tcm_todo (
    id TEXT PRIMARY KEY,
    title TEXT NOT NULL,
    completed INTEGER NOT NULL DEFAULT 0 CHECK (completed IN (0, 1)),
    created_by INTEGER NOT NULL,
    created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
    case_id TEXT NOT NULL REFERENCES tcm_case(id),
    updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);
CREATE UNIQUE INDEX tcm_todo_case ON tcm_todo(case_id);
