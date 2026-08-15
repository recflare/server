import { adminSecretsStore, env } from 'cloudflare:test'
import { exports } from 'cloudflare:workers'
import { beforeAll, describe, expect, test } from 'vitest'

import '../../auth.app'

import {
	GAME_VERSION,
	getAccountsByDeviceId,
	hashPassword,
	PRESENCE_SCHEMA_DDL,
	ROOM_SCHEMA_DDL,
	SCHEMA_DDL,
	seedRoomWithSubRooms,
	SUBROOM_SCHEMA_DDL,
} from '@repo/domain'
import { TOKEN_TTL_SECONDS } from '@repo/jwt'

import {
	banFromReport,
	createReport,
	SCHEMA_DDL as REPORTS_SCHEMA_DDL,
} from '../../../../api/src/reports-db'
import {
	getLinksForAccount,
	linkPlatformIdentity,
	PLATFORM_BACKFILL_SQL,
	PLATFORM_SCHEMA_DDL,
} from '../../platform-db'
import { REFRESH_SCHEMA_DDL } from '../../refresh-db'

import type { Env } from '../../context'

declare module 'cloudflare:test' {
	interface ProvidedEnv extends Env {}
}

const ORIGIN = 'https://example.com'

// The Orientation room (RoomId 13) new accounts are placed into on signup.
const ORIENTATION_SCENE = 'c79709d8-a31b-48aa-9eb8-cc31ba9505e8'

// Credential login requires the account's password; seed a known one for the
// accounts the login tests authenticate as (42, 77).
const LOGIN_PASSWORD = 'correct-horse'

// Meta (Oculus) logins verify their nonce by calling graph.oculus.com authenticated
// as the app, so the tests seed an app secret and stub that call — see metaLogin.
const META_APP_SECRET = 'test-meta-app-secret'
const META_APP_ID = '1232175103309633'
const META_USER_ID = '27061366730207360'
const META_NONCE = 'xOUoGXJtC2N31BRDtoWJqBNo81o3DwfbQC57i9ApaiBIqkgmyMOgMYIng7c5jL5I'
/** Set in beforeAll; needed to overwrite the secret in the not-configured test. */
let metaSecretId: string

// Apply the accounts schema so create_account can persist (mirrors the migration),
// and seed the Orientation room (owned by the rooms worker) so signup can place
// the new player there.
beforeAll(async () => {
	// Seed the shared JWT signing key into the local Secrets Store so .get() resolves.
	await adminSecretsStore(env.JWT_SECRET).create('test-signing-key')
	// The Meta app secret, likewise — a Meta login is refused outright without one.
	metaSecretId = await adminSecretsStore(env.META_APP_SECRET).create(META_APP_SECRET)
	for (const stmt of SCHEMA_DDL) await env.DB.prepare(stmt).run()
	for (const stmt of REFRESH_SCHEMA_DDL) await env.DB.prepare(stmt).run()
	// Platform identity links — one account can hold several (a PC and a headset), and
	// this table is what both the picker and the cached_login grant read.
	for (const stmt of PLATFORM_SCHEMA_DDL) await env.DB.prepare(stmt).run()
	// Presence table (owned by the rooms worker) — signup seeds the Orientation row.
	for (const stmt of PRESENCE_SCHEMA_DDL) await env.DB.prepare(stmt).run()

	// Seed the accounts the credential-login tests use, each with LOGIN_PASSWORD set.
	const hash = await hashPassword(LOGIN_PASSWORD)
	for (const id of [42, 77]) {
		await env.DB.prepare('INSERT OR IGNORE INTO account (data) VALUES (?1)')
			.bind(JSON.stringify({ accountId: id, username: `Player${id}`, passwordHash: hash }))
			.run()
	}
	// The rooms worker's schema (room + interaction) — reading a room aggregates its
	// cheer/favorite Stats from `interaction`, so both tables have to be here.
	for (const stmt of ROOM_SCHEMA_DDL) await env.DB.prepare(stmt).run()
	// Subrooms live in their own table; seed the Orientation room and split its subroom into it.
	for (const stmt of SUBROOM_SCHEMA_DDL) await env.DB.prepare(stmt).run()
	await seedRoomWithSubRooms(env.DB, {
		RoomId: 13,
		Name: 'Orientation',
		IsDorm: false,
		SubRooms: [{ SubRoomId: 23, UnitySceneId: ORIENTATION_SCENE, MaxPlayers: 1 }],
	})
	// Report table (owned by the api worker) — a banned account is refused a token, and
	// a ban is a report row with `banned` set.
	for (const stmt of REPORTS_SCHEMA_DDL) await env.DB.prepare(stmt).run()
})

/**
 * Ban an account the way a moderator would: file a report against it and convert that
 * report into a ban. `banExpires` null is a permanent ban.
 */
async function banAccount(accountId: number, banExpires: string | null = null): Promise<void> {
	const row = await createReport(env.DB, { reporterPlayerId: 1, reportedPlayerId: accountId })
	await banFromReport(env.DB, row.id, { banExpires })
}

/** Seed an account with LOGIN_PASSWORD set, so it can be logged into. */
async function seedAccount(accountId: number, username: string): Promise<void> {
	await env.DB.prepare('INSERT OR IGNORE INTO account (data) VALUES (?1)')
		.bind(JSON.stringify({ accountId, username, passwordHash: await hashPassword(LOGIN_PASSWORD) }))
		.run()
}

/** Decode a JWT payload (no verification) for asserting claims. */
function decodePayload(token: string): Record<string, unknown> {
	const part = token.split('.')[1].replace(/-/g, '+').replace(/_/g, '/')
	return JSON.parse(
		new TextDecoder().decode(Uint8Array.from(atob(part), (ch) => ch.charCodeAt(0)))
	) as Record<string, unknown>
}

async function accessTokenFor(body: string, ip?: string): Promise<string> {
	return (await postToken(body, ip)).json.access_token as string
}

async function tokenFor(body: string, ip?: string): Promise<Record<string, unknown>> {
	return decodePayload(await accessTokenFor(body, ip))
}

/**
 * POST a form-urlencoded body to /connect/token, returning status + parsed JSON.
 * `ip` sets CF-Connecting-IP (what Cloudflare's edge sets in production); omit it and
 * the request looks IP-less, which is how the other tests dodge the per-IP signup cap.
 */
async function postToken(
	body: string,
	ip?: string
): Promise<{ status: number; json: Record<string, unknown> }> {
	const res = await exports.default.fetch(`${ORIGIN}/connect/token`, {
		method: 'POST',
		headers: {
			'Content-Type': 'application/x-www-form-urlencoded',
			...(ip ? { 'CF-Connecting-IP': ip } : {}),
		},
		body,
	})
	return { status: res.status, json: (await res.json()) as Record<string, unknown> }
}

/**
 * POST a Meta grant to /connect/token with graph.oculus.com stubbed to answer
 * `is_valid`. The worker runs in this isolate, so replacing the global fetch is what
 * stands in for Meta — `verifyMetaNonce` resolves `globalThis.fetch` per call for
 * exactly this reason. Returns the graph requests the worker made alongside the
 * response, so a test can assert WHICH user id the nonce was validated against.
 */
async function metaLogin(
	body: string,
	isValid: boolean
): Promise<{ status: number; json: Record<string, unknown>; graphCalls: URLSearchParams[] }> {
	const graphCalls: URLSearchParams[] = []
	const realFetch = globalThis.fetch
	globalThis.fetch = (async (url: string, init?: { body?: string }) => {
		if (url.startsWith('https://graph.oculus.com/')) {
			graphCalls.push(new URLSearchParams(init?.body ?? ''))
			return Response.json({ is_valid: isValid })
		}
		return realFetch(url, init)
	}) as unknown as typeof fetch
	try {
		return { ...(await postToken(body)), graphCalls }
	} finally {
		globalThis.fetch = realFetch
	}
}

/** GET a JSON route on the worker and parse the body as `T`. */
async function getJson<T>(path: string): Promise<T> {
	const res = await exports.default.fetch(`${ORIGIN}${path}`)
	return (await res.json()) as T
}

/** The picker entries a platform identity yields, as the client sees them. */
function cachedLogins(platform: number, id: string) {
	return getJson<Array<Record<string, unknown> & { accountId: number; platform: number }>>(
		`/cachedlogin/forplatformid/${platform}/${id}`
	)
}

/** The `platform_auth` payload a Meta client posts, as observed from a live login. */
function metaPlatformAuth(): string {
	return JSON.stringify({ Nonce: META_NONCE, AppId: META_APP_ID, Source: 'logged in user' })
}

/** POST a form-urlencoded body to changepassword with an optional bearer token. */
function changePassword(body: string, token?: string): Promise<Response> {
	return exports.default.fetch(`${ORIGIN}/account/me/changepassword`, {
		method: 'POST',
		headers: {
			...(token ? { Authorization: `Bearer ${token}` } : {}),
			'Content-Type': 'application/x-www-form-urlencoded',
		},
		body,
	})
}

describe('auth worker routes', () => {
	test('GET /eac/challenge returns the EAC challenge as text/plain', async () => {
		const res = await exports.default.fetch(`${ORIGIN}/eac/challenge`)
		expect(res.status).toBe(200)
		expect(res.headers.get('content-type')).toContain('text/plain')
		// EAC challenge content (BOM is stripped on read).
		expect(await res.text()).toBe('"AA=="')
	})

	test.each([
		['0 (Steam)', 0],
		['1 (Meta)', 1],
	])(
		'GET /cachedlogin/forplatformid/%s/:id returns [] for an unknown id',
		async (_label, platform) => {
			const res = await exports.default.fetch(
				`${ORIGIN}/cachedlogin/forplatformid/${platform}/abc123`
			)
			expect(res.status).toBe(200)
			expect(await res.json()).toEqual([])
		}
	)

	// The one stubbed identity: `1/1` consults nothing and always answers the canned
	// entry, which is how a sideloaded APK (no Meta SDK, so no real identity) gets off
	// the platform login screen and onto username/password.
	test('GET /cachedlogin/forplatformid/1/1 returns the canned Oculus entry', async () => {
		const res = await exports.default.fetch(`${ORIGIN}/cachedlogin/forplatformid/1/1`)
		expect(res.status).toBe(200)
		expect(await res.json()).toEqual([
			{
				platform: 1,
				platformId: '1',
				accountId: 1,
				lastLoginTime: '2026-07-19T17:13:29.225Z',
				requirePassword: true,
			},
		])
	})

	// Only Steam (0) and Meta (1) can be verified — Steam by its signed platform_auth
	// ticket, Meta by validating its nonce with Meta. Every OTHER platform is rejected
	// on the platform-authenticated grants: we won't bind or authorize an identity we
	// can't prove.
	test.each([2, 3, 4, 5, 6, 7, 8])(
		'create_account rejects unverifiable platform %i',
		async (platform) => {
			const res = await postToken(
				`grant_type=create_account&platform=${platform}&platform_id=whoever`
			)
			expect(res.status).toBe(400)
			expect(res.json.error).toBe('invalid_grant')
			expect(res.json.error_description).toContain('only Steam and Meta')
		}
	)

	test.each([2, 3, 4, 5, 6, 7, 8])(
		'cached_login rejects unverifiable platform %i',
		async (platform) => {
			const res = await postToken(
				`grant_type=cached_login&account_id=42&platform=${platform}&platform_id=whoever`
			)
			expect(res.status).toBe(400)
			expect(res.json.error).toBe('invalid_grant')
			expect(res.json.error_description).toContain('only Steam and Meta')
		}
	)

	test('Steam create_account requires a valid platform_auth ticket', async () => {
		// platform=0 (Steam) with no verifiable ticket must not bind the spoofable
		// platform_id field — it's rejected outright.
		const res = await postToken(
			'grant_type=create_account&platform=0&platform_id=76561197962463211'
		)
		expect(res.status).toBe(400)
		expect(res.json.error).toBe('invalid_grant')
		expect(res.json.error_description).toContain('platform_auth')
	})

	test('Steam cached_login requires a valid platform_auth ticket', async () => {
		const res = await postToken(
			'grant_type=cached_login&account_id=42&platform=0&platform_id=76561197962463211'
		)
		expect(res.status).toBe(400)
		expect(res.json.error).toBe('invalid_grant')
		expect(res.json.error_description).toContain('platform_auth')
	})

	test('Meta create_account requires a platform_auth nonce', async () => {
		// platform=1 with no nonce must not bind the spoofable platform_id field.
		const res = await postToken(`grant_type=create_account&platform=1&platform_id=${META_USER_ID}`)
		expect(res.status).toBe(400)
		expect(res.json.error).toBe('invalid_grant')
		expect(res.json.error_description).toContain('platform_auth')
	})

	test('Meta create_account binds the id Meta validated the nonce against', async () => {
		const res = await metaLogin(
			`grant_type=create_account&platform=1&platform_id=${META_USER_ID}` +
				`&platform_auth=${encodeURIComponent(metaPlatformAuth())}&device_id=meta-device`,
			true
		)
		expect(res.status).toBe(200)

		// The nonce was validated against the posted user id, authenticated as the app.
		expect(res.graphCalls).toHaveLength(1)
		expect(res.graphCalls[0].get('nonce')).toBe(META_NONCE)
		expect(res.graphCalls[0].get('user_id')).toBe(META_USER_ID)
		expect(res.graphCalls[0].get('access_token')).toBe(`OC|${META_APP_ID}|${META_APP_SECRET}`)

		// The account is bound to platform 1 with that id — which is what makes the
		// cached-login picker offer it, and the cached_login grant accept it.
		const payload = decodePayload(res.json.access_token as string)
		const accountId = Number(payload.sub)
		const linked = await cachedLogins(1, META_USER_ID)
		expect(linked).toContainEqual(
			expect.objectContaining({ accountId, platform: 1, platformId: META_USER_ID })
		)
		// Platform ownership is the credential, so the client is not asked for a password.
		expect(linked.every((a) => a.requirePassword === false)).toBe(true)
	})

	test('Meta create_account is rejected when Meta does not vouch for the nonce', async () => {
		const res = await metaLogin(
			`grant_type=create_account&platform=1&platform_id=${META_USER_ID}` +
				`&platform_auth=${encodeURIComponent(metaPlatformAuth())}`,
			false
		)
		expect(res.status).toBe(400)
		expect(res.json.error).toBe('invalid_grant')
		expect(res.json.error_description).toContain('platform_auth')
	})

	test('Meta cached_login logs into the linked account with no password', async () => {
		const userId = '27061366730209999'
		await env.DB.prepare('INSERT OR IGNORE INTO account (data) VALUES (?1)')
			.bind(
				JSON.stringify({
					accountId: 5150,
					username: 'MetaPlayer',
					platform: 1,
					platformId: userId,
				})
			)
			.run()
		await linkPlatformIdentity(env.DB, 5150, 1, userId)
		const res = await metaLogin(
			`grant_type=cached_login&account_id=5150&platform=1&platform_id=${userId}` +
				`&platform_auth=${encodeURIComponent(metaPlatformAuth())}`,
			true
		)
		expect(res.status).toBe(200)
		expect(res.graphCalls[0].get('user_id')).toBe(userId)
		const payload = decodePayload(res.json.access_token as string)
		expect(payload.sub).toBe('5150')
	})

	test('a Meta user id cannot log into an account it is not linked to', async () => {
		// The Meta account seeded above, claimed by a different (but genuinely proven)
		// Meta user. Even with a nonce Meta vouches for, the identity has to be one the
		// account is actually linked to.
		const res = await metaLogin(
			`grant_type=cached_login&account_id=5150&platform=1&platform_id=${META_USER_ID}` +
				`&platform_auth=${encodeURIComponent(metaPlatformAuth())}`,
			true
		)
		expect(res.status).toBe(400)
		expect(res.json.error_description).toContain('no linked account')
	})

	test('a Meta login is refused (500) when META_APP_SECRET is unset', async () => {
		// An operator misconfiguration, not a bad credential: without the secret no nonce
		// can be validated, and the alternative — trusting the posted platform_id — would
		// let anyone log into any Meta-linked account by naming its user id.
		const admin = adminSecretsStore(env.META_APP_SECRET)
		await admin.update('', metaSecretId)
		try {
			const res = await metaLogin(
				`grant_type=create_account&platform=1&platform_id=${META_USER_ID}` +
					`&platform_auth=${encodeURIComponent(metaPlatformAuth())}`,
				true
			)
			expect(res.status).toBe(500)
			expect(res.json.error).toBe('server_error')
			// Nothing was asked of Meta, and nothing was trusted.
			expect(res.graphCalls).toHaveLength(0)
		} finally {
			await admin.update(META_APP_SECRET, metaSecretId)
		}
	})

	test('cachedlogin/forplatformid returns the DTO for a bound (Steam) account', async () => {
		// Seed a Steam-linked account directly (a real create_account needs a live
		// ticket); assert the picker projects the CachedLogin DTO the client expects.
		const steamId = '76561197962463299'
		await env.DB.prepare('INSERT OR IGNORE INTO account (data) VALUES (?1)')
			.bind(
				JSON.stringify({
					accountId: 31380,
					username: 'SteamPlayer',
					platform: 0,
					platformId: steamId,
					lastLoginTime: '2026-07-09T21:20:31.419Z',
				})
			)
			.run()
		await linkPlatformIdentity(env.DB, 31380, 0, steamId)
		const res = await exports.default.fetch(`${ORIGIN}/cachedlogin/forplatformid/0/${steamId}`)
		expect(res.status).toBe(200)
		expect(await res.json()).toEqual([
			{
				platform: 0,
				platformId: steamId,
				accountId: 31380,
				lastLoginTime: '2026-07-09T21:20:31.419Z',
				requirePassword: false,
			},
		])
	})

	// The 20250424.01 build POSTs the picker lookup with a platform-attestation form body
	// instead of GETting it. Nothing reads that body yet, so both methods must answer the
	// same list — otherwise the newer client's login screen comes up empty.
	test('POST /cachedlogin/forplatformid answers exactly what the GET answers', async () => {
		const steamId = '76561197962463211'
		await env.DB.prepare('INSERT OR IGNORE INTO account (data) VALUES (?1)')
			.bind(
				JSON.stringify({
					accountId: 31381,
					username: 'SteamPlayer2025',
					platform: 0,
					platformId: steamId,
					lastLoginTime: '2026-08-13T04:21:34.768Z',
				})
			)
			.run()
		await linkPlatformIdentity(env.DB, 31381, 0, steamId)

		// The body as the live client sends it: device id, the platform session ticket, a
		// timestamp. All ignored for now.
		const body = new URLSearchParams({
			deviceId: '69640e6ae1b54ae5b0ca8eeb4a8872ec6cf8fd88',
			platformAuth: JSON.stringify({ Ticket: '140000009C5F501B447424FF', AppId: '471710' }),
			time: '2026-08-13T04:21:34.7684754Z',
		}).toString()
		const posted = await exports.default.fetch(`${ORIGIN}/cachedlogin/forplatformid/0/${steamId}`, {
			method: 'POST',
			headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
			body,
		})
		expect(posted.status).toBe(200)
		const expected = [
			{
				platform: 0,
				platformId: steamId,
				accountId: 31381,
				lastLoginTime: '2026-08-13T04:21:34.768Z',
				requirePassword: false,
			},
		]
		expect(await posted.json()).toEqual(expected)
		expect(await cachedLogins(0, steamId)).toEqual(expected)
	})

	// A POST with no body at all still resolves — the client's body is never consulted.
	test('POST /cachedlogin/forplatformid/1/1 still returns the canned Oculus entry', async () => {
		const res = await exports.default.fetch(`${ORIGIN}/cachedlogin/forplatformid/1/1`, {
			method: 'POST',
		})
		expect(res.status).toBe(200)
		expect(await res.json()).toMatchObject([{ accountId: 1, requirePassword: true }])
	})

	test('one account, a Steam and a Meta identity: both pickers offer it', async () => {
		// The point of the link table. The same account is reachable from the PC and from
		// the headset, and each picker reports the identity IT was asked about — that's
		// what the client posts back on the cached_login grant.
		const steamId = '76561197962463777'
		const metaId = '27061366730207777'
		await env.DB.prepare('INSERT OR IGNORE INTO account (data) VALUES (?1)')
			.bind(
				JSON.stringify({
					accountId: 6200,
					username: 'CrossPlatform',
					platform: 0,
					platformId: steamId,
					lastLoginTime: '2026-08-01T10:00:00.000Z',
				})
			)
			.run()
		await linkPlatformIdentity(env.DB, 6200, 0, steamId)
		await linkPlatformIdentity(env.DB, 6200, 1, metaId)

		const onSteam = await cachedLogins(0, steamId)
		const onMeta = await cachedLogins(1, metaId)

		expect(onSteam).toEqual([
			expect.objectContaining({ accountId: 6200, platform: 0, platformId: steamId }),
		])
		expect(onMeta).toEqual([
			expect.objectContaining({ accountId: 6200, platform: 1, platformId: metaId }),
		])

		// And the grant accepts both, without a password.
		const viaMeta = await metaLogin(
			`grant_type=cached_login&account_id=6200&platform=1&platform_id=${metaId}` +
				`&platform_auth=${encodeURIComponent(metaPlatformAuth())}`,
			true
		)
		expect(viaMeta.status).toBe(200)
		expect(decodePayload(viaMeta.json.access_token as string).sub).toBe('6200')
	})

	test('the picker and the cached_login grant read the same table', async () => {
		// Regression: the picker used to derive links from the account blob (treating a
		// missing `platform` as Steam) while the grant ran its own check, so the client
		// could be handed an account_id that answered "no linked account" forever. Both
		// now read platform_account, which is why an account with a stale blob identity
		// is NOT offered — and, since it isn't offered, never rejected either.
		const steamId = '76561197962463211'
		await env.DB.prepare('INSERT OR IGNORE INTO account (data) VALUES (?1)')
			.bind(JSON.stringify({ accountId: 8, username: 'SteamOnly', platformId: steamId }))
			.run()

		// No link row yet: not offered.
		const before = await cachedLogins(0, steamId)
		expect(before.map((a) => a.accountId)).not.toContain(8)

		// The 0007 backfill is what gives accounts like this one — bound before the link
		// table existed, and carrying no `platform` field at all — their link.
		await env.DB.prepare(PLATFORM_BACKFILL_SQL).run()

		const after = await cachedLogins(0, steamId)
		expect(after.map((a) => a.accountId)).toContain(8)
		// COALESCEd to Steam, which is what an unset platform meant.
		expect(after.find((a) => a.accountId === 8)?.platform).toBe(0)
	})

	test('POST /connect/token issues a bearer token with role/scope claims', async () => {
		const res = await exports.default.fetch(`${ORIGIN}/connect/token`, {
			method: 'POST',
			headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
			body: `account_id=42&platform_id=steam-123&password=${LOGIN_PASSWORD}`,
		})
		expect(res.status).toBe(200)
		const json = (await res.json()) as {
			access_token: string
			token_type: string
			expires_in: number
		}
		expect(json.token_type).toBe('Bearer')
		expect(json.expires_in).toBe(TOKEN_TTL_SECONDS)
		// header.payload.signature
		const parts = json.access_token.split('.')
		expect(parts).toHaveLength(3)

		// The client reads these claims to authorize itself; decode and assert them.
		const payload = JSON.parse(
			new TextDecoder().decode(
				Uint8Array.from(atob(parts[1].replace(/-/g, '+').replace(/_/g, '/')), (ch) =>
					ch.charCodeAt(0)
				)
			)
		) as Record<string, unknown>
		expect(payload.sub).toBe('42') // account_id from the body is honored
		expect(payload.iss).toBe('https://auth.recflare.net')
		expect(payload.aud).toBe('https://auth.recflare.net')
		expect(payload.role).toContain('gameClient')
		// screenshare is a feature gate, not a grant — every token carries it.
		expect(payload.role).toContain('screenshare')
		// A plain adult account carries nothing beyond those — no elevated roles.
		expect(payload.role).not.toContain('developer')
		expect(payload.role).not.toContain('moderator')
		expect(payload.role).not.toContain('junior')
		// No privileges to carry, so the claim is absent rather than an empty array.
		expect(payload['rn.privilege']).toBeUndefined()
		expect(payload.scope).toContain('rn.api')
	})

	// `rn.ver` is the CLIENT's build, from the `ver` it posts here — presence in `match`
	// reads it back off the token, so this is what a player is reported as running.
	test('POST /connect/token stamps the posted ver into rn.ver', async () => {
		const payload = await tokenFor(`account_id=42&password=${LOGIN_PASSWORD}&ver=20250718.01`)
		expect(payload['rn.ver']).toBe('20250718.01')
	})

	// A grant that names no build — a refresh, or a caller that isn't the game — falls
	// back to the server's GAME_VERSION rather than stamping an empty claim, which would
	// leave presence carrying an empty version.
	test('POST /connect/token falls back to GAME_VERSION with no ver', async () => {
		expect((await tokenFor(`account_id=42&password=${LOGIN_PASSWORD}`))['rn.ver']).toBe(
			GAME_VERSION
		)
		expect((await tokenFor(`account_id=42&password=${LOGIN_PASSWORD}&ver=`))['rn.ver']).toBe(
			GAME_VERSION
		)
	})

	test('POST /connect/token stamps developer/moderator roles into the token', async () => {
		await env.DB.prepare('INSERT OR IGNORE INTO account (data) VALUES (?1)')
			.bind(
				JSON.stringify({
					accountId: 91,
					username: 'StaffPlayer',
					passwordHash: await hashPassword(LOGIN_PASSWORD),
					isDeveloper: true,
					isModerator: true,
				})
			)
			.run()
		const payload = await tokenFor(`account_id=91&password=${LOGIN_PASSWORD}`)
		expect(payload.role).toEqual(expect.arrayContaining(['gameClient', 'developer', 'moderator']))
	})

	test('POST /connect/token stamps the junior role for an isJunior account', async () => {
		await env.DB.prepare('INSERT OR IGNORE INTO account (data) VALUES (?1)')
			.bind(
				JSON.stringify({
					accountId: 92,
					username: 'JuniorPlayer',
					passwordHash: await hashPassword(LOGIN_PASSWORD),
					isJunior: true,
				})
			)
			.run()
		const payload = await tokenFor(`account_id=92&password=${LOGIN_PASSWORD}`)
		expect(payload.role).toEqual(expect.arrayContaining(['gameClient', 'screenshare', 'junior']))
		expect(payload.role).not.toContain('developer')
		// `rn.privilege` is a claim, not a scope — it sits beside `role`, never in `scope`.
		expect(payload['rn.privilege']).toEqual(['BanVChat', 'BanRmChat'])
		expect(payload.scope).not.toContain('rn.privilege')
	})

	test('POST /connect/token 400s when no account_id is posted (never defaults to 1)', async () => {
		const res = await exports.default.fetch(`${ORIGIN}/connect/token`, { method: 'POST' })
		expect(res.status).toBe(400)
		expect((await res.json()) as { error: string }).toMatchObject({ error: 'invalid_request' })
	})

	test('POST /connect/token 400s on a non-numeric account_id', async () => {
		const res = await exports.default.fetch(`${ORIGIN}/connect/token`, {
			method: 'POST',
			headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
			body: 'account_id=notanumber',
		})
		expect(res.status).toBe(400)
	})

	test('POST /connect/token rejects a credential login with the wrong password', async () => {
		const res = await postToken('account_id=42&password=wrong-password')
		expect(res.status).toBe(400)
		expect(res.json.error).toBe('invalid_grant')
	})

	test('POST /connect/token rejects a credential login with no password', async () => {
		const res = await postToken('account_id=42')
		expect(res.status).toBe(400)
		expect(res.json.error).toBe('invalid_grant')
	})

	test('POST /connect/token refuses login to an account with no password set', async () => {
		// Account 999 exists but never set a password — it has no credential to verify,
		// so login by id alone is refused (this is the closed takeover hole).
		await env.DB.prepare('INSERT OR IGNORE INTO account (data) VALUES (?1)')
			.bind(JSON.stringify({ accountId: 999, username: 'NoPass' }))
			.run()
		const res = await postToken('account_id=999&password=anything')
		expect(res.status).toBe(400)
		expect(res.json.error).toBe('invalid_grant')
	})

	test('POST /connect/token create_account can set a password used for later login', async () => {
		const created = await postToken(
			'grant_type=create_account&platform_id=steam-pw2&password=hunter2'
		)
		expect(created.status).toBe(200)
		const sub = decodePayload(created.json.access_token as string).sub as string

		// The password set at creation authenticates a subsequent credential login.
		const ok = await postToken(`account_id=${sub}&password=hunter2`)
		expect(ok.status).toBe(200)
		// A wrong password for that same account is rejected.
		const bad = await postToken(`account_id=${sub}&password=nope`)
		expect(bad.status).toBe(400)
	})

	test('POST /connect/token logs in by username (RecRoom password grant)', async () => {
		// The RecRoom client posts the username, not the account_id — case-insensitively
		// and with a trailing space, both of which must still resolve account 42.
		const res = await postToken(
			`grant_type=password&username=player42%20&password=${LOGIN_PASSWORD}`
		)
		expect(res.status).toBe(200)
		expect(decodePayload(res.json.access_token as string).sub).toBe('42')
	})

	test('POST /connect/token rejects a username login with the wrong password', async () => {
		const res = await postToken(`grant_type=password&username=Player42&password=wrong`)
		expect(res.status).toBe(400)
		expect(res.json.error).toBe('invalid_grant')
	})

	test('POST /connect/token 400s on an unknown username', async () => {
		const res = await postToken(`grant_type=password&username=NoSuchUser&password=whatever`)
		expect(res.status).toBe(400)
		expect(res.json.error).toBe('invalid_request')
	})

	test('POST /connect/token grant_type=create_account persists a new account', async () => {
		const payload = await tokenFor('grant_type=create_account&platform_id=steam-123')
		// The token's sub is the new account id, allocated above the system accounts.
		const sub = Number.parseInt(payload.sub as string, 10)
		expect(sub).toBeGreaterThanOrEqual(2)
		// The account exists in the DB with an auto-assigned (non-default) username.
		const row = await env.DB.prepare('SELECT data FROM account WHERE account_id = ?1')
			.bind(sub)
			.first<{ data: string }>()
		expect(row).not.toBeNull()
		const account = JSON.parse(row!.data) as { username: string }
		expect(account.username).not.toMatch(/^Player\d+$/)
	})

	test('POST /connect/token create_account stores the login device on the account', async () => {
		const deviceId = '69640e6ae1b54ae5b0ca8eeb4a8872ec6cf8fd88'
		const payload = await tokenFor(
			`grant_type=create_account&platform_id=steam-dev1&device_id=${deviceId}&device_class=2`
		)
		const sub = Number.parseInt(payload.sub as string, 10)
		const row = await env.DB.prepare('SELECT data FROM account WHERE account_id = ?1')
			.bind(sub)
			.first<{ data: string }>()
		const account = JSON.parse(row!.data) as { deviceId: string; deviceClass: number }
		expect(account.deviceId).toBe(deviceId)
		expect(account.deviceClass).toBe(2)

		// Accounts sharing a device can be found later (account linkup).
		const shared = await getAccountsByDeviceId(env.DB, deviceId)
		expect(shared.map((a) => a.accountId)).toContain(sub)
	})

	test('POST /connect/token stores deviceClass as an integer, not a REAL', async () => {
		// D1 binds a JS number as a SQLite REAL, so a naive json_set writes `"deviceClass":2.0`
		// into the blob. JSON.parse tolerates that, but the raw JSON is what other readers
		// (and any strict int parser) see, so assert on the stored TEXT, not the parsed value.
		await postToken(
			`grant_type=password&username=Player77&password=${LOGIN_PASSWORD}&device_id=dev-int&device_class=2`
		)
		const row = await env.DB.prepare('SELECT data FROM account WHERE account_id = ?1')
			.bind(77)
			.first<{ data: string }>()
		expect(row!.data).toContain('"deviceClass":2')
		expect(row!.data).not.toContain('2.0')
	})

	test('POST /connect/token refreshes the stored device on a credential login', async () => {
		// Account 42 was seeded with no device; a later login records the one it came from.
		const res = await postToken(
			`grant_type=password&username=Player42&password=${LOGIN_PASSWORD}&device_id=dev-42-new&device_class=3`
		)
		expect(res.status).toBe(200)
		const row = await env.DB.prepare('SELECT data FROM account WHERE account_id = ?1')
			.bind(42)
			.first<{ data: string }>()
		const account = JSON.parse(row!.data) as { deviceId: string; deviceClass: number }
		expect(account.deviceId).toBe('dev-42-new')
		expect(account.deviceClass).toBe(3)
	})

	test('POST /connect/token create_account records the client IP', async () => {
		const payload = await tokenFor('grant_type=create_account&platform_id=steam-ip1', '203.0.113.7')
		const sub = Number.parseInt(payload.sub as string, 10)
		const row = await env.DB.prepare('SELECT data FROM account WHERE account_id = ?1')
			.bind(sub)
			.first<{ data: string }>()
		const account = JSON.parse(row!.data) as { signupIp: string; lastLoginIp: string }
		expect(account.signupIp).toBe('203.0.113.7')
		expect(account.lastLoginIp).toBe('203.0.113.7')
	})

	test('POST /connect/token caps the accounts created from one IP', async () => {
		const ip = '198.51.100.22'
		for (let i = 0; i < 3; i++) {
			const ok = await postToken(`grant_type=create_account&platform_id=steam-cap${i}`, ip)
			expect(ok.status).toBe(200)
		}
		// The 4th signup from that IP is refused — the cap is 3.
		const capped = await postToken('grant_type=create_account&platform_id=steam-cap3', ip)
		expect(capped.status).toBe(400)
		expect(capped.json.error).toBe('invalid_grant')
		expect(capped.json.error_description).toMatch(/network/)

		// A different IP is unaffected, and the capped IP can still LOG IN to what it has.
		const other = await postToken(
			'grant_type=create_account&platform_id=steam-cap4',
			'198.51.100.23'
		)
		expect(other.status).toBe(200)
	})

	test('the signup caps come from vars, and 0 disables an arm', async () => {
		// The cap an operator actually runs is the `MAX_ACCOUNTS_PER_IP` var; the constant in
		// auth.app.ts is only the fallback. `env` is shared by every test in this file, so the
		// override is restored in `finally` rather than leaking a cap of 0 into the tests above.
		const original = env.MAX_ACCOUNTS_PER_IP
		try {
			env.MAX_ACCOUNTS_PER_IP = 1
			const ip = '198.51.100.30'
			const first = await postToken('grant_type=create_account&platform_id=steam-var0', ip)
			expect(first.status).toBe(200)
			const capped = await postToken('grant_type=create_account&platform_id=steam-var1', ip)
			expect(capped.status).toBe(400)
			expect(capped.json.error_description).toMatch(/network/)

			// 0 disables the arm entirely: the IP that was just capped can sign up again.
			env.MAX_ACCOUNTS_PER_IP = 0
			const uncapped = await postToken('grant_type=create_account&platform_id=steam-var2', ip)
			expect(uncapped.status).toBe(200)
		} finally {
			env.MAX_ACCOUNTS_PER_IP = original
		}
	})

	test('POST /connect/token does not cap logins, only signups', async () => {
		// Account 42's owner may be over the signup cap; that must never lock them out of
		// an account they already have.
		const res = await postToken(
			`grant_type=password&username=Player42&password=${LOGIN_PASSWORD}`,
			'198.51.100.22'
		)
		expect(res.status).toBe(200)
	})

	test('POST /connect/token create_account seeds the new player into Orientation', async () => {
		const payload = await tokenFor('grant_type=create_account&platform_id=steam-456')
		const sub = payload.sub as string
		// Presence is written to the shared `presence` D1 table (account_id keyed).
		const row = await env.DB.prepare('SELECT data FROM presence WHERE account_id = ?1')
			.bind(Number(sub))
			.first<{ data: string }>()
		expect(row).not.toBeNull()
		const presence = JSON.parse(row!.data) as {
			roomInstance: { roomInstanceId: number; roomId: number; location: string; name: string }
		}
		expect(presence.roomInstance).toMatchObject({
			roomInstanceId: -2,
			roomId: 13,
			location: ORIENTATION_SCENE,
			name: '^Orientation',
		})
	})

	test('POST /connect/token carries the platform int on the token', async () => {
		const payload = await tokenFor(`account_id=42&platform=5&password=${LOGIN_PASSWORD}`)
		expect(payload.platform).toBe(5)
		// `rn.plat` is the same int, not a pinned 0.
		expect(payload['rn.plat']).toBe(5)
	})

	test('POST /connect/token defaults the platform claim when none is posted', async () => {
		const payload = await tokenFor(`account_id=42&password=${LOGIN_PASSWORD}`)
		expect(payload.platform).toBe(0)
		expect(payload['rn.plat']).toBe(0)
	})

	test('POST /connect/token returns a refresh_token that redeems for a new token', async () => {
		const login = await postToken(
			`account_id=42&platform=0&platform_id=steam-123&password=${LOGIN_PASSWORD}`
		)
		expect(login.status).toBe(200)
		const refreshToken = login.json.refresh_token as string
		expect(typeof refreshToken).toBe('string')
		expect(refreshToken.length).toBeGreaterThan(0)

		const refreshed = await postToken(
			`grant_type=refresh_token&refresh_token=${encodeURIComponent(refreshToken)}`
		)
		expect(refreshed.status).toBe(200)
		const payload = decodePayload(refreshed.json.access_token as string)
		expect(payload.sub).toBe('42')
		// The platform identity comes off the account, not the refresh token. Account 42
		// has none bound (the posted `platform_id` above was never Steam-verified, so it
		// was never written), so the refreshed token carries no identity either.
		expect(payload.platform).toBe(0)
		expect(payload.platform_id).toBe('')
		// The refresh token is rotated (single-use), so a new one is returned.
		expect(refreshed.json.refresh_token).not.toBe(refreshToken)
	})

	test('a refreshed token carries the identity bound to the account', async () => {
		// A Steam-bound account: only a verified ticket writes `platformId`, so seed it
		// directly rather than posting an (unverified) platform_id on the login.
		await env.DB.prepare('INSERT OR IGNORE INTO account (data) VALUES (?1)')
			.bind(
				JSON.stringify({
					accountId: 43,
					username: 'Player43',
					passwordHash: await hashPassword(LOGIN_PASSWORD),
					platform: 0,
					platformId: 'steam-123',
				})
			)
			.run()

		const login = await postToken(`account_id=43&password=${LOGIN_PASSWORD}`)
		expect(login.status).toBe(200)
		const refreshed = await postToken(
			`grant_type=refresh_token&refresh_token=${encodeURIComponent(login.json.refresh_token as string)}`
		)
		expect(refreshed.status).toBe(200)
		const payload = decodePayload(refreshed.json.access_token as string)
		expect(payload.sub).toBe('43')
		expect(payload.platform).toBe(0)
		expect(payload.platform_id).toBe('steam-123')
	})

	// A password login is how a player who already has an account signs in on a NEW
	// device. The client posts its platform proof alongside the password, and linking
	// the two is what turns the next launch on that device into a cached login.
	describe('password grant links the platform identity it proves', () => {
		/** Seed an account with LOGIN_PASSWORD set and no platform identity at all. */
		async function seedPasswordAccount(id: number, username: string) {
			await env.DB.prepare('INSERT OR IGNORE INTO account (data) VALUES (?1)')
				.bind(
					JSON.stringify({
						accountId: id,
						username,
						passwordHash: await hashPassword(LOGIN_PASSWORD),
					})
				)
				.run()
		}

		test('a verified Meta login on an existing account links it, and cached login follows', async () => {
			// Exactly the client's flow: an account made elsewhere, signed into on a headset
			// with username + password, with the Meta nonce riding along.
			await seedPasswordAccount(7100, 'djdevin')
			const metaId = '27061366730201234'
			const login = await metaLogin(
				`grant_type=password&username=djdevin&password=${LOGIN_PASSWORD}` +
					`&platform=1&platform_id=${metaId}` +
					`&platform_auth=${encodeURIComponent(metaPlatformAuth())}`,
				true
			)
			expect(login.status).toBe(200)
			expect(decodePayload(login.json.access_token as string).sub).toBe('7100')
			// The nonce was validated against the id being linked — an unproven id is never
			// linked, since a link is a password-free way into the account.
			expect(login.graphCalls[0].get('user_id')).toBe(metaId)

			// The headset now gets a cached login: offered by the picker…
			const offered = await cachedLogins(1, metaId)
			expect(offered.map((a) => a.accountId)).toContain(7100)

			// …and accepted by the grant, with no password.
			const cached = await metaLogin(
				`grant_type=cached_login&account_id=7100&platform=1&platform_id=${metaId}` +
					`&platform_auth=${encodeURIComponent(metaPlatformAuth())}`,
				true
			)
			expect(cached.status).toBe(200)
		})

		test('the first identity linked becomes the account primary; later ones just link', async () => {
			await seedPasswordAccount(7101, 'multiplatform')
			const metaId = '27061366730205678'
			await metaLogin(
				`grant_type=password&username=multiplatform&password=${LOGIN_PASSWORD}` +
					`&platform=1&platform_id=${metaId}` +
					`&platform_auth=${encodeURIComponent(metaPlatformAuth())}`,
				true
			)
			// The blob's primary identity was empty, so the first link fills it in — this is
			// what the account DTO and the refresh grant's claims report.
			const account = (await env.DB.prepare(
				'SELECT data FROM account WHERE account_id = 7101'
			).first<{ data: string }>())!
			expect(JSON.parse(account.data)).toMatchObject({ platform: 1, platformId: metaId })

			// A second identity on another platform links without disturbing the primary.
			await linkPlatformIdentity(env.DB, 7101, 0, '76561197962465678')
			const links = await getLinksForAccount(env.DB, 7101)
			expect(links.map((l) => [l.platform, l.platformId])).toEqual([
				[1, metaId],
				[0, '76561197962465678'],
			])
		})

		test('an unverified platform_auth logs in but links nothing', async () => {
			// The password already proved who this is, so the login stands — but a link is a
			// password-free way in, and this identity was never proven, so none is written.
			await seedPasswordAccount(7102, 'unproven')
			const metaId = '27061366730209876'
			const login = await metaLogin(
				`grant_type=password&username=unproven&password=${LOGIN_PASSWORD}` +
					`&platform=1&platform_id=${metaId}` +
					`&platform_auth=${encodeURIComponent(metaPlatformAuth())}`,
				false // Meta rejects the nonce
			)
			expect(login.status).toBe(200)
			expect(await getLinksForAccount(env.DB, 7102)).toEqual([])
		})

		test('a login with no platform_auth links nothing and asks Meta nothing', async () => {
			await seedPasswordAccount(7103, 'noproof')
			const login = await metaLogin(
				`grant_type=password&username=noproof&password=${LOGIN_PASSWORD}` +
					`&platform=1&platform_id=27061366730204321`,
				true
			)
			expect(login.status).toBe(200)
			expect(login.graphCalls).toHaveLength(0)
			expect(await getLinksForAccount(env.DB, 7103)).toEqual([])
		})

		test('a sideloaded APK (platform id 1) logs in but is never linked', async () => {
			// The sideload placeholder identifies nobody — every sideloaded headset reports
			// `1`, so a link on it would be a password-free way into this account from any of
			// them. The password login still stands; Meta is never even asked, since there is
			// nothing there to validate.
			await seedPasswordAccount(7105, 'sideloader')
			const login = await metaLogin(
				`grant_type=password&username=sideloader&password=${LOGIN_PASSWORD}` +
					`&platform=1&platform_id=1` +
					`&platform_auth=${encodeURIComponent(metaPlatformAuth())}`,
				true // even with Meta answering yes to everything
			)
			expect(login.status).toBe(200)
			expect(login.graphCalls).toHaveLength(0)
			expect(await getLinksForAccount(env.DB, 7105)).toEqual([])
			// And so the picker never offers this account off the placeholder — only the
			// canned stub entry is there.
			expect((await cachedLogins(1, '1')).map((a) => a.accountId)).toEqual([1])
		})

		test('linking obeys the per-identity account cap, without failing the login', async () => {
			// Otherwise the signup cap would be trivially bypassable: create accounts with a
			// password, then link the capped identity into all of them.
			const metaId = '27061366730203333'
			for (let i = 0; i < 3; i++) await linkPlatformIdentity(env.DB, 8000 + i, 1, metaId)

			await seedPasswordAccount(8100, 'overcap')
			const login = await metaLogin(
				`grant_type=password&username=overcap&password=${LOGIN_PASSWORD}` +
					`&platform=1&platform_id=${metaId}` +
					`&platform_auth=${encodeURIComponent(metaPlatformAuth())}`,
				true
			)
			// The password was valid, so the player is logged in — they just don't get a
			// cached login on this account.
			expect(login.status).toBe(200)
			expect(await getLinksForAccount(env.DB, 8100)).toEqual([])
		})

		test('re-logging in on the same device does not duplicate the link', async () => {
			await seedPasswordAccount(7104, 'repeatlogin')
			const metaId = '27061366730207654'
			const body =
				`grant_type=password&username=repeatlogin&password=${LOGIN_PASSWORD}` +
				`&platform=1&platform_id=${metaId}` +
				`&platform_auth=${encodeURIComponent(metaPlatformAuth())}`
			await metaLogin(body, true)
			await metaLogin(body, true)
			expect(await getLinksForAccount(env.DB, 7104)).toHaveLength(1)
		})
	})

	test('POST /connect/token refresh_token is single-use (rejected on reuse)', async () => {
		const login = await postToken(`account_id=77&platform=0&password=${LOGIN_PASSWORD}`)
		const refreshToken = login.json.refresh_token as string

		const first = await postToken(
			`grant_type=refresh_token&refresh_token=${encodeURIComponent(refreshToken)}`
		)
		expect(first.status).toBe(200)
		// Redeeming the same token again fails — it was consumed (rotated) above.
		const reuse = await postToken(
			`grant_type=refresh_token&refresh_token=${encodeURIComponent(refreshToken)}`
		)
		expect(reuse.status).toBe(400)
		expect(reuse.json.error).toBe('invalid_grant')
	})

	test('POST /connect/token 400s on an unknown refresh_token', async () => {
		const res = await postToken('grant_type=refresh_token&refresh_token=NOPE-1')
		expect(res.status).toBe(400)
		expect(res.json.error).toBe('invalid_grant')
	})

	test('POST /cachedlogin/forplatformids returns []', async () => {
		const res = await exports.default.fetch(`${ORIGIN}/cachedlogin/forplatformids`, {
			method: 'POST',
			headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
			body: 'id=76561197971551621&id=76561197976728738',
		})
		expect(res.status).toBe(200)
		expect(await res.json()).toEqual([])
	})

	test('POST /account/me/changepassword 401s without a token', async () => {
		const res = await changePassword('oldPassword=&newPassword=secret123')
		expect(res.status).toBe(401)
	})

	test('POST /account/me/changepassword 400s without a new password', async () => {
		const token = await accessTokenFor('grant_type=create_account&platform_id=steam-pw0')
		const res = await changePassword('oldPassword=&newPassword=', token)
		expect(res.status).toBe(400)
	})

	test('POST /account/me/changepassword sets then rotates the password', async () => {
		const token = await accessTokenFor('grant_type=create_account&platform_id=steam-pw1')

		// First set — oldPassword is empty (as the client sends it).
		const set = await changePassword('oldPassword=&newPassword=first-password', token)
		expect(set.status).toBe(200)
		expect(await set.json()).toEqual({ success: true })

		// A wrong old password is now rejected.
		const wrong = await changePassword('oldPassword=nope&newPassword=second-password', token)
		expect(wrong.status).toBe(400)

		// The correct old password rotates it.
		const rotate = await changePassword(
			'oldPassword=first-password&newPassword=second-password',
			token
		)
		expect(rotate.status).toBe(200)
		expect(await rotate.json()).toEqual({ success: true })
	})

	test('GET /role/developer/:id returns a bare false for an un-flagged account', async () => {
		const res = await exports.default.fetch(`${ORIGIN}/role/developer/42`)
		expect(res.status).toBe(200)
		expect(await res.json()).toBe(false)
	})

	test('GET /role/developer/:id returns a bare true when the account is flagged', async () => {
		await env.DB.prepare('INSERT OR IGNORE INTO account (data) VALUES (?1)')
			.bind(JSON.stringify({ accountId: 4242, username: 'DevPlayer', isDeveloper: true }))
			.run()
		const res = await exports.default.fetch(`${ORIGIN}/role/developer/4242`)
		expect(res.status).toBe(200)
		expect(await res.json()).toBe(true)
	})

	test('GET /role/developer/:id 404s for an unknown player', async () => {
		const res = await exports.default.fetch(`${ORIGIN}/role/developer/99999`)
		expect(res.status).toBe(404)
	})

	test('GET /role/moderator/:id reflects the isModerator flag as a bare boolean', async () => {
		await env.DB.prepare('INSERT OR IGNORE INTO account (data) VALUES (?1)')
			.bind(JSON.stringify({ accountId: 4343, username: 'ModPlayer', isModerator: true }))
			.run()
		const granted = await exports.default.fetch(`${ORIGIN}/role/moderator/4343`)
		expect(await granted.json()).toBe(true)
		// An account without the flag (42) is not a moderator.
		const plain = await exports.default.fetch(`${ORIGIN}/role/moderator/42`)
		expect(await plain.json()).toBe(false)
		// Unknown player → 404.
		expect((await exports.default.fetch(`${ORIGIN}/role/moderator/99999`)).status).toBe(404)
	})

	test('unknown path returns 404', async () => {
		const res = await exports.default.fetch(`${ORIGIN}/nope`)
		expect(res.status).toBe(404)
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
			'GET /cachedlogin/forplatformid/{platform}/{id}',
			'GET /eac/challenge',
			'GET /role/developer/{id}',
			'GET /role/moderator/{id}',
			'POST /account/me/changepassword',
			'POST /cachedlogin/forplatformid/{platform}/{id}',
			'POST /cachedlogin/forplatformids',
			'POST /connect/token',
		])

		// Every operation carries a summary — a path present but undescribed is not
		// documentation.
		for (const ops of Object.values(spec.paths)) {
			for (const op of Object.values(ops)) expect(op.summary).toBeTruthy()
		}
	})
})

// The website is a browser origin calling these endpoints directly — the same ones the
// game calls — instead of proxying them through `www`. That only works if the responses
// carry CORS headers: without them the browser discards a perfectly good token response
// and sign-in fails with nothing in any server log to explain it.
describe('CORS', () => {
	test('answers the preflight the browser sends before a token grant', async () => {
		const res = await exports.default.fetch(
			new Request(`${ORIGIN}/connect/token`, {
				method: 'OPTIONS',
				headers: {
					origin: 'https://www.example.com',
					'access-control-request-method': 'POST',
					'access-control-request-headers': 'content-type',
				},
			}),
			env
		)
		expect(res.status).toBe(204)
		expect(res.headers.get('access-control-allow-origin')).toBe('*')
		expect(res.headers.get('access-control-allow-headers')?.toLowerCase()).toContain('content-type')
	})

	// The header has to be on the REAL response too, not just the preflight — and on a
	// refusal as much as a success, or a rejected sign-in reaches the page as an opaque
	// network error rather than "that password is incorrect".
	test('allows the origin on the response itself, refusals included', async () => {
		const res = await exports.default.fetch(
			new Request(`${ORIGIN}/connect/token`, {
				method: 'POST',
				headers: {
					origin: 'https://www.example.com',
					'content-type': 'application/x-www-form-urlencoded',
				},
				body: new URLSearchParams({ grant_type: 'password', username: 'nobody' }).toString(),
			}),
			env
		)
		expect(res.status).toBe(400)
		expect(res.headers.get('access-control-allow-origin')).toBe('*')
	})

	// The bearer header is what the SPA authenticates with, so it must be allowed by name
	// — a preflight that omits it makes every signed-in call fail.
	test('allows the Authorization header the SPA signs its calls with', async () => {
		const res = await exports.default.fetch(
			new Request(`${ORIGIN}/account/me/changepassword`, {
				method: 'OPTIONS',
				headers: {
					origin: 'https://www.example.com',
					'access-control-request-method': 'POST',
					'access-control-request-headers': 'authorization',
				},
			}),
			env
		)
		expect(res.status).toBe(204)
		expect(res.headers.get('access-control-allow-headers')?.toLowerCase()).toContain(
			'authorization'
		)
	})
})

// A banned account is refused a token at all — the outer wall of a ban, since with no
// token every other worker is shut to it. The ban is a `report` row with `banned` set
// (the api worker owns that table); matchmaking enforces the same ban on tokens issued
// before it was handed down.
describe('banned accounts', () => {
	test('POST /connect/token refuses a password grant from a banned account', async () => {
		await seedAccount(6101, 'BannedPlayer')
		await banAccount(6101)

		const res = await postToken(`account_id=6101&password=${LOGIN_PASSWORD}`)
		expect(res.status).toBe(400)
		expect(res.json.error).toBe('invalid_grant')
		// The exact sentence www's shared auth-messages table keys on to put a real
		// message in front of the player — changing it silently downgrades that to the
		// generic "you could not be signed in".
		expect(res.json.error_description).toBe('this account is banned')
	})

	test('POST /connect/token refuses a username login from a banned account', async () => {
		await seedAccount(6102, 'BannedByName')
		await banAccount(6102)

		const res = await postToken(
			`grant_type=password&username=BannedByName&password=${LOGIN_PASSWORD}`
		)
		expect(res.status).toBe(400)
		expect(res.json.error_description).toBe('this account is banned')
	})

	// A client that was already signed in when the ban landed still holds a valid refresh
	// token; redeeming it must not renew the session.
	test('POST /connect/token refuses to refresh a banned account’s session', async () => {
		await seedAccount(6103, 'BannedLater')
		const login = await postToken(`account_id=6103&password=${LOGIN_PASSWORD}`)
		expect(login.status).toBe(200)
		const refreshToken = login.json.refresh_token as string

		await banAccount(6103)
		const refreshed = await postToken(
			`grant_type=refresh_token&refresh_token=${encodeURIComponent(refreshToken)}`
		)
		expect(refreshed.status).toBe(400)
		expect(refreshed.json.error_description).toBe('this account is banned')
	})

	// The ban check runs AFTER the credential check, so a wrong password on a banned
	// account still answers the ordinary bad-credential refusal — it can't be used to
	// find out whether an account exists or is banned without knowing its password.
	test('a wrong password on a banned account is still a credential refusal', async () => {
		await seedAccount(6104, 'BannedWrongPw')
		await banAccount(6104)

		const res = await postToken('account_id=6104&password=not-the-password')
		expect(res.status).toBe(400)
		expect(res.json.error_description).toBe('invalid account_id or password')
	})

	// A timed ban lifts itself when its expiry passes; nothing clears the flag.
	test('an expired ban lets the account sign in again', async () => {
		await seedAccount(6105, 'ServedTime')
		await banAccount(6105, '2020-01-01T00:00:00.000Z')

		const res = await postToken(`account_id=6105&password=${LOGIN_PASSWORD}`)
		expect(res.status).toBe(200)
		expect(decodePayload(res.json.access_token as string).sub).toBe('6105')
	})

	test('a ban that has not expired yet still refuses the login', async () => {
		await seedAccount(6106, 'StillServing')
		await banAccount(6106, new Date(Date.now() + 3_600_000).toISOString())

		const res = await postToken(`account_id=6106&password=${LOGIN_PASSWORD}`)
		expect(res.status).toBe(400)
		expect(res.json.error_description).toBe('this account is banned')
	})

	// A report is not a ban until a moderator converts it.
	test('an unbanned report does not refuse the login', async () => {
		await seedAccount(6107, 'MerelyReported')
		await createReport(env.DB, { reporterPlayerId: 1, reportedPlayerId: 6107 })

		const res = await postToken(`account_id=6107&password=${LOGIN_PASSWORD}`)
		expect(res.status).toBe(200)
	})

	// The ban is the ACCOUNT's: nothing here stops the player signing up again, which is
	// the signup caps' job, not this check's.
	test('a banned player can still create a new account', async () => {
		await seedAccount(6108, 'BannedButNew')
		await banAccount(6108)

		const created = await postToken('grant_type=create_account&platform_id=steam-after-ban')
		expect(created.status).toBe(200)
	})
})

// The ban follows the player past the account it was written on: a login from an account
// that shares a proven platform identity or an IP with a banned one is refused, and a
// signup carrying either is refused before it mints anything. See the api worker's
// bans-db.ts for the arms and the BAN_EVASION_MATCH knob.
describe('ban evasion at the token endpoint', () => {
	/** Seed a loginable account carrying the IPs it signed up / last logged in from. */
	const account = async (id: number, name: string, ips: Record<string, string> = {}) => {
		await env.DB.prepare('INSERT OR IGNORE INTO account (data) VALUES (?1)')
			.bind(
				JSON.stringify({
					accountId: id,
					username: name,
					passwordHash: await hashPassword(LOGIN_PASSWORD),
					...ips,
				})
			)
			.run()
	}

	const login = (id: number, ip?: string) =>
		postToken(`account_id=${id}&password=${LOGIN_PASSWORD}`, ip)

	test('an account sharing a banned account’s platform identity cannot log in', async () => {
		await account(6301, 'EvaderOne')
		await linkPlatformIdentity(env.DB, 6301, 0, 'steam-tokenevader')
		await banAccount(6301)
		await account(6302, 'EvaderTwo')
		await linkPlatformIdentity(env.DB, 6302, 0, 'steam-tokenevader')

		const res = await login(6302)
		expect(res.status).toBe(400)
		// A vaguer sentence than a direct ban: this account may belong to somebody else.
		expect(res.json.error_description).toBe('this device or network is blocked')
	})

	test('an account sharing a banned account’s IP cannot log in', async () => {
		await account(6303, 'SameHouseBanned', { signupIp: '203.0.113.30' })
		await banAccount(6303)
		await account(6304, 'SameHouseClean', { signupIp: '203.0.113.30' })

		const res = await login(6304)
		expect(res.status).toBe(400)
		expect(res.json.error_description).toBe('this device or network is blocked')
	})

	// The address the request arrives from counts, so an account that never logged in
	// from the banned network before is caught on the first attempt rather than the second.
	test('the request’s own IP is matched even when the account has none stored', async () => {
		await account(6305, 'BannedAtHome', { signupIp: '203.0.113.31' })
		await banAccount(6305)
		await account(6306, 'CleanElsewhere')

		expect((await login(6306, '203.0.113.31')).status).toBe(400)
		// The same account from any other network signs in normally.
		expect((await login(6306, '198.51.100.31')).status).toBe(200)
	})

	test('an unrelated account signs in normally', async () => {
		await account(6307, 'Unrelated', { signupIp: '198.51.100.7' })
		await banAccount(6307 + 1000) // a ban on somebody else entirely
		expect((await login(6307)).status).toBe(200)
	})

	// The point of checking before minting: a refused signup must leave nothing behind,
	// or the evader keeps the account (and burns a slot off the signup caps) anyway.
	test('create_account from a banned IP is refused and creates no account', async () => {
		await account(6310, 'BannedSignupSource', { signupIp: '203.0.113.40' })
		await banAccount(6310)

		const before = await env.DB.prepare('SELECT COUNT(*) AS n FROM account').first<{ n: number }>()
		const res = await postToken('grant_type=create_account', '203.0.113.40')
		expect(res.status).toBe(400)
		expect(res.json.error_description).toBe('this device or network is blocked')
		const after = await env.DB.prepare('SELECT COUNT(*) AS n FROM account').first<{ n: number }>()
		expect(after?.n).toBe(before?.n)
	})

	test('create_account from an unrelated IP still works', async () => {
		const res = await postToken('grant_type=create_account', '198.51.100.99')
		expect(res.status).toBe(200)
	})

	// The knob an operator reaches for when the IP arm locks out real players.
	test('BAN_EVASION_MATCH=platform drops the IP arm but keeps the direct ban', async () => {
		const original = env.BAN_EVASION_MATCH
		await account(6320, 'KnobBanned', { signupIp: '203.0.113.50' })
		await linkPlatformIdentity(env.DB, 6320, 0, 'steam-knobevader')
		await banAccount(6320)
		await account(6321, 'KnobHousemate', { signupIp: '203.0.113.50' })
		await account(6322, 'KnobEvader')
		await linkPlatformIdentity(env.DB, 6322, 0, 'steam-knobevader')

		try {
			env.BAN_EVASION_MATCH = 'platform'
			expect((await login(6321)).status).toBe(200)
			expect((await login(6322)).status).toBe(400)
			// And signup from that network is open again.
			expect((await postToken('grant_type=create_account', '203.0.113.50')).status).toBe(200)

			env.BAN_EVASION_MATCH = 'off'
			expect((await login(6322)).status).toBe(200)
			// The banned account itself is refused whatever the knob says.
			const banned = await login(6320)
			expect(banned.status).toBe(400)
			expect(banned.json.error_description).toBe('this account is banned')
		} finally {
			env.BAN_EVASION_MATCH = original
		}
	})
})
