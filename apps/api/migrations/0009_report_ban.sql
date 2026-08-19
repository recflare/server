-- Turn a report into a ban. A report row already names the player it is against
-- (`reported_player_id`), so a moderator acting on one flips `banned` on that same row
-- rather than duplicating it into a second table — the ban then carries the report that
-- justified it (category, details, room, who filed it) with no join.
-- Generated from src/reports-db.ts (SCHEMA_DDL) — keep in sync.
--
-- `ban_expires` is an ISO-8601 UTC timestamp like `created_at`, and NULL means the ban
-- never expires. Kept as its own column rather than "banned until" alone so a lifted ban
-- (banned = 0) is distinguishable from an expired one, and so the row remains a report
-- once the ban is over. Rows stay append-only in every other respect.
--
-- Partial index: bans are rare next to reports, so indexing only the banned rows keeps
-- the lookup (done on every matchmake and every token grant) reading a handful of pages
-- instead of every report ever filed against that player. idx_report_reported stays —
-- it serves the "all reports against this player" moderation read, which is unfiltered.

ALTER TABLE report ADD COLUMN banned INTEGER NOT NULL DEFAULT 0;
ALTER TABLE report ADD COLUMN ban_expires TEXT;
CREATE INDEX IF NOT EXISTS idx_report_banned ON report (reported_player_id) WHERE banned = 1;
