-- Game-reward selections — the three-choice reward the client shows after a
-- challenge or level-up. `/api/gamerewards/v1/request` mints one and pushes it to the
-- player over the notifications hub; `/api/gamerewards/v1/select` consumes it.
--
-- The three offered drop ids are recorded so `select` can verify the player is
-- claiming something they were actually offered, and `consumed` makes the selection
-- single-use. Owned by the `econ` worker; generated from src/rewards-db.ts
-- (SCHEMA_DDL) — keep in sync.

CREATE TABLE IF NOT EXISTS reward_selection (
  reward_selection_id INTEGER PRIMARY KEY AUTOINCREMENT,
  account_id INTEGER NOT NULL,
  message TEXT NOT NULL DEFAULT '',
  gift_context INTEGER NOT NULL DEFAULT 0,
  reward_type INTEGER NOT NULL DEFAULT 0,
  gift_drop_1_id INTEGER NOT NULL,
  gift_drop_2_id INTEGER NOT NULL,
  gift_drop_3_id INTEGER NOT NULL,
  consumed INTEGER NOT NULL DEFAULT 0,
  created_at TEXT
  );
CREATE INDEX IF NOT EXISTS idx_reward_selection_account ON reward_selection (account_id);
