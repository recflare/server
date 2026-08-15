import { adminSecretsStore, env, SELF } from 'cloudflare:test'
import { beforeAll, describe, expect, it } from 'vitest'

import '../../ai.app'

import type { Env } from '../../context'

declare module 'cloudflare:test' {
	interface ProvidedEnv extends Env {}
}

const ORIGIN = 'https://example.com'

beforeAll(async () => {
	// Seed the shared JWT signing key into the local Secrets Store so .get() resolves.
	await adminSecretsStore(env.JWT_SECRET).create('test-signing-key')
})

// Mint a token the way the `auth` worker does, signing with the shared test key seeded
// into the JWT_SECRET store.
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

const REFUSAL = {
	success: false,
	error_id: 'AI.RoomDoesNotSupportGameAI',
	error: 'This room does not support Rec Room Game AI',
}

describe('ai endpoints', () => {
	it('GET / reports service status', async () => {
		const res = await SELF.fetch(`${ORIGIN}/`)
		expect(res.status).toBe(200)
		expect(await res.json()).toEqual({ service: 'ai', status: 'ok' })
	})
})

describe('GET /gameai/user/access', () => {
	// A refusal, not an HTTP error: the client branches on the body, so a 4xx here would
	// read as a failed request rather than "Game AI isn't available in this room".
	it('refuses with a 200 body', async () => {
		const res = await SELF.fetch(`${ORIGIN}/gameai/user/access?roomId=1234`, {
			headers: await bearer(),
		})
		expect(res.status).toBe(200)
		expect(await res.json()).toEqual(REFUSAL)
	})

	// `roomId` is optional in the reference signature and ignored here, so both forms and
	// any room answer identically.
	it.each(['', '?roomId=1', '?roomId=18446744073709551615'])(
		'answers the same for %s',
		async (query) => {
			const res = await SELF.fetch(`${ORIGIN}/gameai/user/access${query}`, {
				headers: await bearer(),
			})
			expect(res.status).toBe(200)
			expect(await res.json()).toEqual(REFUSAL)
		}
	)

	it('401s without a bearer token', async () => {
		const res = await SELF.fetch(`${ORIGIN}/gameai/user/access?roomId=1234`)
		expect(res.status).toBe(401)
		expect(await res.text()).toBe('')
	})

	it('401s with a garbage token', async () => {
		const res = await SELF.fetch(`${ORIGIN}/gameai/user/access`, {
			headers: { Authorization: 'Bearer not-a-real-token' },
		})
		expect(res.status).toBe(401)
	})
})

describe('GET /roomieai/user/access', () => {
	// Granted, unlike the Game AI check: Roomie runs on the client and only asks for its
	// energy budget, which nothing here meters.
	it('grants an int32-max energy budget', async () => {
		const res = await SELF.fetch(`${ORIGIN}/roomieai/user/access`, { headers: await bearer() })
		expect(res.status).toBe(200)
		expect(await res.json()).toEqual({
			success: true,
			error_id: null,
			error: null,
			value: {
				// int.MaxValue — the client's field is a signed 32-bit int, so a larger number
				// overflows on the way in and reads as negative, i.e. no energy at all.
				MaxEnergyFromSubscriptions: 2147483647,
				EnergyLeft: 2147483647,
				NextSubscriptionEnergyRechargeAt: null,
				OutputAudioEnabled: true,
			},
		})
	})

	it('401s without a bearer token', async () => {
		const res = await SELF.fetch(`${ORIGIN}/roomieai/user/access`)
		expect(res.status).toBe(401)
		expect(await res.text()).toBe('')
	})

	it('401s with a garbage token', async () => {
		const res = await SELF.fetch(`${ORIGIN}/roomieai/user/access`, {
			headers: { Authorization: 'Bearer not-a-real-token' },
		})
		expect(res.status).toBe(401)
	})
})

describe('GET /openapi.json', () => {
	it('documents every route, with no dangling $refs', async () => {
		const res = await SELF.fetch(`${ORIGIN}/openapi.json`)
		expect(res.status).toBe(200)
		const spec = (await res.json()) as {
			openapi: string
			paths: Record<string, Record<string, { summary?: string }>>
		}
		expect(spec.openapi).toMatch(/^3\.1/)

		// The spec route hides itself; everything else is described. Adding a route without
		// a describeRoute() block fails here rather than shipping an incomplete spec.
		const documented = new Set(
			Object.entries(spec.paths).flatMap(([path, ops]) =>
				Object.keys(ops).map((method) => `${method.toUpperCase()} ${path}`)
			)
		)
		expect([...documented].sort()).toEqual([
			'GET /',
			'GET /gameai/user/access',
			'GET /roomieai/user/access',
		])

		for (const ops of Object.values(spec.paths)) {
			for (const op of Object.values(ops)) expect(op.summary).toBeTruthy()
		}

		// Schemas must inline: a `$ref` here is a dangling reference (see openapi.ts).
		expect(JSON.stringify(spec).includes('"$ref"')).toBe(false)
	})
})
