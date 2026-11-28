import { Hono } from 'hono'
import { useWorkersLogger } from 'workers-tagged-logger'

import { hasRoomieKey } from '@repo/domain'
import { withNotFound, withOnError } from '@repo/hono-helpers'
import { validateAndGetAccountId } from '@repo/jwt'

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
	// Whether Roomie's AI may run for the caller (`RecNet.Moderation`, a `Task<bool>` read as a
	// bare JSON boolean). The 2026 client asks right after its realtime session opens and
	// treats anything but an answer — a 404 included — as "RoomieAI is currently
	// unavailable". Enabled exactly when the caller has their own OpenAI key on file: that
	// key is what the session runs on (see the `ai` worker's realtime-session/create).
	.get('/aimoderation/roomie/enabledForPlayer', async (c) => {
		const id = await validateAndGetAccountId(c.req.raw, await c.env.JWT_SECRET.get())
		if (id === null) return c.body(null, 401)
		return c.json(await hasRoomieKey(c.env.DB, id))
	})
	// A finished Roomie conversation, posted (form field `conversation`) for review. Live this
	// fed AI moderation; nothing here reviews conversations, so it is accepted and dropped —
	// never stored or logged, being a transcript of what the player said. The client only
	// checks the status.
	.post('/aimoderation/roomie/conversation', async (c) => {
		const id = await validateAndGetAccountId(c.req.raw, await c.env.JWT_SECRET.get())
		if (id === null) return c.body(null, 401)
		return c.json({})
	})

export default app
