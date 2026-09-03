-- Retire `FriendlyName` from the room blob.
--
-- The rename route (PUT /rooms/:id/name) briefly wrote `FriendlyName` alongside `Name`,
-- and every read defaulted it to `Name`. Neither exists any more: this server serves no
-- display name apart from the unique `Name`, and a stored value would otherwise survive in
-- the blob forever (`json_set` on rename is gone, so nothing would ever update it again).
--
-- Strip the key from every room that carries one. `json_remove` on a blob without the key
-- is a no-op, so the WHERE only spares the rows that need no rewrite.
UPDATE room
SET data = json_remove(data, '$.FriendlyName')
WHERE json_type(data, '$.FriendlyName') IS NOT NULL;
