-- The room flags every public feed filters on, as indexed columns.
--
-- Generated from packages/domain/src/rooms-db.ts (ROOM_SCHEMA_DDL) — keep in sync.
--
-- `is_dorm` was already extracted back in 0001, but `Accessibility` and `ExcludeFromLists`
-- were not, so "the rooms a feed may show" could only be asked in JS. Every feed — hot, recommended,
-- featured, new, recently-updated, similar, search, autocomplete — therefore SELECTed the
-- whole `room` table and threw most of it away after parsing it. On this database that is
-- 1173 rows and ~1.7MB of blob read to rank the 109 rooms that are actually listable: the
-- rest are DORMS (one per account, private by construction) and other private rooms. It is
-- the read D1 reports as slow, and it gets worse with every account that signs up.
--
-- VIRTUAL like the other generated columns, so the blob stays the only copy of the value
-- and no backfill is needed — they are computed on read from the JSON already stored.
ALTER TABLE room ADD COLUMN accessibility INTEGER GENERATED ALWAYS AS (json_extract(data, '$.Accessibility')) VIRTUAL;
ALTER TABLE room ADD COLUMN exclude_from_lists INTEGER GENERATED ALWAYS AS (json_extract(data, '$.ExcludeFromLists')) VIRTUAL;

-- A PARTIAL index: it holds only the public, non-dorm rooms, which is the small minority
-- the feeds serve from. Scanning it visits those rows alone, so the feeds stop reading the
-- dorms at all rather than reading and discarding them. EXPLAIN QUERY PLAN over the feed
-- query goes from
--
--   SCAN room
--
-- to
--
--   SCAN room USING INDEX idx_room_public
--
-- `ExcludeFromLists` is deliberately NOT in the WHERE: search reads the public rooms
-- WITHOUT that term (a room can opt out of the browse feeds and still be findable by
-- name), so indexing the wider set lets both reads use this one index — the extra term is
-- then checked against the handful of rows it already fetched.
CREATE INDEX IF NOT EXISTS idx_room_public ON room (room_id)
  WHERE is_dorm IS NOT 1 AND accessibility = 1;
