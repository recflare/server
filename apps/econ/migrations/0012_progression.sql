-- Player progression (level + XP), owned by the `econ` worker as the writer, but shared:
-- `econ` pays XP out (game rewards) and `api` reads it back for
-- `GET /api/players/v{1,2}/progression/…`, so the helpers live in @repo/domain rather than
-- in either worker. Same split as `received_gift`.
--
-- One row per account, created on the first grant. A missing row means "nothing earned
-- yet", which is the level-1/0-XP default the progression endpoints already served — so
-- reads fall back to it instead of inserting on a GET.
--
-- `level` is stored rather than derived: the reference server levels a player up by
-- subtracting the tier's RequiredXp from the running XP, using thresholds from a config we
-- don't have (configv2.json's LevelProgressionMaps). Until those numbers exist XP
-- accumulates and everyone stays level 1; the column is here so turning the curve on later
-- is a write, not a migration. Kept in sync with PROGRESSION_SCHEMA_DDL in
-- packages/domain/src/progression-db.ts.

CREATE TABLE IF NOT EXISTS progression (
  account_id INTEGER PRIMARY KEY,
  level INTEGER NOT NULL DEFAULT 1,
  xp INTEGER NOT NULL DEFAULT 0
  );
