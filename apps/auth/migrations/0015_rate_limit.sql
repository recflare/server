-- Fixed-window counters: "at most N of these per key per window". What caps the emails
-- this server sends — password-recovery codes (`auth`) and email-change codes (`accounts`)
-- — per target account and per requesting IP, so a mailbox can't be flooded by anyone who
-- knows its address. Mirrored by RATE_LIMIT_SCHEMA_DDL in @repo/domain's rate-limit-db.ts,
-- which says how a key is taken and when rows are purged.

CREATE TABLE IF NOT EXISTS rate_limit (
  key TEXT PRIMARY KEY,
  window_started_at INTEGER NOT NULL,
  count INTEGER NOT NULL
);
