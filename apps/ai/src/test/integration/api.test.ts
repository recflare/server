import { adminSecretsStore, env, SELF } from 'cloudflare:test'
import { beforeAll, beforeEach, describe, expect, it } from 'vitest'

import { RATE_LIMIT_SCHEMA_DDL, ROOMIE_API_KEY_SCHEMA_DDL } from '@repo/domain'

import '../../ai.app'

import { openKey, parseKeyring, sealKey } from '../../roomie-key'

import type { Env } from '../../context'

declare module 'cloudflare:test' {
	interface ProvidedEnv extends Env {}
}

const ORIGIN = 'https://example.com'

/** A version-1 keyring: 32 bytes, base64. Test material only. */
const KEYRING = btoa(String.fromCharCode(...Array.from({ length: 32 }, (_, i) => i + 1)))

beforeAll(async () => {
	// Seed the shared JWT signing key into the local Secrets Store so .get() resolves.
	await adminSecretsStore(env.JWT_SECRET).create('test-signing-key')
	// The keyring the Roomie API keys are sealed with.
	await adminSecretsStore(env.ROOMIE_KEY_ENCRYPTION_KEY).create(KEYRING)
	// This worker's own table (apps/ai/migrations/0001_roomie_api_key.sql) and `auth`'s
	// rate-limit counters.
	for (const stmt of ROOMIE_API_KEY_SCHEMA_DDL) await env.DB.prepare(stmt).run()
	for (const stmt of RATE_LIMIT_SCHEMA_DDL) await env.DB.prepare(stmt).run()
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

async function bearer(sub = '42', version?: string): Promise<Record<string, string>> {
	const now = Math.floor(Date.now() / 1000)
	const signingInput = `${b64url(JSON.stringify({ alg: 'HS256', typ: 'JWT' }))}.${b64url(
		JSON.stringify({ sub, exp: now + 3600, 'rn.ver': version })
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
	it('selects the 2026 no-credit companion fallback without model credentials', async () => {
		const headers = await bearer('42', '20260323.14')
		const res = await SELF.fetch(`${ORIGIN}/roomieai/user/access`, { headers })
		expect(res.status).toBe(200)
		expect(await res.json()).toEqual({
			success: false,
			error_id: 'AI.InsufficientRoomieAICreditNoSub',
			error: 'AI conversation is disabled. Roomie companion mode is available.',
			value: { MaxEnergyFromSubscriptions: 0, EnergyLeft: 0, OutputAudioEnabled: false },
		})
		// Entitlement to local activities must never mint a model credential.
		const session = await SELF.fetch(`${ORIGIN}/realtime-session/create`, {
			method: 'POST',
			headers: { ...headers, 'Content-Type': 'application/json' },
			body: JSON.stringify({ AIType: 'Roomie' }),
		})
		expect(session.status).toBe(200)
		expect(await session.json()).toMatchObject({ success: false, value: null })
	})

	it('preserves the older build budget', async () => {
		const res = await SELF.fetch(`${ORIGIN}/roomieai/user/access`, {
			headers: await bearer('42', '20250718.01'),
		})
		expect(await res.json()).toMatchObject({
			value: { EnergyLeft: 2147483647, OutputAudioEnabled: true },
		})
	})

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

describe('GET /gameai/room/:roomId/spendsummary', () => {
	// Same refusal as the access check but with an explicit `value: null` — the access
	// check omits the key. toEqual pins that difference: don't unify the two shapes.
	it('refuses with a 200 body carrying a null value', async () => {
		const res = await SELF.fetch(`${ORIGIN}/gameai/room/1234/spendsummary`, {
			headers: await bearer(),
		})
		expect(res.status).toBe(200)
		expect(await res.json()).toEqual({ ...REFUSAL, value: null })
	})

	// Room ids are ulong on the wire, so the largest one has 20 digits and exceeds what a
	// JS number holds exactly. It's never parsed here, only matched by the route pattern.
	it.each(['1', '18446744073709551615'])('answers the same for room %s', async (roomId) => {
		const res = await SELF.fetch(`${ORIGIN}/gameai/room/${roomId}/spendsummary`, {
			headers: await bearer(),
		})
		expect(res.status).toBe(200)
		expect(await res.json()).toEqual({ ...REFUSAL, value: null })
	})

	it('401s without a bearer token', async () => {
		const res = await SELF.fetch(`${ORIGIN}/gameai/room/1234/spendsummary`)
		expect(res.status).toBe(401)
		expect(await res.text()).toBe('')
	})
})

describe('GET /roomieai/user/facts', () => {
	// Nothing observes players here, so Roomie's memory of the caller is empty — and empty
	// in both halves: no prose profile, no facts behind one.
	it('reports an empty profile', async () => {
		const res = await SELF.fetch(`${ORIGIN}/roomieai/user/facts`, { headers: await bearer() })
		expect(res.status).toBe(200)
		expect(await res.json()).toEqual({ UserContext: '', UserFacts: [] })
	})

	it('401s without a bearer token', async () => {
		const res = await SELF.fetch(`${ORIGIN}/roomieai/user/facts`)
		expect(res.status).toBe(401)
		expect(await res.text()).toBe('')
	})
})

describe('GET /makerai/user/access', () => {
	// Granted, and pinned whole: the casing is mixed on purpose (PascalCase `Success`/`Error`
	// beside a snake_case `error_id`) and matches neither neighbour on this worker, so a
	// "consistency" edit has to fail here rather than on the client.
	it('grants access', async () => {
		const res = await SELF.fetch(`${ORIGIN}/makerai/user/access?roomInstanceSpecificCheck=True`, {
			headers: await bearer(),
		})
		expect(res.status).toBe(200)
		expect(res.headers.get('content-type')).toContain('application/json')
		expect(await res.json()).toEqual({ Success: true, Error: null, error_id: null })
	})

	it('answers the same without the query param', async () => {
		// `roomInstanceSpecificCheck` is ignored, so its presence, absence and value change
		// nothing.
		const granted = { Success: true, Error: null, error_id: null }
		const res = await SELF.fetch(`${ORIGIN}/makerai/user/access`, { headers: await bearer() })
		expect(await res.json()).toEqual(granted)
		const falseCheck = await SELF.fetch(
			`${ORIGIN}/makerai/user/access?roomInstanceSpecificCheck=False`,
			{
				headers: await bearer(),
			}
		)
		expect(await falseCheck.json()).toEqual(granted)
	})

	it('401s without a bearer token', async () => {
		const res = await SELF.fetch(`${ORIGIN}/makerai/user/access`)
		expect(res.status).toBe(401)
		expect(await res.text()).toBe('')
	})
})

describe('GET /makerai/user/balances', () => {
	// Zeroed rather than refused: the client renders a usage meter from these, and a server
	// that bills nothing has spent nothing. A flat body — no envelope.
	it('reports zeroed balances', async () => {
		const res = await SELF.fetch(`${ORIGIN}/makerai/user/balances`, { headers: await bearer() })
		expect(res.status).toBe(200)
		expect(await res.json()).toEqual({
			UsageDollars: 0,
			UsersMaxUsageDollars: 0,
			RRPlusUsageDollars: 0,
			UsersMaxRRPlusUsageDollars: 0,
			// An untouched allowance reports `Good`; the time bucket is `Empty` at
			// DateTime.MinValue, this server selling no timed access to hold there.
			TimeBalanceStatus: 'Empty',
			TimeExpiresAt: '0001-01-01T00:00:00',
			UsageBalanceStatus: 'Good',
			UsagePercent: 0,
			RRPlusUsageBalanceStatus: 'Good',
			RRPlusUsagePercent: 0,
		})
	})

	it('401s without a bearer token', async () => {
		const res = await SELF.fetch(`${ORIGIN}/makerai/user/balances`)
		expect(res.status).toBe(401)
		expect(await res.text()).toBe('')
	})
})

describe('POST /realtime-session/create', () => {
	// The one call whose real answer is a working credential, so the one that can't be
	// served statically. Note `error_id` is an empty string, not a code, and `value` null.
	it('refuses to open a session', async () => {
		const res = await SELF.fetch(`${ORIGIN}/realtime-session/create`, {
			method: 'POST',
			headers: { ...(await bearer()), 'Content-Type': 'application/json' },
			body: JSON.stringify({ AIType: 'Roomie' }),
		})
		expect(res.status).toBe(200)
		expect(await res.json()).toEqual({
			success: false,
			error: 'Realtime AI sessions are not available on this server',
			error_id: '',
			value: null,
		})
	})

	// The body is never read, so a missing or malformed one must not 500 — the answer is
	// the same refusal either way.
	it.each([
		['no body', undefined],
		['an empty body', '{}'],
		['a malformed body', 'not json'],
	])('refuses with %s', async (_label, body) => {
		const res = await SELF.fetch(`${ORIGIN}/realtime-session/create`, {
			method: 'POST',
			headers: { ...(await bearer()), 'Content-Type': 'application/json' },
			body,
		})
		expect(res.status).toBe(200)
		expect((await res.json()) as { success: boolean }).toMatchObject({ success: false })
	})

	it('401s without a bearer token', async () => {
		const res = await SELF.fetch(`${ORIGIN}/realtime-session/create`, {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({ AIType: 'Roomie' }),
		})
		expect(res.status).toBe(401)
		expect(await res.text()).toBe('')
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
			'DELETE /roomieai/key',
			'GET /',
			'GET /gameai/room/{roomId}/spendsummary',
			'GET /gameai/user/access',
			'GET /makerai/user/access',
			'GET /makerai/user/balances',
			'GET /roomieai/key',
			'GET /roomieai/user/access',
			'GET /roomieai/user/facts',
			'POST /realtime-session/create',
			'POST /realtime-session/logs',
			'POST /roomieai/session/spend',
			'PUT /roomieai/key',
		])

		for (const ops of Object.values(spec.paths)) {
			for (const op of Object.values(ops)) expect(op.summary).toBeTruthy()
		}

		// Schemas must inline: a `$ref` here is a dangling reference (see openapi.ts).
		expect(JSON.stringify(spec).includes('"$ref"')).toBe(false)
	})
})

// ---- Roomie on the player's own OpenAI key ----------------------------------------------

// Keys the OpenAI stub (vitest.config.ts) answers by prefix.
const GOOD_KEY = 'sk-test-good-0123456789abcdefghij'
const REVOKED_KEY = 'sk-test-revoked-0123456789abcdefghij'
const NO_REALTIME_KEY = 'sk-test-norealtime-0123456789abcdefghij'
const FLAKY_KEY = 'sk-test-flaky-0123456789abcdefghij'

const GRANTED = {
	success: true,
	error_id: null,
	error: null,
	value: {
		MaxEnergyFromSubscriptions: 2147483647,
		EnergyLeft: 2147483647,
		NextSubscriptionEnergyRechargeAt: null,
		OutputAudioEnabled: true,
	},
}

async function putKey(sub: string, apiKey: unknown) {
	return SELF.fetch(`${ORIGIN}/roomieai/key`, {
		method: 'PUT',
		headers: { ...(await bearer(sub)), 'Content-Type': 'application/json' },
		body: JSON.stringify({ apiKey }),
	})
}

async function openSession(sub: string) {
	return SELF.fetch(`${ORIGIN}/realtime-session/create`, {
		method: 'POST',
		headers: { ...(await bearer(sub, '20260323.14')), 'Content-Type': 'application/json' },
		body: JSON.stringify({ AIType: 'Roomie' }),
	})
}

/** The last request the OpenAI stub received, or null. */
async function lastOpenAiRequest() {
	const res = await env.OPENAI!.fetch('https://api.openai.com/__last')
	return (await res.json()) as { authorization: string; body: string } | null
}

beforeEach(async () => {
	await env.OPENAI!.fetch('https://api.openai.com/__last', { method: 'DELETE' })
})

describe('Roomie API keys', () => {
	it('reports no key on file', async () => {
		const res = await SELF.fetch(`${ORIGIN}/roomieai/key`, { headers: await bearer('500') })
		expect(res.status).toBe(200)
		expect(await res.json()).toEqual({ available: true, configured: false, updatedAt: null })
	})

	it('saves a key OpenAI accepts, after checking it with OpenAI', async () => {
		const res = await putKey('501', GOOD_KEY)
		expect(res.status).toBe(200)
		const text = await res.text()
		expect(text).not.toContain(GOOD_KEY)
		expect(JSON.parse(text)).toMatchObject({ available: true, configured: true })

		// The check is a Realtime client-secret mint: exactly the permission Roomie needs.
		const sent = await lastOpenAiRequest()
		expect(sent?.authorization).toBe(`Bearer ${GOOD_KEY}`)
		expect(JSON.parse(sent!.body)).toMatchObject({
			session: { type: 'realtime', model: 'gpt-realtime' },
		})

		const status = await SELF.fetch(`${ORIGIN}/roomieai/key`, { headers: await bearer('501') })
		const statusText = await status.text()
		expect(statusText).not.toContain(GOOD_KEY)
		expect(JSON.parse(statusText)).toMatchObject({
			configured: true,
			updatedAt: expect.any(String),
		})
	})

	it('stores only ciphertext: no part of the key is in the row', async () => {
		await putKey('502', GOOD_KEY)
		const row = await env.DB.prepare('SELECT * FROM roomie_api_key WHERE account_id = 502').first<
			Record<string, unknown>
		>()
		expect(row).not.toBeNull()
		expect(JSON.stringify(row)).not.toContain(GOOD_KEY)
		// Not even the distinguishing tail of it.
		const ciphertext = String.fromCharCode(...Array.from(row!.ciphertext as ArrayLike<number>))
		expect(ciphertext).not.toContain(GOOD_KEY.slice(-8))
	})

	it('refuses something that is not an OpenAI key, without calling OpenAI', async () => {
		for (const apiKey of ['', 'hello', 'sk-short', 'sk-has spaces in it 0123456789', 42, null]) {
			const res = await putKey('503', apiKey)
			expect(res.status).toBe(400)
		}
		expect(await lastOpenAiRequest()).toBeNull()
	})

	it('refuses a key OpenAI rejects, without echoing it or OpenAI’s message', async () => {
		const res = await putKey('504', REVOKED_KEY)
		expect(res.status).toBe(400)
		const text = await res.text()
		expect(text).not.toContain(REVOKED_KEY.slice(0, 12))
		expect(text).not.toContain('Incorrect API key')
		const status = await SELF.fetch(`${ORIGIN}/roomieai/key`, { headers: await bearer('504') })
		expect(await status.json()).toMatchObject({ configured: false })
	})

	it('refuses a key that cannot use Realtime', async () => {
		const res = await putKey('505', NO_REALTIME_KEY)
		expect(res.status).toBe(400)
		expect(((await res.json()) as { error: string }).error).toMatch(/Realtime/)
	})

	it('answers 502 when OpenAI fails, and stores nothing', async () => {
		const res = await putKey('506', FLAKY_KEY)
		expect(res.status).toBe(502)
		const status = await SELF.fetch(`${ORIGIN}/roomieai/key`, { headers: await bearer('506') })
		expect(await status.json()).toMatchObject({ configured: false })
	})

	it('caps save attempts per account', async () => {
		const statuses: number[] = []
		for (let i = 0; i < 11; i++) statuses.push((await putKey('507', GOOD_KEY)).status)
		expect(statuses.slice(0, 10).every((s) => s === 200)).toBe(true)
		expect(statuses[10]).toBe(429)
	})

	it('removes a key', async () => {
		await putKey('508', GOOD_KEY)
		const res = await SELF.fetch(`${ORIGIN}/roomieai/key`, {
			method: 'DELETE',
			headers: await bearer('508'),
		})
		expect(res.status).toBe(200)
		expect(await res.json()).toEqual({ available: true, configured: false, updatedAt: null })
		expect(await (await openSession('508')).json()).toMatchObject({ success: false, value: null })
	})

	it('answers the website’s CORS preflight', async () => {
		const res = await SELF.fetch(`${ORIGIN}/roomieai/key`, {
			method: 'OPTIONS',
			headers: {
				Origin: 'https://recflare.net',
				'Access-Control-Request-Method': 'PUT',
				'Access-Control-Request-Headers': 'authorization, content-type',
			},
		})
		expect(res.headers.get('access-control-allow-origin')).toBe('*')
		expect(res.headers.get('access-control-allow-methods')).toContain('PUT')
	})

	it.each(['GET', 'PUT', 'DELETE'])('%s 401s without a bearer token', async (method) => {
		const res = await SELF.fetch(`${ORIGIN}/roomieai/key`, { method })
		expect(res.status).toBe(401)
	})
})

describe('Roomie conversation with a saved key', () => {
	beforeAll(async () => {
		await putKey('600', GOOD_KEY)
	})

	it('grants the 2026 build its full budget', async () => {
		const res = await SELF.fetch(`${ORIGIN}/roomieai/user/access`, {
			headers: await bearer('600', '20260323.14'),
		})
		expect(await res.json()).toEqual(GRANTED)
	})

	it('opens a session on an ephemeral secret, never the key', async () => {
		const res = await openSession('600')
		expect(res.status).toBe(200)
		const text = await res.text()
		expect(text).not.toContain(GOOD_KEY)
		expect(JSON.parse(text)).toEqual({
			success: true,
			error_id: null,
			error: null,
			value: { SessionId: 'sess_test_123', ClientSecret: 'ek_test_ephemeral_secret' },
		})
		expect((await lastOpenAiRequest())?.authorization).toBe(`Bearer ${GOOD_KEY}`)
	})

	it('answers a spend report with the full budget', async () => {
		const res = await SELF.fetch(`${ORIGIN}/roomieai/session/spend`, {
			method: 'POST',
			headers: { ...(await bearer('600', '20260323.14')), 'Content-Type': 'application/json' },
			body: '{}',
		})
		expect(res.status).toBe(200)
		expect(await res.json()).toEqual(GRANTED)
	})

	it('accepts a session’s logs', async () => {
		const res = await SELF.fetch(`${ORIGIN}/realtime-session/logs`, {
			method: 'POST',
			headers: { ...(await bearer('600')), 'Content-Type': 'application/json' },
			body: '{}',
		})
		expect(res.status).toBe(200)
		expect(await res.json()).toEqual({ success: true, error_id: null, error: null })
	})

	// The ciphertext is bound to its account: copying a row onto another account (to run
	// Roomie on someone else's key) leaves a row that cannot be opened.
	it('refuses a row copied from another account', async () => {
		await env.DB.prepare(
			`INSERT OR REPLACE INTO roomie_api_key (account_id, key_version, iv, ciphertext, created_at, updated_at)
			 SELECT 601, key_version, iv, ciphertext, created_at, updated_at FROM roomie_api_key WHERE account_id = 600`
		).run()
		const res = await openSession('601')
		const body = (await res.json()) as { success: boolean; error: string; value: unknown }
		expect(body).toMatchObject({ success: false, value: null })
		expect(body.error).toMatch(/could not be read/)
		expect(await lastOpenAiRequest()).toBeNull()
	})

	it('passes OpenAI’s refusal on as a session refusal', async () => {
		// Saved while valid, revoked since: sealed straight into the table, as the stub would
		// refuse it at save time.
		const ring = (await parseKeyring(KEYRING))!
		const sealed = await sealKey(ring, 602, REVOKED_KEY)
		await env.DB.prepare(
			'INSERT OR REPLACE INTO roomie_api_key (account_id, key_version, iv, ciphertext, created_at, updated_at) VALUES (602, ?1, ?2, ?3, 0, 0)'
		)
			.bind(sealed.keyVersion, sealed.iv, sealed.ciphertext)
			.run()
		const res = await openSession('602')
		const text = await res.text()
		expect(text).not.toContain(REVOKED_KEY.slice(0, 12))
		const body = JSON.parse(text) as { error: string }
		expect(body).toMatchObject({ success: false, error_id: '', value: null })
		expect(body.error).toMatch(/rejected/)
	})
})

describe('roomie-key sealing', () => {
	it('reads a bare base64 keyring as version 1', async () => {
		const ring = await parseKeyring(KEYRING)
		expect(ring?.current.version).toBe(1)
	})

	it('treats the first versioned entry as current and keeps the rest for opening', async () => {
		const older = (await parseKeyring(KEYRING))!
		const sealedOld = await sealKey(older, 9, GOOD_KEY)
		const newer = btoa(String.fromCharCode(...Array.from({ length: 32 }, (_, i) => 255 - i)))
		const ring = (await parseKeyring(`2:${newer}, 1:${KEYRING}`))!
		expect(ring.current.version).toBe(2)
		expect(await openKey(ring, 9, sealedOld)).toBe(GOOD_KEY)
		const sealedNew = await sealKey(ring, 9, GOOD_KEY)
		expect(sealedNew.keyVersion).toBe(2)
		expect(await openKey(ring, 9, sealedNew)).toBe(GOOD_KEY)
	})

	it.each([
		['empty', ''],
		['not base64', 'not-base64!!'],
		['the wrong length', btoa('too short')],
		['a bad version', `0:${KEYRING}`],
		['a duplicate version', `1:${KEYRING},1:${KEYRING}`],
	])('rejects a keyring that is %s', async (_label, secret) => {
		expect(await parseKeyring(secret)).toBeNull()
	})

	it('will not open a key for another account, or under a tampered version', async () => {
		const ring = (await parseKeyring(KEYRING))!
		const sealed = await sealKey(ring, 10, GOOD_KEY)
		expect(await openKey(ring, 11, sealed)).toBeNull()
		expect(await openKey(ring, 10, { ...sealed, keyVersion: 2 })).toBeNull()
		const flipped = Uint8Array.from(sealed.ciphertext)
		flipped[0] = flipped[0]! ^ 1
		expect(await openKey(ring, 10, { ...sealed, ciphertext: flipped })).toBeNull()
	})
})
