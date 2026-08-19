-- The client build a room instance is running, so matchmaking only ever puts players
-- on the SAME build into one session. Two builds sharing a Photon room disagree about
-- how the scene and its objects serialize, so a 2023 client and a 2025 one in the same
-- instance is a broken room rather than a mixed one — and there is nothing to notice it
-- by afterwards, since each side simply fails to see what the other spawned.
--
-- The value is the `rn.ver` claim of the token whose matchmake CREATED the instance
-- (the match worker stamps it; see resolveRoomInstance), and the joinable-instance
-- search filters on it. A room busy with players on another build therefore reads as
-- empty and the joiner gets a fresh instance beside them.
--
-- Rows written before this column existed have no `$.gameVersion`, so `game_version`
-- is NULL and they match no build at all. That is deliberate: an unknown build is not
-- a build to place someone into, and an instance is only ever a live session — once it
-- empties, deleteEmptyRoomInstances retires it and nothing is left carrying a NULL.
--
-- A virtual generated column like the rest of the table (the value lives in the `data`
-- blob); no index — the search is already keyed on the indexed `room_id`.
--
-- Generated from packages/domain/src/room-instance-db.ts (ROOM_INSTANCE_SCHEMA_DDL) —
-- keep in sync.

ALTER TABLE room_instance
  ADD COLUMN game_version TEXT GENERATED ALWAYS AS (json_extract(data, '$.gameVersion')) VIRTUAL;
