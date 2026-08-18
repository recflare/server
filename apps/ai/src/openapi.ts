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

/**
 * An optional boolean query parameter. The client spells these .NET-style (`False`, not
 * `false`), which is worth recording even where the value is ignored.
 */
export function boolQuery(name: string, description: string): OpenAPIV3_1.ParameterObject {
	return { name, in: 'query', required: false, description, schema: { type: 'boolean' } }
}

/** An integer path parameter (ids are constrained to `[0-9]+` by the route pattern). */
export function idParam(name: string, description: string): OpenAPIV3_1.ParameterObject {
	return { name, in: 'path', required: true, description, schema: { type: 'integer' } }
}

/**
 * An `application/json` request body.
 *
 * The schema is emitted directly rather than through `resolver()` — zod's `$schema` key
 * and `additionalProperties: false` are dropped, since the handler reads the fields it
 * knows and ignores the rest, so a closed object would misreport it as stricter than it is.
 */
export function jsonBody(schema: z.ZodType, description: string): OpenAPIV3_1.RequestBodyObject {
	const { $schema: _$schema, additionalProperties: _extra, ...jsonSchema } = z.toJSONSchema(schema)
	return {
		description,
		content: { 'application/json': { schema: jsonSchema as OpenAPIV3_1.SchemaObject } },
	}
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

/**
 * The same refusal, plus an explicit `value: null`. The spend summary carries the key
 * where the access check omits it — the access check answers a yes/no and has nothing to
 * carry, while this one's payload slot exists and is simply empty. Reproduced as the
 * reference server sends it; don't unify the two.
 */
export const GameAiSpendSummaryDenied = GameAiAccessDenied.extend({
	value: z.null().describe('The spend summary. Null — there is no Game AI spend to report'),
})

/**
 * `GET /makerai/user/access` — a BARE JSON boolean, not an envelope and not a `{ value }`
 * wrapper. The whole body is the answer.
 */
export const MakerAiAccessResponse = z
	.boolean()
	.describe('Whether the caller may use Maker AI; always false — no model runs here')

/**
 * Maker AI's dollar balances. A FLAT body — no `{ success, error, value }` envelope — and
 * every figure zero, since nothing here bills for model usage.
 */
export const MakerAiBalances = z.object({
	UsageDollars: z.number().describe('Dollars of model usage spent this period. Always 0'),
	UsersMaxUsageDollars: z.number().describe('The caller’s usage ceiling. Always 0'),
	RRPlusUsageDollars: z.number().describe('Usage spent against the RR+ allowance. Always 0'),
	UsersMaxRRPlusUsageDollars: z.number().describe('The RR+ allowance ceiling. Always 0'),
	TimeBalanceStatus: z.string().describe('Time-balance bucket state, e.g. `Empty`'),
	TimeExpiresAt: z
		.string()
		.describe('When the time balance lapses. `DateTime.MinValue` — there is none'),
	UsageBalanceStatus: z.string().describe('Usage-balance bucket state, e.g. `Good`'),
	UsagePercent: z.number().describe('Share of the usage ceiling consumed. Always 0'),
	RRPlusUsageBalanceStatus: z.string().describe('RR+ usage bucket state, e.g. `Good`'),
	RRPlusUsagePercent: z.number().describe('Share of the RR+ allowance consumed. Always 0'),
})

/** The body the client posts to open a realtime session. Read for documentation only. */
export const RealtimeSessionCreateBody = z.object({
	AIType: z
		.string()
		.optional()
		.describe('Which assistant the client is opening a session for, e.g. `Roomie`'),
})

/**
 * The realtime-session refusal. `{ success, error, error_id, value }` — note `error_id` is
 * an empty string rather than a machine-readable code, and `value` (which would carry the
 * session id and its client secret) is null.
 */
export const RealtimeSessionDenied = z.object({
	success: z.literal(false),
	error: z.string().describe('The message shown to the player'),
	error_id: z.string().describe('Empty — the reference server sends no code for this refusal'),
	value: z.null().describe('The session credentials. Null: no session is created'),
})

/**
 * What Roomie knows about the caller: a prose profile it is primed with, and the discrete
 * facts behind it. Both empty here — nothing observes the player to build them.
 */
export const RoomieUserFacts = z.object({
	UserContext: z.string().describe('A prose profile Roomie is primed with. Empty'),
	UserFacts: z
		.array(
			z.object({
				Id: z.string().describe('GUID identifying the fact'),
				CreatedAt: z.string().describe('When the fact was recorded'),
				Emotion: z.string().describe('Sentiment attached to the fact, e.g. `neutral`'),
				Predicate: z.string().describe('The relation, e.g. `identifies as`'),
				Object: z.string().describe('The value the predicate points at'),
			})
		)
		.describe('The recorded facts. Always empty — nothing here observes the player'),
})
