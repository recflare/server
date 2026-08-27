/**
 * Saved outfits on the shared `recflare` D1 database — the outfit slots a player
 * saves from the avatar screen.
 *
 * One row per (account, slot). The outfit itself is stored as the opaque JSON payload
 * the client posted: we never query inside it, and its fields (OutfitSelectionsV2,
 * FaceFeatures, …) are themselves JSON-in-a-string produced by the client's own
 * serializer. Round-tripping it verbatim is both the simplest and the safest thing —
 * re-encoding risks changing a payload the client has to parse back.
 *
 * The `econ` worker owns the schema/migration (apps/econ/migrations/0002_outfit.sql) and
 * serves the slot list (`GET /api/avatar/v3/saved`, `POST /api/avatar/v3/saved/set`). The
 * `api` worker reads and writes SLOT 0 through `/outfits/me` — the newer client treats
 * slot 0 as the outfit currently worn. Both import these helpers so the table name and
 * row shape live in one place.
 *
 * Note the two write paths store DIFFERENT payload shapes into the same column: econ's
 * saved-outfit slots hold the old flat PascalCase outfit, while `/outfits/me` holds the
 * newer `{ DataVersion, LegacyData, CustomizationSettings, … }` envelope. Each endpoint
 * serves back what it stored, so don't add a projection that assumes either one.
 */

/** Schema DDL (mirror of apps/econ/migrations/0002_outfit.sql) — also builds the table in tests. */
export const OUTFIT_SCHEMA_DDL: string[] = [
	`CREATE TABLE IF NOT EXISTS outfit (
		account_id INTEGER NOT NULL,
		set_id INTEGER NOT NULL,
		avatar TEXT NOT NULL,
		PRIMARY KEY (account_id, set_id)
	)`,
]

/**
 * A saved outfit, as the client posts it. `Slot` is the outfit slot it occupies (the
 * `set_id` column) — saving to a slot the player already used overwrites it, which is
 * exactly what the avatar screen's "save over this outfit" does. The rest of the
 * payload is stored and served back untouched.
 */
export interface Outfit extends Record<string, unknown> {
	Slot: number
}

/** The slot the newer client wears — what `/outfits/me` reads and writes. */
export const CURRENT_OUTFIT_SLOT = 0

/** Every outfit a player has saved, ordered by slot. */
export async function getOutfits(db: D1Database, accountId: number): Promise<Outfit[]> {
	const { results } = await db
		.prepare('SELECT avatar FROM outfit WHERE account_id = ?1 ORDER BY set_id')
		.bind(accountId)
		.all<{ avatar: string }>()
	return results.map((r) => JSON.parse(r.avatar) as Outfit)
}

/** One slot's outfit, or null when the player has never saved into it. */
export async function getOutfit(
	db: D1Database,
	accountId: number,
	slot: number
): Promise<Outfit | null> {
	const row = await db
		.prepare('SELECT avatar FROM outfit WHERE account_id = ?1 AND set_id = ?2')
		.bind(accountId, slot)
		.first<{ avatar: string }>()
	return row ? (JSON.parse(row.avatar) as Outfit) : null
}

/**
 * The most accounts one bulk read may name. D1 caps a prepared statement at 100 bound
 * parameters and `?1` is the slot, leaving 99 for the ids — so this is the whole query in
 * one round trip, with no chunking to get wrong. A room holds far fewer players than that,
 * which is what the caller asks about; the route rejects a longer list rather than silently
 * answering part of it.
 */
export const MAX_BULK_OUTFIT_ACCOUNTS = 99

/**
 * One slot's outfit for each of several accounts — the bulk read behind
 * `POST /outfits/bulk`, which the client uses to dress everyone in a room at once.
 *
 * Keyed by account id, and an account with nothing saved in that slot is simply ABSENT from
 * the map rather than present with a null: a map says "no outfit" by not having the key, and
 * the alternative would be inventing an outfit shape for a player who has never saved one.
 *
 * Ids are de-duplicated — the client sends a room's roster, which can repeat — and the
 * caller must already have held the list to {@link MAX_BULK_OUTFIT_ACCOUNTS}; more than that
 * overflows D1's parameter cap and fails the query outright. Each outfit is served exactly
 * as it was stored: see the note at the top of this file — slot 0 written through
 * `/outfits/me` is the newer envelope, while econ's saved-set writes are the old flat shape,
 * and neither is projected.
 */
export async function getOutfitsByAccounts(
	db: D1Database,
	accountIds: number[],
	slot: number
): Promise<Map<number, Outfit>> {
	const ids = [...new Set(accountIds)]
	if (ids.length === 0) return new Map()

	const placeholders = ids.map((_, n) => `?${n + 2}`).join(', ')
	const { results } = await db
		.prepare(
			`SELECT account_id, avatar FROM outfit WHERE set_id = ?1 AND account_id IN (${placeholders})`
		)
		.bind(slot, ...ids)
		.all<{ account_id: number; avatar: string }>()

	return new Map(results.map((row) => [row.account_id, JSON.parse(row.avatar) as Outfit]))
}

/**
 * Save an outfit into one of the player's slots, replacing whatever was there. The
 * upsert is keyed on (account_id, set_id), so re-saving a slot overwrites rather than
 * accumulating duplicate rows for it.
 */
export async function setOutfit(db: D1Database, accountId: number, outfit: Outfit): Promise<void> {
	await db
		.prepare(
			`INSERT INTO outfit (account_id, set_id, avatar) VALUES (?1, ?2, ?3)
			 ON CONFLICT (account_id, set_id) DO UPDATE SET avatar = ?3`
		)
		.bind(accountId, outfit.Slot, JSON.stringify(outfit))
		.run()
}
