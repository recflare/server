import { Hono } from 'hono'
import { describeRoute } from 'hono-openapi'

import { getProgression, getProgressions } from '@repo/domain'
import { logger } from '@repo/hono-helpers'

// The notification-type ids the hub carries (owned by the `notify` worker). Imported as a
// value — the enum has no runtime dependencies.
import { NotificationType } from '../../../notify/src/notification-types'
import { parseFormIds, queryIds } from '../http'
import {
	BulkIdsRequest,
	form,
	idParam,
	intQuery,
	json,
	JsonArray,
	ProgressionDto,
	ReputationDto,
} from '../openapi'

import type { Context } from 'hono'
import type { Progression } from '@repo/domain'
import type { App } from '../context'

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
 * Default reputation for an account — the fallback used with no DB. Nobody has
 * earned cheers yet, so every counter is 0 and everyone has their full cheer credit.
 * `SelectedCheer` is an int (0 = none selected), not null, and `IsCheerful` is true:
 * the client reads it to decide whether the player may hand out cheers at all.
 */
function defaultReputation(id: number) {
	return {
		AccountId: id,
		IsCheerful: true,
		Noteriety: 0,
		SelectedCheer: 0,
		CheerCredit: 20,
		CheerGeneral: 0,
		CheerHelpful: 0,
		CheerCreative: 0,
		CheerGreatHost: 0,
		CheerSportsman: 0,
		SubscriberCount: 0,
		SubscribedCount: 0,
	}
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
				'The cheer counters shown on a player’s profile. No cheers are stored yet, so ' +
				'every player gets the same all-zero record with full cheer credit.',
			parameters: [idParam('id', 'Account id')],
			responses: { 200: json(ReputationDto, 'The player’s reputation') },
		}),
		(c) => c.json(defaultReputation(Number.parseInt(c.req.param('id'), 10)))
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
	// Synthesize a default reputation per requested id (the intended behavior;
	// the DB-less fallback reads a static JSON file instead).
	.post(
		'/api/playerReputation/v2/bulk',
		describeRoute({
			tags: ['Progression'],
			summary: 'Reputations in bulk',
			description:
				'One default reputation per requested id, in request order. Ids that name no ' +
				'account still get a record — the client renders a profile card from it.',
			requestBody: BULK_ID_BODY,
			responses: { 200: json(ReputationDto.array(), 'One reputation per requested id') },
		}),
		async (c) => {
			const ids = await parseFormIds(c)
			return c.json(ids.map(defaultReputation))
		}
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
		(c) => c.json(queryIds(c).map(defaultReputation))
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
