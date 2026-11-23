-- Use the canonical, supplied artwork for the modern creation-menu templates.
UPDATE room SET data = json_set(data, '$.ImageName', '3ss6lkjmuddib0maid1bay1jp.png')
WHERE name_lower = 'defaultmakerroom' AND creator_account_id = 1;
UPDATE room SET data = json_set(data, '$.ImageName', '1d2nvft6te5npx362qx9f098s.png')
WHERE name_lower = 'advancedmakerroom' AND creator_account_id = 1;
