-- A player's own OpenAI API key, which powers their Roomie's voice conversation. Owned by the
-- `ai` worker, the only worker holding ROOMIE_KEY_ENCRYPTION_KEY: the key is stored as
-- AES-256-GCM ciphertext, bound (as additional authenticated data) to the account and the
-- encryption-key version, so a copy of this table alone reveals nothing usable and a row
-- moved onto another account fails to decrypt. No column holds any part of the plaintext.
-- Mirrored by ROOMIE_API_KEY_SCHEMA_DDL in @repo/domain's roomie-key-db.ts.

CREATE TABLE IF NOT EXISTS roomie_api_key (
  account_id INTEGER PRIMARY KEY,
  key_version INTEGER NOT NULL,
  iv BLOB NOT NULL,
  ciphertext BLOB NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
