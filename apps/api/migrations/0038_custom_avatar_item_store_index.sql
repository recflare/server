-- Index the store rows' random draw (`randomCustomAvatarItemIds` in apps/lists/src/lists.app.ts):
-- "a handful of the Coach's published, priced items in these outfit slots". Served by
-- `idx_custom_avatar_item_creator` alone it visited EVERY first-party item per row drawn —
-- thousands of rows, each one's whole JSON record loaded to work out accessibility, price and
-- slot — at ~21 ms a draw.
--
-- PARTIAL over what the store can sell, keyed by creator then slot, with the id as the last
-- key so the draw is answered from the index without touching a record. SQLite uses a partial
-- index only when the query's WHERE contains its terms as written, so the query must keep
-- `accessibility <> 0` and `price > 0` as LITERALS (not binds) — change either and it silently
-- goes back to walking every Coach item.
-- Generated from src/custom-avatar-items-db.ts (SCHEMA_DDL) — keep in sync.

CREATE INDEX IF NOT EXISTS idx_custom_avatar_item_store
  ON custom_avatar_item (creator_account_id, outfit_type, custom_avatar_item_id)
  WHERE accessibility <> 0 AND price > 0;
