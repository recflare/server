-- Room offers — what a room SELLS of its own inventory items (`room_inventory_item`, 0030).
-- Owned by the `econ` worker; generated from src/room-offer-db.ts (ROOM_OFFER_SCHEMA_DDL) —
-- keep in sync.
--
-- Written by `POST /econ/roomOffer/room/{roomId}`. `origin_id` is a GUID, the client's
-- `OriginId`. `item_mappings` is a JSON array of `{ ItemType, ItemOriginId, Count }` — for
-- `ItemType` 1 the `ItemOriginId` is a `room_inventory_item.origin_id` of the same room — read
-- back whole and never queried into. `price_unit_id` is the client's `PriceUnitId` as JSON; it
-- has only been seen null.
CREATE TABLE IF NOT EXISTS room_offer (
  origin_id TEXT PRIMARY KEY,
  room_id INTEGER NOT NULL,
  name TEXT NOT NULL,
  description TEXT NOT NULL,
  image_name TEXT,
  price INTEGER NOT NULL,
  has_dynamic_price INTEGER NOT NULL DEFAULT 0,
  minimum_dynamic_price INTEGER,
  maximum_dynamic_price INTEGER,
  max_num_purchases_per_player INTEGER,
  max_count_per_purchase INTEGER NOT NULL DEFAULT 1,
  item_mappings TEXT NOT NULL DEFAULT '[]',
  price_unit_id TEXT NOT NULL DEFAULT 'null',
  allow_rename INTEGER NOT NULL DEFAULT 0,
  visibility INTEGER NOT NULL DEFAULT 0,
  is_giftable INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  modified_at TEXT NOT NULL
  );

-- Every read is "this room's offers".
CREATE INDEX IF NOT EXISTS idx_room_offer_room ON room_offer (room_id);
