/**
 * Owned inventions on the shared `recflare` D1 database — the inventions a player has
 * bought. One row per (account, invention), written at purchase time by the `econ`
 * worker's buyInvention — the `v2` GET and the `v3` POST, which share one settlement.
 *
 * Only the invention id is stored: the invention record itself lives in the `invention`
 * table, whose schema the `api` worker owns (apps/api/migrations/0002_invention.sql) on
 * this same database, and copying its DTO here would leave two rows to keep in step. A
 * creator is not listed here either — they own their invention through its
 * `CreatorPlayerId`, and the buy path refuses to sell an invention to its own creator.
 *
 * The one thing a grant does write on the invention record is its `NumDownloads`: the
 * number of rows here that name it, re-derived on every grant (see `grantInvention`), the
 * way `CheerCount` is re-derived from `invention_interaction` on every cheer.
 *
 * The `econ` worker owns the schema/migration (apps/econ/migrations/
 * 0008_inventory_invention.sql) and is the only writer; `api` only reads, to fold bought
 * inventions into `GET /api/inventions/v2/mine`. Both import these helpers so the table
 * name and row shape live in one place — the same split as gifts-db.ts.
 */

/** Schema DDL (mirror of migrations 0008_inventory_invention.sql) — also builds the table in tests. */
export const INVENTORY_INVENTION_SCHEMA_DDL: string[] = [
	`CREATE TABLE IF NOT EXISTS inventory_invention (
		account_id INTEGER NOT NULL,
		invention_id INTEGER NOT NULL,
		acquired_at TEXT NOT NULL,
		PRIMARY KEY (account_id, invention_id)
	)`,
	// Backs the per-invention count `grantInvention` re-derives (migrations/0026).
	`CREATE INDEX IF NOT EXISTS idx_inventory_invention_invention
		ON inventory_invention (invention_id)`,
	// Backs the "top today" window (migrations/0033) — see getInventionAcquisitionCounts.
	`CREATE INDEX IF NOT EXISTS idx_inventory_invention_acquired
		ON inventory_invention (acquired_at, invention_id)`,
]

/**
 * Grant an invention to a player. INSERT OR IGNORE on the (account, invention) primary
 * key: owning an invention is boolean, so a second grant keeps the original
 * `acquired_at` rather than back-dating the purchase to now.
 *
 * Then resyncs the invention's denormalized `NumDownloads` — the number of players who
 * have it — and returns it. The count is DERIVED from this table rather than incremented,
 * so a repeated grant can't inflate it and a drifted number heals on the next one. It is
 * a `json_set` on the one key, like the cheer count, so it doesn't touch `ModifiedAt` or
 * race a full-record rewrite into losing anything but this number.
 */
export async function grantInvention(
	db: D1Database,
	accountId: number,
	inventionId: number
): Promise<number> {
	await db
		.prepare(
			'INSERT OR IGNORE INTO inventory_invention (account_id, invention_id, acquired_at) VALUES (?1, ?2, ?3)'
		)
		.bind(accountId, inventionId, new Date().toISOString())
		.run()

	const row = await db
		.prepare('SELECT COUNT(*) AS n FROM inventory_invention WHERE invention_id = ?1')
		.bind(inventionId)
		.first<{ n: number }>()
	const downloads = row?.n ?? 0
	await db
		.prepare(
			"UPDATE invention SET data = json_set(data, '$.NumDownloads', CAST(?2 AS INTEGER)) WHERE id = ?1"
		)
		.bind(inventionId, downloads)
		.run()
	return downloads
}

/**
 * Whether a player has bought an invention. This answers for BOUGHT inventions only —
 * the creator of an invention owns it without a row here, so callers that mean "may use
 * this invention" must check `CreatorPlayerId` as well.
 */
export async function ownsInvention(
	db: D1Database,
	accountId: number,
	inventionId: number
): Promise<boolean> {
	const row = await db
		.prepare(
			'SELECT 1 AS owned FROM inventory_invention WHERE account_id = ?1 AND invention_id = ?2'
		)
		.bind(accountId, inventionId)
		.first<{ owned: number }>()
	return row !== null
}

/**
 * How many times each invention was acquired at or after `since`, most-acquired first
 * (ties broken by newest invention, so paging is stable). Backs the `api` worker's "top
 * today" feed, which passes 24 hours ago.
 *
 * `acquired_at` holds `toISOString()` output, which is fixed-width UTC, so a lexical
 * `>=` on the string is a chronological comparison — no date parsing in SQL.
 *
 * This counts ACQUISITIONS, not spend: a free invention's grant is a row here just like
 * a paid one, and one player can only ever contribute a single row per invention (the
 * table's primary key), so a popular invention can't be inflated by one buyer. Creators
 * are absent by design — they own theirs through `CreatorPlayerId` and never buy it —
 * which is what makes this a measure of what other people picked up.
 *
 * `INDEXED BY idx_inventory_invention_acquired` is load-bearing. That index answers the
 * window as a range seek and carries `invention_id`, so the day's rows are read from it
 * alone. Left to itself the planner walks `idx_inventory_invention_invention` instead, to
 * skip sorting for the GROUP BY, which reads EVERY acquisition ever made to keep a day's
 * worth: ~100k rows for ~1.7k on production, 30 ms to 0.65 ms in a local benchmark.
 */
export async function getInventionAcquisitionCounts(
	db: D1Database,
	since: string
): Promise<Array<{ inventionId: number; count: number }>> {
	const { results } = await db
		.prepare(
			`SELECT invention_id, COUNT(*) AS count
			 FROM inventory_invention INDEXED BY idx_inventory_invention_acquired
			 WHERE acquired_at >= ?1
			 GROUP BY invention_id
			 ORDER BY count DESC, invention_id DESC`
		)
		.bind(since)
		.all<{ invention_id: number; count: number }>()
	return results.map((r) => ({ inventionId: r.invention_id, count: r.count }))
}

/** The ids of every invention a player has bought, oldest purchase first. */
export async function getOwnedInventionIds(db: D1Database, accountId: number): Promise<number[]> {
	const { results } = await db
		.prepare(
			'SELECT invention_id FROM inventory_invention WHERE account_id = ?1 ORDER BY acquired_at, invention_id'
		)
		.bind(accountId)
		.all<{ invention_id: number }>()
	return results.map((r) => r.invention_id)
}
