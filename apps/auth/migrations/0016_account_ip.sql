-- Every client IP an account has been seen from: one row per (account, address) with when it
-- was first and last seen and how often. The account blob keeps only the ends of this history
-- (`signupIp`, immutable, and `lastLoginIp`, overwritten by each login); a ban that follows a
-- player needs the middle too — see @repo/domain's account-ip-db.ts, which mirrors this
-- schema (ACCOUNT_IP_SCHEMA_DDL) and is the only writer. `auth` writes a row on every token
-- grant; the api worker's bans-db reads it for the ban-evasion IP arm and `www`'s staff panel
-- lists it.

CREATE TABLE IF NOT EXISTS account_ip (
  account_id INTEGER NOT NULL,
  ip TEXT NOT NULL,
  first_seen TEXT NOT NULL,
  last_seen TEXT NOT NULL,
  hits INTEGER NOT NULL DEFAULT 1,
  PRIMARY KEY (account_id, ip)
);
CREATE INDEX IF NOT EXISTS idx_account_ip_ip ON account_ip (ip);

-- Backfill from what the blob already knows, so the history starts with the two addresses
-- every existing account has on record rather than empty. The signup address is dated to the
-- account's creation and the last-login address to its last login; an account whose two are
-- the same gets one row spanning both.
INSERT INTO account_ip (account_id, ip, first_seen, last_seen, hits)
SELECT account_id,
  signup_ip,
  COALESCE(json_extract(data, '$.createdAt'), ''),
  COALESCE(json_extract(data, '$.createdAt'), ''),
  1
FROM account
WHERE signup_ip IS NOT NULL AND signup_ip <> '' AND account_id IS NOT NULL
ON CONFLICT (account_id, ip) DO NOTHING;

INSERT INTO account_ip (account_id, ip, first_seen, last_seen, hits)
SELECT account_id,
  json_extract(data, '$.lastLoginIp'),
  COALESCE(json_extract(data, '$.lastLoginTime'), json_extract(data, '$.createdAt'), ''),
  COALESCE(json_extract(data, '$.lastLoginTime'), json_extract(data, '$.createdAt'), ''),
  1
FROM account
WHERE json_extract(data, '$.lastLoginIp') IS NOT NULL
  AND json_extract(data, '$.lastLoginIp') <> ''
  AND account_id IS NOT NULL
ON CONFLICT (account_id, ip) DO UPDATE SET
  last_seen = MAX(last_seen, excluded.last_seen);
