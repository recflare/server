import { Hono } from 'hono'
import { describeRoute, openAPIRouteHandler } from 'hono-openapi'
import { useWorkersLogger } from 'workers-tagged-logger'

import { logger, withCleanSpec, withNotFound, withOnError } from '@repo/hono-helpers'
import { validateAndGetAccountId } from '@repo/jwt'

import { NotificationType } from '../../notify/src/notification-types'
import { getThreadMessages } from './message-db'
import {
	AUTHED,
	ChatMessageDto,
	ChatPrivacySettings,
	ChatResult,
	ChatThreadDto,
	ChatThreadWithMessagesDto,
	CreateThreadRequest,
	CreateThreadResponse,
	FavoriteThreadRequest,
	form,
	json,
	messageCountParam,
	NOT_A_MEMBER_RESPONSE,
	PartyInviteSettings,
	PartyThread,
	RenameThreadRequest,
	SendMessageRequest,
	SendMessageResponse,
	ServiceStatus,
	SnoozeThreadRequest,
	THREAD_ID_PARAM,
	UNAUTHORIZED_RESPONSE,
	WithMembersRequest,
} from './openapi'
import {
	addThreadMember,
	getOrCreateThreadWithMembers,
	getThreadForPlayer,
	getThreadMemberIds,
	getThreadsForPlayer,
	isThreadMember,
	leftChatContents,
	markThreadRead,
	postMessage,
	removeThreadMember,
	setThreadFavorited,
	setThreadName,
	setThreadSnoozed,
	SYSTEM_SENDER_ID,
} from './thread-db'

import type { Context } from 'hono'
import type { App } from './context'
import type { ChatMessage } from './message-db'

/**
 * Resolve the account id from a Bearer token. Returns `null` when the header is
 * missing, the token is invalid, or the `sub` claim isn't an integer.
 */
async function authedId(c: Context<App>): Promise<number | null> {
	return validateAndGetAccountId(c.req.raw, await c.env.JWT_SECRET.get())
}

/**
 * How many items a `MessageCount` query param asks for. The client sends 16; anything
 * missing, unparseable, or out of range falls back to the default rather than 400ing,
 * and the cap keeps a hand-written request from pulling a whole thread history.
 */
const DEFAULT_MESSAGE_COUNT = 16
const MAX_MESSAGE_COUNT = 100

/** What the client asks for when opening a thread (`messageCount=50`). */
const DEFAULT_THREAD_MESSAGE_COUNT = 50

function messageCount(c: Context<App>, fallback = DEFAULT_MESSAGE_COUNT): number {
	// The GET routes spell it `MessageCount` in the query; the POST forms spell it
	// `messageCount` in the body. Accept either, wherever it turns up.
	const raw = Number.parseInt(c.req.query('MessageCount') ?? c.req.query('messageCount') ?? '', 10)
	if (Number.isNaN(raw) || raw <= 0) return fallback
	return Math.min(raw, MAX_MESSAGE_COUNT)
}

/** The page size a POST form asks for, which may also arrive in the body. */
async function formMessageCount(c: Context<App>, fallback: number): Promise<number> {
	const raw = Number.parseInt((await formField(c, 'messageCount')) ?? '', 10)
	if (Number.isNaN(raw) || raw <= 0) return messageCount(c, fallback)
	return Math.min(raw, MAX_MESSAGE_COUNT)
}

/**
 * What a chat action reports back to the client — the reference's ChatResult, usually
 * alongside a payload but sometimes (the DM privacy check) as the whole body. Only these
 * four of the enum's twenty values are reachable here; `ChatResult` in openapi.ts records
 * the rest, including the 15/16 privacy refusals nothing on this server can answer.
 */
const CHAT_SUCCESS = 0
const CHAT_INVALID_ARGUMENTS = 1
const CHAT_MEMBERSHIP_NOT_FOUND = 3
const CHAT_PLAYER_ALREADY_ON_THREAD = 4

/**
 * How long a party invite link stays usable, in minutes (`GET /settings/partyinvite`).
 * The reference's value. Nothing here stores invite links, so this is what the client
 * counts down with rather than a lifetime this server enforces.
 */
const PARTY_INVITE_LIFETIME_MINUTES = 60

/**
 * Who may start a chat with a player — the client's `ChatPrivacy` enum, served numerically
 * like every other enum on this build. `Friends` is what a fresh account reports, and what
 * every account reports here: nothing stores a per-player setting yet.
 */
const ChatPrivacy = {
	Friends: 0,
	Favorites: 1,
	NoOne: 2,
} as const

/** The hub is a single global Durable Object instance, as every worker addresses it. */
const HUB_INSTANCE = 'global'

/**
 * Push ChatMessageReceived to everyone in the thread once a message lands, so the
 * conversation updates live instead of on the next poll.
 *
 * The sender is notified too, deliberately: the client doesn't fold the HTTP response
 * into its local thread cache, so without a self-targeted push its own outgoing message
 * doesn't appear until the thread is refetched.
 *
 * Best-effort — a hub failure is logged and swallowed, since the message has already
 * committed and the client will still see it on the next fetch.
 */
async function pushChatMessage(c: Context<App>, message: ChatMessage): Promise<void> {
	try {
		const hub = c.env.RECFLARE_NOTIFICATIONS_HUB.getByName(HUB_INSTANCE)
		const members = await getThreadMemberIds(c.env.DB, message.chatThreadId)
		await Promise.all(
			members.map((playerId) =>
				hub.notifyPlayer(playerId, NotificationType.ChatMessageReceived, { ...message })
			)
		)
	} catch (err) {
		logger.error('failed to push ChatMessageReceived notification', {
			chatThreadId: message.chatThreadId,
			chatMessageId: message.chatMessageId,
			error: err instanceof Error ? err.message : String(err),
		})
	}
}

/**
 * Send a message to a thread that already exists — every message after the one that
 * opened the conversation. `/thread/18` is what the client posts; `/thread/18/message` is
 * the same call under the reference's other spelling, so both routes land here.
 *
 * Answers `{chatResult, chatThread}` — the whole thread with its messages, not just the
 * message that was sent, so the client re-renders the conversation from one response.
 * Blank or missing contents stores nothing and reports invalid-arguments, still with the
 * thread attached, rather than an error status.
 */
async function sendToThread(c: Context<App>) {
	const id = await authedId(c)
	if (id === null) return c.body(null, 401)

	const chatThreadId = Number.parseInt(c.req.param('id') ?? '', 10)
	if (!(await isThreadMember(c.env.DB, chatThreadId, id))) return c.notFound()

	// Stored exactly as sent: the envelope carries its own Type/Version and may hold
	// fields we know nothing about (the client sends Version 2 with a `<=>` prefix in
	// Data, and a `Blocks` array alongside it), so nothing here parses or rewrites it.
	const contents = (await formField(c, 'messageContents'))?.trim()
	const posted =
		contents === undefined || contents === ''
			? null
			: await postMessage(c.env.DB, { chatThreadId, senderPlayerId: id, contents })
	if (posted !== null) {
		await pushChatMessage(c, posted)
		// Sending is reading: the reference answers with `lastReadMessageId` already at the
		// message just posted, so the sender's own thread doesn't come back unread.
		await markThreadRead(c.env.DB, chatThreadId, id, posted.chatMessageId)
	}

	const thread = await threadWithMessages(c, chatThreadId, id, DEFAULT_THREAD_MESSAGE_COUNT)
	return c.json({
		chatResult: posted === null ? CHAT_INVALID_ARGUMENTS : CHAT_SUCCESS,
		chatThread: thread,
	})
}

/**
 * Move the caller's read pointer on a thread, to `chatMessageId` or (undefined) to the
 * thread's latest message. Answers the bare ChatResult integer the reference sends.
 */
async function markRead(c: Context<App>, chatMessageId?: number) {
	const id = await authedId(c)
	if (id === null) return c.body(null, 401)

	// Every route reaching here constrains `:id` to digits, so the parse can't fail.
	const chatThreadId = Number.parseInt(c.req.param('id') ?? '', 10)
	if (!(await isThreadMember(c.env.DB, chatThreadId, id))) return c.notFound()

	await markThreadRead(c.env.DB, chatThreadId, id, chatMessageId)
	return c.json(CHAT_SUCCESS)
}

/**
 * A thread rendered for opening a conversation: the thread's own fields plus a page of
 * its messages, newest first. `latestMessage` gives way to the full page — the client is
 * sent one or the other, never both — and `messages` is always present, empty for a
 * thread with nothing in it yet.
 *
 * Null when the caller isn't a member (or the thread doesn't exist); membership is the
 * gate, so the two cases are indistinguishable from outside.
 */
async function threadWithMessages(
	c: Context<App>,
	chatThreadId: number,
	playerId: number,
	limit: number
) {
	const thread = await getThreadForPlayer(c.env.DB, chatThreadId, playerId)
	if (thread === null) return null

	const messages = await getThreadMessages(c.env.DB, chatThreadId, { limit })
	const { latestMessage: _latest, ...rest } = thread
	return { ...rest, messages }
}

/** Ceiling on a new thread's roster, counting the caller. */
const MAX_THREAD_MEMBERS = 50

/** Longest a thread name may be; anything beyond is truncated, not rejected. */
const MAX_THREAD_NAME_LENGTH = 128

/**
 * What `snooze=True` stores in `snoozedUntil`. The client sends a boolean but reads back
 * an instant, so "snoozed" is expressed as a time far enough out to mean indefinitely.
 */
const SNOOZED_INDEFINITELY = '9999-12-31T23:59:59Z'

/**
 * The repeated `ids` fields naming a new thread's members (`ids=2&ids=155`). The client
 * sends them as a urlencoded body, but they're read from the query string too, since
 * the same call is easy to hand-write that way. Values that aren't integers are dropped.
 */
async function memberIds(c: Context<App>): Promise<number[]> {
	const raw = [...(c.req.queries('ids') ?? [])]
	const form = await c.req.formData().catch(() => null)
	if (form !== null) raw.push(...form.getAll('ids').map(String))
	return raw.map((value) => Number.parseInt(value, 10)).filter((id) => Number.isInteger(id))
}

/** A form boolean as the client spells it (`True`/`False`), tolerant of the variants. */
async function formBool(c: Context<App>, name: string): Promise<boolean> {
	const value = (await formField(c, name))?.trim().toLowerCase()
	return value === 'true' || value === '1' || value === 'yes'
}

/** A single form field, or the query param of the same name. Hono caches the body, so
 * this is safe to call alongside `memberIds`. */
async function formField(c: Context<App>, name: string): Promise<string | undefined> {
	const form = await c.req.formData().catch(() => null)
	const value = form?.get(name)
	return typeof value === 'string' ? value : c.req.query(name)
}

/**
 * A concise `describeRoute` spec for one of the thread-scoped actions that answers the
 * bare ChatResult integer rather than an HTTP status — rename, leave, snooze, favorite,
 * add-member and the read-pointer moves. They share the auth gate, the `:id` path param,
 * and the "3 when the caller isn't on the thread" behaviour.
 */
function chatResultRoute(
	summary: string,
	description: string,
	extra: {
		requestBody?: ReturnType<typeof form>
		parameters?: unknown[]
		successDescription?: string
		/** Set for the read-pointer routes, which 404 a non-member instead of answering 3. */
		notFound?: boolean
	} = {}
) {
	return describeRoute({
		tags: ['Chat'],
		summary,
		description,
		security: AUTHED,
		parameters: [THREAD_ID_PARAM, ...((extra.parameters ?? []) as never[])],
		...(extra.requestBody === undefined ? {} : { requestBody: extra.requestBody }),
		responses: {
			200: json(
				ChatResult,
				extra.successDescription ??
					'The ChatResult (0 on success, 3 when the caller isn’t on the thread)'
			),
			401: UNAUTHORIZED_RESPONSE,
			...(extra.notFound === true ? { 404: NOT_A_MEMBER_RESPONSE } : {}),
		},
	})
}

/**
 * The `describeRoute` spec shared by the two spellings of "send to an existing thread".
 * `/thread/{id}` is what the client posts; `/thread/{id}/message` is the same call under
 * the reference's other spelling, and both land in `sendToThread`.
 */
function sendToThreadRoute(spelling: string) {
	return describeRoute({
		tags: ['Messages'],
		summary: `Send a message to an existing thread (${spelling})`,
		description: [
			'Every message after the one that opened the conversation. Answers',
			'`{ chatResult, chatThread }` — the WHOLE thread with its messages, not just the message',
			'that was sent, so the client re-renders the conversation from one response. Blank or',
			'missing `messageContents` stores nothing and reports invalid-arguments (1), still with',
			'the thread attached, rather than an error status. Sending is reading: the sender’s own',
			'`lastReadMessageId` comes back already at the message just posted. Pushes',
			'ChatMessageReceived to every member, the sender included — the client doesn’t fold the',
			'HTTP response into its local cache, so without a self-targeted push its own outgoing',
			'message doesn’t appear until the thread is refetched. Note the hub frame’s `Id` is a',
			'STRING: the client dispatches on it and silently drops a numeric one.',
		].join(' '),
		security: AUTHED,
		parameters: [THREAD_ID_PARAM],
		requestBody: form(SendMessageRequest, 'The message envelope'),
		responses: {
			200: json(SendMessageResponse, 'The ChatResult plus the whole thread with its messages'),
			401: UNAUTHORIZED_RESPONSE,
			404: NOT_A_MEMBER_RESPONSE,
		},
	})
}

const app = new Hono<App>()
	.use(
		'*',
		// middleware
		(c, next) =>
			useWorkersLogger(c.env.NAME, {
				environment: c.env.ENVIRONMENT,
				release: c.env.SENTRY_RELEASE,
			})(c, next)
	)

	.onError(withOnError())
	.notFound(withNotFound())

	.get(
		'/',
		describeRoute({
			tags: ['Service'],
			summary: 'Service liveness',
			description: 'A fixed `{ service, status }` body. No auth — a plain liveness probe.',
			responses: { 200: json(ServiceStatus, 'Always `{ service: "chat", status: "ok" }`') },
		}),
		(c) => c.json({ service: 'chat', status: 'ok' })
	)

	// The player's own thread list, newest conversation first — each thread carrying its
	// latest message and the caller's own read/snooze/favorite state. `MessageCount` is
	// the page size (of threads, despite the name). Membership scopes the query, so a
	// player only ever sees their own threads.
	.get(
		'/thread',
		describeRoute({
			tags: ['Threads'],
			summary: 'The caller’s thread list',
			description: [
				'Every thread the caller is a member of, newest conversation first — each carrying its',
				'`latestMessage` and the caller’s own read/snooze/favorite state. `MessageCount` is the',
				'page size (of THREADS, despite the name). Membership scopes the query, so a player',
				'only ever sees their own threads.',
			].join(' '),
			security: AUTHED,
			parameters: [messageCountParam(DEFAULT_MESSAGE_COUNT)],
			responses: {
				200: json(ChatThreadDto.array(), 'The caller’s threads, newest first (empty when none)'),
				401: UNAUTHORIZED_RESPONSE,
			},
		}),
		async (c) => {
			const id = await authedId(c)
			if (id === null) return c.body(null, 401)
			return c.json(await getThreadsForPlayer(c.env.DB, id, { limit: messageCount(c) }))
		}
	)

	// Send to a set of players (`ids=155&ids=2&messageContents=…`) — the client's
	// create-thread-and-post-first-message call, in one. Resolves to the thread those
	// players already share rather than opening a second one.
	//
	// `messageContents` is the same envelope a message carries
	// (`{"Type":0,"Version":1,"Data":"…"}`) and is stored verbatim, unparsed. The client
	// also sends it blank, right after /thread/withmembers: that opens the thread without
	// posting an empty message, and reports invalid-arguments the way the reference does.
	.post(
		'/thread',
		describeRoute({
			tags: ['Threads'],
			summary: 'Open a thread with a set of players and post the first message',
			description: [
				'The client’s create-thread-and-post-first-message call, in one. Resolves to the thread',
				'those players already share rather than opening a second one. `messageContents` is the',
				'same envelope a message carries and is stored verbatim, unparsed; the client also sends',
				'it blank right after `/thread/withmembers`, which opens the thread without posting and',
				'reports invalid-arguments. Answers a `{ chatThread, chatResult }` wrapper, not a bare',
				'thread. Pushes ChatMessageReceived to every member (including the sender).',
			].join(' '),
			security: AUTHED,
			requestBody: form(CreateThreadRequest, 'The member ids and the first message'),
			responses: {
				200: json(CreateThreadResponse, 'The thread plus the result of the first message'),
				400: {
					description: [
						'Fewer than 2 members (naming only yourself) or more than 50, counting the caller',
						'(empty body)',
					].join(' '),
				},
				401: UNAUTHORIZED_RESPONSE,
			},
		}),
		async (c) => {
			const id = await authedId(c)
			if (id === null) return c.body(null, 401)

			const members = [...new Set([id, ...(await memberIds(c))])]
			if (members.length < 2 || members.length > MAX_THREAD_MEMBERS) return c.body(null, 400)

			const chatThreadId = await getOrCreateThreadWithMembers(c.env.DB, members, id)

			const contents = (await formField(c, 'messageContents'))?.trim()
			const posted =
				contents === undefined || contents === ''
					? null
					: await postMessage(c.env.DB, { chatThreadId, senderPlayerId: id, contents })
			if (posted !== null) {
				await pushChatMessage(c, posted)
				await markThreadRead(c.env.DB, chatThreadId, id, posted.chatMessageId)
			}

			const thread = await getThreadForPlayer(c.env.DB, chatThreadId, id)
			if (thread === null) throw new Error(`thread ${chatThreadId} vanished after creation`)
			// The reference answers a wrapper here, not a bare thread.
			return c.json({
				chatThread: thread,
				chatResult: posted === null ? CHAT_INVALID_ARGUMENTS : CHAT_SUCCESS,
			})
		}
	)

	// How long a party invite link lives. Server-side config the client reads to stamp its
	// own invite links, not per-player state — one hour, which is the reference's value.
	//
	// A bare single-key object: `{ InviteLinkLifetimeInMinutes }` and nothing else, no
	// `{ success, error, value }` envelope. Nothing here expires links (there is no invite
	// link store), so this is the number the client shows and counts down with rather than
	// a lifetime this server enforces.
	.get(
		'/settings/partyinvite',
		describeRoute({
			tags: ['Threads'],
			summary: 'Party invite settings',
			description: [
				'How long a party invite link stays usable, in minutes, as a bare single-key object —',
				'no envelope. 60 here, the reference’s value. Nothing on this server stores or expires',
				'invite links, so the client is the only thing that acts on it.',
			].join(' '),
			security: AUTHED,
			responses: {
				200: json(PartyInviteSettings, 'The invite-link lifetime'),
				401: UNAUTHORIZED_RESPONSE,
			},
		}),
		async (c) => {
			const id = await authedId(c)
			if (id === null) return c.body(null, 401)
			return c.json({ InviteLinkLifetimeInMinutes: PARTY_INVITE_LIFETIME_MINUTES })
		}
	)

	// The party thread (`/thread/party?maxCount=1&mode=0`). STUB: the response shape is
	// unknown — it hasn't been observed off a live client — so this answers an empty
	// object, which parses as "no party" rather than failing the client's deserializer the
	// way a 404 or a bare array would. `maxCount` and `mode` are accepted and ignored.
	// Replace the body once the real shape is captured.
	.get(
		'/thread/party',
		describeRoute({
			tags: ['Threads'],
			summary: 'The caller’s party thread (stub)',
			description: [
				'STUB — the response shape has not been observed off a live client, so this answers an',
				'empty object `{}`, which parses as "no party" rather than failing the client’s',
				'deserializer the way a 404 or a bare array would. `maxCount` and `mode` are accepted and',
				'ignored. Replace the body once the real shape is captured.',
			].join(' '),
			security: AUTHED,
			parameters: [
				{
					name: 'maxCount',
					in: 'query',
					required: false,
					description: 'Page size the client sends (1). Ignored by the stub',
					schema: { type: 'integer' },
				},
				{
					name: 'mode',
					in: 'query',
					required: false,
					description: 'Unknown mode selector the client sends (0). Ignored by the stub',
					schema: { type: 'integer' },
				},
			],
			responses: {
				200: json(PartyThread, 'Always `{}` — the stub carries no party'),
				401: UNAUTHORIZED_RESPONSE,
			},
		}),
		async (c) => {
			const id = await authedId(c)
			if (id === null) return c.body(null, 401)
			return c.json({})
		}
	)

	// The caller's chat privacy settings — who may DM them, and who may pull them into a
	// group chat. Both report `Friends`, which is the reference's default and the safer of
	// the two directions to be wrong in: it describes a player as more private than the
	// server actually enforces, rather than less.
	//
	// REPORTED, NOT ENFORCED. Nothing here stores a per-player setting or checks one — the
	// DM check below allows every message regardless — so this is what the client renders on
	// its privacy screen. Wire the two together if this ever becomes real: a screen that says
	// "Friends" while anyone can message you is worse than one that says nothing.
	//
	// `playerId` comes off the TOKEN, not a query param: the answer is about the caller.
	.get(
		'/thread/chatPrivacySetting',
		describeRoute({
			tags: ['Threads'],
			summary: 'The caller’s chat privacy settings',
			description: [
				'Who may direct-message the caller and who may add them to a group chat, as the',
				'`ChatPrivacy` enum by NUMBER (0 Friends · 1 Favorites · 2 NoOne). Both are `Friends`',
				'here — nothing stores a per-player setting — and nothing enforces them either: the',
				'DM check allows every message. `playerId` is the caller, read from the token.',
			].join(' '),
			security: AUTHED,
			responses: {
				200: json(ChatPrivacySettings, 'The caller’s settings — always Friends/Friends'),
				401: UNAUTHORIZED_RESPONSE,
			},
		}),
		async (c) => {
			const id = await authedId(c)
			if (id === null) return c.body(null, 401)
			return c.json({
				playerId: id,
				directMessagePrivacySetting: ChatPrivacy.Friends,
				groupChatPrivacySetting: ChatPrivacy.Friends,
			})
		}
	)

	// May the caller DM this player? Asked before the client opens a new direct message, so
	// it can grey the button out rather than let the send fail. Always 0 (Success): nothing
	// here stores the who-can-message-me privacy setting the name refers to, so there is no
	// setting to refuse on.
	//
	// The body is a bare ChatResult INTEGER — the client instantiates its response wrapper
	// with the ChatResult enum, not a bool, so `true` decodes as nothing. The refusals this
	// endpoint would otherwise answer are 15 (blocked by the caller's own privacy setting)
	// and 16 (blocked by the other player's); everything else in the enum belongs to the
	// thread actions. It is served numerically: this client build carries no by-name enum
	// formatter.
	.get(
		'/thread/checkCanSendDirectMessageWithPrivacySetting',
		describeRoute({
			tags: ['Threads'],
			summary: 'May the caller DM this player?',
			description: [
				'Whether the caller may open a direct message with `receivingPlayerId`, as a bare',
				'ChatResult integer — 0 (Success) means allowed; a real refusal would be 15 (the',
				'caller’s own privacy setting) or 16 (the other player’s). Always 0 here: this server',
				'stores no who-can-message-me privacy setting, so there is nothing to refuse on.',
				'`receivingPlayerId` is accepted and ignored; the answer is the same for every player,',
				'and the client asks again for the next one.',
			].join(' '),
			security: AUTHED,
			parameters: [
				{
					name: 'receivingPlayerId',
					in: 'query',
					required: false,
					description: 'The player the caller wants to message. Accepted and ignored.',
					schema: { type: 'integer' },
				},
			],
			responses: {
				200: json(ChatResult, 'Always 0 (Success) — the DM is allowed'),
				401: UNAUTHORIZED_RESPONSE,
			},
		}),
		async (c) => {
			const id = await authedId(c)
			if (id === null) return c.body(null, 401)
			return c.json(CHAT_SUCCESS)
		}
	)

	// "Open the chat with these people" — the client's GetChatBetweenPlayers. Fetch or
	// create: the thread whose membership is exactly `ids` plus the caller, opened only
	// if they don't already share one. Returning a fresh empty thread each call would
	// bury the real conversation and hand the client a thread with no messages.
	//
	// Answers the thread with a `messages` array (what `messageCount` sizes) rather than
	// the list's single `latestMessage`, so the client can open straight into the
	// conversation. The array is always present, empty for a brand-new thread.
	.post(
		'/thread/withmembers',
		describeRoute({
			tags: ['Threads'],
			summary: 'Fetch or open the thread with exactly these members',
			description: [
				'The client’s GetChatBetweenPlayers. Fetch-or-create: the thread whose membership is',
				'exactly `ids` plus the caller, opened only if they don’t already share one (returning a',
				'fresh empty thread each call would bury the real conversation). Answers the thread with',
				'a `messages` array — what `messageCount` sizes — rather than the list’s single',
				'`latestMessage`, so the client can open straight into the conversation. The array is',
				'always present, empty for a brand-new thread.',
			].join(' '),
			security: AUTHED,
			requestBody: form(WithMembersRequest, 'The member ids and the page size'),
			responses: {
				200: json(ChatThreadWithMessagesDto, 'The thread with a page of its messages'),
				400: {
					description: [
						'Fewer than 2 members (naming only yourself) or more than 50, counting the caller',
						'(empty body)',
					].join(' '),
				},
				401: UNAUTHORIZED_RESPONSE,
			},
		}),
		async (c) => {
			const id = await authedId(c)
			if (id === null) return c.body(null, 401)

			const members = [...new Set([id, ...(await memberIds(c))])]
			// A thread needs someone else in it; naming only yourself is a bad request
			// rather than a lonely thread.
			if (members.length < 2 || members.length > MAX_THREAD_MEMBERS) return c.body(null, 400)

			const chatThreadId = await getOrCreateThreadWithMembers(c.env.DB, members, id)
			const limit = await formMessageCount(c, DEFAULT_THREAD_MESSAGE_COUNT)
			const thread = await threadWithMessages(c, chatThreadId, id, limit)
			if (thread === null) throw new Error(`thread ${chatThreadId} vanished after creation`)
			return c.json(thread)
		}
	)

	// A page of one thread's messages, newest first — a bare array, not a thread object.
	// The client reads a conversation through either spelling: `/thread/2?messageCount=50`
	// and `/thread/2/message?MessageCount=16` answer the same thing, so they share a
	// handler; only the default page size differs, matching what each caller sends.
	//
	// 404 rather than 403 for a thread the caller isn't in: whether a thread exists is
	// itself private, so a non-member gets the same answer as for a thread that's gone.
	// An empty thread is still a 200 with `[]` — a conversation just opened with someone
	// has no messages yet and still has to open.
	// One thread with its recent messages — what the client opens a conversation with
	// (`/thread/13?messageCount=50`). An OBJECT, the same shape /thread/withmembers
	// answers: the client parses this one as a thread and rejects a bare array
	// ("expected '{', actual '['"). Only /thread/:id/message below serves an array.
	//
	// 404s only for a thread the caller isn't in, not for one that's simply empty: a
	// thread just opened with someone has no messages yet and still has to open.
	.get(
		'/thread/:id{[0-9]+}',
		describeRoute({
			tags: ['Threads'],
			summary: 'One thread with its recent messages',
			description: [
				'What the client opens a conversation with (`/thread/13?messageCount=50`). An OBJECT —',
				'the same shape `/thread/withmembers` answers: the client parses this one as a thread',
				"and rejects a bare array (\"expected '{', actual '['\"). Only `/thread/{id}/message`",
				'serves an array. 404s only for a thread the caller isn’t in, not for one that’s simply',
				'empty — a thread just opened with someone has no messages yet and still has to open.',
			].join(' '),
			security: AUTHED,
			parameters: [THREAD_ID_PARAM, messageCountParam(DEFAULT_THREAD_MESSAGE_COUNT)],
			responses: {
				200: json(ChatThreadWithMessagesDto, 'The thread with a page of its messages'),
				401: UNAUTHORIZED_RESPONSE,
				404: NOT_A_MEMBER_RESPONSE,
			},
		}),
		async (c) => {
			const id = await authedId(c)
			if (id === null) return c.body(null, 401)

			const chatThreadId = Number.parseInt(c.req.param('id'), 10)
			const limit = messageCount(c, DEFAULT_THREAD_MESSAGE_COUNT)
			const thread = await threadWithMessages(c, chatThreadId, id, limit)
			return thread === null ? c.notFound() : c.json(thread)
		}
	)

	// Send a message to a thread that already exists — every message after the one that
	// opened the conversation. `/thread/18` is what the client posts; `/thread/18/message`
	// is the same call under the reference's other spelling.
	//
	// Answers the SendMessageResponse wrapper (`{chatMessage, chatResult}`), not a bare
	// message. Blank or missing contents is invalid-arguments with no message attached,
	// rather than an error status.
	.post('/thread/:id{[0-9]+}', sendToThreadRoute('`/thread/{id}`'), (c) => sendToThread(c))
	.post('/thread/:id{[0-9]+}/message', sendToThreadRoute('`/thread/{id}/message`'), (c) =>
		sendToThread(c)
	)

	// Rename a thread (`name=my chat`). Any member may rename — there's no owner — and an
	// empty name clears it back to unnamed, which renders as the member list. Answers a
	// bare ChatResult: 3 when the caller isn't on the thread, 0 on success.
	.on(
		['POST', 'PUT'],
		'/thread/:id{[0-9]+}/rename',
		chatResultRoute(
			'Rename a thread',
			[
				'Any member may rename — there is no owner — and an empty name clears it back to unnamed,',
				'which renders as the member list. The name is truncated to 128 characters rather than',
				'rejected. Answers a bare ChatResult: 3 when the caller isn’t on the thread, 0 on success.',
			].join(' '),
			{ requestBody: form(RenameThreadRequest, 'The new name') }
		),
		async (c) => {
			const id = await authedId(c)
			if (id === null) return c.body(null, 401)

			const chatThreadId = Number.parseInt(c.req.param('id'), 10)
			if (!(await isThreadMember(c.env.DB, chatThreadId, id))) {
				return c.json(CHAT_MEMBERSHIP_NOT_FOUND)
			}

			const name = ((await formField(c, 'name')) ?? '').trim().slice(0, MAX_THREAD_NAME_LENGTH)
			await setThreadName(c.env.DB, chatThreadId, name)
			return c.json(CHAT_SUCCESS)
		}
	)

	// Leave a thread. The thread and its history survive — only the caller's membership
	// goes, so they stop seeing it and the remaining members keep the conversation.
	//
	// A "Player <@U…> left" notice is posted first, so the others see why the roster
	// changed; the leaver is still a member at that moment and gets the push too, which
	// is what tells their client the thread is gone.
	.on(
		['POST', 'DELETE'],
		'/thread/:id{[0-9]+}/leave',
		chatResultRoute(
			'Leave a thread',
			[
				'The thread and its history survive — only the caller’s membership goes, so they stop',
				'seeing it and the remaining members keep the conversation. A "Player <@U…> left" system',
				'notice is posted first so the others see why the roster changed; the leaver is still a',
				'member at that moment and gets the push too, which is what tells their client the thread',
				'is gone.',
			].join(' ')
		),
		async (c) => {
			const id = await authedId(c)
			if (id === null) return c.body(null, 401)

			const chatThreadId = Number.parseInt(c.req.param('id'), 10)
			if (!(await isThreadMember(c.env.DB, chatThreadId, id))) {
				return c.json(CHAT_MEMBERSHIP_NOT_FOUND)
			}

			const notice = await postMessage(c.env.DB, {
				chatThreadId,
				senderPlayerId: SYSTEM_SENDER_ID,
				contents: leftChatContents(id),
			})
			await pushChatMessage(c, notice)

			await removeThreadMember(c.env.DB, chatThreadId, id)
			return c.json(CHAT_SUCCESS)
		}
	)

	// Snooze or unsnooze a thread (`snooze=True`), for the caller alone — snoozing is a
	// per-member setting, so it never affects what anyone else sees.
	//
	// The client sends a boolean while the field it reads back is `snoozedUntil`, a time.
	// `True` is therefore stored as a far-future instant meaning "muted indefinitely", and
	// `False` clears it. If the real server instead snoozes for a fixed window, this is
	// the one line to change.
	.on(
		['POST', 'PUT'],
		'/thread/:id{[0-9]+}/snooze',
		chatResultRoute(
			'Snooze or unsnooze a thread',
			[
				'Per-member, for the caller alone — it never affects what anyone else sees. The client',
				'sends a boolean while the field it reads back (`snoozedUntil`) is a time, so `True` is',
				'stored as a far-future instant (9999-12-31T23:59:59Z) meaning "muted indefinitely" and',
				'`False` clears it.',
			].join(' '),
			{ requestBody: form(SnoozeThreadRequest, 'The snooze flag') }
		),
		async (c) => {
			const id = await authedId(c)
			if (id === null) return c.body(null, 401)

			const chatThreadId = Number.parseInt(c.req.param('id'), 10)
			if (!(await isThreadMember(c.env.DB, chatThreadId, id))) {
				return c.json(CHAT_MEMBERSHIP_NOT_FOUND)
			}

			const on = await formBool(c, 'snooze')
			await setThreadSnoozed(c.env.DB, chatThreadId, id, on ? SNOOZED_INDEFINITELY : null)
			return c.json(CHAT_SUCCESS)
		}
	)

	// Favorite or unfavorite a thread (`favorite=True`), for the caller alone — like
	// snoozing, it's a per-member flag that pins the thread in their own inbox.
	.on(
		['PUT', 'POST'],
		'/thread/:id{[0-9]+}/favorite',
		chatResultRoute(
			'Favorite or unfavorite a thread',
			[
				'Like snoozing, a per-member flag that pins the thread in the caller’s own inbox and',
				'leaves everyone else’s untouched.',
			].join(' '),
			{ requestBody: form(FavoriteThreadRequest, 'The favorite flag') }
		),
		async (c) => {
			const id = await authedId(c)
			if (id === null) return c.body(null, 401)

			const chatThreadId = Number.parseInt(c.req.param('id'), 10)
			if (!(await isThreadMember(c.env.DB, chatThreadId, id))) {
				return c.json(CHAT_MEMBERSHIP_NOT_FOUND)
			}

			await setThreadFavorited(c.env.DB, chatThreadId, id, await formBool(c, 'favorite'))
			return c.json(CHAT_SUCCESS)
		}
	)

	// Add a player to a thread (`/thread/20/member/2`). Gated on the caller already being
	// in it — you can only pull someone into a conversation you're part of.
	//
	// Answers a bare ChatResult rather than an HTTP status, as the reference does: 3 when
	// the caller isn't a member (which doubles as "no such thread", keeping a thread's
	// existence private), 4 when the target is already on it, 0 on success. Idempotent —
	// re-adding an existing member changes nothing.
	.post(
		'/thread/:id{[0-9]+}/member/:playerId{[0-9]+}',
		chatResultRoute(
			'Add a player to a thread',
			[
				'Gated on the caller already being in it — you can only pull someone into a conversation',
				'you’re part of. Answers a bare ChatResult rather than an HTTP status, as the reference',
				'does: 3 when the caller isn’t a member (which doubles as "no such thread", keeping a',
				'thread’s existence private), 4 when the target is already on it, 0 on success.',
				'Idempotent — re-adding an existing member changes nothing.',
			].join(' '),
			{
				parameters: [
					{
						name: 'playerId',
						in: 'path',
						required: true,
						description: 'The account id to add (digits only)',
						schema: { type: 'string' },
					},
				],
				successDescription: '0 success · 3 caller not a member · 4 target already on the thread',
			}
		),
		async (c) => {
			const id = await authedId(c)
			if (id === null) return c.body(null, 401)

			const chatThreadId = Number.parseInt(c.req.param('id'), 10)
			if (!(await isThreadMember(c.env.DB, chatThreadId, id))) {
				return c.json(CHAT_MEMBERSHIP_NOT_FOUND)
			}

			const playerId = Number.parseInt(c.req.param('playerId'), 10)
			if (await isThreadMember(c.env.DB, chatThreadId, playerId)) {
				return c.json(CHAT_PLAYER_ALREADY_ON_THREAD)
			}

			await addThreadMember(c.env.DB, chatThreadId, playerId)
			return c.json(CHAT_SUCCESS)
		}
	)

	// Move the caller's read pointer — `/thread/15/read` for the whole thread, or
	// `/thread/15/message/:messageId/read` for a specific message, which the client uses
	// when the view sits on a message rather than the bottom. Both verbs, as the client
	// sends either. Answers the bare ChatResult integer the reference does.
	//
	// The pointer only moves forward, and never past the thread's real latest message: an
	// id the client made up (or one it read from a synthetic message) can't strand the
	// thread as permanently read.
	.on(
		['PUT', 'POST'],
		'/thread/:id{[0-9]+}/read',
		chatResultRoute(
			'Mark a whole thread read',
			[
				'Moves the caller’s read pointer to the thread’s latest message. The pointer only moves',
				'forward and never past the thread’s real latest message, so an id the client made up',
				'can’t strand the thread as permanently read. 404s for a thread the caller isn’t on.',
			].join(' '),
			{ successDescription: 'Always 0 (success)', notFound: true }
		),
		(c) => markRead(c)
	)
	.on(
		['PUT', 'POST'],
		'/thread/:id{[0-9]+}/message/:messageId{[0-9]+}/read',
		chatResultRoute(
			'Mark read up to a specific message',
			[
				'What the client sends when the view sits on a message rather than the bottom. Same',
				'forward-only, clamped pointer as the whole-thread form. 404s for a thread the caller',
				'isn’t on.',
			].join(' '),
			{
				parameters: [
					{
						name: 'messageId',
						in: 'path',
						required: true,
						description: 'The message to read up to (digits only)',
						schema: { type: 'string' },
					},
				],
				successDescription: 'Always 0 (success)',
				notFound: true,
			}
		),
		(c) => markRead(c, Number.parseInt(c.req.param('messageId'), 10))
	)

	// A page of one thread's messages, newest first — a bare array, unlike /thread/:id.
	// `MessageCount` is the page size. 404 rather than 403 for a thread the caller isn't
	// in: whether a thread exists is itself private, so a non-member gets the same answer
	// as for a thread that's gone.
	.get(
		'/thread/:id{[0-9]+}/message',
		describeRoute({
			tags: ['Messages'],
			summary: 'A page of one thread’s messages',
			description: [
				'Newest first — a bare ARRAY, unlike `/thread/{id}`, which serves the thread object.',
				'`MessageCount` is the page size. 404 rather than 403 for a thread the caller isn’t in:',
				'whether a thread exists is itself private, so a non-member gets the same answer as for a',
				'thread that’s gone. An empty thread is still a 200 with `[]`.',
			].join(' '),
			security: AUTHED,
			parameters: [THREAD_ID_PARAM, messageCountParam(DEFAULT_MESSAGE_COUNT)],
			responses: {
				200: json(ChatMessageDto.array(), 'The page of messages, newest first (empty when none)'),
				401: UNAUTHORIZED_RESPONSE,
				404: NOT_A_MEMBER_RESPONSE,
			},
		}),
		async (c) => {
			const id = await authedId(c)
			if (id === null) return c.body(null, 401)

			const chatThreadId = Number.parseInt(c.req.param('id'), 10)
			if (!(await isThreadMember(c.env.DB, chatThreadId, id))) return c.notFound()

			return c.json(await getThreadMessages(c.env.DB, chatThreadId, { limit: messageCount(c) }))
		}
	)

// The generated spec. Documentation only — no request is validated against it (see
// openapi.ts). `hide: true` keeps this route out of its own output.
app.get(
	'/openapi.json',
	describeRoute({ hide: true }),
	withCleanSpec(
		openAPIRouteHandler(app, {
			documentation: {
				info: {
					title: 'recflare chat',
					version: '1.0.0',
					description: [
						'Chat threads and messages for recflare, a private-server reimplementation of the Rec',
						'Room backend. A thread is a conversation — a DM pair, a named group, or a system',
						'thread — and membership is both the authorization gate and the `playerIds` the client',
						'renders. Threads, membership and messages are D1-backed; every message also fans out',
						'over the `notify` hub Durable Object as a ChatMessageReceived frame, so a conversation',
						'updates live instead of on the next poll. (The hub frame carries a STRING `Id` — the',
						'client dispatches on it and silently drops a numeric one.)',
					].join('\n'),
				},
				servers: [{ url: 'https://chat.recflare.net', description: 'Production' }],
				components: {
					securitySchemes: {
						bearerAuth: {
							type: 'http',
							scheme: 'bearer',
							bearerFormat: 'JWT',
							description: 'An `access_token` from the auth worker’s `POST /connect/token`.',
						},
					},
				},
			},
		})
	)
)

export default app
