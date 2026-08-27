-- The room_id index behind a room's event shelf (`GET /api/playerevents/v1/room/{roomId}`).
-- Owned by the `api` worker; generated from src/events-db.ts (SCHEMA_DDL) — keep in sync.
--
-- The column itself has been on the `event` table since 0006; only the index is new. The
-- club feed has had one since that migration and the room feed now reads the same way, so
-- without this a room's shelf scans every event in the database.

CREATE INDEX IF NOT EXISTS idx_event_room ON event (room_id);
