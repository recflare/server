-- Per-player settings: the key/value bag the game client reads on load and writes back
-- as the player toggles options. Generated from packages/domain/src/player-settings-db.ts
-- (PLAYER_SETTINGS_SCHEMA_DDL) — keep in sync.
--
-- One row per player. `data` is the whole map as a JSON object of strings
-- (`{"Recroom.OOBE":"77","TUTORIAL_COMPLETE_MASK":"11"}`) — the same value the
-- RECFLARE_PLAYER_SETTINGS KV namespace used to hold under `player:<id>`, which is what
-- `runx admin settings-import-kv` copies across. Every writer (this worker, api, match,
-- chat) merges into the object rather than replacing it.
CREATE TABLE IF NOT EXISTS player_settings (
  account_id INTEGER PRIMARY KEY,
  data TEXT NOT NULL
);
