/**
 * Chat threads and their membership on the shared `recflare` D1 database. A thread is a
 * conversation — a DM pair, a named group chat, or a system thread; the messages in it
 * live in `message` (see message-db.ts).
 *
 * Membership (`thread_member`) does double duty: it is the authorization gate — a
 * player may read or post to a thread only if they hold a row — and it is what renders
 * the `playerIds` array the client shows. Nothing here has a foreign key to accounts,
 * here or on a message's sender: that table belongs to the `auth` worker, and a thread
 * outlives the accounts in it.
 *
 * The thread denormalizes `latest_message_id` so the thread list renders from one
 * indexed row per thread rather than a per-thread MAX() over `message`, and so it can
 * be ordered by recency without a join — message ids are monotonic, so the highest id
 * is the newest thread. `postMessage` keeps it in sync.
 *
 * The per-viewer fields — `lastReadMessageId`, `snoozedUntil`, `isFavorited` — live on
 * the membership row, not the thread: two players in one DM have independent read
 * positions, snoozes, and favorites.
 *
 * The `chat` worker owns this schema/migration (migrations/0002_thread.sql).
 * `THREAD_SCHEMA_DDL` mirrors it so tests can build the tables directly.
 */

import { insertMessage } from './message-db'

import type { ChatMessage, NewChatMessage } from './message-db'

/** Schema DDL (mirror of migrations/0002_thread.sql). */
export const THREAD_SCHEMA_DDL: string[] = [
	`CREATE TABLE IF NOT EXISTS message_thread (
		chat_thread_id INTEGER PRIMARY KEY AUTOINCREMENT,
		chat_thread_name TEXT,
		chat_thread_type INTEGER NOT NULL DEFAULT 0,
		latest_message_id INTEGER,
		created_at TEXT NOT NULL
	)`,
	`CREATE INDEX IF NOT EXISTS idx_message_thread_latest ON message_thread (latest_message_id)`,
	`CREATE TABLE IF NOT EXISTS thread_member (
		chat_thread_id INTEGER NOT NULL,
		player_id INTEGER NOT NULL,
		last_read_message_id INTEGER,
		snoozed_until TEXT,
		is_favorited INTEGER NOT NULL DEFAULT 0,
		PRIMARY KEY (chat_thread_id, player_id)
	)`,
	// The thread-list query is "every thread this player is in", so player_id leads.
	`CREATE INDEX IF NOT EXISTS idx_thread_member_player ON thread_member (player_id)`,
]

/**
 * A thread as the client receives it: the thread, its members, its most recent message,
 * and the viewing player's own read/snooze/favorite state. This is the element shape of
 * the thread-list response.
 */
export interface ChatThread {
	/** Null only for a thread with no messages yet. */
	latestMessage: ChatMessage | null
	chatThreadId: number
	playerIds: number[]
	/**
	 * 0 when the player has never read the thread — never null. The client deserializes
	 * this into a non-nullable int and fails the whole response on a null ("expected
	 * 'Number Token', actual 'null'"), unlike `latestMessage`, which it accepts as null.
	 */
	lastReadMessageId: number
	/**
	 * Empty for DMs and unnamed groups — never null. The client dereferences this name
	 * without a null check (a null NullReferenceExceptions its way out of
	 * GetChatBetweenPlayers) and falls back to naming the members when it's blank.
	 */
	chatThreadName: string
	/**
	 * Which kind of conversation this is — the client's `ChatThreadType`: 0 Player,
	 * 1 Club, 2 Party. Player covers both DMs and group chats; nothing here distinguishes
	 * the two. The field has to be present whatever its value: the client deserializes it
	 * as a non-nullable int and drops the whole response when it's missing.
	 */
	chatThreadType: ChatThreadTypeValue
	snoozedUntil: string | null
	isFavorited: boolean
}

/**
 * The client's `ChatThreadType` enum, stored on the thread and served numerically like
 * every other enum on this build. A plain conversation — DM or group — is `Player`;
 * `Party` is what `POST /thread/party` opens. Nothing here serves `Club` yet: club chat
 * lives in the `clubs` worker, and the member is here so a stored 1 renders as itself
 * rather than being read as a player thread.
 */
export const ChatThreadType = {
	Player: 0,
	Club: 1,
	Party: 2,
} as const

export type ChatThreadTypeValue = (typeof ChatThreadType)[keyof typeof ChatThreadType]

/** The joined row backing a rendered thread, before it's shaped for the client. */
interface ThreadRow {
	chat_thread_id: number
	chat_thread_name: string | null
	chat_thread_type: number
	player_ids: string | null
	last_read_message_id: number | null
	snoozed_until: string | null
	is_favorited: number
	msg_chat_message_id: number | null
	msg_chat_thread_id: number | null
	msg_sender_player_id: number | null
	msg_time_sent: string | null
	msg_contents: string | null
	msg_moderation_state: number | null
}

function toThread(row: ThreadRow): ChatThread {
	return {
		latestMessage:
			row.msg_chat_message_id === null
				? null
				: {
						chatMessageId: row.msg_chat_message_id,
						chatThreadId: row.msg_chat_thread_id!,
						senderPlayerId: row.msg_sender_player_id!,
						timeSent: row.msg_time_sent!,
						contents: row.msg_contents!,
						moderationState: row.msg_moderation_state!,
					},
		chatThreadId: row.chat_thread_id,
		// group_concat of the membership rows, already ordered by player id.
		playerIds: row.player_ids === null ? [] : row.player_ids.split(',').map(Number),
		// Null in the column means "never read"; the client insists on a number.
		lastReadMessageId: row.last_read_message_id ?? 0,
		// Null in the column means "unnamed"; the client dereferences it unchecked.
		chatThreadName: row.chat_thread_name ?? '',
		chatThreadType: row.chat_thread_type as ChatThreadTypeValue,
		snoozedUntil: row.snoozed_until,
		isFavorited: row.is_favorited !== 0,
	}
}

/**
 * The shared projection behind every rendered thread — the list, the single read and the
 * party read. Membership LEADS the join, so it is the authorization check as well as the
 * query: a row only exists for a thread `me` is in. The inner ordered subquery around
 * group_concat is what makes `playerIds` come back sorted rather than in row order.
 *
 * Callers append their own WHERE (and ORDER/LIMIT) and bind `?1` onwards from there.
 */
const THREAD_SELECT = `SELECT
				t.chat_thread_id,
				t.chat_thread_name,
				t.chat_thread_type,
				(SELECT group_concat(player_id) FROM
					(SELECT player_id FROM thread_member WHERE chat_thread_id = t.chat_thread_id
					 ORDER BY player_id)) AS player_ids,
				me.last_read_message_id,
				me.snoozed_until,
				me.is_favorited,
				msg.chat_message_id AS msg_chat_message_id,
				msg.chat_thread_id AS msg_chat_thread_id,
				msg.sender_player_id AS msg_sender_player_id,
				msg.time_sent AS msg_time_sent,
				msg.contents AS msg_contents,
				msg.moderation_state AS msg_moderation_state
			 FROM thread_member me
			 JOIN message_thread t ON t.chat_thread_id = me.chat_thread_id
			 LEFT JOIN message msg ON msg.chat_message_id = t.latest_message_id`

/**
 * The thread list as it renders for one player, newest conversation first — the
 * `?MessageCount=N` page of the thread endpoint.
 *
 * Membership scopes the query — see {@link THREAD_SELECT}.
 */
export async function getThreadsForPlayer(
	db: D1Database,
	playerId: number,
	{ limit = 50 }: { limit?: number } = {}
): Promise<ChatThread[]> {
	const { results } = await db
		.prepare(
			`${THREAD_SELECT}
			 WHERE me.player_id = ?1
			 ORDER BY t.latest_message_id DESC
			 LIMIT ?2`
		)
		.bind(playerId, limit)
		.all<ThreadRow>()
	return results.map(toThread)
}

/** One thread as it renders for one player, or null if they aren't a member of it. */
export async function getThreadForPlayer(
	db: D1Database,
	chatThreadId: number,
	playerId: number
): Promise<ChatThread | null> {
	const row = await db
		.prepare(
			`${THREAD_SELECT}
			 WHERE me.chat_thread_id = ?1 AND me.player_id = ?2`
		)
		.bind(chatThreadId, playerId)
		.first<ThreadRow>()
	return row === null ? null : toThread(row)
}

/**
 * The party a player is already in, or null — the newest party thread carrying a
 * membership row for them, rendered exactly as {@link getThreadForPlayer} renders one.
 *
 * The fast path behind `GET /thread/party`: a player already on a party is answered from
 * ONE D1 query, with no player-settings read at all. `LatestPartyChat` is consulted only
 * when this comes back null — that is, only for a player who has yet to JOIN a party.
 *
 * Newest first (by thread id, which is monotonic) because a player can hold membership in
 * parties they never formally left: the one they are in is the most recent one they are on.
 */
export async function getPartyThreadForPlayer(
	db: D1Database,
	playerId: number
): Promise<ChatThread | null> {
	const row = await db
		.prepare(
			`${THREAD_SELECT}
			 WHERE me.player_id = ?1 AND t.chat_thread_type = ?2
			 ORDER BY t.chat_thread_id DESC
			 LIMIT 1`
		)
		.bind(playerId, ChatThreadType.Party)
		.first<ThreadRow>()
	return row === null ? null : toThread(row)
}

/** What a thread IS, without any of what's in it. See {@link getThreadMeta}. */
export interface ThreadMeta {
	chatThreadType: ChatThreadTypeValue
	/** ISO-8601 UTC, as `created_at` stores it. */
	createdAt: string
}

/**
 * A thread's kind and age, or null when there is no such thread — the one read here that
 * does NOT go through membership.
 *
 * It exists for the party join (`GET /thread/party`), which has to know a thread is real,
 * is a party, and is still young enough to join BEFORE it puts the caller on it; every
 * other read is membership-scoped, and a caller joining a party is by definition not a
 * member yet. It answers these two fields and nothing else — no name, no roster, no
 * messages — precisely so it can't become a way to read a thread you aren't in.
 */
export async function getThreadMeta(
	db: D1Database,
	chatThreadId: number
): Promise<ThreadMeta | null> {
	const row = await db
		.prepare(
			'SELECT chat_thread_type, created_at FROM message_thread WHERE chat_thread_id = ?1'
		)
		.bind(chatThreadId)
		.first<{ chat_thread_type: number; created_at: string }>()
	return row === null
		? null
		: { chatThreadType: row.chat_thread_type as ChatThreadTypeValue, createdAt: row.created_at }
}

/**
 * Whether a player may read or post to a thread. Every thread-scoped route gates on
 * this before touching messages.
 */
export async function isThreadMember(
	db: D1Database,
	chatThreadId: number,
	playerId: number
): Promise<boolean> {
	const row = await db
		.prepare('SELECT 1 AS ok FROM thread_member WHERE chat_thread_id = ?1 AND player_id = ?2')
		.bind(chatThreadId, playerId)
		.first<{ ok: number }>()
	return row !== null
}

/**
 * The pseudo-player system messages are sent as. Not a real account — the client renders
 * a message from this sender as a notice rather than as someone speaking, which is why
 * `message.sender_player_id` carries no foreign key and permits negative ids.
 */
export const SYSTEM_SENDER_ID = -5

/**
 * The notice a thread opens with: `Player <@U10441985> started a chat`. The `<@U…>` token
 * is a mention the client resolves to a display name, so the id goes in raw.
 */
export function startedChatContents(playerId: number): string {
	return JSON.stringify({
		Type: 0,
		Version: 1,
		Data: `Player <@U${playerId}> started a chat`,
	})
}

/**
 * The notice left behind when someone walks out of a group: `Player <@U14922080> left`.
 * Same `<@U…>` mention token the opening notice uses.
 */
export function leftChatContents(playerId: number): string {
	return JSON.stringify({ Type: 0, Version: 1, Data: `Player <@U${playerId}> left` })
}

/**
 * The counterpart notice when someone is pulled onto a thread or walks into a party:
 * `Player <@U14922080> joined`. Same `<@U…>` mention token as the other two.
 *
 * It carries the roster change as a MESSAGE because that is the only way to carry one: the
 * client has no join/leave channel, only `ChatMessageReceived` and `PlayerLeftChat`, both
 * of which take a message. So the notice is both what the thread shows and what tells
 * everyone — the new member's client included — that the roster moved.
 */
export function joinedChatContents(playerId: number): string {
	return JSON.stringify({ Type: 0, Version: 1, Data: `Player <@U${playerId}> joined` })
}

/**
 * Rename a thread. An empty name clears it back to unnamed, which renders as the member
 * list rather than a blank title.
 */
export async function setThreadName(
	db: D1Database,
	chatThreadId: number,
	name: string
): Promise<void> {
	await db
		.prepare('UPDATE message_thread SET chat_thread_name = ?2 WHERE chat_thread_id = ?1')
		.bind(chatThreadId, name === '' ? null : name)
		.run()
}

/**
 * Open a thread between a set of players, returning its new id. `name` is null for DMs
 * and unnamed groups. Duplicate player ids collapse, so a caller need not dedupe.
 *
 * Pass `startedBy` to open the thread the way the real server does — with a system
 * "started a chat" notice as its first message. A thread with no messages at all is one
 * the client won't display, so every thread born from a request gets one; the parameter
 * is optional only so tests can build a bare thread directly.
 *
 * Every call opens a *distinct* thread, even for a member set that already has one —
 * threads are not keyed by their membership, and the same pair may hold several.
 *
 * `type` is the thread's kind and defaults to `Player`, which covers DMs and group chats
 * alike; a party opens as `Party`.
 */
export async function createThread(
	db: D1Database,
	playerIds: number[],
	name: string | null = null,
	startedBy?: number,
	type: ChatThreadTypeValue = ChatThreadType.Player
): Promise<number> {
	const row = await db
		.prepare(
			`INSERT INTO message_thread (chat_thread_name, chat_thread_type, created_at)
			 VALUES (?1, ?2, ?3)
			 RETURNING chat_thread_id`
		)
		.bind(name, type, new Date().toISOString())
		.first<{ chat_thread_id: number }>()
	if (row === null) throw new Error('failed to create chat thread')

	const members = [...new Set(playerIds)]
	if (members.length > 0) {
		await db.batch(
			members.map((playerId) =>
				db
					.prepare(
						`INSERT OR IGNORE INTO thread_member (chat_thread_id, player_id)
						 VALUES (?1, ?2)`
					)
					.bind(row.chat_thread_id, playerId)
			)
		)
	}

	if (startedBy !== undefined) {
		await postMessage(db, {
			chatThreadId: row.chat_thread_id,
			senderPlayerId: SYSTEM_SENDER_ID,
			contents: startedChatContents(startedBy),
		})
	}
	return row.chat_thread_id
}

/**
 * The existing thread whose membership is *exactly* this set of players, or null. The
 * oldest match wins, so a set that somehow accumulated duplicates keeps resolving to the
 * conversation with the history in it.
 *
 * This is what makes "open a chat with these people" reuse the conversation you already
 * have with them rather than starting an empty one each time. Matching is on the whole
 * set: a DM and a group that happens to contain those two people are different threads.
 *
 * Only threads that still have a `message_thread` row can match. Membership rows whose
 * thread is gone are ignored rather than resolved to: matching one would hand back an id
 * that nothing else in the worker can render, and — since the oldest match wins — it
 * would keep winning on every subsequent call.
 *
 * Matching is also scoped to one `type`: a party whose roster happens to be the people
 * you are opening a DM with is a different conversation, and handing it back would drop
 * the DM into the party.
 */
export async function findThreadWithMembers(
	db: D1Database,
	playerIds: number[],
	type: ChatThreadTypeValue = ChatThreadType.Player
): Promise<number | null> {
	const members = [...new Set(playerIds)]
	if (members.length === 0) return null

	// ?1 is the member count, ?2 the thread type; ?3… are the ids themselves.
	const placeholders = members.map((_, i) => `?${i + 3}`).join(', ')
	const row = await db
		.prepare(
			`SELECT m.chat_thread_id FROM thread_member m
			 JOIN message_thread t ON t.chat_thread_id = m.chat_thread_id
			 WHERE t.chat_thread_type = ?2
			 GROUP BY m.chat_thread_id
			 HAVING COUNT(*) = ?1
			    AND COUNT(CASE WHEN m.player_id IN (${placeholders}) THEN 1 END) = ?1
			 ORDER BY m.chat_thread_id
			 LIMIT 1`
		)
		.bind(members.length, type, ...members)
		.first<{ chat_thread_id: number }>()
	return row?.chat_thread_id ?? null
}

/**
 * The thread with exactly these members, opening one if it doesn't exist yet. Two
 * simultaneous first-messages to the same set can still race into two threads; the
 * oldest-match rule in `findThreadWithMembers` means both parties converge on one of
 * them afterwards.
 *
 * `created` says which happened. The caller needs it: a thread that was just opened has to
 * be PUSHED to its members, or it sits on the server unseen until somebody posts to it —
 * the client has no "you were added to a thread" channel, so the opening notice going out
 * over the socket is the only thing that makes a new conversation appear.
 */
export async function getOrCreateThreadWithMembers(
	db: D1Database,
	playerIds: number[],
	startedBy: number
): Promise<{ chatThreadId: number; created: boolean }> {
	const existing = await findThreadWithMembers(db, playerIds)
	if (existing !== null) return { chatThreadId: existing, created: false }
	return { chatThreadId: await createThread(db, playerIds, null, startedBy), created: true }
}

/** Everyone in a thread, ordered by id — the fan-out list for a push notification. */
export async function getThreadMemberIds(db: D1Database, chatThreadId: number): Promise<number[]> {
	const { results } = await db
		.prepare('SELECT player_id FROM thread_member WHERE chat_thread_id = ?1 ORDER BY player_id')
		.bind(chatThreadId)
		.all<{ player_id: number }>()
	return results.map((r) => r.player_id)
}

/** Add a player to an existing thread. A no-op if they're already in it. */
export async function addThreadMember(
	db: D1Database,
	chatThreadId: number,
	playerId: number
): Promise<void> {
	await db
		.prepare('INSERT OR IGNORE INTO thread_member (chat_thread_id, player_id) VALUES (?1, ?2)')
		.bind(chatThreadId, playerId)
		.run()
}

/** Remove a player from a thread. The thread and its messages outlive the membership. */
export async function removeThreadMember(
	db: D1Database,
	chatThreadId: number,
	playerId: number
): Promise<void> {
	await db
		.prepare('DELETE FROM thread_member WHERE chat_thread_id = ?1 AND player_id = ?2')
		.bind(chatThreadId, playerId)
		.run()
}

/**
 * Post a message and advance the thread's denormalized `latest_message_id` — the only
 * way messages should be written, so the thread list never goes stale. Two statements
 * rather than a batch, because the update needs the id the insert assigns.
 */
export async function postMessage(db: D1Database, message: NewChatMessage): Promise<ChatMessage> {
	const stored = await insertMessage(db, message)
	await db
		.prepare('UPDATE message_thread SET latest_message_id = ?2 WHERE chat_thread_id = ?1')
		.bind(stored.chatThreadId, stored.chatMessageId)
		.run()
	return stored
}

/**
 * Advance a player's read position, to a specific message or (with no id) to the whole
 * thread. Only ever moves forward: an out-of-order ack from a second client can't walk
 * the thread back to unread.
 *
 * The id is also clamped to the thread's real latest message, so a client acking an id
 * that was never stored can't strand the pointer beyond every future message and leave
 * the thread permanently "read".
 */
export async function markThreadRead(
	db: D1Database,
	chatThreadId: number,
	playerId: number,
	chatMessageId?: number
): Promise<void> {
	await db
		.prepare(
			`UPDATE thread_member
			 SET last_read_message_id = MAX(
			   COALESCE(last_read_message_id, 0),
			   MIN(
			     COALESCE(?3, (SELECT latest_message_id FROM message_thread WHERE chat_thread_id = ?1), 0),
			     COALESCE((SELECT latest_message_id FROM message_thread WHERE chat_thread_id = ?1), 0)
			   )
			 )
			 WHERE chat_thread_id = ?1 AND player_id = ?2`
		)
		.bind(chatThreadId, playerId, chatMessageId ?? null)
		.run()
}

/** Favorite or unfavorite a thread, for one player only. */
export async function setThreadFavorited(
	db: D1Database,
	chatThreadId: number,
	playerId: number,
	isFavorited: boolean
): Promise<void> {
	await db
		.prepare(
			'UPDATE thread_member SET is_favorited = ?3 WHERE chat_thread_id = ?1 AND player_id = ?2'
		)
		.bind(chatThreadId, playerId, isFavorited ? 1 : 0)
		.run()
}

/** Snooze a thread's notifications until an instant, or clear the snooze with null. */
export async function setThreadSnoozed(
	db: D1Database,
	chatThreadId: number,
	playerId: number,
	snoozedUntil: string | null
): Promise<void> {
	await db
		.prepare(
			'UPDATE thread_member SET snoozed_until = ?3 WHERE chat_thread_id = ?1 AND player_id = ?2'
		)
		.bind(chatThreadId, playerId, snoozedUntil)
		.run()
}
