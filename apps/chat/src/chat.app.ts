import { Hono } from 'hono'
import { describeRoute, openAPIRouteHandler } from 'hono-openapi'
import { useWorkersLogger } from 'workers-tagged-logger'

import { logger, withCleanSpec, withNotFound, withOnError } from '@repo/hono-helpers'
import { validateAndGetAccountId } from '@repo/jwt'

import { censorSwears } from '../../api/src/sanitize'
import { NotificationType } from '../../notify/src/notification-types'
import { getThreadMessages } from './message-db'
import {
	AUTHED,
	ChatMessageDto,
	ChatPrivacySettingRequest,
	ChatPrivacySettings,
	ChatResult,
	ChatThreadDto,
	ChatThreadWithMessagesDto,
	CreatePartyChatResponse,
	CreateThreadRequest,
	CreateThreadResponse,
	FavoriteThreadRequest,
	form,
	json,
	messageCountParam,
	NOT_A_MEMBER_RESPONSE,
	PartyChatThread,
	PartyInviteSettings,
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
	ChatThreadType,
	createThread,
	getOrCreateThreadWithMembers,
	getThreadForPlayer,
	getThreadMemberIds,
	getPartyThreadForPlayer,
	getThreadMeta,
	getThreadsForPlayer,
	isThreadMember,
	joinedChatContents,
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
import type { App, Env } from './context'
import type { ChatMessage } from './message-db'
import type { ChatThread } from './thread-db'

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
 * Whether a party is still open to newcomers — `GET /thread/party` joins the caller only
 * inside this window, measured from the thread's `created_at`.
 *
 * It is the invite lifetime above, deliberately the same number rather than a second one:
 * a player joins a party by holding its id in `LatestPartyChat`, which is what an invite
 * puts there, so the join is the redemption of that invite and can't outlive it. A party
 * older than the window still belongs to the people already on it — this gates JOINING,
 * not reading, so nobody's own party expires out from under them.
 *
 * Fails CLOSED on a `created_at` that won't parse: no timestamp, no join. Nothing writes
 * one that can't, and the alternative is an unbounded join window on a corrupt row.
 */
function isPartyJoinable(createdAt: string, now = Date.now()): boolean {
	const opened = Date.parse(createdAt)
	if (Number.isNaN(opened)) return false
	return now - opened <= PARTY_INVITE_LIFETIME_MINUTES * 60_000
}

/**
 * Who may start a chat with a player — the client's `ChatPrivacy` enum, served numerically
 * like every other enum on this build. `Friends` is what a fresh account reports, and what
 * a player who has never touched their privacy screen reads back here.
 *
 * The PUT spells the same enum by NAME (`directMessagePrivacySetting=Favorites`); only the
 * GET is numeric. Both directions go through `parseChatPrivacy`, which takes either.
 */
const ChatPrivacy = {
	Friends: 0,
	Favorites: 1,
	NoOne: 2,
} as const

type ChatPrivacyValue = (typeof ChatPrivacy)[keyof typeof ChatPrivacy]

/** The enum member names, indexed by ordinal — what a stored setting holds. */
const CHAT_PRIVACY_NAMES = ['Friends', 'Favorites', 'NoOne'] as const

/**
 * The keys the two settings live under in the player's `playersettings` map. Chat has no
 * table of its own for them: they belong with the player's other toggles, and the settings
 * bag is already read and written per player.
 */
const DM_PRIVACY_KEY = 'directMessagePrivacySetting'
const GROUP_PRIVACY_KEY = 'groupChatPrivacySetting'

/**
 * Where a player's CURRENT party lives: the thread id of the party they most recently
 * opened, written by `POST /thread/party` and read back by the GET on the same path.
 *
 * It is a player setting rather than a column because the party is a property of the
 * PLAYER, not of the thread — "which party am I in" has one answer per person, and a
 * player is in exactly one at a time. The settings bag is already read and written per
 * player here, the same way the two privacy settings are.
 *
 * Nothing clears it: a party the player has left, or one that no longer exists, is
 * filtered out on the read instead, which also covers an id written by something else.
 */
const LATEST_PARTY_CHAT_KEY = 'LatestPartyChat'

/**
 * A `ChatPrivacy` out of whatever was stored or posted — the member name as the client
 * sends it (case-insensitively), or the ordinal as the GET serves it, since a value that
 * made a round trip through the settings bag could be spelled either way.
 *
 * `undefined` for anything unrecognized, which the read and the write treat differently: a
 * stored value that won't parse falls back to the default, but a posted one that won't
 * parse is a field worth leaving alone rather than a write of `Friends`.
 */
function parseChatPrivacy(value: string | undefined): ChatPrivacyValue | undefined {
	const raw = (value ?? '').trim()
	if (raw === '') return undefined

	const byName = CHAT_PRIVACY_NAMES.findIndex((n) => n.toLowerCase() === raw.toLowerCase())
	if (byName !== -1) return byName as ChatPrivacyValue

	const ordinal = Number.parseInt(raw, 10)
	return ordinal >= 0 && ordinal < CHAT_PRIVACY_NAMES.length
		? (ordinal as ChatPrivacyValue)
		: undefined
}

/** The player's settings map from the KV the `playersettings` worker owns. */
async function getPlayerSettings(
	env: Env,
	accountId: number
): Promise<Record<string, string> | null> {
	return env.RECFLARE_PLAYER_SETTINGS.get<Record<string, string>>(
		`player:${accountId}`,
		'json'
	).catch(() => null)
}

/**
 * A player's two chat privacy settings. Absent settings, an absent key and an unparseable
 * value all read `Friends` — the reference's default, and the safer of the two directions
 * to be wrong in: it describes a player as more private than this server enforces, rather
 * than less.
 */
async function readChatPrivacy(
	env: Env,
	accountId: number
): Promise<{
	directMessagePrivacySetting: ChatPrivacyValue
	groupChatPrivacySetting: ChatPrivacyValue
}> {
	const stored = (await getPlayerSettings(env, accountId)) ?? {}
	return {
		directMessagePrivacySetting: parseChatPrivacy(stored[DM_PRIVACY_KEY]) ?? ChatPrivacy.Friends,
		groupChatPrivacySetting: parseChatPrivacy(stored[GROUP_PRIVACY_KEY]) ?? ChatPrivacy.Friends,
	}
}

/**
 * Write the posted setting(s) back into the player's settings map.
 *
 * The write MERGES, exactly as the `playersettings` worker's own PUT does: the map holds
 * every setting the player has (OOBE state, tutorial mask, …), so storing these two on
 * their own would wipe the rest. Values are stored by NAME, the way the client posts them,
 * so the bag stays readable; `parseChatPrivacy` takes either spelling back.
 */
async function writeChatPrivacy(
	env: Env,
	accountId: number,
	settings: Partial<Record<typeof DM_PRIVACY_KEY | typeof GROUP_PRIVACY_KEY, ChatPrivacyValue>>
): Promise<void> {
	const patch: Record<string, string> = {}
	for (const [key, value] of Object.entries(settings)) {
		if (value !== undefined) patch[key] = CHAT_PRIVACY_NAMES[value]
	}
	await mergePlayerSettings(env, accountId, patch)
}

/**
 * Merge keys into the player's settings map, the way the `playersettings` worker's own PUT
 * does. Never a whole-map write: the bag holds every setting the player has (OOBE state,
 * tutorial mask, …) and storing one key on its own would wipe the rest. Values are strings,
 * which is what that worker stores and what its GET serves back.
 */
async function mergePlayerSettings(
	env: Env,
	accountId: number,
	patch: Record<string, string>
): Promise<void> {
	const merged: Record<string, string> = { ...(await getPlayerSettings(env, accountId)), ...patch }
	await env.RECFLARE_PLAYER_SETTINGS.put(`player:${accountId}`, JSON.stringify(merged))
}

/**
 * The thread id in the player's `LatestPartyChat` setting, or null when they have no party
 * — nothing stored, or something stored that isn't a positive integer (the bag's values are
 * strings, and this one could have been written by hand).
 */
async function readLatestPartyChatId(env: Env, accountId: number): Promise<number | null> {
	const stored = (await getPlayerSettings(env, accountId)) ?? {}
	const id = Number.parseInt(String(stored[LATEST_PARTY_CHAT_KEY] ?? ''), 10)
	return Number.isNaN(id) || id <= 0 ? null : id
}

/** The hub is a single global Durable Object instance, as every worker addresses it. */
const HUB_INSTANCE = 'global'

/**
 * Push a thread's most recent message to everyone on it. This is how a NEW thread
 * announces itself.
 *
 * The client has exactly two chat channels, `ChatMessageReceived` and `PlayerLeftChat`,
 * and both carry a MESSAGE: there is no "a thread was opened" or "you were added" frame to
 * send. So a conversation someone gains access to stays invisible on their client until a
 * message arrives on it — which is why `/thread/withmembers` used to go unnoticed until the
 * sender typed something, the thread having been created with only its "started a chat"
 * notice and that notice never having left the database.
 *
 * Sending the notice fixes that without inventing anything: the message being pushed is one
 * that genuinely exists on the thread. A no-op for a thread with nothing in it.
 */
async function pushThreadLatestMessage(c: Context<App>, chatThreadId: number): Promise<void> {
	const [latest] = await getThreadMessages(c.env.DB, chatThreadId, { limit: 1 })
	if (latest === undefined) return
	await pushChatMessage(c, latest)
}

/**
 * Announce that a player is now on a thread: post the `Player <@U…> joined` notice and push
 * it to the whole thread.
 *
 * The exact shape of the leave route's goodbye, and for the same reasons. Everyone is told,
 * not just the player who joined: a roster change is the thread's business — the others
 * need to know who they are talking to — and there is no roster channel to say it on, so
 * the notice is the message AND the signal. The new member is a member by the time this
 * runs, so the same push is what puts the conversation on their screen.
 *
 * Call it AFTER the membership row exists, or the joiner is left out of the fan-out.
 */
async function announceJoin(
	c: Context<App>,
	chatThreadId: number,
	playerId: number
): Promise<void> {
	const notice = await postMessage(c.env.DB, {
		chatThreadId,
		senderPlayerId: SYSTEM_SENDER_ID,
		contents: joinedChatContents(playerId),
	})
	await pushChatMessage(c, notice)
}

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
 * The message envelope with the player's own words masked, as it will be stored.
 *
 * The same filter `api`'s `POST /api/sanitize/v1` runs, applied again here because
 * nothing obliges the client to have called it: a message posted straight to this
 * endpoint would otherwise reach every member of the thread unfiltered.
 *
 * Only `Data` — the text the player typed — is censored. `Type`, `Version`, the `Blocks`
 * array and whatever else the client packs alongside are copied through untouched: the
 * rest of the envelope is the client's own business and this server doesn't know what
 * most of it means. The
 * mask is one character per character, so lengths (and therefore the envelope) survive
 * intact, and a Version 2 `Data` keeps its `<=>` prefix — the marker isn't a word, so
 * whole-word matching never reaches it.
 *
 * Contents that aren't a JSON object, or whose `Data` isn't a string, are censored
 * whole: a hand-written `messageContents=hi` is plain text with nothing in it to
 * preserve. Text with nothing to object to comes back as the very bytes that were sent,
 * which is the common case — the envelope is only rebuilt when something was masked.
 *
 * Blocked characters are deliberately NOT stripped the way `PreRemoveBlockedCharacters`
 * strips them: chat carries emoji, and the format characters that rule removes include
 * the zero-width joiners holding a multi-person emoji together.
 */
function censorContents(contents: string): string {
	let envelope: unknown
	try {
		envelope = JSON.parse(contents)
	} catch {
		return censorSwears(contents)
	}
	if (typeof envelope !== 'object' || envelope === null || Array.isArray(envelope)) {
		return censorSwears(contents)
	}

	const fields = envelope as Record<string, unknown>
	const data = fields.Data
	if (typeof data !== 'string') return contents

	const censored = censorSwears(data)
	return censored === data ? contents : JSON.stringify({ ...fields, Data: censored })
}

/**
 * A stored message in the PascalCase shape the client's SendMessage handler reads back, as
 * distinct from the camelCase {@link ChatMessage} the thread payloads carry. Same six
 * fields; the client reads them in two places under two spellings.
 *
 * `Contents` goes out exactly as stored, which is what makes the envelope discipline matter:
 * the client parses it into `MessageJson` in a post-deserialize hook, and anything that
 * isn't an escaped `{ Type, Version, Data }` with a non-null `Data` leaves that null. The
 * hook only logs, so the client then throws on the null instead of showing the message.
 */
function toSentChatMessage(message: ChatMessage) {
	return {
		ChatMessageId: message.chatMessageId,
		ChatThreadId: message.chatThreadId,
		SenderPlayerId: message.senderPlayerId,
		TimeSent: message.timeSent,
		Contents: message.contents,
		ModerationState: message.moderationState,
	}
}

/**
 * A thread in the PascalCase shape `POST /thread/party` answers — the client's
 * CreatePartyChat formatter, which is its own and reads none of the camelCase keys the
 * thread payloads carry. Ten wire keys; see {@link PartyChatThread} for why the CLR
 * type's other three never appear.
 *
 * `Messages` and `LatestMessage` are both present here, unlike the camelCase pair which
 * carries one or the other, and `ChatThreadName` goes out NULL when unnamed rather than
 * as the empty string the camelCase projections must send.
 */
function toPartyChatThread(thread: ChatThread, messages: ChatMessage[]) {
	return {
		ChatThreadId: thread.chatThreadId,
		ChatThreadType: thread.chatThreadType,
		LastReadMessageId: thread.lastReadMessageId,
		Messages: messages.map(toSentChatMessage),
		LatestMessage: thread.latestMessage === null ? null : toSentChatMessage(thread.latestMessage),
		PlayerIds: thread.playerIds,
		// This formatter takes the null; only the camelCase projections have to send ''.
		ChatThreadName: thread.chatThreadName === '' ? null : thread.chatThreadName,
		SnoozedUntil: thread.snoozedUntil,
		IsFavorited: thread.isFavorited,
		// No thread on this table carries a club — club chat lives in the `clubs` worker.
		ClubId: null,
	}
}

/**
 * Send a message to a thread that already exists — every message after the one that
 * opened the conversation. `/thread/18` is what the client posts; `/thread/18/message` is
 * the same call under the reference's other spelling, so both routes land here.
 *
 * Answers the message just posted (`ChatMessage`/`ChatResult`, which is what the client's
 * own send handler reads) AND the whole thread with its messages (`chatResult`/`chatThread`,
 * which the conversation re-renders from). Blank or missing contents stores nothing and
 * reports invalid-arguments, still with the thread attached, rather than an error status —
 * and with a NULL `ChatMessage`, which is safe because the client only dereferences it on
 * result 0.
 */
async function sendToThread(c: Context<App>) {
	const id = await authedId(c)
	if (id === null) return c.body(null, 401)

	const chatThreadId = Number.parseInt(c.req.param('id') ?? '', 10)
	if (!(await isThreadMember(c.env.DB, chatThreadId, id))) return c.notFound()

	// Stored as sent but for the profanity mask: the envelope carries its own Type/Version
	// and may hold fields we know nothing about (the client sends Version 2 with a `<=>`
	// prefix in Data, and a `Blocks` array alongside it), so `censorContents` rewrites the
	// player's `Data` and nothing else.
	const contents = (await formField(c, 'messageContents'))?.trim()
	const posted =
		contents === undefined || contents === ''
			? null
			: await postMessage(c.env.DB, {
					chatThreadId,
					senderPlayerId: id,
					contents: censorContents(contents),
				})
	if (posted !== null) {
		await pushChatMessage(c, posted)
		// Sending is reading: the reference answers with `lastReadMessageId` already at the
		// message just posted, so the sender's own thread doesn't come back unread.
		await markThreadRead(c.env.DB, chatThreadId, id, posted.chatMessageId)
	}

	const thread = await threadWithMessages(c, chatThreadId, id, DEFAULT_THREAD_MESSAGE_COUNT)
	const chatResult = posted === null ? CHAT_INVALID_ARGUMENTS : CHAT_SUCCESS
	// Both spellings, because the client reads this response in two places. Its SendMessage
	// handler dereferences `ChatMessage` the moment `ChatResult` is 0, so a success answered
	// without one throws inside the client — the lowercase pair alone left that null. The
	// thread stays for the conversation re-render. One value, serialized twice, so the two
	// result keys can never disagree.
	return c.json({
		ChatMessage: posted === null ? null : toSentChatMessage(posted),
		ChatResult: chatResult,
		chatResult,
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
			'Every message after the one that opened the conversation. Answers FOUR keys in two',
			'spellings: `ChatMessage`/`ChatResult`, which is what the client’s own send handler reads',
			'— it dereferences `ChatMessage` as soon as `ChatResult` is 0, so a success without one',
			'throws inside the client — plus `chatResult`/`chatThread`, the WHOLE thread with its',
			'messages, which the conversation re-renders from. The two result keys are one value',
			'serialized twice. `ChatMessage.Contents` is the stored envelope verbatim, and it MUST',
			'parse to `{ Type, Version, Data }` with a non-null `Data`: the client parses it into',
			'`MessageJson` in a post-deserialize hook that only logs on failure, then dereferences the',
			'null. The envelope’s',
			'`Data` goes through the same profanity filter `api`’s `POST /api/sanitize/v1` runs, masked',
			'one `*` per character; every other field is stored as sent. Blank or',
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
	// (`{"Type":0,"Version":1,"Data":"…"}`), stored as sent but for the profanity mask
	// `censorContents` puts over `Data` — the same filter the later messages go through,
	// since the first one is no different. The client also sends it blank, right after
	// /thread/withmembers: that opens the thread without posting an empty message, and
	// reports invalid-arguments the way the reference does.
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

			const { chatThreadId, created } = await getOrCreateThreadWithMembers(c.env.DB, members, id)
			// A thread nobody has been told about is a thread nobody sees. Push its opening
			// notice the moment it exists, rather than leaving the conversation to surface on
			// whatever message happens to follow — there may not be one: this route is also
			// called with an empty `messageContents`.
			if (created) await pushThreadLatestMessage(c, chatThreadId)

			const contents = (await formField(c, 'messageContents'))?.trim()
			const posted =
				contents === undefined || contents === ''
					? null
					: await postMessage(c.env.DB, {
							chatThreadId,
							senderPlayerId: id,
							contents: censorContents(contents),
						})
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

	// The caller's current party (`/thread/party?maxCount=1&mode=0`) — the client's
	// GetPartyChat.
	//
	// TWO paths, cheapest first:
	//
	//  1. ALREADY IN A PARTY — one D1 query (`getPartyThreadForPlayer`: the membership join,
	//     filtered to party threads, newest first) answers it outright. This is the common
	//     case, every read after the first, and it touches the settings KV not at all.
	//  2. NOT IN ONE YET — only then is the caller's `LatestPartyChat` player setting read.
	//     The POST below writes that key for the player who OPENED the party; the client
	//     writes it (through `playersettings`) for a player pulled into someone else's. Such
	//     a player holds the key but no membership row — nothing has added them — so a
	//     membership-only read answered them "no party", which is the bug the join fixes.
	//     The read puts them on the thread and then serves it: `GET /thread/party` is how
	//     you enter a party, not merely how you look at one.
	//
	// Reaching path 2 means the caller is in NO party, so they cannot already be a member of
	// the thread the key names — which is why the join here needs no membership check of its
	// own, and why the age gate below can be unconditional.
	//
	// On path 2 the thread is checked to exist, to be a party, and to be YOUNGER THAN THE
	// INVITE LIFETIME before anyone is added to it, so a key naming a DM, a thread that is
	// gone, or an hours-old party can't produce a membership row in it.
	//
	// The age check gates JOINING only — path 1 never reaches it, so a party keeps being
	// served to the players already on it however old it is, rather than going dark on them
	// after an hour. `LatestPartyChat` is the caller's own player setting, which the client
	// can PUT to anything through the `playersettings` worker, so the key IS the invite here
	// and the window is what keeps it from being a permanent one. Tighten further (an invite
	// the party actually issued) if parties ever need to be closed outright.
	//
	// SAME PATH, DIFFERENT BODY from the POST: this one is the BARE thread, with no
	// `{ ChatThread, ChatResult }` wrapper around it. Same ten-key PascalCase projection
	// inside, so the two share `toPartyChatThread` — but nothing else, which is why these
	// are two handlers rather than one verb-agnostic one.
	//
	// No party answers `{}`: the client parses that as a thread with everything at its
	// default, which reads as "no party", where a 404 or a null body would fail its
	// deserializer.
	//
	// `maxCount` and `mode` are accepted and ignored. `maxCount=1` is most likely the
	// number of party chats wanted, which is already what a single-thread body serves; if
	// it turns out to size `Messages` instead, ignoring it only ever serves MORE history
	// than asked for, where guessing wrong the other way would truncate the party's
	// messages to one. `mode` is unknown.
	.get(
		'/thread/party',
		describeRoute({
			tags: ['Threads'],
			summary: 'The caller’s current party thread (GetPartyChat)',
			description: [
				'The party the caller is currently in: the newest party thread they are a member of,',
				'answered from a single query. Failing that, the thread named by their own',
				'`LatestPartyChat` player setting — which `POST /thread/party` writes for the player',
				'who opened the party and the client writes for a player who joins someone else’s.',
				'',
				'That second path JOINS: a caller who is not on any party yet is ADDED to the thread',
				'their key names and then served it, which is how a player pulled into someone else’s',
				'party enters it — they hold the key but no membership row, and a membership-only read',
				'answers them "no party". The thread must exist, be a party, and be younger than the',
				'60-minute invite lifetime before anyone is added, so a key naming a DM, a deleted',
				'thread or a stale party answers `{}` and writes nothing. The age gate is on JOINING',
				'only — a player already on a party is served it however old it is. A join posts a',
				'"Player <@U…> joined" notice and pushes it to the party, so the people already in it',
				'see who arrived.',
				'',
				'The BARE thread, unlike the POST on the same path, which wraps the same projection in',
				'`{ ChatThread, ChatResult }`. `maxCount` and `mode` are accepted and ignored.',
			].join(' '),
			security: AUTHED,
			parameters: [
				{
					name: 'maxCount',
					in: 'query',
					required: false,
					description: 'Page size the client sends (1). Accepted and ignored',
					schema: { type: 'integer' },
				},
				{
					name: 'mode',
					in: 'query',
					required: false,
					description: 'Unknown mode selector the client sends (0). Accepted and ignored',
					schema: { type: 'integer' },
				},
			],
			responses: {
				200: json(PartyChatThread, 'The caller’s party, or `{}` when they have none'),
				401: UNAUTHORIZED_RESPONSE,
			},
		}),
		async (c) => {
			const id = await authedId(c)
			if (id === null) return c.body(null, 401)

			// Path 1: already in a party. One query, no settings read.
			let thread = await getPartyThreadForPlayer(c.env.DB, id)

			// Path 2: not in one — the key is the only thing that can name a party to join.
			if (thread === null) {
				const chatThreadId = await readLatestPartyChatId(c.env, id)
				if (chatThreadId === null) return c.json({})

				// Checked BEFORE the join: a gone thread, one of some other type, or a party
				// too old to still be taking people isn't something to put anybody on —
				// whoever wrote the key.
				const meta = await getThreadMeta(c.env.DB, chatThreadId)
				if (meta === null || meta.chatThreadType !== ChatThreadType.Party) return c.json({})
				if (!isPartyJoinable(meta.createdAt)) return c.json({})

				await addThreadMember(c.env.DB, chatThreadId, id)
				// The same announcement the add-member route makes: the party learns someone
				// walked in. It is also usually a party's FIRST message — one opens empty.
				await announceJoin(c, chatThreadId, id)
				thread = await getThreadForPlayer(c.env.DB, chatThreadId, id)
				if (thread === null) throw new Error(`party thread ${chatThreadId} vanished after join`)
			}

			const messages = await getThreadMessages(c.env.DB, thread.chatThreadId, {
				limit: DEFAULT_THREAD_MESSAGE_COUNT,
			})
			return c.json(toPartyChatThread(thread, messages))
		}
	)

	// Open a party — the client's CreatePartyChat. A thread of type 2
	// (`ChatThreadType.Party`) holding only the caller, which the client then fills by
	// inviting people onto it (`POST /thread/{id}/member/{playerId}`). The one place a
	// thread is opened with a single member: every other create refuses a roster of just
	// yourself, because a DM with nobody in it is a mistake, whereas a party you are so far
	// the only member of is exactly what starting one looks like.
	//
	// Takes NO query params and NO body — the client posts to the bare path.
	//
	// Always a NEW party, never a fetch-or-create: a party is a session, not a standing
	// conversation with a set of people, so resolving to the one you left this morning
	// would hand the invitees its history.
	//
	// It opens EMPTY — no system "started a chat" notice, unlike every other new thread
	// here. The observed response carries `Messages: []` with a null `LatestMessage`, so a
	// notice would be a message the reference doesn't post.
	//
	// The body is the PascalCase `{ ChatThread, ChatResult }` wrapper, bare — no
	// `{ success, error, value }` envelope — and the thread inside it is its own
	// projection: ten keys, both `Messages` and `LatestMessage`, a null `ChatThreadName`,
	// and a `ClubId` that exists nowhere else. See `toPartyChatThread`.
	.post(
		'/thread/party',
		describeRoute({
			tags: ['Threads'],
			summary: 'Open a party thread for the caller (CreatePartyChat)',
			description: [
				'The client’s CreatePartyChat. Opens a thread of type 2 (Party) whose only member is',
				'the caller — the client fills it by inviting players on afterwards. No query params',
				'and no body. Always a new party, never a fetch-or-create: a party is a session rather',
				'than a standing conversation, so an old one would hand the invitees its history. The',
				'only create that accepts a roster of just the caller, and the only one that opens with',
				'no messages at all — no “started a chat” notice, matching the observed',
				'`Messages: []`. Records the new thread as the caller’s `LatestPartyChat` player',
				'setting, which is where `GET /thread/party` looks for it. Answers the bare PascalCase',
				'`{ ChatThread, ChatResult }` wrapper, whose thread is a projection of its own — not the',
				'camelCase shape the other thread routes serve.',
			].join(' '),
			security: AUTHED,
			responses: {
				200: json(CreatePartyChatResponse, 'The new party thread, empty, with ChatResult 0'),
				401: UNAUTHORIZED_RESPONSE,
			},
		}),
		async (c) => {
			const id = await authedId(c)
			if (id === null) return c.body(null, 401)

			const chatThreadId = await createThread(c.env.DB, [id], null, undefined, ChatThreadType.Party)
			// This is what makes the party findable: the GET resolves the caller's current
			// party through this key and nothing else. Written before the response, so a
			// client that opens the party and immediately re-reads it can't miss it.
			await mergePlayerSettings(c.env, id, { [LATEST_PARTY_CHAT_KEY]: String(chatThreadId) })

			const thread = await getThreadForPlayer(c.env.DB, chatThreadId, id)
			if (thread === null) throw new Error(`party thread ${chatThreadId} vanished after creation`)
			// Read the messages back rather than assuming []: the party is empty as it is
			// created, but the projection shouldn't be the thing that says so.
			const messages = await getThreadMessages(c.env.DB, chatThreadId, {
				limit: DEFAULT_THREAD_MESSAGE_COUNT,
			})
			return c.json({
				ChatThread: toPartyChatThread(thread, messages),
				ChatResult: CHAT_SUCCESS,
			})
		}
	)

	// The caller's chat privacy settings — who may DM them, and who may pull them into a
	// group chat — read out of their `playersettings` map. A player who has never opened the
	// privacy screen reads `Friends` for both, the reference's default and the safer of the
	// two directions to be wrong in: it describes a player as more private than the server
	// actually enforces, rather than less.
	//
	// STORED, NOT ENFORCED. The PUT below keeps the player's choice, but nothing checks it:
	// the DM check further down allows every message regardless, because this server has no
	// friends/favorites list to test a sender against. Wire the two together once it does —
	// a screen that says "Favorites" while anyone can message you is worse than one that
	// says nothing.
	//
	// `playerId` comes off the TOKEN, not a query param: the answer is about the caller.
	.get(
		'/thread/chatPrivacySetting',
		describeRoute({
			tags: ['Threads'],
			summary: 'The caller’s chat privacy settings',
			description: [
				'Who may direct-message the caller and who may add them to a group chat, as the',
				'`ChatPrivacy` enum by NUMBER (0 Friends · 1 Favorites · 2 NoOne) — note the PUT takes',
				'the same enum by NAME. Read from the caller’s `playersettings` map; a player who has',
				'never set them reads `Friends` for both, as does one whose stored value won’t parse.',
				'Stored but not enforced: the DM check allows every message. `playerId` is the caller,',
				'read from the token.',
			].join(' '),
			security: AUTHED,
			responses: {
				200: json(ChatPrivacySettings, 'The caller’s stored settings (Friends/Friends by default)'),
				401: UNAUTHORIZED_RESPONSE,
			},
		}),
		async (c) => {
			const id = await authedId(c)
			if (id === null) return c.body(null, 401)
			return c.json({ playerId: id, ...(await readChatPrivacy(c.env, id)) })
		}
	)

	// Set one of the two settings. The client PUTs whichever row of its privacy screen the
	// player just changed — `directMessagePrivacySetting=Favorites` OR
	// `groupChatPrivacySetting=Favorites`, never both — so a field that isn't in the body is
	// left alone rather than reset to the default, which would silently undo the other row.
	//
	// The body spells the enum by NAME while the GET answers the ordinal; that asymmetry is
	// the client's, not a mistake here. An unrecognized value writes nothing.
	//
	// Answers the RESULTING settings, the same body the GET serves, rather than an empty
	// ack: the client has just changed a toggle it renders, and a body it can read back
	// can't disagree with what was stored.
	.put(
		'/thread/chatPrivacySetting',
		describeRoute({
			tags: ['Threads'],
			summary: 'Set the caller’s chat privacy settings',
			description: [
				'Stores the posted setting(s) in the caller’s `playersettings` map and answers the',
				'resulting settings — the same body `GET /thread/chatPrivacySetting` serves, with the',
				'enum by NUMBER. The body names the enum by NAME',
				'(`directMessagePrivacySetting=Favorites`); the ordinal is accepted too. The client',
				'sends one field per call, so an absent field leaves that setting as it was, and the',
				'write merges into the settings map so the player’s other settings are untouched. A',
				'body with nothing readable in it is a no-op 200 answering the stored settings, not a',
				'400. Stored, not enforced: nothing checks these when a message is sent.',
			].join(' '),
			security: AUTHED,
			requestBody: form(ChatPrivacySettingRequest, 'The setting(s) to store'),
			responses: {
				200: json(ChatPrivacySettings, 'The caller’s settings as they now stand'),
				401: UNAUTHORIZED_RESPONSE,
			},
		}),
		async (c) => {
			const id = await authedId(c)
			if (id === null) return c.body(null, 401)

			const posted = {
				[DM_PRIVACY_KEY]: parseChatPrivacy(await formField(c, DM_PRIVACY_KEY)),
				[GROUP_PRIVACY_KEY]: parseChatPrivacy(await formField(c, GROUP_PRIVACY_KEY)),
			}
			if (posted[DM_PRIVACY_KEY] !== undefined || posted[GROUP_PRIVACY_KEY] !== undefined) {
				await writeChatPrivacy(c.env, id, posted)
			}

			return c.json({ playerId: id, ...(await readChatPrivacy(c.env, id)) })
		}
	)

	// May the caller DM this player? Asked before the client opens a new direct message, so
	// it can grey the button out rather than let the send fail. Always 0 (Success): the
	// setting the name refers to is stored (see `/thread/chatPrivacySetting`) but can't be
	// checked, since Friends and Favorites both need a friends list this server doesn't
	// keep. Enforce it here the moment one exists.
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
				'caller’s own privacy setting) or 16 (the other player’s). Always 0 here: the settings',
				'`/thread/chatPrivacySetting` stores are not enforced, since Friends and Favorites both',
				'need a friends list this server doesn’t keep.',
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

			const { chatThreadId, created } = await getOrCreateThreadWithMembers(c.env.DB, members, id)
			// The reported bug: this opened the thread silently, so the other player saw
			// nothing until the first message landed. The opening notice is what tells them.
			if (created) await pushThreadLatestMessage(c, chatThreadId)

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
				'Idempotent — re-adding an existing member changes nothing. On success a',
				'"Player <@U…> joined" system notice is posted and pushed to the whole thread: the',
				'existing members because the roster changed, the new one because that push is what',
				'puts the conversation on their screen.',
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
			// Everyone hears about it — the existing members because the roster changed under
			// them, the new one because this is what puts the conversation on their screen.
			await announceJoin(c, chatThreadId, playerId)
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
