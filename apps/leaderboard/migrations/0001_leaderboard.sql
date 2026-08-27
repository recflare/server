-- A room's leaderboards: each player's value on each of a room's stat channels. Owned by
-- the `leaderboard` worker, which is the only reader and the only writer —
-- `POST /leaderboard/CheckAndSetStat` writes a row and the three reads
-- (`GetRanks`, `GetNearbyScores`, `GetPlayerRank`) rank them. Generated from
-- src/leaderboard-db.ts (SCHEMA_DDL) — keep in sync.
--
-- One row per (player, room, channel). A row is created the first time a player posts a
-- stat for that channel of the room; a player with no row is simply not on that board,
-- which the reads answer as an empty slice / the unranked sentinel rather than by
-- inserting on a read.
--
-- `stat_channel` is the client's `StatChannel` — which of the room's tracked stats this
-- is (a room keeps one board per channel) — and `stat_value` is what it posts as
-- `StatValue`. What a channel counts (wins, laps, a time) is the room's business; the
-- server only orders on it, highest first unless the client asks for ascending, ties
-- broken on the lower `player_id` so a rank is stable between two reads.

CREATE TABLE IF NOT EXISTS leaderboard (
  player_id INTEGER NOT NULL,
  room_id INTEGER NOT NULL,
  stat_channel INTEGER NOT NULL,
  stat_value INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (player_id, room_id, stat_channel)
  );

-- The reads walk one board (room + channel) ordered by value; the primary key serves the
-- point lookup but not that scan.
CREATE INDEX IF NOT EXISTS leaderboard_board_value
  ON leaderboard (room_id, stat_channel, stat_value DESC, player_id);
