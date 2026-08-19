import { env } from 'cloudflare:test'
import { exports } from 'cloudflare:workers'
import { describe, expect, test } from 'vitest'

import '../../cdn.app'

import type { Env } from '../../context'

declare module 'cloudflare:test' {
	interface ProvidedEnv extends Env {}
}

const ORIGIN = 'https://example.com'

describe('cdn endpoints', () => {
	test('GET / reports service status', async () => {
		const res = await exports.default.fetch(`${ORIGIN}/`)
		expect(res.status).toBe(200)
		expect(await res.json()).toEqual({ service: 'cdn', status: 'ok' })
	})

	test('GET /config/LoadingScreenTipData returns the tip array', async () => {
		const res = await exports.default.fetch(`${ORIGIN}/config/LoadingScreenTipData`)
		expect(res.status).toBe(200)
		const body = (await res.json()) as Array<{ Title: string }>
		expect(Array.isArray(body)).toBe(true)
		expect(body.length).toBeGreaterThan(0)
		expect(body[0]).toHaveProperty('Title')
	})

	// The config directory is served by filename through the ASSETS binding, so a file
	// dropped into `static/config/` is reachable without touching the worker.
	test.each(['RRPlusConfig_v3', 'SkuConfig_v1'])(
		'GET /config/%s serves the file from static/config',
		async (name) => {
			const res = await exports.default.fetch(`${ORIGIN}/config/${name}`)
			expect(res.status).toBe(200)
			expect(res.headers.get('content-type')).toContain('application/json')
			expect((await res.text()).length).toBeGreaterThan(0)
		}
	)

	// Not everything in the directory is JSON: a config may be an opaque blob named by
	// GUID, which is served as-is under its own name.
	test('GET /config/:name serves an extension-less binary config', async () => {
		const res = await exports.default.fetch(`${ORIGIN}/config/1b057e6e-979d-4f30-8856-a386f77c90da`)
		expect(res.status).toBe(200)
		expect((await res.arrayBuffer()).byteLength).toBeGreaterThan(0)
	})

	// The game configs name these files WITH the extension (`Econ.MakerAI.DayPass.Config`
	// is `"SkuConfig_v1.json"`), so both spellings have to land on the same file.
	test('GET /config/:name accepts the .json suffix', async () => {
		const bare = await exports.default.fetch(`${ORIGIN}/config/SkuConfig_v1`)
		const suffixed = await exports.default.fetch(`${ORIGIN}/config/SkuConfig_v1.json`)
		expect(suffixed.status).toBe(200)
		expect(await suffixed.text()).toBe(await bare.text())
	})

	// Byte-for-byte: RRPlusConfig_v3.json opens with a UTF-8 BOM, as the real CDN served
	// it. Re-serializing the file (or parsing and re-emitting it) would strip those bytes.
	test('GET /config/RRPlusConfig_v3 keeps the file’s bytes, BOM included', async () => {
		const res = await exports.default.fetch(`${ORIGIN}/config/RRPlusConfig_v3`)
		const bytes = new Uint8Array(await res.arrayBuffer())
		expect(Array.from(bytes.slice(0, 3))).toEqual([0xef, 0xbb, 0xbf])
		// `text()` decodes the BOM away, so the remainder still parses as the config.
		expect(JSON.parse(new TextDecoder().decode(bytes))).toHaveProperty('BenefitLists')
	})

	test('GET /config/:name 404s a config that is not published', async () => {
		const res = await exports.default.fetch(`${ORIGIN}/config/NoSuchConfig`)
		expect(res.status).toBe(404)
	})

	// The name reaches the binding as a filename, so anything that could climb out of
	// `static/config/` is refused before it gets there. (A bare `..` never arrives: the
	// URL is normalized to `/` before routing, which is the liveness probe.)
	test.each(['%2e%2e%2floading-screen-tip-data.json', 'sub%2Fdir', '.hidden', 'Sku.Config'])(
		'GET /config/%s 404s rather than reaching the asset server',
		async (name) => {
			const res = await exports.default.fetch(`${ORIGIN}/config/${name}`)
			expect(res.status).toBe(404)
		}
	)

	// `run_worker_first` keeps the asset server from answering ahead of the Worker: the
	// tip data is an asset too (`static/loading-screen-tip-data.json`), and it must stay
	// unreachable at that path — its route is `/config/LoadingScreenTipData`.
	test('assets are not served at their own paths', async () => {
		const res = await exports.default.fetch(`${ORIGIN}/loading-screen-tip-data.json`)
		expect(res.status).toBe(404)
	})

	test('GET /config/LoadingScreenTipData still wins over the wildcard', async () => {
		const res = await exports.default.fetch(`${ORIGIN}/config/LoadingScreenTipData`)
		expect(res.status).toBe(200)
		expect(Array.isArray(await res.json())).toBe(true)
	})

	test('GET /sigs/:sigName 404s when the blob is absent', async () => {
		const res = await exports.default.fetch(`${ORIGIN}/sigs/does-not-exist`)
		expect(res.status).toBe(404)
	})

	test('GET /sigs/:sigName streams the blob from R2 as octet-stream', async () => {
		await env.CDN_ASSETS.put('sigs/682c1283', new Uint8Array([1, 2, 3, 4]))
		const res = await exports.default.fetch(`${ORIGIN}/sigs/682c1283`)
		expect(res.status).toBe(200)
		expect(res.headers.get('content-type')).toBe('application/octet-stream')
		expect(new Uint8Array(await res.arrayBuffer())).toEqual(new Uint8Array([1, 2, 3, 4]))
	})

	// Every file this worker hands back carries the same 30-day Cache-Control — the R2
	// blobs, the configs served through the ASSETS binding, and the bundled tip data.
	test('every served file carries the 30-day Cache-Control', async () => {
		const CACHE_CONTROL = `public, max-age=${86400 * 30}`
		await env.CDN_ASSETS.put('room/2026-02-03/cached', new Uint8Array([1, 2, 3]))

		for (const path of [
			'/room/2026-02-03/cached',
			'/config/RRPlusConfig_v3.json',
			'/config/LoadingScreenTipData',
		]) {
			const res = await exports.default.fetch(`${ORIGIN}${path}`)
			expect(res.status, path).toBe(200)
			expect(res.headers.get('cache-control'), path).toBe(CACHE_CONTROL)
		}

		// A ranged read is still a served file, and a 304 has to carry it too — otherwise a
		// revalidation would answer "no change" with no instruction on how long that holds.
		const ranged = await exports.default.fetch(`${ORIGIN}/room/2026-02-03/cached`, {
			headers: { Range: 'bytes=0-1' },
		})
		expect(ranged.status).toBe(206)
		expect(ranged.headers.get('cache-control')).toBe(CACHE_CONTROL)

		const etag = (await exports.default.fetch(`${ORIGIN}/room/2026-02-03/cached`)).headers.get(
			'etag'
		)
		const revalidated = await exports.default.fetch(`${ORIGIN}/room/2026-02-03/cached`, {
			headers: { 'If-None-Match': etag ?? '' },
		})
		expect(revalidated.status).toBe(304)
		expect(revalidated.headers.get('cache-control')).toBe(CACHE_CONTROL)
	})

	test('GET /sigs/:sigName honors a Range request with 206', async () => {
		await env.CDN_ASSETS.put('sigs/ranged', new Uint8Array([10, 11, 12, 13, 14, 15]))
		const res = await exports.default.fetch(`${ORIGIN}/sigs/ranged`, {
			headers: { Range: 'bytes=2-4' },
		})
		expect(res.status).toBe(206)
		expect(res.headers.get('content-range')).toBe('bytes 2-4/6')
		expect(res.headers.get('accept-ranges')).toBe('bytes')
		expect(new Uint8Array(await res.arrayBuffer())).toEqual(new Uint8Array([12, 13, 14]))
	})

	// The other two Range forms. Both resolve to a concrete offset/length inside R2, so
	// they exercise the same Content-Range math as the closed range above — which read
	// every range as a suffix range and emitted `bytes NaN-NaN/6` until it was fixed.
	test('GET /sigs/:sigName honors open-ended and suffix Range requests', async () => {
		await env.CDN_ASSETS.put('sigs/ranged2', new Uint8Array([10, 11, 12, 13, 14, 15]))
		const fetchRange = (range: string) =>
			exports.default.fetch(`${ORIGIN}/sigs/ranged2`, { headers: { Range: range } })

		// `bytes=4-` — from an offset to the end.
		const open = await fetchRange('bytes=4-')
		expect(open.status).toBe(206)
		expect(open.headers.get('content-range')).toBe('bytes 4-5/6')
		expect(new Uint8Array(await open.arrayBuffer())).toEqual(new Uint8Array([14, 15]))

		// `bytes=-2` — the last N bytes.
		const suffix = await fetchRange('bytes=-2')
		expect(suffix.status).toBe(206)
		expect(suffix.headers.get('content-range')).toBe('bytes 4-5/6')
		expect(new Uint8Array(await suffix.arrayBuffer())).toEqual(new Uint8Array([14, 15]))
	})

	// The corrupting answer to a byte-range request is a bare 200 carrying the whole
	// object: the downloader asked for a slice, so it writes the body at that offset and
	// the reassembled file is wrong (EAC "Signatures don't match"). R2 resolves a value
	// it cannot parse or satisfy to the WHOLE object rather than failing, so these are
	// exactly the inputs that used to fall through to a 200 — every one of them must
	// still come back 206 with a Content-Range stating what the body actually holds.
	test('GET /sigs/:sigName never answers a bytes range with a whole-object 200', async () => {
		await env.CDN_ASSETS.put('sigs/ranged3', new Uint8Array([10, 11, 12, 13, 14, 15]))
		const fetchRange = (range: string) =>
			exports.default.fetch(`${ORIGIN}/sigs/ranged3`, { headers: { Range: range } })

		for (const range of [
			'bytes=100-200', // wholly past the end of a 6-byte object
			'bytes=abc', // not the byte-range grammar
			'bytes=0-1,3-4', // multi-range, which R2 does not serve
			'bytes=0-5', // satisfiable, and covers everything
		]) {
			const res = await fetchRange(range)
			expect(res.status, range).toBe(206)
			expect(res.headers.get('content-range'), range).toBe('bytes 0-5/6')
		}

		// A range that runs off the end but starts inside is a real partial read.
		const partial = await fetchRange('bytes=4-99')
		expect(partial.status).toBe(206)
		expect(partial.headers.get('content-range')).toBe('bytes 4-5/6')
		expect(new Uint8Array(await partial.arrayBuffer())).toEqual(new Uint8Array([14, 15]))

		// A unit other than bytes must be ignored outright — RFC 9110 — not answered
		// with a byte-denominated Content-Range.
		const other = await fetchRange('items=0-1')
		expect(other.status).toBe(200)
		expect(other.headers.get('content-range')).toBeNull()
		expect(new Uint8Array(await other.arrayBuffer())).toEqual(
			new Uint8Array([10, 11, 12, 13, 14, 15])
		)
	})

	test('GET /room/:dataBlob streams the room blob from R2', async () => {
		await env.CDN_ASSETS.put('room/94tp5zjtwz0gppp8xlv1j9l5b.room', new Uint8Array([9, 8, 7]))
		const res = await exports.default.fetch(`${ORIGIN}/room/94tp5zjtwz0gppp8xlv1j9l5b.room`)
		expect(res.status).toBe(200)
		expect(res.headers.get('content-type')).toBe('application/octet-stream')
		expect(new Uint8Array(await res.arrayBuffer())).toEqual(new Uint8Array([9, 8, 7]))
	})

	test('GET /room/:dataBlob 404s when the blob is absent', async () => {
		const res = await exports.default.fetch(`${ORIGIN}/room/missing.room`)
		expect(res.status).toBe(404)
	})

	// The website lets a room's owner download their own scene data (the room page in
	// `www`), which is a browser reading these bytes from another origin. Without the
	// header it can fetch them but not read the result — and the page can't tell that
	// apart from the blob being gone.
	test('answers CORS so a browser on another origin can read a blob', async () => {
		await env.CDN_ASSETS.put('room/2026-08-01/cors-check', new Uint8Array([4, 2]))
		const res = await exports.default.fetch(`${ORIGIN}/room/2026-08-01/cors-check`, {
			headers: { origin: 'https://www.example.net' },
		})
		expect(res.status).toBe(200)
		expect(res.headers.get('access-control-allow-origin')).toBe('*')
		expect(new Uint8Array(await res.arrayBuffer())).toEqual(new Uint8Array([4, 2]))
	})

	test('GET /invention/:dataBlob streams the invention blob from R2', async () => {
		// Date-foldered, `.inv`-suffixed — the name the storage worker generates and the
		// api worker hands back as the invention's BlobName.
		const name = '2026-07-12/6f1c0c3e-1b6a-4a52-9f52-0f4a1a6d2f77.inv'
		await env.CDN_ASSETS.put(`invention/${name}`, new Uint8Array([1, 2, 3]))
		const res = await exports.default.fetch(`${ORIGIN}/invention/${name}`)
		expect(res.status).toBe(200)
		expect(new Uint8Array(await res.arrayBuffer())).toEqual(new Uint8Array([1, 2, 3]))
	})

	test('GET /invention/:dataBlob 404s when the blob is absent', async () => {
		const res = await exports.default.fetch(`${ORIGIN}/invention/missing.inv`)
		expect(res.status).toBe(404)
	})

	test('GET /data/:id streams the data blob from R2', async () => {
		// Date-foldered — the name the storage worker generates for a FileType 2 upload.
		const name = '2026-08-05/3b9c1f0a-5d2e-4c1b-9a77-2e6f0b4d8c31'
		await env.CDN_ASSETS.put(`data/${name}`, new Uint8Array([4, 5, 6]))
		const res = await exports.default.fetch(`${ORIGIN}/data/${name}`)
		expect(res.status).toBe(200)
		expect(res.headers.get('content-type')).toBe('application/octet-stream')
		expect(new Uint8Array(await res.arrayBuffer())).toEqual(new Uint8Array([4, 5, 6]))
	})

	test('GET /data/:id 404s when the blob is absent', async () => {
		const res = await exports.default.fetch(`${ORIGIN}/data/missing`)
		expect(res.status).toBe(404)
	})

	test('GET /openapi.json documents every route', async () => {
		const res = await exports.default.fetch(`${ORIGIN}/openapi.json`)
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
		expect([...documented].sort()).toEqual([
			'GET /',
			'GET /config/LoadingScreenTipData',
			'GET /config/{name}',
			'GET /data/{id}',
			'GET /invention/{dataBlob}',
			'GET /room/{dataBlob}',
			'GET /sigs/{sigName}',
		])

		// Every operation carries a summary — a path present but undescribed is not
		// documentation.
		for (const ops of Object.values(spec.paths)) {
			for (const op of Object.values(ops)) expect(op.summary).toBeTruthy()
		}

		// Schemas must inline: a `$ref` here is a dangling reference (see openapi.ts).
		expect(JSON.stringify(spec).includes('"$ref"')).toBe(false)
	})
})
