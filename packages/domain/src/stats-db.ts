/**
 * Server statistics sampled over time (`stat` table). The `match` presence cron
 * records one `online` sample per run — the count of live `presence` rows once the
 * expired ones are swept. Migration: apps/match/migrations/0002_stat.sql.
 */

/** Schema DDL (mirror of apps/match/migrations/0002_stat.sql). */
export const STAT_SCHEMA_DDL: string[] = [
	`CREATE TABLE IF NOT EXISTS stat (
		stat_type TEXT NOT NULL,
		value INTEGER NOT NULL,
		datetime TEXT NOT NULL
	)`,
	`CREATE INDEX IF NOT EXISTS idx_stat_type_datetime ON stat (stat_type, datetime)`,
]

export interface StatRow {
	statType: string
	value: number
	datetime: string
}

/** Record one sample of `statType`, stamped with the current UTC time (ISO-8601). */
export async function recordStat(
	db: D1Database,
	statType: string,
	value: number,
	now: Date = new Date()
): Promise<void> {
	await db
		.prepare('INSERT INTO stat (stat_type, value, datetime) VALUES (?1, ?2, ?3)')
		.bind(statType, value, now.toISOString())
		.run()
}

/** Samples of `statType`, oldest first. */
export async function getStats(db: D1Database, statType: string, limit = 1000): Promise<StatRow[]> {
	const { results } = await db
		.prepare(
			'SELECT stat_type, value, datetime FROM stat WHERE stat_type = ?1 ORDER BY datetime ASC LIMIT ?2'
		)
		.bind(statType, limit)
		.all<{ stat_type: string; value: number; datetime: string }>()
	return results.map((r) => ({ statType: r.stat_type, value: r.value, datetime: r.datetime }))
}
