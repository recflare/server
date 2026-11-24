-- Dorms are named after their owner (`@<username>'s Dorm`), but a username change never
-- renamed the dorm, so it kept the name it was provisioned under (often sign-up's generated
-- one, e.g. `@CleverFalcon26637's Dorm`). `accounts` now renames the dorm with the username;
-- this catches up the dorms renamed before that.
--
-- Only the server's own names: a custom dorm the player named cannot start with `@`.
UPDATE room
  SET data = json_set(room.data, '$.Name', '@' || json_extract(account.data, '$.username') || '''s Dorm')
  FROM account
  WHERE account.account_id = room.creator_account_id
    AND room.is_dorm = 1
    AND room.name_lower LIKE '@%''s dorm'
    AND json_extract(account.data, '$.username') IS NOT NULL
    AND json_extract(room.data, '$.Name') <> '@' || json_extract(account.data, '$.username') || '''s Dorm';
