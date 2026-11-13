/**
 * Room offers — what a room SELLS of its own inventory items. One offer is a price and a list
 * of `ItemMappings`, each naming a `room_inventory_item` (see `room-inventory-item-db.ts`) by
 * its `OriginId` and how many of it the offer gives. Buying an offer is not implemented yet.
 *
 * The endpoints:
 *  - `POST /econ/roomOffer/room/{roomId}` creates an offer (or replaces the one `OriginId` names)
 *  - `GET  /econ/roomOffer/room/{roomId}` lists a room's offers
 *
 * This worker (`econ`) owns the table and its migration — see apps/econ/migrations/0031.
 */

/** Schema DDL — also builds the table in tests. Mirrors migration 0031. */
export const ROOM_OFFER_SCHEMA_DDL: string[] = [
	// `origin_id` is a GUID, the client's `OriginId`. `item_mappings` is a JSON array of
	// `{ ItemType, ItemOriginId, Count }`, read back whole and never queried into, the same
	// reasoning as `room_inventory_item.tag_ids`. `price_unit_id` is the client's `PriceUnitId`
	// as JSON — its type has only been seen null, so it round-trips whatever was sent.
	`CREATE TABLE IF NOT EXISTS room_offer (
		origin_id TEXT PRIMARY KEY,
		room_id INTEGER NOT NULL,
		name TEXT NOT NULL,
		description TEXT NOT NULL,
		image_name TEXT,
		price INTEGER NOT NULL,
		has_dynamic_price INTEGER NOT NULL DEFAULT 0,
		minimum_dynamic_price INTEGER,
		maximum_dynamic_price INTEGER,
		max_num_purchases_per_player INTEGER,
		max_count_per_purchase INTEGER NOT NULL DEFAULT 1,
		item_mappings TEXT NOT NULL DEFAULT '[]',
		price_unit_id TEXT NOT NULL DEFAULT 'null',
		allow_rename INTEGER NOT NULL DEFAULT 0,
		visibility INTEGER NOT NULL DEFAULT 0,
		is_giftable INTEGER NOT NULL DEFAULT 0,
		created_at TEXT NOT NULL,
		modified_at TEXT NOT NULL
	)`,
	// Every read is "this room's offers".
	`CREATE INDEX IF NOT EXISTS idx_room_offer_room ON room_offer (room_id)`,
]

/**
 * `ItemType` 1: the mapping's `ItemOriginId` is a `room_inventory_item`. The only type
 * observed; nothing else is accepted until another is seen.
 */
export const ROOM_OFFER_ITEM_TYPE_INVENTORY_ITEM = 1

/** One thing an offer gives — the client's item mapping, in its key order. */
export interface RoomOfferItemMapping {
	ItemType: number
	/** For `ItemType` 1, a `room_inventory_item.origin_id` of the offer's room. */
	ItemOriginId: string
	Count: number
}

/** What a write supplies; the id and the timestamps are the server's. */
export interface NewRoomOffer {
	RoomId: number
	Name: string
	Description: string
	ImageName: string | null
	Price: number
	HasDynamicPrice: boolean
	MinimumDynamicPrice: number | null
	MaximumDynamicPrice: number | null
	MaxNumPurchasesPerPlayer: number | null
	MaxCountPerPurchase: number
	ItemMappings: RoomOfferItemMapping[]
	/** Only ever seen null; stored and served as sent. */
	PriceUnitId: unknown
	AllowRename: boolean
	Visibility: number
	IsGiftable: boolean
}

/**
 * An offer as stored, served as the create's `Value`. PROVISIONAL as a wire shape: the
 * envelope around it is observed, its own keys are not, so this is the request body's keys in
 * its order with `OriginId` filled in and `RoomId`/`CreatedAt`/`ModifiedAt` added.
 */
export interface RoomOffer {
	OriginId: string
	RoomId: number
	Name: string
	Description: string
	ImageName: string | null
	Price: number
	HasDynamicPrice: boolean
	MinimumDynamicPrice: number | null
	MaximumDynamicPrice: number | null
	MaxNumPurchasesPerPlayer: number | null
	MaxCountPerPurchase: number
	ItemMappings: RoomOfferItemMapping[]
	PriceUnitId: unknown
	AllowRename: boolean
	Visibility: number
	IsGiftable: boolean
	/** ISO-8601 UTC. */
	CreatedAt: string
	/** ISO-8601 UTC. */
	ModifiedAt: string
}

interface OfferRow {
	origin_id: string
	room_id: number
	name: string
	description: string
	image_name: string | null
	price: number
	has_dynamic_price: number
	minimum_dynamic_price: number | null
	maximum_dynamic_price: number | null
	max_num_purchases_per_player: number | null
	max_count_per_purchase: number
	item_mappings: string
	price_unit_id: string
	allow_rename: number
	visibility: number
	is_giftable: number
	created_at: string
	modified_at: string
}

const OFFER_COLUMNS = `origin_id, room_id, name, description, image_name, price, has_dynamic_price, minimum_dynamic_price, maximum_dynamic_price, max_num_purchases_per_player, max_count_per_purchase, item_mappings, price_unit_id, allow_rename, visibility, is_giftable, created_at, modified_at`

function parseJson<T>(raw: string, fallback: T): T {
	try {
		return JSON.parse(raw) as T
	} catch {
		return fallback
	}
}

const toOffer = (row: OfferRow): RoomOffer => ({
	OriginId: row.origin_id,
	RoomId: row.room_id,
	Name: row.name,
	Description: row.description,
	ImageName: row.image_name,
	Price: row.price,
	HasDynamicPrice: row.has_dynamic_price !== 0,
	MinimumDynamicPrice: row.minimum_dynamic_price,
	MaximumDynamicPrice: row.maximum_dynamic_price,
	MaxNumPurchasesPerPlayer: row.max_num_purchases_per_player,
	MaxCountPerPurchase: row.max_count_per_purchase,
	ItemMappings: parseJson<RoomOfferItemMapping[]>(row.item_mappings, []),
	PriceUnitId: parseJson<unknown>(row.price_unit_id, null),
	AllowRename: row.allow_rename !== 0,
	Visibility: row.visibility,
	IsGiftable: row.is_giftable !== 0,
	CreatedAt: row.created_at,
	ModifiedAt: row.modified_at,
})

/** One offer by its id, or null when there is no such row. */
export async function getRoomOffer(db: D1Database, originId: string): Promise<RoomOffer | null> {
	const row = await db
		.prepare(`SELECT ${OFFER_COLUMNS} FROM room_offer WHERE origin_id = ?1`)
		.bind(originId)
		.first<OfferRow>()
	return row ? toOffer(row) : null
}

/** Every offer a room has, oldest first. Always an array. */
export async function getRoomOffers(db: D1Database, roomId: number): Promise<RoomOffer[]> {
	const { results } = await db
		.prepare(
			`SELECT ${OFFER_COLUMNS} FROM room_offer WHERE room_id = ?1 ORDER BY created_at, origin_id`
		)
		.bind(roomId)
		.all<OfferRow>()
	return results.map(toOffer)
}

/**
 * Create an offer, or replace the one `originId` already names. The caller has checked that
 * an existing `originId` belongs to `offer.RoomId` and that every mapping names one of that
 * room's items; a replace keeps the offer's `CreatedAt` and never moves it between rooms.
 */
export async function upsertRoomOffer(
	db: D1Database,
	originId: string,
	offer: NewRoomOffer
): Promise<RoomOffer> {
	const now = new Date().toISOString()
	const row = await db
		.prepare(
			`INSERT INTO room_offer (${OFFER_COLUMNS})
			 VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15, ?16, ?17, ?17)
			 ON CONFLICT (origin_id) DO UPDATE SET
			   name = excluded.name,
			   description = excluded.description,
			   image_name = excluded.image_name,
			   price = excluded.price,
			   has_dynamic_price = excluded.has_dynamic_price,
			   minimum_dynamic_price = excluded.minimum_dynamic_price,
			   maximum_dynamic_price = excluded.maximum_dynamic_price,
			   max_num_purchases_per_player = excluded.max_num_purchases_per_player,
			   max_count_per_purchase = excluded.max_count_per_purchase,
			   item_mappings = excluded.item_mappings,
			   price_unit_id = excluded.price_unit_id,
			   allow_rename = excluded.allow_rename,
			   visibility = excluded.visibility,
			   is_giftable = excluded.is_giftable,
			   modified_at = excluded.modified_at
			 RETURNING ${OFFER_COLUMNS}`
		)
		.bind(
			originId,
			offer.RoomId,
			offer.Name,
			offer.Description,
			offer.ImageName,
			offer.Price,
			offer.HasDynamicPrice ? 1 : 0,
			offer.MinimumDynamicPrice,
			offer.MaximumDynamicPrice,
			offer.MaxNumPurchasesPerPlayer,
			offer.MaxCountPerPurchase,
			JSON.stringify(offer.ItemMappings),
			JSON.stringify(offer.PriceUnitId ?? null),
			offer.AllowRename ? 1 : 0,
			offer.Visibility,
			offer.IsGiftable ? 1 : 0,
			now
		)
		.first<OfferRow>()
	return toOffer(row!)
}
