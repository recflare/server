import { resolver } from 'hono-openapi'
import { z } from 'zod'

import type { OpenAPIV3_1 } from 'openapi-types'

/**
 * OpenAPI schemas for the cdn worker.
 *
 * IMPORTANT: these are DESCRIPTIVE ONLY. They are passed to `describeRoute` to
 * generate the spec and are never wired into `hono-openapi`'s `validator()`. Same
 * rationale as the auth/accounts/img workers: a reverse-engineered protocol, lenient
 * handlers, no runtime validation.
 *
 * Do NOT add `.meta({ id })` to these schemas — with this hono-openapi + zod v4 setup a
 * meta'd schema used in a response emits a `$ref` the framework doesn't always hoist
 * into `components.schemas`, leaving a dangling reference. Leaving meta off makes every
 * schema inline, which renders correctly in any tool.
 *
 * Most of this worker's surface is opaque BYTES, not JSON, so those responses are
 * described with a binary content type rather than a zod schema (the same way the `img`
 * worker describes image bytes).
 */

/** Emit a zod schema as an `application/json` response body. */
export function json(schema: z.ZodType, description: string) {
	return { description, content: { 'application/json': { schema: resolver(schema) } } }
}

/**
 * A binary asset response. Everything streamed out of the bucket is served as
 * `application/octet-stream` regardless of what it actually is — the client downloads
 * these blobs, it never sniffs their type.
 */
export function assetBytes(description: string): OpenAPIV3_1.ResponseObject {
	return {
		description,
		content: { 'application/octet-stream': { schema: { type: 'string', format: 'binary' } } },
	}
}

/** The shared responses of every asset route: the byte-serving ones plus its failures. */
export function assetResponses(description: string): OpenAPIV3_1.ResponsesObject {
	return {
		200: assetBytes(description),
		206: assetBytes('A byte range, when the request carried a `Range` header'),
		304: { description: '`If-None-Match` matched the stored etag (no body)' },
		400: { description: 'The key contains `..` (no body)' },
		404: { description: 'No such object in the bucket' },
		416: { description: 'The `Range` header could not be satisfied (no body)' },
	}
}

/** The `Range` / `If-None-Match` headers every asset route honours. */
export const CONDITIONAL_HEADERS: OpenAPIV3_1.ParameterObject[] = [
	{
		name: 'Range',
		in: 'header',
		required: false,
		description:
			'A single byte range (`bytes=start-end`, `bytes=start-`, `bytes=-suffix`), parsed by R2 itself. Any `bytes=` value is answered 206 with a `Content-Range` naming the bytes enclosed — never a bare 200 carrying the whole object, which a chunked downloader would write at the offset it asked for. A multi-range or unsatisfiable value yields the whole object, but says so in the `Content-Range`. A unit other than `bytes` is ignored (200).',
		schema: { type: 'string', example: 'bytes=0-1023' },
	},
	{
		name: 'If-None-Match',
		in: 'header',
		required: false,
		description: 'The etag of a previously fetched copy; a match answers 304 with no body.',
		schema: { type: 'string' },
	},
]

/** A path parameter naming an object in the bucket. */
export function keyParam(
	name: string,
	description: string,
	slashes: boolean
): OpenAPIV3_1.ParameterObject {
	return {
		name,
		in: 'path',
		required: true,
		description: slashes ? `${description} May contain slashes.` : description,
		schema: { type: 'string' },
	}
}

// ---- Response schemas ------------------------------------------------------

/**
 * An opaque JSON document — the config files under `static/config/` are served verbatim
 * and nothing here interprets them, so modelling their fields would be noise that goes
 * stale the moment a file is replaced.
 */
export const JsonValue = z.record(z.string(), z.unknown())

/** `GET /` — the liveness probe body. */
export const ServiceStatus = z.object({
	service: z.literal('cdn'),
	status: z.literal('ok'),
})

/**
 * One loading-screen tip. `Context`/`InputType`/`Visibility` are client-side enums that
 * decide where a tip may appear, and `PlatformMask` is a bit field of the platforms it
 * shows on — every tip in the bundled set is left at whatever the 2019 capture had.
 */
export const LoadingScreenTip = z.object({
	Name: z.string().describe('A GUID (no dashes) — the tip’s id, not a display name'),
	Title: z.string(),
	Message: z.string(),
	RoomNames: z
		.array(z.string())
		.describe('Rooms to restrict the tip to; empty everywhere in the bundled set'),
	Context: z.int(),
	InputType: z.int(),
	Visibility: z.int(),
	AllowCycling: z.boolean(),
	RestrictToNewUsers: z.boolean(),
	ImageName: z.string().describe('An image key the client resolves against the img worker'),
	PlatformMask: z.int().describe('Bit field of the platforms the tip shows on'),
	CreatedAt: z.string(),
})
