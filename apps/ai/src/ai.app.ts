import { Hono } from 'hono'
import { describeRoute, openAPIRouteHandler } from 'hono-openapi'
import { useWorkersLogger } from 'workers-tagged-logger'

import { withCleanSpec, withNotFound, withOnError } from '@repo/hono-helpers'
import { validateAndGetAccountId } from '@repo/jwt'

import {
	AUTHED,
	GameAiAccessDenied,
	HealthResponse,
	intQuery,
	json,
	RoomieAiAccess,
	UNAUTHORIZED_RESPONSE,
} from './openapi'

import type { Context } from 'hono'
import type { App } from './context'

/**
 * AI Worker. Serves the access checks the client makes before offering its AI features.
 * Nothing here runs a model, and the two features are answered differently for that
 * reason: Game AI is a server-side feature this server cannot provide, so it is refused;
 * Roomie is the client's own assistant and only asks this service what its energy budget
 * is, so it is granted an unlimited one.
 */

/**
 * `int.MaxValue` — the client's energy fields are signed 32-bit ints, so this is the
 * largest budget it can hold. Anything larger (an int64 max, say) overflows on the way in
 * and lands as a negative number, i.e. no energy at all.
 */
const INT32_MAX = 2_147_483_647

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

			return c.json({
				success: false,
				error_id: 'AI.RoomDoesNotSupportGameAI',
				error: 'This room does not support Rec Room Game AI',
			})
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
						'The Game AI service for recflare, a private-server reimplementation of the Rec Room',
						'backend. The client checks here before offering its AI features in a room.',
						'',
						'No model runs behind this worker, so the access check refuses every room — as a 200',
						'carrying `success: false`, which is the shape the client branches on. That is the',
						'whole surface today; the worker exists so the client gets a definite answer on the',
						'host its endpoints document names, instead of a failed request.',
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
