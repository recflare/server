/**
 * Owned equipment on the shared `recflare` D1 database — the equipment skins a player
 * has bought from a storefront (e.g. a "Bow Skin (Dryad Summer)"). One row per
 * (account, item): like avatar items, owning a piece of equipment is boolean, so the
 * skin is granted at purchase time (`POST /api/storefronts/v2/buyItem`, when the
 * gift-drop carries an `EquipmentModificationGuid`) and read back by
 * `GET /api/equipment/v2/getUnlocked`.
 *
 * The item is keyed by the gift-drop's equipment guid, so re-buying the same skin
 * upserts rather than piling up duplicate rows (these drops are flagged `Unique`).
 * `data` is the rendered unlocked-equipment DTO, stored opaquely and served back
 * untouched.
 *
 * This worker (`econ`) owns the table and its migration — see apps/econ/migrations/
 * 0006_equipment.sql. The gift box the purchase also creates lives in a separate table
 * (@repo/domain's received_gift); ownership does not depend on the box being opened.
 */

/** Schema DDL (mirror of migrations 0006_equipment.sql) — also builds the table in tests. */
export const EQUIPMENT_SCHEMA_DDL: string[] = [
	`CREATE TABLE IF NOT EXISTS equipment (
		account_id INTEGER NOT NULL,
		equipment_modification_guid TEXT NOT NULL,
		data TEXT NOT NULL,
		PRIMARY KEY (account_id, equipment_modification_guid)
	)`,
]

/**
 * A rendered piece of unlocked equipment, as `/api/equipment/v2/getUnlocked` serves it.
 * `ModificationGuid` is the item's guid string and the row's key; `PrefabName` names the
 * base equipment the modification applies to.
 *
 * The names are UNPREFIXED here, unlike the gift-drop/gift-box shapes that carry the
 * same two values as `EquipmentPrefabName`/`EquipmentModificationGuid`. That's not an
 * inconsistency to tidy up: a drop is a flat record holding avatar, consumable and
 * equipment fields side by side, so it needs the prefix to disambiguate, while this
 * record is all equipment. Confirmed against the live endpoint, and the entries the
 * client sends back to `/api/equipment/v1/update` use the same unprefixed names.
 */
export interface Equipment extends Record<string, unknown> {
	ModificationGuid: string
	PrefabName: string
	FriendlyName: string
	Tooltip: string
	Rarity: number
	/** Always -1 (all platforms) — we don't gate equipment per platform. */
	PlatformMask: number
	/** Player-set favourite flag, toggled by `PUT`/`POST /api/equipment/v1/update`. */
	Favorited: boolean
}

/**
 * Grant a piece of equipment into a player's inventory. Upserts on
 * (account_id, equipment_modification_guid): owning equipment is boolean, so re-buying
 * it refreshes the stored DTO rather than adding a second copy. The refresh carries the
 * player's `Favorited` flag over, so re-buying doesn't quietly un-favourite the skin
 * (a row written before the flag existed reads as not favourited).
 */
export async function grantEquipment(
	db: D1Database,
	accountId: number,
	equipment: Equipment
): Promise<void> {
	await db
		.prepare(
			`INSERT INTO equipment (account_id, equipment_modification_guid, data) VALUES (?1, ?2, ?3)
			 ON CONFLICT (account_id, equipment_modification_guid) DO UPDATE SET
			   data = json_set(?3, '$.Favorited',
			     json(CASE WHEN json_extract(equipment.data, '$.Favorited') THEN 'true' ELSE 'false' END))`
		)
		.bind(accountId, equipment.ModificationGuid, JSON.stringify(equipment))
		.run()
}

/** One entry of the `PUT`/`POST /api/equipment/v1/update` body. */
export interface EquipmentFavoriteUpdate {
	ModificationGuid: string
	Favorited: boolean
}

/**
 * Apply the client's favourite toggles. Only the `Favorited` flag is writable — the
 * rest of the posted entry (PrefabName, Rarity, …) is the client echoing back what it
 * was served, and the reference server ignores it too.
 *
 * A guid the caller doesn't own matches no row and is silently dropped: equipment is
 * only ever granted by a purchase, so there is nothing to favourite until then (and an
 * insert here would let a client mint equipment for itself).
 */
export async function setEquipmentFavorited(
	db: D1Database,
	accountId: number,
	updates: EquipmentFavoriteUpdate[]
): Promise<void> {
	if (updates.length === 0) return
	const stmt = db.prepare(
		`UPDATE equipment SET data = json_set(data, '$.Favorited', json(?3))
		 WHERE account_id = ?1 AND equipment_modification_guid = ?2`
	)
	await db.batch(
		updates.map((u) => stmt.bind(accountId, u.ModificationGuid, u.Favorited ? 'true' : 'false'))
	)
}

/** Every piece of equipment a player owns, ordered by guid for a stable listing. */
export async function getEquipment(db: D1Database, accountId: number): Promise<Equipment[]> {
	const { results } = await db
		.prepare(
			'SELECT data FROM equipment WHERE account_id = ?1 ORDER BY equipment_modification_guid'
		)
		.bind(accountId)
		.all<{ data: string }>()
	return results.map((r) => JSON.parse(r.data) as Equipment)
}
