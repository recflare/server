import { resolver } from 'hono-openapi'
import { z } from 'zod'

import type { OpenAPIV3_1 } from 'openapi-types'

/**
 * OpenAPI schemas for the ai worker.
 *
 * IMPORTANT: these are DESCRIPTIVE ONLY. They are passed to `describeRoute` to generate
 * the spec and are never wired into `hono-openapi`'s `validator()`. Same rationale as the
 * auth/accounts/econ/match/playersettings workers: a reverse-engineered protocol, lenient
 * handlers, no runtime validation.
 *
 * Do NOT add `.meta({ id })` to these schemas — with this hono-openapi + zod v4 setup a
 * meta'd schema used in a response emits a `$ref` the framework doesn't always hoist into
 * `components.schemas`, leaving a dangling reference. Leaving meta off makes every schema
 * inline, which renders correctly in any tool.
 */

/** Emit a zod schema as an `application/json` response body. */
export function json(schema: z.ZodType, description: string) {
	return { description, content: { 'application/json': { schema: resolver(schema) } } }
}

/** The empty-body 401 the auth-gated routes return. */
export const UNAUTHORIZED_RESPONSE = { description: 'Missing or invalid bearer token (empty body)' }

/** Bearer-JWT security requirement, for the auth-gated routes. */
export const AUTHED = [{ bearerAuth: [] }]

/** An optional integer query parameter. */
export function intQuery(name: string, description: string): OpenAPIV3_1.ParameterObject {
	return { name, in: 'query', required: false, description, schema: { type: 'integer' } }
}

// ---- Response schemas ------------------------------------------------------

/** `GET /` — the root health check. */
export const HealthResponse = z.object({
	service: z.literal('ai'),
	status: z.literal('ok'),
})

/**
 * The Roomie AI access envelope — the `{ success, error_id, error, value }` shape, unlike
 * the flat Game AI refusal above. Roomie is granted here, with its energy budget pinned at
 * the maximum a signed 32-bit int holds (see INT32_MAX).
 */
export const RoomieAiAccess = z.object({
	success: z.literal(true),
	error_id: z.null(),
	error: z.null(),
	value: z.object({
		MaxEnergyFromSubscriptions: z
			.int()
			.describe('The energy ceiling a subscription buys — pinned to int32 max'),
		EnergyLeft: z.int().describe('Energy remaining. Never spent here, so also int32 max'),
		NextSubscriptionEnergyRechargeAt: z
			.string()
			.nullable()
			.describe('When the budget refills. Null — nothing depletes, so nothing recharges'),
		OutputAudioEnabled: z.boolean().describe('Whether Roomie may speak its replies'),
	}),
})

/**
 * The refusal every Game AI read answers with. It is a 200 carrying `success: false`, not
 * an HTTP error — the client branches on the body, and an error status would surface as a
 * failed request rather than the "not available here" state it is meant to show.
 */
export const GameAiAccessDenied = z.object({
	success: z.literal(false),
	error_id: z.string().describe('Machine-readable reason, e.g. `AI.RoomDoesNotSupportGameAI`'),
	error: z.string().describe('The message shown to the player'),
})
