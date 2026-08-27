import { adminSecretsStore, env, SELF } from 'cloudflare:test'
import { beforeAll, expect, it } from 'vitest'

import {
	CURATED_LIST_SCHEMA_DDL,
	PRESENCE_SCHEMA_DDL,
	ROOM_SCHEMA_DDL,
	seedRoomWithSubRooms,
	SUBROOM_SCHEMA_DDL,
} from '@repo/domain'

import curatedLists from '../../../static/curated-lists.json'

import type { Env } from '../../context'

declare module 'cloudflare:test' {
	interface ProvidedEnv extends Env {}
}

const ORIGIN = 'https://example.com'

beforeAll(async () => {
	// Seed the shared JWT signing key into the local Secrets Store so .get() resolves.
	await adminSecretsStore(env.JWT_SECRET).create('test-signing-key')

	// The shared room schema (owned by the `rooms` worker) plus a few public rooms — the
	// live rows rank these. Presence is what makes a room "hot", so its table is here too.
	for (const stmt of ROOM_SCHEMA_DDL) await env.DB.prepare(stmt).run()
	for (const stmt of SUBROOM_SCHEMA_DDL) await env.DB.prepare(stmt).run()
	for (const stmt of PRESENCE_SCHEMA_DDL) await env.DB.prepare(stmt).run()
	// The player-owned curated lists, which this worker owns.
	for (const stmt of CURATED_LIST_SCHEMA_DDL) await env.DB.prepare(stmt).run()

	// Creation order and publish order are deliberately near-REVERSES of each other, so the
	// `new` row and the `recentlyupdated` row can't both be passing on the same ordering.
	//
	//   room  created     published    →  new order: 7, 4, 8, 3
	//      3  2026-01-01  2026-06-01      recentlyupdated: 3, 4, 8, 7
	//      8  2026-01-15  2026-04-01
	//      4  2026-02-01  2026-05-01
	//      7  2026-03-01  never
	for (const room of [
		// Account 1 is the Coach — its rooms are this server's stock ones, which the discovery
		// rows leave out.
		//
		// Tags fill the CATEGORY rows. Room 2 carries `quest` on purpose: every quest-tagged
		// room this server ships with is the Coach's, so a category row that dropped them
		// would be permanently empty.
		{
			RoomId: 2,
			Name: 'RecCenter',
			CreatorAccountId: 1,
			CreatedAt: '2026-04-01T00:00:00Z',
			Tags: [
				{ Tag: 'rro', Type: 2 },
				{ Tag: 'Quest', Type: 0 },
			],
		},
		{
			RoomId: 3,
			Name: 'DodgeBall',
			CreatorAccountId: 500,
			CreatedAt: '2026-01-01T00:00:00Z',
			Tags: [{ Tag: 'quest', Type: 0 }],
		},
		{
			RoomId: 4,
			Name: 'Quietly',
			CreatorAccountId: 501,
			CreatedAt: '2026-02-01T00:00:00Z',
			Tags: [
				{ Tag: 'pvp', Type: 0 },
				{ Tag: 'horror', Type: 0 },
			],
		},
		// Never published a save, so `recentlyupdated` falls back to its creation time — which
		// is the newest of the lot, so it leads `new` and trails `recentlyupdated`.
		{ RoomId: 7, Name: 'FreshRoom', CreatorAccountId: 503, CreatedAt: '2026-03-01T00:00:00Z' },
		{ RoomId: 8, Name: 'Staged', CreatorAccountId: 504, CreatedAt: '2026-01-15T00:00:00Z' },
	]) {
		await seedRoomWithSubRooms(env.DB, {
			...room,
			Accessibility: 1,
			IsDorm: false,
			SubRooms: [],
		} as Record<string, unknown>)
	}
	// Non-public and a dorm: neither belongs in a discovery row.
	for (const room of [
		{ RoomId: 5, Name: 'SecretRoom', CreatorAccountId: 500, Accessibility: 0, IsDorm: false },
		{ RoomId: 6, Name: '@Dorm', CreatorAccountId: 502, Accessibility: 1, IsDorm: true },
	]) {
		await seedRoomWithSubRooms(env.DB, { ...room, SubRooms: [] } as Record<string, unknown>)
	}

	// What a room's "last updated" reads from: the save its subroom currently PUBLISHES.
	await publishSave(3, '2026-06-01T00:00:00Z')
	await publishSave(4, '2026-05-01T00:00:00Z')
	await publishSave(8, '2026-04-01T00:00:00Z')
	// …and a STAGED save far in the future on room 8, which must not move it. Nothing anyone
	// else can load has changed, so a row about updates must not float it to the top.
	await stageSave(8, '2026-12-01T00:00:00Z')
})

/**
 * Give a room a subroom whose published save was created at `createdAt`. Written straight
 * to the shared tables rather than through the `rooms` worker's save route, which this
 * worker has no way to call.
 */
async function publishSave(roomId: number, createdAt: string): Promise<void> {
	await env.DB.prepare('INSERT INTO subroom (sub_room_id, room_id, data) VALUES (?1, ?1, ?2)')
		.bind(roomId, JSON.stringify({ SubRoomId: roomId, RoomId: roomId, Name: 'Home' }))
		.run()
	const id = await insertSave(roomId, createdAt)
	await env.DB.prepare('UPDATE subroom SET current_save_id = ?2 WHERE sub_room_id = ?1')
		.bind(roomId, id)
		.run()
}

/** Attach an UNPUBLISHED save to a subroom that already exists. */
async function stageSave(subRoomId: number, createdAt: string): Promise<void> {
	const id = await insertSave(subRoomId, createdAt)
	await env.DB.prepare('UPDATE subroom SET staged_save_id = ?2 WHERE sub_room_id = ?1')
		.bind(subRoomId, id)
		.run()
}

/** Append a save row and return its (globally unique) id. */
async function insertSave(subRoomId: number, createdAt: string): Promise<number> {
	const row = await env.DB.prepare(
		'INSERT INTO subroom_save (sub_room_id, data) VALUES (?1, ?2) RETURNING sub_room_data_save_id'
	)
		.bind(
			subRoomId,
			JSON.stringify({ SubRoomId: subRoomId, DataBlob: 'scene', CreatedAt: createdAt })
		)
		.first<{ sub_room_data_save_id: number }>()
	return row!.sub_room_data_save_id
}

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

it('serves one curated list object, not a collection', async () => {
	// The client reads a single list off this endpoint — a bare object, not an array.
	const res = await SELF.fetch(
		`${ORIGIN}/curatedlists?creatorAccountId=1&type=7&name=Discovery.PageSource.PlayExplore`
	)
	expect(res.status).toBe(200)
	expect(res.headers.get('content-type')).toContain('application/json')

	const body = await res.text()
	// The reference's list ids are 64-bit: they must reach the client as an unquoted number
	// with every digit intact, which parsing them here would round away (…307326 → …307300).
	expect(body).toContain('"ListId":624765592684307326')

	// Compared without the id: a literal here would round the same way the parse does, so
	// the digits are checked on the raw body above and everything else on the object.
	const { ListId: _id, ...rest } = JSON.parse(body) as Record<string, unknown>
	expect(rest).toEqual({
		CreatorAccountId: 1,
		Name: 'Discovery.PageSource.PlayExplore',
		Description: null,
		ImageName: 'DefaultRoomImage.jpg',
		Type: 7,
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
		Accessibility: 1,
		CreatedAt: '2025-04-23T18:27:03.2643786Z',
	})
})

it('serves every capture in static/curated-lists.json by name', async () => {
	// Driven by the file itself, so a capture added to it is a capture this covers: each
	// entry must be reachable by the three keys the client asks with, and come back as
	// itself. The ids the client caches against have to be unique and reach it with their
	// digits intact.
	expect(curatedLists.length).toBeGreaterThan(0)
	const seen = new Set<string>()
	for (const capture of curatedLists) {
		const res = await SELF.fetch(
			`${ORIGIN}/curatedlists?creatorAccountId=${capture.CreatorAccountId}` +
				`&type=${capture.Type}&name=${capture.Name}`
		)
		expect(res.status).toBe(200)
		const body = await res.text()
		// Never a quoted id: the client's field is a number.
		expect(body).toMatch(/"ListId":\d+,/)
		const { ListId: _id, ...rest } = JSON.parse(body) as Record<string, unknown>
		const { ListId: _captured, ...expected } = capture as Record<string, unknown>
		expect(rest).toEqual(expected)
		expect((capture.ItemIds as string[]).length).toBeGreaterThan(0)
		const id = /"ListId":(\d+),/.exec(body)?.[1]
		expect(id).toBe(capture.ListId)
		expect(seen.has(id!)).toBe(false)
		seen.add(id!)
	}
})

it('serves the RoomGenreTags capture with its tag names', async () => {
	// Genre NAMES, not room or section ids — and the one capture with a null `ImageName`,
	// since the client draws no tile for it. Served under type 5, where the other captures
	// are type 7.
	const res = await SELF.fetch(
		`${ORIGIN}/curatedlists?creatorAccountId=1&type=5&name=RoomGenreTags`
	)
	expect(res.status).toBe(200)
	const body = await res.text()
	expect(body).toContain('"ListId":1')
	expect(JSON.parse(body)).toEqual({
		ListId: 1,
		CreatorAccountId: 1,
		Name: 'RoomGenreTags',
		Description: '',
		ImageName: null,
		Type: 5,
		ItemIds: ['quest', 'battle', 'roleplay', 'horror', 'hangout', 'casual', 'explore'],
		CreatedAt: '2026-01-01T00:00:00Z',
	})
})

it('matches the name case-insensitively and prefers it over the type', async () => {
	const canonical = await (
		await SELF.fetch(
			`${ORIGIN}/curatedlists?creatorAccountId=1&type=7&name=Discovery.PageSource.PlayLibrary`
		)
	).text()
	expect(canonical).toContain('"ListId":5321092632685904804')
	expect(JSON.parse(canonical)).toMatchObject({ Name: 'Discovery.PageSource.PlayLibrary', Type: 7 })

	// Casing reaching us is the client's, not ours.
	const lower = await SELF.fetch(`${ORIGIN}/curatedlists?name=discovery.pagesource.playlibrary`)
	expect(await lower.text()).toBe(canonical)

	// Every capture shares type 7, so the name is what tells them apart — a request naming
	// Library must never come back with Explore's rows, and the type alone answers with the
	// page default (the first list in the array).
	const explore = await SELF.fetch(`${ORIGIN}/curatedlists?type=7`)
	expect(((await explore.json()) as { Name: string }).Name).toBe('Discovery.PageSource.PlayExplore')
})

it('404s for a name it has nothing under', async () => {
	// A name nothing matches is a list that does not exist. It used to answer with the
	// default capture, which put one page's rows under another page's heading — content that
	// looks real, where a 404 says plainly there is no such list. `17859340` is the store
	// Featured page's own lookup (by the reference's numeric list id) and gets the same
	// answer: nothing here is called that.
	for (const query of [
		'?creatorAccountId=1&type=5&name=Internal_Medieval_Items',
		'?creatorAccountId=1&type=4&name=17859340',
		'?type=99&name=Nope',
		'?type=7&name=Discovery.PageSource.NotAPage',
	]) {
		const res = await SELF.fetch(`${ORIGIN}/curatedlists${query}`)
		expect(res.status).toBe(404)
	}

	// Naming NO list is not a miss — it asks for the page default, and only the type says
	// which page. Without a type there is no page either, so that 404s too.
	const byType = await SELF.fetch(`${ORIGIN}/curatedlists?creatorAccountId=1&type=7`)
	expect(byType.status).toBe(200)
	expect(((await byType.json()) as { Name: string }).Name).toBe('Discovery.PageSource.PlayExplore')

	for (const query of ['?creatorAccountId=7&type=&name=', '']) {
		expect((await SELF.fetch(`${ORIGIN}/curatedlists${query}`)).status).toBe(404)
	}
})

/**
 * Store a player's own list and its items, the way the (not yet written) save-for-later
 * mutation would. Returns the id it was stored under.
 */
async function seedPlayerList(
	list: {
		creatorAccountId: number
		type: number
		name: string
		description?: string | null
		imageName?: string
		accessibility?: number
		createdAt?: string
	},
	itemIds: string[]
): Promise<number> {
	const row = await env.DB.prepare(
		`INSERT INTO list (creator_account_id, list_type, list_name, list_description,
		                   image_name, accessibility, created_at)
		 VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)
		 RETURNING list_id`
	)
		.bind(
			list.creatorAccountId,
			list.type,
			list.name,
			list.description ?? null,
			list.imageName ?? 'DefaultRoomImage.jpg',
			list.accessibility ?? 1,
			list.createdAt ?? '2025-04-23T18:27:03.2643786Z'
		)
		.first<{ list_id: number }>()
	const listId = row!.list_id
	for (const itemId of itemIds) {
		await env.DB.prepare('INSERT INTO list_item (list_id, item_id) VALUES (?1, ?2)')
			.bind(listId, itemId)
			.run()
	}
	return listId
}

it('serves a player’s own __SavedForLater_Rooms list out of D1', async () => {
	const listId = await seedPlayerList(
		{
			creatorAccountId: 205,
			type: 1,
			name: '__SavedForLater_Rooms',
			description: 'Something',
		},
		['3', '4', '8']
	)

	const res = await SELF.fetch(
		`${ORIGIN}/curatedlists?creatorAccountId=205&type=1&name=__SavedForLater_Rooms`
	)
	expect(res.status).toBe(200)
	const body = await res.text()
	// A stored id reaches the client the same way a captured one does: unquoted.
	expect(body).toContain(`"ListId":${listId},`)

	const { ListId: _id, ...rest } = JSON.parse(body) as Record<string, unknown>
	expect(rest).toEqual({
		CreatorAccountId: 205,
		Name: '__SavedForLater_Rooms',
		Description: 'Something',
		ImageName: 'DefaultRoomImage.jpg',
		// The ListEntityType: 1 = Rooms, so the ItemIds are room ids the client resolves
		// against the rooms worker. ItemIds are STRINGS even here, as in every capture.
		Type: 1,
		ItemIds: ['3', '4', '8'],
		Accessibility: 1,
		CreatedAt: '2025-04-23T18:27:03.2643786Z',
	})
})

it('serves a player list in the order its items were added', async () => {
	await seedPlayerList({ creatorAccountId: 206, type: 1, name: '__SavedForLater_Rooms' }, [
		'8',
		'2',
		'7',
	])
	const res = await SELF.fetch(
		`${ORIGIN}/curatedlists?creatorAccountId=206&type=1&name=__SavedForLater_Rooms`
	)
	// Insertion order, not sorted and not the row order D1 happens to return: the ItemIds
	// array IS the display order of the carousel.
	expect(((await res.json()) as { ItemIds: string[] }).ItemIds).toEqual(['8', '2', '7'])
})

it('keeps one player’s list out of another’s, and one list type out of another', async () => {
	await seedPlayerList({ creatorAccountId: 207, type: 1, name: '__SavedForLater_Rooms' }, ['3'])

	// The same name for a different player is a different list — and player 208 has none, so
	// theirs comes back EMPTY rather than 207's.
	const other = await SELF.fetch(
		`${ORIGIN}/curatedlists?creatorAccountId=208&type=1&name=__SavedForLater_Rooms`
	)
	expect((await other.json()) as unknown).toMatchObject({
		CreatorAccountId: 208,
		Name: '__SavedForLater_Rooms',
		ItemIds: [],
	})

	// Same owner and name, different entity type: also a different list. The type says what
	// the ids ARE, so serving room ids to a request for items would resolve them against the
	// wrong service.
	const wrongType = await SELF.fetch(
		`${ORIGIN}/curatedlists?creatorAccountId=207&type=4&name=__SavedForLater_Rooms`
	)
	expect(((await wrongType.json()) as { ItemIds: string[] }).ItemIds).toEqual([])
})

it('matches a player list’s name case-insensitively', async () => {
	await seedPlayerList({ creatorAccountId: 209, type: 1, name: '__SavedForLater_Rooms' }, ['4'])
	const res = await SELF.fetch(
		`${ORIGIN}/curatedlists?creatorAccountId=209&type=1&name=__savedforlater_rooms`
	)
	expect(((await res.json()) as { ItemIds: string[] }).ItemIds).toEqual(['4'])
})

it('answers an unowned reserved list EMPTY rather than with the default page', async () => {
	// The bug this replaces: nothing is captured under `__SavedForLater_Rooms` and nothing
	// is captured under type 1 either, so the fallback chain used to end at the default list
	// — and a player who had saved nothing got the Play/Explore rows under a "Saved for
	// Later" heading. A reserved name stops before that fallback.
	const res = await SELF.fetch(
		`${ORIGIN}/curatedlists?creatorAccountId=999&type=1&name=__SavedForLater_Rooms`
	)
	expect(res.status).toBe(200)
	const list = (await res.json()) as { Name: string; ItemIds: string[]; ImageName: string }
	expect(list.Name).toBe('__SavedForLater_Rooms')
	expect(list.ItemIds).toEqual([])
	// Still a well-formed list: the client parses ImageName into a non-nullable string.
	expect(typeof list.ImageName).toBe('string')
})

it('404s for a NON-reserved unknown name', async () => {
	// The empty-list answer is the reserved prefix's alone: a name a player did not reserve
	// and this server has nothing under is missing, not empty. An empty list would have the
	// client render a real but blank row for a page that does not exist here.
	const featured = await SELF.fetch(
		`${ORIGIN}/curatedlists?creatorAccountId=1&type=4&name=17859340`
	)
	expect(featured.status).toBe(404)
})

it('prefers a player’s stored list over a capture of the same name', async () => {
	// The captures are this server's fixtures; a stored list is a player's own data, so D1
	// is asked first.
	await seedPlayerList(
		{ creatorAccountId: 210, type: 7, name: 'Discovery.PageSource.PlayExplore' },
		['Rooms_MostPopular']
	)
	const res = await SELF.fetch(
		`${ORIGIN}/curatedlists?creatorAccountId=210&type=7&name=Discovery.PageSource.PlayExplore`
	)
	expect(((await res.json()) as { ItemIds: string[] }).ItemIds).toEqual(['Rooms_MostPopular'])

	// …and the capture still answers for the account that owns it.
	const captured = await SELF.fetch(
		`${ORIGIN}/curatedlists?creatorAccountId=1&type=7&name=Discovery.PageSource.PlayExplore`
	)
	expect(((await captured.json()) as { ItemIds: string[] }).ItemIds.length).toBe(10)
})

/** The client's save-for-later call: PUT the item into the named list, body-encoded. */
async function saveForLater(
	name: string,
	itemId: string,
	headers: Record<string, string>,
	body = 'accessibility=0&type=1'
) {
	return SELF.fetch(`${ORIGIN}/curatedlists/${name}/items/${itemId}/createlistifneeded`, {
		method: 'PUT',
		headers: { ...headers, 'Content-Type': 'application/x-www-form-urlencoded' },
		body,
	})
}

/** Read a player's list back the way the client does. */
async function readList(accountId: number, type = 1, name = '__SavedForLater_Rooms') {
	const res = await SELF.fetch(
		`${ORIGIN}/curatedlists?creatorAccountId=${accountId}&type=${type}&name=${name}`
	)
	expect(res.status).toBe(200)
	return (await res.json()) as {
		CreatorAccountId: number
		Name: string
		Type: number
		ItemIds: string[]
		Accessibility: number
		ImageName: string
	}
}

it('creates the list and adds the item on PUT …/createlistifneeded', async () => {
	const res = await saveForLater('__SavedForLater_Rooms', '953', await bearer('300'))
	expect(res.status).toBe(200)

	// Answers the list as it now stands — the row the client re-renders is the one this call
	// changed — with the id unquoted, as every read of a list serves it.
	const body = await res.text()
	expect(body).toMatch(/"ListId":\d+,/)
	// The SAVE's projection: every key the read serves EXCEPT `Accessibility`, in the read's
	// order. Compared exactly, not loosely, because the missing key is the point.
	const { ListId: _id, ...rest } = JSON.parse(body) as Record<string, unknown>
	expect(rest).toEqual({
		CreatorAccountId: 300,
		Name: '__SavedForLater_Rooms',
		Description: null,
		ImageName: 'DefaultRoomImage.jpg',
		Type: 1,
		ItemIds: ['953'],
		CreatedAt: expect.any(String),
	})
	expect(Object.keys(rest)).not.toContain('Accessibility')

	// …and the client's own read finds it under the same three keys — and DOES carry the
	// accessibility the save stored but did not echo.
	expect(await readList(300)).toMatchObject({ ItemIds: ['953'], Accessibility: 0 })
})

it('appends to the list it already created rather than making a second one', async () => {
	const headers = await bearer('301')
	const first = await (await saveForLater('__SavedForLater_Rooms', '953', headers)).text()
	const second = await (await saveForLater('__SavedForLater_Rooms', '641', headers)).text()

	// Same list id both times: the name is the list's identity, so the second save must find
	// the first list rather than create a rival the read can never resolve.
	const idOf = (b: string) => /"ListId":(\d+),/.exec(b)?.[1]
	expect(idOf(second)).toBe(idOf(first))
	expect(await readList(301)).toMatchObject({ ItemIds: ['953', '641'] })
})

it('is idempotent — saving the same room twice shows it once', async () => {
	const headers = await bearer('302')
	await saveForLater('__SavedForLater_Rooms', '953', headers)
	await saveForLater('__SavedForLater_Rooms', '641', headers)
	const again = await saveForLater('__SavedForLater_Rooms', '953', headers)
	expect(again.status).toBe(200)

	// Kept in the position it was FIRST saved into, not moved to the end.
	expect(await readList(302)).toMatchObject({ ItemIds: ['953', '641'] })
})

it('owns the list by the TOKEN, not by anything the caller can name', async () => {
	await saveForLater('__SavedForLater_Rooms', '953', await bearer('303'))
	await saveForLater('__SavedForLater_Rooms', '641', await bearer('304'))

	// Two players, two lists — neither can reach the other's, and the route takes no
	// creatorAccountId at all, so there is nothing to write into someone else's list with.
	expect((await readList(303)).ItemIds).toEqual(['953'])
	expect((await readList(304)).ItemIds).toEqual(['641'])
})

it('refuses an unauthenticated save', async () => {
	const res = await saveForLater('__SavedForLater_Rooms', '953', {})
	expect(res.status).toBe(401)
})

it('creates the list under the type the body names', async () => {
	// `type` is part of a list's identity, so a body naming 4 must not land in the type-1
	// list the client reads back — and must be findable under 4.
	await saveForLater('__SavedForLater_Items', '77', await bearer('305'), 'accessibility=0&type=4')
	expect((await readList(305, 4, '__SavedForLater_Items')).ItemIds).toEqual(['77'])
	expect((await readList(305, 1, '__SavedForLater_Items')).ItemIds).toEqual([])
})

it('defaults a bodiless save to a private room list', async () => {
	// A body that never arrives (or fails to parse) must not strand the list under a type the
	// client's own read can't find.
	const res = await SELF.fetch(
		`${ORIGIN}/curatedlists/__SavedForLater_Rooms/items/953/createlistifneeded`,
		{ method: 'PUT', headers: await bearer('306') }
	)
	expect(res.status).toBe(200)
	expect(await readList(306)).toMatchObject({ Type: 1, Accessibility: 0, ItemIds: ['953'] })
})

it('leaves an existing list’s accessibility alone on a later save', async () => {
	const headers = await bearer('307')
	await saveForLater('__SavedForLater_Rooms', '953', headers, 'accessibility=1&type=1')
	expect((await readList(307)).Accessibility).toBe(1)

	// The client sends accessibility on every add, but this call is "add an item", not
	// "change who can see the list" — one stray add must not flip a list the player made public.
	await saveForLater('__SavedForLater_Rooms', '641', headers, 'accessibility=0&type=1')
	expect(await readList(307)).toMatchObject({ Accessibility: 1, ItemIds: ['953', '641'] })
})

it('serves a discovery row from /algorithmiclists', async () => {
	const res = await SELF.fetch(
		`${ORIGIN}/algorithmiclists/Rooms_Battle_AlgoEndpoint_PlayHighlight_TabsTest_Explore?type=1`
	)
	expect(res.status).toBe(200)
	// `Type` is echoed from the query — it says what the ids ARE (1 = rooms), so the client
	// resolves them against the right service. Nothing ranks this row, so it answers 200 with
	// NO entities: the client hides an empty carousel, where a 404 would show it as one that
	// failed to load.
	expect(await res.json()).toEqual({ Type: 1, Entities: [] })
})

it('serves the hand-picked summerpartycarousel row', async () => {
	// The store's "Medieval Masterpieces from the Community" carousel, which the client asks
	// for by the section's `sourceMetadata` slug and with `?type=5` (Generic). Nothing ranks
	// store items here, so the row is a fixed id list — same entity shape as any other row,
	// ids as STRINGS and `Context` null.
	const res = await SELF.fetch(`${ORIGIN}/algorithmiclists/summerpartycarousel?type=5`)
	expect(res.status).toBe(200)
	const expected = {
		Type: 5,
		Entities: [
			{ Id: '257', Context: null },
			{ Id: '192', Context: null },
			{ Id: '641', Context: null },
			{ Id: '657', Context: null },
		],
	}
	expect(await res.json()).toEqual(expected)

	// Looked up folded, like every other row key: the casing is the reference's, not ours.
	const cased = await SELF.fetch(`${ORIGIN}/algorithmiclists/SummerPartyCarousel?type=5`)
	expect(await cased.json()).toEqual(expected)

	// The store Clothing page's "New" carousel serves the same placeholder items — both are
	// store rows nothing ranks yet, so they share one id list rather than drifting apart.
	const newItems = await SELF.fetch(`${ORIGIN}/algorithmiclists/newitems?type=5`)
	expect(newItems.status).toBe(200)
	expect(await newItems.json()).toEqual(expected)
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

/** Fetch a discovery row and return the room ids it serves, in order. */
async function rowIds(list: string): Promise<string[]> {
	const res = await SELF.fetch(`${ORIGIN}/algorithmiclists/${list}?type=1`)
	expect(res.status).toBe(200)
	const body = (await res.json()) as {
		Type: number
		Entities: Array<{ Id: string; Context: null }>
	}
	expect(body.Type).toBe(1)
	// Same entity shape as any other row: ids as STRINGS, `Context` null.
	expect(body.Entities.every((e) => e.Context === null)).toBe(true)
	return body.Entities.map((e) => e.Id)
}

it('orders /algorithmiclists/recentlyupdated by when each room last PUBLISHED', async () => {
	// Publish order, newest first — room 7 last because it has never published and falls back
	// to its own creation time. Note this is nearly the reverse of the `new` row below: the
	// two rows read different timestamps, not the same one twice.
	expect(await rowIds('recentlyupdated')).toEqual(['3', '4', '8', '7'])
})

it('does not let a STAGED save float a room up recentlyupdated', async () => {
	// Room 8's staged save is dated December, later than every published save here. It stays
	// third all the same: staging changes nothing another player can load, so a row about
	// updates must not react to it.
	const ids = await rowIds('recentlyupdated')
	expect(ids.indexOf('8')).toBe(2)
})

it('orders /algorithmiclists/new by creation time', async () => {
	expect(await rowIds('new')).toEqual(['7', '4', '8', '3'])
})

it.each(['recentlyupdated', 'new'])(
	'leaves stock, private and dorm rooms out of %s',
	async (list) => {
		const ids = await rowIds(list)
		// Room 2 is the Coach's — this server's stock rooms, which a row about what players have
		// been building must not be full of.
		expect(ids).not.toContain('2')
		// Not public, and a dorm.
		expect(ids).not.toContain('5')
		expect(ids).not.toContain('6')
	}
)

/** Stamp a visit, the way the `match` heartbeat's interaction write would. */
async function recordVisit(playerId: number, roomId: number, at: string): Promise<void> {
	await env.DB.prepare(
		'INSERT OR REPLACE INTO interaction (player_id, room_id, last_visited_at) VALUES (?1, ?2, ?3)'
	)
		.bind(playerId, roomId, at)
		.run()
}

/** The row ids `list` serves to the caller `headers` authenticate as. */
async function personalRowIds(list: string, headers: Record<string, string>): Promise<string[]> {
	const res = await SELF.fetch(`${ORIGIN}/algorithmiclists/${list}?type=1`, { headers })
	expect(res.status).toBe(200)
	const body = (await res.json()) as {
		Type: number
		Entities: Array<{ Id: string; Context: null }>
	}
	expect(body.Type).toBe(1)
	expect(body.Entities.every((e) => e.Context === null)).toBe(true)
	return body.Entities.map((e) => e.Id)
}

it('orders /algorithmiclists/recentlyvisited by the caller’s last visit, newest first', async () => {
	// Player 42 (what `bearer()` mints by default) has been in three rooms; the timestamps
	// are deliberately unrelated to creation and publish order, so this row can't pass on
	// either of the orderings `new` and `recentlyupdated` assert.
	await recordVisit(42, 3, '2026-07-01T00:00:00Z')
	await recordVisit(42, 8, '2026-07-03T00:00:00Z')
	await recordVisit(42, 4, '2026-07-02T00:00:00Z')

	expect(await personalRowIds('recentlyvisited', await bearer('42'))).toEqual(['8', '4', '3'])
})

it('keeps one player’s recentlyvisited row out of another’s', async () => {
	// Player 43 has been somewhere else entirely. The slug is the same for everyone, so the
	// row has to be resolved from the TOKEN rather than from the row key.
	await recordVisit(43, 7, '2026-07-04T00:00:00Z')
	expect(await personalRowIds('recentlyvisited', await bearer('43'))).toEqual(['7'])
})

it('serves recentlyvisited a room the caller can still get back to, private or stock', async () => {
	// Room 5 is private and room 2 is the Coach's — both are dropped from the RANKED rows,
	// and both belong here: this is where the caller has actually been, not a recommendation.
	await recordVisit(44, 5, '2026-07-05T00:00:00Z')
	await recordVisit(44, 2, '2026-07-06T00:00:00Z')
	expect(await personalRowIds('recentlyvisited', await bearer('44'))).toEqual(['2', '5'])
})

it('answers recentlyvisited empty for a caller with no history and no token', async () => {
	// A brand-new account has been nowhere, and an untokened caller is nobody — both get an
	// EMPTY row rather than the canned entities, which would claim visits that never happened,
	// and rather than a 401, which the client renders as a row that failed to load.
	expect(await personalRowIds('recentlyvisited', await bearer('999'))).toEqual([])

	const res = await SELF.fetch(`${ORIGIN}/algorithmiclists/RecentlyVisited?type=1`)
	expect(res.status).toBe(200)
	expect(await res.json()).toEqual({ Type: 1, Entities: [] })
})

it('serves the rooms tagged `quest` for /algorithmiclists/quests_algoendpoint', async () => {
	const ids = await rowIds('quests_algoendpoint')
	// Ordering is the hot feed's (live players, then engagement), so assert membership.
	expect([...ids].sort()).toEqual(['2', '3'])

	// Room 2 is the COACH's and belongs here all the same. Every quest-tagged room this
	// server ships with is the Coach's, so applying the player-made filter the Hot/New rows
	// use would leave this carousel empty — a category row asks what a room is about, not
	// who made it.
	expect(ids).toContain('2')

	// Tagged `pvp`, not `quest`.
	expect(ids).not.toContain('4')
	// A category row is still a discovery row: the private room and the dorm stay out.
	expect(ids).not.toContain('5')
	expect(ids).not.toContain('6')
})

// One row per category, each selecting on its own tag. The slugs and tags line up here,
// but the table maps them explicitly — see ROW_FEEDS.
it.each([
	['horror_algoendpoint', ['4']],
	// Nothing carries these tags yet, so the rows are genuinely EMPTY rather than falling
	// back to the canned entities. An empty category is the honest answer; the fallback would
	// show five unrelated rooms under a category heading.
	['battle_algoendpoint', []],
	['roleplay_algoendpoint', []],
	['hangout_algoendpoint', []],
	['casual_algoendpoint', []],
	['explore_algoendpoint', []],
])('serves the %s category row', async (list, expected) => {
	expect(await rowIds(list)).toEqual(expected)
})

it('matches the tag case-insensitively', async () => {
	// Room 2 carries `Quest` capitalised — tags are matched lowercased, so casing a player
	// typed must not decide whether their room is in the category.
	expect(await rowIds('quests_algoendpoint')).toContain('2')
})

it.each([
	['RecentlyUpdated', 'recentlyupdated'],
	['New', 'new'],
	['HOTLIST', 'hotlist'],
	['Quests_AlgoEndpoint', 'quests_algoendpoint'],
])('matches the row key %s case-insensitively', async (asked, canonical) => {
	// The slug reaches us from a curated page's ItemIds or a section's sourceMetadata, whose
	// casing is the reference's rather than ours.
	expect(await rowIds(asked)).toEqual(await rowIds(canonical))
})

it('echoes the requested type and answers an unknown row', async () => {
	const other = await SELF.fetch(`${ORIGIN}/algorithmiclists/Nothing_Ranks_This_Row?type=4`)
	expect(other.status).toBe(200)
	const body = (await other.json()) as { Type: number; Entities: unknown[] }
	// An unknown row key answers 200 with no entities rather than 404ing: a failed request
	// renders as a row that failed to load, an empty one as a row the client hides.
	expect(body.Type).toBe(4)
	expect(body.Entities).toEqual([])

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

// D1 caps a statement at 100 bound parameters. The seed above has a handful of rooms, so
// every per-room `IN (…)` list fitted and the cap went unnoticed until a real server
// crossed it: a discovery row reads every room to rank it and attaches tags to all of
// them, so the bind list grew with the database until the query failed with "variable
// number must be between ?1 and ?100". The ranking lives in `@repo/domain`, which this
// worker bundles from source — so this is the same fix the `rooms` worker got, asserted
// again from the worker that reported it.
it('serves the rows when there are more rooms than D1 allows bound parameters', async () => {
	const FIRST = 20000
	const COUNT = 150
	for (let i = 0; i < COUNT; i++) {
		const roomId = FIRST + i
		await env.DB.prepare('INSERT INTO room (data) VALUES (?1)')
			.bind(
				JSON.stringify({
					RoomId: roomId,
					Name: `BulkRoom${i}`,
					CreatorAccountId: 700,
					IsDorm: false,
					Accessibility: 1,
					CreatedAt: '2026-05-01T00:00:00Z',
				})
			)
			.run()
		if (i % 3 === 0) {
			await env.DB.prepare('INSERT INTO room_tag (room_id, tag, type) VALUES (?1, ?2, 0)')
				.bind(roomId, 'quest')
				.run()
		}
	}

	// The row that reported the error, plus the three others that read every room.
	for (const list of ['HotList', 'new', 'recentlyupdated']) {
		const res = await SELF.fetch(`${ORIGIN}/algorithmiclists/${list}?type=1`)
		expect(res.status, `${list} above the bound-parameter cap`).toBe(200)
		const body = (await res.json()) as { Entities: unknown[] }
		expect(body.Entities.length).toBeGreaterThan(0)
	}

	// And a category row, which narrows on the tag index rather than reading every room.
	const quests = await SELF.fetch(`${ORIGIN}/algorithmiclists/quests_algoendpoint?type=1`)
	expect(quests.status).toBe(200)
	expect(((await quests.json()) as { Entities: unknown[] }).Entities.length).toBeGreaterThan(0)

	await env.DB.prepare('DELETE FROM room WHERE room_id >= ?1').bind(FIRST).run()
	await env.DB.prepare('DELETE FROM room_tag WHERE room_id >= ?1').bind(FIRST).run()
})

it('generates a spec with no dangling $refs', async () => {
	const res = await SELF.fetch(`${ORIGIN}/openapi.json`)
	expect(res.status).toBe(200)
	const spec = (await res.json()) as { paths: Record<string, unknown> }
	expect(Object.keys(spec.paths)).toEqual(
		expect.arrayContaining([
			'/curatedlists',
			'/curatedlists/bulk',
			'/curatedlists/{name}/items/{itemId}/createlistifneeded',
			'/algorithmiclists/{list}',
			'/contextualfeatures',
		])
	)
	// The spec route keeps itself out of its own output.
	expect(Object.keys(spec.paths)).not.toContain('/openapi.json')
	expect(JSON.stringify(spec).match(/\$ref/g)).toBeNull()
})
