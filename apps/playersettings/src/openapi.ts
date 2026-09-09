import { resolver } from 'hono-openapi'
import { z } from 'zod'

import type { OpenAPIV3_1 } from 'openapi-types'

/**
 * OpenAPI schemas for the playersettings worker.
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
 * A request body the handler accepts in either encoding. The single write route parses
 * form-urlencoded/multipart (`key`/`value`, which is what the client posts) and JSON
 * (one object or an array of them), so both are documented on the one body.
 */
export function formOrJson(
	formSchema: z.ZodType,
	jsonSchema: z.ZodType,
	description: string
): OpenAPIV3_1.RequestBodyObject {
	const f = toOpenApiSchema(formSchema)
	return {
		description,
		content: {
			'application/x-www-form-urlencoded': { schema: f },
			'multipart/form-data': { schema: f },
			'application/json': { schema: toOpenApiSchema(jsonSchema) },
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
	service: z.literal('playersettings'),
	status: z.literal('ok'),
})

/**
 * One stored setting as the client reads it (`GET /playersettings`). `Value` is always a
 * string — the client stores numbers/bools stringified.
 */
export const PlayerSettingEntry = z.object({
	PlayerId: z.int().describe('The authenticated player the setting belongs to'),
	Key: z.string(),
	Value: z.string(),
})

// ---- Request schemas -------------------------------------------------------

/**
 * The form-encoded write the client actually sends: a single `key`/`value` pair (e.g.
 * `key=PlayerSessionCount&value=1`). An empty `key` is dropped.
 */
export const SettingFormWrite = z.object({
	key: z.string().describe('The setting name; an empty key is ignored'),
	value: z.string().describe('The setting value, as a string'),
})

/**
 * The JSON form of the same write. Accepted as one object or an array of them, and both
 * `key`/`value` and `Key`/`Value` casings are read; numbers and booleans are stringified.
 */
export const SettingJsonWrite = z.union([
	z.object({
		key: z.string().optional(),
		Key: z.string().optional(),
		value: z.union([z.string(), z.number(), z.boolean()]).optional(),
		Value: z.union([z.string(), z.number(), z.boolean()]).optional(),
	}),
	z.array(
		z.object({
			key: z.string().optional(),
			Key: z.string().optional(),
			value: z.union([z.string(), z.number(), z.boolean()]).optional(),
			Value: z.union([z.string(), z.number(), z.boolean()]).optional(),
		})
	),
])

/**
 * The form-encoded delete the client actually sends: a bare `key=PlayerShoppingBagId`,
 * with no `value`. An empty `key` is ignored.
 */
export const SettingFormDelete = z.object({
	key: z.string().describe('The setting name to remove; an empty key is ignored'),
})

/**
 * The JSON form of the same delete. Accepted as a bare setting name, a `{ key }` /
 * `{ Key }` object, or an array of either.
 */
export const SettingJsonDelete = z.union([
	z.string(),
	z.object({ key: z.string().optional(), Key: z.string().optional() }),
	z.array(
		z.union([z.string(), z.object({ key: z.string().optional(), Key: z.string().optional() })])
	),
])
