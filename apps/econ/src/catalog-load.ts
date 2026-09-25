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
 *
 * WHERE THE ROWS COME FROM. The 2025 general store as this worker serves it, and nothing else:
 * `static/storefronts/sf3-2025.json`, the live game's storefront 3 dumped
 * (`static/db/Watch_EnumValue_3.json`) and written out by `runx storefront build` with its
 * captured sale stripped and the skins the store never listed (`static/db/skins.json`)
 * appended as listings of their own. Loading the served file is what makes a row here and a
 * listing there one record: same asset id, same number, always. An earlier `avatar-items.json`
 * capture used to be the source and a storefront was generated FROM the table with invented
 * ids; the dump made both unnecessary.
 */

/** What a catalog row IS — the discriminator, and what says which id `item_key` holds. */
export const CatalogKind = {
	/** An avatar item: something worn. Its `item_key` is the `AvatarItemDesc`. */
	AvatarItem: 'avatar_item',
	/** An equipment skin: a re-skin of a held prefab. Its `item_key` is the `ModificationGuid`. */
	Skin: 'skin',
	/** A consumable: food, a potion, a KO icon. Its `item_key` is the `ConsumableItemDesc`. */
	Consumable: 'consumable',
} as const

export type CatalogKindValue = (typeof CatalogKind)[keyof typeof CatalogKind]

/** One price on a store listing. `StorefrontSaleData` is a discount the dump captured live. */
export interface StoreListingPrice {
	CurrencyType: number
	Price: number
	StorefrontSaleData: {
		SalePercent: number
		SaleStartDate: string | null
		SaleEndDate: string | null
	} | null
}

/**
 * A store listing's `GiftDrop` as the 2025 dump records it — the client's own `GiftDrop` class.
 * Only the members the loader reads are typed; the rest ride along untouched.
 *
 * Exactly ONE of the four item ids is set on a listing that carries an item: `AvatarItemDesc`,
 * `ConsumableItemDesc`, `EquipmentModificationGuid` or `CustomAvatarItemId`. A query box
 * (`IsQuery`) and a token bundle (`Currency` > 0) carry none.
 */
export interface StoreListingGiftDrop {
	GiftDropId: number
	FriendlyName: string
	Tooltip: string | null
	TagList: string | null
	ConsumableItemDesc: string
	AvatarItemDesc: string
	CustomAvatarItemId: string | null
	AvatarItemType: number | null
	EquipmentPrefabName: string
	EquipmentModificationGuid: string
	IsQuery: boolean
	Rarity: number
	Currency: number
	CurrencyType: number
	AvatarItemId: number
	ThumbnailImageName: string | null
	[extra: string]: unknown
}

/** One listing of the store dump — a `StoreItems[]` entry, as the client reads it. */
export interface StoreListing {
	PurchasableItemId: number
	GiftDrop: StoreListingGiftDrop
	Prices: StoreListingPrice[]
	SubscriberPrices: StoreListingPrice[] | null
	[extra: string]: unknown
}

/** One storefront page — the dump (`static/db/Watch_EnumValue_3.json`) or the served file. */
export interface StorefrontDump {
	StoreItems: StoreListing[]
	NextUpdate: string
	StorefrontType: number
	SubscriberDiscountPercent: number
	[extra: string]: unknown
}

/**
 * The capture's skin record (`static/db/skins.json`). Every field is present on every row.
 *
 * A thin capture: every `Rarity` is 0 or 1, every `UnlockedLevel` 0, every `ThumbnailImage`
 * empty, and where a guid is also in the store the store's name and rarity are the real ones
 * and disagree with these on every row. So it is read by `runx storefront build` ALONE, for
 * the skins the store does not list — see {@link unlistedSkinListing} — and the loader never
 * sees it.
 */
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
 * What a store listing SELLS — the catalog kind it loads as, or why it loads as nothing.
 *
 * `custom_avatar_item` listings are first-party UGC: they live in the `custom_avatar_item`
 * table (`just cai-load`), not here. `query` is a loot box and `currency` a token bundle —
 * neither is an item. `unknown` carries no id at all (two expo items the dump prices at
 * nothing). `consumable_pack` is assigned by the load rather than by {@link listingKind}: a
 * consumable the store sells singly AND as a pack ("Disco Dance Break", "… 3-Pack") is one
 * consumable listed twice, and the catalog is of things, not of listings.
 */
export type ListingKind =
	CatalogKindValue | 'custom_avatar_item' | 'query' | 'currency' | 'unknown' | 'consumable_pack'

/** Classify one listing by which of its item ids is set. */
export function listingKind(listing: StoreListing): ListingKind {
	const drop = listing.GiftDrop
	if (drop.AvatarItemDesc !== '') return CatalogKind.AvatarItem
	if (drop.ConsumableItemDesc !== '') return CatalogKind.Consumable
	if (drop.EquipmentModificationGuid !== '') return CatalogKind.Skin
	if (drop.CustomAvatarItemId !== null && drop.CustomAvatarItemId !== '') {
		return 'custom_avatar_item'
	}
	if (drop.IsQuery) return 'query'
	if (drop.Currency > 0) return 'currency'
	return 'unknown'
}

/**
 * The dump's listings with its verbatim repeats collapsed — twenty listings appear twice, byte
 * for byte. One copy is kept, in first position; a repeated id whose copies DIFFER is refused,
 * since order would then decide what the id means. The storefront file is written from this,
 * and the catalog load reads that file, so neither sees a repeat as a duplicate item.
 */
export function collapseRepeatedListings(listings: StoreListing[]): {
	listings: StoreListing[]
	repeats: number
} {
	const byId = new Map<number, string>()
	const kept: StoreListing[] = []
	let repeats = 0
	for (const listing of listings) {
		const json = JSON.stringify(listing)
		const first = byId.get(listing.PurchasableItemId)
		if (first === undefined) {
			byId.set(listing.PurchasableItemId, json)
			kept.push(listing)
		} else if (first === json) {
			repeats++
		} else {
			throw new Error(
				`PurchasableItemId ${listing.PurchasableItemId} is listed twice with different contents`
			)
		}
	}
	return { listings: kept, repeats }
}

/**
 * The first `PurchasableItemId` given to a skin the store does NOT list.
 *
 * Every other number in `sf3-2025.json` is the game's own. The skins the 2025 store never sold
 * still have to be listed — the weekly gift pool and the discovery rows draw skins from the
 * store, and a `catalog` row IS a listing — so they are appended with numbers of their own,
 * from here, in `skins.json` order. The store's ids top out below 40 000; a million is clear of
 * anything a fresher dump could bring.
 */
export const UNLISTED_SKIN_ID_BASE = 1_000_000

/** The rarity an unlisted skin is sold at: the top tier, where the store puts most of its own. */
export const UNLISTED_SKIN_RARITY = 50

/**
 * What a GOLD skin costs — any skin whose name carries `(Gold)`, thirteen of them, all from the
 * capture. A prestige price, and the same for a subscriber: no discount, no sale.
 */
export const GOLD_SKIN_PRICE = 1_000_000

/** Whether a listing is a gold skin — a skin whose name says `(Gold)`. */
export const isGoldSkin = (listing: StoreListing): boolean =>
	listing.GiftDrop.EquipmentModificationGuid !== '' &&
	listing.GiftDrop.FriendlyName.includes('(Gold)')

/** RecCenterTokens — the currency the store sells in. */
const CURRENCY_TYPE_TOKENS = 2

/**
 * A skin the store does not list, AS a listing — the dump's own skin shape, so the client reads
 * it like the rest. Rarity {@link UNLISTED_SKIN_RARITY} and priced from it: the store's own
 * rarity-50 skins run 1000-6000 tokens, and {@link PRICE_BY_RARITY} puts this in the middle.
 * The capture's name and tooltip. `ThumbnailImageName` is `""` — as it is on EVERY skin the
 * served store lists, the game's own included (see `runx storefront build`).
 */
export function unlistedSkinListing(skin: SkinCapture, id: number): StoreListing {
	const price = priceForRarity(UNLISTED_SKIN_RARITY)
	const priced = (p: number): StoreListingPrice => ({
		CurrencyType: CURRENCY_TYPE_TOKENS,
		Price: p,
		StorefrontSaleData: null,
	})
	return {
		GiftDrop: {
			GiftDropId: id,
			FriendlyName: skin.FriendlyName,
			Tooltip: skin.Tooltip ?? '',
			TagList: '',
			ConsumableItemDesc: '',
			AvatarItemDesc: '',
			CustomAvatarItemId: null,
			AvatarItemType: null,
			EquipmentPrefabName: skin.PrefabName,
			EquipmentModificationGuid: skin.ModificationGuid,
			IsQuery: false,
			QueryRedirectContext: null,
			QueryRedirectTag: null,
			QueryRedirectRarity: null,
			Unique: false,
			SubscribersOnly: false,
			Rarity: UNLISTED_SKIN_RARITY,
			Context: 1003,
			Currency: 0,
			CurrencyType: 0,
			ItemCount: 1,
			ItemSetId: null,
			ItemSetFriendlyName: '',
			AvatarItemId: 0,
			EquipmentItemId: 0,
			ThumbnailImageName: '',
			AvatarItemInfo: null,
		},
		PurchasableItemId: id,
		Type: 0,
		Prices: [priced(price)],
		SubscriberPrices: [priced(subscriberPriceFor(price))],
		IsFeatured: false,
		NewUntil: null,
		AvailableAt: null,
		AvailableUntil: null,
		CanBeGifted: true,
		OnlyAvailableThroughCv2: false,
	}
}

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
	/** Its `catalog_id`: the listing's `PurchasableItemId`. */
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

/** What {@link buildCatalogLoad} produced, and what it left out. */
export interface CatalogLoad {
	rows: CatalogLoadRow[]
	collisions: CatalogCollision[]
	/** Listings that load as nothing, counted by {@link ListingKind}. */
	skipped: Partial<Record<ListingKind, number>>
}

/**
 * The store records no platform mask — every listing is for every platform, which is what the
 * `platform_mask` column's `-1` default means.
 */
const ALL_PLATFORMS = -1

/**
 * A listed avatar item. `is_base_avatar_item` and `created_at` are NULL because a store listing
 * records neither; a NULL there is "not recorded", which is true.
 */
function avatarItemRow(listing: StoreListing): CatalogLoadRow {
	const drop = listing.GiftDrop
	return {
		key: drop.AvatarItemDesc,
		id: listing.PurchasableItemId,
		label: `${drop.FriendlyName} (avatar item)`,
		values: [
			drop.AvatarItemDesc,
			listing.PurchasableItemId,
			CatalogKind.AvatarItem,
			drop.FriendlyName,
			drop.Tooltip,
			drop.Rarity,
			ALL_PLATFORMS,
			drop.ThumbnailImageName,
			drop.AvatarItemType ?? 0,
			// 0 is the dump's "none"; the column's is NULL.
			drop.AvatarItemId || null,
			null,
			drop.TagList,
			null,
			null,
			null,
		],
	}
}

/** A listed consumable: the shared columns only, keyed by its `ConsumableItemDesc`. */
function consumableRow(listing: StoreListing): CatalogLoadRow {
	const drop = listing.GiftDrop
	return {
		key: drop.ConsumableItemDesc,
		id: listing.PurchasableItemId,
		label: `${drop.FriendlyName} (consumable)`,
		values: [
			drop.ConsumableItemDesc,
			listing.PurchasableItemId,
			CatalogKind.Consumable,
			drop.FriendlyName,
			drop.Tooltip,
			drop.Rarity,
			ALL_PLATFORMS,
			drop.ThumbnailImageName,
			null,
			null,
			null,
			drop.TagList,
			null,
			null,
			null,
		],
	}
}

/** A listed skin: what the listing carries. */
function listedSkinRow(listing: StoreListing): CatalogLoadRow {
	const drop = listing.GiftDrop
	return {
		key: drop.EquipmentModificationGuid,
		id: listing.PurchasableItemId,
		label: `${drop.FriendlyName} (skin, ${drop.EquipmentPrefabName})`,
		values: [
			drop.EquipmentModificationGuid,
			listing.PurchasableItemId,
			CatalogKind.Skin,
			drop.FriendlyName,
			drop.Tooltip,
			drop.Rarity,
			ALL_PLATFORMS,
			drop.ThumbnailImageName,
			null,
			null,
			null,
			null,
			null,
			drop.EquipmentPrefabName,
			null,
		],
	}
}

/**
 * Turn the served store into the rows a load writes, de-duplicated on `item_key`.
 *
 * `item_key` is unique across ALL kinds, so a repeat is a defect in the source rather than
 * something the table should model. First occurrence wins and the rest are RETURNED rather
 * than dropped on the floor: the caller has to report them, because a collision that vanishes
 * quietly is the exact failure the single key exists to prevent. (The dump's verbatim repeats
 * are collapsed by {@link collapseRepeatedListings} before the served file is written, so they
 * never get here; a consumable's PACK is counted, not reported — see {@link ListingKind}.)
 *
 * Rows come out in STORE ORDER, one per listing that sells a catalog item, and `catalog_id` is
 * the listing's `PurchasableItemId` — a real, stable number, the one the client buys by. A
 * store id naming two different keys is refused outright: it cannot be resolved by order, and
 * nothing in the dump does it.
 */
export function buildCatalogLoad(listings: StoreListing[]): CatalogLoad {
	const seen = new Map<string, string>()
	const idOwner = new Map<number, string>()
	const rows: CatalogLoadRow[] = []
	const collisions: CatalogCollision[] = []
	const skipped: Partial<Record<ListingKind, number>> = {}

	/** Keep the row, or report it as a repeat of one already kept. */
	const push = (row: CatalogLoadRow): void => {
		const kept = seen.get(row.key)
		if (kept !== undefined) {
			collisions.push({ key: row.key, kept, dropped: row.label })
			return
		}
		const owner = idOwner.get(row.id)
		if (owner !== undefined) {
			throw new Error(`catalog_id ${row.id} names two items: ${owner} and ${row.label}`)
		}
		seen.set(row.key, row.label)
		idOwner.set(row.id, row.label)
		rows.push(row)
	}

	for (const listing of listings) {
		const kind = listingKind(listing)
		switch (kind) {
			case CatalogKind.AvatarItem:
				push(avatarItemRow(listing))
				break
			case CatalogKind.Consumable:
				// The pack of a consumable already listed singly: one thing, one row.
				if (seen.has(listing.GiftDrop.ConsumableItemDesc)) {
					skipped.consumable_pack = (skipped.consumable_pack ?? 0) + 1
					break
				}
				push(consumableRow(listing))
				break
			case CatalogKind.Skin:
				push(listedSkinRow(listing))
				break
			default:
				skipped[kind] = (skipped[kind] ?? 0) + 1
		}
	}

	return { rows, collisions, skipped }
}

/**
 * Rarities that mark the developer/unreleased tier.
 *
 * `-1`. The 2025 store lists a handful of such items and this server serves that store
 * verbatim, so they CAN be bought; the tier is kept out of the discovery rows the `lists`
 * worker draws from the catalog, which is the one place this is still read.
 */
export const UNSELLABLE_RARITIES: readonly number[] = [-1]

/** Whether an item of this rarity is outside the developer tier. */
export const isSellableRarity = (rarity: number): boolean => !UNSELLABLE_RARITIES.includes(rarity)

/**
 * What an item costs by rarity, in RecCenterTokens — for the things the store dump does not
 * price: the skins it never listed ({@link unlistedSkinListing}) and a first-party custom
 * avatar item it does not list (`apps/api/scripts/price-custom-avatar-items.ts`). Everything
 * the dump lists carries its real price, verbatim.
 */
export const PRICE_BY_RARITY: Record<number, number> = {
	0: 150,
	10: 600,
	20: 700,
	30: 800,
	50: 3000,
}

/**
 * What a rarity absent from {@link PRICE_BY_RARITY} costs — the bottom tier, never free. A
 * floor rather than a skip because an unpriced item silently vanishing is harder to notice
 * than one that turns up cheap.
 */
export const DEFAULT_PRICE = 150

/** What one item of this rarity costs, in RecCenterTokens. */
export const priceForRarity = (rarity: number): number => PRICE_BY_RARITY[rarity] ?? DEFAULT_PRICE

/**
 * What Rec Room Plus takes off, in percent — the same number the econ worker's own
 * `subscriberFloor` allows, which is what makes a subscriber's discounted `RequestedPrice` land
 * inside the band rather than through the floor.
 */
export const SUBSCRIBER_DISCOUNT_PERCENT = 10

/** The subscriber price for a regular one. Floored, matching the worker's `subscriberFloor`. */
export const subscriberPriceFor = (regular: number): number =>
	Math.floor((regular * (100 - SUBSCRIBER_DISCOUNT_PERCENT)) / 100)

/**
 * The last client build served the 2023 general store.
 *
 * The econ worker compares a caller's token `rn.ver` to this to pick which storefront FILE
 * they get for storefront 3: `sf3.json` (the 2023 store, frozen) up to and including this
 * build, `sf3-2025.json` (the 2025 store dump) after it.
 */
export const LEGACY_CLIENT_BUILD = 20_230_414
