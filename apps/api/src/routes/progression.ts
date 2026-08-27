import { Hono } from 'hono'
import { describeRoute } from 'hono-openapi'

import {
	getPlayerIdsInInstance,
	getPresence,
	getProgression,
	getProgressions,
	MessageType,
} from '@repo/domain'
import { logger } from '@repo/hono-helpers'

// The notification-type ids the hub carries (owned by the `notify` worker). Imported as a
// value — the enum has no runtime dependencies.
import { NotificationType } from '../../../notify/src/notification-types'
import { authedId, parseFormIds, queryIds, unauthorized } from '../http'
import {
	AUTHED,
	BulkIdsRequest,
	CheerPlayerRequest,
	CheerPlayerResponse,
	SetSelectedCheerRequest,
	form,
	idParam,
	intQuery,
	json,
	JsonArray,
	ProgressionDto,
	ReputationDto,
	UNAUTHORIZED_RESPONSE,
} from '../openapi'
import {
	addCheer,
	CheerCategory,
	DAILY_CHEER_CREDIT,
	getReputation,
	getReputations,
	isCheerCategory,
	setSelectedCheer,
	spendCheerCredit,
} from '../reputation-db'

import type { Context } from 'hono'
import type { Progression } from '@repo/domain'
import type { ReputationPayload } from '../../../notify/src/notification-payloads'
import type { App } from '../context'
import type { Reputation } from '../reputation-db'

/** The notifications hub is a single global DO instance (see the `notify` worker). */
const HUB_INSTANCE = 'global'

/**
 * Push the caller's own progression back at them over the socket, mirroring the reference's
 * `HubSendProgressionUpdate` on this same read. Pushing from a GET looks odd, but it is how
 * a client that just connected gets its level bar right: the frame is what the client acts
 * on, the response body is only what it asked for. Best-effort — a hub failure leaves the
 * body correct.
 */
async function pushProgression(c: Context<App>, progression: Progression): Promise<void> {
	try {
		await c.env.RECFLARE_NOTIFICATIONS_HUB.getByName(HUB_INSTANCE).notifyPlayer(
			progression.PlayerId,
			NotificationType.PlayerProgressionLevelUpdate,
			{ PlayerId: progression.PlayerId, Level: progression.Level, XP: progression.XP }
		)
	} catch (err) {
		logger.error('failed to push PlayerProgressionLevelUpdate notification', {
			accountId: progression.PlayerId,
			error: err instanceof Error ? err.message : String(err),
		})
	}
}

/**
 * Push the `MessageReceived` frame that actually plays a cheer on the cheered player's
 * client — a Message of type `PlayerCheer` (or its anonymous twin). That message, NOT
 * `ReputationUpdate`, is what the client renders the cheer from; every reference server
 * (meownet-api, DorkNet, the E12354 C# server) sends it, and a cheer that only pushes
 * `ReputationUpdate` moves the counters and plays nothing.
 *
 * `Data` is the category given, as a string (a Message's `Data` is always a string). An
 * anonymous cheer uses the anonymous type and names sender 0, so the recipient's client
 * neither shows nor can look up who gave it — `Anonymous` decides nothing else.
 *
 * Durable, like the rest of the target's frames: the cheer is theirs whether or not they are
 * connected right now. Best-effort — the cheer is already counted.
 */
async function pushCheerMessage(
	c: Context<App>,
	fromId: number,
	toId: number,
	category: number,
	anonymous: boolean
): Promise<void> {
	try {
		await c.env.RECFLARE_NOTIFICATIONS_HUB.getByName(HUB_INSTANCE).notifyPlayer(
			toId,
			NotificationType.MessageReceived,
			{
				FromPlayerId: anonymous ? 0 : fromId,
				ToPlayerId: toId,
				Type: anonymous ? MessageType.PlayerCheerAnonymous : MessageType.PlayerCheer,
				Data: String(category),
			}
		)
	} catch (err) {
		logger.error('failed to push PlayerCheer MessageReceived notification', {
			fromId,
			toId,
			error: err instanceof Error ? err.message : String(err),
		})
	}
}

/**
 * Trim a stored reputation to the fields a `ReputationUpdate` frame carries — the client's
 * decoder has no `Noteriety` or subscriber counts on this payload. Nothing else changes:
 * `IsCheerful` and `SelectedCheer` are the record's, exactly as the profile DTO serves them.
 * (This once overrode both per send to "play" the cheer — no reference does that, and the
 * client plays a cheer off the `PlayerCheer` MESSAGE, not this frame.) Built against the
 * recovered interface so a renamed key fails the build rather than vanishing on the wire.
 *
 * `AccountId` is who the frame is ABOUT, which is not who it is sent to: a cheer's frame
 * names the player being cheered and goes to everyone watching.
 */
function reputationFrame(reputation: Reputation): ReputationPayload {
	const { Noteriety: _n, SubscriberCount: _sr, SubscribedCount: _sd, ...payload } = reputation
	return payload
}

/**
 * Push a `ReputationUpdate` frame to one player, durably — it survives them being offline
 * and lands on their next connect. For the frames that report a real change to the player
 * they name: their counters moved, or their credit did.
 *
 * Best-effort: the cheer is already stored by the time this runs, so a hub hiccup must not
 * fail the request — the numbers are right on the next read either way.
 */
async function pushReputation(
	c: Context<App>,
	playerId: number,
	frame: ReputationPayload
): Promise<void> {
	try {
		await c.env.RECFLARE_NOTIFICATIONS_HUB.getByName(HUB_INSTANCE).notifyPlayer(
			playerId,
			NotificationType.ReputationUpdate,
			{ ...frame }
		)
	} catch (err) {
		logger.error('failed to push ReputationUpdate notification', {
			playerId,
			accountId: frame.AccountId,
			error: err instanceof Error ? err.message : String(err),
		})
	}
}

/**
 * Push the same frame to a roomful of players, EPHEMERALLY — delivered to whoever is
 * connected and dropped for anyone who isn't.
 *
 * That is the right send for an audience frame. A cheer's effect belongs to the moment it
 * happened; queueing it would play someone else's cheer at a bystander when they next log
 * in, hours later and somewhere else. The people the cheer actually changed something for
 * get their own durable frame instead.
 */
async function pushReputationToRoom(
	c: Context<App>,
	playerIds: number[],
	frame: ReputationPayload
): Promise<void> {
	if (playerIds.length === 0) return
	try {
		await c.env.RECFLARE_NOTIFICATIONS_HUB.getByName(HUB_INSTANCE).notifyPlayersEphemeral(
			playerIds,
			NotificationType.ReputationUpdate,
			{ ...frame }
		)
	} catch (err) {
		logger.error('failed to push ReputationUpdate notification to room', {
			playerIds,
			accountId: frame.AccountId,
			error: err instanceof Error ? err.message : String(err),
		})
	}
}

/**
 * Read one field of the cheer form. The client posts it form-encoded, but the same names
 * also arrive as a query string on some builds, so both are accepted (same helper the
 * moderation routes use on their forms).
 */
function formField(
	body: Record<string, unknown>,
	c: Context<App>,
	name: string
): string | undefined {
	const raw = body[name]
	if (typeof raw === 'string' && raw !== '') return raw
	return c.req.query(name) || undefined
}

/** Parse a form field as an integer, or null when absent / not a number. */
function asInt(value: string | undefined): number | null {
	if (value === undefined) return null
	const n = Number.parseInt(value, 10)
	return Number.isNaN(n) ? null : n
}

/**
 * Parse a form field as a bool. The client sends .NET's `True`/`False`, so the match is
 * case-insensitive; anything else — an absent field included — reads as false, which is the
 * safe default for `Anonymous` (a cheer nobody asked to hide is a signed one).
 */
function asBool(value: string | undefined): boolean {
	return value !== undefined && /^(true|1)$/i.test(value.trim())
}

/**
 * The `{ Success, Message }` body a cheer answers with — PascalCase, as the reference, and
 * `Message` is NULL on success rather than an empty string. That is not the same envelope
 * as the lowercase `{ success, error: "" }` the reports and warnings use; don't unify them.
 */
function cheerResult(c: Context<App>, message: string | null = null) {
	return c.json({ Success: message === null, Message: message })
}

/**
 * The repeated `id` query param the 2023 client uses on the bulk GET forms — each value
 * may itself be a comma-separated list, so `?id=1,2&id=3` is three ids.
 */
const BULK_ID_QUERY = [
	intQuery('id', 'Repeated once per account id (`?id=1&id=2`); not comma-separated'),
]

/** The `Ids` form body the bulk POST forms take. */
const BULK_ID_BODY = form(BulkIdsRequest, 'The account ids to look up')

// ---- Reputation / progression ----------------------------------------------
export const progressionRoutes = new Hono<App>({ strict: false })
	.get(
		'/api/playerReputation/v1/:id',
		describeRoute({
			tags: ['Progression'],
			summary: 'A player’s reputation',
			description:
				'The cheer counters shown on a player’s profile, from the `reputation` table. A ' +
				'player nobody has cheered has no row and reads back all-zero. `CheerCredit` is ' +
				'the odd one out — what they have left to GIVE today, out of ' +
				`${DAILY_CHEER_CREDIT}; it refills lazily, so a stale window reads as full ` +
				'without being reset here.',
			parameters: [idParam('id', 'Account id')],
			responses: { 200: json(ReputationDto, 'The player’s reputation') },
		}),
		async (c) => c.json(await getReputation(c.env.DB, Number.parseInt(c.req.param('id'), 10)))
	)
	.get(
		'/api/players/v1/progression/:id',
		describeRoute({
			tags: ['Progression'],
			summary: 'A player’s level and XP',
			description:
				'The level and XP banked in `progression` (game rewards pay into it from the `econ` ' +
				'worker); `XP` is the progress into the current level, not a lifetime total. A ' +
				'player who has earned none has no row and reads back as level 1 with 0 XP. Also ' +
				'pushes the same values as a `PlayerProgressionLevelUpdate` frame, as the reference ' +
				'does — that is what moves the client’s bar.',
			parameters: [idParam('id', 'Account id')],
			responses: { 200: json(ProgressionDto, 'The player’s progression') },
		}),
		async (c) => {
			const id = Number.parseInt(c.req.param('id'), 10)
			const progression = await getProgression(c.env.DB, id)
			await pushProgression(c, progression)
			return c.json(progression)
		}
	)
	.post(
		'/api/playerReputation/v1/bulk',
		describeRoute({
			tags: ['Progression'],
			summary: 'Reputations in bulk (v1)',
			description:
				'The older bulk form, superseded by v2. It answers an empty list rather than ' +
				'synthesizing defaults — the client only uses v2.',
			requestBody: BULK_ID_BODY,
			responses: { 200: json(JsonArray, 'An empty list') },
		}),
		(c) => c.json([])
	)
	.post(
		'/api/playerReputation/v2/bulk',
		describeRoute({
			tags: ['Progression'],
			summary: 'Reputations in bulk',
			description:
				'One reputation per requested id, in request order. Ids that name no account — or ' +
				'that nobody has cheered — still get an all-zero record rather than being dropped: ' +
				'the client renders a profile card from each entry.',
			requestBody: BULK_ID_BODY,
			responses: { 200: json(ReputationDto.array(), 'One reputation per requested id') },
		}),
		async (c) => c.json(await getReputations(c.env.DB, await parseFormIds(c)))
	)
	// The 2023 client calls this as a GET with repeated `id` query params.
	.get(
		'/api/playerReputation/v2/bulk',
		describeRoute({
			tags: ['Progression'],
			summary: 'Reputations in bulk (GET form)',
			description:
				'What the 2023 client sends: the same bulk lookup with the ids as repeated query ' +
				'params instead of a form body.',
			parameters: BULK_ID_QUERY,
			responses: { 200: json(ReputationDto.array(), 'One reputation per requested id') },
		}),
		async (c) => c.json(await getReputations(c.env.DB, queryIds(c)))
	)
	// Cheering another player: spend one of the caller's daily credits, count it against the
	// target's category counter, and play it in front of the room.
	//
	// Nothing stores an individual cheer — this keeps a per-player counter, not a log of who
	// cheered whom. So neither `RoomId` nor `Anonymous` reaches storage: both are spent
	// immediately on the notification, one deciding who sees it and the other whether it is
	// seen at all.
	.post(
		'/api/PlayerCheer/v1/create',
		describeRoute({
			tags: ['Progression'],
			summary: 'Cheer another player',
			description:
				'Hands one cheer to `PlayerIdTo` in the category `CheerCategory` names (0 General, ' +
				'10 Helpful, 20 Sportmanship, 30 GreatHost, 40 Creative), counting it on their ' +
				'`reputation` row.\n\n' +
				`A player may give ${DAILY_CHEER_CREDIT} cheers per day. The credit refills lazily: ` +
				'the first cheer opens a 24-hour window, and the first cheer after that window has ' +
				'passed starts a fresh one at full credit — so a player who spends all day refills ' +
				'24h after their FIRST cheer, not their last.\n\n' +
				'The cheered player gets a durable `MessageReceived` frame carrying a Message of ' +
				'type 50 (`PlayerCheer`) — 51 (`PlayerCheerAnonymous`, sender 0) when `Anonymous` — ' +
				'with `Data` = the category. That message is what plays the cheer on their ' +
				'client; the `ReputationUpdate` frames below only refresh the numbers.\n\n' +
				'A cheer is played in front of people, so the `ReputationUpdate` frame naming the ' +
				'cheered player goes to EVERYONE in the room instance the caller is standing in, ' +
				'not just the two of them. The cheered player gets it durably (their counters ' +
				'really moved); the rest of the room gets it only if they are connected, since ' +
				'the effect belongs to the moment. The caller gets a second frame of their own ' +
				'because their `CheerCredit` moved and the response body does not carry it.\n\n' +
				'`Anonymous` swaps the message for its anonymous twin (type 51, sender 0) and ' +
				'nothing else — the counters move the same either way.\n\n' +
				'The audience comes from the caller’s live presence, not from `RoomId`, which is ' +
				'accepted and unused: a client cannot aim its effect at a room it is not in. ' +
				'Neither field is stored — this keeps counters, not a log of individual cheers.\n\n' +
				'Refusals (no credit left, an unknown category, cheering yourself) answer 200 with ' +
				'`{ Success: false, Message }` rather than an error status — the client shows the ' +
				'message.',
			security: AUTHED,
			requestBody: form(CheerPlayerRequest, 'The cheer'),
			responses: {
				200: json(
					CheerPlayerResponse,
					'`{ Success: true, Message: null }` — see above for refusals'
				),
				401: UNAUTHORIZED_RESPONSE,
			},
		}),
		async (c) => {
			const fromId = await authedId(c)
			if (fromId === null) return unauthorized(c)

			const body = await c.req.parseBody().catch(() => ({}) as Record<string, unknown>)
			const toId = asInt(formField(body, c, 'PlayerIdTo'))
			if (toId === null) return cheerResult(c, 'PlayerIdTo is required')
			if (toId === fromId) return cheerResult(c, 'You cannot cheer yourself')

			// Validated BEFORE the credit is spent: a category we can't count would otherwise
			// take a cheer off the caller and give nothing to anyone.
			const category = asInt(formField(body, c, 'CheerCategory'))
			if (category === null || !isCheerCategory(category)) {
				return cheerResult(c, 'CheerCategory is not a cheer category')
			}

			const remaining = await spendCheerCredit(c.env.DB, fromId)
			if (remaining === null) return cheerResult(c, 'You are out of cheers for today')

			const cheered = await addCheer(c.env.DB, toId, category)

			// The frame that PLAYS the cheer on the cheered player's client — a Message of
			// type PlayerCheer (or its anonymous twin). `ReputationUpdate` alone moves the
			// numbers and shows nothing.
			await pushCheerMessage(c, fromId, toId, category, asBool(formField(body, c, 'Anonymous')))

			// The frame the room sees: the cheered player's record, so everyone's copy of
			// their counters moves. It is ABOUT them — `AccountId` is theirs — but goes to
			// everyone standing there.
			const frame = reputationFrame(cheered)

			// The audience is read from the GIVER's live presence, not from the body's
			// `RoomId` — a client that lied about the room would otherwise play its effect in
			// someone else's. A cheer given outside a room instance (from a profile screen)
			// simply has no audience.
			const presence = await getPresence<{ roomInstanceId?: number }>(c.env.DB, fromId)
			const instanceId = presence?.roomInstance?.roomInstanceId
			const audience =
				instanceId === undefined
					? []
					: (await getPlayerIdsInInstance(c.env.DB, instanceId)).filter((id) => id !== toId)

			// The cheered player is deliberately not in that list: for them this is a real
			// change to their own record, so they get it durably and get it whether or not
			// they were in the room — the room gets a copy that expires with the moment.
			await pushReputation(c, toId, frame)
			await pushReputationToRoom(c, audience, frame)

			// The caller's own record, with the credit the spend just resolved rather than a
			// re-read — a cheer they fired off in parallel must not make this frame report a
			// credit they no longer have.
			await pushReputation(
				c,
				fromId,
				reputationFrame({ ...(await getReputation(c.env.DB, fromId)), CheerCredit: remaining })
			)

			return cheerResult(c)
		}
	)
	// Pinning a cheer to the caller's own profile: the badge the client shows next to
	// their name, read back as `SelectedCheer` on the reputation DTO.
	.post(
		'/api/PlayerCheer/v1/SetSelectedCheer',
		describeRoute({
			tags: ['Progression'],
			summary: 'Pin a cheer to your profile',
			description:
				'Stores `CheerCategory` as the caller’s `SelectedCheer` (-1 `None` unpins, read ' +
				'back as 0) and pushes them a `ReputationUpdate` so a second device catches up. ' +
				'Same `{ Success, Message }` reply as the cheer.',
			security: AUTHED,
			requestBody: form(SetSelectedCheerRequest, 'The category to pin'),
			responses: {
				200: json(CheerPlayerResponse, '`{ Success: true, Message: null }`'),
				401: UNAUTHORIZED_RESPONSE,
			},
		}),
		async (c) => {
			const id = await authedId(c)
			if (id === null) return unauthorized(c)

			const body = await c.req.parseBody().catch(() => ({}) as Record<string, unknown>)
			const category = asInt(formField(body, c, 'CheerCategory'))
			if (category === null || !(category === CheerCategory.None || isCheerCategory(category))) {
				return cheerResult(c, 'CheerCategory is not a cheer category')
			}

			const reputation = await setSelectedCheer(c.env.DB, id, category)
			await pushReputation(c, id, reputationFrame(reputation))
			return cheerResult(c)
		}
	)
	.post(
		'/api/players/v1/progression/bulk',
		describeRoute({
			tags: ['Progression'],
			summary: 'Progressions in bulk (v1)',
			description: 'No progression is stored yet, so this is an empty list.',
			requestBody: BULK_ID_BODY,
			responses: { 200: json(JsonArray, 'An empty list') },
		}),
		async (c) => {
			await parseFormIds(c) // TODO: query PlayerProgressions for these ids
			return c.json([])
		}
	)
	// v2 is identical to v1 — same form-id parse + PlayerProgressions query.
	.post(
		'/api/players/v2/progression/bulk',
		describeRoute({
			tags: ['Progression'],
			summary: 'Progressions in bulk (v2)',
			description: 'Identical to v1 — same ids in, same empty list out.',
			requestBody: BULK_ID_BODY,
			responses: { 200: json(JsonArray, 'An empty list') },
		}),
		async (c) => {
			await parseFormIds(c) // TODO: query PlayerProgressions for these ids
			return c.json([])
		}
	)
	// The 2023 client calls this as a GET with repeated `id` query params.
	// Return a default progression per requested id.
	.get(
		'/api/players/v2/progression/bulk',
		describeRoute({
			tags: ['Progression'],
			summary: 'Progressions in bulk (GET form)',
			description:
				'What the 2023 client sends. Unlike the POST forms this one does answer — one ' +
				'progression per requested id, in request order, defaulting to level 1 / 0 XP for ' +
				'ids that have earned nothing.',
			parameters: BULK_ID_QUERY,
			responses: { 200: json(ProgressionDto.array(), 'One progression per requested id') },
		}),
		async (c) => c.json(await getProgressions(c.env.DB, queryIds(c)))
	)
	.post(
		'/api/v1/progression/bulk',
		describeRoute({
			tags: ['Progression'],
			summary: 'Progressions in bulk (unversioned path)',
			description:
				'An older unversioned path some client builds still call. Same empty answer as ' +
				'the versioned POST forms.',
			requestBody: BULK_ID_BODY,
			responses: { 200: json(JsonArray, 'An empty list') },
		}),
		async (c) => {
			await parseFormIds(c) // TODO: query PlayerProgressions for these ids
			return c.json([])
		}
	)

	// The progression events running right now — the limited-time XP events the client shows
	// a banner and a progress track for.
	//
	// STUB: an empty list, which the client reads as "no event on" and skips the event UI
	// entirely. That is the honest answer (nothing here runs events) and the safe one: a
	// fabricated event would draw a track that never fills. No auth — whether an event is
	// running is the same fact for everybody, and the client asks while loading.
	.get(
		'/api/progressionEvents/active',
		describeRoute({
			tags: ['Progression'],
			summary: 'Progression events currently running (stub)',
			description:
				'The limited-time XP events in progress. Always an empty list — nothing on this ' +
				'server runs one — which the client reads as “no event” and skips the event UI, ' +
				'where a 404 would stall the load. No auth: it is the same answer for every player.',
			responses: { 200: json(JsonArray, 'Empty — no event is running') },
		}),
		(c) => c.json([])
	)
