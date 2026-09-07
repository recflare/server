-- Server statistics sampled over time — one row per sample, as the presence cron
-- writes them. Generated from packages/domain/src/stats-db.ts (STAT_SCHEMA_DDL) — keep
-- in sync.
--
-- `stat_type` names what was measured (currently just `online`: the number of live
-- `presence` rows, i.e. players online, taken right after the expired ones are swept).
-- `value` is the measurement and `datetime` is when it was taken, as an ISO-8601 UTC
-- string so it reads directly and sorts lexically.
CREATE TABLE IF NOT EXISTS stat (
  stat_type TEXT NOT NULL,
  value INTEGER NOT NULL,
  datetime TEXT NOT NULL
  );

-- For "the `online` series over a time range".
CREATE INDEX IF NOT EXISTS idx_stat_type_datetime ON stat (stat_type, datetime);
