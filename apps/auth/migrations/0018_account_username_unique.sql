-- A username belongs to ONE account (case-insensitive). The index on `username_lower` was a
-- plain one, so nothing refused a second holder: signup assigned a random name from only
-- 2.56M combinations without checking it was free, and ~250 names ended up shared (e.g.
-- accounts 38757 and 45048 were both `GentlePenguin6856`). `createAccount` now checks and
-- retries, and `accounts` `PUT /account/me/username` checks first; this index is the
-- backstop against a race.
--
-- Before the index can be made unique, existing duplicates have to go: the LOWEST account
-- id keeps the name (the first account to hold it) and each other holder is renamed to
-- `Player<id>` — unique by construction, and the same name `defaultAccount` gives an id —
-- with one extra username change, since they never chose the name they lost. Display
-- names are left alone (they need not be unique). Renamed players see it on next sign-in.
--
-- If some account had already CHOSEN a `Player<id>` name a renamed account lands on, the
-- unique index below fails to build and the migration rolls back; rename that one first.
--
-- The plain index is what makes the grouping and join cheap, so it stays until the
-- clean-up is done (see 0013's note on D1's CPU limit).
--
-- Kept in sync with SCHEMA_DDL in @repo/domain's accounts-db.ts (and its mirror in
-- apps/econ/src/avatar-db.ts).

UPDATE account
   SET data = json_set(
         data,
         '$.username', 'Player' || account_id,
         '$.availableUsernameChanges',
         COALESCE(json_extract(data, '$.availableUsernameChanges'), 3) + 1
       )
 WHERE account_id IN (
   SELECT a.account_id
     FROM account a
     JOIN (
       SELECT username_lower, MIN(account_id) AS keeper
         FROM account
        WHERE username_lower IS NOT NULL
        GROUP BY username_lower
       HAVING COUNT(*) > 1
     ) d ON a.username_lower = d.username_lower
    WHERE a.account_id > d.keeper
 );

DROP INDEX IF EXISTS idx_accounts_username_lower;

CREATE UNIQUE INDEX IF NOT EXISTS idx_accounts_username_lower ON account (username_lower);
