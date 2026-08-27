/**
 * Custom avatar items — player-designed items built on a base catalog item — on the
 * shared `recflare` D1 database. One column per field of the client's `CustomAvatarItem`
 * DTO, so a row maps straight onto the response.
 *
 * The two uploads that accompany a creation (the design blob and the thumbnail PNG) live
 * in the shared image bucket (`recflare-img`, the `IMAGES` binding) under
 * `avatar-item/<date>/<id>-thumb.png` and `<id>-design.png`; the two filename columns hold
 * those bucket keys, which the `img` worker serves back by key.
 *
 * The `api` worker owns the schema/migration (migrations/0015_custom_avatar_item.sql,
 * applied under its own `migrations_table`).
 */

/** Schema DDL (mirror of migrations/0015_custom_avatar_item.sql). */
export const SCHEMA_DDL: string[] = [
	`CREATE TABLE IF NOT EXISTS custom_avatar_item (
		custom_avatar_item_id TEXT PRIMARY KEY,
		creator_account_id INTEGER NOT NULL,
		name TEXT NOT NULL,
		description TEXT NOT NULL DEFAULT '',
		price INTEGER NOT NULL DEFAULT 0,
		accessibility INTEGER NOT NULL DEFAULT 0,
		force_cannot_publish INTEGER NOT NULL DEFAULT 0,
		is_featured INTEGER NOT NULL DEFAULT 0,
		is_rec_room_approved INTEGER NOT NULL DEFAULT 0,
		base_avatar_item_id INTEGER NOT NULL,
		base_avatar_item_color TEXT NOT NULL,
		design_filename TEXT NOT NULL,
		thumbnail_image_filename TEXT NOT NULL,
		created_at TEXT NOT NULL,
		modified_at TEXT NOT NULL,
		preview_orientation INTEGER NOT NULL DEFAULT 0,
		outfit_type INTEGER NOT NULL DEFAULT 0
	)`,
	`CREATE INDEX IF NOT EXISTS idx_custom_avatar_item_creator ON custom_avatar_item (creator_account_id)`,
]

/** The client's `CustomAvatarItem` record (PascalCase, as served). */
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
	BaseAvatarItemId: number
	BaseAvatarItemColor: string
	DesignFilename: string
	ThumbnailImageFilename: string
	CreatedAt: string
	ModifiedAt: string
	PreviewOrientation: number
	RankingContext: null
	OutfitType: number
	CurrentSaves: never[]
	PurchaseInfo: null
}

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
}

interface Row {
	custom_avatar_item_id: string
	creator_account_id: number
	name: string
	description: string
	price: number
	accessibility: number
	force_cannot_publish: number
	is_featured: number
	is_rec_room_approved: number
	base_avatar_item_id: number
	base_avatar_item_color: string
	design_filename: string
	thumbnail_image_filename: string
	created_at: string
	modified_at: string
	preview_orientation: number
	outfit_type: number
}

function toDto(row: Row): CustomAvatarItem {
	return {
		CustomAvatarItemId: row.custom_avatar_item_id,
		CreatorAccountId: row.creator_account_id,
		Name: row.name,
		Description: row.description,
		Price: row.price,
		Accessibility: row.accessibility,
		ForceCannotPublish: row.force_cannot_publish === 1,
		IsFeatured: row.is_featured === 1,
		IsRecRoomApproved: row.is_rec_room_approved === 1,
		BaseAvatarItemId: row.base_avatar_item_id,
		BaseAvatarItemColor: row.base_avatar_item_color,
		DesignFilename: row.design_filename,
		ThumbnailImageFilename: row.thumbnail_image_filename,
		CreatedAt: row.created_at,
		ModifiedAt: row.modified_at,
		PreviewOrientation: row.preview_orientation,
		RankingContext: null,
		OutfitType: row.outfit_type,
		CurrentSaves: [],
		PurchaseInfo: null,
	}
}

/** Inserts a new custom avatar item and returns it as the client's DTO. */
export async function createCustomAvatarItem(
	db: D1Database,
	input: CreateCustomAvatarItemInput,
	now: Date = new Date()
): Promise<CustomAvatarItem> {
	const ts = now.toISOString()
	const row = await db
		.prepare(
			`INSERT INTO custom_avatar_item (
				custom_avatar_item_id, creator_account_id, name, description, price, accessibility,
				base_avatar_item_id, base_avatar_item_color, design_filename, thumbnail_image_filename,
				created_at, modified_at
			) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?11)
			RETURNING *`
		)
		.bind(
			input.customAvatarItemId,
			input.creatorAccountId,
			input.name,
			input.description,
			input.price,
			input.accessibility,
			input.baseAvatarItemId,
			input.baseAvatarItemColor,
			input.designFilename,
			input.thumbnailImageFilename,
			ts
		)
		.first<Row>()
	if (!row) throw new Error('custom_avatar_item insert returned no row')
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
 */
export function toUgcPurchasable(item: CustomAvatarItem, roomId: number): UgcPurchasableItem {
	return {
		ItemType: UGC_ITEM_TYPE_CUSTOM_AVATAR_ITEM,
		ItemId: item.CustomAvatarItemId,
		Name: item.Name,
		Description: item.Description,
		ImageName: item.ThumbnailImageFilename,
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
		.prepare(`SELECT * FROM custom_avatar_item WHERE custom_avatar_item_id IN (${placeholders})`)
		.bind(...ids)
		.all<Row>()
	const byId = new Map(results.map((r) => [r.custom_avatar_item_id, toDto(r)]))
	return ids.flatMap((id) => byId.get(id) ?? [])
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
			`SELECT * FROM custom_avatar_item WHERE is_featured = 1 AND accessibility != 0
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
			`SELECT * FROM custom_avatar_item WHERE accessibility != 0
			 ORDER BY created_at DESC, custom_avatar_item_id LIMIT ?1`
		)
		.bind(limit)
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
			`SELECT * FROM custom_avatar_item
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
 * Applies a partial edit to one item, bumping `modified_at`. Fields the caller leaves
 * null keep their value (the client sends every field, nulling the untouched ones).
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
			`UPDATE custom_avatar_item SET
				name = COALESCE(?2, name),
				description = COALESCE(?3, description),
				price = COALESCE(?4, price),
				accessibility = COALESCE(?5, accessibility),
				modified_at = ?6
			 WHERE custom_avatar_item_id = ?1
			 RETURNING *`
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
		.prepare('DELETE FROM custom_avatar_item WHERE custom_avatar_item_id = ?1 RETURNING *')
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
		.prepare('SELECT * FROM custom_avatar_item WHERE custom_avatar_item_id = ?1')
		.bind(id)
		.first<Row>()
	return row ? toDto(row) : null
}
