-- A room's leaderboard: how many wins each player has in each room. Owned by the
-- `leaderboard` worker, which is the only reader and the only writer —
-- `POST /leaderboard/CheckAndSetStat` writes a row and the three reads
-- (`GetRanks`, `GetNearbyScores`, `GetPlayerRank`) rank them. Generated from
-- src/leaderboard-db.ts (SCHEMA_DDL) — keep in sync.
--
-- One row per (player, room). A row is created the first time a player posts a stat for
-- the room; a player with no row is simply not on that room's board, which the reads
-- answer as an empty slice / the unranked sentinel rather than by inserting on a read.
--
-- `wins` is the stat the client posts as `StatValue`. The board is ordered on it — ties
-- break on the lower `player_id`, so a rank is stable between two reads.
--
-- The client's `StatChannel` is NOT a column: this server keeps one board per room, and
-- every channel writes to and reads from it. Adding a channel later is a column plus a
-- new primary key, not a new table.

CREATE TABLE IF NOT EXISTS leaderboard (
  player_id INTEGER NOT NULL,
  room_id INTEGER NOT NULL,
  wins INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (player_id, room_id)
  );

-- The reads walk one room's board ordered by wins; the primary key serves the
-- (player, room) point lookup but not that scan.
CREATE INDEX IF NOT EXISTS leaderboard_room_wins ON leaderboard (room_id, wins DESC, player_id);
