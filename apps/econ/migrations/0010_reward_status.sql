-- Game-reward eligibility, owned by the `econ` worker. One row per (account, reward type):
-- the client asks for a reward whenever it thinks one is due (`POST
-- /api/gamerewards/v1/request` with `rewardType`/`Message`), so this table is what decides
-- whether one is actually owed and keeps a repeat ask from paying out twice.
--
-- `granted_at` is when the type was last claimed and `grant_count` how many times it has
-- been; the claim is a conditional upsert, so the check and the write are one atomic
-- statement (the client can fire two requests at once after a match).
--
-- The reward TYPE is the whole key. The client also sends a `giftContext` (the activity,
-- e.g. `Soccer`), deliberately not keyed on: one cooldown per type, shared across
-- activities. Kept in sync with REWARD_STATUS_SCHEMA_DDL in src/reward-db.ts.

CREATE TABLE IF NOT EXISTS reward_status (
  account_id INTEGER NOT NULL,
  reward_type TEXT NOT NULL,
  granted_at TEXT NOT NULL,
  grant_count INTEGER NOT NULL,
  PRIMARY KEY (account_id, reward_type)
  );
