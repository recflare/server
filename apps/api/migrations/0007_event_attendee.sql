-- Player-event RSVPs: one row per player per event, recording how they answered
-- (`POST /api/playerevents/v1/respond`). Unlike the `event` table next to it, this
-- one is genuinely columnar — like the relationship/report tables — so it's a
-- normal relational table rather than a JSON blob. Owned by the `api` worker;
-- generated from src/events-db.ts (SCHEMA_DDL) — keep in sync.
--
-- `status` is the response type: 0 Going, 1 Interested, 2 Can't go. Only Going
-- counts toward the event's `AttendeeCount`, which is recomputed from this table on
-- every response. A decline is recorded rather than deleted, so the client can show
-- a player their own answer and changing your mind is an UPDATE (the composite
-- primary key is what makes the upsert a replace).
--
-- An event's creator gets a Going row at create time — that's why a fresh event's
-- AttendeeCount is 1.

CREATE TABLE IF NOT EXISTS event_attendee (
  event_id INTEGER NOT NULL,
  player_id INTEGER NOT NULL,
  status INTEGER NOT NULL,
  responded_at TEXT NOT NULL,
  PRIMARY KEY (event_id, player_id)
  );
CREATE INDEX IF NOT EXISTS idx_event_attendee_player ON event_attendee (player_id);
