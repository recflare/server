import { adminSecretsStore, env, SELF } from 'cloudflare:test'
import { beforeAll, describe, expect, it } from 'vitest'

import { RELATIONSHIP_SCHEMA_DDL, RelationshipType } from '@repo/domain'

import { SCHEMA_DDL } from '../../leaderboard-db'

beforeAll(async () => {
	// Seed the shared JWT signing key into the local Secrets Store so .get() resolves.
	await adminSecretsStore(env.JWT_SECRET).create(TEST_SECRET)
	for (const stmt of SCHEMA_DDL) await env.DB.prepare(stmt).run()
	// The `api` worker's relationship table — the friends filter reads it.
	for (const stmt of RELATIONSHIP_SCHEMA_DDL) await env.DB.prepare(stmt).run()
})

const befriend = (a: number, b: number) =>
	env.DB.prepare(
		'INSERT INTO relationship (requester_id, target_id, relationship_type) VALUES (?1, ?2, ?3)'
	)
		.bind(a, b, RelationshipType.Friend)
		.run()

// Mint a token the way the `auth` worker does, signing with the shared test key seeded
// into the JWT_SECRET store, so this worker's validation accepts it.
const TEST_SECRET = 'test-signing-key'

function b64url(input: ArrayBuffer | string): string {
	const bytes = typeof input === 'string' ? new TextEncoder().encode(input) : new Uint8Array(input)
	let binary = ''
	for (const byte of bytes) binary += String.fromCharCode(byte)
	return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

async function bearer(sub: number): Promise<Record<string, string>> {
	const now = Math.floor(Date.now() / 1000)
	const signingInput = `${b64url(JSON.stringify({ alg: 'HS256', typ: 'JWT' }))}.${b64url(
		JSON.stringify({ sub: String(sub), exp: now + 3600 })
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

const post = (path: string, body: unknown, headers: Record<string, string> = {}) =>
	SELF.fetch(`https://example.com/leaderboard/${path}`, {
		method: 'POST',
		headers: { 'content-type': 'application/json', ...headers },
		body: JSON.stringify(body),
	})

async function setStat(
	player: number,
	RoomId: number,
	StatValue: number,
	CurrentStatValue: number | null = null,
	StatChannel = 2
) {
	const res = await post(
		'CheckAndSetStat',
		{ StatChannel, RoomId, StatValue, CurrentStatValue },
		await bearer(player)
	)
	expect(res.status).toBe(200)
	// The whole body is the number — not an envelope, not `{ value: 0 }`.
	expect(await res.text()).toBe('0')
}

const stored = (player: number, room: number, channel = 2) =>
	env.DB.prepare(
		'SELECT stat_value FROM leaderboard WHERE player_id = ?1 AND room_id = ?2 AND stat_channel = ?3'
	)
		.bind(player, room, channel)
		.first<{ stat_value: number }>()

it('response with hello world', async () => {
	const res = await SELF.fetch('https://example.com')
	expect(res.status).toBe(200)
	expect(await res.text()).toMatchInlineSnapshot(`"hello, world!"`)
})

describe('an empty board', () => {
	it('answers GetNearbyScores with an empty row list', async () => {
		const res = await post('GetNearbyScores', { PlayerId: 1, RoomId: 999, StatChannel: 1 })
		expect(res.status).toBe(200)
		expect(await res.json()).toEqual({ Rows: [] })
	})

	it('answers GetRanks with an empty row list', async () => {
		const res = await post('GetRanks', {
			RankStart: 0,
			RankEnd: 9,
			PlayerId: 2,
			StatChannel: 1,
			RoomId: 999,
			FilterType: 0,
			SortAscending: false,
		})
		expect(res.status).toBe(200)
		expect(await res.json()).toEqual({ Rows: [] })
	})

	it('answers GetPlayerRank with the unranked sentinel and the caller’s own id', async () => {
		const res = await post('GetPlayerRank', {
			PlayerId: 205,
			StatChannel: 2,
			RoomId: 999,
			FilterType: 0,
			SortAscending: false,
		})
		expect(res.status).toBe(200)
		// Three fields, no board selectors: the client pairs the answer with its own question.
		// Rank is 1-based, so the sentinel has to be a big number rather than 0 — which would
		// render the unranked caller as first place.
		expect(await res.json()).toEqual({ PlayerId: 205, Score: 0, Rank: 99999 })
	})

	it('answers GetPlayerRank even when the body is unreadable', async () => {
		const res = await SELF.fetch('https://example.com/leaderboard/GetPlayerRank', {
			method: 'POST',
			body: 'not json',
		})
		// A board that fails to draw is worse than one that draws the player as unranked.
		expect(res.status).toBe(200)
		expect(await res.json()).toEqual({ PlayerId: 0, Score: 0, Rank: 99999 })
	})

	it('answers GetRanks with an empty board when the body is unreadable', async () => {
		const res = await SELF.fetch('https://example.com/leaderboard/GetRanks', {
			method: 'POST',
			body: 'not json',
		})
		expect(res.status).toBe(200)
		expect(await res.json()).toEqual({ Rows: [] })
	})
})

describe('CheckAndSetStat', () => {
	it('refuses a write with no bearer token', async () => {
		const res = await post('CheckAndSetStat', {
			StatChannel: 2,
			RoomId: 14,
			StatValue: 1,
			CurrentStatValue: null,
		})
		expect(res.status).toBe(401)
	})

	it('stores the caller’s value on the board and answers a bare 0', async () => {
		await setStat(42, 14, 3)
		expect(await stored(42, 14)).toEqual({ stat_value: 3 })
	})

	it('overwrites when the client believes nothing is stored', async () => {
		await setStat(43, 14, 3)
		await setStat(43, 14, 7, null)
		expect(await stored(43, 14)).toEqual({ stat_value: 7 })
	})

	it('writes only when CurrentStatValue matches what is stored', async () => {
		await setStat(44, 14, 3)
		await setStat(44, 14, 4, 3)
		expect(await stored(44, 14)).toEqual({ stat_value: 4 })
		// A stale client that still believes 3 is stored doesn't walk the board backwards.
		await setStat(44, 14, 1, 3)
		expect(await stored(44, 14)).toEqual({ stat_value: 4 })
	})

	it('keeps rooms and channels apart', async () => {
		await setStat(45, 14, 3)
		await setStat(45, 15, 9)
		await setStat(45, 14, 5, null, 7)
		expect(await stored(45, 14)).toEqual({ stat_value: 3 })
		expect(await stored(45, 15)).toEqual({ stat_value: 9 })
		expect(await stored(45, 14, 7)).toEqual({ stat_value: 5 })
	})
})

describe('a scored board', () => {
	// Room 100: player 1 has 10, player 2 has 30, player 3 has 20, player 4 has 20 (ties
	// break on the lower id, so 3 ranks ahead of 4).
	const ROOM = 100
	beforeAll(async () => {
		await setStat(1, ROOM, 10)
		await setStat(2, ROOM, 30)
		await setStat(3, ROOM, 20)
		await setStat(4, ROOM, 20)
	})

	it('answers another channel of the same room as its own, empty board', async () => {
		const res = await post('GetRanks', {
			RankStart: 0,
			RankEnd: 9,
			PlayerId: 1,
			StatChannel: 3,
			RoomId: ROOM,
			FilterType: 0,
			SortAscending: false,
		})
		expect(await res.json()).toEqual({ Rows: [] })
	})

	it('ranks highest value first with 1-based ranks', async () => {
		const res = await post('GetRanks', {
			RankStart: 0,
			RankEnd: 9,
			PlayerId: 1,
			StatChannel: 2,
			RoomId: ROOM,
			FilterType: 0,
			SortAscending: false,
		})
		expect(await res.json()).toEqual({
			Rows: [
				{ PlayerId: 2, Score: 30, Rank: 1 },
				{ PlayerId: 3, Score: 20, Rank: 2 },
				{ PlayerId: 4, Score: 20, Rank: 3 },
				{ PlayerId: 1, Score: 10, Rank: 4 },
			],
		})
	})

	it('pages the board by rank, inclusive at both ends', async () => {
		const res = await post('GetRanks', {
			RankStart: 2,
			RankEnd: 3,
			PlayerId: 1,
			StatChannel: 2,
			RoomId: ROOM,
			FilterType: 0,
			SortAscending: false,
		})
		expect(await res.json()).toEqual({
			Rows: [
				{ PlayerId: 3, Score: 20, Rank: 2 },
				{ PlayerId: 4, Score: 20, Rank: 3 },
			],
		})
	})

	it('ranks lowest first when asked to sort ascending', async () => {
		const res = await post('GetRanks', {
			RankStart: 1,
			RankEnd: 2,
			PlayerId: 1,
			StatChannel: 2,
			RoomId: ROOM,
			FilterType: 0,
			SortAscending: true,
		})
		expect(await res.json()).toEqual({
			Rows: [
				{ PlayerId: 1, Score: 10, Rank: 1 },
				{ PlayerId: 3, Score: 20, Rank: 2 },
			],
		})
	})

	it('answers a player’s own rank consistently with the page', async () => {
		const res = await post('GetPlayerRank', {
			PlayerId: 4,
			StatChannel: 2,
			RoomId: ROOM,
			FilterType: 0,
			SortAscending: false,
		})
		expect(await res.json()).toEqual({ PlayerId: 4, Score: 20, Rank: 3 })
	})

	it('answers a player with no row in the room as unranked', async () => {
		const res = await post('GetPlayerRank', {
			PlayerId: 77,
			StatChannel: 2,
			RoomId: ROOM,
			FilterType: 0,
			SortAscending: false,
		})
		expect(await res.json()).toEqual({ PlayerId: 77, Score: 0, Rank: 99999 })
	})

	it('answers the rows around a player, clamped to the board', async () => {
		const res = await post('GetNearbyScores', {
			PlayerId: 4,
			StatChannel: 2,
			RoomId: ROOM,
			FilterType: 0,
			SortAscending: false,
			WindowSize: 1,
		})
		expect(await res.json()).toEqual({
			Rows: [
				{ PlayerId: 3, Score: 20, Rank: 2 },
				{ PlayerId: 4, Score: 20, Rank: 3 },
				{ PlayerId: 1, Score: 10, Rank: 4 },
			],
		})
	})

	it('answers the top of the board around a player who isn’t on it', async () => {
		const res = await post('GetNearbyScores', {
			PlayerId: 77,
			StatChannel: 2,
			RoomId: ROOM,
			FilterType: 0,
			SortAscending: false,
			WindowSize: 1,
		})
		expect(await res.json()).toEqual({
			Rows: [
				{ PlayerId: 2, Score: 30, Rank: 1 },
				{ PlayerId: 3, Score: 20, Rank: 2 },
				{ PlayerId: 4, Score: 20, Rank: 3 },
			],
		})
	})
})

describe('the friends filter', () => {
	// Room 200, channel 2: players 11..15 score 50, 40, 30, 20, 10. Player 14 is friends
	// with 11 (14 requested) and 15 (15 requested); 12 and 13 are strangers, and 16 is a
	// friend with no score. Globally 14 is 4th; among friends 2nd.
	const ROOM = 200
	const board = (extra: object) => ({
		StatChannel: 2,
		RoomId: ROOM,
		FilterType: 1,
		SortAscending: false,
		...extra,
	})
	beforeAll(async () => {
		await setStat(11, ROOM, 50)
		await setStat(12, ROOM, 40)
		await setStat(13, ROOM, 30)
		await setStat(14, ROOM, 20)
		await setStat(15, ROOM, 10)
		await befriend(14, 11)
		await befriend(15, 14)
		await befriend(14, 16)
		// A pending request is not a friendship.
		await env.DB.prepare(
			'INSERT INTO relationship (requester_id, target_id, relationship_type) VALUES (14, 12, ?1)'
		)
			.bind(RelationshipType.FriendRequestSent)
			.run()
	})

	it('ranks the viewer among their friends on GetRanks', async () => {
		const res = await post('GetRanks', board({ PlayerId: 14, RankStart: 1, RankEnd: 10 }))
		expect(await res.json()).toEqual({
			Rows: [
				{ PlayerId: 11, Score: 50, Rank: 1 },
				{ PlayerId: 14, Score: 20, Rank: 2 },
				{ PlayerId: 15, Score: 10, Rank: 3 },
			],
		})
	})

	it('gives the friends rank on GetPlayerRank', async () => {
		const res = await post('GetPlayerRank', board({ PlayerId: 14 }))
		expect(await res.json()).toEqual({ PlayerId: 14, Score: 20, Rank: 2 })
		const global = await post('GetPlayerRank', board({ PlayerId: 14, FilterType: 0 }))
		expect(await global.json()).toEqual({ PlayerId: 14, Score: 20, Rank: 4 })
	})

	it('centres GetNearbyScores on the viewer within their friends', async () => {
		const res = await post('GetNearbyScores', board({ PlayerId: 14, WindowSize: 10 }))
		expect(await res.json()).toEqual({
			Rows: [
				{ PlayerId: 11, Score: 50, Rank: 1 },
				{ PlayerId: 14, Score: 20, Rank: 2 },
				{ PlayerId: 15, Score: 10, Rank: 3 },
			],
		})
	})

	it('shows a player with no friends only themself', async () => {
		const res = await post('GetRanks', board({ PlayerId: 13, RankStart: 1, RankEnd: 10 }))
		expect(await res.json()).toEqual({ Rows: [{ PlayerId: 13, Score: 30, Rank: 1 }] })
	})
})

describe('the nearby window', () => {
	// Room 300: players 21..45 score 25..1, so 25 rows with player 33 in the middle (rank 13).
	const ROOM = 300
	beforeAll(async () => {
		for (let p = 21; p <= 45; p++) await setStat(p, ROOM, 46 - p)
	})

	it('caps WindowSize at 10 either side', async () => {
		const res = await post('GetNearbyScores', {
			PlayerId: 33,
			StatChannel: 2,
			RoomId: ROOM,
			FilterType: 0,
			SortAscending: false,
			WindowSize: 100,
		})
		const { Rows } = (await res.json()) as { Rows: { Rank: number }[] }
		expect(Rows).toHaveLength(21)
		expect(Rows[0]?.Rank).toBe(3)
		expect(Rows[20]?.Rank).toBe(23)
	})

	it('defaults WindowSize to 10 when absent', async () => {
		const res = await post('GetNearbyScores', {
			PlayerId: 33,
			StatChannel: 2,
			RoomId: ROOM,
			FilterType: 0,
			SortAscending: false,
		})
		const { Rows } = (await res.json()) as { Rows: unknown[] }
		expect(Rows).toHaveLength(21)
	})
})

it('serves an openapi spec with no dangling refs', async () => {
	const res = await SELF.fetch('https://example.com/openapi.json')
	expect(res.status).toBe(200)
	const spec = (await res.json()) as Record<string, unknown>
	expect(Object.keys(spec.paths as object).sort()).toEqual([
		'/',
		'/leaderboard/CheckAndSetStat',
		'/leaderboard/GetNearbyScores',
		'/leaderboard/GetPlayerRank',
		'/leaderboard/GetRanks',
	])
	expect(JSON.stringify(spec).match(/\$ref/g)).toBeNull()
})
