/**
 * Owned CUSTOM avatar items on the shared `recflare` D1 database — the custom avatar items
 * (player-made shirts and the imported first-party items alike) a player has bought. One row
 * per (account, item), written by `POST /api/items/bulkpurchase` when a line names an item
 * by `Guid`, and read back by `GET /econ/customAvatarItems/v1/owned`.
 *
 * Only the id is stored: the item record lives in `custom_avatar_item`, whose schema the
 * `api` worker owns (apps/api/src/custom-avatar-items-db.ts) on this same database, and the
 * owned read joins across to serve it whole. A creator is not listed here — they own their
 * item through `CreatorAccountId`, which the owned read folds in and the buy path refuses to
 * sell them — the same arrangement as `inventory_invention`.
 *
 * This worker (`econ`) owns the table and its migration — see apps/econ/migrations/
 * 0023_inventory_custom.sql.
 */

import { parseCustomAvatarItem } from '../../api/src/custom-avatar-items-db'

import type { CustomAvatarItem } from '../../api/src/custom-avatar-items-db'

/** Schema DDL (mirror of migrations 0023_inventory_custom.sql) — also builds the table in tests. */
export const INVENTORY_CUSTOM_SCHEMA_DDL: string[] = [
	`CREATE TABLE IF NOT EXISTS inventory_custom (
		account_id INTEGER NOT NULL,
		custom_avatar_item_id TEXT NOT NULL,
		acquired_at TEXT NOT NULL,
		PRIMARY KEY (account_id, custom_avatar_item_id)
	)`,
]

/**
 * Grant a custom avatar item to a player. INSERT OR IGNORE on the (account, item) primary
 * key: owning an item is boolean, so a second grant keeps the original `acquired_at` rather
 * than back-dating the purchase to now.
 */
export async function grantCustomAvatarItem(
	db: D1Database,
	accountId: number,
	customAvatarItemId: string,
	now: Date = new Date()
): Promise<boolean> {
	const { meta } = await db
		.prepare(
			'INSERT OR IGNORE INTO inventory_custom (account_id, custom_avatar_item_id, acquired_at) VALUES (?1, ?2, ?3)'
		)
		.bind(accountId, customAvatarItemId, now.toISOString())
		.run()
	return meta.changes > 0
}

/**
 * Which of `ids` a player has BOUGHT. Bought only — the creator of an item owns it without a
 * row here, so a caller that means "may wear this" checks `CreatorAccountId` as well. Ids are
 * matched case-insensitively, since a GUID's case is not part of its identity and the client
 * is not consistent about it.
 */
export async function ownedCustomAvatarItemIds(
	db: D1Database,
	accountId: number,
	ids: string[]
): Promise<Set<string>> {
	if (ids.length === 0) return new Set()
	const placeholders = ids.map((_, i) => `?${i + 2}`).join(', ')
	const { results } = await db
		.prepare(
			`SELECT custom_avatar_item_id FROM inventory_custom
			 WHERE account_id = ?1 AND lower(custom_avatar_item_id) IN (${placeholders})`
		)
		.bind(accountId, ...ids.map((id) => id.toLowerCase()))
		.all<{ custom_avatar_item_id: string }>()
	return new Set(results.map((r) => r.custom_avatar_item_id.toLowerCase()))
}

/**
 * Every custom avatar item a player owns, as the client's full `CustomAvatarItem` record:
 * what they BOUGHT (a row here) and what they CREATED (`CreatorAccountId`, drafts included —
 * it is their shirt whether or not it is published), oldest first by when it became theirs
 * (the purchase, or the item's creation). Read off `custom_avatar_item` itself so a deleted
 * item simply drops out rather than leaving an id that resolves to nothing, and so an item
 * both made and (somehow) bought appears once. `PurchaseInfo` is null: the owned list is
 * not a store page.
 */
export async function getOwnedCustomAvatarItems(
	db: D1Database,
	accountId: number
): Promise<CustomAvatarItem[]> {
	const { results } = await db
		.prepare(
			`SELECT i.data, coalesce(o.acquired_at, i.created_at) AS owned_at
			 FROM custom_avatar_item i
			 LEFT JOIN inventory_custom o
			   ON o.custom_avatar_item_id = i.custom_avatar_item_id AND o.account_id = ?1
			 WHERE o.account_id IS NOT NULL OR i.creator_account_id = ?1
			 ORDER BY owned_at, i.custom_avatar_item_id`
		)
		.bind(accountId)
		.all<{ data: string }>()
	return results.map((r) => parseCustomAvatarItem(r.data))
}
