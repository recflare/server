/**
 * Room keys — a room's own admission tickets.
 *
 * A creator lists a key for their room: a named, priced thing a player can hold to get
 * through a door the room locks. This module is the LISTING — its name, its price, which room
 * it opens. Nothing sells a key yet, so who holds one is not recorded anywhere. The endpoints:
 *  - `POST /api/roomkeys/v1/create` lists one
 *  - `GET  /api/roomkeys/v1/room?roomId=` lists a room's
 *
 * This worker (`econ`) owns the table and its migrations — see apps/econ/migrations/0024.
 */

/** Schema DDL — also builds the table in tests. Mirrors migration 0024. */
export const ROOM_KEY_SCHEMA_DDL: string[] = [
	// `room_key_id` is an AUTOINCREMENT rather than a GUID, unlike a room currency's: the
	// client's own model names a key by a numeric `RoomKeyId` (see the `notify` worker's
	// `LocalRoomKeyPayload`). `replication_id` is the GUID beside it, minted here.
	//
	// `key_type` is the body's `Type`, stored as the enum NAME it arrives as (`Key`) and served
	// back as the ORDINAL (`Type: 0`) — see {@link ROOM_KEY_TYPE_ORDINALS}. Only `Key` has
	// been observed.
	//
	// `purchase_currency_id` is the `room_currency` the key is charged in — nullable, and the
	// create body names none. `image_name` is '' in the row (NOT NULL), but the client reads
	// `ImageName` as null until a key carries art, so an empty column is served as null.
	`CREATE TABLE IF NOT EXISTS room_key (
		room_key_id INTEGER PRIMARY KEY AUTOINCREMENT,
		replication_id TEXT NOT NULL,
		room_id INTEGER NOT NULL,
		key_type TEXT NOT NULL,
		name TEXT NOT NULL,
		description TEXT NOT NULL,
		price INTEGER NOT NULL,
		purchase_currency_id TEXT,
		image_name TEXT NOT NULL DEFAULT '',
		created_at TEXT NOT NULL
	)`,
	// Every read is "this room's keys" — the whole access pattern.
	`CREATE INDEX IF NOT EXISTS idx_room_key_room ON room_key (room_id)`,
]

/**
 * The `Type` a key is served with: the ordinal of the client's key-type enum, keyed by the
 * NAME the create body posts (`Type=Key`). Only `Key` has been observed; an unrecognised name
 * is stored as posted and served as 0.
 */
export const ROOM_KEY_TYPE_ORDINALS: Readonly<Record<string, number>> = { Key: 0 }

/**
 * A room key as the client reads it — the `RoomKey` inside the create response's
 * `{ Status, RoomKey }`, member for member and in its order (observed from the live client),
 * and the `notify` worker's `LocalRoomKeyPayload`. The create endpoint answers this object and
 * the `LocalRoomKeyCreated` frame carries it, which is why `econ.app.ts` assigns one of these
 * straight to a `LocalRoomKeyPayload`: that assignment is what stops the two drifting apart.
 *
 * `Type` is the body's enum NAME served back as its ORDINAL (`Key` → 0), and `ImageName` is
 * NULL rather than '' until a key can carry art — both as the client sends and reads them.
 */
export interface RoomKey {
	RoomKeyId: number
	ReplicationId: string
	RoomId: number
	Name: string
	Description: string
	Price: number
	/** A `room_currency` id, or null — the create body names none. */
	PurchaseCurrencyId: string | null
	/** ISO-8601 UTC. */
	CreatedAt: string
	/** Null until a key can carry art. */
	ImageName: string | null
	/** The key type's ordinal — 0 `Key`. See {@link ROOM_KEY_TYPE_ORDINALS}. */
	Type: number
}

/** What the create endpoint supplies; the ids and the timestamp are minted here. */
export interface NewRoomKey {
	RoomId: number
	/** The body's `Type`, an enum name (`Key`). Stored verbatim, served as its ordinal. */
	Type: string
	Name: string
	Description: string
	Price: number
}

interface RoomKeyRow {
	room_key_id: number
	replication_id: string
	room_id: number
	key_type: string
	name: string
	description: string
	price: number
	purchase_currency_id: string | null
	image_name: string
	created_at: string
}

const SELECT_COLUMNS = `room_key_id, replication_id, room_id, key_type, name, description, price, purchase_currency_id, image_name, created_at`

const toRoomKey = (row: RoomKeyRow): RoomKey => ({
	RoomKeyId: row.room_key_id,
	ReplicationId: row.replication_id,
	RoomId: row.room_id,
	Name: row.name,
	Description: row.description,
	Price: row.price,
	PurchaseCurrencyId: row.purchase_currency_id,
	CreatedAt: row.created_at,
	ImageName: row.image_name === '' ? null : row.image_name,
	Type: ROOM_KEY_TYPE_ORDINALS[row.key_type] ?? 0,
})

/** List a room key, returning it as the client reads it back. */
export async function createRoomKey(db: D1Database, key: NewRoomKey): Promise<RoomKey> {
	const row = await db
		.prepare(
			`INSERT INTO room_key
			   (replication_id, room_id, key_type, name, description, price, purchase_currency_id, image_name, created_at)
			 VALUES (?1, ?2, ?3, ?4, ?5, ?6, NULL, '', ?7)
			 RETURNING ${SELECT_COLUMNS}`
		)
		.bind(
			crypto.randomUUID(),
			key.RoomId,
			key.Type,
			key.Name,
			key.Description,
			key.Price,
			new Date().toISOString()
		)
		.first<RoomKeyRow>()

	return toRoomKey(row!)
}

/**
 * Every key a room has listed, oldest first — the order its owner built them up in. The
 * autoincrement id IS creation order, so it is the sort key.
 */
export async function getRoomKeys(db: D1Database, roomId: number): Promise<RoomKey[]> {
	const { results } = await db
		.prepare(`SELECT ${SELECT_COLUMNS} FROM room_key WHERE room_id = ?1 ORDER BY room_key_id`)
		.bind(roomId)
		.all<RoomKeyRow>()

	return results.map(toRoomKey)
}
