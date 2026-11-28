-- Cover the tag read that hydrates every room (`tagsByRoom` in packages/domain/src/rooms-db.ts
-- — one call per room page AND per single-room read, ~450k a day). The `(room_id, tag)` primary
-- key found each tag but then opened the table row for `type` and `is_primary_genre`; with all
-- four columns in the index the read never leaves it. Keyed like the primary key, so
-- `ORDER BY room_id, tag` comes straight off the index with no sort.
-- Generated from packages/domain/src/rooms-db.ts (ROOM_SCHEMA_DDL) — keep in sync.

CREATE INDEX IF NOT EXISTS idx_room_tag_room
  ON room_tag (room_id, tag, type, is_primary_genre);
