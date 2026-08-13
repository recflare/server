import { Hono } from 'hono'
import { useWorkersLogger } from 'workers-tagged-logger'

import { withNotFound, withOnError } from '@repo/hono-helpers'

import { buildEndpoints } from './endpoints'

import type { App } from './context'

/**
 * Name-server / service-discovery worker served at the apex domain.
 * Returns the endpoints document the game client fetches to discover every
 * service host. Hosts are derived from the `DOMAIN` var, which is injected at
 * deploy time (see `run-wrangler-deploy`) and defaults in `wrangler.jsonc` for
 * local dev.
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

	// Endpoints document, derived from the deploy-time base domain.
	.get('/', (c) => c.json(buildEndpoints(c.env.DOMAIN, c.env.SUBDOMAINS)))

export default app
