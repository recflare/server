-- Canonical descriptions for the modern room-creation templates.
UPDATE room SET data = json_set(data, '$.Description', 'The place to start for most creators. Make it whatever you like!
- Simple Creation
- Animation Support
- Previously called: MakerRoom (R1)')
WHERE name_lower = 'defaultmakerroom' AND creator_account_id = 1;
UPDATE room SET data = json_set(data, '$.Description', 'A blank canvas recommended for experienced creators who are familiar with hierarchical building.
- Containers
- Replicator
- Pathfinder
- Previously called: MakerRoom2 (R2)')
WHERE name_lower = 'advancedmakerroom' AND creator_account_id = 1;
