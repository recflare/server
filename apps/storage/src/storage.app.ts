import { Hono } from 'hono'
import { describeRoute, openAPIRouteHandler } from 'hono-openapi'
import { useWorkersLogger } from 'workers-tagged-logger'

import {
	intVar,
	withCleanSpec,
	withDefaultCors,
	withNotFound,
	withOnError,
} from '@repo/hono-helpers'
import { validateAndGetAccountId, validateAndGetRoles } from '@repo/jwt'

import {
	AUTHED,
	ErrorResponse,
	json,
	text,
	UNAUTHORIZED_RESPONSE,
	UPLOAD_REQUEST_BODY,
	UploadResponse,
} from './openapi'

import type { App } from './context'

/**
 * Storage worker. Handles client file uploads (`POST /upload`) into the shared
 * CDN R2 bucket, foldered by the posted `FileType` so the `cdn` worker can serve
 * them back.
 */

/**
 * The client's `UploadFileType` enum → the R2 subfolder uploads of that type are
 * stored under. `Unknown` (0) is intentionally absent: like the referencecdn
 * server's `makeUploadName`, an unrecognized type has no destination and is
 * rejected rather than stored.
 *
 * RoomSave (1) lands under `room/` (not `roomsave/`) so the `cdn` worker's
 * `GET /room/:dataBlob` route serves the blob back — both bind the same
 * `recflare-cdn` bucket, so the key prefixes must match. RoomMetadata (6) — the
 * room-level blob a room save posts as `RoomData`, which the room then names as its
 * `DataBlob` — lands under `room/` too: the client fetches it from the same
 * `/room/<name>` path it fetches the scene from. It once went under `roommetadata/`,
 * where nothing ever asked for it. The two never collide — every upload is named by
 * a fresh GUID under the day's folder.
 */
const UPLOAD_SUBFOLDER: Record<number, string> = {
	1: 'room',
	2: 'data',
	3: 'image',
	4: 'video',
	5: 'invention',
	6: 'room',
	8: 'room',
	9: 'roomunityasset',
	10: 'unityasset',
}

/** Resolve the storage subfolder for a posted FileType, or `undefined` when unknown. */
function subfolderForFileType(fileType: string): string | undefined {
	return UPLOAD_SUBFOLDER[Number.parseInt(fileType, 10)]
}

/**
 * The file extension an upload of a given type keeps. Invention data blobs are
 * named `<name>.inv` — the client expects the extension on the `BlobName` it later
 * gets back from the api worker, so it has to be part of the stored key too, or the
 * blob wouldn't be there to download. Other types are stored under a bare name.
 */
const UPLOAD_EXTENSION: Record<number, string> = {
	5: '.inv',
}

/**
 * A Worker must not accept an unbounded user-controlled blob into memory and R2.
 * Operators can tune this for known room sizes, but an unset or invalid value keeps
 * the safe 64 MiB default. Non-positive values are invalid rather than disabling the
 * limit: a public upload endpoint must always have a finite ceiling.
 */
const DEFAULT_MAX_UPLOAD_BYTES = 64 * 1024 * 1024

function maxUploadBytes(value: unknown): number {
	const configured = intVar(value, DEFAULT_MAX_UPLOAD_BYTES)
	return configured > 0 ? configured : DEFAULT_MAX_UPLOAD_BYTES
}

/**
 * Operator-granted elevated roles (the auth worker stamps them from an account's
 * isDeveloper/isModerator flags). Same set `rooms` treats as staff. Staff uploads skip
 * the size limit: they load first-party content by hand that can outgrow it.
 */
const STAFF_ROLES: ReadonlySet<string> = new Set(['developer', 'moderator'])

function extensionForFileType(fileType: string): string {
	return UPLOAD_EXTENSION[Number.parseInt(fileType, 10)] ?? ''
}

/** Read a text form field by any of its accepted names, matched case-insensitively. */
function textField(body: Record<string, unknown>, ...names: string[]): string | undefined {
	for (const [key, value] of Object.entries(body)) {
		if (typeof value === 'string' && names.includes(key.toLowerCase())) return value
	}
	return undefined
}

/** Workers requires quoted disposition parameters; Mono emits valid bare tokens. */
function normalizeMultipartHeaders(contentType: string): TransformStream<Uint8Array, Uint8Array> {
	const boundary = /boundary=(?:"([^"]+)"|([^;\s]+))/i.exec(contentType)
	const marker = new TextEncoder().encode(`\r\n--${boundary?.[1] ?? boundary?.[2]}`)
	let pending = new Uint8Array(0)
	let headers = true
	return new TransformStream({
		transform(chunk, controller) {
			const bytes = new Uint8Array(pending.length + chunk.length)
			bytes.set(pending)
			bytes.set(chunk, pending.length)
			pending = bytes
			while (pending.length) {
				if (headers) {
					let end = -1
					for (let i = 0; i + 3 < pending.length; i++)
						if (
							pending[i] === 13 &&
							pending[i + 1] === 10 &&
							pending[i + 2] === 13 &&
							pending[i + 3] === 10
						) {
							end = i + 4
							break
						}
					if (end < 0) {
						if (pending.length > 64 * 1024) throw new Error('Multipart headers exceed limit')
						return
					}
					const text = new TextDecoder()
						.decode(pending.subarray(0, end))
						.replace(/^Content-Disposition:[^\r\n]*/gim, (line) =>
							line.replace(
								/(;\s*(?:name|filename)=)([!#$%&'*+\-.^_`|~0-9a-z]+)(?=;|\r|$)/gi,
								'$1"$2"'
							)
						)
					controller.enqueue(new TextEncoder().encode(text))
					pending = pending.subarray(end)
					headers = false
				} else {
					let start = -1
					for (let i = 0; i + marker.length + 1 < pending.length; i++) {
						if (
							pending[i] === 13 &&
							marker.every((byte, j) => pending[i + j] === byte) &&
							pending[i + marker.length] === 13 &&
							pending[i + marker.length + 1] === 10
						) {
							start = i
							break
						}
					}
					if (start < 0) {
						const end = Math.max(0, pending.length - marker.length - 2)
						if (end) controller.enqueue(pending.subarray(0, end))
						pending = pending.subarray(end)
						return
					}
					const end = start + marker.length + 2
					controller.enqueue(pending.subarray(0, end))
					pending = pending.subarray(end)
					headers = true
				}
			}
		},
		flush(controller) {
			if (pending.length) controller.enqueue(pending)
		},
	})
}

/** Studio compresses the entire multipart body, not the individual file parts. */
async function readUploadForm(
	request: Request,
	limit: number
): Promise<{ form: FormData } | { error: string; status: 400 | 413 | 415 }> {
	const encoding = request.headers.get('content-encoding')?.trim().toLowerCase()
	if (encoding && encoding !== 'identity' && encoding !== 'gzip')
		return { error: 'Unsupported upload encoding.', status: 415 }
	let tooLarge = false
	try {
		let stream = request.body
		if (!stream) return { form: new FormData() }
		if (encoding === 'gzip') stream = stream.pipeThrough(new DecompressionStream('gzip'))
		let decodedBytes = 0
		stream = stream.pipeThrough(
			new TransformStream<Uint8Array, Uint8Array>({
				transform(chunk, controller) {
					decodedBytes += chunk.byteLength
					// Account for the multipart envelope while bounding expanded input before parsing.
					if (decodedBytes > limit + 64 * 1024) {
						tooLarge = true
						throw new Error('Decoded upload exceeds limit')
					}
					controller.enqueue(chunk)
				},
			})
		)
		const headers = new Headers(request.headers)
		headers.delete('content-encoding')
		headers.delete('content-length')
		if (/^multipart\/form-data\s*;/i.test(headers.get('content-type') ?? ''))
			stream = stream.pipeThrough(normalizeMultipartHeaders(headers.get('content-type')!))
		return {
			form: await new Request(request.url, { method: 'POST', headers, body: stream }).formData(),
		}
	} catch {
		return {
			error: tooLarge ? 'Files exceed the upload limit.' : 'Invalid upload form.',
			status: tooLarge ? 413 : 400,
		}
	}
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
	// The game posts here with no Origin at all, but the website does too — it uploads a
	// subroom's scene blob straight from the browser, the same way it calls `rooms` and
	// `accounts` directly. An `Authorization` header makes that a preflighted request, so
	// without this the OPTIONS gets a 404 and the upload never leaves the page.
	.use('*', withDefaultCors())

	.onError(withOnError())
	.notFound(withNotFound())

	.get(
		'/',
		describeRoute({
			tags: ['Meta'],
			summary: 'Health check',
			description: 'Plain-text liveness probe. No auth.',
			responses: { 200: text('Service is up (`hello, world!`)') },
		}),
		async (c) => {
			return c.text('hello, world!')
		}
	)

	// File upload. Auth-gated — any valid account token is allowed (no role check), but
	// staff (developer/moderator) skip the size limit.
	// Multipart form with `FileType` (the client's UploadFileType enum) and a binary
	// part. Stores the file in the shared CDN R2 bucket under
	// `<type-subfolder>/<upload-date>/<random-name>` and returns the generated name
	// (the `<upload-date>/<random-name>` part the `cdn` worker serves back) the client
	// references it by. Also accepts a name-only post (no binary) that just echoes
	// back an explicit `name`/`filename`/`imagename`. Mirrors the reference `Upload`.
	.post(
		'/upload/unityassets',
		describeRoute({
			tags: ['Upload'],
			summary: 'Upload Studio source files',
			security: AUTHED,
			description:
				'Repeated multipart file parts, returned in request order with filename and SHA-256.',
		}),
		async (c) => {
			const id = await validateAndGetAccountId(c.req.raw, await c.env.JWT_SECRET.get())
			if (id === null) return c.body(null, 401)
			const limit = maxUploadBytes(c.env.MAX_UPLOAD_BYTES)
			const parsed = await readUploadForm(c.req.raw, limit)
			if ('error' in parsed) return c.json({ error: parsed.error }, parsed.status)
			const form = parsed.form
			const files = Array.from(form.values()).filter(
				(value): value is File => value instanceof File
			)
			if (files.length === 0) return c.json({ error: 'No source files supplied.' }, 400)
			if (files.reduce((size, file) => size + file.size, 0) > limit)
				return c.json({ error: 'Source files exceed the upload limit.' }, 413)
			const uploaded = []
			for (const file of files) {
				const bytes = await file.arrayBuffer()
				const hash = await crypto.subtle.digest('SHA-256', bytes)
				// SDK XYGEAHCXHVR: unsigned little-endian SHA-256, base36 padded to
				// 50 digits, then the first 40 characters. Its source manifest already
				// contains this name before upload; random names cannot round-trip.
				const name = new Uint8Array(hash)
					.reduceRight((n, byte) => n * 256n + BigInt(byte), 0n)
					.toString(36)
					.padStart(50, '0')
					.slice(0, 40)
				await c.env.CDN_ASSETS.put(`unityasset/${name}`, bytes, { sha256: hash })
				uploaded.push({ Filename: name, Hash: btoa(String.fromCharCode(...new Uint8Array(hash))) })
			}
			return c.json(uploaded)
		}
	)
	.post(
		'/upload',
		describeRoute({
			tags: ['Upload'],
			summary: 'Upload a file',
			description: [
				'Stores the posted file in the shared CDN R2 bucket under',
				'`<type-subfolder>/<upload-date>/<random-name>` and returns the',
				'`<upload-date>/<random-name>` part the client references it by (the same name the',
				'`cdn` worker serves back). The subfolder comes from `FileType`; RoomSave (1) lands',
				'under `room/` so the cdn worker’s `GET /room/:dataBlob` finds it, and an Invention',
				'(5) keeps a `.inv` extension on both the key and the returned name. Auth-gated —',
				'any valid account token is allowed, no role check; staff (developer/moderator) skip the size limit. A post with no binary part but',
				'an explicit `imageName` / `filename` / `name` just echoes that name back. Mirrors',
				'the reference server’s `Upload`.',
			].join(' '),
			security: AUTHED,
			requestBody: UPLOAD_REQUEST_BODY,
			responses: {
				200: json(UploadResponse, 'The stored (or echoed) file name'),
				400: json(ErrorResponse, 'Unknown/missing FileType, or neither a file nor a name'),
				401: UNAUTHORIZED_RESPONSE,
				413: json(
					ErrorResponse,
					'The binary file exceeds the configured upload limit (staff are exempt)'
				),
			},
		}),
		async (c) => {
			const secret = await c.env.JWT_SECRET.get()
			const id = await validateAndGetAccountId(c.req.raw, secret)
			if (id === null) return c.body(null, 401)

			const roles = await validateAndGetRoles(c.req.raw, secret)
			const isStaff = roles?.some((role) => STAFF_ROLES.has(role)) ?? false
			const limit = maxUploadBytes(c.env.MAX_UPLOAD_BYTES)
			const parsed = await readUploadForm(c.req.raw, isStaff ? Number.MAX_SAFE_INTEGER : limit)
			if ('error' in parsed) return c.json({ error: parsed.error }, parsed.status)
			const body = Object.fromEntries(parsed.form.entries())

			// The binary part is identified by being a file (filename/content-type),
			// not by its field name — matching the reference's part detection.
			const file = Object.values(body).find((v): v is File => v instanceof File)

			if (file) {
				if (!isStaff && file.size > limit) {
					return c.json({ error: `file exceeds the ${limit}-byte upload limit` }, 413)
				}

				const fileType = textField(body, 'filetype') ?? '0'
				const subfolder = subfolderForFileType(fileType)
				if (subfolder === undefined) {
					// makeUploadName == "" → no destination for an unknown/missing type.
					return c.json({ error: 'missing or unknown FileType' }, 400)
				}
				// Folder each upload under its date (e.g. `room/2026-02-03/<uuid>`) so the
				// bucket stays browsable. The date is part of the returned name, so the key
				// the `cdn` worker reads back (`<subfolder>/<name>`) still round-trips — as
				// does the extension, which is why it goes on the key, not just the name.
				const datePrefix = new Date().toISOString().slice(0, 10)
				const filename = `${datePrefix}/${crypto.randomUUID()}${extensionForFileType(fileType)}`
				const bytes = await file.arrayBuffer()
				await c.env.CDN_ASSETS.put(`${subfolder}/${filename}`, bytes, {
					httpMetadata: { contentType: file.type || 'application/octet-stream' },
					// Record the SHA-256 on the object. R2 stores an md5 on its own, but the
					// hashes the client is served (an invention's `BlobHash`) are SHA-256, and
					// only a checksum given at put time is readable later — this lets the `api`
					// worker answer one from a HEAD instead of downloading the blob to digest it.
					sha256: await crypto.subtle.digest('SHA-256', bytes),
				})
				if (c.req.header('user-agent')?.startsWith('RRStudio')) {
					const hash = await crypto.subtle.digest('SHA-256', bytes)
					return c.json({
						Filename: filename,
						Hash: btoa(String.fromCharCode(...new Uint8Array(hash))),
					})
				}
				return c.json({ filename })
			}

			// No binary — accept an explicit name and echo it straight back.
			const explicitName = textField(body, 'imagename', 'filename', 'name')
			if (explicitName) return c.json({ filename: explicitName })

			return c.json({ error: 'missing filename or valid upload data' }, 400)
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
					title: 'recflare storage',
					version: '1.0.0',
					description: [
						'File uploads for recflare, a private-server reimplementation of the Rec Room',
						'backend. The client posts room saves, holotars, images, videos, inventions and',
						'room metadata here; each lands in the shared CDN R2 bucket under a folder chosen',
						'by its `FileType`, and the `cdn` worker serves them back from the same bucket.',
					].join('\n'),
				},
				servers: [{ url: 'https://storage.recflare.net', description: 'Production' }],
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
