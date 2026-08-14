-- Widen the game-reward cooldown key to include the activity the reward came from.
--
-- The client posts a `giftContext` alongside the type (`rewardType=PostGameActivity&
-- giftContext=Soccer`), which migration 0010 deliberately dropped: one cooldown per type,
-- shared across activities. That means the first activity of the day pays once no matter
-- how many different activities a player runs. Keying on (type, context) instead gives
-- each activity its own cooldown, so a different activity pays again while the same one
-- stays on cooldown.
--
-- SQLite can't add a column to a primary key, so the table is rebuilt and the rows copied
-- across. Existing rows have no context and take `''` — NOT the NULL that would read more
-- naturally, because SQLite allows (and does not dedupe) NULLs in a non-INTEGER primary
-- key, which would let the upsert insert a second unkeyed row instead of updating the
-- first and pay out every time. Asks that carry no `giftContext` land on that same `''`
-- bucket, so a pre-migration cooldown keeps counting.

CREATE TABLE reward_status_new (
  account_id INTEGER NOT NULL,
  reward_type TEXT NOT NULL,
  gift_context TEXT NOT NULL,
  granted_at TEXT NOT NULL,
  grant_count INTEGER NOT NULL,
  PRIMARY KEY (account_id, reward_type, gift_context)
  );

INSERT INTO reward_status_new (account_id, reward_type, gift_context, granted_at, grant_count)
SELECT account_id, reward_type, '', granted_at, grant_count FROM reward_status;

DROP TABLE reward_status;

ALTER TABLE reward_status_new RENAME TO reward_status;
