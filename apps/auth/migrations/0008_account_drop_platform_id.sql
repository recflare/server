-- Drop the `platform_id` generated column added by 0004. Nothing reads it any more:
-- 0007 moved every account ↔ identity link into `platform_account`, which is now the
-- one source of truth for the login picker and the `cached_login` grant. The column's
-- last reader was 0007's own backfill, which has already run.
--
-- Leaving it would leave a SECOND, stale answer to "which account does this identity
-- open?" — it only ever holds the account's primary identity, so an account reachable
-- from a PC and a headset appears here under one of them. That is exactly the split
-- that used to have the picker offer an account the grant then refused.
--
-- The underlying `platformId` in the JSON blob STAYS: it is the account's primary
-- identity, and feeds the account DTO and a refreshed token's claims. This drops the
-- generated column and its index only — a virtual column stores nothing, so no account
-- data is rewritten or lost. The index has to go first; SQLite refuses to drop an
-- indexed column. Kept in sync with SCHEMA_DDL in @repo/domain's accounts-db.ts.
--
-- Safe to run before or after the deploy that ships it: no worker queries this column,
-- so the currently-deployed code doesn't notice it go. (`PLATFORM_BACKFILL_SQL` in
-- src/platform-db.ts still names it in 0007's text — that statement has run and won't
-- run again; the exported copy selects the blob instead so tests keep working.)

DROP INDEX IF EXISTS idx_accounts_platform_id;
ALTER TABLE account DROP COLUMN platform_id;
