import { Hono } from 'hono'
import { useWorkersLogger } from 'workers-tagged-logger'

import { withNotFound, withOnError } from '@repo/hono-helpers'
import { validateAndGetAccountId } from '@repo/jwt'

import { createLink } from './link-db'

import type { App } from './context'

/**
 * The longest a link may live, in hours: ten years. The client asks for at most a year
 * (8760, a room link); this only stops a hand-written request from minting a date that
 * doesn't exist.
 */
const MAX_VALID_HOURS = 87_600

/** A form field as a whole integer, or null when it's absent or anything else. */
function intField(value: unknown): number | null {
	if (typeof value !== 'string' || !/^-?\d+$/.test(value.trim())) return null
	const n = Number(value.trim())
	return Number.isSafeInteger(n) ? n : null
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

	.get('/', async (c) => {
		return c.text('hello, world!')
	})

	// Mint a share code for a room, club or event — the client's "share" link. A form body:
	//   data         '{"ExtraJson":"{\"RoomId\":1162}","Platform":0,"Type":5}', stored verbatim
	//   validHours   how long the code lives (8760 room · 2160 club · 8640 event seen)
	//   codeType     the link's kind (5 room · 3 club · 4 event seen)
	//   extraDataId  the id of the thing linked to
	// Answers the full share URL as a JSON string (`"https://rec.example.com?a=ABC123"`). Auth-gated: the
	// row records who made it.
	.post('/actionlink', async (c) => {
		const accountId = await validateAndGetAccountId(c.req.raw, await c.env.JWT_SECRET.get())
		if (accountId === null) return c.body(null, 401)

		const body = await c.req.parseBody().catch(() => ({}) as Record<string, unknown>)
		const codeType = intField(body.codeType)
		const validHours = intField(body.validHours)
		if (codeType === null) return c.json({ error: 'codeType is required' }, 400)
		if (validHours === null || validHours <= 0 || validHours > MAX_VALID_HOURS) {
			return c.json({ error: 'validHours must be a positive number of hours' }, 400)
		}

		const code = await createLink(c.env.DB, {
			creatorAccountId: accountId,
			codeType,
			extraDataId: intField(body.extraDataId),
			data: typeof body.data === 'string' ? body.data : null,
			validHours,
		})
		return c.json(`https://${c.env.DOMAIN}?a=${code}`)
	})

export default app
