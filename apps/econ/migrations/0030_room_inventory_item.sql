-- Room inventory items — the things a room DEFINES for its players to hold. The client's
-- `RoomInventoryItem` family, three tables under one prefix. Owned by the `econ` worker;
-- generated from src/room-inventory-item-db.ts (ROOM_INVENTORY_ITEM_SCHEMA_DDL) — keep in sync.
--
-- NOT `room_inventory` (migration 0022): that name was taken first, by what players hold of a
-- room's CONSUMABLES. These are a separate feature and share nothing with it.
--
-- `room_inventory_item` is the DEFINITION, written by `POST /econ/roomInventory/room/{roomId}`
-- and read by the GET on the same path. `origin_id` is a GUID, the client's `OriginId`.
-- `properties` is a JSON blob the client writes and reads AS A STRING — stored and served
-- verbatim, never parsed. `tag_ids` is a JSON array of `room_inventory_item_tag.tag_id`: the
-- client reads the list back whole and nothing queries by tag, so there is no link table.
CREATE TABLE IF NOT EXISTS room_inventory_item (
  origin_id TEXT PRIMARY KEY,
  room_id INTEGER NOT NULL,
  name TEXT NOT NULL,
  description TEXT NOT NULL,
  image_name TEXT,
  created_at TEXT NOT NULL,
  modified_at TEXT NOT NULL,
  properties TEXT,
  tag_ids TEXT NOT NULL DEFAULT '[]',
  icon_shape INTEGER NOT NULL DEFAULT 0,
  icon_color INTEGER NOT NULL DEFAULT 0
  );

-- Every read is "this room's items" — the whole access pattern.
CREATE INDEX IF NOT EXISTS idx_room_inventory_item_room ON room_inventory_item (room_id);

-- A room's tags (`GET /econ/roomInventoryItemTags/room/{roomId}`), created by the `NewTags` an
-- item write carries. `tag_id` is an AUTOINCREMENT: the client's `TagId` is a long, not a
-- GUID. A name is unique within its room, so a `NewTags` entry naming an existing tag
-- resolves to it rather than making a twin.
CREATE TABLE IF NOT EXISTS room_inventory_item_tag (
  tag_id INTEGER PRIMARY KEY AUTOINCREMENT,
  room_id INTEGER NOT NULL,
  name TEXT NOT NULL,
  properties TEXT,
  UNIQUE (room_id, name)
  );

-- How many of an item a player holds (`GET /econ/roomInventory/room/{roomId}/player`). Keyed
-- by ITEM, not by room — the definition already says which room it belongs to, the same
-- reasoning as `room_inventory` and `room_balance` — and the served `RoomId` is joined in.
-- Written by `POST /econ/roomInventory/v2/award`; `count` is the total held, floored at zero,
-- and `concurrency_code` the last award's `NewConcurrencyCode` (stored, not checked).
CREATE TABLE IF NOT EXISTS room_inventory_item_player (
  account_id INTEGER NOT NULL,
  origin_id TEXT NOT NULL,
  count INTEGER NOT NULL DEFAULT 0,
  concurrency_code TEXT NOT NULL,
  created_at TEXT NOT NULL,
  modified_at TEXT NOT NULL,
  PRIMARY KEY (account_id, origin_id)
  );
