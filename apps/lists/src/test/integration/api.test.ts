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

it('serves the canned discovery page from /curatedlists', async () => {
	const res = await SELF.fetch(
		`${ORIGIN}/curatedlists?creatorAccountId=1&type=5&name=RoomGenreTags`
	)
	expect(res.status).toBe(200)
	expect(res.headers.get('content-type')).toContain('application/json')

	// The id is a 64-bit integer past Number.MAX_SAFE_INTEGER: assert the raw digits, since
	// parsing to a JS number would round it (…307326 → …307328) and hide the bug this
	// endpoint's bigint handling exists to avoid.
	const text = await res.text()
	expect(text).toContain('"ListId":624765592684307326,')

	expect(JSON.parse(text)).toMatchObject([
		{
			CreatorAccountId: 1,
			Name: 'Discovery.PageSource.PlayExplore',
			Description: null,
			ImageName: 'DefaultRoomImage.jpg',
			Type: 7,
			Accessibility: 1,
			CreatedAt: '2025-04-23T18:27:03.2643786Z',
			ItemIds: [
				'Rooms_New_PlayHighlight_TabsTest_Explore',
				'RoomCategories_MoodPlaylists_FeelingLucky',
				'Rooms_RecentlyUpdated_TabsTest_Explore',
				'Rooms_Battle_AlgoEndpoint_PlayHighlight_TabsTest_Explore',
				'Rooms_Quests_AlgoEndpoint_PlayHighlight_TabsTest_Explore',
				'Rooms_Roleplay_AlgoEndpoint_PlayHighlight_TabsTest_Explore',
				'Rooms_Horror_AlgoEndpoint_PlayHighlight_TabsTest_Explore',
				'Rooms_Hangout_AlgoEndpoint_PlayHighlight_TabsTest_Explore',
				'Rooms_Casual_AlgoEndpoint_PlayHighlight_TabsTest_Explore',
				'Rooms_Explore_AlgoEndpoint_PlayHighlight_TabsTest_Explore',
			],
		},
	])
})

it('serves the same curated page whatever the query asks for', async () => {
	// Nothing curates lists here yet, so the filters are ignored rather than answering an
	// empty array — an empty Play/Explore page is what the client would render otherwise.
	const filtered = await SELF.fetch(`${ORIGIN}/curatedlists?type=99&name=Nope`)
	const bare = await SELF.fetch(`${ORIGIN}/curatedlists`)
	expect(filtered.status).toBe(200)
	expect(await filtered.text()).toBe(await bare.text())
})

it('serves a discovery row from /algorithmiclists', async () => {
	const res = await SELF.fetch(
		`${ORIGIN}/algorithmiclists/Rooms_Battle_AlgoEndpoint_PlayHighlight_TabsTest_Explore?type=1`
	)
	expect(res.status).toBe(200)
	// `Type` is echoed from the query — it says what the ids ARE (1 = rooms), so the client
	// resolves them against the right service. Ids are STRINGS even though a room id is a
	// number, and `Context` (the ranking attribution) is null: nothing ranks anything here
	// yet, so every row serves rooms 2–6.
	expect(await res.json()).toEqual({
		Type: 1,
		Entities: [
			{ Id: '2', Context: null },
			{ Id: '3', Context: null },
			{ Id: '4', Context: null },
			{ Id: '5', Context: null },
			{ Id: '6', Context: null },
		],
	})
})

it('echoes the requested type and answers an unknown row', async () => {
	const other = await SELF.fetch(`${ORIGIN}/algorithmiclists/Nothing_Ranks_This_Row?type=4`)
	expect(other.status).toBe(200)
	const body = (await other.json()) as { Type: number; Entities: unknown[] }
	// An unknown row key still gets the canned entities: a 404 renders as a row that failed
	// to load rather than an empty one.
	expect(body.Type).toBe(4)
	expect(body.Entities).toHaveLength(5)

	// No `type` at all falls back to Rooms (1), the only one the client asks for — falling
	// back to the enum's zero value would have the row resolve room ids as ACCOUNTS.
	const untyped = await SELF.fetch(`${ORIGIN}/algorithmiclists/Rooms_New_TabsTest_Explore`)
	expect(((await untyped.json()) as { Type: number }).Type).toBe(1)

	// `Type` is a byte on the client, so a value that can't round-trip is not echoed back.
	for (const bad of ['256', '-1', 'rooms']) {
		const res = await SELF.fetch(
			`${ORIGIN}/algorithmiclists/Rooms_New_TabsTest_Explore?type=${bad}`
		)
		expect(((await res.json()) as { Type: number }).Type).toBe(1)
	}
	// 0 (Accounts) is a real member, so it IS echoed — it is not treated as "unset".
	const accounts = await SELF.fetch(`${ORIGIN}/algorithmiclists/Accounts_Row?type=0`)
	expect(((await accounts.json()) as { Type: number }).Type).toBe(0)
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
