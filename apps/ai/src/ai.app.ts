import { Hono } from 'hono'
import { describeRoute, openAPIRouteHandler } from 'hono-openapi'
import { useWorkersLogger } from 'workers-tagged-logger'

import { withCleanSpec, withNotFound, withOnError } from '@repo/hono-helpers'
import { validateAndGetAccountId } from '@repo/jwt'

import {
	AUTHED,
	GameAiAccessDenied,
	GameAiSpendSummaryDenied,
	HealthResponse,
	idParam,
	intQuery,
	json,
	jsonBody,
	MakerAiBalances,
	RealtimeSessionCreateBody,
	RealtimeSessionDenied,
	RoomieAiAccess,
	RoomieUserFacts,
	UNAUTHORIZED_RESPONSE,
} from './openapi'

import type { Context } from 'hono'
import type { App } from './context'

/**
 * AI Worker. Serves the access checks and budget reads the client makes before offering
 * its AI features. Nothing here runs a model, so every answer is static — but not
 * uniformly a refusal, because the features fail differently:
 *
 * - Game AI is a SERVER-side feature. This server cannot provide it, so both its reads are
 *   refused and the client hides the feature.
 * - Roomie runs on the CLIENT and only asks this service what it may spend, so the budget
 *   reads are granted in full. The session that would actually reach a model
 *   (`/realtime-session/create`) is where it stops.
 * - Maker AI meters model usage in dollars. Nothing here bills, so every figure is zero.
 */

/**
 * `int.MaxValue` — the client's energy fields are signed 32-bit ints, so this is the
 * largest budget it can hold. Anything larger (an int64 max, say) overflows on the way in
 * and lands as a negative number, i.e. no energy at all.
 */
const INT32_MAX = 2_147_483_647

/**
 * The reason both Game AI reads refuse with. `AI.RoomDoesNotSupportGameAI` is the id the
 * client renders a message for; the room it names makes no difference, there being no Game
 * AI backend behind any of them.
 */
const GAME_AI_UNSUPPORTED = {
	success: false,
	error_id: 'AI.RoomDoesNotSupportGameAI',
	error: 'This room does not support Rec Room Game AI',
} as const

/**
 * Resolve the account id from a Bearer token (the route is auth-gated).
 * Returns `null` when the header is missing, the token is invalid, or the `sub` claim
 * isn't an integer.
 */
async function authedId(c: Context<App>): Promise<number | null> {
	return validateAndGetAccountId(c.req.raw, await c.env.JWT_SECRET.get())
}

/** Results.Unauthorized() equivalent — 401 with empty body. */
function unauthorized(c: Context<App>) {
	return c.body(null, 401)
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

	// Root health check.
	.get(
		'/',
		describeRoute({
			tags: ['Service'],
			summary: 'Health check',
			description: 'Liveness probe for the ai worker. No auth.',
			responses: { 200: json(HealthResponse, 'Service is up') },
		}),
		(c) => c.json({ service: 'ai', status: 'ok' })
	)

	// Whether the caller may use Game AI in a room. Always refused: no Game AI backend
	// exists here, so the honest answer for every room is that it doesn't support it.
	.get(
		'/gameai/user/access',
		describeRoute({
			tags: ['Game AI'],
			summary: 'May the caller use Game AI here?',
			description: [
				'Asked before the client offers any Game AI feature in a room. This server hosts no',
				'Game AI, so it always refuses — with a 200 carrying `success: false`, NOT an HTTP',
				'error: the client branches on the body, and an error status would read as a failed',
				'request rather than the “not available here” state this is. `AI.RoomDoesNotSupportGameAI`',
				'is the reason the client renders.',
				'',
				'`roomId` is accepted and ignored — the answer is the same for every room, and the',
				'refusal is per-room by nature, so the client asks again for the next one. The token',
				'is still validated first, as the reference does.',
			].join(' '),
			security: AUTHED,
			parameters: [intQuery('roomId', 'The room the client is asking about. Ignored.')],
			responses: {
				200: json(GameAiAccessDenied, 'Always a refusal'),
				401: UNAUTHORIZED_RESPONSE,
			},
		}),
		async (c) => {
			const id = await authedId(c)
			if (id === null) return unauthorized(c)

			return c.json(GAME_AI_UNSUPPORTED)
		}
	)

	// What a room has spent on Game AI. Refused for the same reason as the access check
	// above, but note the body differs: this one carries an explicit `value: null`.
	.get(
		'/gameai/room/:roomId{[0-9]+}/spendsummary',
		describeRoute({
			tags: ['Game AI'],
			summary: 'A room’s Game AI spend summary',
			description: [
				'What a room has spent of its Game AI budget. Refused with the same 200-plus-',
				'`success: false` body as the access check, since a room that cannot use Game AI has',
				'no spend to summarise.',
				'',
				'The body is NOT identical to the access check’s: it carries `value: null` where that',
				'one omits the key entirely. The access check answers a yes/no and has nothing to',
				'carry; this endpoint’s payload slot exists and is empty. Reproduced as the reference',
				'server sends it — don’t unify the two.',
			].join(' '),
			security: AUTHED,
			parameters: [idParam('roomId', 'The room being asked about. Ignored.')],
			responses: {
				200: json(GameAiSpendSummaryDenied, 'Always a refusal'),
				401: UNAUTHORIZED_RESPONSE,
			},
		}),
		async (c) => {
			const id = await authedId(c)
			if (id === null) return unauthorized(c)

			return c.json({ ...GAME_AI_UNSUPPORTED, value: null })
		}
	)

	// Roomie AI's energy budget. Granted, unlike Game AI above: Roomie runs on the client
	// and only asks this service how much energy it has, so the honest answer for a server
	// that meters nothing is "as much as you can count".
	.get(
		'/roomieai/user/access',
		describeRoute({
			tags: ['Roomie AI'],
			summary: 'The caller’s Roomie AI energy budget',
			description: [
				'What Roomie may spend: an energy ceiling, what is left of it, and when it next',
				'refills. Nothing here meters energy, so the budget is `int.MaxValue` and never',
				'depletes — which is why `NextSubscriptionEnergyRechargeAt` is null, there being no',
				'spend to recharge from.',
				'',
				'The envelope is `{ success, error_id, error, value }`, NOT the flat body the Game AI',
				'check answers with. The two are different shapes on purpose — don’t unify them.',
			].join(' '),
			security: AUTHED,
			responses: {
				200: json(RoomieAiAccess, 'The energy budget — always granted, always full'),
				401: UNAUTHORIZED_RESPONSE,
			},
		}),
		async (c) => {
			const id = await authedId(c)
			if (id === null) return unauthorized(c)

			return c.json({
				success: true,
				error_id: null,
				error: null,
				value: {
					MaxEnergyFromSubscriptions: INT32_MAX,
					EnergyLeft: INT32_MAX,
					NextSubscriptionEnergyRechargeAt: null,
					OutputAudioEnabled: true,
				},
			})
		}
	)

	// What Roomie has been told about the caller. Nothing observes players here, so it has
	// been told nothing.
	.get(
		'/roomieai/user/facts',
		describeRoute({
			tags: ['Roomie AI'],
			summary: 'What Roomie knows about the caller',
			description: [
				'The memory Roomie is primed with: `UserContext`, a prose profile written from past',
				'conversations, and `UserFacts`, the discrete `(Predicate, Object)` claims behind it —',
				'live, these are things the player told Roomie about themselves.',
				'',
				'Both are empty here. Nothing on this server observes a conversation, so there is',
				'nothing to remember, and Roomie starts every session knowing nothing about who it is',
				'talking to. A flat body, like the Maker AI balances and unlike the access check',
				'above.',
			].join(' '),
			security: AUTHED,
			responses: {
				200: json(RoomieUserFacts, 'An empty profile — always'),
				401: UNAUTHORIZED_RESPONSE,
			},
		}),
		async (c) => {
			const id = await authedId(c)
			if (id === null) return unauthorized(c)

			return c.json({ UserContext: '', UserFacts: [] })
		}
	)

	// Maker AI's dollar balances. Zeroed rather than refused: the client reads these to
	// render a usage meter, and a server that bills nothing has spent nothing.
	.get(
		'/makerai/user/balances',
		describeRoute({
			tags: ['Maker AI'],
			summary: 'The caller’s Maker AI usage balances',
			description: [
				'What Maker AI has cost the caller. Live, these meter model usage in DOLLARS against',
				'a per-user ceiling and a separate RR+ allowance, and the client renders them as a',
				'usage bar with a status word.',
				'',
				'Nothing here bills for model usage, so every figure is zero and both usage buckets',
				'report `Good` — an untouched allowance, not an exhausted one. The time bucket is',
				'`Empty` with `TimeExpiresAt` at `DateTime.MinValue`, this server selling no timed',
				'access for it to hold.',
				'',
				'A flat body — no `{ success, error, value }` envelope, unlike the Roomie access check.',
			].join(' '),
			security: AUTHED,
			responses: {
				200: json(MakerAiBalances, 'All zero — nothing is metered here'),
				401: UNAUTHORIZED_RESPONSE,
			},
		}),
		async (c) => {
			const id = await authedId(c)
			if (id === null) return unauthorized(c)

			return c.json({
				UsageDollars: 0,
				UsersMaxUsageDollars: 0,
				RRPlusUsageDollars: 0,
				UsersMaxRRPlusUsageDollars: 0,
				TimeBalanceStatus: 'Empty',
				TimeExpiresAt: '0001-01-01T00:00:00',
				UsageBalanceStatus: 'Good',
				UsagePercent: 0,
				RRPlusUsageBalanceStatus: 'Good',
				RRPlusUsagePercent: 0,
			})
		}
	)

	// Opening a live voice session with an assistant — the one call here that would reach a
	// real model, and so the one that cannot be answered statically. Refused.
	.post(
		'/realtime-session/create',
		describeRoute({
			tags: ['Roomie AI'],
			summary: 'Open a realtime AI session',
			description: [
				'Posted when the player actually pulls out an assistant. Live, this mints a short-',
				'lived credential the CLIENT then uses to talk to the model provider directly, and',
				'answers with `{ SessionId, ClientSecret }` in `value`.',
				'',
				'Refused here. This is the one endpoint on the worker whose answer is a working key',
				'rather than a description of one, so there is nothing static to serve — which is why',
				'the budget reads above grant everything and the refusal lands at this point instead:',
				'the client offers the feature, and the session it opens is what fails.',
				'',
				'The refusal is still a 200 with `success: false`, and `error_id` is an EMPTY STRING',
				'rather than a code — the reference server sends no id for this one. `value` is null.',
			].join(' '),
			security: AUTHED,
			requestBody: jsonBody(
				RealtimeSessionCreateBody,
				'Which assistant is being opened. Read for the log only — the answer is the same either way.'
			),
			responses: {
				200: json(RealtimeSessionDenied, 'Always a refusal — no session is created'),
				401: UNAUTHORIZED_RESPONSE,
			},
		}),
		async (c) => {
			const id = await authedId(c)
			if (id === null) return unauthorized(c)

			return c.json({
				success: false,
				error: 'Realtime AI sessions are not available on this server',
				error_id: '',
				value: null,
			})
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
					title: 'recflare ai',
					version: '1.0.0',
					description: [
						'The AI service for recflare, a private-server reimplementation of the Rec Room',
						'backend. The client checks here before offering any of its AI features: Game AI in a',
						'room, the Roomie assistant, and Maker AI’s usage meter.',
						'',
						'No model runs behind this worker, so every answer is static — but they are not all',
						'refusals, because the features fail at different points. Game AI is a server-side',
						'feature this server cannot provide, so both its reads refuse. Roomie and Maker AI',
						'only ask what the caller may SPEND, which nothing here meters, so those reads are',
						'granted in full; the refusal lands instead on `POST /realtime-session/create`, the',
						'one call whose real answer is a working credential rather than a description of one.',
						'',
						'The refusals are 200s carrying `success: false`, which is the shape the client',
						'branches on — the worker exists so the client gets a definite answer on the host its',
						'endpoints document names, instead of a failed request.',
					].join('\n'),
				},
				servers: [{ url: 'https://ai.recflare.net', description: 'Production' }],
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
