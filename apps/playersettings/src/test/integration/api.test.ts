import { adminSecretsStore, env, SELF } from 'cloudflare:test'
import { beforeAll, describe, expect, it } from 'vitest'

import '../../playersettings.app'

import type { Env } from '../../context'

declare module 'cloudflare:test' {
	interface ProvidedEnv extends Env {}
}

const ORIGIN = 'https://example.com'

beforeAll(async () => {
	// Seed the shared JWT signing key into the local Secrets Store so .get() resolves.
	await adminSecretsStore(env.JWT_SECRET).create('test-signing-key')
})

// Mint a token the way the `auth` worker does, signing with the shared test key seeded into the JWT_SECRET store.
const TEST_SECRET = 'test-signing-key'

function b64url(input: ArrayBuffer | string): string {
	const bytes = typeof input === 'string' ? new TextEncoder().encode(input) : new Uint8Array(input)
	let binary = ''
	for (const byte of bytes) binary += String.fromCharCode(byte)
	return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

async function bearer(sub = '42'): Promise<Record<string, string>> {
	const now = Math.floor(Date.now() / 1000)
	const signingInput = `${b64url(JSON.stringify({ alg: 'HS256', typ: 'JWT' }))}.${b64url(
		JSON.stringify({ sub, exp: now + 3600 })
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

function putForm(
	fields: Record<string, string>,
	headers: Record<string, string> = {}
): RequestInit {
	return {
		method: 'PUT',
		headers: { 'Content-Type': 'application/x-www-form-urlencoded', ...headers },
		body: new URLSearchParams(fields).toString(),
	}
}

function deleteForm(
	fields: Record<string, string>,
	headers: Record<string, string> = {}
): RequestInit {
	return {
		method: 'DELETE',
		headers: { 'Content-Type': 'application/x-www-form-urlencoded', ...headers },
		body: new URLSearchParams(fields).toString(),
	}
}

describe('playersettings endpoints', () => {
	it('GET / reports service status', async () => {
		const res = await SELF.fetch(`${ORIGIN}/`)
		expect(res.status).toBe(200)
		expect(await res.json()).toEqual({ service: 'playersettings', status: 'ok' })
	})

	it('GET /playersettings 401s without a token', async () => {
		const res = await SELF.fetch(`${ORIGIN}/playersettings`)
		expect(res.status).toBe(401)
	})

	it('GET /playersettings seeds and returns the default settings on first read', async () => {
		const res = await SELF.fetch(`${ORIGIN}/playersettings`, { headers: await bearer('100') })
		expect(res.status).toBe(200)
		const settings = (await res.json()) as Array<{ PlayerId: number; Key: string; Value: string }>
		expect(settings.length).toBeGreaterThan(0)
		expect(settings.every((s) => s.PlayerId === 100)).toBe(true)
		expect(settings.find((s) => s.Key === 'Recroom.OOBE')?.Value).toBe('77')
		expect(settings.find((s) => s.Key === 'TUTORIAL_COMPLETE_MASK')?.Value).toBe('11')

		// Defaults were persisted to KV.
		const stored = await env.RECFLARE_PLAYER_SETTINGS.get<Record<string, string>>(
			'player:100',
			'json'
		)
		expect(stored?.['Recroom.OOBE']).toBe('77')
	})

	it('GET /playersettings reflects a value written by PUT', async () => {
		await SELF.fetch(
			`${ORIGIN}/playersettings`,
			putForm({ key: 'PlayerSessionCount', value: '99' }, await bearer('101'))
		)
		const res = await SELF.fetch(`${ORIGIN}/playersettings`, { headers: await bearer('101') })
		const settings = (await res.json()) as Array<{ Key: string; Value: string }>
		// PUT created the only entry, so GET returns it without seeding defaults.
		expect(settings).toEqual([{ PlayerId: 101, Key: 'PlayerSessionCount', Value: '99' }])
	})

	it('PUT /playersettings 401s without a token', async () => {
		const res = await SELF.fetch(`${ORIGIN}/playersettings`, putForm({ key: 'X', value: '1' }))
		expect(res.status).toBe(401)
	})

	it('PUT /playersettings persists the form key/value into KV', async () => {
		const res = await SELF.fetch(
			`${ORIGIN}/playersettings`,
			putForm({ key: 'PlayerSessionCount', value: '1' }, await bearer('7'))
		)
		expect(res.status).toBe(200)

		const stored = await env.RECFLARE_PLAYER_SETTINGS.get<Record<string, string>>(
			'player:7',
			'json'
		)
		expect(stored).toEqual({ PlayerSessionCount: '1' })
	})

	it('PUT /playersettings merges instead of replacing', async () => {
		await SELF.fetch(
			`${ORIGIN}/playersettings`,
			putForm({ key: 'A', value: '1' }, await bearer('8'))
		)
		await SELF.fetch(
			`${ORIGIN}/playersettings`,
			putForm({ key: 'B', value: '2' }, await bearer('8'))
		)

		const stored = await env.RECFLARE_PLAYER_SETTINGS.get<Record<string, string>>(
			'player:8',
			'json'
		)
		expect(stored).toEqual({ A: '1', B: '2' })
	})

	it('PUT /playersettings 200s with no parseable settings', async () => {
		const res = await SELF.fetch(`${ORIGIN}/playersettings`, putForm({}, await bearer('9')))
		expect(res.status).toBe(200)
	})

	it('PUT /playersettings ignores null and primitive JSON array entries', async () => {
		const res = await SELF.fetch(`${ORIGIN}/playersettings`, {
			method: 'PUT',
			headers: { 'Content-Type': 'application/json', ...(await bearer('10')) },
			body: JSON.stringify([null, 12, false, { Key: 'PlayerSessionCount', Value: 4 }]),
		})
		expect(res.status).toBe(200)

		const stored = await env.RECFLARE_PLAYER_SETTINGS.get<Record<string, string>>(
			'player:10',
			'json'
		)
		expect(stored).toEqual({ PlayerSessionCount: '4' })
	})

	it('DELETE /playersettings 401s without a token', async () => {
		const res = await SELF.fetch(
			`${ORIGIN}/playersettings`,
			deleteForm({ key: 'PlayerShoppingBagId' })
		)
		expect(res.status).toBe(401)
	})

	it('DELETE /playersettings removes the named key and leaves the rest', async () => {
		await SELF.fetch(
			`${ORIGIN}/playersettings`,
			putForm({ key: 'PlayerShoppingBagId', value: 'bag-1' }, await bearer('20'))
		)
		await SELF.fetch(
			`${ORIGIN}/playersettings`,
			putForm({ key: 'PlayerSessionCount', value: '3' }, await bearer('20'))
		)

		const res = await SELF.fetch(
			`${ORIGIN}/playersettings`,
			deleteForm({ key: 'PlayerShoppingBagId' }, await bearer('20'))
		)
		expect(res.status).toBe(200)

		const stored = await env.RECFLARE_PLAYER_SETTINGS.get<Record<string, string>>(
			'player:20',
			'json'
		)
		expect(stored).toEqual({ PlayerSessionCount: '3' })
	})

	it('DELETE /playersettings reads a body with no content-type', async () => {
		await SELF.fetch(
			`${ORIGIN}/playersettings`,
			putForm({ key: 'PlayerShoppingBagId', value: 'bag-2' }, await bearer('21'))
		)

		const res = await SELF.fetch(`${ORIGIN}/playersettings`, {
			method: 'DELETE',
			headers: await bearer('21'),
			body: 'key=PlayerShoppingBagId',
		})
		expect(res.status).toBe(200)

		const stored = await env.RECFLARE_PLAYER_SETTINGS.get<Record<string, string>>(
			'player:21',
			'json'
		)
		expect(stored).toEqual({})
	})

	it('DELETE /playersettings 200s for an unknown key and an empty body', async () => {
		await SELF.fetch(
			`${ORIGIN}/playersettings`,
			putForm({ key: 'A', value: '1' }, await bearer('22'))
		)

		const unknown = await SELF.fetch(
			`${ORIGIN}/playersettings`,
			deleteForm({ key: 'NotStored' }, await bearer('22'))
		)
		expect(unknown.status).toBe(200)

		const empty = await SELF.fetch(`${ORIGIN}/playersettings`, deleteForm({}, await bearer('22')))
		expect(empty.status).toBe(200)

		// Neither call touched the stored map.
		const stored = await env.RECFLARE_PLAYER_SETTINGS.get<Record<string, string>>(
			'player:22',
			'json'
		)
		expect(stored).toEqual({ A: '1' })
	})

	it('DELETE /playersettings ignores null and primitive JSON array entries', async () => {
		await env.RECFLARE_PLAYER_SETTINGS.put(
			'player:23',
			JSON.stringify({ Keep: 'yes', Remove: 'me' })
		)

		const res = await SELF.fetch(`${ORIGIN}/playersettings`, {
			method: 'DELETE',
			headers: { 'Content-Type': 'application/json', ...(await bearer('23')) },
			body: JSON.stringify([null, 12, false, { Key: 'Remove' }]),
		})
		expect(res.status).toBe(200)

		const stored = await env.RECFLARE_PLAYER_SETTINGS.get<Record<string, string>>(
			'player:23',
			'json'
		)
		expect(stored).toEqual({ Keep: 'yes' })
	})

	it('GET /openapi.json documents every route', async () => {
		const res = await SELF.fetch(`${ORIGIN}/openapi.json`)
		expect(res.status).toBe(200)
		const spec = (await res.json()) as {
			openapi: string
			paths: Record<string, Record<string, { summary?: string }>>
		}
		expect(spec.openapi).toMatch(/^3\.1/)

		// The spec route hides itself.
		expect(spec.paths['/openapi.json']).toBeUndefined()

		// Every route the worker serves is described. This is the drift guard: adding a
		// route without a describeRoute() block fails here rather than silently shipping
		// an incomplete spec.
		const documented = new Set(
			Object.entries(spec.paths).flatMap(([path, ops]) =>
				Object.keys(ops).map((method) => `${method.toUpperCase()} ${path}`)
			)
		)
		expect([...documented].sort()).toEqual([
			'DELETE /playersettings',
			'GET /',
			'GET /playersettings',
			'PUT /playersettings',
		])

		// Every operation carries a summary — a path present but undescribed is not
		// documentation.
		for (const ops of Object.values(spec.paths)) {
			for (const op of Object.values(ops)) expect(op.summary).toBeTruthy()
		}

		// Schemas are inlined rather than $ref'd into components: a `.meta({ id })`'d
		// schema used in a response emits a $ref this hono-openapi + zod v4 setup does
		// not always hoist, leaving a dangling reference.
		expect(JSON.stringify(spec).includes('"$ref"')).toBe(false)
	})
})
