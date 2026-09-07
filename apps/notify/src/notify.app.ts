import { Hono } from 'hono'
import { useWorkersLogger } from 'workers-tagged-logger'

import { logger, withDefaultCors, withNotFound, withOnError } from '@repo/hono-helpers'
import { validateAndGetAccountId, validateAndGetRoles } from '@repo/jwt'

import { NotificationsHub, OWNER_HEADER } from './notifications-hub'

import type { Context, MiddlewareHandler } from 'hono'
import type { App } from './context'

/**
 * Maps a SignalR hub at `/hub/v1`. The hub itself — WebSocket transport, the
 * SignalR JSON Hub Protocol, and the shared connection state —
 * lives in the `NotificationsHub` Durable Object; this worker handles the
 * SignalR negotiate handshake, forwards the WebSocket upgrade to the DO, and
 * exposes internal send/broadcast endpoints for other workers.
 */

/** The hub state is global → one DO instance. */
const HUB_INSTANCE = 'global'

/**
 * A valid notification `Id` — a client-defined string tag (e.g. "AccountUpdate")
 * or a numeric code. An empty string is treated as missing.
 */
function isNotificationType(value: unknown): value is string | number {
	return (typeof value === 'string' && value !== '') || typeof value === 'number'
}

/**
 * Roles allowed to call the internal send/broadcast endpoints. These are the
 * operator-granted elevated roles (see the auth worker's `role` claim, set from an
 * account's isDeveloper/isModerator flags via the admin CLI) — so a staffer grants
 * themselves the role and can then push notifications through the shared hub, e.g.
 * from the accounts web UI's maintenance control.
 */
const ADMIN_ROLES = new Set(['developer', 'moderator'])

/**
 * The player opening a hub WebSocket, or null when the connect carries no valid token.
 *
 * A WebSocket connect can't always carry an `Authorization` header — SignalR clients
 * that can't set headers on the upgrade put the token in an `access_token` query
 * param instead — so both are accepted, header first.
 */
async function connectionOwner(c: Context<App>): Promise<number | null> {
	const secret = await c.env.JWT_SECRET.get()
	const id = await validateAndGetAccountId(c.req.raw, secret)
	if (id !== null) return id

	const token = c.req.query('access_token')
	if (!token) return null
	return validateAndGetAccountId(
		new Request(c.req.url, { headers: { Authorization: `Bearer ${token}` } }),
		secret
	)
}

/**
 * Gates the `/internal/*` endpoints on a valid Bearer token that carries one of the
 * {@link ADMIN_ROLES} in its `role` claim. 401 for a missing/invalid token, 403 for a
 * valid token that lacks an admin role.
 */
const requireAdmin: MiddlewareHandler<App> = async (c, next) => {
	const roles = await validateAndGetRoles(c.req.raw, await c.env.JWT_SECRET.get())
	if (roles === null) return c.json({ error: 'Unauthorized' }, 401)
	if (!roles.some((role) => ADMIN_ROLES.has(role))) return c.json({ error: 'Forbidden' }, 403)
	await next()
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

	// The website (`www`) is a browser origin calling these endpoints directly, the way
	// rec.net's own site called the game's API — so the responses need CORS headers or
	// the browser discards them. `origin: '*'` is deliberate and safe HERE because these
	// endpoints authenticate with a bearer token in the `Authorization` header, never a
	// cookie: a hostile page can't read another origin's stored token, so there is no
	// ambient credential for `*` to expose. Do not add cookie auth without narrowing it.
	.use('*', withDefaultCors())

	.onError(withOnError())
	.notFound(withNotFound())

	// SignalR negotiation. Clients POST here first; we hand back an id that is
	// then passed as `?id=` on the WebSocket connect. We don't pre-register it —
	// the DO adopts whatever id arrives — so negotiate stays stateless.
	.post('/hub/v1/negotiate', (c) => {
		const negotiateVersion = Number(c.req.query('negotiateVersion')) || 0
		const id = crypto.randomUUID()
		logger.info('signalr negotiate', { negotiateVersion })
		return c.json({
			negotiateVersion,
			connectionId: id,
			connectionToken: id,
			availableTransports: [{ transport: 'WebSockets', transferFormats: ['Text'] }],
		})
	})

	// The hub WebSocket. Upgrade requests are forwarded to the Durable Object, tagged
	// with the connecting player so the hub can route their own notifications to them.
	.get('/hub/v1', async (c) => {
		if ((c.req.header('upgrade') ?? '').toLowerCase() !== 'websocket') {
			return c.json({ error: 'Expected a WebSocket upgrade request' }, 426)
		}

		const playerId = await connectionOwner(c)
		// Every notification the hub sends is either for a specific player or a
		// broadcast to logged-in clients, so a connection we can't identify has nothing
		// to receive. Refusing it here keeps unidentified sockets out of the hub
		// entirely rather than letting them sit there collecting broadcasts.
		if (playerId === null) return c.json({ error: 'Unauthorized' }, 401)

		const request = new Request(c.req.raw)
		// Always set from the validated token, never passed through: the header is the
		// DO's proof of identity, so a client sending its own must not be believed.
		request.headers.set(OWNER_HEADER, String(playerId))

		return c.env.RECFLARE_NOTIFICATIONS_HUB.getByName(HUB_INSTANCE).fetch(request)
	})

	// ---- Internal service-to-service send/broadcast --------------------------
	// Lets other workers push notifications through the shared hub. Gated to admin
	// accounts (see requireAdmin) as a temporary lockdown.
	.use('/internal/*', requireAdmin)

	.post('/internal/notify', async (c) => {
		const body = await c.req
			.json<{
				playerId?: number
				notificationType?: string | number
				data?: Record<string, unknown>
			}>()
			.catch(() => null)
		if (!body || typeof body.playerId !== 'number' || !isNotificationType(body.notificationType)) {
			return c.json({ error: 'playerId and notificationType are required' }, 400)
		}
		const result = await c.env.RECFLARE_NOTIFICATIONS_HUB.getByName(HUB_INSTANCE).notifyPlayer(
			body.playerId,
			body.notificationType,
			body.data
		)
		return c.json({ success: true, ...result })
	})

	.post('/internal/broadcast', async (c) => {
		const body = await c.req
			.json<{ notificationType?: string | number; data?: Record<string, unknown> }>()
			.catch(() => null)
		if (!body || !isNotificationType(body.notificationType)) {
			return c.json({ error: 'notificationType is required' }, 400)
		}
		const result = await c.env.RECFLARE_NOTIFICATIONS_HUB.getByName(HUB_INSTANCE).broadcast(
			body.notificationType,
			body.data
		)
		return c.json({ success: true, ...result })
	})

	// Send a coach/system direct message to every currently-online player.
	.post('/internal/coach-message-all', async (c) => {
		const body = await c.req.json<{ messageContent?: string }>().catch(() => null)
		const content = typeof body?.messageContent === 'string' ? body.messageContent.trim() : ''
		if (content === '') return c.json({ error: 'messageContent is required' }, 400)
		const result =
			await c.env.RECFLARE_NOTIFICATIONS_HUB.getByName(HUB_INSTANCE).coachMessageAll(content)
		return c.json({ success: true, ...result })
	})

	// The targeted form of the broadcast above: one coach message to ONE player. Queued
	// by the hub when they're offline (unlike coach-message-all, which reaches only
	// whoever is connected), so this arrives either way.
	.post('/internal/coach-message', async (c) => {
		const body = await c.req
			.json<{ playerId?: number; messageContent?: string }>()
			.catch(() => null)
		const content = typeof body?.messageContent === 'string' ? body.messageContent.trim() : ''
		if (typeof body?.playerId !== 'number' || !Number.isInteger(body.playerId)) {
			return c.json({ error: 'playerId is required' }, 400)
		}
		if (content === '') return c.json({ error: 'messageContent is required' }, 400)
		const result = await c.env.RECFLARE_NOTIFICATIONS_HUB.getByName(HUB_INSTANCE).coachMessage(
			body.playerId,
			content
		)
		return c.json({ success: true, ...result })
	})

	// Read-only view of the hub's routing state, for working out why a notification
	// didn't arrive: which connections are live, which players each one receives for,
	// and what's queued for a player who wasn't reachable.
	.get('/internal/hub-state', async (c) => {
		return c.json(await c.env.RECFLARE_NOTIFICATIONS_HUB.getByName(HUB_INSTANCE).inspect())
	})

	// Discard queued notifications, for `?playerId=` or — with the explicit `?all=true`,
	// so a bare call can't do it by accident — the whole queue. Anything left pending is
	// delivered on the player's next subscribe, so stale frames need a way out.
	.delete('/internal/hub-state/pending', async (c) => {
		const raw = c.req.query('playerId')
		const playerId = raw === undefined ? undefined : Number.parseInt(raw, 10)
		if (playerId !== undefined && !Number.isInteger(playerId)) {
			return c.json({ error: 'playerId must be an integer' }, 400)
		}
		if (playerId === undefined && c.req.query('all') !== 'true') {
			return c.json({ error: 'pass playerId, or all=true to clear every queue' }, 400)
		}

		const result =
			await c.env.RECFLARE_NOTIFICATIONS_HUB.getByName(HUB_INSTANCE).clearPending(playerId)
		logger.info('cleared pending notifications', { playerId: playerId ?? null, ...result })
		return c.json({ success: true, ...result })
	})

export { NotificationsHub }
export default app
