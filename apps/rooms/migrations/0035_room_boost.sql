-- Room boosts (2026 client): one row per boost request. Owned by the `rooms` worker; generated
-- from @repo/domain room-boosts-db.ts (ROOM_BOOST_SCHEMA_DDL) — keep in sync.
--
-- A player spends a Room Boost consumable in a room through econ's
-- `POST /api/consumables/v1/consume` (with the room's `RoomId` and a fresh GUID `RequestId`);
-- econ writes the row, `amount` being the units spent. A row is active for 30 days from
-- `created_at`, computed at read time, so rows are never deleted by expiry. `request_id` is
-- unique: a retried consume claims nothing twice.
CREATE TABLE IF NOT EXISTS room_boost (
	id INTEGER PRIMARY KEY AUTOINCREMENT,
	room_id INTEGER NOT NULL,
	account_id INTEGER NOT NULL,
	request_id TEXT NOT NULL UNIQUE,
	amount INTEGER NOT NULL DEFAULT 1,
	created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_room_boost_room ON room_boost (room_id, created_at);
CREATE INDEX IF NOT EXISTS idx_room_boost_player ON room_boost (room_id, account_id, created_at);
