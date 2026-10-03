-- Who may upload from RecFlare Studio. The editor treats Full access as the JWT
-- role claim `betastudio` and nothing else (developer does not grant it). Auth
-- stamps that claim, on every login and every refresh, only for rows in this
-- table. Staff add and remove rows from the website
-- (`/settings/recroomstudio`); this worker only reads them.
--
-- Owned here, with the rest of the auth schema. www has no migrations_dir, so
-- a login looks this table up and fails until `just migrate -F auth` has run.
-- Kept in sync with STUDIO_BETA_ACCESS_SCHEMA_DDL in
-- packages/domain/src/studio-access-db.ts.

CREATE TABLE IF NOT EXISTS studio_beta_access (
  account_id INTEGER PRIMARY KEY,
  granted_by INTEGER NOT NULL,
  granted_at TEXT NOT NULL
);
