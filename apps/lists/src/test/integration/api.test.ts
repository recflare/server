import { adminSecretsStore, env, SELF } from 'cloudflare:test'
import { beforeAll, expect, it } from 'vitest'

import {
	PRESENCE_SCHEMA_DDL,
	ROOM_SCHEMA_DDL,
	seedRoomWithSubRooms,
	SUBROOM_SCHEMA_DDL,
} from '@repo/domain'

import type { Env } from '../../context'

declare module 'cloudflare:test' {
	interface ProvidedEnv extends Env {}
}

const ORIGIN = 'https://example.com'

beforeAll(async () => {
	// Seed the shared JWT signing key into the local Secrets Store so .get() resolves.
	await adminSecretsStore(env.JWT_SECRET).create('test-signing-key')

	// The shared room schema (owned by the `rooms` worker) plus a few public rooms — the
	// HotList row ranks these. Presence is what makes a room "hot", so its table is here too.
	for (const stmt of ROOM_SCHEMA_DDL) await env.DB.prepare(stmt).run()
	for (const stmt of SUBROOM_SCHEMA_DDL) await env.DB.prepare(stmt).run()
	for (const stmt of PRESENCE_SCHEMA_DDL) await env.DB.prepare(stmt).run()
	for (const room of [
		// Account 1 is the Coach — its rooms are this server's stock ones, which the hot row
		// leaves out.
		{ RoomId: 2, Name: 'RecCenter', CreatorAccountId: 1, Accessibility: 1, IsDorm: false },
		{ RoomId: 3, Name: 'DodgeBall', CreatorAccountId: 500, Accessibility: 1, IsDorm: false },
		{ RoomId: 4, Name: 'Quietly', CreatorAccountId: 501, Accessibility: 1, IsDorm: false },
		// Non-public and a dorm: neither belongs in a discovery row.
		{ RoomId: 5, Name: 'SecretRoom', CreatorAccountId: 500, Accessibility: 0, IsDorm: false },
		{ RoomId: 6, Name: '@Dorm', CreatorAccountId: 502, Accessibility: 1, IsDorm: true },
	]) {
		await seedRoomWithSubRooms(env.DB, { ...room, SubRooms: [] } as Record<string, unknown>)
	}
})

/** Put a player in a room, the way the `match` heartbeat would — this is what ranks it. */
async function putInRoom(accountId: number, roomId: number): Promise<void> {
	const now = Math.floor(Date.now() / 1000)
	await env.DB.prepare('INSERT OR REPLACE INTO presence (data) VALUES (?1)')
		.bind(
			JSON.stringify({
				accountId,
				roomInstance: { roomInstanceId: 1000000 + roomId, roomId, subRoomId: roomId },
				expiresAt: now + 900,
			})
		)
		.run()
}

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

	const text = await res.text()
	expect(JSON.parse(text)).toMatchObject([
		{
			ListId: 1,
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

it('serves the PlayLibrary page when the query names it', async () => {
	const res = await SELF.fetch(
		`${ORIGIN}/curatedlists?creatorAccountId=1&type=5&name=Discovery.PageSource.PlayLibrary`
	)
	expect(res.status).toBe(200)

	const text = await res.text()
	expect(JSON.parse(text)).toMatchObject([
		{
			ListId: 2,
			CreatorAccountId: 1,
			Name: 'Discovery.PageSource.PlayLibrary',
			Description: null,
			ImageName: 'DefaultRoomImage.jpg',
			Type: 7,
			Accessibility: 1,
			CreatedAt: '2025-04-23T18:25:31.5308539Z',
			ItemIds: [
				'Rooms_ContinuePlaying_PlayLibrary',
				'Rooms_SavedForLater_PlayHighlight',
				'Rooms_Favorites_PlayLibrary',
				'Rooms_MyRooms_Play',
			],
		},
	])

	// The name is matched case-insensitively, and `type` is not filtered on — the request
	// above asks for type 5 and gets the type 7 list, as the reference does.
	const lower = await SELF.fetch(`${ORIGIN}/curatedlists?name=discovery.pagesource.playlibrary`)
	expect(await lower.text()).toBe(text)
})

it('gives each curated page a distinct, JS-safe ListId', async () => {
	// The client caches a list against its ListId, so two pages must never share one — and
	// an id past Number.MAX_SAFE_INTEGER would round on the way through JSON, which is why
	// these are small numbers of our own rather than the reference's 64-bit ones.
	const pages = ['Discovery.PageSource.PlayExplore', 'Discovery.PageSource.PlayLibrary']
	const ids: number[] = []
	for (const name of pages) {
		const [list] = (await (
			await SELF.fetch(`${ORIGIN}/curatedlists?name=${name}`)
		).json()) as Array<{ ListId: number }>
		expect(Number.isSafeInteger(list.ListId)).toBe(true)
		ids.push(list.ListId)
	}
	expect(new Set(ids).size).toBe(ids.length)
})

it('falls back to the Explore page for a name it has nothing for', async () => {
	// An empty array renders as an empty Play page, so an unknown page source answers
	// SOMETHING — which is also what the reference was observed doing for RoomGenreTags.
	const explore = await (
		await SELF.fetch(`${ORIGIN}/curatedlists?name=Discovery.PageSource.PlayExplore`)
	).text()

	for (const query of ['?type=99&name=Nope', '?creatorAccountId=1&type=5&name=RoomGenreTags', '']) {
		const res = await SELF.fetch(`${ORIGIN}/curatedlists${query}`)
		expect(res.status).toBe(200)
		expect(await res.text()).toBe(explore)
	}
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

it('serves the live hot-room ranking for /algorithmiclists/HotList', async () => {
	// Two players in room 3, one in room 4 — live player count is what ranks the hot feed,
	// so 3 comes first. Room 2 is busiest of all and still must not appear: the Coach
	// account made it.
	await putInRoom(901, 3)
	await putInRoom(902, 3)
	await putInRoom(903, 4)
	await putInRoom(904, 2)
	await putInRoom(905, 2)
	await putInRoom(906, 2)

	const res = await SELF.fetch(`${ORIGIN}/algorithmiclists/HotList?type=1`)
	expect(res.status).toBe(200)
	const body = (await res.json()) as {
		Type: number
		Entities: Array<{ Id: string; Context: null }>
	}
	expect(body.Type).toBe(1)

	// Same entity shape as any other row: ids as STRINGS, `Context` null (nothing attributes
	// a ranking here). Only ids travel — the client resolves each room itself.
	const ids = body.Entities.map((e) => e.Id)
	expect(ids.slice(0, 2)).toEqual(['3', '4'])
	expect(body.Entities.every((e) => e.Context === null)).toBe(true)

	// Room 2 has the most players in it and is still absent: it was created by account 1,
	// the Coach, whose stock rooms the hot row leaves out — a "Hot" row full of Rec Center
	// is a row about the server rather than about what players are doing.
	expect(ids).not.toContain('2')
	// The private room and the dorm are not in it either.
	expect(ids).not.toContain('5')
	expect(ids).not.toContain('6')

	// The row key is matched case-insensitively — it reaches us from a curated page's
	// ItemIds, whose casing is the reference's.
	const lower = await SELF.fetch(`${ORIGIN}/algorithmiclists/hotlist?type=1`)
	expect(((await lower.json()) as { Entities: unknown[] }).Entities).toEqual(body.Entities)
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
