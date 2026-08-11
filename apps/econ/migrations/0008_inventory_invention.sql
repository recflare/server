-- Owned inventions, owned by the `econ` worker. One row per (account, invention): the
-- inventions a player has bought from the invention store. Written at purchase time by
-- `/api/storefronts/v2/buyInvention`, which also uses it to reject a re-buy. Ownership
-- is boolean (you own an invention or you don't), so the pair is the primary key and a
-- second purchase is a no-op rather than a duplicate row.
--
-- The invention itself lives in the `invention` table, whose schema/migrations the `api`
-- worker owns (apps/api/migrations/0002_invention.sql) on this same `recflare` database;
-- only the id is stored here. Creators are NOT listed here — an invention's creator owns
-- it by virtue of `CreatorPlayerId`, and never buys their own. Kept in sync with
-- INVENTORY_INVENTION_SCHEMA_DDL in src/inventory-invention-db.ts.

CREATE TABLE IF NOT EXISTS inventory_invention (
  account_id INTEGER NOT NULL,
  invention_id INTEGER NOT NULL,
  acquired_at TEXT NOT NULL,
  PRIMARY KEY (account_id, invention_id)
  );
