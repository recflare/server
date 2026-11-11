-- Player dorms are not developer-owned. Every dorm `getOrCreateDormRoom` provisioned was a
-- copy of the template dorm (RoomId 1), and the copy kept the template's
-- `IsDeveloperOwned: true`; the code now clears it on new dorms, and this clears it on the
-- ones already made. Coach's own dorms (the template included) keep the flag.
--
-- Dorms only: other rooms with the flag were set by hand and are left alone.

UPDATE room
  SET data = json_set(data, '$.IsDeveloperOwned', json('false'))
  WHERE is_dorm = 1
    AND creator_account_id <> 1
    AND json_extract(data, '$.IsDeveloperOwned') = 1;
