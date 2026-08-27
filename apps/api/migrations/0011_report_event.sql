-- Reporting a player EVENT (`POST /api/playerevents/v1/report`) reuses the report
-- table rather than getting one of its own: it is the same submission with the same
-- fields (category, free-text details, the reporter from the token) and the same
-- moderation life — a moderator acting on it sets `banned` on the row exactly as they
-- would for a player report. Generated from src/reports-db.ts (SCHEMA_DDL) — keep in
-- sync.
--
-- `event_id` names the reported event; NULL on every ordinary player report, which is
-- what tells the two kinds apart. The row's other columns are still filled in from the
-- event: `reported_player_id` is its CREATOR (the person a moderator would act
-- against — the column is NOT NULL, and "who is answerable for this event" is the only
-- honest answer), and `room_id` the room it runs in, read from the event table so the
-- client doesn't have to send either.
--
-- Partial index: event reports are a small minority of rows, so indexing only the ones
-- that name an event keeps "reports against this event" off a full scan without paying
-- for the NULLs.
--
-- SUPERSEDED by 0016_report_invention.sql, which DROPS that index: nothing ever queried
-- `event_id`, so it only cost writes. Left here so an unmigrated database still applies
-- the migrations in order and ends up in the same place.

ALTER TABLE report ADD COLUMN event_id INTEGER;
CREATE INDEX IF NOT EXISTS idx_report_event ON report (event_id) WHERE event_id IS NOT NULL;
