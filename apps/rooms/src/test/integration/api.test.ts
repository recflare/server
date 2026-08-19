import { adminSecretsStore, env, SELF } from 'cloudflare:test'
import { beforeAll, describe, expect, it } from 'vitest'

import '../../rooms.app'

import {
	createRoomInstance,
	getRoomInstance,
	PRESENCE_SCHEMA_DDL,
	ROOM_INSTANCE_SCHEMA_DDL,
	ROOM_SCHEMA_DDL,
	seedRoomWithSubRooms,
	SUBROOM_SCHEMA_DDL,
} from '@repo/domain'

import { NotificationType } from '../../../../notify/src/notification-types'
import importRooms from '../../../static/ImportRooms.json'

import type { Env } from '../../context'

declare module 'cloudflare:test' {
	interface ProvidedEnv extends Env {}
}

const ORIGIN = 'https://example.com'

// Mint a token the way the `auth` worker does, signing with the shared test key seeded into the JWT_SECRET store.
const TEST_SECRET = 'test-signing-key'
function b64url(input: ArrayBuffer | string): string {
	const bytes = typeof input === 'string' ? new TextEncoder().encode(input) : new Uint8Array(input)
	let binary = ''
	for (const byte of bytes) binary += String.fromCharCode(byte)
	return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}
// `roles` mints the `role` claim the auth worker stamps from an account's flags; left
// off, the token carries none — what a plain player's looks like to the role gates.
async function bearer(
	sub: string,
	roles?: string[],
	// The client build the token was minted for (`rn.ver`), which is what
	// `/featuredrooms/current` gates on. Omitted by default, like a token from a grant that
	// posted no `ver`.
	version?: string
): Promise<Record<string, string>> {
	const now = Math.floor(Date.now() / 1000)
	const signingInput = `${b64url(JSON.stringify({ alg: 'HS256', typ: 'JWT' }))}.${b64url(
		JSON.stringify({
			sub,
			exp: now + 3600,
			...(roles && { role: roles }),
			...(version && { 'rn.ver': version }),
		})
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

/**
 * Put a player in a room, the way the `match` heartbeat would — the save routes read this
 * to decide whether a non-creator may see the room's history. `expired` writes a row that
 * has already lapsed, which reads back as no presence at all.
 */
async function putInRoom(
	accountId: number,
	roomId: number,
	{ expired = false }: { expired?: boolean } = {}
): Promise<void> {
	const now = Math.floor(Date.now() / 1000)
	await env.DB.prepare('INSERT OR REPLACE INTO presence (data) VALUES (?1)')
		.bind(
			JSON.stringify({
				accountId,
				roomInstance: { roomInstanceId: 1000000 + roomId, roomId, subRoomId: roomId },
				expiresAt: expired ? now - 1 : now + 900,
			})
		)
		.run()
}

/** Take a player back out of whatever room they were in. */
async function clearPresence(accountId: number): Promise<void> {
	await env.DB.prepare('DELETE FROM presence WHERE account_id = ?1').bind(accountId).run()
}

// Apply the schema + seed the imported rooms into the test D1 (mirrors the migrations).
beforeAll(async () => {
	// Seed the shared JWT signing key into the local Secrets Store so .get() resolves.
	await adminSecretsStore(env.JWT_SECRET).create('test-signing-key')
	for (const stmt of ROOM_SCHEMA_DDL) await env.DB.prepare(stmt).run()
	for (const stmt of SUBROOM_SCHEMA_DDL) await env.DB.prepare(stmt).run()
	for (const stmt of ROOM_INSTANCE_SCHEMA_DDL) await env.DB.prepare(stmt).run()
	// Presence table (read by the photon access-token handler).
	for (const stmt of PRESENCE_SCHEMA_DDL) await env.DB.prepare(stmt).run()
	// Seed each room and split its subrooms into the subroom table (mirrors 0007's backfill).
	for (const r of importRooms) await seedRoomWithSubRooms(env.DB, r as Record<string, unknown>)

	// Accounts table (owned by the auth worker) — provisioning a dorm reads the username
	// to name the room. Seed the player `dormroom/me` provisions a fresh dorm for.
	await env.DB.prepare(
		`CREATE TABLE IF NOT EXISTS account (
			data TEXT NOT NULL,
			account_id INTEGER GENERATED ALWAYS AS (json_extract(data, '$.accountId')) VIRTUAL
		)`
	).run()
	await env.DB.prepare('INSERT OR IGNORE INTO account (data) VALUES (?1)')
		.bind(JSON.stringify({ accountId: 999, username: 'Dormer' }))
		.run()

	// Relationship table (owned by the api worker) — `visitedby/:playerId` reads it to
	// check the caller is a friend of the player whose history they're asking for.
	await env.DB.prepare(
		`CREATE TABLE IF NOT EXISTS relationship (
			id INTEGER PRIMARY KEY AUTOINCREMENT,
			requester_id INTEGER NOT NULL,
			target_id INTEGER NOT NULL,
			relationship_type INTEGER NOT NULL DEFAULT 0
		)`
	).run()
	const insertRel = env.DB.prepare(
		'INSERT INTO relationship (requester_id, target_id, relationship_type) VALUES (?1, ?2, ?3)'
	)
	await env.DB.batch([
		insertRel.bind(791, 790, 3), // friends — the caller (791) is the requester
		insertRel.bind(790, 792, 3), // friends — the caller (792) is the target
		insertRel.bind(793, 790, 1), // request out, not accepted — 793 is NOT a friend
	])
})

describe('rooms endpoints', () => {
	it('GET / reports service status', async () => {
		const res = await SELF.fetch(`${ORIGIN}/`)
		expect(res.status).toBe(200)
		expect(await res.json()).toEqual({ service: 'rooms', status: 'ok' })
	})

	it('GET /rooms/1 returns the seeded dorm with its SubRoom scene', async () => {
		const res = await SELF.fetch(`${ORIGIN}/rooms/1?include=1325`)
		expect(res.status).toBe(200)
		const body = (await res.json()) as {
			RoomId: number
			Name: string
			IsDorm: boolean
			SubRooms: Array<{ UnitySceneId: string }>
		}
		expect(body).toMatchObject({ RoomId: 1, Name: 'DormRoom', IsDorm: true })
		expect(body.SubRooms[0].UnitySceneId).toBe('76d98498-60a1-430c-ab76-b54a29b7a163')
	})

	// Neither is stored — the seed blobs predate both keys — so they are defaulted on read.
	// The client's room DTO always carries them, and an ABSENT key is not the same as a
	// zero/null one to its parser.
	it('GET /rooms/:id carries BoostCount and CurrentSnapshotId', async () => {
		const res = await SELF.fetch(`${ORIGIN}/rooms/1`)
		expect(res.status).toBe(200)
		const body = (await res.json()) as Record<string, unknown>
		expect(body).toHaveProperty('BoostCount', 0)
		expect(body).toHaveProperty('CurrentSnapshotId', null)
	})

	// Pinned whole: these are the numbers the client's publish UI counts against, and
	// `error: null` / `error_id` is a different envelope from the room mutations' — a
	// "cleanup" that unified the two would break the client silently.
	it('GET /publishState/configs returns the republish limits', async () => {
		const res = await SELF.fetch(`${ORIGIN}/publishState/configs`)
		expect(res.status).toBe(200)
		expect(await res.json()).toEqual({
			value: {
				UpdateMaxCount: 3,
				UpdateRollingWindowInDays: 365,
				UpdateExpirationInDays: 30,
				UpdateCooldownInDays: 45,
			},
			success: true,
			error_id: null,
			error: null,
		})
	})

	// Stub. Registered (not 404) matters more than the body: the client asks for this on
	// room entry, and an unregistered path stalls the load rather than erroring visibly.
	it('GET /rooms/:id/experience/player returns [] for any room', async () => {
		const res = await SELF.fetch(`${ORIGIN}/rooms/92/experience/player`)
		expect(res.status).toBe(200)
		expect(await res.json()).toEqual([])
	})

	it('GET /rooms/:id 404s for a room not in D1', async () => {
		const res = await SELF.fetch(`${ORIGIN}/rooms/99999`)
		expect(res.status).toBe(404)
	})

	it('GET /rooms?name= resolves a real room case-insensitively', async () => {
		const res = await SELF.fetch(`${ORIGIN}/rooms?name=reccenter`)
		expect(res.status).toBe(200)
		expect(await res.json()).toMatchObject({ Name: 'RecCenter' })
	})

	it('GET /rooms?name= returns {} when nothing matches', async () => {
		const res = await SELF.fetch(`${ORIGIN}/rooms?name=NoSuchRoomHere`)
		expect(await res.json()).toEqual({})
	})

	it('GET /rooms with no id or name returns 400', async () => {
		const res = await SELF.fetch(`${ORIGIN}/rooms`)
		expect(res.status).toBe(400)
	})

	it('GET /rooms/bulk?id= returns the matching rooms', async () => {
		const res = await SELF.fetch(`${ORIGIN}/rooms/bulk?id=1,2`)
		expect(res.status).toBe(200)
		const body = (await res.json()) as Array<{ RoomId: number; Name: string }>
		expect(body.map((r) => r.Name).sort()).toEqual(['DormRoom', 'RecCenter'])
	})

	it('GET /rooms/bulk?name=RecCenter returns [RecCenter]', async () => {
		const res = await SELF.fetch(`${ORIGIN}/rooms/bulk?name=RecCenter`)
		const body = (await res.json()) as Array<{ Name: string }>
		expect(body.map((r) => r.Name)).toEqual(['RecCenter'])
	})

	it('POST /rooms/bulk takes repeated id fields in a form body', async () => {
		const post = async (body: string) =>
			SELF.fetch(`${ORIGIN}/rooms/bulk`, {
				method: 'POST',
				headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
				body,
			})

		// The client's form: one `id` per room, plus the filter. An id that isn't in D1 is
		// simply absent, so the answer can be shorter than the request.
		const res = await post('id=1&id=2&id=999999&excludePrivateRooms=False')
		expect(res.status).toBe(200)
		const body = (await res.json()) as Array<{ RoomId: number; Name: string }>
		expect(body.map((r) => r.Name).sort()).toEqual(['DormRoom', 'RecCenter'])

		// Comma-separated values inside an `id` work too, as they do on the GET.
		const commas = (await (await post('id=1,2')).json()) as Array<{ Name: string }>
		expect(commas.map((r) => r.Name).sort()).toEqual(['DormRoom', 'RecCenter'])

		// `excludePrivateRooms=True` drops the non-public rooms — the dorm here.
		const publicOnly = (await (await post('id=1&id=2&excludePrivateRooms=True')).json()) as Array<{
			Name: string
			Accessibility: number
		}>
		expect(publicOnly.map((r) => r.Name)).toEqual(['RecCenter'])
		expect(publicOnly.every((r) => r.Accessibility === 1)).toBe(true)

		// No ids is an empty array, not a 400 — unlike the GET, which needs an `id` or `name`.
		expect(await (await post('excludePrivateRooms=False')).json()).toEqual([])

		// D1 binds one parameter per id and caps a query at 100, so a longer list is refused
		// rather than split — a caller asking about more than a hundred rooms at once has lost
		// track of what it is rendering.
		const idList = (n: number) => Array.from({ length: n }, (_, i) => 500000 + i)
		expect(
			(
				await post(
					idList(100)
						.map((id) => `id=${id}`)
						.join('&')
				)
			).status
		).toBe(200)
		const overCap = await post(
			idList(101)
				.map((id) => `id=${id}`)
				.join('&')
		)
		expect(overCap.status).toBe(400)
		expect(await overCap.json()).toBe('At most 100 room ids may be looked up at once')

		// The GET form has the same cap, counting the ids inside its comma-separated `id`.
		const overCapGet = await SELF.fetch(`${ORIGIN}/rooms/bulk?id=${idList(101).join(',')}`)
		expect(overCapGet.status).toBe(400)
	})

	it('GET /rooms/ownedby/me is auth-gated and scoped to the caller', async () => {
		// No token → 401, no stub-account fallback (would otherwise leak account 1).
		const noAuth = await SELF.fetch(`${ORIGIN}/rooms/ownedby/me`)
		expect(noAuth.status).toBe(401)
		// Account 1 owns all the seeded rooms, but the dorm is excluded here.
		const mine = (await (
			await SELF.fetch(`${ORIGIN}/rooms/ownedby/me`, { headers: await bearer('1') })
		).json()) as Array<{ RoomId: number; IsDorm?: boolean }>
		expect(mine.length).toBe(importRooms.filter((r) => r.IsDorm !== true).length)
		// The dorm (RoomId 1) is auto-provisioned, so it never appears.
		expect(mine.some((r) => r.RoomId === 1 || r.IsDorm === true)).toBe(false)
		// A different account owns none of them.
		const other = (await (
			await SELF.fetch(`${ORIGIN}/rooms/ownedby/me`, { headers: await bearer('999') })
		).json()) as unknown[]
		expect(other).toEqual([])
	})

	it('GET /dormroom/me serves the caller’s dorm id, not the room', async () => {
		// No token → 401. Without this the endpoint would hand out (and provision) a dorm
		// for whichever account a fallback picked.
		const noAuth = await SELF.fetch(`${ORIGIN}/dormroom/me`)
		expect(noAuth.status).toBe(401)

		// Account 1 owns the seeded dorm (RoomId 1). The body is that id ALONE — a bare
		// JSON number, not the room and not an object wrapping the id.
		const res = await SELF.fetch(`${ORIGIN}/dormroom/me`, { headers: await bearer('1') })
		expect(res.status).toBe(200)
		expect(await res.json()).toBe(1)

		// It is the id of a room that really is the caller's dorm — the caller fetches the
		// room itself from /rooms/{id}.
		const room = (await (await SELF.fetch(`${ORIGIN}/rooms/1`)).json()) as {
			RoomId: number
			IsDorm: boolean
			CreatorAccountId: number
		}
		expect(room).toMatchObject({ RoomId: 1, IsDorm: true, CreatorAccountId: 1 })

		// A player who has never entered their dorm gets one provisioned rather than a
		// 404 — the get-or-create still happens, only the payload shrank. And it belongs
		// to THEM, not the template dorm they were cloned from.
		const fresh = (await (
			await SELF.fetch(`${ORIGIN}/dormroom/me`, { headers: await bearer('999') })
		).json()) as number
		expect(typeof fresh).toBe('number')
		expect(fresh).not.toBe(1)

		const provisioned = (await (await SELF.fetch(`${ORIGIN}/rooms/${fresh}`)).json()) as {
			IsDorm: boolean
			CreatorAccountId: number
		}
		expect(provisioned).toMatchObject({ IsDorm: true, CreatorAccountId: 999 })

		// Idempotent: the second call is the same dorm, not a second one.
		const again = (await (
			await SELF.fetch(`${ORIGIN}/dormroom/me`, { headers: await bearer('999') })
		).json()) as number
		expect(again).toBe(fresh)
	})

	// The website's "My rooms" list is a browser calling this worker from another origin,
	// so a response without CORS headers is one the browser throws away — and the page
	// can't tell that apart from the server being down. Pinned on the preflight too: the
	// SPA sends `Authorization`, which makes even the GET a preflighted request.
	it('answers CORS so the website can read a room list from the browser', async () => {
		const preflight = await SELF.fetch(`${ORIGIN}/rooms/ownedby/me`, {
			method: 'OPTIONS',
			headers: {
				origin: 'https://www.example.com',
				'access-control-request-method': 'GET',
				'access-control-request-headers': 'authorization',
			},
		})
		expect(preflight.status).toBe(204)
		expect(preflight.headers.get('access-control-allow-origin')).toBe('*')
		expect(preflight.headers.get('access-control-allow-headers')?.toLowerCase()).toContain(
			'authorization'
		)

		const res = await SELF.fetch(`${ORIGIN}/rooms/ownedby/me`, {
			headers: { ...(await bearer('1')), origin: 'https://www.example.com' },
		})
		expect(res.status).toBe(200)
		expect(res.headers.get('access-control-allow-origin')).toBe('*')
	})

	it('GET /rooms/ownedby|createdby/me lists the caller’s UNPUBLISHED rooms too', async () => {
		// "My Rooms" is the owner's own list, not a catalog: it must show a room that
		// isn't public yet, or a freshly created room (which starts Private — see
		// cloneRoom) would be invisible to the person who just made it. Only the
		// PUBLIC-facing `ownedby/:accountId` profile list filters on accessibility.
		const headers = {
			...(await bearer('804')),
			'Content-Type': 'application/x-www-form-urlencoded',
		}
		await SELF.fetch(`${ORIGIN}/rooms/24/clone`, {
			method: 'POST',
			headers,
			body: new URLSearchParams({ name: 'MyUnpublishedRoom' }).toString(),
		})

		const listOf = async (path: string) =>
			(await (await SELF.fetch(`${ORIGIN}${path}`, { headers })).json()) as Array<{
				Name: string
				Accessibility: number
			}>

		for (const path of [
			'/rooms/ownedby/me',
			'/rooms/createdby/me',
			'/roomserver/rooms/createdby/me',
		]) {
			const mine = await listOf(path)
			const room = mine.find((r) => r.Name === 'MyUnpublishedRoom')
			expect(room, `${path} must list the caller's unpublished room`).toBeDefined()
			expect(room!.Accessibility).toBe(0)
		}

		// The same room is absent from the account's PUBLIC profile list.
		const publicList = (await (await SELF.fetch(`${ORIGIN}/rooms/ownedby/804`)).json()) as Array<{
			Name: string
		}>
		expect(publicList.some((r) => r.Name === 'MyUnpublishedRoom')).toBe(false)
	})

	it('GET /rooms/contributedby/me lists rooms the caller has a role in, not their own', async () => {
		const seed = (data: Record<string, unknown>) =>
			env.DB.prepare('INSERT INTO room (data) VALUES (?1)').bind(JSON.stringify(data)).run()

		// A room somebody else made, where 820 is a co-owner...
		await seed({
			RoomId: 30401,
			Name: 'ContribCoOwner',
			CreatorAccountId: 821,
			Accessibility: 1,
			SubRooms: [],
			Roles: [
				{ AccountId: 821, Role: 255 },
				{ AccountId: 820, Role: 30 },
			],
		})
		// ...one where they're only a host (every tier counts, not just owner-level)...
		await seed({
			RoomId: 30402,
			Name: 'ContribHost',
			CreatorAccountId: 821,
			// Unpublished: a contributor works on the room before it goes public, so
			// accessibility is not filtered here.
			Accessibility: 0,
			SubRooms: [],
			Roles: [{ AccountId: 820, Role: 10 }],
		})
		// ...one they created themselves, whose Roles name them as Creator...
		await seed({
			RoomId: 30403,
			Name: 'ContribOwn',
			CreatorAccountId: 820,
			Accessibility: 1,
			SubRooms: [],
			Roles: [{ AccountId: 820, Role: 255 }],
		})
		// ...one they have nothing to do with, and one with no Roles key at all (the older
		// seeded rooms have none — json_each must drop them, not error).
		await seed({
			RoomId: 30404,
			Name: 'ContribOther',
			CreatorAccountId: 821,
			Accessibility: 1,
			SubRooms: [],
			Roles: [{ AccountId: 822, Role: 30 }],
		})
		await seed({ RoomId: 30405, Name: 'ContribNoRoles', CreatorAccountId: 821, SubRooms: [] })

		const res = await SELF.fetch(`${ORIGIN}/rooms/contributedby/me`, {
			headers: await bearer('820'),
		})
		expect(res.status).toBe(200)
		const rooms = (await res.json()) as Array<{ RoomId: number; Name: string }>
		// A bare array of the canonical room DTO — no envelope, no paging wrapper.
		expect(Array.isArray(rooms)).toBe(true)
		expect(rooms.map((r) => r.RoomId).sort((a, b) => a - b)).toEqual([30401, 30402])
		// The caller's OWN room is excluded, or this would just repeat createdby/me.
		expect(rooms.some((r) => r.RoomId === 30403)).toBe(false)
		expect(rooms[0]).toMatchObject({ Name: expect.any(String), Accessibility: expect.any(Number) })

		// A player who contributes to nothing gets an empty array, not a 404.
		const none = await SELF.fetch(`${ORIGIN}/rooms/contributedby/me`, {
			headers: await bearer('829'),
		})
		expect(await none.json()).toEqual([])

		// Auth-scoped: `me` is the token, so no token is a 401.
		expect((await SELF.fetch(`${ORIGIN}/rooms/contributedby/me`)).status).toBe(401)

		// The DB is shared across this file, and these are the only player-made public rooms
		// in it — leaving them behind changes what the `new`/`community` room feeds serve.
		await env.DB.prepare('DELETE FROM room WHERE room_id BETWEEN 30401 AND 30405').run()
	})

	it('GET /rooms/:roomId/experience serves the fixed XP settings, no auth', async () => {
		const res = await SELF.fetch(`${ORIGIN}/rooms/2/experience`)
		expect(res.status).toBe(200)
		// A bare two-key object — no `{ success, error, value }` envelope around it. Disabled:
		// no room awards XP here, and DailyLimit is the cap that would apply if one did.
		expect(await res.json()).toEqual({ Enabled: false, DailyLimit: 1000 })

		// Nothing is stored per room, so every room answers the same — including one that
		// doesn't exist, which is never looked up.
		expect(await (await SELF.fetch(`${ORIGIN}/rooms/77/experience`)).json()).toEqual({
			Enabled: false,
			DailyLimit: 1000,
		})
		expect(await (await SELF.fetch(`${ORIGIN}/rooms/99999/experience`)).json()).toEqual({
			Enabled: false,
			DailyLimit: 1000,
		})

		// The id is digits-only, like the other room-scoped routes.
		expect((await SELF.fetch(`${ORIGIN}/rooms/abc/experience`)).status).toBe(404)
	})

	it('GET /rooms/ownedby/:id returns an account public rooms (no auth)', async () => {
		const res = await SELF.fetch(`${ORIGIN}/rooms/ownedby/1`)
		expect(res.status).toBe(200)
		const body = (await res.json()) as Array<{
			RoomId: number
			Accessibility: number
			IsDorm?: boolean
			CreatorAccountId: number
		}>
		expect(body.length).toBeGreaterThan(0)
		// Only public, non-dorm rooms owned by account 1 — the private dorm (RoomId 1)
		// is excluded.
		expect(
			body.every((r) => r.Accessibility === 1 && r.IsDorm !== true && r.CreatorAccountId === 1)
		).toBe(true)
		expect(body.some((r) => r.RoomId === 1)).toBe(false)

		// An account that owns no public rooms → empty array.
		expect(await (await SELF.fetch(`${ORIGIN}/rooms/ownedby/999`)).json()).toEqual([])
	})

	it('GET /rooms/search returns a paginated { Results, TotalResults }', async () => {
		// Name-term search resolves a known public room.
		const res = await SELF.fetch(`${ORIGIN}/rooms/search?query=reccenter&skip=0&take=100`)
		expect(res.status).toBe(200)
		const body = (await res.json()) as { Results: Array<{ Name: string }>; TotalResults: number }
		expect(body.TotalResults).toBeGreaterThanOrEqual(1)
		expect(body.Results.some((r) => r.Name === 'RecCenter')).toBe(true)
	})

	it('GET /rooms/autocomplete_search suggests names and tags as plain strings', async () => {
		const suggest = async (query: string, extra = '') =>
			(await (
				await SELF.fetch(
					`${ORIGIN}/rooms/autocomplete_search?query=${encodeURIComponent(query)}${extra}`
				)
			).json()) as string[]

		// A bare array of STRINGS — not rooms, not an envelope.
		const rec = await suggest('rec', '&take=4&searchSessionId=abc-123')
		expect(Array.isArray(rec)).toBe(true)
		for (const s of rec) expect(typeof s).toBe('string')
		expect(rec).toContain('RecCenter')
		expect(rec.length).toBeLessThanOrEqual(4)

		// Every suggestion finds something when submitted — the point of the endpoint.
		for (const term of rec) {
			const found = (await (
				await SELF.fetch(`${ORIGIN}/rooms/search?query=${encodeURIComponent(term)}`)
			).json()) as { TotalResults: number }
			expect(found.TotalResults, `"${term}" must find rooms`).toBeGreaterThan(0)
		}

		// Tags are suggested with their `#`, and a `#` query suggests tags only.
		const tags = await suggest('#rro')
		expect(tags).toEqual(['#rro'])
		expect(tags.every((t) => t.startsWith('#'))).toBe(true)

		// `take` caps the list; an empty query suggests nothing rather than everything.
		expect((await suggest('e', '&take=2')).length).toBeLessThanOrEqual(2)
		expect(await suggest('')).toEqual([])
		expect(await suggest('zzzznothingmatchesthis')).toEqual([])

		// Deterministic: the same query suggests the same things in the same order.
		expect(await suggest('rec')).toEqual(rec)

		// Dorms are excluded, exactly as they are from search.
		expect(await suggest('dormroom')).toEqual([])
	})

	it('GET /rooms/search excludes dorms and respects pagination shape', async () => {
		const res = await SELF.fetch(`${ORIGIN}/rooms/search?query=dormroom`)
		expect(res.status).toBe(200)
		const body = (await res.json()) as { Results: unknown[]; TotalResults: number }
		// The dorm is non-public/dorm, so a name search for it returns nothing.
		expect(body).toEqual({ Results: [], TotalResults: 0 })
	})

	it('GET /rooms/search?query=#tag returns 200 (tag search)', async () => {
		const res = await SELF.fetch(`${ORIGIN}/rooms/search?query=%23Quest+%23recroomoriginal`)
		expect(res.status).toBe(200)
		const body = (await res.json()) as { Results: unknown[]; TotalResults: number }
		expect(Array.isArray(body.Results)).toBe(true)
		expect(typeof body.TotalResults).toBe('number')
	})

	it('GET /rooms/search aliases #recroomoriginal to the rro tag', async () => {
		// Rooms are tagged `rro`, not `recroomoriginal` — the alias bridges them.
		const aliased = (await (
			await SELF.fetch(`${ORIGIN}/rooms/search?query=%23recroomoriginal`)
		).json()) as { TotalResults: number }
		const direct = (await (await SELF.fetch(`${ORIGIN}/rooms/search?query=%23rro`)).json()) as {
			TotalResults: number
		}
		expect(aliased.TotalResults).toBe(direct.TotalResults)
		expect(aliased.TotalResults).toBeGreaterThan(0)
	})

	it('GET /rooms/favoritedby/me returns a bare array of the caller favorited rooms (auth-scoped)', async () => {
		const headers = await bearer('777')

		// Auth-gated — no token is a 401, never account 1's favorites.
		expect((await SELF.fetch(`${ORIGIN}/rooms/favoritedby/me`)).status).toBe(401)

		// No favorites yet → empty array.
		const empty = (await (
			await SELF.fetch(`${ORIGIN}/rooms/favoritedby/me`, { headers })
		).json()) as unknown[]
		expect(empty).toEqual([])

		// Favorite two real rooms, then they come back.
		for (const id of [2, 12]) {
			await SELF.fetch(`${ORIGIN}/rooms/${id}/interactionby/me/favorite`, {
				method: 'PUT',
				headers,
			})
		}
		const body = (await (
			await SELF.fetch(`${ORIGIN}/rooms/favoritedby/me?skip=0&take=100`, { headers })
		).json()) as Array<{ RoomId: number }>
		expect(body.map((r) => r.RoomId).sort((a, b) => a - b)).toEqual([2, 12])

		// Un-favoriting one drops it from the list.
		await SELF.fetch(`${ORIGIN}/rooms/2/interactionby/me/favorite`, { method: 'PUT', headers })
		const afterUnfav = (await (
			await SELF.fetch(`${ORIGIN}/rooms/favoritedby/me`, { headers })
		).json()) as Array<{ RoomId: number }>
		expect(afterUnfav.map((r) => r.RoomId)).toEqual([12])

		// Scoped per player — a different account sees none.
		const other = (await (
			await SELF.fetch(`${ORIGIN}/rooms/favoritedby/me`, { headers: await bearer('778') })
		).json()) as unknown[]
		expect(other).toEqual([])
	})

	it('GET /rooms/visitedby/me returns a bare array of rooms the caller has interacted with (auth-scoped)', async () => {
		const headers = await bearer('779')

		// No interactions yet → empty array.
		const empty = (await (
			await SELF.fetch(`${ORIGIN}/rooms/visitedby/me`, { headers })
		).json()) as unknown[]
		expect(empty).toEqual([])

		// Interacting (cheer/favorite) records a last-visit on those rooms.
		await SELF.fetch(`${ORIGIN}/rooms/2/interactionby/me/cheer`, { method: 'PUT', headers })
		await SELF.fetch(`${ORIGIN}/rooms/12/interactionby/me/favorite`, { method: 'PUT', headers })

		const body = (await (
			await SELF.fetch(`${ORIGIN}/rooms/visitedby/me?skip=0&take=100`, { headers })
		).json()) as Array<{ RoomId: number }>
		expect(body.map((r) => r.RoomId).sort((a, b) => a - b)).toEqual([2, 12])

		// Un-cheering still counts as visited (the interaction row persists).
		await SELF.fetch(`${ORIGIN}/rooms/2/interactionby/me/cheer`, { method: 'PUT', headers })
		const afterUncheer = (await (
			await SELF.fetch(`${ORIGIN}/rooms/visitedby/me`, { headers })
		).json()) as unknown[]
		expect(afterUncheer.length).toBe(2)

		// Scoped per player — a different account sees none.
		const other = (await (
			await SELF.fetch(`${ORIGIN}/rooms/visitedby/me`, { headers: await bearer('780') })
		).json()) as unknown[]
		expect(other).toEqual([])
	})

	it('GET /rooms/visitedby/:playerId serves a friend’s visited rooms and 403s everyone else', async () => {
		// Give 790 a visit history (cheering/favoriting stamps a last-visit).
		const subject = await bearer('790')
		await SELF.fetch(`${ORIGIN}/rooms/2/interactionby/me/cheer`, {
			method: 'PUT',
			headers: subject,
		})
		await SELF.fetch(`${ORIGIN}/rooms/12/interactionby/me/favorite`, {
			method: 'PUT',
			headers: subject,
		})

		// A mutual friend reads it — a bare array, regardless of which side of the
		// relationship row the caller sits on.
		for (const friend of ['791', '792']) {
			const res = await SELF.fetch(`${ORIGIN}/rooms/visitedby/790`, {
				headers: await bearer(friend),
			})
			expect(res.status).toBe(200)
			const body = (await res.json()) as Array<{ RoomId: number }>
			expect(body.map((r) => r.RoomId).sort((a, b) => a - b)).toEqual([2, 12])
		}

		// Paginated via skip/take.
		const page = (await (
			await SELF.fetch(`${ORIGIN}/rooms/visitedby/790?skip=0&take=1`, {
				headers: await bearer('791'),
			})
		).json()) as unknown[]
		expect(page.length).toBe(1)

		// Your own history is readable by id, not just via `me`.
		const own = (await (
			await SELF.fetch(`${ORIGIN}/rooms/visitedby/790`, { headers: subject })
		).json()) as unknown[]
		expect(own.length).toBe(2)

		// A pending request is not a friendship, and a stranger is not either → 403.
		for (const outsider of ['793', '794']) {
			const res = await SELF.fetch(`${ORIGIN}/rooms/visitedby/790`, {
				headers: await bearer(outsider),
			})
			expect(res.status).toBe(403)
		}

		// No token at all → 401, never a fallback account.
		const anon = await SELF.fetch(`${ORIGIN}/rooms/visitedby/790`)
		expect(anon.status).toBe(401)

		// `visitedby/me` still routes to the literal handler, not the id pattern.
		const me = (await (
			await SELF.fetch(`${ORIGIN}/rooms/visitedby/me`, { headers: subject })
		).json()) as unknown[]
		expect(me.length).toBe(2)
	})

	it('GET /rooms/hot returns a paginated { Results, TotalResults } of public rooms', async () => {
		const res = await SELF.fetch(`${ORIGIN}/rooms/hot?skip=0&take=100`)
		expect(res.status).toBe(200)
		const body = (await res.json()) as {
			Results: Array<{ RoomId: number; IsDorm?: boolean }>
			TotalResults: number
		}
		expect(body.Results.length).toBeGreaterThan(0)
		expect(body.TotalResults).toBeGreaterThanOrEqual(body.Results.length)
		// The dorm (RoomId 1) is non-public, so it's never in the feed.
		expect(body.Results.some((r) => r.RoomId === 1 || r.IsDorm === true)).toBe(false)
	})

	it('GET /rooms/hot?tag=rro filters to rro-tagged rooms', async () => {
		const res = await SELF.fetch(`${ORIGIN}/rooms/hot?tag=rro&skip=0&take=100`)
		expect(res.status).toBe(200)
		const body = (await res.json()) as {
			Results: Array<{ Name: string; Tags?: Array<{ Tag: string }> }>
			TotalResults: number
		}
		expect(body.Results.length).toBeGreaterThan(0)
		// Every result carries the rro tag, and a known rro room is present.
		expect(body.Results.every((r) => (r.Tags ?? []).some((t) => t.Tag === 'rro'))).toBe(true)
		expect(body.Results.some((r) => r.Name === 'RecCenter')).toBe(true)
	})

	it('GET /rooms/hot respects take pagination (TotalResults is the full count)', async () => {
		const res = await SELF.fetch(`${ORIGIN}/rooms/hot?tag=rro&skip=0&take=2`)
		const body = (await res.json()) as { Results: unknown[]; TotalResults: number }
		expect(body.Results.length).toBeLessThanOrEqual(2)
		expect(body.TotalResults).toBeGreaterThan(body.Results.length)
	})

	it('GET /rooms/hot ranks rooms by the live presence in their instances', async () => {
		const feed = async (): Promise<number[]> =>
			(
				(await (await SELF.fetch(`${ORIGIN}/rooms/hot?skip=0&take=100`)).json()) as {
					Results: Array<{ RoomId: number }>
				}
			).Results.map((r) => r.RoomId)

		// Two rooms from the tail of the engagement-ordered feed, so any move to the
		// front can only come from presence.
		const before = await feed()
		const busiest = before[before.length - 1]
		const quieter = before[before.length - 2]

		// Two players in two different instances of `busiest`, one in `quieter`, plus a
		// lobby presence (no instance) that must not count for anyone.
		const expiresAt = Math.floor(Date.now() / 1000) + 900
		const seed = env.DB.prepare('INSERT OR REPLACE INTO presence (data) VALUES (?1)')
		await env.DB.batch(
			[
				{ accountId: 90001, roomInstance: { roomInstanceId: 1000901, roomId: busiest } },
				{ accountId: 90002, roomInstance: { roomInstanceId: 1000902, roomId: busiest } },
				{ accountId: 90003, roomInstance: { roomInstanceId: 1000903, roomId: quieter } },
				{ accountId: 90004, roomInstance: null },
			].map((p) => seed.bind(JSON.stringify({ ...p, expiresAt })))
		)

		expect((await feed()).slice(0, 2)).toEqual([busiest, quieter])

		// Expired presence doesn't count — the feed falls back to engagement order.
		await env.DB.prepare(
			`UPDATE presence SET data = json_set(data, '$.expiresAt', ?1)
			 WHERE account_id IN (90001, 90002, 90003, 90004)`
		)
			.bind(Math.floor(Date.now() / 1000) - 1)
			.run()
		expect(await feed()).toEqual(before)

		await env.DB.prepare(
			'DELETE FROM presence WHERE account_id IN (90001, 90002, 90003, 90004)'
		).run()
	})

	it('GET /rooms/hot aliases #recroomoriginal to the rro tag', async () => {
		const aliased = (await (
			await SELF.fetch(`${ORIGIN}/rooms/hot?tag=recroomoriginal`)
		).json()) as { TotalResults: number }
		const direct = (await (await SELF.fetch(`${ORIGIN}/rooms/hot?tag=rro`)).json()) as {
			TotalResults: number
		}
		expect(aliased.TotalResults).toBe(direct.TotalResults)
		expect(aliased.TotalResults).toBeGreaterThan(0)
	})

	it('GET /rooms/hot?tag=new serves player-made rooms newest-first (pseudo-tag)', async () => {
		type Feed = { Results: Array<{ Name: string }>; TotalResults: number }
		const feed = async (): Promise<Feed> =>
			(await (await SELF.fetch(`${ORIGIN}/rooms/hot?tag=new&skip=0&take=100`)).json()) as Feed
		const names = async (): Promise<string[]> => (await feed()).Results.map((r) => r.Name)

		// No room carries a `new` tag, and every seeded room is a Rec Room Original — so
		// the feed is empty until a player makes something.
		expect(await feed()).toEqual({ Results: [], TotalResults: 0 })

		const seeded: number[] = []
		const seed = async (room: Record<string, unknown>) => {
			seeded.push(Number(room.RoomId))
			await seedRoomWithSubRooms(env.DB, { Accessibility: 1, IsDorm: false, IsRRO: false, ...room })
		}

		// Two player-made public rooms and one that isn't public.
		await seed({ RoomId: 9001, Name: 'OlderPlayerRoom', CreatedAt: '2026-07-01T00:00:00Z' })
		await seed({ RoomId: 9002, Name: 'NewerPlayerRoom', CreatedAt: '2026-07-02T00:00:00Z' })
		await seed({
			RoomId: 9003,
			Name: 'UnlistedPlayerRoom',
			CreatedAt: '2026-07-03T00:00:00Z',
			Accessibility: 2,
		})

		// Newest first, and the non-public room is excluded as it is everywhere else.
		expect(await feed()).toMatchObject({
			Results: [{ Name: 'NewerPlayerRoom' }, { Name: 'OlderPlayerRoom' }],
			TotalResults: 2,
		})

		// An RRO stays out even when it's the newest room in the database — by the flag,
		// or by the auto-derived `rro` tag alone.
		await seed({
			RoomId: 9004,
			Name: 'BrandNewRRO',
			CreatedAt: '2026-07-04T00:00:00Z',
			IsRRO: true,
		})
		await seed({
			RoomId: 9005,
			Name: 'TaggedRRO',
			CreatedAt: '2026-07-05T00:00:00Z',
			Tags: [{ Tag: 'rro', Type: 2 }],
		})
		expect(await names()).toEqual(['NewerPlayerRoom', 'OlderPlayerRoom'])

		// Paging comes off the same order.
		const page = (await (
			await SELF.fetch(`${ORIGIN}/rooms/hot?tag=new&skip=1&take=1`)
		).json()) as Feed
		expect(page).toMatchObject({ Results: [{ Name: 'OlderPlayerRoom' }], TotalResults: 2 })

		// Leave the shared feeds as they were for the tests that follow.
		const ids = seeded.join(',')
		await env.DB.prepare(`DELETE FROM room WHERE room_id IN (${ids})`).run()
		await env.DB.prepare(`DELETE FROM subroom WHERE room_id IN (${ids})`).run()
	})

	it('GET /rooms/hot?tag=community serves rooms the Coach account did not create', async () => {
		type Feed = { Results: Array<{ Name: string }>; TotalResults: number }
		const feed = async (): Promise<Feed> =>
			(await (await SELF.fetch(`${ORIGIN}/rooms/hot?tag=community&skip=0&take=100`)).json()) as Feed
		const names = async (): Promise<string[]> => (await feed()).Results.map((r) => r.Name)

		// No room carries a `community` tag, and every seeded room belongs to Coach
		// (account 1) — so the feed is empty until another account makes something.
		expect(await feed()).toEqual({ Results: [], TotalResults: 0 })

		const seeded: number[] = []
		const seed = async (room: Record<string, unknown>) => {
			seeded.push(Number(room.RoomId))
			await seedRoomWithSubRooms(env.DB, {
				Accessibility: 1,
				IsDorm: false,
				CreatorAccountId: 2,
				...room,
			})
		}

		await seed({ RoomId: 9101, Name: 'CommunityOne' })
		await seed({ RoomId: 9102, Name: 'CommunityTwo' })
		// Coach's own rooms stay out, and so do non-public rooms as everywhere else.
		await seed({ RoomId: 9103, Name: 'CoachRoom', CreatorAccountId: 1 })
		await seed({ RoomId: 9104, Name: 'UnlistedCommunityRoom', Accessibility: 2 })

		// Nobody is in any of them and their stats are all zero, so the feed's normal
		// ordering falls through to RoomId.
		expect(await names()).toEqual(['CommunityOne', 'CommunityTwo'])

		// Creator, not RRO-ness, is what `community` filters on — unlike `new`, a
		// player-made room flagged as an RRO still belongs here.
		await seed({ RoomId: 9105, Name: 'PlayerMadeRRO', IsRRO: true })
		expect(await names()).toEqual(['CommunityOne', 'CommunityTwo', 'PlayerMadeRRO'])

		// Paging comes off the same order.
		const page = (await (
			await SELF.fetch(`${ORIGIN}/rooms/hot?tag=community&skip=1&take=1`)
		).json()) as Feed
		expect(page).toMatchObject({ Results: [{ Name: 'CommunityTwo' }], TotalResults: 3 })

		// Leave the shared feeds as they were for the tests that follow.
		const ids = seeded.join(',')
		await env.DB.prepare(`DELETE FROM room WHERE room_id IN (${ids})`).run()
		await env.DB.prepare(`DELETE FROM subroom WHERE room_id IN (${ids})`).run()
	})

	it('GET /rooms/base returns a bare array of base/template rooms (incl. non-public)', async () => {
		const res = await SELF.fetch(`${ORIGIN}/rooms/base`)
		expect(res.status).toBe(200)
		const body = (await res.json()) as Array<{
			RoomId: number
			Accessibility: number
			Tags?: Array<{ Tag: string }>
		}>
		expect(Array.isArray(body)).toBe(true)
		expect(body.length).toBeGreaterThan(0)
		// Every result carries the `base` tag.
		expect(body.every((r) => (r.Tags ?? []).some((t) => t.Tag === 'base'))).toBe(true)
		// Includes rooms that aren't publicly listed (Accessibility != 1) — base
		// rooms bypass the public filter the feeds use.
		expect(body.some((r) => r.Accessibility !== 1)).toBe(true)
	})

	it('GET /rooms/base respects take pagination', async () => {
		const res = await SELF.fetch(`${ORIGIN}/rooms/base?skip=0&take=5`)
		const body = (await res.json()) as unknown[]
		expect(body.length).toBeLessThanOrEqual(5)
	})

	it('GET /rooms/recommendations returns a bare array of public rooms (split-test params ignored)', async () => {
		const res = await SELF.fetch(`${ORIGIN}/rooms/recommendations?splitTestId=1&splitTestValue=5`)
		expect(res.status).toBe(200)
		const body = (await res.json()) as Array<{ RoomId: number; IsDorm?: boolean }>
		expect(Array.isArray(body)).toBe(true)
		expect(body.length).toBeGreaterThan(0)
		// The dorm (RoomId 1) is non-public, so it's never recommended.
		expect(body.some((r) => r.RoomId === 1 || r.IsDorm === true)).toBe(false)

		// The split-test params don't change the result.
		const plain = (await (await SELF.fetch(`${ORIGIN}/rooms/recommendations`)).json()) as Array<{
			RoomId: number
		}>
		expect(plain.map((r) => r.RoomId)).toEqual(body.map((r) => r.RoomId))
	})

	it('GET /rooms/recommendations respects take pagination', async () => {
		const res = await SELF.fetch(`${ORIGIN}/rooms/recommendations?skip=0&take=3`)
		const body = (await res.json()) as unknown[]
		expect(body.length).toBeLessThanOrEqual(3)
	})

	// Served only to the client builds that render it — the 2023 client's other room
	// listings start failing with NREs when it gets this payload, which is why the route
	// was parked entirely for a while (see FEATURED_ROOMS_VERSIONS in rooms.app.ts).
	it('GET /featuredrooms/current serves the group to a supported client build', async () => {
		const res = await SELF.fetch(`${ORIGIN}/featuredrooms/current`, {
			headers: await bearer('1', undefined, '20250718.01'),
		})
		expect(res.status).toBe(200)
		const body = (await res.json()) as {
			FeaturedRoomGroupId: number
			name: string
			StartAt: string
			EndAt: string
			Rooms: Array<{ RoomId: number; RoomName: string; ImageName: string }>
		}
		expect(body.FeaturedRoomGroupId).toBe(1)
		expect(body.name).toBe('Featured Rooms')
		expect(body.Rooms.length).toBeGreaterThan(0)
		// Compact projection carries name + image, not the full room blob.
		expect(body.Rooms.every((r) => typeof r.RoomName === 'string')).toBe(true)
		// The dorm (RoomId 1) is non-public, so it's never featured.
		expect(body.Rooms.some((r) => r.RoomId === 1)).toBe(false)
	})

	it('GET /featuredrooms/current withholds the group from other client builds', async () => {
		// The 2023 build gets the 404 it got while the route was parked — the state in which
		// its room listings work. Same for a token with no `rn.ver` at all.
		for (const version of ['20230414', '20231207', undefined]) {
			const res = await SELF.fetch(`${ORIGIN}/featuredrooms/current`, {
				headers: await bearer('1', undefined, version),
			})
			expect(res.status, `build ${version}`).toBe(404)
		}

		// And no token at all is a 401, not a 404: the build is read off the token.
		expect((await SELF.fetch(`${ORIGIN}/featuredrooms/current`)).status).toBe(401)
	})

	it('GET /rooms/:id/similar returns { Results, TotalResults } of tag-sharing rooms (excluding self)', async () => {
		const res = await SELF.fetch(`${ORIGIN}/rooms/2/similar`)
		expect(res.status).toBe(200)
		const body = (await res.json()) as {
			Results: Array<{ RoomId: number; Tags?: Array<{ Tag: string }> }>
			TotalResults: number
		}
		expect(body.Results.length).toBeGreaterThan(0)
		expect(body.TotalResults).toBeGreaterThanOrEqual(body.Results.length)
		// Never includes the target room itself.
		expect(body.Results.some((r) => r.RoomId === 2)).toBe(false)
		// Every result shares the `rro` tag RecCenter (room 2) carries.
		expect(body.Results.every((r) => (r.Tags ?? []).some((t) => t.Tag === 'rro'))).toBe(true)
	})

	it('GET /rooms/:id/similar respects take pagination', async () => {
		const res = await SELF.fetch(`${ORIGIN}/rooms/2/similar?skip=0&take=3`)
		const body = (await res.json()) as { Results: unknown[]; TotalResults: number }
		expect(body.Results.length).toBeLessThanOrEqual(3)
		expect(body.TotalResults).toBeGreaterThan(body.Results.length)
	})

	it('GET /rooms/:id/similar returns an empty result for a room not in D1', async () => {
		const res = await SELF.fetch(`${ORIGIN}/rooms/99999/similar`)
		expect(res.status).toBe(200)
		expect(await res.json()).toEqual({ Results: [], TotalResults: 0 })
	})

	it('POST /rooms/:id/clone clones a base room into a new owned room', async () => {
		const headers = {
			...(await bearer('801')),
			'Content-Type': 'application/x-www-form-urlencoded',
		}
		const post = async (id: number, name: string) =>
			(await (
				await SELF.fetch(`${ORIGIN}/rooms/${id}/clone`, {
					method: 'POST',
					headers,
					body: new URLSearchParams({ name }).toString(),
				})
			).json()) as {
				success: boolean
				error: string
				value: {
					RoomId: number
					Name: string
					CreatorAccountId: number
					Tags?: Array<{ Tag: string }>
					IsRRO: boolean
					Accessibility: number
					Roles: Array<{ AccountId: number; Role: number; InvitedRole: number }>
				} | null
			}

		// Clone MakerRoom (base, RoomId 24) → a fresh room owned by the caller (801).
		const ok = await post(24, 'MyMakerClone')
		expect(ok.success).toBe(true)
		expect(ok.error).toBe('')
		expect(ok.value).not.toBeNull()
		expect(ok.value!.Name).toBe('MyMakerClone')
		expect(ok.value!.CreatorAccountId).toBe(801)
		expect(ok.value!.RoomId).toBeGreaterThan(51)
		// The clone starts fresh with no tags — none of the source's tags (including
		// the `base` template tag) carry over.
		expect(ok.value!.Tags).toEqual([])
		// IsRRO is cleared so the client doesn't render a virtual "RRO" tag on the clone.
		expect(ok.value!.IsRRO).toBe(false)
		// A new room is unpublished: Private (0), never the source's visibility.
		expect(ok.value!.Accessibility).toBe(0)
		// Ownership is reset to the cloner: sole owner (Role 255), and none of the
		// source base room's roles (accounts 1/2) carry over.
		expect(ok.value!.Roles).toEqual([
			{ AccountId: 801, Role: 255, LastChangedByAccountId: null, InvitedRole: 0 },
		])

		// It persists and is fetchable by its new id.
		const fetched = (await (await SELF.fetch(`${ORIGIN}/rooms/${ok.value!.RoomId}`)).json()) as {
			Name: string
		}
		expect(fetched.Name).toBe('MyMakerClone')

		// Duplicate name is rejected.
		const dup = await post(24, 'MyMakerClone')
		expect(dup).toMatchObject({ success: false, value: null })
		expect(dup.error).toMatch(/already exists/i)
	})

	it('POST /rooms/:id/clone of a PUBLIC source stays out of the public feeds', async () => {
		// Park (RoomId 25) is the one seeded base room that is itself public
		// (Accessibility 1). Cloning used to inherit that, so a room appeared in
		// hot/search/recommendations the instant it was created — before its owner had
		// published anything.
		const res = await SELF.fetch(`${ORIGIN}/rooms/25/clone`, {
			method: 'POST',
			headers: {
				...(await bearer('802')),
				'Content-Type': 'application/x-www-form-urlencoded',
			},
			body: new URLSearchParams({ name: 'ParkCloneUnpublished' }).toString(),
		})
		const { value } = (await res.json()) as { value: { RoomId: number; Accessibility: number } }
		expect(value.Accessibility).toBe(0)

		const namesIn = async (path: string) => {
			const body = (await (await SELF.fetch(`${ORIGIN}${path}`)).json()) as
				{ Results: Array<{ Name: string }> } | Array<{ Name: string }>
			return (Array.isArray(body) ? body : body.Results).map((r) => r.Name)
		}
		expect(await namesIn('/rooms/hot?take=200')).not.toContain('ParkCloneUnpublished')
		expect(await namesIn('/rooms/hot?tag=new&take=200')).not.toContain('ParkCloneUnpublished')
		expect(await namesIn('/rooms/recommendations?take=200')).not.toContain('ParkCloneUnpublished')
		expect(await namesIn('/rooms/search?query=parkcloneunpublished')).not.toContain(
			'ParkCloneUnpublished'
		)

		// Publishing it (owner sets Accessibility to Public) puts it in the feed.
		await putForm('/rooms/' + value.RoomId + '/accessibility', { accessibility: '1' }, '802')
		expect(await namesIn('/rooms/hot?take=200')).toContain('ParkCloneUnpublished')
	})

	it('POST /rooms/:id/clone requires auth (401, no account-1 fallback)', async () => {
		// No Authorization header → hard 401, and nothing is created.
		const res = await SELF.fetch(`${ORIGIN}/rooms/24/clone`, {
			method: 'POST',
			headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
			body: new URLSearchParams({ name: 'UnauthedClone' }).toString(),
		})
		expect(res.status).toBe(401)
		expect(await res.json()).toMatchObject({ success: false, value: null })

		// An invalid/garbage token is also rejected.
		const bad = await SELF.fetch(`${ORIGIN}/rooms/24/clone`, {
			method: 'POST',
			headers: {
				Authorization: 'Bearer not.a.jwt',
				'Content-Type': 'application/x-www-form-urlencoded',
			},
			body: new URLSearchParams({ name: 'UnauthedClone' }).toString(),
		})
		expect(bad.status).toBe(401)

		// The room was never created.
		const lookup = await SELF.fetch(`${ORIGIN}/rooms?name=UnauthedClone`)
		expect(await lookup.json()).toEqual({})
	})

	it('POST /rooms/:id/clone validates name and cloneability', async () => {
		const headers = {
			...(await bearer('802')),
			'Content-Type': 'application/x-www-form-urlencoded',
		}
		const post = async (id: number, body?: string) =>
			(await (
				await SELF.fetch(`${ORIGIN}/rooms/${id}/clone`, { method: 'POST', headers, body })
			).json()) as { success: boolean; error: string; value: unknown }

		// Missing name.
		const noName = await post(24, new URLSearchParams({ name: '' }).toString())
		expect(noName).toMatchObject({ success: false, value: null })
		expect(noName.error).toMatch(/must enter a name/i)

		// The dorm (RoomId 1) disallows cloning.
		const notCloneable = await post(1, new URLSearchParams({ name: 'CannotCloneDorm' }).toString())
		expect(notCloneable).toMatchObject({ success: false, value: null })
		expect(notCloneable.error).toMatch(/can't clone/i)

		// A source room not in D1.
		const missing = await post(99999, new URLSearchParams({ name: 'CloneOfNothing' }).toString())
		expect(missing).toMatchObject({ success: false, value: null })
	})

	it('POST /rooms/:id/clone enforces the per-account room cap', async () => {
		const headers = {
			...(await bearer('803')),
			'Content-Type': 'application/x-www-form-urlencoded',
		}
		const clone = async (name: string) =>
			(await (
				await SELF.fetch(`${ORIGIN}/rooms/24/clone`, {
					method: 'POST',
					headers,
					body: new URLSearchParams({ name }).toString(),
				})
			).json()) as { success: boolean; error: string; value: unknown }

		// The cap an operator actually runs is the `MAX_ROOMS_PER_ACCOUNT` var; the
		// constant in the worker is only the fallback.
		const original = env.MAX_ROOMS_PER_ACCOUNT
		try {
			env.MAX_ROOMS_PER_ACCOUNT = 2
			expect(await clone('CapOne')).toMatchObject({ success: true })
			expect(await clone('CapTwo')).toMatchObject({ success: true })

			const rejected = await clone('CapThree')
			expect(rejected).toMatchObject({ success: false, value: null })
			expect(rejected.error).toMatch(/only have 2 rooms/i)

			// A dorm doesn't count against the cap — it's auto-provisioned, not made.
			await env.DB.prepare('INSERT INTO room (data) VALUES (?1)')
				.bind(
					JSON.stringify({
						RoomId: 30303,
						Name: '^Dorm803',
						CreatorAccountId: 803,
						IsDorm: true,
						SubRooms: [],
						Roles: [],
					})
				)
				.run()
			env.MAX_ROOMS_PER_ACCOUNT = 3
			expect(await clone('CapThreeForReal')).toMatchObject({ success: true })

			// 0 lifts the cap entirely.
			env.MAX_ROOMS_PER_ACCOUNT = 0
			expect(await clone('Uncapped')).toMatchObject({ success: true })
		} finally {
			env.MAX_ROOMS_PER_ACCOUNT = original
		}
	})

	const postForm = async (
		path: string,
		fields: Record<string, string>,
		sub?: string,
		roles?: string[]
	) =>
		SELF.fetch(`${ORIGIN}${path}`, {
			method: 'POST',
			headers: {
				...(sub ? await bearer(sub, roles) : {}),
				'Content-Type': 'application/x-www-form-urlencoded',
			},
			body: new URLSearchParams(fields).toString(),
		})

	const putForm = async (path: string, fields: Record<string, string>, sub?: string) =>
		SELF.fetch(`${ORIGIN}${path}`, {
			method: 'PUT',
			headers: {
				...(sub ? await bearer(sub) : {}),
				'Content-Type': 'application/x-www-form-urlencoded',
			},
			body: new URLSearchParams(fields).toString(),
		})

	// Room-mutation envelope helper (PascalCase `{ Success, Value, ErrorId, Error }` —
	// used by name/image/description).
	type RoomResult = {
		Success: boolean
		Value: unknown
		ErrorId: string | null
		Error: string | null
	}
	const bodyOf = async (res: Response) => (await res.json()) as RoomResult

	// Lowercase `{ success, error, value }` envelope — used by tags/clone and the
	// roles/warning/cloning/restrictions room-settings mutations (value = updated room).
	type RoomEnv = { success: boolean; error: string; value: Record<string, unknown> | null }
	const envOf = async (res: Response) => (await res.json()) as RoomEnv

	// A subroom as the client sees it. There is no GET for a single subroom — the client
	// reads them off the room — so tests do the same.
	const subRoomOf = async (
		roomId: number,
		subRoomId: number
	): Promise<Record<string, unknown> | undefined> => {
		const res = await SELF.fetch(`${ORIGIN}/rooms/${roomId}`)
		if (res.status !== 200) return undefined
		const room = (await res.json()) as { SubRooms?: Array<Record<string, unknown>> }
		return (room.SubRooms ?? []).find((s) => s.SubRoomId === subRoomId)
	}

	it('PUT /rooms/:id/description is auth-gated, owner-only, and persists', async () => {
		// No token → 401 (auth gate).
		expect((await putForm('/rooms/2/description', { description: 'x' })).status).toBe(401)
		// Not the owner (RecCenter is owned by account 1) → 200 envelope, Success:false.
		expect(
			await bodyOf(await putForm('/rooms/2/description', { description: 'x' }, '999'))
		).toMatchObject({ Success: false, ErrorId: 'Rooms.NotOwner' })
		// Unknown room → Rooms.DoesntExist envelope.
		expect(
			await bodyOf(await putForm('/rooms/99999/description', { description: 'x' }, '1'))
		).toMatchObject({
			Success: false,
			ErrorId: 'Rooms.DoesntExist',
			Error: 'This room does not exist!',
		})

		// Owner updates it, and it persists.
		const ok = await putForm('/rooms/2/description', { description: 'blah blah blah' }, '1')
		expect(ok.status).toBe(200)
		expect(await bodyOf(ok)).toMatchObject({
			Success: true,
			Value: null,
			ErrorId: null,
			Error: null,
		})
		const room = (await (await SELF.fetch(`${ORIGIN}/rooms/2`)).json()) as { Description: string }
		expect(room.Description).toBe('blah blah blah')
	})

	it('PUT /rooms/:id/image is auth-gated, owner-only, and persists', async () => {
		const imageName = '644064b03bd64a8291cde284629e9ca9.jpg'
		// No token → 401 (auth gate).
		expect((await putForm('/rooms/2/image', { imageName })).status).toBe(401)
		// Not the owner (RecCenter is owned by account 1) → 200 envelope, Success:false.
		expect(await bodyOf(await putForm('/rooms/2/image', { imageName }, '999'))).toMatchObject({
			Success: false,
			ErrorId: 'Rooms.NotOwner',
		})
		// Unknown room → Rooms.DoesntExist envelope.
		expect(await bodyOf(await putForm('/rooms/99999/image', { imageName }, '1'))).toMatchObject({
			Success: false,
			ErrorId: 'Rooms.DoesntExist',
		})
		// Empty image → Success:false.
		expect(await bodyOf(await putForm('/rooms/2/image', { imageName: '  ' }, '1'))).toMatchObject({
			Success: false,
			ErrorId: 'Rooms.InvalidImage',
		})

		// Owner sets it, and it persists.
		const ok = await putForm('/rooms/2/image', { imageName }, '1')
		expect(ok.status).toBe(200)
		expect(await bodyOf(ok)).toMatchObject({ Success: true })
		const room = (await (await SELF.fetch(`${ORIGIN}/rooms/2`)).json()) as { ImageName: string }
		expect(room.ImageName).toBe(imageName)
	})

	it('DELETE /rooms/:id is auth-gated, owner-only, and removes the room + its CDN image', async () => {
		// Throwaway room owned by account 1, with its image object in the CDN bucket and
		// a player interaction row.
		const ImageName = 'test/2026-07-17/delete-me.jpg'
		await env.DB.prepare('INSERT INTO room (data) VALUES (?1)')
			.bind(
				JSON.stringify({
					RoomId: 9500,
					Name: 'DeleteMe',
					CreatorAccountId: 1,
					IsDorm: false,
					Accessibility: 1,
					ImageName,
					SubRooms: [],
				})
			)
			.run()
		await env.CDN_ASSETS.put(`room/${ImageName}`, new Uint8Array([1, 2, 3]))
		await env.DB.prepare(
			'INSERT INTO interaction (player_id, room_id, cheered, favorited) VALUES (7, 9500, 1, 1)'
		).run()

		const del = async (sub?: string) =>
			SELF.fetch(`${ORIGIN}/rooms/9500`, {
				method: 'DELETE',
				headers: sub ? await bearer(sub) : {},
			})
		const roomExists = async () =>
			(await env.DB.prepare('SELECT 1 FROM room WHERE room_id = 9500').first()) !== null

		// No token → 401. A non-owner → Success:false (room untouched).
		expect((await del()).status).toBe(401)
		expect(await bodyOf(await del('2'))).toMatchObject({
			Success: false,
			ErrorId: 'Rooms.NotOwner',
		})
		expect(await roomExists()).toBe(true)

		// Owner → Success:true; the room, its interactions, and the CDN image are gone.
		expect(await bodyOf(await del('1'))).toMatchObject({ Success: true })
		expect(await roomExists()).toBe(false)
		expect(await env.CDN_ASSETS.get(`room/${ImageName}`)).toBeNull()
		const interactions = await env.DB.prepare(
			'SELECT COUNT(*) AS n FROM interaction WHERE room_id = 9500'
		).first<{ n: number }>()
		expect(interactions!.n).toBe(0)
	})

	it('PUT /rooms/:id/roles/:accountId is auth-gated, owner/co-owner-only, and persists', async () => {
		const rolesOf = async (): Promise<Array<{ AccountId: number; Role: number }>> => {
			const room = (await (await SELF.fetch(`${ORIGIN}/rooms/2`)).json()) as {
				Roles?: Array<{ AccountId: number; Role: number }>
			}
			return room.Roles ?? []
		}

		// No token → 401 (auth gate).
		expect((await putForm('/rooms/2/roles/5', { role: '20' })).status).toBe(401)
		// A valid token but no role on the room (RecCenter is owned by account 1, with
		// account 2 as co-owner) → 403.
		expect((await putForm('/rooms/2/roles/5', { role: '20' }, '999')).status).toBe(403)
		// Unknown room → failure envelope.
		expect(await envOf(await putForm('/rooms/99999/roles/5', { role: '20' }, '1'))).toMatchObject({
			success: false,
			error: 'This room does not exist!',
		})
		// Non-numeric role → failure envelope.
		expect(await envOf(await putForm('/rooms/2/roles/5', { role: 'nope' }, '1'))).toMatchObject({
			success: false,
		})

		// Owner sets account 5's role to 20, adding a new Roles entry that persists. The
		// success envelope carries the updated room as `value`.
		const ok = await putForm('/rooms/2/roles/5', { role: '20' }, '1')
		expect(ok.status).toBe(200)
		const okBody = await envOf(ok)
		expect(okBody).toMatchObject({ success: true, error: '' })
		expect(okBody.value?.Roles as Array<{ AccountId: number; Role: number }>).toContainEqual(
			expect.objectContaining({ AccountId: 5, Role: 20 })
		)
		expect(await rolesOf()).toContainEqual(expect.objectContaining({ AccountId: 5, Role: 20 }))

		// The co-owner (account 2, Role 30) may also change it — updating the existing
		// entry in place rather than adding a duplicate.
		const byCoOwner = await putForm('/rooms/2/roles/5', { role: '10' }, '2')
		expect(byCoOwner.status).toBe(200)
		const roles = await rolesOf()
		expect(roles.filter((r) => r.AccountId === 5)).toHaveLength(1)
		expect(roles).toContainEqual(expect.objectContaining({ AccountId: 5, Role: 10 }))
		// The seeded co-owner (account 2) is left intact.
		expect(roles).toContainEqual(expect.objectContaining({ AccountId: 2, Role: 30 }))
	})

	it('POST /rooms/:id/bans is gated to the room’s owners or staff, and persists', async () => {
		// RecCenter (room 2) is owned by account 1, with account 2 as co-owner.
		const bansOf = async (roomId: number) =>
			(
				await env.DB.prepare(
					'SELECT banned_player_id, ban_mask, banned_by_account_id FROM room_ban WHERE room_id = ?1'
				)
					.bind(roomId)
					.all<{ banned_player_id: number; ban_mask: number; banned_by_account_id: number }>()
			).results

		// No token → 401 (auth gate).
		expect((await postForm('/rooms/2/bans', { banMask: '0', id: '205' })).status).toBe(401)
		// A valid token, no role on the room and no staff role → 403.
		expect((await postForm('/rooms/2/bans', { banMask: '0', id: '205' }, '999')).status).toBe(403)
		// Unknown room → failure envelope.
		expect(
			await envOf(await postForm('/rooms/99999/bans', { banMask: '0', id: '205' }, '1'))
		).toMatchObject({ success: false, error: 'This room does not exist!' })

		// The owner bans player 205 — the real client body.
		const ok = await postForm('/rooms/2/bans', { banMask: '0', id: '205' }, '1')
		expect(ok.status).toBe(200)
		expect(await envOf(ok)).toMatchObject({
			success: true,
			error: '',
			value: { RoomId: 2, BannedPlayerId: 205, BanMask: 0, BannedByAccountId: 1 },
		})
		expect(await bansOf(2)).toEqual([
			{ banned_player_id: 205, ban_mask: 0, banned_by_account_id: 1 },
		])

		// Re-banning rewrites the one row rather than appending a second.
		expect((await postForm('/rooms/2/bans', { banMask: '7', id: '205' }, '2')).status).toBe(200)
		expect(await bansOf(2)).toEqual([
			{ banned_player_id: 205, ban_mask: 7, banned_by_account_id: 2 },
		])

		// A staff token bans in a room they have no role on.
		const byStaff = await postForm('/rooms/2/bans', { id: '206' }, '999', [
			'gameClient',
			'moderator',
		])
		expect(byStaff.status).toBe(200)
		// banMask defaults to 0 when the field is absent.
		expect(await envOf(byStaff)).toMatchObject({ value: { BannedPlayerId: 206, BanMask: 0 } })

		// Refusals: no id, yourself, and an owner of the room (a co-owner must not be
		// able to ban the creator out of their own room).
		expect(await envOf(await postForm('/rooms/2/bans', { id: 'nope' }, '1'))).toMatchObject({
			success: false,
			value: null,
		})
		expect(await envOf(await postForm('/rooms/2/bans', { id: '1' }, '1'))).toMatchObject({
			success: false,
			error: 'You cannot ban yourself!',
		})
		expect(await envOf(await postForm('/rooms/2/bans', { id: '1' }, '2'))).toMatchObject({
			success: false,
			error: 'You cannot ban an owner of this room!',
		})
		// Nothing was written by any of the refusals.
		expect(await bansOf(2)).toHaveLength(2)
	})

	it('GET /Room_server/rooms/:id/bans/:playerId/isBanned answers the real ban state', async () => {
		const isBanned = async (roomId: number, playerId: number, sub = '300') =>
			SELF.fetch(`${ORIGIN}/Room_server/rooms/${roomId}/bans/${playerId}/isBanned`, {
				headers: await bearer(sub),
			})

		// Auth-gated, but any authenticated caller may ask — a ban is not a secret from the
		// player it stops.
		expect((await SELF.fetch(`${ORIGIN}/Room_server/rooms/2/bans/205/isBanned`)).status).toBe(401)

		// Nobody is banned from room 3.
		const clean = await isBanned(3, 4242)
		expect(clean.status).toBe(200)
		// `success` says the CHECK ran; `value` is the answer. Note `error_id` is present and
		// `error` is null — not the room mutations' `{ success, error, value }` with `""`.
		expect(await clean.json()).toEqual({
			success: true,
			error: null,
			error_id: null,
			value: false,
		})

		// Ban someone from room 3, and the same call now says so.
		await env.DB.prepare(
			'INSERT INTO room_ban (room_id, banned_player_id, ban_mask, banned_by_account_id, created_at)' +
				" VALUES (?1, ?2, 0, 1, '2026-01-01T00:00:00Z')"
		)
			.bind(3, 4242)
			.run()
		expect(await (await isBanned(3, 4242)).json()).toMatchObject({ success: true, value: true })

		// The ban is per (room, player): another room and another player are unaffected.
		expect(await (await isBanned(2, 4242)).json()).toMatchObject({ value: false })
		expect(await (await isBanned(3, 4243)).json()).toMatchObject({ value: false })

		await env.DB.prepare('DELETE FROM room_ban WHERE room_id = ?1 AND banned_player_id = ?2')
			.bind(3, 4242)
			.run()
	})

	it('POST /rooms/:id/bans kicks the banned player', async () => {
		type Sent = { playerId: number; notificationType: string | number; data: unknown }
		const hub = () => env.RECFLARE_NOTIFICATIONS_HUB.getByName('global')
		const sentSince = async (): Promise<Sent[]> =>
			(await (await hub().fetch('http://do/all')).json()) as Sent[]

		// The room's current name, read rather than hardcoded — earlier tests rename it.
		const { Name } = (await (await SELF.fetch(`${ORIGIN}/rooms/2`)).json()) as { Name: string }

		await hub().fetch('http://do/all', { method: 'DELETE' })
		expect((await postForm('/rooms/2/bans', { banMask: '0', id: '207' }, '1')).status).toBe(200)

		// A ModerationKick (id 22) to the BANNED player, not the caller — it ejects them
		// from the instance they're in now; the row keeps them out of future matchmakes.
		// Asserted against the enum rather than a literal: the ids are notify's to change.
		expect(await sentSince()).toEqual([
			{
				playerId: 207,
				notificationType: NotificationType.ModerationKick,
				// The client's moderation payload, camelCase, in wire order.
				data: {
					reportCategory: -1, // Moderator — a person acted, not the system
					duration: 0, // a room ban has no expiry
					gameSessionId: 0,
					// The host ejected them (as opposed to a room vote-kick, which doesn't
					// exist yet). Account 1 owns RecCenter, so it hosts it.
					isHostKick: true,
					message: `You have been banned from ${Name}.`,
					playerIdReporter: 1,
					isBan: true,
					isVoiceModAutoban: false,
				},
			},
		])

		// A staff moderator doesn't host the room, so it isn't a host kick — and
		// `playerIdReporter` is still whoever caused it.
		await hub().fetch('http://do/all', { method: 'DELETE' })
		expect(
			(await postForm('/rooms/2/bans', { id: '208' }, '999', ['gameClient', 'moderator'])).status
		).toBe(200)
		expect((await sentSince())[0]).toMatchObject({
			playerId: 208,
			data: { isHostKick: false, playerIdReporter: 999 },
		})
	})

	it('GET /rooms/:id/bans lists the room’s bans, under the same gate', async () => {
		type Entry = { accountId: number; bannedByAccountId: number; banStartTime: string }
		const list = async (path: string, sub?: string, roles?: string[]) =>
			SELF.fetch(`${ORIGIN}${path}`, { headers: sub ? await bearer(sub, roles) : {} })

		// Room 3 is owned by account 1 (it has no bans yet) — ban two players into it.
		expect((await postForm('/rooms/3/bans', { id: '401' }, '1')).status).toBe(200)
		expect((await postForm('/rooms/3/bans', { id: '402' }, '1')).status).toBe(200)

		// No token → 401; a valid token with no room role and no staff role → 403.
		expect((await list('/rooms/3/bans')).status).toBe(401)
		expect((await list('/rooms/3/bans', '999')).status).toBe(403)

		const res = await list('/rooms/3/bans', '1')
		expect(res.status).toBe(200)
		// A bare array in the client's camelCase shape — no room id, no ban mask.
		const bans = (await res.json()) as Entry[]
		expect(bans.map((b) => b.accountId).sort((a, b) => a - b)).toEqual([401, 402])
		expect(bans[0]).toEqual({
			accountId: expect.any(Number),
			bannedByAccountId: 1,
			banStartTime: expect.stringMatching(/^\d{4}-\d{2}-\d{2}T/),
		})

		// A staffer can read a list for a room they have no role on.
		expect((await list('/rooms/3/bans', '999', ['gameClient', 'moderator'])).status).toBe(200)

		// An unknown room reads the same as a room with nobody banned — no probing which
		// room ids exist.
		expect(await (await list('/rooms/99999/bans', '1')).json()).toEqual([])
	})

	it('DELETE /rooms/:id/bans/:playerId lifts a ban, under the same gate', async () => {
		const del = async (path: string, sub?: string, roles?: string[]) =>
			SELF.fetch(`${ORIGIN}${path}`, {
				method: 'DELETE',
				headers: sub ? await bearer(sub, roles) : {},
			})
		const isBanned = async (roomId: number, playerId: number) =>
			(await env.DB.prepare(
				'SELECT 1 AS hit FROM room_ban WHERE room_id = ?1 AND banned_player_id = ?2'
			)
				.bind(roomId, playerId)
				.first()) !== null

		// Two bans to lift: one removed by the owner, one by a staffer.
		expect((await postForm('/rooms/2/bans', { id: '305' }, '1')).status).toBe(200)
		expect((await postForm('/rooms/2/bans', { id: '306' }, '1')).status).toBe(200)

		// No token → 401; a valid token with no room role and no staff role → 403.
		expect((await del('/rooms/2/bans/305')).status).toBe(401)
		expect((await del('/rooms/2/bans/305', '999')).status).toBe(403)
		expect(await isBanned(2, 305)).toBe(true)

		// Unknown room → failure envelope.
		expect(await envOf(await del('/rooms/99999/bans/305', '1'))).toMatchObject({
			success: false,
			error: 'This room does not exist!',
		})

		// The owner lifts it; the removed ban comes back as `value`.
		const ok = await del('/rooms/2/bans/305', '1')
		expect(ok.status).toBe(200)
		expect(await envOf(ok)).toMatchObject({
			success: true,
			error: '',
			value: { RoomId: 2, BannedPlayerId: 305 },
		})
		expect(await isBanned(2, 305)).toBe(false)

		// Unbanning someone who isn't banned is a rejection, not a silent success.
		expect(await envOf(await del('/rooms/2/bans/305', '1'))).toMatchObject({
			success: false,
			error: 'This player is not banned from this room!',
			value: null,
		})

		// A staff token may lift a ban in a room they have no role on.
		expect((await del('/rooms/2/bans/306', '999', ['gameClient', 'developer'])).status).toBe(200)
		expect(await isBanned(2, 306)).toBe(false)
	})

	it('PUT /rooms/:id/warning is auth-gated, owner/co-owner-only, and persists', async () => {
		// No token → 401 (auth gate).
		expect((await putForm('/rooms/2/warning', { warningMask: '2' })).status).toBe(401)
		// A valid token but no role on the room → 403.
		expect((await putForm('/rooms/2/warning', { warningMask: '2' }, '999')).status).toBe(403)
		// Unknown room → failure envelope.
		expect(
			await envOf(await putForm('/rooms/99999/warning', { warningMask: '2' }, '1'))
		).toMatchObject({ success: false, error: 'This room does not exist!' })
		// Non-numeric mask → failure envelope.
		expect(await envOf(await putForm('/rooms/2/warning', { warningMask: 'x' }, '1'))).toMatchObject(
			{ success: false }
		)

		// Owner sets it, and it persists as an integer (not 2.0). The success envelope
		// carries the updated room as `value`.
		const ok = await putForm('/rooms/2/warning', { warningMask: '2' }, '1')
		expect(ok.status).toBe(200)
		const okBody = await envOf(ok)
		expect(okBody).toMatchObject({ success: true, error: '' })
		expect(okBody.value?.WarningMask).toBe(2)
		const raw = await env.DB.prepare('SELECT data FROM room WHERE room_id = ?1')
			.bind(2)
			.first<{ data: string }>()
		expect(raw!.data).toContain('"WarningMask":2')
		expect(raw!.data).not.toContain('"WarningMask":2.0')
		const room = (await (await SELF.fetch(`${ORIGIN}/rooms/2`)).json()) as { WarningMask: number }
		expect(room.WarningMask).toBe(2)

		// The mask can carry an optional free-text CustomWarning alongside it.
		const custom = await envOf(
			await putForm('/rooms/2/warning', { warningMask: '63', customWarning: 'slfkjsdf' }, '1')
		)
		expect(custom).toMatchObject({ success: true })
		expect(custom.value).toMatchObject({ WarningMask: 63, CustomWarning: 'slfkjsdf' })
		const withCustom = (await (await SELF.fetch(`${ORIGIN}/rooms/2`)).json()) as {
			WarningMask: number
			CustomWarning: string
		}
		expect(withCustom).toMatchObject({ WarningMask: 63, CustomWarning: 'slfkjsdf' })

		// Omitting customWarning leaves the existing text untouched (partial update).
		await putForm('/rooms/2/warning', { warningMask: '7' }, '1')
		const kept = (await (await SELF.fetch(`${ORIGIN}/rooms/2`)).json()) as { CustomWarning: string }
		expect(kept.CustomWarning).toBe('slfkjsdf')

		// The co-owner (account 2, Role 30) may also set it.
		expect((await putForm('/rooms/2/warning', { warningMask: '4' }, '2')).status).toBe(200)
	})

	it('PUT /rooms/:id/cloning is auth-gated, owner/co-owner-only, and persists a JSON boolean', async () => {
		// No token → 401.
		expect((await putForm('/rooms/2/cloning', { cloningAllowed: 'False' })).status).toBe(401)
		// A valid token but no role on the room → 403.
		expect((await putForm('/rooms/2/cloning', { cloningAllowed: 'False' }, '999')).status).toBe(403)
		// Unknown room → failure envelope.
		expect(
			await envOf(await putForm('/rooms/99999/cloning', { cloningAllowed: 'False' }, '1'))
		).toMatchObject({ success: false, error: 'This room does not exist!' })

		// Owner disables cloning; it persists as a real JSON boolean (not 0/1). The
		// success envelope carries the updated room as `value`.
		const disabled = await envOf(
			await putForm('/rooms/2/cloning', { cloningAllowed: 'False' }, '1')
		)
		expect(disabled).toMatchObject({ success: true, error: '' })
		expect(disabled.value?.CloningAllowed).toBe(false)
		const raw = await env.DB.prepare('SELECT data FROM room WHERE room_id = ?1')
			.bind(2)
			.first<{ data: string }>()
		expect(raw!.data).toContain('"CloningAllowed":false')
		const room = (await (await SELF.fetch(`${ORIGIN}/rooms/2`)).json()) as {
			CloningAllowed: boolean
		}
		expect(room.CloningAllowed).toBe(false)

		// The co-owner (account 2) may re-enable it.
		await putForm('/rooms/2/cloning', { cloningAllowed: 'True' }, '2')
		const reenabled = (await (await SELF.fetch(`${ORIGIN}/rooms/2`)).json()) as {
			CloningAllowed: boolean
		}
		expect(reenabled.CloningAllowed).toBe(true)
	})

	it('PUT /rooms/:id/restrictions sets the Supports* flags present in the body', async () => {
		// No token → 401; a valid token with no role → 403.
		expect((await putForm('/rooms/2/restrictions', { supportsScreens: 'True' })).status).toBe(401)
		expect(
			(await putForm('/rooms/2/restrictions', { supportsScreens: 'True' }, '999')).status
		).toBe(403)

		// The exact client body: a mix of True/False across a subset of the flags.
		const res = await SELF.fetch(`${ORIGIN}/rooms/2/restrictions`, {
			method: 'PUT',
			headers: { ...(await bearer('1')), 'Content-Type': 'application/x-www-form-urlencoded' },
			body: 'supportsScreens=True&supportsWalkVR=True&supportsTeleportVR=False&supportsJuniors=True',
		})
		expect(res.status).toBe(200)
		// The success envelope carries the updated room as `value`.
		const env2 = await envOf(res)
		expect(env2).toMatchObject({ success: true, error: '' })
		expect(env2.value).toMatchObject({
			SupportsScreens: true,
			SupportsWalkVR: true,
			SupportsTeleportVR: false,
			SupportsJuniors: true,
		})

		const room = (await (await SELF.fetch(`${ORIGIN}/rooms/2`)).json()) as {
			SupportsScreens: boolean
			SupportsWalkVR: boolean
			SupportsTeleportVR: boolean
			SupportsJuniors: boolean
			SupportsMobile: boolean
		}
		expect(room.SupportsScreens).toBe(true)
		expect(room.SupportsWalkVR).toBe(true)
		expect(room.SupportsTeleportVR).toBe(false)
		expect(room.SupportsJuniors).toBe(true)
		// A flag not in the body is left unchanged (still a boolean, not dropped).
		expect(typeof room.SupportsMobile).toBe('boolean')
	})

	it('PUT /rooms/:id/loadscreen replaces the load screen (auth-gated, owner/co-owner-only)', async () => {
		const screensOf = async (): Promise<Array<Record<string, unknown>>> => {
			const room = (await (await SELF.fetch(`${ORIGIN}/rooms/2`)).json()) as {
				LoadScreens?: Array<Record<string, unknown>>
			}
			return room.LoadScreens ?? []
		}

		// No token → 401; a valid token with no role → 403.
		expect((await putForm('/rooms/2/loadscreen', { imageName: 'a.jpg' })).status).toBe(401)
		expect((await putForm('/rooms/2/loadscreen', { imageName: 'a.jpg' }, '999')).status).toBe(403)
		// Unknown room → failure envelope.
		expect(
			await envOf(await putForm('/rooms/99999/loadscreen', { imageName: 'a.jpg' }, '1'))
		).toMatchObject({ success: false, error: 'This room does not exist!' })
		// Missing image → failure envelope.
		expect(await envOf(await putForm('/rooms/2/loadscreen', { title: 'x' }, '1'))).toMatchObject({
			success: false,
		})

		// Owner sets one (imageName + title + subtitle) — the success envelope carries the
		// updated room, and the posted screen is the ONLY entry.
		const added = await envOf(
			await putForm(
				'/rooms/2/loadscreen',
				{ imageName: 'sharecamera/2026-07-15/abc.jpg', title: 'asdf', subtitle: 'sdf' },
				'1'
			)
		)
		expect(added).toMatchObject({ success: true })
		expect(added.value?.LoadScreens).toEqual([
			{ ImageName: 'sharecamera/2026-07-15/abc.jpg', Title: 'asdf', Subtitle: 'sdf' },
		])
		expect(await screensOf()).toHaveLength(1)

		// A second call REPLACES rather than appending (the client renders one screen, so
		// an appended one would sit unreachable behind the old); title/subtitle default to
		// empty when omitted.
		const co = await envOf(await putForm('/rooms/2/loadscreen', { imageName: 'second.jpg' }, '2'))
		expect(co).toMatchObject({ success: true })
		expect(await screensOf()).toEqual([{ ImageName: 'second.jpg', Title: '', Subtitle: '' }])
	})

	it('PUT /rooms/:id/accessibility sets the room-level Accessibility (auth-gated, owner/co-owner-only)', async () => {
		// No token → 401; a valid token with no role → 403.
		expect((await putForm('/rooms/2/accessibility', { accessibility: '1' })).status).toBe(401)
		expect((await putForm('/rooms/2/accessibility', { accessibility: '1' }, '999')).status).toBe(
			403
		)
		// Unknown room → failure envelope.
		expect(
			await envOf(await putForm('/rooms/99999/accessibility', { accessibility: '1' }, '1'))
		).toMatchObject({ success: false, error: 'This room does not exist!' })
		// Non-numeric → failure envelope.
		expect(
			await envOf(await putForm('/rooms/2/accessibility', { accessibility: 'x' }, '1'))
		).toMatchObject({ success: false })

		// Owner sets it (0 = Private); the success envelope carries the updated room.
		const priv = await envOf(await putForm('/rooms/2/accessibility', { accessibility: '0' }, '1'))
		expect(priv).toMatchObject({ success: true, error: '' })
		expect(priv.value?.Accessibility).toBe(0)
		const room = (await (await SELF.fetch(`${ORIGIN}/rooms/2`)).json()) as { Accessibility: number }
		expect(room.Accessibility).toBe(0)

		// The co-owner (account 2) may set it back to public (1).
		const pub = await envOf(await putForm('/rooms/2/accessibility', { accessibility: '1' }, '2'))
		expect(pub.value?.Accessibility).toBe(1)
	})

	it('there is no GET for a single subroom — only the room carries them', async () => {
		// The real API has no `GET …/subrooms/{id}/data`; the client reads subrooms off the
		// room. Only the POST (the room save) exists on that path, and it is auth-gated.
		expect((await SELF.fetch(`${ORIGIN}/rooms/2/subrooms/2/data`)).status).toBe(404)
		expect(await subRoomOf(2, 2)).toMatchObject({ SubRoomId: 2 })
	})

	it('POST /rooms/:id/subrooms/:sid/data is auth-gated, owner-only, and saves the blobs', async () => {
		const save = {
			UnityAssetId: null,
			RoomData: { Filename: '5c618c920f6247efb8327e327d0b4417', Hash: null, OwnershipProof: null },
			SubRoomData: {
				Filename: 'a84167b16796452ab70ee8a6a5b1dc5f',
				Hash: null,
				OwnershipProof: null,
			},
			InventionUsage: 'CAE=',
			PersistenceVersion: 41,
			Description: 'mydescription here',
			AutoPublish: true,
		}
		// No token → 401.
		expect(
			(
				await SELF.fetch(`${ORIGIN}/rooms/2/subrooms/2/data`, {
					method: 'POST',
					headers: { 'Content-Type': 'application/json' },
					body: JSON.stringify(save),
				})
			).status
		).toBe(401)

		const authed = async (roomId: number, subRoomId: number, sub = '1') =>
			SELF.fetch(`${ORIGIN}/rooms/${roomId}/subrooms/${subRoomId}/data`, {
				method: 'POST',
				headers: { 'Content-Type': 'application/json', ...(await bearer(sub)) },
				body: JSON.stringify(save),
			})

		// A valid token but no role on the room → 403.
		expect((await authed(2, 2, '999')).status).toBe(403)
		// Rejections use the same lowercase envelope as the success case.
		expect(await envOf(await authed(99999, 2, '1'))).toMatchObject({
			success: false,
			error: 'This room does not exist!',
		})
		expect(await envOf(await authed(2, 9999, '1'))).toMatchObject({ success: false })

		// The room's own fields are read first: a save is a revision of a SUBROOM and must
		// leave them alone. `Description` in the body is the save comment, not the room's
		// description — that is `PUT /rooms/:id/description`'s to set.
		const before = (await (await SELF.fetch(`${ORIGIN}/rooms/2`)).json()) as {
			Description: string
			PersistenceVersion: number
		}
		expect(before.Description).not.toBe('mydescription here')

		// Owner saves → 200. `value` carries BOTH the updated room and the new save, and
		// `error` is null (not ''). This fixture sends `AutoPublish: true`, so it goes live.
		const ok = await authed(2, 2, '1')
		expect(ok.status).toBe(200)
		const saved = (await ok.json()) as {
			success: boolean
			error: string | null
			value: {
				room: Record<string, unknown>
				subRoomDataSave: Record<string, unknown>
			}
		}
		expect(saved.success).toBe(true)
		expect(saved.error).toBeNull()
		expect(saved.value.room).toMatchObject({ RoomId: 2, Description: before.Description })

		// The save is a camelCase projection, NOT the PascalCase CurrentSave shape.
		expect(saved.value.subRoomDataSave).toEqual({
			subRoomDataSaveId: expect.any(Number),
			subRoomId: 2,
			unityAssetId: null,
			unityAsset: null,
			unityAssetHash: null,
			dataBlob: 'a84167b16796452ab70ee8a6a5b1dc5f',
			dataBlobHash: null,
			savedByAccountId: 1,
			savedOnPlatform: 0,
			savedOnDeviceClass: 0,
			description: 'mydescription here',
			createdAt: expect.any(String),
		})

		// The saved subroom rides along inside the room's SubRooms, carrying the new save.
		const savedSub = (saved.value.room.SubRooms as Array<Record<string, unknown>>).find(
			(s) => s.SubRoomId === 2
		)!
		expect(savedSub).toMatchObject({
			RoomDataBlob: '5c618c920f6247efb8327e327d0b4417',
			CreatorAccountId: 1,
			PersistenceVersion: 41,
		})
		expect(savedSub.CurrentSave).toMatchObject({
			DataBlob: 'a84167b16796452ab70ee8a6a5b1dc5f',
		})

		// It also persists — reading the room back shows the save live.
		const sub = (await subRoomOf(2, 2)) as unknown as {
			SubRoomId: number
			CreatorAccountId: number
			CurrentSave: {
				DataBlob: string
				SubRoomDataSaveId: number
				SavedByAccountId: number
				PersistenceVersion: number
				Description: string
				UnitySubAssets: unknown[]
				Tags: unknown[]
			}
			StagedSubRoomDataSaveId: number | null
		}
		expect(sub).toMatchObject({ SubRoomId: 2, CreatorAccountId: 1 })
		expect(sub.CurrentSave).toMatchObject({
			DataBlob: 'a84167b16796452ab70ee8a6a5b1dc5f',
			SavedByAccountId: 1,
			PersistenceVersion: 41,
			UnitySubAssets: [],
			Tags: [],
		})
		expect(sub.CurrentSave.SubRoomDataSaveId).toBeGreaterThan(0)
		expect(sub.StagedSubRoomDataSaveId).toBeNull()

		// The save comment and the scene fields land on the SUBROOM's revision, and the
		// room's own fields are untouched — a save must never rewrite the room.
		expect(sub.CurrentSave.Description).toBe('mydescription here')
		expect(sub).toMatchObject({ PersistenceVersion: 41, InventionUsage: 'CAE=' })
		const room = (await (await SELF.fetch(`${ORIGIN}/rooms/2`)).json()) as {
			Description: string
			PersistenceVersion: number
			InventionUsage?: string
		}
		expect(room.Description).toBe(before.Description)
		expect(room.PersistenceVersion).toBe(before.PersistenceVersion)
		expect(room.InventionUsage).toBeUndefined()

		// A CoOwner (account 2 holds Role 30 in the seeded rooms) may also save — 200
		// with the room envelope. The creator stays account 1 (not clobbered).
		const coOwner = await authed(2, 2, '2')
		expect(coOwner.status).toBe(200)
		const coOwnerEnv = (await coOwner.json()) as {
			success: boolean
			value: { room: { SubRooms: Array<Record<string, unknown>> }; subRoomDataSave: unknown }
		}
		expect(coOwnerEnv.success).toBe(true)
		expect(coOwnerEnv.value.room.SubRooms.find((s) => s.SubRoomId === 2)).toMatchObject({
			CreatorAccountId: 1,
		})
		// The save records who actually saved it, not the room's creator.
		expect(coOwnerEnv.value.subRoomDataSave).toMatchObject({ savedByAccountId: 2 })
	})

	it('GET /rooms/:id gives every subroom a CurrentSave key (null before the first save)', async () => {
		// The client loads a subroom's scene data from CurrentSave and nothing else, so
		// the key must be PRESENT — the seeded rooms predate it and have no such field in
		// their stored blob. `in` rather than a value check: absent and null differ here.
		// Room 3 is seeded and never saved by another test (room 2 is the save fixture).
		const room = (await (await SELF.fetch(`${ORIGIN}/rooms/3`)).json()) as {
			SubRooms: Array<Record<string, unknown>>
		}
		expect(room.SubRooms.length).toBeGreaterThan(0)
		for (const sub of room.SubRooms) {
			expect('CurrentSave' in sub).toBe(true)
			expect(sub.CurrentSave).toBeNull()
		}
	})

	it('a real client room-save body stages, and publish_save makes it live', async () => {
		const save = async (body: unknown) =>
			SELF.fetch(`${ORIGIN}/rooms/5/subrooms/5/data`, {
				method: 'POST',
				headers: { 'Content-Type': 'application/json', ...(await bearer('1')) },
				body: JSON.stringify(body),
			})
		type Sub = {
			CurrentSave: Record<string, unknown> | null
			StagedSubRoomDataSaveId: number | null
		}
		const subOf = async () => (await subRoomOf(5, 5)) as unknown as Sub
		const publish = async (saveId: number, sub = '1') =>
			SELF.fetch(`${ORIGIN}/rooms/5/subrooms/5/publish_save`, {
				method: 'POST',
				headers: {
					...(await bearer(sub)),
					'Content-Type': 'application/x-www-form-urlencoded',
				},
				body: new URLSearchParams({ subRoomDataSaveId: String(saveId) }).toString(),
			})

		// The exact body the live client posts after uploading both blobs to `storage`:
		// SubRoomData is the scene blob, RoomData the metadata blob.
		const res = await save({
			UnityAssetId: null,
			RoomData: { Filename: '2026-07-28/b266ccd5-metadata', Hash: null, OwnershipProof: null },
			SubRoomData: { Filename: '2026-07-28/f176fc3b-scene', Hash: null, OwnershipProof: null },
			InventionUsage: 'CAE=',
			PersistenceVersion: 51,
			Description: 'TEST',
			AutoPublish: false,
		})
		expect(res.status).toBe(200)

		// Room 5 is not a dorm → staged, nothing live yet.
		const stagedSub = await subOf()
		expect(stagedSub.CurrentSave).toBeNull()
		const firstId = stagedSub.StagedSubRoomDataSaveId!
		expect(firstId).toBeGreaterThan(0)

		// Publishing makes it what the loader fetches, and clears the staging slot.
		expect((await publish(firstId)).status).toBe(200)
		const live = await subOf()
		expect(live.StagedSubRoomDataSaveId).toBeNull()
		expect(live.CurrentSave).toMatchObject({
			SubRoomId: 5,
			SubRoomDataSaveId: firstId,
			DataBlob: '2026-07-28/f176fc3b-scene',
			PersistenceVersion: 51,
			SavedByAccountId: 1,
			Description: 'TEST',
			OMVersion: 0,
			UgcSubVersion: 0,
			ModerationState: 0,
		})
		// DataBlobHash rides along (null — the client sent `Hash: null`); UnityAssetId is
		// omitted entirely rather than nulled, since the save carried none.
		expect(live.CurrentSave!.DataBlobHash).toBeNull()
		expect('UnityAssetId' in live.CurrentSave!).toBe(false)

		// It's on the room read too — that's what the loader actually fetches.
		const room = (await (await SELF.fetch(`${ORIGIN}/rooms/5`)).json()) as {
			SubRooms: Array<{ SubRoomId: number; CurrentSave: { SubRoomDataSaveId: number } | null }>
		}
		expect(room.SubRooms.find((s) => s.SubRoomId === 5)!.CurrentSave!.SubRoomDataSaveId).toBe(
			firstId
		)

		// A second save appends and stages — what players load does NOT change.
		await save({ SubRoomData: { Filename: 'second.room' } })
		const afterSecond = await subOf()
		const secondId = afterSecond.StagedSubRoomDataSaveId!
		expect(secondId).toBeGreaterThan(firstId)
		expect(afterSecond.CurrentSave).toMatchObject({ SubRoomDataSaveId: firstId })

		// Both saves are in the history, newest first — the first one is not lost.
		const history = (await (
			await SELF.fetch(`${ORIGIN}/rooms/5/subrooms/5/saves`, { headers: await bearer('1') })
		).json()) as {
			Results: Array<{ DataBlob: string; Description: string }>
			TotalResults: number
		}
		expect(history.TotalResults).toBe(2)
		expect(history.Results.map((s) => s.DataBlob)).toEqual([
			'second.room',
			'2026-07-28/f176fc3b-scene',
		])
		// A save with no Description records an empty string, not null.
		expect(history.Results[0]!.Description).toBe('')

		// Publishing an OLDER save is a restore — and keeps the newer staged work.
		expect((await publish(secondId)).status).toBe(200)
		expect((await subOf()).StagedSubRoomDataSaveId).toBeNull()
		expect((await publish(firstId)).status).toBe(200)
		const restored = await subOf()
		expect(restored.CurrentSave).toMatchObject({ SubRoomDataSaveId: firstId })

		// A save id from a different subroom is rejected, even though ids are global.
		const foreign = (await (
			await publish(
				((await subRoomOf(2, 2)) as unknown as Sub).CurrentSave!.SubRoomDataSaveId as number
			)
		).json()) as { success: boolean; error: string }
		expect(foreign.success).toBe(false)
		expect(foreign.error).toBe('That save does not exist!')

		// Co-owners may save but not publish.
		expect(((await (await publish(firstId, '2')).json()) as { success: boolean }).success).toBe(
			false
		)
	})

	it('migrates a pre-CurrentSave subroom into a real save row (0008 backfill 2)', async () => {
		// A subroom saved by the older code has its blob in the flat DataBlob field and no
		// CurrentSave at all. seedRoomWithSubRooms mirrors the migration, so this covers
		// the backfill: the flat fields become a save row the subroom points at, rather
		// than reading as never-saved and hiding real content from the loader.
		await seedRoomWithSubRooms(env.DB, {
			RoomId: 820,
			Name: 'LegacyShaped',
			CreatorAccountId: 1,
			SubRooms: [
				{
					SubRoomId: 830,
					Name: 'Legacy',
					CreatorAccountId: 7,
					UnitySceneId: '76d98498-60a1-430c-ab76-b54a29b7a163',
					MaxPlayers: 4,
					Accessibility: 2,
					DataBlob: 'legacy-blob.room',
					DataSavedAt: '2024-03-04T05:06:07.000Z',
					PersistenceVersion: 12,
				},
			],
		})

		const sub = (await subRoomOf(820, 830)) as unknown as {
			CurrentSave: Record<string, unknown>
		}
		expect(sub.CurrentSave).toMatchObject({
			SubRoomId: 830,
			DataBlob: 'legacy-blob.room',
			PersistenceVersion: 12,
			SavedByAccountId: 7,
			CreatedAt: '2024-03-04T05:06:07.000Z',
			UnitySubAssets: [],
			Tags: [],
		})
		// Stable across reads — it's a stored row now, not something rebuilt per request.
		const again = (await subRoomOf(820, 830)) as unknown as {
			CurrentSave: { SubRoomDataSaveId: number }
		}
		expect(again.CurrentSave.SubRoomDataSaveId).toBe(sub.CurrentSave.SubRoomDataSaveId)
	})

	it('a dorm save publishes immediately instead of staging', async () => {
		// Room 1 is the seeded DormRoom (IsDorm). A dorm is the player's own space with no
		// publish step in the client, so staging one would make their edits permanently
		// invisible — dorm saves go straight live.
		const res = await SELF.fetch(`${ORIGIN}/rooms/1/subrooms/1/data`, {
			method: 'POST',
			headers: { 'Content-Type': 'application/json', ...(await bearer('1')) },
			body: JSON.stringify({ SubRoomData: { Filename: 'dorm.room' } }),
		})
		expect(res.status).toBe(200)

		const sub = (await subRoomOf(1, 1)) as unknown as {
			CurrentSave: { DataBlob: string } | null
			StagedSubRoomDataSaveId: number | null
		}
		expect(sub.CurrentSave).toMatchObject({ DataBlob: 'dorm.room' })
		expect(sub.StagedSubRoomDataSaveId).toBeNull()
	})

	it('save ids are globally unique across subrooms, so a bare id resolves', async () => {
		// StagedSubRoomDataSaveId points at a save by bare id with no subroom context, so
		// per-subroom numbering (every subroom's first save being 1) would be ambiguous.
		const save = async (roomId: number, subRoomId: number) =>
			SELF.fetch(`${ORIGIN}/rooms/${roomId}/subrooms/${subRoomId}/data`, {
				method: 'POST',
				headers: { 'Content-Type': 'application/json', ...(await bearer('1')) },
				body: JSON.stringify({ SubRoomData: { Filename: `blob-${subRoomId}.room` } }),
			})
		// Non-dorm saves stage, so the fresh id lands on StagedSubRoomDataSaveId.
		const idOf = async (roomId: number, subRoomId: number) =>
			((await subRoomOf(roomId, subRoomId)) as unknown as { StagedSubRoomDataSaveId: number })
				.StagedSubRoomDataSaveId

		// Two different subrooms, each getting their FIRST save.
		await save(6, 6)
		await save(7, 7)
		expect(await idOf(6, 6)).not.toBe(await idOf(7, 7))
	})

	it('a cloned subroom re-points CurrentSave at the copy, not the source', async () => {
		// Save room 2's subroom so there is a CurrentSave to copy.
		await SELF.fetch(`${ORIGIN}/rooms/2/subrooms/2/data`, {
			method: 'POST',
			headers: { ...(await bearer('1')), 'Content-Type': 'application/json' },
			body: JSON.stringify({ SubRoomData: { Filename: 'cloned-source.room' } }),
		})

		const res = await SELF.fetch(`${ORIGIN}/rooms/2/subrooms/2/clone`, {
			method: 'POST',
			headers: await bearer('1'),
		})
		const body = (await res.json()) as {
			value: { SubRooms: Array<{ SubRoomId: number; CurrentSave: { SubRoomId: number } | null }> }
		}
		const clone = body.value.SubRooms.find((s) => s.SubRoomId !== 2 && s.CurrentSave !== null)!
		expect(clone).toBeDefined()
		// The copy's save must claim the COPY, or the client resolves it against the source.
		expect(clone.CurrentSave!.SubRoomId).toBe(clone.SubRoomId)
	})

	it('PUT /rooms/:id/tags is auth-gated, owner/co-owner-only, and toggles (add/remove)', async () => {
		// The lowercase `{ success, error, value }` envelope this endpoint returns.
		type TagResult = {
			success: boolean
			error: string
			value: { Tags?: Array<{ Tag: string }> } | null
		}
		const envOf = async (res: Response) => (await res.json()) as TagResult
		const tagsIn = (r: TagResult) => (r.value?.Tags ?? []).map((t) => t.Tag)

		// No token → 401.
		expect((await putForm('/rooms/2/tags', { tag: 'quest' })).status).toBe(401)
		// A valid token but no role on the room → 403.
		expect((await putForm('/rooms/2/tags', { tag: 'quest' }, '999')).status).toBe(403)
		// Unknown room → failure envelope.
		expect(await envOf(await putForm('/rooms/99999/tags', { tag: 'quest' }, '1'))).toMatchObject({
			success: false,
			error: 'This room does not exist!',
		})
		// Empty tag → failure envelope.
		expect(await envOf(await putForm('/rooms/2/tags', { tag: '  ' }, '1'))).toMatchObject({
			success: false,
			error: 'You must provide a tag!',
		})

		// Owner adds a non-main tag → success envelope carries the updated room.
		const added = await envOf(await putForm('/rooms/2/tags', { tag: 'spooky' }, '1'))
		expect(added).toMatchObject({ success: true, error: '' })
		expect(tagsIn(added)).toContain('spooky')

		// The same call again toggles it back off (no delete endpoint).
		const removed = await envOf(await putForm('/rooms/2/tags', { tag: 'SPOOKY' }, '1'))
		expect(tagsIn(removed)).not.toContain('spooky')

		// Main tags are radio buttons: setting one clears any other main tag, but
		// leaves non-main tags alone.
		await putForm('/rooms/2/tags', { tag: 'campfire' }, '1') // non-main, stays put
		const pvp = await envOf(await putForm('/rooms/2/tags', { tag: 'pvp' }, '1'))
		expect(tagsIn(pvp)).toEqual(expect.arrayContaining(['pvp', 'campfire']))

		const quest = await envOf(await putForm('/rooms/2/tags', { tag: 'quest' }, '1'))
		expect(tagsIn(quest)).toContain('quest')
		expect(tagsIn(quest)).not.toContain('pvp') // the previous main tag was cleared
		expect(tagsIn(quest)).toContain('campfire') // non-main tag untouched

		// Toggling the current main tag off just removes it (no other change).
		const off = await envOf(await putForm('/rooms/2/tags', { tag: 'quest' }, '1'))
		expect(tagsIn(off)).not.toContain('quest')
		expect(tagsIn(off)).toContain('campfire')

		// The co-owner (account 2, Role 30) may edit tags too.
		const byCoOwner = await envOf(await putForm('/rooms/2/tags', { tag: 'spooky' }, '2'))
		expect(byCoOwner).toMatchObject({ success: true, error: '' })
		expect(tagsIn(byCoOwner)).toContain('spooky')
	})

	it('PUT /rooms/:id/name is auth-gated, owner-only, unique, and persists', async () => {
		// No token → 401 (auth gate).
		expect((await putForm('/rooms/2/name', { name: 'Whatever' })).status).toBe(401)
		// Wrong owner / unknown room → Success:false envelopes.
		expect(await bodyOf(await putForm('/rooms/2/name', { name: 'Whatever' }, '999'))).toMatchObject(
			{
				Success: false,
				ErrorId: 'Rooms.NotOwner',
			}
		)
		expect(
			await bodyOf(await putForm('/rooms/99999/name', { name: 'Whatever' }, '1'))
		).toMatchObject({
			Success: false,
			ErrorId: 'Rooms.DoesntExist',
		})
		// Empty name → Success:false.
		expect(await bodyOf(await putForm('/rooms/2/name', { name: '  ' }, '1'))).toMatchObject({
			Success: false,
			ErrorId: 'Rooms.InvalidName',
		})
		// A name already used by a different room (GoldenTrophy is room 12).
		expect(
			await bodyOf(await putForm('/rooms/2/name', { name: 'GoldenTrophy' }, '1'))
		).toMatchObject({
			Success: false,
			ErrorId: 'Rooms.AlreadyExists',
			Error: 'A room with that name already exists!',
		})

		// Owner renames to a free name, and it persists (findable by the new name).
		const ok = await putForm('/rooms/2/name', { name: 'RenamedCenter' }, '1')
		expect(await bodyOf(ok)).toMatchObject({ Success: true })
		const room = (await (await SELF.fetch(`${ORIGIN}/rooms?name=RenamedCenter`)).json()) as {
			RoomId: number
		}
		expect(room.RoomId).toBe(2)
	})

	it('room_instance: create + read round-trips and hides JsonIgnore fields', async () => {
		const created = await createRoomInstance(env.DB, {
			ownerAccountId: 5,
			roomId: 2,
			subRoomId: 3,
			photonRoomId: crypto.randomUUID(),
			name: '^RecCenter',
			maxCapacity: 20,
			isPrivate: true,
			encryptVoiceChat: true,
		})
		// The DB assigns a sequential id, mapped to `roomInstanceId` in the DTO.
		expect(created.roomInstanceId).toBeGreaterThan(0)
		expect(created.roomId).toBe(2)
		expect(created.isPrivate).toBe(true)
		expect(created.EncryptVoiceChat).toBe(true) // PascalCase JSON key, per the reference

		// Reads back identically; JsonIgnore columns are not in the DTO.
		const fetched = await getRoomInstance(env.DB, created.roomInstanceId)
		expect(fetched).toEqual(created)
		expect('ownerAccountId' in (fetched as object)).toBe(false)
		expect('dataBlob' in (fetched as object)).toBe(false)
		expect('allowNewUsers' in (fetched as object)).toBe(false)
	})

	it('GET /photon_access_token 401s without a token', async () => {
		expect((await SELF.fetch(`${ORIGIN}/photon_access_token`)).status).toBe(401)
	})

	it('GET /photon_access_token returns permissions + presence instance', async () => {
		// Seed the caller's presence so RoomInstanceId reflects their current instance.
		await env.DB.prepare('INSERT OR REPLACE INTO presence (data) VALUES (?1)')
			.bind(
				JSON.stringify({
					accountId: 777,
					roomInstance: { roomInstanceId: 1000042 },
					expiresAt: Math.floor(Date.now() / 1000) + 900,
				})
			)
			.run()
		const res = await SELF.fetch(`${ORIGIN}/photon_access_token`, { headers: await bearer('777') })
		expect(res.status).toBe(200)
		const body = (await res.json()) as {
			Permissions: Array<{ Permission: string; Role: number }>
			PhotonAccessToken: string
			RoomInstanceId: number | null
		}
		expect(body.Permissions.length).toBe(11)
		expect(body.RoomInstanceId).toBe(1000042)
		// A non-dev account does NOT get the global (Role 0) maker pen.
		expect(body.Permissions.some((p) => p.Permission === 'CAN_USE_MAKER_PEN' && p.Role === 0)).toBe(
			false
		)
	})

	it('GET /photon_access_token returns null RoomInstanceId when the caller has no presence', async () => {
		const res = await SELF.fetch(`${ORIGIN}/photon_access_token`, { headers: await bearer('888') })
		expect(res.status).toBe(200)
		expect(((await res.json()) as { RoomInstanceId: number | null }).RoomInstanceId).toBeNull()
	})

	it('GET /photon_access_token grants the global maker pen to dev accounts (1/2/3)', async () => {
		for (const sub of ['1', '2', '3']) {
			const res = await SELF.fetch(`${ORIGIN}/photon_access_token`, { headers: await bearer(sub) })
			expect(res.status).toBe(200)
			const body = (await res.json()) as {
				Permissions: Array<{ Permission: string; Role: number; Override: boolean }>
			}
			// The global maker pen is prepended → first entry, Role 0, Override true.
			expect(body.Permissions[0]).toMatchObject({
				Permission: 'CAN_USE_MAKER_PEN',
				Role: 0,
				Override: true,
			})
			expect(body.Permissions.length).toBe(12)
		}
	})

	it('interaction: defaults to false, cheer/favorite toggle and persist', async () => {
		type Interaction = { Cheered: boolean; Favorited: boolean; LastVisitedAt: string }
		const headers = await bearer('555')
		const get = async () =>
			(await (
				await SELF.fetch(`${ORIGIN}/rooms/12/interactionby/me`, { headers })
			).json()) as Interaction
		const put = async (action: 'cheer' | 'favorite') =>
			(await (
				await SELF.fetch(`${ORIGIN}/rooms/12/interactionby/me/${action}`, {
					method: 'PUT',
					headers,
				})
			).json()) as Interaction

		// No row yet → both false.
		expect(await get()).toMatchObject({ Cheered: false, Favorited: false })

		// Cheer on, then favorite on.
		expect(await put('cheer')).toMatchObject({ Cheered: true, Favorited: false })
		expect(await put('favorite')).toMatchObject({ Cheered: true, Favorited: true })
		// Persisted across a fresh GET.
		expect(await get()).toMatchObject({ Cheered: true, Favorited: true })

		// Toggling again flips back.
		expect(await put('cheer')).toMatchObject({ Cheered: false, Favorited: true })

		// Scoped per player — a different account starts fresh.
		const other = await bearer('556')
		const otherGet = (await (
			await SELF.fetch(`${ORIGIN}/rooms/12/interactionby/me`, { headers: other })
		).json()) as Interaction
		expect(otherGet).toMatchObject({ Cheered: false, Favorited: false })
	})

	it('room Stats aggregate cheers/favorites from the interaction table', async () => {
		type Stats = {
			CheerCount: number
			FavoriteCount: number
			VisitorCount: number
			VisitCount: number
		}
		// Room 15 (CrimsonCauldron) is untouched by the other interaction tests.
		const searched = async (): Promise<Stats> => {
			const body = (await (
				await SELF.fetch(`${ORIGIN}/rooms/search?query=crimsoncauldron`)
			).json()) as { Results: Array<{ Stats: Stats }> }
			return body.Results[0]!.Stats
		}
		const direct = async (): Promise<Stats> =>
			((await (await SELF.fetch(`${ORIGIN}/rooms/15`)).json()) as { Stats: Stats }).Stats
		const interact = async (player: string, action: string, method: string) =>
			SELF.fetch(`${ORIGIN}/rooms/15/interactionby/me/${action}`, {
				method,
				headers: await bearer(player),
			})

		// Nobody has interacted with it yet.
		expect(await searched()).toEqual({
			CheerCount: 0,
			FavoriteCount: 0,
			VisitorCount: 0,
			VisitCount: 0,
		})

		// Two players cheer it; one of them also favorites it.
		await interact('561', 'cheer', 'PUT')
		await interact('562', 'cheer', 'PUT')
		await interact('561', 'favorite', 'PUT')

		// Both the search results and the room itself report the aggregate.
		expect(await searched()).toMatchObject({ CheerCount: 2, FavoriteCount: 1 })
		expect(await direct()).toMatchObject({ CheerCount: 2, FavoriteCount: 1 })

		// Clearing a cheer decrements it. Visits are counted by the `match` worker on
		// matchmake and nobody has entered this room, so those stay 0.
		await interact('562', 'cheer', 'DELETE')
		expect(await direct()).toEqual({
			CheerCount: 1,
			FavoriteCount: 1,
			VisitorCount: 0,
			VisitCount: 0,
		})

		// VisitCount is the `room.visits` column (what match bumps on each matchmake),
		// served on every read of the room — here and in the search results — and it
		// survives the cheer/favorite aggregation rather than being zeroed by it.
		await env.DB.prepare('UPDATE room SET visits = 7 WHERE room_id = 15').run()
		expect(await direct()).toEqual({
			CheerCount: 1,
			FavoriteCount: 1,
			VisitorCount: 0,
			VisitCount: 7,
		})
		expect(await searched()).toMatchObject({ VisitCount: 7 })

		// A write to the room doesn't bake the count into the blob (nor reset it).
		// Account 1 created room 15, so the description write is allowed.
		const wrote = await SELF.fetch(`${ORIGIN}/rooms/15/description`, {
			method: 'PUT',
			headers: {
				...(await bearer('1')),
				'Content-Type': 'application/x-www-form-urlencoded',
			},
			body: new URLSearchParams({ description: 'counted' }).toString(),
		})
		expect(wrote.status).toBe(200)
		const blob = await env.DB.prepare('SELECT data FROM room WHERE room_id = 15').first<{
			data: string
		}>()
		expect((JSON.parse(blob!.data) as { Stats: Stats }).Stats.VisitCount).toBe(0)
		expect(await direct()).toMatchObject({ VisitCount: 7 })
	})

	it('DELETE /rooms/:id/interactionby/me/cheer clears the cheer (auth-gated, idempotent)', async () => {
		type Interaction = { Cheered: boolean; Favorited: boolean }
		const headers = await bearer('557')
		const del = () =>
			SELF.fetch(`${ORIGIN}/rooms/12/interactionby/me/cheer`, { method: 'DELETE', headers })

		// No token → 401.
		expect(
			(await SELF.fetch(`${ORIGIN}/rooms/12/interactionby/me/cheer`, { method: 'DELETE' })).status
		).toBe(401)

		// Cheer + favorite on, then DELETE clears only the cheer (favorite untouched).
		await SELF.fetch(`${ORIGIN}/rooms/12/interactionby/me/cheer`, { method: 'PUT', headers })
		await SELF.fetch(`${ORIGIN}/rooms/12/interactionby/me/favorite`, { method: 'PUT', headers })
		expect(await (await del()).json()).toMatchObject({ Cheered: false, Favorited: true })

		// Idempotent — a second DELETE stays cleared.
		expect(await (await del()).json()).toMatchObject({ Cheered: false, Favorited: true })

		// Idempotent on a never-interacted room, and it doesn't create a visited row.
		const fresh = await bearer('558')
		const res = await SELF.fetch(`${ORIGIN}/rooms/2/interactionby/me/cheer`, {
			method: 'DELETE',
			headers: fresh,
		})
		expect(await res.json()).toMatchObject({ Cheered: false, Favorited: false })
		const visited = (await (
			await SELF.fetch(`${ORIGIN}/rooms/visitedby/me`, { headers: fresh })
		).json()) as unknown[]
		expect(visited).toEqual([])
	})

	it('DELETE /rooms/:id/interactionby/me/favorite clears the favorite (auth-gated, idempotent)', async () => {
		const headers = await bearer('559')
		const del = () =>
			SELF.fetch(`${ORIGIN}/rooms/12/interactionby/me/favorite`, { method: 'DELETE', headers })

		// No token → 401.
		expect(
			(await SELF.fetch(`${ORIGIN}/rooms/12/interactionby/me/favorite`, { method: 'DELETE' }))
				.status
		).toBe(401)

		// Favorite + cheer on, then DELETE clears only the favorite (cheer untouched).
		await SELF.fetch(`${ORIGIN}/rooms/12/interactionby/me/favorite`, { method: 'PUT', headers })
		await SELF.fetch(`${ORIGIN}/rooms/12/interactionby/me/cheer`, { method: 'PUT', headers })
		expect(await (await del()).json()).toMatchObject({ Cheered: true, Favorited: false })
		// It drops out of the caller's favorited list.
		const favs = (await (
			await SELF.fetch(`${ORIGIN}/rooms/favoritedby/me`, { headers })
		).json()) as unknown[]
		expect(favs).toEqual([])

		// Idempotent — a second DELETE stays cleared.
		expect(await (await del()).json()).toMatchObject({ Cheered: true, Favorited: false })

		// Idempotent on a never-interacted room, without creating a visited row.
		const fresh = await bearer('560')
		const res = await SELF.fetch(`${ORIGIN}/rooms/2/interactionby/me/favorite`, {
			method: 'DELETE',
			headers: fresh,
		})
		expect(await res.json()).toMatchObject({ Cheered: false, Favorited: false })
		const visited = (await (
			await SELF.fetch(`${ORIGIN}/rooms/visitedby/me`, { headers: fresh })
		).json()) as unknown[]
		expect(visited).toEqual([])
	})

	it('PUT /rooms/:id/subrooms/:sid/modify is auth-gated, owner-only, and persists subroom settings', async () => {
		const fields = { name: 'MyCoolSubroom', accessibility: '1', maxPlayers: '20' }
		// No token → 401 (auth gate).
		expect((await putForm('/rooms/2/subrooms/2/modify', fields)).status).toBe(401)
		// Not the owner (room 2 is owned by account 1) → NotOwner.
		expect(await bodyOf(await putForm('/rooms/2/subrooms/2/modify', fields, '999'))).toMatchObject({
			Success: false,
			ErrorId: 'Rooms.NotOwner',
		})
		// Unknown room → DoesntExist.
		expect(
			await bodyOf(await putForm('/rooms/99999/subrooms/2/modify', fields, '1'))
		).toMatchObject({ Success: false, ErrorId: 'Rooms.DoesntExist' })
		// Unknown subroom → DoesntExist.
		expect(await bodyOf(await putForm('/rooms/2/subrooms/9999/modify', fields, '1'))).toMatchObject(
			{ Success: false, ErrorId: 'Rooms.DoesntExist' }
		)
		// Empty name → InvalidName.
		expect(
			await bodyOf(await putForm('/rooms/2/subrooms/2/modify', { ...fields, name: '  ' }, '1'))
		).toMatchObject({ Success: false, ErrorId: 'Rooms.InvalidName' })

		// Owner updates the subroom → Success, and it persists on the subroom descriptor.
		const ok = await putForm('/rooms/2/subrooms/2/modify', fields, '1')
		expect(ok.status).toBe(200)
		expect(await bodyOf(ok)).toMatchObject({ Success: true })
		const sub = (await subRoomOf(2, 2)) as unknown as {
			Name: string
			Accessibility: number
			MaxPlayers: number
		}
		expect(sub).toMatchObject({ Name: 'MyCoolSubroom', Accessibility: 1, MaxPlayers: 20 })
	})

	it('PUT /rooms/:id/subrooms/:sid/accessibility takes the enum name the client sends', async () => {
		const path = '/rooms/2/subrooms/2/accessibility'
		const accessibilityOf = async () =>
			((await subRoomOf(2, 2)) as unknown as { Accessibility: number }).Accessibility

		// No token → 401.
		expect((await putForm(path, { accessibility: 'Private' })).status).toBe(401)
		// Not the owner (room 2 is owned by account 1) → failure envelope.
		expect(await envOf(await putForm(path, { accessibility: 'Private' }, '999'))).toMatchObject({
			success: false,
			error: 'You are not the owner of this room!',
		})
		// Unknown room / unknown subroom → failure envelope.
		expect(
			await envOf(
				await putForm('/rooms/99999/subrooms/2/accessibility', { accessibility: '0' }, '1')
			)
		).toMatchObject({ success: false })
		expect(
			await envOf(
				await putForm('/rooms/2/subrooms/9999/accessibility', { accessibility: '0' }, '1')
			)
		).toMatchObject({ success: false })
		// A value that names nothing in the enum → rejected, not silently stored.
		expect(await envOf(await putForm(path, { accessibility: 'Nonsense' }, '1'))).toMatchObject({
			success: false,
			error: 'You must provide a valid accessibility!',
		})

		// The name form is what the live client sends.
		const priv = await envOf(await putForm(path, { accessibility: 'Private' }, '1'))
		expect(priv.success).toBe(true)
		// The envelope carries the updated ROOM, so the client can re-render the subroom list.
		expect(priv.value).toMatchObject({ RoomId: 2 })
		expect(await accessibilityOf()).toBe(0)

		// Case-insensitive, and the later enum members resolve too.
		expect((await envOf(await putForm(path, { accessibility: 'dev_unlisted' }, '1'))).success).toBe(
			true
		)
		expect(await accessibilityOf()).toBe(4)

		// The ordinal still works.
		expect((await envOf(await putForm(path, { accessibility: '1' }, '1'))).success).toBe(true)
		expect(await accessibilityOf()).toBe(1)
	})

	// The permission table a room's creator saves on a subroom, and how it reaches the
	// client: `PUT …/permissions` stores entries keyed by (Permission, Role), and
	// `GET /photon_access_token` merges them over its defaults for whoever is standing in
	// that subroom. Room 2 / subroom 2 is owned by account 1; account 743 is the visitor
	// whose presence points at it.
	describe('subroom permissions', () => {
		type Permission = { Permission: string; Role: number; Override: boolean; Value: string }

		const putPermissions = async (path: string, body: unknown, sub?: string) =>
			SELF.fetch(`${ORIGIN}${path}`, {
				method: 'PUT',
				headers: { ...(sub ? await bearer(sub) : {}), 'Content-Type': 'application/json' },
				body: JSON.stringify(body),
			})

		// Put a player in an instance of the given subroom, then read the permission table
		// the client would apply when it spawns there.
		const permissionsIn = async (accountId: number, subRoomId: number): Promise<Permission[]> => {
			await env.DB.prepare('INSERT OR REPLACE INTO presence (data) VALUES (?1)')
				.bind(
					JSON.stringify({
						accountId,
						roomInstance: { roomInstanceId: 1000900 + subRoomId, roomId: 2, subRoomId },
						expiresAt: Math.floor(Date.now() / 1000) + 900,
					})
				)
				.run()
			const res = await SELF.fetch(`${ORIGIN}/photon_access_token`, {
				headers: await bearer(String(accountId)),
			})
			expect(res.status).toBe(200)
			return ((await res.json()) as { Permissions: Permission[] }).Permissions
		}

		const entry = (list: Permission[], permission: string, role: number) =>
			list.find((p) => p.Permission === permission && p.Role === role)

		it('is auth-gated and creator-only', async () => {
			const body = [
				{ Permission: 'CAN_SAVE_INVENTIONS', Role: 30, Override: false, Type: 0, Value: 'True' },
			]
			// No token → 401.
			expect((await putPermissions('/rooms/2/subrooms/2/permissions', body)).status).toBe(401)
			// A valid token that isn't the room's creator → 403.
			expect((await putPermissions('/rooms/2/subrooms/2/permissions', body, '999')).status).toBe(
				403
			)
			// Not even a co-owner: account 2 holds Role 30 on the seeded rooms. Co-owners may
			// build in a room but don't decide what a role may do.
			expect((await putPermissions('/rooms/2/subrooms/2/permissions', body, '2')).status).toBe(403)
			// Unknown room / unknown subroom → 404.
			expect((await putPermissions('/rooms/99999/subrooms/2/permissions', body, '1')).status).toBe(
				404
			)
			// A subroom id belonging to another room doesn't resolve either.
			expect((await putPermissions('/rooms/2/subrooms/9999/permissions', body, '1')).status).toBe(
				404
			)
		})

		it('answers an empty 200 — the client reads no body', async () => {
			const res = await putPermissions(
				'/rooms/2/subrooms/2/permissions',
				[{ Permission: 'CAN_SPAWN_INVENTIONS', Role: 30, Override: true, Type: 0, Value: 'True' }],
				'1'
			)
			expect(res.status).toBe(200)
			expect(await res.text()).toBe('')
		})

		it('a checked Override replaces the matching default in place', async () => {
			const before = await permissionsIn(743, 2)
			expect(before.length).toBe(11)
			const at = before.findIndex((p) => p.Permission === 'CAN_USE_MAKER_PEN' && p.Role === 30)
			// The default for this pair is an un-overridden grant.
			expect(before[at]).toMatchObject({ Override: false, Value: 'True' })

			expect(
				(
					await putPermissions(
						'/rooms/2/subrooms/2/permissions',
						[
							{
								Permission: 'CAN_USE_MAKER_PEN',
								Role: 30,
								Override: true,
								Type: 0,
								Value: 'False',
							},
						],
						'1'
					)
				).status
			).toBe(200)

			const after = await permissionsIn(743, 2)
			// Replaced, not appended — and at the same index, so the table doesn't reshuffle.
			expect(after.length).toBe(11)
			expect(after[at]).toMatchObject({
				Permission: 'CAN_USE_MAKER_PEN',
				Role: 30,
				Override: true,
				Value: 'False',
			})

			// Re-sending the same (Permission, Role) updates that entry rather than adding one.
			await putPermissions(
				'/rooms/2/subrooms/2/permissions',
				[{ Permission: 'CAN_USE_MAKER_PEN', Role: 30, Override: true, Type: 0, Value: 'True' }],
				'1'
			)
			const changed = await permissionsIn(743, 2)
			expect(changed.length).toBe(11)
			expect(changed[at]).toMatchObject({ Override: true, Value: 'True' })
		})

		it('an unchecked Override erases the entry, back to the default', async () => {
			const stored = async () =>
				(await env.DB.prepare(
					`SELECT COUNT(*) AS n FROM subroom_permission
					 WHERE sub_room_id = 2 AND permission = 'CAN_USE_MAKER_PEN' AND role = 30`
				).first<{ n: number }>())!.n

			// The previous test left this pair overridden.
			expect(await stored()).toBe(1)

			// `Override: false` means "fall back to the default" — the `Value` riding along is
			// not stored, it's whatever the picker happened to show.
			expect(
				(
					await putPermissions(
						'/rooms/2/subrooms/2/permissions',
						[
							{
								Permission: 'CAN_USE_MAKER_PEN',
								Role: 30,
								Override: false,
								Type: 0,
								Value: 'True',
							},
						],
						'1'
					)
				).status
			).toBe(200)

			// The row is gone, and the token serves the default for the pair again.
			expect(await stored()).toBe(0)
			const table = await permissionsIn(743, 2)
			expect(table.length).toBe(11)
			expect(entry(table, 'CAN_USE_MAKER_PEN', 30)).toMatchObject({
				Override: false,
				Value: 'True',
			})

			// Clearing a pair that was never overridden is a no-op, not an insert.
			await putPermissions(
				'/rooms/2/subrooms/2/permissions',
				[{ Permission: 'CAN_INVITE', Role: 0, Override: false, Type: 0, Value: 'True' }],
				'1'
			)
			expect((await permissionsIn(743, 2)).length).toBe(11)
		})

		it('appends a permission the defaults do not carry, and scopes it to its subroom', async () => {
			// CAN_INVITE is in none of the defaults, so it lands as a new entry.
			await putPermissions(
				'/rooms/2/subrooms/2/permissions',
				[{ Permission: 'CAN_INVITE', Role: 30, Override: true, Type: 0, Value: 'False' }],
				'1'
			)
			const inSubRoom2 = await permissionsIn(744, 2)
			expect(inSubRoom2.length).toBe(12)
			expect(entry(inSubRoom2, 'CAN_INVITE', 30)).toMatchObject({
				Override: true,
				Value: 'False',
			})

			// A different subroom is untouched — the table is per-subroom, not per-room.
			expect((await permissionsIn(744, 3)).length).toBe(11)
			// And so is a player in no instance at all.
			await env.DB.prepare('DELETE FROM presence WHERE account_id = ?1').bind(744).run()
			const lobby = await SELF.fetch(`${ORIGIN}/photon_access_token`, {
				headers: await bearer('744'),
			})
			expect(((await lobby.json()) as { Permissions: Permission[] }).Permissions.length).toBe(11)
		})

		it('keeps a Value that isn’t True/False verbatim', async () => {
			// Not every permission's UI is the True/False picker, so nothing interprets the
			// string — it goes to the client exactly as the creator set it.
			await putPermissions(
				'/rooms/2/subrooms/2/permissions',
				[{ Permission: 'MAX_SPAWNED_INVENTIONS', Role: 0, Override: true, Type: 0, Value: '25' }],
				'1'
			)
			expect(entry(await permissionsIn(747, 2), 'MAX_SPAWNED_INVENTIONS', 0)).toMatchObject({
				Override: true,
				Value: '25',
			})
		})

		it('applies over the dev accounts’ global maker pen, without listing a pair twice', async () => {
			await putPermissions(
				'/rooms/2/subrooms/2/permissions',
				[
					{ Permission: 'CAN_USE_MAKER_PEN', Role: 0, Override: true, Type: 0, Value: 'False' },
					// The third sample body — a Role 0 grant the defaults already carry.
					{
						Permission: 'CAN_USE_DELETE_ALL_BUTTON',
						Role: 0,
						Override: true,
						Type: 0,
						Value: 'True',
					},
				],
				'1'
			)
			// Account 3 is one of the hardcoded dev accounts, so it gets the global (Role 0)
			// maker pen prepended — which this subroom then revokes. The merge runs last and
			// replaces it in place, so the pair appears exactly ONCE: a table listing it twice
			// with two values would leave which one applies up to the client.
			const devTable = await permissionsIn(3, 2)
			expect(devTable.filter((p) => p.Permission === 'CAN_USE_MAKER_PEN' && p.Role === 0)).toEqual([
				{ Override: true, Permission: 'CAN_USE_MAKER_PEN', Role: 0, Type: 0, Value: 'False' },
			])
			expect(entry(devTable, 'CAN_USE_DELETE_ALL_BUTTON', 0)).toMatchObject({ Value: 'True' })

			// A normal player in the same subroom sees the same revocation.
			expect(entry(await permissionsIn(745, 2), 'CAN_USE_MAKER_PEN', 0)).toMatchObject({
				Value: 'False',
			})
		})

		it('a cloned subroom inherits the source’s permission table', async () => {
			const res = await SELF.fetch(`${ORIGIN}/rooms/2/subrooms/2/clone`, {
				method: 'POST',
				headers: await bearer('1'),
			})
			const room = (await res.json()) as { value: { SubRooms: Array<{ SubRoomId: number }> } }
			const cloneId = Math.max(...room.value.SubRooms.map((s) => s.SubRoomId))

			const inClone = await permissionsIn(746, cloneId)
			expect(entry(inClone, 'CAN_INVITE', 30)).toMatchObject({ Value: 'False' })
			expect(entry(inClone, 'CAN_USE_MAKER_PEN', 0)).toMatchObject({ Value: 'False' })
		})
	})

	it('POST /rooms/:id/subrooms/:sid/clone is auth-gated, owner-only, and copies the subroom', async () => {
		const clone = async (roomId: number, subRoomId: number, sub?: string) =>
			SELF.fetch(`${ORIGIN}/rooms/${roomId}/subrooms/${subRoomId}/clone`, {
				method: 'POST',
				headers: sub ? await bearer(sub) : {},
			})
		type SubRoom = { SubRoomId: number; CreatorAccountId: number }
		const envelope = async (res: Response) =>
			(await res.json()) as {
				success: boolean
				error: string
				value: { RoomId: number; SubRooms: SubRoom[] } | null
			}

		// No token → 401.
		expect((await clone(2, 2)).status).toBe(401)
		// Not the owner → success:false envelope.
		expect((await envelope(await clone(2, 2, '999'))).success).toBe(false)
		// Unknown subroom → success:false envelope.
		expect((await envelope(await clone(2, 9999, '1'))).success).toBe(false)

		const before = new Set(
			(
				(await (await SELF.fetch(`${ORIGIN}/rooms/2`)).json()) as { SubRooms: SubRoom[] }
			).SubRooms.map((s) => s.SubRoomId)
		)

		// Owner clones → success. `value` is the updated ROOM, not the new subroom, so the
		// clone shows up as one extra entry in its re-attached SubRooms list.
		const res = await clone(2, 2, '1')
		expect(res.status).toBe(200)
		const body = await envelope(res)
		expect(body.success).toBe(true)
		expect(body.value?.RoomId).toBe(2)
		const added = body.value!.SubRooms.filter((s) => !before.has(s.SubRoomId))
		expect(added).toHaveLength(1)
		expect(added[0]!.CreatorAccountId).toBe(1)
		// A fresh id, and fetchable as a subroom of the room.
		expect(added[0]!.SubRoomId).not.toBe(2)
		expect(await subRoomOf(2, added[0]!.SubRoomId)).toMatchObject({
			SubRoomId: added[0]!.SubRoomId,
		})
	})

	it('subroom clone mints a globally-unique SubRoomId (no cross-room clash)', async () => {
		// The old per-room `max(SubRoomId)+1` allocator would mint id 3 for room 2's clone —
		// colliding with another room that already owns subroom 3. The subroom table's
		// autoincrement mints an id above every existing subroom instead.
		const maxBefore = (await env.DB.prepare('SELECT MAX(sub_room_id) AS m FROM subroom').first<{
			m: number
		}>())!.m

		const res = await SELF.fetch(`${ORIGIN}/rooms/2/subrooms/2/clone`, {
			method: 'POST',
			headers: await bearer('1'),
		})
		// `value` is the updated room; the clone is its highest-numbered subroom.
		const body = (await res.json()) as {
			value: { RoomId: number; SubRooms: Array<{ SubRoomId: number }> }
		}
		const cloned = Math.max(...body.value.SubRooms.map((s) => s.SubRoomId))
		// Above every prior subroom id — a fresh global id, not a per-room collision.
		expect(cloned).toBeGreaterThan(maxBefore)
		expect(body.value.RoomId).toBe(2)

		// The id is unique across the whole table (exactly one row owns it).
		const dupes = (await env.DB.prepare('SELECT COUNT(*) AS n FROM subroom WHERE sub_room_id = ?1')
			.bind(cloned)
			.first<{ n: number }>())!.n
		expect(dupes).toBe(1)
	})

	it('POST /rooms/:id/subrooms creates a new subroom (auth-gated, owner-only, fresh id)', async () => {
		const create = async (roomId: number, name: string, sub?: string) =>
			SELF.fetch(`${ORIGIN}/rooms/${roomId}/subrooms`, {
				method: 'POST',
				headers: {
					...(sub ? await bearer(sub) : {}),
					'Content-Type': 'application/x-www-form-urlencoded',
				},
				body: new URLSearchParams({ name }).toString(),
			})
		type SubRoom = { SubRoomId: number; RoomId: number; Name: string; CreatorAccountId: number }
		const envelope = async (res: Response) =>
			(await res.json()) as {
				success: boolean
				// The whole room comes back on success (the client re-renders its subroom list).
				value: { RoomId: number; SubRooms: SubRoom[] } | null
			}

		// No token → 401.
		expect((await create(2, 'ffff')).status).toBe(401)
		// Valid token but not the owner → success:false envelope.
		expect((await envelope(await create(2, 'ffff', '999'))).success).toBe(false)
		// Blank name → success:false envelope.
		expect((await envelope(await create(2, '  ', '1'))).success).toBe(false)
		// Unknown room → success:false envelope.
		expect((await envelope(await create(99999, 'ffff', '1'))).success).toBe(false)

		const maxBefore = (await env.DB.prepare('SELECT MAX(sub_room_id) AS m FROM subroom').first<{
			m: number
		}>())!.m

		// Owner creates → success, and the returned room now embeds the new subroom: a fresh
		// global SubRoomId owned by the caller, named, and fetchable.
		const body = await envelope(await create(2, 'ffff', '1'))
		expect(body.success).toBe(true)
		expect(body.value?.RoomId).toBe(2)
		const created = body.value?.SubRooms.find((s) => s.Name === 'ffff')
		expect(created).toMatchObject({ RoomId: 2, Name: 'ffff', CreatorAccountId: 1 })
		expect(created!.SubRoomId).toBeGreaterThan(maxBefore)

		const fetched = (await subRoomOf(2, created!.SubRoomId)) as unknown as {
			SubRoomId: number
			Name: string
			UnitySceneId: string
		}
		expect(fetched).toMatchObject({ SubRoomId: created?.SubRoomId, Name: 'ffff' })

		// It inherits room 2's own existing (first) subroom scene.
		const roomScene = (
			JSON.parse(
				(await env.DB.prepare(
					'SELECT data FROM subroom WHERE room_id = 2 ORDER BY sub_room_id LIMIT 1'
				).first<{ data: string }>())!.data
			) as { UnitySceneId: string }
		).UnitySceneId
		expect(fetched.UnitySceneId).toBe(roomScene)
	})

	it('DELETE /rooms/:id/subrooms/:sid removes a subroom (auth-gated, owner-only, not the last)', async () => {
		const del = async (roomId: number, subRoomId: number, sub?: string) =>
			SELF.fetch(`${ORIGIN}/rooms/${roomId}/subrooms/${subRoomId}`, {
				method: 'DELETE',
				headers: sub ? await bearer(sub) : {},
			})
		type SubRoom = { SubRoomId: number; Name: string }
		const envelope = async (res: Response) =>
			(await res.json()) as { success: boolean; value: { SubRooms: SubRoom[] } | null }

		// Add a subroom to room 2 (which already has others), and capture its id by name.
		const created = (await (
			await SELF.fetch(`${ORIGIN}/rooms/2/subrooms`, {
				method: 'POST',
				headers: { ...(await bearer('1')), 'Content-Type': 'application/x-www-form-urlencoded' },
				body: new URLSearchParams({ name: 'ToDelete' }).toString(),
			})
		).json()) as { value: { SubRooms: SubRoom[] } }
		const newId = created.value.SubRooms.find((s) => s.Name === 'ToDelete')!.SubRoomId

		// No token → 401. Not the owner → success:false. Unknown subroom → success:false.
		expect((await del(2, newId)).status).toBe(401)
		expect((await envelope(await del(2, newId, '999'))).success).toBe(false)
		expect((await envelope(await del(2, 99999, '1'))).success).toBe(false)

		// Owner deletes → success, and the subroom is gone from the returned room + not fetchable.
		const body = await envelope(await del(2, newId, '1'))
		expect(body.success).toBe(true)
		expect(body.value?.SubRooms.some((s) => s.SubRoomId === newId)).toBe(false)
		expect(await subRoomOf(2, newId)).toBeUndefined()

		// A room's only subroom can't be deleted (would leave it with no scene). Seed a
		// dedicated single-subroom room owned by account 1 to exercise the guard.
		await seedRoomWithSubRooms(env.DB, {
			RoomId: 700,
			Name: 'SoloSubRoom',
			CreatorAccountId: 1,
			SubRooms: [{ SubRoomId: 900, UnitySceneId: 'x', MaxPlayers: 4 }],
		})
		expect((await envelope(await del(700, 900, '1'))).success).toBe(false)
		// The lone subroom survives the refused delete.
		expect(await subRoomOf(700, 900)).toBeDefined()
	})

	it('GET /rooms/:id/subrooms/:sid/saves pages the save history, newest first', async () => {
		type Page = {
			Results: Array<{ SubRoomId: number; SubRoomDataSaveId: number }>
			TotalResults: number
			TotalCount: number
		}
		const page = async (query: string) =>
			(await (
				await SELF.fetch(`${ORIGIN}/rooms/2/subrooms/2/saves${query}`, {
					headers: await bearer('1'),
				})
			).json()) as Page

		// Room 2's subroom is saved several times by the tests above — each save appended.
		const all = await page('?unityAssetTarget=0&unityAssetVersion=1')
		expect(all.Results.length).toBeGreaterThan(1)
		expect(all.Results.every((s) => s.SubRoomId === 2)).toBe(true)
		// Newest first: ids descend.
		const ids = all.Results.map((s) => s.SubRoomDataSaveId)
		expect([...ids].sort((a, b) => b - a)).toEqual(ids)
		// Both spellings of the count, and they agree with the list.
		expect(all.TotalResults).toBe(all.Results.length)
		expect(all.TotalCount).toBe(all.TotalResults)

		// skip/take actually page rather than being ignored.
		const paged = await page('?skip=1&take=1')
		expect(paged.Results).toHaveLength(1)
		expect(paged.Results[0]!.SubRoomDataSaveId).toBe(ids[1])
		expect(paged.TotalResults).toBe(all.TotalResults)

		// A never-saved subroom pages empty rather than 404ing.
		const empty = await SELF.fetch(`${ORIGIN}/rooms/3/subrooms/3/saves`, {
			headers: await bearer('1'),
		})
		expect(await empty.json()).toEqual({ Results: [], TotalResults: 0, TotalCount: 0 })

		// The list exposes unpublished saves, so it isn't public: no token → 401, and a
		// valid token from someone who is neither the creator nor in the room → 403. Account
		// 2 is a co-owner (Role 30 on the seeded rooms) and is refused too — holding a role
		// grants nothing here; being in the room does (see below).
		expect((await SELF.fetch(`${ORIGIN}/rooms/2/subrooms/2/saves`)).status).toBe(401)
		expect(
			(await SELF.fetch(`${ORIGIN}/rooms/2/subrooms/2/saves`, { headers: await bearer('999') }))
				.status
		).toBe(403)
		expect(
			(await SELF.fetch(`${ORIGIN}/rooms/2/subrooms/2/saves`, { headers: await bearer('2') }))
				.status
		).toBe(403)

		// …but a player standing IN the room reads it: the client resolves which version to
		// load from this list, so a visitor who can't read it can't load the instance.
		await putInRoom(999, 2)
		expect(
			(await SELF.fetch(`${ORIGIN}/rooms/2/subrooms/2/saves`, { headers: await bearer('999') }))
				.status
		).toBe(200)
		// Presence in a DIFFERENT room is not presence in this one.
		await putInRoom(999, 5)
		expect(
			(await SELF.fetch(`${ORIGIN}/rooms/2/subrooms/2/saves`, { headers: await bearer('999') }))
				.status
		).toBe(403)
		// And the grant lasts only as long as the presence does — an expired row reads as
		// absent, so the visitor is refused again the moment they leave.
		await putInRoom(999, 2, { expired: true })
		expect(
			(await SELF.fetch(`${ORIGIN}/rooms/2/subrooms/2/saves`, { headers: await bearer('999') }))
				.status
		).toBe(403)
		await clearPresence(999)
	})

	it('GET /rooms/:id/subrooms/:sid/saves/no_unity_assets lists the same history, lighter', async () => {
		const get = async (path: string, sub?: string) =>
			SELF.fetch(`${ORIGIN}${path}`, sub === undefined ? {} : { headers: await bearer(sub) })
		const light = '/rooms/2/subrooms/2/saves/no_unity_assets'

		const res = await get(light, '1')
		expect(res.status).toBe(200)
		const page = (await res.json()) as {
			Results: Array<Record<string, unknown>>
			TotalResults: number
			TotalCount: number
		}
		// The same history the full list serves — same rows, same order, same counts.
		const full = (await (await get('/rooms/2/subrooms/2/saves', '1')).json()) as {
			Results: Array<{ SubRoomDataSaveId: number; DataBlob: string }>
			TotalResults: number
		}
		expect(page.TotalResults).toBe(full.TotalResults)
		expect(page.TotalCount).toBe(page.TotalResults)
		expect(page.Results.map((r) => r.SubRoomDataSaveId)).toEqual(
			full.Results.map((r) => r.SubRoomDataSaveId)
		)

		// The lighter row: the Unity-asset PAYLOADS are gone (and `Tags` with them), the asset
		// IDs stay, and `UnityAssetId` is present-and-null rather than omitted.
		const row = page.Results[0]!
		expect(Object.keys(row)).toEqual([
			'SubRoomDataSaveId',
			'SubRoomId',
			'UnityAssetId',
			'ReferencedUnityAssetIds',
			'DataBlob',
			'DataBlobHash',
			'PersistenceVersion',
			'OMVersion',
			'SavedByAccountId',
			'SavedOnPlatform',
			'SavedOnDeviceClass',
			'Description',
			'ModerationState',
			'CreatedAt',
			'UgcSubVersion',
		])
		expect(row.UnityAssetId).toBe(null)
		expect(row.ReferencedUnityAssetIds).toEqual([])
		expect(row.SubRoomId).toBe(2)
		expect(row.DataBlob).toBe(full.Results[0]!.DataBlob)

		// skip/take page it the same way.
		const paged = (await (await get(`${light}?skip=1&take=1`, '1')).json()) as {
			Results: Array<{ SubRoomDataSaveId: number }>
			TotalResults: number
		}
		expect(paged.Results).toHaveLength(1)
		expect(paged.Results[0]!.SubRoomDataSaveId).toBe(full.Results[1]!.SubRoomDataSaveId)
		expect(paged.TotalResults).toBe(full.TotalResults)

		// A never-saved subroom pages empty rather than 404ing, as the full list does.
		expect(await (await get('/rooms/3/subrooms/3/saves/no_unity_assets', '1')).json()).toEqual({
			Results: [],
			TotalResults: 0,
			TotalCount: 0,
		})

		// Same gate as the list it mirrors — it exposes the same unpublished saves.
		expect((await get(light)).status).toBe(401)
		expect((await get(light, '999')).status).toBe(403)
		expect((await get(light, '2')).status).toBe(403)
		await putInRoom(999, 2)
		expect((await get(light, '999')).status).toBe(200)
		await clearPresence(999)
		expect((await get(light, '999')).status).toBe(403)
	})

	it('GET /rooms/:id/subrooms/:sid/saves/:saveId is the detail behind a history row', async () => {
		const get = async (path: string, sub?: string) =>
			SELF.fetch(`${ORIGIN}${path}`, sub === undefined ? {} : { headers: await bearer(sub) })

		// Pick a real save off the history the previous test paged.
		const list = (await (await get('/rooms/2/subrooms/2/saves', '1')).json()) as {
			Results: Array<{ SubRoomDataSaveId: number; DataBlob: string; Description: string }>
		}
		const row = list.Results[0]!

		const res = await get(`/rooms/2/subrooms/2/saves/${row.SubRoomDataSaveId}`, '1')
		expect(res.status).toBe(200)
		// The camelCase projection the room save returns — NOT the PascalCase row the list
		// serves. Same field set, exactly: no persistence/OM/UGC versions, no asset arrays.
		expect(await res.json()).toEqual({
			subRoomDataSaveId: row.SubRoomDataSaveId,
			subRoomId: 2,
			unityAssetId: null,
			unityAsset: null,
			unityAssetHash: null,
			dataBlob: row.DataBlob,
			dataBlobHash: null,
			savedByAccountId: expect.any(Number),
			savedOnPlatform: 0,
			savedOnDeviceClass: 0,
			description: row.Description,
			createdAt: expect.any(String),
		})

		// Unknown save, and a save that exists but belongs to ANOTHER subroom (ids are
		// global, so an unscoped lookup would happily resolve this one) — both 404.
		expect((await get('/rooms/2/subrooms/2/saves/99999', '1')).status).toBe(404)
		const foreign = (
			(await subRoomOf(5, 5)) as unknown as { CurrentSave: { SubRoomDataSaveId: number } }
		).CurrentSave.SubRoomDataSaveId
		expect((await get(`/rooms/2/subrooms/2/saves/${foreign}`, '1')).status).toBe(404)
		// …and it does resolve on its own subroom, so the 404 above is the scoping, not a
		// missing row.
		expect((await get(`/rooms/5/subrooms/5/saves/${foreign}`, '1')).status).toBe(200)

		// Unknown room or subroom is a 404 too (the LIST answers an empty page instead).
		expect((await get('/rooms/99999/subrooms/2/saves/1', '1')).status).toBe(404)
		expect((await get('/rooms/2/subrooms/99999/saves/1', '1')).status).toBe(404)

		// Same gate as the list it details: 401 unauthed, 403 for someone who is neither the
		// creator nor in the room (a co-owner included) — it reads unpublished saves.
		const detail = `/rooms/2/subrooms/2/saves/${row.SubRoomDataSaveId}`
		expect((await get(detail)).status).toBe(401)
		expect((await get(detail, '999')).status).toBe(403)
		expect((await get(detail, '2')).status).toBe(403)
		// A player standing in the room reads it, for as long as they're there.
		await putInRoom(999, 2)
		expect((await get(detail, '999')).status).toBe(200)
		await clearPresence(999)
		expect((await get(detail, '999')).status).toBe(403)
	})

	it('GET /openapi.json documents every route', async () => {
		const res = await SELF.fetch(`${ORIGIN}/openapi.json`)
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
			'DELETE /rooms/{roomId}',
			'DELETE /rooms/{roomId}/bans/{playerId}',
			'DELETE /rooms/{roomId}/interactionby/me/cheer',
			'DELETE /rooms/{roomId}/interactionby/me/favorite',
			'DELETE /rooms/{roomId}/subrooms/{subRoomId}',
			'GET /',
			'GET /Room_server/rooms/{roomId}/bans/{playerId}/isBanned',
			'GET /dormroom/me',
			'GET /featuredrooms/current',
			'GET /photon_access_token',
			'GET /publishState/configs',
			'GET /rooms',
			'GET /rooms/autocomplete_search',
			'GET /rooms/base',
			'GET /rooms/bulk',
			'GET /rooms/contributedby/me',
			'GET /rooms/createdby/me',
			'GET /rooms/favoritedby/me',
			'GET /rooms/hot',
			'GET /rooms/ownedby/me',
			'GET /rooms/ownedby/{accountId}',
			'GET /rooms/recommendations',
			'GET /rooms/search',
			'GET /rooms/visitedby/me',
			'GET /rooms/visitedby/{playerId}',
			'GET /rooms/{roomId}',
			'GET /rooms/{roomId}/bans',
			'GET /rooms/{roomId}/experience',
			'GET /rooms/{roomId}/experience/player',
			'GET /rooms/{roomId}/interactionby/me',
			'GET /rooms/{roomId}/playerdata/me',
			'GET /rooms/{roomId}/similar',
			'GET /rooms/{roomId}/subrooms/{subRoomId}/saves',
			'GET /rooms/{roomId}/subrooms/{subRoomId}/saves/no_unity_assets',
			'GET /rooms/{roomId}/subrooms/{subRoomId}/saves/{saveId}',
			'GET /roomserver/rooms/createdby/me',
			'POST /rooms/bulk',
			'POST /rooms/{roomId}/bans',
			'POST /rooms/{roomId}/clone',
			'POST /rooms/{roomId}/subrooms',
			'POST /rooms/{roomId}/subrooms/{subRoomId}/clone',
			'POST /rooms/{roomId}/subrooms/{subRoomId}/data',
			'POST /rooms/{roomId}/subrooms/{subRoomId}/publish_save',
			'PUT /rooms/{roomId}/accessibility',
			'PUT /rooms/{roomId}/cloning',
			'PUT /rooms/{roomId}/description',
			'PUT /rooms/{roomId}/image',
			'PUT /rooms/{roomId}/interactionby/me/cheer',
			'PUT /rooms/{roomId}/interactionby/me/favorite',
			'PUT /rooms/{roomId}/loadscreen',
			'PUT /rooms/{roomId}/name',
			'PUT /rooms/{roomId}/restrictions',
			'PUT /rooms/{roomId}/roles/{accountId}',
			'PUT /rooms/{roomId}/subrooms/{subRoomId}/accessibility',
			'PUT /rooms/{roomId}/subrooms/{subRoomId}/modify',
			'PUT /rooms/{roomId}/subrooms/{subRoomId}/permissions',
			'PUT /rooms/{roomId}/tags',
			'PUT /rooms/{roomId}/warning',
		])

		// Every operation carries a summary — a path present but undescribed is not
		// documentation.
		for (const ops of Object.values(spec.paths)) {
			for (const op of Object.values(ops)) expect(op.summary).toBeTruthy()
		}
	})
})

// Room and subroom names take letters, digits and underscores, at most 32 (see
// `roomNameRejection` in @repo/domain — usernames are held to the narrower rule, with no
// underscore). All four routes that take a player-supplied name enforce it, and each
// keeps its OWN refusal shape: the create
// paths answer the lowercase `{ success, error, value }` envelope, the two settings
// routes answer `{ Success, ErrorId, Error }` with the same `Rooms.InvalidName` id they
// already used for an empty name. The client keys off those, so the rule had to fit the
// existing shapes rather than introduce a fifth one.
//
// Names the SERVER generates are exempt on purpose — a dorm is `@<username>'s Dorm`,
// which this rule would reject. That's why the check lives in the handlers.
describe('room name validation', () => {
	const bad = ['My Room', 'punct!', 'a'.repeat(33)]

	const post = async (path: string, fields: Record<string, string>, sub: string) =>
		SELF.fetch(`${ORIGIN}${path}`, {
			method: 'POST',
			headers: { ...(await bearer(sub)), 'Content-Type': 'application/x-www-form-urlencoded' },
			body: new URLSearchParams(fields).toString(),
		})

	const put = async (path: string, fields: Record<string, string>, sub: string) =>
		SELF.fetch(`${ORIGIN}${path}`, {
			method: 'PUT',
			headers: { ...(await bearer(sub)), 'Content-Type': 'application/x-www-form-urlencoded' },
			body: new URLSearchParams(fields).toString(),
		})

	it('refuses a bad name when a player clones a room into existence', async () => {
		for (const name of bad) {
			const res = await post('/rooms/2/clone', { name }, '1')
			const body = (await res.json()) as { success: boolean; error: string; value: unknown }
			expect(body.success, name).toBe(false)
			expect(body.error).toMatch(/letters, numbers and underscores|at most 32 characters/)
			expect(body.value).toBeNull()
		}
	})

	it('refuses a bad name on rename, with the id the client already handles', async () => {
		for (const name of bad) {
			const res = await put('/rooms/2/name', { name }, '1')
			const body = (await res.json()) as { Success: boolean; ErrorId: string; Error: string }
			expect(body.Success, name).toBe(false)
			expect(body.ErrorId).toBe('Rooms.InvalidName')
			expect(body.Error).toMatch(/letters, numbers and underscores|at most 32 characters/)
		}

		// Unchanged: the refusals above never reached the write.
		const room = (await (await SELF.fetch(`${ORIGIN}/rooms/2`)).json()) as { Name: string }
		expect(room.Name).not.toMatch(/[^A-Za-z0-9_]/)
	})

	it('refuses a bad name when creating or modifying a subroom', async () => {
		for (const name of bad) {
			const created = await post('/rooms/2/subrooms', { name }, '1')
			const env1 = (await created.json()) as { success: boolean; error: string }
			expect(env1.success, name).toBe(false)
			expect(env1.error).toMatch(/letters, numbers and underscores|at most 32 characters/)

			const modified = await put(
				'/rooms/2/subrooms/2/modify',
				{ name, accessibility: '1', maxPlayers: '20' },
				'1'
			)
			const res2 = (await modified.json()) as { Success: boolean; ErrorId: string }
			expect(res2.Success, name).toBe(false)
			expect(res2.ErrorId).toBe('Rooms.InvalidName')
		}
	})

	it('accepts a 32-character name, and an underscore where a space is refused', async () => {
		for (const name of ['a'.repeat(32), 'Laser_Tag']) {
			const res = await post('/rooms/2/subrooms', { name }, '1')
			const body = (await res.json()) as {
				success: boolean
				value: { SubRooms: Array<{ Name: string }> }
			}
			expect(body.success, name).toBe(true)
			expect(body.value.SubRooms.some((s) => s.Name === name)).toBe(true)
		}
	})
})
