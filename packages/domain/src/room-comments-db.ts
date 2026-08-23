/**
 * Room comments on the shared `recflare` D1 database — the notes a player leaves pinned in
 * a room's scene, which everyone standing in that subroom sees floating at the position
 * they were dropped.
 *
 * Columns rather than a JSON blob (the `club_announcement` pattern rather than the
 * `room`/`club` one): a comment is six scalars and a point, none of it a client-shaped
 * document that has to survive round-tripping, and the room/subroom pair has to be
 * queryable.
 *
 * The `roomcomments` worker owns this schema/migration
 * (`apps/roomcomments/migrations/0001_room_comment.sql`, applied under its own
 * `migrations_table` so it doesn't clash with the other workers' migrations that share the
 * database). `ROOM_COMMENT_SCHEMA_DDL` mirrors that migration so tests can build the table
 * directly.
 */

/** Schema DDL (mirror of apps/roomcomments/migrations/0001_room_comment.sql). */
export const ROOM_COMMENT_SCHEMA_DDL: string[] = [
	// `comment_id` is an ordinary autoincrement integer, and it is the CURSOR the read
	// endpoint pages on (`?minId=`), so it has to be monotonic per insert. AUTOINCREMENT
	// rather than a bare rowid alias for exactly that reason: a deleted comment's id must
	// never be handed out again, or a client polling with `minId` would skip the comment
	// that reused it.
	//
	// The position is three REALs, not the strings the form body carries. The client posts a
	// C# float's shortest round-trip text (`positionX=-0.4979804`) but reads the response
	// back as a NUMBER — `"PositionX": "1.5"` fails its parser — and a float64 holds those
	// 7-9 significant digits exactly, so the text that arrives is the text that goes back out.
	`CREATE TABLE IF NOT EXISTS room_comment (
		comment_id INTEGER PRIMARY KEY AUTOINCREMENT,
		room_id INTEGER NOT NULL,
		subroom_id INTEGER NOT NULL,
		player_id INTEGER NOT NULL,
		style INTEGER NOT NULL DEFAULT 0,
		message TEXT NOT NULL DEFAULT '',
		position_x REAL NOT NULL DEFAULT 0,
		position_y REAL NOT NULL DEFAULT 0,
		position_z REAL NOT NULL DEFAULT 0,
		created_at TEXT NOT NULL
	)`,
	// The read is always "this room, newer than this id, newest first" — one index covers
	// the filter and the ordering together.
	`CREATE INDEX IF NOT EXISTS idx_room_comment_room ON room_comment (room_id, comment_id)`,
]

/**
 * One comment as the client parses it. PascalCase, and `PositionX/Y/Z` are NUMBERS even
 * though the create body posts them as text.
 *
 * `Unread` is always TRUE. It is not a stored column and it is NOT derived from who is
 * reading: the reference answers `Unread: true` on the create response too, for the
 * author's own brand-new comment, so it can't be "unread by this viewer". It is read state
 * that only something marking comments read could ever clear, and nothing here does — so
 * every comment is unread, to everyone, always. Deriving it from authorship instead would
 * make the author's own comments read, which is the one case the reference is known to
 * answer `true` for.
 */
export interface RoomComment {
	CommentId: number
	RoomId: number
	SubRoomId: number
	AccountId: number
	CreatedAt: string
	Message: string
	Style: number
	Unread: boolean
	PositionX: number
	PositionY: number
	PositionZ: number
}

interface RoomCommentRow {
	comment_id: number
	room_id: number
	subroom_id: number
	player_id: number
	style: number
	message: string
	position_x: number
	position_y: number
	position_z: number
	created_at: string
}

/** A stored row as the client-facing comment. */
function toRoomComment(row: RoomCommentRow): RoomComment {
	return {
		CommentId: row.comment_id,
		RoomId: row.room_id,
		SubRoomId: row.subroom_id,
		AccountId: row.player_id,
		CreatedAt: row.created_at,
		Message: row.message,
		Style: row.style,
		// Always true — see RoomComment. Nothing marks a comment read.
		Unread: true,
		PositionX: row.position_x,
		PositionY: row.position_y,
		PositionZ: row.position_z,
	}
}

const SELECT_COLUMNS = `comment_id, room_id, subroom_id, player_id, style, message,
	 position_x, position_y, position_z, created_at`

/** How many comments a read serves when the request names no `count`, and the ceiling. */
export const DEFAULT_COMMENT_COUNT = 100
const MAX_COMMENT_COUNT = 500

/** Clamp a requested `count` into `[1, MAX_COMMENT_COUNT]`; anything unparseable is the default. */
export function clampCommentCount(count: number | null): number {
	if (count === null || !Number.isFinite(count)) return DEFAULT_COMMENT_COUNT
	return Math.min(Math.max(Math.trunc(count), 1), MAX_COMMENT_COUNT)
}

/**
 * A room's comments, newest first — the `GET /comments/get/:roomId` read.
 *
 * `minId` is an EXCLUSIVE cursor, which is why the client's "give me everything" sentinel
 * is `-1` rather than `0`: a client that holds comments up to id N polls with `minId=N` and
 * gets only what was written since. Newest-first, so a fresh client asking for 100 out of a
 * room with thousands gets the 100 that are actually on the wall rather than the oldest
 * hundred.
 *
 * `subRoomId` narrows to one subroom when given; the client asks for the whole room and
 * sorts them out itself, so it is normally null. An unknown room simply has no comments.
 */
export async function getRoomComments(
	db: D1Database,
	roomId: number,
	opts: { count?: number; minId?: number; subRoomId?: number | null } = {}
): Promise<RoomComment[]> {
	const count = clampCommentCount(opts.count ?? null)
	const minId = Number.isFinite(opts.minId) ? (opts.minId as number) : -1
	const subRoomId = opts.subRoomId ?? null

	const { results } = await db
		.prepare(
			`SELECT ${SELECT_COLUMNS}
			 FROM room_comment
			 WHERE room_id = ?1 AND comment_id > ?2 AND (?3 IS NULL OR subroom_id = ?3)
			 ORDER BY comment_id DESC
			 LIMIT ?4`
		)
		.bind(roomId, minId, subRoomId, count)
		.all<RoomCommentRow>()

	return results.map(toRoomComment)
}

/**
 * Leave a comment in a room, returning it as the client reads it back — the create
 * response is the new comment itself, so the client can render the bubble it just placed
 * without re-fetching the list.
 *
 * That response carries `Unread: true` like every other, the author's own included; it is
 * read state, not a per-viewer flag (see `RoomComment`).
 */
export async function createRoomComment(
	db: D1Database,
	roomId: number,
	playerId: number,
	fields: {
		subRoomId: number
		message: string
		style?: number
		positionX?: number
		positionY?: number
		positionZ?: number
	}
): Promise<RoomComment | null> {
	const row = await db
		.prepare(
			`INSERT INTO room_comment (room_id, subroom_id, player_id, style, message,
				position_x, position_y, position_z, created_at)
			 VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)
			 RETURNING ${SELECT_COLUMNS}`
		)
		.bind(
			roomId,
			fields.subRoomId,
			playerId,
			fields.style ?? 0,
			fields.message,
			fields.positionX ?? 0,
			fields.positionY ?? 0,
			fields.positionZ ?? 0,
			new Date().toISOString()
		)
		.first<RoomCommentRow>()

	return row ? toRoomComment(row) : null
}
