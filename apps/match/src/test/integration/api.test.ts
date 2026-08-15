import {
	adminSecretsStore,
	createExecutionContext,
	createScheduledController,
	env,
	waitOnExecutionContext,
} from 'cloudflare:test'
import { exports } from 'cloudflare:workers'
import { beforeAll, describe, expect, test } from 'vitest'

import {
	countPlayersInInstance,
	createRoomInstance,
	EMPTY_INSTANCE_GRACE_SECONDS,
	GAME_VERSION,
	getRoomInstance,
	PRESENCE_SCHEMA_DDL,
	ROOM_INSTANCE_SCHEMA_DDL,
	ROOM_SCHEMA_DDL,
	seedRoomWithSubRooms,
	SUBROOM_SCHEMA_DDL,
} from '@repo/domain'

import { SCHEMA_DDL as EVENTS_SCHEMA_DDL } from '../../../../api/src/events-db'
import {
	banFromReport,
	createReport,
	SCHEMA_DDL as REPORTS_SCHEMA_DDL,
} from '../../../../api/src/reports-db'
import { PLATFORM_SCHEMA_DDL } from '../../../../auth/src/platform-db'
import { scheduled } from '../../match.app'

import type { Env } from '../../context'

declare module 'cloudflare:test' {
	interface ProvidedEnv extends Env {}
}

const ORIGIN = 'https://example.com'

/** What a matchmake answers with when the request named no `CorrelationId`. */
const EMPTY_CORRELATION_ID = '00000000-0000-0000-0000-000000000000'

/**
 * A refused matchmake, whole: the code under both names the client reads (`result` and
 * the legacy `errorCode`, always equal), a null instance, and the correlation echo — an
 * empty GUID here, since these requests carry no `CorrelationId`. A refusal has to
 * correlate too, or the client goes on waiting for a response it never matches up.
 */
function refused(code: number) {
	return {
		errorCode: code,
		result: code,
		roomInstance: null,
		correlationId: EMPTY_CORRELATION_ID,
	}
}

// Matchmaking into a room resolves its real scene from the shared recflare D1.
// Seed the schema + a couple of rooms (matching the rooms worker's migration).
const RECCENTER_SCENE = 'cbad71af-0831-44d8-b8ef-69edafa841f6'
const SECOND_SUBROOM_SCENE = '3f0f6cd0-5c9f-42b2-9c07-2a5a2a1c9f11'
const TEST_ROOMS = [
	{
		RoomId: 1,
		Name: 'DormRoom',
		IsDorm: true,
		Accessibility: 2,
		SubRooms: [{ SubRoomId: 1, UnitySceneId: '76d98498-60a1-430c-ab76-b54a29b7a163' }],
	},
	{
		RoomId: 2,
		Name: 'RecCenter',
		IsDorm: false,
		Accessibility: 1,
		SubRooms: [{ SubRoomId: 2, UnitySceneId: RECCENTER_SCENE, MaxPlayers: 12 }],
	},
	{
		RoomId: 3,
		Name: 'TestersRoom',
		IsDorm: false,
		Accessibility: 1,
		CreatorAccountId: 42,
		// Account 43 is a co-owner (Role 30) — it may view the room's instances too.
		Roles: [{ AccountId: 43, Role: 30, LastChangedByAccountId: null, InvitedRole: 0 }],
		SubRooms: [{ SubRoomId: 3, UnitySceneId: RECCENTER_SCENE, MaxPlayers: 8 }],
	},
	{
		// A single-seat room so one player fills its instance (fullness tests).
		RoomId: 5,
		Name: 'SoloRoom',
		IsDorm: false,
		Accessibility: 1,
		SubRooms: [{ SubRoomId: 5, UnitySceneId: RECCENTER_SCENE, MaxPlayers: 1 }],
	},
	{
		// Two subrooms (separate scenes) — matchmaking into one must not land you in
		// the other.
		RoomId: 77,
		Name: 'MultiRoom',
		IsDorm: false,
		Accessibility: 1,
		SubRooms: [
			{ SubRoomId: 34, UnitySceneId: RECCENTER_SCENE, MaxPlayers: 10 },
			{ SubRoomId: 35, UnitySceneId: SECOND_SUBROOM_SCENE, MaxPlayers: 6 },
		],
	},
]

beforeAll(async () => {
	// Seed the shared JWT signing key into the local Secrets Store so .get() resolves.
	await adminSecretsStore(env.JWT_SECRET).create('test-signing-key')
	// The rooms worker's schema (room + interaction) — reading a room aggregates its
	// cheer/favorite Stats from `interaction`, so both tables have to be here.
	for (const stmt of ROOM_SCHEMA_DDL) await env.DB.prepare(stmt).run()
	// Subrooms live in their own table now; seed each room and split its subrooms into it.
	for (const stmt of SUBROOM_SCHEMA_DDL) await env.DB.prepare(stmt).run()
	for (const r of TEST_ROOMS) await seedRoomWithSubRooms(env.DB, r as Record<string, unknown>)
	// Room instances (owned by the rooms worker) — matchmaking finds/creates here.
	for (const stmt of ROOM_INSTANCE_SCHEMA_DDL) await env.DB.prepare(stmt).run()
	// Presence table (owned by the rooms worker) — written/read by matchmake + heartbeat.
	for (const stmt of PRESENCE_SCHEMA_DDL) await env.DB.prepare(stmt).run()

	// Accounts table (owned by the auth worker) — dorm creation reads the username
	// to name the room. Seed the players the dorm tests authenticate as.
	await env.DB.prepare(
		`CREATE TABLE IF NOT EXISTS account (
			data TEXT NOT NULL,
			account_id INTEGER GENERATED ALWAYS AS (json_extract(data, '$.accountId')) VIRTUAL
		)`
	).run()
	const insertAccount = env.DB.prepare('INSERT OR IGNORE INTO account (data) VALUES (?1)')
	await env.DB.batch([
		insertAccount.bind(JSON.stringify({ accountId: 42, username: 'Tester' })),
		insertAccount.bind(JSON.stringify({ accountId: 43, username: 'Roomie' })),
	])

	// Club tables (owned by the clubs worker) — matchmake/club reads the clubhouse
	// room and the caller's membership from them.
	await env.DB.prepare(
		`CREATE TABLE IF NOT EXISTS club (
			data TEXT NOT NULL,
			club_id INTEGER GENERATED ALWAYS AS (json_extract(data, '$.ClubId')) VIRTUAL
		)`
	).run()
	await env.DB.prepare(
		`CREATE TABLE IF NOT EXISTS club_member (
			club_member_id INTEGER PRIMARY KEY AUTOINCREMENT,
			club_id INTEGER NOT NULL,
			account_id INTEGER NOT NULL,
			membership_type INTEGER NOT NULL DEFAULT 0,
			created_at TEXT
		)`
	).run()
	const insertClub = env.DB.prepare('INSERT OR IGNORE INTO club (data) VALUES (?1)')
	await env.DB.batch([
		// Club 4 has room 2 as its clubhouse; club 5 has none set.
		insertClub.bind(JSON.stringify({ ClubId: 4, Name: 'Clubbers', ClubhouseRoomId: 2 })),
		insertClub.bind(JSON.stringify({ ClubId: 5, Name: 'Homeless', ClubhouseRoomId: null })),
	])
	const insertMember = env.DB.prepare(
		'INSERT INTO club_member (club_id, account_id, membership_type) VALUES (?1, ?2, ?3)'
	)
	await env.DB.batch([
		insertMember.bind(4, 120, 100), // creator
		insertMember.bind(4, 121, 10), // member
		insertMember.bind(4, 122, 1), // pending request — not a member yet
		insertMember.bind(4, 123, -1), // banned
		insertMember.bind(5, 120, 100),
	])

	// Player-event tables (owned by the api worker) — matchmake/event reads the event
	// for its room and the caller's invite row for access.
	for (const stmt of EVENTS_SCHEMA_DDL) await env.DB.prepare(stmt).run()
	const insertEvent = env.DB.prepare('INSERT OR IGNORE INTO event (data) VALUES (?1)')
	const event = (id: number, accessibility: number, extra?: Record<string, unknown>) =>
		JSON.stringify({
			PlayerEventId: id,
			CreatorPlayerId: 300,
			ImageName: null,
			RoomId: 2,
			SubRoomId: null,
			ClubId: null,
			Name: `Event ${id}`,
			Description: '',
			StartTime: '2020-11-29T22:00:00Z',
			EndTime: '2020-11-29T23:00:00Z',
			AttendeeCount: 1,
			State: 0,
			Accessibility: accessibility,
			IsMultiInstance: false,
			SupportMultiInstanceRoomChat: false,
			DefaultBroadcastPermissions: 0,
			CanRequestBroadcastPermissions: 0,
			...extra,
		})
	await env.DB.batch([
		insertEvent.bind(event(8, 0)), // private
		insertEvent.bind(event(9, 1)), // public
		insertEvent.bind(event(10, 2)), // unlisted — listings only, still joinable
		// A private one in the two-subroom room, pinning the SECOND subroom.
		insertEvent.bind(event(11, 0, { RoomId: 77, SubRoomId: 35 })),
	])
	const insertAttendee = env.DB.prepare(
		`INSERT INTO event_attendee (event_id, player_id, status, responded_at)
		 VALUES (?1, ?2, ?3, '2020-11-29T21:00:00Z')`
	)
	await env.DB.batch([
		insertAttendee.bind(8, 300, 0), // the creator, Going from create
		insertAttendee.bind(8, 301, 0), // invited
		insertAttendee.bind(8, 302, 2), // invited, but declined — still allowed in
		insertAttendee.bind(11, 301, 0),
	])

	// Relationship table (owned by the api worker) — matchmake reads it to push a
	// presence update to the player's friends. Seed friendships for player 9700.
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
		insertRel.bind(9700, 9701, 3), // friends (9700 requested) — friend is the target
		insertRel.bind(9702, 9700, 3), // friends (9702 requested) — friend is the requester
		insertRel.bind(9700, 9703, 1), // pending request out — 9703 is NOT a friend
	])

	// Report table (owned by the api worker) — an account-wide ban is a report row with
	// `banned` set, and every matchmake is refused for a player who has one.
	for (const stmt of REPORTS_SCHEMA_DDL) await env.DB.prepare(stmt).run()
	// Platform identity links (owned by the auth worker) — a ban also reaches the
	// accounts sharing a proven identity with the banned one.
	for (const stmt of PLATFORM_SCHEMA_DDL) await env.DB.prepare(stmt).run()
})

/**
 * Ban a player account-wide the way a moderator would: file a report against them and
 * convert it. `banExpires` null is a permanent ban.
 */
async function banAccount(playerId: number, banExpires: string | null = null): Promise<void> {
	const row = await createReport(env.DB, { reporterPlayerId: 1, reportedPlayerId: playerId })
	await banFromReport(env.DB, row.id, { banExpires })
}

// Mint a token the way the `auth` worker does, signing with the shared test key seeded into the JWT_SECRET store, so the
// match worker's validation accepts it. Kept inline to avoid a cross-package
// import.
const TEST_SECRET = 'test-signing-key'

function b64url(input: ArrayBuffer | string): string {
	const bytes = typeof input === 'string' ? new TextEncoder().encode(input) : new Uint8Array(input)
	let binary = ''
	for (const byte of bytes) binary += String.fromCharCode(byte)
	return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

// `version` mints the `rn.ver` claim auth stamps from the client's posted `ver`; left
// off, the token carries none — which is what a token issued before the claim carried the
// client's own build looks like to presence.
async function bearer(sub = '42', version?: string): Promise<Record<string, string>> {
	const now = Math.floor(Date.now() / 1000)
	const signingInput = `${b64url(JSON.stringify({ alg: 'HS256', typ: 'JWT' }))}.${b64url(
		JSON.stringify({ sub, exp: now + 3600, ...(version && { 'rn.ver': version }) })
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

describe('public endpoints', () => {
	test('POST /player/login returns 200', async () => {
		const res = await exports.default.fetch(`${ORIGIN}/player/login`, { method: 'POST' })
		expect(res.status).toBe(200)
	})

	test('POST /player/exclusivelogin returns { errorCode: 0 }', async () => {
		const res = await exports.default.fetch(`${ORIGIN}/player/exclusivelogin`, { method: 'POST' })
		expect(res.status).toBe(200)
		expect(await res.json()).toEqual({ errorCode: 0 })
	})

	test('POST /player/notifydisconnect returns 200', async () => {
		const res = await exports.default.fetch(`${ORIGIN}/player/notifydisconnect`, {
			method: 'POST',
			headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
			body: 'PlayerId=155&RoomInstanceId=1000001',
		})
		expect(res.status).toBe(200)
	})

	test('GET /player?id=N synthesizes a player payload for that id', async () => {
		const res = await exports.default.fetch(`${ORIGIN}/player?id=99`)
		expect(res.status).toBe(200)
		// The full presence shape the client deserializes — including the connection
		// fields, which only ever carry values in a matchmaking response.
		expect(await res.json()).toEqual([
			{
				appVersion: GAME_VERSION,
				deviceClass: 0,
				errorCode: 0,
				isOnline: false,
				playerId: 99,
				roomInstance: null,
				statusVisibility: 0,
				vrMovementMode: 1,
				platform: 0,
				photonAuthToken: null,
				photonRealtimeAppId: null,
				photonVoiceAppId: null,
				photonChatAppId: null,
				photonRegion: null,
				photonRoomId: null,
				voiceConnectionInfo: null,
				voiceServerId: null,
				experiments: null,
			},
		])
	})

	test('GET /player?id=&id= returns one payload per id, in order', async () => {
		const res = await exports.default.fetch(`${ORIGIN}/player?id=1070&id=1380`)
		const players = (await res.json()) as Array<{ playerId: number; isOnline: boolean }>
		expect(players.map((p) => p.playerId)).toEqual([1070, 1380])
		// Neither has presence → both offline.
		expect(players.every((p) => p.isOnline === false)).toBe(true)
	})

	test('GET /player without an id returns the default payload', async () => {
		const res = await exports.default.fetch(`${ORIGIN}/player`)
		expect(res.status).toBe(200)
		const players = (await res.json()) as Array<{ playerId: number; isOnline: boolean }>
		expect(players[0]).toMatchObject({ playerId: 1, isOnline: true, appVersion: GAME_VERSION })
	})

	// The "avoid juniors" preference lives in the playersettings KV map, not in presence.
	// The body is a BARE boolean — the client reads the whole body as the value.
	describe('GET /player/avoidjuniors', () => {
		const settings = async (playerId: number, map: Record<string, string>) =>
			env.RECFLARE_PLAYER_SETTINGS.put(`player:${playerId}`, JSON.stringify(map))

		const read = async (playerId: number) => {
			const res = await exports.default.fetch(`${ORIGIN}/player/avoidjuniors`, {
				headers: await bearer(String(playerId)),
			})
			expect(res.status).toBe(200)
			return res.json()
		}

		test('reads the stored setting', async () => {
			await settings(3100, { avoidJuniors: 'True', 'Recroom.OOBE': '77' })
			expect(await read(3100)).toBe(true)

			await settings(3101, { avoidJuniors: 'False' })
			expect(await read(3101)).toBe(false)
		})

		test('the key match ignores casing and separators', async () => {
			await settings(3102, { AVOID_JUNIORS: '1' })
			expect(await read(3102)).toBe(true)

			await settings(3103, { avoidjuniors: 'yes' })
			expect(await read(3103)).toBe(true)
		})

		// A player who never touched the setting, and one whose value is junk, both read
		// false — the read gates matchmaking, so it must not fail closed.
		test('defaults to false when unset or unparseable', async () => {
			expect(await read(3104)).toBe(false)

			await settings(3105, { 'Recroom.OOBE': '77' })
			expect(await read(3105)).toBe(false)

			await settings(3106, { avoidJuniors: 'maybe' })
			expect(await read(3106)).toBe(false)
		})

		test('is auth-gated', async () => {
			const res = await exports.default.fetch(`${ORIGIN}/player/avoidjuniors`)
			expect(res.status).toBe(401)
		})
	})

	describe('PUT /player/avoidjuniors', () => {
		const stored = async (playerId: number) =>
			env.RECFLARE_PLAYER_SETTINGS.get<Record<string, string>>(`player:${playerId}`, 'json')

		const write = async (playerId: number, body: string) => {
			const res = await exports.default.fetch(`${ORIGIN}/player/avoidjuniors`, {
				method: 'PUT',
				headers: {
					...(await bearer(String(playerId))),
					'Content-Type': 'application/x-www-form-urlencoded',
				},
				body,
			})
			expect(res.status).toBe(200)
			return res.json()
		}

		const read = async (playerId: number) => {
			const res = await exports.default.fetch(`${ORIGIN}/player/avoidjuniors`, {
				headers: await bearer(String(playerId)),
			})
			return res.json()
		}

		// The body the client posts. The response is the resulting value, and the GET agrees.
		test('stores the posted preference and answers it', async () => {
			expect(await write(3200, 'avoidJuniors=True')).toBe(true)
			expect(await read(3200)).toBe(true)

			expect(await write(3200, 'avoidJuniors=False')).toBe(false)
			expect(await read(3200)).toBe(false)
		})

		// The map holds every setting the player has, so the write must not replace it.
		test('merges into the player’s other settings', async () => {
			await env.RECFLARE_PLAYER_SETTINGS.put(
				'player:3201',
				JSON.stringify({ 'Recroom.OOBE': '77', TUTORIAL_COMPLETE_MASK: '11' })
			)
			await write(3201, 'avoidJuniors=True')
			expect(await stored(3201)).toEqual({
				'Recroom.OOBE': '77',
				TUTORIAL_COMPLETE_MASK: '11',
				avoidJuniors: 'True',
			})
		})

		// Whichever spelling the player's map already carries is the one overwritten —
		// two keys for one preference would make the read depend on their order.
		test('overwrites an existing key rather than adding a second one', async () => {
			await env.RECFLARE_PLAYER_SETTINGS.put(
				'player:3202',
				JSON.stringify({ AVOID_JUNIORS: 'True' })
			)
			expect(await write(3202, 'avoidJuniors=False')).toBe(false)
			expect(await stored(3202)).toEqual({ AVOID_JUNIORS: 'False' })
		})

		test('accepts a JSON body', async () => {
			const res = await exports.default.fetch(`${ORIGIN}/player/avoidjuniors`, {
				method: 'PUT',
				headers: {
					...(await bearer('3203')),
					'Content-Type': 'application/json',
				},
				body: JSON.stringify({ avoidJuniors: true }),
			})
			expect(res.status).toBe(200)
			expect(await res.json()).toBe(true)
			expect(await read(3203)).toBe(true)
		})

		// An unreadable body leaves the stored setting alone and answers it — a no-op 200,
		// not a 400 and not a write of `false`.
		test('a body with no readable value is a no-op', async () => {
			await write(3204, 'avoidJuniors=True')
			expect(await write(3204, 'avoidJuniors=maybe')).toBe(true)
			expect(await write(3204, '')).toBe(true)
			expect(await stored(3204)).toEqual({ avoidJuniors: 'True' })
		})

		test('is auth-gated', async () => {
			const res = await exports.default.fetch(`${ORIGIN}/player/avoidjuniors`, {
				method: 'PUT',
				headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
				body: 'avoidJuniors=True',
			})
			expect(res.status).toBe(401)
		})
	})

	test('POST /matchmake/room/:roomId resolves the room scene from D1', async () => {
		const headers = await bearer('88')
		const res = await exports.default.fetch(`${ORIGIN}/matchmake/room/2`, {
			method: 'POST',
			headers: { ...headers, 'Content-Type': 'application/x-www-form-urlencoded' },
			body: new URLSearchParams({ JoinMode: '2' }).toString(),
		})
		expect(res.status).toBe(200)
		const body = (await res.json()) as {
			errorCode: number
			roomInstance: { roomId: number; location: string; isPrivate: boolean; name: string }
		}
		expect(body.errorCode).toBe(0)
		expect(body.roomInstance).toMatchObject({
			roomId: 2,
			name: '^RecCenter',
			location: RECCENTER_SCENE,
			isPrivate: true,
		})
	})

	test('a matchmake counts a visit against the room', async () => {
		const visits = async (roomId: number): Promise<number> =>
			(await env.DB.prepare('SELECT visits FROM room WHERE room_id = ?1')
				.bind(roomId)
				.first<{ visits: number }>())!.visits
		const enter = async (path: string, player: string) => {
			const res = await exports.default.fetch(`${ORIGIN}${path}`, {
				method: 'POST',
				headers: {
					...(await bearer(player)),
					'Content-Type': 'application/x-www-form-urlencoded',
				},
				body: new URLSearchParams({ JoinMode: '2' }).toString(),
			})
			expect(res.status).toBe(200)
		}

		// Counted per matchmake, whichever route got the player there — the two-segment
		// room form and the subroom form both land in room 77.
		const before = await visits(77)
		await enter('/matchmake/room/77', '94')
		expect(await visits(77)).toBe(before + 1)
		await enter('/matchmake/room/77/35', '95')
		expect(await visits(77)).toBe(before + 2)

		// Same player entering again is another visit (VisitCount is visits, not visitors),
		// and it's the entered room that's counted — not every room.
		const otherBefore = await visits(2)
		await enter('/matchmake/room/77', '94')
		expect(await visits(77)).toBe(before + 3)
		expect(await visits(2)).toBe(otherBefore)

		// A refused matchmake counts nothing: an unknown room has no row to bump.
		const res = await exports.default.fetch(`${ORIGIN}/matchmake/room/99999`, {
			method: 'POST',
			headers: await bearer('96'),
		})
		expect(((await res.json()) as { errorCode: number }).errorCode).toBe(20)
	})

	test('POST /matchmake/room/:roomId seeds presence with the account device class', async () => {
		// A screen player (deviceClass 2, recorded by auth at login) matchmaking with no
		// live presence: without the account fallback they'd enter the room as deviceClass
		// 0 (VR) until their next heartbeat, and everyone in the room would see that.
		await env.DB.prepare('INSERT OR IGNORE INTO account (data) VALUES (?1)')
			.bind(JSON.stringify({ accountId: 55, username: 'Screenie', deviceClass: 2, platform: 0 }))
			.run()
		const headers = await bearer('55')
		const res = await exports.default.fetch(`${ORIGIN}/matchmake/room/2`, {
			method: 'POST',
			headers: { ...headers, 'Content-Type': 'application/x-www-form-urlencoded' },
			body: new URLSearchParams({ JoinMode: '2' }).toString(),
		})
		expect(res.status).toBe(200)

		const row = await env.DB.prepare('SELECT data FROM presence WHERE account_id = ?1')
			.bind(55)
			.first<{ data: string }>()
		const presence = JSON.parse(row!.data) as { deviceClass: number }
		expect(presence.deviceClass).toBe(2)
	})

	test('POST /matchmake/room/:roomId/:subRoomId enters that subroom', async () => {
		type Instance = {
			roomId: number
			subRoomId: number
			location: string
			maxCapacity: number
			roomInstanceId: number
		}
		const matchmake = async (path: string, sub: string): Promise<Instance> => {
			const res = await exports.default.fetch(`${ORIGIN}${path}`, {
				method: 'POST',
				headers: {
					...(await bearer(sub)),
					'Content-Type': 'application/x-www-form-urlencoded',
				},
				// The client's real body: JoinMode 0 (public) plus flags we ignore.
				body: 'BypassMovementModeRestriction=True&MaxPersistenceVersion=41&JoinMode=0&ClientJoinData=%7B%22WelcomeMatName%22%3A%22%22%7D&AdditionalPlayersAutoFollow=False',
			})
			expect(res.status).toBe(200)
			const body = (await res.json()) as { errorCode: number; roomInstance: Instance }
			expect(body.errorCode).toBe(0)
			return body.roomInstance
		}

		// Subroom 35 → that subroom's own scene and capacity, not the first subroom's.
		const second = await matchmake('/matchmake/room/77/35', '90')
		expect(second).toMatchObject({
			roomId: 77,
			subRoomId: 35,
			location: SECOND_SUBROOM_SCENE,
			maxCapacity: 6,
		})

		// A second player asking for the same subroom joins the same instance...
		const alsoSecond = await matchmake('/matchmake/room/77/35', '91')
		expect(alsoSecond.roomInstanceId).toBe(second.roomInstanceId)

		// ...but the other subroom is a separate place, with its own instance + scene.
		const first = await matchmake('/matchmake/room/77/34', '92')
		expect(first.roomInstanceId).not.toBe(second.roomInstanceId)
		expect(first).toMatchObject({ subRoomId: 34, location: RECCENTER_SCENE, maxCapacity: 10 })

		// An unknown subroom falls back to the room's first (its default entrance).
		const unknown = await matchmake('/matchmake/room/77/999', '93')
		expect(unknown).toMatchObject({ subRoomId: 34, location: RECCENTER_SCENE })
	})

	test('matchmaking serves the PUBLISHED save to everyone, creator included', async () => {
		// The client offers the owner "latest or published" itself, from the
		// `/subrooms/{id}/saves` list — matchmaking never picks. Serving a staged blob to
		// the creator here would put them on a different version to everyone else in the
		// same instance.
		const room = {
			RoomId: 78,
			Name: 'StagedRoom',
			IsDorm: false,
			Accessibility: 1,
			CreatorAccountId: 400,
			Roles: [{ AccountId: 401, Role: 30, LastChangedByAccountId: null, InvitedRole: 0 }],
			SubRooms: [
				{
					SubRoomId: 36,
					UnitySceneId: RECCENTER_SCENE,
					MaxPlayers: 10,
					// Seeded as the published save (seedRoomWithSubRooms mirrors the backfill).
					CurrentSave: { DataBlob: 'published.room' },
				},
			],
		}
		await seedRoomWithSubRooms(env.DB, room as unknown as Record<string, unknown>)
		// Stage a newer save the creator hasn't published.
		const staged = await env.DB.prepare(
			'INSERT INTO subroom_save (sub_room_id, data) VALUES (?1, ?2) RETURNING sub_room_data_save_id'
		)
			.bind(36, JSON.stringify({ DataBlob: 'staged.room' }))
			.first<{ sub_room_data_save_id: number }>()
		await env.DB.prepare('UPDATE subroom SET staged_save_id = ?2 WHERE sub_room_id = ?1')
			.bind(36, staged!.sub_room_data_save_id)
			.run()

		const matchmake = async (sub: string) => {
			const res = await exports.default.fetch(`${ORIGIN}/matchmake/room/78/36`, {
				method: 'POST',
				headers: {
					...(await bearer(sub)),
					'Content-Type': 'application/x-www-form-urlencoded',
				},
				body: 'JoinMode=0',
			})
			expect(res.status).toBe(200)
			return ((await res.json()) as { roomInstance: { dataBlob: string } }).roomInstance
		}

		// Creator, co-owner and ordinary player all land on the same published version —
		// having a newer staged save changes nothing here.
		expect((await matchmake('400')).dataBlob).toBe('published.room')
		expect((await matchmake('401')).dataBlob).toBe('published.room')
		expect((await matchmake('402')).dataBlob).toBe('published.room')
	})

	test('POST /matchmake/club/:clubId places members into the clubhouse', async () => {
		const matchmake = async (path: string, sub?: string) =>
			exports.default.fetch(`${ORIGIN}${path}`, {
				method: 'POST',
				headers: {
					...(sub === undefined ? {} : await bearer(sub)),
					'Content-Type': 'application/x-www-form-urlencoded',
				},
				body: 'JoinMode=0',
			})
		type Body = {
			errorCode: number
			roomInstance: { roomId: number; location: string; roomInstanceId: number } | null
		}

		// A member lands in an instance of the club's clubhouse (room 2)...
		const res = await matchmake('/matchmake/club/4', '121')
		expect(res.status).toBe(200)
		const body = (await res.json()) as Body
		expect(body.errorCode).toBe(0)
		expect(body.roomInstance).toMatchObject({ roomId: 2, location: RECCENTER_SCENE })

		// ...and it's recorded as their presence, like any other matchmake.
		const row = await env.DB.prepare('SELECT data FROM presence WHERE account_id = ?1')
			.bind(121)
			.first<{ data: string }>()
		const presence = JSON.parse(row!.data) as { roomInstance: { roomInstanceId: number } }
		expect(presence.roomInstance.roomInstanceId).toBe(body.roomInstance!.roomInstanceId)

		// The creator is a member too, and joins the same public instance.
		const creator = (await (await matchmake('/matchmake/club/4', '120')).json()) as Body
		expect(creator.roomInstance?.roomInstanceId).toBe(body.roomInstance!.roomInstanceId)

		// Everyone who isn't a member is turned away with the same answer: a non-member,
		// a pending request, a banned account, a club with no clubhouse, an unknown club.
		for (const [path, sub] of [
			['/matchmake/club/4', '199'],
			['/matchmake/club/4', '122'],
			['/matchmake/club/4', '123'],
			['/matchmake/club/5', '120'],
			['/matchmake/club/9999', '120'],
		] as const) {
			expect(await (await matchmake(path, sub)).json()).toEqual(refused(20))
		}

		// Signed out is a 401, not a matchmaking error.
		expect((await matchmake('/matchmake/club/4')).status).toBe(401)
	})

	test('POST /matchmake/event/:eventId gates a private event on the invite list', async () => {
		const matchmake = async (path: string, sub?: string) =>
			exports.default.fetch(`${ORIGIN}${path}`, {
				method: 'POST',
				headers: {
					...(sub === undefined ? {} : await bearer(sub)),
					'Content-Type': 'application/x-www-form-urlencoded',
				},
				body: 'JoinMode=0',
			})
		type Body = {
			errorCode: number
			roomInstance: { roomId: number; location: string; roomInstanceId: number } | null
		}
		const join = async (path: string, sub?: string) =>
			(await (await matchmake(path, sub)).json()) as Body

		// An invited player lands in an instance of the event's room (2)...
		const invited = await join('/matchmake/event/8', '301')
		expect(invited.errorCode).toBe(0)
		expect(invited.roomInstance).toMatchObject({ roomId: 2, location: RECCENTER_SCENE })

		// ...recorded as their presence, like any other matchmake.
		const row = await env.DB.prepare('SELECT data FROM presence WHERE account_id = ?1')
			.bind(301)
			.first<{ data: string }>()
		const presence = JSON.parse(row!.data) as { roomInstance: { roomInstanceId: number } }
		expect(presence.roomInstance.roomInstanceId).toBe(invited.roomInstance!.roomInstanceId)

		// The creator gets in, and so does someone who was invited and DECLINED — the row
		// is the invite, whatever the answer.
		expect((await join('/matchmake/event/8', '300')).errorCode).toBe(0)
		expect((await join('/matchmake/event/8', '302')).errorCode).toBe(0)

		// A stranger doesn't — and is told why (35 EventIsPrivate), not fobbed off with 20.
		expect(await join('/matchmake/event/8', '399')).toEqual(refused(35))

		// Public and unlisted are open to anyone: unlisted only keeps an event out of the
		// listings, it doesn't close it.
		expect((await join('/matchmake/event/9', '399')).errorCode).toBe(0)
		expect((await join('/matchmake/event/10', '399')).errorCode).toBe(0)

		// An unknown event is the opaque NoSuchRoom, so ids can't be probed.
		expect(await join('/matchmake/event/9999', '399')).toEqual(refused(20))

		// Signed out is a 401, not a matchmaking error.
		expect((await matchmake('/matchmake/event/9')).status).toBe(401)
	})

	test('POST /matchmake/event/:eventId enters the subroom the event pins', async () => {
		const res = await exports.default.fetch(`${ORIGIN}/matchmake/event/11`, {
			method: 'POST',
			headers: { ...(await bearer('301')), 'Content-Type': 'application/x-www-form-urlencoded' },
			body: 'JoinMode=0',
		})
		const body = (await res.json()) as {
			errorCode: number
			roomInstance: { roomId: number; subRoomId: number; location: string } | null
		}
		// Room 77's SECOND subroom (35), not its first — the event pins the scene.
		expect(body.errorCode).toBe(0)
		expect(body.roomInstance).toMatchObject({
			roomId: 77,
			subRoomId: 35,
			location: SECOND_SUBROOM_SCENE,
		})
	})

	test('POST /matchmake/room/:roomId returns NoSuchRoom for an unknown room', async () => {
		const res = await exports.default.fetch(`${ORIGIN}/matchmake/room/99999`, {
			method: 'POST',
			headers: await bearer('88'),
		})
		expect(res.status).toBe(200)
		expect(await res.json()).toEqual(refused(20))
	})

	test('ROOM_REDIRECTS switches a matchmake out to another room', async () => {
		// `env` is shared by every test in this file, so restore the knob in `finally`.
		const original = env.ROOM_REDIRECTS
		const matchmake = async (path: string, player: string) =>
			(await (
				await exports.default.fetch(`${ORIGIN}${path}`, {
					method: 'POST',
					headers: {
						...(await bearer(player)),
						'Content-Type': 'application/x-www-form-urlencoded',
					},
					// Private, so each call gets a fresh instance of whatever room it landed in.
					body: new URLSearchParams({ JoinMode: '2' }).toString(),
				})
			).json()) as {
				errorCode: number
				roomInstance: { roomId: number; subRoomId: number; location: string; name: string } | null
			}

		try {
			env.ROOM_REDIRECTS = '2=MultiRoom'
			// The room asked for is never entered; the substitute is, scene and all.
			expect((await matchmake('/matchmake/room/2', '8801')).roomInstance).toMatchObject({
				roomId: 77,
				name: '^MultiRoom',
				location: RECCENTER_SCENE,
			})
			// Matched on the resolved room, not the path segment, so the name spelling of the
			// same room is substituted too.
			expect((await matchmake('/matchmake/room/RecCenter', '8802')).roomInstance).toMatchObject({
				roomId: 77,
			})
			// The requested subroom is dropped — 35 is a subroom of the substitute, not of the
			// room asked for — so entry falls back to the substitute's default subroom (34).
			expect((await matchmake('/matchmake/room/2/35', '8803')).roomInstance).toMatchObject({
				roomId: 77,
				subRoomId: 34,
				location: RECCENTER_SCENE,
			})
			// Club 4's clubhouse is room 2, and it resolves through the same path: a
			// substituted room is substituted wherever a matchmake names it.
			expect((await matchmake('/matchmake/club/4', '121')).roomInstance).toMatchObject({
				roomId: 77,
			})

			// Targeting by id works the same, and substitution is a single hop: 2 and 77
			// swap rather than bouncing between each other.
			env.ROOM_REDIRECTS = '2=77,77=2'
			expect((await matchmake('/matchmake/room/2', '8804')).roomInstance).toMatchObject({
				roomId: 77,
			})
			expect((await matchmake('/matchmake/room/77', '8805')).roomInstance).toMatchObject({
				roomId: 2,
			})

			// A target that doesn't resolve leaves the requested room in place — a typo'd
			// knob must not make the room unreachable.
			env.ROOM_REDIRECTS = '2=NoSuchRoomHere'
			expect((await matchmake('/matchmake/room/2', '8806')).roomInstance).toMatchObject({
				roomId: 2,
			})

			// Unset: everyone enters the room they asked for.
			env.ROOM_REDIRECTS = undefined
			expect((await matchmake('/matchmake/room/2', '8807')).roomInstance).toMatchObject({
				roomId: 2,
				name: '^RecCenter',
			})
		} finally {
			env.ROOM_REDIRECTS = original
		}
	})

	test('PUT /player/statusvisibility returns 200', async () => {
		const res = await exports.default.fetch(`${ORIGIN}/player/statusvisibility`, { method: 'PUT' })
		expect(res.status).toBe(200)
	})

	test('GET /player/connection-info 401s without a token', async () => {
		const res = await exports.default.fetch(`${ORIGIN}/player/connection-info`)
		expect(res.status).toBe(401)
	})

	test('GET /player/qos returns the probe targets', async () => {
		const res = await exports.default.fetch(`${ORIGIN}/player/qos`)
		expect(res.status).toBe(200)
		// A bare array, not the { success, value, error } envelope connection-info uses.
		expect(await res.json()).toEqual([
			{ id: 'us-west1', address: '34.169.254.144:50000' },
			{ id: 'europe-west1', address: '35.205.141.119:50000' },
			{ id: 'asia-northeast1', address: '35.200.67.228:50000' },
			{ id: 'us-east1', address: '34.73.244.122:50000' },
			{ id: 'us-central1', address: '34.69.179.51:50000' },
			{ id: 'northamerica-northeast1', address: '34.152.4.100:50000' },
		])
	})

	test('PUT /player/photonregionpings returns 200', async () => {
		const res = await exports.default.fetch(`${ORIGIN}/player/photonregionpings`, { method: 'PUT' })
		expect(res.status).toBe(200)
	})

	test('POST /roominstance/:id/reportjoinresult returns 200', async () => {
		const res = await exports.default.fetch(`${ORIGIN}/roominstance/5/reportjoinresult`, {
			method: 'POST',
		})
		expect(res.status).toBe(200)
	})
})

describe('auth-gated endpoints', () => {
	test('POST /matchmake/room/:roomId reuses a public instance across players; a private one is fresh', async () => {
		const matchmake = async (sub: string, joinMode?: string) =>
			(await (
				await exports.default.fetch(`${ORIGIN}/matchmake/room/2`, {
					method: 'POST',
					headers: {
						...(await bearer(sub)),
						'Content-Type': 'application/x-www-form-urlencoded',
					},
					body: joinMode ? new URLSearchParams({ JoinMode: joinMode }).toString() : undefined,
				})
			).json()) as { roomInstance: { photonRoomId: string; roomInstanceId: number } }

		// Two *different* players matchmaking into the same room share the reused
		// instance (population grouping). Distinct accounts here, since re-matchmaking as
		// the *same* player deliberately moves them to a fresh instance — see below.
		const a = await matchmake('900')
		const b = await matchmake('901')
		expect(a.roomInstance.photonRoomId).toMatch(/^[0-9a-f-]{36}$/)
		expect(b.roomInstance.photonRoomId).toBe(a.roomInstance.photonRoomId)
		expect(b.roomInstance.roomInstanceId).toBe(a.roomInstance.roomInstanceId)

		// A private matchmake (JoinMode 2) gets its own distinct instance.
		const priv = await matchmake('902', '2')
		expect(priv.roomInstance.photonRoomId).not.toBe(a.roomInstance.photonRoomId)
	})

	test('GET /player/connection-info hands back the Photon room the caller matchmade into', async () => {
		const matchmaked = (await (
			await exports.default.fetch(`${ORIGIN}/matchmake/room/2`, {
				method: 'POST',
				headers: await bearer('960'),
			})
		).json()) as { roomInstance: { photonRoomId: string } }

		const res = await exports.default.fetch(`${ORIGIN}/player/connection-info`, {
			headers: await bearer('960'),
		})
		expect(res.status).toBe(200)
		expect(await res.json()).toEqual({
			success: true,
			value: {
				// A signed JWT, not an opaque id — three base64url segments.
				photonAuthToken: expect.stringMatching(/^[\w-]+\.[\w-]+\.[\w-]+$/),
				photonRealtimeAppId: '8f322bdb-2b1f-4c27-a232-01436f43d14e',
				photonVoiceAppId: '6b4682e1-a1a9-4e04-b44a-6db0049a4df3',
				photonChatAppId: '55fae86e-0459-4f97-bf6c-39c9341da6ef',
				// Matches the region every room instance is stamped with.
				photonRegion: 'us',
				// The room the client is told to join has to be the one matchmaking placed
				// them in, or they end up alone in a room of their own.
				photonRoomId: matchmaked.roomInstance.photonRoomId,
				// Empty strings, not nulls — unlike the presence payload's connection fields,
				// which stay null (they never carry credentials).
				voiceConnectionInfo: '',
				voiceServerId: '',
				experiments: {
					networkTransformSyncInterval: 10,
					shouldUseUnreliableOnChange: false,
					shouldAvoidDiscontinuityRPCs: true,
					shouldAvoidRedundantDiscontinuity: false,
					r2RuntimeStaticBaking: true,
					r2AutoEmbodiment: true,
					r2RuntimeStaticBakingMinShapeThreshold: 1,
					r2UseCheapReplicas: true,
					// true would send the client to a local game server instead of Photon.
					shouldUseGameServerNetworking: false,
				},
			},
			error: null,
		})
	})

	test('GET /player/connection-info mints a token carrying the caller’s id', async () => {
		const res = await exports.default.fetch(`${ORIGIN}/player/connection-info`, {
			headers: await bearer('961'),
		})
		const body = (await res.json()) as {
			value: { photonAuthToken: string; photonRealtimeAppId: string }
		}
		const claims = JSON.parse(atob(body.value.photonAuthToken.split('.')[1]!)) as {
			sub: string
			aud: string
			exp: number
			'rn.env': string
		}
		expect(claims.sub).toBe('961')
		// Scoped to the realtime app the same response hands out. Asserted as agreement
		// rather than a pinned literal: PHOTON_APPS is hardcoded until it moves to wrangler
		// vars, and a token minted for a different app than the client is handed is the bug
		// worth catching here.
		expect(claims.aud).toBe(body.value.photonRealtimeAppId)
		expect(claims.exp).toBeGreaterThan(Math.floor(Date.now() / 1000))
		// The client is built against prod regardless of which environment we run in.
		expect(claims['rn.env']).toBe('prod')
	})

	test('GET /player/connection-info falls back to ?roomInstanceId when presence has no room', async () => {
		// Player 962 never matchmade, so there's no presence to read the room from; the
		// param names the instance they're trying to connect to.
		const instance = await createRoomInstance(env.DB, {
			roomId: 2,
			subRoomId: 2,
			roomInstanceType: 0,
			photonRoomId: 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee',
			maxCapacity: 12,
			isPrivate: false,
			ownerAccountId: 962,
		})

		const res = await exports.default.fetch(
			`${ORIGIN}/player/connection-info?roomInstanceId=${instance.roomInstanceId}`,
			{ headers: await bearer('962') }
		)
		expect(res.status).toBe(200)
		const body = (await res.json()) as { value: { photonRoomId: string } }
		expect(body.value.photonRoomId).toBe('aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee')
	})

	test('GET /player/connection-info serves an empty photonRoomId when nothing resolves', async () => {
		const res = await exports.default.fetch(`${ORIGIN}/player/connection-info`, {
			headers: await bearer('963'),
		})
		const body = (await res.json()) as { value: { photonRoomId: string } }
		expect(body.value.photonRoomId).toBe('')
	})

	test('re-matchmaking into your current room returns a different instance (id must change)', async () => {
		// The client keys the room transition off a changing roomInstanceId; handing back
		// the instance the player is already in hangs their join. RecCenter (cap 12) so
		// the instance isn't full — the naive "reuse the oldest joinable" would otherwise
		// return the same id the player already has.
		const first = await matchmakeInto('2', '950')
		const second = await matchmakeInto('2', '950')
		expect(second).not.toBe(first)
	})

	test('POST /matchmake/dorm 401s without a token', async () => {
		const res = await exports.default.fetch(`${ORIGIN}/matchmake/dorm`, { method: 'POST' })
		expect(res.status).toBe(401)
	})

	test('POST /matchmake/dorm returns the same personal dorm (idempotent)', async () => {
		// First entry (fresh account 43) creates the dorm; a second returns the same one.
		const first = (await (
			await exports.default.fetch(`${ORIGIN}/matchmake/dorm`, {
				method: 'POST',
				headers: await bearer('43'),
			})
		).json()) as { roomInstance: { roomId: number; photonRoomId: string; roomInstanceId: number } }
		expect(first.roomInstance.roomId).toBeGreaterThan(2)

		const res = await exports.default.fetch(`${ORIGIN}/matchmake/dorm`, {
			method: 'POST',
			headers: await bearer('43'),
		})
		expect(res.status).toBe(200)
		const body = (await res.json()) as {
			errorCode: number
			roomInstance: {
				name: string
				location: string
				isPrivate: boolean
				roomId: number
				photonRoomId: string
				roomInstanceId: number
			}
		}
		expect(body.errorCode).toBe(0)
		expect(body.roomInstance).toMatchObject({
			name: "@Roomie's Dorm",
			location: '76d98498-60a1-430c-ab76-b54a29b7a163',
			isPrivate: true,
			// Same dorm room + reused instance (stable id + Photon room), not a new one.
			roomId: first.roomInstance.roomId,
			photonRoomId: first.roomInstance.photonRoomId,
			roomInstanceId: first.roomInstance.roomInstanceId,
		})
	})

	test('a matchmake echoes the request’s CorrelationId (and mirrors errorCode as result)', async () => {
		// The client tags each attempt with a GUID and won't accept a session whose
		// response doesn't carry the same one back ("Unable to connect to game session").
		const correlationId = 'b71abbbb-93e1-4d67-94da-64e6f554863a'
		const dorm = (await (
			await exports.default.fetch(`${ORIGIN}/matchmake/dorm`, {
				method: 'POST',
				headers: {
					...(await bearer('43')),
					'content-type': 'application/x-www-form-urlencoded',
				},
				// Verbatim from the client, unread fields included.
				body: `BypassMovementModeRestriction=False&LoginLock=40bacd8f-7c60-4d49-93f9-462b096602de&VoiceServerVersion=gameserver-2&CorrelationId=${correlationId}&MaxPersistenceVersion=227`,
			})
		).json()) as { errorCode: number; result: number; correlationId: string }
		expect(dorm.correlationId).toBe(correlationId)
		// Both names for the one code, always in agreement.
		expect(dorm.result).toBe(0)
		expect(dorm.errorCode).toBe(0)

		// A room matchmake echoes it too, and so does a refusal — a refused attempt the
		// client can't correlate is one it goes on waiting for.
		const room = (await (
			await exports.default.fetch(`${ORIGIN}/matchmake/room/999999`, {
				method: 'POST',
				headers: {
					...(await bearer('43')),
					'content-type': 'application/x-www-form-urlencoded',
				},
				body: `JoinMode=0&CorrelationId=${correlationId}`,
			})
		).json()) as { errorCode: number; result: number; roomInstance: null; correlationId: string }
		expect(room).toEqual({
			errorCode: 20,
			result: 20,
			roomInstance: null,
			correlationId,
		})
	})

	test('a matchmake with no CorrelationId answers the empty GUID, not null', async () => {
		// The client reads correlationId as a Guid, not a nullable one — an older client
		// that sends none still has to get a parseable value back.
		const body = (await (
			await exports.default.fetch(`${ORIGIN}/matchmake/dorm`, {
				method: 'POST',
				headers: await bearer('43'),
			})
		).json()) as { correlationId: string }
		expect(body.correlationId).toBe(EMPTY_CORRELATION_ID)
	})

	test('POST /matchmake/none 401s without a token', async () => {
		const res = await exports.default.fetch(`${ORIGIN}/matchmake/none`, { method: 'POST' })
		expect(res.status).toBe(401)
	})

	test('POST /matchmake/none keeps the caller where they are, else falls back to the dorm', async () => {
		const none = async (sub: string) =>
			(await (
				await exports.default.fetch(`${ORIGIN}/matchmake/none`, {
					method: 'POST',
					headers: await bearer(sub),
				})
			).json()) as { errorCode: number; roomInstance: { roomId: number; roomInstanceId: number } }

		// Account 44 has never entered a room → their personal dorm, and a second call is
		// idempotent now that presence holds it.
		const fresh = await none('44')
		expect(fresh.errorCode).toBe(0)
		expect(fresh.roomInstance.roomId).toBeGreaterThan(2)
		expect((await none('44')).roomInstance).toMatchObject({
			roomId: fresh.roomInstance.roomId,
			roomInstanceId: fresh.roomInstance.roomInstanceId,
		})

		// Once in a real room, `none` must NOT warp them out of it — that is the whole
		// point of the endpoint, since the client posts it while sitting in Orientation.
		const entered = (await (
			await exports.default.fetch(`${ORIGIN}/matchmake/room/2`, {
				method: 'POST',
				headers: await bearer('44'),
			})
		).json()) as { roomInstance: { roomId: number; roomInstanceId: number } }
		expect(entered.roomInstance.roomId).toBe(2)
		expect((await none('44')).roomInstance).toMatchObject({
			roomId: 2,
			roomInstanceId: entered.roomInstance.roomInstanceId,
		})
	})

	test('each player’s dorm gets a distinct global subroom id', async () => {
		// Dorms used to copy the template subroom verbatim, so every dorm carried SubRoomId 1.
		// With subrooms minted from the global sequence, each dorm gets its own unique id.
		const dormSubRoomId = async (sub: string): Promise<number> => {
			const body = (await (
				await exports.default.fetch(`${ORIGIN}/matchmake/dorm`, {
					method: 'POST',
					headers: await bearer(sub),
				})
			).json()) as { roomInstance: { subRoomId: number } }
			return body.roomInstance.subRoomId
		}
		const a = await dormSubRoomId('7001')
		const b = await dormSubRoomId('7002')
		expect(a).not.toBe(b)
		// Neither reuses the seed dorm template's SubRoomId (1).
		expect(a).not.toBe(1)
		expect(b).not.toBe(1)
	})

	test('POST /matchmake/room/:roomId resolves a room by name from D1', async () => {
		const res = await exports.default.fetch(`${ORIGIN}/matchmake/room/RecCenter`, {
			method: 'POST',
			headers: { ...(await bearer()), 'Content-Type': 'application/x-www-form-urlencoded' },
			body: new URLSearchParams({ JoinMode: '2' }).toString(),
		})
		expect(res.status).toBe(200)
		const body = (await res.json()) as {
			roomInstance: { roomId: number; name: string; location: string; isPrivate: boolean }
		}
		expect(body.roomInstance).toMatchObject({
			roomId: 2,
			name: '^RecCenter',
			location: RECCENTER_SCENE,
			isPrivate: true,
		})
	})

	test('POST /player/heartbeat 401s without a token', async () => {
		const res = await exports.default.fetch(`${ORIGIN}/player/heartbeat`, { method: 'POST' })
		expect(res.status).toBe(401)
	})

	test('POST /player/heartbeat reports no presence before matchmake', async () => {
		// Fresh token (sub 7) with no stored presence → not in a room.
		const res = await exports.default.fetch(`${ORIGIN}/player/heartbeat`, {
			method: 'POST',
			headers: { ...(await bearer('7')), 'Content-Type': 'application/json' },
			body: JSON.stringify({ statusVisibility: 2, platform: 5 }),
		})
		expect(res.status).toBe(200)
		expect(await res.json()).toMatchObject({
			playerId: 7,
			roomInstance: null,
			isOnline: false,
		})
	})

	test('matchmake then heartbeat replays the stored instance (in sync)', async () => {
		const headers = await bearer()
		const mm = (await (
			await exports.default.fetch(`${ORIGIN}/matchmake/dorm`, { method: 'POST', headers })
		).json()) as { roomInstance: Record<string, unknown> }
		// LoginLock form heartbeat (no presence fields) still gets the stored room.
		const hb = (await (
			await exports.default.fetch(`${ORIGIN}/player/heartbeat`, {
				method: 'POST',
				headers: { ...headers, 'Content-Type': 'application/x-www-form-urlencoded' },
				body: 'LoginLock=abc',
			})
		).json()) as { roomInstance: Record<string, unknown>; isOnline: boolean }
		expect(hb.isOnline).toBe(true)
		expect(hb.roomInstance).toEqual(mm.roomInstance)
	})

	test('heartbeat ignores posted status fields — stored presence is returned unchanged', async () => {
		const headers = await bearer('8')
		await exports.default.fetch(`${ORIGIN}/matchmake/dorm`, { method: 'POST', headers })
		const hb = (await (
			await exports.default.fetch(`${ORIGIN}/player/heartbeat`, {
				method: 'POST',
				headers: { ...headers, 'Content-Type': 'application/json' },
				body: JSON.stringify({ statusVisibility: 2, platform: 5, appVersion: '20210129' }),
			})
		).json()) as {
			statusVisibility: number
			platform: number
			appVersion: string
			isOnline: boolean
		}
		// Posted fields are NOT merged — the stored dorm presence (its defaults) is returned.
		expect(hb).toMatchObject({
			statusVisibility: 0,
			platform: 0,
			appVersion: GAME_VERSION,
			isOnline: true,
		})
	})

	// The build a player reports is the one their TOKEN carries (`rn.ver`, from the `ver`
	// they posted to /connect/token) — not this server's GAME_VERSION, which is only the
	// fallback for a token that names none.
	test('presence reports the build from the caller’s token', async () => {
		const headers = await bearer('9710', '20250718.01')
		await exports.default.fetch(`${ORIGIN}/matchmake/dorm`, { method: 'POST', headers })

		const hb = (await (
			await exports.default.fetch(`${ORIGIN}/player/heartbeat`, { method: 'POST', headers })
		).json()) as { appVersion: string }
		expect(hb.appVersion).toBe('20250718.01')

		// And it is what everyone else sees of them, since it was written to the row.
		const [player] = (await (
			await exports.default.fetch(`${ORIGIN}/player?id=9710`)
		).json()) as Array<{ appVersion: string }>
		expect(player.appVersion).toBe('20250718.01')
	})

	// A player who quit and relaunched on a new build heartbeats with a NEW token against
	// the row the old session left behind; the heartbeat adopts it rather than waiting for
	// a re-matchmake.
	test('a heartbeat on a new build updates the stored version', async () => {
		await exports.default.fetch(`${ORIGIN}/matchmake/dorm`, {
			method: 'POST',
			headers: await bearer('9711', '20250424.01'),
		})

		const hb = (await (
			await exports.default.fetch(`${ORIGIN}/player/heartbeat`, {
				method: 'POST',
				headers: await bearer('9711', '20250718.01'),
			})
		).json()) as { appVersion: string }
		expect(hb.appVersion).toBe('20250718.01')

		const [player] = (await (
			await exports.default.fetch(`${ORIGIN}/player?id=9711`)
		).json()) as Array<{ appVersion: string }>
		expect(player.appVersion).toBe('20250718.01')
	})

	// A token issued before the claim carried the client's build still has to produce a
	// usable version — an empty one breaks the client's presence handling.
	test('a token with no rn.ver falls back to GAME_VERSION', async () => {
		const headers = await bearer('9712')
		await exports.default.fetch(`${ORIGIN}/matchmake/dorm`, { method: 'POST', headers })
		const hb = (await (
			await exports.default.fetch(`${ORIGIN}/player/heartbeat`, { method: 'POST', headers })
		).json()) as { appVersion: string }
		expect(hb.appVersion).toBe(GAME_VERSION)
	})

	test('heartbeat pushes no websocket frame', async () => {
		// The notify DO is stubbed to record every send (see vitest.config).
		type Sent = { playerId: number; notificationType: number; data: Record<string, unknown> }
		const hub = () => env.RECFLARE_NOTIFICATIONS_HUB.getByName('global')

		const headers = await bearer('9600')
		await exports.default.fetch(`${ORIGIN}/matchmake/dorm`, { method: 'POST', headers })
		// Clear whatever the matchmake fan-out recorded so we observe only the heartbeat.
		await hub().fetch('http://do/all', { method: 'DELETE' })
		const res = await exports.default.fetch(`${ORIGIN}/player/heartbeat`, {
			method: 'POST',
			headers,
		})
		expect(res.status).toBe(200)

		const sent = (await (await hub().fetch('http://do/all')).json()) as Sent[]
		// The heartbeat no longer echoes itself back over the websocket.
		expect(sent).toHaveLength(0)
	})

	test('login records the LoginLock; a superseded heartbeat gets an empty body', async () => {
		const headers = await bearer('8100')
		// Enter a room so there's live presence, then record this session's lock at login.
		await exports.default.fetch(`${ORIGIN}/matchmake/dorm`, { method: 'POST', headers })
		await exports.default.fetch(`${ORIGIN}/player/login`, {
			method: 'POST',
			headers: { ...headers, 'Content-Type': 'application/x-www-form-urlencoded' },
			body: 'LoginLock=session-one',
		})

		// A heartbeat carrying the recorded lock gets the presence back.
		const ok = await exports.default.fetch(`${ORIGIN}/player/heartbeat`, {
			method: 'POST',
			headers: { ...headers, 'Content-Type': 'application/x-www-form-urlencoded' },
			body: 'LoginLock=session-one',
		})
		expect(ok.status).toBe(200)
		expect(((await ok.json()) as { isOnline: boolean }).isOnline).toBe(true)

		// A heartbeat from a superseded session (different lock) gets nothing.
		const stale = await exports.default.fetch(`${ORIGIN}/player/heartbeat`, {
			method: 'POST',
			headers: { ...headers, 'Content-Type': 'application/x-www-form-urlencoded' },
			body: 'LoginLock=session-two',
		})
		expect(stale.status).toBe(200)
		expect(await stale.text()).toBe('')
	})

	test('login with no live presence seeds a lobby row carrying the lock', async () => {
		const headers = await bearer('8200')
		await exports.default.fetch(`${ORIGIN}/player/login`, {
			method: 'POST',
			headers: { ...headers, 'Content-Type': 'application/x-www-form-urlencoded' },
			body: 'LoginLock=lobby-lock',
		})
		// Online in the lobby (no room), and a mismatched heartbeat is rejected on the lock
		// recorded at login even though no matchmake ever ran.
		const hb = await exports.default.fetch(`${ORIGIN}/player/heartbeat`, {
			method: 'POST',
			headers: { ...headers, 'Content-Type': 'application/x-www-form-urlencoded' },
			body: 'LoginLock=lobby-lock',
		})
		expect(((await hb.json()) as { isOnline: boolean; roomInstance: unknown }).isOnline).toBe(true)

		const stale = await exports.default.fetch(`${ORIGIN}/player/heartbeat`, {
			method: 'POST',
			headers: { ...headers, 'Content-Type': 'application/x-www-form-urlencoded' },
			body: 'LoginLock=other',
		})
		expect(await stale.text()).toBe('')
	})

	// Seed presence directly into D1 with a chosen instance and `expiresAt` (epoch
	// seconds), so the TTL branches can be exercised deterministically (independent of
	// timing) and a player can be planted in an instance without matchmaking there.
	const seedPresenceInInstance = (id: number, roomInstanceId: number, expiresAt: number) =>
		env.DB.prepare('INSERT OR REPLACE INTO presence (data) VALUES (?1)')
			.bind(
				JSON.stringify({
					accountId: id,
					roomInstance: { roomInstanceId, roomId: 1 },
					statusVisibility: 0,
					deviceClass: 0,
					vrMovementMode: 1,
					platform: 0,
					appVersion: GAME_VERSION,
					expiresAt,
				})
			)
			.run()

	const seedPresence = (id: number, expiresAt: number) =>
		seedPresenceInInstance(id, 1000042, expiresAt)

	const storedExpiresAt = async (id: number): Promise<number> => {
		const row = await env.DB.prepare('SELECT data FROM presence WHERE account_id = ?1')
			.bind(id)
			.first<{ data: string }>()
		return (JSON.parse(row!.data) as { expiresAt: number }).expiresAt
	}

	const nowSeconds = () => Math.floor(Date.now() / 1000)

	/** Rows for an account, expired ones included — the sweep should leave none. */
	const countPresenceRows = async (id: number): Promise<number> => {
		const row = await env.DB.prepare('SELECT COUNT(*) AS n FROM presence WHERE account_id = ?1')
			.bind(id)
			.first<{ n: number }>()
		return row?.n ?? 0
	}

	test('heartbeat refreshes presence when its TTL is close to lapsing', async () => {
		// TTL about to lapse (well inside the refresh window).
		const nearExpiry = nowSeconds() + 10
		await seedPresence(700, nearExpiry)
		await exports.default.fetch(`${ORIGIN}/player/heartbeat`, {
			method: 'POST',
			headers: await bearer('700'),
		})
		// The heartbeat re-wrote the row, pushing expiry ~PRESENCE_TTL_SECONDS ahead.
		expect(await storedExpiresAt(700)).toBeGreaterThan(nearExpiry + 60)
	})

	test('heartbeat skips the write when nothing changed and the TTL is healthy', async () => {
		// A distinctive, far-future expiry (outside the refresh window) survives
		// untouched — proving the unchanged heartbeat did not re-write the row.
		const healthyExpiry = nowSeconds() + 800
		await seedPresence(701, healthyExpiry)
		await exports.default.fetch(`${ORIGIN}/player/heartbeat`, {
			method: 'POST',
			headers: await bearer('701'),
		})
		expect(await storedExpiresAt(701)).toBe(healthyExpiry)
	})

	test('countPlayersInInstance counts live players in a room instance (excludes expired)', async () => {
		// Three players in instance 1000099 — two live, one expired.
		await seedPresenceInInstance(710, 1000099, nowSeconds() + 800)
		await seedPresenceInInstance(711, 1000099, nowSeconds() + 800)
		await seedPresenceInInstance(712, 1000099, nowSeconds() - 10) // expired → not counted
		expect(await countPlayersInInstance(env.DB, 1000099)).toBe(2)
		expect(await countPlayersInInstance(env.DB, 999999)).toBe(0)
	})

	// Matchmake into a room, returning the resulting instance id.
	const matchmakeInto = async (room: string, sub: string): Promise<number> => {
		const res = (await (
			await exports.default.fetch(`${ORIGIN}/matchmake/room/${room}`, {
				method: 'POST',
				headers: await bearer(sub),
			})
		).json()) as { roomInstance: { roomInstanceId: number } }
		return res.roomInstance.roomInstanceId
	}

	test('matchmaking flags an instance full once it reaches capacity, and routes the next player elsewhere', async () => {
		// SoloRoom (RoomId 5, MaxPlayers 1): one player fills its instance.
		const first = await matchmakeInto('5', '820')
		expect((await getRoomInstance(env.DB, first))?.isFull).toBe(true)
		// A second player can't join the full instance — matchmaking makes a fresh one.
		const second = await matchmakeInto('5', '821')
		expect(second).not.toBe(first)
		expect((await getRoomInstance(env.DB, second))?.isFull).toBe(true)
	})

	test('matchmaking leaves an instance not full below capacity', async () => {
		// RecCenter (RoomId 2, MaxPlayers 12): one player does not fill it.
		const instanceId = await matchmakeInto('2', '822')
		expect((await getRoomInstance(env.DB, instanceId))?.isFull).toBe(false)
	})

	test('leaving a full instance clears its full flag', async () => {
		// Fill SoloRoom, then the same player matchmakes into RecCenter — the SoloRoom
		// instance they left should no longer be full.
		const solo = await matchmakeInto('5', '823')
		expect((await getRoomInstance(env.DB, solo))?.isFull).toBe(true)
		await matchmakeInto('2', '823')
		expect((await getRoomInstance(env.DB, solo))?.isFull).toBe(false)
	})

	test('the cron sweep purges expired presence and frees the instance those players were in', async () => {
		// A player fills SoloRoom, then vanishes without matchmaking out (a crash) —
		// nothing recomputes fullness, so the instance sits full with nobody in it.
		const solo = await matchmakeInto('5', '824')
		expect((await getRoomInstance(env.DB, solo))?.isFull).toBe(true)
		await env.DB.prepare(
			"UPDATE presence SET data = json_set(data, '$.expiresAt', ?2) WHERE account_id = ?1"
		)
			.bind(824, nowSeconds() - 10)
			.run()

		// Driven through the module's own export rather than the `exports` proxy — a
		// ScheduledController can't cross the isolate boundary the proxy serializes over.
		const ctx = createExecutionContext()
		await scheduled(createScheduledController(), env, ctx)
		await waitOnExecutionContext(ctx)

		// Expired row gone, and the instance is joinable again.
		expect(await countPresenceRows(824)).toBe(0)
		expect((await getRoomInstance(env.DB, solo))?.isFull).toBe(false)
	})

	// Age an instance past EMPTY_INSTANCE_GRACE_SECONDS by backdating its `createdAt`
	// (the generated `created_at` column follows the blob), so the empty-instance sweep
	// can be exercised without waiting out the grace window.
	const backdateInstance = (id: number, secondsAgo = EMPTY_INSTANCE_GRACE_SECONDS + 60) =>
		env.DB.prepare(
			"UPDATE room_instance SET data = json_set(data, '$.createdAt', ?2) WHERE id = ?1"
		)
			.bind(id, new Date(Date.now() - secondsAgo * 1000).toISOString())
			.run()

	const expirePresence = (accountId: number) =>
		env.DB.prepare(
			"UPDATE presence SET data = json_set(data, '$.expiresAt', ?2) WHERE account_id = ?1"
		)
			.bind(accountId, nowSeconds() - 10)
			.run()

	test('the cron sweep deletes instances nobody is left standing in', async () => {
		// Two instances built directly rather than by matchmaking, so neither is one a
		// previous test's player is still standing in (public matchmakes reuse instances).
		// One holds a player who crashed out — an expired row the sweep purges first,
		// leaving the instance empty — the other a live player.
		const abandoned = await createRoomInstance(env.DB, {
			ownerAccountId: 830,
			roomId: 2,
			photonRoomId: 'abandoned-instance',
			maxCapacity: 12,
		})
		await seedPresenceInInstance(830, abandoned.roomInstanceId, nowSeconds() - 10)
		const occupied = await createRoomInstance(env.DB, {
			ownerAccountId: 831,
			roomId: 2,
			photonRoomId: 'occupied-instance',
			maxCapacity: 12,
		})
		await seedPresenceInInstance(831, occupied.roomInstanceId, nowSeconds() + 800)
		await backdateInstance(abandoned.roomInstanceId)
		await backdateInstance(occupied.roomInstanceId)

		const ctx = createExecutionContext()
		await scheduled(createScheduledController(), env, ctx)
		await waitOnExecutionContext(ctx)

		expect(await getRoomInstance(env.DB, abandoned.roomInstanceId)).toBeNull()
		expect(await getRoomInstance(env.DB, occupied.roomInstanceId)).not.toBeNull()
	})

	test('the cron sweep spares a freshly created instance nobody has joined yet', async () => {
		// The instance and its creator's presence are written by the same request but not
		// atomically — a sweep landing in between must not delete the instance the player
		// is being handed. `createdAt` is left alone, so it's inside the grace window.
		const fresh = await createRoomInstance(env.DB, {
			ownerAccountId: 832,
			roomId: 2,
			photonRoomId: 'fresh-instance',
			maxCapacity: 12,
		})

		const ctx = createExecutionContext()
		await scheduled(createScheduledController(), env, ctx)
		await waitOnExecutionContext(ctx)

		expect(await getRoomInstance(env.DB, fresh.roomInstanceId)).not.toBeNull()
	})

	test('the cron sweep spares an empty dorm instance', async () => {
		// A dorm is backed by one persistent instance so its Photon room id survives
		// re-entry — it sits empty whenever the owner is anywhere else.
		const headers = await bearer('833')
		const dorm = (await (
			await exports.default.fetch(`${ORIGIN}/matchmake/dorm`, { method: 'POST', headers })
		).json()) as { roomInstance: { roomInstanceId: number } }
		const dormInstanceId = dorm.roomInstance.roomInstanceId
		await expirePresence(833)
		await backdateInstance(dormInstanceId)

		const ctx = createExecutionContext()
		await scheduled(createScheduledController(), env, ctx)
		await waitOnExecutionContext(ctx)

		expect(await getRoomInstance(env.DB, dormInstanceId)).not.toBeNull()
	})

	test('player/login and exclusivelogin preserve presence', async () => {
		const headers = await bearer('9')
		await exports.default.fetch(`${ORIGIN}/matchmake/dorm`, { method: 'POST', headers })
		// These acks must not wipe presence — the client fires exclusivelogin when going
		// online, and clearing here would bounce the player to the dorm.
		await exports.default.fetch(`${ORIGIN}/player/exclusivelogin`, { method: 'POST', headers })
		await exports.default.fetch(`${ORIGIN}/player/login`, { method: 'POST', headers })
		const hb = (await (
			await exports.default.fetch(`${ORIGIN}/player/heartbeat`, { method: 'POST', headers })
		).json()) as { roomInstance: { name: string } | null; isOnline: boolean }
		expect(hb.isOnline).toBe(true)
		// Presence is preserved: the heartbeat replays their personal dorm. Account 9
		// has no seeded username, so the name falls back to `@Player9's Dorm`.
		expect(hb.roomInstance?.name).toBe("@Player9's Dorm")
	})

	test('player/logout clears presence and frees the instance the player was in', async () => {
		// Fill SoloRoom (cap 1) so its instance is full, then log out.
		const solo = await matchmakeInto('5', '960')
		expect((await getRoomInstance(env.DB, solo))?.isFull).toBe(true)

		const headers = await bearer('960')
		await exports.default.fetch(`${ORIGIN}/player/logout`, { method: 'POST', headers })

		// Presence is gone → the heartbeat reports offline with no room.
		const hb = (await (
			await exports.default.fetch(`${ORIGIN}/player/heartbeat`, { method: 'POST', headers })
		).json()) as { roomInstance: unknown; isOnline: boolean }
		expect(hb.isOnline).toBe(false)
		expect(hb.roomInstance).toBeNull()
		expect(await countPresenceRows(960)).toBe(0)
		// The instance they left is no longer full.
		expect((await getRoomInstance(env.DB, solo))?.isFull).toBe(false)
	})

	test('player/logout preserves a new player still in Orientation (account-creation bootstrap)', async () => {
		// Mirror the auth worker's Orientation seed: presence pointing at instance -2.
		// The client's spurious bootstrap logout must NOT wipe it, or the new player is
		// bounced out of Orientation to the dorm.
		await env.DB.prepare('INSERT OR REPLACE INTO presence (data) VALUES (?1)')
			.bind(
				JSON.stringify({
					accountId: 961,
					roomInstance: { roomInstanceId: -2, roomId: 13, name: '^Orientation' },
					statusVisibility: 0,
					deviceClass: 0,
					vrMovementMode: 1,
					platform: 0,
					appVersion: GAME_VERSION,
					expiresAt: nowSeconds() + 800,
				})
			)
			.run()

		await exports.default.fetch(`${ORIGIN}/player/logout`, {
			method: 'POST',
			headers: await bearer('961'),
		})

		const hb = (await (
			await exports.default.fetch(`${ORIGIN}/player/heartbeat`, {
				method: 'POST',
				headers: await bearer('961'),
			})
		).json()) as { roomInstance: { roomInstanceId: number } | null; isOnline: boolean }
		expect(hb.isOnline).toBe(true)
		expect(hb.roomInstance?.roomInstanceId).toBe(-2)
	})

	test('GET /player?id reports stored presence per id', async () => {
		await exports.default.fetch(`${ORIGIN}/matchmake/dorm`, {
			method: 'POST',
			headers: await bearer('55'),
		})
		const res = await exports.default.fetch(`${ORIGIN}/player?id=55`)
		expect(res.status).toBe(200)
		const players = (await res.json()) as Array<{ playerId: number; isOnline: boolean }>
		expect(players[0]).toMatchObject({ playerId: 55, isOnline: true })
	})

	test('GET /room/:id/instances is auth-gated, owner/co-owner-only, and lists the room’s instances', async () => {
		// No token → 401.
		expect((await exports.default.fetch(`${ORIGIN}/room/3/instances`)).status).toBe(401)

		// A valid token but no role on the room (room 3 is owned by account 42, with
		// account 43 as co-owner) → 403.
		expect(
			(
				await exports.default.fetch(`${ORIGIN}/room/3/instances`, {
					headers: await bearer('999'),
				})
			).status
		).toBe(403)

		// Unknown room → 404.
		expect(
			(
				await exports.default.fetch(`${ORIGIN}/room/99999/instances`, {
					headers: await bearer('42'),
				})
			).status
		).toBe(404)

		// Matchmaking into room 3 creates an instance the owner can then see.
		await exports.default.fetch(`${ORIGIN}/matchmake/room/3`, {
			method: 'POST',
			headers: await bearer('42'),
		})
		const res = await exports.default.fetch(`${ORIGIN}/room/3/instances`, {
			headers: await bearer('42'),
		})
		expect(res.status).toBe(200)
		const instances = (await res.json()) as Array<{
			roomInstanceId: number
			roomId: number
			subRoomId: number
			isFull: boolean
			createdAt: string
			playerIds: number[]
		}>
		expect(instances.length).toBeGreaterThanOrEqual(1)
		expect(instances.every((i) => i.roomId === 3)).toBe(true)

		// The summary projection: id/subroom/fullness/createdAt plus who's in there —
		// and none of the client DTO's connection fields.
		const instance = instances.find((i) => i.playerIds.includes(42))
		expect(instance).toBeDefined()
		expect(Object.keys(instance!).sort()).toEqual([
			'createdAt',
			'isFull',
			'playerIds',
			'roomId',
			'roomInstanceId',
			'subRoomId',
		])
		expect(instance!.isFull).toBe(false)
		expect(Number.isNaN(Date.parse(instance!.createdAt))).toBe(false)

		// The co-owner (account 43, Role 30) may view the instances too.
		const coOwner = await exports.default.fetch(`${ORIGIN}/room/3/instances`, {
			headers: await bearer('43'),
		})
		expect(coOwner.status).toBe(200)
		expect((await coOwner.json()) as unknown[]).toHaveLength(instances.length)
	})

	test('POST /matchmake/instance/:id joins that exact instance, owner-only', async () => {
		// A player with no role on room 3 spins up an instance of it, which the room's
		// owner should then be able to drop into by id.
		const spawn = await exports.default.fetch(`${ORIGIN}/matchmake/room/3`, {
			method: 'POST',
			headers: await bearer('43'),
		})
		const spawned = (await spawn.json()) as {
			roomInstance: { roomInstanceId: number; photonRoomId: string }
		}
		const instanceId = spawned.roomInstance.roomInstanceId

		// No token → 401.
		expect(
			(
				await exports.default.fetch(`${ORIGIN}/matchmake/instance/${instanceId}`, {
					method: 'POST',
				})
			).status
		).toBe(401)

		// Authed but not the room's owner or co-owner → the opaque NoSuchRoom refusal,
		// so instance ids can't be probed for live private sessions.
		const stranger = await exports.default.fetch(`${ORIGIN}/matchmake/instance/${instanceId}`, {
			method: 'POST',
			headers: await bearer('999'),
		})
		expect(stranger.status).toBe(200)
		expect(await stranger.json()).toEqual(refused(20))

		// Unknown instance → same refusal.
		const unknown = await exports.default.fetch(`${ORIGIN}/matchmake/instance/9999999`, {
			method: 'POST',
			headers: await bearer('42'),
		})
		expect(await unknown.json()).toEqual(refused(20))

		// Park the owner somewhere else first, so this is a real transition.
		await exports.default.fetch(`${ORIGIN}/matchmake/dorm`, {
			method: 'POST',
			headers: await bearer('42'),
		})

		// The owner lands in that exact instance — same id AND same Photon room as the
		// player already in it, which is what makes it the same session.
		const joined = await exports.default.fetch(`${ORIGIN}/matchmake/instance/${instanceId}`, {
			method: 'POST',
			headers: await bearer('42'),
		})
		expect(joined.status).toBe(200)
		const body = (await joined.json()) as {
			errorCode: number
			roomInstance: { roomInstanceId: number; photonRoomId: string; roomId: number }
		}
		expect(body.errorCode).toBe(0)
		expect(body.roomInstance.roomInstanceId).toBe(instanceId)
		expect(body.roomInstance.photonRoomId).toBe(spawned.roomInstance.photonRoomId)
		expect(body.roomInstance.roomId).toBe(3)

		// It's now the owner's presence, and the listing shows both of them in there.
		const listed = (await (
			await exports.default.fetch(`${ORIGIN}/room/3/instances`, { headers: await bearer('42') })
		).json()) as Array<{ roomInstanceId: number; playerIds: number[] }>
		const target = listed.find((i) => i.roomInstanceId === instanceId)
		expect(target?.playerIds).toEqual([42, 43])
	})

	test('POST /roominstance/:id/markprivate closes the instance, owner-only', async () => {
		// Room 77 subroom 34 — its own instance, so marking it private can't affect the
		// instances the other tests matchmake into.
		const spawn = await exports.default.fetch(`${ORIGIN}/matchmake/room/77/34`, {
			method: 'POST',
			headers: await bearer('42'),
		})
		const { roomInstance } = (await spawn.json()) as { roomInstance: { roomInstanceId: number } }
		const instanceId = roomInstance.roomInstanceId

		// No token → 401.
		expect(
			(
				await exports.default.fetch(`${ORIGIN}/roominstance/${instanceId}/markprivate`, {
					method: 'POST',
				})
			).status
		).toBe(401)

		// Unknown instance → 404.
		expect(
			(
				await exports.default.fetch(`${ORIGIN}/roominstance/9999999/markprivate`, {
					method: 'POST',
					headers: await bearer('42'),
				})
			).status
		).toBe(404)

		// Room 77 has no creator and no roles, so nobody manages it → 403 even for 42.
		expect(
			(
				await exports.default.fetch(`${ORIGIN}/roominstance/${instanceId}/markprivate`, {
					method: 'POST',
					headers: await bearer('42'),
				})
			).status
		).toBe(403)

		// Room 3 is account 42's, so its instances are theirs to close.
		const owned = await exports.default.fetch(`${ORIGIN}/matchmake/room/3`, {
			method: 'POST',
			headers: await bearer('43'),
		})
		const ownedId = ((await owned.json()) as { roomInstance: { roomInstanceId: number } })
			.roomInstance.roomInstanceId
		const marked = await exports.default.fetch(`${ORIGIN}/roominstance/${ownedId}/markprivate`, {
			method: 'POST',
			headers: await bearer('42'),
		})
		expect(marked.status).toBe(200)
		expect(await marked.text()).toBe('')

		// Closed to strangers: a public matchmake into room 3 no longer reuses it, so a
		// new player lands in a different instance.
		const after = await exports.default.fetch(`${ORIGIN}/matchmake/room/3`, {
			method: 'POST',
			headers: await bearer('999'),
		})
		const afterId = ((await after.json()) as { roomInstance: { roomInstanceId: number } })
			.roomInstance.roomInstanceId
		expect(afterId).not.toBe(ownedId)

		// The player already inside is untouched — this shuts the door, it doesn't clear
		// the room.
		const listed = (await (
			await exports.default.fetch(`${ORIGIN}/room/3/instances`, { headers: await bearer('42') })
		).json()) as Array<{ roomInstanceId: number; playerIds: number[] }>
		expect(listed.find((i) => i.roomInstanceId === ownedId)?.playerIds).toContain(43)
	})

	test('POST /invite pushes a game-invite MessageReceived to the target', async () => {
		// The notify DO is stubbed to record every notifyPlayer call (see vitest.config).
		type Sent = {
			playerId: number
			notificationType: number
			data: {
				Id: number
				FromPlayerId: number
				ToPlayerId: number
				Type: number
				Data: string
				SentTime: string
				RoomId: number | null
			}
		}
		const hub = () => env.RECFLARE_NOTIFICATIONS_HUB.getByName('global')
		const reset = () => hub().fetch('http://do/all', { method: 'DELETE' })
		const sent = async (): Promise<Sent[]> =>
			(await (await hub().fetch('http://do/all')).json()) as Sent[]

		await reset()

		// A live instance of room 2 to invite the target into.
		const instance = await createRoomInstance(env.DB, {
			ownerAccountId: 42,
			roomId: 2,
			subRoomId: 2,
			photonRoomId: crypto.randomUUID(),
			name: '^RecCenter',
			maxCapacity: 12,
		})

		const invite = async (body: string, sub?: string): Promise<Response> =>
			exports.default.fetch(`${ORIGIN}/invite`, {
				method: 'POST',
				headers: {
					...(sub === undefined ? {} : await bearer(sub)),
					'Content-Type': 'application/x-www-form-urlencoded',
				},
				body,
			})

		// The client's exact request: player 42 invites 153 into their instance.
		const res = await invite(`playerId=153&roomInstanceId=${instance.roomInstanceId}`, '42')
		expect(res.status).toBe(200)

		const notes = await sent()
		expect(notes).toHaveLength(1)
		expect(notes[0].playerId).toBe(153) // delivered to the invitee, not the caller
		expect(notes[0].notificationType).toBe(2) // NotificationType.MessageReceived
		expect(notes[0].data).toMatchObject({
			FromPlayerId: 42, // the caller
			ToPlayerId: 153,
			Type: 0, // MessageType.GameInvite
			Data: String(instance.roomInstanceId), // raw roomInstanceId string
			RoomId: 2, // resolved from the instance
		})
		expect(notes[0].data.Id).toBeGreaterThan(0)
		expect(typeof notes[0].data.SentTime).toBe('string')

		// A missing token is a 401 and a missing/zero/non-numeric playerId a 400 — and
		// none of them push a notification.
		await reset()
		expect((await invite('playerId=153')).status).toBe(401)
		expect((await invite('playerId=0', '42')).status).toBe(400)
		expect((await invite('playerId=abc', '42')).status).toBe(400)
		expect(await sent()).toHaveLength(0)

		// An unknown (or absent) room instance still delivers the invite — just with a null
		// RoomId (which the real hub drops from the frame).
		const noRoom = await invite('playerId=153&roomInstanceId=999999', '42')
		expect(noRoom.status).toBe(200)
		const after = await sent()
		expect(after).toHaveLength(1)
		expect(after[0].data.RoomId).toBeNull()
		expect(after[0].data.Data).toBe('999999')
	})

	test('matchmake pushes SubscriptionUpdatePresence to the player’s friends', async () => {
		// The notify DO is stubbed to record every send (see vitest.config). The friend
		// fan-out is a single batch call carrying the friend ids.
		type Batch = {
			playerIds: number[]
			notificationType: number | string
			data: {
				playerId: number
				statusVisibility: number
				isOnline: boolean
				appVersion: string
				roomInstance: Record<string, unknown> | null
			}
		}
		const hub = () => env.RECFLARE_NOTIFICATIONS_HUB.getByName('global')
		await hub().fetch('http://do/all', { method: 'DELETE' })

		// 9700 enters RecCenter (room 2, public).
		const res = await exports.default.fetch(`${ORIGIN}/matchmake/room/2`, {
			method: 'POST',
			headers: await bearer('9700'),
		})
		expect(res.status).toBe(200)
		const mm = (await res.json()) as { roomInstance: { roomInstanceId: number } }

		const sent = (await (await hub().fetch('http://do/all')).json()) as Batch[]
		expect(sent).toHaveLength(1)
		const batch = sent[0]
		// Delivered to the two friends (in both graph directions), not the pending-request
		// player (9703).
		expect(batch.playerIds.slice().sort((a, b) => a - b)).toEqual([9701, 9702])
		expect(batch.notificationType).toBe('PresenceUpdate') // NotificationType.SubscriptionUpdatePresence
		expect(batch.data).toMatchObject({
			playerId: 9700,
			statusVisibility: 0, // Everyone — not hidden from friends
			isOnline: true,
			appVersion: GAME_VERSION, // a STRING, matching the client build
		})
		expect(typeof batch.data.appVersion).toBe('string')
		// The redacted instance the friends see: the room just entered (read back from the
		// player's stored presence). photonRoomId and dataBlob are blanked so a friend can't
		// use the leaked Photon room id to join a private instance directly; photonRegion is
		// dropped entirely.
		expect(batch.data.roomInstance).toMatchObject({
			roomId: 2,
			roomInstanceId: mm.roomInstance.roomInstanceId,
			photonRoomId: '', // blanked
			dataBlob: '', // blanked
		})
		expect(batch.data.roomInstance).not.toHaveProperty('photonRegion')
		expect(batch.data.roomInstance).toHaveProperty('photonRegionId')

		// A player with no friends triggers no fan-out (empty list → no hub call).
		await hub().fetch('http://do/all', { method: 'DELETE' })
		await exports.default.fetch(`${ORIGIN}/matchmake/room/2`, {
			method: 'POST',
			headers: await bearer('9999'),
		})
		expect(await (await hub().fetch('http://do/all')).json()).toEqual([])
	})

	test('logout fires SubscriptionUpdatePresence (offline) to friends', async () => {
		type Batch = {
			playerIds: number[]
			notificationType: number | string
			data: { playerId: number; isOnline: boolean; roomInstance: Record<string, unknown> | null }
		}
		const hub = () => env.RECFLARE_NOTIFICATIONS_HUB.getByName('global')
		const sent = async (): Promise<Batch[]> =>
			(await (await hub().fetch('http://do/all')).json()) as Batch[]

		// 9900 is friends with 9901.
		await env.DB.prepare(
			'INSERT INTO relationship (requester_id, target_id, relationship_type) VALUES (?1, ?2, ?3)'
		)
			.bind(9900, 9901, 3)
			.run()

		// 9900 enters a room (presence created), then reset the hub so we isolate the
		// logout push from the entry push.
		await exports.default.fetch(`${ORIGIN}/matchmake/room/2`, {
			method: 'POST',
			headers: await bearer('9900'),
		})
		await hub().fetch('http://do/all', { method: 'DELETE' })

		const res = await exports.default.fetch(`${ORIGIN}/player/logout`, {
			method: 'POST',
			headers: await bearer('9900'),
		})
		expect(res.status).toBe(200)

		// The friend gets an offline presence snapshot: no room, isOnline false.
		const batch = await sent()
		expect(batch).toHaveLength(1)
		expect(batch[0].playerIds).toEqual([9901])
		expect(batch[0].notificationType).toBe('PresenceUpdate') // SubscriptionUpdatePresence
		expect(batch[0].data).toMatchObject({ playerId: 9900, isOnline: false, roomInstance: null })

		// Presence is actually cleared — a second logout (no presence) fires nothing.
		await hub().fetch('http://do/all', { method: 'DELETE' })
		await exports.default.fetch(`${ORIGIN}/player/logout`, {
			method: 'POST',
			headers: await bearer('9900'),
		})
		expect(await sent()).toEqual([])

		// An unauthenticated logout is a no-op too.
		await exports.default.fetch(`${ORIGIN}/player/logout`, { method: 'POST' })
		expect(await sent()).toEqual([])
	})

	test('POST /matchmake/player/:id follows a friend into their room, friends only', async () => {
		// 9800 is friends with 9801 (in a room) and 9803 (not in any room); 9802 is not a
		// friend.
		const insertRel = env.DB.prepare(
			'INSERT INTO relationship (requester_id, target_id, relationship_type) VALUES (?1, ?2, ?3)'
		)
		await env.DB.batch([insertRel.bind(9800, 9801, 3), insertRel.bind(9803, 9800, 3)])

		const follow = async (targetId: number, sub?: string): Promise<Response> =>
			exports.default.fetch(`${ORIGIN}/matchmake/player/${targetId}`, {
				method: 'POST',
				...(sub === undefined ? {} : { headers: await bearer(sub) }),
			})
		type Result = {
			errorCode: number
			roomInstance: { roomInstanceId: number; photonRoomId: string; roomId: number } | null
		}

		// The friend (9801) enters RecCenter → they now have a presence with an instance.
		const friendMM = (await (
			await exports.default.fetch(`${ORIGIN}/matchmake/room/2`, {
				method: 'POST',
				headers: await bearer('9801'),
			})
		).json()) as Result

		// 9800 follows 9801 → placed into the SAME instance, with the real (un-redacted)
		// Photon room id, since they're authorized to join.
		const res = await follow(9801, '9800')
		expect(res.status).toBe(200)
		const body = (await res.json()) as Result
		expect(body.errorCode).toBe(0)
		expect(body.roomInstance?.roomInstanceId).toBe(friendMM.roomInstance?.roomInstanceId)
		expect(body.roomInstance?.photonRoomId).toBe(friendMM.roomInstance?.photonRoomId)
		expect(body.roomInstance?.photonRoomId).not.toBe('')

		// And 9800's presence now points at that instance (the heartbeat replays it).
		const hb = (await (
			await exports.default.fetch(`${ORIGIN}/player/heartbeat`, {
				method: 'POST',
				headers: { ...(await bearer('9800')), 'Content-Type': 'application/json' },
				body: '{}',
			})
		).json()) as { roomInstance: { roomInstanceId: number } | null }
		expect(hb.roomInstance?.roomInstanceId).toBe(friendMM.roomInstance?.roomInstanceId)

		// A non-friend can't be followed → NoSuchRoom, null instance (no leak of their state).
		expect(await (await follow(9802, '9800')).json()).toEqual(refused(20))
		// You can't follow yourself.
		expect(await (await follow(9800, '9800')).json()).toEqual(refused(20))
		// A friend who isn't in any room → nothing to join.
		expect(await (await follow(9803, '9800')).json()).toEqual(refused(20))

		// No token → 401.
		expect((await follow(9801)).status).toBe(401)

		// A ban on the room blocks the follow too: this path hands out a Photon room id
		// without going through resolveRoomInstance, so it carries its own ban check —
		// otherwise following a friend in would be a way around a ban.
		await env.DB.prepare(
			`INSERT INTO room_ban (room_id, banned_player_id, ban_mask, banned_by_account_id, created_at)
			 VALUES (2, 9800, 0, 1, '2026-01-01T00:00:00.000Z')`
		).run()
		try {
			expect(await (await follow(9801, '9800')).json()).toEqual(refused(55))
		} finally {
			await env.DB.prepare(
				'DELETE FROM room_ban WHERE room_id = 2 AND banned_player_id = 9800'
			).run()
		}
	})

	test('POST /matchmake/room/:roomId refuses a player banned from the room', async () => {
		const matchmake = async (sub: string) =>
			(await (
				await exports.default.fetch(`${ORIGIN}/matchmake/room/2`, {
					method: 'POST',
					headers: await bearer(sub),
				})
			).json()) as { errorCode: number; roomInstance: { roomInstanceId: number } | null }

		// Not banned yet → a normal join.
		expect((await matchmake('9700')).errorCode).toBe(0)

		await env.DB.prepare(
			`INSERT INTO room_ban (room_id, banned_player_id, ban_mask, banned_by_account_id, created_at)
			 VALUES (2, 9701, 0, 1, '2026-01-01T00:00:00.000Z')`
		).run()

		// The ban is the whole enforcement: no instance means no Photon room id, so there
		// is nothing for the banned player to join. errorCode 55 rather than the opaque
		// NoSuchRoom every other refusal answers — a banned player already knows the room
		// exists, so the client can say why. Applies to the subroom path as well.
		expect(await matchmake('9701')).toEqual(refused(55))
		const sub = await exports.default.fetch(`${ORIGIN}/matchmake/room/2/2`, {
			method: 'POST',
			headers: await bearer('9701'),
		})
		expect(await sub.json()).toEqual(refused(55))

		// Refused before any instance is created, and no presence was recorded for them.
		expect(
			await env.DB.prepare('SELECT 1 AS hit FROM presence WHERE account_id = 9701').first()
		).toBeNull()

		// The ban is per-room — another room is unaffected.
		const other = (await (
			await exports.default.fetch(`${ORIGIN}/matchmake/room/77`, {
				method: 'POST',
				headers: await bearer('9701'),
			})
		).json()) as { errorCode: number }
		expect(other.errorCode).toBe(0)

		// Lifting the ban lets them in again.
		await env.DB.prepare('DELETE FROM room_ban WHERE room_id = 2 AND banned_player_id = 9701').run()
		expect((await matchmake('9701')).errorCode).toBe(0)
	})

	test('POST /matchmake/room/:id invites AdditionalPlayerIds (party) into the instance', async () => {
		// Party invites go out as game invites over notifyPlayer (see vitest stub). 9850 has
		// no friends, so the only recorded sends are the party invites (no presence fan-out).
		type Invite = {
			playerId: number
			notificationType: number
			data: {
				FromPlayerId: number
				ToPlayerId: number
				Type: number
				Data: string
				RoomId: number | null
			}
		}
		const hub = () => env.RECFLARE_NOTIFICATIONS_HUB.getByName('global')
		const reset = () => hub().fetch('http://do/all', { method: 'DELETE' })
		const sent = async (): Promise<Invite[]> =>
			(await (await hub().fetch('http://do/all')).json()) as Invite[]

		const matchmake = async (body: string, sub = '9850'): Promise<Response> =>
			exports.default.fetch(`${ORIGIN}/matchmake/room/2`, {
				method: 'POST',
				headers: { ...(await bearer(sub)), 'Content-Type': 'application/x-www-form-urlencoded' },
				body,
			})

		// The client's exact request shape (the extra fields are accepted and ignored), one
		// party member.
		await reset()
		const res = await matchmake(
			'BypassMovementModeRestriction=False&LoginLock=abc&AdditionalPlayerIds=153&MaxPersistenceVersion=51&JoinMode=0'
		)
		expect(res.status).toBe(200)
		const instance = ((await res.json()) as { roomInstance: { roomInstanceId: number } })
			.roomInstance

		const invites = await sent()
		expect(invites).toHaveLength(1)
		expect(invites[0].playerId).toBe(153) // delivered to the party member
		expect(invites[0].notificationType).toBe(2) // NotificationType.MessageReceived
		expect(invites[0].data).toMatchObject({
			FromPlayerId: 9850, // the party leader (caller)
			ToPlayerId: 153,
			Type: 0, // MessageType.GameInvite
			Data: String(instance.roomInstanceId), // the instance the leader landed in
			RoomId: 2,
		})

		// Multiple ids (repeated fields, not comma-separated), de-duplicated, and the leader
		// themselves is skipped.
		await reset()
		await matchmake(
			'AdditionalPlayerIds=153&AdditionalPlayerIds=154&AdditionalPlayerIds=153&AdditionalPlayerIds=9850&JoinMode=0'
		)
		const many = await sent()
		expect(many.map((i) => i.playerId).sort((a, b) => a - b)).toEqual([153, 154])

		// No AdditionalPlayerIds → nobody is invited.
		await reset()
		await matchmake('JoinMode=0')
		expect(await sent()).toEqual([])
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
			'GET /player',
			'GET /player/avoidjuniors',
			'GET /player/connection-info',
			'GET /player/qos',
			'GET /room/{roomId}/instances',
			'GET /rooms/requiring/developer',
			'GET /rooms/requiring/rrplus',
			'POST /invite',
			'POST /matchmake/club/{clubId}',
			'POST /matchmake/dorm',
			'POST /matchmake/event/{eventId}',
			'POST /matchmake/instance/{instanceId}',
			'POST /matchmake/none',
			'POST /matchmake/player/{playerId}',
			'POST /matchmake/room/{roomId}',
			'POST /matchmake/room/{roomId}/{subRoomId}',
			'POST /player/exclusivelogin',
			'POST /player/heartbeat',
			'POST /player/login',
			'POST /player/logout',
			'POST /player/notifydisconnect',
			'POST /roominstance/{id}/markprivate',
			'POST /roominstance/{id}/reportjoinresult',
			'PUT /player/avoidjuniors',
			'PUT /player/gameserverregionpings',
			'PUT /player/photonregionpings',
			'PUT /player/statusvisibility',
			'PUT /roominstance/{id}/inprogress',
		])

		// Every operation carries a summary — a path present but undescribed is not
		// documentation.
		for (const ops of Object.values(spec.paths)) {
			for (const op of Object.values(ops)) expect(op.summary).toBeTruthy()
		}
	})
})

// An ACCOUNT ban (a `report` row with `banned` set, owned by the api worker) is not
// about any one room, so it is enforced across every matchmake rather than per route —
// see the /matchmake/* gate in match.app.ts. It answers the same BannedFromRoom (55) the
// per-room bans do, which is the code the client renders as "you are banned".
describe('account bans', () => {
	const matchmake = async (path: string, player: string) =>
		exports.default.fetch(`${ORIGIN}${path}`, {
			method: 'POST',
			headers: await bearer(player),
		})

	test('every matchmake route is refused for a banned account', async () => {
		await banAccount(6001)
		// One live instance of room 2 and one club membership, so each route would
		// otherwise have somewhere to put them.
		for (const path of [
			'/matchmake/room/2',
			'/matchmake/room/77/34',
			'/matchmake/dorm',
			'/matchmake/club/4',
			'/matchmake/player/9701',
			'/matchmake/instance/1',
		]) {
			const res = await matchmake(path, '6001')
			expect(res.status, path).toBe(200)
			expect(await res.json(), path).toEqual(refused(55))
		}
	})

	// The refusal is the ban's, not the room's: nothing is entered, so no presence is
	// written and the player stays where they were (nowhere).
	test('a refused matchmake leaves no presence behind', async () => {
		await banAccount(6002)
		expect((await matchmake('/matchmake/room/2', '6002')).status).toBe(200)

		const player = (await (
			await exports.default.fetch(`${ORIGIN}/player?id=6002`, { headers: await bearer('6002') })
		).json()) as Array<{ isOnline: boolean; roomInstance: unknown }>
		expect(player[0]?.roomInstance ?? null).toBeNull()
	})

	// A timed ban lifts itself once its expiry passes — nothing clears the flag.
	test('an expired ban no longer blocks a matchmake', async () => {
		await banAccount(6003, '2020-01-01T00:00:00.000Z')
		const res = await matchmake('/matchmake/room/2', '6003')
		const body = (await res.json()) as { errorCode: number; roomInstance: unknown }
		expect(body.errorCode).toBe(0)
		expect(body.roomInstance).not.toBeNull()
	})

	test('a ban that has not expired yet blocks a matchmake', async () => {
		await banAccount(6004, new Date(Date.now() + 3_600_000).toISOString())
		expect(await (await matchmake('/matchmake/room/2', '6004')).json()).toEqual(refused(55))
	})

	// A report on its own is not a ban — only a moderator converting it is.
	test('an unbanned report does not block a matchmake', async () => {
		await createReport(env.DB, { reporterPlayerId: 1, reportedPlayerId: 6005 })
		const body = (await (await matchmake('/matchmake/room/2', '6005')).json()) as {
			errorCode: number
		}
		expect(body.errorCode).toBe(0)
	})

	// Filing the report doesn't touch the reporter, so they still play.
	test('the reporter is not banned by the report they filed', async () => {
		await banAccount(6006)
		const body = (await (await matchmake('/matchmake/room/2', '1')).json()) as { errorCode: number }
		expect(body.errorCode).toBe(0)
	})

	// The gate must not turn a missing token into "banned" — that's still a 401.
	test('an unauthenticated matchmake is still a 401', async () => {
		const res = await exports.default.fetch(`${ORIGIN}/matchmake/room/2`, { method: 'POST' })
		expect(res.status).toBe(401)
	})

	// Only the matchmakes are gated: presence and the rest of the surface keep working,
	// so a banned player's client isn't left hammering a dead heartbeat.
	test('the gate does not touch non-matchmake routes', async () => {
		await banAccount(6007)
		const res = await exports.default.fetch(`${ORIGIN}/player/heartbeat`, {
			method: 'POST',
			headers: await bearer('6007'),
		})
		expect(res.status).toBe(200)
	})
})

// The ban follows the player past the account it was written on: a new account sharing a
// proven platform identity or an IP with a banned one is refused the same way. See
// bans-db.ts in the api worker for the arms and the BAN_EVASION_MATCH knob.
describe('ban evasion at matchmake', () => {
	const matchmake = async (player: string, ip?: string) =>
		(await (
			await exports.default.fetch(`${ORIGIN}/matchmake/room/2`, {
				method: 'POST',
				headers: { ...(await bearer(player)), ...(ip ? { 'CF-Connecting-IP': ip } : {}) },
			})
		).json()) as { errorCode: number; roomInstance: unknown }

	/** Seed an account row carrying the IPs it signed up / last logged in from. */
	const account = async (id: number, ips: Record<string, string> = {}) => {
		await env.DB.prepare('INSERT OR IGNORE INTO account (data) VALUES (?1)')
			.bind(JSON.stringify({ accountId: id, username: `Player${id}`, ...ips }))
			.run()
	}

	const link = async (id: number, platform: number, platformId: string) => {
		await env.DB.prepare(
			`INSERT OR IGNORE INTO platform_account (account_id, platform, platform_id, linked_at)
			 VALUES (?1, ?2, ?3, ?4)`
		)
			.bind(id, platform, platformId, new Date().toISOString())
			.run()
	}

	test('a new account sharing a banned account’s platform identity is refused', async () => {
		await account(6201)
		await link(6201, 0, 'steam-evader')
		await banAccount(6201)
		// The replacement account: different id, same headset.
		await account(6202)
		await link(6202, 0, 'steam-evader')

		expect(await matchmake('6202')).toEqual(refused(55))
	})

	test('a new account sharing a banned account’s signup IP is refused', async () => {
		await account(6203, { signupIp: '203.0.113.203' })
		await banAccount(6203)
		await account(6204, { signupIp: '203.0.113.203' })

		expect(await matchmake('6204')).toEqual(refused(55))
	})

	// The address the request arrives from counts too, so an account that has never
	// logged in from the banned network before is caught on the first matchmake.
	test('the request’s own IP is matched even when the account has none stored', async () => {
		await account(6205, { signupIp: '203.0.113.205' })
		await banAccount(6205)
		await account(6206)

		expect(await matchmake('6206', '203.0.113.205')).toEqual(refused(55))
		// From anywhere else, that same account plays.
		expect((await matchmake('6206', '198.51.100.50')).errorCode).toBe(0)
	})

	test('an unrelated account is unaffected', async () => {
		await account(6207, { signupIp: '203.0.113.207' })
		await banAccount(6207)
		await account(6208, { signupIp: '198.51.100.208' })
		await link(6208, 0, 'steam-innocent')

		expect((await matchmake('6208')).errorCode).toBe(0)
	})

	// BAN_EVASION_MATCH is the operator's answer to the IP arm's false positives: the
	// housemate of a banned player gets back in, the evader on the same headset does not.
	test('BAN_EVASION_MATCH=platform drops the IP arm but keeps the direct ban', async () => {
		const original = env.BAN_EVASION_MATCH
		await account(6210, { signupIp: '203.0.113.210' })
		await link(6210, 0, 'steam-knob')
		await banAccount(6210)
		await account(6211, { signupIp: '203.0.113.210' }) // housemate
		await account(6212)
		await link(6212, 0, 'steam-knob') // same headset

		try {
			env.BAN_EVASION_MATCH = 'platform'
			expect((await matchmake('6211')).errorCode).toBe(0)
			expect(await matchmake('6212')).toEqual(refused(55))
			// The banned account itself is still refused, whatever the knob says.
			expect(await matchmake('6210')).toEqual(refused(55))

			env.BAN_EVASION_MATCH = 'off'
			expect((await matchmake('6211')).errorCode).toBe(0)
			expect((await matchmake('6212')).errorCode).toBe(0)
			expect(await matchmake('6210')).toEqual(refused(55))
		} finally {
			env.BAN_EVASION_MATCH = original
		}
	})
})
