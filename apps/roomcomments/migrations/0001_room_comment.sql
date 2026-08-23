-- Room comments — the notes a player leaves pinned in a room's scene, which everyone
-- standing in that subroom sees floating at the position they were dropped. Generated from
-- packages/domain/src/room-comments-db.ts (ROOM_COMMENT_SCHEMA_DDL) — keep in sync.
--
-- Columns rather than a JSON blob (the `club_announcement` pattern rather than the
-- `room`/`club` one): a comment is six scalars and a point, none of it a client-shaped
-- document that has to survive round-tripping, and the room/subroom pair has to be
-- queryable.

-- `comment_id` is an ordinary autoincrement integer, and it is the CURSOR the read endpoint
-- pages on (`GET /comments/get/:roomId?minId=`), so it has to be monotonic per insert.
-- AUTOINCREMENT rather than a bare rowid alias for exactly that reason: a deleted comment's
-- id must never be handed out again, or a client polling with `minId` would skip the
-- comment that reused it.
--
-- The position is three REALs, not the strings the form body carries. The client posts a
-- C# float's shortest round-trip text (`positionX=-0.4979804`) but reads the response back
-- as a NUMBER — `"PositionX": "1.5"` fails its parser — and a float64 holds those 7-9
-- significant digits exactly, so the text that arrives is the text that goes back out.
CREATE TABLE IF NOT EXISTS room_comment (
  comment_id INTEGER PRIMARY KEY AUTOINCREMENT,
  room_id INTEGER NOT NULL,
  subroom_id INTEGER NOT NULL,
  player_id INTEGER NOT NULL,
  style INTEGER NOT NULL DEFAULT 0,
  message TEXT NOT NULL DEFAULT '',
  position_x REAL NOT NULL DEFAULT 0,
  position_y REAL NOT NULL DEFAULT 0,
  position_z REAL NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL
  );

-- The read is always "this room, newer than this id, newest first" — one index covers the
-- filter and the ordering together.
CREATE INDEX IF NOT EXISTS idx_room_comment_room ON room_comment (room_id, comment_id);
