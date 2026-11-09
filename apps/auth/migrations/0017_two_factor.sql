-- Two-factor sign-in, opt-in per account. `account_2fa` holds which second factor an
-- account's PASSWORD grant must also pass (`method`: 'none', 'totp' or 'email'), the
-- authenticator secret (base32) once enrolled, a secret being enrolled but not yet
-- confirmed with a code, and the last TOTP time step accepted (so a code can't be
-- replayed). `login_challenge` is a pending sign-in waiting on that second factor, keyed by
-- a SHA-256 of the client's `login_context`, counting the guesses made against it.
-- Mirrored by TWO_FACTOR_SCHEMA_DDL in src/two-factor.ts, which says how both are used.

CREATE TABLE IF NOT EXISTS account_2fa (
  account_id INTEGER PRIMARY KEY,
  method TEXT NOT NULL DEFAULT 'none',
  totp_secret TEXT,
  totp_pending_secret TEXT,
  totp_last_step INTEGER NOT NULL DEFAULT 0,
  updated_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS login_challenge (
  context_hash TEXT PRIMARY KEY,
  account_id INTEGER NOT NULL,
  method TEXT NOT NULL,
  attempts INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_login_challenge_expires ON login_challenge (expires_at);
