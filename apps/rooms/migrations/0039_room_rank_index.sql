-- The feeds' ranking stubs, as a covering index.
--
-- Generated from packages/domain/src/rooms-db.ts (ROOM_SCHEMA_DDL, RANK_STUB) — keep in sync.
-- The json_object below MUST be the same expression as RANK_STUB: SQLite only reads an
-- indexed expression out of the index when the query's expression matches it, and a query
-- that names this index (`INDEXED BY idx_room_rank`) while not matching still runs, just
-- reading every blob again.
--
-- Every scan-then-rank feed (hot, new, recently-updated, recommended, trending, featured,
-- similar) selects that stub from every listable room. The rooms' `data` blobs are ~20 KB
-- on overflow pages, and reading them was the whole cost of the scan: the filter was
-- already answered by `idx_room_public`. An index on an expression stores the expression's
-- value, and SQLite (3.41+) reads it from there instead of recomputing it, so the scan now
-- never opens a blob. 20 ms to 0.65 ms on a 5k-room local benchmark.
--
-- A plain index, not a STORED generated column: no table rebuild, and no trigger or
-- app-side copy to drift — SQLite maintains it on every write to `data`.
--
-- PARTIAL over exactly LISTABLE_WHERE, so it holds only the rooms a feed may serve.
CREATE INDEX IF NOT EXISTS idx_room_rank ON room (
  room_id,
  json_object(
    'RoomId', data -> '$.RoomId',
    'IsDorm', data -> '$.IsDorm',
    'Accessibility', data -> '$.Accessibility',
    'ExcludeFromLists', data -> '$.ExcludeFromLists',
    'CreatorAccountId', data -> '$.CreatorAccountId',
    'CreatedAt', data -> '$.CreatedAt',
    'IsRRO', data -> '$.IsRRO',
    'Stats', data -> '$.Stats'
  ),
  visits,
  cheers,
  favorites
)
  WHERE is_dorm IS NOT 1 AND accessibility = 1 AND exclude_from_lists IS NOT 1;
