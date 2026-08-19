import { resolver } from 'hono-openapi'
import { z } from 'zod'

import type { OpenAPIV3_1 } from 'openapi-types'

/**
 * OpenAPI schemas for the chat worker.
 *
 * IMPORTANT: these are DESCRIPTIVE ONLY. They are passed to `describeRoute` to
 * generate the spec and are never wired into `hono-openapi`'s `validator()`. Same
 * rationale as the auth/accounts/econ/match workers: a reverse-engineered protocol,
 * lenient handlers, no runtime validation.
 *
 * Do NOT add `.meta({ id })` to these schemas — with this hono-openapi + zod v4 setup a
 * meta'd schema used in a response emits a `$ref` the framework doesn't always hoist
 * into `components.schemas`, leaving a dangling reference. Leaving meta off makes every
 * schema inline, which renders correctly in any tool.
 */

/** Emit a zod schema as an `application/json` response body. */
export function json(schema: z.ZodType, description: string) {
	return { description, content: { 'application/json': { schema: resolver(schema) } } }
}

function toOpenApiSchema(schema: z.ZodType): OpenAPIV3_1.SchemaObject {
	const { $schema: _$schema, additionalProperties: _extra, ...jsonSchema } = z.toJSONSchema(schema)
	return jsonSchema as OpenAPIV3_1.SchemaObject
}

/** A form-urlencoded / multipart request body (the client posts both). */
export function form(schema: z.ZodType, description: string): OpenAPIV3_1.RequestBodyObject {
	const s = toOpenApiSchema(schema)
	return {
		description,
		content: {
			'application/x-www-form-urlencoded': { schema: s },
			'multipart/form-data': { schema: s },
		},
	}
}

/** An `application/json` request body. */
export function jsonBody(schema: z.ZodType, description: string): OpenAPIV3_1.RequestBodyObject {
	return { description, content: { 'application/json': { schema: toOpenApiSchema(schema) } } }
}

/** The empty-body 401 the auth-gated routes return. */
export const UNAUTHORIZED_RESPONSE = { description: 'Missing or invalid bearer token (empty body)' }

/** Bearer-JWT security requirement, for the auth-gated routes. */
export const AUTHED = [{ bearerAuth: [] }]

/**
 * The 404 a thread-scoped route answers when the caller isn't a member. Deliberately
 * indistinguishable from "no such thread" — whether a thread exists is itself private.
 */
export const NOT_A_MEMBER_RESPONSE = {
	description: 'Not a member of the thread (or no such thread) — the two are indistinguishable',
}

// ---- Response schemas ------------------------------------------------------

/**
 * A chat message as stored and served (see message-db.ts). `contents` is the client's own
 * envelope (`{"Type":0,"Version":1,"Data":"hello"}`) — stored verbatim and served back
 * untouched, so new message types need no schema change. A `senderPlayerId` of -5 is the
 * system pseudo-player the "started a chat" / "left" notices are posted as.
 */
export const ChatMessageDto = z.object({
	chatMessageId: z.int().describe('Server-assigned, unique across all threads'),
	chatThreadId: z.int(),
	senderPlayerId: z.int().describe('-5 is the system sender (join/leave notices)'),
	timeSent: z.string().describe('ISO-8601 UTC instant, as .NET serializes DateTime'),
	contents: z.string().describe('The raw client envelope, e.g. {"Type":0,"Version":1,"Data":"hi"}'),
	moderationState: z.int().describe('0 None, 1 Flagged, 2 Hidden'),
})

/** The per-viewer fields every rendered thread carries, plus the thread's own. */
const threadBase = {
	chatThreadId: z.int(),
	playerIds: z.array(z.int()).describe('The thread’s members, ordered by id'),
	lastReadMessageId: z
		.int()
		.describe('0 when never read — never null (the client deserializes a non-nullable int)'),
	chatThreadName: z
		.string()
		.describe('Empty for DMs and unnamed groups — never null (the client dereferences it)'),
	chatThreadType: z.int().describe('Always 0 — the only type the reference serves'),
	snoozedUntil: z.string().nullable().describe('An instant, or null when not snoozed'),
	isFavorited: z.boolean(),
}

/**
 * A thread as it appears in the thread LIST: the thread, its members, the caller's own
 * read/snooze/favorite state, and its single most recent message.
 */
export const ChatThreadDto = z.object({
	latestMessage: ChatMessageDto.nullable().describe('Null only for a thread with no messages yet'),
	...threadBase,
})

/**
 * A thread as it appears when a conversation is OPENED: the same fields, but with a page
 * of `messages` (newest first) in place of `latestMessage`. The client is sent one or the
 * other, never both; `messages` is always present, empty for a brand-new thread.
 */
export const ChatThreadWithMessagesDto = z.object({
	...threadBase,
	messages: z.array(ChatMessageDto).describe('Newest first; empty for a thread with nothing in it'),
})

/**
 * The bare ChatResult integer several actions answer with (HTTP 200 either way). The
 * client's enum in full, recovered from the build — it is served NUMERICALLY, there being
 * no by-name formatter on the client side:
 *
 * 0 Success · 1 InvalidArguments · 2 ThreadNotFound · 3 MembershipNotFound ·
 * 4 PlayerAlreadyOnThread · 5 CannotMessagePlayer · 6 InvalidCharacters ·
 * 7 RecentlyLeftThread · 8 ThreadTooLarge · 9 InsufficientPermission ·
 * 10 TooManyAffiliationThreads · 11 UnderModeration · 12 MessageNotFound ·
 * 13 InvalidThreadJoinType · 14 PlayerBanned ·
 * 15 CannotMessagePlayerDueToLocalPrivacySetting ·
 * 16 CannotMessagePlayerDueToRemotePrivacySetting ·
 * 17 SuccessWithPartialPlayersAddedToThreadDueToPrivacySetting ·
 * 18 CannotAddPlayersToThreadDueToPrivacySetting ·
 * 19 CannotConvertDirectMessageChatToGroupChatDueToPrivacySetting
 *
 * Only 0, 1, 3 and 4 are reachable on this server; the rest are recorded so a route that
 * needs one answers the number the client actually branches on.
 */
export const ChatResult = z
	.int()
	.describe(
		'ChatResult, numeric: 0 Success · 1 InvalidArguments · 2 ThreadNotFound · 3 MembershipNotFound · 4 PlayerAlreadyOnThread · 5 CannotMessagePlayer · 6 InvalidCharacters · 7 RecentlyLeftThread · 8 ThreadTooLarge · 9 InsufficientPermission · 10 TooManyAffiliationThreads · 11 UnderModeration · 12 MessageNotFound · 13 InvalidThreadJoinType · 14 PlayerBanned · 15 CannotMessagePlayerDueToLocalPrivacySetting · 16 CannotMessagePlayerDueToRemotePrivacySetting · 17 SuccessWithPartialPlayersAddedToThreadDueToPrivacySetting · 18 CannotAddPlayersToThreadDueToPrivacySetting · 19 CannotConvertDirectMessageChatToGroupChatDueToPrivacySetting'
	)

/**
 * `POST /thread` — the reference's wrapper: the created (or resolved) thread plus the
 * result of the first message. Blank `messageContents` opens the thread without posting
 * and reports invalid-arguments (1), still with the thread attached.
 */
export const CreateThreadResponse = z.object({
	chatThread: ChatThreadDto,
	chatResult: ChatResult,
})

/**
 * `POST /thread/:id` and `/thread/:id/message` — the whole thread with its messages, not
 * just the message that was sent, so the client re-renders the conversation from one
 * response.
 */
export const SendMessageResponse = z.object({
	chatResult: ChatResult,
	chatThread: ChatThreadWithMessagesDto.nullable(),
})

/**
 * `GET /settings/partyinvite` — how long a party invite link stays usable, in minutes. A
 * bare single-key object, not an envelope: the whole body is this one setting.
 */
export const PartyInviteSettings = z.object({
	InviteLinkLifetimeInMinutes: z
		.int()
		.describe('Minutes a party invite link stays valid before it lapses'),
})

/**
 * `GET|PUT /thread/chatPrivacySetting` — who may start a chat with the caller. camelCase,
 * unlike the PascalCase thread DTOs, and the two settings are the `ChatPrivacy` enum served
 * NUMERICALLY (0 Friends · 1 Favorites · 2 NoOne): this client build carries no by-name enum
 * formatter, so a string would decode as nothing. Note the asymmetry with the PUT, which
 * sends the enum by NAME (`directMessagePrivacySetting=Favorites`).
 *
 * STORED, NOT ENFORCED. The PUT keeps the player's choice in the `playersettings` KV and this
 * is what the client renders its privacy screen from, but nothing checks it —
 * `GET /thread/checkCanSendDirectMessageWithPrivacySetting` still allows every DM, since this
 * server has no friends/favorites list to test a sender against.
 */
export const ChatPrivacySettings = z.object({
	playerId: z.int().describe('The caller — read from the token, not from the query'),
	directMessagePrivacySetting: z
		.int()
		.describe('Who may DM the caller: 0 Friends · 1 Favorites · 2 NoOne'),
	groupChatPrivacySetting: z
		.int()
		.describe('Who may add the caller to a group chat: 0 Friends · 1 Favorites · 2 NoOne'),
})

/**
 * `GET /thread/party` — STUB. The real shape hasn't been observed off a live client, so
 * the route answers an empty object and this schema says so rather than guessing at
 * fields. Fill both in together once the real response is captured.
 */
export const PartyThread = z.object({}).describe('Stub — always empty; the real shape is unknown')

/** `GET /` — the liveness probe. */
export const ServiceStatus = z.object({
	service: z.literal('chat'),
	status: z.literal('ok'),
})

// ---- Request schemas -------------------------------------------------------

/**
 * `POST /thread` form body. `ids` is repeated (`ids=2&ids=155`) and names the OTHER
 * members; the caller is always added. Values that aren't integers are dropped. The
 * fields are also read from the query string, since the same call is easy to hand-write
 * that way.
 */
export const CreateThreadRequest = z.object({
	ids: z.array(z.int()).describe('Repeated: ids=2&ids=155. The caller is added automatically'),
	messageContents: z
		.string()
		.optional()
		.describe(
			[
				'The client envelope, stored verbatim and unparsed. Blank/absent opens the thread',
				'without posting a message and reports chatResult 1',
			].join(' ')
		),
})

/**
 * `POST /thread/withmembers` form body — the client's GetChatBetweenPlayers. Same
 * repeated `ids`, plus the page size for the returned `messages`.
 */
export const WithMembersRequest = z.object({
	ids: z.array(z.int()).describe('Repeated: ids=2&ids=155. The caller is added automatically'),
	messageCount: z
		.int()
		.optional()
		.describe('Page size for `messages`; defaults to 50, capped at 100'),
})

/** `POST /thread/:id` (and `/thread/:id/message`) form body. */
export const SendMessageRequest = z.object({
	messageContents: z
		.string()
		.describe(
			[
				'The client envelope (Type/Version/Data), stored verbatim. Blank or missing stores',
				'nothing and reports chatResult 1, still with the thread attached',
			].join(' ')
		),
	messageCount: z.int().optional().describe('Page size for the returned thread’s `messages`'),
})

/** `POST|PUT /thread/:id/rename` form body. Any member may rename; there is no owner. */
export const RenameThreadRequest = z.object({
	name: z
		.string()
		.describe('Truncated to 128 chars, not rejected. Empty clears it back to unnamed'),
})

/** `POST|PUT /thread/:id/snooze` form body. */
export const SnoozeThreadRequest = z.object({
	snooze: z
		.string()
		.describe('`True`/`False` as the client spells it (`1`/`yes` also count as true)'),
})

/**
 * `PUT /thread/chatPrivacySetting` form body. The client sends ONE of the two fields per
 * call — it PUTs whichever row of its privacy screen the player just changed — so a field
 * that isn't in the body leaves that setting as it was rather than resetting it.
 *
 * The value is the `ChatPrivacy` enum by NAME (`Favorites`), which is how the client spells
 * it here even though the GET answers with the ordinal; the ordinal is accepted too.
 */
export const ChatPrivacySettingRequest = z.object({
	directMessagePrivacySetting: z
		.string()
		.optional()
		.describe('Who may DM the caller: `Friends` · `Favorites` · `NoOne` (or 0 · 1 · 2)'),
	groupChatPrivacySetting: z
		.string()
		.optional()
		.describe(
			'Who may add the caller to a group chat: `Friends` · `Favorites` · `NoOne` (or 0 · 1 · 2)'
		),
})

/** `PUT|POST /thread/:id/favorite` form body. */
export const FavoriteThreadRequest = z.object({
	favorite: z
		.string()
		.describe('`True`/`False` as the client spells it (`1`/`yes` also count as true)'),
})

// ---- Shared parameters -----------------------------------------------------

/** The numeric `:id` path segment naming a thread (constrained to digits by the route). */
export const THREAD_ID_PARAM = {
	name: 'id',
	in: 'path',
	required: true,
	description: 'Chat thread id (digits only — a non-numeric path matches no route)',
	schema: { type: 'string' },
} as const

/** The `MessageCount` / `messageCount` query param the GET routes accept. */
export function messageCountParam(fallback: number) {
	return {
		name: 'MessageCount',
		in: 'query',
		required: false,
		description: `Page size; defaults to ${fallback}, capped at 100. \`messageCount\` is accepted too. Anything unparseable or out of range falls back rather than 400ing`,
		schema: { type: 'integer' },
	} as const
}
