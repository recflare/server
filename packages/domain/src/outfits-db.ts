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

// ---- Serving an outfit to OTHER players -------------------------------------------------
//
// An outfit is stored exactly as its owner posted it, and `/outfits/me` hands it straight
// back to them. But the bulk read (`POST /outfits/bulk`) is how everyone ELSE's client
// dresses a player, and nothing on the way in checks that the player may wear what they
// saved — an edited save, or a client that skips the store, puts an unbought item on an
// avatar everyone in the room then sees. So the bulk read serves each outfit with the
// selections the wearer does not own taken OUT, and the owner keeps seeing their own
// save untouched.
//
// What a selection names, in each of the forms the two write paths store:
//
// - A legacy descriptor list (`LegacyData.SelectionsV1` in the newer envelope, the flat
//   `OutfitSelections` in econ's) is `;`-delimited, one entry per worn item, each
//   `<AvatarItemDesc>,<extra>,<bodyPart>` — e.g. `40528de7-…,51ef8d39-…,0b2395e1-…,,0`
//   and `5cd08cfb-…,,1`. The `AvatarItemDesc` is `<baseAsset>,<color>,<texture>,` with its
//   empty trailing fields dropped, which is why the entries differ in length.
// - A v2 selection list (`LegacyData.SelectionsV2`, `OutfitSelectionsV2`) is JSON in a
//   string, `{ selections: [ { PrefabGuid, CombinationGuid, BodyPart, UgcOutfitData? } ] }`,
//   where `PrefabGuid` is the base asset and a custom shirt rides in
//   `UgcOutfitData.CustomAvatarItemId`.
// - `CustomizationSettings` is the newer client's own structured document, also JSON in a
//   string. Only its header (`AvatarVersion`, `AvatarBodyType`) has been observed; whatever
//   selections it carries are assumed to be the v2 shape above, found wherever they sit.
// - `Selections` and `CustomAvatarItems` are plain arrays (observed empty), walked the same
//   way.
//
// Ownership is decided on the BASE ASSET — the first field of the descriptor, which is the
// one identifier every form carries (`PrefabGuid` is nothing else) and the field the client
// decides renderability on (see `baseAsset` in econ's catalog). A player owns a base asset
// when any `inventory` row of theirs starts with it, or when it is in the free default
// catalog (what econ's `GET /api/avatar/v4/items` hands every player) or is one of the base
// items custom clothing is built on. That is coarser than a purchase — a store sells the
// same base in several colours as separate items, and owning one colour lets the others
// through — because the v2 forms record no colour to check, and a rule the three forms
// disagree on would dress a player differently depending on which one the client reads.
// A custom item (`CustomAvatarItemId`) is owned when bought (`inventory_custom`) or made
// (`custom_avatar_item.creator_account_id`), the same pair econ's owned list serves.
//
// An outfit that loses nothing is returned as the very object it came in as, string fields
// byte-for-byte: the JSON-in-a-string documents are re-encoded only when a selection inside
// them was removed, keeping the verbatim round trip the note at the top of this file asks
// for in the common case.

/** What one player may wear: base assets and custom item ids, each lower-cased. */
export interface OwnedOutfitItems {
	bases: Set<string>
	customItemIds: Set<string>
}

/**
 * The base asset of an `AvatarItemDesc` or of a legacy selection entry: the first
 * comma-separated field, lower-cased. The same first field whichever form of the item it is
 * read from — a catalog descriptor (`<base>,<color>,<texture>,`), an inventory key, or a
 * worn selection (`<base>,…,<bodyPart>`).
 */
export function outfitItemBase(desc: string): string {
	return (desc.split(',')[0] ?? '').trim().toLowerCase()
}

/** A JSON object, as the walkers below see one. */
type JsonObject = Record<string, unknown>

function isObject(value: unknown): value is JsonObject {
	return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/**
 * Whether one v2-style selection object names only owned things. An object with neither a
 * `PrefabGuid` nor a `CustomAvatarItemId` is not a selection and is always kept.
 */
function selectionOwned(selection: JsonObject, owned: OwnedOutfitItems): boolean {
	const prefab = selection.PrefabGuid
	if (typeof prefab === 'string' && prefab !== '' && !owned.bases.has(outfitItemBase(prefab))) {
		return false
	}
	const ugc = selection.UgcOutfitData
	const customIds = [
		selection.CustomAvatarItemId,
		isObject(ugc) ? ugc.CustomAvatarItemId : undefined,
	]
	for (const id of customIds) {
		if (typeof id === 'string' && id !== '' && !owned.customItemIds.has(id.toLowerCase())) {
			return false
		}
	}
	return true
}

/**
 * Walk a parsed JSON value and drop, from every array in it, the selection objects the
 * player does not own. Returns the (possibly new) value and whether anything was dropped;
 * an untouched subtree is returned as the same reference.
 */
function pruneSelections(value: unknown, owned: OwnedOutfitItems): [unknown, boolean] {
	if (Array.isArray(value)) {
		let changed = false
		const kept: unknown[] = []
		for (const entry of value) {
			if (isObject(entry) && !selectionOwned(entry, owned)) {
				changed = true
				continue
			}
			const [pruned, entryChanged] = pruneSelections(entry, owned)
			changed ||= entryChanged
			kept.push(pruned)
		}
		return changed ? [kept, true] : [value, false]
	}
	if (isObject(value)) {
		let changed = false
		const out: JsonObject = {}
		for (const [key, entry] of Object.entries(value)) {
			const [pruned, entryChanged] = pruneSelections(entry, owned)
			changed ||= entryChanged
			out[key] = pruned
		}
		return changed ? [out, true] : [value, false]
	}
	return [value, false]
}

/**
 * The legacy `;`-delimited descriptor list with the unowned entries removed. Returned as
 * the same string when nothing was removed; a string that is not a list (empty, or
 * carrying no `;`-separated descriptors) is returned as it is.
 */
function pruneLegacySelections(list: string, owned: OwnedOutfitItems): string {
	const entries = list.split(';')
	const kept = entries.filter((entry) => entry === '' || owned.bases.has(outfitItemBase(entry)))
	return kept.length === entries.length ? list : kept.join(';')
}

/**
 * A JSON-in-a-string document with the unowned selections removed. The original string is
 * returned when nothing was removed — or when it does not parse, which is the client's own
 * document to make sense of, not this server's.
 */
function pruneJsonDocument(document: string, owned: OwnedOutfitItems): string {
	let parsed: unknown
	try {
		parsed = JSON.parse(document)
	} catch {
		return document
	}
	const [pruned, changed] = pruneSelections(parsed, owned)
	return changed ? JSON.stringify(pruned) : document
}

/**
 * An outfit as other players should see it: every selection naming something the wearer
 * does not own is removed from each form the outfit carries (see the section note above).
 * The outfit is returned as the same object when it loses nothing.
 */
export function restrictOutfitToOwned(outfit: Outfit, owned: OwnedOutfitItems): Outfit {
	let changed = false
	const out: JsonObject = { ...outfit }

	const pruneString = (
		target: JsonObject,
		key: string,
		prune: (value: string, owned: OwnedOutfitItems) => string
	) => {
		const value = target[key]
		if (typeof value !== 'string') return
		const pruned = prune(value, owned)
		if (pruned !== value) {
			target[key] = pruned
			changed = true
		}
	}
	const pruneArray = (target: JsonObject, key: string) => {
		const [pruned, arrayChanged] = pruneSelections(target[key], owned)
		if (arrayChanged) {
			target[key] = pruned
			changed = true
		}
	}

	// The newer envelope's legacy block, copied so the stored object is not written to.
	if (isObject(outfit.LegacyData)) {
		const legacy: JsonObject = { ...outfit.LegacyData }
		pruneString(legacy, 'SelectionsV1', pruneLegacySelections)
		pruneString(legacy, 'SelectionsV2', pruneJsonDocument)
		out.LegacyData = legacy
	}
	pruneString(out, 'CustomizationSettings', pruneJsonDocument)
	pruneArray(out, 'Selections')

	// Econ's flat shape.
	pruneString(out, 'OutfitSelections', pruneLegacySelections)
	pruneString(out, 'OutfitSelectionsV2', pruneJsonDocument)
	pruneArray(out, 'CustomAvatarItems')

	return changed ? (out as Outfit) : outfit
}

/**
 * What each of several players may wear — the ownership behind
 * {@link restrictOutfitToOwned}, read for the bulk outfit read's whole roster in one
 * round trip. `freeBases` are the base assets every player has (the default catalog and
 * the custom-clothing base items), folded into each player's set.
 *
 * Three reads batched: bought items (`inventory`, keyed by `AvatarItemDesc`, reduced to the
 * base asset), bought custom items (`inventory_custom`) and made custom items
 * (`custom_avatar_item` by creator) — the two sources econ's owned-items list joins. Ids are
 * de-duplicated and the caller must already have held the list to
 * {@link MAX_BULK_OUTFIT_ACCOUNTS}, D1's parameter cap. Every account asked for gets an
 * entry, if only the free set.
 */
export async function getOwnedOutfitItemsByAccounts(
	db: D1Database,
	accountIds: number[],
	freeBases: ReadonlySet<string>
): Promise<Map<number, OwnedOutfitItems>> {
	const ids = [...new Set(accountIds)]
	const owned = new Map<number, OwnedOutfitItems>()
	for (const id of ids) owned.set(id, { bases: new Set(freeBases), customItemIds: new Set() })
	if (ids.length === 0) return owned

	const placeholders = ids.map((_, n) => `?${n + 1}`).join(', ')
	const [items, bought, made] = await db.batch<{ account_id: number; value: string }>([
		db
			.prepare(
				`SELECT account_id, avatar_item_desc AS value FROM inventory WHERE account_id IN (${placeholders})`
			)
			.bind(...ids),
		db
			.prepare(
				`SELECT account_id, custom_avatar_item_id AS value FROM inventory_custom WHERE account_id IN (${placeholders})`
			)
			.bind(...ids),
		db
			.prepare(
				`SELECT creator_account_id AS account_id, custom_avatar_item_id AS value
				 FROM custom_avatar_item WHERE creator_account_id IN (${placeholders})`
			)
			.bind(...ids),
	])

	for (const row of items.results) owned.get(row.account_id)?.bases.add(outfitItemBase(row.value))
	for (const row of [...bought.results, ...made.results]) {
		if (typeof row.value === 'string') {
			owned.get(row.account_id)?.customItemIds.add(row.value.toLowerCase())
		}
	}
	return owned
}
