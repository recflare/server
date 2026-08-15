import { Hono } from 'hono'
import { describeRoute, openAPIRouteHandler } from 'hono-openapi'
import { useWorkersLogger } from 'workers-tagged-logger'

import { withCleanSpec, withNotFound, withOnError } from '@repo/hono-helpers'

import { DiscoverySections, json, PAGE_SOURCE_PARAM, ServiceStatus } from './openapi'
import { fetchPageSource } from './page-sources'

import type { App } from './context'

/**
 * Discovery Worker. Serves the layout of the client's discovery pages — which carousels a
 * page shows and in what order — out of `static/`, one file per page source, through the
 * ASSETS binding (see `page-sources.ts`). It does not serve the carousels' CONTENTS: each
 * section names a client-side feed the client resolves against the `rooms`/`api` workers
 * itself.
 *
 * Unauthenticated: every client gets the same layout, and the client fetches this before
 * anything player-specific.
 */
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

	// Root health check.
	.get(
		'/',
		describeRoute({
			tags: ['Service'],
			summary: 'Health check',
			description: 'Liveness probe for the discovery worker. No auth.',
			responses: { 200: json(ServiceStatus, 'Service is up') },
		}),
		(c) => c.json({ service: 'discovery', status: 'ok' })
	)

	// One discovery page's section layout, served verbatim from `static/<type>.json`.
	.get(
		'/sections/pagesource/:type',
		describeRoute({
			tags: ['Discovery'],
			summary: 'Section layout for a page source',
			description: [
				'The sections of one discovery page, in the order the client draws them. `{type}` IS',
				'the filename — the body is `static/<type>.json` served verbatim — so the page sources',
				'that exist are whichever files are published (`WatchHome`, `PlayHighlight`,',
				'`CommunityBoard`, `PlayMenuTabs`, `PlayCategories`, `StoreFeatured`, `StoreClothing`,',
				'`StoreConsumables` and `bulk` at the time of writing). The match is exact, case',
				'included.',
				'',
				'This replaces the `Discovery.DiscoveryPageContent.*` game configs, which carried the',
				'same layouts as embedded JSON strings: with `Discovery.UseNewDiscoveryServerAPI` set',
				'to `True` the client asks this service instead. The two are not the same shape — the',
				'configs wrapped the list in `{ pageSource, sections }` with PascalCase fields, while',
				'this answers the bare ARRAY with camelCase ones.',
				'',
				'A section only NAMES a feed (`source`/`sourceMetadata`); its rooms, items and accounts',
				'are fetched separately by the client. Nothing here is player-specific, so there is no',
				'auth and every client gets the same layout.',
			].join('\n'),
			parameters: [PAGE_SOURCE_PARAM],
			responses: {
				200: json(DiscoverySections, 'The page’s sections'),
				304: { description: '`If-None-Match` matched the file’s etag (no body)' },
				404: { description: 'No file is published under that name' },
			},
		}),
		async (c) => {
			const res = await fetchPageSource(c, c.req.param('type'))
			return res ?? c.notFound()
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
					title: 'recflare discovery',
					version: '1.0.0',
					description: [
						'Discovery page layouts for recflare, a private-server reimplementation of the Rec',
						'Room backend. The client asks this service which sections each of its discovery',
						'pages shows — Watch home, the play menu and its tabs, the community board, the store',
						'pages — and draws them in the order given.',
						'',
						'Each layout is a file in `static/`, published as a Workers static asset and served',
						'verbatim by filename, so the set of page sources is whatever is published rather',
						'than anything the code enumerates. Nothing is editable at runtime and every client',
						'gets the same answer, so the routes are unauthenticated.',
						'',
						'A section names a feed rather than carrying its contents: the client resolves the',
						'rooms, items and accounts behind each carousel against the `rooms` and `api` workers',
						'itself.',
					].join('\n'),
				},
				servers: [{ url: 'https://discovery.recflare.net', description: 'Production' }],
			},
		})
	)
)

export default app
