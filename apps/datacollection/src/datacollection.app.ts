import { Hono } from 'hono'
import { useWorkersLogger } from 'workers-tagged-logger'

import { withNotFound, withOnError } from '@repo/hono-helpers'

import type { App } from './context'

/**
 * DataCollection Worker. The client's telemetry sink: it batches gameplay/analytics events
 * and posts them here, and asks on startup how heavily to sample them. Nothing here stores
 * or forwards anything — there is no analytics backend behind this server — so both routes
 * are acknowledgements.
 *
 * Neither is auth-gated. Telemetry is fire-and-forget from the client's side and it posts
 * before a session is fully established, so a 401 buys nothing and costs a retry loop.
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

	.get('/', async (c) => {
		return c.text('hello, world!')
	})

	// Event drop-off, singular. The client posts one event here and only checks that the
	// call succeeded — the response body is never read — so an empty object is a complete
	// answer. Events are discarded; nothing collects them.
	.post('/data/event', async (c) => {
		return c.json({})
	})

	// The same drop-off for a BATCH of events. Separate route rather than an alias: the
	// client sends an array here and the answer is an array, mirroring the request one
	// per-event result at a time. Empty says "nothing to report back about any of them".
	// Don't collapse the two — a `{}` on this path is not the shape the client's decoder
	// expects for a batch.
	.post('/data/events', async (c) => {
		return c.json([])
	})

	// Sampling configuration, asked for once per session (`?sessionId=<guid>`). An empty
	// object carries no per-event overrides, which the client reads as "sample everything
	// at the built-in default rates". Since the events are discarded anyway, the rate it
	// picks makes no difference here.
	.get('/sampling', async (c) => {
		return c.json({})
	})

export default app
