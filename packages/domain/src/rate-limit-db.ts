/**
 * Fixed-window counters on the shared `recflare` D1 database (owned by the `auth` worker,
 * migration 0015): "at most N of these per key per window". What stands between the two
 * things this server emails — password-recovery codes (`auth`) and email-change codes
 * (`accounts`) — and someone who has an address and a loop: keyed by the target account,
 * so a mailbox gets a handful of codes a day however many are asked for, and by the
 * requesting IP, so one source can't spray requests across every address it knows.
 *
 * A fixed window rather than a sliding one: the first hit in a window starts it, the
 * count resets when it lapses. Coarse, but one UPSERT with no history to keep, and the
 * caps here are loose enough that the edges don't matter. Rows for keys nobody has touched
 * in a week are purged as a side effect of the next take, so the table stays the size of
 * recent activity.
 */

/** Schema DDL (mirror of apps/auth/migrations/0015_rate_limit.sql). */
export const RATE_LIMIT_SCHEMA_DDL: string[] = [
	`CREATE TABLE IF NOT EXISTS rate_limit (
		key TEXT PRIMARY KEY,
		window_started_at INTEGER NOT NULL,
		count INTEGER NOT NULL
	)`,
]

/** Rows idle this long (s) are dropped on the next take. Longer than any window in use. */
const RATE_LIMIT_PURGE_AFTER_SECONDS = 7 * 24 * 60 * 60

/**
 * Count one hit against `key` and say whether it is within `limit` per `windowSeconds`.
 * The hit is counted whether or not it is allowed, so a caller that keeps hammering a
 * capped key stays capped. `count` is the window's total after this hit, for the log.
 */
export async function takeRateLimit(
	db: D1Database,
	key: string,
	limit: number,
	windowSeconds: number
): Promise<{ allowed: boolean; count: number }> {
	const now = Math.floor(Date.now() / 1000)
	const [, taken] = await db.batch<{ count: number }>([
		db
			.prepare('DELETE FROM rate_limit WHERE window_started_at < ?1')
			.bind(now - RATE_LIMIT_PURGE_AFTER_SECONDS),
		db
			.prepare(
				`INSERT INTO rate_limit (key, window_started_at, count) VALUES (?1, ?2, 1)
				 ON CONFLICT (key) DO UPDATE SET
					count = CASE WHEN window_started_at + ?3 <= ?2 THEN 1 ELSE count + 1 END,
					window_started_at = CASE WHEN window_started_at + ?3 <= ?2 THEN ?2 ELSE window_started_at END
				 RETURNING count`
			)
			.bind(key, now, windowSeconds),
	])
	const count = taken!.results[0]?.count ?? 1
	return { allowed: count <= limit, count }
}
