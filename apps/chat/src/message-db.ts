/**
 * Chat messages on the shared `recflare` D1 database — the individual messages posted
 * to a chat thread (a DM pair or a group). Stored as columns rather than a JSON blob
 * (mirroring the reference model): every field is a scalar the server itself reads, and the
 * one client-shaped part — `contents` — is already an opaque string.
 *
 * `contents` is the client's envelope, e.g.
 * `{"Type":0,"Version":1,"Data":"This is jordanparki7 from your Oculus friends."}`,
 * where `Type` selects how the client renders `Data` (plain text, an invite, an image
 * …) and `Version` versions that encoding. It is served back exactly as stored, and the
 * writer (`chat.app.ts`) rewrites nothing in it but the profanity mask over `Data`, so
 * new message types need no schema change here.
 *
 * `chatMessageId` is server-assigned and unique across all threads (AUTOINCREMENT), the
 * way the client expects to be able to reference a message by id alone.
 *
 * The `chat` worker owns this schema/migration (migrations/0001_message.sql, applied
 * under its own `migrations_table` so it doesn't clash with the other workers'
 * migrations that share the database). `SCHEMA_DDL` mirrors that migration so tests can
 * build the table directly.
 */

/** Schema DDL (mirror of migrations/0001_message.sql). */
export const SCHEMA_DDL: string[] = [
	`CREATE TABLE IF NOT EXISTS message (
		chat_message_id INTEGER PRIMARY KEY AUTOINCREMENT,
		chat_thread_id INTEGER NOT NULL,
		sender_player_id INTEGER NOT NULL,
		time_sent TEXT NOT NULL,
		contents TEXT NOT NULL,
		moderation_state INTEGER NOT NULL DEFAULT 0
	)`,
	// Thread listing is always (thread, id) — newest-first pages walk this index.
	`CREATE INDEX IF NOT EXISTS idx_message_thread ON message (chat_thread_id, chat_message_id)`,
	`CREATE INDEX IF NOT EXISTS idx_message_sender ON message (sender_player_id)`,
]

/**
 * Whether a message has been touched by moderation. `None` is the overwhelmingly common
 * case and the column default; the others let a message be withheld from the thread
 * without deleting the row.
 */
export enum ChatModerationState {
	None = 0,
	Flagged = 1,
	Hidden = 2,
}

/** A chat message, in the shape the client sends and receives it. */
export interface ChatMessage {
	chatMessageId: number
	chatThreadId: number
	senderPlayerId: number
	/** ISO-8601 UTC instant, as .NET serializes `DateTime` (e.g. `2022-05-22T12:47:03.6536656`). */
	timeSent: string
	/** The raw message envelope, e.g. `{"Type":0,"Version":1,"Data":"hello"}`. */
	contents: string
	moderationState: ChatModerationState
}

/** A new message, before the server assigns its id and (by default) its timestamp. */
export interface NewChatMessage {
	chatThreadId: number
	senderPlayerId: number
	contents: string
	/** Defaults to now. Pass only when replaying a message with its original timestamp. */
	timeSent?: string
	moderationState?: ChatModerationState
}

/** The stored row, before it's mapped back to the client's camelCase shape. */
interface MessageRow {
	chat_message_id: number
	chat_thread_id: number
	sender_player_id: number
	time_sent: string
	contents: string
	moderation_state: number
}

function toMessage(row: MessageRow): ChatMessage {
	return {
		chatMessageId: row.chat_message_id,
		chatThreadId: row.chat_thread_id,
		senderPlayerId: row.sender_player_id,
		timeSent: row.time_sent,
		contents: row.contents,
		moderationState: row.moderation_state,
	}
}

/** Post a message to a thread, returning it with its server-assigned id. */
export async function insertMessage(db: D1Database, message: NewChatMessage): Promise<ChatMessage> {
	const row = await db
		.prepare(
			`INSERT INTO message (chat_thread_id, sender_player_id, time_sent, contents, moderation_state)
			 VALUES (?1, ?2, ?3, ?4, ?5)
			 RETURNING *`
		)
		.bind(
			message.chatThreadId,
			message.senderPlayerId,
			message.timeSent ?? new Date().toISOString(),
			message.contents,
			message.moderationState ?? ChatModerationState.None
		)
		.first<MessageRow>()
	// RETURNING on an INSERT that ran always yields the row; a null here means the
	// insert itself failed, which D1 would already have thrown for.
	if (row === null) throw new Error('failed to insert chat message')
	return toMessage(row)
}

/**
 * A page of a thread's messages, newest first. `before` pages backwards through the
 * history: pass the `chatMessageId` of the oldest message you already have.
 */
export async function getThreadMessages(
	db: D1Database,
	chatThreadId: number,
	{ limit = 50, before }: { limit?: number; before?: number } = {}
): Promise<ChatMessage[]> {
	const { results } = before
		? await db
				.prepare(
					`SELECT * FROM message WHERE chat_thread_id = ?1 AND chat_message_id < ?2
					 ORDER BY chat_message_id DESC LIMIT ?3`
				)
				.bind(chatThreadId, before, limit)
				.all<MessageRow>()
		: await db
				.prepare(
					`SELECT * FROM message WHERE chat_thread_id = ?1
					 ORDER BY chat_message_id DESC LIMIT ?2`
				)
				.bind(chatThreadId, limit)
				.all<MessageRow>()
	return results.map(toMessage)
}

/** A single message by id, or null if there's no such message. */
export async function getMessage(
	db: D1Database,
	chatMessageId: number
): Promise<ChatMessage | null> {
	const row = await db
		.prepare('SELECT * FROM message WHERE chat_message_id = ?1')
		.bind(chatMessageId)
		.first<MessageRow>()
	return row === null ? null : toMessage(row)
}
