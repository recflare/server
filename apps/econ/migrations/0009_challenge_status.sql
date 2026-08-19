-- Weekly-challenge progress, owned by the `econ` worker. One row per (account,
-- challenge): the client evaluates a challenge's rule tree locally and posts its verdict
-- to `/api/challenge/v2/updateProgress`, which upserts here; `/api/challenge/v2/getCurrent`
-- reads the rows back to stamp each challenge's per-player `Complete`.
--
-- Only the completion flag is stored. The `Config` rule tree posted alongside it is the
-- challenge's definition (static/weekly-challenge.json, identical for every player) plus
-- the client's running count in `cc`; the server evaluates none of it, so a per-player copy
-- would just be a staler duplicate of the catalog.
--
-- `challenge_map_id` is the rotation the report belongs to. It is not part of the key, but
-- it scopes reads and resets the row when a challenge id comes back in a later rotation:
-- ids are only unique within one. Kept in sync with CHALLENGE_STATUS_SCHEMA_DDL in
-- src/challenge-db.ts.

CREATE TABLE IF NOT EXISTS challenge_status (
  account_id INTEGER NOT NULL,
  challenge_id INTEGER NOT NULL,
  challenge_map_id INTEGER NOT NULL,
  complete INTEGER NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (account_id, challenge_id)
  );

CREATE INDEX IF NOT EXISTS idx_challenge_status_account_map ON challenge_status (account_id, challenge_map_id);
