/**
 * Room inventory items — the things a room DEFINES for its players to hold.
 *
 * Not the room's shop: `room-consumable-db.ts` is what a room sells, and its `room_inventory`
 * table (the name was taken first) is who holds a CONSUMABLE. This is the client's
 * `RoomInventoryItem` family, three tables under one prefix:
 *  - `room_inventory_item` — the DEFINITION: a name, a picture, an icon, a `Properties` blob
 *  - `room_inventory_item_tag` — the room's tags, which a definition names by `TagId`
 *  - `room_inventory_item_player` — how many of an item a player holds
 *
 * The endpoints:
 *  - `POST /econ/roomInventory/room/{roomId}` defines an item (and any `NewTags` it carries)
 *  - `GET  /econ/roomInventory/room/{roomId}` lists a room's definitions
 *  - `PUT  /econ/roomInventory/items/{roomId}/{originId}` edits one
 *  - `DELETE /econ/roomInventory/items/{roomId}/{originId}` removes one, and who holds it
 *  - `GET  /econ/roomInventoryItemTags/room/{roomId}` lists a room's tags
 *  - `GET  /econ/roomInventory/room/{roomId}/player` lists what the caller holds there
 *  - `POST /econ/roomInventory/v2/award` gives the caller some of a room's items
 *
 * This worker (`econ`) owns the tables and their migration — see apps/econ/migrations/0030.
 */

/** Schema DDL — also builds the tables in tests. Mirrors migration 0030. */
export const ROOM_INVENTORY_ITEM_SCHEMA_DDL: string[] = [
	// `origin_id` is a GUID, the client's `OriginId` — how it names the item afterwards, and
	// what a held row points at (`RoomInventoryItemOriginId`).
	//
	// `properties` is a JSON blob the client writes and reads AS A STRING; it is stored and
	// served verbatim and never parsed here. `tag_ids` is a JSON array of
	// `room_inventory_item_tag.tag_id`: the client reads the list back whole and nothing
	// queries by tag, so a link table would buy nothing.
	`CREATE TABLE IF NOT EXISTS room_inventory_item (
		origin_id TEXT PRIMARY KEY,
		room_id INTEGER NOT NULL,
		name TEXT NOT NULL,
		description TEXT NOT NULL,
		image_name TEXT,
		created_at TEXT NOT NULL,
		modified_at TEXT NOT NULL,
		properties TEXT,
		tag_ids TEXT NOT NULL DEFAULT '[]',
		icon_shape INTEGER NOT NULL DEFAULT 0,
		icon_color INTEGER NOT NULL DEFAULT 0
	)`,
	// Every read is "this room's items" — the whole access pattern.
	`CREATE INDEX IF NOT EXISTS idx_room_inventory_item_room ON room_inventory_item (room_id)`,
	// `tag_id` is an AUTOINCREMENT: the client's `TagId` is a long, not a GUID. A tag belongs
	// to one room, and its name is unique there — a `NewTags` entry naming an existing tag
	// resolves to it rather than making a twin.
	`CREATE TABLE IF NOT EXISTS room_inventory_item_tag (
		tag_id INTEGER PRIMARY KEY AUTOINCREMENT,
		room_id INTEGER NOT NULL,
		name TEXT NOT NULL,
		properties TEXT,
		UNIQUE (room_id, name)
	)`,
	// Keyed by ITEM, not by room: the definition already says which room it belongs to (the
	// same reasoning as `room_inventory` and `room_balance`). The served `RoomId` is joined in.
	`CREATE TABLE IF NOT EXISTS room_inventory_item_player (
		account_id INTEGER NOT NULL,
		origin_id TEXT NOT NULL,
		count INTEGER NOT NULL DEFAULT 0,
		concurrency_code TEXT NOT NULL,
		created_at TEXT NOT NULL,
		modified_at TEXT NOT NULL,
		PRIMARY KEY (account_id, origin_id)
	)`,
]

/** A room's tag as the client reads it — `RoomInventoryItemTagDTO`, in its key order. */
export interface RoomInventoryItemTag {
	TagId: number
	Name: string
	/** A JSON blob as a string, verbatim; null when the tag was written with none. */
	Properties: string | null
}

/**
 * An item definition as the client reads it — `RoomInventoryItemDTO`, its 12 keys in order.
 *
 * `NewTags` is an INPUT: the tags a write wants created. It is always present on the way
 * out (the client's parser wants the key) — the tags that write created, on the write's own
 * response, and `[]` on every list read.
 */
export interface RoomInventoryItem {
	OriginId: string
	RoomId: number
	Name: string
	Description: string
	ImageName: string | null
	/** ISO-8601 UTC. */
	CreatedAt: string
	/** ISO-8601 UTC. */
	ModifiedAt: string
	/** A JSON blob as a string, verbatim. */
	Properties: string | null
	TagIds: number[]
	NewTags: RoomInventoryItemTag[]
	/** A byte in the client's model. */
	IconShape: number
	IconColor: number
}

/** What a write supplies; the timestamps are minted here. */
export interface NewRoomInventoryItem {
	RoomId: number
	Name: string
	Description: string
	ImageName: string | null
	Properties: string | null
	/** Existing tags to attach. Ids that are not this room's tags are dropped. */
	TagIds: number[]
	/** Tags to create (or resolve by name) in the room and attach. */
	NewTags: Array<{ Name: string; Properties: string | null }>
	IconShape: number
	IconColor: number
}

/** What a player holds of one item — `PlayerRoomInventoryItemDTO`, in its key order. */
export interface PlayerRoomInventoryItem {
	RoomId: number
	RoomInventoryItemOriginId: string
	Count: number
	ConcurrencyCode: string
	/** ISO-8601 UTC. */
	CreatedAt: string
	/** ISO-8601 UTC. */
	ModifiedAt: string
}

interface ItemRow {
	origin_id: string
	room_id: number
	name: string
	description: string
	image_name: string | null
	created_at: string
	modified_at: string
	properties: string | null
	tag_ids: string
	icon_shape: number
	icon_color: number
}

interface TagRow {
	tag_id: number
	name: string
	properties: string | null
}

const ITEM_COLUMNS = `origin_id, room_id, name, description, image_name, created_at, modified_at, properties, tag_ids, icon_shape, icon_color`

function parseTagIds(raw: string): number[] {
	try {
		const ids: unknown = JSON.parse(raw)
		return Array.isArray(ids) ? ids.filter((id): id is number => Number.isInteger(id)) : []
	} catch {
		return []
	}
}

const toItem = (row: ItemRow, newTags: RoomInventoryItemTag[] = []): RoomInventoryItem => ({
	OriginId: row.origin_id,
	RoomId: row.room_id,
	Name: row.name,
	Description: row.description,
	ImageName: row.image_name,
	CreatedAt: row.created_at,
	ModifiedAt: row.modified_at,
	Properties: row.properties,
	TagIds: parseTagIds(row.tag_ids),
	NewTags: newTags,
	IconShape: row.icon_shape,
	IconColor: row.icon_color,
})

const toTag = (row: TagRow): RoomInventoryItemTag => ({
	TagId: row.tag_id,
	Name: row.name,
	Properties: row.properties,
})

/** One definition by its id, or null when there is no such row. */
export async function getRoomInventoryItem(
	db: D1Database,
	originId: string
): Promise<RoomInventoryItem | null> {
	const row = await db
		.prepare(`SELECT ${ITEM_COLUMNS} FROM room_inventory_item WHERE origin_id = ?1`)
		.bind(originId)
		.first<ItemRow>()
	return row ? toItem(row) : null
}

/** Every item a room defines, oldest first. Always an array. */
export async function getRoomInventoryItems(
	db: D1Database,
	roomId: number
): Promise<RoomInventoryItem[]> {
	const { results } = await db
		.prepare(
			`SELECT ${ITEM_COLUMNS} FROM room_inventory_item
			 WHERE room_id = ?1 ORDER BY created_at, origin_id`
		)
		.bind(roomId)
		.all<ItemRow>()
	return results.map((row) => toItem(row))
}

/** Every tag a room has, oldest first. Always an array. */
export async function getRoomInventoryItemTags(
	db: D1Database,
	roomId: number
): Promise<RoomInventoryItemTag[]> {
	const { results } = await db
		.prepare(
			`SELECT tag_id, name, properties FROM room_inventory_item_tag
			 WHERE room_id = ?1 ORDER BY tag_id`
		)
		.bind(roomId)
		.all<TagRow>()
	return results.map(toTag)
}

/**
 * Define an item, or replace the definition `originId` already names. The caller has
 * checked that an existing `originId` belongs to `item.RoomId`; a replace keeps the item's
 * `CreatedAt` and never moves it between rooms.
 *
 * `NewTags` are created in the room first — an entry naming a tag the room already has
 * resolves to that tag, untouched — and their ids are attached after the `TagIds` the write
 * named, which are filtered down to tags that are really this room's. The returned item
 * carries the tags this write asked for as `NewTags`, now with their ids.
 */
export async function upsertRoomInventoryItem(
	db: D1Database,
	originId: string,
	item: NewRoomInventoryItem
): Promise<RoomInventoryItem> {
	const newTags: RoomInventoryItemTag[] = []
	for (const tag of item.NewTags) {
		if (newTags.some((t) => t.Name === tag.Name)) continue
		const [, found] = await db.batch<TagRow>([
			db
				.prepare(
					`INSERT OR IGNORE INTO room_inventory_item_tag (room_id, name, properties)
					 VALUES (?1, ?2, ?3)`
				)
				.bind(item.RoomId, tag.Name, tag.Properties),
			db
				.prepare(
					`SELECT tag_id, name, properties FROM room_inventory_item_tag
					 WHERE room_id = ?1 AND name = ?2`
				)
				.bind(item.RoomId, tag.Name),
		])
		if (found.results[0]) newTags.push(toTag(found.results[0]))
	}

	const roomTagIds = new Set(
		(await getRoomInventoryItemTags(db, item.RoomId)).map((tag) => tag.TagId)
	)
	const tagIds = [
		...new Set([...item.TagIds.filter((id) => roomTagIds.has(id)), ...newTags.map((t) => t.TagId)]),
	]

	const now = new Date().toISOString()
	const row = await db
		.prepare(
			`INSERT INTO room_inventory_item (${ITEM_COLUMNS})
			 VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?6, ?7, ?8, ?9, ?10)
			 ON CONFLICT (origin_id) DO UPDATE SET
			   name = excluded.name,
			   description = excluded.description,
			   image_name = excluded.image_name,
			   modified_at = excluded.modified_at,
			   properties = excluded.properties,
			   tag_ids = excluded.tag_ids,
			   icon_shape = excluded.icon_shape,
			   icon_color = excluded.icon_color
			 RETURNING ${ITEM_COLUMNS}`
		)
		.bind(
			originId,
			item.RoomId,
			item.Name,
			item.Description,
			item.ImageName,
			now,
			item.Properties,
			JSON.stringify(tagIds),
			item.IconShape,
			item.IconColor
		)
		.first<ItemRow>()

	return toItem(row!, newTags)
}

/**
 * Remove a room's item definition, and with it what every player holds of it — a held row
 * naming nothing would never be served again, only kept. Scoped to `roomId`: an id that is
 * another room's item deletes nothing. The room's tags are left alone; other items may name
 * them. Answers whether a definition was removed.
 */
export async function deleteRoomInventoryItem(
	db: D1Database,
	roomId: number,
	originId: string
): Promise<boolean> {
	const [, removed] = await db.batch([
		db
			.prepare(
				`DELETE FROM room_inventory_item_player
				 WHERE origin_id IN
				   (SELECT origin_id FROM room_inventory_item WHERE origin_id = ?1 AND room_id = ?2)`
			)
			.bind(originId, roomId),
		db
			.prepare('DELETE FROM room_inventory_item WHERE origin_id = ?1 AND room_id = ?2')
			.bind(originId, roomId),
	])
	return removed.meta.changes > 0
}

/**
 * Give a player some of an item, returning what they hold afterwards — or null when
 * `originId` is not an item `roomId` defines (nothing is written: a held row naming nothing
 * could never be described).
 *
 * `Count` is the RESULTING total, never the change, floored at zero in the statement itself
 * so a negative `quantity` takes away without racing below zero. `concurrencyCode` is the
 * request's `NewConcurrencyCode`, stored to be served back; it is not checked against
 * anything. `CreatedAt` is the first award's time and survives later ones. Read back rather
 * than taken from a `RETURNING`, as `awardRoomConsumable` is; the batch is one transaction.
 */
export async function awardRoomInventoryItem(
	db: D1Database,
	accountId: number,
	roomId: number,
	originId: string,
	quantity: number,
	concurrencyCode: string
): Promise<PlayerRoomInventoryItem | null> {
	const [, after] = await db.batch<{
		count: number
		concurrency_code: string
		created_at: string
		modified_at: string
	}>([
		db
			.prepare(
				`INSERT INTO room_inventory_item_player
				   (account_id, origin_id, count, concurrency_code, created_at, modified_at)
				 SELECT ?1, origin_id, MAX(0, ?4), ?5, ?6, ?6
				 FROM room_inventory_item WHERE origin_id = ?2 AND room_id = ?3
				 ON CONFLICT (account_id, origin_id) DO UPDATE SET
				   count = MAX(0, room_inventory_item_player.count + ?4),
				   concurrency_code = ?5,
				   modified_at = ?6`
			)
			.bind(accountId, originId, roomId, quantity, concurrencyCode, new Date().toISOString()),
		db
			.prepare(
				`SELECT p.count, p.concurrency_code, p.created_at, p.modified_at
				 FROM room_inventory_item_player p
				 JOIN room_inventory_item i ON i.origin_id = p.origin_id
				 WHERE p.account_id = ?1 AND p.origin_id = ?2 AND i.room_id = ?3`
			)
			.bind(accountId, originId, roomId),
	])

	const row = after.results[0]
	if (!row) return null
	return {
		RoomId: roomId,
		RoomInventoryItemOriginId: originId,
		Count: row.count,
		ConcurrencyCode: row.concurrency_code,
		CreatedAt: row.created_at,
		ModifiedAt: row.modified_at,
	}
}

/**
 * What `accountId` holds of a room's items, in the order the room defined them. A row whose
 * definition is gone is not served — a held item that cannot be described. Always an array.
 */
export async function getPlayerRoomInventoryItems(
	db: D1Database,
	roomId: number,
	accountId: number
): Promise<PlayerRoomInventoryItem[]> {
	const { results } = await db
		.prepare(
			`SELECT i.room_id, p.origin_id, p.count, p.concurrency_code, p.created_at, p.modified_at
			 FROM room_inventory_item_player p
			 JOIN room_inventory_item i ON i.origin_id = p.origin_id
			 WHERE i.room_id = ?1 AND p.account_id = ?2
			 ORDER BY i.created_at, i.origin_id`
		)
		.bind(roomId, accountId)
		.all<{
			room_id: number
			origin_id: string
			count: number
			concurrency_code: string
			created_at: string
			modified_at: string
		}>()
	return results.map((row) => ({
		RoomId: row.room_id,
		RoomInventoryItemOriginId: row.origin_id,
		Count: row.count,
		ConcurrencyCode: row.concurrency_code,
		CreatedAt: row.created_at,
		ModifiedAt: row.modified_at,
	}))
}
