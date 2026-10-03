-- Studio editor device-login grants (owned by the auth worker). Rec Room Studio
-- posts POST /connect/deviceauthorization here, then polls /connect/token with
-- grant_type=urn:ietf:params:oauth:grant-type:device_code. The browser page that
-- approves the code lives on www (`/device`); this table is only the handshake.
--
-- The device_code is a bearer secret until it is consumed, so only its SHA-256
-- is stored. The user_code is the short code the player sees and types, so it
-- has to be stored as itself. Kept in sync with STUDIO_DEVICE_SCHEMA_DDL in
-- src/studio-device.ts.

CREATE TABLE IF NOT EXISTS studio_device_grant (
  device_code_hash TEXT PRIMARY KEY,
  user_code TEXT NOT NULL UNIQUE,
  account_id INTEGER,
  status TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL
);
