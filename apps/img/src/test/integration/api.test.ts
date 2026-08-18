import { PhotonImage } from '@cf-wasm/photon'
import { createExecutionContext, env, SELF, waitOnExecutionContext } from 'cloudflare:test'
import { beforeAll, describe, expect, it } from 'vitest'

import app from '../../img.app'

import type { Env } from '../../context'

declare module 'cloudflare:test' {
	interface ProvidedEnv extends Env {}
}

const ORIGIN = 'https://example.com'

/** Decode a JPEG and read back its pixel dimensions. */
function jpegSize(bytes: Uint8Array): { width: number; height: number } {
	const img = PhotonImage.new_from_byteslice(bytes)
	try {
		return { width: img.get_width(), height: img.get_height() }
	} finally {
		img.free()
	}
}

// A tiny valid JPEG magic-number blob — enough to assert round-tripping.
const IMAGE_BYTES = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46])

// Public half (SPKI DER, base64) of the dev IMG_SIGNING_KEY in wrangler.jsonc —
// used to verify the Content-Signature header.
const PUBLIC_SPKI_B64 =
	'MIIBIjANBgkqhkiG9w0BAQEFAAOCAQ8AMIIBCgKCAQEA1EIcBzPCvOFRy3WYuG8ICaRyr/OpotABJBpiMq2zcZHsSPXQw7NC+N082JDqYLy627oB9qJ+wC3idtbzFTANLkIYIEWMWJC9hjWl56vBVXOIroji2+lOpR4hV9JRdgmJfBYXmJPtHRP4GAl8np9xcnZpbMJdauR+HIJiQT3QHc2RomLXWCUfOb564cW8Ks7CLlmXPWf4M77DufHhY+788uWq6bI0+QSJ1qrUi3gaou0HPj7YPTl7pUTwX4VOmHKN5Nw+/jB9f2JNpRKp9niylCVUgdHnmHz5iqMW86HRf7EJcalSyYn7cC6b1ng9GPYryybipZ7QuTgl52qu2GQDaQIDAQAB'

// An R2-only key that has no matching file in `static/`, so it exercises the
// bucket path rather than a static asset.
const R2_KEY = 'user-photo.jpg'

// An extensionless name, as returned by the `storage` worker for a FileType 3
// upload — served from `recflare-cdn` under `image/`, not `recflare-img`.
const CDN_NAME = '2028-06-01/12345-67890-12345'

/**
 * Fetch with real signing turned OFF — the deployed default. `vitest.config.ts`
 * binds `IMG_SIGNING_ENABLED` on so the RSA path stays covered, so the placeholder
 * path has to drive the app directly with an overridden env.
 */
async function unsignedFetch(url: string): Promise<Response> {
	const ctx = createExecutionContext()
	const res = await app.fetch(new Request(url), { ...env, IMG_SIGNING_ENABLED: false }, ctx)
	await waitOnExecutionContext(ctx)
	return res
}

beforeAll(async () => {
	await env.IMAGES.put(R2_KEY, IMAGE_BYTES, {
		httpMetadata: { contentType: 'image/jpeg' },
	})
	await env.CDN_ASSETS.put(`image/${CDN_NAME}`, IMAGE_BYTES, {
		httpMetadata: { contentType: 'image/jpeg' },
	})
	// Seed R2 with a key that ALSO exists in `static/` to prove static wins.
	await env.IMAGES.put('3DCharades.jpg', IMAGE_BYTES, {
		httpMetadata: { contentType: 'image/jpeg' },
	})
})

describe('img endpoints', () => {
	it('GET / reports service status', async () => {
		const res = await SELF.fetch(`${ORIGIN}/`)
		expect(res.status).toBe(200)
		expect(await res.json()).toEqual({ service: 'img', status: 'ok' })
	})

	it('streams an image stored in R2 with its content type', async () => {
		const res = await SELF.fetch(`${ORIGIN}/${R2_KEY}`)
		expect(res.status).toBe(200)
		expect(res.headers.get('content-type')).toBe('image/jpeg')
		expect(new Uint8Array(await res.arrayBuffer())).toEqual(IMAGE_BYTES)
	})

	// Images are served with the same 30-day window `cdn` uses for its blobs, plus
	// `immutable` — an image never changes under its key, a new one takes a new key.
	it('every served image carries the 30-day Cache-Control', async () => {
		const CACHE_CONTROL = `public, max-age=${86400 * 30}, immutable`

		// The stored object, a static asset, and the fallback for a key in neither.
		for (const path of [`/${R2_KEY}`, `/${CDN_NAME}`, '/does-not-exist-anywhere.jpg']) {
			const res = await SELF.fetch(`${ORIGIN}${path}`)
			expect(res.status, path).toBe(200)
			expect(res.headers.get('cache-control'), path).toBe(CACHE_CONTROL)
		}

		// And the transformed variant, which is rebuilt rather than streamed. Uses a real
		// (decodable) JPEG, since a resize has to actually run for this path to be reached.
		const resized = await SELF.fetch(`${ORIGIN}/3DCharades.jpg?width=128`)
		expect(resized.status).toBe(200)
		expect(resized.headers.get('cache-control')).toBe(CACHE_CONTROL)
	})

	it('serves an extensionless key from the cdn bucket under image/', async () => {
		const res = await SELF.fetch(`${ORIGIN}/${CDN_NAME}`)
		expect(res.status).toBe(200)
		expect(res.headers.get('content-type')).toBe('image/jpeg')
		expect(new Uint8Array(await res.arrayBuffer())).toEqual(IMAGE_BYTES)
	})

	it('does not look for an extensionless key in the image bucket', async () => {
		// Same bare name seeded into `recflare-img` instead: extensionless keys only
		// ever resolve against `recflare-cdn`, so this falls through to the default.
		await env.IMAGES.put('2028-06-02/only-in-img', IMAGE_BYTES)
		const res = await SELF.fetch(`${ORIGIN}/2028-06-02/only-in-img`)
		expect(res.status).toBe(200)
		const body = new Uint8Array(await res.arrayBuffer())
		expect(body.length).toBeGreaterThan(IMAGE_BYTES.length)
	})

	it('resizes an extensionless cdn image', async () => {
		// Exercises the transform path against the cdn bucket, not just the stream-through.
		// Needs a decodable JPEG, so reuse a bundled static asset's bytes.
		const real = await (await SELF.fetch(`${ORIGIN}/3DCharades.jpg`)).arrayBuffer()
		await env.CDN_ASSETS.put('image/2028-06-03/real-photo', real, {
			httpMetadata: { contentType: 'image/jpeg' },
		})

		const res = await SELF.fetch(`${ORIGIN}/2028-06-03/real-photo?width=128`)
		expect(res.status).toBe(200)
		expect(res.headers.get('content-type')).toBe('image/jpeg')
		expect(res.headers.get('etag')).toBeNull()
		expect(jpegSize(new Uint8Array(await res.arrayBuffer())).width).toBe(128)
	})

	it('serves a static asset in preference to an R2 object of the same key', async () => {
		const res = await SELF.fetch(`${ORIGIN}/3DCharades.jpg`)
		expect(res.status).toBe(200)
		expect(res.headers.get('content-type')).toMatch(/^image\/jpeg/)
		// The bundled static JPEG, not the tiny IMAGE_BYTES stub seeded into R2.
		const body = new Uint8Array(await res.arrayBuffer())
		expect(body.length).toBeGreaterThan(IMAGE_BYTES.length)
		expect(body[0]).toBe(0xff)
		expect(body[1]).toBe(0xd8)
	})

	it('serves a nested static asset', async () => {
		const res = await SELF.fetch(`${ORIGIN}/Base/Clearcut.jpg`)
		expect(res.status).toBe(200)
		expect(res.headers.get('content-type')).toMatch(/^image\/jpeg/)
		const body = new Uint8Array(await res.arrayBuffer())
		expect(body.length).toBeGreaterThan(0)
		expect(body[0]).toBe(0xff)
		expect(body[1]).toBe(0xd8)
	})

	it('returns 304 when If-None-Match matches the etag', async () => {
		const first = await SELF.fetch(`${ORIGIN}/${R2_KEY}`)
		const etag = first.headers.get('etag')
		expect(etag).toBeTruthy()
		const res = await SELF.fetch(`${ORIGIN}/${R2_KEY}`, {
			headers: { 'If-None-Match': etag! },
		})
		expect(res.status).toBe(304)
	})

	it('honors a Range request on the stored image with a 206', async () => {
		const res = await SELF.fetch(`${ORIGIN}/${R2_KEY}`, { headers: { Range: 'bytes=2-4' } })
		expect(res.status).toBe(206)
		expect(res.headers.get('content-range')).toBe('bytes 2-4/8')
		expect(res.headers.get('accept-ranges')).toBe('bytes')
		expect(new Uint8Array(await res.arrayBuffer())).toEqual(IMAGE_BYTES.slice(2, 5))
	})

	// R2 resolves a range it cannot parse or satisfy to the WHOLE object rather than
	// failing. Handing that back as a bare 200 is the shape that corrupts a chunked
	// download — the client wrote a whole file where it expected a slice — so every one
	// of these still states what the body holds.
	it('never answers a bytes range with a whole-object 200', async () => {
		for (const range of ['bytes=100-200', 'bytes=abc', 'bytes=0-1,3-4', 'bytes=0-7']) {
			const res = await SELF.fetch(`${ORIGIN}/${R2_KEY}`, { headers: { Range: range } })
			expect(res.status, range).toBe(206)
			expect(res.headers.get('content-range'), range).toBe('bytes 0-7/8')
		}

		// A unit other than bytes must be ignored outright (RFC 9110), not answered with
		// a byte-denominated Content-Range.
		const other = await SELF.fetch(`${ORIGIN}/${R2_KEY}`, { headers: { Range: 'items=0-1' } })
		expect(other.status).toBe(200)
		expect(other.headers.get('content-range')).toBeNull()
	})

	// A resize decodes the whole image, so there is no meaningful slice of the source to
	// read — the range is ignored and the whole transformed result served, which is the
	// legal answer. What it must NOT do is claim a 206 over bytes it rebuilt. Runs against
	// the R2 path (a decodable JPEG borrowed from `static/`), since that is the one that
	// has a range to suppress; the static-asset path is never handed one at all.
	it('ignores a Range when a transform rebuilds the body', async () => {
		const real = await (await SELF.fetch(`${ORIGIN}/3DCharades.jpg`)).arrayBuffer()
		await env.IMAGES.put('ranged-transform.jpg', real, {
			httpMetadata: { contentType: 'image/jpeg' },
		})

		const res = await SELF.fetch(`${ORIGIN}/ranged-transform.jpg?width=128`, {
			headers: { Range: 'bytes=0-9' },
		})
		expect(res.status).toBe(200)
		expect(res.headers.get('content-range')).toBeNull()
		expect(res.headers.get('accept-ranges')).toBeNull()
		expect(jpegSize(new Uint8Array(await res.arrayBuffer())).width).toBe(128)

		// Same for a real RSA signature, which covers the whole body (the test env binds
		// IMG_SIGNING_ENABLED on, so `?sig=p1` takes the signing path rather than the stub).
		const signed = await SELF.fetch(`${ORIGIN}/ranged-transform.jpg?sig=p1`, {
			headers: { Range: 'bytes=0-9' },
		})
		expect(signed.status).toBe(200)
		expect(signed.headers.get('content-range')).toBeNull()
		expect(signed.headers.get('content-signature')).toContain('key-id=KEY:RSA:p1.rec.net')
		expect(new Uint8Array(await signed.arrayBuffer()).byteLength).toBe(real.byteLength)
	})

	it('serves the DefaultProfileImage.jpg fallback for a missing image', async () => {
		const res = await SELF.fetch(`${ORIGIN}/missing.png`)
		expect(res.status).toBe(200)
		expect(res.headers.get('content-type')).toMatch(/^image\/jpeg/)
		const body = new Uint8Array(await res.arrayBuffer())
		// Real JPEG static asset: SOI marker + non-empty body.
		expect(body.length).toBeGreaterThan(0)
		expect(body[0]).toBe(0xff)
		expect(body[1]).toBe(0xd8)
	})

	it('signs the DefaultProfileImage.jpg fallback with ?sig=p1', async () => {
		const res = await SELF.fetch(`${ORIGIN}/missing.png?sig=p1`)
		expect(res.status).toBe(200)

		const header = res.headers.get('content-signature')
		expect(header).toMatch(/^key-id=KEY:RSA:p1\.rec\.net; data=/)

		const signatureB64 = header!.split('data=')[1]
		const signature = Uint8Array.from(atob(signatureB64), (ch) => ch.charCodeAt(0))
		const body = new Uint8Array(await res.arrayBuffer())

		const publicKey = await crypto.subtle.importKey(
			'spki',
			Uint8Array.from(atob(PUBLIC_SPKI_B64), (ch) => ch.charCodeAt(0)),
			{ name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-1' },
			false,
			['verify']
		)
		const ok = await crypto.subtle.verify('RSASSA-PKCS1-v1_5', publicKey, signature, body)
		expect(ok).toBe(true)
	})

	it('signs the response with ?sig=p1 and the signature verifies', async () => {
		const res = await SELF.fetch(`${ORIGIN}/${R2_KEY}?sig=p1`)
		expect(res.status).toBe(200)

		const header = res.headers.get('content-signature')
		expect(header).toMatch(/^key-id=KEY:RSA:p1\.rec\.net; data=/)

		const signatureB64 = header!.split('data=')[1]
		const signature = Uint8Array.from(atob(signatureB64), (ch) => ch.charCodeAt(0))
		const body = new Uint8Array(await res.arrayBuffer())

		const publicKey = await crypto.subtle.importKey(
			'spki',
			Uint8Array.from(atob(PUBLIC_SPKI_B64), (ch) => ch.charCodeAt(0)),
			{ name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-1' },
			false,
			['verify']
		)
		const ok = await crypto.subtle.verify('RSASSA-PKCS1-v1_5', publicKey, signature, body)
		expect(ok).toBe(true)
	})

	it('does not sign without ?sig=p1', async () => {
		const res = await SELF.fetch(`${ORIGIN}/${R2_KEY}`)
		expect(res.headers.get('content-signature')).toBeNull()
	})

	it('returns a placeholder signature when IMG_SIGNING_ENABLED is off', async () => {
		// The deployed default (see wrangler.jsonc). The header must still be there —
		// the client requires it — but the value is derived from the key, so the body
		// is neither buffered nor hashed and streams straight out of R2.
		const res = await unsignedFetch(`${ORIGIN}/${R2_KEY}?sig=p1`)
		expect(res.status).toBe(200)

		const header = res.headers.get('content-signature')
		expect(header).toMatch(/^key-id=KEY:RSA:p1\.rec\.net; data=/)
		// Same shape as a real RSA-2048 signature, so the client's parser sees no
		// difference between the two modes.
		const signature = Uint8Array.from(atob(header!.split('data=')[1]), (ch) => ch.charCodeAt(0))
		expect(signature.length).toBe(256)
		expect(signature.some((b) => b !== 0)).toBe(true)

		// Still on the streaming path: the source etag survives and the bytes are the
		// stored object, untouched.
		expect(res.headers.get('etag')).toBeTruthy()
		expect(new Uint8Array(await res.arrayBuffer())).toEqual(IMAGE_BYTES)
	})

	it('derives the placeholder signature from the key, stably', async () => {
		const sigFor = async (path: string) =>
			(await unsignedFetch(`${ORIGIN}/${path}?sig=p1`)).headers.get('content-signature')

		// Stable for a key, so a cached response and a fresh one agree...
		expect(await sigFor(R2_KEY)).toBe(await sigFor(R2_KEY))
		// ...and distinct across keys, so it isn't a single hardcoded constant.
		expect(await sigFor(R2_KEY)).not.toBe(await sigFor(CDN_NAME))
	})

	it('signs the fallback and resized bodies with a placeholder too', async () => {
		// The fallback (missing key) and the transform path both go through
		// serveStaticAsset/finalizeImage — the header must survive both.
		const fallback = await unsignedFetch(`${ORIGIN}/missing.png?sig=p1`)
		expect(fallback.headers.get('content-signature')).toMatch(/^key-id=KEY:RSA:p1\.rec\.net; /)

		const resized = await unsignedFetch(`${ORIGIN}/RecCenter.jpg?width=512&sig=p1`)
		expect(resized.headers.get('content-signature')).toMatch(/^key-id=KEY:RSA:p1\.rec\.net; /)
		expect(jpegSize(new Uint8Array(await resized.arrayBuffer())).width).toBe(512)
	})

	it('resizes a static asset to ?width, preserving aspect ratio', async () => {
		const full = new Uint8Array(await (await SELF.fetch(`${ORIGIN}/RecCenter.jpg`)).arrayBuffer())
		const original = jpegSize(full)

		const res = await SELF.fetch(`${ORIGIN}/RecCenter.jpg?width=512`)
		expect(res.status).toBe(200)
		expect(res.headers.get('content-type')).toBe('image/jpeg')
		// Resized responses carry no etag (the source etag no longer describes them).
		expect(res.headers.get('etag')).toBeNull()

		const body = new Uint8Array(await res.arrayBuffer())
		const resized = jpegSize(body)
		expect(resized.width).toBe(512)
		// Height scales with the source aspect ratio (allow 1px rounding).
		expect(resized.height).toBeCloseTo(Math.round((original.height / original.width) * 512), -0.5)
	})

	it('center-crops to a square and resizes with ?cropSquare=1&width', async () => {
		const res = await SELF.fetch(`${ORIGIN}/RecCenter.jpg?width=256&cropSquare=1`)
		expect(res.status).toBe(200)
		expect(res.headers.get('content-type')).toBe('image/jpeg')

		const size = jpegSize(new Uint8Array(await res.arrayBuffer()))
		expect(size.width).toBe(256)
		expect(size.height).toBe(256)
	})

	it('crops to a square at native size with ?cropSquare=1 alone', async () => {
		const full = jpegSize(
			new Uint8Array(await (await SELF.fetch(`${ORIGIN}/RecCenter.jpg`)).arrayBuffer())
		)
		const res = await SELF.fetch(`${ORIGIN}/RecCenter.jpg?cropSquare=1`)
		expect(res.status).toBe(200)

		const size = jpegSize(new Uint8Array(await res.arrayBuffer()))
		expect(size.width).toBe(size.height)
		// The square's side is the shorter source dimension.
		expect(size.width).toBe(Math.min(full.width, full.height))
	})

	it('ignores an invalid ?width and serves the original', async () => {
		const full = new Uint8Array(await (await SELF.fetch(`${ORIGIN}/RecCenter.jpg`)).arrayBuffer())
		const res = await SELF.fetch(`${ORIGIN}/RecCenter.jpg?width=0`)
		expect(res.status).toBe(200)
		expect(new Uint8Array(await res.arrayBuffer())).toEqual(full)
	})

	it('ignores a ?width outside the allowed sizes and serves the original', async () => {
		const full = new Uint8Array(await (await SELF.fetch(`${ORIGIN}/RecCenter.jpg`)).arrayBuffer())
		// 300 isn't one of 128/256/512/1024, so it's rejected and the source served.
		const res = await SELF.fetch(`${ORIGIN}/RecCenter.jpg?width=300`)
		expect(res.status).toBe(200)
		expect(new Uint8Array(await res.arrayBuffer())).toEqual(full)
	})

	it('signs the resized body with ?width and ?sig=p1', async () => {
		const res = await SELF.fetch(`${ORIGIN}/RecCenter.jpg?width=512&sig=p1`)
		expect(res.status).toBe(200)
		expect(jpegSize(new Uint8Array(await res.clone().arrayBuffer())).width).toBe(512)

		const header = res.headers.get('content-signature')
		expect(header).toMatch(/^key-id=KEY:RSA:p1\.rec\.net; data=/)

		const signature = Uint8Array.from(atob(header!.split('data=')[1]), (ch) => ch.charCodeAt(0))
		const body = new Uint8Array(await res.arrayBuffer())

		const publicKey = await crypto.subtle.importKey(
			'spki',
			Uint8Array.from(atob(PUBLIC_SPKI_B64), (ch) => ch.charCodeAt(0)),
			{ name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-1' },
			false,
			['verify']
		)
		// The signature must verify over the RESIZED bytes the client receives.
		const ok = await crypto.subtle.verify('RSASSA-PKCS1-v1_5', publicKey, signature, body)
		expect(ok).toBe(true)
	})

	it('GET /openapi.json documents every route', async () => {
		const res = await SELF.fetch(`${ORIGIN}/openapi.json`)
		expect(res.status).toBe(200)
		const spec = (await res.json()) as {
			openapi: string
			paths: Record<string, Record<string, { summary?: string }>>
		}
		expect(spec.openapi).toMatch(/^3\.1/)

		// The spec route hides itself.
		expect(spec.paths['/openapi.json']).toBeUndefined()

		// Every route the worker serves is described. This is the drift guard: adding a
		// route without a describeRoute() block fails here rather than silently shipping
		// an incomplete spec. Hono's `:param` syntax becomes OpenAPI's `{param}`.
		const documented = new Set(
			Object.entries(spec.paths).flatMap(([path, ops]) =>
				Object.keys(ops).map((method) => `${method.toUpperCase()} ${path}`)
			)
		)
		expect([...documented].sort()).toEqual(['GET /', 'GET /{key}'])

		// Every operation carries a summary — a path present but undescribed is not
		// documentation.
		for (const ops of Object.values(spec.paths)) {
			for (const op of Object.values(ops)) expect(op.summary).toBeTruthy()
		}

		// Schemas must inline: a `$ref` here is a dangling reference (see openapi.ts).
		expect(JSON.stringify(spec).includes('"$ref"')).toBe(false)
	})
})
