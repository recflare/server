-- Player-event tags: the categories an event is filed under (`workshops`, `meetup`, …),
-- one row per tag per event. Owned by the `api` worker; generated from src/events-db.ts
-- (SCHEMA_DDL) — keep in sync.
--
-- A separate table rather than a field on the event blob, for a reason that isn't
-- storage taste: the stored blob IS the event DTO every read serves verbatim, and the
-- event reads do NOT carry tags — they surface only behind
-- `GET /api/playerevents/v1/{id}?includeDetails=True`. Putting them in the blob would
-- leak a `Tags` key into every other read.
--
-- `tag` is stored lowercased and is the search key: `?query=%23workshops` (a `#`-prefixed
-- term) filters on this table, while a bare term still matches the name/description.
-- `type` is the client's tag-category int, echoed back as sent — its enum isn't reversed
-- yet, and nothing here interprets it.
--
-- The primary key is (event_id, tag): an event can't carry the same tag twice, and a tag
-- edit REPLACES the event's set rather than accumulating.

CREATE TABLE IF NOT EXISTS event_tag (
  event_id INTEGER NOT NULL,
  tag TEXT NOT NULL,
  type INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (event_id, tag)
  );
CREATE INDEX IF NOT EXISTS idx_event_tag_tag ON event_tag (tag);
