-- One-shot codes sent by email: the PBKDF2 hash of the six-digit code the player was
-- mailed, what it is for (`purpose`: a `password_reset`; or an `email_change` — the
-- current address approving a change — followed by an `email_verify` — the new address
-- confirming itself — both with the new address as `payload`), and when it was issued and
-- lapses. One pending code per
-- account and purpose. Mirrored by EMAIL_CODE_SCHEMA_DDL in @repo/domain's
-- email-code-db.ts, which says how the row is used — in short, a wrong guess BURNS it
-- (`code_hash` goes NULL, the row stays for the resend cooldown), a right one deletes it,
-- and a new request replaces it. Written by `auth` and `accounts`; owned here with the
-- rest of the account tables.

CREATE TABLE IF NOT EXISTS email_code (
  account_id INTEGER NOT NULL,
  purpose TEXT NOT NULL,
  code_hash TEXT,
  payload TEXT,
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  PRIMARY KEY (account_id, purpose)
);
