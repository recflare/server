-- Weekly-challenge gift grants, owned by the `econ` worker. One row per (account,
-- rotation), written when the last challenge of a rotation is reported complete on
-- `/api/challenge/v2/updateProgress` and the rotation's `Gift` is handed out.
--
-- The table exists only to make that grant happen ONCE. The client reports progress
-- repeatedly, so every report that arrives with the set already finished would otherwise
-- mint another copy of the reward; the insert is the gate, and it conflicts on the second
-- report instead of paying out again.
--
-- Keyed by rotation as well as account so a new week's set can be finished and rewarded on
-- its own — `challenge_map_id` is the rotation, matching `challenge_status`. There is no
-- `granted` flag: the row's existence IS the grant. Kept in sync with
-- CHALLENGE_GIFT_SCHEMA_DDL in src/challenge-db.ts.

CREATE TABLE IF NOT EXISTS challenge_gift (
  account_id INTEGER NOT NULL,
  challenge_map_id INTEGER NOT NULL,
  granted_at TEXT NOT NULL,
  PRIMARY KEY (account_id, challenge_map_id)
  );
