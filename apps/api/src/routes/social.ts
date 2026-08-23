import { Hono } from 'hono'
import { describeRoute } from 'hono-openapi'

import {
	acceptFriendRequest,
	addFriend,
	countOnlineFriends,
	getAccountsByIds,
	getMutualFriendIds,
	getRelationshipsForPlayer,
	MUTUAL_FRIENDS_LIMIT,
	removeFriend,
	sendFriendRequest,
	setRelationshipFlag,
} from '@repo/domain'
import { logger } from '@repo/hono-helpers'

// The notification-type ids the hub carries (owned by the `notify` worker). Imported
// as a value — the enum has no runtime dependencies.
import { NotificationType } from '../../../notify/src/notification-types'
import { authedId, unauthorized } from '../http'
import {
	AckResponse,
	AUTHED,
	ErrorResponse,
	form,
	FriendOnlineCountResponse,
	intQuery,
	json,
	JsonArray,
	jsonBody,
	MutualFriendDto,
	RelationshipDto,
	SendMessageRequest,
	SendMultipleMessagesRequest,
	SuccessErrorEnvelope,
	UNAUTHORIZED_RESPONSE,
} from '../openapi'

import type { Context } from 'hono'
import type {
	RelationshipChange,
	RelationshipFlag,
	RelationshipResponse,
} from '@repo/domain'
import type { App } from '../context'

/** The notifications hub is a single global DO instance (see the `notify` worker). */
const HUB_INSTANCE = 'global'

/**
 * The Message a `MessageReceived` frame carries. A type alias rather than an interface:
 * `notifyPlayer` takes an index-signature record, which only aliases satisfy implicitly.
 */
type Message = {
	FromPlayerId: number
	ToPlayerId: number
	Type: number
	Data: string
}

/**
 * Push one `MessageReceived` frame, resolving false when the hub could not be reached.
 * Unlike the relationship pushes, a failure here is NOT swallowed by the caller: there
 * is no message store behind this, so the notification is the whole delivery.
 */
async function pushMessage(c: Context<App>, message: Message): Promise<boolean> {
	try {
		await c.env.RECFLARE_NOTIFICATIONS_HUB.getByName(HUB_INSTANCE).notifyPlayer(
			message.ToPlayerId,
			NotificationType.MessageReceived,
			message
		)
		return true
	} catch (err) {
		logger.error('failed to push MessageReceived notification', {
			toPlayerId: message.ToPlayerId,
			error: err instanceof Error ? err.message : String(err),
		})
		return false
	}
}

/**
 * Push a `RelationshipChanged` notification carrying `rel` to one player. Hub failures are
 * logged and swallowed — the DB write has already committed, so a hub hiccup must not fail
 * the request.
 */
async function notifyRelationship(
	c: Context<App>,
	playerId: number,
	rel: RelationshipResponse
): Promise<void> {
	try {
		await c.env.RECFLARE_NOTIFICATIONS_HUB.getByName(HUB_INSTANCE).notifyPlayer(
			playerId,
			NotificationType.RelationshipChanged,
			{ ...rel }
		)
	} catch (err) {
		logger.error('failed to push RelationshipChanged notification', {
			playerId,
			error: err instanceof Error ? err.message : String(err),
		})
	}
}

/**
 * Notify both players of a friend-graph change, each with the relationship projected from
 * their own point of view — the target of a request sees `FriendRequestReceived` where the
 * sender sees `Sent`, so the two payloads differ. A no-op mutation notifies nobody.
 */
async function notifyBoth(
	c: Context<App>,
	playerId: number,
	otherId: number,
	change: RelationshipChange
): Promise<void> {
	if (!change.changed) return
	await notifyRelationship(c, playerId, change.self)
	await notifyRelationship(c, otherId, change.other)
}

/**
 * Apply a per-player relationship flag toggle (favorited/ignored/muted). The flags are
 * private to the caller's own side of the row, so only the caller is notified. The
 * resulting relationship rides the notification and the HTTP body is just the
 * `{ Success, Message }` ack.
 */
async function applyFlag(
	c: Context<App>,
	playerId: number,
	otherId: number,
	flag: RelationshipFlag,
	value: boolean
): Promise<Response> {
	const rel = await setRelationshipFlag(c.env.DB, playerId, otherId, flag, value)
	await notifyRelationship(c, playerId, rel)
	return c.json({ Success: true, Message: '' })
}

/**
 * Read the other player's id from a relationship-mutation request. The exact wire
 * shape is still TBD, so this is liberal: it accepts `playerId`/`id` as a query
 * param and `PlayerId`/`playerId`/`Id` from a JSON or form body. Returns null when
 * no integer id is present.
 */
async function targetPlayerId(c: Context<App>): Promise<number | null> {
	const fromQuery = c.req.query('playerId') ?? c.req.query('id')
	if (fromQuery !== undefined) {
		const n = Number.parseInt(fromQuery, 10)
		if (!Number.isNaN(n)) return n
	}
	// Body may be JSON or form-encoded; Hono's parseBody only handles the latter.
	const contentType = c.req.header('content-type') ?? ''
	const body = contentType.includes('application/json')
		? await c.req.json<Record<string, unknown>>().catch(() => ({}) as Record<string, unknown>)
		: ((await c.req.parseBody().catch(() => ({}))) as Record<string, unknown>)
	const raw = body.PlayerId ?? body.playerId ?? body.Id
	if (typeof raw === 'number') return Number.isNaN(raw) ? null : raw
	if (typeof raw === 'string') {
		const n = Number.parseInt(raw, 10)
		if (!Number.isNaN(n)) return n
	}
	return null
}

/**
 * How every relationship mutation names its target. The handler is liberal — it also
 * accepts `PlayerId`/`playerId`/`Id` from a JSON or form body — but the client sends the
 * query param, so that's what the spec documents.
 */
const TARGET_PARAMS = [
	intQuery('id', 'The other player. The client uses this form.'),
	intQuery('playerId', 'Accepted as an alias for `id`'),
]

/**
 * A `describeRoute` spec for one of the four friend-graph mutations. These change state
 * both players can see, so each also pushes a RelationshipChanged notification to both
 * sides; the HTTP body is the caller's own projection.
 */
function friendMutation(summary: string, description: string) {
	return describeRoute({
		tags: ['Social'],
		summary,
		description,
		security: AUTHED,
		parameters: TARGET_PARAMS,
		responses: {
			200: json(RelationshipDto, 'The relationship, from the caller’s point of view'),
			400: json(ErrorResponse, 'No target id, or the caller targeting themselves'),
			401: UNAUTHORIZED_RESPONSE,
		},
	})
}

/**
 * A `describeRoute` spec for a per-side flag toggle (favorite / ignore / mute and their
 * inverses). The write lands on the caller's own side of the row, so only the caller is
 * notified — and the resulting relationship rides that notification, not the response,
 * which is just the ack.
 */
function flagToggle(summary: string, description: string) {
	return describeRoute({
		tags: ['Social'],
		summary,
		description,
		security: AUTHED,
		parameters: TARGET_PARAMS,
		responses: {
			200: json(AckResponse, 'The ack; the relationship arrives over the notification hub'),
			400: json(ErrorResponse, 'No target id, or the caller targeting themselves'),
			401: UNAUTHORIZED_RESPONSE,
		},
	})
}

// ---- Social ----------------------------------------------------------------
export const socialRoutes = new Hono<App>({ strict: false })
	// The authed player's relationships, projected from their point of view — a bare
	// array of RelationshipResponse. Auth-gated.
	.get(
		'/api/relationships/v2/get',
		describeRoute({
			tags: ['Social'],
			summary: 'The caller’s relationships',
			description:
				'Every relationship the signed-in player has, projected from their point of view — ' +
				'a bare array. `None` rows are included: that is how an unfriending, or an ' +
				'ignore/mute of someone you were never friends with, is recorded, and they still ' +
				'carry the caller’s favorited/ignored/muted flags.',
			security: AUTHED,
			responses: {
				200: json(RelationshipDto.array(), 'The caller’s relationships'),
				401: UNAUTHORIZED_RESPONSE,
			},
		}),
		async (c) => {
			const id = await authedId(c)
			if (id === null) return unauthorized(c)
			return c.json(await getRelationshipsForPlayer(c.env.DB, id))
		}
	)

	// The friends the caller and another player have in common. Unlike the other
	// relationship routes this answers account cards, not relationships — it's what the
	// client shows on someone else's profile.
	.get(
		'/api/relationships/mutualfriends',
		describeRoute({
			tags: ['Social'],
			summary: 'Friends in common with another player',
			description:
				'The accounts the caller and `id` are both friends with — a bare array, ascending ' +
				`by account id and capped at ${MUTUAL_FRIENDS_LIMIT}. Only real friendships count; ` +
				'pending requests on either side are ignored.\n\n' +
				'Answers an empty array rather than an error for the degenerate cases: no target ' +
				'id, an id of 0 or below, or the caller asking for mutuals with themselves. ' +
				'Mutual ids with no account row are dropped, so the list can be shorter than the ' +
				'intersection.\n\n' +
				'Each entry is a trimmed account card. `ProfileImage` is an empty string, never ' +
				'null, when the account has no image.',
			security: AUTHED,
			parameters: [intQuery('id', 'The other player')],
			responses: {
				200: json(MutualFriendDto.array(), 'The shared friends; empty when there are none'),
				401: UNAUTHORIZED_RESPONSE,
			},
		}),
		async (c) => {
			const id = await authedId(c)
			if (id === null) return unauthorized(c)

			const raw = c.req.query('id')
			const otherId = raw === undefined ? Number.NaN : Number.parseInt(raw, 10)
			// Nothing to intersect: no/garbage id, a non-positive one, or the caller
			// themselves. An empty list, not an error — this feeds a profile panel.
			if (Number.isNaN(otherId) || otherId <= 0 || otherId === id) return c.json([])

			const mutualIds = await getMutualFriendIds(c.env.DB, id, otherId)
			const accounts = await getAccountsByIds(c.env.DB, mutualIds)
			return c.json(
				accounts
					.map((a) => ({
						AccountId: a.accountId,
						Username: a.username,
						DisplayName: a.displayName,
						ProfileImage: a.profileImage ?? '',
					}))
					// getAccountsByIds doesn't promise an order; keep the ascending one.
					.sort((a, b) => a.AccountId - b.AccountId)
			)
		}
	)

	// A message from one player to another — the "invite me!" style prompts the client
	// sends. Nothing is stored: the message IS the notification, pushed to the
	// recipient's hub connection (and queued by the hub if they're offline).
	.post(
		'/api/messages/v2/send',
		describeRoute({
			tags: ['Social'],
			summary: 'Send a message to another player',
			description:
				'Pushes a `MessageReceived` notification to `ToPlayerId` carrying the message — ' +
				'the same frame the Coach broadcast sends (see the `notify` worker’s ' +
				'`coachMessageAll`), except `FromPlayerId` is the caller rather than the Coach ' +
				'account and it goes to one player. The hub queues it when the recipient is ' +
				'offline, so it arrives on their next connect.\n\n' +
				'Nothing is persisted here — there is no message store, the notification is the ' +
				'whole delivery. The sender is the caller (from the bearer token), NOT a body ' +
				'field. `Type` is a Message-model type (a different enum from `NotificationType`) ' +
				'passed through unmapped, defaulting to 0; `Data` is the payload and is commonly ' +
				'empty.\n\n' +
				'Answers the same `{ success, error }` envelope as the report / warning writes, ' +
				'`error` an empty string on success. A hub failure is reported honestly as a 500 ' +
				'with `success: false` — with no store behind it, a swallowed error would be a ' +
				'silently dropped message.',
			security: AUTHED,
			requestBody: form(SendMessageRequest, 'The message'),
			responses: {
				200: json(SuccessErrorEnvelope, '`{ success: true, error: "" }`'),
				400: json(SuccessErrorEnvelope, 'No `ToPlayerId` in the request'),
				401: UNAUTHORIZED_RESPONSE,
				500: json(SuccessErrorEnvelope, 'The notifications hub could not be reached'),
			},
		}),
		async (c) => {
			const fromPlayerId = await authedId(c)
			if (fromPlayerId === null) return unauthorized(c)

			const body = (await c.req.parseBody().catch(() => ({}))) as Record<string, unknown>
			const str = (v: unknown): string | undefined => (typeof v === 'string' ? v : undefined)
			const toPlayerId = Number.parseInt(str(body.ToPlayerId) ?? '', 10)
			if (Number.isNaN(toPlayerId)) {
				return c.json({ success: false, error: 'ToPlayerId is required' }, 400)
			}

			// The Message the notification carries. Mirrors the coach message's shape with
			// a real sender and recipient; `Data` stays a string, empty included (the hub
			// drops only null/undefined from the frame).
			const delivered = await pushMessage(c, {
				FromPlayerId: fromPlayerId,
				ToPlayerId: toPlayerId,
				Type: Number.parseInt(str(body.Type) ?? '', 10) || 0,
				Data: str(body.Data) ?? '',
			})
			if (!delivered) {
				return c.json({ success: false, error: 'Failed to deliver message' }, 500)
			}

			return c.json({ success: true, error: '' })
		}
	)

	// The bulk form of the send above: one message, several recipients. Posted as JSON
	// (`{"ToPlayerIds":[205],"Type":20,"Data":""}`), not the form encoding the single
	// send uses, so `Type` arrives as a number here.
	.post(
		'/api/messages/v1/sendMultiple',
		describeRoute({
			tags: ['Social'],
			summary: 'Send one message to several players',
			description:
				'The bulk form of `POST /api/messages/v2/send`: pushes the same ' +
				'`MessageReceived` frame to every id in `ToPlayerIds`, each addressed to its own ' +
				'recipient (`ToPlayerId` differs per frame — the payload is not shared). Same ' +
				'sender rule: the caller’s bearer token, never a body field. Same non-store: the ' +
				'notification is the whole delivery, queued by the hub for whoever is offline.\n\n' +
				'The body is JSON rather than the single send’s form encoding, so `Type` is a ' +
				'number (still an unmapped Message-model type, defaulting to 0) and `Data` a ' +
				'string, commonly empty. Repeated ids are delivered once.\n\n' +
				'Answers the same `{ success, error }` envelope. Delivery is attempted for every ' +
				'recipient even after one fails, but a hub failure for ANY of them is reported ' +
				'honestly as a 500 — the envelope has no room to say which, and with no store ' +
				'behind it a swallowed error would be a silently dropped message.',
			security: AUTHED,
			requestBody: jsonBody(SendMultipleMessagesRequest, 'The message and its recipients'),
			responses: {
				200: json(SuccessErrorEnvelope, '`{ success: true, error: "" }`'),
				400: json(SuccessErrorEnvelope, 'No usable id in `ToPlayerIds`'),
				401: UNAUTHORIZED_RESPONSE,
				500: json(SuccessErrorEnvelope, 'The notifications hub could not be reached'),
			},
		}),
		async (c) => {
			const fromPlayerId = await authedId(c)
			if (fromPlayerId === null) return unauthorized(c)

			const body = (await c.req.json<Record<string, unknown>>().catch(() => ({}))) as Record<
				string,
				unknown
			>
			// Ids may arrive as numbers or as numeric strings; drop anything that isn't an
			// id and de-duplicate, so a repeated id doesn't deliver the message twice.
			const toPlayerIds = [
				...new Set(
					(Array.isArray(body.ToPlayerIds) ? body.ToPlayerIds : [])
						.map((v) => (typeof v === 'number' ? v : Number.parseInt(String(v), 10)))
						.filter((n) => Number.isInteger(n) && n > 0)
				),
			]
			if (toPlayerIds.length === 0) {
				return c.json({ success: false, error: 'ToPlayerIds is required' }, 400)
			}

			const type = typeof body.Type === 'number' ? body.Type : Number(body.Type) || 0
			const data = typeof body.Data === 'string' ? body.Data : ''

			// Every recipient is attempted even if an earlier one fails — the reachable
			// players get their message either way.
			const results = await Promise.all(
				toPlayerIds.map((toPlayerId) =>
					pushMessage(c, {
						FromPlayerId: fromPlayerId,
						ToPlayerId: toPlayerId,
						Type: type,
						Data: data,
					})
				)
			)
			if (results.includes(false)) {
				return c.json({ success: false, error: 'Failed to deliver message' }, 500)
			}

			return c.json({ success: true, error: '' })
		}
	)

	// Send a friend request to another player (the target arrives as `?id=`). The
	// client calls this as a GET; the mutations accept GET or POST (the Go handlers
	// matched any method). Auth-gated. Returns the resulting relationship from the
	// caller's point of view.
	//
	// The four friend-graph mutations below change state both players can see, so each
	// notifies BOTH sides with their own projection (see notifyBoth) on top of the HTTP
	// response. A no-op — re-sending an outstanding request, accepting nothing pending —
	// notifies nobody.
	.on(
		['GET', 'POST'],
		'/api/relationships/v2/sendfriendrequest',
		friendMutation(
			'Send a friend request',
			'Offer friendship to another player. Re-sending an outstanding request is a no-op ' +
				'and notifies nobody.'
		),
		async (c) => {
			const id = await authedId(c)
			if (id === null) return unauthorized(c)
			const target = await targetPlayerId(c)
			if (target === null || target === id) return c.json({ error: 'invalid player id' }, 400)
			const change = await sendFriendRequest(c.env.DB, id, target)
			await notifyBoth(c, id, target, change)
			return c.json(change.self)
		}
	)

	// Accept a pending friend request from another player (`?id=`). Auth-gated.
	.on(
		['GET', 'POST'],
		'/api/relationships/v2/acceptfriendrequest',
		friendMutation(
			'Accept a friend request',
			'Turn a pending incoming request into a friendship. Accepting nothing pending is a ' +
				'no-op and notifies nobody.'
		),
		async (c) => {
			const id = await authedId(c)
			if (id === null) return unauthorized(c)
			const target = await targetPlayerId(c)
			if (target === null || target === id) return c.json({ error: 'invalid player id' }, 400)
			const change = await acceptFriendRequest(c.env.DB, id, target)
			await notifyBoth(c, id, target, change)
			return c.json(change.self)
		}
	)

	// Remove a friend / cancel a request / decline a request (`?id=`). The row is kept as
	// a None relationship so the per-side flags survive (see removeFriend). Auth-gated.
	.on(
		['GET', 'POST'],
		'/api/relationships/v2/removefriend',
		friendMutation(
			'Unfriend, or cancel/decline a request',
			'All three are the same operation. The row is kept as a `None` relationship so the ' +
				'per-side favorited/ignored/muted flags survive.'
		),
		async (c) => {
			const id = await authedId(c)
			if (id === null) return unauthorized(c)
			const target = await targetPlayerId(c)
			if (target === null || target === id) return c.json({ error: 'invalid player id' }, 400)
			const change = await removeFriend(c.env.DB, id, target)
			await notifyBoth(c, id, target, change)
			return c.json(change.self)
		}
	)

	// Directly add another player as a friend, no pending-request step (`?id=`). Auth-gated.
	.on(
		['GET', 'POST'],
		'/api/relationships/v2/addfriend',
		friendMutation(
			'Befriend directly',
			'Become friends with no pending-request step. Already being friends is a no-op.'
		),
		async (c) => {
			const id = await authedId(c)
			if (id === null) return unauthorized(c)
			const target = await targetPlayerId(c)
			if (target === null || target === id) return c.json({ error: 'invalid player id' }, 400)
			const change = await addFriend(c.env.DB, id, target)
			await notifyBoth(c, id, target, change)
			return c.json(change.self)
		}
	)

	// Ignore / mute another player, and their inverses unignore / unmute (target
	// arrives as `PlayerId` in the POST body). These set a per-player flag on the
	// *caller's* side of the relationship row, creating a bare (None) row when the
	// pair aren't otherwise related — so you can ignore/mute someone you've never
	// friended. The un- variants just clear the same flag. Auth-gated. The resulting
	// relationship is delivered via a RelationshipChanged hub notification (see
	// applyFlag); the HTTP body is just the { Success, Message } ack.
	.on(
		['GET', 'POST'],
		'/api/relationships/v1/ignore',
		flagToggle(
			'Ignore a player',
			'Sets the caller’s `ignored` flag. Ignoring someone you have no relationship with ' +
				'creates a bare (`None`) row to hold the flag.'
		),
		async (c) => {
			const id = await authedId(c)
			if (id === null) return unauthorized(c)
			const target = await targetPlayerId(c)
			if (target === null || target === id) return c.json({ error: 'invalid player id' }, 400)
			return applyFlag(c, id, target, 'ignored', true)
		}
	)
	.on(
		['GET', 'POST'],
		'/api/relationships/v1/unignore',
		flagToggle('Stop ignoring a player', 'Clears the caller’s `ignored` flag.'),
		async (c) => {
			const id = await authedId(c)
			if (id === null) return unauthorized(c)
			const target = await targetPlayerId(c)
			if (target === null || target === id) return c.json({ error: 'invalid player id' }, 400)
			return applyFlag(c, id, target, 'ignored', false)
		}
	)
	.on(
		['GET', 'POST'],
		'/api/relationships/v1/mute',
		flagToggle(
			'Mute a player',
			'Sets the caller’s `muted` flag. Like ignore, this works on a player you have no ' +
				'relationship with.'
		),
		async (c) => {
			const id = await authedId(c)
			if (id === null) return unauthorized(c)
			const target = await targetPlayerId(c)
			if (target === null || target === id) return c.json({ error: 'invalid player id' }, 400)
			return applyFlag(c, id, target, 'muted', true)
		}
	)
	.on(
		['GET', 'POST'],
		'/api/relationships/v1/unmute',
		flagToggle('Unmute a player', 'Clears the caller’s `muted` flag.'),
		async (c) => {
			const id = await authedId(c)
			if (id === null) return unauthorized(c)
			const target = await targetPlayerId(c)
			if (target === null || target === id) return c.json({ error: 'invalid player id' }, 400)
			return applyFlag(c, id, target, 'muted', false)
		}
	)

	// Favorite / unfavorite another player (the client calls these as a GET with the
	// target in `?id=`). Same per-side flag mechanics as ignore/mute above: the write
	// lands on the *caller's* side of the row, and favoriting someone you have no
	// relationship with creates a bare (None) row. Auth-gated. Result rides a
	// RelationshipChanged notification; the body is the { Success, Message } ack.
	.on(
		['GET', 'POST'],
		'/api/relationships/v1/favorite',
		flagToggle(
			'Favorite a player',
			'Sets the caller’s `favorited` flag — what pins a player to the top of their friends ' +
				'list. Works on a player you have no relationship with.'
		),
		async (c) => {
			const id = await authedId(c)
			if (id === null) return unauthorized(c)
			const target = await targetPlayerId(c)
			if (target === null || target === id) return c.json({ error: 'invalid player id' }, 400)
			return applyFlag(c, id, target, 'favorited', true)
		}
	)
	.on(
		['GET', 'POST'],
		'/api/relationships/v1/unfavorite',
		flagToggle('Unfavorite a player', 'Clears the caller’s `favorited` flag.'),
		async (c) => {
			const id = await authedId(c)
			if (id === null) return unauthorized(c)
			const target = await targetPlayerId(c)
			if (target === null || target === id) return c.json({ error: 'invalid player id' }, 400)
			return applyFlag(c, id, target, 'favorited', false)
		}
	)

	.get(
		'/api/messages/v2/get',
		describeRoute({
			tags: ['Social'],
			summary: 'Direct messages',
			description: 'There is no message store yet, so this is always an empty list.',
			responses: { 200: json(JsonArray, 'An empty list') },
		}),
		(c) => c.json([])
	)
	// How many of the caller's friends are online — the friends panel's header count.
	// Answered from the friend graph joined to live presence, so it agrees with the
	// friends the panel then lists. Auth-gated: the count is the CALLER's own.
	.post(
		'/api/messages/v1/friendOnlineStatus',
		describeRoute({
			tags: ['Social'],
			summary: 'How many friends are online',
			description:
				'The caller’s `Friend` relationships joined to live `presence`. Only unexpired ' +
				'presence counts, and friends in the lobby (no room instance) count too — they ' +
				'are signed in, just not in a room.\n\n' +
				'A friend’s `statusVisibility` is not consulted: nothing else in the stack filters ' +
				'presence on it, so hiding people here would disagree with the list the client ' +
				'renders underneath the count.\n\n' +
				'A POST that takes no body — the player is the bearer token.',
			security: AUTHED,
			responses: {
				200: json(FriendOnlineCountResponse, 'The caller’s online-friend count'),
				401: UNAUTHORIZED_RESPONSE,
			},
		}),
		async (c) => {
			const id = await authedId(c)
			if (id === null) return unauthorized(c)
			return c.json({
				success: true,
				value: { FriendsOnlineCount: await countOnlineFriends(c.env.DB, id) },
			})
		}
	)
	.get(
		'/api/messages/v1/favoriteFriendOnlineStatus',
		describeRoute({
			tags: ['Social'],
			summary: 'Online status of favorited friends',
			description:
				'Presence for the caller’s favorited friends. Presence lives in the `match` ' +
				'worker and is not joined in here yet, so this is an empty list.',
			responses: { 200: json(JsonArray, 'An empty list') },
		}),
		(c) => c.json([])
	)
