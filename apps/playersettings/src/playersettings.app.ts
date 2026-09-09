import { Hono } from 'hono'
import { describeRoute, openAPIRouteHandler } from 'hono-openapi'
import { useWorkersLogger } from 'workers-tagged-logger'

import { withCleanSpec, withNotFound, withOnError } from '@repo/hono-helpers'
import { validateAndGetAccountId } from '@repo/jwt'

import { DEFAULT_SETTINGS } from './default-settings'
import {
	AUTHED,
	formOrJson,
	HealthResponse,
	json,
	PlayerSettingEntry,
	SettingFormDelete,
	SettingFormWrite,
	SettingJsonDelete,
	SettingJsonWrite,
	UNAUTHORIZED_RESPONSE,
} from './openapi'

import type { Context } from 'hono'
import type { App } from './context'

/**
 * Player Settings Worker. Serves the small key/value settings bag the game client reads
 * on load and writes back as the player toggles options. Backed by a per-player KV map
 * (`player:{id}`); a player with nothing stored is seeded with the reference defaults on
 * their first read.
 *
 * Every `/playersettings` route is auth-gated on the Bearer JWT issued by the `auth` worker.
 */

/**
 * Resolve the account id from a Bearer token (the route is auth-gated).
 * Returns `null` when the header is missing, the token is invalid, or the `sub`
 * claim isn't an integer.
 */
async function authedId(c: Context<App>): Promise<number | null> {
	return validateAndGetAccountId(c.req.raw, await c.env.JWT_SECRET.get())
}

/** Results.Unauthorized() equivalent — 401 with empty body. */
function unauthorized(c: Context<App>) {
	return c.body(null, 401)
}

/**
 * Pull `{ key, value }` pairs out of a PUT body: a form-urlencoded `key`/`value`,
 * or a JSON body (single object or array). Entries with an empty key are dropped.
 */
async function parseSettings(c: Context<App>): Promise<Array<{ key: string; value: string }>> {
	const contentType = c.req.header('content-type') ?? ''

	if (contentType.includes('application/json')) {
		const body = await c.req.json<unknown>().catch(() => null)
		const list = Array.isArray(body) ? body : body == null ? [] : [body]
		return list
			.map((o) => {
				const rec = o as Record<string, unknown>
				const key = rec.key ?? rec.Key
				const value = rec.value ?? rec.Value
				return {
					key: typeof key === 'string' ? key : '',
					value:
						typeof value === 'string'
							? value
							: typeof value === 'number' || typeof value === 'boolean'
								? String(value)
								: '',
				}
			})
			.filter((s) => s.key !== '')
	}

	// form-urlencoded / multipart
	const form = await c.req.parseBody().catch(() => ({}) as Record<string, unknown>)
	const key = typeof form.key === 'string' ? form.key : ''
	const value = typeof form.value === 'string' ? form.value : ''
	return key ? [{ key, value }] : []
}

/**
 * Pull the setting name(s) to remove out of a DELETE body. The client sends a bare
 * form-urlencoded `key=PlayerShoppingBagId` — with no `value`, and (unlike its PUTs) not
 * always a `content-type` Hono's body parser recognises on a DELETE, so an unparsed body
 * is re-read as raw text. A JSON body is accepted too, as a bare string, a `{ key }`
 * object, or an array of either. Blank names are dropped.
 */
async function parseDeleteKeys(c: Context<App>): Promise<string[]> {
	const contentType = c.req.header('content-type') ?? ''

	if (contentType.includes('application/json')) {
		const body = await c.req.json<unknown>().catch(() => null)
		const list = Array.isArray(body) ? body : body == null ? [] : [body]
		return list
			.map((o) => {
				if (typeof o === 'string') return o
				const rec = o as Record<string, unknown>
				const key = rec.key ?? rec.Key
				return typeof key === 'string' ? key : ''
			})
			.filter((k) => k !== '')
	}

	// Pick ONE read of the body from the content-type: Hono's parser only recognises the
	// form types, and re-reading as text after it has cached a FormData re-serialises the
	// body as multipart, so trying both in turn parses garbage.
	let key = ''
	if (contentType.includes('form-data') || contentType.includes('x-www-form-urlencoded')) {
		const form = await c.req.parseBody().catch(() => ({}) as Record<string, unknown>)
		if (typeof form.key === 'string') key = form.key
	} else {
		key = new URLSearchParams(await c.req.text().catch(() => '')).get('key') ?? ''
	}

	// Last resort, for a client that hangs the name off the URL instead.
	if (key === '') key = c.req.query('key') ?? ''
	return key ? [key] : []
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

	// Root health check.
	.get(
		'/',
		describeRoute({
			tags: ['Service'],
			summary: 'Health check',
			description: 'Liveness probe for the playersettings worker. No auth.',
			responses: { 200: json(HealthResponse, 'Service is up') },
		}),
		(c) => c.json({ service: 'playersettings', status: 'ok' })
	)

	// The authenticated player's settings as `{ PlayerId, Key, Value }`. Reads
	// the per-player KV map; seeds (and persists) the defaults on first read.
	.get(
		'/playersettings',
		describeRoute({
			tags: ['Player Settings'],
			summary: 'The player’s settings',
			description: [
				'The authenticated player’s settings as `{ PlayerId, Key, Value }` entries, read from',
				'their KV map. A player with nothing stored is seeded with the reference defaults',
				'(Recroom.OOBE, TUTORIAL_COMPLETE_MASK, FIRST_TIME_IN_FLAGS), which are persisted on',
				'that first read.',
			].join(' '),
			security: AUTHED,
			responses: {
				200: json(PlayerSettingEntry.array(), 'The player’s settings (defaults on first read)'),
				401: UNAUTHORIZED_RESPONSE,
			},
		}),
		async (c) => {
			const id = await authedId(c)
			if (id === null) return unauthorized(c)

			const kvKey = `player:${id}`
			let stored = await c.env.RECFLARE_PLAYER_SETTINGS.get<Record<string, string>>(kvKey, 'json')
			if (!stored || Object.keys(stored).length === 0) {
				stored = Object.fromEntries(DEFAULT_SETTINGS.map((s) => [s.Key, s.Value]))
				await c.env.RECFLARE_PLAYER_SETTINGS.put(kvKey, JSON.stringify(stored))
			}

			return c.json(Object.entries(stored).map(([Key, Value]) => ({ PlayerId: id, Key, Value })))
		}
	)

	// Upsert player settings into KV, keyed by the authenticated player id.
	// A full replace would overwrite the player's entire set; we merge so individual key PUTs
	// (e.g. `key=PlayerSessionCount&value=1`) don't wipe the rest.
	.put(
		'/playersettings',
		describeRoute({
			tags: ['Player Settings'],
			summary: 'Write the player’s settings',
			description: [
				'Upserts the posted setting(s) into the caller’s KV map. The write MERGES: a single',
				'key PUT (`key=PlayerSessionCount&value=1`, which is what the client sends) leaves the',
				'player’s other settings alone. A JSON body is also accepted, as one object or an',
				'array, in either `key`/`value` or `Key`/`Value` casing; entries with an empty key are',
				'dropped. An unparseable or empty body is a no-op 200, not a 400. Empty body on success.',
			].join(' '),
			security: AUTHED,
			requestBody: formOrJson(SettingFormWrite, SettingJsonWrite, 'The setting(s) to write'),
			responses: {
				200: { description: 'Applied, or nothing parseable to apply (empty body)' },
				401: UNAUTHORIZED_RESPONSE,
			},
		}),
		async (c) => {
			const id = await authedId(c)
			if (id === null) return unauthorized(c)

			const incoming = await parseSettings(c)
			if (incoming.length === 0) return c.body(null, 200)

			const kvKey = `player:${id}`
			const existing = await c.env.RECFLARE_PLAYER_SETTINGS.get<Record<string, string>>(
				kvKey,
				'json'
			)
			const merged: Record<string, string> = { ...existing }
			for (const { key, value } of incoming) merged[key] = value

			await c.env.RECFLARE_PLAYER_SETTINGS.put(kvKey, JSON.stringify(merged))
			return c.body(null, 200)
		}
	)

	// Remove a setting from the caller's map. The client sends `key=PlayerShoppingBagId`
	// when it drops a value it no longer wants defaulted (a stale shopping bag id, say)
	// rather than writing an empty string over it.
	.delete(
		'/playersettings',
		describeRoute({
			tags: ['Player Settings'],
			summary: 'Delete a player setting',
			description: [
				'Removes the named setting(s) from the caller’s KV map. The client sends a bare',
				'form-urlencoded `key=PlayerShoppingBagId` (no `value`); a JSON body — a string, a',
				'`{ key }` object, or an array of either — and a `?key=` query param are also read.',
				'Deleting a key that isn’t stored, or sending nothing to delete, is a no-op 200, not a',
				'404. Empty body on success.',
				'',
				'Note that emptying the map entirely puts the player back to a first read: the next',
				'`GET` re-seeds the defaults.',
			].join(' '),
			security: AUTHED,
			requestBody: formOrJson(SettingFormDelete, SettingJsonDelete, 'The setting(s) to remove'),
			responses: {
				200: { description: 'Removed, or nothing to remove (empty body)' },
				401: UNAUTHORIZED_RESPONSE,
			},
		}),
		async (c) => {
			const id = await authedId(c)
			if (id === null) return unauthorized(c)

			const keys = await parseDeleteKeys(c)
			if (keys.length === 0) return c.body(null, 200)

			const kvKey = `player:${id}`
			const existing = await c.env.RECFLARE_PLAYER_SETTINGS.get<Record<string, string>>(
				kvKey,
				'json'
			)
			if (!existing) return c.body(null, 200)

			const remaining = { ...existing }
			let removed = false
			for (const key of keys) {
				if (key in remaining) {
					delete remaining[key]
					removed = true
				}
			}
			if (removed) await c.env.RECFLARE_PLAYER_SETTINGS.put(kvKey, JSON.stringify(remaining))

			return c.body(null, 200)
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
					title: 'recflare playersettings',
					version: '1.0.0',
					description: [
						'The player key/value settings bag for recflare, a private-server reimplementation of',
						'the Rec Room backend. The client reads these on load and writes them back as the',
						'player toggles options; they are stored in a per-player KV map, seeded with the',
						'reference defaults on a player’s first read.',
					].join('\n'),
				},
				servers: [{ url: 'https://playersettings.recflare.net', description: 'Production' }],
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
