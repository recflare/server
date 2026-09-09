-- A player's interaction with an invention. One row per (player, invention); `cheered`
-- is toggled in place and the invention JSON's denormalized `CheerCount` is resynced
-- after every write. Generated from src/inventions-db.ts (SCHEMA_DDL) — keep in sync.

CREATE TABLE IF NOT EXISTS invention_interaction (
  player_id INTEGER NOT NULL,
  invention_id INTEGER NOT NULL,
  cheered INTEGER NOT NULL DEFAULT 0,
  created_at TEXT,
  PRIMARY KEY (player_id, invention_id)
);
CREATE INDEX IF NOT EXISTS idx_invention_interaction_invention
  ON invention_interaction (invention_id);
