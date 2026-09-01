/**
 * Room invites on the shared `recflare` D1 database — one row per game invite a player
 * sends another ("come join me in this room"), as `POST /invite` on the `match` worker
 * creates them.
 *
 * The invite that reaches the invitee is a live notification, not a row: `match` pushes a
 * `MessageReceived` frame the moment the invite is created, and the client renders the join
 * prompt straight off it. This table exists so the invite has an ID OF ITS OWN —
 * `RoomInviteId`, which the create response hands back — and so an invite can be looked up
 * or expired after the fact rather than vanishing with the socket frame.
 *
 * The `match` worker owns this schema/migration
 * (`apps/match/migrations/0001_room_invite.sql`, applied under its own `migrations_table`
 * so it doesn't clash with the other workers' migrations that share the database).
 * `ROOM_INVITE_SCHEMA_DDL` mirrors that migration so tests can build the table directly.
 */

/** Schema DDL (mirror of apps/match/migrations/0001_room_invite.sql). */
export const ROOM_INVITE_SCHEMA_DDL: string[] = [
	// `room_invite_id` is AUTOINCREMENT rather than a bare rowid alias: the id is handed to
	// the client, and expiring old invites deletes rows, so a reused id would point a
	// client's stale invite at somebody else's.
	//
	// `room_id` is nullable because the invite is: the caller names a room INSTANCE, and one
	// that has already died (or was never real) leaves the invite with nothing to resolve —
	// `match` sends it anyway, with a null RoomId, so the row records the same thing.
	//
	// `created_at` is epoch SECONDS, like `presence.expires_at` on the same database and for
	// the same reason: the sweep that will expire these compares it against `Date.now()/1000`
	// in SQL, and an integer compare needs no parsing. Indexed for that sweep.
	`CREATE TABLE IF NOT EXISTS room_invite (
		room_invite_id INTEGER PRIMARY KEY AUTOINCREMENT,
		from_player_id INTEGER NOT NULL,
		to_player_id INTEGER NOT NULL,
		room_id INTEGER,
		created_at INTEGER NOT NULL
	)`,
	`CREATE INDEX IF NOT EXISTS idx_room_invite_created ON room_invite (created_at)`,
]

/**
 * One invite as the client reads it — PascalCase, and the whole of what `POST /invite`
 * answers with.
 */
export interface RoomInvite {
	RoomInviteId: number
	FromPlayerId: number
	ToPlayerId: number
	RoomId: number | null
}

interface RoomInviteRow {
	room_invite_id: number
	from_player_id: number
	to_player_id: number
	room_id: number | null
}

const SELECT_COLUMNS = `room_invite_id, from_player_id, to_player_id, room_id`

const nowSeconds = () => Math.floor(Date.now() / 1000)

/**
 * One invite by its id, or null when there is no such row.
 *
 * Null covers BOTH "never existed" and "already expired" — the sweep deletes expired rows
 * rather than flagging them, and {@link ROOM_INVITE_SCHEMA_DDL} keeps ids from being
 * reused, so a lookup that misses is an invite that is no longer good either way.
 */
export async function getRoomInvite(
	db: D1Database,
	roomInviteId: number
): Promise<RoomInvite | null> {
	const row = await db
		.prepare(`SELECT ${SELECT_COLUMNS} FROM room_invite WHERE room_invite_id = ?1`)
		.bind(roomInviteId)
		.first<RoomInviteRow>()

	if (!row) return null
	return {
		RoomInviteId: row.room_invite_id,
		FromPlayerId: row.from_player_id,
		ToPlayerId: row.to_player_id,
		RoomId: row.room_id,
	}
}

/**
 * The newest live invite from `fromPlayerId` to `toPlayerId`, or null when none stands.
 *
 * This is the by-PLAYER-pair lookup behind `POST /matchmake/v2/player/:playerId`, where
 * the caller redeems "an invite from that player" without holding a `RoomInviteId` (the
 * newer client's invite frame doesn't always carry a usable one). Newest by id — ids are
 * AUTOINCREMENT, so the largest is the most recently sent — and, like
 * {@link getRoomInvite}, a miss covers both "never invited" and "already swept".
 */
export async function getLatestRoomInviteBetween(
	db: D1Database,
	fromPlayerId: number,
	toPlayerId: number
): Promise<RoomInvite | null> {
	const row = await db
		.prepare(
			`SELECT ${SELECT_COLUMNS} FROM room_invite
			 WHERE from_player_id = ?1 AND to_player_id = ?2
			 ORDER BY room_invite_id DESC LIMIT 1`
		)
		.bind(fromPlayerId, toPlayerId)
		.first<RoomInviteRow>()

	if (!row) return null
	return {
		RoomInviteId: row.room_invite_id,
		FromPlayerId: row.from_player_id,
		ToPlayerId: row.to_player_id,
		RoomId: row.room_id,
	}
}

/**
 * Record an invite from `fromPlayerId` to `toPlayerId` for a room, returning it as the
 * client reads it back. `roomId` is null when the caller's room instance didn't resolve.
 *
 * The caller still has to deliver the invite (the `MessageReceived` frame); this only
 * mints the row and its id.
 */
export async function createRoomInvite(
	db: D1Database,
	fromPlayerId: number,
	toPlayerId: number,
	roomId: number | null
): Promise<RoomInvite | null> {
	const row = await db
		.prepare(
			`INSERT INTO room_invite (from_player_id, to_player_id, room_id, created_at)
			 VALUES (?1, ?2, ?3, ?4)
			 RETURNING ${SELECT_COLUMNS}`
		)
		.bind(fromPlayerId, toPlayerId, roomId, nowSeconds())
		.first<RoomInviteRow>()

	if (!row) return null
	return {
		RoomInviteId: row.room_invite_id,
		FromPlayerId: row.from_player_id,
		ToPlayerId: row.to_player_id,
		RoomId: row.room_id,
	}
}
