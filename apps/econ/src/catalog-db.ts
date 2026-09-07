import { CatalogKind } from './catalog-load'

import type { CatalogKindValue } from './catalog-load'

/**
 * The item CATALOG on the shared `recflare` D1 database — every avatar item and every
 * equipment skin the game knows about, one row each, loaded once by migration rather than
 * written at runtime. Nothing here is per-player: ownership lives in `inventory` and
 * `equipment`, and this table only says what a thing IS.
 *
 * It exists to be QUERIED. The catalogs were previously reachable only by parsing a whole
 * storefront JSON per request (`sf{N}.json`, 1161 items in sf3 alone) and by scanning the
 * bundled `default-avatar-items.json`, which means every lookup pays for the whole file and
 * nothing can be searched by name or filtered by tag at all. A row with indexes answers those
 * in one statement.
 *
 * BOTH kinds share one table because they share most of a record — a display name, a tooltip, a
 * rarity, a platform mask, a thumbnail — and because the interesting queries ("what is called
 * X", "what is this thing the player owns") run across both. `kind` discriminates, and the
 * columns each kind alone carries are nullable and empty on the other. Read a row through
 * {@link toCatalogAvatarItem}/{@link toCatalogSkin} rather than serving it raw: the client's
 * two DTOs share no key order and differ in what they omit.
 *
 * Where the rows come from: `static/db/avatar-items.json` and `static/db/skins.json`, both
 * captured from the reference and loaded by `runx catalog load`.
 *
 * The migration builds the TABLE ONLY — it holds no rows. The catalog changes as the game's
 * item list changes, and that is not a schema change: a migration per refresh would mean a
 * deploy per refresh, an ever-growing pile of near-identical data migrations, and no way to
 * reload without inventing a new one. So the structure is versioned and the contents are
 * (re)loaded on demand, which also makes a refresh a `git diff` of the JSON rather than of
 * 700KB of generated SQL.
 *
 * This worker (`econ`) owns the table and its migration.
 */

// The discriminator and the JSON→row mapping live in `catalog-load.ts`, which deliberately
// touches no Workers types: `runx catalog load` (a plain Node CLI in @repo/tools) imports it,
// and importing this module instead would drag `D1Database` into a package that has no such
// types. Re-exported here so callers still get the whole table from one import.
export {
	buildCatalogLoad,
	CATALOG_INSERT_COLUMNS,
	CatalogKind,
	type AvatarItemCapture,
	type CatalogCollision,
	type CatalogKindValue,
	type CatalogLoadRow,
	type CatalogValue,
	type SkinCapture,
} from './catalog-load'

/**
 * Schema DDL (mirror of migrations/0015_catalog.sql) — also builds the table in tests.
 *
 * ONE KEY spans both kinds. `item_key` is an avatar item's `AvatarItemDesc` and a skin's
 * `ModificationGuid`: neither repeats, the two never collide, and no item has both. That is
 * also how the INVENTORY identifies what a player owns, so resolving an owned thing is a lookup
 * on this column — not a join that first has to establish which kind of thing it is.
 *
 * Not every key is a GUID. 191 skins and 109 avatar items carry the short alpha-string ids the
 * game used before it moved to GUIDs (`_OWVy3z6iU-M3-zbQgSLig`), so the column is TEXT and
 * compared as text. Do not add a uuid-shaped constraint and do not try to parse one.
 *
 * `avatar_item_id` is carried as DATA ONLY and deliberately not indexed: it is missing from 22
 * avatar items and repeated on 9 more (id 9503 alone covers five unrelated developer items), so
 * it can neither key nor reliably find anything.
 *
 * `catalog_id` is the small NUMERIC handle the site uses where a key would be unwieldy, and is
 * what a generated storefront lists a row under as its `PurchasableItemId`. It is assigned by
 * the loader from `CATALOG_ID_BASE` (10000, clear of every captured storefront's own ids) and
 * renumbered by every load, so it identifies a row only within one load — see the field's own
 * note. It is unique where set, and the migration that adds it is 0016, since 0015 was already
 * applied.
 *
 * Nullability is load-bearing rather than incidental: `tooltip` is genuinely NULL on some rows
 * of BOTH kinds and `""` on others, and the client's DTOs serve the distinction through, so the
 * column may not be defaulted to the empty string.
 */
export const CATALOG_SCHEMA_DDL: string[] = [
	`CREATE TABLE IF NOT EXISTS catalog (
		item_key TEXT PRIMARY KEY,
		catalog_id INTEGER,
		kind TEXT NOT NULL,
		friendly_name TEXT NOT NULL,
		tooltip TEXT,
		rarity INTEGER NOT NULL DEFAULT 0,
		platform_mask INTEGER NOT NULL DEFAULT -1,
		thumbnail_image TEXT,
		avatar_item_type INTEGER,
		avatar_item_id INTEGER,
		is_base_avatar_item INTEGER,
		tag_list TEXT,
		created_at TEXT,
		prefab_name TEXT,
		unlocked_level INTEGER
	)`,
	// The search index. Folded, because a name search is case-insensitive and SQLite's LIKE is
	// only case-insensitive for ASCII — which these names are not all of.
	`CREATE INDEX IF NOT EXISTS idx_catalog_name ON catalog (kind, lower(friendly_name))`,
	// Every skin of one prefab, which is how a skin picker is filled.
	`CREATE INDEX IF NOT EXISTS idx_catalog_prefab ON catalog (prefab_name) WHERE prefab_name IS NOT NULL`,
	// Seasonal rows ('halloween', 'music', …) — a handful of tags over 3000-odd rows, so the
	// index is worth far more than its size.
	`CREATE INDEX IF NOT EXISTS idx_catalog_tag ON catalog (tag_list) WHERE tag_list IS NOT NULL`,
	// The numeric handle. Unique where set — a number that names two rows is useless as a handle
	// — and partial, because a row is un-numbered between existing and being numbered by a load.
	`CREATE UNIQUE INDEX IF NOT EXISTS idx_catalog_id ON catalog (catalog_id) WHERE catalog_id IS NOT NULL`,
]

/** A catalog row exactly as stored — snake_case, both kinds' columns, most of them null. */
export interface CatalogRow {
	item_key: string
	/**
	 * A small numeric handle for the row — for the surfaces that need to name an item as a
	 * number rather than as a comma-laden `AvatarItemDesc` or a guid, and the
	 * `PurchasableItemId` a generated storefront lists it under.
	 *
	 * A LOAD-ORDER SURROGATE, not an identity: `runx catalog load` assigns it, so it is stable
	 * only until the next load. Never store it, never reference it across a load, never treat it
	 * as what an item IS — `item_key` is that, and it is what the inventory holds. NULL only
	 * between a row existing and a load numbering it.
	 */
	catalog_id: number | null
	kind: string
	friendly_name: string
	tooltip: string | null
	rarity: number
	platform_mask: number
	thumbnail_image: string | null
	avatar_item_type: number | null
	avatar_item_id: number | null
	is_base_avatar_item: number | null
	tag_list: string | null
	created_at: string | null
	prefab_name: string | null
	unlocked_level: number | null
}

/**
 * The catalog's view of an avatar item — the bundled `default-avatar-items.json` record plus
 * the four fields that file leaves out (`AvatarItemId`, `IsBaseAvatarItem`, `CreatedAt`,
 * `ThumbnailImage`), which is what `GET /api/avatar/v1/defaultunlocked` serves and what the
 * store rows resolve against.
 *
 * `AvatarItemId` is nullable and `Tooltip` may be null; both are true of the captured data and
 * the client reads them that way. Do not tighten either to keep a projection simple.
 */
export interface CatalogAvatarItem {
	AvatarItemDesc: string
	AvatarItemType: number
	PlatformMask: number
	FriendlyName: string
	Tooltip: string | null
	Rarity: number
	TagList: string | null
	AvatarItemId: number | null
	IsBaseAvatarItem: boolean
	CreatedAt: string | null
	ThumbnailImage: string | null
}

/**
 * The catalog's view of a skin, in the client's `Equipment` shape plus the two fields the
 * capture carries that an owned-equipment row does not (`UnlockedLevel`, `ThumbnailImage`).
 *
 * `Favorited` is a PLAYER's flag, not a property of the skin, so the catalog does not store it
 * — every captured row said `false` because the capture belonged to one account. It is
 * projected as `false` here and overwritten from the owning player's `equipment` row; storing
 * it would make one player's favourites everyone's.
 */
export interface CatalogSkin {
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

/** Projects a row to the avatar-item record. Throws on a row of the wrong kind. */
export function toCatalogAvatarItem(row: CatalogRow): CatalogAvatarItem {
	if (row.kind !== CatalogKind.AvatarItem) {
		throw new Error(`catalog row ${row.item_key} is a ${row.kind}, not an avatar item`)
	}
	return {
		// The key IS the desc — that is what makes it the key.
		AvatarItemDesc: row.item_key,
		AvatarItemType: row.avatar_item_type ?? 0,
		PlatformMask: row.platform_mask,
		FriendlyName: row.friendly_name,
		Tooltip: row.tooltip,
		Rarity: row.rarity,
		TagList: row.tag_list,
		AvatarItemId: row.avatar_item_id,
		IsBaseAvatarItem: row.is_base_avatar_item === 1,
		CreatedAt: row.created_at,
		ThumbnailImage: row.thumbnail_image,
	}
}

/** Projects a row to the skin record. Throws on a row of the wrong kind. */
export function toCatalogSkin(row: CatalogRow): CatalogSkin {
	if (row.kind !== CatalogKind.Skin) {
		throw new Error(`catalog row ${row.item_key} is a ${row.kind}, not a skin`)
	}
	return {
		PrefabName: row.prefab_name ?? '',
		// The key IS the guid.
		ModificationGuid: row.item_key,
		UnlockedLevel: row.unlocked_level ?? 0,
		Favorited: false,
		PlatformMask: row.platform_mask,
		FriendlyName: row.friendly_name,
		Tooltip: row.tooltip,
		Rarity: row.rarity,
		ThumbnailImage: row.thumbnail_image,
	}
}

/**
 * The base asset an avatar item is built on — the FIRST field of its `AvatarItemDesc`, which is
 * `<baseAsset>,<color>,<texture>,`. The client can only draw an item whose base asset it
 * already ships with, so this is the field that decides whether a store row renders anything
 * (see the Generic-row notes in the `lists` worker).
 */
export function baseAsset(desc: string): string {
	return desc.split(',')[0] ?? ''
}

/**
 * One catalog row by its key, WHICHEVER kind it is. This is the lookup the inventory wants: a
 * player's owned things are ids of exactly this shape, and the row that comes back says which
 * kind it turned out to be.
 */
export async function getCatalogItem(db: D1Database, itemKey: string): Promise<CatalogRow | null> {
	return await db
		.prepare('SELECT * FROM catalog WHERE item_key = ?1')
		.bind(itemKey)
		.first<CatalogRow>()
}

/**
 * One catalog row by its numeric handle.
 *
 * Only meaningful WITHIN a load: the number is reassigned every time the catalog is loaded, so
 * a caller holding one from before a reload will get a different item or nothing at all. Fine
 * for a request that looked the number up moments ago; never for anything stored.
 */
export async function getCatalogItemById(
	db: D1Database,
	catalogId: number
): Promise<CatalogRow | null> {
	return await db
		.prepare('SELECT * FROM catalog WHERE catalog_id = ?1')
		.bind(catalogId)
		.first<CatalogRow>()
}

/**
 * Resolve many keys at once, in the order asked; unknown keys are skipped rather than left as
 * holes, so the result may be SHORTER than the input and must not be read positionally. One
 * statement for a whole inventory, which is the point of the table.
 */
export async function getCatalogItems(db: D1Database, itemKeys: string[]): Promise<CatalogRow[]> {
	if (itemKeys.length === 0) return []
	const placeholders = itemKeys.map((_, i) => `?${i + 1}`).join(', ')
	const { results } = await db
		.prepare(`SELECT * FROM catalog WHERE item_key IN (${placeholders})`)
		.bind(...itemKeys)
		.all<CatalogRow>()
	const byKey = new Map(results.map((r) => [r.item_key, r]))
	return itemKeys.flatMap((key) => byKey.get(key) ?? [])
}

/** One avatar item by its `AvatarItemDesc`. Null for an unknown key OR for a skin's key. */
export async function getAvatarItem(
	db: D1Database,
	avatarItemDesc: string
): Promise<CatalogAvatarItem | null> {
	const row = await getCatalogItem(db, avatarItemDesc)
	return row?.kind === CatalogKind.AvatarItem ? toCatalogAvatarItem(row) : null
}

/** One skin by its `ModificationGuid`. Null for an unknown key OR for an avatar item's key. */
export async function getSkin(
	db: D1Database,
	modificationGuid: string
): Promise<CatalogSkin | null> {
	const row = await getCatalogItem(db, modificationGuid)
	return row?.kind === CatalogKind.Skin ? toCatalogSkin(row) : null
}

/** Every skin of one prefab (`[MakerPen]`, `[QuestSword]`, …), by name. */
export async function getSkinsForPrefab(
	db: D1Database,
	prefabName: string
): Promise<CatalogSkin[]> {
	const { results } = await db
		.prepare('SELECT * FROM catalog WHERE prefab_name = ?1 ORDER BY friendly_name')
		.bind(prefabName)
		.all<CatalogRow>()
	return results.map(toCatalogSkin)
}

/**
 * Name search within one kind — a case-insensitive substring match, ordered by name so paging
 * is stable.
 *
 * Both sides are lowered so the comparison hits `idx_catalog_name`, whose second column is
 * `lower(friendly_name)`: SQLite's `LIKE` folds case for ASCII only, and these names are not
 * all ASCII. `%` and `_` in the needle are escaped, so a player searching for a literal
 * underscore gets that rather than a wildcard.
 */
export async function searchCatalog(
	db: D1Database,
	kind: CatalogKindValue,
	needle: string,
	limit = 50
): Promise<CatalogRow[]> {
	const escaped = needle.toLowerCase().replace(/[\\%_]/g, (ch) => `\\${ch}`)
	const { results } = await db
		.prepare(
			`SELECT * FROM catalog
			 WHERE kind = ?1 AND lower(friendly_name) LIKE ?2 ESCAPE '\\'
			 ORDER BY friendly_name, item_key LIMIT ?3`
		)
		.bind(kind, `%${escaped}%`, limit)
		.all<CatalogRow>()
	return results
}

/** Every avatar item carrying a seasonal tag (`halloween`, `music`, …), by name. */
export async function getAvatarItemsByTag(
	db: D1Database,
	tag: string
): Promise<CatalogAvatarItem[]> {
	const { results } = await db
		.prepare('SELECT * FROM catalog WHERE tag_list = ?1 ORDER BY friendly_name')
		.bind(tag)
		.all<CatalogRow>()
	return results.map(toCatalogAvatarItem)
}

/** How many rows of each kind the catalog holds — the cheap check that a load actually landed. */
export async function countCatalog(db: D1Database): Promise<Record<string, number>> {
	const { results } = await db
		.prepare('SELECT kind, COUNT(*) AS n FROM catalog GROUP BY kind')
		.all<{ kind: string; n: number }>()
	return Object.fromEntries(results.map((r) => [r.kind, r.n]))
}
