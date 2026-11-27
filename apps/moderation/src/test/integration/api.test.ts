import { adminSecretsStore, env, SELF } from 'cloudflare:test'
import { beforeAll, describe, expect, it } from 'vitest'

import { ROOMIE_API_KEY_SCHEMA_DDL } from '@repo/domain'

import '../../moderation.app'

import type { Env } from '../../context'

declare module 'cloudflare:test' {
	interface ProvidedEnv extends Env {}
}

const ORIGIN = 'https://example.com'
const TEST_SECRET = 'test-signing-key'

beforeAll(async () => {
	await adminSecretsStore(env.JWT_SECRET).create(TEST_SECRET)
	// The table is the `ai` worker's (apps/ai/migrations/0001_roomie_api_key.sql).
	for (const stmt of ROOMIE_API_KEY_SCHEMA_DDL) await env.DB.prepare(stmt).run()
	// Account 7 has a key on file; the row's contents are never read here, so filler will do.
	await env.DB.prepare(
		"INSERT OR REPLACE INTO roomie_api_key (account_id, key_version, iv, ciphertext, created_at, updated_at) VALUES (7, 1, x'00', x'00', 0, 0)"
	).run()
})

function b64url(input: ArrayBuffer | string): string {
	const bytes = typeof input === 'string' ? new TextEncoder().encode(input) : new Uint8Array(input)
	let binary = ''
	for (const byte of bytes) binary += String.fromCharCode(byte)
	return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

async function bearer(sub: string): Promise<Record<string, string>> {
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
	const res = await SELF.fetch('https://example.com')
	expect(res.status).toBe(200)
	expect(await res.text()).toMatchInlineSnapshot(`"hello, world!"`)
})

it('serves empty voice moderation credentials', async () => {
	const res = await SELF.fetch('https://example.com/voice/config')
	expect(res.status).toBe(200)
	expect(await res.json()).toEqual({ AccountId: '', ApiKey: '' })
})

describe('GET /aimoderation/roomie/enabledForPlayer', () => {
	// A bare JSON boolean: the client reads it as Task<bool>.
	it('is true for a player with a Roomie API key on file', async () => {
		const res = await SELF.fetch(`${ORIGIN}/aimoderation/roomie/enabledForPlayer`, {
			headers: await bearer('7'),
		})
		expect(res.status).toBe(200)
		expect(await res.text()).toBe('true')
	})

	it('is false for a player without one', async () => {
		const res = await SELF.fetch(`${ORIGIN}/aimoderation/roomie/enabledForPlayer`, {
			headers: await bearer('8'),
		})
		expect(res.status).toBe(200)
		expect(await res.text()).toBe('false')
	})

	it('401s without a bearer token', async () => {
		const res = await SELF.fetch(`${ORIGIN}/aimoderation/roomie/enabledForPlayer`)
		expect(res.status).toBe(401)
	})
})

describe('POST /aimoderation/roomie/conversation', () => {
	it('accepts the conversation', async () => {
		const res = await SELF.fetch(`${ORIGIN}/aimoderation/roomie/conversation`, {
			method: 'POST',
			headers: { ...(await bearer('7')), 'Content-Type': 'application/x-www-form-urlencoded' },
			body: new URLSearchParams({ conversation: '[]' }).toString(),
		})
		expect(res.status).toBe(200)
		expect(await res.json()).toEqual({})
	})

	it('401s without a bearer token', async () => {
		const res = await SELF.fetch(`${ORIGIN}/aimoderation/roomie/conversation`, { method: 'POST' })
		expect(res.status).toBe(401)
	})
})
