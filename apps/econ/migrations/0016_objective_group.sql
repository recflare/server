-- A player's objective *groups* — the daily/weekly sets their objectives belong to.
-- The client clears a group when it's finished with it (`/api/objectives/v1/cleargroup`),
-- which marks it completed and stamps the clear time; `myprogress` reads the groups
-- back alongside the objectives themselves.
--
-- Keyed by (account, group), the client's own identifier. `group` is a SQL keyword,
-- hence `group_id`. Owned by the `econ` worker; generated from src/objectives-db.ts
-- (SCHEMA_DDL) — keep in sync.

CREATE TABLE IF NOT EXISTS objective_group (
  account_id INTEGER NOT NULL,
  group_id INTEGER NOT NULL,
  is_completed INTEGER NOT NULL DEFAULT 0,
  cleared_at TEXT,
  PRIMARY KEY (account_id, group_id)
  );
