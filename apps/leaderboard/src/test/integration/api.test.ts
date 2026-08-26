import { adminSecretsStore, env, SELF } from 'cloudflare:test'
import { beforeAll, describe, expect, it } from 'vitest'

import { SCHEMA_DDL } from '../../leaderboard-db'

beforeAll(async () => {
	// Seed the shared JWT signing key into the local Secrets Store so .get() resolves.
	await adminSecretsStore(env.JWT_SECRET).create(TEST_SECRET)
	for (const stmt of SCHEMA_DDL) await env.DB.prepare(stmt).run()
})

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
	CurrentStatValue: number | null = null
) {
	const res = await post(
		'CheckAndSetStat',
		{ StatChannel: 2, RoomId, StatValue, CurrentStatValue },
		await bearer(player)
	)
	expect(res.status).toBe(200)
	// The whole body is the number — not an envelope, not `{ value: 0 }`.
	expect(await res.text()).toBe('0')
}

const wins = (player: number, room: number) =>
	env.DB.prepare('SELECT wins FROM leaderboard WHERE player_id = ?1 AND room_id = ?2')
		.bind(player, room)
		.first<{ wins: number }>()

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

	it('stores the caller’s wins for the room and answers a bare 0', async () => {
		await setStat(42, 14, 3)
		expect(await wins(42, 14)).toEqual({ wins: 3 })
	})

	it('overwrites when the client believes nothing is stored', async () => {
		await setStat(43, 14, 3)
		await setStat(43, 14, 7, null)
		expect(await wins(43, 14)).toEqual({ wins: 7 })
	})

	it('writes only when CurrentStatValue matches what is stored', async () => {
		await setStat(44, 14, 3)
		await setStat(44, 14, 4, 3)
		expect(await wins(44, 14)).toEqual({ wins: 4 })
		// A stale client that still believes 3 is stored doesn't walk the board backwards.
		await setStat(44, 14, 1, 3)
		expect(await wins(44, 14)).toEqual({ wins: 4 })
	})

	it('keeps rooms apart', async () => {
		await setStat(45, 14, 3)
		await setStat(45, 15, 9)
		expect(await wins(45, 14)).toEqual({ wins: 3 })
		expect(await wins(45, 15)).toEqual({ wins: 9 })
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

	it('ranks highest wins first with 1-based ranks', async () => {
		const res = await post('GetRanks', {
			RankStart: 0,
			RankEnd: 9,
			PlayerId: 1,
			StatChannel: 1,
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
			StatChannel: 1,
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
			StatChannel: 1,
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
