import { resolver } from 'hono-openapi'
import { z } from 'zod'

import type { OpenAPIV3_1 } from 'openapi-types'

/**
 * OpenAPI schemas for the img worker.
 *
 * IMPORTANT: these are DESCRIPTIVE ONLY. They are passed to `describeRoute` to
 * generate the spec and are never wired into `hono-openapi`'s `validator()`. Same
 * rationale as the auth/accounts/econ workers: a reverse-engineered protocol, lenient
 * handlers, no runtime validation.
 *
 * Do NOT add `.meta({ id })` to these schemas — with this hono-openapi + zod v4 setup a
 * meta'd schema used in a response emits a `$ref` the framework doesn't always hoist
 * into `components.schemas`, leaving a dangling reference. Leaving meta off makes every
 * schema inline, which renders correctly in any tool.
 *
 * Most of this worker's surface is image BYTES, not JSON, so those responses are
 * described with a binary content type rather than a zod schema.
 */

/** Emit a zod schema as an `application/json` response body. */
export function json(schema: z.ZodType, description: string) {
	return { description, content: { 'application/json': { schema: resolver(schema) } } }
}

/**
 * An image-bytes response. The stored object's own content type is served verbatim
 * (usually `image/jpeg`, occasionally `image/png`); any response that went through the
 * Photon resize/crop path is re-encoded: `image/png` when the source is a PNG (so alpha
 * survives), `image/jpeg` otherwise.
 */
export function imageBytes(description: string): OpenAPIV3_1.ResponseObject {
	const schema: OpenAPIV3_1.SchemaObject = { type: 'string', format: 'binary' }
	return {
		description,
		content: {
			'image/jpeg': { schema },
			'image/png': { schema },
		},
	}
}

// ---- Response schemas ------------------------------------------------------

/** `GET /` — the liveness probe body. */
export const ServiceStatus = z.object({
	service: z.literal('img'),
	status: z.literal('ok'),
})
