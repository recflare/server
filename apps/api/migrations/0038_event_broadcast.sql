-- The broadcast running for a multi-instance player event (2026 client), one row per
-- event. Owned by the `api` worker; generated from src/events-db.ts (SCHEMA_DDL) — keep
-- in sync.
--
-- Written only by `match` (`POST /tachyon/broadcast`) when the room server reports that it
-- started or stopped a broadcast. Every event read joins it in as the event's
-- `BroadcastingRoomInstanceId`; it is not a key on the event blob because every edit
-- rewrites that blob whole.
CREATE TABLE IF NOT EXISTS event_broadcast (
	event_id INTEGER PRIMARY KEY,
	room_instance_id INTEGER NOT NULL,
	broadcaster_id INTEGER NOT NULL,
	started_at TEXT NOT NULL
);
