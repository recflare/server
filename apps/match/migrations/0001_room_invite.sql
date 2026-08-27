-- Room invites — one row per game invite a player sends another ("come join me in this
-- room"), as `POST /invite` creates them. Generated from
-- packages/domain/src/room-invites-db.ts (ROOM_INVITE_SCHEMA_DDL) — keep in sync.
--
-- The invite that reaches the invitee is a live notification, not a row: the worker pushes
-- a MessageReceived frame the moment the invite is created. This table exists so the invite
-- has an id of its own — `RoomInviteId`, which the create response hands back — and so an
-- invite can be looked up or expired after the fact rather than vanishing with the frame.

-- `room_invite_id` is AUTOINCREMENT rather than a bare rowid alias: the id is handed to the
-- client, and expiring old invites deletes rows, so a reused id would point a client's stale
-- invite at somebody else's.
--
-- `room_id` is nullable because the invite is: the caller names a room INSTANCE, and one
-- that has already died (or was never real) leaves the invite with nothing to resolve — the
-- worker sends it anyway, with a null RoomId, so the row records the same thing.
--
-- `created_at` is epoch SECONDS, like `presence.expires_at` on the same database and for the
-- same reason: the sweep that will expire these compares it against `Date.now()/1000` in
-- SQL, and an integer compare needs no parsing.
CREATE TABLE IF NOT EXISTS room_invite (
  room_invite_id INTEGER PRIMARY KEY AUTOINCREMENT,
  from_player_id INTEGER NOT NULL,
  to_player_id INTEGER NOT NULL,
  room_id INTEGER,
  created_at INTEGER NOT NULL
  );

-- For the expiry sweep: "everything older than X".
CREATE INDEX IF NOT EXISTS idx_room_invite_created ON room_invite (created_at);
