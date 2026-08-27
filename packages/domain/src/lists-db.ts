/**
 * Player-owned curated lists on the shared `recflare` D1 database — the playlists a player
 * builds themselves, of which "Saved for Later" is the one the client creates on its own.
 *
 * Columns rather than a JSON blob (the `club_announcement` pattern rather than the
 * `room`/`club` one): nothing here is a client-shaped document that has to survive
 * round-tripping, it is five scalars and a set of ids, and the ids need their own table to
 * be queried and de-duplicated at all.
 *
 * A list is GENERIC. `list_type` says what the `item_id`s ARE — the `ListEntityType` the
 * algorithmic lists echo, so `1` is Rooms and an `item_id` is a room id — and nothing here
 * interprets them: the client resolves each id against the service that type names. That is
 * also why `item_id` is TEXT rather than an integer. A list of rooms carries room ids, but a
 * list of discovery sections carries section KEYS, and one column has to hold both.
 *
 * The `lists` worker owns this schema/migration (`apps/lists/migrations/0001_curated_list.sql`,
 * applied under its own `migrations_table` so it doesn't clash with the other workers'
 * migrations that share the database). `CURATED_LIST_SCHEMA_DDL` mirrors that migration so
 * tests can build the tables directly.
 */

/** Schema DDL (mirror of apps/lists/migrations/0001_curated_list.sql). */
export const CURATED_LIST_SCHEMA_DDL: string[] = [
	// `list_id` is an ordinary autoincrement integer. The reference's own ids run to 18
	// digits (`624765592684307326`) and the static captures still carry theirs verbatim, but
	// nothing requires a list this server MINTS to look like that — and a small id stays well
	// inside what a JS number holds exactly, so it can't be rounded on its way through D1 or
	// JSON. AUTOINCREMENT rather than a bare rowid alias: a list id is handed to the client,
	// so a deleted list's id must not be handed out again to a different list.
	`CREATE TABLE IF NOT EXISTS list (
		list_id INTEGER PRIMARY KEY AUTOINCREMENT,
		creator_account_id INTEGER NOT NULL,
		list_type INTEGER NOT NULL,
		list_name TEXT NOT NULL,
		list_name_lower TEXT GENERATED ALWAYS AS (lower(list_name)) VIRTUAL,
		list_description TEXT,
		image_name TEXT NOT NULL DEFAULT '',
		accessibility INTEGER NOT NULL DEFAULT 1,
		created_at TEXT NOT NULL
	)`,
	// The lookup the client actually makes: `?creatorAccountId=&type=&name=`, all three at
	// once. UNIQUE because that triple is a list's identity — the client asks for
	// `__SavedForLater_Rooms` by name expecting the one it has been appending to, so a
	// player must never end up with two. Folded, since the casing that reaches us is the
	// client's.
	`CREATE UNIQUE INDEX IF NOT EXISTS idx_list_owner_type_name
		ON list (creator_account_id, list_type, list_name_lower)`,
	`CREATE INDEX IF NOT EXISTS idx_list_creator ON list (creator_account_id)`,
	// A list's contents — one row per item, insertion order preserved by the surrogate key,
	// which is the order the `ItemIds` array is served in.
	//
	// UNIQUE on the pair: saving the same room twice is a no-op, not a carousel showing it
	// twice. The section's own `supportsDedupe` is about dedupe ACROSS rows and doesn't help
	// here.
	`CREATE TABLE IF NOT EXISTS list_item (
		list_item_id INTEGER PRIMARY KEY AUTOINCREMENT,
		list_id INTEGER NOT NULL,
		item_id TEXT NOT NULL
	)`,
	`CREATE UNIQUE INDEX IF NOT EXISTS idx_list_item_pair ON list_item (list_id, item_id)`,
	`CREATE INDEX IF NOT EXISTS idx_list_item_list ON list_item (list_id)`,
]

/**
 * One curated list as the client parses it, whether it came out of D1 or out of a static
 * capture. `Description` may be null, and `ItemIds` are strings even where they stand for
 * numeric ids, which is what the working captures carry.
 *
 * `ImageName` is a STRING on every list the client draws a TILE for — it reads it straight
 * into a string field, and empty or null renders that tile blank. It is nullable only
 * because one capture (`RoomGenreTags`, whose `ItemIds` are genre names rather than rooms)
 * is served with a null, having no tile to draw. A stored list always has a string; don't
 * reach for the null on anything the client renders as a row.
 *
 * `ListId` is a string HERE ONLY and never reaches the client as one: the `lists` worker's
 * `serializeCuratedList` puts the digits back on the wire unquoted, because the client's
 * field is a number and a quoted id fails its parser. It stays a string even though a
 * STORED id is a small integer, because a CAPTURED one is 18 digits — parsing that would
 * round it (…307326 → …307300) — and both kinds flow through this one shape.
 */
export interface CuratedList {
	ListId: string
	CreatorAccountId: number
	Name: string
	Description: string | null
	ImageName: string | null
	Type: number
	ItemIds: string[]
	Accessibility?: number
	CreatedAt: string
}

interface ListRow {
	list_id: number
	creator_account_id: number
	list_type: number
	list_name: string
	list_description: string | null
	image_name: string
	accessibility: number
	created_at: string
}

/**
 * The image a list carries when nothing set one. Every captured list uses it, and the field
 * cannot be empty or null without the client rendering a blank tile for the row.
 */
export const DEFAULT_LIST_IMAGE = 'DefaultRoomImage.jpg'

/** A stored row plus its items, as the client-facing list. */
function toCuratedList(row: ListRow, itemIds: string[]): CuratedList {
	return {
		ListId: String(row.list_id),
		CreatorAccountId: row.creator_account_id,
		Name: row.list_name,
		Description: row.list_description,
		ImageName: row.image_name,
		Type: row.list_type,
		ItemIds: itemIds,
		Accessibility: row.accessibility,
		CreatedAt: row.created_at,
	}
}

/** A list's item ids, in the order they were added — the order the row displays them. */
async function getListItems(db: D1Database, listId: number): Promise<string[]> {
	const { results } = await db
		.prepare('SELECT item_id FROM list_item WHERE list_id = ?1 ORDER BY list_item_id')
		.bind(listId)
		.all<{ item_id: string }>()
	return results.map((r) => r.item_id)
}

/** What identifies a player's list, and what a missing one is created with. */
export interface PlayerListKey {
	creatorAccountId: number
	/** The `ListEntityType` — what the item ids ARE. 1 (Rooms) is what the client sends. */
	type: number
	name: string
	/** Applied only when the list is CREATED; see {@link addPlayerListItem}. */
	accessibility: number
}

/**
 * Add an item to a player's list, creating the list if they don't have one yet — the
 * `…/items/:itemId/createlistifneeded` call the client makes when someone saves a room for
 * later. Answers the list as it now stands, which is what the caller re-renders the row from.
 *
 * Idempotent in both halves. The list insert is `OR IGNORE` against the
 * (creator, type, name) unique index and the id is re-read rather than assumed, so two adds
 * racing to create the same list end up with ONE list and the loser adopts the winner's id
 * instead of silently writing its item into a list nobody will look up. The item insert is
 * `OR IGNORE` against (list_id, item_id), so saving the same room twice leaves the row
 * showing it once, in the position it was first saved into.
 *
 * `accessibility` is honoured only on creation. The client sends it on every add, but this
 * call is "add an item", not "change who can see the list" — applying it each time would let
 * one stray add flip a list the player had deliberately made public, or the reverse.
 */
export async function addPlayerListItem(
	db: D1Database,
	key: PlayerListKey,
	itemId: string
): Promise<CuratedList> {
	await db
		.prepare(
			`INSERT OR IGNORE INTO list (creator_account_id, list_type, list_name,
			                             list_description, image_name, accessibility, created_at)
			 VALUES (?1, ?2, ?3, NULL, ?4, ?5, ?6)`
		)
		.bind(
			key.creatorAccountId,
			key.type,
			key.name,
			DEFAULT_LIST_IMAGE,
			key.accessibility,
			new Date().toISOString()
		)
		.run()

	// Read the id back rather than taking the insert's: `OR IGNORE` assigns nothing when the
	// player already had the list, and says nothing about whether the row is ours.
	const row = await db
		.prepare(
			`SELECT list_id FROM list
			 WHERE creator_account_id = ?1 AND list_type = ?2 AND list_name_lower = lower(?3)`
		)
		.bind(key.creatorAccountId, key.type, key.name)
		.first<{ list_id: number }>()
	const listId = row!.list_id

	await db
		.prepare('INSERT OR IGNORE INTO list_item (list_id, item_id) VALUES (?1, ?2)')
		.bind(listId, itemId)
		.run()

	return (await getPlayerList(db, key.creatorAccountId, key.type, key.name))!
}

/**
 * A player's own list, looked up the way the client asks for one:
 * `?creatorAccountId=&type=&name=`. Undefined when that player has no such list — the
 * caller decides what an absent list answers, since a static capture may cover the name.
 *
 * The name is matched case-insensitively; a list with no items is still a list and comes
 * back with an empty `ItemIds`, which is NOT the same answer as undefined.
 */
export async function getPlayerList(
	db: D1Database,
	creatorAccountId: number,
	type: number,
	name: string
): Promise<CuratedList | undefined> {
	const row = await db
		.prepare(
			`SELECT list_id, creator_account_id, list_type, list_name, list_description,
			        image_name, accessibility, created_at
			 FROM list
			 WHERE creator_account_id = ?1 AND list_type = ?2 AND list_name_lower = lower(?3)`
		)
		.bind(creatorAccountId, type, name)
		.first<ListRow>()
	if (row === null) return undefined
	return toCuratedList(row, await getListItems(db, row.list_id))
}
