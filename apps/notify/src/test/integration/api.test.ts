import { adminSecretsStore, env } from 'cloudflare:test'
import { exports } from 'cloudflare:workers'
import { beforeAll, describe, expect, test } from 'vitest'

import '../../notify.app'

import type { Env } from '../../context'
import type { HubState } from '../../notifications-hub'

declare module 'cloudflare:test' {
	interface ProvidedEnv extends Env {}
}

const ORIGIN = 'https://example.com'
const RS = '\u001e'

// Mint a token the way the `auth` worker does, signing with the shared test key
// seeded into the JWT_SECRET store. Accounts 1 and 2 are the internal-endpoint admins.
const TEST_SECRET = 'test-signing-key'
function b64url(input: ArrayBuffer | string): string {
	const bytes = typeof input === 'string' ? new TextEncoder().encode(input) : new Uint8Array(input)
	let binary = ''
	for (const byte of bytes) binary += String.fromCharCode(byte)
	return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}
async function bearer(
	sub: string,
	roles?: string[],
	expiresIn = 3600
): Promise<Record<string, string>> {
	const now = Math.floor(Date.now() / 1000)
	const claims: Record<string, unknown> = { sub, exp: now + expiresIn }
	if (roles) claims.role = roles
	const signingInput = `${b64url(JSON.stringify({ alg: 'HS256', typ: 'JWT' }))}.${b64url(
		JSON.stringify(claims)
	)}`
	const key = await crypto.subtle.importKey(
		'raw',
		new TextEncoder().encode(TEST_SECRET),
		{ name: 'HMAC', hash: 'SHA-256' },
		false,
		['sign']
	)
	const sig = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(signingInput))
	return { Authorization: `Bearer ${signingInput}.${b64url(sig)}` }
}

// Seed the shared JWT signing key into the local Secrets Store so .get() resolves.
beforeAll(async () => {
	await adminSecretsStore(env.JWT_SECRET).create(TEST_SECRET)
})

/** Who `connect` is by default — kept clear of the player ids the tests notify. */
const DEFAULT_CONNECT_PLAYER = 9000

interface HubRecord {
	type?: number
	target?: string
	invocationId?: string
	result?: unknown
	arguments?: unknown[]
}

/** Open a hub WebSocket, accept it, and complete the SignalR handshake. */
async function connect(
	id: string,
	opts: { headers?: Record<string, string>; query?: string } = {}
): Promise<{
	ws: WebSocket
	waitFor: (pred: (r: HubRecord) => boolean) => Promise<HubRecord>
	/** Everything this socket has received so far — for asserting something did NOT arrive. */
	records: HubRecord[]
}> {
	// The hub only accepts identified connections, so default to a token; pass explicit
	// `headers` (`{}` for none) where the test is about who is connecting.
	const auth = opts.headers ?? (await bearer(String(DEFAULT_CONNECT_PLAYER), ['gameClient']))
	const res = await exports.default.fetch(`${ORIGIN}/hub/v1?id=${id}${opts.query ?? ''}`, {
		headers: { Upgrade: 'websocket', ...auth },
	})
	expect(res.status).toBe(101)
	const ws = res.webSocket!
	ws.accept()

	const records: HubRecord[] = []
	const waiters: Array<{ pred: (r: HubRecord) => boolean; resolve: (r: HubRecord) => void }> = []
	ws.addEventListener('message', (e: MessageEvent) => {
		const text =
			typeof e.data === 'string' ? e.data : new TextDecoder().decode(e.data as ArrayBuffer)
		for (const part of text.split(RS)) {
			if (!part) continue
			const rec = JSON.parse(part) as HubRecord
			records.push(rec)
			for (let i = waiters.length - 1; i >= 0; i--) {
				if (waiters[i].pred(rec)) {
					waiters[i].resolve(rec)
					waiters.splice(i, 1)
				}
			}
		}
	})

	const waitFor = (pred: (r: HubRecord) => boolean): Promise<HubRecord> => {
		const existing = records.find(pred)
		if (existing) return Promise.resolve(existing)
		return new Promise((resolve, reject) => {
			const timer = setTimeout(() => reject(new Error('timed out waiting for hub message')), 2000)
			waiters.push({
				pred,
				resolve: (r) => {
					clearTimeout(timer)
					resolve(r)
				},
			})
		})
	}

	// Handshake, then the OnConnect callback.
	ws.send(`{"protocol":"json","version":1}${RS}`)
	await waitFor((r) => r.type === 1 && r.target === 'OnConnect')

	return { ws, waitFor, records }
}

const send = (ws: WebSocket, msg: HubRecord) => ws.send(JSON.stringify(msg) + RS)

// The /internal/* endpoints are admin-gated (a token carrying an admin role), so
// default to a moderator token; pass `auth` to override (e.g. the 401/403 paths).
const post = async (path: string, body: unknown, auth?: Record<string, string>) =>
	exports.default.fetch(`${ORIGIN}${path}`, {
		method: 'POST',
		headers: {
			'Content-Type': 'application/json',
			...(auth ?? (await bearer('1', ['gameClient', 'moderator']))),
		},
		body: JSON.stringify(body),
	})

describe('negotiate', () => {
	test('POST /hub/v1/negotiate advertises the WebSocket transport', async () => {
		const res = await exports.default.fetch(`${ORIGIN}/hub/v1/negotiate?negotiateVersion=1`, {
			method: 'POST',
		})
		expect(res.status).toBe(200)
		const body = (await res.json()) as {
			connectionId: string
			connectionToken: string
			availableTransports: Array<{ transport: string }>
		}
		expect(body.connectionId).toMatch(/^[0-9a-f-]{36}$/)
		expect(body.connectionToken).toBe(body.connectionId)
		expect(body.availableTransports[0].transport).toBe('WebSockets')
	})

	test('GET /hub/v1 without an upgrade header is 426', async () => {
		const res = await exports.default.fetch(`${ORIGIN}/hub/v1`)
		expect(res.status).toBe(426)
	})
})

describe('internal endpoint auth', () => {
	const body = { playerId: 1, notificationType: 1, data: {} }

	test('401 without a Bearer token', async () => {
		const res = await exports.default.fetch(`${ORIGIN}/internal/notify`, {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify(body),
		})
		expect(res.status).toBe(401)
	})

	test('403 for a valid token without an admin role', async () => {
		const res = await post('/internal/notify', body, await bearer('3', ['gameClient']))
		expect(res.status).toBe(403)
	})

	test('tokens carrying an admin role are allowed', async () => {
		for (const role of ['developer', 'moderator']) {
			const res = await post(
				'/internal/broadcast',
				{ notificationType: 1 },
				await bearer('3', ['gameClient', role])
			)
			expect(res.status).toBe(200)
		}
	})
})

describe('hub protocol', () => {
	test('GetSubscriptions reflects SubscribeToPlayers', async () => {
		const { ws, waitFor } = await connect('conn-subs')

		send(ws, { type: 1, invocationId: '1', target: 'GetSubscriptions', arguments: [] })
		const empty = await waitFor((r) => r.type === 3 && r.invocationId === '1')
		expect(empty.result).toEqual([])

		send(ws, { type: 1, target: 'SubscribeToPlayers', arguments: [{ playerIds: [1, 2, 2] }] })
		send(ws, { type: 1, invocationId: '2', target: 'GetSubscriptions', arguments: [] })
		const subscribed = await waitFor((r) => r.type === 3 && r.invocationId === '2')
		expect((subscribed.result as number[]).sort((a, b) => a - b)).toEqual([1, 2])

		ws.close()
	})

	// The client's argument spelling isn't specified anywhere, and getting it wrong is
	// silent: subscribing replaces the connection's set, so a misread leaves it at zero
	// and every notification queues instead of being delivered.
	test.each([
		['an options object', [{ playerIds: [11, 12] }]],
		['a single array argument', [[11, 12]]],
		['varargs', [11, 12]],
		['string ids', [{ playerIds: ['11', '12'] }]],
	])('SubscribeToPlayers accepts %s', async (label, args) => {
		const { ws, waitFor } = await connect(`conn-args-${label.replace(/\s+/g, '-')}`)
		send(ws, { type: 1, target: 'SubscribeToPlayers', arguments: args })
		send(ws, { type: 1, invocationId: 'g', target: 'GetSubscriptions', arguments: [] })
		const result = await waitFor((r) => r.type === 3 && r.invocationId === 'g')
		expect((result.result as number[]).sort((a, b) => a - b)).toEqual([11, 12])
		ws.close()
	})

	test('an unreadable argument leaves existing subscriptions alone', async () => {
		const { ws, waitFor } = await connect('conn-args-bad')
		send(ws, { type: 1, target: 'SubscribeToPlayers', arguments: [{ playerIds: [21] }] })

		// Answered, but the connection keeps the players it already had rather than
		// being wiped to zero.
		send(ws, { type: 1, invocationId: 'b', target: 'SubscribeToPlayers', arguments: ['nonsense'] })
		await waitFor((r) => r.type === 3 && r.invocationId === 'b')

		send(ws, { type: 1, invocationId: 'g', target: 'GetSubscriptions', arguments: [] })
		const result = await waitFor((r) => r.type === 3 && r.invocationId === 'g')
		expect(result.result).toEqual([21])
		ws.close()
	})

	test('an explicitly empty list still clears the connection', async () => {
		const { ws, waitFor } = await connect('conn-args-empty')
		send(ws, { type: 1, target: 'SubscribeToPlayers', arguments: [{ playerIds: [31] }] })
		send(ws, { type: 1, target: 'SubscribeToPlayers', arguments: [{ playerIds: [] }] })
		send(ws, { type: 1, invocationId: 'g', target: 'GetSubscriptions', arguments: [] })
		const result = await waitFor((r) => r.type === 3 && r.invocationId === 'g')
		expect(result.result).toEqual([])
		ws.close()
	})

	test('responds to ping', async () => {
		const { ws, waitFor } = await connect('conn-ping')
		send(ws, { type: 6 })
		const pong = await waitFor((r) => r.type === 6)
		expect(pong.type).toBe(6)
		ws.close()
	})
})

describe('notification delivery', () => {
	test('queues for an offline player and flushes on subscribe', async () => {
		const playerId = 9001
		const queued = await post('/internal/notify', {
			playerId,
			notificationType: 2,
			data: { messageId: 'm1' },
		})
		expect(await queued.json()).toMatchObject({ queued: true, delivered: 0 })

		const { ws, waitFor } = await connect('conn-pending')
		send(ws, { type: 1, target: 'SubscribeToPlayers', arguments: [{ playerIds: [playerId] }] })
		const note = await waitFor((r) => r.type === 1 && r.target === 'Notification')
		expect(JSON.parse((note.arguments as string[])[0])).toEqual({
			Id: '2',
			Msg: { messageId: 'm1' },
		})

		ws.close()
	})

	test('delivers live to a subscribed player', async () => {
		const playerId = 9002
		const { ws, waitFor } = await connect('conn-live')
		send(ws, {
			type: 1,
			invocationId: 's',
			target: 'SubscribeToPlayers',
			arguments: [{ playerIds: [playerId] }],
		})
		await waitFor((r) => r.type === 3 && r.invocationId === 's')

		const res = await post('/internal/notify', {
			playerId,
			notificationType: 1,
			data: { accountId: 42 },
		})
		expect(await res.json()).toMatchObject({ delivered: 1, queued: false })

		const note = await waitFor((r) => r.type === 1 && r.target === 'Notification')
		expect(JSON.parse((note.arguments as string[])[0])).toEqual({
			Id: '1',
			Msg: { accountId: 42 },
		})

		ws.close()
	})

	test('broadcast reaches connected clients', async () => {
		const { ws, waitFor } = await connect('conn-broadcast')
		const res = await post('/internal/broadcast', {
			notificationType: 25,
			data: { message: 'maint' },
		})
		expect(((await res.json()) as { delivered: number }).delivered).toBeGreaterThanOrEqual(1)
		const note = await waitFor((r) => r.type === 1 && r.target === 'Notification')
		expect(JSON.parse((note.arguments as string[])[0])).toEqual({
			Id: '25',
			Msg: { message: 'maint' },
		})
		ws.close()
	})

	test('coach-message-all messages every connected client', async () => {
		const a = await connect('coach-a')
		const b = await connect('coach-b')

		const res = await post('/internal/coach-message-all', { messageContent: 'hello all' })
		expect(res.status).toBe(200)
		expect(((await res.json()) as { sent: number }).sent).toBeGreaterThanOrEqual(2)

		const noteA = await a.waitFor((r) => r.type === 1 && r.target === 'Notification')
		const payloadA = JSON.parse((noteA.arguments as string[])[0]) as {
			Id: string
			Msg: Record<string, unknown>
		}
		expect(payloadA.Id).toBe('2') // MessageReceived
		expect(payloadA.Msg).toMatchObject({ FromPlayerId: 1, Type: 100, Data: 'hello all' })

		const noteB = await b.waitFor((r) => r.type === 1 && r.target === 'Notification')
		const payloadB = JSON.parse((noteB.arguments as string[])[0]) as {
			Msg: Record<string, unknown>
		}
		expect(payloadB.Msg).toMatchObject({ Data: 'hello all' })

		a.ws.close()
		b.ws.close()
	})

	test('coach-message reaches only the named player, addressed to them', async () => {
		const playerId = 9010
		const target = await connect('coach-one', {
			headers: await bearer(String(playerId), ['gameClient']),
		})
		const bystander = await connect('coach-one-bystander')
		send(target.ws, {
			type: 1,
			invocationId: 's',
			target: 'SubscribeToPlayers',
			arguments: [{ playerIds: [playerId] }],
		})
		await target.waitFor((r) => r.type === 3 && r.invocationId === 's')

		const res = await post('/internal/coach-message', { playerId, messageContent: 'just you' })
		expect(res.status).toBe(200)
		expect(await res.json()).toMatchObject({ delivered: 1, queued: false })

		const note = await target.waitFor((r) => r.type === 1 && r.target === 'Notification')
		const payload = JSON.parse((note.arguments as string[])[0]) as {
			Id: string
			Msg: Record<string, unknown>
		}
		expect(payload.Id).toBe('2') // MessageReceived
		// Same Coach frame as the broadcast, plus the recipient the broadcast can't name.
		expect(payload.Msg).toMatchObject({
			FromPlayerId: 1,
			ToPlayerId: playerId,
			Type: 100,
			Data: 'just you',
		})

		// The point of the targeted send: nobody else's socket sees it. The bystander is
		// subscribed to nothing, and a broadcast would have reached it regardless.
		expect(bystander.records.some((r) => r.target === 'Notification')).toBe(false)

		target.ws.close()
		bystander.ws.close()
	})

	test('coach-message queues for a player who is offline', async () => {
		const playerId = 9011
		const res = await post('/internal/coach-message', {
			playerId,
			messageContent: 'catch you later',
		})
		expect(await res.json()).toMatchObject({ delivered: 0, queued: true })

		// Unlike the broadcast, it survives until they connect.
		const { ws, waitFor } = await connect('coach-one-late')
		send(ws, { type: 1, target: 'SubscribeToPlayers', arguments: [{ playerIds: [playerId] }] })
		const note = await waitFor((r) => r.type === 1 && r.target === 'Notification')
		expect(
			(JSON.parse((note.arguments as string[])[0]) as { Msg: Record<string, unknown> }).Msg
		).toMatchObject({ FromPlayerId: 1, ToPlayerId: playerId, Data: 'catch you later' })
		ws.close()
	})

	test('coach-message 400s without a player or a message', async () => {
		expect((await post('/internal/coach-message', { messageContent: 'nobody' })).status).toBe(400)
		expect((await post('/internal/coach-message', { playerId: 9012 })).status).toBe(400)
		expect(
			(await post('/internal/coach-message', { playerId: 9012, messageContent: '   ' })).status
		).toBe(400)
	})

	test('coach-message-all 400s on an empty message', async () => {
		const res = await post('/internal/coach-message-all', { messageContent: '   ' })
		expect(res.status).toBe(400)
	})

	test('emits a numeric notificationType as a string Id', async () => {
		// The client dispatches on a string Id, so numeric codes (e.g. econ's
		// NotificationType enum) must be serialized as strings or they're dropped.
		const playerId = 9003
		const { ws, waitFor } = await connect('conn-numeric-id')
		send(ws, {
			type: 1,
			invocationId: 's',
			target: 'SubscribeToPlayers',
			arguments: [{ playerIds: [playerId] }],
		})
		await waitFor((r) => r.type === 3 && r.invocationId === 's')

		await post('/internal/notify', { playerId, notificationType: 71, data: { itemId: 5 } })

		const note = await waitFor((r) => r.type === 1 && r.target === 'Notification')
		const payload = JSON.parse((note.arguments as string[])[0]) as { Id: unknown }
		expect(payload.Id).toBe('71')
		expect(typeof payload.Id).toBe('string')

		ws.close()
	})
})

// The client never calls SubscribeToPlayers, so a player's own notifications reach them
// only because the connect established who they are.
describe('connection ownership', () => {
	const hubState = async () =>
		(await (
			await exports.default.fetch(`${ORIGIN}/internal/hub-state`, {
				headers: await bearer('1', ['gameClient', 'moderator']),
			})
		).json()) as HubState

	// The client never calls SubscribeToPlayers, so connecting is the only moment a
	// queue can drain — with the flush living only in there, anything that landed while
	// the player was reconnecting stayed queued forever.
	test('drains what queued while the player was away, on connect', async () => {
		const playerId = 9305
		await post('/internal/notify', { playerId, notificationType: 90, data: { n: 1 } })
		await post('/internal/notify', { playerId, notificationType: 90, data: { n: 2 } })

		const { ws, waitFor } = await connect('conn-flush', {
			headers: await bearer(String(playerId), ['gameClient']),
		})

		// Delivered in the order they queued, and cleared once sent.
		const first = await waitFor(
			(r) => r.target === 'Notification' && (r.arguments as string[])[0].includes('"n":1')
		)
		expect(JSON.parse((first.arguments as string[])[0])).toEqual({ Id: '90', Msg: { n: 1 } })
		await waitFor(
			(r) => r.target === 'Notification' && (r.arguments as string[])[0].includes('"n":2')
		)
		expect((await hubState()).pending.find((p) => p.playerId === playerId)).toBeUndefined()

		ws.close()
	})

	test('delivers to the connecting player without any subscription', async () => {
		const playerId = 9301
		const { ws, waitFor } = await connect('conn-owned', {
			headers: await bearer(String(playerId), ['gameClient']),
		})

		const res = await post('/internal/notify', {
			playerId,
			notificationType: 90,
			data: { chatThreadId: 22 },
		})
		expect(await res.json()).toMatchObject({ delivered: 1, queued: false })

		const note = await waitFor((r) => r.type === 1 && r.target === 'Notification')
		expect(JSON.parse((note.arguments as string[])[0])).toEqual({
			Id: '90',
			Msg: { chatThreadId: 22 },
		})

		const connection = (await hubState()).connections.find((c) => c.connectionId === 'conn-owned')
		expect(connection).toMatchObject({ playerId, playerIds: [] })

		ws.close()
	})

	// SignalR clients that can't set headers on the upgrade put the token here instead.
	test('accepts the token as an access_token query param', async () => {
		const playerId = 9302
		const auth = await bearer(String(playerId), ['gameClient'])
		const token = auth.Authorization.slice('Bearer '.length)
		const { ws, waitFor } = await connect('conn-owned-query', {
			headers: {},
			query: `&access_token=${token}`,
		})

		await post('/internal/notify', { playerId, notificationType: 90, data: { a: 1 } })
		const note = await waitFor((r) => r.type === 1 && r.target === 'Notification')
		expect(JSON.parse((note.arguments as string[])[0])).toMatchObject({ Id: '90' })

		ws.close()
	})

	// The header is the DO's proof of identity, so presenting one without a token must
	// not get you in — otherwise anyone could name themselves and receive that player's
	// notifications.
	test('a client-supplied owner header does not authenticate a connect', async () => {
		const res = await exports.default.fetch(`${ORIGIN}/hub/v1?id=conn-spoofed`, {
			headers: { Upgrade: 'websocket', 'x-recflare-connection-owner': '9303' },
		})
		expect(res.status).toBe(401)

		const notified = await post('/internal/notify', { playerId: 9303, notificationType: 90 })
		expect(await notified.json()).toMatchObject({ delivered: 0, queued: true })
		expect(
			(await hubState()).connections.find((c) => c.connectionId === 'conn-spoofed')
		).toBeUndefined()
	})

	test('an unidentified connect is refused', async () => {
		const res = await exports.default.fetch(`${ORIGIN}/hub/v1?id=conn-anon`, {
			headers: { Upgrade: 'websocket' },
		})
		expect(res.status).toBe(401)
	})

	test('an expired token is refused', async () => {
		const expired = await bearer(String(9304), ['gameClient'], -60)
		const res = await exports.default.fetch(`${ORIGIN}/hub/v1?id=conn-expired`, {
			headers: { Upgrade: 'websocket', ...expired },
		})
		expect(res.status).toBe(401)
	})
})

describe('hub state', () => {
	const hubState = async (auth?: Record<string, string>) =>
		exports.default.fetch(`${ORIGIN}/internal/hub-state`, {
			headers: auth ?? (await bearer('1', ['gameClient', 'moderator'])),
		})

	test('reports a connection, who it receives for, and what is queued', async () => {
		const subscribed = 9101
		const offline = 9102
		const { ws, waitFor } = await connect('conn-state')
		send(ws, {
			type: 1,
			invocationId: 's',
			target: 'SubscribeToPlayers',
			arguments: [{ playerIds: [subscribed] }],
		})
		await waitFor((r) => r.type === 3 && r.invocationId === 's')

		// Nobody is subscribed to `offline`, so this one queues instead of delivering —
		// the case a missing push is usually hiding in.
		await post('/internal/notify', { playerId: offline, notificationType: 90, data: { a: 1 } })

		// One DO is shared across the file, so other tests' connections are in here too.
		const state = (await (await hubState()).json()) as HubState
		expect(state.connections.find((c) => c.connectionId === 'conn-state')).toEqual({
			connectionId: 'conn-state',
			live: true,
			handshakeDone: true,
			playerId: DEFAULT_CONNECT_PLAYER,
			playerIds: [subscribed],
		})
		const queued = state.pending.find((p) => p.playerId === offline)
		expect(queued?.count).toBe(1)
		expect(JSON.parse(queued!.latest)).toEqual({ Id: '90', Msg: { a: 1 } })
		expect(state.pending.find((p) => p.playerId === subscribed)).toBeUndefined()

		ws.close()
	})

	test('is admin-gated like the other internal endpoints', async () => {
		expect((await exports.default.fetch(`${ORIGIN}/internal/hub-state`)).status).toBe(401)
		expect((await hubState(await bearer('3', ['gameClient']))).status).toBe(403)
	})
})

describe('clearing pending notifications', () => {
	const clear = async (query: string, auth?: Record<string, string>) =>
		exports.default.fetch(`${ORIGIN}/internal/hub-state/pending?${query}`, {
			method: 'DELETE',
			headers: auth ?? (await bearer('1', ['gameClient', 'moderator'])),
		})

	const pendingFor = async (playerId: number) => {
		const state = (await (
			await exports.default.fetch(`${ORIGIN}/internal/hub-state`, {
				headers: await bearer('1', ['gameClient', 'moderator']),
			})
		).json()) as HubState
		return state.pending.find((p) => p.playerId === playerId)
	}

	const queue = async (playerId: number, count: number) => {
		for (let i = 0; i < count; i++) {
			await post('/internal/notify', { playerId, notificationType: 90, data: { i } })
		}
	}

	test('clears one player, leaving everyone else queued', async () => {
		await queue(9201, 2)
		await queue(9202, 1)

		const res = await clear('playerId=9201')
		expect(res.status).toBe(200)
		expect(await res.json()).toEqual({ success: true, cleared: 2 })
		expect(await pendingFor(9201)).toBeUndefined()
		expect((await pendingFor(9202))?.count).toBe(1)

		// Clearing a queue that's already empty is a no-op, not an error.
		expect(await (await clear('playerId=9201')).json()).toEqual({ success: true, cleared: 0 })
	})

	test('clears every queue only when all=true is explicit', async () => {
		await queue(9203, 1)

		const guarded = await clear('')
		expect(guarded.status).toBe(400)
		expect((await pendingFor(9203))?.count).toBe(1)

		const res = await clear('all=true')
		expect(res.status).toBe(200)
		expect(((await res.json()) as { cleared: number }).cleared).toBeGreaterThanOrEqual(1)
		expect(await pendingFor(9203)).toBeUndefined()
	})

	test('400s on a non-numeric playerId', async () => {
		expect((await clear('playerId=nope')).status).toBe(400)
	})

	test('is admin-gated like the other internal endpoints', async () => {
		const res = await exports.default.fetch(`${ORIGIN}/internal/hub-state/pending?all=true`, {
			method: 'DELETE',
		})
		expect(res.status).toBe(401)
		expect((await clear('all=true', await bearer('3', ['gameClient']))).status).toBe(403)
	})
})

// The website's admin controls (maintenance countdown, coach broadcast) are a browser
// calling `/internal/*` directly rather than through a `www` proxy, so these need CORS.
describe('CORS', () => {
	// The catch: `/internal/*` is behind `requireAdmin`, and a browser preflight carries
	// NO Authorization header — it can't, that's the header it's asking permission to
	// send. So the CORS middleware has to answer it before the admin gate sees it,
	// otherwise every admin action fails the preflight with a 401 and never gets sent.
	test('answers the preflight on an admin endpoint without a token', async () => {
		const res = await exports.default.fetch(
			new Request(`${ORIGIN}/internal/broadcast`, {
				method: 'OPTIONS',
				headers: {
					origin: 'https://www.example.com',
					'access-control-request-method': 'POST',
					'access-control-request-headers': 'authorization, content-type',
				},
			}),
			env
		)
		expect(res.status).toBe(204)
		expect(res.headers.get('access-control-allow-origin')).toBe('*')
		const allowed = res.headers.get('access-control-allow-headers')?.toLowerCase() ?? ''
		expect(allowed).toContain('authorization')
		expect(allowed).toContain('content-type')
	})

	// The gate itself is untouched: the preflight passing is not the request passing.
	test('still rejects the actual call without an admin token', async () => {
		const res = await exports.default.fetch(
			new Request(`${ORIGIN}/internal/broadcast`, {
				method: 'POST',
				headers: { origin: 'https://www.example.com', 'content-type': 'application/json' },
				body: JSON.stringify({ notificationType: 25, data: {} }),
			}),
			env
		)
		expect(res.status).toBe(401)
		expect(res.headers.get('access-control-allow-origin')).toBe('*')
	})
})
