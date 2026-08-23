import { crop, PhotonImage, resize, SamplingFilter } from '@cf-wasm/photon'
import { Hono } from 'hono'
import { describeRoute, openAPIRouteHandler } from 'hono-openapi'
import { useWorkersLogger } from 'workers-tagged-logger'

import { withCleanSpec, withNotFound, withOnError, writeContentRange } from '@repo/hono-helpers'

import { imageBytes, json, ServiceStatus } from './openapi'

import type { App, Env } from './context'

/** Key id the client uses to look up the public half of the signing key. */
const SIGNATURE_KEY_ID = 'KEY:RSA:p1.rec.net'

/** Static asset served (200) when the requested key is missing from R2. */
const FALLBACK_ASSET_PATH = '/DefaultProfileImage.jpg'

/** Prefix extensionless keys resolve under in the shared `recflare-cdn` bucket. */
const CDN_IMAGE_PREFIX = 'image/'

/**
 * Cache-Control for served images — 30 days (86400 × 30), matching what `cdn` serves its
 * blobs with. `immutable` rides along because an uploaded image never changes under its
 * key: a new image simply uses a new one, so there is nothing for a browser to revalidate
 * inside the window.
 */
const CACHE_CONTROL = `public, max-age=${86400 * 30}, immutable`

/**
 * Allowed output dimensions. Restricting resizes to a small fixed set caps the
 * number of distinct variants an attacker can request, so they can't blow past
 * the edge cache and force the (expensive) WASM resize on every hit.
 */
const ALLOWED_DIMENSIONS = new Set([128, 256, 512, 1024])

/** JPEG quality used when re-encoding a resized image. */
const RESIZE_JPEG_QUALITY = 90

/** A requested transform, from `?width=`/`?height=`/`?cropSquare=1`. At least one applies. */
interface Transform {
	width?: number
	height?: number
	/** Center-crop the source to a square before resizing (`?cropSquare=1`). */
	cropSquare: boolean
}

/** Parse a dimension query param, or `undefined` if absent or not an allowed size. */
function parseDimension(value: string | undefined): number | undefined {
	if (value === undefined) return undefined
	const n = Number(value)
	if (!Number.isInteger(n) || !ALLOWED_DIMENSIONS.has(n)) return undefined
	return n
}

/** Build a `Transform` from the request query, or `null` when none is requested. */
function parseTransform(
	width: string | undefined,
	height: string | undefined,
	cropSquare: string | undefined
): Transform | null {
	const w = parseDimension(width)
	const h = parseDimension(height)
	const square = cropSquare === '1'
	if (w === undefined && h === undefined && !square) return null
	return { width: w, height: h, cropSquare: square }
}

/**
 * Decode `input`, apply the requested transform (optional center-crop to a
 * square, then resize preserving aspect ratio when only one dimension is given),
 * and re-encode as JPEG. Runs the Photon WASM codec in-isolate; edge caching
 * (see `wrangler.jsonc`) means each variant only pays this cost once.
 */
function resizeImage(input: Uint8Array, transform: Transform): Uint8Array {
	let img = PhotonImage.new_from_byteslice(input)
	// Every PhotonImage we allocate (source + each stage) must be freed.
	const owned = [img]
	try {
		if (transform.cropSquare) {
			const w = img.get_width()
			const h = img.get_height()
			const side = Math.min(w, h)
			const x = Math.floor((w - side) / 2)
			const y = Math.floor((h - side) / 2)
			img = crop(img, x, y, x + side, y + side)
			owned.push(img)
		}

		let { width, height } = transform
		if (width !== undefined || height !== undefined) {
			const srcW = img.get_width()
			const srcH = img.get_height()
			if (width !== undefined && height === undefined) {
				height = Math.max(1, Math.round((srcH / srcW) * width))
			} else if (height !== undefined && width === undefined) {
				width = Math.max(1, Math.round((srcW / srcH) * height))
			}
			img = resize(img, width!, height!, SamplingFilter.Lanczos3)
			owned.push(img)
		}

		return img.get_bytes_jpeg(RESIZE_JPEG_QUALITY)
	} finally {
		for (const image of owned) image.free()
	}
}

/**
 * Which bucket (and under which key) a requested path resolves in.
 *
 * Every object the `api` worker writes to `recflare-img` keeps a file extension
 * (`.jpg` is forced when the upload has none), so an extensionless key can only be
 * a `storage` upload: FileType 3 lands in the shared `recflare-cdn` bucket as
 * `image/<date>/<uuid>` and the client references it by the bare `<date>/<uuid>`
 * name it got back. That makes the extension a reliable discriminator —
 * `/2028-06-01/<uuid>` here is `recflare-cdn`'s `image/2028-06-01/<uuid>`.
 */
function resolveObject(env: Env, key: string): { bucket: R2Bucket; objectKey: string } {
	const filename = key.slice(key.lastIndexOf('/') + 1)
	return filename.includes('.')
		? { bucket: env.IMAGES, objectKey: key }
		: { bucket: env.CDN_ASSETS, objectKey: CDN_IMAGE_PREFIX + key }
}

// Import the signing key once per isolate. The key material is constant for the
// lifetime of the Worker, so caching the promise is safe.
let signingKey: Promise<CryptoKey | null> | undefined

function getSigningKey(env: Env): Promise<CryptoKey | null> {
	if (signingKey === undefined) {
		signingKey = (async () => {
			if (!env.IMG_SIGNING_KEY) return null
			const der = Uint8Array.from(atob(env.IMG_SIGNING_KEY), (ch) => ch.charCodeAt(0))
			return crypto.subtle.importKey(
				'pkcs8',
				der,
				{ name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-1' },
				false,
				['sign']
			)
		})()
	}
	return signingKey
}

/** RSA-SHA1 sign the bytes, base64-encoded. */
async function signImage(env: Env, bytes: BufferSource): Promise<string | null> {
	const key = await getSigningKey(env)
	if (!key) return null
	const sig = await crypto.subtle.sign('RSASSA-PKCS1-v1_5', key, bytes)
	let binary = ''
	for (const byte of new Uint8Array(sig)) binary += String.fromCharCode(byte)
	return btoa(binary)
}

/** Length of an RSA-2048 signature, matched by the placeholder below. */
const SIGNATURE_BYTES = 256

/**
 * A placeholder `Content-Signature` value derived from the object key.
 *
 * The client requires the header to be PRESENT when it asks for `?sig=p1` — it
 * does not check the value — and a real signature is this worker's dominant CPU
 * cost, so by default we fabricate one. Being a pure function of the key it needs
 * no access to the body, which is the whole point: the response still streams out
 * of R2 instead of being buffered into the isolate to be hashed.
 *
 * FNV-1a over the key seeds an xorshift32 PRNG that fills a full RSA-2048-length
 * signature, so the value looks structurally right and is stable for a given key
 * (a cached response and a fresh one agree). It is NOT verifiable: turn on
 * `IMG_SIGNING_ENABLED` if anything ever needs to check it.
 */
function stubSignature(key: string): string {
	let state = 0x811c9dc5
	for (let i = 0; i < key.length; i++) {
		state = Math.imul(state ^ key.charCodeAt(i), 0x01000193) >>> 0
	}
	// xorshift32 is a fixed point at zero; the FNV basis makes this unreachable in
	// practice, but a degenerate all-zero signature is worth ruling out outright.
	if (state === 0) state = 0x811c9dc5

	let binary = ''
	for (let i = 0; i < SIGNATURE_BYTES; i++) {
		state = (state ^ (state << 13)) >>> 0
		state = state ^ (state >>> 17)
		state = (state ^ (state << 5)) >>> 0
		binary += String.fromCharCode(state & 0xff)
	}
	return btoa(binary)
}

/**
 * How this request's `Content-Signature` header gets produced.
 *
 * - `none` — no `?sig=p1` was asked for; no header.
 * - `stub` — the value is a pure function of the object key and is already
 *   computed, so the body never has to be read. The default.
 * - `rsa` — a real RSA-SHA1 signature over the bytes actually returned, which
 *   forces the whole body through the isolate.
 */
type Signing = { mode: 'none' } | { mode: 'stub'; value: string } | { mode: 'rsa' }

function resolveSigning(env: Env, sig: string | undefined, key: string): Signing {
	if (sig !== 'p1') return { mode: 'none' }
	if (env.IMG_SIGNING_ENABLED === true) return { mode: 'rsa' }
	return { mode: 'stub', value: stubSignature(key) }
}

function signatureHeader(value: string): string {
	return `key-id=${SIGNATURE_KEY_ID}; data=${value}`
}

/**
 * Apply the key-derived placeholder signature, if that's the mode in play. Called
 * before the body is touched — a stub never forces buffering.
 */
function applyStubSignature(headers: Headers, signing: Signing): void {
	if (signing.mode === 'stub') headers.set('content-signature', signatureHeader(signing.value))
}

/** Whether serving this response requires the full body in the isolate. */
function needsBody(transform: Transform | null, signing: Signing): boolean {
	return transform !== null || signing.mode === 'rsa'
}

/**
 * Given the full image bytes and prepared response `headers`, optionally resize
 * (Photon) and/or RSA-SHA1 sign before returning the `Response`. Both operations
 * need the whole body, so callers buffer before calling this. A `stub` signature
 * is already on `headers` by this point.
 */
async function finalizeImage(
	env: Env,
	bytes: ArrayBuffer,
	headers: Headers,
	transform: Transform | null,
	signing: Signing
): Promise<Response> {
	let body: BufferSource = bytes
	if (transform) {
		body = resizeImage(new Uint8Array(bytes), transform)
		// Output is always JPEG, and the source etag no longer describes the body.
		headers.set('content-type', 'image/jpeg')
		headers.delete('etag')
	}

	if (signing.mode === 'rsa') {
		const signature = await signImage(env, body)
		if (signature) headers.set('content-signature', signatureHeader(signature))
	}

	return new Response(body, { headers })
}

/**
 * Serve a static asset `Response` with our standard cache headers, honouring
 * `?width`/`?height` (resize) and `?sig=p1` (signing). A transform or a real
 * signature requires the full body, so the asset is buffered; otherwise it is
 * streamed through untouched.
 */
async function serveStaticAsset(
	env: Env,
	asset: Response,
	transform: Transform | null,
	signing: Signing
): Promise<Response> {
	const headers = new Headers()
	const contentType = asset.headers.get('content-type')
	if (contentType) headers.set('content-type', contentType)
	headers.set('cache-control', CACHE_CONTROL)
	applyStubSignature(headers, signing)

	if (needsBody(transform, signing)) {
		const bytes = await asset.arrayBuffer()
		return finalizeImage(env, bytes, headers, transform, signing)
	}

	return new Response(asset.body, { headers })
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

	.onError(withOnError())
	.notFound(withNotFound())

	.get(
		'/',
		describeRoute({
			tags: ['Images'],
			summary: 'Service status',
			description: 'Liveness probe. Always `{ service: "img", status: "ok" }`.',
			responses: { 200: json(ServiceStatus, 'The worker is up') },
		}),
		(c) => c.json({ service: 'img', status: 'ok' })
	)

// The generated spec. Documentation only — no request is validated against it (see
// openapi.ts). `hide: true` keeps this route out of its own output.
//
// Registered BEFORE the `/:key{.+}` catch-all below: that route matches every path and
// always returns a Response (the DefaultProfileImage.jpg fallback when nothing is
// stored), so anything declared after it is unreachable. The spec is still complete —
// `openAPIRouteHandler` walks `app.routes` at request time, after the catch-all has
// been registered.
app.get(
	'/openapi.json',
	describeRoute({ hide: true }),
	withCleanSpec(
		openAPIRouteHandler(app, {
			documentation: {
				info: {
					title: 'recflare img',
					version: '1.0.0',
					description: [
						'Image hosting for recflare, a private-server reimplementation of the Rec Room',
						'backend. Serves every image the client renders — profile photos, room thumbnails,',
						'club banners and the photo feed — out of R2, with bundled static assets',
						'(`static/`) taking precedence over the bucket and `DefaultProfileImage.jpg` served',
						'as the fallback when a key is missing. Keys with an extension come from the',
						'`recflare-img` bucket; extensionless ones are `storage` uploads and come from the',
						'shared `recflare-cdn` bucket under its `image/` prefix. Optional center-crop and resize',
						'run through the Photon WASM codec; `?sig=p1` adds the `Content-Signature` header',
						'the client expects against `KEY:RSA:p1.rec.net` — a key-derived placeholder',
						'unless the `IMG_SIGNING_ENABLED` flag turns on real RSA-SHA1 signing.',
						'',
						'Note that this worker only serves bytes: the image metadata the client lists (the',
						'`SavedImage` records behind `/api/images/...`) lives in the `api` worker, which',
						'points at keys here.',
					].join('\n'),
				},
				servers: [{ url: 'https://img.recflare.net', description: 'Production' }],
			},
		})
	)
)

// Stream an image straight from the R2 bucket by key, e.g.
// `GET /DefaultProfileImage.jpg`. The key may contain slashes for nested
// objects. Supports conditional requests via If-None-Match.
//
// When the client appends `?sig=p1`, the response body is RSA-SHA1 signed and
// the signature returned in a `Content-Signature` header. Signing requires the
// full body, so the object is buffered.
app.get(
	'/:key{.+}',
	describeRoute({
		tags: ['Images'],
		summary: 'Serve an image by key',
		description: [
			'Serves the image stored under `key`, which may contain slashes for nested objects',
			'(e.g. `Base/Clearcut.jpg`). A bundled static asset always wins over an R2 object of',
			'the same key; when neither exists the bundled `DefaultProfileImage.jpg` is served',
			'with a 200 rather than a 404, so the client never renders a broken image.',
			'',
			'Which bucket the key resolves in depends on its extension. A key with one (always',
			'the case for an `api` image upload) comes from `recflare-img`. A key WITHOUT one is',
			'a `storage` upload and comes from the shared `recflare-cdn` bucket under its',
			'`image/` prefix, so `/2028-06-01/<uuid>` here serves `image/2028-06-01/<uuid>`',
			'there.',
			'',
			'Responses carry `Cache-Control: public, max-age=31536000, immutable` — an uploaded',
			'image is never rewritten in place, a new image gets a new key.',
			'',
			'`?width`/`?height`/`?cropSquare=1` run the body through the Photon codec and always',
			'return JPEG with no `ETag` (the source etag no longer describes the body), and the',
			'`If-None-Match` precondition is skipped. An out-of-range or non-integer dimension is',
			'ignored and the original is served — never an error.',
			'',
			'A `Range` is honoured (206) only on the untouched stream, which is the only response',
			'that advertises `Accept-Ranges`. A transform decodes the whole image and a real',
			'signature covers the whole body, so those serve the entire result and ignore the',
			'header. Where a range does apply, a `bytes=` request is never answered with a bare',
			'200: the `Content-Range` always states which bytes the body holds.',
		].join('\n'),
		parameters: [
			{
				name: 'key',
				in: 'path',
				required: true,
				description: 'Object key; may contain slashes. A key containing `..` is rejected (400).',
				schema: { type: 'string' },
			},
			{
				name: 'width',
				in: 'query',
				required: false,
				description: [
					'Output width. Only 128, 256, 512 or 1024 are honoured — any other value is',
					'ignored and the source served untouched. Given alone, height follows the aspect ratio.',
				].join(' '),
				schema: { type: 'integer', enum: [128, 256, 512, 1024], example: 512 },
			},
			{
				name: 'height',
				in: 'query',
				required: false,
				description:
					'Output height, same allowed set as `width`. Given alone, width follows the aspect ratio.',
				schema: { type: 'integer', enum: [128, 256, 512, 1024], example: 512 },
			},
			{
				name: 'cropSquare',
				in: 'query',
				required: false,
				description: [
					'`1` center-crops the source to a square before any resize. Used for the square',
					'profile/thumbnail slots. Any other value is ignored.',
				].join(' '),
				schema: { type: 'string', enum: ['1'] },
			},
			{
				name: 'sig',
				in: 'query',
				required: false,
				description: [
					'`p1` returns a `Content-Signature: key-id=KEY:RSA:p1.rec.net; data=<base64>`',
					'header. By default `data` is a PLACEHOLDER derived from the object key, not a',
					'real signature — the client requires the header to be present but does not',
					'verify it, and signing for real costs the streaming fast path. Set',
					'`IMG_SIGNING_ENABLED` for a true RSA-SHA1 signature over the bytes actually',
					'returned (i.e. the resized body when a transform applies); that also needs an',
					'`IMG_SIGNING_KEY`, without which the header is omitted entirely.',
				].join(' '),
				schema: { type: 'string', enum: ['p1'] },
			},
			{
				name: 'If-None-Match',
				in: 'header',
				required: false,
				description:
					'Conditional request against the R2 object etag. Ignored when a transform is requested.',
				schema: { type: 'string' },
			},
			{
				name: 'Range',
				in: 'header',
				required: false,
				description: [
					'A single byte range, parsed by R2 itself. Honoured with a 206 on the untouched',
					'stream only — ignored when a transform or a real signature applies, since both',
					'need the whole image. A `bytes=` value never yields a bare 200: the',
					'`Content-Range` names the bytes enclosed even where that is all of them.',
				].join(' '),
				schema: { type: 'string', example: 'bytes=0-1023' },
			},
		],
		responses: {
			200: imageBytes('The image bytes (or the DefaultProfileImage.jpg fallback)'),
			206: imageBytes('A byte range of the stored image, when the request carried a `Range`'),
			304: { description: 'If-None-Match matched the stored object etag; no body' },
			400: { description: 'The key contained `..`; no body' },
		},
	}),
	async (c) => {
		const key = c.req.param('key')
		if (key.includes('..')) return c.body(null, 400)

		// `?sig=p1` always answers with a Content-Signature header — the client needs
		// one to be there — but by default the value is a cheap placeholder derived
		// from the key rather than a real RSA-SHA1 signature over the body. See
		// stubSignature(); IMG_SIGNING_ENABLED switches back to real signing.
		const signing = resolveSigning(c.env, c.req.query('sig'), key)
		const transform = parseTransform(
			c.req.query('width'),
			c.req.query('height'),
			c.req.query('cropSquare')
		)

		// Prefer a bundled static asset when one exists for this key, before hitting
		// R2. This lets us ship canonical images (e.g. room thumbnails in `static/`)
		// that always win over whatever, if anything, is in the bucket.
		const staticAsset = await c.env.ASSETS.fetch(new URL(`/${key}`, c.req.url))
		if (staticAsset.ok) {
			return serveStaticAsset(c.env, staticAsset, transform, signing)
		}

		// Conditional requests only make sense for the untransformed object: a
		// resized response carries no etag, so the client can never send a matching
		// one. Skip the precondition when a transform is requested.
		const ifNoneMatch = transform ? undefined : c.req.header('if-none-match')?.replace(/"/g, '')
		const { bucket, objectKey } = resolveObject(c.env, key)
		// A `Range` applies only to the untouched stream. Resizing decodes the whole image
		// and an RSA signature covers the whole body, so a ranged read there would produce
		// bytes that are not the range asked for — ask R2 for the range only when we are
		// going to hand its bytes straight back. R2 parses the header itself; see
		// writeContentRange() below for why it is never answered with a bare 200.
		const range = needsBody(transform, signing) ? undefined : c.req.raw.headers
		const object = await bucket.get(objectKey, {
			...(ifNoneMatch ? { onlyIf: { etagDoesNotMatch: ifNoneMatch } } : {}),
			...(range ? { range } : {}),
		})
		if (!object) {
			// Missing from both static and R2 → serve the bundled DefaultProfileImage.jpg
			// static asset so clients still get a valid image instead of a 404. Honour
			// `?sig=p1` the same way so the fallback is signed like any other image.
			const asset = await c.env.ASSETS.fetch(new URL(FALLBACK_ASSET_PATH, c.req.url))
			return serveStaticAsset(c.env, asset, transform, signing)
		}

		const headers = new Headers()
		object.writeHttpMetadata(headers)
		headers.set('etag', object.httpEtag)
		headers.set('cache-control', CACHE_CONTROL)

		// Precondition matched (If-None-Match) → R2 returns no body.
		if (!('body' in object)) return new Response(null, { status: 304, headers })

		// Set after the 304 above so both signing modes behave alike: the header only
		// ever rides a response that actually carries bytes.
		applyStubSignature(headers, signing)

		if (needsBody(transform, signing)) {
			const bytes = await object.arrayBuffer()
			return finalizeImage(c.env, bytes, headers, transform, signing)
		}

		// Only the untouched stream can honour a range, so only it advertises the fact.
		// The transformed and static-asset paths above serve the whole thing regardless,
		// which is the legal answer to a range you cannot honour — but claiming
		// `accept-ranges` there would invite a client to expect otherwise.
		headers.set('accept-ranges', 'bytes')
		if (writeContentRange(headers, c.req.raw.headers, object)) {
			return new Response(object.body, { status: 206, headers })
		}

		return new Response(object.body, { headers })
	}
)

export default app
