-- Per-room leaderboard definitions. Generated from packages/domain/src/rooms-db.ts
-- (ROOM_SCHEMA_DDL) — keep in sync.
--
-- One row per (room, leaderboard). `leaderboard_id` is the client's slot number — small
-- ordinals (1, 2, 3…), unique only within the room, which is why the pair is the primary
-- key rather than the id alone. Re-posting a slot (POST /rooms/:id/leaderboards/:lid)
-- reconfigures it in place; DELETE on the same path removes it.
--
-- `sort_ascending` stores the client's `sortAscending=True/False` as 1/0; `stat_format`
-- is the client's `statFormat` int, echoed back as stored.

CREATE TABLE IF NOT EXISTS room_leaderboard (
  room_id INTEGER NOT NULL,
  leaderboard_id INTEGER NOT NULL,
  leaderboard_title TEXT NOT NULL,
  stat_format INTEGER NOT NULL DEFAULT 0,
  sort_ascending INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (room_id, leaderboard_id)
  );
