import { adminSecretsStore, env, SELF } from 'cloudflare:test'
import { beforeAll, expect, it } from 'vitest'

import { SCHEMA_DDL as ACCOUNT_SCHEMA_DDL, updateAccount } from '@repo/domain/src/accounts-db'
import { PlatformType } from '@repo/domain/src/enums'
import { PRESENCE_SCHEMA_DDL, PRESENCE_TTL_SECONDS } from '@repo/domain/src/presence-db'
import { generateToken } from '@repo/jwt'

import {
	CACHED_LOGIN_PLATFORMS,
	countAccountsForPlatformIdentity,
	isPlatformIdentityLinked,
	linkPlatformIdentity,
	PLATFORM_SCHEMA_DDL,
} from '../../../../auth/src/platform-db'
import { discordConfig, parseRoleIds, qualifies } from '../../discord'
import { DOCUMENTED_SERVICES } from '../../docs'
import { DISCORD_INVITE, ISSUES_URL, PRIVACY_EMAIL } from '../../links'
import { turnstileKeys } from '../../turnstile'
import { postAuthForm, readAuthError } from '../../upstream'

import type { Env } from '../../context'

declare module 'cloudflare:test' {
	interface ProvidedEnv extends Env {}
}

// Turnstile's documented always-passes test keypair, seeded into the LOCAL Secrets Store
// so the bindings resolve — the same way every other worker's tests seed JWT_SECRET. It
// stands in for the two account-level secrets a deployed www reads, and it's what OPENS
// signup (see src/turnstile.ts): without it every signup test would test the closed door.
const TEST_SITE_KEY = '1x00000000000000000000AA'
const TEST_SECRET_KEY = '1x0000000000000000000000000000000AA'

// The shared HS256 key. www verifies tokens itself for exactly one route (the benefits
// claim), so the tests have to be able to MINT one — hence a known value here rather than
// whatever a deployed store holds.
const TEST_JWT_SECRET = 'test-jwt-secret'

/** A bearer token for `accountId`, signed the way `auth` signs one. */
const tokenFor = (accountId: number): Promise<string> =>
	generateToken(String(accountId), '', 4, TEST_JWT_SECRET)

// A Discord app that is HALF configured: credentials seeded below, but wrangler.jsonc
// leaves DISCORD_GUILD_ID / DISCORD_BENEFITS_ROLE_IDS empty. This is deliberately the most
// dangerous half — an operator who registers an app and stops has something that can sign
// a player in and no question left to ask about them — so it is the state the route-level
// tests pin: the claim must still be CLOSED. The fully-configured path is covered by
// unit-testing `discordConfig`, since exercising it end to end would call discord.com.
const TEST_DISCORD_CLIENT_ID = 'test-discord-client-id'
const TEST_DISCORD_CLIENT_SECRET = 'test-discord-client-secret'

beforeAll(async () => {
	await adminSecretsStore(env.TURNSTILE_SITE_KEY).create(TEST_SITE_KEY)
	await adminSecretsStore(env.TURNSTILE_SECRET_KEY).create(TEST_SECRET_KEY)
	await adminSecretsStore(env.JWT_SECRET).create(TEST_JWT_SECRET)
	await adminSecretsStore(env.DISCORD_CLIENT_ID).create(TEST_DISCORD_CLIENT_ID)
	await adminSecretsStore(env.DISCORD_CLIENT_SECRET).create(TEST_DISCORD_CLIENT_SECRET)
	// `presence` is owned (and migrated) by other workers — www only reads it — so the
	// table has to be created here for the head-count behind /server-status.
	for (const stmt of PRESENCE_SCHEMA_DDL) await env.DB.prepare(stmt).run()
	// `account` likewise: owned by `auth`, read and (for the benefits claim) written here.
	for (const stmt of ACCOUNT_SCHEMA_DDL) await env.DB.prepare(stmt).run()
	// And `platform_account`, where a claimed Discord identity is linked.
	for (const stmt of PLATFORM_SCHEMA_DDL) await env.DB.prepare(stmt).run()
})

// Web signup is open, but only behind the Turnstile check. These pin the closed door:
// the pass path can't be tested here (it would call Cloudflare's siteverify for real).
//
// The hostnames matter as much as the key: the SPA calls auth/accounts/api/notify/rooms
// DIRECTLY (as rec.net's site did), and this is the only place it learns where they are.
// A build with them missing can't sign anyone in.
it('advertises signup and where the other workers live', async () => {
	const res = await SELF.fetch('https://example.com/api/config')
	expect(res.status).toBe(200)
	// Read through the Secrets Store binding, from the value seeded above.
	expect(await res.json()).toEqual({
		signupEnabled: true,
		turnstileSiteKey: TEST_SITE_KEY,
		// Closed, because the Discord app here has no guild/role to check against — and with
		// it closed the SPA is given no authorize URL to send anyone to, so the claim can't
		// even be started. Note the client id is NOT leaked by a closed config.
		benefitsEnabled: false,
		discordAuthorizeUrl: null,
		hosts: {
			auth: 'https://auth.rec.example.com',
			accounts: 'https://accounts.rec.example.com',
			api: 'https://api.rec.example.com',
			img: 'https://img.rec.example.com',
			notify: 'https://notify.rec.example.com',
			rooms: 'https://rooms.rec.example.com',
			cdn: 'https://cdn.rec.example.com',
			storage: 'https://storage.rec.example.com',
		},
	})
})

// The BFF proxies are gone: the browser calls those workers itself. Pinned because
// nothing else would fail if one were left behind — a stale proxy keeps working, it just
// re-creates the maintenance burden (and the shared-IP bug) this removed. `/api/signup`
// is the deliberate exception, and it's covered below.
it('no longer proxies the endpoints the game already serves', async () => {
	for (const path of [
		'/api/me',
		'/api/login',
		'/api/logout',
		'/api/username',
		'/api/email',
		'/api/password',
		'/api/maintenance',
		'/api/coach-message',
		'/api/slideshow',
	]) {
		const res = await SELF.fetch(`https://example.com${path}`, { method: 'POST' })
		// Falls through to the SPA catch-all, which has no ASSETS binding under test.
		expect(res.status, path).toBe(404)
	}
})

// The keypair is the on/off switch for signup, so a www whose keys don't resolve must
// report it closed — that's the state a fresh deploy starts in, before the operator
// creates the two secrets. Checked directly because the real bindings are seeded for the
// fetch tests above.
//
// A store read that THROWS (secret absent, store unreachable) has to close the door the
// same way rather than surface as an error: /api/config is on the homepage's critical
// path, and a 500 there costs the whole page, not just the signup form.
it('treats an unresolvable or half-configured keypair as signup being off', async () => {
	const stub = (value: string | null): SecretsStoreSecret =>
		({ get: async () => value ?? '' }) as SecretsStoreSecret
	const throws = (): SecretsStoreSecret =>
		({
			get: async () => {
				throw new Error('secret not found')
			},
		}) as unknown as SecretsStoreSecret

	const withKeys = (site: SecretsStoreSecret, secret: SecretsStoreSecret) =>
		({
			ENVIRONMENT: 'development',
			TURNSTILE_SITE_KEY: site,
			TURNSTILE_SECRET_KEY: secret,
		}) as Env

	await expect(turnstileKeys(withKeys(throws(), throws()))).resolves.toBeNull()
	await expect(turnstileKeys(withKeys(stub('0xsite'), throws()))).resolves.toBeNull()
	await expect(turnstileKeys(withKeys(throws(), stub('0xsecret')))).resolves.toBeNull()
	await expect(turnstileKeys(withKeys(stub(''), stub('0xsecret')))).resolves.toBeNull()
	await expect(turnstileKeys(withKeys(stub('0xsite'), stub('0xsecret')))).resolves.toEqual({
		siteKey: '0xsite',
		secretKey: '0xsecret',
	})
})

it('refuses a signup with no Turnstile token', async () => {
	const res = await SELF.fetch('https://example.com/api/signup', {
		method: 'POST',
		headers: { 'content-type': 'application/json' },
		body: JSON.stringify({ password: 'whatever' }),
	})
	// Rejected before any upstream call, so a bot can't reach create_account by omitting it.
	expect(res.status).toBe(400)
	expect(await res.json()).toEqual({ error: 'Please complete the bot check.' })
})

it('refuses a signup with no password', async () => {
	const res = await SELF.fetch('https://example.com/api/signup', {
		method: 'POST',
		headers: { 'content-type': 'application/json' },
		body: JSON.stringify({ turnstileToken: 'dummy' }),
	})
	expect(res.status).toBe(400)
	expect(await res.json()).toEqual({ error: 'A password is required.' })
})

// A refused grant reaches the form as a sentence, never as the OAuth code. auth answers
// `{ error: 'invalid_grant', error_description: <the actual reason> }`, and www used to
// relay that untouched — so every failed signup, including one the player could act on
// (the per-network cap), read simply "invalid_grant". Checked directly because the pass
// path can't be reached from here (it would call the real auth worker).
it('explains a refused signup instead of relaying invalid_grant', async () => {
	const refused = (description: string, status = 400) =>
		new Response(JSON.stringify({ error: 'invalid_grant', error_description: description }), {
			status,
			headers: { 'content-type': 'application/json' },
		})

	const capped = await readAuthError(
		refused('too many accounts created from this network'),
		'signup'
	)
	expect(capped.status).toBe(400)
	expect(capped.message).toContain('Too many accounts have already been created from your network')
	// The raw pair still reaches the operator's log line.
	expect(capped.upstream).toBe('invalid_grant: too many accounts created from this network')

	const badPassword = await readAuthError(refused('invalid account_id or password'), 'login')
	expect(badPassword.message).toBe('That username or password is incorrect.')

	// A description auth grew since this table was written must not leak through as-is:
	// it's written for an operator, so an unmapped one falls back to the generic sentence.
	const unmapped = await readAuthError(refused('some new internal reason'), 'signup')
	expect(unmapped.message).not.toContain('some new internal reason')
	expect(unmapped.message).toContain('could not be created')

	// Nothing about the form was wrong — auth couldn't proceed (an unset JWT_SECRET). Don't
	// send them back to re-check their details, and don't answer 400 for our own fault.
	const broken = await readAuthError(
		new Response(
			JSON.stringify({
				error: 'server_error',
				error_description: 'token signing is not configured',
			}),
			{ status: 500, headers: { 'content-type': 'application/json' } }
		),
		'signup'
	)
	expect(broken.status).toBe(502)
	expect(broken.message).toContain('problem on our end')

	// A body from something in front of auth (an edge error page) is not JSON at all.
	const html = await readAuthError(new Response('<html>502</html>', { status: 502 }), 'signup')
	expect(html.status).toBe(502)
	expect(html.message).toContain('problem on our end')
	expect(html.upstream).toBe('HTTP 502')
})

// The signup cap counts auth's `CF-Connecting-IP` as the account's immutable `signupIp`,
// and www used to reach auth over https://auth.<DOMAIN> — a Worker subrequest, which
// re-enters the Cloudflare edge, which REPLACES that header with Cloudflare's own
// address. Every browser signup therefore shared one IP, and the cap (3, never decaying)
// refused the fourth web account ever created, for everyone. The service binding skips
// the edge, so the header set here is the one auth reads.
//
// Checked directly rather than through /api/signup: the pass path would call Cloudflare's
// siteverify for real (see the Turnstile tests above).
it('carries the browser IP across to auth instead of losing it to the edge', async () => {
	const seen: Request[] = []
	const withAuth = (fetcher?: Fetcher) =>
		({
			DOMAIN: 'rec.example.com',
			AUTH: fetcher,
		}) as unknown as Env
	const capture = {
		fetch: async (request: Request) => {
			seen.push(request)
			return new Response('{}', { headers: { 'content-type': 'application/json' } })
		},
	} as unknown as Fetcher

	await postAuthForm(
		withAuth(capture),
		'/connect/token',
		{ grant_type: 'create_account', password: 'hunter2' },
		{ clientIp: '203.0.113.7' }
	)

	// The binding is used in preference to the hostname, and the real IP rides along.
	expect(seen).toHaveLength(1)
	expect(seen[0]!.headers.get('cf-connecting-ip')).toBe('203.0.113.7')
	// Still the same host/path/body auth already answers — only the transport changed.
	expect(seen[0]!.url).toBe('https://auth.rec.example.com/connect/token')
	const body = await seen[0]!.formData()
	expect(body.get('grant_type')).toBe('create_account')
	expect(body.get('password')).toBe('hunter2')

	// A call with no IP to forward must not invent one: an absent header leaves auth's
	// own `clientIp` empty, which SKIPS the cap, rather than counting everyone together.
	// Reachable in local dev, where the edge sets no `cf-connecting-ip` to pass on.
	await postAuthForm(withAuth(capture), '/connect/token', { grant_type: 'create_account' })
	expect(seen[1]!.headers.get('cf-connecting-ip')).toBeNull()
})

// The public status snapshot. Two things are pinned: it needs no auth and no origin (a
// status page or Discord bot fetches it from anywhere), and its player count is LIVE
// presence — a row whose TTL has run out is a player who crashed or hard-quit, and
// counting them would leave the number permanently inflated between sweeps.
it('serves a public head-count of the players actually online', async () => {
	const now = Math.floor(Date.now() / 1000)
	const write = (accountId: number, expiresAt: number) =>
		env.DB.prepare('INSERT OR REPLACE INTO presence (data) VALUES (?1)')
			.bind(JSON.stringify({ accountId, roomInstance: null, expiresAt }))
			.run()

	// Empty table: online, nobody playing.
	let res = await SELF.fetch('https://example.com/server-status')
	expect(res.status).toBe(200)
	expect(await res.json()).toEqual({ status: 'online', players: 0 })

	await write(1, now + PRESENCE_TTL_SECONDS) // in a lobby — still online
	await write(2, now + PRESENCE_TTL_SECONDS)
	await write(3, now - 1) // stopped heartbeating, not yet swept

	res = await SELF.fetch('https://example.com/server-status', {
		headers: { origin: 'https://s.example' },
	})
	expect(res.status).toBe(200)
	// Readable from any origin — it's meant to be embedded elsewhere.
	expect(res.headers.get('access-control-allow-origin')).toBe('*')
	expect(await res.json()).toEqual({ status: 'online', players: 2 })
})

it('serves the aggregated docs page with a source per documented service', async () => {
	const res = await SELF.fetch('https://example.com/docs')
	expect(res.status).toBe(200)
	expect(res.headers.get('content-type')).toContain('text/html')
	const html = await res.text()
	// Mounts the self-hosted Scalar bundle (not a CDN) and lists every service's spec.
	expect(html).toContain('/docs/scalar.standalone.js')
	// Driven off the constant so adding a service can't leave the page (or this test)
	// behind.
	for (const { slug } of DOCUMENTED_SERVICES) {
		expect(html).toContain(`/docs/openapi/${slug}.json`)
	}
})

it('404s a spec proxy for an unknown service (not an open proxy)', async () => {
	// An un-allowlisted service is rejected before any upstream fetch, so this can't be
	// turned into a proxy to `https://<anything>.<DOMAIN>`.
	const res = await SELF.fetch('https://example.com/docs/openapi/evil.json')
	expect(res.status).toBe(404)
})

// ---- Discord benefits claim ------------------------------------------------

// All four settings are the switch, exactly as the Turnstile keypair is for signup: a
// half-configured app must read as OFF. The dangerous half is a client id and secret with
// no guild/role — that authenticates a player and then has no question left to ask about
// them, so treating it as configured would hand Rec Room Plus to anyone with a Discord
// account. Checked directly because the configured path can't be reached from here (it
// would call discord.com for real).
it('treats a half-configured discord app as benefit claims being off', async () => {
	const stub = (value: string | null): SecretsStoreSecret =>
		({ get: async () => value ?? '' }) as SecretsStoreSecret
	const throws = (): SecretsStoreSecret =>
		({
			get: async () => {
				throw new Error('secret not found')
			},
		}) as unknown as SecretsStoreSecret

	const withDiscord = (
		id: SecretsStoreSecret,
		secret: SecretsStoreSecret,
		guildId?: string,
		roleIds?: string
	) =>
		({
			ENVIRONMENT: 'development',
			DISCORD_CLIENT_ID: id,
			DISCORD_CLIENT_SECRET: secret,
			DISCORD_GUILD_ID: guildId,
			DISCORD_BENEFITS_ROLE_IDS: roleIds,
		}) as Env

	const id = stub('client-id')
	const secret = stub('client-secret')
	// Snowflakes, as the real vars hold: ids are all digits, never a role's display name.
	const guild = '1077000000000000000'
	const role = '1077000000000000001'

	// Nothing at all, and a store this worker can't read: both closed, never a 500.
	await expect(discordConfig(withDiscord(throws(), throws()))).resolves.toBeNull()
	await expect(discordConfig(withDiscord(stub(''), stub(''), '', ''))).resolves.toBeNull()
	// Each single missing piece, including the two that would otherwise grant Plus for a
	// bare Discord login.
	await expect(discordConfig(withDiscord(throws(), secret, guild, role))).resolves.toBeNull()
	await expect(discordConfig(withDiscord(id, throws(), guild, role))).resolves.toBeNull()
	await expect(discordConfig(withDiscord(id, secret, '', role))).resolves.toBeNull()
	await expect(discordConfig(withDiscord(id, secret, guild, ''))).resolves.toBeNull()
	await expect(discordConfig(withDiscord(id, secret))).resolves.toBeNull()
	// A role list that parses to NO ids is unset, not configured — otherwise a stray comma
	// left in the var would open the claim with nothing to check against.
	await expect(discordConfig(withDiscord(id, secret, guild, ' , , '))).resolves.toBeNull()
	// All four present is the only configured state.
	await expect(discordConfig(withDiscord(id, secret, guild, role))).resolves.toEqual({
		clientId: 'client-id',
		clientSecret: 'client-secret',
		guildId: guild,
		roleIds: [role],
	})
	// Several qualifying roles is the ordinary case, not a special one.
	const second = '1077000000000000002'
	await expect(discordConfig(withDiscord(id, secret, guild, `${role},${second}`))).resolves.toEqual(
		{
			clientId: 'client-id',
			clientSecret: 'client-secret',
			guildId: guild,
			roleIds: [role, second],
		}
	)
})

// Several roles can qualify for the same benefit (a supporter role, a booster role,
// staff…), so the list is parsed leniently: an operator pasting ids out of Discord gets
// one per line, and a trailing comma is a typo rather than a role of '' that nothing
// could ever match. Every id is a snowflake — all digits, kept as a string.
it('parses a qualifying-role list however an operator writes it', () => {
	expect(parseRoleIds('1077000000000000001')).toEqual(['1077000000000000001'])
	expect(parseRoleIds('1077000000000000001,1077000000000000002')).toEqual([
		'1077000000000000001',
		'1077000000000000002',
	])
	expect(parseRoleIds(' 1077000000000000001 , 1077000000000000002 ')).toEqual([
		'1077000000000000001',
		'1077000000000000002',
	])
	// Pasted a line at a time, straight out of Discord.
	expect(parseRoleIds('1077000000000000001\n1077000000000000002\n')).toEqual([
		'1077000000000000001',
		'1077000000000000002',
	])
	// Kept as STRINGS, never parsed to numbers: a snowflake exceeds 2^53, so
	// Number('1077000000000000001') would round and stop matching the real role.
	expect(parseRoleIds('1077000000000000001')[0]).toBe('1077000000000000001')
	// Nothing to match on — these are the values that must close the claim.
	expect(parseRoleIds('')).toEqual([])
	expect(parseRoleIds('  ')).toEqual([])
	expect(parseRoleIds(',,')).toEqual([])
	// A trailing separator adds no empty id, which would match no role and never qualify.
	expect(parseRoleIds('1077000000000000001,')).toEqual(['1077000000000000001'])
})

// ANY one of the configured roles qualifies — they are alternatives, not requirements.
// Testing for a subset instead would mean a player had to hold every tier at once, i.e.
// nobody would ever claim.
it('qualifies a member holding any one of the roles', () => {
	// Ids on both sides — Discord reports a member's roles as snowflakes, never as names.
	const supporter = '1077000000000000001'
	const booster = '1077000000000000002'
	const qualifying = [supporter, booster]

	expect(qualifies([supporter], qualifying)).toBe(true)
	expect(qualifies([booster], qualifying)).toBe(true)
	expect(qualifies([booster, supporter], qualifying)).toBe(true)
	// Holding some other role in the server is not enough.
	expect(qualifies(['1077000000000000009'], qualifying)).toBe(false)
	expect(qualifies([], qualifying)).toBe(false)
})

// The closed door, from the outside. This must be refused BEFORE the token is looked at,
// so an unconfigured server can't be talked into a claim by a valid session.
it('refuses a benefits claim when discord is only half configured', async () => {
	const res = await SELF.fetch('https://example.com/api/benefits/claim', {
		method: 'POST',
		headers: {
			'content-type': 'application/json',
			authorization: `Bearer ${await tokenFor(4001)}`,
		},
		body: JSON.stringify({ code: 'whatever' }),
	})
	expect(res.status).toBe(403)
	expect(await res.json()).toEqual({ error: 'Benefit claims are currently disabled.' })
})

// The benefits routes act on ONE account — the claim writes `hasPlus` onto its row — so
// which account it is has to come from a verified token and never from the request. Both
// halves of "verified" are pinned: no token, and a token signed with a key this server
// doesn't use (i.e. one it never issued).
//
// Asserted on `/api/benefits/status` because it's the benefits route whose auth gate is
// reachable here: the claim refuses on the config gate FIRST (covered above), which is
// the right order — an unconfigured server shouldn't be examining credentials for a
// feature it doesn't run — but it means an unconfigured project can't observe its 401.
it('requires a valid session to read benefits', async () => {
	const path = 'https://example.com/api/benefits/status'

	// No token at all.
	expect((await SELF.fetch(path)).status).toBe(401)

	// A token that is well-formed but signed with the wrong key.
	const forged = await generateToken('4002', '', 4, 'not-the-real-secret')
	const res = await SELF.fetch(path, { headers: { authorization: `Bearer ${forged}` } })
	expect(res.status).toBe(401)
})

// What the claim page renders before anyone presses anything. `hasPlus` is read off the
// account ROW rather than a token claim, because it's set after the browser's token was
// issued — a freshly-claimed player's token says nothing about it.
it('reports where an account stands on benefits', async () => {
	const token = await tokenFor(4003)

	// An account with no row at all reads as "nothing claimed" rather than 404ing: every
	// account has a benefits status, whether or not it has been written to yet.
	let res = await SELF.fetch('https://example.com/api/benefits/status', {
		headers: { authorization: `Bearer ${token}` },
	})
	expect(res.status).toBe(200)
	expect(await res.json()).toEqual({ hasPlus: false, linked: false })

	await updateAccount(env.DB, 4003, { hasPlus: true })
	await linkPlatformIdentity(env.DB, 4003, PlatformType.Discord, '99001')
	res = await SELF.fetch('https://example.com/api/benefits/status', {
		headers: { authorization: `Bearer ${token}` },
	})
	// `linked` says THAT a Discord identity is attached, never which one — the id is of no
	// use to the page, and an account's linked identities have no business on the wire.
	expect(await res.json()).toEqual({ hasPlus: true, linked: true })
})

// The once-only guard the claim is built on. Without it, one Discord member holding the
// role could walk it around every RecFlare account they own; with it, the second claim is
// refused and the first account keeps the benefit. Exercised at the two lookups the route
// asks, since the route's own path to them runs through discord.com.
it('tells a repeat claim from a second account claiming the same discord identity', async () => {
	await updateAccount(env.DB, 4004, { hasPlus: true })
	await linkPlatformIdentity(env.DB, 4004, PlatformType.Discord, '99002')

	// The identity is taken, so a DIFFERENT account claiming it is the 409 case…
	await expect(
		countAccountsForPlatformIdentity(env.DB, PlatformType.Discord, '99002')
	).resolves.toBe(1)
	await expect(isPlatformIdentityLinked(env.DB, 4005, PlatformType.Discord, '99002')).resolves.toBe(
		false
	)

	// …while the account that already holds it re-claims idempotently, which is what makes
	// the page safe to reload and a lapsed-then-restored role re-claimable.
	await expect(isPlatformIdentityLinked(env.DB, 4004, PlatformType.Discord, '99002')).resolves.toBe(
		true
	)

	// A Discord member who has claimed nowhere yet.
	await expect(
		countAccountsForPlatformIdentity(env.DB, PlatformType.Discord, '99003')
	).resolves.toBe(0)
})

// A Discord link must never become a way INTO an account. The login picker is public and
// unauthenticated, so listing one would both offer the client an account it can't redeem
// (the grant refuses platform 101) and tell anyone which RecFlare account a Discord user
// owns — a snowflake is readable by anyone sharing a server with them. `auth` owns that
// gate; this pins that the platform www writes to is one the gate actually excludes.
it('stores the discord identity on a platform the login picker will not list', () => {
	expect(CACHED_LOGIN_PLATFORMS).not.toContain(PlatformType.Discord)
})

// The privacy policy is what the Meta Horizon Store's VRC.Privacy.1–4 checks are run
// against, and a reviewer only sees the rendered page — so the four things they look
// for are pinned here. If a section is renamed, re-read the VRC before loosening the
// assertion: these strings are the requirement, not incidental copy.
it('serves the privacy policy as real server-rendered HTML', async () => {
	const res = await SELF.fetch('https://example.com/privacy')
	// VRC.Privacy.1 — live, public, no sign-in, and text without JavaScript.
	expect(res.status).toBe(200)
	expect(res.headers.get('content-type')).toContain('text/html')
	const html = await res.text()
	expect(html).toContain('Privacy Policy')

	// VRC.Privacy.2 — what is collected, VRC.Privacy.3 — what it is used for.
	expect(html).toContain('What we collect')
	expect(html).toContain('Why we use it')

	// VRC.Privacy.4 — deletion is explained, free, and open to every region.
	expect(html).toContain('Deleting your data')
	expect(html).toMatch(/delete your account[^.]*at any\s+time, from anywhere in the world/)
	expect(html).toContain('There is no charge for this')

	// A deletion route a reader can actually follow. Discord and GitHub are always
	// listed; the mailbox only when one is configured (see PRIVACY_EMAIL).
	expect(html).toContain(DISCORD_INVITE)
	expect(html).toContain(ISSUES_URL)
	if (PRIVACY_EMAIL) expect(html).toContain(`mailto:${PRIVACY_EMAIL}`)
})
