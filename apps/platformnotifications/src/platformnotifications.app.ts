import { Hono } from 'hono'
import { useWorkersLogger } from 'workers-tagged-logger'

import { withNotFound, withOnError } from '@repo/hono-helpers'
import { validateAndGetAccountId } from '@repo/jwt'

import type { Context } from 'hono'
import type { App } from './context'

/**
 * Resolve the account id from a Bearer token. Returns `null` when the header is missing,
 * the token is invalid, or the `sub` claim isn't an integer.
 */
async function authedId(c: Context<App>): Promise<number | null> {
	return validateAndGetAccountId(c.req.raw, await c.env.JWT_SECRET.get())
}

/** Results.Unauthorized() equivalent — 401 with empty body. */
function unauthorized(c: Context<App>) {
	return c.body(null, 401)
}

/**
 * The notification categories `GET /config/categories` serves — a STUB standing in for the
 * real list until something here actually defines categories and stores preferences against
 * them.
 *
 * `CategoryId` is the client's own id for the category, `Importance` its ranking (0 being
 * the lowest observed), and `IsMuteable` whether the player may switch it off at all. The
 * stub marker lives in `Description` because that is what the client displays; keep it
 * there — a category that silently does nothing is worse than one that says it does nothing.
 */
const NOTIFICATION_CATEGORIES = [
	{
		CategoryId: 2,
		Importance: 0,
		Name: 'Friends',
		Description: 'Friend requests and friend activity [STUB — recflare sends no notifications yet]',
		IsMuteable: true,
	},
]

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

	// Whether a player receives gameplay invites — the switch the client checks before
	// offering to invite someone. Always true: nothing here stores per-player notification
	// preferences, and true is the answer that leaves inviting working. A bare JSON boolean,
	// not an envelope.
	//
	// `{id}` is the account being asked about and is accepted but not read: the answer is the
	// same for everyone, so there is nothing to look up. The token is still validated first,
	// as the reference does, which means a caller can ask about any id but must be someone.
	.get('/accounts/:id{[0-9]+}/receives/GameplayInvites', async (c) => {
		const accountId = await authedId(c)
		if (accountId === null) return unauthorized(c)

		return c.json(true)
	})

	// The notification categories a player can be shown toggles for — the "what may we notify
	// you about" list. A bare array of PascalCase categories, no envelope. No auth: the list
	// is server-side config, the same for every player, and a caller's own preferences are
	// the per-account routes above.
	//
	// STUB. Nothing here defines categories or stores a preference against one, so this is
	// one hand-written entry standing in for the real list — the toggle it draws does
	// nothing. The `Description` says so IN THE TEXT rather than only in this comment: it is
	// the field the client renders, so the stub is visible in-game instead of looking like
	// a real (and broken) setting. `Name` is left clean in case the client keys off it.
	.get('/config/categories', async (c) => {
		return c.json(NOTIFICATION_CATEGORIES)
	})

	// The caller's own notification preferences — which categories they have muted, by
	// CategoryId (the ids `/config/categories` above hands out).
	//
	// STUB: nothing here stores a preference, so nobody has muted anything and the list is
	// empty. Empty is also the right stub value rather than a made-up id: a muted category
	// the player never muted would show as an off switch they can't explain, and the ids
	// would have to agree with the category list to mean anything at all.
	//
	// Auth-gated — this one IS per-player, unlike the category config above. A `{ }` object
	// rather than a bare array: the shape has room for the other preferences the reference
	// carries here.
	.get('/preferences', async (c) => {
		const accountId = await authedId(c)
		if (accountId === null) return unauthorized(c)

		return c.json({ MutedCategories: [] })
	})

export default app
