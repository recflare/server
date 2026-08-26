import { resolver } from 'hono-openapi'
import { z } from 'zod'

import type { OpenAPIV3_1 } from 'openapi-types'

/**
 * OpenAPI schemas for the leaderboard worker.
 *
 * IMPORTANT: these are DESCRIPTIVE ONLY. They are passed to `describeRoute` to generate
 * the spec and are never wired into `hono-openapi`'s `validator()`. Same rationale as the
 * auth/accounts/econ/match workers: a reverse-engineered protocol, lenient handlers, no
 * runtime validation. Here it matters more than usual — three of the four handlers do not
 * parse their bodies at all, and the fourth reads one field, so a body that contradicts the
 * schema below is still answered.
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
 * `additionalProperties: false` are dropped — the handlers ignore fields they don't read,
 * so a closed object would misreport them as stricter than they are.
 */
function toOpenApiSchema(schema: z.ZodType): OpenAPIV3_1.SchemaObject {
	const { $schema: _$schema, additionalProperties: _extra, ...jsonSchema } = z.toJSONSchema(schema)
	return jsonSchema as OpenAPIV3_1.SchemaObject
}

/** An `application/json` request body — every leaderboard route takes one. */
export function jsonBody(schema: z.ZodType, description: string): OpenAPIV3_1.RequestBodyObject {
	return { description, content: { 'application/json': { schema: toOpenApiSchema(schema) } } }
}

// ---- Response schemas ------------------------------------------------------

/**
 * Both leaderboard reads answer this and nothing else: `{ Rows: [...] }`.
 *
 * An EMPTY `Rows` is a complete answer meaning "this leaderboard has no scores", which the
 * client renders as a blank board rather than failing. The key must be present; a bare `{}`
 * trips its parser. Each row is the same `{ PlayerId, Score, Rank }` {@link PlayerRank}
 * answers — the shape both reference servers serve.
 */
export const LeaderboardRows = z.object({
	Rows: z
		.array(z.lazy(() => PlayerRank))
		.describe('The board’s rows, in rank order. Empty when the board has no scores.'),
})

/**
 * `POST /leaderboard/GetPlayerRank` — one player's standing on one board, e.g.
 * `{"PlayerId":205,"Score":4200,"Rank":17}`.
 *
 * Three fields only: none of the board selectors the request names are echoed back, so the
 * client matches the answer to the question by having asked it. A player with no row gets
 * the 99999 sentinel with a zero score — see the route for why that rather than a rank of
 * 0, which would read as "first place".
 */
export const PlayerRank = z.object({
	PlayerId: z.int().describe('Echoed from the request — whose rank this is'),
	Score: z.int().describe('The player’s wins in the room; 0 when they have no row there'),
	Rank: z.int().describe('1-based position on the board; 99999 when the player isn’t on it'),
})

/**
 * `POST /leaderboard/CheckAndSetStat` — a BARE JSON number, not an envelope and not a
 * `{ value }` wrapper. The whole body is `0`.
 *
 * What the number means beyond "not an error" hasn't been recovered from the client; `0` is
 * what the live service answers, so it is what this answers.
 */
export const CheckAndSetStatResponse = z
	.literal(0)
	.describe('Always the bare number 0 — the result code the live service returns')

// ---- Request schemas -------------------------------------------------------

/**
 * The body the client posts to `GetRanks`, e.g.
 * `{"RankStart":0,"RankEnd":9,"PlayerId":2,"StatChannel":1,"RoomId":6,"FilterType":0,"SortAscending":false}`.
 *
 * Recovered from a live client, not from a spec. `StatChannel` and `FilterType` are
 * accepted and ignored — one board per room, global.
 */
export const GetRanksBody = z.object({
	RankStart: z.int().describe('First rank of the slice, 0-based and inclusive'),
	RankEnd: z.int().describe('Last rank of the slice, inclusive — 0–9 is the first ten'),
	PlayerId: z.int().describe('The player reading the board'),
	StatChannel: z.int().describe('Which of the room’s tracked stats to rank on'),
	RoomId: z.int().describe('The room whose board is being read'),
	FilterType: z.int().describe('Who the board counts: 0 Global, 1 Friends'),
	SortAscending: z.boolean().describe('false ranks highest-first, the usual leaderboard'),
})

/**
 * The body the client posts to `GetPlayerRank`, e.g.
 * `{"PlayerId":205,"StatChannel":2,"RoomId":14,"FilterType":0,"SortAscending":false}`.
 *
 * The same board selectors {@link GetRanksBody} carries, minus the slice — this asks about
 * one player rather than a page.
 */
export const GetPlayerRankBody = z.object({
	PlayerId: z.int().describe('The player whose rank is being asked for'),
	StatChannel: z.int().describe('Which of the room’s tracked stats to rank on'),
	RoomId: z.int().describe('The room whose board is being read'),
	FilterType: z.int().describe('Who the board counts: 0 Global, 1 Friends'),
	SortAscending: z.boolean().describe('false ranks highest-first, the usual leaderboard'),
})

/**
 * The body the client posts to `CheckAndSetStat`, e.g.
 * `{"StatChannel":2,"RoomId":14,"StatValue":1,"CurrentStatValue":null}`.
 *
 * A compare-and-set: `CurrentStatValue` is what the client believes is already stored (null
 * when it believes nothing is), and `StatValue` is what it wants stored. There is no
 * `PlayerId` — the stat belongs to whoever is calling.
 */
export const CheckAndSetStatBody = z.object({
	StatChannel: z.int().describe('Which of the room’s tracked stats is being written'),
	RoomId: z.int().describe('The room the stat belongs to'),
	StatValue: z.number().describe('The value to store'),
	CurrentStatValue: z
		.number()
		.nullable()
		.describe('What the client believes is stored now; null when it believes nothing is'),
})

/**
 * The body posted to `GetNearbyScores`: {@link GetPlayerRankBody} plus `WindowSize`. This
 * is the reference servers' shape (the client's `GetNearbyScoresRequestDTO` extends its
 * rank request with `WindowSize`); it has not yet been watched from a live client here,
 * which is why the handler still logs it.
 */
export const GetNearbyScoresBody = GetPlayerRankBody.extend({
	WindowSize: z.int().describe('How many rows either side of the player to return; default 10'),
})
