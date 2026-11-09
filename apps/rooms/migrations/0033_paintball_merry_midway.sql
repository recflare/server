-- Paintball (RoomId 10) gains a seventh map, MerryMidway, configured like the other six
-- (8 players, public, auto-staged saves, no creator). Its id comes from the subroom
-- sequence rather than being fixed: dorms and clones have been minting ids from the same
-- sequence since 0007, so any id picked here could already be taken on a live database.
-- Guarded on the scene, so it inserts once however it is applied.
--
-- Mirrored in static/ImportRooms.json (which the tests seed from) — keep in sync.

INSERT INTO subroom (room_id, data)
  SELECT 10, json_object(
    'RoomId', 10,
    'CreatorAccountId', NULL,
    'UnitySceneId', 'a8b02f8f-7c7c-4271-8d13-6151348c4fc1',
    'Name', 'MerryMidway',
    'LastModeratedSaveModerationState', 0,
    'IsSandbox', json('false'),
    'MaxPlayers', 8,
    'Accessibility', 1,
    'ShouldAutoStageSaves', json('true')
  )
  WHERE EXISTS (SELECT 1 FROM room WHERE room_id = 10)
    AND NOT EXISTS (
      SELECT 1 FROM subroom
      WHERE room_id = 10
        AND json_extract(data, '$.UnitySceneId') = 'a8b02f8f-7c7c-4271-8d13-6151348c4fc1'
    );
