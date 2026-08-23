import { resolver } from 'hono-openapi'
import { z } from 'zod'

import type { OpenAPIV3_1 } from 'openapi-types'

/**
 * OpenAPI schemas for the roomcomments worker.
 *
 * IMPORTANT: these are DESCRIPTIVE ONLY. They are passed to `describeRoute` to
 * generate the spec and are never wired into `hono-openapi`'s `validator()`. Same
 * rationale as the auth/accounts/econ/match workers: a reverse-engineered protocol,
 * lenient handlers, no runtime validation.
 *
 * Do NOT add `.meta({ id })` to these schemas — with this hono-openapi + zod v4 setup a
 * meta'd schema used in a response emits a `$ref` the framework doesn't always hoist
 * into `components.schemas`, leaving a dangling reference. Leaving meta off makes every
 * schema inline, which renders correctly in any tool.
 */

/** Emit a zod schema as an `application/json` response body. */
export function json(schema: z.ZodType, description: string) {
	return { description, content: { 'application/json': { schema: resolver(schema) } } }
}

function toOpenApiSchema(schema: z.ZodType): OpenAPIV3_1.SchemaObject {
	const { $schema: _$schema, additionalProperties: _extra, ...jsonSchema } = z.toJSONSchema(schema)
	return jsonSchema as OpenAPIV3_1.SchemaObject
}

/**
 * A form-encoded request body. The client posts `application/x-www-form-urlencoded`; Hono's
 * `parseBody()` also reads multipart, so both are documented on the one body.
 */
export function form(schema: z.ZodType, description: string): OpenAPIV3_1.RequestBodyObject {
	const f = toOpenApiSchema(schema)
	return {
		description,
		content: {
			'application/x-www-form-urlencoded': { schema: f },
			'multipart/form-data': { schema: f },
		},
	}
}

/** The empty-body 401 the auth-gated routes return. */
export const UNAUTHORIZED_RESPONSE = { description: 'Missing or invalid bearer token (empty body)' }

/** Bearer-JWT security requirement, for the auth-gated routes. */
export const AUTHED = [{ bearerAuth: [] }]

// ---- Response schemas ------------------------------------------------------

/** `GET /` — the root health check. */
export const HealthResponse = z.object({
	service: z.literal('roomcomments'),
	status: z.literal('ok'),
})

/**
 * One comment as the client reads it. `PositionX/Y/Z` are NUMBERS on the way out even
 * though the create body posts them as text — a quoted float fails the client's parser.
 */
export const RoomCommentEntry = z.object({
	CommentId: z.int().describe('Autoincrement id; also the `minId` cursor for the read'),
	RoomId: z.int(),
	SubRoomId: z.int().describe('The subroom whose scene the comment is pinned in'),
	AccountId: z.int().describe('The player who wrote it'),
	CreatedAt: z.string().describe('ISO-8601 UTC'),
	Message: z.string(),
	Style: z.int().describe('The bubble style the client rendered it with'),
	Unread: z
		.boolean()
		.describe(
			'Always true. Read state rather than a per-viewer flag, and nothing marks a comment read — the create response says true for the author’s own new comment too.'
		),
	PositionX: z.number(),
	PositionY: z.number(),
	PositionZ: z.number(),
})

// ---- Request schemas -------------------------------------------------------

/**
 * The form-encoded create the client actually sends, e.g.
 * `message=sdf&subRoomId=1307&style=0&positionX=-0.4979804&positionY=1.568297&positionZ=-0.05002981`.
 */
export const CommentCreateBody = z.object({
	message: z.string().describe('The comment text; an empty message is rejected'),
	subRoomId: z.string().describe('The subroom to pin it in (integer, as text)'),
	style: z.string().optional().describe('Bubble style (integer, as text); defaults to 0'),
	positionX: z.string().optional().describe('Scene position (float, as text); defaults to 0'),
	positionY: z.string().optional().describe('Scene position (float, as text); defaults to 0'),
	positionZ: z.string().optional().describe('Scene position (float, as text); defaults to 0'),
})
