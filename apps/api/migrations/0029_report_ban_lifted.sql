-- Who LIFTED a ban, and when. Owned by the `api` worker; generated from src/reports-db.ts
-- (SCHEMA_DDL) — keep in sync.
--
-- A lift clears `banned`, `ban_expires`, `banned_by_player_id` and `banned_at` (see
-- 0020_report_ban_audit.sql), which leaves the row looking exactly like a report nobody
-- ever acted on. On the staff panel that read as "Ban…" next to a report whose ban a
-- colleague had deliberately lifted an hour earlier, and a second moderator re-banned the
-- player without knowing. The `audit_log` still had the lift, but nothing reads it per row.
--
-- So the lift now signs the row: `unbanned_by_player_id` is the moderator who lifted the
-- ban and `unbanned_at` when they did. Both are NULL until a ban is lifted, and are CLEARED
-- again by a re-ban (the row describes the ban's current state, and a standing ban has not
-- been lifted). A non-null `unbanned_at` on a `banned = 0` row therefore means "somebody
-- decided this player should be back in the game", which is what the panel shows.
--
-- Rows lifted before this migration are backfilled from `audit_log` (0024), where every
-- lift has been recorded as an `unban` row naming the report in `data.reportId` — the
-- latest such row per report, since a report can be banned and lifted more than once.
-- Only rows not banned NOW are touched: a re-ban after a lift has cleared the lift.
--
-- Neither column is indexed: read per row on the panel's tables, never filtered on.

ALTER TABLE report ADD COLUMN unbanned_by_player_id INTEGER;
ALTER TABLE report ADD COLUMN unbanned_at TEXT;

UPDATE report
SET unbanned_by_player_id = (
      SELECT player_id FROM audit_log
      WHERE action = 'unban' AND json_extract(data, '$.reportId') = report.id
      ORDER BY audit_log_id DESC LIMIT 1
    ),
    unbanned_at = (
      SELECT date FROM audit_log
      WHERE action = 'unban' AND json_extract(data, '$.reportId') = report.id
      ORDER BY audit_log_id DESC LIMIT 1
    )
WHERE banned = 0
  AND EXISTS (
    SELECT 1 FROM audit_log
    WHERE action = 'unban' AND json_extract(data, '$.reportId') = report.id
  );
