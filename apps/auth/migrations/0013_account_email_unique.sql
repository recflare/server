-- An email address belongs to ONE account. Password recovery (`auth`
-- `POST /account/recoverpassword`) is handed nothing but the address the player typed and
-- has to find their account from it, which only works if no two accounts share one.
--
-- Exposed as a generated column, case-folded, with an empty or absent email read as NULL so
-- accounts without one never collide — and a UNIQUE partial index over it, which is what
-- actually refuses a second holder. `accounts` `POST /account/me/email` checks first and
-- answers a refusal the player can read; the index is the backstop against a race.
--
-- Before the index can be built, existing duplicates have to go: the LOWEST account id
-- keeps the address (the first account to claim it) and the others lose theirs, since a
-- recovery sent to a shared address could only ever reach one of them anyway. Those
-- players set it again from the account page or in game.
--
-- Kept in sync with SCHEMA_DDL in @repo/domain's accounts-db.ts (and its mirror in
-- apps/econ/src/avatar-db.ts).

ALTER TABLE account ADD COLUMN email_lower TEXT GENERATED ALWAYS AS (NULLIF(lower(json_extract(data, '$.email')), '')) VIRTUAL;

UPDATE account SET data = json_remove(data, '$.email')
 WHERE email_lower IS NOT NULL
   AND account_id > (SELECT MIN(a2.account_id) FROM account a2 WHERE a2.email_lower = account.email_lower);

CREATE UNIQUE INDEX IF NOT EXISTS idx_account_email_lower ON account (email_lower) WHERE email_lower IS NOT NULL;
