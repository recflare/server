-- Store the `Config` rule tree the client posts with each weekly-challenge progress report.
--
-- Migration 0009 kept only the completion flag, on the grounds that the tree is the
-- challenge's definition (static/weekly-challenge.json) and therefore identical for every
-- player. That is only true of the tree the SERVER publishes: the client posts it back with
-- its own progress written into the nodes — `cc` on a counter is the running count, `c`
-- marks a satisfied node — so the posted copy is per-player state, and dropping it threw
-- away the only record of how far along a player was. The client does the evaluating; this
-- is where the partial progress it reports has to live between sessions.
--
-- Nullable, and NULL is meaningful: no report has been stored for that challenge yet (or a
-- report arrived without a `Config`), so `/api/challenge/v2/getCurrent` serves the static
-- tree for it unchanged. Kept in sync with CHALLENGE_STATUS_SCHEMA_DDL in
-- src/challenge-db.ts.

ALTER TABLE challenge_status ADD COLUMN config TEXT;
