-- The two profile fields 0013 left off the `reputation` table on the theory that nothing
-- varied them per player. Owned by the `api` worker; generated from src/reputation-db.ts
-- (SCHEMA_DDL) — keep in sync.
--
-- `selected_cheer` is the cheer a player has PINNED to their profile, written by
-- `POST /api/PlayerCheer/v1/SetSelectedCheer` (form `CheerCategory`), which every reference
-- server stores per player — 0013's "no endpoint sets one" was wrong. `is_cheerful` is the
-- profile flag the client's DTO and `ReputationUpdate` frame both carry, read straight off
-- the record like every reference does; it is a column so it can vary one day without a
-- migration, defaulted true because that is what every reference serves.
ALTER TABLE reputation ADD COLUMN is_cheerful INTEGER NOT NULL DEFAULT 1;
ALTER TABLE reputation ADD COLUMN selected_cheer INTEGER NOT NULL DEFAULT 0;
