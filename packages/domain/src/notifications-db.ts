/**
 * Stored notifications on the shared `recflare` D1 database — one row per notification a
 * player has been sent, as `GET /api/messages/v2/get` serves them back on login.
 *
 * A notification is a WebSocket push, and this table is the delayed half of one. The live
 * half is the `MessageReceived` frame the hub pushes, and for a long time it was the ONLY
 * half: the inbox endpoint answered an empty list unconditionally, so anything sent to an
 * offline player existed solely as a queued frame in the hub's Durable Object. That queue is
 * best-effort by construction — dropped once sent rather than acked, bounded per player, and
 * skipped entirely whenever the hub believes it delivered (a socket the client has already
 * abandoned still counts as a delivery) — so a push could be lost with nothing left to show
 * it ever existed. A row here outlives all of that: the player reads it on next login
 * whether or not the socket ever carried it.
 *
 * The two halves are tied together by the ID. A stored notification's `Id` is the id carried
 * on the frame that delivers it, so the client can recognise the push it received as the one
 * it then reads from the inbox, and `POST /api/messages/v3/delete` has an id to match. A
 * sender therefore WRITES THE ROW FIRST and builds its frame from the returned record —
 * never the other way round, and never with an id of its own invention.
 *
 * Not everything pushed belongs here. Only what is still worth reading LATER: a direct
 * message, a room-role invite, a coach message to one player. A broadcast (a maintenance
 * notice to everyone online at once) would be a row per player for something nobody re-reads;
 * a vote-to-kick prompt is about a session that has since ended; a cheer already has its
 * durable record in the `reputation` counters.
 *
 * The table is `notification`, NOT `message`: the `chat` worker already owns a `message`
 * table on this same shared database (its thread posts, a different thing entirely). The two
 * were distinguishable only by name, and `CREATE TABLE IF NOT EXISTS` against a name that is
 * already taken does nothing and says nothing — so the first version of this migration
 * quietly adopted chat's table and failed only one statement later, on an index naming a
 * column that table doesn't have. Every worker here shares one database; check a table name
 * against the whole repo before taking it.
 *
 * The `api` worker owns this schema/migration (`apps/api/migrations/0019_notification.sql`,
 * applied under its own `migrations_table` so it doesn't clash with the other workers'
 * migrations that share the database). `NOTIFICATION_SCHEMA_DDL` mirrors that migration so
 * tests can build the table directly.
 */

/**
 * How many stored notifications one player keeps, newest-wins.
 *
 * Bounded for the same reason the hub's pending queue is: an inbox nothing ever deletes grows
 * with every notification the server sends, and the read then loads the lot. The client shows
 * an inbox rather than an archive, and a player returning to a screenful of them is served no
 * better by the one below it.
 */
export const MAX_NOTIFICATIONS_PER_PLAYER = 20

/** Schema DDL (mirror of apps/api/migrations/0019_notification.sql). */
export const NOTIFICATION_SCHEMA_DDL: string[] = [
	// `notification_id` is AUTOINCREMENT rather than a bare rowid alias: it is handed to the
	// client (on the frame and in the inbox) and deleting a notification frees its rowid, so a
	// reused id would point a client's stale row at somebody else's.
	//
	// `data` is nullable because a Message's `Data` is: the types that carry no payload of
	// their own send null, distinct from the empty string a DM sends. Where it is set it is
	// always a STRING, whatever it means to that type (a room-role invite puts the offered
	// role tier in it). `room_id`/`player_event_id` are the optional context a notification
	// can name.
	//
	// `sent_time` is an ISO-8601 UTC string, which is fixed-width and so orders correctly
	// under SQLite's plain string comparison — though reads order by `notification_id`, which
	// is monotonic and doesn't tie when two land in the same millisecond.
	`CREATE TABLE IF NOT EXISTS notification (
		notification_id INTEGER PRIMARY KEY AUTOINCREMENT,
		from_player_id INTEGER NOT NULL,
		to_player_id INTEGER NOT NULL,
		type INTEGER NOT NULL,
		data TEXT,
		room_id INTEGER,
		player_event_id INTEGER,
		sent_time TEXT NOT NULL
	)`,
	// The inbox read and the newest-wins trim are both "this player's notifications, newest
	// first", which is the whole access pattern.
	`CREATE INDEX IF NOT EXISTS idx_notification_recipient ON notification (to_player_id, notification_id DESC)`,
	// The send burst limit counts one sender's recent rows (see `countRecentNotificationsFrom`).
	`CREATE INDEX IF NOT EXISTS idx_notification_sender ON notification (from_player_id, sent_time)`,
]

/**
 * One stored notification, in the shape the client reads it — the client's Message model,
 * which is also what the `MessageReceived` frame carries (see the `notify` worker's
 * `MessageReceivedPayload`). Same shape in the inbox and on the wire, deliberately: they are
 * one notification delivered two ways, and the client parses it with the same decoder either
 * way. Hence `Id` here rather than a spelled-out `NotificationId` — the field names belong to
 * the client, not to this table.
 */
export interface StoredNotification {
	Id: number
	FromPlayerId: number
	ToPlayerId: number
	/** ISO-8601 UTC. */
	SentTime: string
	Type: number
	Data: string | null
	RoomId: number | null
	PlayerEventId: number | null
}

/** What a sender supplies; the rest of a {@link StoredNotification} is minted here. */
export interface NewNotification {
	FromPlayerId: number
	ToPlayerId: number
	Type: number
	Data?: string | null
	RoomId?: number | null
	PlayerEventId?: number | null
}

interface NotificationRow {
	notification_id: number
	from_player_id: number
	to_player_id: number
	type: number
	data: string | null
	room_id: number | null
	player_event_id: number | null
	sent_time: string
}

const SELECT_COLUMNS = `notification_id, from_player_id, to_player_id, type, data, room_id, player_event_id, sent_time`

const toNotification = (row: NotificationRow): StoredNotification => ({
	Id: row.notification_id,
	FromPlayerId: row.from_player_id,
	ToPlayerId: row.to_player_id,
	SentTime: row.sent_time,
	Type: row.type,
	Data: row.data,
	RoomId: row.room_id,
	PlayerEventId: row.player_event_id,
})

/**
 * Store one notification and return it as the client reads it — including the `Id` the caller
 * must then put on the `MessageReceived` frame it pushes.
 *
 * Trims the recipient's inbox to {@link MAX_NOTIFICATIONS_PER_PLAYER} on the way, oldest
 * first, so the bound holds no matter how the inbox got long. Both statements go in one
 * batch: they are one logical write, and an insert whose trim didn't run would leave the
 * inbox over its bound until the next notification happened along.
 */
export async function createNotification(
	db: D1Database,
	notification: NewNotification
): Promise<StoredNotification> {
	const [inserted] = await db.batch<NotificationRow>([
		db
			.prepare(
				`INSERT INTO notification (from_player_id, to_player_id, type, data, room_id, player_event_id, sent_time)
				 VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)
				 RETURNING ${SELECT_COLUMNS}`
			)
			.bind(
				notification.FromPlayerId,
				notification.ToPlayerId,
				notification.Type,
				notification.Data ?? null,
				notification.RoomId ?? null,
				notification.PlayerEventId ?? null,
				new Date().toISOString()
			),
		db
			.prepare(
				`DELETE FROM notification
				 WHERE to_player_id = ?1 AND notification_id NOT IN (
				   SELECT notification_id FROM notification WHERE to_player_id = ?1
				   ORDER BY notification_id DESC LIMIT ?2
				 )`
			)
			.bind(notification.ToPlayerId, MAX_NOTIFICATIONS_PER_PLAYER),
	])

	return toNotification(inserted.results[0])
}

/**
 * How many notifications of the given `types` a player has sent since `since` — what the
 * message send's burst limit counts, read off `sent_time` rather than a counter of its own.
 *
 * A LOWER bound, not an exact count: a row is gone once its recipient deletes it or their
 * inbox trims it. The trim keeps a recipient's newest {@link MAX_NOTIFICATIONS_PER_PLAYER},
 * so a burst aimed at one player still leaves that many of its rows standing — a limit at
 * or below that number cannot be dodged by flooding a single inbox.
 */
export async function countRecentNotificationsFrom(
	db: D1Database,
	fromPlayerId: number,
	types: readonly number[],
	since: Date
): Promise<number> {
	if (types.length === 0) return 0
	const placeholders = types.map((_, i) => `?${i + 3}`).join(', ')
	const row = await db
		.prepare(
			`SELECT COUNT(*) AS n FROM notification
			 WHERE from_player_id = ?1 AND sent_time > ?2 AND type IN (${placeholders})`
		)
		.bind(fromPlayerId, since.toISOString(), ...types)
		.first<{ n: number }>()
	return row?.n ?? 0
}

/**
 * A player's inbox, newest first — everything sent TO them that they haven't deleted.
 *
 * Newest first because the client renders the list in the order it is given and the recent
 * ones are what is still worth acting on. Ordered by `notification_id` rather than
 * `sent_time`: ids are monotonic, so two that land in the same millisecond still have a
 * definite order.
 */
export async function getNotificationsForPlayer(
	db: D1Database,
	playerId: number
): Promise<StoredNotification[]> {
	const { results } = await db
		.prepare(
			`SELECT ${SELECT_COLUMNS} FROM notification
			 WHERE to_player_id = ?1 ORDER BY notification_id DESC LIMIT ?2`
		)
		.bind(playerId, MAX_NOTIFICATIONS_PER_PLAYER)
		.all<NotificationRow>()

	return results.map(toNotification)
}

/**
 * Delete notifications from one player's inbox, returning how many rows went.
 *
 * Scoped to the recipient, not just the ids: an id names a notification globally, so deleting
 * on id alone would let anyone holding one clear somebody else's inbox. An id that isn't
 * theirs (or is already gone) simply matches nothing — the client removes its rows locally
 * and re-reads the list either way, so a partial match is not an error.
 */
export async function deleteNotifications(
	db: D1Database,
	playerId: number,
	notificationIds: number[]
): Promise<number> {
	if (notificationIds.length === 0) return 0

	const placeholders = notificationIds.map((_, i) => `?${i + 2}`).join(', ')
	const { results } = await db
		.prepare(
			`DELETE FROM notification
			 WHERE to_player_id = ?1 AND notification_id IN (${placeholders})
			 RETURNING notification_id`
		)
		.bind(playerId, ...notificationIds)
		.all<{ notification_id: number }>()

	return results.length
}
