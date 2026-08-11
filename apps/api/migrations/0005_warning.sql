-- Moderator-issued player warnings. The counterpart to the `report` table (0004):
-- reports are what players submit, warnings are what a moderator hands down. Also
-- columnar rather than a JSON blob, and likewise append-only. Owned by the `api`
-- worker; generated from src/warnings-db.ts (SCHEMA_DDL) — keep in sync.
--
-- `moderator_player_id` is the acting moderator, taken from the caller's bearer
-- token (the endpoint is gated on the `moderator` role); everything else comes
-- from the form body. `display_reason` is what the warned player is shown,
-- `moderator_note` is internal.

CREATE TABLE IF NOT EXISTS warning (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  moderator_player_id INTEGER NOT NULL,
  warned_player_id INTEGER NOT NULL,
  report_category INTEGER NOT NULL DEFAULT 0,
  display_reason TEXT,
  moderator_note TEXT,
  created_at TEXT NOT NULL
  );
CREATE INDEX IF NOT EXISTS idx_warning_warned ON warning (warned_player_id);
CREATE INDEX IF NOT EXISTS idx_warning_moderator ON warning (moderator_player_id);
