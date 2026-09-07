/**
 * Turning the captured JSON into `catalog` rows — the loader half of the item catalog, used by
 * `runx catalog load` (in @repo/tools) rather than by the worker.
 *
 * Separate from `catalog-db.ts` for one reason: that module types its queries with
 * `D1Database`, a Workers type, and the loader runs in a plain Node CLI that has no such
 * types. Everything here is pure data mapping with no imports, so both sides can use it.
 * `catalog-db.ts` re-exports all of it, so nothing outside these two files needs to know.
 *
 * The mapping lives beside the schema it fills (rather than in the CLI) so that a column added
 * to the table and a column added to the loader cannot drift apart — a test pins that they
 * agree, and the loader renders values POSITIONALLY, so a mismatch is a silent mis-load.
 */

/** What a catalog row IS — the discriminator, and what says which id `item_key` holds. */
export const CatalogKind = {
	/** An avatar item: something worn. Its `item_key` is the `AvatarItemDesc`. */
	AvatarItem: 'avatar_item',
	/** An equipment skin: a re-skin of a held prefab. Its `item_key` is the `ModificationGuid`. */
	Skin: 'skin',
} as const

export type CatalogKindValue = (typeof CatalogKind)[keyof typeof CatalogKind]

/**
 * The capture's avatar-item record (`static/db/avatar-items.json`).
 *
 * Everything from `TagList` down is absent on some rows — the 22 permanent hair dyes carry
 * only the first six fields — so those are optional rather than nullable. The distinction
 * matters: a missing key and a null value both land as NULL, but only one of them is a field
 * the capture actually recorded.
 */
export interface AvatarItemCapture {
	AvatarItemDesc: string
	AvatarItemType: number
	PlatformMask: number
	FriendlyName: string
	Tooltip: string | null
	Rarity: number
	TagList?: string | null
	AvatarItemId?: number
	IsBaseAvatarItem?: boolean
	CreatedAt?: string
	ThumbnailImage?: string | null
}

/** The capture's skin record (`static/db/skins.json`). Every field is present on every row. */
export interface SkinCapture {
	PrefabName: string
	ModificationGuid: string
	UnlockedLevel: number
	Favorited: boolean
	PlatformMask: number
	FriendlyName: string
	Tooltip: string | null
	Rarity: number
	ThumbnailImage: string | null
}

/**
 * The first `catalog_id` a load hands out.
 *
 * The catalog needs ids that cannot be confused with any captured storefront's, because a
 * generated storefront lists a row under its `catalog_id` DIRECTLY — one number, no second
 * numbering and no arithmetic between them. Every real captured `PurchasableItemId` is 2764 or
 * below (one sf3 outlier at 20756767 aside), so numbering from 1 would have collided with sf3's
 * own head-on and the same id would mean two different items depending on which storefront the
 * client read it from. Starting at 10000 puts the whole catalog somewhere nothing else uses.
 */
export const CATALOG_ID_BASE = 10_000

/** The columns a load writes, in the order {@link toCatalogInsertRow} returns values. */
export const CATALOG_INSERT_COLUMNS = [
	'item_key',
	'catalog_id',
	'kind',
	'friendly_name',
	'tooltip',
	'rarity',
	'platform_mask',
	'thumbnail_image',
	'avatar_item_type',
	'avatar_item_id',
	'is_base_avatar_item',
	'tag_list',
	'created_at',
	'prefab_name',
	'unlocked_level',
] as const

/** A value bound into a load's INSERT. `undefined` is a key the capture omitted. */
export type CatalogValue = string | number | boolean | null | undefined

/** One row of a load, plus enough to name it in a collision report. */
export interface CatalogLoadRow {
	key: string
	/** Its `catalog_id`: 1-based position in this load, also present inside `values`. */
	id: number
	label: string
	values: CatalogValue[]
}

/** A duplicate `item_key` in the captures: which key, which row won, which was dropped. */
export interface CatalogCollision {
	key: string
	kept: string
	dropped: string
}

function avatarItemRow(i: AvatarItemCapture): Omit<CatalogLoadRow, 'id'> {
	return {
		key: i.AvatarItemDesc,
		label: `${i.FriendlyName} (avatar item)`,
		values: [
			i.AvatarItemDesc,
			// Filled in by buildCatalogLoad once the de-duplicated order is known.
			null,
			CatalogKind.AvatarItem,
			i.FriendlyName,
			i.Tooltip,
			i.Rarity,
			i.PlatformMask,
			i.ThumbnailImage,
			i.AvatarItemType,
			i.AvatarItemId,
			i.IsBaseAvatarItem ?? false,
			i.TagList,
			i.CreatedAt,
			null,
			null,
		],
	}
}

function skinRow(s: SkinCapture): Omit<CatalogLoadRow, 'id'> {
	return {
		key: s.ModificationGuid,
		label: `${s.FriendlyName} (skin, ${s.PrefabName})`,
		values: [
			s.ModificationGuid,
			// Filled in by buildCatalogLoad once the de-duplicated order is known.
			null,
			CatalogKind.Skin,
			s.FriendlyName,
			s.Tooltip,
			s.Rarity,
			s.PlatformMask,
			s.ThumbnailImage,
			null,
			null,
			null,
			null,
			null,
			s.PrefabName,
			s.UnlockedLevel,
		],
	}
}

/**
 * Turn both captures into the rows a load writes, de-duplicated on `item_key`.
 *
 * `item_key` is unique across BOTH kinds, so a repeat is a defect in the capture rather than
 * something the table should model. First occurrence wins and the rest are RETURNED rather
 * than dropped on the floor: the caller has to report them, because a collision that vanishes
 * quietly is the exact failure the single key exists to prevent.
 *
 * Each surviving row is also numbered — `catalog_id`, from {@link CATALOG_ID_BASE} upward in
 * capture order, the small numeric handle the site uses in place of a comma-laden desc or a
 * guid, and the `PurchasableItemId` a generated storefront lists it under. It is assigned here
 * rather than by the database so the caller can render it into the same INSERT, and it is a
 * LOAD-ORDER surrogate: the next load renumbers, and nothing may store it.
 */
export function buildCatalogLoad(
	avatarItems: AvatarItemCapture[],
	skins: SkinCapture[]
): { rows: CatalogLoadRow[]; collisions: CatalogCollision[] } {
	const seen = new Map<string, string>()
	const rows: CatalogLoadRow[] = []
	const collisions: CatalogCollision[] = []
	const idAt = CATALOG_INSERT_COLUMNS.indexOf('catalog_id')
	for (const row of [...avatarItems.map(avatarItemRow), ...skins.map(skinRow)]) {
		const kept = seen.get(row.key)
		if (kept !== undefined) {
			collisions.push({ key: row.key, kept, dropped: row.label })
			continue
		}
		seen.set(row.key, row.label)
		// Numbered AFTER de-duplication and from {@link CATALOG_ID_BASE}, so a load's ids are
		// exactly BASE..BASE+rows.length-1 with no gaps — a dropped duplicate must not burn a
		// number.
		const id = CATALOG_ID_BASE + rows.length
		row.values[idAt] = id
		rows.push({ ...row, id })
	}
	return { rows, collisions }
}

/**
 * Rarities that are NOT sold, and so never appear in a generated storefront.
 *
 * `-1` is the developer/unreleased tier. The items carrying it stay in the `catalog` table —
 * that is a record of what EXISTS — but a storefront is a record of what is for SALE, and an
 * item listed in one can be bought: `findStoreItem` resolves a purchase against the catalog
 * file itself, so listing them at any price would put them on sale.
 *
 * Lives here rather than in the storefront generator because two things need the same answer:
 * the generator, which omits them, and anything that hands the client a PurchasableItem id,
 * which must not name one the storefront never listed. A client asked to resolve an id no
 * storefront sells renders nothing, indistinguishably from an id it failed to parse.
 */
export const UNSELLABLE_RARITIES: readonly number[] = [-1]

/** Whether an item of this rarity may appear in a storefront. */
export const isSellableRarity = (rarity: number): boolean => !UNSELLABLE_RARITIES.includes(rarity)

/**
 * What a catalog item costs, by rarity — the pricing every surface that sells a catalog row
 * must agree on.
 *
 * Shared rather than living in the storefront generator alone because a purchase is CHECKED
 * against the price the client was shown: `priceCheck` compares the posted `RequestedPrice`
 * with the catalog's, and a server that priced a buy differently from the file it listed would
 * refuse every purchase as "Price has changed". One table, both sides.
 *
 * The tiers 0/10/30/50 were specified; 20 sits between its neighbours at 700 (sf3's own
 * rarity-20 items cluster at 400-600, but 600 is taken by rarity 10 here, and two tiers sharing
 * a price makes the rarity invisible). {@link UNSELLABLE_RARITIES} is priced by nothing — those
 * items are not sold at all.
 */
export const PRICE_BY_RARITY: Record<number, number> = {
	0: 150,
	10: 600,
	20: 700,
	30: 800,
	50: 3000,
}

/**
 * What a rarity absent from {@link PRICE_BY_RARITY} costs — the bottom tier, never free.
 *
 * Only reachable if a future capture introduces a rarity nobody has priced. A floor rather than
 * a skip because an unpriced item silently vanishing from the store is harder to notice than
 * one that turns up cheap; a rarity meant to be unsellable belongs in
 * {@link UNSELLABLE_RARITIES}, where a load reports it.
 */
export const DEFAULT_PRICE = 150

/** What one catalog row costs, in RecCenterTokens. */
export const priceForRarity = (rarity: number): number => PRICE_BY_RARITY[rarity] ?? DEFAULT_PRICE

/**
 * What Rec Room Plus takes off, in percent. The same number the server's own `subscriberFloor`
 * allows, which is what makes a subscriber's discounted `RequestedPrice` land inside the band
 * rather than through the floor.
 */
export const SUBSCRIBER_DISCOUNT_PERCENT = 10

/** The subscriber price for a regular one. Floored, matching the server's `subscriberFloor`. */
export const subscriberPriceFor = (regular: number): number =>
	Math.floor((regular * (100 - SUBSCRIBER_DISCOUNT_PERCENT)) / 100)

/**
 * The last client build treated as the 2023-era one, as a build number and as the ISO date the
 * item catalogue records `CreatedAt` in.
 *
 * One constant in two forms because two things key off the same moment: the econ worker decides
 * which storefront FILE a caller is served by comparing their token's `rn.ver` to the number,
 * and the storefront generator decides which ITEMS go in the 2023 file by comparing each item's
 * `CreatedAt` to the date. They must not drift — a build served the old store but a store built
 * to a different date would sell items that build has never heard of.
 */
export const LEGACY_CLIENT_BUILD = 20_230_414

/** {@link LEGACY_CLIENT_BUILD} as `YYYY-MM-DD`, for comparing against a `CreatedAt`. */
export const LEGACY_CLIENT_BUILD_DATE = '2023-04-14'

/**
 * Whether an item existed by the time of {@link LEGACY_CLIENT_BUILD} — i.e. whether the 2023
 * store should sell it.
 *
 * An item with NO `CreatedAt` is treated as too new and left out: three catalogue rows carry
 * none, and there is no way to show they predate the cutoff. Excluding is the conservative
 * direction — the 2023 store missing three items nobody noticed is better than it offering
 * something that build cannot render.
 */
export const existedByLegacyBuild = (createdAt: string | null | undefined): boolean =>
	typeof createdAt === 'string' && createdAt.slice(0, 10) < LEGACY_CLIENT_BUILD_DATE
