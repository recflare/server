import { Hono } from 'hono'
import { useWorkersLogger } from 'workers-tagged-logger'

import { withNotFound, withOnError } from '@repo/hono-helpers'

import type { App } from './context'

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

	// Voice-moderation vendor credentials. The client fetches these while setting up voice
	// so it can talk to the moderation vendor DIRECTLY — the audio never passes through this
	// service, which is why the credentials are handed out rather than used server-side.
	//
	// Both are deliberately EMPTY: no vendor account is wired up here, and the client treats
	// blank credentials as "voice moderation is off" instead of failing voice setup. The keys
	// must still be present and strings — a missing key or a null trips the client's parser.
	// Note `AccountId` is a STRING even though it reads as a number.
	.get('/voice/config', (c) => {
		return c.json({ AccountId: '', ApiKey: '' })
	})

export default app
