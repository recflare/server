-- Player-event storage (scheduled events: a room, a window of time, and the
-- settings the event runs under). Like the image/invention/rooms/accounts tables
-- in this shared database, an event is a single JSON blob in the `data` column,
-- with queryable fields exposed as SQLite generated (virtual) columns extracted
-- from that JSON. Owned by the `api` worker; generated from src/events-db.ts
-- (SCHEMA_DDL) — keep in sync.
--
-- The stored blob IS the DTO: every read endpoint serves it verbatim, so the
-- PascalCase field set matches Rec Room's `PlayerEvent` exactly. `start_time` /
-- `end_time` extract ISO-8601 UTC strings, which compare lexicographically — the
-- browse query filters finished events in SQL on that.

CREATE TABLE IF NOT EXISTS event (
  data TEXT NOT NULL,
  id INTEGER GENERATED ALWAYS AS (json_extract(data, '$.PlayerEventId')) VIRTUAL,
  creator_player_id INTEGER GENERATED ALWAYS AS (json_extract(data, '$.CreatorPlayerId')) VIRTUAL,
  room_id INTEGER GENERATED ALWAYS AS (json_extract(data, '$.RoomId')) VIRTUAL,
  club_id INTEGER GENERATED ALWAYS AS (json_extract(data, '$.ClubId')) VIRTUAL,
  start_time TEXT GENERATED ALWAYS AS (json_extract(data, '$.StartTime')) VIRTUAL,
  end_time TEXT GENERATED ALWAYS AS (json_extract(data, '$.EndTime')) VIRTUAL
  );
CREATE UNIQUE INDEX IF NOT EXISTS idx_event_id ON event (id);
CREATE INDEX IF NOT EXISTS idx_event_creator ON event (creator_player_id);
CREATE INDEX IF NOT EXISTS idx_event_club ON event (club_id);
CREATE INDEX IF NOT EXISTS idx_event_start ON event (start_time);
