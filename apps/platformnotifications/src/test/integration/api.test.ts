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

it('reports that a player receives gameplay invites', async () => {
	const res = await SELF.fetch(`${ORIGIN}/accounts/205/receives/GameplayInvites`, {
		headers: await bearer('205'),
	})
	expect(res.status).toBe(200)
	expect(res.headers.get('content-type')).toContain('application/json')
	// The whole body is the boolean — not `{ value: true }`, not an envelope.
	expect(await res.text()).toBe('true')
})

it('answers the same for any account id, since nothing is stored per player', async () => {
	// A caller may ask about someone else; the answer doesn't depend on the id.
	const other = await SELF.fetch(`${ORIGIN}/accounts/999999/receives/GameplayInvites`, {
		headers: await bearer('205'),
	})
	expect(await other.text()).toBe('true')

	// The id is digits-only, like the reference's `ulong id`.
	expect((await SELF.fetch(`${ORIGIN}/accounts/abc/receives/GameplayInvites`)).status).toBe(404)
})

it('401s the gameplay-invites check without a bearer token', async () => {
	const res = await SELF.fetch(`${ORIGIN}/accounts/205/receives/GameplayInvites`)
	expect(res.status).toBe(401)
	expect(await res.text()).toBe('')
})

it('serves the stub notification categories', async () => {
	// A bare array of PascalCase categories, and no auth — the list is server-side config
	// rather than anything per-player.
	const res = await SELF.fetch(`${ORIGIN}/config/categories`)
	expect(res.status).toBe(200)
	const categories = (await res.json()) as Array<{
		CategoryId: number
		Importance: number
		Name: string
		Description: string
		IsMuteable: boolean
	}>
	expect(categories).toHaveLength(1)
	expect(categories[0]).toMatchObject({
		CategoryId: 2,
		Importance: 0,
		Name: 'Friends',
		IsMuteable: true,
	})
	// The stub marker is in the DISPLAYED text, so a category that does nothing says so
	// in-game rather than looking like a real setting. Keep it there while this is a stub.
	expect(categories[0].Description).toContain('STUB')
})

it('serves the caller’s notification preferences', async () => {
	const res = await SELF.fetch(`${ORIGIN}/preferences`, { headers: await bearer('205') })
	expect(res.status).toBe(200)
	// Nothing stores preferences, so nobody has muted anything. An object, not a bare array —
	// the shape has room for the other preferences the reference carries here.
	expect(await res.json()).toEqual({ MutedCategories: [] })
})

it('401s the preferences read without a bearer token', async () => {
	// Per-player, unlike /config/categories, so this one needs a token.
	const res = await SELF.fetch(`${ORIGIN}/preferences`)
	expect(res.status).toBe(401)
	expect(await res.text()).toBe('')
})
