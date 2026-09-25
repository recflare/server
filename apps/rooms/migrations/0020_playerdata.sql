-- Per-room, per-player variable data — what the client saves through
-- `PUT /rooms/{roomId}/playerdata/me` and reads back from `GET .../playerdata/me`.
--
-- Generated from packages/domain/src/rooms-db.ts (ROOM_SCHEMA_DDL) — keep in sync.
--
-- One row per (room, player). `data` is the client's blob exactly as posted (the `data`
-- form field, a base64 string); the server neither decodes nor validates it, and a
-- re-save overwrites the row in place, so the table holds only each player's latest.

CREATE TABLE IF NOT EXISTS playerdata (
  room_id INTEGER NOT NULL,
  player_id INTEGER NOT NULL,
  data TEXT NOT NULL,
  PRIMARY KEY (room_id, player_id)
  );
