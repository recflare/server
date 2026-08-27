-- Reporting an INVENTION (`POST /api/inventions/v1/report`) reuses the report table, as
-- the event report next to it does: same fields, same moderation life — a moderator
-- acting on one sets `banned` on the row exactly as they would for a player report.
-- Generated from src/reports-db.ts (SCHEMA_DDL) — keep in sync.
--
-- `invention_id` names the reported invention; NULL on every other kind of report. It
-- sits beside `event_id` and the two are mutually exclusive: a row names an event, or an
-- invention, or neither (an ordinary player report), which is what tells the kinds apart.
--
-- The row's `reported_player_id` is the invention's CREATOR, read from the invention
-- rather than sent by the client — the column is NOT NULL, and "who is answerable for
-- this invention" is the only honest answer. No `room_id`: an invention is not tied to
-- one room the way an event is, so there is nothing to fill it in from.
--
-- Neither id column is INDEXED. Both are written on every report of their kind and read
-- by nothing — no query in any worker filters on either, and the moderation reads that do
-- exist go by player (`idx_report_reported`) or by the ban flag. So the partial index
-- 0011 built over `event_id` is dropped here rather than being mirrored for
-- `invention_id`: it only cost writes. Add one back with the query that needs it.

ALTER TABLE report ADD COLUMN invention_id INTEGER;
DROP INDEX IF EXISTS idx_report_event;
