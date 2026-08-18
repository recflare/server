import { Hono } from 'hono'
import { describeRoute, openAPIRouteHandler, resolver } from 'hono-openapi'
import { useWorkersLogger } from 'workers-tagged-logger'

import {
	withCleanSpec,
	withDefaultCors,
	withNotFound,
	withOnError,
	writeContentRange,
} from '@repo/hono-helpers'

import loadingScreenTipData from '../static/loading-screen-tip-data.json'
import {
	assetResponses,
	CONDITIONAL_HEADERS,
	json,
	JsonValue,
	keyParam,
	LoadingScreenTip,
	ServiceStatus,
} from './openapi'

import type { Context } from 'hono'
import type { App, Env } from './context'

/**
 * CDN routes. The `cdn` prefix maps to this worker's subdomain, so method routes
 * are served bare. Everything but the liveness probe and the bundled tip data is
 * streamed out of the shared `recflare-cdn` R2 bucket, keyed by prefix.
 */

/**
 * Stream a binary asset from the CDN R2 bucket as application/octet-stream,
 * honoring Range requests. 404s when the file is missing.
 * Supports conditional GET and byte-range requests (206) — large-file
 * downloaders fetch in ranges, and a 200 where a 206 is expected corrupts the
 * reassembled file (e.g. EAC "Signatures don't match").
 *
 * This is why `cache.enabled` is false in wrangler.jsonc: Workers Caching strips `Range`
 * before the worker is invoked and slices the 206 out of its own cache, which silently
 * degrades to a whole-object 200 whenever the response is not cacheable. The range
 * answer has to be ours to guarantee.
 */
async function serveAsset(c: Context<App>, key: string) {
	if (key.includes('..')) return c.body(null, 400)

	const ifNoneMatch = c.req.header('if-none-match')?.replace(/"/g, '')
	// R2 parses the `Range` header itself when handed the request headers, so there is no
	// grammar to reimplement here. It resolves every form (`bytes=a-b`, `bytes=a-`,
	// `bytes=-n`) to a concrete offset/length, and anything it cannot parse or satisfy to
	// the whole object — see the 206 branch, which is what turns that back into a 200.
	// With no `Range` header present this is an ordinary whole-object read.
	let object
	try {
		object = await (c.env as Env).CDN_ASSETS.get(key, {
			...(ifNoneMatch ? { onlyIf: { etagDoesNotMatch: ifNoneMatch } } : {}),
			range: c.req.raw.headers,
		})
	} catch (e) {
		// Defensive: R2 documents InvalidRange (10039) for a range it can't satisfy, which
		// is a 416 rather than the 500 the error handler would otherwise turn it into.
		// Locally it never fires — workerd resolves an unsatisfiable range to the whole
		// object instead of throwing — so this covers the service behaving as documented.
		if (e instanceof Error && e.message.includes('(10039)')) return c.body(null, 416)
		throw e
	}
	if (!object) return c.notFound()

	const headers = new Headers()
	object.writeHttpMetadata(headers)
	headers.set('etag', object.httpEtag)
	headers.set('content-type', 'application/octet-stream')
	headers.set('accept-ranges', 'bytes')
	headers.set('cache-control', CACHE_CONTROL)

	// Precondition matched (If-None-Match) → R2 returns no body.
	if (!('body' in object)) return new Response(null, { status: 304, headers })

	// A `bytes=` request is ALWAYS answered 206 with a Content-Range naming the bytes
	// actually enclosed — never a bare 200 carrying the whole object. That is the one
	// answer a chunked downloader cannot survive: it asked for a slice, so it writes
	// whatever comes back at that offset, and a whole-object body silently corrupts the
	// reassembled file (EAC "Signatures don't match"). See writeContentRange().
	if (writeContentRange(headers, c.req.raw.headers, object)) {
		return new Response(object.body, { status: 206, headers })
	}

	return new Response(object.body, { headers })
}

/**
 * Cache-Control on every file this worker serves — 30 days (86400 × 30). These are big,
 * rarely-changing blobs fetched by key: a room scene, an invention, a signature blob. The
 * keys are content-addressed or date-foldered UUIDs, so a changed asset arrives under a
 * NEW key rather than replacing one that is already cached.
 *
 * Not `immutable`, unlike `img`: the same rule covers `/config/`, whose files ARE
 * republished under their existing names, and telling a browser never to revalidate those
 * would pin a stale config for the whole window.
 */
const CACHE_CONTROL = `public, max-age=${86400 * 30}`

/**
 * What may reach the ASSETS binding as a config filename: one path segment, no slashes,
 * and `..` rejected outright below. A traversal is then a 404 from this worker rather than
 * a request the asset server has to be trusted to refuse.
 */
const CONFIG_NAME = /^[A-Za-z0-9._-]+$/

/**
 * Serve a file from `static/config/` through the ASSETS binding, by its own filename —
 * whatever is in that directory, not just the JSON (a config may be an opaque binary blob
 * named by GUID). `null` when nothing is published under that name.
 *
 * A name carrying no extension also resolves against `<name>.json`, because the same file
 * is asked for both ways: the game configs that point at these carry the extension
 * (`Econ.MakerAI.DayPass.Config` is `"SkuConfig_v1.json"`) while the client's older config
 * calls leave it off. The exact name is tried first, so an extension-less FILE always wins
 * over the `.json` guess.
 *
 * The asset response is handed back whole rather than parsed and re-serialized: it already
 * carries a content type and an etag (so `If-None-Match` gets its 304 for free), and these
 * files go out BYTE-FOR-BYTE — `RRPlusConfig_v3.json` opens with a UTF-8 BOM, which is what
 * the real CDN served and what the client's parser expects.
 */
async function serveConfig(c: Context<App>, name: string): Promise<Response | null> {
	if (!CONFIG_NAME.test(name) || name.includes('..')) return null

	const candidates = name.includes('.') ? [name] : [name, `${name}.json`]
	for (const candidate of candidates) {
		// Forwarding the original request keeps its conditional headers; only the URL is
		// rewritten to the asset's path.
		const res = await c.env.ASSETS.fetch(
			new Request(new URL(`/config/${candidate}`, c.req.url), c.req.raw)
		)
		// Rebuilt rather than returned as-is, only to stamp our own Cache-Control over the
		// asset server's: everything else — the body, the status, the content type, the etag
		// a conditional GET matched on — is carried across untouched. A 304 has no body to
		// carry, and `Response` refuses one for that status.
		if (res.ok || res.status === 304) {
			const headers = new Headers(res.headers)
			headers.set('cache-control', CACHE_CONTROL)
			return new Response(res.status === 304 ? null : res.body, { status: res.status, headers })
		}
	}
	return null
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

	// The website lets a room's owner download their own scene blobs (see the room page
	// in `www`), which means a browser reading these bytes from another origin — without
	// these headers it can fetch them but not touch the result. `origin: '*'` gives away
	// nothing: every route here is already unauthenticated and public to anyone holding
	// the key, and nothing on this worker reads a cookie or a token, so there is no
	// ambient credential for `*` to expose. The keys are unguessable UUIDs, and that is
	// unchanged by who may read a response they already had to name exactly.
	.use('*', withDefaultCors())

	.onError(withOnError())
	.notFound(withNotFound())

	.get(
		'/',
		describeRoute({
			tags: ['Service'],
			summary: 'Service liveness',
			description: 'A fixed `{ service, status }` body. No auth — a plain liveness probe.',
			responses: { 200: json(ServiceStatus, 'Always `{ service: "cdn", status: "ok" }`') },
		}),
		(c) => c.json({ service: 'cdn', status: 'ok' })
	)

	// Loading-screen tips, bundled here as static JSON.
	.get(
		'/config/LoadingScreenTipData',
		describeRoute({
			tags: ['Config'],
			summary: 'Loading-screen tips',
			description: [
				'The tips the client cycles through on a loading screen. A bundled static file',
				'(`static/loading-screen-tip-data.json`), captured from the real service and served',
				'verbatim — nothing here is editable at runtime, and every client gets the same list',
				'regardless of platform or room. The per-tip `Context`/`Visibility`/`PlatformMask`',
				'fields are the client’s own filters, applied client-side.',
			].join(' '),
			responses: { 200: json(LoadingScreenTip.array(), 'The bundled tips') },
		}),
		(c) => c.json(loadingScreenTipData, 200, { 'Cache-Control': CACHE_CONTROL })
	)

	// Everything else under `/config/`, served from `static/config/` by filename — JSON and
	// opaque blobs alike. Declared AFTER the tip-data route above, which would otherwise be
	// shadowed by this one: its file is named differently from its path, so it stays a
	// route of its own.
	.get(
		'/config/:name',
		describeRoute({
			tags: ['Config'],
			summary: 'Serve a config file',
			description: [
				'Serves a file out of `static/config/` verbatim — `RRPlusConfig_v3.json` (the Rec Room',
				'Plus benefit lists), `SkuConfig_v1.json` (the Maker AI day-pass store copy) and a',
				'GUID-named binary blob today. `{name}` IS the filename, so publishing a config is',
				'dropping a file in that directory; nothing in the worker enumerates them, and not',
				'everything there is JSON.',
				'',
				'A name with no extension also resolves against `<name>.json`, because the same file',
				'is asked for both ways — the game configs that point at these carry the extension',
				'(`Econ.MakerAI.DayPass.Config` is `"SkuConfig_v1.json"`), the client’s older config',
				'calls leave it off. An extension-less file wins over the `.json` guess.',
				'',
				'These are byte-for-byte copies of what the real CDN served, BOM included, and are',
				'not rewritten or re-serialized on the way out.',
			].join(' '),
			parameters: [
				keyParam('name', 'The config’s filename. The `.json` may be left off.', false),
				...CONDITIONAL_HEADERS.filter((h) => h.name === 'If-None-Match'),
			],
			responses: {
				200: {
					description: 'The config file, as stored',
					content: {
						'application/json': { schema: resolver(JsonValue) },
						'application/octet-stream': { schema: { type: 'string', format: 'binary' } },
					},
				},
				304: { description: '`If-None-Match` matched the file’s etag (no body)' },
				404: { description: 'No config is published under that name' },
			},
		}),
		async (c) => (await serveConfig(c, c.req.param('name'))) ?? c.notFound()
	)

	// Signature blobs by name. Streamed from R2 under the `sigs/` key prefix;
	// 404 when missing.
	.get(
		'/sigs/:sigName',
		describeRoute({
			tags: ['Assets'],
			summary: 'Serve a signature blob',
			description: [
				'Streams the object stored under `sigs/<sigName>`. These are the anti-cheat signature',
				'blobs the client fetches at startup; nothing here inspects or validates them.',
			].join(' '),
			parameters: [keyParam('sigName', 'The blob name.', false), ...CONDITIONAL_HEADERS],
			responses: assetResponses('The signature blob'),
		}),
		(c) => serveAsset(c, `sigs/${c.req.param('sigName')}`)
	)

	// Room build data by name. The client fetches this for a SubRoom's DataBlob to
	// load the room. Streamed from R2 under `room/`. The name may contain slashes
	// (uploads are foldered by date, e.g. `2026-02-03/<uuid>`), so match the rest of
	// the path.
	.get(
		'/room/:dataBlob{.+}',
		describeRoute({
			tags: ['Assets'],
			summary: 'Serve room build data',
			description: [
				'Streams the object stored under `room/<dataBlob>` — the saved scene the client',
				'downloads to load a room. The name comes from a subroom’s `DataBlob` (see the `rooms`',
				'worker) and is date-foldered by the upload, e.g. `2026-02-03/<uuid>`, so it contains',
				'slashes.',
				'',
				'A room’s IMAGE also lives under this prefix, stored by its bare `ImageName` — the',
				'same route serves both.',
			].join('\n'),
			parameters: [keyParam('dataBlob', 'The blob name.', true), ...CONDITIONAL_HEADERS],
			responses: assetResponses('The room data'),
		}),
		(c) => serveAsset(c, `room/${c.req.param('dataBlob')}`)
	)

	// Invention data by name. The client fetches this for an invention's
	// `CurrentVersion.BlobName` to spawn it. Streamed from R2 under `invention/`.
	// Like room blobs the name is date-foldered, and it carries the `.inv` extension
	// the upload stored it under, so the rest of the path is matched as-is.
	.get(
		'/invention/:dataBlob{.+}',
		describeRoute({
			tags: ['Assets'],
			summary: 'Serve invention data',
			description: [
				'Streams the object stored under `invention/<dataBlob>` — the data the client',
				'downloads to spawn an invention. The name comes from an invention’s',
				'`CurrentVersion.BlobName` (see the `api` worker); like room blobs it is date-foldered,',
				'and it keeps the `.inv` extension the upload stored it under.',
			].join(' '),
			parameters: [
				keyParam('dataBlob', 'The blob name, including `.inv`.', true),
				...CONDITIONAL_HEADERS,
			],
			responses: assetResponses('The invention data'),
		}),
		(c) => serveAsset(c, `invention/${c.req.param('dataBlob')}`)
	)

	// Generic client data by name. Anything the client uploads as FileType 2 lands
	// under `data/` (a Holotar recording is the one seen in the wild) and the client
	// fetches it back from this prefix. Date-foldered like the room and invention
	// blobs, so the rest of the path is matched as-is.
	.get(
		'/data/:id{.+}',
		describeRoute({
			tags: ['Assets'],
			summary: 'Serve a client data blob',
			description: [
				'Streams the object stored under `data/<id>` — whatever the client uploaded as',
				'`UploadFileType` 2 (see the `storage` worker), a Holotar recording being the case',
				'observed. Like room and invention blobs the name is date-foldered by the upload,',
				'e.g. `2026-02-03/<uuid>`, so it contains slashes. The worker does not interpret the',
				'bytes — the prefix exists because the client expects to read these back from `/data/`.',
			].join(' '),
			parameters: [keyParam('id', 'The blob name.', true), ...CONDITIONAL_HEADERS],
			responses: assetResponses('The data blob'),
		}),
		(c) => serveAsset(c, `data/${c.req.param('id')}`)
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
					title: 'recflare cdn',
					version: '1.0.0',
					description: [
						'Binary asset delivery for recflare, a private-server reimplementation of the Rec',
						'Room backend. Streams the blobs the client downloads while playing — anti-cheat',
						'signatures, saved room scenes, invention data and generic client uploads — out of',
						'the shared `recflare-cdn` R2 bucket, plus the JSON config files the client reads',
						'from `/config/`.',
						'',
						'Everything is keyed by prefix (`sigs/`, `room/`, `invention/`, `data/`) and served as',
						'`application/octet-stream`; the worker never interprets what it hands back. Reads',
						'are unauthenticated — a caller needs the exact key, which only comes from an',
						'authenticated call to another worker.',
						'',
						'This worker only READS. Uploads go through the `storage` worker, which writes the',
						'same bucket, and images are served by `img` rather than from here.',
						'',
						'Every asset route supports conditional GETs (`If-None-Match` → 304) and single',
						'byte ranges (`Range` → 206). The ranges matter: large-file downloaders fetch in',
						'chunks, and answering 200 where a 206 is expected corrupts the reassembled file —',
						'which surfaces as an anti-cheat “Signatures don’t match” failure, not a download',
						'error. So a `bytes=` request is never answered with a whole-object 200: the 206',
						'always carries a `Content-Range` stating which bytes the body holds, even where',
						'that turns out to be all of them.',
					].join('\n'),
				},
				servers: [{ url: 'https://cdn.recflare.net', description: 'Production' }],
			},
		})
	)
)

export default app
