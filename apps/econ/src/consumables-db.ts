/**
 * Owned consumables on the shared `recflare` D1 database — the consumable items a
 * player has bought from a storefront (e.g. a "Supreme Pizza"). One row per granted
 * instance: unlike avatar items (own-once, keyed by their desc), consumables stack, so
 * each purchase inserts a fresh row carrying its own id, count and created_at.
 *
 * Granted at purchase time (`POST /api/storefronts/v2/buyItem`, when the gift-drop
 * carries a `ConsumableItemDesc`) and read back by `GET /api/consumables/v2/getUnlocked`,
 * which groups a player's rows by `consumable_item_desc` into the client's unlocked-
 * consumable DTO — its `Ids`/`CreatedAts` are these per-instance columns and `Count`
 * their sum.
 *
 * This worker (`econ`) owns the table and its migration — see apps/econ/migrations/
 * 0005_consumable.sql.
 */

/** Schema DDL (mirror of migrations 0005_consumable.sql) — also builds the table in tests. */
export const CONSUMABLE_SCHEMA_DDL: string[] = [
	`CREATE TABLE IF NOT EXISTS consumable (
		id INTEGER PRIMARY KEY AUTOINCREMENT,
		account_id INTEGER NOT NULL,
		consumable_item_desc TEXT NOT NULL,
		count INTEGER NOT NULL,
		created_at TEXT NOT NULL
	)`,
	`CREATE INDEX IF NOT EXISTS idx_consumable_account ON consumable (account_id)`,
]

/**
 * An unlocked consumable as `/api/consumables/v2/getUnlocked` serves it: one entry per
 * distinct `ConsumableItemDesc`, aggregating every instance the player owns. `Ids` and
 * `CreatedAts` line up per instance; `Count`/`InitialCount` are the summed quantity (no
 * consumption is tracked yet, so they stay equal). The activation fields are inert
 * defaults until timed consumables exist.
 */
export interface UnlockedConsumable {
	Ids: number[]
	CreatedAts: string[]
	ConsumableItemDesc: string
	Count: number
	InitialCount: number
	IsActive: boolean
	ActiveDurationMinutes: number
	IsTransferable: boolean
}

/**
 * Grant `count` of a consumable to a player as a new owned instance (they stack).
 * Returns the new row's id — the consumable mapping id the client keys on.
 */
export async function grantConsumable(
	db: D1Database,
	accountId: number,
	consumableItemDesc: string,
	count: number
): Promise<number> {
	const row = await db
		.prepare(
			`INSERT INTO consumable (account_id, consumable_item_desc, count, created_at)
			 VALUES (?1, ?2, ?3, ?4) RETURNING id`
		)
		.bind(accountId, consumableItemDesc, count, new Date().toISOString())
		.first<{ id: number }>()
	return row?.id ?? 0
}

/** A player's total owned count of a consumable, summed across its stacked instances. */
export async function countConsumable(
	db: D1Database,
	accountId: number,
	consumableItemDesc: string
): Promise<number> {
	const row = await db
		.prepare(
			'SELECT COALESCE(SUM(count), 0) AS total FROM consumable WHERE account_id = ?1 AND consumable_item_desc = ?2'
		)
		.bind(accountId, consumableItemDesc)
		.first<{ total: number }>()
	return row?.total ?? 0
}

/** The outcome of consuming an instance — its identity plus the resulting count. */
export interface ConsumeResult {
	id: number
	consumableItemDesc: string
	createdAt: string
	/** The instance's count before this consumption. */
	previousCount: number
	/** The count left after consuming (0 when the row was deleted). */
	remaining: number
}

/**
 * Consume `deltaCount` from one owned consumable instance, by row `id` and scoped to
 * its owner (so a player can only consume their own). Reduces that instance's `count`;
 * once it would reach zero (or below) the row is deleted entirely. Returns the
 * instance's details plus the resulting count, or null when the row didn't exist /
 * isn't the caller's.
 */
/** The `ConsumableItemDesc` of a consumable instance the account owns, or null. */
export async function getOwnedConsumableDesc(
	db: D1Database,
	accountId: number,
	id: number
): Promise<string | null> {
	const row = await db
		.prepare('SELECT consumable_item_desc FROM consumable WHERE id = ?1 AND account_id = ?2')
		.bind(id, accountId)
		.first<{ consumable_item_desc: string }>()
	return row?.consumable_item_desc ?? null
}

export async function consumeConsumable(
	db: D1Database,
	accountId: number,
	id: number,
	deltaCount: number
): Promise<ConsumeResult | null> {
	const row = await db
		.prepare(
			'SELECT consumable_item_desc, count, created_at FROM consumable WHERE id = ?1 AND account_id = ?2'
		)
		.bind(id, accountId)
		.first<{ consumable_item_desc: string; count: number; created_at: string }>()
	if (row === null) return null

	const remaining = row.count - deltaCount
	if (remaining > 0) {
		await db.prepare('UPDATE consumable SET count = ?2 WHERE id = ?1').bind(id, remaining).run()
	} else {
		await db
			.prepare('DELETE FROM consumable WHERE id = ?1 AND account_id = ?2')
			.bind(id, accountId)
			.run()
	}
	return {
		id,
		consumableItemDesc: row.consumable_item_desc,
		createdAt: row.created_at,
		previousCount: row.count,
		remaining: Math.max(remaining, 0),
	}
}

interface ConsumableRow {
	id: number
	consumable_item_desc: string
	count: number
	created_at: string
}

/**
 * Every consumable a player owns, grouped by item into the unlocked-consumable DTO.
 * Rows are read oldest-first so each group's `Ids`/`CreatedAts` are in purchase order.
 */
export async function getConsumables(
	db: D1Database,
	accountId: number
): Promise<UnlockedConsumable[]> {
	const { results } = await db
		.prepare(
			`SELECT id, consumable_item_desc, count, created_at
			 FROM consumable WHERE account_id = ?1 ORDER BY id`
		)
		.bind(accountId)
		.all<ConsumableRow>()

	const byDesc = new Map<string, UnlockedConsumable>()
	for (const r of results) {
		const existing = byDesc.get(r.consumable_item_desc)
		if (existing === undefined) {
			byDesc.set(r.consumable_item_desc, {
				Ids: [r.id],
				CreatedAts: [r.created_at],
				ConsumableItemDesc: r.consumable_item_desc,
				Count: r.count,
				InitialCount: r.count,
				IsActive: false,
				ActiveDurationMinutes: 0,
				IsTransferable: false,
			})
		} else {
			existing.Ids.push(r.id)
			existing.CreatedAts.push(r.created_at)
			existing.Count += r.count
			existing.InitialCount += r.count
		}
	}
	return [...byDesc.values()]
}
