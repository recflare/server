/**
 * Custom avatar items on the shared `recflare` D1 database: the player-designed shirts built
 * on a base catalog item, and the first-party items imported from the official service, which
 * are the same record with a set of built Unity assetbundles (`CurrentSaves`) in place of a
 * base item and a design PNG.
 *
 * A row is the client's `CustomAvatarItem` record verbatim, as JSON in `data` — the layout the
 * `invention`, `event`, `room`, `account` and `club` tables use — with the fields the queries
 * filter and sort on exposed as generated (virtual) columns. So a row IS the response, an
 * import is the exported record as-is, and a field the source adds later is served without a
 * migration. The flat one-column-per-field table this replaced (0015) could not hold a
 * first-party item at all: its base-item and filename columns were NOT NULL, and it had no home
 * for the saves.
 *
 * `CurrentSaves` stays EMBEDDED rather than in a child table: the client reads a save off its
 * item and picks one by `BodyType`, and nothing on this server looks a save up by its bare id
 * (the legacy-item lookup keys them by `AvatarItemDesc`). Room saves got their own table
 * because the client points at one by bare id; that does not apply here.
 *
 * The two uploads that accompany a player's creation (the design blob and the thumbnail PNG)
 * live in the shared image bucket (`recflare-img`, the `IMAGES` binding) under
 * `avatar-item/<date>/<id>-thumb.png` and `<id>-design.png`; `ThumbnailImageFilename` and
 * `DesignFilename` hold those bucket keys, which the `img` worker serves back by key. A
 * first-party item has both null and is rendered from its saves' assetbundles instead.
 *
 * The `api` worker owns the schema/migration (migrations/0015_custom_avatar_item.sql, rebuilt
 * as JSON by 0022_custom_avatar_item_json.sql, applied under its own `migrations_table`).
 */

import { COACH_ACCOUNT_ID } from './custom-avatar-items-load'

/** Schema DDL (mirror of migrations/0022_custom_avatar_item_json.sql). */
export const SCHEMA_DDL: string[] = [
	`CREATE TABLE IF NOT EXISTS custom_avatar_item (
		data TEXT NOT NULL,
		custom_avatar_item_id TEXT GENERATED ALWAYS AS (json_extract(data, '$.CustomAvatarItemId')) VIRTUAL,
		creator_account_id INTEGER GENERATED ALWAYS AS (json_extract(data, '$.CreatorAccountId')) VIRTUAL,
		accessibility INTEGER GENERATED ALWAYS AS (json_extract(data, '$.Accessibility')) VIRTUAL,
		outfit_type INTEGER GENERATED ALWAYS AS (json_extract(data, '$.OutfitType')) VIRTUAL,
		price INTEGER GENERATED ALWAYS AS (json_extract(data, '$.Price')) VIRTUAL,
		is_featured INTEGER GENERATED ALWAYS AS (json_extract(data, '$.IsFeatured')) VIRTUAL,
		created_at TEXT GENERATED ALWAYS AS (json_extract(data, '$.CreatedAt')) VIRTUAL,
		name_lower TEXT GENERATED ALWAYS AS (lower(coalesce(json_extract(data, '$.Name'), ''))) VIRTUAL,
		description_lower TEXT GENERATED ALWAYS AS (lower(coalesce(json_extract(data, '$.Description'), ''))) VIRTUAL
	)`,
	`CREATE UNIQUE INDEX IF NOT EXISTS idx_custom_avatar_item_id ON custom_avatar_item (custom_avatar_item_id)`,
	`CREATE INDEX IF NOT EXISTS idx_custom_avatar_item_creator ON custom_avatar_item (creator_account_id)`,
]

/**
 * One built version of a first-party item, as the client's PascalCase `CustomAvatarItemSave`:
 * a Unity assetbundle (`UnityAsset`, with `UnityAsset2` a second variant) the client downloads
 * to render the item, plus the thumbnail it shows in the store. An item carries one per
 * `BodyType` it was built for; the client picks the save matching the wearer's body.
 * `AdditionalConfiguration` is the client's own JSON-in-a-string document and is served as
 * stored. Not the camelCase `CustomAvatarItemSave` the legacy-item lookup documents — same
 * save, different casing and field set; keep the two apart.
 */
export interface CustomAvatarItemSave {
	CustomAvatarItemSaveId: number
	CustomAvatarItemId: string
	UnityAssetId: string
	BodyType: number
	OutfitType: number
	QAState: number
	CreatedAt: string
	ModifiedAt: string
	Description: string | null
	ThumbnailFileName: string
	AdditionalConfiguration: string
	UnityAsset: string
	UnityAssetHash: string
	UnityAsset2: string | null
	UnityAsset2Hash: string | null
}

/** A tag on an item (`{ TagType: 0, Value: "export" }` on the imported first-party items). */
export interface CustomAvatarItemTag {
	TagType: number
	Value: string
}

/**
 * The client's `CustomAvatarItem` record (PascalCase, as served). The four nullable fields are
 * null on a first-party item, which has no base item or design PNG: it is rendered from
 * `CurrentSaves` instead, which is empty on a player-made shirt.
 */
export interface CustomAvatarItem {
	CustomAvatarItemId: string
	CreatorAccountId: number
	Name: string
	Description: string
	Price: number
	Accessibility: number
	ForceCannotPublish: boolean
	IsFeatured: boolean
	IsRecRoomApproved: boolean
	BaseAvatarItemId: number | null
	BaseAvatarItemColor: string | null
	DesignFilename: string | null
	ThumbnailImageFilename: string | null
	CreatedAt: string
	ModifiedAt: string
	PreviewOrientation: number
	RankingContext: null
	OutfitType: number
	CurrentSaves: CustomAvatarItemSave[]
	Tags: CustomAvatarItemTag[]
	CustomBadgeMetadata: unknown
	RankedEntityId: string
	PurchaseInfo: null
}

/**
 * `RecRoom.Avatars.OutfitType.CustomShirt` — the slot of a custom shirt, the one kind of custom
 * avatar item the client can make. The enum (unobfuscated in the client) is banded by body
 * region: head None -1, Hat 0, Hair 2, Ear 3, Eye 10, Beard 20; torso Shoulder 100, Shirt 101,
 * Waist 102, Neck 103, TeamJersey 104, CustomShirt 105; arms Wrist 200, TeamWrist 203; legs
 * Legs 300, Feet 301; Roomie_Hat 500, Roomie_Waist 501, Roomie_Eye 502. It reaches the search
 * as a bare `IEnumerable<int>` — nothing on the wire ties 105 to the name.
 *
 * This is what the store's user-generated-content tab searches for, ALONE
 * (`GET /api/customAvatarItems/v1/search?outfitTypes=105&includeCoachItems=False`), so it is
 * what every created item must be filed under: the table's default of 0 (Hat) matched nothing,
 * and the tab sat empty over a full catalog. The imported first-party items carry their own
 * slot (a wing is 100, Shoulder) and are found by the storefront tab's dozen-slot query.
 *
 * Not to be confused with the search's `itemTypes`, a different 3-member enum (All -1, None 0,
 * Shirt 1) whose Shirt is 1, not 101 or 105. The client sends `itemTypes=-1` (All) alongside
 * `outfitTypes=105`; the outfit type is the filter, and the two are never cross-mapped.
 */
export const OUTFIT_TYPE_CUSTOM_SHIRT = 105

/** What `POST /api/customAvatarItems/v1` needs to create an item. */
export interface CreateCustomAvatarItemInput {
	/** The item's id. Chosen by the caller because the upload keys are derived from it. */
	customAvatarItemId: string
	creatorAccountId: number
	name: string
	description: string
	price: number
	baseAvatarItemId: number
	baseAvatarItemColor: string
	accessibility: number
	designFilename: string
	thumbnailImageFilename: string
	/** The slot the item is worn in; {@link OUTFIT_TYPE_CUSTOM_SHIRT} when left out. */
	outfitType?: number
}

interface Row {
	data: string
}

/**
 * What a stored record may lack and the response must carry: an imported record predates
 * some of these, and `PurchaseInfo` is a store-side projection (`econ` prices items), never
 * stored. Everything the record does carry wins over these.
 */
const DTO_DEFAULTS = {
	CurrentSaves: [] as CustomAvatarItemSave[],
	Tags: [] as CustomAvatarItemTag[],
	CustomBadgeMetadata: null,
	RankingContext: null,
	PurchaseInfo: null,
} as const

/**
 * A stored row's JSON as the client's record. Exported for the `econ` worker's owned-items
 * read, which joins `inventory_custom` to this table and must serve the same shape.
 */
export function parseCustomAvatarItem(data: string): CustomAvatarItem {
	const stored = JSON.parse(data) as CustomAvatarItem
	return { ...DTO_DEFAULTS, ...stored, RankingContext: null, PurchaseInfo: null }
}

function toDto(row: Row): CustomAvatarItem {
	return parseCustomAvatarItem(row.data)
}

/** Inserts a new player-made custom avatar item and returns it as the client's DTO. */
export async function createCustomAvatarItem(
	db: D1Database,
	input: CreateCustomAvatarItemInput,
	now: Date = new Date()
): Promise<CustomAvatarItem> {
	const ts = now.toISOString()
	const record: Omit<CustomAvatarItem, 'PurchaseInfo'> = {
		CustomAvatarItemId: input.customAvatarItemId,
		CreatorAccountId: input.creatorAccountId,
		Name: input.name,
		Description: input.description,
		Price: input.price,
		Accessibility: input.accessibility,
		ForceCannotPublish: false,
		IsFeatured: false,
		IsRecRoomApproved: false,
		BaseAvatarItemId: input.baseAvatarItemId,
		BaseAvatarItemColor: input.baseAvatarItemColor,
		DesignFilename: input.designFilename,
		ThumbnailImageFilename: input.thumbnailImageFilename,
		CreatedAt: ts,
		ModifiedAt: ts,
		PreviewOrientation: 0,
		OutfitType: input.outfitType ?? OUTFIT_TYPE_CUSTOM_SHIRT,
		CurrentSaves: [],
		Tags: [],
		CustomBadgeMetadata: null,
		RankedEntityId: input.customAvatarItemId,
		RankingContext: null,
	}
	const row = await db
		.prepare('INSERT INTO custom_avatar_item (data) VALUES (?1) RETURNING data')
		.bind(JSON.stringify(record))
		.first<Row>()
	if (!row) throw new Error('custom_avatar_item insert returned no row')
	return toDto(row)
}

/**
 * Stores a record as exported from the official service (the first-party items), verbatim,
 * replacing any row with the same `CustomAvatarItemId` so a re-import with corrections lands.
 * This is what the generated import migration does in SQL; it is here for tests and tooling.
 */
export async function importCustomAvatarItem(
	db: D1Database,
	record: Omit<CustomAvatarItem, 'PurchaseInfo'> & { PurchaseInfo?: unknown }
): Promise<CustomAvatarItem> {
	const { PurchaseInfo: _purchaseInfo, ...stored } = record
	const row = await db
		.prepare(
			`INSERT INTO custom_avatar_item (data) VALUES (?1)
			 ON CONFLICT(custom_avatar_item_id) DO UPDATE SET data = excluded.data
			 RETURNING data`
		)
		.bind(JSON.stringify(stored))
		.first<Row>()
	if (!row) throw new Error('custom_avatar_item import returned no row')
	return toDto(row)
}

/**
 * The `ItemType` that names a custom avatar item in a UGC-purchasable reference
 * (`POST /api/ugcPurchasables/v1/items/bulk`'s `Ids[].itemType`).
 */
export const UGC_ITEM_TYPE_CUSTOM_AVATAR_ITEM = 3

/** A custom avatar item as the client's `UgcPurchasableItem` (the store-facing view). */
export interface UgcPurchasableItem {
	ItemType: number
	ItemId: string
	Name: string
	Description: string
	ImageName: string
	RoomId: number
	Price: number
	PurchaseCurrencyId: string | null
	CreatedAt: string
	ModifiedAt: string
}

/**
 * The store-facing projection of a custom avatar item. `RoomId` is echoed from the
 * request — the item table has no room; what the client wants it for is still unknown.
 * `PurchaseCurrencyId` is null (the client's field is nullable) until a currency exists.
 * `ImageName` is the item's own thumbnail for a player-made shirt; a first-party item has
 * none at the item level, so the first save's thumbnail stands in.
 */
export function toUgcPurchasable(item: CustomAvatarItem, roomId: number): UgcPurchasableItem {
	return {
		ItemType: UGC_ITEM_TYPE_CUSTOM_AVATAR_ITEM,
		ItemId: item.CustomAvatarItemId,
		Name: item.Name,
		Description: item.Description,
		ImageName: item.ThumbnailImageFilename ?? item.CurrentSaves[0]?.ThumbnailFileName ?? '',
		RoomId: roomId,
		Price: item.Price,
		PurchaseCurrencyId: null,
		CreatedAt: item.CreatedAt,
		ModifiedAt: item.ModifiedAt,
	}
}

/** Fetches the items with these ids, in the order asked; unknown ids are skipped. */
export async function getCustomAvatarItems(
	db: D1Database,
	ids: string[]
): Promise<CustomAvatarItem[]> {
	if (ids.length === 0) return []
	const placeholders = ids.map((_, i) => `?${i + 1}`).join(', ')
	const { results } = await db
		.prepare(`SELECT data FROM custom_avatar_item WHERE custom_avatar_item_id IN (${placeholders})`)
		.bind(...ids)
		.all<Row>()
	const byId = new Map(results.map(toDto).map((item) => [item.CustomAvatarItemId, item]))
	return ids.flatMap((id) => byId.get(id) ?? [])
}

/**
 * Where the QUEST builds of the assetbundles live, relative to the PC ones. An assetbundle is
 * built per Unity target, and a save names its bundle by bare filename for the client to fetch
 * from the cdn's `/avatar/`; the Android build of the same bundle keeps the same filename one
 * folder down, so a caller asking for the Quest target is served `quest/<name>.assetbundle` and asks the cdn for
 * `/avatar/quest/<name>.assetbundle`.
 */
export const QUEST_ASSET_PREFIX = 'quest/'

/**
 * The `unityAssetTarget` a Quest asks with — the Unity build target the caller wants its
 * assetbundles built for, which the client names on every custom-avatar-item read. 0 is PC
 * (Windows), and is what the saves' bare names are; 2 has been SEEN from the Android/Oculus
 * client and is read as that. The rest of the enum has not been observed.
 */
export const UNITY_ASSET_TARGET_QUEST = 2

/**
 * Whether a request's `unityAssetTarget` asks for the Quest builds. Anything else — 0, a
 * target not seen yet, or none at all — is served the PC names, which is what was served
 * before targets were read.
 */
export function isQuestAssetTarget(target: string | null | undefined): boolean {
	return target?.trim() === String(UNITY_ASSET_TARGET_QUEST)
}

/**
 * An assetbundle name under {@link QUEST_ASSET_PREFIX}. Only `.assetbundle` names are touched,
 * and one that already carries the prefix is left alone; null (an absent `UnityAsset2`) is
 * returned as it came.
 */
function questAsset<T extends string | null>(name: T): T | string {
	if (name === null || !name.endsWith('.assetbundle')) return name
	return name.startsWith(QUEST_ASSET_PREFIX) ? name : QUEST_ASSET_PREFIX + name
}

/**
 * An item as a caller asking for the Quest target is served it: every save's `UnityAsset`/`UnityAsset2` pointed at
 * the Quest build (see {@link QUEST_ASSET_PREFIX}). Per-response, never stored — the row keeps
 * the bare names, which are what every other target is served. The hashes are left as
 * stored. A player-made shirt has no saves and comes back unchanged.
 */
export function toQuestCustomAvatarItem(item: CustomAvatarItem): CustomAvatarItem {
	return {
		...item,
		CurrentSaves: item.CurrentSaves.map((save) => ({
			...save,
			UnityAsset: questAsset(save.UnityAsset),
			UnityAsset2: questAsset(save.UnityAsset2),
		})),
	}
}

/**
 * The featured feed (`GET /api/customAvatarItems/v1/featured`): items flagged
 * `is_featured` that are also published — `Accessibility` 0 is the unpublished state, so
 * those are excluded even when flagged. Newest first. Nothing sets the flag yet, so the
 * feed is empty until an operator writes `is_featured = 1`.
 */
export async function listFeaturedCustomAvatarItems(
	db: D1Database,
	limit = 50
): Promise<CustomAvatarItem[]> {
	const { results } = await db
		.prepare(
			`SELECT data FROM custom_avatar_item WHERE is_featured = 1 AND accessibility != 0
			 ORDER BY created_at DESC, custom_avatar_item_id LIMIT ?1`
		)
		.bind(limit)
		.all<Row>()
	return results.map(toDto)
}

/**
 * The "hot" (trending) feed (`GET /api/customAvatarItems/v1/hot`): every PUBLISHED item —
 * `Accessibility` 0 is the unpublished state and is the only thing held back. Newest
 * first, standing in for a trend ranking there is nothing to compute one from yet (no
 * purchase or wear counts are recorded).
 */
export async function listHotCustomAvatarItems(
	db: D1Database,
	limit = 50
): Promise<CustomAvatarItem[]> {
	const { results } = await db
		.prepare(
			`SELECT data FROM custom_avatar_item WHERE accessibility != 0
			 ORDER BY created_at DESC, custom_avatar_item_id LIMIT ?1`
		)
		.bind(limit)
		.all<Row>()
	return results.map(toDto)
}

/**
 * The "Coach" system account — this server's stock content is authored by it, the same id the
 * `econ` worker attributes a self-buy or an anonymous gift to. Lives in the loader module so
 * the CLI can name it without Workers types; re-exported here for the worker-side callers.
 */
export { COACH_ACCOUNT_ID }

/** What `GET /api/customAvatarItems/v1/search` narrows the catalog by. */
export interface CustomAvatarItemSearch {
	/** Free text, matched against an item's NAME or its DESCRIPTION. Blank means no filter. */
	searchQuery?: string
	/**
	 * `OutfitType`s to include. EMPTY means no filter rather than no results: the client sends
	 * the full set of types it can render, so an absent parameter is "everything", not "nothing".
	 */
	outfitTypes?: number[]
	/**
	 * WHICH SIDE of the catalog to serve, not whether to add one to the other: `true` is the
	 * Coach's stock content ONLY, `false` is player-made content ONLY, and undefined is both.
	 * The client browses the store's two tabs with this — its storefront call says `True`
	 * and its user-generated-content call says `False` — so "include" reads as a toggle
	 * between them, never as a superset.
	 */
	includeCoachItems?: boolean
	/** Lowest price to include, inclusive. */
	minPrice?: number
	/** Highest price to include, inclusive. */
	maxPrice?: number
	/** Rows to skip, for paging. */
	skip?: number
	/** Rows to return. Capped at {@link SEARCH_MAX_TAKE}. */
	take?: number
}

/** The most rows one search returns, whatever `take` asks for. The client asks for 100. */
export const SEARCH_MAX_TAKE = 200

/**
 * The store's item search (`GET /api/customAvatarItems/v1/search`), newest first.
 *
 * PUBLISHED items only — `Accessibility` 0 is the unpublished state, and this is the browse
 * surface everyone shares, so an unpublished item must not appear here even to its creator (who
 * has `fromCreator` for that).
 *
 * `searchQuery` matches an item's NAME or its DESCRIPTION, case-insensitively, as a substring,
 * or its `CustomAvatarItemId` whole. Both sides are lowered rather than relying on `LIKE`, which
 * folds case for ASCII only and would miss half of what players type. `%` and `_` in the needle
 * are escaped, so searching for a literal one finds it instead of matching everything.
 *
 * `outfitTypes` is a WHITELIST when non-empty and no filter when empty, which is the opposite of
 * how an empty IN () clause reads in SQL: the client sends every type it can render, so treating
 * an absent parameter as "match nothing" would empty the store.
 *
 * `includeCoachItems` SPLITS the catalog by author rather than widening it: `true` is the Coach's
 * items alone, `false` everyone else's alone, absent both. The client's storefront tab sends
 * `True` and its user-generated-content tab sends `False`, and the two must not overlap — read
 * as "stock plus players'", the storefront would show every player's item too.
 *
 * Ordered by recency because there is nothing else to order by — no purchase counts, no wear
 * counts, no ratings are recorded — which is the same stand-in the `hot` feed makes. The
 * `custom_avatar_item_id` tiebreak is what makes paging stable: without it, two items sharing a
 * `created_at` can swap places between pages and one is served twice while the other is missed.
 */
export async function searchCustomAvatarItems(
	db: D1Database,
	search: CustomAvatarItemSearch = {}
): Promise<CustomAvatarItem[]> {
	const take = Math.min(Math.max(search.take ?? 50, 0), SEARCH_MAX_TAKE)
	const skip = Math.max(search.skip ?? 0, 0)
	if (take === 0) return []

	const where = ['accessibility != 0']
	const binds: Array<number | string> = []
	/** Bind a value and get its placeholder, so the numbering can't drift as clauses are added. */
	const bind = (value: number | string): string => `?${binds.push(value)}`

	const needle = search.searchQuery?.trim() ?? ''
	if (needle !== '') {
		// Escaped so a needle of LIKE metacharacters matches them literally rather than everything.
		const escaped = needle.toLowerCase().replace(/[\\%_]/g, (ch) => `\\${ch}`)
		const pattern = bind(`%${escaped}%`)
		// `name_lower`/`description_lower` are generated columns, lowered once at the row rather
		// than per query. An id typed in whole finds its item too, since the client searches by
		// `CustomAvatarItemId` as well as by text.
		const exact = bind(needle.toLowerCase())
		where.push(
			`(name_lower LIKE ${pattern} ESCAPE '\\' OR description_lower LIKE ${pattern} ESCAPE '\\'` +
				` OR lower(custom_avatar_item_id) = ${exact})`
		)
	}

	const outfitTypes = search.outfitTypes ?? []
	if (outfitTypes.length > 0) {
		where.push(`outfit_type IN (${outfitTypes.map((t) => bind(t)).join(', ')})`)
	}
	if (search.includeCoachItems === true) {
		where.push(`creator_account_id = ${bind(COACH_ACCOUNT_ID)}`)
	} else if (search.includeCoachItems === false) {
		where.push(`creator_account_id != ${bind(COACH_ACCOUNT_ID)}`)
	}
	if (search.minPrice !== undefined) where.push(`price >= ${bind(search.minPrice)}`)
	if (search.maxPrice !== undefined) where.push(`price <= ${bind(search.maxPrice)}`)

	const limit = bind(take)
	const offset = bind(skip)
	const { results } = await db
		.prepare(
			`SELECT data FROM custom_avatar_item WHERE ${where.join(' AND ')}
			 ORDER BY created_at DESC, custom_avatar_item_id
			 LIMIT ${limit} OFFSET ${offset}`
		)
		.bind(...binds)
		.all<Row>()
	return results.map(toDto)
}

/**
 * What an account has authored (`GET /api/customAvatarItems/v2/fromCreator/:id`), newest
 * first, with the total for the client's paginated envelope. `includeUnpublished` is for
 * the creator looking at their own shelf: it adds the `Accessibility` 0 items everyone
 * else is not shown. Paging is not applied yet (the client sends none), so `TotalResults`
 * always equals the list length.
 */
export async function listCustomAvatarItemsByCreator(
	db: D1Database,
	creatorAccountId: number,
	includeUnpublished = false
): Promise<{ Results: CustomAvatarItem[]; TotalResults: number }> {
	const { results } = await db
		.prepare(
			`SELECT data FROM custom_avatar_item
			 WHERE creator_account_id = ?1 AND (accessibility != 0 OR ?2)
			 ORDER BY created_at DESC, custom_avatar_item_id`
		)
		.bind(creatorAccountId, includeUnpublished ? 1 : 0)
		.all<Row>()
	const items = results.map(toDto)
	return { Results: items, TotalResults: items.length }
}

/** The editable fields of `PUT /api/customAvatarItems/v1/:id`; null/undefined = leave alone. */
export interface UpdateCustomAvatarItemInput {
	name?: string | null
	description?: string | null
	price?: number | null
	accessibility?: number | null
}

/**
 * Applies a partial edit to one item in place with `json_set`, bumping `ModifiedAt`. Fields
 * the caller leaves null keep their value (the client sends every field, nulling the
 * untouched ones).
 * Returns the updated item, or null when no row has that id.
 */
export async function updateCustomAvatarItem(
	db: D1Database,
	id: string,
	patch: UpdateCustomAvatarItemInput,
	now: Date = new Date()
): Promise<CustomAvatarItem | null> {
	const row = await db
		.prepare(
			`UPDATE custom_avatar_item SET data = json_set(data,
				'$.Name', coalesce(?2, json_extract(data, '$.Name')),
				'$.Description', coalesce(?3, json_extract(data, '$.Description')),
				'$.Price', coalesce(?4, json_extract(data, '$.Price')),
				'$.Accessibility', coalesce(?5, json_extract(data, '$.Accessibility')),
				'$.ModifiedAt', ?6)
			 WHERE custom_avatar_item_id = ?1
			 RETURNING data`
		)
		.bind(
			id,
			patch.name ?? null,
			patch.description ?? null,
			patch.price ?? null,
			patch.accessibility ?? null,
			now.toISOString()
		)
		.first<Row>()
	return row ? toDto(row) : null
}

/** Deletes one item's row. Returns the deleted item, or null when no row had that id. */
export async function deleteCustomAvatarItem(
	db: D1Database,
	id: string
): Promise<CustomAvatarItem | null> {
	const row = await db
		.prepare('DELETE FROM custom_avatar_item WHERE custom_avatar_item_id = ?1 RETURNING data')
		.bind(id)
		.first<Row>()
	return row ? toDto(row) : null
}

/** Fetches one item by id, or null. */
export async function getCustomAvatarItem(
	db: D1Database,
	id: string
): Promise<CustomAvatarItem | null> {
	const row = await db
		.prepare('SELECT data FROM custom_avatar_item WHERE custom_avatar_item_id = ?1')
		.bind(id)
		.first<Row>()
	return row ? toDto(row) : null
}
