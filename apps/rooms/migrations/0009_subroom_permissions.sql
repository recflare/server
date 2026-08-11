-- Per-subroom permission overrides. `PUT /rooms/{roomId}/subrooms/{subRoomId}/permissions`
-- is how a room's creator changes what a role may do in one subroom (spawn inventions,
-- invite, use the delete-all button, …). The client addresses an entry by the
-- (`Permission`, `Role`) pair and re-PUTs that pair to change it, so the pair is the
-- primary key: sending it again overwrites the stored row rather than appending a second.
--
-- A row IS an override, so the client's `Override` flag is not a column. It's the checkbox
-- the client draws next to each permission — `Override: true` stores the value, and
-- `Override: false` means "fall back to the default", which deletes the row. Reads always
-- serve `Override: true`.
--
-- Read on one path only — `GET /photon_access_token`, where a stored entry overwrites the
-- matching default in the permission table the client applies when it spawns. That's why
-- this is its own table rather than a field on the subroom's `data` blob: that blob is
-- served to the client verbatim inside the room, and nothing client-facing reads these.
--
-- `value` is the client's string kept verbatim: usually `True`/`False`, but a permission
-- whose UI isn't a True/False picker carries something else, and we don't interpret it.
--
-- Generated from packages/domain/src/rooms-db.ts (SUBROOM_SCHEMA_DDL) — keep in sync.

CREATE TABLE IF NOT EXISTS subroom_permission (
  sub_room_id INTEGER NOT NULL,
  permission TEXT NOT NULL,
  role INTEGER NOT NULL,
  type INTEGER NOT NULL DEFAULT 0,
  value TEXT NOT NULL,
  PRIMARY KEY (sub_room_id, permission, role)
  );
