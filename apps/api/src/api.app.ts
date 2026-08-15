import { Hono } from 'hono'
import { describeRoute, openAPIRouteHandler } from 'hono-openapi'
import { useWorkersLogger } from 'workers-tagged-logger'

import { withCleanSpec, withDefaultCors, withNotFound, withOnError } from '@repo/hono-helpers'

import { accountRoutes } from './routes/account'
import { avatarRoutes } from './routes/avatar'
import { configRoutes } from './routes/config'
import { eventRoutes } from './routes/events'
import { gameplayRoutes } from './routes/gameplay'
import { imageRoutes } from './routes/images'
import { inventoryRoutes } from './routes/inventory'
import { moderationRoutes } from './routes/moderation'
import { progressionRoutes } from './routes/progression'
import { roomRoutes } from './routes/rooms'
import { socialRoutes } from './routes/social'

import type { App } from './context'

/**
 * The Game API surface. Endpoints that would be backed by a database or on-disk
 * JSON files are stubbed here — no bindings yet.
 * Auth-gated routes still validate the Bearer JWT issued by the `auth` worker.
 *
 * Placeholder responses for file-backed endpoints are marked `TODO: hydrate`.
 *
 * Routes are grouped into per-domain controllers under `./routes` and mounted
 * at `/` below. Shared request helpers live in `./http`.
 */

// strict: false so trailing-slash routes (e.g. `/gifts/consume/`) match either form.
const app = new Hono<App>({ strict: false })
	.use(
		'*',
		// middleware
		(c, next) =>
			useWorkersLogger(c.env.NAME, {
				environment: c.env.ENVIRONMENT,
				release: c.env.SENTRY_RELEASE,
			})(c, next)
	)

	// The website (`www`) is a browser origin calling these endpoints directly, the way
	// rec.net's own site called the game's API — so the responses need CORS headers or
	// the browser discards them. `origin: '*'` is deliberate and safe HERE because these
	// endpoints authenticate with a bearer token in the `Authorization` header, never a
	// cookie: a hostile page can't read another origin's stored token, so there is no
	// ambient credential for `*` to expose. Do not add cookie auth without narrowing it.
	.use('*', withDefaultCors())

	.onError(withOnError())
	.notFound(withNotFound())

	// ---- Controllers ----------------------------------------------------------
	.route('/', configRoutes)
	.route('/', socialRoutes)
	.route('/', progressionRoutes)
	.route('/', avatarRoutes)
	.route('/', gameplayRoutes)
	.route('/', eventRoutes)
	.route('/', moderationRoutes)
	.route('/', inventoryRoutes)
	.route('/', roomRoutes)
	.route('/', imageRoutes)
	.route('/', accountRoutes)

// The generated spec. Documentation only — no request is validated against it (see
// openapi.ts). `hide: true` keeps this route out of its own output.
app.get(
	'/openapi.json',
	describeRoute({ hide: true }),
	withCleanSpec(
		openAPIRouteHandler(app, {
			documentation: {
				info: {
					title: 'recflare api',
					version: '1.0.0',
					description: [
						'The catch-all Game API for recflare, a private-server reimplementation of the Rec',
						'Room backend: everything the client calls that has not been split out into its own',
						'worker yet. Today that is config, the friend graph, inventions, saved photos,',
						'player events, reputation and the assorted sinks the client hits while loading.',
						'Relationships, inventions, images and player events are D1-backed; several',
						'endpoints are still stubs, noted per route.',
						'',
						'Expect this surface to shrink. Paths that also exist on a dedicated worker (avatar,',
						'equipment, consumables and objectives on `econ`) are already served there — the',
						'client calls that host and the copy here is a stub, which each route says.',
					].join('\n'),
				},
				servers: [{ url: 'https://api.recflare.net', description: 'Production' }],
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
