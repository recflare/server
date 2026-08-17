import { adminSecretsStore, env, SELF } from 'cloudflare:test'
import { beforeAll, expect, it } from 'vitest'

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

it('response with hello world', async () => {
	const res = await SELF.fetch(ORIGIN)
	expect(res.status).toBe(200)
	expect(await res.text()).toMatchInlineSnapshot(`"hello, world!"`)
})

it('serves the canned curated-list bulk lookup', async () => {
	const res = await SELF.fetch(`${ORIGIN}/curatedlists/bulk?id=17859340`)
	expect(res.status).toBe(200)
	expect(await res.json()).toEqual([
		{
			ListId: 17859340,
			CreatorAccountId: 1,
			Name: 'My List',
			Description: null,
			ImageName: '',
			Type: 1,
			ItemIds: ['123', '456'],
			CreatedAt: '2025-07-18T00:00:00Z',
		},
	])
})

it('acknowledges a contextual-features post', async () => {
	const res = await SELF.fetch(`${ORIGIN}/contextualfeatures`, {
		method: 'POST',
		headers: { ...(await bearer()), 'Content-Type': 'application/json' },
		body: JSON.stringify({}),
	})
	expect(res.status).toBe(200)
	expect(await res.json()).toEqual({ success: true, error_id: null, error: null })
})

it('401s the contextual-features post without a bearer token', async () => {
	const res = await SELF.fetch(`${ORIGIN}/contextualfeatures`, { method: 'POST' })
	expect(res.status).toBe(401)
	expect(await res.text()).toBe('')
})
