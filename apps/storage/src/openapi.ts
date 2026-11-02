import { resolver } from 'hono-openapi'
import { z } from 'zod'

import type { OpenAPIV3_1 } from 'openapi-types'

/**
 * OpenAPI schemas for the storage worker.
 *
 * IMPORTANT: these are DESCRIPTIVE ONLY. They are passed to `describeRoute` to
 * generate the spec and are never wired into `hono-openapi`'s `validator()`. Same
 * rationale as the auth/accounts/match/econ workers: a reverse-engineered protocol,
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

/** A `text/plain` response body. */
export function text(description: string) {
	return { description, content: { 'text/plain': { schema: { type: 'string' as const } } } }
}

function toOpenApiSchema(schema: z.ZodType): OpenAPIV3_1.SchemaObject {
	const { $schema: _$schema, additionalProperties: _extra, ...jsonSchema } = z.toJSONSchema(schema)
	return jsonSchema as OpenAPIV3_1.SchemaObject
}

/** A form-urlencoded / multipart request body (the client posts both). */
export function form(schema: z.ZodType, description: string): OpenAPIV3_1.RequestBodyObject {
	const s = toOpenApiSchema(schema)
	return {
		description,
		content: {
			'application/x-www-form-urlencoded': { schema: s },
			'multipart/form-data': { schema: s },
		},
	}
}

/** An `application/json` request body. */
export function jsonBody(schema: z.ZodType, description: string): OpenAPIV3_1.RequestBodyObject {
	return { description, content: { 'application/json': { schema: toOpenApiSchema(schema) } } }
}

/** The empty-body 401 the auth-gated routes return. */
export const UNAUTHORIZED_RESPONSE = { description: 'Missing or invalid bearer token (empty body)' }

/** Bearer-JWT security requirement, for the auth-gated routes. */
export const AUTHED = [{ bearerAuth: [] }]

// ---- Response schemas ------------------------------------------------------

/**
 * `POST /upload` success body. `filename` is the `<upload-date>/<random-name>` part of
 * the stored key — the client keeps it and later references the blob by it, and the
 * `cdn` worker reads it back from `<type-subfolder>/<filename>`. On a name-only post it
 * is the name that was sent, echoed straight back.
 */
export const UploadResponse = z.object({
	filename: z
		.string()
		.describe('`<YYYY-MM-DD>/<uuid>[.ext]`, or the posted name on a name-only upload'),
})

/** `POST /upload/video` success body: where and how to `PUT` the file, and where it will live. */
export const VideoUploadResponse = z.object({
	uploadUrl: z.string().describe('A presigned `PUT` URL for the R2 bucket, valid for `expiresIn`'),
	key: z.string().describe('The object key, `video/<name>-<id>.<ext>`; the `cdn` serves `/<key>`'),
	contentType: z
		.string()
		.describe('The `Content-Type` the `PUT` must send — the signature binds it'),
	expiresIn: z.number().describe('Seconds the URL stays valid'),
})

/** The `{ error }` body the 400s carry. */
export const ErrorResponse = z.object({ error: z.string() })

// ---- Request schemas -------------------------------------------------------

/** `POST /upload/video` JSON body: just the name of the file about to be uploaded. */
export const VideoUploadRequest = z.object({
	filename: z.string().describe('The file name, e.g. `intro.mp4`; its extension picks the type'),
})

/**
 * The text parts of `POST /upload`. Field names are matched case-insensitively, so the
 * client's `imageName` / `FileType` casing is only indicative. The binary part is not in
 * this schema — see `UPLOAD_REQUEST_BODY`.
 */
export const UploadRequest = z.object({
	FileType: z
		.string()
		.describe(
			[
				'The client’s UploadFileType enum as a string: 1 RoomSave, 2 Holotar, 3 Image,',
				'4 Video, 5 Invention, 6 RoomMetadata. 0 (Unknown) and unrecognized values have no',
				'destination folder and are rejected.',
			].join(' ')
		),
	imageName: z
		.string()
		.optional()
		.describe(
			[
				'Name-only post: with no binary part, an explicit `imageName` / `filename` / `name`',
				'is echoed straight back as `filename`.',
			].join(' ')
		),
})

/**
 * The `POST /upload` request body. The binary part is detected by being a file (it has a
 * filename / content-type), not by its field name, so its key is arbitrary — the client
 * posts it as `File`. zod cannot express a binary part, so it is spliced into the
 * generated schema as `{ type: 'string', format: 'binary' }`.
 */
export const UPLOAD_REQUEST_BODY: OpenAPIV3_1.RequestBodyObject = (() => {
	const body = form(UploadRequest, 'The FileType and the file to store')
	for (const media of Object.values(body.content)) {
		const schema = media.schema as OpenAPIV3_1.SchemaObject
		schema.properties = {
			...schema.properties,
			File: {
				type: 'string',
				format: 'binary',
				description: [
					'The file to store. Matched by being a file part, not by this field name.',
					'Omit it to make a name-only post.',
				].join(' '),
			},
		}
	}
	return body
})()
