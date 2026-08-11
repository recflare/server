-- Let one account be linked to MORE THAN ONE platform identity, so a player with a
-- PC and a headset gets a cached login on both. The account blob's single
-- `platformId`/`platform` pair could only hold one, so logging in on the second
-- device meant a password every time.
--
-- Links move into their own table, which becomes the one source of truth for both
-- halves of a cached login (the picker and the `cached_login` grant). The blob fields
-- stay as the account's *primary* identity — the first one linked — for the account
-- DTO and the refresh grant's claims; nothing authorizes off them any more. Kept in
-- sync with PLATFORM_SCHEMA_DDL in src/platform-db.ts.

CREATE TABLE IF NOT EXISTS platform_account (
  account_id INTEGER NOT NULL,
  platform INTEGER NOT NULL,
  platform_id TEXT NOT NULL,
  linked_at TEXT NOT NULL,
  PRIMARY KEY (platform, platform_id, account_id)
  );
CREATE INDEX IF NOT EXISTS idx_platform_account_account ON platform_account (account_id);
CREATE INDEX IF NOT EXISTS idx_platform_account_platform_id ON platform_account (platform_id);

-- Backfill every identity already bound to an account. `platform` is COALESCEd to 0
-- because nothing ever defaulted that field: an account can carry a platformId with no
-- platform recorded, and back when Steam was the only verifiable platform an unset one
-- *was* Steam. Without the COALESCE those accounts would lose their cached login at
-- deploy. Mirrored as PLATFORM_BACKFILL_SQL in src/platform-db.ts, which is what the
-- tests run.
INSERT OR IGNORE INTO platform_account (account_id, platform, platform_id, linked_at)
SELECT
  account_id,
  COALESCE(json_extract(data, '$.platform'), 0),
  platform_id,
  COALESCE(json_extract(data, '$.createdAt'), '1970-01-01T00:00:00Z')
FROM account
WHERE platform_id IS NOT NULL AND platform_id <> '';
