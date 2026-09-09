-- Room roles as their own table, mirroring 0013's move of tags into `room_tag`. One row
-- per (room, account). Generated from packages/domain/src/rooms-db.ts (ROOM_SCHEMA_DDL) —
-- keep in sync.
--
-- The row is the client's `Roles` entry shape:
--   { "AccountId": …, "Role": …, "LastChangedByAccountId": …, "InvitedRole": … }
-- `role` is the member's CURRENT role tier (10 Host, 20 Moderator, 30 CoOwner,
-- 255 Creator); `invited_role` is the tier they have been OFFERED but not yet accepted —
-- usually higher than `role`, and 0 when no invitation is pending. `last_changed_by` is
-- who last touched the row; NULL for creator entries, matching the blob's
-- `LastChangedByAccountId: null`.
--
-- The table is AUTHORITATIVE and the blob's `Roles` key is removed below, the same
-- arrangement 0013 gave tags: `serializeRoom` drops `Roles` on write and the reads
-- re-attach it (attachRoles), so the room DTO the client sees is unchanged and the two
-- copies can't drift. `getContributedRooms` now matches on this table instead of running
-- `json_each` over every blob.

CREATE TABLE IF NOT EXISTS room_role (
  room_id INTEGER NOT NULL,
  account_id INTEGER NOT NULL,
  role INTEGER NOT NULL DEFAULT 0,
  last_changed_by INTEGER,
  invited_role INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (room_id, account_id)
  );

-- Backfill from the blobs, the way 0013 backfilled `room_tag`. `json_each` walks the
-- `Roles` array; a room with no array (or a null one) contributes nothing, which is why
-- this is a join rather than a correlated subquery. `INSERT OR IGNORE` collapses a blob
-- that somehow carries the same account twice — the primary key is (room, account).
INSERT OR IGNORE INTO room_role (room_id, account_id, role, last_changed_by, invited_role)
  SELECT
    r.room_id,
    json_extract(t.value, '$.AccountId'),
    COALESCE(json_extract(t.value, '$.Role'), 0),
    json_extract(t.value, '$.LastChangedByAccountId'),
    COALESCE(json_extract(t.value, '$.InvitedRole'), 0)
  FROM room r, json_each(r.data, '$.Roles') t
  WHERE json_extract(t.value, '$.AccountId') IS NOT NULL;

-- Single source of truth: the roles now live in `room_role`, so the copy in the blob
-- goes. Leaving it would be a second answer to "who has a role in this room" that only
-- the writes through setRoomRole keep current.
UPDATE room SET data = json_remove(data, '$.Roles');
