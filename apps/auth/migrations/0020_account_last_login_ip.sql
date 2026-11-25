-- Expose the account's `lastLoginIp` (in the JSON blob) as an indexed generated column, beside
-- `signup_ip` (0013), so the ban resolution (`resolveBan` in apps/api/src/bans-db.ts) can find
-- the accounts sharing an address with the caller by index.
--
-- That query runs on every matchmake and every token grant. It used to drive from every banned
-- report and read each banned account's blob to compare these two fields, so its cost grew with
-- the number of bans ever handed down; it now drives from the caller's own addresses outward,
-- which needs both blob fields reachable by value. `account_ip` (0016) already is.
--
-- A full index, like `signup_ip`: the lookup is by value. It is rewritten only when a login
-- arrives from a different address than the last one. Kept in sync with SCHEMA_DDL in
-- @repo/domain's accounts-db.ts (and its mirror in apps/econ/src/avatar-db.ts).

ALTER TABLE account ADD COLUMN last_login_ip TEXT GENERATED ALWAYS AS (json_extract(data, '$.lastLoginIp')) VIRTUAL;
CREATE INDEX IF NOT EXISTS idx_account_last_login_ip ON account (last_login_ip);
