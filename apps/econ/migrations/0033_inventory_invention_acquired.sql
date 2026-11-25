-- The "top today" invention feed's window, as an index.
--
-- Generated from packages/domain/src/inventory-invention-db.ts
-- (INVENTORY_INVENTION_SCHEMA_DDL) — keep in sync.
--
-- `getInventionAcquisitionCounts` counts the acquisitions of the last 24 hours, and nothing
-- indexed `acquired_at`, so every call read the whole table: ~100k rows on production to
-- count ~1.7k. Keyed on `acquired_at` the window is a range seek, and carrying
-- `invention_id` makes the index covering, so the GROUP BY never touches the table.
--
-- The query names this index (`INDEXED BY`): the planner otherwise prefers walking
-- `idx_inventory_invention_invention` to skip sorting the groups, which is the full read.
CREATE INDEX IF NOT EXISTS idx_inventory_invention_acquired
  ON inventory_invention (acquired_at, invention_id);
