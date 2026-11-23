CREATE TABLE IF NOT EXISTS invention_version (
    invention_id INTEGER NOT NULL,
    version_number INTEGER NOT NULL,
    data TEXT NOT NULL,
    PRIMARY KEY (invention_id, version_number)
);
INSERT OR IGNORE INTO invention_version (invention_id, version_number, data)
SELECT id, json_extract(data, '$.CurrentVersionNumber'),
    json_set(json_extract(data, '$.CurrentVersion'),
        '$.CreatedAt', json_extract(data, '$.CreatedAt'),
        '$.ReferencedInventions', json(COALESCE(json_extract(data, '$.ReferencedInventions'), '[]')),
        '$.ReferencedUnityAssetIds', json(COALESCE(json_extract(data, '$.ReferencedUnityAssetIds'), '[]')))
FROM invention WHERE json_extract(data, '$.CurrentVersion') IS NOT NULL;
