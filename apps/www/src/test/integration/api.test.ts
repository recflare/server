import { adminSecretsStore, env, SELF } from 'cloudflare:test'
import { beforeAll, expect, it } from 'vitest'

import {
	PRESENCE_SCHEMA_DDL,
	PRESENCE_TTL_SECONDS,
	presenceGeoFromCf,
} from '@repo/domain/src/presence-db'

import { DOCUMENTED_SERVICES } from '../../docs'
import { DISCORD_INVITE, ISSUES_URL, PRIVACY_EMAIL } from '../../links'
import { turnstileKeys } from '../../turnstile'
import { postAuthForm, readAuthError } from '../../upstream'

import type { PresenceGeo } from '@repo/domain/src/presence-db'
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

beforeAll(async () => {
	await adminSecretsStore(env.TURNSTILE_SITE_KEY).create(TEST_SITE_KEY)
	await adminSecretsStore(env.TURNSTILE_SECRET_KEY).create(TEST_SECRET_KEY)
	// `presence` is owned (and migrated) by other workers — www only reads it — so the
	// table has to be created here for the head-count behind /server-status.
	for (const stmt of PRESENCE_SCHEMA_DDL) await env.DB.prepare(stmt).run()
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

// The globe on the front page. Two things are pinned here that a rendering bug wouldn't
// catch: that the response carries COUNTS per grid cell and no per-player row (the whole
// reason locations are stored coarsened in the first place), and that `players` and
// `located` are allowed to disagree — a player the edge couldn't place is online without
// being on the map, and the page says so rather than showing the smaller number.
it('serves player locations as counts per grid cell, never per player', async () => {
	const now = Math.floor(Date.now() / 1000)
	await env.DB.prepare('DELETE FROM presence').run()
	const write = (accountId: number, expiresAt: number, geo: PresenceGeo | null) =>
		env.DB.prepare('INSERT OR REPLACE INTO presence (data) VALUES (?1)')
			.bind(JSON.stringify({ accountId, roomInstance: null, expiresAt, geo: geo ?? undefined }))
			.run()

	const live = now + PRESENCE_TTL_SECONDS
	// Two players in one cell, one in another, one online but unplaceable, one lapsed.
	await write(1, live, { lat: 34, lon: -118.5, country: 'US' })
	await write(2, live, { lat: 34, lon: -118.5, country: 'US' })
	await write(3, live, { lat: 51.5, lon: 0, country: 'GB' })
	await write(4, live, null)
	await write(5, now - 1, { lat: 34, lon: -118.5, country: 'US' })

	const res = await SELF.fetch('https://example.com/server-status/locations', {
		headers: { origin: 'https://s.example' },
	})
	expect(res.status).toBe(200)
	// Public like the head-count beside it.
	expect(res.headers.get('access-control-allow-origin')).toBe('*')
	expect(await res.json()).toEqual({
		// Everyone unexpired, including the player with no location…
		players: 4,
		// …who is the reason these two differ.
		located: 3,
		// Busiest cell first, and the two in one cell are ONE pin — not two rows that
		// happen to share coordinates, which would be a per-player list in disguise.
		pins: [
			{ lat: 34, lon: -118.5, country: 'US', players: 2 },
			{ lat: 51.5, lon: 0, country: 'GB', players: 1 },
		],
	})
})

// The blur is applied on the way IN, so the database itself never holds a fine
// coordinate — pinned because doing it at read time would look identical from the
// outside and be worth much less.
it('snaps a location to the grid and refuses to name a pseudo-country', () => {
	expect(presenceGeoFromCf({ latitude: '34.0522', longitude: '-118.2437', country: 'US' })).toEqual(
		{ lat: 34, lon: -118, country: 'US' }
	)
	// Cleanly on the grid, not 34.900000000000006 — two spellings of one cell would
	// group into two pins sitting on top of each other.
	expect(presenceGeoFromCf({ latitude: '34.8', longitude: '0.1', country: 'gb' })).toEqual({
		lat: 35,
		lon: 0,
		country: 'GB',
	})
	// `T1` is Tor, not a country.
	expect(presenceGeoFromCf({ latitude: '0', longitude: '0', country: 'T1' })?.country).toBe('XX')
	// No `cf` at all is the ordinary local-dev case, and must not become a pin at (0, 0).
	expect(presenceGeoFromCf(undefined)).toBeNull()
	expect(presenceGeoFromCf({ country: 'US' })).toBeNull()
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
