-- Lifetime visit counter on `room`. The `match` worker bumps it once per successful
-- matchmake into the room (see recordRoomVisit, called from match's enterRoom), which
-- is the only way a player ever lands in a room, and every room read serves it as the
-- room's `Stats.VisitCount`.
--
-- A real column rather than a field in the `data` blob: a visit has to be one atomic
-- `visits = visits + 1` UPDATE. Writing it into the blob would mean reading the whole
-- room, editing the JSON and writing it back, so two players entering at once would
-- lose one of the visits — and would race every other writer of the room besides.
--
-- Unlike CheerCount/FavoriteCount it can't be derived on read either: a visit leaves
-- no per-player row to count (`interaction.last_visited_at` is only stamped by the
-- cheer/favorite toggles). Existing rooms start from 0 — the count begins now.
--
-- Generated from packages/domain/src/rooms-db.ts (ROOM_SCHEMA_DDL) — keep in sync.

ALTER TABLE room ADD COLUMN visits INTEGER NOT NULL DEFAULT 0;
