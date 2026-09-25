import { adminSecretsStore, env, SELF } from 'cloudflare:test'
import { beforeAll, expect, it } from 'vitest'

import { SCHEMA_DDL as ACCOUNT_SCHEMA_DDL, updateAccount } from '@repo/domain/src/accounts-db'
import { AUDIT_LOG_SCHEMA_DDL } from '@repo/domain/src/audit-db'
import { PlatformType } from '@repo/domain/src/enums'
import { getPendingGifts, RECEIVED_GIFT_SCHEMA_DDL } from '@repo/domain/src/gifts-db'
import {
	PRESENCE_SCHEMA_DDL,
	PRESENCE_TTL_SECONDS,
	setPresence,
} from '@repo/domain/src/presence-db'
import { getProgression, PROGRESSION_SCHEMA_DDL } from '@repo/domain/src/progression-db'
import { ROOM_INSTANCE_SCHEMA_DDL } from '@repo/domain/src/room-instance-db'
// Banning a player moves them into their own dorm, which is a room (created on demand) with
// a subroom — so those tables have to be here, as they are on the shared database.
import { ROOM_SCHEMA_DDL, SUBROOM_SCHEMA_DDL } from '@repo/domain/src/rooms-db'
import { recordStat, STAT_SCHEMA_DDL } from '@repo/domain/src/stats-db'
import { generateToken } from '@repo/jwt'

import {
	createCustomAvatarItem,
	SCHEMA_DDL as CUSTOM_AVATAR_ITEM_SCHEMA_DDL,
} from '../../../../api/src/custom-avatar-items-db'
import {
	createReport,
	getReportById,
	SCHEMA_DDL as REPORT_SCHEMA_DDL,
} from '../../../../api/src/reports-db'
import { createWarning, SCHEMA_DDL as WARNING_SCHEMA_DDL } from '../../../../api/src/warnings-db'
import {
	CACHED_LOGIN_PLATFORMS,
	countAccountsForPlatformIdentity,
	isPlatformIdentityLinked,
	linkPlatformIdentity,
	PLATFORM_SCHEMA_DDL,
} from '../../../../auth/src/platform-db'
import {
	BALANCE_SCHEMA_DDL,
	CurrencyType,
	DEFAULT_STARTING_TOKENS,
	getBalance,
} from '../../../../econ/src/balance-db'
import { CATALOG_SCHEMA_DDL } from '../../../../econ/src/catalog-db'
import { CONSUMABLE_SCHEMA_DDL, getConsumables } from '../../../../econ/src/consumables-db'
import { EQUIPMENT_SCHEMA_DDL, getEquipment } from '../../../../econ/src/equipment-db'
import {
	grantCustomAvatarItem,
	INVENTORY_CUSTOM_SCHEMA_DDL,
	ownedCustomAvatarItemIds,
} from '../../../../econ/src/inventory-custom-db'
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
const tokenFor = (accountId: number, roles: string[] = []): Promise<string> =>
	generateToken(String(accountId), '', 4, TEST_JWT_SECRET, roles)

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
	// `report` and `warning` are owned (and migrated) by `api`; www serves the staff panel
	// over them, so the tables have to exist here too. `room_instance` comes with them
	// because a ban ejects the banned player from the instance they're standing in.
	for (const stmt of REPORT_SCHEMA_DDL) await env.DB.prepare(stmt).run()
	for (const stmt of WARNING_SCHEMA_DDL) await env.DB.prepare(stmt).run()
	for (const stmt of ROOM_INSTANCE_SCHEMA_DDL) await env.DB.prepare(stmt).run()
	for (const stmt of ROOM_SCHEMA_DDL) await env.DB.prepare(stmt).run()
	for (const stmt of SUBROOM_SCHEMA_DDL) await env.DB.prepare(stmt).run()
	// `stat` is written by the `match` presence cron; www only reads it, for `/stats`.
	for (const stmt of STAT_SCHEMA_DDL) await env.DB.prepare(stmt).run()
	// `audit_log` is owned by `api`; www files a row there for every ban and lift.
	for (const stmt of AUDIT_LOG_SCHEMA_DDL) await env.DB.prepare(stmt).run()
	// `balance` and `received_gift` are owned by `econ`; a staff token gift writes both.
	for (const stmt of BALANCE_SCHEMA_DDL) await env.DB.prepare(stmt).run()
	for (const stmt of RECEIVED_GIFT_SCHEMA_DDL) await env.DB.prepare(stmt).run()
	// A custom item gift reads `custom_avatar_item` (owned by `api`) and writes
	// `inventory_custom` (owned by `econ`).
	for (const stmt of CUSTOM_AVATAR_ITEM_SCHEMA_DDL) await env.DB.prepare(stmt).run()
	for (const stmt of INVENTORY_CUSTOM_SCHEMA_DDL) await env.DB.prepare(stmt).run()
	// A skin or consumable gift resolves its item in `catalog` and writes `equipment` or
	// `consumable` — all three `econ`'s.
	for (const stmt of CATALOG_SCHEMA_DDL) await env.DB.prepare(stmt).run()
	for (const stmt of EQUIPMENT_SCHEMA_DDL) await env.DB.prepare(stmt).run()
	for (const stmt of CONSUMABLE_SCHEMA_DDL) await env.DB.prepare(stmt).run()
	// And an XP gift writes `progression`.
	for (const stmt of PROGRESSION_SCHEMA_DDL) await env.DB.prepare(stmt).run()
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

// The series behind `/stats`. What's pinned: samples fold into the range's bucket as its
// PEAK, the average is over the raw samples (not over the buckets), samples outside the
// window and other stat types stay out, and the range is a closed list.
it('serves the online series bucketed by range, peak per bucket', async () => {
	await env.DB.prepare('DELETE FROM stat').run()
	// Anchored to the start of the previous hour so the three samples provably share one
	// hourly bucket, whenever the test runs.
	const hour = Math.floor(Date.now() / 3_600_000) * 3_600_000 - 3_600_000
	await recordStat(env.DB, 'online', 4, new Date(hour))
	await recordStat(env.DB, 'online', 9, new Date(hour + 5 * 60_000))
	await recordStat(env.DB, 'online', 2, new Date(hour + 10 * 60_000))
	await recordStat(env.DB, 'online', 50, new Date(hour - 8 * 86_400_000)) // before the 7d window
	await recordStat(env.DB, 'rooms', 99, new Date(hour)) // another series entirely

	let res = await SELF.fetch('https://example.com/api/stats/online?range=7d')
	expect(res.status).toBe(200)
	const week = await res.json<{
		bucketSeconds: number
		from: number
		to: number
		peak: number
		average: number
		points: Array<{ t: number; players: number }>
	}>()
	expect(week.bucketSeconds).toBe(3600)
	expect(week.to - week.from).toBe(7 * 86_400)
	expect(week.points).toEqual([{ t: hour / 1000, players: 9 }])
	expect(week.peak).toBe(9)
	expect(week.average).toBe(5)

	// The default range is the raw five-minute series: one point per sample.
	res = await SELF.fetch('https://example.com/api/stats/online')
	const day = await res.json<{ range: string; points: Array<{ players: number }> }>()
	expect(day.range).toBe('24h')
	expect(day.points.map((p) => p.players)).toEqual([4, 9, 2])

	// The 30-day window reaches the old sample the week didn't.
	res = await SELF.fetch('https://example.com/api/stats/online?range=30d')
	expect((await res.json<{ peak: number }>()).peak).toBe(50)

	res = await SELF.fetch('https://example.com/api/stats/online?range=forever')
	expect(res.status).toBe(400)
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

// ---- Staff moderation panel -------------------------------------------------
//
// The `/api/staff/*` endpoints behind the `/moderation` page (see src/staff.ts). These
// are recflare's own surface — no Rec Room client calls them — which is why they live on
// `www` rather than on the workers that reimplement the game's API.
//
// The gate is the whole security model here: every route reads and writes moderation
// state for any account, so the tests below pin BOTH refusals (no token, and a valid
// token without a staff role) as carefully as they pin the happy paths.

/** GET a staff endpoint as `accountId`, with or without the staff role. */
async function staffGet(path: string, accountId: number, roles: string[] = ['moderator']) {
	return SELF.fetch(`https://example.com${path}`, {
		headers: { authorization: `Bearer ${await tokenFor(accountId, roles)}` },
	})
}

/** POST a JSON body to a staff endpoint as a moderator (or whatever `roles` names). */
async function staffPost(
	path: string,
	accountId: number,
	body: unknown,
	roles: string[] = ['moderator']
) {
	return SELF.fetch(`https://example.com${path}`, {
		method: 'POST',
		headers: {
			authorization: `Bearer ${await tokenFor(accountId, roles)}`,
			'content-type': 'application/json',
		},
		body: JSON.stringify(body),
	})
}

/** POST a JSON body to a developer-only staff endpoint (the gifts) as a developer. */
const devPost = (path: string, accountId: number, body: unknown) =>
	staffPost(path, accountId, body, ['developer'])

// Two refusals, not one. A 401 is an expired session — the SPA drops the token and sends
// the player to sign in — while a 403 is a signed-in player who simply isn't staff, and
// looping THEM through a sign-in would change nothing. Every route is checked, because
// the gate is middleware and a route registered outside it would be wide open.
it('refuses every staff endpoint without a token, and without a staff role', async () => {
	const paths = [
		'/api/staff/reports',
		'/api/staff/reports/top-reported',
		'/api/staff/reports/1',
		'/api/staff/bans',
		'/api/staff/players/1',
		'/api/staff/players/1/linked',
	]
	const writes = [
		'/api/staff/players/1/gift-tokens',
		'/api/staff/players/1/gift-item',
		'/api/staff/players/1/gift-xp',
		'/api/staff/players/1/username-changes',
		'/api/staff/players/1/clear-password',
	]
	writes.push('/api/staff/rooms/1/gift-tokens', '/api/staff/online/gift-tokens')
	for (const path of writes) {
		expect((await SELF.fetch(`https://example.com${path}`, { method: 'POST' })).status).toBe(401)
		const res = await SELF.fetch(`https://example.com${path}`, {
			method: 'POST',
			headers: { authorization: `Bearer ${await tokenFor(8101, ['gameClient'])}` },
		})
		expect(res.status).toBe(403)
	}

	// The gifts are narrower: a moderator is staff, but not a developer.
	for (const path of writes.filter((p) => p.includes('/gift-'))) {
		expect((await staffPost(path, 8101, { amount: 1 })).status).toBe(403)
	}

	for (const path of paths) {
		expect((await SELF.fetch(`https://example.com${path}`)).status).toBe(401)
		// A valid token whose `role` claim is a plain player's.
		expect((await staffGet(path, 8101, ['gameClient'])).status).toBe(403)
	}

	// The writes too, on the same terms.
	const unauthed = await SELF.fetch('https://example.com/api/staff/reports', {
		method: 'POST',
		headers: { 'content-type': 'application/json' },
		body: JSON.stringify({ reportedPlayerId: 8102 }),
	})
	expect(unauthed.status).toBe(401)

	const player = await SELF.fetch('https://example.com/api/staff/reports/1/ban', {
		method: 'POST',
		headers: {
			authorization: `Bearer ${await tokenFor(8101, ['gameClient'])}`,
			'content-type': 'application/json',
		},
		body: JSON.stringify({ banned: true, days: 1 }),
	})
	expect(player.status).toBe(403)
})

// The reporter is the CALLER, never a body field — that is the record of who raised a
// hand-written report, and it is why nothing marks these rows as staff-created.
it('files a minimal report as the acting moderator', async () => {
	const res = await staffPost('/api/staff/reports', 8110, {
		reportedPlayerId: 8111,
		reportCategory: 102,
		details: 'Seen in a log, in the Rec Center',
	})
	expect(res.status).toBe(200)
	const report = (await res.json()) as Record<string, unknown>
	expect(report.reporter_player_id).toBe(8110)
	expect(report.reported_player_id).toBe(8111)
	expect(report.report_category).toBe(102)
	expect(report.details).toBe('Seen in a log, in the Rec Center')
	// Filed unbanned: a report is not a ban, and the ban is a separate decision.
	expect(report.banned).toBe(0)
	expect(report.banned_at).toBeNull()
	expect(report.banned_by_player_id).toBeNull()
})

// Who, what kind and why — and nothing else. A moderator does not know a room's numeric
// id and would have to go and look it up, so WHERE goes in `details` with the rest of the
// account of what happened. `room_id` is a player report's column: the client that filed
// one knows the id it was standing in, and a hand-written row must not pretend to.
it('ignores a room id on a hand-written report', async () => {
	const res = await staffPost('/api/staff/reports', 8110, {
		reportedPlayerId: 8112,
		details: 'In someone’s dorm',
		roomId: 991,
	})
	expect(res.status).toBe(200)
	expect(((await res.json()) as Record<string, unknown>).room_id).toBeNull()
})

it('refuses a report with no player, and one a moderator files against themselves', async () => {
	expect((await staffPost('/api/staff/reports', 8110, {})).status).toBe(400)
	// The self-report is a mistake every time, and the ban it would justify locks the
	// panel's own operator out of the game.
	expect((await staffPost('/api/staff/reports', 8110, { reportedPlayerId: 8110 })).status).toBe(400)
})

// The search is the panel's way into the log, so each filter is pinned separately: a
// filter that quietly doesn't apply looks like "no reports of that kind" rather than an
// error, which is the failure a moderator would act on.
it('searches reports by player, by reporter and by ban state', async () => {
	const target = 8120
	await createReport(env.DB, {
		reporterPlayerId: 8121,
		reportedPlayerId: target,
		reportCategory: 101,
		details: 'first',
	})
	await createReport(env.DB, {
		reporterPlayerId: 8122,
		reportedPlayerId: target,
		reportCategory: 102,
		details: 'second',
	})
	await createReport(env.DB, { reporterPlayerId: 8121, reportedPlayerId: 8123, details: 'other' })

	const byPlayer = (await (
		await staffGet(`/api/staff/reports?reportedPlayerId=${target}`, 8110)
	).json()) as { reports: Array<{ details: string }>; total: number }
	// Newest first, and only the two against this player.
	expect(byPlayer.total).toBe(2)
	expect(byPlayer.reports.map((r) => r.details)).toEqual(['second', 'first'])

	const byReporter = (await (
		await staffGet('/api/staff/reports?reporterPlayerId=8122', 8110)
	).json()) as { total: number }
	expect(byReporter.total).toBe(1)

	const byCategory = (await (
		await staffGet(`/api/staff/reports?reportedPlayerId=${target}&reportCategory=101`, 8110)
	).json()) as { reports: Array<{ details: string }> }
	expect(byCategory.reports.map((r) => r.details)).toEqual(['first'])

	// An ABSENT `banned` param must not read as `false` — that would hide every actioned
	// report from an unfiltered search, which is most of what a moderator looks for.
	const unfiltered = (await (
		await staffGet(`/api/staff/reports?reportedPlayerId=${target}`, 8110)
	).json()) as { total: number }
	expect(unfiltered.total).toBe(2)
	const unbanned = (await (
		await staffGet(`/api/staff/reports?reportedPlayerId=${target}&banned=false`, 8110)
	).json()) as { total: number }
	expect(unbanned.total).toBe(2)
	const banned = (await (
		await staffGet(`/api/staff/reports?reportedPlayerId=${target}&banned=true`, 8110)
	).json()) as { total: number }
	expect(banned.total).toBe(0)
})

// `total` is the unpaged count of the same predicate, so the pager can say "26–50 of 120"
// without re-deriving it — and a page smaller than the count is not the end of the list.
it('pages the search, reporting the full match count alongside the page', async () => {
	const target = 8130
	for (let i = 0; i < 5; i++) {
		await createReport(env.DB, {
			reporterPlayerId: 8131,
			reportedPlayerId: target,
			details: `r${i}`,
		})
	}

	const first = (await (
		await staffGet(`/api/staff/reports?reportedPlayerId=${target}&take=2`, 8110)
	).json()) as { reports: Array<{ details: string }>; total: number }
	expect(first.total).toBe(5)
	expect(first.reports.map((r) => r.details)).toEqual(['r4', 'r3'])

	const second = (await (
		await staffGet(`/api/staff/reports?reportedPlayerId=${target}&take=2&skip=2`, 8110)
	).json()) as { reports: Array<{ details: string }>; total: number }
	expect(second.total).toBe(5)
	expect(second.reports.map((r) => r.details)).toEqual(['r2', 'r1'])
})

// Ranked by DISTINCT reporters ahead of raw count. One player filing twenty reports
// against someone they're feuding with is a different thing from twenty players filing
// one each, and a queue that can't tell them apart puts the feud at the top.
it('ranks the report queue by distinct reporters, not by raw count', async () => {
	const feud = 8140
	const real = 8141
	// Four reports, all from the same person.
	for (let i = 0; i < 4; i++) {
		await createReport(env.DB, { reporterPlayerId: 8142, reportedPlayerId: feud })
	}
	// Three reports, three different people.
	for (const reporter of [8143, 8144, 8145]) {
		await createReport(env.DB, { reporterPlayerId: reporter, reportedPlayerId: real })
	}

	const rows = (await (
		await staffGet('/api/staff/reports/top-reported?minReports=3', 8110)
	).json()) as Array<{ playerId: number; reports: number; distinctReporters: number }>

	const feudRow = rows.find((r) => r.playerId === feud)
	const realRow = rows.find((r) => r.playerId === real)
	expect(feudRow).toMatchObject({ reports: 4, distinctReporters: 1 })
	expect(realRow).toMatchObject({ reports: 3, distinctReporters: 3 })
	// Fewer reports, more reporters — and so ahead of the feud in the list.
	expect(rows.indexOf(realRow!)).toBeLessThan(rows.indexOf(feudRow!))
})

it('keeps the long tail of single reports out of the queue', async () => {
	await createReport(env.DB, { reporterPlayerId: 8151, reportedPlayerId: 8150 })
	const rows = (await (
		await staffGet('/api/staff/reports/top-reported?minReports=3', 8110)
	).json()) as Array<{ playerId: number }>
	expect(rows.map((r) => r.playerId)).not.toContain(8150)

	// …but it is a threshold, not a rule: a moderator can lower it.
	const all = (await (
		await staffGet('/api/staff/reports/top-reported?minReports=1', 8110)
	).json()) as Array<{ playerId: number }>
	expect(all.map((r) => r.playerId)).toContain(8150)
})

// The ban: a duration in, an expiry stored, and the audit trail that 0020 added. The
// duration matters because `banned_at` is what the client's block screen counts the ban
// from — see `banBlockDetails`.
it('bans from a report, recording who did it and when', async () => {
	const report = await createReport(env.DB, {
		reporterPlayerId: 8161,
		reportedPlayerId: 8160,
		reportCategory: 102,
	})
	const before = Date.now()

	const res = await staffPost(`/api/staff/reports/${report.id}/ban`, 8110, {
		banned: true,
		days: 7,
	})
	expect(res.status).toBe(200)
	const banned = (await res.json()) as Record<string, unknown>

	expect(banned.banned).toBe(1)
	expect(banned.banned_by_player_id).toBe(8110)
	expect(Date.parse(banned.banned_at as string)).toBeGreaterThanOrEqual(before)
	// Seven days out, give or take the test's own runtime.
	const expires = Date.parse(banned.ban_expires as string)
	expect(expires - Date.parse(banned.banned_at as string)).toBeCloseTo(7 * 86_400_000, -4)

	// And it shows up as a ban in force, which is a different question from `banned = 1`.
	const bans = (await (await staffGet('/api/staff/bans', 8110)).json()) as Array<{ id: number }>
	expect(bans.map((b) => b.id)).toContain(report.id)
})

it('bans permanently when asked, and refuses a duration in the past', async () => {
	const report = await createReport(env.DB, { reporterPlayerId: 8171, reportedPlayerId: 8170 })

	const permanent = await staffPost(`/api/staff/reports/${report.id}/ban`, 8110, {
		banned: true,
		permanent: true,
	})
	expect(permanent.status).toBe(200)
	// NULL is what records "never lifts" — not a far-future date.
	expect(((await permanent.json()) as Record<string, unknown>).ban_expires).toBeNull()

	// An expiry that was ASKED for but can't be honoured is refused rather than quietly
	// becoming a permanent ban — the one mistake here that waiting cannot undo.
	const past = await staffPost(`/api/staff/reports/${report.id}/ban`, 8110, {
		banned: true,
		expires: '2001-01-01T00:00:00.000Z',
	})
	expect(past.status).toBe(400)
	const nonsense = await staffPost(`/api/staff/reports/${report.id}/ban`, 8110, {
		banned: true,
		expires: 'next tuesday',
	})
	expect(nonsense.status).toBe(400)
})

// A lift has to leave the row distinguishable from an EXPIRED ban (banned = 0 versus a
// past ban_expires), and must not leave an audit trail saying a ban runs from somewhere.
it('lifts a ban, clearing the expiry and the audit columns but keeping the report', async () => {
	const report = await createReport(env.DB, {
		reporterPlayerId: 8181,
		reportedPlayerId: 8180,
		details: 'still on file',
	})
	expect((await staffPost(`/api/staff/reports/${report.id}/ban`, 8110, { days: 1 })).status).toBe(
		200
	)

	const lifted = await staffPost(`/api/staff/reports/${report.id}/ban`, 8111, { banned: false })
	expect(lifted.status).toBe(200)
	const row = (await lifted.json()) as Record<string, unknown>
	expect(row.banned).toBe(0)
	expect(row.ban_expires).toBeNull()
	expect(row.banned_at).toBeNull()
	expect(row.banned_by_player_id).toBeNull()
	// The report itself survives — it is the record of what was reported, not of the ban.
	expect(row.details).toBe('still on file')

	const bans = (await (await staffGet('/api/staff/bans', 8110)).json()) as Array<{ id: number }>
	expect(bans.map((b) => b.id)).not.toContain(report.id)
})

// A lift wipes the ban columns, so without its own signature the row reads exactly like a
// report nobody acted on — and the next moderator to search the player saw "Ban…" and
// re-banned someone a colleague had deliberately let back in. The lift signs the row with
// who and when; the search serves it; a re-ban clears it, since a standing ban is not lifted.
it('signs a lifted ban with who lifted it, and clears that on a re-ban', async () => {
	const player = 8240
	const report = await createReport(env.DB, { reporterPlayerId: 8241, reportedPlayerId: player })
	expect((await staffPost(`/api/staff/reports/${report.id}/ban`, 8110, { days: 1 })).status).toBe(
		200
	)
	// Untouched until a lift — a standing ban has not been lifted.
	const banned = (await (await staffGet(`/api/staff/reports/${report.id}`, 8110)).json()) as Record<
		string,
		unknown
	>
	expect(banned).toMatchObject({ banned: 1, unbanned_by_player_id: null, unbanned_at: null })

	const lifted = (await (
		await staffPost(`/api/staff/reports/${report.id}/ban`, 8111, { banned: false })
	).json()) as Record<string, unknown>
	// Signed by the LIFTING moderator, not the banning one.
	expect(lifted).toMatchObject({ banned: 0, unbanned_by_player_id: 8111 })
	expect(lifted.unbanned_at).toEqual(expect.any(String))

	// The search — `/moderation/search?reportedPlayerId=…` — is where the next moderator
	// meets the row, so it has to carry the signature too.
	const search = (await (
		await staffGet(`/api/staff/reports?reportedPlayerId=${player}`, 8110)
	).json()) as { reports: Array<Record<string, unknown>> }
	expect(search.reports).toHaveLength(1)
	expect(search.reports[0]).toMatchObject({
		id: report.id,
		banned: 0,
		unbanned_by_player_id: 8111,
		unbanned_at: lifted.unbanned_at,
	})
	// And the player's own page, which the search links to.
	const history = (await (await staffGet(`/api/staff/players/${player}`, 8110)).json()) as {
		activeBan: unknown
		reports: Array<Record<string, unknown>>
	}
	expect(history.activeBan).toBeNull()
	expect(history.reports[0]).toMatchObject({ unbanned_by_player_id: 8111 })

	// Banning again — knowingly — is a standing ban once more, with no lift on it.
	const rebanned = (await (
		await staffPost(`/api/staff/reports/${report.id}/ban`, 8112, { days: 7 })
	).json()) as Record<string, unknown>
	expect(rebanned).toMatchObject({
		banned: 1,
		banned_by_player_id: 8112,
		unbanned_by_player_id: null,
		unbanned_at: null,
	})
})

// The report row keeps only the ban's CURRENT state — a lift wipes who banned and when —
// so the audit log is the one place a ban and its lift are both still on record.
it('records a ban and its lift on the audit log, against the moderator', async () => {
	const report = await createReport(env.DB, {
		reporterPlayerId: 8186,
		reportedPlayerId: 8185,
		reportCategory: 102,
	})
	expect((await staffPost(`/api/staff/reports/${report.id}/ban`, 8110, { days: 2 })).status).toBe(
		200
	)
	expect(
		(await staffPost(`/api/staff/reports/${report.id}/ban`, 8111, { banned: false })).status
	).toBe(200)

	const { results } = await env.DB.prepare(
		`SELECT player_id, action, data FROM audit_log
		 WHERE action IN ('ban', 'unban') AND json_extract(data, '$.reportId') = ?1
		 ORDER BY audit_log_id`
	)
		.bind(report.id)
		.all<{ player_id: number; action: string; data: string }>()
	expect(results.map((r) => [r.player_id, r.action])).toEqual([
		[8110, 'ban'],
		[8111, 'unban'],
	])

	const ban = JSON.parse(results[0].data)
	expect(ban).toMatchObject({ reportId: report.id, playerId: 8185, reportCategory: 102 })
	expect(ban.banExpires).toEqual(expect.any(String))
	expect(ban.previous).toMatchObject({ banned: false, bannedBy: null })

	// The lift names who it undid: the report row itself no longer can.
	const unban = JSON.parse(results[1].data)
	expect(unban).toMatchObject({ playerId: 8185, banExpires: null })
	expect(unban.previous).toMatchObject({
		banned: true,
		bannedBy: 8110,
		banExpires: ban.banExpires,
	})
})

it('answers a ban on a report that does not exist with a 404', async () => {
	expect((await staffPost('/api/staff/reports/99999/ban', 8110, { days: 1 })).status).toBe(404)
	expect((await staffGet('/api/staff/reports/99999', 8110)).status).toBe(404)
})

// Without this a ban only bites on the player's NEXT matchmake: `match` refuses a banned
// player, but nothing revisits a session already in progress, so someone banned
// mid-session keeps playing until they leave on their own.
it('throws a banned player out of the instance they are standing in', async () => {
	const hub = () => env.RECFLARE_NOTIFICATIONS_HUB.getByName('global')
	await hub().fetch('http://do/all', { method: 'DELETE' })

	await setPresence(env.DB, {
		accountId: 8190,
		roomInstance: { roomInstanceId: 77001 },
		statusVisibility: 0,
		deviceClass: 0,
		vrMovementMode: 0,
		platform: 4,
		appVersion: 'test',
	})
	const report = await createReport(env.DB, { reporterPlayerId: 8191, reportedPlayerId: 8190 })
	expect((await staffPost(`/api/staff/reports/${report.id}/ban`, 8110, { days: 3 })).status).toBe(
		200
	)

	const frames = (await (await hub().fetch('http://do/all')).json()) as Array<{
		playerIds?: number[]
		ephemeral?: boolean
		notificationType: number | string
		data: Record<string, unknown>
	}>
	expect(frames).toHaveLength(1)
	expect(frames[0].playerIds).toEqual([8190])
	// EPHEMERAL: a kick is true of the moment it happened. Queued and delivered on a later
	// connect it would eject them from an unrelated session.
	expect(frames[0].ephemeral).toBe(true)
	// `IsBan` is what makes the client's screen name this a ban rather than a kick.
	expect(frames[0].data.IsBan).toBe(true)
	expect(frames[0].data.GameSessionId).toBe(77001)

	// The SAME ban the sign-in screen describes, not a generic one: its category, message and
	// the Duration/TimeoutStartedAt pair, three days from when it was handed down.
	const banned = await getReportById(env.DB, report.id)
	expect(frames[0].data).toMatchObject({
		ReportCategory: banned!.report_category,
		Message: 'Rule violation',
		TimeoutStartedAt: banned!.banned_at,
		Duration: 3 * 86_400,
	})

	// And they are out of that instance — moved into their own DORM, not deleted: `match`
	// lets a banned player matchmake there and nowhere else, so it is where they read the
	// block screen, and with no presence at all the client loads the dorm a second time.
	const presence = await env.DB.prepare(
		"SELECT json_extract(data, '$.roomInstance.roomInstanceId') AS instance FROM presence WHERE json_extract(data, '$.accountId') = 8190"
	).first<{ instance: number | null }>()
	expect(presence).not.toBeNull()
	// The OFFLINE dorm sentinel — a room the client loads locally, with no session behind it.
	expect(presence?.instance).toBe(-2)
})

// Online but not standing in any room — in a menu — is still banned from the game, and is
// told so now rather than at their next sign-in.
it('tells a banned player who is online but in no instance', async () => {
	const hub = () => env.RECFLARE_NOTIFICATIONS_HUB.getByName('global')
	await hub().fetch('http://do/all', { method: 'DELETE' })

	await setPresence(env.DB, {
		accountId: 8195,
		roomInstance: null,
		statusVisibility: 0,
		deviceClass: 0,
		vrMovementMode: 0,
		platform: 4,
		appVersion: 'test',
	})
	const report = await createReport(env.DB, { reporterPlayerId: 8196, reportedPlayerId: 8195 })
	expect(
		(await staffPost(`/api/staff/reports/${report.id}/ban`, 8110, { permanent: true })).status
	).toBe(200)

	const frames = (await (await hub().fetch('http://do/all')).json()) as Array<{
		playerIds?: number[]
		ephemeral?: boolean
		data: Record<string, unknown>
	}>
	expect(frames).toHaveLength(1)
	expect(frames[0]).toMatchObject({ playerIds: [8195], ephemeral: true })
	// No session to name, and a permanent ban carries the largest duration the field holds.
	expect(frames[0].data).toMatchObject({ IsBan: true, GameSessionId: 0, Duration: 2_147_483_647 })
})

// The ban row is committed before the kick is attempted, so a player who is offline (or
// a hub that can't be reached) must not fail a ban that has been handed down.
it('bans an offline player without a kick to push', async () => {
	const hub = () => env.RECFLARE_NOTIFICATIONS_HUB.getByName('global')
	await hub().fetch('http://do/all', { method: 'DELETE' })

	const report = await createReport(env.DB, { reporterPlayerId: 8201, reportedPlayerId: 8200 })
	expect((await staffPost(`/api/staff/reports/${report.id}/ban`, 8110, { days: 1 })).status).toBe(
		200
	)
	await expect(getReportById(env.DB, report.id)).resolves.toMatchObject({ banned: 1 })

	const frames = (await (await hub().fetch('http://do/all')).json()) as unknown[]
	expect(frames).toHaveLength(0)
})

// One screen, one call: a moderator deciding what to do about an account reads the
// reports, the warnings and the ban together, and three round trips would let the page
// render a decision out of a half-loaded history.
it('serves a player’s reports, warnings and active ban together', async () => {
	const player = 8210
	await createReport(env.DB, {
		reporterPlayerId: 8211,
		reportedPlayerId: player,
		details: 'reported',
	})
	const actioned = await createReport(env.DB, {
		reporterPlayerId: 8212,
		reportedPlayerId: player,
		reportCategory: 101,
	})
	await createWarning(env.DB, {
		moderatorPlayerId: 8110,
		warnedPlayerId: player,
		reportCategory: 101,
		displayReason: 'Told once',
		moderatorNote: 'internal',
	})
	expect((await staffPost(`/api/staff/reports/${actioned.id}/ban`, 8110, { days: 2 })).status).toBe(
		200
	)

	const history = (await (await staffGet(`/api/staff/players/${player}`, 8110)).json()) as {
		playerId: number
		reports: Array<{ id: number }>
		warnings: Array<{ display_reason: string; moderator_note: string }>
		activeBan: { id: number } | null
	}
	expect(history.playerId).toBe(player)
	expect(history.reports).toHaveLength(2)
	// The ban in force is the one the panel headlines, and it names the report behind it.
	expect(history.activeBan?.id).toBe(actioned.id)
	expect(history.warnings).toHaveLength(1)
	// Both halves of a warning are here: the panel is the internal view, so the note a
	// player never sees is shown to staff.
	expect(history.warnings[0]).toMatchObject({
		display_reason: 'Told once',
		moderator_note: 'internal',
	})
})

// The evasion preview. The IP arm is coarse by design — households and shared networks
// look identical to it — so the panel shows the blast radius BEFORE a ban lands, and
// echoes which arms the operator has enabled so an empty list can be read correctly.
it('previews which other accounts a ban would reach', async () => {
	// `account_id` is GENERATED from the blob, so only `data` is written — the same way
	// `auth` writes an account row.
	const seedAccount = (data: Record<string, unknown>) =>
		env.DB.prepare('INSERT OR REPLACE INTO account (data) VALUES (?1)')
			.bind(JSON.stringify(data))
			.run()
	await seedAccount({ accountId: 8220, username: 'Evader', lastLoginIp: '203.0.113.9' })
	await seedAccount({ accountId: 8221, username: 'Housemate', signupIp: '203.0.113.9' })
	await linkPlatformIdentity(env.DB, 8220, PlatformType.Steam, 'steam-8220')
	await linkPlatformIdentity(env.DB, 8222, PlatformType.Steam, 'steam-8220')

	const preview = (await (await staffGet('/api/staff/players/8220/linked', 8110)).json()) as {
		arms: { ip: boolean; platform: boolean }
		linked: Array<{ accountId: number; username: string | null; via: string }>
	}
	// BAN_EVASION_MATCH is unset in the test config, so both arms are live — the default
	// an operator who sets nothing gets.
	expect(preview.arms).toEqual({ ip: true, platform: true })

	// The platform match is the sharp one (a proven identity) and sorts first; the IP one
	// is the coarse arm that would catch the housemate.
	expect(preview.linked.find((l) => l.accountId === 8222)?.via).toBe('platform')
	expect(preview.linked.find((l) => l.accountId === 8221)).toMatchObject({
		via: 'ip',
		username: 'Housemate',
	})
	// Never the account asked about: the question is who ELSE.
	expect(preview.linked.map((l) => l.accountId)).not.toContain(8220)
})

// The panel's own URLs must reach the SPA, not the worker's API surface. `requireStaff`
// is mounted on `/api/staff/*`, and `run_worker_first` lists `/api/*` — so every
// `/moderation/…` path falls through assets-first to the SPA shell, which is what lets a
// moderator reload on a player's history or paste a link to one.
//
// What is asserted is the NEGATIVE: not a 401 or 403. A test run has no ASSETS binding
// (there is no client build behind it), so the catch-all answers 404 here and every other
// SPA route — `/account`, `/login`, `/` — does too. A 401 would mean the staff middleware
// had grown to cover these paths, and a cold load of the panel would start refusing
// instead of rendering.
it('leaves the panel’s own routes to the SPA rather than the staff endpoints', async () => {
	for (const path of [
		'/moderation',
		'/moderation/search',
		'/moderation/bans',
		'/moderation/players/5',
		'/moderation/reports/5/ban',
	]) {
		const res = await SELF.fetch(`https://example.com${path}`)
		expect(res.status).not.toBe(401)
		expect(res.status).not.toBe(403)
		// Same answer the other SPA routes give in a test run, for the same reason.
		expect(res.status).toBe((await SELF.fetch('https://example.com/account')).status)
	}
})

// Ordered by when the ban LANDED, newest first: the list's job is catching mistakes, and
// the ban most likely to be wrong is the one just handed down. See `getBansInForce`.
it('serves standing bans most recently handed down first', async () => {
	const older = await createReport(env.DB, { reporterPlayerId: 8231, reportedPlayerId: 8230 })
	const newer = await createReport(env.DB, { reporterPlayerId: 8233, reportedPlayerId: 8232 })
	// The older ban is the PERMANENT one, so an order by severity would float it to the top.
	expect(
		(await staffPost(`/api/staff/reports/${older.id}/ban`, 8110, { permanent: true })).status
	).toBe(200)
	await env.DB.prepare('UPDATE report SET banned_at = ?2 WHERE id = ?1')
		.bind(older.id, '2024-01-01T00:00:00.000Z')
		.run()
	expect((await staffPost(`/api/staff/reports/${newer.id}/ban`, 8110, { days: 1 })).status).toBe(
		200
	)

	const bans = (await (await staffGet('/api/staff/bans', 8110)).json()) as Array<{ id: number }>
	const ordered = bans.map((b) => b.id).filter((id) => [older.id, newer.id].includes(id))
	expect(ordered).toEqual([newer.id, older.id])
})

// ---- Staff player actions ---------------------------------------------------
//
// The staff card on a player's profile page. Each action is recorded on `audit_log` against
// the staffer who took it, with the target in `data`.

/** The audit rows for one action against one target player, oldest first. */
async function auditRows(action: string, playerId: number) {
	const { results } = await env.DB.prepare(
		`SELECT player_id, data FROM audit_log
		 WHERE action = ?1 AND json_extract(data, '$.playerId') = ?2 ORDER BY audit_log_id`
	)
		.bind(action, playerId)
		.all<{ player_id: number; data: string }>()
	return results.map((r) => ({ actor: r.player_id, data: JSON.parse(r.data) }))
}

// Credited on top of the signup grant (a never-touched balance is seeded first, as econ
// does), boxed, and announced: the balance frame carries the resulting TOTAL in the one
// ALL_PLATFORMS bucket, and the box frame is what shows the player it arrived.
it('gifts a player tokens in a gift box', async () => {
	const hub = () => env.RECFLARE_NOTIFICATIONS_HUB.getByName('global')
	await hub().fetch('http://do/all', { method: 'DELETE' })
	await updateAccount(env.DB, 8300, { username: 'Giftee' })

	const res = await devPost('/api/staff/players/8300/gift-tokens', 8110, { amount: 500 })
	expect(res.status).toBe(200)
	const body = (await res.json()) as { balance: number; giftId: number }
	expect(body.balance).toBe(DEFAULT_STARTING_TOKENS + 500)
	await expect(
		getBalance(env.DB, 8300, CurrencyType.RecCenterTokens, DEFAULT_STARTING_TOKENS)
	).resolves.toBe(DEFAULT_STARTING_TOKENS + 500)

	const gifts = await getPendingGifts(env.DB, 8300)
	expect(gifts).toHaveLength(1)
	expect(gifts[0]).toMatchObject({
		Id: body.giftId,
		FromPlayerId: 1,
		CurrencyType: CurrencyType.RecCenterTokens,
		Currency: 500,
		// No staff box holds an avatar item; a 0 here sends the client after one.
		AvatarItemType: null,
	})

	const frames = (await (await hub().fetch('http://do/all')).json()) as Array<{
		playerId: number
		notificationType: number
		data: Record<string, unknown>
	}>
	expect(frames.map((f) => [f.playerId, f.notificationType])).toEqual([
		[8300, 61],
		[8300, 31],
	])
	expect(frames[0].data).toEqual({
		Balance: DEFAULT_STARTING_TOKENS + 500,
		CurrencyType: CurrencyType.RecCenterTokens,
		Platform: -2,
	})
	expect(frames[1].data).toMatchObject({ Id: body.giftId, Currency: 500, BalanceType: -2 })

	expect(await auditRows('gift_tokens', 8300)).toEqual([
		{
			actor: 8110,
			data: {
				playerId: 8300,
				amount: 500,
				message: 'A gift from the staff!',
				balance: DEFAULT_STARTING_TOKENS + 500,
				giftId: body.giftId,
			},
		},
	])
})

it('refuses a token gift that is not a whole number, too large, or to nobody', async () => {
	await updateAccount(env.DB, 8301, { username: 'NotGifted' })
	// A fraction and a word are not amounts, and the cap binds in both directions, since a
	// negative gift takes tokens away. Zero is allowed — see the empty box below.
	for (const amount of [1.5, 'lots', 10_001, -10_001]) {
		const res = await devPost('/api/staff/players/8301/gift-tokens', 8110, { amount })
		expect(res.status).toBe(400)
	}
	expect((await devPost('/api/staff/players/8399/gift-tokens', 8110, { amount: 5 })).status).toBe(
		404
	)
	expect(await getPendingGifts(env.DB, 8301)).toEqual([])
	expect(await auditRows('gift_tokens', 8301)).toEqual([])
})

// A negative gift takes tokens back — through the same guarded debit a purchase spends with,
// so it cannot overdraw. It still mints a box, carrying the negative amount: what the client
// makes of one is the thing being found out.
it('takes tokens back on a negative gift, and cannot overdraw', async () => {
	const hub = () => env.RECFLARE_NOTIFICATIONS_HUB.getByName('global')
	await hub().fetch('http://do/all', { method: 'DELETE' })
	await updateAccount(env.DB, 8360, { username: 'Indebted' })

	const res = await devPost('/api/staff/players/8360/gift-tokens', 8110, { amount: -400 })
	expect(res.status).toBe(200)
	const body = (await res.json()) as { balance: number; giftId: number }
	expect(body.balance).toBe(DEFAULT_STARTING_TOKENS - 400)
	await expect(
		getBalance(env.DB, 8360, CurrencyType.RecCenterTokens, DEFAULT_STARTING_TOKENS)
	).resolves.toBe(DEFAULT_STARTING_TOKENS - 400)

	const gifts = await getPendingGifts(env.DB, 8360)
	expect(gifts).toHaveLength(1)
	expect(gifts[0]).toMatchObject({ Id: body.giftId, Currency: -400 })

	// The balance frame carries the resulting total, as it does for a credit.
	const frames = (await (await hub().fetch('http://do/all')).json()) as Array<{
		notificationType: number
		data: Record<string, unknown>
	}>
	expect(frames[0].data).toMatchObject({ Balance: DEFAULT_STARTING_TOKENS - 400 })

	expect(await auditRows('gift_tokens', 8360)).toEqual([
		{
			actor: 8110,
			data: {
				playerId: 8360,
				amount: -400,
				message: 'A gift from the staff!',
				balance: DEFAULT_STARTING_TOKENS - 400,
				giftId: body.giftId,
			},
		},
	])

	// More than they hold changes nothing: no debit, no box, no audit row beyond the first.
	// Under the cap, so this is the BALANCE refusing it and not the typo guard (they hold
	// DEFAULT_STARTING_TOKENS - 400 by now).
	const tooMuch = await devPost('/api/staff/players/8360/gift-tokens', 8110, {
		amount: -(DEFAULT_STARTING_TOKENS - 100),
	})
	expect(tooMuch.status).toBe(400)
	await expect(
		getBalance(env.DB, 8360, CurrencyType.RecCenterTokens, DEFAULT_STARTING_TOKENS)
	).resolves.toBe(DEFAULT_STARTING_TOKENS - 400)
	expect(await getPendingGifts(env.DB, 8360)).toHaveLength(1)
	expect(await auditRows('gift_tokens', 8360)).toHaveLength(1)
})

// The room is the audience, not one session: everyone standing in any instance of it, read
// at the moment the button is pressed.
it('sends tokens to everyone in a room, across its instances', async () => {
	const inRoom = async (accountId: number, roomId: number, roomInstanceId: number) =>
		setPresence(env.DB, {
			accountId,
			roomInstance: { roomId, roomInstanceId },
			statusVisibility: 0,
			deviceClass: 0,
			vrMovementMode: 0,
			platform: 4,
			appVersion: 'test',
		})
	// Two instances of room 7700, plus a player in a different room who must not be paid.
	await inRoom(8370, 7700, 77101)
	await inRoom(8371, 7700, 77101)
	await inRoom(8372, 7700, 77102)
	await inRoom(8373, 7701, 77103)

	const res = await devPost('/api/staff/rooms/7700/gift-tokens', 8110, { amount: 250 })
	expect(res.status).toBe(200)
	expect(await res.json()).toEqual({
		roomId: 7700,
		amount: 250,
		paid: [8370, 8371, 8372],
		skipped: [],
	})

	for (const playerId of [8370, 8371, 8372]) {
		await expect(
			getBalance(env.DB, playerId, CurrencyType.RecCenterTokens, DEFAULT_STARTING_TOKENS)
		).resolves.toBe(DEFAULT_STARTING_TOKENS + 250)
		expect(await getPendingGifts(env.DB, playerId)).toHaveLength(1)
	}
	// The player in the other room is untouched — no box, and no balance row touched.
	expect(await getPendingGifts(env.DB, 8373)).toEqual([])

	const { results } = await env.DB.prepare(
		`SELECT player_id, data FROM audit_log
		 WHERE action = 'gift_tokens_room' AND json_extract(data, '$.roomId') = 7700`
	).all<{ player_id: number; data: string }>()
	expect(results).toHaveLength(1)
	expect(results[0].player_id).toBe(8110)
	expect(JSON.parse(results[0].data)).toEqual({
		roomId: 7700,
		amount: 250,
		message: 'A gift from the staff!',
		paid: [8370, 8371, 8372],
		skipped: [],
	})
})

// An empty room is a 404 rather than a silent success: a staffer who pressed the button
// expects somebody to have been paid.
it('refuses a room gift with nobody in the room, and a bad amount', async () => {
	expect((await devPost('/api/staff/rooms/7799/gift-tokens', 8110, { amount: 10 })).status).toBe(
		404
	)
	expect(
		(await devPost('/api/staff/rooms/7700/gift-tokens', 8110, { amount: 10_001 })).status
	).toBe(400)
})

// The box says what the staffer wrote, when they wrote something: the one-player and room
// gifts take the same optional `message` the drop requires. Blank keeps the staff default,
// and one too long to send is refused rather than cut.
it('puts a custom message on a one-player and a room token gift', async () => {
	await updateAccount(env.DB, 8362, { username: 'Messaged' })
	let res = await devPost('/api/staff/players/8362/gift-tokens', 8110, {
		amount: 50,
		message: '  Well played!  ',
	})
	expect(res.status).toBe(200)
	expect(await getPendingGifts(env.DB, 8362)).toMatchObject([
		{ Currency: 50, Message: 'Well played!' },
	])
	expect(await auditRows('gift_tokens', 8362)).toMatchObject([
		{ data: { message: 'Well played!' } },
	])

	res = await devPost('/api/staff/players/8362/gift-tokens', 8110, { amount: 5, message: '' })
	expect(res.status).toBe(200)
	expect((await getPendingGifts(env.DB, 8362)).map((g) => g.Message)).toEqual([
		'Well played!',
		'A gift from the staff!',
	])
	expect(
		(
			await devPost('/api/staff/players/8362/gift-tokens', 8110, {
				amount: 5,
				message: 'x'.repeat(257),
			})
		).status
	).toBe(400)

	await setPresence(env.DB, {
		accountId: 8363,
		roomInstance: { roomId: 7720, roomInstanceId: 77301 },
		statusVisibility: 0,
		deviceClass: 0,
		vrMovementMode: 0,
		platform: 4,
		appVersion: 'test',
	})
	res = await devPost('/api/staff/rooms/7720/gift-tokens', 8110, {
		amount: 25,
		message: 'Thanks for coming!',
	})
	expect(res.status).toBe(200)
	expect(await getPendingGifts(env.DB, 8363)).toMatchObject([
		{ Currency: 25, Message: 'Thanks for coming!' },
	])
	expect(
		(
			await devPost('/api/staff/rooms/7720/gift-tokens', 8110, {
				amount: 25,
				message: 'x'.repeat(257),
			})
		).status
	).toBe(400)
})

// Everyone online is the audience — a player in a room, a player in another room and a
// player sat in the lobby with no instance at all — and the box carries the operator's message
// rather than the staff default.
it('drops tokens on everyone online, lobby included, with the message on the box', async () => {
	const online = async (
		accountId: number,
		roomInstance: { roomId: number; roomInstanceId: number } | null
	) =>
		setPresence(env.DB, {
			accountId,
			roomInstance,
			statusVisibility: 0,
			deviceClass: 0,
			vrMovementMode: 0,
			platform: 4,
			appVersion: 'test',
		})
	await online(8380, { roomId: 7710, roomInstanceId: 77201 })
	await online(8381, { roomId: 7711, roomInstanceId: 77202 })
	await online(8382, null)
	// Expired presence is offline: the row is still there until the sweep, but they left.
	await online(8383, { roomId: 7710, roomInstanceId: 77201 })
	await env.DB.prepare(
		`UPDATE presence SET data = json_set(data, '$.expiresAt', 1) WHERE account_id = 8383`
	).run()

	const res = await devPost('/api/staff/online/gift-tokens', 8110, {
		amount: 100,
		message: 'Thanks for playing!',
	})
	expect(res.status).toBe(200)
	const body = (await res.json()) as { amount: number; message: string; paid: number[] }
	expect(body.amount).toBe(100)
	expect(body.message).toBe('Thanks for playing!')
	expect(body.paid).toEqual(expect.arrayContaining([8380, 8381, 8382]))
	expect(body.paid).not.toContain(8383)

	for (const playerId of [8380, 8381, 8382]) {
		await expect(
			getBalance(env.DB, playerId, CurrencyType.RecCenterTokens, DEFAULT_STARTING_TOKENS)
		).resolves.toBe(DEFAULT_STARTING_TOKENS + 100)
		const gifts = await getPendingGifts(env.DB, playerId)
		expect(gifts).toHaveLength(1)
		expect(gifts[0]).toMatchObject({ Currency: 100, Message: 'Thanks for playing!' })
	}
	expect(await getPendingGifts(env.DB, 8383)).toEqual([])

	const { results } = await env.DB.prepare(
		`SELECT player_id, data FROM audit_log WHERE action = 'gift_tokens_online'`
	).all<{ player_id: number; data: string }>()
	expect(results).toHaveLength(1)
	expect(results[0].player_id).toBe(8110)
	expect(JSON.parse(results[0].data)).toMatchObject({ amount: 100, message: 'Thanks for playing!' })
})

// The drop is narrower than the other gifts: positive only, capped at 1,000 each whatever
// MAX_TOKEN_GIFT allows, and the box needs a message — that is what the players see of it.
it('refuses a token drop over the cap, without a message, or with nobody online', async () => {
	const drop = (body: unknown) => devPost('/api/staff/online/gift-tokens', 8110, body)
	expect((await drop({ amount: 1_001, message: 'hi' })).status).toBe(400)
	expect((await drop({ amount: 0, message: 'hi' })).status).toBe(400)
	expect((await drop({ amount: -5, message: 'hi' })).status).toBe(400)
	expect((await drop({ amount: 10, message: '   ' })).status).toBe(400)
	expect((await drop({ amount: 10 })).status).toBe(400)
	// An empty server is a 404 rather than a silent success, as an empty room is.
	await env.DB.prepare('DELETE FROM presence').run()
	expect((await drop({ amount: 1_000, message: 'hi' })).status).toBe(404)
})

// Zero is a real gift here: nothing moves, and the player gets an empty box.
it('sends an empty box on a zero token gift', async () => {
	await updateAccount(env.DB, 8361, { username: 'Emptyhanded' })
	const res = await devPost('/api/staff/players/8361/gift-tokens', 8110, { amount: 0 })
	expect(res.status).toBe(200)
	const body = (await res.json()) as { balance: number; giftId: number }
	expect(body.balance).toBe(DEFAULT_STARTING_TOKENS)

	const gifts = await getPendingGifts(env.DB, 8361)
	expect(gifts).toHaveLength(1)
	expect(gifts[0]).toMatchObject({ Id: body.giftId, Currency: 0 })
	expect(await auditRows('gift_tokens', 8361)).toMatchObject([{ data: { amount: 0 } }])
})

// An account that has never renamed itself stores no count and is read as the default 3, so
// the first grant makes it 4 rather than 1.
it('adds a username change on top of the default', async () => {
	await updateAccount(env.DB, 8310, { username: 'Renamer' })

	let res = await staffPost('/api/staff/players/8310/username-changes', 8110, {})
	expect(res.status).toBe(200)
	expect(await res.json()).toEqual({ playerId: 8310, availableUsernameChanges: 4 })

	await updateAccount(env.DB, 8310, { availableUsernameChanges: 0 })
	res = await staffPost('/api/staff/players/8310/username-changes', 8110, {})
	expect(await res.json()).toEqual({ playerId: 8310, availableUsernameChanges: 1 })

	expect((await auditRows('add_username_change', 8310)).map((r) => r.data)).toEqual([
		{ playerId: 8310, availableUsernameChanges: 4 },
		{ playerId: 8310, availableUsernameChanges: 1 },
	])
	expect((await staffPost('/api/staff/players/8398/username-changes', 8110, {})).status).toBe(404)
})

it('clears a player’s password so they can set a new one in game', async () => {
	await updateAccount(env.DB, 8320, { username: 'Forgetful', passwordHash: 'salt:hash' })

	let res = await staffPost('/api/staff/players/8320/clear-password', 8110, {})
	expect(res.status).toBe(200)
	expect(await res.json()).toEqual({ playerId: 8320, hadPassword: true })
	const row = await env.DB.prepare(
		"SELECT json_extract(data, '$.passwordHash') AS hash, json_extract(data, '$.username') AS username FROM account WHERE account_id = 8320"
	).first<{ hash: string | null; username: string }>()
	// Only the hash goes: the rest of the account is untouched.
	expect(row).toEqual({ hash: null, username: 'Forgetful' })

	// Clearing it again is harmless, and says there was nothing to clear.
	res = await staffPost('/api/staff/players/8320/clear-password', 8110, {})
	expect(await res.json()).toEqual({ playerId: 8320, hadPassword: false })

	expect(await auditRows('clear_password', 8320)).toEqual([
		{ actor: 8110, data: { playerId: 8320, hadPassword: true } },
		{ actor: 8110, data: { playerId: 8320, hadPassword: false } },
	])
	expect((await staffPost('/api/staff/players/8397/clear-password', 8110, {})).status).toBe(404)
})

/** A custom avatar item made by `creatorAccountId`; published unless `accessibility` says. */
const seedCustomItem = (id: string, creatorAccountId: number, accessibility = 1) =>
	createCustomAvatarItem(env.DB, {
		customAvatarItemId: id,
		creatorAccountId,
		name: `Shirt ${id.slice(0, 4)}`,
		description: '',
		price: 300,
		baseAvatarItemId: 1,
		baseAvatarItemColor: '',
		accessibility,
		designFilename: 'design.png',
		thumbnailImageFilename: 'thumb.png',
	})

/** A catalog row — a skin (with `prefabName`), a consumable or an avatar item — as `runx catalog load` writes one. */
const seedCatalogRow = (
	itemKey: string,
	catalogId: number,
	kind: 'skin' | 'consumable' | 'avatar_item',
	friendlyName: string,
	prefabName: string | null = null
) =>
	env.DB.prepare(
		`INSERT INTO catalog (item_key, catalog_id, kind, friendly_name, tooltip, rarity, platform_mask, prefab_name)
		 VALUES (?1, ?2, ?3, ?4, NULL, 3, -1, ?5)`
	)
		.bind(itemKey, catalogId, kind, friendlyName, prefabName)
		.run()

/** Every frame the hub was handed, after clearing it. */
const hubFrames = async () =>
	(await (
		await env.RECFLARE_NOTIFICATIONS_HUB.getByName('global').fetch('http://do/all')
	).json()) as Array<{
		playerId: number
		notificationType: number
		data: Record<string, unknown>
	}>
const clearHub = () =>
	env.RECFLARE_NOTIFICATIONS_HUB.getByName('global').fetch('http://do/all', { method: 'DELETE' })

/** The one item gift, by whichever id. */
const giftItem = (playerId: number, itemId: unknown, message?: string) =>
	devPost(`/api/staff/players/${playerId}/gift-item`, 8110, { itemId, message })

// Delivered as a purchase delivers one — owned, and boxed by `CustomAvatarItemId` — but nobody
// is charged and the creator is not paid: a grant, not a sale.
it('gifts a player a custom item in a gift box', async () => {
	await clearHub()
	await updateAccount(env.DB, 8330, { username: 'Wearer' })
	const item = await seedCustomItem('0a1b2c3d-0000-4000-8000-000000000001', 8331)

	// Upper-cased on purpose: a GUID's case is not part of its identity.
	const res = await giftItem(8330, item.CustomAvatarItemId.toUpperCase())
	expect(res.status).toBe(200)
	const body = (await res.json()) as { kind: string; giftId: number; name: string }
	expect(body).toMatchObject({ kind: 'custom_item', name: item.Name })

	await expect(ownedCustomAvatarItemIds(env.DB, 8330, [item.CustomAvatarItemId])).resolves.toEqual(
		new Set([item.CustomAvatarItemId])
	)
	const gifts = await getPendingGifts(env.DB, 8330)
	expect(gifts).toHaveLength(1)
	expect(gifts[0]).toMatchObject({
		Id: body.giftId,
		FromPlayerId: 1,
		CustomAvatarItemId: item.CustomAvatarItemId,
		AvatarItemDesc: '',
		// As econ boxes a bought custom item — an avatar item, so not the null the others carry.
		AvatarItemType: 0,
		Currency: 0,
		Message: 'A gift from the staff!',
		// Purchased_Gift_A: one of the contexts the client's box classifier tests. Default (0)
		// is not, and a box it can't classify renders as "cannot display".
		GiftContext: 500,
	})

	// Only the box is announced: no balance moved, the creator's included.
	const frames = await hubFrames()
	expect(frames.map((f) => [f.playerId, f.notificationType])).toEqual([[8330, 31]])
	expect(frames[0].data).toMatchObject({
		Id: body.giftId,
		CustomAvatarItemId: item.CustomAvatarItemId,
		GiftContext: 500,
	})

	expect(await auditRows('gift_custom_item', 8330)).toEqual([
		{
			actor: 8110,
			data: {
				playerId: 8330,
				customAvatarItemId: item.CustomAvatarItemId,
				name: item.Name,
				message: 'A gift from the staff!',
				giftId: body.giftId,
			},
		},
	])
})

it('refuses a custom item gift the store would refuse', async () => {
	await updateAccount(env.DB, 8340, { username: 'Picky' })
	const published = await seedCustomItem('0a1b2c3d-0000-4000-8000-000000000002', 8341)
	const draft = await seedCustomItem('0a1b2c3d-0000-4000-8000-000000000003', 8341, 0)
	const own = await seedCustomItem('0a1b2c3d-0000-4000-8000-000000000004', 8340)
	await grantCustomAvatarItem(env.DB, 8340, published.CustomAvatarItemId)

	expect((await giftItem(8340, '')).status).toBe(400)
	expect((await giftItem(8340, 7)).status).toBe(400)
	expect((await giftItem(8340, published.CustomAvatarItemId, 'x'.repeat(257))).status).toBe(400)
	expect((await giftItem(8340, 'no-such-item')).status).toBe(404)
	// A draft is visible to its creator alone; handing it out would publish it for them.
	expect((await giftItem(8340, draft.CustomAvatarItemId)).status).toBe(404)
	expect((await giftItem(8340, own.CustomAvatarItemId)).status).toBe(409)
	expect((await giftItem(8340, published.CustomAvatarItemId)).status).toBe(409)
	expect((await giftItem(8396, published.CustomAvatarItemId)).status).toBe(404)

	expect(await getPendingGifts(env.DB, 8340)).toEqual([])
	expect(await auditRows('gift_custom_item', 8340)).toEqual([])
})

// Delivered as a purchase delivers one — an `equipment` row, and a box keyed by the prefab and
// guid with `AvatarItemType` NULL (a 0 sends the client after an avatar item that isn't there).
it('gifts a player a skin in a gift box', async () => {
	await clearHub()
	await updateAccount(env.DB, 8420, { username: 'Armed' })
	await seedCatalogRow('0dM2SfqGR0SmtO5ufTWfUQ', 91001, 'skin', 'Bow Skin (Dryad)', '[Bow]')
	await seedCatalogRow(
		'a1b2c3d4-0000-4000-8000-000000000001',
		91002,
		'skin',
		'Pen Skin',
		'[MakerPen]'
	)

	// By key, as the export spells it — the short ids are case-sensitive, so nothing is folded.
	let res = await giftItem(8420, '0dM2SfqGR0SmtO5ufTWfUQ', 'Nice shot')
	expect(res.status).toBe(200)
	const body = (await res.json()) as {
		kind: string
		giftId: number
		name: string
		prefabName: string
	}
	expect(body).toMatchObject({ kind: 'skin', name: 'Bow Skin (Dryad)', prefabName: '[Bow]' })

	expect(await getEquipment(env.DB, 8420)).toEqual([
		{
			ModificationGuid: '0dM2SfqGR0SmtO5ufTWfUQ',
			PrefabName: '[Bow]',
			FriendlyName: 'Bow Skin (Dryad)',
			Tooltip: '',
			Rarity: 3,
			PlatformMask: -1,
			Favorited: false,
		},
	])
	const gifts = await getPendingGifts(env.DB, 8420)
	expect(gifts).toHaveLength(1)
	expect(gifts[0]).toMatchObject({
		Id: body.giftId,
		FromPlayerId: 1,
		EquipmentPrefabName: '[Bow]',
		EquipmentModificationGuid: '0dM2SfqGR0SmtO5ufTWfUQ',
		AvatarItemType: null,
		AvatarItemDesc: '',
		GiftRarity: 3,
		GiftContext: 500,
		Message: 'Nice shot',
	})
	const frames = await hubFrames()
	expect(frames.map((f) => [f.playerId, f.notificationType])).toEqual([[8420, 31]])
	expect(frames[0].data).toMatchObject({
		Id: body.giftId,
		EquipmentModificationGuid: '0dM2SfqGR0SmtO5ufTWfUQ',
		AvatarItemType: null,
		GiftContext: 500,
	})
	expect(await auditRows('gift_skin', 8420)).toEqual([
		{
			actor: 8110,
			data: {
				playerId: 8420,
				modificationGuid: '0dM2SfqGR0SmtO5ufTWfUQ',
				prefabName: '[Bow]',
				name: 'Bow Skin (Dryad)',
				message: 'Nice shot',
				giftId: body.giftId,
			},
		},
	])

	// Or by the store's numeric id.
	res = await giftItem(8420, '91002')
	expect(res.status).toBe(200)
	expect((await getEquipment(env.DB, 8420)).map((eq) => eq.ModificationGuid)).toEqual([
		'0dM2SfqGR0SmtO5ufTWfUQ',
		'a1b2c3d4-0000-4000-8000-000000000001',
	])

	// Owning a skin is boolean: a second gift would be a box with nothing new in it.
	expect((await giftItem(8420, 'skin-owned-8420', 'x'.repeat(257))).status).toBe(400)
	expect((await giftItem(8420, '0dM2SfqGR0SmtO5ufTWfUQ')).status).toBe(409)
	expect((await giftItem(8420, '99999999')).status).toBe(404)
	expect((await giftItem(8394, '0dM2SfqGR0SmtO5ufTWfUQ')).status).toBe(404)
	expect(await getEquipment(env.DB, 8420)).toHaveLength(2)
	expect(await getPendingGifts(env.DB, 8420)).toHaveLength(2)
})

// A consumable stacks: each gift is a fresh row, and the box carries that row's id and the
// count the player had before it, which is what opening the box reports.
it('gifts a player a consumable in a gift box, and again', async () => {
	await clearHub()
	await updateAccount(env.DB, 8430, { username: 'Hungry' })
	await seedCatalogRow('0DsHcPhR_Eybn53UxKJhJw', 91010, 'consumable', 'Supreme Pizza')

	let res = await giftItem(8430, '0DsHcPhR_Eybn53UxKJhJw')
	expect(res.status).toBe(200)
	const first = (await res.json()) as {
		kind: string
		giftId: number
		name: string
		count: number
		owned: number
	}
	expect(first).toMatchObject({ kind: 'consumable', name: 'Supreme Pizza', count: 1, owned: 1 })

	let owned = await getConsumables(env.DB, 8430)
	expect(owned).toHaveLength(1)
	expect(owned[0]).toMatchObject({ ConsumableItemDesc: '0DsHcPhR_Eybn53UxKJhJw', Count: 1 })
	let gifts = await getPendingGifts(env.DB, 8430)
	expect(gifts).toHaveLength(1)
	expect(gifts[0]).toMatchObject({
		Id: first.giftId,
		FromPlayerId: 1,
		ConsumableItemDesc: '0DsHcPhR_Eybn53UxKJhJw',
		ConsumableCount: 1,
		ConsumableMappingId: owned[0].Ids[0],
		ConsumablePreExistingCount: 0,
		AvatarItemType: null,
		EquipmentModificationGuid: '',
		GiftRarity: 3,
		GiftContext: 500,
		Message: 'A gift from the staff!',
	})
	const frames = await hubFrames()
	expect(frames.map((f) => [f.playerId, f.notificationType])).toEqual([[8430, 31]])
	expect(frames[0].data).toMatchObject({
		Id: first.giftId,
		ConsumableItemDesc: '0DsHcPhR_Eybn53UxKJhJw',
		AvatarItemType: null,
	})
	expect(await auditRows('gift_consumable', 8430)).toEqual([
		{
			actor: 8110,
			data: {
				playerId: 8430,
				consumableItemDesc: '0DsHcPhR_Eybn53UxKJhJw',
				name: 'Supreme Pizza',
				count: 1,
				message: 'A gift from the staff!',
				giftId: first.giftId,
			},
		},
	])

	// Again, by the store's id this time: a second instance, and the box knows they had one.
	res = await giftItem(8430, '91010', 'Seconds?')
	expect(res.status).toBe(200)
	expect(await res.json()).toMatchObject({ kind: 'consumable', owned: 2 })
	owned = await getConsumables(env.DB, 8430)
	expect(owned).toHaveLength(1)
	expect(owned[0]).toMatchObject({ Count: 2 })
	expect(owned[0].Ids).toHaveLength(2)
	gifts = await getPendingGifts(env.DB, 8430)
	expect(gifts).toHaveLength(2)
	expect(gifts.map((g) => g.ConsumablePreExistingCount ?? -1).sort((a, b) => a - b)).toEqual([0, 1])
	expect(gifts.map((g) => g.Message).sort()).toEqual(['A gift from the staff!', 'Seconds?'])

	expect((await giftItem(8430, '0DsHcPhR_Eybn53UxKJhJw', 'x'.repeat(257))).status).toBe(400)
	expect((await giftItem(8393, '0DsHcPhR_Eybn53UxKJhJw')).status).toBe(404)
	expect(await getConsumables(env.DB, 8430)).toEqual(owned)
})

// One id field, so the id decides the kind — and a UUID could be anything, so BOTH tables are
// asked. A baked avatar item is a real row nothing here can grant, and an id in both tables
// is nobody's to pick between.
it('refuses an item gift for a baked avatar item, or an id that names two things', async () => {
	await updateAccount(env.DB, 8440, { username: 'Ambiguous' })
	await seedCatalogRow('Hat,0,0,', 91020, 'avatar_item', 'A Hat')
	const twin = await seedCustomItem('0a1b2c3d-0000-4000-8000-000000000005', 8441)
	await seedCatalogRow(twin.CustomAvatarItemId, 91021, 'skin', 'Twin Skin', '[Bow]')

	let res = await giftItem(8440, 'Hat,0,0,')
	expect(res.status).toBe(400)
	expect(((await res.json()) as { error: string }).error).toMatch(/baked avatar item/)
	res = await giftItem(8440, '91020')
	expect(res.status).toBe(400)

	res = await giftItem(8440, twin.CustomAvatarItemId)
	expect(res.status).toBe(409)
	expect(((await res.json()) as { error: string }).error).toMatch(/both/)
	// The catalog id names only the skin, so that way round it goes through.
	res = await giftItem(8440, '91021')
	expect(res.status).toBe(200)
	expect(await res.json()).toMatchObject({ kind: 'skin', name: 'Twin Skin' })

	expect(await getPendingGifts(env.DB, 8440)).toHaveLength(1)
	await expect(ownedCustomAvatarItemIds(env.DB, 8440, [twin.CustomAvatarItemId])).resolves.toEqual(
		new Set()
	)
})

// Banked and levelled like a game reward's XP: 25 takes a fresh player from level 1 through
// 2 (10) and 3 (10) with 5 into level 3. The bar moves, and the box shows what arrived.
it('gifts a player XP in a gift box', async () => {
	const hub = () => env.RECFLARE_NOTIFICATIONS_HUB.getByName('global')
	await hub().fetch('http://do/all', { method: 'DELETE' })
	await updateAccount(env.DB, 8350, { username: 'Climber' })

	const res = await devPost('/api/staff/players/8350/gift-xp', 8110, {
		amount: 25,
		message: 'Keep climbing!',
	})
	expect(res.status).toBe(200)
	const body = (await res.json()) as { giftId: number }
	expect(body).toMatchObject({ level: 3, xp: 5, levelsGained: 2 })
	await expect(getProgression(env.DB, 8350)).resolves.toEqual({ PlayerId: 8350, Level: 3, XP: 5 })

	const gifts = await getPendingGifts(env.DB, 8350)
	expect(gifts).toHaveLength(1)
	expect(gifts[0]).toMatchObject({
		Id: body.giftId,
		FromPlayerId: 1,
		Xp: 25,
		Currency: 0,
		AvatarItemType: null,
		GiftContext: 500,
		Message: 'Keep climbing!',
	})

	const frames = (await (await hub().fetch('http://do/all')).json()) as Array<{
		playerId: number
		notificationType: number | string
		data: Record<string, unknown>
	}>
	expect(frames.map((f) => [f.playerId, f.notificationType])).toEqual([
		[8350, 'PlayerProgressionLevelUpdate'],
		[8350, 31],
	])
	expect(frames[0].data).toEqual({ PlayerId: 8350, Level: 3, XP: 5 })
	expect(frames[1].data).toMatchObject({
		Id: body.giftId,
		Xp: 25,
		GiftContext: 500,
		Message: 'Keep climbing!',
	})

	expect(await auditRows('gift_xp', 8350)).toEqual([
		{
			actor: 8110,
			data: {
				playerId: 8350,
				amount: 25,
				message: 'Keep climbing!',
				level: 3,
				levelsGained: 2,
				giftId: body.giftId,
			},
		},
	])
})

it('refuses an XP gift that is not a positive whole number, too large, or to nobody', async () => {
	await updateAccount(env.DB, 8351, { username: 'Stuck' })
	for (const amount of [0, -5, 1.5, 'lots', 101]) {
		expect((await devPost('/api/staff/players/8351/gift-xp', 8110, { amount })).status).toBe(400)
	}
	expect(
		(
			await devPost('/api/staff/players/8351/gift-xp', 8110, {
				amount: 5,
				message: 'x'.repeat(257),
			})
		).status
	).toBe(400)
	expect((await devPost('/api/staff/players/8395/gift-xp', 8110, { amount: 5 })).status).toBe(404)
	await expect(getProgression(env.DB, 8351)).resolves.toEqual({ PlayerId: 8351, Level: 1, XP: 0 })
	expect(await auditRows('gift_xp', 8351)).toEqual([])
})
