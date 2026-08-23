-- Room tags as their own table, mirroring the `api` worker's `event_tag` (0010). One row
-- per tag per room. Generated from packages/domain/src/rooms-db.ts (ROOM_SCHEMA_DDL) —
-- keep in sync.
--
-- The table is AUTHORITATIVE and the blob's `Tags` key is removed below, the same
-- arrangement 0007/0008 gave subrooms and their saves: one place a tag is stored, so the
-- two can't drift. `serializeRoom` drops `Tags` on write and the reads re-attach it, so
-- the room DTO the client sees is unchanged.
--
-- The point is the lookup. Every tag-filtered read — a discovery category row
-- (`/algorithmiclists/quests_algoendpoint`), a `#tag` room search, the `base` template
-- list — used to SELECT every room and parse each blob just to ask what it was tagged.
-- They now narrow in SQL off `idx_room_tag_tag` and read only the blobs that match.
--
-- `tag` is stored lowercased: it is the lookup key, and every comparison in rooms-db.ts
-- was already case-insensitive, so nothing downstream can tell. `type` is the client's
-- tag-category int — 0 for a user tag, 2 for the auto-derived ones like `rro` — echoed
-- back as stored.

CREATE TABLE IF NOT EXISTS room_tag (
  room_id INTEGER NOT NULL,
  tag TEXT NOT NULL,
  type INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (room_id, tag)
  );
CREATE INDEX IF NOT EXISTS idx_room_tag_tag ON room_tag (tag);

-- Backfill from the blobs. `json_each` walks the `Tags` array; a room with no array (or a
-- null one) contributes nothing, which is why this is a join rather than a correlated
-- subquery. `INSERT OR IGNORE` collapses a room that somehow carries the same tag twice
-- in different casing — the primary key is the lowercased name.
INSERT OR IGNORE INTO room_tag (room_id, tag, type)
  SELECT
    r.room_id,
    lower(json_extract(t.value, '$.Tag')),
    COALESCE(json_extract(t.value, '$.Type'), 0)
  FROM room r, json_each(r.data, '$.Tags') t
  WHERE json_extract(t.value, '$.Tag') IS NOT NULL;

-- Single source of truth: the tags now live in `room_tag`, so the copy in the blob goes.
-- Leaving it would be a second answer to "what is this room tagged" that only the writes
-- through toggleRoomTag keep current.
UPDATE room SET data = json_remove(data, '$.Tags');
