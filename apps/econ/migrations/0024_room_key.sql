-- Room keys — a room's own admission tickets.
--
-- A creator lists a key for their room (`POST /api/roomkeys/v1/create`, form-encoded
-- `Type=Key&RoomId=1162&Name=my%20key&Description=…&Price=50`): a named, priced thing a
-- player can hold to get through a door the room locks. This is the LISTING — its name, its
-- price, which room it opens. Nothing SELLS a key yet, so there is no table of who holds one.
-- Owned by the `econ` worker; generated from src/room-key-db.ts (ROOM_KEY_SCHEMA_DDL) — keep
-- in sync.
--
-- `room_key_id` is an AUTOINCREMENT rather than a GUID, unlike a room currency's or a
-- consumable's: the client's own model (`LocalRoomKeyCreated`'s payload, which names a key by
-- a numeric `RoomKeyId`) says so. `replication_id` is the GUID beside it that the same
-- payload carries; it is minted here.
--
-- `key_type` is the body's `Type`, stored as the enum NAME it arrives as (`Key`) and served
-- back as its ordinal (`Type: 0`); only `Key` has been observed.
--
-- `price` is the body's `Price`, and `purchase_currency_id` the `room_currency` it is charged
-- in — nullable, `Guid?` in the client's model, and the create body names none, so it is null
-- until an edit can set it. `image_name` is '' in the row and served as a null `ImageName`
-- (what the client reads) until a key can carry art.
CREATE TABLE IF NOT EXISTS room_key (
  room_key_id INTEGER PRIMARY KEY AUTOINCREMENT,
  replication_id TEXT NOT NULL,
  room_id INTEGER NOT NULL,
  key_type TEXT NOT NULL,
  name TEXT NOT NULL,
  description TEXT NOT NULL,
  price INTEGER NOT NULL,
  purchase_currency_id TEXT,
  image_name TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL
  );

-- Every read is "this room's keys" — the whole access pattern.
CREATE INDEX IF NOT EXISTS idx_room_key_room ON room_key (room_id);
