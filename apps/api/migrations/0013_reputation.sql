-- Player reputation (the cheer counters on a profile) and the daily cheer credit that
-- pays for handing one out. Both owned by the `api` worker, which is the only reader and
-- the only writer — `POST /api/PlayerCheer/v1/create` writes them and the
-- `/api/playerReputation/…` reads serve them. Generated from src/reputation-db.ts
-- (SCHEMA_DDL) — keep in sync.
--
-- Two tables because they answer two different questions. `reputation` is what a player
-- has RECEIVED: one counter per cheer category. `player_cheer` is what they have left to
-- GIVE, refilling to 20 once the window in `created` is a day old — a lazy reset, so
-- nothing has to run on a schedule.
--
-- Neither row is created until it is needed: a missing `reputation` row means nobody has
-- cheered that player, which is the all-zero record the endpoints already served, and a
-- missing `player_cheer` row means they have never spent a cheer, i.e. full credit. So
-- reads fall back to the defaults instead of inserting on a GET.
--
-- `CheerCredit` on the DTO is NOT a column here even though the client's record carries it
-- next to the counters: it is `player_cheer.cheers_left` with the rollover applied. Storing
-- it in both places would let the number a player reads drift from the one the spend checks.
--
-- `noteriety` keeps the reference's spelling (the client's field is `Noteriety`). It and
-- the subscriber counts are stored but nothing writes them yet — they are per-player
-- numbers that will have a source one day, so the column is here and turning them on later
-- is a write rather than a migration.
--
-- `IsCheerful` and `SelectedCheer` were left off here on the theory that nothing varied
-- them per player; 0014 adds them — `SelectedCheer` is written by `SetSelectedCheer`.

CREATE TABLE IF NOT EXISTS reputation (
  account_id INTEGER PRIMARY KEY,
  noteriety INTEGER NOT NULL DEFAULT 0,
  cheer_general INTEGER NOT NULL DEFAULT 0,
  cheer_helpful INTEGER NOT NULL DEFAULT 0,
  cheer_creative INTEGER NOT NULL DEFAULT 0,
  cheer_great_host INTEGER NOT NULL DEFAULT 0,
  cheer_sportsman INTEGER NOT NULL DEFAULT 0,
  subscriber_count INTEGER NOT NULL DEFAULT 0,
  subscribed_count INTEGER NOT NULL DEFAULT 0
  );

-- `created` is the START of the live credit window, not the row's creation time: spending
-- a cheer inside a window leaves it alone, so a player refills 24h after their FIRST cheer
-- rather than sliding the deadline forward with every one they hand out. Stored as an
-- ISO-8601 UTC string, which is fixed-width and so orders correctly under SQLite's plain
-- string comparison — the spend compares against a cutoff without any date functions.
CREATE TABLE IF NOT EXISTS player_cheer (
  player_id INTEGER PRIMARY KEY,
  cheers_left INTEGER NOT NULL,
  created TEXT NOT NULL
  );
