import { resolver } from 'hono-openapi'
import { z } from 'zod'

import type { OpenAPIV3_1 } from 'openapi-types'

/**
 * OpenAPI schemas for the leaderboard worker.
 *
 * IMPORTANT: these are DESCRIPTIVE ONLY. They are passed to `describeRoute` to generate
 * the spec and are never wired into `hono-openapi`'s `validator()`. Same rationale as the
 * auth/accounts/econ/match workers: a reverse-engineered protocol, lenient handlers, no
 * runtime validation. Here it matters more than usual — the handlers do not parse their
 * bodies at all yet, so a body that contradicts the schema below is still answered.
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

/**
 * Convert a zod schema to a plain OpenAPI schema for a request body. `describeRoute`'s
 * `requestBody` takes an OpenAPI schema (not a `resolver()`). zod's `$schema` key and
 * `additionalProperties: false` are dropped — the handlers read nothing out of these
 * bodies at all, so a closed object would misreport them as stricter than they are.
 */
function toOpenApiSchema(schema: z.ZodType): OpenAPIV3_1.SchemaObject {
	const { $schema: _$schema, additionalProperties: _extra, ...jsonSchema } = z.toJSONSchema(schema)
	return jsonSchema as OpenAPIV3_1.SchemaObject
}

/** An `application/json` request body — what the client posts to both reads. */
export function jsonBody(schema: z.ZodType, description: string): OpenAPIV3_1.RequestBodyObject {
	return { description, content: { 'application/json': { schema: toOpenApiSchema(schema) } } }
}

// ---- Response schemas ------------------------------------------------------

/**
 * Both leaderboard reads answer this and nothing else: `{ Rows: [...] }`.
 *
 * `Rows` is EMPTY on this server — nothing scores anything yet — and an empty list is a
 * complete answer meaning "this leaderboard has no scores", which the client renders as a
 * blank board rather than failing. The key must be present; a bare `{}` trips its parser.
 *
 * The row shape is therefore undocumented: no live response has ever carried one, so
 * describing a row here would be inventing it. It is typed as an open object rather than
 * `unknown` so a viewer shows an object in the array.
 */
export const LeaderboardRows = z.object({
	Rows: z
		.array(z.looseObject({}))
		.describe('The board’s rows. Always empty — nothing is scored or stored yet.'),
})

// ---- Request schemas -------------------------------------------------------

/**
 * The body the client posts to `GetRanks`, e.g.
 * `{"RankStart":0,"RankEnd":9,"PlayerId":2,"StatChannel":1,"RoomId":6,"FilterType":0,"SortAscending":false}`.
 *
 * Recovered from a live client, not from a spec, and IGNORED by the handler today — the
 * board is empty whatever it says. It is documented because it is the record of what the
 * client asks for, which is what an implementation will have to answer.
 */
export const GetRanksBody = z.object({
	RankStart: z.int().describe('First rank of the slice, 0-based and inclusive'),
	RankEnd: z.int().describe('Last rank of the slice, inclusive — 0–9 is the first ten'),
	PlayerId: z.int().describe('The player reading the board'),
	StatChannel: z.int().describe('Which of the room’s tracked stats to rank on'),
	RoomId: z.int().describe('The room whose board is being read'),
	FilterType: z.int().describe('Client-side filter selector; its members aren’t known yet'),
	SortAscending: z.boolean().describe('false ranks highest-first, the usual leaderboard'),
})

/**
 * The body posted to `GetNearbyScores`. Its shape has NOT been recovered from the client —
 * the handler logs the raw text precisely so it can be — so this documents an open object
 * rather than guessing fields. Expect it to name a player and a board the way
 * {@link GetRanksBody} does.
 */
export const GetNearbyScoresBody = z
	.looseObject({})
	.describe('Unknown shape — logged by the handler so it can be recovered from a live client.')
