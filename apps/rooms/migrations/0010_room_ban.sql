-- Per-room player bans. `POST /rooms/{roomId}/bans` is how a room's owner (or a
-- staff account) bans a player from a room; one row per (room, player), so
-- re-banning someone already banned updates their row rather than appending a
-- second one.
--
-- `ban_mask` is the client's `banMask` form field, stored verbatim. Its meaning is
-- not known yet — the client sends 0 — so nothing interprets it; it's kept so the
-- value isn't lost once we work out what it selects.
--
-- Columnar rather than a JSON blob, and deliberately NOT part of the room's `data`
-- blob: that blob is served to the client verbatim as the room, and a room's ban
-- list is not something every reader of a room should receive.
--
-- Generated from packages/domain/src/rooms-db.ts (ROOM_SCHEMA_DDL) — keep in sync.

CREATE TABLE IF NOT EXISTS room_ban (
  room_id INTEGER NOT NULL,
  banned_player_id INTEGER NOT NULL,
  ban_mask INTEGER NOT NULL DEFAULT 0,
  banned_by_account_id INTEGER NOT NULL,
  created_at TEXT NOT NULL,
  PRIMARY KEY (room_id, banned_player_id)
  );
CREATE INDEX IF NOT EXISTS idx_room_ban_player ON room_ban (banned_player_id);
