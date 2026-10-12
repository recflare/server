CREATE TABLE tcm_plan (id INTEGER PRIMARY KEY, name TEXT NOT NULL, description TEXT NOT NULL, created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')));
CREATE TABLE tcm_pass (id INTEGER PRIMARY KEY, plan_id INTEGER NOT NULL REFERENCES tcm_plan(id), name TEXT NOT NULL, description TEXT NOT NULL, start_date TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')), end_date TEXT, manually_closed INTEGER NOT NULL DEFAULT 0);
CREATE TABLE tcm_case (id TEXT PRIMARY KEY, pass_id INTEGER NOT NULL REFERENCES tcm_pass(id), title TEXT NOT NULL, description TEXT NOT NULL, room_name TEXT NOT NULL DEFAULT '', status INTEGER NOT NULL DEFAULT 0 CHECK(status BETWEEN 0 AND 4), assigned_account_id INTEGER);
CREATE TABLE tcm_comment (id INTEGER PRIMARY KEY AUTOINCREMENT, case_id TEXT NOT NULL REFERENCES tcm_case(id), account_id INTEGER NOT NULL, comment TEXT NOT NULL, created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')));
CREATE INDEX tcm_case_pass ON tcm_case(pass_id);
CREATE INDEX tcm_comment_case ON tcm_comment(case_id, id);
