-- Per-player objective progress — the daily/weekly challenge checklist. The client
-- reports progress with `/api/objectives/v1/updateobjective` and reads it back from
-- `/api/objectives/v1/myprogress`.
--
-- An objective is keyed by (account, group, index) — the client's own identifiers —
-- so updates upsert on that triple. `has_claimed_reward` latches on first completion
-- so a reward can't be paid twice. `group`/`index` are SQL keywords, hence the
-- `group_id`/`idx` column names. Owned by the `econ` worker; generated from
-- src/objectives-db.ts (SCHEMA_DDL) — keep in sync.

CREATE TABLE IF NOT EXISTS objective (
  account_id INTEGER NOT NULL,
  group_id INTEGER NOT NULL,
  idx INTEGER NOT NULL,
  progress REAL NOT NULL DEFAULT 0,
  visual_progress REAL NOT NULL DEFAULT 0,
  is_completed INTEGER NOT NULL DEFAULT 0,
  is_rewarded INTEGER NOT NULL DEFAULT 0,
  has_claimed_reward INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (account_id, group_id, idx)
  );
CREATE INDEX IF NOT EXISTS idx_objective_account ON objective (account_id);
