import { adminSecretsStore, env } from 'cloudflare:test'
import { exports } from 'cloudflare:workers'
import { beforeAll, describe, expect, test } from 'vitest'

import '../../accounts.app'

import { SCHEMA_DDL } from '@repo/domain'

import type { Env } from '../../context'

declare module 'cloudflare:test' {
	interface ProvidedEnv extends Env {}
}

const ORIGIN = 'https://example.com'

// Apply the accounts schema + seed the system (uid 0) and Coach (uid 1) accounts
// into the test D1 (mirrors apps/auth/migrations/0001_accounts.sql).
beforeAll(async () => {
	// Seed the shared JWT signing key into the local Secrets Store so .get() resolves.
	await adminSecretsStore(env.JWT_SECRET).create('test-signing-key')
	for (const stmt of SCHEMA_DDL) await env.DB.prepare(stmt).run()
	const insert = env.DB.prepare('INSERT OR IGNORE INTO account (data) VALUES (?1)')
	await env.DB.batch([
		insert.bind(JSON.stringify({ accountId: 0, username: 'RecRoom', displayName: 'Rec Room' })),
		insert.bind(JSON.stringify({ accountId: 1, username: 'Coach', displayName: 'Coach' })),
	])
})

// Mint a token the way the `auth` worker does, signing with the shared test key seeded into the JWT_SECRET store, so the
// accounts worker's validation accepts it. Kept inline to avoid a cross-package
// import.
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

const form = (fields: Record<string, string>): RequestInit => ({
	method: 'PUT',
	headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
	body: new URLSearchParams(fields).toString(),
})

describe('public endpoints', () => {
	test('GET / returns a health response', async () => {
		const res = await exports.default.fetch(`${ORIGIN}/`)
		expect(res.status).toBe(200)
		expect(await res.json()).toEqual({ service: 'accounts', status: 'ok' })
	})

	test('GET /account/:id returns a default account', async () => {
		const res = await exports.default.fetch(`${ORIGIN}/account/123`)
		expect(res.status).toBe(200)
		expect(await res.json()).toMatchObject({
			accountId: 123,
			username: 'Player123',
			displayName: 'Player123',
			profileImage: 'DefaultProfileImage.jpg',
		})
	})

	test('GET /account/:id rejects a non-numeric id', async () => {
		const res = await exports.default.fetch(`${ORIGIN}/account/abc`)
		expect(res.status).toBe(400)
	})

	test('GET /account/bulk resolves stored accounts and synthesizes the rest', async () => {
		const res = await exports.default.fetch(`${ORIGIN}/account/bulk?id=1&id=2,3`)
		expect(res.status).toBe(200)
		const accounts = (await res.json()) as Array<{ accountId: number; username: string }>
		// Every requested id is present and in order.
		expect(accounts.map((a) => a.accountId)).toEqual([1, 2, 3])
		// id 1 is the seeded Coach account; 2 and 3 fall back to synthesized defaults.
		expect(accounts[0].username).toBe('Coach')
		expect(accounts[1].username).toBe('Player2')
	})

	test('GET /account/search prefix-matches usernames, returns public DTOs', async () => {
		const res = await exports.default.fetch(`${ORIGIN}/account/search?name=coa`)
		expect(res.status).toBe(200)
		const accounts = (await res.json()) as Array<{ accountId: number; username: string }>
		// "Coach" (seeded uid 1) matches the "coa" prefix, case-insensitively.
		expect(accounts.some((a) => a.accountId === 1 && a.username === 'Coach')).toBe(true)
		// A non-matching prefix yields nothing.
		const none = await exports.default.fetch(`${ORIGIN}/account/search?name=zzzznope`)
		expect(await none.json()).toEqual([])
		// An empty query yields nothing (no full-table dump).
		const empty = await exports.default.fetch(`${ORIGIN}/account/search?name=`)
		expect(await empty.json()).toEqual([])
	})

	test('GET /account/:id/bio returns an empty bio', async () => {
		const res = await exports.default.fetch(`${ORIGIN}/account/7/bio`)
		expect(await res.json()).toEqual({ accountId: 7, bio: '' })
	})

	test('POST /account/create persists a new account with a random username', async () => {
		const res = await exports.default.fetch(`${ORIGIN}/account/create`, { method: 'POST' })
		expect(res.status).toBe(200)
		const body = (await res.json()) as {
			success: boolean
			value: { accountId: number; username: string; displayName: string }
		}
		expect(body.success).toBe(true)
		// Id is allocated above the seeded system accounts (0, 1).
		expect(body.value.accountId).toBeGreaterThanOrEqual(2)
		// Username is auto-assigned (not the synthesized "Player<id>" fallback) and
		// the display name mirrors it.
		expect(body.value.username).not.toMatch(/^Player\d+$/)
		expect(body.value.username.length).toBeGreaterThan(0)
		expect(body.value.displayName).toBe(body.value.username)
		// It's retrievable afterwards.
		const lookup = await exports.default.fetch(`${ORIGIN}/account/${body.value.accountId}`)
		const found = (await lookup.json()) as { username: string }
		expect(found.username).toBe(body.value.username)
	})
})

describe('auth-gated endpoints', () => {
	test('GET /account/me 401s without a token', async () => {
		const res = await exports.default.fetch(`${ORIGIN}/account/me`)
		expect(res.status).toBe(401)
	})

	test('GET /account/me 401s with a garbage token', async () => {
		const res = await exports.default.fetch(`${ORIGIN}/account/me`, {
			headers: { Authorization: 'Bearer not-a-real-token' },
		})
		expect(res.status).toBe(401)
	})

	test('GET /account/me returns the self account with a valid token', async () => {
		const res = await exports.default.fetch(`${ORIGIN}/account/me`, { headers: await bearer() })
		expect(res.status).toBe(200)
		const body = (await res.json()) as Record<string, unknown>
		// Account JSON is camelCase (the client's AccountDTO), not the PascalCase we
		// store internally.
		expect(body).toMatchObject({
			accountId: 42,
			username: 'Player42',
			personalPronouns: 0,
			identityFlags: 0,
			availableUsernameChanges: 1,
			// An unset email is "", not null — the client reads it as a string, and the
			// hub frame this DTO also rides drops null values outright.
			email: '',
			// Nothing sets these yet, but the key has to be present — the client reads
			// both off the account DTO.
			bannerImage: '',
			displayEmoji: '',
		})
		// juniorState + parentAccountId must be omitted when null, not emitted as
		// null, or the client's enum parser throws on `juniorState`. `phone` isn't
		// part of the shape.
		expect('juniorState' in body).toBe(false)
		expect('parentAccountId' in body).toBe(false)
		expect('phone' in body).toBe(false)
	})

	test('GET /parentalcontrol/me returns the flags', async () => {
		const res = await exports.default.fetch(`${ORIGIN}/parentalcontrol/me`, {
			headers: await bearer(),
		})
		expect(await res.json()).toEqual({ accountId: 42, disallowInAppPurchases: false })
	})

	test('GET /accountprivacysettings/:id echoes the id with the privacy flags', async () => {
		// A bare {} fails the client's deserializer, so the fields have to be there.
		const res = await exports.default.fetch(`${ORIGIN}/accountprivacysettings/145`)
		expect(res.status).toBe(200)
		expect(await res.json()).toEqual({ accountId: 145, isRecentHistoryVisible: true })
	})

	test('PUT /account/me/displayname 401s without a token', async () => {
		const res = await exports.default.fetch(`${ORIGIN}/account/me/displayname`, {
			...form({ displayName: 'Bob' }),
		})
		expect(res.status).toBe(401)
	})

	test('PUT /account/me/displayname persists the display name', async () => {
		const headers = {
			...(await bearer('895')),
			'Content-Type': 'application/x-www-form-urlencoded',
		}
		const res = await exports.default.fetch(`${ORIGIN}/account/me/displayname`, {
			...form({ displayName: 'laskdjfasdlfkj' }),
			headers,
		})
		expect(res.status).toBe(200)
		expect(await res.json()).toEqual({ success: true })

		const me = await exports.default.fetch(`${ORIGIN}/account/me`, { headers: await bearer('895') })
		expect(((await me.json()) as { displayName: string }).displayName).toBe('laskdjfasdlfkj')
	})

	test('PUT /account/me/username 401s without a token', async () => {
		const res = await exports.default.fetch(`${ORIGIN}/account/me/username`, {
			...form({ username: 'whoever' }),
		})
		expect(res.status).toBe(401)
	})

	test('PUT /account/me/username returns a Success:false envelope for a taken name', async () => {
		// "Coach" is the seeded account 1.
		const res = await exports.default.fetch(`${ORIGIN}/account/me/username`, {
			...form({ username: 'Coach' }),
			headers: { ...(await bearer('893')), 'Content-Type': 'application/x-www-form-urlencoded' },
		})
		// Business errors are HTTP 200 with the { success, error, value } envelope.
		expect(res.status).toBe(200)
		const body = (await res.json()) as { success: boolean; error: string; value: string }
		expect(body.success).toBe(false)
		expect(body.error).toMatch(/already taken/i)
		expect(body.value).toBe('')
	})

	test('PUT /account/me/username changes the name, decrements the counter, then blocks', async () => {
		const headers = {
			...(await bearer('892')),
			'Content-Type': 'application/x-www-form-urlencoded',
		}
		// First change succeeds — value is the updated account.
		const ok = await exports.default.fetch(`${ORIGIN}/account/me/username`, {
			...form({ username: 'coachx' }),
			headers,
		})
		expect(ok.status).toBe(200)
		const okBody = (await ok.json()) as {
			success: boolean
			error: string
			value: { accountId: number; username: string }
		}
		expect(okBody.success).toBe(true)
		expect(okBody.error).toBe('')
		expect(okBody.value).toMatchObject({ accountId: 892, username: 'coachx' })

		// /account/me reflects the new name and the decremented counter.
		const me = (await (
			await exports.default.fetch(`${ORIGIN}/account/me`, { headers: await bearer('892') })
		).json()) as { username: string; availableUsernameChanges: number }
		expect(me.username).toBe('coachx')
		expect(me.availableUsernameChanges).toBe(0)

		// A second change is blocked — no changes remaining (still HTTP 200).
		const blocked = await exports.default.fetch(`${ORIGIN}/account/me/username`, {
			...form({ username: 'coachy' }),
			headers,
		})
		expect(blocked.status).toBe(200)
		const blockedBody = (await blocked.json()) as { success: boolean; error: string }
		expect(blockedBody.success).toBe(false)
		expect(blockedBody.error).toMatch(/no username changes/i)
	})

	test('PUT /account/me/profileimage 401s without a token', async () => {
		const res = await exports.default.fetch(`${ORIGIN}/account/me/profileimage`, {
			...form({ imageName: 'abc.jpg' }),
		})
		expect(res.status).toBe(401)
	})

	test('PUT /account/me/profileimage 400s without an imageName', async () => {
		const res = await exports.default.fetch(`${ORIGIN}/account/me/profileimage`, {
			...form({}),
			headers: { ...(await bearer('777')), 'Content-Type': 'application/x-www-form-urlencoded' },
		})
		expect(res.status).toBe(400)
	})

	test('PUT /account/me/profileimage persists the avatar on the account', async () => {
		const res = await exports.default.fetch(`${ORIGIN}/account/me/profileimage`, {
			...form({ imageName: 'deadbeef.jpg' }),
			headers: { ...(await bearer('777')), 'Content-Type': 'application/x-www-form-urlencoded' },
		})
		expect(res.status).toBe(200)
		expect(await res.json()).toEqual({ success: true })

		// The stored value is returned by the self account (no hardcoded override).
		const me = await exports.default.fetch(`${ORIGIN}/account/me`, { headers: await bearer('777') })
		expect(((await me.json()) as { profileImage: string }).profileImage).toBe('deadbeef.jpg')
	})

	test('PUT /account/me/identityflags 401s without a token', async () => {
		const res = await exports.default.fetch(`${ORIGIN}/account/me/identityflags`, {
			...form({ identityFlags: '384' }),
		})
		expect(res.status).toBe(401)
	})

	test('PUT /account/me/identityflags 400s on a non-numeric value', async () => {
		const res = await exports.default.fetch(`${ORIGIN}/account/me/identityflags`, {
			...form({ identityFlags: 'nope' }),
			headers: { ...(await bearer('889')), 'Content-Type': 'application/x-www-form-urlencoded' },
		})
		expect(res.status).toBe(400)
	})

	test('PUT /account/me/identityflags persists the flags, surfaced by /account/me', async () => {
		const res = await exports.default.fetch(`${ORIGIN}/account/me/identityflags`, {
			...form({ identityFlags: '384' }),
			headers: { ...(await bearer('889')), 'Content-Type': 'application/x-www-form-urlencoded' },
		})
		expect(res.status).toBe(200)
		expect(await res.json()).toEqual({ success: true })

		const me = await exports.default.fetch(`${ORIGIN}/account/me`, { headers: await bearer('889') })
		expect(((await me.json()) as { identityFlags: number }).identityFlags).toBe(384)
	})

	test('POST /account/me/phone 401s without a token', async () => {
		const res = await exports.default.fetch(`${ORIGIN}/account/me/phone`, {
			method: 'POST',
			headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
			body: 'phone=%2B14444444444',
		})
		expect(res.status).toBe(401)
	})

	test('POST /account/me/phone 400s on empty, persists a real number', async () => {
		const headers = {
			...(await bearer('891')),
			'Content-Type': 'application/x-www-form-urlencoded',
		}
		// Empty phone → 400.
		const empty = await exports.default.fetch(`${ORIGIN}/account/me/phone`, {
			method: 'POST',
			headers,
			body: 'phone=',
		})
		expect(empty.status).toBe(400)

		// Set it → success.
		const res = await exports.default.fetch(`${ORIGIN}/account/me/phone`, {
			method: 'POST',
			headers,
			body: 'phone=%2B14444444444',
		})
		expect(res.status).toBe(200)
		expect(await res.json()).toEqual({ success: true })
	})

	test('PUT /account/me/personalpronouns persists the value, surfaced by /account/me', async () => {
		const res = await exports.default.fetch(`${ORIGIN}/account/me/personalpronouns`, {
			...form({ pronounFlags: '2' }),
			headers: { ...(await bearer('894')), 'Content-Type': 'application/x-www-form-urlencoded' },
		})
		expect(res.status).toBe(200)
		expect(await res.json()).toEqual({ success: true })

		const me = await exports.default.fetch(`${ORIGIN}/account/me`, { headers: await bearer('894') })
		expect(((await me.json()) as { personalPronouns: number }).personalPronouns).toBe(2)
	})

	test('PUT /account/me/bio 401s without a token', async () => {
		const res = await exports.default.fetch(`${ORIGIN}/account/me/bio`, { ...form({ bio: 'x' }) })
		expect(res.status).toBe(401)
	})

	test('PUT /account/me/bio persists the bio, read back via GET /account/:id/bio', async () => {
		const res = await exports.default.fetch(`${ORIGIN}/account/me/bio`, {
			...form({ bio: 'Devin!' }),
			headers: { ...(await bearer('890')), 'Content-Type': 'application/x-www-form-urlencoded' },
		})
		expect(res.status).toBe(200)
		expect(await res.json()).toEqual({ success: true })

		const bio = await exports.default.fetch(`${ORIGIN}/account/890/bio`)
		expect(await bio.json()).toEqual({ accountId: 890, bio: 'Devin!' })
	})

	test('POST /account/me/email 401s without a token', async () => {
		const res = await exports.default.fetch(`${ORIGIN}/account/me/email`, {
			...form({ email: 'a@b.com' }),
			method: 'POST',
		})
		expect(res.status).toBe(401)
	})

	test('POST /account/me/email 400s on a malformed email', async () => {
		const res = await exports.default.fetch(`${ORIGIN}/account/me/email`, {
			...form({ email: 'notanemail' }),
			method: 'POST',
			headers: { ...(await bearer('888')), 'Content-Type': 'application/x-www-form-urlencoded' },
		})
		expect(res.status).toBe(400)
	})

	test('POST /account/me/email persists the email, surfaced by /account/me', async () => {
		const res = await exports.default.fetch(`${ORIGIN}/account/me/email`, {
			...form({ email: 'ners@recroom.com' }),
			method: 'POST',
			headers: { ...(await bearer('888')), 'Content-Type': 'application/x-www-form-urlencoded' },
		})
		expect(res.status).toBe(200)
		expect(await res.json()).toEqual({ success: true })

		// The stored email is now returned by the self account (was a null stub).
		const me = await exports.default.fetch(`${ORIGIN}/account/me`, { headers: await bearer('888') })
		expect(((await me.json()) as { email: string }).email).toBe('ners@recroom.com')
	})

	test('GET /openapi.json documents every route', async () => {
		const res = await exports.default.fetch(`${ORIGIN}/openapi.json`)
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
		// an incomplete spec. Hono's `:param` syntax becomes OpenAPI's `{param}`.
		const documented = new Set(
			Object.entries(spec.paths).flatMap(([path, ops]) =>
				Object.keys(ops).map((method) => `${method.toUpperCase()} ${path}`)
			)
		)
		expect([...documented].sort()).toEqual([
			'GET /',
			'GET /account/bulk',
			'GET /account/me',
			'GET /account/search',
			'GET /account/{id}',
			'GET /account/{id}/bio',
			'GET /accountprivacysettings/{id}',
			'GET /parentalcontrol/me',
			'POST /account/create',
			'POST /account/me/email',
			'POST /account/me/phone',
			'PUT /account/me/bio',
			'PUT /account/me/displayname',
			'PUT /account/me/identityflags',
			'PUT /account/me/personalpronouns',
			'PUT /account/me/profileimage',
			'PUT /account/me/username',
		])

		// Every operation carries a summary — a path present but undescribed is not
		// documentation.
		for (const ops of Object.values(spec.paths)) {
			for (const op of Object.values(ops)) expect(op.summary).toBeTruthy()
		}
	})

	// hono-openapi registers a validated form body under `multipart/form-data` only, and
	// its `media` option can't say otherwise (a precedence bug — see `withCleanSpec`). The
	// real callers post `application/x-www-form-urlencoded`, so a spec that named only
	// multipart would tell an integrator to send the one thing nothing here sends.
	test('GET /openapi.json documents both form content types on validated routes', async () => {
		const res = await exports.default.fetch(`${ORIGIN}/openapi.json`)
		const spec = (await res.json()) as {
			paths: Record<string, Record<string, { requestBody?: { content: Record<string, unknown> } }>>
		}

		for (const [path, method] of [
			['/account/me/email', 'post'],
			['/account/me/username', 'put'],
			['/account/me/displayname', 'put'],
			['/account/me/bio', 'put'],
			['/account/me/phone', 'post'],
		] as const) {
			const content = spec.paths[path]?.[method]?.requestBody?.content ?? {}
			expect(Object.keys(content).sort(), path).toEqual([
				'application/x-www-form-urlencoded',
				'multipart/form-data',
			])
		}
	})
})

// The names a player chooses are alphanumeric and length-capped, by the same rule the
// `rooms` worker applies (see `nameRejection` in @repo/domain). The three limits come
// from the client's own input boxes rather than a round number, so anything stored is
// something the game can render and re-edit.
//
// Server-generated names go around this deliberately — the seeded "Rec Room" account
// above has a space in its display name, and dorms are called `@<username>'s Dorm`. The
// check belongs at the request handler, not in the db helpers.
describe('name, email and bio validation', () => {
	const authed = async (sub: string) => ({
		...(await bearer(sub)),
		'Content-Type': 'application/x-www-form-urlencoded',
	})

	test('PUT /account/me/username refuses anything but letters and digits, max 50', async () => {
		const headers = await authed('8801')
		for (const username of ['has space', 'under_score', 'punct!', 'café', 'a'.repeat(51)]) {
			const res = await exports.default.fetch(`${ORIGIN}/account/me/username`, {
				...form({ username }),
				headers,
			})
			// Refused by the SCHEMA (see openapi.ts `UsernameRequest`) before the handler
			// runs — but still the envelope at HTTP 200, like every other refusal here,
			// because the hook puts it there.
			expect(res.status, username).toBe(200)
			const body = (await res.json()) as { success: boolean; error: string; value: string }
			expect(body.success, username).toBe(false)
			expect(body.error).toMatch(/letters and numbers|at most 50 characters/)
			expect(body.value).toBe('')
		}

		// The rationed change must NOT be spent by a refusal: an account starts with one,
		// and burning it on a typo would leave the player stuck with a name they never had.
		const me = (await (
			await exports.default.fetch(`${ORIGIN}/account/me`, { headers: await bearer('8801') })
		).json()) as { availableUsernameChanges: number }
		expect(me.availableUsernameChanges).toBe(1)

		// 50 is the client's own cap, so a name that long has to be accepted.
		const ok = await exports.default.fetch(`${ORIGIN}/account/me/username`, {
			...form({ username: 'a'.repeat(50) }),
			headers,
		})
		expect(((await ok.json()) as { success: boolean }).success).toBe(true)
	})

	test('PUT /account/me/displayname refuses anything but letters and digits, max 15', async () => {
		const headers = await authed('8802')
		for (const displayName of ['has space', 'punct!', 'a'.repeat(16)]) {
			const res = await exports.default.fetch(`${ORIGIN}/account/me/displayname`, {
				...form({ displayName }),
				headers,
			})
			// An empty 400, matching what this route already answers for an empty name —
			// it acks with a bare `{ success: true }` and has never sent the client a body
			// on failure.
			expect(res.status, displayName).toBe(400)
		}

		// 15 is the client's box, so it must fit.
		const ok = await exports.default.fetch(`${ORIGIN}/account/me/displayname`, {
			...form({ displayName: 'a'.repeat(15) }),
			headers,
		})
		expect(ok.status).toBe(200)
	})

	// Syntax comes from the `isemail` package rather than a pattern written here — this is
	// a contact address nothing is ever sent to in order to prove it, so a hand-rolled
	// regex only buys more edge cases to get wrong. It enforces the RFC's own
	// 254-character maximum, which is why there's no separate length check.
	test('POST /account/me/email requires a syntactically valid address', async () => {
		const headers = await authed('8803')
		const bad = [
			'nope', // no @ at all — what this route used to be the only check for
			'@example.com', // nothing to deliver to
			'someone@', // no domain
			'someone@example.', // empty last label
			'two words@example.com', // whitespace
			`${'a'.repeat(250)}@example.com`, // past the RFC's 254
		]
		for (const email of bad) {
			const res = await exports.default.fetch(`${ORIGIN}/account/me/email`, {
				...form({ email }),
				method: 'POST',
				headers,
			})
			expect(res.status, email).toBe(400)
		}

		// `someone@localhost` is in the ACCEPTED list on purpose: it's valid per the RFC,
		// and an undeliverable address costs nothing here.
		for (const email of [
			'someone@example.com',
			'first.last+tag@mail.example.co.uk',
			'someone@localhost',
		]) {
			const res = await exports.default.fetch(`${ORIGIN}/account/me/email`, {
				...form({ email }),
				method: 'POST',
				headers,
			})
			expect(res.status, email).toBe(200)
		}
	})

	test('PUT /account/me/bio caps the stored text at 255 characters', async () => {
		const headers = await authed('8804')

		const ok = await exports.default.fetch(`${ORIGIN}/account/me/bio`, {
			...form({ bio: 'b'.repeat(255) }),
			headers,
		})
		expect(ok.status).toBe(200)

		// Refused rather than truncated — storing half a sentence reads as data loss.
		const tooLong = await exports.default.fetch(`${ORIGIN}/account/me/bio`, {
			...form({ bio: 'b'.repeat(256) }),
			headers,
		})
		expect(tooLong.status).toBe(400)

		// The refusal changed nothing: the 255-character bio is still what's stored.
		const me = await exports.default.fetch(`${ORIGIN}/account/8804/bio`)
		expect(((await me.json()) as { bio: string }).bio).toBe('b'.repeat(255))
	})
})

// Phone is deliberately NOT held to the name rule above: the client sends E.164
// (`+15552223333`), so a letters-and-digits check would reject every real number by
// eating the leading `+`. Pinned here because this route sits between two that DID just
// get stricter, and the obvious next "cleanup" is to make it match them.
test('POST /account/me/phone stores an E.164 number exactly as the client sends it', async () => {
	const res = await exports.default.fetch(`${ORIGIN}/account/me/phone`, {
		...form({ phone: '+15552223333' }),
		method: 'POST',
		headers: { ...(await bearer('8805')), 'Content-Type': 'application/x-www-form-urlencoded' },
	})
	expect(res.status).toBe(200)
	expect(await res.json()).toEqual({ success: true })

	// Read from the row: phone is stored but not surfaced by any DTO, so there's no
	// endpoint to check it through.
	const row = await env.DB.prepare(
		"SELECT json_extract(data, '$.phone') AS phone FROM account WHERE json_extract(data, '$.accountId') = 8805"
	).first<{ phone: string }>()
	// Verbatim — no normalising, no stripping of the +.
	expect(row?.phone).toBe('+15552223333')
})
