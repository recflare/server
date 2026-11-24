-- Modern Choose Base Room matches these names exactly. Allocate after player IDs.
INSERT INTO room (data)
SELECT json_set(s.data, '$.RoomId', (SELECT MAX(room_id) FROM room) + t.version,
 '$.Name', t.name, '$.UgcVersion', t.version, '$.RankedEntityId', '',
 '$.Description', t.description,
 '$.Roles', json('[{"AccountId":1,"Role":255,"LastChangedByAccountId":null,"InvitedRole":0}]'),
 '$.Stats', json('{"CheerCount":0,"FavoriteCount":0,"VisitorCount":0,"VisitCount":0}'))
FROM room s JOIN (
 SELECT 1 version, 'DefaultMakerRoom' name, 'A blank canvas for creating with Rooms 1.' description
 UNION ALL SELECT 2, 'AdvancedMakerRoom', 'A blank canvas for creating with Rooms 2.'
) t WHERE s.name_lower = 'makerroom'
 AND NOT EXISTS (SELECT 1 FROM room e WHERE e.name_lower = lower(t.name));
INSERT OR IGNORE INTO room_tag (room_id, tag, type)
SELECT room_id, 'base', 0 FROM room WHERE name_lower IN ('defaultmakerroom','advancedmakerroom') AND creator_account_id=1;
INSERT OR IGNORE INTO room_role (account_id, room_id, role, invited_role, last_changed_by_account_id)
SELECT 1, room_id, 255, 0, NULL FROM room WHERE name_lower IN ('defaultmakerroom','advancedmakerroom') AND creator_account_id=1;
-- Built-in Maker scenes also used by Studio's empty-room loader. Reuse upstream image.
INSERT INTO subroom (room_id, data)
SELECT r.room_id, json_object('RoomId',r.room_id,'CreatorAccountId',1,'Name','Home',
 'UnitySceneId',CASE r.name_lower WHEN 'advancedmakerroom' THEN '5d4e40d8-f289-4295-a6e1-4f907835007d' ELSE 'a75f7547-79eb-47c6-8986-6767abcb4f92' END,
 'IsSandbox',json('true'),'MaxPlayers',12,'Accessibility',2,'LastModeratedSaveModerationState',0,'ShouldAutoStageSaves',json('true'))
FROM room r WHERE r.name_lower IN ('defaultmakerroom','advancedmakerroom') AND r.creator_account_id=1
 AND NOT EXISTS (SELECT 1 FROM subroom s WHERE s.room_id=r.room_id);
-- R2 requires an object-model save even for the built-in empty scene.
INSERT INTO subroom_save (sub_room_id,data)
SELECT s.sub_room_id,json_object('UnitySubAssets',json('[]'),'ReferencedUnityAssets',json('[]'),'ReferencedUnityAssetIds',json('[]'),
 'DataBlob',NULL,'DataBlobHash',NULL,'PersistenceVersion',0,'OMVersion',198,'UgcSubVersion',0,
 'SavedByAccountId',1,'SavedOnPlatform',0,'SavedOnDeviceClass',0,'Description','','Tags',json('[]'),'ModerationState',0,'CreatedAt',strftime('%Y-%m-%dT%H:%M:%fZ','now'))
FROM subroom s JOIN room r ON r.room_id=s.room_id WHERE r.name_lower='advancedmakerroom' AND r.creator_account_id=1
 AND s.current_save_id IS NULL AND NOT EXISTS (SELECT 1 FROM subroom_save v WHERE v.sub_room_id=s.sub_room_id);
UPDATE subroom SET current_save_id=(SELECT MIN(sub_room_data_save_id) FROM subroom_save v WHERE v.sub_room_id=subroom.sub_room_id)
WHERE room_id IN (SELECT room_id FROM room WHERE name_lower='advancedmakerroom' AND creator_account_id=1) AND current_save_id IS NULL;

