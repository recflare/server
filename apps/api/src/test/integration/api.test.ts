import { adminSecretsStore, env } from 'cloudflare:test'
import { exports } from 'cloudflare:workers'
import { beforeAll, describe, expect, test } from 'vitest'

import {
	addXp,
	applyLevelUps,
	createImage,
	GAME_VERSION,
	getImageByName,
	grantInvention,
	IMAGE_SCHEMA_DDL,
	INVENTORY_INVENTION_SCHEMA_DDL,
	LEVEL_REQUIRED_XP,
	LEVEL_REWARDS,
	MAX_LEVEL,
	MessageType,
	OUTFIT_SCHEMA_DDL,
	PRESENCE_SCHEMA_DDL,
	PRESENCE_TTL_SECONDS,
	PROGRESSION_SCHEMA_DDL,
	RELATIONSHIP_SCHEMA_DDL,
	ROOM_INSTANCE_SCHEMA_DDL,
	ROOM_SCHEMA_DDL,
	seedRoomWithSubRooms,
	SUBROOM_SCHEMA_DDL,
	SUPPORTED_GAME_VERSIONS,
} from '@repo/domain'

import '../../api.app'

import { PLATFORM_SCHEMA_DDL } from '../../../../auth/src/platform-db'
import { banEvasionMatch, resolveBan } from '../../bans-db'
import {
	createCustomAvatarItem,
	SCHEMA_DDL as CUSTOM_AVATAR_ITEM_SCHEMA_DDL,
} from '../../custom-avatar-items-db'
import {
	countGoing,
	SCHEMA_DDL as EVENTS_SCHEMA_DDL,
	getEventAttendees,
	getEventResponse,
} from '../../events-db'
import { SCHEMA_DDL as INVENTIONS_SCHEMA_DDL } from '../../inventions-db'
import {
	banFromReport,
	createReport,
	getActiveBan,
	getReportsAgainst,
	isPlayerBanned,
	SCHEMA_DDL as REPORTS_SCHEMA_DDL,
} from '../../reports-db'
import {
	CheerCategory,
	DAILY_CHEER_CREDIT,
	getCheerCredit,
	getReputation,
	SCHEMA_DDL as REPUTATION_SCHEMA_DDL,
	spendCheerCredit,
} from '../../reputation-db'
import { charadesWordsFor } from '../../routes/gameplay'
import { getWarningsAgainst, SCHEMA_DDL as WARNINGS_SCHEMA_DDL } from '../../warnings-db'

import type { SavedImage } from '@repo/domain'
import type { Env } from '../../context'
import type { EventTag, PlayerEvent, PlayerEventEnvelope, PlayerEventResult } from '../../events-db'
import type {
	InventionSaveResult,
	InventionSaveV9Result,
	SavedInvention,
} from '../../inventions-db'

declare module 'cloudflare:test' {
	interface ProvidedEnv extends Env {}
}

const ORIGIN = 'https://example.com'

// `/api/rooms/v1/verifyRole` reads room roles from the shared recflare D1. Set
// up the schema (matching the rooms worker's migration) + a couple of rooms.
const TEST_ROOMS = [
	{
		RoomId: 2,
		Name: 'RecCenter',
		IsDorm: false,
		CreatorAccountId: 1,
		SubRooms: [{ SubRoomId: 2 }],
	},
	{
		// Owned by account 1; account 42 holds Role 30 (a co-owner) for verifyRole tests.
		RoomId: 3,
		Name: 'RoleRoom',
		IsDorm: false,
		CreatorAccountId: 1,
		SubRooms: [{ SubRoomId: 3 }],
		Roles: [{ AccountId: 42, Role: 30, LastChangedByAccountId: null, InvitedRole: 0 }],
	},
	{
		// The instant kick's room. Owned by account 42 (the default test token); 43 holds
		// Moderator (20) and 44 only Host (10) — the tier just below that gate.
		RoomId: 4,
		Name: 'KickRoom',
		IsDorm: false,
		CreatorAccountId: 42,
		SubRooms: [{ SubRoomId: 4 }],
		Roles: [
			{ AccountId: 43, Role: 20, LastChangedByAccountId: null, InvitedRole: 0 },
			{ AccountId: 44, Role: 10, LastChangedByAccountId: null, InvitedRole: 0 },
		],
	},
]

beforeAll(async () => {
	// Seed the shared JWT signing key into the local Secrets Store so .get() resolves.
	await adminSecretsStore(env.JWT_SECRET).create('test-signing-key')
	// The rooms worker's schema (room + interaction) — reading a room aggregates its
	// cheer/favorite Stats from `interaction`, so both tables have to be here.
	for (const stmt of ROOM_SCHEMA_DDL) await env.DB.prepare(stmt).run()
	// Subrooms live in their own table now; getRoomById hydrates from it, so create it and
	// split each seeded room's subrooms into it (mirrors the rooms worker's 0007 migration).
	for (const stmt of SUBROOM_SCHEMA_DDL) await env.DB.prepare(stmt).run()
	for (const r of TEST_ROOMS) await seedRoomWithSubRooms(env.DB, r as Record<string, unknown>)

	// Accounts table (matching the auth worker's migration) — uploadsaved records
	// profile thumbnails on the account row. Seed the account the test token (sub
	// 42) authenticates as.
	await env.DB.prepare(
		`CREATE TABLE IF NOT EXISTS account (
			data TEXT NOT NULL,
			account_id INTEGER GENERATED ALWAYS AS (json_extract(data, '$.accountId')) VIRTUAL,
			username_lower TEXT GENERATED ALWAYS AS (lower(json_extract(data, '$.username'))) VIRTUAL
		)`
	).run()
	await env.DB.prepare('INSERT OR IGNORE INTO account (data) VALUES (?1)')
		.bind(
			JSON.stringify({ accountId: 42, username: 'Tester', profileImage: 'DefaultProfileImage.jpg' })
		)
		.run()

	// Images table (owned by the img worker) — uploadsaved records a row here.
	for (const stmt of IMAGE_SCHEMA_DDL) await env.DB.prepare(stmt).run()

	// Relationships table (owned by the api worker) — friendship endpoints use it.
	for (const stmt of RELATIONSHIP_SCHEMA_DDL) await env.DB.prepare(stmt).run()

	// Presence (owned by the rooms worker) — the online-friend count joins onto it.
	for (const stmt of PRESENCE_SCHEMA_DDL) await env.DB.prepare(stmt).run()

	// Room instances (owned by the rooms worker) — the instant kick resolves the game
	// session it is given to the room whose staff may kick from it.
	for (const stmt of ROOM_INSTANCE_SCHEMA_DDL) await env.DB.prepare(stmt).run()

	// Outfit table (owned by the econ worker) — /outfits/me reads and writes slot 0.
	for (const stmt of OUTFIT_SCHEMA_DDL) await env.DB.prepare(stmt).run()

	// Inventions table (owned by the api worker) — invention save/mine use it.
	for (const stmt of INVENTIONS_SCHEMA_DDL) await env.DB.prepare(stmt).run()

	// Bought-invention ownership (owned by the econ worker) — `v2/mine` folds it in.
	for (const stmt of INVENTORY_INVENTION_SCHEMA_DDL) await env.DB.prepare(stmt).run()
	for (const stmt of PROGRESSION_SCHEMA_DDL) await env.DB.prepare(stmt).run()

	// Reports table (owned by the api worker) — player reports are recorded here.
	for (const stmt of REPORTS_SCHEMA_DDL) await env.DB.prepare(stmt).run()
	// Platform identity links (owned by the auth worker) — the sharp arm of the
	// ban-evasion resolution matches on them.
	for (const stmt of PLATFORM_SCHEMA_DDL) await env.DB.prepare(stmt).run()

	// Warnings table (owned by the api worker) — moderator-issued warnings land here.
	for (const stmt of WARNINGS_SCHEMA_DDL) await env.DB.prepare(stmt).run()

	// Player events table (owned by the api worker) — scheduled events live here.
	for (const stmt of EVENTS_SCHEMA_DDL) await env.DB.prepare(stmt).run()

	// Reputation + cheer credit (owned by the api worker) — cheering writes both.
	for (const stmt of REPUTATION_SCHEMA_DDL) await env.DB.prepare(stmt).run()

	// Custom avatar items (owned by the api worker).
	for (const stmt of CUSTOM_AVATAR_ITEM_SCHEMA_DDL) await env.DB.prepare(stmt).run()
})

// Mint a token the way the `auth` worker does, signing with the shared test key seeded into the JWT_SECRET store, so the
// api worker's validation accepts it. Kept inline to avoid a cross-package import.
const TEST_SECRET = 'test-signing-key'

function b64url(input: ArrayBuffer | string): string {
	const bytes = typeof input === 'string' ? new TextEncoder().encode(input) : new Uint8Array(input)
	let binary = ''
	for (const byte of bytes) binary += String.fromCharCode(byte)
	return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

// `roles` mints the `role` claim the auth worker stamps from an account's flags; left
// off, the token carries none, which is what a plain player's looks like to the
// role-gated routes. `version` mints the `rn.ver` claim auth stamps from the build the
// client posted at login; left off, the token carries none, like one issued before the
// claim existed.
async function bearer(
	sub = '42',
	roles?: string[],
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

/** Base64 SHA-256 — the form an invention version's `BlobHash` takes. */
async function base64Sha256(bytes: Uint8Array): Promise<string> {
	const digest = await crypto.subtle.digest('SHA-256', bytes)
	return btoa(String.fromCharCode(...new Uint8Array(digest)))
}

describe('public endpoints', () => {
	test('GET /api/config/v1/amplitude', async () => {
		const res = await exports.default.fetch(`${ORIGIN}/api/config/v1/amplitude`)
		expect(res.status).toBe(200)
		expect(await res.json()).toEqual({
			AmplitudeKey: '',
			UseRudderStack: false,
			RudderStackKey: '',
			UseStatSig: false,
			StatSigKey: '',
			StatSigEnvironment: 0,
		})
	})

	test('GET /api/config/v1/azurespeech', async () => {
		const res = await exports.default.fetch(`${ORIGIN}/api/config/v1/azurespeech`)
		expect(res.status).toBe(200)
		expect(await res.json()).toEqual({
			Key: 'dce8de5b297747d9b5bddcc7f19e8c5b',
			Region: 'eastus',
			Enabled: false,
		})
	})

	test('GET /api/config/v1/backtrace', async () => {
		const res = await exports.default.fetch(`${ORIGIN}/api/config/v1/backtrace`)
		expect(res.status).toBe(200)
		const body = (await res.json()) as { ReportBudget: number; VersionRegex: string }
		expect(body).toMatchObject({ ReportBudget: 125, VersionRegex: '.*' })
	})

	test('GET /api/versioncheck/v4 reports current for the matching build', async () => {
		const res = await exports.default.fetch(`${ORIGIN}/api/versioncheck/v4?v=${GAME_VERSION}`)
		expect(await res.json()).toMatchObject({ VersionStatus: 0 })
	})

	test('GET /api/versioncheck/v4 reports current for every supported build', async () => {
		for (const version of SUPPORTED_GAME_VERSIONS) {
			const res = await exports.default.fetch(`${ORIGIN}/api/versioncheck/v4?v=${version}`)
			expect(await res.json(), version).toMatchObject({ VersionStatus: 0 })
		}
	})

	test('GET /api/versioncheck/v4 flags a mismatched build', async () => {
		const res = await exports.default.fetch(`${ORIGIN}/api/versioncheck/v4?v=19990101`)
		expect(await res.json()).toMatchObject({ VersionStatus: 1 })
	})

	test('GET /api/versioncheck/v4 flags a client that sends no build', async () => {
		const res = await exports.default.fetch(`${ORIGIN}/api/versioncheck/v4`)
		expect(await res.json()).toMatchObject({ VersionStatus: 1 })
	})

	// Two catalogs, picked off the token's `rn.ver`: a build newer than GAME_VERSION gets
	// the 2025 one. `Avatars.AdvancedFaceCustomizationEnabled` is a key only that catalog
	// has, so its presence identifies which body was served.
	const gameConfigKeys = async (version?: string) => {
		const res = await exports.default.fetch(`${ORIGIN}/api/gameconfigs/v1/all`, {
			headers: version === undefined ? {} : await bearer('42', undefined, version),
		})
		expect(res.status).toBe(200)
		return new Set(((await res.json()) as Array<{ Key: string }>).map((e) => e.Key))
	}
	const KEY_2025_ONLY = 'Avatars.AdvancedFaceCustomizationEnabled'

	test('GET /api/gameconfigs/v1/all serves the 2025 catalog to a newer build', async () => {
		for (const version of ['20250718.01', '20250424.01', '20231207']) {
			expect(await gameConfigKeys(version), version).toContain(KEY_2025_ONLY)
		}
	})

	test('GET /api/gameconfigs/v1/all serves the 2023 catalog to the target build', async () => {
		expect(await gameConfigKeys(GAME_VERSION)).not.toContain(KEY_2025_ONLY)
	})

	test('GET /api/gameconfigs/v1/all serves the 2023 catalog to an older build', async () => {
		expect(await gameConfigKeys('20220101')).not.toContain(KEY_2025_ONLY)
	})

	test('GET /api/gameconfigs/v1/all falls back to the 2023 catalog without a token', async () => {
		// No token, and a token with no `rn.ver`: neither is evidence of a newer client, so
		// both get the body this route has always served.
		expect(await gameConfigKeys()).not.toContain(KEY_2025_ONLY)
		const res = await exports.default.fetch(`${ORIGIN}/api/gameconfigs/v1/all`, {
			headers: await bearer('42'),
		})
		expect(((await res.json()) as Array<{ Key: string }>).map((e) => e.Key)).not.toContain(
			KEY_2025_ONLY
		)
	})

	test('GET /api/versioncheck/islandedversions is empty', async () => {
		const res = await exports.default.fetch(`${ORIGIN}/api/versioncheck/islandedversions`)
		expect(res.status).toBe(200)
		expect(await res.json()).toEqual([])
	})

	test('GET /api/relationships/v2/get returns empty array for a player with none', async () => {
		const res = await exports.default.fetch(`${ORIGIN}/api/relationships/v2/get`, {
			headers: await bearer('99999'),
		})
		expect(res.status).toBe(200)
		expect(await res.json()).toEqual([])
	})

	test('GET /api/playerReputation/v1/:id echoes the id', async () => {
		const res = await exports.default.fetch(`${ORIGIN}/api/playerReputation/v1/99`)
		expect(await res.json()).toMatchObject({ AccountId: 99, CheerCredit: 20 })
	})

	test('GET /api/playerReputation/v2/bulk?id= returns a reputation per id', async () => {
		const res = await exports.default.fetch(`${ORIGIN}/api/playerReputation/v2/bulk?id=1380`)
		expect(res.status).toBe(200)
		// The full reputation shape the client expects, field for field.
		expect(await res.json()).toEqual([
			{
				AccountId: 1380,
				IsCheerful: true,
				Noteriety: 0,
				SelectedCheer: 0,
				CheerCredit: 20,
				CheerGeneral: 0,
				CheerHelpful: 0,
				CheerCreative: 0,
				CheerGreatHost: 0,
				CheerSportsman: 0,
				SubscriberCount: 0,
				SubscribedCount: 0,
			},
		])

		const many = await exports.default.fetch(`${ORIGIN}/api/playerReputation/v2/bulk?id=1&id=2`)
		const reps = (await many.json()) as Array<{ AccountId: number }>
		expect(reps.map((r) => r.AccountId)).toEqual([1, 2])
	})

	// Cheering: `POST /api/PlayerCheer/v1/create`. The giver comes from the token, so these
	// use ids of their own (71xx) rather than the shared 42 — a spent credit is durable
	// state, and the reputation reads above assert all-zero records.
	const cheer = async (fields: Record<string, string>, sub = '7100') =>
		exports.default.fetch(`${ORIGIN}/api/PlayerCheer/v1/create`, {
			method: 'POST',
			headers: {
				...(await bearer(sub)),
				'Content-Type': 'application/x-www-form-urlencoded',
			},
			body: new URLSearchParams(fields),
		})

	const reputationOf = async (id: number) =>
		(await (await exports.default.fetch(`${ORIGIN}/api/playerReputation/v1/${id}`)).json()) as {
			CheerCredit: number
			CheerGeneral: number
			CheerHelpful: number
		}

	test('a cheer counts on the target and spends the giver’s credit', async () => {
		// The body the client posts, verbatim from the live request.
		const res = await cheer({
			PlayerIdTo: '7101',
			CheerCategory: '0',
			RoomId: '112',
			Anonymous: 'False',
		})
		expect(res.status).toBe(200)
		expect(await res.json()).toEqual({ Success: true, Message: null })

		// The target's counter moved and nothing else did — in particular their OWN credit is
		// untouched, since receiving a cheer doesn't pay for giving one.
		expect(await reputationOf(7101)).toMatchObject({
			CheerGeneral: 1,
			CheerHelpful: 0,
			CheerCredit: DAILY_CHEER_CREDIT,
		})
		// The giver paid, and has no counters of their own.
		expect(await reputationOf(7100)).toMatchObject({
			CheerGeneral: 0,
			CheerCredit: DAILY_CHEER_CREDIT - 1,
		})
	})

	test('each category counts into its own column', async () => {
		for (const category of [
			CheerCategory.General,
			CheerCategory.Helpful,
			CheerCategory.Sportmanship,
			CheerCategory.GreatHost,
			CheerCategory.Creative,
		]) {
			expect(
				(await cheer({ PlayerIdTo: '7102', CheerCategory: String(category) }, '7103')).status
			).toBe(200)
		}
		expect(await getReputation(env.DB, 7102)).toEqual({
			AccountId: 7102,
			IsCheerful: true,
			Noteriety: 0,
			SelectedCheer: 0,
			CheerCredit: DAILY_CHEER_CREDIT,
			CheerGeneral: 1,
			CheerHelpful: 1,
			CheerCreative: 1,
			CheerGreatHost: 1,
			CheerSportsman: 1,
			SubscriberCount: 0,
			SubscribedCount: 0,
		})
	})

	test('a cheer the server can’t count is refused before it costs anything', async () => {
		// Each refusal answers 200 with the reason — the client shows `Message` — and none of
		// them may take a credit off the caller, which is what the closing assertion checks.
		for (const [fields, Message] of [
			[{ PlayerIdTo: '7105' }, 'CheerCategory is not a cheer category'],
			// -1 is the enum's `None`: a real member, but not a counter.
			[{ PlayerIdTo: '7105', CheerCategory: '-1' }, 'CheerCategory is not a cheer category'],
			[{ PlayerIdTo: '7105', CheerCategory: '5' }, 'CheerCategory is not a cheer category'],
			[{ CheerCategory: '0' }, 'PlayerIdTo is required'],
			[{ PlayerIdTo: '7104', CheerCategory: '0' }, 'You cannot cheer yourself'],
		] as Array<[Record<string, string>, string]>) {
			const res = await cheer(fields, '7104')
			expect(res.status).toBe(200)
			expect(await res.json()).toEqual({ Success: false, Message })
		}
		expect(await getCheerCredit(env.DB, 7104)).toBe(DAILY_CHEER_CREDIT)
		expect(await reputationOf(7105)).toMatchObject({ CheerGeneral: 0 })
	})

	test('the cheer frame plays in front of the whole room instance', async () => {
		// Presence is written by the `match` worker; seeded straight into the table here.
		// 7108 (the giver), 7109 (the target) and 7120 (a bystander) share instance 8800;
		// 7121 stands in a different instance and must hear nothing.
		const standIn = async (accountId: number, roomInstanceId: number | null) =>
			env.DB.prepare('INSERT OR REPLACE INTO presence (data) VALUES (?1)')
				.bind(
					JSON.stringify({
						accountId,
						roomInstance: roomInstanceId === null ? null : { roomInstanceId, roomId: 112 },
						statusVisibility: 0,
						deviceClass: 0,
						vrMovementMode: 0,
						platform: 0,
						appVersion: GAME_VERSION,
						expiresAt: Math.floor(Date.now() / 1000) + PRESENCE_TTL_SECONDS,
					})
				)
				.run()

		// The notify DO is stubbed to record every notifyPlayer / notifyPlayersEphemeral call
		// (see vitest.config).
		const cheerHub = () => env.RECFLARE_NOTIFICATIONS_HUB.getByName('global')
		const framesFor = async (anonymous: string) => {
			await cheerHub().fetch('http://do/all', { method: 'DELETE' })
			expect(
				(
					await cheer(
						{ PlayerIdTo: '7109', CheerCategory: '10', RoomId: '112', Anonymous: anonymous },
						'7108'
					)
				).status
			).toBe(200)
			return (await (await cheerHub().fetch('http://do/all')).json()) as Array<{
				playerId?: number
				playerIds?: number[]
				ephemeral?: boolean
				notificationType: string
				data: Record<string, unknown>
			}>
		}

		for (const id of [7108, 7109, 7120]) await standIn(id, 8800)
		await standIn(7121, 8801)

		// A signed cheer. Four sends: the PlayerCheer message that plays the cheer on the
		// target's client, then the ReputationUpdate for the target durably, the rest of their
		// instance ephemerally, and the giver's own credit refresh.
		const all = await framesFor('False')
		expect(all).toHaveLength(4)
		expect(all[0]).toMatchObject({
			playerId: 7109,
			notificationType: 2, // NotificationType.MessageReceived
			data: { FromPlayerId: 7108, ToPlayerId: 7109, Type: MessageType.PlayerCheer, Data: '10' },
		})
		expect(all[0]!.ephemeral).toBeFalsy()
		const signed = all.slice(1)
		expect(signed.every((f) => f.notificationType === 'ReputationUpdate')).toBe(true)

		// `AccountId` is who the frame is ABOUT, not who it goes to — the room hears about
		// 7109. The frame is 7109's RECORD: `SelectedCheer` is their pinned cheer (none), not
		// the category just given, and `IsCheerful` is the profile flag — the message above
		// is what plays the cheer.
		const played = {
			AccountId: 7109,
			IsCheerful: true,
			SelectedCheer: 0,
			CheerHelpful: 1,
		}
		expect(signed[0]).toMatchObject({ playerId: 7109, data: played })
		// The bystander and the giver see it; the target is not in the room list (they got
		// the durable copy), and 7121 is in another instance entirely.
		expect(signed[1]).toMatchObject({ playerIds: [7108, 7120], ephemeral: true, data: played })

		// The giver's second frame is about THEM: their record with the spent credit.
		expect(signed[2]).toMatchObject({
			playerId: 7108,
			data: {
				AccountId: 7108,
				IsCheerful: true,
				SelectedCheer: 0,
				CheerCredit: DAILY_CHEER_CREDIT - 1,
			},
		})

		// An anonymous cheer reaches exactly the same people and moves the same counter —
		// it just doesn't announce who gave it: the message is the anonymous type from
		// sender 0. The reputation frames are the same records as before.
		const allAnonymous = await framesFor('True')
		expect(allAnonymous).toHaveLength(4)
		expect(allAnonymous[0]).toMatchObject({
			playerId: 7109,
			notificationType: 2, // NotificationType.MessageReceived
			data: {
				FromPlayerId: 0,
				ToPlayerId: 7109,
				Type: MessageType.PlayerCheerAnonymous,
				Data: '10',
			},
		})
		const anonymous = allAnonymous.slice(1)
		expect(anonymous[0]).toMatchObject({
			playerId: 7109,
			data: { AccountId: 7109, IsCheerful: true, SelectedCheer: 0, CheerHelpful: 2 },
		})
		expect(anonymous[1]).toMatchObject({ playerIds: [7108, 7120], data: { IsCheerful: true } })

		// The frame carries only the fields the client's decoder has — no Noteriety or
		// subscriber counts, which live on the profile DTO alone.
		expect(Object.keys(anonymous[0]!.data).sort()).toEqual([
			'AccountId',
			'CheerCreative',
			'CheerCredit',
			'CheerGeneral',
			'CheerGreatHost',
			'CheerHelpful',
			'CheerSportsman',
			'IsCheerful',
			'SelectedCheer',
		])
	})

	test('a cheer with no room instance still reaches the player cheered', async () => {
		// Cheering from a profile screen: the giver has lobby presence (roomInstance null),
		// so there is no audience — but the target's own frame is not the room's to lose.
		await env.DB.prepare('INSERT OR REPLACE INTO presence (data) VALUES (?1)')
			.bind(
				JSON.stringify({
					accountId: 7130,
					roomInstance: null,
					statusVisibility: 0,
					deviceClass: 0,
					vrMovementMode: 0,
					platform: 0,
					appVersion: GAME_VERSION,
					expiresAt: Math.floor(Date.now() / 1000) + PRESENCE_TTL_SECONDS,
				})
			)
			.run()
		const cheerHub = () => env.RECFLARE_NOTIFICATIONS_HUB.getByName('global')
		await cheerHub().fetch('http://do/all', { method: 'DELETE' })

		expect((await cheer({ PlayerIdTo: '7131', CheerCategory: '40' }, '7130')).status).toBe(200)

		const frames = (await (await cheerHub().fetch('http://do/all')).json()) as Array<{
			playerId?: number
			ephemeral?: boolean
			data: Record<string, unknown>
		}>
		// Three sends — the target's cheer message and reputation, then the giver's
		// reputation — all durable and all addressed: nothing was broadcast.
		expect(frames.map((f) => f.playerId)).toEqual([7131, 7131, 7130])
		expect(frames.some((f) => f.ephemeral)).toBe(false)
		expect(frames[0]!.data).toMatchObject({
			ToPlayerId: 7131,
			Type: MessageType.PlayerCheer,
			Data: '40',
		})
		expect(frames[1]!.data).toMatchObject({ AccountId: 7131, CheerCreative: 1 })
	})

	test('SetSelectedCheer pins a cheer to the profile and pushes the record', async () => {
		const pin = async (CheerCategory: string, sub: string) =>
			exports.default.fetch(`${ORIGIN}/api/PlayerCheer/v1/SetSelectedCheer`, {
				method: 'POST',
				headers: { ...(await bearer(sub)), 'Content-Type': 'application/x-www-form-urlencoded' },
				body: new URLSearchParams({ CheerCategory }),
			})
		const hub = () => env.RECFLARE_NOTIFICATIONS_HUB.getByName('global')
		await hub().fetch('http://do/all', { method: 'DELETE' })

		// 7140 has never been cheered — pinning still works, creating their row.
		const res = await pin(String(CheerCategory.GreatHost), '7140')
		expect(res.status).toBe(200)
		expect(await res.json()).toEqual({ Success: true, Message: null })
		expect(await getReputation(env.DB, 7140)).toMatchObject({
			SelectedCheer: CheerCategory.GreatHost,
			IsCheerful: true,
			CheerGreatHost: 0,
		})
		const frames = (await (await hub().fetch('http://do/all')).json()) as Array<{
			playerId?: number
			data: Record<string, unknown>
		}>
		expect(frames).toHaveLength(1)
		expect(frames[0]).toMatchObject({
			playerId: 7140,
			data: { AccountId: 7140, SelectedCheer: CheerCategory.GreatHost },
		})

		// The pin survives a cheer landing on the row, and a cheer's frame carries it.
		expect((await cheer({ PlayerIdTo: '7140', CheerCategory: '0' }, '7141')).status).toBe(200)
		expect(await reputationOf(7140)).toMatchObject({ CheerGeneral: 1 })
		expect(await getReputation(env.DB, 7140)).toMatchObject({
			SelectedCheer: CheerCategory.GreatHost,
		})

		// -1 (`None`) unpins, read back as 0; a made-up category is refused.
		expect(await (await pin('-1', '7140')).json()).toEqual({ Success: true, Message: null })
		expect(await getReputation(env.DB, 7140)).toMatchObject({ SelectedCheer: 0 })
		expect(await (await pin('7', '7140')).json()).toEqual({
			Success: false,
			Message: 'CheerCategory is not a cheer category',
		})
		expect(await pin('0', '7140').then((r) => r.status)).toBe(200)
		expect(
			(
				await exports.default.fetch(`${ORIGIN}/api/PlayerCheer/v1/SetSelectedCheer`, {
					method: 'POST',
					body: new URLSearchParams({ CheerCategory: '0' }),
				})
			).status
		).toBe(401)
	})

	test('cheering needs a token', async () => {
		const res = await exports.default.fetch(`${ORIGIN}/api/PlayerCheer/v1/create`, {
			method: 'POST',
			headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
			body: new URLSearchParams({ PlayerIdTo: '7101', CheerCategory: '0' }),
		})
		expect(res.status).toBe(401)
	})

	test('the daily credit runs out and refills a day after the FIRST cheer', async () => {
		// Driven through spendCheerCredit with an injected clock: burning 20 cheers over HTTP
		// says nothing more than this does, and the rollover can't be tested any other way.
		const start = new Date('2026-08-25T09:00:00.000Z')
		const at = (hours: number) => new Date(start.getTime() + hours * 60 * 60 * 1000)

		// The first spend opens the window; the credit counts down to nothing.
		for (let spent = 1; spent <= DAILY_CHEER_CREDIT; spent++) {
			// Spread across the window — spending inside it must not slide the deadline.
			expect(await spendCheerCredit(env.DB, 7110, at(spent === 1 ? 0 : 12))).toBe(
				DAILY_CHEER_CREDIT - spent
			)
		}
		expect(await spendCheerCredit(env.DB, 7110, at(12))).toBeNull()
		expect(await getCheerCredit(env.DB, 7110, at(12))).toBe(0)

		// 23 hours in, still empty: the window is measured from the first cheer, not the last.
		expect(await spendCheerCredit(env.DB, 7110, at(23))).toBeNull()

		// A day after that first cheer it refills — lazily, on the spend itself, so nothing
		// has to run on a schedule.
		expect(await getCheerCredit(env.DB, 7110, at(24.5))).toBe(DAILY_CHEER_CREDIT)
		expect(await spendCheerCredit(env.DB, 7110, at(24.5))).toBe(DAILY_CHEER_CREDIT - 1)
		expect(await getCheerCredit(env.DB, 7110, at(25))).toBe(DAILY_CHEER_CREDIT - 1)
	})

	test('a player out of credit is refused, and the target keeps their counters', async () => {
		// Empty 7106's credit directly, then try to cheer over HTTP.
		for (let i = 0; i < DAILY_CHEER_CREDIT; i++) await spendCheerCredit(env.DB, 7106)
		const res = await cheer({ PlayerIdTo: '7107', CheerCategory: '10' }, '7106')
		expect(res.status).toBe(200)
		expect(await res.json()).toEqual({
			Success: false,
			Message: 'You are out of cheers for today',
		})
		expect(await reputationOf(7107)).toMatchObject({ CheerHelpful: 0 })
	})

	test('GET /api/activities/charades/v1/words/Charades returns the word bank', async () => {
		const res = await exports.default.fetch(`${ORIGIN}/api/activities/charades/v1/words/Charades`)
		expect(res.status).toBe(200)
		const words = (await res.json()) as Array<{ Id: number; Difficulty: number; EN_US: string }>
		expect(Array.isArray(words)).toBe(true)
		expect(words.length).toBeGreaterThan(0)
		// Which bank that is depends on the day — the April Fools list replaces the ordinary
		// one on April 1st — so compare against the same selector the route uses rather than
		// hard-coding a word here. The two banks' contents are pinned below.
		expect(words).toEqual(charadesWordsFor())
	})

	test('serves the April Fools charades words on April 1st and the ordinary list otherwise', () => {
		// A replacement, not an addition: the joke list stands alone for the day, and its ids
		// start past the end of the ordinary one rather than overlapping it.
		const april = charadesWordsFor(new Date('2026-04-01T12:00:00Z'))
		expect(april[0]).toEqual({ Id: 1258, Difficulty: 10, EN_US: 'Nothing' })

		const ordinary = charadesWordsFor(new Date('2026-04-02T12:00:00Z'))
		expect(ordinary[0]).toEqual({ Id: 1, Difficulty: 0, EN_US: 'David Bowie' })
		expect(ordinary.some((w) => w.Id === april[0].Id)).toBe(false)

		// Every other day gets the ordinary list, including the edges of April 1 UTC and the
		// first of other months.
		expect(charadesWordsFor(new Date('2026-03-31T23:59:59Z'))).toBe(ordinary)
		expect(charadesWordsFor(new Date('2026-04-02T00:00:00Z'))).toBe(ordinary)
		expect(charadesWordsFor(new Date('2026-05-01T12:00:00Z'))).toBe(ordinary)
		expect(charadesWordsFor(new Date('2026-01-01T12:00:00Z'))).toBe(ordinary)

		// The window is the whole of April 1 in UTC, not local time.
		expect(charadesWordsFor(new Date('2026-04-01T00:00:00Z'))).toBe(april)
		expect(charadesWordsFor(new Date('2026-04-01T23:59:59Z'))).toBe(april)
	})

	// The client POSTs this with no body, despite it being a pure read; the route answers
	// GET as well, and both methods serve the same body.
	test.each(['GET', 'POST'])(
		'%s /api/PlayerReporting/v1/moderationBlockDetails reports "not blocked"',
		async (method) => {
			const res = await exports.default.fetch(
				`${ORIGIN}/api/PlayerReporting/v1/moderationBlockDetails`,
				{ method }
			)
			expect(res.status).toBe(200)
			// ReportCategory -1 = Unknown (0 is a real category). Message is null, not the
			// reference stub's empty string — the client tells "no message" from a blank one.
			expect(await res.json()).toEqual({
				ReportCategory: -1,
				Duration: 0,
				GameSessionId: 0,
				IsBan: false,
				IsHostKick: false,
				IsVoiceModAutoban: false,
				Message: null,
				PlayerIdReporter: null,
				TimeoutStartedAt: null,
			})
		}
	)

	// A fixed list, in render order — the client shows the buttons in the order they
	// arrive, so the order is part of the contract, not just the contents.
	test('GET /api/PlayerReporting/v1/voteToKickReasons serves the reasons in order', async () => {
		const res = await exports.default.fetch(`${ORIGIN}/api/PlayerReporting/v1/voteToKickReasons`, {
			headers: await bearer(),
		})
		expect(res.status).toBe(200)
		expect(await res.json()).toEqual([
			{ Reason: 'Discriminatory language', ReportCategory: 102 },
			{ Reason: 'Discriminatory behavior', ReportCategory: 102 },
			{ Reason: 'Threats or encouraging suicide', ReportCategory: 102 },
			{ Reason: 'Toxic behavior', ReportCategory: 102 },
			{ Reason: 'Sexual behavior in public', ReportCategory: 101 },
			{ Reason: 'Sexual language in public', ReportCategory: 101 },
			{ Reason: 'Non-consensual sexual behavior', ReportCategory: 101 },
			{ Reason: 'Player in walls or floor', ReportCategory: 103 },
			{ Reason: 'Friendly fire', ReportCategory: 103 },
			{ Reason: 'Microphone spam', ReportCategory: 103 },
			{ Reason: 'Abusing bugs or exploits', ReportCategory: 103 },
			{ Reason: 'Spawn camping', ReportCategory: 103 },
			{ Reason: 'Inactive in games (AFK)', ReportCategory: 6 },
			{ Reason: 'Prefab swapping', ReportCategory: 6 },
			{ Reason: 'Not following game rules', ReportCategory: 6 },
		])
	})

	test('GET /api/PlayerReporting/v1/voteToKickReasons is auth-gated', async () => {
		const res = await exports.default.fetch(`${ORIGIN}/api/PlayerReporting/v1/voteToKickReasons`)
		expect(res.status).toBe(401)
	})

	test('POST /api/PlayerReporting/v1/referee says the caller is not one', async () => {
		const res = await exports.default.fetch(`${ORIGIN}/api/PlayerReporting/v1/referee`, {
			method: 'POST',
		})
		expect(res.status).toBe(200)
		// A bare boolean, not an envelope or a list.
		expect(await res.json()).toBe(false)
	})

	test('GET /api/referee/files has no cases', async () => {
		const res = await exports.default.fetch(`${ORIGIN}/api/referee/files`)
		expect(res.status).toBe(200)
		expect(await res.json()).toEqual([])
	})

	// Unauthenticated by design — the client posts this before it has an account, so
	// there's no bearer token to check and nothing to attribute the id to.
	test('POST /api/PlayerReporting/v1/deviceId accepts an unauthenticated report', async () => {
		const res = await exports.default.fetch(`${ORIGIN}/api/PlayerReporting/v1/deviceId`, {
			method: 'POST',
			headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
			body: new URLSearchParams({
				oldDeviceId: '491e8b9',
				newDeviceId: '491e8b9566cb1b593367c72860e978b3d5765326',
				platform: '0',
			}),
		})
		expect(res.status).toBe(200)
		expect(await res.json()).toEqual([])
	})

	test('POST /api/playerReputation/v2/bulk returns a reputation per id', async () => {
		const res = await exports.default.fetch(`${ORIGIN}/api/playerReputation/v2/bulk`, {
			method: 'POST',
			headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
			body: new URLSearchParams({ Ids: '1,2,3' }),
		})
		expect(res.status).toBe(200)
		const reps = (await res.json()) as Array<{ AccountId: number; CheerCredit: number }>
		expect(reps.map((r) => r.AccountId)).toEqual([1, 2, 3])
		expect(reps.every((r) => r.CheerCredit === 20)).toBe(true)
	})

	test('POST /api/playerReputation/v2/bulk returns [] without ids', async () => {
		const res = await exports.default.fetch(`${ORIGIN}/api/playerReputation/v2/bulk`, {
			method: 'POST',
		})
		expect(await res.json()).toEqual([])
	})

	test('GET /api/players/v2/progression/bulk?id= returns progression per id', async () => {
		const res = await exports.default.fetch(`${ORIGIN}/api/players/v2/progression/bulk?id=1&id=2`)
		expect(res.status).toBe(200)
		const body = (await res.json()) as Array<{ PlayerId: number; Level: number }>
		expect(body.map((p) => p.PlayerId)).toEqual([1, 2])
		expect(body[0]).toMatchObject({ Level: 1, XP: 0 })
	})

	test('progression reads back the XP game rewards banked, levelled up', async () => {
		// The two workers share this table; `econ` writes it when a game reward is claimed (5 XP
		// at a time). Granted in one lump here to exercise a multi-level climb: 25 XP from level
		// 1 pays the 10 to reach 2 and the 10 to reach 3, leaving 5.
		expect(await addXp(env.DB, 4242, 25)).toEqual({
			progression: { PlayerId: 4242, Level: 3, XP: 5 },
			levelsGained: 2,
		})
		// The next 25 lands on 5: 10 to reach level 4, then 20 to reach 5, leaving nothing.
		await addXp(env.DB, 4242, 25)

		const single = await exports.default.fetch(`${ORIGIN}/api/players/v1/progression/4242`)
		expect(await single.json()).toEqual({ PlayerId: 4242, Level: 5, XP: 0 })

		// A player who has earned nothing has no row, and still gets a record — the bulk form
		// renders a card per id, so a missing one must not shorten the list.
		const bulk = await exports.default.fetch(
			`${ORIGIN}/api/players/v2/progression/bulk?id=4242&id=4243`
		)
		expect(await bulk.json()).toEqual([
			{ PlayerId: 4242, Level: 5, XP: 0 },
			{ PlayerId: 4243, Level: 1, XP: 0 },
		])
	})

	test('the level ladder the server uses is the one the client is served', async () => {
		// The client draws its bar against `LevelProgressionMaps` from this config; the server
		// levels by LEVEL_REQUIRED_XP. If they drift, the bar fills to a different mark than
		// the level-up fires at.
		const res = await exports.default.fetch(`${ORIGIN}/api/config/v2`)
		expect(res.status).toBe(200)
		const config = (await res.json()) as {
			LevelProgressionMaps: Array<{ Level: number; RequiredXp: number; GiftRarity: number }>
		}
		expect(config.LevelProgressionMaps.map((m) => m.RequiredXp)).toEqual([...LEVEL_REQUIRED_XP])
		// The config's own `GiftRarity` is deliberately NOT asserted against `LEVEL_REWARDS`:
		// it is a coarse per-band tier (flat 10 to level 14, 20 to 39, 30 to 49, 50 at the cap)
		// and we grant from the published per-level table instead, which disagrees in places —
		// level 15 is 2-Star there and 20 here. Only the XP costs have to match.
		expect(config.LevelProgressionMaps.map((m) => m.GiftRarity)).toHaveLength(LEVEL_REWARDS.length)
		// Indexed by level, so entry N is what a level-N player spends to reach N+1.
		expect(config.LevelProgressionMaps.map((m) => m.Level)).toEqual(
			LEVEL_REQUIRED_XP.map((_, level) => level)
		)
	})

	test('the level rewards match the published reward table', async () => {
		// Rec Room's published level-reward table, spot-checked at the points where it turns:
		// consumables early, then clothing at a rising star rating (2★ = 10, 3★ = 20, 4★ = 30,
		// 5★ = 50). These are the levels an off-by-one in the table would move.
		expect(LEVEL_REWARDS[0]).toBe(0) // nobody reaches level 0
		expect([1, 3, 5, 6, 7, 9].map((level) => LEVEL_REWARDS[level])).toEqual([
			-1, -1, -1, -1, -1, -1,
		])
		expect([2, 4, 8, 10, 21].map((level) => LEVEL_REWARDS[level])).toEqual([10, 10, 10, 10, 10])
		expect([22, 30].map((level) => LEVEL_REWARDS[level])).toEqual([20, 20])
		expect([31, 35, 40, 49].map((level) => LEVEL_REWARDS[level])).toEqual([30, 30, 30, 30])
		expect(LEVEL_REWARDS[50]).toBe(50) // the only 5-Star in the progression
		expect(LEVEL_REWARDS).toHaveLength(51)
	})

	test('the ladder matches the published XP curve', async () => {
		// Rec Room's own level-curve chart, read at its gridlines: cumulative XP to finish each
		// level. The per-level costs are easy to edit one at a time and hard to eyeball as a
		// curve, so the milestones are what actually pin the shape.
		const cumulative = LEVEL_REQUIRED_XP.reduce<number[]>((totals, cost, level) => {
			totals[level] = level === 0 ? 0 : (totals[level - 1] ?? 0) + cost
			return totals
		}, [])
		expect(cumulative[10]).toBe(170)
		expect(cumulative[20]).toBe(620)
		expect(cumulative[30]).toBe(1770)
		expect(cumulative[40]).toBe(5370)
		expect(cumulative[50]).toBe(16170)
	})

	test('levelling stops at the top of the ladder', async () => {
		// Nothing above MAX_LEVEL to buy, so a huge grant banks XP and stays put.
		expect(applyLevelUps(MAX_LEVEL, 100_000)).toEqual({ level: MAX_LEVEL, xp: 100_000 })
		// …and a grant that doesn't cover the current level's cost just accrues.
		expect(applyLevelUps(1, 9)).toEqual({ level: 1, xp: 9 })
	})

	test('POST /api/players/v2/progression/bulk returns an array', async () => {
		const res = await exports.default.fetch(`${ORIGIN}/api/players/v2/progression/bulk`, {
			method: 'POST',
			headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
			body: new URLSearchParams({ Ids: '1,2,3' }),
		})
		expect(res.status).toBe(200)
		expect(await res.json()).toEqual([])
	})

	test('GET /api/customAvatarItems/v1/isCreationAllowedForAccount returns a success envelope', async () => {
		const res = await exports.default.fetch(
			`${ORIGIN}/api/customAvatarItems/v1/isCreationAllowedForAccount`
		)
		expect(res.status).toBe(200)
		expect(await res.json()).toEqual({ success: true, value: null })
	})

	test('GET /api/customAvatarItems/v1/isCreationEnabled returns true', async () => {
		const res = await exports.default.fetch(`${ORIGIN}/api/customAvatarItems/v1/isCreationEnabled`)
		expect(res.status).toBe(200)
		expect(await res.json()).toBe(true)
	})

	test('GET /api/customAvatarItems/v1/isRenderingEnabled returns true', async () => {
		const res = await exports.default.fetch(`${ORIGIN}/api/customAvatarItems/v1/isRenderingEnabled`)
		expect(res.status).toBe(200)
		expect(await res.json()).toBe(true)
	})

	test('GET /api/customAvatarItems/v1/featured lists flagged, published items, newest first', async () => {
		await env.DB.prepare('DELETE FROM custom_avatar_item').run()
		const older = await createCustomAvatarItem(
			env.DB,
			item('Older', 1),
			new Date('2026-08-01T00:00:00Z')
		)
		const newer = await createCustomAvatarItem(
			env.DB,
			item('Newer', 1),
			new Date('2026-08-02T00:00:00Z')
		)
		const unpublished = await createCustomAvatarItem(env.DB, item('Unpublished', 0))
		const unflagged = await createCustomAvatarItem(env.DB, item('Unflagged', 1))
		// Nothing flags items yet, so flag straight in the table — the unflagged one stays.
		await env.DB.prepare(
			'UPDATE custom_avatar_item SET is_featured = 1 WHERE custom_avatar_item_id != ?1'
		)
			.bind(unflagged.CustomAvatarItemId)
			.run()

		const res = await exports.default.fetch(`${ORIGIN}/api/customAvatarItems/v1/featured`)
		expect(res.status).toBe(200)
		const got = (await res.json()) as Array<{ CustomAvatarItemId: string; Name: string }>
		expect(got.map((i) => i.CustomAvatarItemId)).toEqual([
			newer.CustomAvatarItemId,
			older.CustomAvatarItemId,
		])
		expect(got.map((i) => i.CustomAvatarItemId)).not.toContain(unpublished.CustomAvatarItemId)
		expect(got[0]).toMatchObject({ Name: 'Newer', IsFeatured: true, CurrentSaves: [] })

		function item(name: string, accessibility: number) {
			return {
				customAvatarItemId: crypto.randomUUID(),
				creatorAccountId: 205,
				name,
				description: '',
				price: 0,
				baseAvatarItemId: 1,
				baseAvatarItemColor: '#fff',
				accessibility,
				designFilename: 'design_x.bin',
				thumbnailImageFilename: 'thumb_x.png',
			}
		}
	})

	test('GET /api/CircuitChipLists/:list is empty for any name', async () => {
		// A palette on the Maker Pen's circuit board, named by the path. Nothing records which
		// chips a player has used or favourited, so every one of them is empty — including names
		// this server has never heard of, which the client will ask for as its build changes.
		// An unknown name being a 404 would render as a palette that FAILED to load rather than
		// one with nothing in it.
		for (const list of [
			'Favorites',
			'Recent',
			'All',
			'SomePaletteThisServerHasNeverHeardOf',
			// Path-segment oddities: a name that needs escaping, and a numeric one.
			encodeURIComponent('Weird Name/With Slash'),
			'42',
		]) {
			const res = await exports.default.fetch(`${ORIGIN}/api/CircuitChipLists/${list}`)
			expect(res.status, list).toBe(200)
			expect(await res.json(), list).toEqual([])
		}
	})

	test('GET /api/inventions/v1/featureddormskins returns []', async () => {
		const res = await exports.default.fetch(`${ORIGIN}/api/inventions/v1/featureddormskins`)
		expect(res.status).toBe(200)
		expect(await res.json()).toEqual([])
	})

	test('GET /api/customAvatarItems/v1/hot lists the published items, newest first', async () => {
		await env.DB.prepare('DELETE FROM custom_avatar_item').run()
		const empty = await exports.default.fetch(`${ORIGIN}/api/customAvatarItems/v1/hot`)
		expect(empty.status).toBe(200)
		expect(await empty.json()).toEqual([])

		const older = await createCustomAvatarItem(
			env.DB,
			item('Older', 1),
			new Date('2026-08-01T00:00:00Z')
		)
		const newer = await createCustomAvatarItem(
			env.DB,
			item('Newer', 1),
			new Date('2026-08-02T00:00:00Z')
		)
		const unpublished = await createCustomAvatarItem(env.DB, item('Unpublished', 0))

		const res = await exports.default.fetch(`${ORIGIN}/api/customAvatarItems/v1/hot`)
		expect(res.status).toBe(200)
		const got = (await res.json()) as Array<{ CustomAvatarItemId: string; Name: string }>
		// Unfeatured but published: the hot feed does not care about the featured flag.
		expect(got.map((i) => i.CustomAvatarItemId)).toEqual([
			newer.CustomAvatarItemId,
			older.CustomAvatarItemId,
		])
		expect(got.map((i) => i.CustomAvatarItemId)).not.toContain(unpublished.CustomAvatarItemId)
		expect(got[0]).toMatchObject({ Name: 'Newer', IsFeatured: false, CurrentSaves: [] })

		function item(name: string, accessibility: number) {
			return {
				customAvatarItemId: crypto.randomUUID(),
				creatorAccountId: 205,
				name,
				description: '',
				price: 0,
				baseAvatarItemId: 1,
				baseAvatarItemColor: '#fff',
				accessibility,
				designFilename: 'design_x.bin',
				thumbnailImageFilename: 'thumb_x.png',
			}
		}
	})

	test('GET /api/customAvatarItems/v1/search filters, pages and excludes unpublished', async () => {
		await env.DB.prepare('DELETE FROM custom_avatar_item').run()

		const search = async (query: string) => {
			const res = await exports.default.fetch(`${ORIGIN}/api/customAvatarItems/v1/search${query}`)
			expect(res.status, query).toBe(200)
			return (await res.json()) as Array<{
				CustomAvatarItemId: string
				Name: string
				OutfitType: number
				PurchaseInfo: null
			}>
		}

		// A BARE ARRAY, not the `{ Results, TotalResults }` envelope `fromCreator` uses.
		expect(await search('')).toEqual([])

		const made: Record<string, string> = {}
		// Six published items across three outfit types, plus one unpublished and one Coach's.
		// Creation times ascend with the index so "newest first" is unambiguous.
		const spec: Array<[name: string, outfitType: number, accessibility: number, creator: number]> =
			[
				['Hat A', 0, 1, 205],
				['Shirt A', 2, 1, 205],
				['Shirt B', 2, 1, 205],
				['Trousers A', 3, 1, 205],
				['Coach Hat', 0, 1, 1],
				['Hidden', 0, 0, 205],
			]
		for (const [i, [name, outfitType, accessibility, creator]] of spec.entries()) {
			const created = await createCustomAvatarItem(
				env.DB,
				{
					customAvatarItemId: crypto.randomUUID(),
					creatorAccountId: creator,
					name,
					description: '',
					price: 0,
					baseAvatarItemId: 1,
					baseAvatarItemColor: '#fff',
					accessibility,
					designFilename: 'design_x.bin',
					thumbnailImageFilename: 'thumb_x.png',
				},
				new Date(Date.UTC(2026, 7, 1 + i))
			)
			made[name] = created.CustomAvatarItemId
			// Nothing sets outfit_type on creation yet, so set it straight in the table.
			await env.DB.prepare(
				'UPDATE custom_avatar_item SET outfit_type = ?2 WHERE custom_avatar_item_id = ?1'
			)
				.bind(created.CustomAvatarItemId, outfitType)
				.run()
		}

		// Newest first, and `Hidden` never appears: Accessibility 0 is unpublished, and this is
		// the shared browse surface — its creator sees it through `fromCreator`, not here.
		const all = await search('')
		expect(all.map((i) => i.Name)).toEqual([
			'Coach Hat',
			'Trousers A',
			'Shirt B',
			'Shirt A',
			'Hat A',
		])

		// `outfitTypes` repeats and acts as a whitelist — the real client sends a dozen of them.
		expect((await search('?outfitTypes=2')).map((i) => i.Name)).toEqual(['Shirt B', 'Shirt A'])
		expect((await search('?outfitTypes=0&outfitTypes=3')).map((i) => i.Name)).toEqual([
			'Coach Hat',
			'Trousers A',
			'Hat A',
		])

		// Sending NONE means no filter, not no results: the client sends every type it can render,
		// so reading an absent parameter as an empty `IN ()` would empty the store.
		expect((await search('?skip=0&take=100')).map((i) => i.Name)).toEqual(all.map((i) => i.Name))

		// A non-numeric value is dropped rather than becoming NaN, which would match nothing and
		// quietly empty a filter the caller believes they set.
		expect((await search('?outfitTypes=2&outfitTypes=nonsense')).map((i) => i.Name)).toEqual([
			'Shirt B',
			'Shirt A',
		])

		// Paging, and it is STABLE: consecutive pages must not repeat or skip a row, which the
		// id tiebreak in the ordering is what guarantees when timestamps collide.
		const page1 = await search('?skip=0&take=2')
		const page2 = await search('?skip=2&take=2')
		expect(page1.map((i) => i.Name)).toEqual(['Coach Hat', 'Trousers A'])
		expect(page2.map((i) => i.Name)).toEqual(['Shirt B', 'Shirt A'])
		expect(
			page1.some((i) => page2.some((j) => j.CustomAvatarItemId === i.CustomAvatarItemId))
		).toBe(false)
		expect(await search('?skip=99&take=10')).toEqual([])
		expect(await search('?take=0')).toEqual([])

		// The client capitalises its booleans (`includeCoachItems=True`), so the comparison folds
		// case; only a recognisable "false" turns the stock content off.
		expect((await search('?includeCoachItems=True')).map((i) => i.Name)).toContain('Coach Hat')
		expect((await search('?includeCoachItems=false')).map((i) => i.Name)).not.toContain('Coach Hat')

		// The whole query the client actually sends, unchanged — the parameters that aren't acted
		// on yet must be accepted rather than 400 or throw.
		const real = await search(
			'?outfitTypes=0&outfitTypes=2&outfitTypes=3&outfitTypes=10&outfitTypes=20&outfitTypes=100' +
				'&outfitTypes=101&outfitTypes=102&outfitTypes=103&outfitTypes=200&outfitTypes=300' +
				'&outfitTypes=301&includePurchaseInfos=True&includeCoachItems=True&ordering=0&skip=0' +
				'&take=100&unityAssetTarget=0&unityAssetVersion=3'
		)
		expect(real.map((i) => i.Name)).toEqual(all.map((i) => i.Name))
		// `includePurchaseInfos=True` notwithstanding: nothing prices a custom item here yet, so
		// the field is null on every item and the parameter changes nothing.
		expect(real.every((i) => i.PurchaseInfo === null)).toBe(true)
	})

	test('GET /api/customAvatarItems/v1/search matches name or description, and bounds price', async () => {
		await env.DB.prepare('DELETE FROM custom_avatar_item').run()

		const search = async (query: string) => {
			const res = await exports.default.fetch(`${ORIGIN}/api/customAvatarItems/v1/search${query}`)
			expect(res.status, query).toBe(200)
			return ((await res.json()) as Array<{ Name: string }>).map((i) => i.Name)
		}

		const make = async (name: string, description: string, price: number, i: number) =>
			createCustomAvatarItem(
				env.DB,
				{
					customAvatarItemId: crypto.randomUUID(),
					creatorAccountId: 205,
					name,
					description,
					price,
					baseAvatarItemId: 1,
					baseAvatarItemColor: '#fff',
					accessibility: 1,
					designFilename: 'design_x.bin',
					thumbnailImageFilename: 'thumb_x.png',
				},
				new Date(Date.UTC(2026, 7, 1 + i))
			)

		await make('Room Hat', '', 100, 0)
		// Matched on DESCRIPTION, not name — the two are searched together.
		await make('Cosy Beanie', 'Warm in any ROOM', 500, 1)
		// Matched case-insensitively and as a SUBSTRING, mid-word.
		await make('Ballroom Shoes', '', 9000, 2)
		await make('Unrelated Cap', 'nothing to do with it', 250, 3)
		// A name holding LIKE metacharacters, for the escaping below.
		await make('100% Wool', 'a_b', 50, 4)

		// Newest first throughout, so the order also proves the query didn't disturb the ordering.
		expect(await search('?searchQuery=room')).toEqual(['Ballroom Shoes', 'Cosy Beanie', 'Room Hat'])
		// Case folds both ways: SQLite's own LIKE only folds ASCII, so both sides are lowered.
		expect(await search('?searchQuery=ROOM')).toEqual(['Ballroom Shoes', 'Cosy Beanie', 'Room Hat'])
		expect(await search('?searchQuery=beanie')).toEqual(['Cosy Beanie'])
		expect(await search('?searchQuery=nothing%20to%20do')).toEqual(['Unrelated Cap'])
		expect(await search('?searchQuery=zzzz')).toEqual([])

		// Blank or absent is NO filter, not an empty result — a cleared search box must show the
		// store rather than nothing.
		expect(await search('?searchQuery=')).toHaveLength(5)
		expect(await search('?searchQuery=%20%20')).toHaveLength(5)

		// A needle of LIKE metacharacters matches them LITERALLY. Unescaped, `%` would match every
		// item and `_` any single character, so a player searching for "100%" would get the lot.
		expect(await search('?searchQuery=%25')).toEqual(['100% Wool'])
		expect(await search('?searchQuery=a_b')).toEqual(['100% Wool'])

		// Price bounds, inclusive at both ends.
		expect(await search('?minPrice=250&maxPrice=9000')).toEqual([
			'Unrelated Cap',
			'Ballroom Shoes',
			'Cosy Beanie',
		])
		expect(await search('?maxPrice=100')).toEqual(['100% Wool', 'Room Hat'])
		expect(await search('?minPrice=9000')).toEqual(['Ballroom Shoes'])
		expect(await search('?minPrice=100000')).toEqual([])

		// Combined with the text search, since the client sends both together.
		expect(await search('?searchQuery=room&maxPrice=500')).toEqual(['Cosy Beanie', 'Room Hat'])

		// The whole query the client actually sends. `itemTypes` and the unity asset parameters are
		// accepted and not acted on; `outfitTypes=105` matches nothing, so this is empty — which is
		// the filter working, not the search failing.
		expect(
			await search(
				'?searchQuery=room&itemTypes=-1&outfitTypes=105&minPrice=0&maxPrice=10000' +
					'&includePurchaseInfos=True&includeCoachItems=False&ordering=0&skip=0&take=1000' +
					'&unityAssetTarget=0&unityAssetVersion=3'
			)
		).toEqual([])
		// Same query with the outfit-type filter dropped: the rest of it does match.
		expect(
			await search(
				'?searchQuery=room&itemTypes=-1&minPrice=0&maxPrice=10000&includePurchaseInfos=True' +
					'&includeCoachItems=False&ordering=0&skip=0&take=1000&unityAssetTarget=0' +
					'&unityAssetVersion=3'
			)
		).toEqual(['Ballroom Shoes', 'Cosy Beanie', 'Room Hat'])
	})

	test('GET /api/customAvatarItems/v2/fromCreator/:id shows unpublished items only to the creator', async () => {
		await env.DB.prepare('DELETE FROM custom_avatar_item').run()
		const base = {
			description: '',
			price: 0,
			baseAvatarItemId: 1,
			baseAvatarItemColor: '#fff',
			designFilename: 'design_x.bin',
			thumbnailImageFilename: 'thumb_x.png',
		}
		const pub = await createCustomAvatarItem(
			env.DB,
			{
				...base,
				customAvatarItemId: crypto.randomUUID(),
				creatorAccountId: 205,
				name: 'Published',
				accessibility: 1,
			},
			new Date('2026-08-01T00:00:00Z')
		)
		const draft = await createCustomAvatarItem(
			env.DB,
			{
				...base,
				customAvatarItemId: crypto.randomUUID(),
				creatorAccountId: 205,
				name: 'Draft',
				accessibility: 0,
			},
			new Date('2026-08-02T00:00:00Z')
		)
		await createCustomAvatarItem(env.DB, {
			...base,
			customAvatarItemId: crypto.randomUUID(),
			creatorAccountId: 9,
			name: 'Other',
			accessibility: 0,
		})

		type Page = { Results: Array<{ CustomAvatarItemId: string }>; TotalResults: number }
		const url = `${ORIGIN}/api/customAvatarItems/v2/fromCreator/205`

		// Anonymous, or someone else: only the published (Accessibility != 0) item.
		for (const headers of [{}, await bearer('9')]) {
			const res = await exports.default.fetch(url, { headers })
			expect(res.status).toBe(200)
			const page = (await res.json()) as Page
			expect(page.TotalResults).toBe(1)
			expect(page.Results.map((i) => i.CustomAvatarItemId)).toEqual([pub.CustomAvatarItemId])
		}

		// The creator: their unpublished item too, newest first.
		const own = (await (
			await exports.default.fetch(url, { headers: await bearer('205') })
		).json()) as Page
		expect(own.TotalResults).toBe(2)
		expect(own.Results.map((i) => i.CustomAvatarItemId)).toEqual([
			draft.CustomAvatarItemId,
			pub.CustomAvatarItemId,
		])

		const none = await exports.default.fetch(`${ORIGIN}/api/customAvatarItems/v2/fromCreator/2`)
		expect(await none.json()).toEqual({ Results: [], TotalResults: 0 })
	})

	// Nothing locks avatar items here, so the array is empty and the posted ids are never
	// parsed. Unlike the custom-item bulk below, this one takes no token — the reference
	// answers outright.
	test('POST /api/avatar/v1/lockeditems/bulk returns [] without auth', async () => {
		const res = await exports.default.fetch(`${ORIGIN}/api/avatar/v1/lockeditems/bulk`, {
			method: 'POST',
			headers: { 'content-type': 'application/json' },
			body: JSON.stringify(['a', 'b']),
		})
		expect(res.status).toBe(200)
		expect(await res.json()).toEqual([])
	})

	/** Create a custom avatar item and return it, so a bulk lookup has something to find. */
	async function createCustomItem(
		creator: string,
		metadata: Record<string, unknown>
	): Promise<{ CustomAvatarItemId: string; Name: string }> {
		const form = new FormData()
		form.set(
			'metadata',
			JSON.stringify({
				Name: 'bulk item',
				Description: '',
				Price: 0,
				BaseAvatarItemId: 2184,
				BaseAvatarItemColor: '#F55C1A',
				Accessibility: 1,
				...metadata,
			})
		)
		form.set('thumbnailImage', new File([new Uint8Array([1])], 'f.bin', { type: 'image/png' }))
		form.set('design', new File([new Uint8Array([2])], 'f.bin', { type: 'image/png' }))
		const res = await exports.default.fetch(`${ORIGIN}/api/customAvatarItems/v1`, {
			method: 'POST',
			headers: await bearer(creator),
			body: form,
		})
		expect(res.status).toBe(200)
		return ((await res.json()) as { Value: { CustomAvatarItemId: string; Name: string } }).Value
	}

	/** POST the bulk lookup with `ids` as repeated form fields, as the client binds them. */
	async function bulkLookup(
		ids: string[],
		as = '42'
	): Promise<Array<{ CustomAvatarItemId: string; Name: string }>> {
		const res = await exports.default.fetch(`${ORIGIN}/api/customAvatarItems/v1/bulk`, {
			method: 'POST',
			headers: { 'content-type': 'application/x-www-form-urlencoded', ...(await bearer(as)) },
			// Repeated form field, as `[FromForm] List<string>` binds it.
			body: new URLSearchParams(ids.map((id) => ['customAvatarItemIds', id])),
		})
		expect(res.status).toBe(200)
		return (await res.json()) as Array<{ CustomAvatarItemId: string; Name: string }>
	}

	// A BARE ARRAY of the items that matched — not the `{ Results, TotalResults }` page
	// the sibling custom-item reads serve — resolved out of the `custom_avatar_item` table.
	// This is what a `1.<guid>` entity in a Generic discovery row resolves through, so it
	// answering `[]` (as it did while it was a stub) renders that row's items as nothing.
	test('POST /api/customAvatarItems/v1/bulk resolves the posted ids against the table', async () => {
		const first = await createCustomItem('205', { Name: 'bulk one' })
		const second = await createCustomItem('205', { Name: 'bulk two' })

		// In REQUEST order, not creation order — the client reads the array positionally.
		const items = await bulkLookup([second.CustomAvatarItemId, first.CustomAvatarItemId])
		expect(items.map((i) => i.CustomAvatarItemId)).toEqual([
			second.CustomAvatarItemId,
			first.CustomAvatarItemId,
		])
		expect(items[0]).toMatchObject({ Name: 'bulk two', CreatorAccountId: 205, Accessibility: 1 })

		// A miss is an absent entry, not an error: the client reads the items it got back
		// rather than the ids it asked for, so an unknown id must not cost it the rest.
		const mixed = await bulkLookup([
			'00000000-0000-0000-0000-000000000000',
			first.CustomAvatarItemId,
		])
		expect(mixed.map((i) => i.CustomAvatarItemId)).toEqual([first.CustomAvatarItemId])

		// Ids also ride comma-separated inside one field, and on the query string — the
		// client's exact encoding here isn't pinned down, so all three spellings are read.
		const commas = await bulkLookup([`${first.CustomAvatarItemId},${second.CustomAvatarItemId}`])
		expect(commas).toHaveLength(2)
		const queried = await exports.default.fetch(
			`${ORIGIN}/api/customAvatarItems/v1/bulk?customAvatarItemIds=${first.CustomAvatarItemId}`,
			{ method: 'POST', headers: await bearer() }
		)
		expect(((await queried.json()) as unknown[]).length).toBe(1)

		// Over 100 ids answers EMPTY without touching the table. The client has been seen posting
		// far more than a screen could draw, and empty is safe precisely because a miss here is
		// already not an error. Empty rather than the first 100: the client reads the items it got
		// back, not the ids it asked about, so it cannot tell a truncated batch from a batch of
		// misses and would cache the difference.
		const padding = Array.from({ length: 99 }, () => '00000000-0000-0000-0000-000000000000')
		expect(await bulkLookup([first.CustomAvatarItemId, ...padding])).toHaveLength(1)
		expect(
			await bulkLookup([first.CustomAvatarItemId, second.CustomAvatarItemId, ...padding])
		).toEqual([])
	})

	// Unpublished items are held back from everyone but their creator — the same rule the
	// featured/hot feeds and the creator shelf apply, so this route can't surface an item
	// the feeds hide.
	test('POST /api/customAvatarItems/v1/bulk hides unpublished items from everyone but the creator', async () => {
		const hidden = await createCustomItem('206', { Name: 'unpublished', Accessibility: 0 })

		expect(await bulkLookup([hidden.CustomAvatarItemId], '42')).toEqual([])
		const own = await bulkLookup([hidden.CustomAvatarItemId], '206')
		expect(own.map((i) => i.Name)).toEqual(['unpublished'])
	})

	// A missing body is a 200 with an empty array rather than a 400: nothing was asked for,
	// so nothing matched — the same shape as asking for ids that all miss.
	test('POST /api/customAvatarItems/v1/bulk answers an empty array for an empty body', async () => {
		const res = await exports.default.fetch(`${ORIGIN}/api/customAvatarItems/v1/bulk`, {
			method: 'POST',
			headers: await bearer(),
		})
		expect(res.status).toBe(200)
		expect(await res.json()).toEqual([])
	})

	test('POST /api/customAvatarItems/v1/bulk is auth-gated', async () => {
		const res = await exports.default.fetch(`${ORIGIN}/api/customAvatarItems/v1/bulk`, {
			method: 'POST',
		})
		expect(res.status).toBe(401)
	})

	test('POST /api/customAvatarItems/GetCustomAvatarItemCurrentSavesForLegacyAvatarItems returns an empty map', async () => {
		const res = await exports.default.fetch(
			`${ORIGIN}/api/customAvatarItems/GetCustomAvatarItemCurrentSavesForLegacyAvatarItems`,
			{
				method: 'POST',
				headers: { 'content-type': 'application/json' },
				body: JSON.stringify({ AvatarItemIds: [1, 2, 3] }),
			}
		)
		expect(res.status).toBe(200)
		expect(await res.json()).toEqual({ customAvatarItemSavesByAvatarItemDesc: {} })
	})

	test('GET /outfits/me 401s without a token, serves the empty envelope for a new player', async () => {
		const anon = await exports.default.fetch(`${ORIGIN}/outfits/me`)
		expect(anon.status).toBe(401)
		// Account 77 never saves an outfit, so it keeps getting the new-account envelope.
		const res = await exports.default.fetch(`${ORIGIN}/outfits/me`, { headers: await bearer('77') })
		expect(res.status).toBe(200)
		expect(await res.json()).toEqual({
			FaceFeatures: '',
			HairColor: '',
			OutfitSelections: '',
			SkinColor: '',
		})
	})

	test('PUT /outfits/me saves into slot 0; GET reads it back verbatim', async () => {
		// The client's own payload, trimmed to one selection: the point is that the heavy
		// JSON-in-a-string fields survive the round trip as strings, unparsed.
		const outfit = {
			DataVersion: 2,
			LegacyData: {
				SelectionsV1: '193a3bf9-abc0-4d78-8d63-92046908b1c5,,0',
				SelectionsV2:
					'{"selections":[{"PrefabGuid":"193a3bf9-abc0-4d78-8d63-92046908b1c5","CombinationGuid":"","BodyPart":0}]}',
				FaceFeatures: '{"ver":7,"eyeId":"Aeu0yxJXG0qCOLZW5Tcu7A","hideEars":false}',
				SkinColor: 'Dc6StLFk60u5iUTrb3_C3w',
				HairColor: 'UAT0OaWEkUG-mWDIyiX1Kg',
			},
			CustomizationSettings: '{"AvatarVersion":2,"AvatarBodyType":0}',
			Selections: [],
			Slot: 0,
			Name: null,
			Accessibility: 1,
			ThumbnailFileName: null,
		}

		const anon = await exports.default.fetch(`${ORIGIN}/outfits/me`, {
			method: 'PUT',
			headers: { 'content-type': 'application/json' },
			body: JSON.stringify(outfit),
		})
		expect(anon.status).toBe(401)

		const res = await exports.default.fetch(`${ORIGIN}/outfits/me`, {
			method: 'PUT',
			headers: { ...(await bearer()), 'content-type': 'application/json' },
			body: JSON.stringify(outfit),
		})
		expect(res.status).toBe(200)
		// The save answers the base envelope — three keys, no `Value`, and NOT the outfit
		// just sent. Note the mixed casing: `Success`/`Error` but `error_id`.
		expect(await res.json()).toEqual({ Success: true, Error: null, error_id: null })

		// The read serves it back byte-for-byte — the JSON-in-a-string fields are still
		// strings, not re-encoded objects.
		const read = await exports.default.fetch(`${ORIGIN}/outfits/me`, { headers: await bearer() })
		expect(await read.json()).toEqual(outfit)

		// Re-saving overwrites slot 0 rather than adding a second row.
		const changed = { ...outfit, LegacyData: { ...outfit.LegacyData, SkinColor: 'changed' } }
		await exports.default.fetch(`${ORIGIN}/outfits/me`, {
			method: 'PUT',
			headers: { ...(await bearer()), 'content-type': 'application/json' },
			body: JSON.stringify(changed),
		})
		const reread = await exports.default.fetch(`${ORIGIN}/outfits/me`, { headers: await bearer() })
		expect(await reread.json()).toEqual(changed)
		const rows = await env.DB.prepare(
			'SELECT COUNT(*) AS n FROM outfit WHERE account_id = 42'
		).first<{ n: number }>()
		expect(rows?.n).toBe(1)

		// A save naming another slot does not touch what the caller is wearing.
		await exports.default.fetch(`${ORIGIN}/outfits/me`, {
			method: 'PUT',
			headers: { ...(await bearer()), 'content-type': 'application/json' },
			body: JSON.stringify({ ...changed, Slot: 3, Name: 'slot three' }),
		})
		const worn = await exports.default.fetch(`${ORIGIN}/outfits/me`, { headers: await bearer() })
		expect(((await worn.json()) as { Name: string | null }).Name).toBe(null)
	})

	test('GET /outfits/me/saved 401s without a token, returns [] with one', async () => {
		const anon = await exports.default.fetch(`${ORIGIN}/outfits/me/saved`)
		expect(anon.status).toBe(401)
		// Empty even for account 42, which saved an outfit through PUT /outfits/me above.
		const res = await exports.default.fetch(`${ORIGIN}/outfits/me/saved`, {
			headers: await bearer(),
		})
		expect(res.status).toBe(200)
		expect(await res.json()).toEqual([])
	})

	test('POST /outfits/bulk serves each account’s worn outfit, keyed by id', async () => {
		const bulk = async (body: unknown, sub?: string) =>
			exports.default.fetch(`${ORIGIN}/outfits/bulk`, {
				method: 'POST',
				headers: {
					...(sub === undefined ? {} : await bearer(sub)),
					'content-type': 'application/json',
				},
				body: JSON.stringify(body),
			})

		// Two accounts with a saved outfit, and one with none.
		const outfitFor = (skin: string) => ({
			DataVersion: 2,
			LegacyData: {
				SelectionsV1: '193a3bf9-abc0-4d78-8d63-92046908b1c5,,0',
				SelectionsV2: '{"selections":[]}',
				FaceFeatures: '{"ver":7}',
				SkinColor: skin,
				HairColor: 'UAT0OaWEkUG-mWDIyiX1Kg',
			},
			CustomizationSettings: '{"AvatarVersion":2,"AvatarBodyType":0}',
			Selections: [],
			Slot: 0,
			Name: '',
			Accessibility: 1,
			ThumbnailFileName: null,
		})
		const saved = new Map([
			[187, outfitFor('skin-187')],
			[220, outfitFor('skin-220')],
		])
		for (const [accountId, outfit] of saved) {
			const res = await exports.default.fetch(`${ORIGIN}/outfits/me`, {
				method: 'PUT',
				headers: { ...(await bearer(String(accountId))), 'content-type': 'application/json' },
				body: JSON.stringify(outfit),
			})
			expect(res.status).toBe(200)
		}

		expect((await bulk({ AccountIds: [187] })).status).toBe(401)

		const res = await bulk(
			{ AccountIds: [187, 220], UnityAssetTarget: null, UnityAssetVersion: null },
			'42'
		)
		expect(res.status).toBe(200)
		// A map keyed by the account id as a STRING, each value the outfit exactly as saved —
		// the JSON-in-a-string fields are still strings.
		expect(await res.json()).toEqual({
			OutfitsByAccountId: {
				'187': saved.get(187),
				'220': saved.get(220),
			},
		})

		// An account with nothing saved is ABSENT rather than carrying a null, and a repeated
		// id collapses instead of appearing twice.
		const sparse = await bulk({ AccountIds: [187, 999888, 187] }, '42')
		expect(await sparse.json()).toEqual({ OutfitsByAccountId: { '187': saved.get(187) } })

		// No ids is an empty map, not every outfit on the server.
		expect(await (await bulk({ AccountIds: [] }, '42')).json()).toEqual({ OutfitsByAccountId: {} })

		// 99 distinct accounts is the most one request may name — one query, one round trip.
		const atCap = [...Array.from({ length: 98 }, (_, i) => 500000 + i), 220]
		expect(await (await bulk({ AccountIds: atCap }, '42')).json()).toEqual({
			OutfitsByAccountId: { '220': saved.get(220) },
		})
		// One more is refused rather than answered in part, which would read as "those
		// accounts have no outfit". Duplicates don't count against the cap.
		expect((await bulk({ AccountIds: [...atCap, 500999] }, '42')).status).toBe(400)
		expect((await bulk({ AccountIds: [...atCap, ...atCap] }, '42')).status).toBe(200)

		// An unparseable body is a 400, like the save's. (A body that parses but isn't an
		// object — a bare string, say — names no accounts and so answers an empty map.)
		const bad = await exports.default.fetch(`${ORIGIN}/outfits/bulk`, {
			method: 'POST',
			headers: { ...(await bearer('42')), 'content-type': 'application/json' },
			body: 'not json',
		})
		expect(bad.status).toBe(400)
	})

	test('PUT /outfits/me 400s on an unparseable body', async () => {
		const res = await exports.default.fetch(`${ORIGIN}/outfits/me`, {
			method: 'PUT',
			headers: { ...(await bearer()), 'content-type': 'application/json' },
			body: 'not json',
		})
		expect(res.status).toBe(400)
	})

	test('GET /api/progressionEvents/active is an empty list (no auth)', async () => {
		// The client reads an empty list as "no event running" and skips the event UI; a 404
		// would stall its load instead.
		const res = await exports.default.fetch(`${ORIGIN}/api/progressionEvents/active`)
		expect(res.status).toBe(200)
		expect(await res.json()).toEqual([])
	})

	test('GET /api/rooms/v1/filters returns an object with filter arrays', async () => {
		const res = await exports.default.fetch(`${ORIGIN}/api/rooms/v1/filters`)
		expect(res.status).toBe(200)
		const body = (await res.json()) as { PinnedFilters: string[]; PopularFilters: string[] }
		expect(Array.isArray(body.PinnedFilters)).toBe(true)
		expect(Array.isArray(body.PopularFilters)).toBe(true)
	})

	test('GET /api/keepsakes/globalconfig returns the keepsake config', async () => {
		const res = await exports.default.fetch(`${ORIGIN}/api/keepsakes/globalconfig`)
		expect(res.status).toBe(200)
		expect(await res.json()).toMatchObject({ KeepsakeFeatureEnabled: true })
	})

	test('GET /api/keepsakes/rooms/:id returns 204; categories returns an empty result set', async () => {
		const room = await exports.default.fetch(`${ORIGIN}/api/keepsakes/rooms/1`)
		expect(room.status).toBe(204)
		// A result set, not a list: the client parses this one as an object and an array
		// fails it outright ("expected '{', actual '['").
		const cats = await exports.default.fetch(`${ORIGIN}/api/keepsakes/categories`)
		expect(cats.status).toBe(200)
		expect(await cats.json()).toEqual({ Results: [], TotalResults: 0 })
	})

	test('POST /statsigUserProperties returns the StatsigEnabled flag', async () => {
		const res = await exports.default.fetch(`${ORIGIN}/statsigUserProperties`, { method: 'POST' })
		expect(res.status).toBe(200)
		expect(await res.json()).toEqual({ success: true })
	})

	test('GET /voice/config returns an object', async () => {
		const res = await exports.default.fetch(`${ORIGIN}/voice/config`)
		expect(res.status).toBe(200)
		expect(await res.json()).toEqual({})
	})

	test('GET /api/inventions/v2/mine 401s without a bearer token', async () => {
		const res = await exports.default.fetch(`${ORIGIN}/api/inventions/v2/mine`)
		expect(res.status).toBe(401)
	})

	test('GET /api/inventions/v2/mine returns [] for a player with none', async () => {
		const res = await exports.default.fetch(`${ORIGIN}/api/inventions/v2/mine`, {
			headers: await bearer('7777'),
		})
		expect(res.status).toBe(200)
		expect(await res.json()).toEqual([])
	})

	test('POST /api/inventions/v6/save persists the invention and lists it in mine', async () => {
		const body = {
			name: '071126 13:10:50',
			description: 'No description yet',
			imageName: '2026-07-11/0ff3d5f9-e544-422d-84a0-dec46195a82b.jpg',
			instantiationCost: 103,
			lightsCost: 0,
			chipsCost: 0,
			cloudVariablesCost: 0,
			aiCost: 0,
			creationRoomId: 73,
			inventionDataFilename: '2026-07-11/cc15a7fa-2e81-4da0-b8f1-2a4dcd8ae1a3',
			referencedInventions: [],
			creatorAccountRole: 255,
		}
		const res = await exports.default.fetch(`${ORIGIN}/api/inventions/v6/save`, {
			method: 'POST',
			headers: { ...(await bearer('5150')), 'Content-Type': 'application/json' },
			body: JSON.stringify(body),
		})
		expect(res.status).toBe(200)
		// Save answers with the `{ Status, Invention, InventionVersion }` envelope —
		// the version sits alongside the invention, not only nested inside it.
		const result = (await res.json()) as InventionSaveResult
		expect(result.Status).toBe(0)
		const saved = result.Invention
		expect(saved.InventionId).toBeGreaterThan(0)
		expect(saved.CreatorPlayerId).toBe(5150)
		expect(saved.Name).toBe(body.name)
		expect(saved.Description).toBe(body.description)
		expect(saved.ImageName).toBe(body.imageName)
		// Costs + the data blob live on the version. The blob name always carries the
		// `.inv` extension the client expects, whether or not the client sent it.
		expect(result.InventionVersion).toMatchObject({
			InventionId: saved.InventionId,
			VersionNumber: 1,
			InstantiationCost: 103,
			LightsCost: 0,
			BlobName: `${body.inventionDataFilename}.inv`,
		})
		expect(saved.CurrentVersion.BlobName).toBe(`${body.inventionDataFilename}.inv`)

		// An extension the client already supplied isn't doubled up.
		const withExt = await exports.default.fetch(`${ORIGIN}/api/inventions/v6/save`, {
			method: 'POST',
			headers: { ...(await bearer('5150')), 'Content-Type': 'application/json' },
			body: JSON.stringify({ name: 'Already Suffixed', inventionDataFilename: '2026-07-12/x.inv' }),
		})
		expect(((await withExt.json()) as InventionSaveResult).InventionVersion.BlobName).toBe(
			'2026-07-12/x.inv'
		)
		expect(saved.CreationRoomId).toBe(73)
		// Fully permissioned from the start (the client's creatorAccountRole is a room
		// role, not an invention permission, so it's ignored); publishing is what
		// narrows GeneralPermission down.
		expect(saved.CreatorPermission).toBe(100)
		expect(saved.GeneralPermission).toBe(100)
		expect(saved.AllowTrial).toBe(true)
		// Freshly saved → private/unpublished until the player publishes it.
		expect(saved.IsPublished).toBe(false)
		expect(saved.FirstPublishedAt).toBeNull()
		expect(typeof saved.CreatedAt).toBe('string')

		const mine = await exports.default.fetch(`${ORIGIN}/api/inventions/v2/mine`, {
			headers: await bearer('5150'),
		})
		expect(mine.status).toBe(200)
		const list = (await mine.json()) as SavedInvention[]
		expect(list.map((i) => i.InventionId)).toContain(saved.InventionId)

		// The saved invention is fetchable by id via the v1 lookup.
		const one = await exports.default.fetch(
			`${ORIGIN}/api/inventions/v1?inventionId=${saved.InventionId}`
		)
		expect(one.status).toBe(200)
		expect((await one.json()) as SavedInvention).toMatchObject({ InventionId: saved.InventionId })
	})

	test('POST /api/inventions/v9/save answers the enveloped result the client reads', async () => {
		const body = {
			name: '082926 13:42:46',
			description: 'No description yet',
			imageName: 'invention/2026-08-29/52c1e282-76f5-4974-975f-d85060884085.jpg',
			hasBetaContent: false,
			instantiationCost: 101,
			lightsCost: 0,
			chipsCost: 0,
			cloudVariablesCost: 0,
			aiCost: 0,
			ugcVersion: 1,
			creationRoomId: 398,
			inventionDataFilename: '2026-08-29/cb608051-f38b-4ef2-aa8a-a26eb0195b2b.inv',
			referencedInventions: [],
			referencedUnityAssetIds: [],
			creatorAccountRole: 255,
			convertedFromInventionId: null,
			displayMetadataJson: '{"0":0,"99":0}',
			longDescription: '',
			tagsRequest: { AutoTags: ['small'], CustomTags: null },
		}
		const res = await exports.default.fetch(`${ORIGIN}/api/inventions/v9/save`, {
			method: 'POST',
			headers: { ...(await bearer('5151')), 'Content-Type': 'application/json' },
			body: JSON.stringify(body),
		})
		expect(res.status).toBe(200)

		// v9 is ENVELOPED where v6 is bare. The client checks Success and then reads
		// Value.Invention.InventionId — unguarded, so a true Success with a null Value is
		// the one shape that takes it down.
		const result = (await res.json()) as InventionSaveV9Result
		expect(result.Success).toBe(true)
		expect(result.Error).toBeNull()
		expect(result.error_id).toBeNull()
		const value = result.Value
		if (value === null) throw new Error('Value must not be null on a successful save')
		expect(value.Status).toBe(0)
		expect(Object.keys(value).sort()).toEqual([
			'Invention',
			'InventionVersion',
			'Status',
			'TagsResponse',
		])

		const saved = value.Invention
		expect(saved.InventionId).toBeGreaterThan(0)
		expect(saved.CreatorPlayerId).toBe(5151)
		expect(saved.Name).toBe(body.name)
		expect(saved.CreationRoomId).toBe(398)
		expect(saved.DisplayMetadataJson).toBe('{"0":0,"99":0}')
		// UgcVersion is an INVENTION field here, next to the version numbers — not a
		// version one, where its twin HasBetaContent lives.
		expect(saved.UgcVersion).toBe(1)
		expect(saved.CurrentVersionNumber).toBe(1)
		expect(saved.LatestVersionNumber).toBe(1)
		// The v9 RRInvention has no nested version, no Referenced* and no IsPublished —
		// the client reads publication from FirstPublishedAt.
		expect(saved).not.toHaveProperty('CurrentVersion')
		expect(saved).not.toHaveProperty('ReferencedInventions')
		expect(saved).not.toHaveProperty('IsPublished')
		expect(saved.FirstPublishedAt).toBeNull()

		// Costs, the blob and the beta flag ride on the version beside it. No AICost: the
		// request sends one and this DTO has nowhere to put it.
		expect(value.InventionVersion).toMatchObject({
			InventionId: saved.InventionId,
			VersionNumber: 1,
			InstantiationCost: 101,
			HasBetaContent: false,
			BlobName: body.inventionDataFilename,
			UgcAccessibility: null,
			ReferencedInventions: [],
			ReferencedUnityAssetIds: [],
		})
		expect(value.InventionVersion).not.toHaveProperty('AICost')

		// The tagsRequest is applied as `v1/settags` would have applied it, and answered
		// the way settags answers: a result code and the bare tag NAMES.
		expect(value.TagsResponse).toEqual({ Result: 0, Tags: ['small'] })
		const details = await exports.default.fetch(
			`${ORIGIN}/api/inventions/v1/details?inventionId=${saved.InventionId}`
		)
		expect(await details.json()).toEqual({ Tags: [{ Tag: 'small', Type: 2 }] })

		// Stored once, read by every version: the older lookup still serves the record it
		// always did, nested CurrentVersion and all.
		const one = await exports.default.fetch(
			`${ORIGIN}/api/inventions/v1?inventionId=${saved.InventionId}`
		)
		expect((await one.json()) as SavedInvention).toMatchObject({
			InventionId: saved.InventionId,
			IsPublished: false,
			CurrentVersion: { BlobName: body.inventionDataFilename },
		})
	})

	test('POST /api/inventions/v9/save leaves the v9-only keys off the stored record', async () => {
		// The same body a v6 client sends, posted at v9: nothing is back-filled, so the
		// record is the one v6 has always stored. The response still carries the full v9
		// projection — those fields have defaults there, not absences.
		const res = await exports.default.fetch(`${ORIGIN}/api/inventions/v9/save`, {
			method: 'POST',
			headers: { ...(await bearer('5152')), 'Content-Type': 'application/json' },
			body: JSON.stringify({ name: 'Bare Save', inventionDataFilename: 'bare.inv' }),
		})
		expect(res.status).toBe(200)
		const value = ((await res.json()) as InventionSaveV9Result).Value
		if (value === null) throw new Error('Value must not be null on a successful save')
		expect(value.Invention.UgcVersion).toBe(0)
		expect(value.Invention.DisplayMetadataJson).toBeNull()
		// A save always mints a version; the key is nullable only because econ's
		// `v3/buyInvention` answers in this same envelope and a buy mints none.
		expect(value.InventionVersion).not.toBeNull()
		expect(value.InventionVersion?.HasBetaContent).toBe(false)
		expect(value.TagsResponse).toEqual({ Result: 0, Tags: [] })

		const one = await exports.default.fetch(
			`${ORIGIN}/api/inventions/v1?inventionId=${value.Invention.InventionId}`
		)
		const stored = (await one.json()) as SavedInvention
		expect(stored).not.toHaveProperty('Tags')
		expect(stored).not.toHaveProperty('UgcVersion')
		expect(stored).not.toHaveProperty('ReferencedUnityAssetIds')
		expect(stored.CurrentVersion).not.toHaveProperty('HasBetaContent')
	})

	test('POST /api/inventions/v9/save refuses through the envelope, never a bare error', async () => {
		// A refusal the client can show is Success:false with a null Value — the branch
		// that reads Error and nothing else. A bare `{ error }` body would deserialize to
		// a null envelope and take the client down instead of failing the save.
		const res = await exports.default.fetch(`${ORIGIN}/api/inventions/v9/save`, {
			method: 'POST',
			headers: { ...(await bearer('5153')), 'Content-Type': 'application/json' },
			body: JSON.stringify({ name: 'No Blob' }),
		})
		expect(res.status).toBe(200)
		expect(await res.json()).toEqual({
			Value: null,
			Success: false,
			Error: 'inventionDataFilename is required',
			error_id: null,
		})

		// Even the 401 answers the envelope: an empty body is a null envelope to the
		// client, which is the crash, not a refusal.
		const anon = await exports.default.fetch(`${ORIGIN}/api/inventions/v9/save`, {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({ name: 'Anon', inventionDataFilename: 'anon.inv' }),
		})
		expect(anon.status).toBe(401)
		expect((await anon.json()) as InventionSaveV9Result).toMatchObject({
			Value: null,
			Success: false,
		})
	})

	test('POST /api/inventions/v9/save keeps the save when a tag breaks the tag rule', async () => {
		// The reply carries a tag result of its own, so the two outcomes are separate: a
		// hyphen in a tag must not cost the player the build they just saved.
		const res = await exports.default.fetch(`${ORIGIN}/api/inventions/v9/save`, {
			method: 'POST',
			headers: { ...(await bearer('5154')), 'Content-Type': 'application/json' },
			body: JSON.stringify({
				name: 'Tagged Badly',
				inventionDataFilename: 'tagged-badly.inv',
				tagsRequest: { AutoTags: ['small'], CustomTags: ['bad-tag'] },
			}),
		})
		expect(res.status).toBe(200)
		const result = (await res.json()) as InventionSaveV9Result
		expect(result.Success).toBe(true)
		const value = result.Value
		if (value === null) throw new Error('a refused tag must not refuse the save')
		expect(value.Invention.InventionId).toBeGreaterThan(0)

		// Non-zero result, and the whole list dropped rather than the offending tag alone —
		// the creator re-submits it through `v1/settags` and sees what took.
		expect(value.TagsResponse).toEqual({ Result: 1, Tags: [] })
		const details = await exports.default.fetch(
			`${ORIGIN}/api/inventions/v1/details?inventionId=${value.Invention.InventionId}`
		)
		expect(await details.json()).toEqual({ Tags: [] })

		// The invention is on the creator's shelf regardless.
		const mine = await exports.default.fetch(`${ORIGIN}/api/inventions/v2/mine`, {
			headers: await bearer('5154'),
		})
		expect(((await mine.json()) as SavedInvention[]).map((i) => i.InventionId)).toEqual([
			value.Invention.InventionId,
		])
	})

	test('PUT /api/inventions/v2/metadata edits only the fields that aren’t null', async () => {
		const save = await exports.default.fetch(`${ORIGIN}/api/inventions/v9/save`, {
			method: 'POST',
			headers: { ...(await bearer('5160')), 'Content-Type': 'application/json' },
			body: JSON.stringify({
				name: 'Before Edit',
				description: 'the original description',
				imageName: 'invention/before.jpg',
				inventionDataFilename: 'before-edit.inv',
				longDescription: 'the original blurb',
				tagsRequest: { AutoTags: ['small'], CustomTags: null },
			}),
		})
		const inventionId = ((await save.json()) as InventionSaveV9Result).Value?.Invention.InventionId
		expect(inventionId).toBeGreaterThan(0)

		// The client sends the whole shape every time and marks what it isn't touching as
		// null — so a null Name must not blank the name.
		const res = await exports.default.fetch(`${ORIGIN}/api/inventions/v2/metadata`, {
			method: 'PUT',
			headers: { ...(await bearer('5160')), 'Content-Type': 'application/json' },
			body: JSON.stringify({
				InventionId: inventionId,
				Name: null,
				Description: 'devin test No description yet',
				LongDescription: null,
				ImageName: null,
				TagsRequest: null,
			}),
		})
		expect(res.status).toBe(200)
		const result = (await res.json()) as InventionSaveV9Result
		expect(result.Success).toBe(true)
		const value = result.Value
		if (value === null) throw new Error('Value must not be null on a successful edit')

		// The edit answers the UPDATED invention — the client re-renders the detail page
		// from it — in the same envelope the save answers.
		expect(value.Invention.Description).toBe('devin test No description yet')
		expect(value.Invention.Name).toBe('Before Edit')
		expect(value.Invention.ImageName).toBe('invention/before.jpg')
		expect(value.Invention.InventionId).toBe(inventionId)
		// A null TagsRequest leaves the stored tags alone, and they are still reported: the
		// list is what the invention HAS, not what this call changed.
		expect(value.TagsResponse).toEqual({ Result: 0, Tags: ['small'] })

		// And it stuck — including the long description, which the v9 Invention DTO has no
		// key for but the record keeps.
		const one = await exports.default.fetch(
			`${ORIGIN}/api/inventions/v1?inventionId=${inventionId}`
		)
		expect((await one.json()) as SavedInvention).toMatchObject({
			Name: 'Before Edit',
			Description: 'devin test No description yet',
			LongDescription: 'the original blurb',
			Tags: [{ Tag: 'small', Type: 2 }],
		})
	})

	test('PUT /api/inventions/v2/metadata treats an empty string as a clear, not a null', async () => {
		const save = await exports.default.fetch(`${ORIGIN}/api/inventions/v9/save`, {
			method: 'POST',
			headers: { ...(await bearer('5161')), 'Content-Type': 'application/json' },
			body: JSON.stringify({
				name: 'Clear Me',
				description: 'to be cleared',
				imageName: 'invention/clear-me.jpg',
				inventionDataFilename: 'clear-me.inv',
				longDescription: 'blurb to be cleared',
			}),
		})
		const inventionId = ((await save.json()) as InventionSaveV9Result).Value?.Invention.InventionId

		const res = await exports.default.fetch(`${ORIGIN}/api/inventions/v2/metadata`, {
			method: 'PUT',
			headers: { ...(await bearer('5161')), 'Content-Type': 'application/json' },
			body: JSON.stringify({
				InventionId: inventionId,
				Name: null,
				Description: '',
				LongDescription: '',
				ImageName: '',
				TagsRequest: { AutoTags: ['large'], CustomTags: ['puzzle'] },
			}),
		})
		const value = ((await res.json()) as InventionSaveV9Result).Value
		if (value === null) throw new Error('Value must not be null on a successful edit')
		expect(value.Invention.Description).toBe('')
		expect(value.Invention.ImageName).toBe('')
		// TagsRequest replaces both lists wholesale, auto first, then custom.
		expect(value.TagsResponse).toEqual({ Result: 0, Tags: ['large', 'puzzle'] })

		// An empty name is not how a name is cleared — nothing can draw a nameless
		// invention, so it fails the same rule a save holds it to and nothing is written.
		const named = await exports.default.fetch(`${ORIGIN}/api/inventions/v2/metadata`, {
			method: 'PUT',
			headers: { ...(await bearer('5161')), 'Content-Type': 'application/json' },
			body: JSON.stringify({ InventionId: inventionId, Name: '' }),
		})
		expect(named.status).toBe(200)
		expect((await named.json()) as InventionSaveV9Result).toMatchObject({
			Value: null,
			Success: false,
		})
		const one = await exports.default.fetch(
			`${ORIGIN}/api/inventions/v1?inventionId=${inventionId}`
		)
		expect(((await one.json()) as SavedInvention).Name).toBe('Clear Me')
	})

	test('PUT /api/inventions/v2/metadata refuses another creator’s invention in-band', async () => {
		const save = await exports.default.fetch(`${ORIGIN}/api/inventions/v9/save`, {
			method: 'POST',
			headers: { ...(await bearer('5162')), 'Content-Type': 'application/json' },
			body: JSON.stringify({ name: 'Not Yours', inventionDataFilename: 'not-yours.inv' }),
		})
		const inventionId = ((await save.json()) as InventionSaveV9Result).Value?.Invention.InventionId

		// Someone else's invention and an unknown one are domain answers, not transport
		// ones — the client's own status enum has NotCreator and DoesNotExist members — so
		// they come back 200 in the envelope, where the message reaches a human.
		const theirs = await exports.default.fetch(`${ORIGIN}/api/inventions/v2/metadata`, {
			method: 'PUT',
			headers: { ...(await bearer('5163')), 'Content-Type': 'application/json' },
			body: JSON.stringify({ InventionId: inventionId, Description: 'hijacked' }),
		})
		expect(theirs.status).toBe(200)
		expect(await theirs.json()).toEqual({
			Value: null,
			Success: false,
			Error: 'Not your invention',
			error_id: null,
		})

		const missing = await exports.default.fetch(`${ORIGIN}/api/inventions/v2/metadata`, {
			method: 'PUT',
			headers: { ...(await bearer('5162')), 'Content-Type': 'application/json' },
			body: JSON.stringify({ InventionId: 987654, Description: 'nobody' }),
		})
		expect(missing.status).toBe(200)
		expect((await missing.json()) as InventionSaveV9Result).toMatchObject({
			Value: null,
			Error: 'No such invention',
		})

		// A missing token is the one refusal that stays a transport failure — but it still
		// answers the envelope, because an unparseable body crashes the client.
		const anon = await exports.default.fetch(`${ORIGIN}/api/inventions/v2/metadata`, {
			method: 'PUT',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({ InventionId: inventionId, Description: 'anon' }),
		})
		expect(anon.status).toBe(401)
		expect((await anon.json()) as InventionSaveV9Result).toMatchObject({
			Value: null,
			Success: false,
		})

		// Untouched throughout.
		const one = await exports.default.fetch(
			`${ORIGIN}/api/inventions/v1?inventionId=${inventionId}`
		)
		expect(((await one.json()) as SavedInvention).Description).toBe('No description yet')
	})

	test('PUT /api/inventions/v2/metadata keeps the edit when a tag breaks the tag rule', async () => {
		const save = await exports.default.fetch(`${ORIGIN}/api/inventions/v9/save`, {
			method: 'POST',
			headers: { ...(await bearer('5164')), 'Content-Type': 'application/json' },
			body: JSON.stringify({
				name: 'Tag Trouble',
				inventionDataFilename: 'tag-trouble.inv',
				tagsRequest: { AutoTags: ['small'], CustomTags: null },
			}),
		})
		const inventionId = ((await save.json()) as InventionSaveV9Result).Value?.Invention.InventionId

		const res = await exports.default.fetch(`${ORIGIN}/api/inventions/v2/metadata`, {
			method: 'PUT',
			headers: { ...(await bearer('5164')), 'Content-Type': 'application/json' },
			body: JSON.stringify({
				InventionId: inventionId,
				Description: 'edited anyway',
				TagsRequest: { AutoTags: ['small'], CustomTags: ['bad-tag'] },
			}),
		})
		const value = ((await res.json()) as InventionSaveV9Result).Value
		if (value === null) throw new Error('a refused tag must not refuse the edit')
		// The metadata edit lands; the tags are what didn't.
		expect(value.Invention.Description).toBe('edited anyway')
		expect(value.TagsResponse).toEqual({ Result: 1, Tags: [] })
		const details = await exports.default.fetch(
			`${ORIGIN}/api/inventions/v1/details?inventionId=${inventionId}`
		)
		expect(await details.json()).toEqual({ Tags: [] })
	})

	test('POST /api/inventions/v4/publish publishes with the permission and accessibility sent', async () => {
		const save = await exports.default.fetch(`${ORIGIN}/api/inventions/v9/save`, {
			method: 'POST',
			headers: { ...(await bearer('5170')), 'Content-Type': 'application/json' },
			body: JSON.stringify({ name: 'Publish Me', inventionDataFilename: 'publish-me.inv' }),
		})
		const saved = ((await save.json()) as InventionSaveV9Result).Value?.Invention
		expect(saved?.FirstPublishedAt).toBeNull()

		const res = await exports.default.fetch(`${ORIGIN}/api/inventions/v4/publish`, {
			method: 'POST',
			headers: { ...(await bearer('5170')), 'Content-Type': 'application/json' },
			body: JSON.stringify({
				InventionId: saved?.InventionId,
				Permission: 20,
				Accessibility: 1,
				Price: null,
			}),
		})
		expect(res.status).toBe(200)
		const result = (await res.json()) as InventionSaveV9Result
		expect(result.Success).toBe(true)
		const value = result.Value
		if (value === null) throw new Error('Value must not be null on a successful publish')

		// Publishing narrows what everyone else gets down to what the sheet sent, and dates
		// the invention — the client reads publication from FirstPublishedAt, not a flag.
		expect(value.Invention.GeneralPermission).toBe(20)
		expect(value.Invention.Accessibility).toBe(1)
		expect(typeof value.Invention.FirstPublishedAt).toBe('string')
		expect(value.Invention.Price).toBe(0)

		// And it's findable now: the record the older reads serve says published, and it
		// turns up in search.
		const one = await exports.default.fetch(
			`${ORIGIN}/api/inventions/v1?inventionId=${value.Invention.InventionId}`
		)
		expect((await one.json()) as SavedInvention).toMatchObject({ IsPublished: true })
		const found = await exports.default.fetch(`${ORIGIN}/api/inventions/v2/search?value=Publish Me`)
		expect(((await found.json()) as SavedInvention[]).map((i) => i.InventionId)).toContain(
			value.Invention.InventionId
		)

		// Taken back out: the browse tests below assert the exact published catalogue, and
		// a test that publishes something publicly is a test that changes it.
		await env.DB.prepare('DELETE FROM invention WHERE id = ?1')
			.bind(value.Invention.InventionId)
			.run()
	})

	test('POST /api/inventions/v4/publish keeps an unlisted invention out of the feeds', async () => {
		const save = await exports.default.fetch(`${ORIGIN}/api/inventions/v9/save`, {
			method: 'POST',
			headers: { ...(await bearer('5171')), 'Content-Type': 'application/json' },
			body: JSON.stringify({
				name: 'Quietly Published',
				inventionDataFilename: 'quietly-published.inv',
				creationRoomId: 4171,
			}),
		})
		const inventionId = ((await save.json()) as InventionSaveV9Result).Value?.Invention.InventionId

		const res = await exports.default.fetch(`${ORIGIN}/api/inventions/v4/publish`, {
			method: 'POST',
			headers: { ...(await bearer('5171')), 'Content-Type': 'application/json' },
			body: JSON.stringify({ InventionId: inventionId, Permission: 20, Accessibility: 2 }),
		})
		const value = ((await res.json()) as InventionSaveV9Result).Value
		expect(value?.Invention.Accessibility).toBe(2)

		// Unlisted is published — it is reachable by id, which is the whole point of it —
		// but it is not something anyone comes across.
		const one = await exports.default.fetch(
			`${ORIGIN}/api/inventions/v1?inventionId=${inventionId}`
		)
		expect((await one.json()) as SavedInvention).toMatchObject({
			InventionId: inventionId,
			IsPublished: true,
		})
		const found = await exports.default.fetch(
			`${ORIGIN}/api/inventions/v2/search?value=Quietly Published`
		)
		expect(await found.json()).toEqual([])
		const room = await exports.default.fetch(`${ORIGIN}/api/inventions/v1/room?id=4171`)
		expect(await room.json()).toEqual([])
	})

	test('POST /api/inventions/v4/publish leaves a price and a first-publish date alone', async () => {
		const save = await exports.default.fetch(`${ORIGIN}/api/inventions/v9/save`, {
			method: 'POST',
			headers: { ...(await bearer('5172')), 'Content-Type': 'application/json' },
			body: JSON.stringify({ name: 'For Sale', inventionDataFilename: 'for-sale.inv' }),
		})
		const inventionId = ((await save.json()) as InventionSaveV9Result).Value?.Invention.InventionId

		const publish = async (body: Record<string, unknown>) => {
			const res = await exports.default.fetch(`${ORIGIN}/api/inventions/v4/publish`, {
				method: 'POST',
				headers: { ...(await bearer('5172')), 'Content-Type': 'application/json' },
				body: JSON.stringify({ InventionId: inventionId, ...body }),
			})
			const value = ((await res.json()) as InventionSaveV9Result).Value
			if (value === null) throw new Error('Value must not be null on a successful publish')
			return value.Invention
		}

		const first = await publish({ Permission: 80, Accessibility: 1, Price: 250 })
		expect(first.Price).toBe(250)

		// A republish that says nothing about money must not give away something that was
		// for sale, and must not re-date the first publish.
		const again = await publish({ Permission: 20, Accessibility: 1, Price: null })
		expect(again.Price).toBe(250)
		expect(again.GeneralPermission).toBe(20)
		expect(again.FirstPublishedAt).toBe(first.FirstPublishedAt)

		// A negative price is dropped rather than stored.
		expect((await publish({ Price: -5 })).Price).toBe(250)

		// Out of the published catalogue again — see the note in the publish test above.
		await env.DB.prepare('DELETE FROM invention WHERE id = ?1').bind(inventionId).run()
	})

	test('POST /api/inventions/v4/publish refuses another creator’s invention in-band', async () => {
		const save = await exports.default.fetch(`${ORIGIN}/api/inventions/v9/save`, {
			method: 'POST',
			headers: { ...(await bearer('5173')), 'Content-Type': 'application/json' },
			body: JSON.stringify({ name: 'Theirs Alone', inventionDataFilename: 'theirs-alone.inv' }),
		})
		const inventionId = ((await save.json()) as InventionSaveV9Result).Value?.Invention.InventionId

		const theirs = await exports.default.fetch(`${ORIGIN}/api/inventions/v4/publish`, {
			method: 'POST',
			headers: { ...(await bearer('5174')), 'Content-Type': 'application/json' },
			body: JSON.stringify({ InventionId: inventionId, Permission: 20, Accessibility: 1 }),
		})
		expect(theirs.status).toBe(200)
		expect(await theirs.json()).toEqual({
			Value: null,
			Success: false,
			Error: 'Not your invention',
			error_id: null,
		})

		const anon = await exports.default.fetch(`${ORIGIN}/api/inventions/v4/publish`, {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({ InventionId: inventionId, Permission: 20, Accessibility: 1 }),
		})
		expect(anon.status).toBe(401)
		expect((await anon.json()) as InventionSaveV9Result).toMatchObject({ Value: null })

		// Still unpublished throughout.
		const one = await exports.default.fetch(
			`${ORIGIN}/api/inventions/v1?inventionId=${inventionId}`
		)
		expect((await one.json()) as SavedInvention).toMatchObject({
			IsPublished: false,
			FirstPublishedAt: null,
		})
	})

	test('POST /api/inventions/v2/delete removes the creator’s invention', async () => {
		const save = await exports.default.fetch(`${ORIGIN}/api/inventions/v9/save`, {
			method: 'POST',
			headers: { ...(await bearer('5180')), 'Content-Type': 'application/json' },
			body: JSON.stringify({
				name: 'Delete Me',
				inventionDataFilename: 'delete-me.inv',
				tagsRequest: { AutoTags: ['small'], CustomTags: null },
			}),
		})
		const inventionId = ((await save.json()) as InventionSaveV9Result).Value?.Invention.InventionId
		expect(inventionId).toBeGreaterThan(0)

		const res = await exports.default.fetch(`${ORIGIN}/api/inventions/v2/delete`, {
			method: 'POST',
			headers: { ...(await bearer('5180')), 'Content-Type': 'application/json' },
			body: JSON.stringify({ InventionId: inventionId }),
		})
		expect(res.status).toBe(200)
		// `Value` is null even on success — there is no invention left to redraw from.
		expect(await res.json()).toEqual({ Value: null, Success: true, Error: null, error_id: null })

		// Gone from the read and from the creator's shelf.
		const one = await exports.default.fetch(
			`${ORIGIN}/api/inventions/v1?inventionId=${inventionId}`
		)
		expect(one.status).toBe(404)
		const mine = await exports.default.fetch(`${ORIGIN}/api/inventions/v2/mine`, {
			headers: await bearer('5180'),
		})
		expect(((await mine.json()) as SavedInvention[]).map((i) => i.InventionId)).not.toContain(
			inventionId
		)

		// And the row itself, tags and all, rather than a hidden record still taking the id.
		const row = await env.DB.prepare('SELECT COUNT(*) AS n FROM invention WHERE id = ?1')
			.bind(inventionId)
			.first<{ n: number }>()
		expect(row?.n).toBe(0)

		// Deleting it twice is a refusal, not a second success: the id resolves to nothing.
		const again = await exports.default.fetch(`${ORIGIN}/api/inventions/v2/delete`, {
			method: 'POST',
			headers: { ...(await bearer('5180')), 'Content-Type': 'application/json' },
			body: JSON.stringify({ InventionId: inventionId }),
		})
		expect(await again.json()).toEqual({
			Value: null,
			Success: false,
			Error: 'No such invention',
			error_id: null,
		})
	})

	test('POST /api/inventions/v2/delete refuses anyone but the creator, in-band', async () => {
		const save = await exports.default.fetch(`${ORIGIN}/api/inventions/v9/save`, {
			method: 'POST',
			headers: { ...(await bearer('5181')), 'Content-Type': 'application/json' },
			body: JSON.stringify({ name: 'Not Yours To Bin', inventionDataFilename: 'not-yours.inv' }),
		})
		const inventionId = ((await save.json()) as InventionSaveV9Result).Value?.Invention.InventionId

		// 5182 BOUGHT it — owning a copy is still not the right to delete it.
		await grantInvention(env.DB, 5182, inventionId as number)
		const theirs = await exports.default.fetch(`${ORIGIN}/api/inventions/v2/delete`, {
			method: 'POST',
			headers: { ...(await bearer('5182')), 'Content-Type': 'application/json' },
			body: JSON.stringify({ InventionId: inventionId }),
		})
		expect(theirs.status).toBe(200)
		expect(await theirs.json()).toEqual({
			Value: null,
			Success: false,
			Error: 'Not your invention',
			error_id: null,
		})

		const missing = await exports.default.fetch(`${ORIGIN}/api/inventions/v2/delete`, {
			method: 'POST',
			headers: { ...(await bearer('5181')), 'Content-Type': 'application/json' },
			body: JSON.stringify({ InventionId: 987_655 }),
		})
		expect(missing.status).toBe(200)
		expect(await missing.json()).toEqual({
			Value: null,
			Success: false,
			Error: 'No such invention',
			error_id: null,
		})

		// A missing token is the one refusal that stays a transport failure — and it still
		// answers the envelope rather than a bare error body.
		const anon = await exports.default.fetch(`${ORIGIN}/api/inventions/v2/delete`, {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({ InventionId: inventionId }),
		})
		expect(anon.status).toBe(401)
		expect(await anon.json()).toMatchObject({ Value: null, Success: false })

		// Still there throughout.
		const one = await exports.default.fetch(
			`${ORIGIN}/api/inventions/v1?inventionId=${inventionId}`
		)
		expect(one.status).toBe(200)
	})

	test('POST /api/inventions/v2/delete leaves a buyer’s ownership row behind', async () => {
		const save = await exports.default.fetch(`${ORIGIN}/api/inventions/v9/save`, {
			method: 'POST',
			headers: { ...(await bearer('5183')), 'Content-Type': 'application/json' },
			body: JSON.stringify({ name: 'Sold Then Binned', inventionDataFilename: 'sold.inv' }),
		})
		const inventionId = ((await save.json()) as InventionSaveV9Result).Value?.Invention
			.InventionId as number
		await grantInvention(env.DB, 5184, inventionId)

		const res = await exports.default.fetch(`${ORIGIN}/api/inventions/v2/delete`, {
			method: 'POST',
			headers: { ...(await bearer('5183')), 'Content-Type': 'application/json' },
			body: JSON.stringify({ InventionId: inventionId }),
		})
		expect((await res.json()) as { Success: boolean }).toMatchObject({ Success: true })

		// The purchase record is not rewritten by someone else's delete...
		const owned = await env.DB.prepare(
			'SELECT COUNT(*) AS n FROM inventory_invention WHERE invention_id = ?1'
		)
			.bind(inventionId)
			.first<{ n: number }>()
		expect(owned?.n).toBe(1)

		// ...but with no invention row behind it, it drops out of the buyer's shelf anyway.
		const mine = await exports.default.fetch(`${ORIGIN}/api/inventions/v2/mine`, {
			headers: await bearer('5184'),
		})
		expect(((await mine.json()) as SavedInvention[]).map((i) => i.InventionId)).not.toContain(
			inventionId
		)
	})

	test('GET /api/inventions/v2/mine lists bought inventions alongside the caller’s own', async () => {
		// Account 6100 creates one; 6101 buys it (the econ worker's buyInvention writes
		// exactly this row) and also creates one of their own.
		const save = async (sub: string, name: string) => {
			const res = await exports.default.fetch(`${ORIGIN}/api/inventions/v6/save`, {
				method: 'POST',
				headers: { ...(await bearer(sub)), 'Content-Type': 'application/json' },
				body: JSON.stringify({ name, inventionDataFilename: `${name}.inv` }),
			})
			expect(res.status).toBe(200)
			return ((await res.json()) as InventionSaveResult).Invention
		}
		const mine = async (sub: string) => {
			const res = await exports.default.fetch(`${ORIGIN}/api/inventions/v2/mine`, {
				headers: await bearer(sub),
			})
			expect(res.status).toBe(200)
			return (await res.json()) as SavedInvention[]
		}

		const bought = await save('6100', 'bought-invention')
		const own = await save('6101', 'own-invention')
		await grantInvention(env.DB, 6101, bought.InventionId)

		// Newest first, whichever set it came from: 6101 saved theirs after buying.
		const list = await mine('6101')
		expect(list.map((i) => i.InventionId)).toEqual([own.InventionId, bought.InventionId])
		// A bought invention is still the creator's — it is listed, not re-attributed.
		expect(list.find((i) => i.InventionId === bought.InventionId)?.CreatorPlayerId).toBe(6100)
		// It is unpublished (a fresh save is), and stays on the buyer's shelf regardless.
		expect(list.find((i) => i.InventionId === bought.InventionId)?.IsPublished).toBe(false)

		// The seller's own list is unaffected by the sale.
		expect((await mine('6100')).map((i) => i.InventionId)).toEqual([bought.InventionId])

		// An ownership row pointing at an invention that no longer exists just drops out.
		await grantInvention(env.DB, 6101, 999_888)
		expect((await mine('6101')).map((i) => i.InventionId)).toEqual([
			own.InventionId,
			bought.InventionId,
		])
	})

	test('POST /api/customAvatarItems/v1/:id/report files a report against the item’s creator', async () => {
		// 205 makes an item; 42 reports it. The creator is derived FROM the item — the client
		// sends `ReportedPlayerId: null` because it does not know who made it.
		const item = await createCustomItem('205', { Name: 'Reportable Hat' })

		const res = await exports.default.fetch(
			`${ORIGIN}/api/customAvatarItems/v1/${item.CustomAvatarItemId}/report`,
			{
				method: 'POST',
				headers: { ...(await bearer('42')), 'Content-Type': 'application/json' },
				body: JSON.stringify({
					ReportCategory: 2,
					Details: 'tesfsfsdf',
					ReportedPlayerId: null,
				}),
			}
		)
		expect(res.status).toBe(200)
		expect(await res.json()).toEqual({ success: true, error: '' })

		// One row in the shared report table, marked as an item report by `custom_avatar_item_id`.
		// `room_id` stays null — an item isn't tied to one room the way an event is — and the
		// other two id columns stay null, which is what tells the kinds apart.
		const row = await env.DB.prepare('SELECT * FROM report WHERE custom_avatar_item_id = ?1')
			.bind(item.CustomAvatarItemId)
			.first<Record<string, unknown>>()
		expect(row).toMatchObject({
			reporter_player_id: 42,
			reported_player_id: 205, // the item's creator
			report_category: 2,
			details: 'tesfsfsdf',
			custom_avatar_item_id: item.CustomAvatarItemId,
			invention_id: null,
			event_id: null,
			room_id: null,
			banned: 0, // filed unbanned, like any report
		})

		// A body naming SOMEONE ELSE is ignored: the reported player is read off the item either
		// way. Letting a client name who a report is against would let it point one at anybody.
		await exports.default.fetch(
			`${ORIGIN}/api/customAvatarItems/v1/${item.CustomAvatarItemId}/report`,
			{
				method: 'POST',
				headers: { ...(await bearer('42')), 'Content-Type': 'application/json' },
				body: JSON.stringify({ ReportCategory: 1, ReportedPlayerId: 999 }),
			}
		)
		const reported = await env.DB.prepare(
			'SELECT reported_player_id FROM report WHERE custom_avatar_item_id = ?1'
		)
			.bind(item.CustomAvatarItemId)
			.all<{ reported_player_id: number }>()
		// Nothing dedupes: two reports of the same item are two rows, both against the creator.
		expect(reported.results.map((r) => r.reported_player_id)).toEqual([205, 205])

		// An item that does not exist is refused rather than filed against nobody — the row's
		// reported player has to be someone.
		const unknown = await exports.default.fetch(
			`${ORIGIN}/api/customAvatarItems/v1/00000000-0000-0000-0000-000000000000/report`,
			{
				method: 'POST',
				headers: { ...(await bearer('42')), 'Content-Type': 'application/json' },
				body: JSON.stringify({ ReportCategory: 0 }),
			}
		)
		expect(unknown.status).toBe(404)
		expect(await unknown.json()).toEqual({ success: false, error: 'No such item' })

		// Auth-gated: the reporter comes from the token, so there is no filing one signed out.
		const anon = await exports.default.fetch(
			`${ORIGIN}/api/customAvatarItems/v1/${item.CustomAvatarItemId}/report`,
			{
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({ ReportCategory: 0 }),
			}
		)
		expect(anon.status).toBe(401)
	})

	test('POST /api/inventions/v1/report files a report row against the invention', async () => {
		// 5150 saves an invention; 42 reports it. The creator is derived from the invention,
		// so the reporter never gets to name who the report is against.
		const save = await exports.default.fetch(`${ORIGIN}/api/inventions/v6/save`, {
			method: 'POST',
			headers: { ...(await bearer('5150')), 'Content-Type': 'application/json' },
			body: JSON.stringify({ name: 'Reportable', inventionDataFilename: 'blob' }),
		})
		const inventionId = ((await save.json()) as InventionSaveResult).Invention.InventionId

		const res = await exports.default.fetch(`${ORIGIN}/api/inventions/v1/report`, {
			method: 'POST',
			headers: { ...(await bearer('42')), 'Content-Type': 'application/json' },
			body: JSON.stringify({ InventionId: inventionId, Details: 'test', ReportCategory: 0 }),
		})
		expect(res.status).toBe(200)
		expect(await res.json()).toEqual({ success: true, error: '' })

		// One row in the shared report table, marked as an invention report by `invention_id`,
		// with the reported player filled in FROM the invention. `room_id` stays null: an
		// invention isn't tied to one room the way an event is, so there is nothing to read.
		const row = await env.DB.prepare('SELECT * FROM report WHERE invention_id = ?1')
			.bind(inventionId)
			.first<Record<string, unknown>>()
		expect(row).toMatchObject({
			reporter_player_id: 42,
			reported_player_id: 5150, // the invention's creator
			report_category: 0,
			details: 'test',
			invention_id: inventionId,
			event_id: null, // the two id columns are mutually exclusive
			room_id: null,
			banned: 0, // filed unbanned, like any report
		})

		// A body with no usable invention id, and one naming an invention that doesn't exist —
		// both answer the same envelope shape as the success branch.
		const noId = await exports.default.fetch(`${ORIGIN}/api/inventions/v1/report`, {
			method: 'POST',
			headers: { ...(await bearer('42')), 'Content-Type': 'application/json' },
			body: JSON.stringify({ Details: 'x' }),
		})
		expect(noId.status).toBe(400)
		expect(await noId.json()).toEqual({ success: false, error: 'InventionId is required' })

		const unknown = await exports.default.fetch(`${ORIGIN}/api/inventions/v1/report`, {
			method: 'POST',
			headers: { ...(await bearer('42')), 'Content-Type': 'application/json' },
			body: JSON.stringify({ InventionId: 999999 }),
		})
		expect(unknown.status).toBe(404)
		expect(await unknown.json()).toEqual({ success: false, error: 'No such invention' })

		// Auth-gated: the reporter comes from the token, so there's no filing one signed out.
		const anon = await exports.default.fetch(`${ORIGIN}/api/inventions/v1/report`, {
			method: 'POST',
			body: JSON.stringify({ InventionId: inventionId }),
		})
		expect(anon.status).toBe(401)
	})

	test('POST /api/inventions/v6/save 401s without a bearer token', async () => {
		const res = await exports.default.fetch(`${ORIGIN}/api/inventions/v6/save`, {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({ name: 'x', inventionDataFilename: 'a.inv' }),
		})
		expect(res.status).toBe(401)
	})

	test('POST /api/inventions/v6/save 400s without the invention data blob', async () => {
		const res = await exports.default.fetch(`${ORIGIN}/api/inventions/v6/save`, {
			method: 'POST',
			headers: { ...(await bearer()), 'Content-Type': 'application/json' },
			body: JSON.stringify({ name: 'no blob' }),
		})
		expect(res.status).toBe(400)
	})

	test('POST /api/inventions/v6/save defaults a missing name and description', async () => {
		const res = await exports.default.fetch(`${ORIGIN}/api/inventions/v6/save`, {
			method: 'POST',
			headers: { ...(await bearer('6161')), 'Content-Type': 'application/json' },
			body: JSON.stringify({ inventionDataFilename: 'a.inv', name: '  ' }),
		})
		expect(res.status).toBe(200)
		expect(((await res.json()) as InventionSaveResult).Invention).toMatchObject({
			Name: 'Untitled',
			Description: 'No description yet',
		})
	})

	test('POST /api/inventions/v6/save enforces the name and description rules', async () => {
		const save = async (fields: Record<string, unknown>): Promise<Response> =>
			exports.default.fetch(`${ORIGIN}/api/inventions/v6/save`, {
				method: 'POST',
				headers: { ...(await bearer('6262')), 'Content-Type': 'application/json' },
				body: JSON.stringify({ inventionDataFilename: 'a.inv', ...fields }),
			})

		// A name is 3–24 characters of letters, digits, spaces, dashes and colons.
		expect((await save({ name: 'ab' })).status).toBe(400)
		expect((await save({ name: 'a'.repeat(25) })).status).toBe(400)
		expect((await save({ name: 'Rocket!' })).status).toBe(400)
		expect((await save({ name: 'Café Lamp' })).status).toBe(400)
		const ok = await save({ name: 'Rocket Sofa-Bed 2' })
		expect(ok.status).toBe(200)
		expect(((await ok.json()) as InventionSaveResult).Invention.Name).toBe('Rocket Sofa-Bed 2')

		// The rejection carries the player-facing sentence, not a code.
		const short = await save({ name: 'ab' })
		expect((await short.json()) as { error: string }).toEqual({
			error: 'Invention names must be at least 3 characters.',
		})

		// A description is prose: any characters, at most 512 of them.
		expect((await save({ name: 'Long Winded', description: 'x'.repeat(513) })).status).toBe(400)
		expect((await save({ name: 'Long Winded', description: 'x'.repeat(512) })).status).toBe(200)
		expect((await save({ name: 'Punctuated', description: 'Yes! It’s 100% good.' })).status).toBe(
			200
		)
	})

	test('POST /api/inventions/v6/save accepts the client’s auto-generated timestamp name', async () => {
		// The real client names an unnamed invention after the moment it was saved
		// (`071126 13:10:50`, captured from a live save), so the colon is in the allowed name
		// charset on purpose. Dropping it from the pattern would 400 every unnamed save the
		// game makes — this test is what would catch that.
		const res = await exports.default.fetch(`${ORIGIN}/api/inventions/v6/save`, {
			method: 'POST',
			headers: { ...(await bearer('6363')), 'Content-Type': 'application/json' },
			body: JSON.stringify({ inventionDataFilename: 'a.inv', name: '071126 13:10:50' }),
		})
		expect(res.status).toBe(200)
		expect(((await res.json()) as InventionSaveResult).Invention.Name).toBe('071126 13:10:50')
	})

	test('GET /api/inventions/v1 404s for an unknown invention', async () => {
		const res = await exports.default.fetch(`${ORIGIN}/api/inventions/v1?inventionId=999999`)
		expect(res.status).toBe(404)
	})

	test('GET /api/inventions/v1/details returns the tag list; 404s on an unknown id', async () => {
		const save = await exports.default.fetch(`${ORIGIN}/api/inventions/v6/save`, {
			method: 'POST',
			headers: { ...(await bearer('6060')), 'Content-Type': 'application/json' },
			body: JSON.stringify({ name: 'Tagless Sofabed', inventionDataFilename: 'a.inv' }),
		})
		const { Invention } = (await save.json()) as InventionSaveResult

		// A freshly saved invention is untagged until settags writes to it.
		const res = await exports.default.fetch(
			`${ORIGIN}/api/inventions/v1/details?inventionId=${Invention.InventionId}`
		)
		expect(res.status).toBe(200)
		expect(await res.json()).toEqual({ Tags: [] })

		// Tags stored on the record are echoed back under `Tags`.
		const tagged = { ...Invention, InventionId: 5150, Tags: [{ Tag: 'medium', Type: 1 }] }
		await env.DB.prepare('INSERT INTO invention (data) VALUES (?1)')
			.bind(JSON.stringify(tagged))
			.run()
		const withTags = await exports.default.fetch(
			`${ORIGIN}/api/inventions/v1/details?inventionId=5150`
		)
		expect(await withTags.json()).toEqual({ Tags: [{ Tag: 'medium', Type: 1 }] })

		const unknown = await exports.default.fetch(
			`${ORIGIN}/api/inventions/v1/details?inventionId=999999`
		)
		expect(unknown.status).toBe(404)
	})

	test('POST /api/inventions/v1/settags tags the invention; details serves them back', async () => {
		const save = await exports.default.fetch(`${ORIGIN}/api/inventions/v6/save`, {
			method: 'POST',
			headers: { ...(await bearer('4242')), 'Content-Type': 'application/json' },
			body: JSON.stringify({ name: 'Sofabed', inventionDataFilename: 'a.inv' }),
		})
		const { Invention } = (await save.json()) as InventionSaveResult
		const settags = async (body: unknown, sub = '4242'): Promise<Response> =>
			exports.default.fetch(`${ORIGIN}/api/inventions/v1/settags`, {
				method: 'POST',
				headers: { ...(await bearer(sub)), 'Content-Type': 'application/json' },
				body: JSON.stringify(body),
			})

		// Custom tags are Type 0, auto tags Type 2.
		const res = await settags({
			InventionId: Invention.InventionId,
			AutoTags: ['lowink'],
			CustomTags: ['blah'],
		})
		expect(res.status).toBe(200)
		// settags answers the flat list of tag *names*, auto first, then custom.
		expect(await res.json()).toEqual({ Result: 0, Tags: ['lowink', 'blah'] })

		// details serves the typed objects: custom is Type 0, auto is Type 2.
		const details = await exports.default.fetch(
			`${ORIGIN}/api/inventions/v1/details?inventionId=${Invention.InventionId}`
		)
		expect(await details.json()).toEqual({
			Tags: [
				{ Tag: 'lowink', Type: 2 },
				{ Tag: 'blah', Type: 0 },
			],
		})

		// Both lists are replaced wholesale, and tags are normalized + de-duplicated.
		const replaced = await settags({
			InventionId: Invention.InventionId,
			AutoTags: [],
			CustomTags: ['Modern', ' modern ', 'Bed'],
		})
		expect(await replaced.json()).toEqual({ Result: 0, Tags: ['modern', 'bed'] })

		// A tag is at most 15 letters once lowercased. One bad tag in either list fails the
		// whole call — nothing is dropped silently — and leaves the stored tags alone.
		const punctuated = await settags({
			InventionId: Invention.InventionId,
			CustomTags: ['racing', 'Cool Stuff!'],
		})
		expect(punctuated.status).toBe(400)
		expect((await punctuated.json()) as { error: string }).toEqual({
			error: 'Invention tags can only contain letters. (“cool stuff!”)',
		})
		expect(
			(await settags({ InventionId: Invention.InventionId, AutoTags: ['a'.repeat(16)] })).status
		).toBe(400)
		expect(
			(await settags({ InventionId: Invention.InventionId, CustomTags: ['tag2'] })).status
		).toBe(400)
		const stillThere = await exports.default.fetch(
			`${ORIGIN}/api/inventions/v1/details?inventionId=${Invention.InventionId}`
		)
		expect(await stillThere.json()).toEqual({
			Tags: [
				{ Tag: 'modern', Type: 0 },
				{ Tag: 'bed', Type: 0 },
			],
		})

		// Blank entries are skipped rather than rejected: the store already drops them.
		const padded = await settags({
			InventionId: Invention.InventionId,
			CustomTags: ['modern', '', '  '],
		})
		expect(await padded.json()).toEqual({ Result: 0, Tags: ['modern'] })

		// Only the creator may retag; unknown inventions 404; no token → 401.
		const notMine = await settags({ InventionId: Invention.InventionId, CustomTags: ['x'] }, '9999')
		expect(notMine.status).toBe(403)

		const unknown = await settags({ InventionId: 999999, CustomTags: ['x'] })
		expect(unknown.status).toBe(404)

		const anon = await exports.default.fetch(`${ORIGIN}/api/inventions/v1/settags`, {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({ InventionId: Invention.InventionId, CustomTags: ['x'] }),
		})
		expect(anon.status).toBe(401)
	})

	test('GET /api/inventions/v2/search returns published inventions, filtered by value', async () => {
		// Only published inventions are searchable, and nothing published exists via
		// the save path (a fresh save is private), so seed the rows directly.
		const published = (id: number, name: string, description: string): SavedInvention =>
			({
				InventionId: id,
				ReplicationId: crypto.randomUUID(),
				CreatorPlayerId: 8080,
				Name: name,
				Description: description,
				ImageName: '',
				CurrentVersionNumber: 1,
				CurrentVersion: { InventionId: id, VersionNumber: 1, BlobName: '' },
				IsPublished: true,
				HideFromPlayer: false,
				CreatedAt: `2026-07-0${id}T00:00:00Z`,
			}) as unknown as SavedInvention

		for (const inv of [
			published(101, 'Modern Sofabed', 'Stylistic modern bed'),
			published(102, 'Racing Game', 'A retro inspired TV gaming set'),
			// Unpublished + hidden rows must stay out of the results.
			{ ...published(103, 'Secret Sofabed', ''), IsPublished: false },
			{ ...published(104, 'Hidden Sofabed', ''), HideFromPlayer: true },
		]) {
			await env.DB.prepare('INSERT INTO invention (data) VALUES (?1)')
				.bind(JSON.stringify(inv))
				.run()
		}

		// No `value` → browse everything published, newest first.
		const all = await exports.default.fetch(`${ORIGIN}/api/inventions/v2/search?skip=0&take=100`)
		expect(all.status).toBe(200)
		expect(((await all.json()) as SavedInvention[]).map((i) => i.InventionId)).toEqual([102, 101])

		// `value` matches name or description, case-insensitively.
		const hit = await exports.default.fetch(
			`${ORIGIN}/api/inventions/v2/search?value=${encodeURIComponent('modern sofabed')}`
		)
		expect(((await hit.json()) as SavedInvention[]).map((i) => i.InventionId)).toEqual([101])

		// skip/take paginate the published set.
		const page = await exports.default.fetch(`${ORIGIN}/api/inventions/v2/search?skip=1&take=1`)
		expect(((await page.json()) as SavedInvention[]).map((i) => i.InventionId)).toEqual([101])

		const miss = await exports.default.fetch(`${ORIGIN}/api/inventions/v2/search?value=nomatch`)
		expect(await miss.json()).toEqual([])
	})

	test('GET /api/inventions/v2/search filters and pages in SQL, and does not search tags', async () => {
		const published = (id: number, name: string, description: string, tags: string[]) =>
			({
				InventionId: id,
				ReplicationId: crypto.randomUUID(),
				CreatorPlayerId: 8081,
				Name: name,
				Description: description,
				ImageName: '',
				CurrentVersionNumber: 1,
				CurrentVersion: { InventionId: id, VersionNumber: 1, BlobName: '' },
				IsPublished: true,
				HideFromPlayer: false,
				CreatedAt: `2026-09-0${id - 200}T00:00:00Z`,
				Tags: tags.map((Tag) => ({ Tag, Type: 2 })),
			}) as unknown as SavedInvention

		for (const inv of [
			published(201, 'Devin Cube', 'i dont even know lol', ['small']),
			published(202, 'Devin Cube 2', 'No description yet', ['small', 'dormanchor']),
			published(203, 'Recflarian Flag', 'idk..... lol', ['medium']),
			published(204, 'Smallest Table', 'a small table', ['medium']),
			// Name holds LIKE metacharacters, for the escaping below.
			published(205, '100% Cube_Thing', '', []),
		]) {
			await env.DB.prepare('INSERT INTO invention (data) VALUES (?1)')
				.bind(JSON.stringify(inv))
				.run()
		}

		const ids = async (query: string) => {
			const res = await exports.default.fetch(`${ORIGIN}/api/inventions/v2/search?${query}`)
			expect(res.status, query).toBe(200)
			return ((await res.json()) as SavedInvention[])
				.map((i) => i.InventionId)
				.filter((id) => id >= 201)
		}

		// Newest first, matched against name OR description, case-insensitively.
		expect(await ids('value=cube&skip=0&take=100')).toEqual([205, 202, 201])
		expect(await ids('value=CUBE&skip=0&take=100')).toEqual([205, 202, 201])
		expect(await ids('value=small&skip=0&take=100')).toEqual([204])
		expect(await ids('value=lol&skip=0&take=100')).toEqual([203, 201])

		// Terms are ANDed, so more words narrow rather than widen.
		expect(await ids(`value=${encodeURIComponent('devin cube')}&skip=0&take=100`)).toEqual([
			202, 201,
		])
		expect(await ids(`value=${encodeURIComponent('devin flag')}&skip=0&take=100`)).toEqual([])

		// LIKE metacharacters are escaped: unescaped, `%` would match everything and `_` any
		// single character, so searching for "100%" would return the whole catalogue.
		expect(await ids('value=%25&skip=0&take=100')).toEqual([205])
		expect(await ids('value=cube_thing&skip=0&take=100')).toEqual([205])

		// TAGS ARE NOT SEARCHED. The browse screen's chips send `#small`, and no name or
		// description contains it, so the term matches nothing — the tag is on 201 and 202, and a
		// tag search would have returned them. Deliberate for now: matching tags needs them out of
		// the JSON blob and into something indexable, and doing it in memory would mean reading
		// every row to answer one page.
		expect(await ids(`value=${encodeURIComponent('#small')}&skip=0&take=100`)).toEqual([])

		// Paged in SQL: consecutive pages neither repeat nor skip a row. The `id` tiebreak in the
		// ordering is what guarantees that when two inventions share a `CreatedAt`.
		const page1 = await ids('value=cube&skip=0&take=2')
		const page2 = await ids('value=cube&skip=2&take=2')
		expect(page1).toEqual([205, 202])
		expect(page2).toEqual([201])
		expect(page1.some((id) => page2.includes(id))).toBe(false)
		expect(await ids('value=cube&skip=99&take=10')).toEqual([])

		// Cleaned up: the feeds and the tag-filter chips are derived from EVERY published
		// invention, so rows left behind here would change what those tests see.
		await env.DB.prepare('DELETE FROM invention WHERE id >= 201 AND id <= 205').run()
	})

	test('GET /api/inventions/v1/tagfilters ranks the tags in use', async () => {
		// Two published inventions tagged `furniture`, one `bed` — plus a tagged draft,
		// whose tags must not leak into the public filter chips.
		const make = async (name: string, tags: string[], publish: boolean): Promise<void> => {
			const save = await exports.default.fetch(`${ORIGIN}/api/inventions/v6/save`, {
				method: 'POST',
				headers: { ...(await bearer('9090')), 'Content-Type': 'application/json' },
				body: JSON.stringify({ name, inventionDataFilename: 'a.inv' }),
			})
			const { Invention } = (await save.json()) as InventionSaveResult
			await exports.default.fetch(`${ORIGIN}/api/inventions/v1/settags`, {
				method: 'POST',
				headers: { ...(await bearer('9090')), 'Content-Type': 'application/json' },
				body: JSON.stringify({ InventionId: Invention.InventionId, CustomTags: tags }),
			})
			if (publish) {
				await exports.default.fetch(
					`${ORIGIN}/api/inventions/v3/publish?inventionId=${Invention.InventionId}`,
					{ headers: await bearer('9090') }
				)
			}
		}
		await make('Filter Sofa', ['furniture', 'bed'], true)
		await make('Filter Chair', ['furniture'], true)
		await make('Filter Draft', ['secrettag'], false)

		const res = await exports.default.fetch(`${ORIGIN}/api/inventions/v1/tagfilters`)
		expect(res.status).toBe(200)
		const filters = (await res.json()) as {
			PinnedFilters: string[]
			PopularFilters: string[]
			TrendingFilters: null
		}
		// Most-used tag first, and the draft's tag is nowhere to be seen.
		expect(filters.PopularFilters.slice(0, 2)).toEqual(['furniture', 'bed'])
		expect(filters.PopularFilters).not.toContain('secrettag')
		expect(filters.PinnedFilters).toEqual(filters.PopularFilters.slice(0, 5))
		expect(filters.TrendingFilters).toBeNull()
	})

	test('GET /api/inventions/v2/batch returns the requested inventions', async () => {
		const save = async (name: string): Promise<SavedInvention> => {
			const res = await exports.default.fetch(`${ORIGIN}/api/inventions/v6/save`, {
				method: 'POST',
				headers: { ...(await bearer('5566')), 'Content-Type': 'application/json' },
				body: JSON.stringify({ name, inventionDataFilename: 'a.inv' }),
			})
			return ((await res.json()) as InventionSaveResult).Invention
		}
		const batch = async (query: string, sub?: string): Promise<SavedInvention[]> => {
			const res = await exports.default.fetch(`${ORIGIN}/api/inventions/v2/batch?${query}`, {
				headers: sub === undefined ? {} : await bearer(sub),
			})
			expect(res.status).toBe(200)
			return (await res.json()) as SavedInvention[]
		}

		const first = await save('Batch One')
		const draft = await save('Batch Draft')
		await exports.default.fetch(
			`${ORIGIN}/api/inventions/v3/publish?inventionId=${first.InventionId}`,
			{
				headers: await bearer('5566'),
			}
		)

		// Repeated ids and comma-separated ids both work, and order is preserved.
		const ids = await batch(`id=${first.InventionId}&id=${first.InventionId}`)
		expect(ids.map((i) => i.InventionId)).toEqual([first.InventionId, first.InventionId])
		const commaSeparated = await batch(`id=${first.InventionId},999999`)
		expect(commaSeparated.map((i) => i.InventionId)).toEqual([first.InventionId])

		// The draft is hidden from everyone but its creator.
		expect((await batch(`id=${draft.InventionId}`)).map((i) => i.InventionId)).toEqual([])
		expect((await batch(`id=${draft.InventionId}`, '9999')).map((i) => i.InventionId)).toEqual([])
		expect((await batch(`id=${draft.InventionId}`, '5566')).map((i) => i.InventionId)).toEqual([
			draft.InventionId,
		])

		// No ids at all → an empty list, not an error.
		expect(await batch('')).toEqual([])
	})

	test('GET /api/inventions/v1/fulllineageowner answers for the whole set of ids', async () => {
		const save = async (sub: string, name: string): Promise<SavedInvention> => {
			const res = await exports.default.fetch(`${ORIGIN}/api/inventions/v6/save`, {
				method: 'POST',
				headers: { ...(await bearer(sub)), 'Content-Type': 'application/json' },
				body: JSON.stringify({ name, inventionDataFilename: 'a.inv' }),
			})
			expect(res.status).toBe(200)
			return ((await res.json()) as InventionSaveResult).Invention
		}
		const owns = async (query: string, sub: string): Promise<unknown> => {
			const res = await exports.default.fetch(
				`${ORIGIN}/api/inventions/v1/fulllineageowner?${query}`,
				{ headers: await bearer(sub) }
			)
			expect(res.status).toBe(200)
			return await res.json()
		}

		// 7301 makes two; 7302 makes one and buys one of 7301's.
		const own = await save('7301', 'Lineage Root')
		const nested = await save('7301', 'Lineage Nested')
		const others = await save('7302', 'Someone Elses')
		await grantInvention(env.DB, 7302, nested.InventionId)

		// The creator owns their own lineage; one invention that isn't theirs sinks it.
		expect(await owns(`id=${own.InventionId}&id=${nested.InventionId}`, '7301')).toBe(true)
		expect(
			await owns(`id=${own.InventionId}&id=${nested.InventionId}&id=${others.InventionId}`, '7301')
		).toBe(false)

		// Bought counts as owned, and comma-separated ids parse like the batch endpoint.
		expect(await owns(`id=${nested.InventionId},${others.InventionId}`, '7302')).toBe(true)
		expect(await owns(`id=${own.InventionId}`, '7302')).toBe(false)

		// An id with no invention behind it is not owned, whoever asks.
		expect(await owns(`id=${own.InventionId}&id=999999`, '7301')).toBe(false)
		// No ids at all: nothing in an empty lineage is unowned.
		expect(await owns('', '7301')).toBe(true)
	})

	test('GET /api/inventions/v1/fulllineageowner 401s without a bearer token', async () => {
		const res = await exports.default.fetch(`${ORIGIN}/api/inventions/v1/fulllineageowner?id=1`)
		expect(res.status).toBe(401)
	})

	test('GET /api/inventions/v1/room lists a room’s published inventions', async () => {
		// Two inventions created in room 76, one of them still a draft.
		const create = async (name: string, room: number): Promise<SavedInvention> => {
			const res = await exports.default.fetch(`${ORIGIN}/api/inventions/v6/save`, {
				method: 'POST',
				headers: { ...(await bearer('8484')), 'Content-Type': 'application/json' },
				body: JSON.stringify({ name, creationRoomId: room, inventionDataFilename: 'a.inv' }),
			})
			return ((await res.json()) as InventionSaveResult).Invention
		}
		const publish = async (id: number): Promise<void> => {
			await exports.default.fetch(`${ORIGIN}/api/inventions/v3/publish?inventionId=${id}`, {
				headers: await bearer('8484'),
			})
		}

		const inRoom = await create('Room Lamp', 76)
		const draft = await create('Draft Lamp In Room', 76)
		const otherRoom = await create('Other Room Lamp', 77)
		await publish(inRoom.InventionId)
		await publish(otherRoom.InventionId)

		const res = await exports.default.fetch(`${ORIGIN}/api/inventions/v1/room?id=76`)
		expect(res.status).toBe(200)
		const ids = ((await res.json()) as SavedInvention[]).map((i) => i.InventionId)
		expect(ids).toEqual([inRoom.InventionId])
		// The unpublished one and the other room's are both excluded.
		expect(ids).not.toContain(draft.InventionId)
		expect(ids).not.toContain(otherRoom.InventionId)

		// A room with no inventions is an empty list, not a 404.
		const empty = await exports.default.fetch(`${ORIGIN}/api/inventions/v1/room?id=999`)
		expect(await empty.json()).toEqual([])

		const noId = await exports.default.fetch(`${ORIGIN}/api/inventions/v1/room`)
		expect(noId.status).toBe(400)
	})

	test('GET /api/inventions/v1/personaldetails/:id reports the cheer flag', async () => {
		// No cheer storage yet, so nobody is ever cheering — signed in or not.
		const res = await exports.default.fetch(`${ORIGIN}/api/inventions/v1/personaldetails/2`, {
			headers: await bearer('42'),
		})
		expect(res.status).toBe(200)
		expect(await res.json()).toEqual({ IsCheering: false })

		const anon = await exports.default.fetch(`${ORIGIN}/api/inventions/v1/personaldetails/2`)
		expect(anon.status).toBe(200)
		expect(await anon.json()).toEqual({ IsCheering: false })
	})

	test('GET /api/inventions/v1/version serves the version; unknown versions 404', async () => {
		// The data file is uploaded (via the storage worker) before the metadata save,
		// so the version carries its hash from the start. No sha256 recorded on this
		// object — the api worker digests the blob itself in that case.
		const data = new Uint8Array([1, 2, 3, 4])
		await env.CDN_ASSETS.put('invention/2026-07-12/lamp.inv', data)

		const save = await exports.default.fetch(`${ORIGIN}/api/inventions/v6/save`, {
			method: 'POST',
			headers: { ...(await bearer('7373')), 'Content-Type': 'application/json' },
			body: JSON.stringify({
				name: 'Versioned Lamp',
				instantiationCost: 42,
				inventionDataFilename: '2026-07-12/lamp.inv',
			}),
		})
		const { Invention } = (await save.json()) as InventionSaveResult

		// The bare RRInventionVersion — the blob name is what the client downloads,
		// BlobHash the base64 SHA-256 of what it will download.
		const res = await exports.default.fetch(
			`${ORIGIN}/api/inventions/v1/version?inventionId=${Invention.InventionId}&version=1`
		)
		expect(res.status).toBe(200)
		expect(await res.json()).toMatchObject({
			InventionId: Invention.InventionId,
			VersionNumber: 1,
			BlobName: '2026-07-12/lamp.inv',
			BlobHash: await base64Sha256(data),
			InstantiationCost: 42,
		})

		// `version=0` means "whichever is current" rather than a number to match, and gets the
		// same version 1 back. Nothing has a version 0 — a fresh save is version 1 — so a caller
		// sending it does not know which version it wants, and matching it literally would 404 an
		// invention that exists.
		const v0 = await exports.default.fetch(
			`${ORIGIN}/api/inventions/v1/version?inventionId=${Invention.InventionId}&version=0`
		)
		expect(v0.status).toBe(200)
		expect(await v0.json()).toMatchObject({
			InventionId: Invention.InventionId,
			VersionNumber: 1,
			BlobName: '2026-07-12/lamp.inv',
		})

		// The 0 shortcut does NOT make up an invention: an unknown id still 404s at 0.
		const zeroUnknown = await exports.default.fetch(
			`${ORIGIN}/api/inventions/v1/version?inventionId=999999&version=0`
		)
		expect(zeroUnknown.status).toBe(404)

		// Only the current version exists; any other NUMBER still 404s, as does an unknown id.
		const v2 = await exports.default.fetch(
			`${ORIGIN}/api/inventions/v1/version?inventionId=${Invention.InventionId}&version=2`
		)
		expect(v2.status).toBe(404)
		const unknown = await exports.default.fetch(
			`${ORIGIN}/api/inventions/v1/version?inventionId=999999&version=1`
		)
		expect(unknown.status).toBe(404)

		// Both params are required.
		const noVersion = await exports.default.fetch(
			`${ORIGIN}/api/inventions/v1/version?inventionId=${Invention.InventionId}`
		)
		expect(noVersion.status).toBe(400)
		const noId = await exports.default.fetch(`${ORIGIN}/api/inventions/v1/version?version=1`)
		expect(noId.status).toBe(400)
	})

	test('BlobHash is null until the blob exists, then backfilled onto the invention', async () => {
		// Saved before the upload landed: nothing to hash, so the field stays null
		// rather than carrying a hash of something the client can't download.
		const save = await exports.default.fetch(`${ORIGIN}/api/inventions/v6/save`, {
			method: 'POST',
			headers: { ...(await bearer('7474')), 'Content-Type': 'application/json' },
			body: JSON.stringify({ name: 'Late Lamp', inventionDataFilename: '2026-07-12/late.inv' }),
		})
		const { Invention, InventionVersion } = (await save.json()) as InventionSaveResult
		expect(InventionVersion.BlobHash).toBeNull()

		const version = async (): Promise<Record<string, unknown>> => {
			const res = await exports.default.fetch(
				`${ORIGIN}/api/inventions/v1/version?inventionId=${Invention.InventionId}&version=1`
			)
			return (await res.json()) as Record<string, unknown>
		}
		expect((await version()).BlobHash).toBeNull()

		// Once the blob is there the hash resolves — here from the checksum recorded at
		// upload time (what the storage worker puts), not by digesting the body.
		const data = new Uint8Array([9, 8, 7])
		await env.CDN_ASSETS.put('invention/2026-07-12/late.inv', data, {
			sha256: await crypto.subtle.digest('SHA-256', data),
		})
		const hash = await base64Sha256(data)
		expect((await version()).BlobHash).toBe(hash)

		// And it's kept, so the other invention endpoints serve it too — without the
		// read counting as an edit (ModifiedAt is untouched).
		const details = await exports.default.fetch(
			`${ORIGIN}/api/inventions/v1?inventionId=${Invention.InventionId}`
		)
		const stored = (await details.json()) as SavedInvention
		expect(stored.CurrentVersion.BlobHash).toBe(hash)
		expect(stored.ModifiedAt).toBe(Invention.ModifiedAt)
	})

	test('GET /api/inventions/v1/update edits metadata + permission, creator only', async () => {
		const save = await exports.default.fetch(`${ORIGIN}/api/inventions/v6/save`, {
			method: 'POST',
			headers: { ...(await bearer('3131')), 'Content-Type': 'application/json' },
			body: JSON.stringify({
				name: 'Draft Lamp',
				description: 'No description yet',
				inventionDataFilename: 'a.inv',
			}),
		})
		const { Invention } = (await save.json()) as InventionSaveResult
		const update = async (query: string, sub = '3131'): Promise<Response> =>
			exports.default.fetch(
				`${ORIGIN}/api/inventions/v1/update?inventionId=${Invention.InventionId}&${query}`,
				{ headers: await bearer(sub) }
			)

		// Update answers the save envelope. Only the params present change — the name
		// is left alone here.
		const res = await update(`description=${encodeURIComponent('my description')}`)
		expect(res.status).toBe(200)
		const edited = (await res.json()) as InventionSaveResult
		expect(edited.Status).toBe(0)
		expect(edited.InventionVersion.InventionId).toBe(Invention.InventionId)
		expect(edited.Invention).toMatchObject({
			InventionId: Invention.InventionId,
			Description: 'my description',
			Name: 'Draft Lamp',
			IsPublished: false,
		})

		// `permission` takes a name or the raw number, and lands on GeneralPermission.
		const byName = (await (await update('permission=edit_and_save')).json()) as InventionSaveResult
		expect(byName.Invention.GeneralPermission).toBe(40)
		const byNumber = (await (await update('permission=80')).json()) as InventionSaveResult
		expect(byNumber.Invention.GeneralPermission).toBe(80)

		// An empty description clears it; an empty name does *not* blank the invention.
		const cleared = (await (await update('description=&name=')).json()) as InventionSaveResult
		expect(cleared.Invention).toMatchObject({ Description: '', Name: 'Draft Lamp' })

		// A supplied name/description is held to the same rules as the save path, and a
		// rejected edit changes nothing.
		expect((await update('name=xy')).status).toBe(400)
		expect((await update(`name=${encodeURIComponent('Lamp?')}`)).status).toBe(400)
		expect((await update(`description=${'x'.repeat(513)}`)).status).toBe(400)
		const unchanged = (await (await update('permission=20')).json()) as InventionSaveResult
		expect(unchanged.Invention).toMatchObject({ Name: 'Draft Lamp', Description: '' })
		const renamed = (await (await update('name=Draft-Lamp%20Two')).json()) as InventionSaveResult
		expect(renamed.Invention.Name).toBe('Draft-Lamp Two')

		// allowTrial takes true/1.
		const trial = (await (await update('allowTrial=true')).json()) as InventionSaveResult
		expect(trial.Invention.AllowTrial).toBe(true)

		// Update does not publish or price — those are v3/publish and v1/updateprice.
		expect(trial.Invention.IsPublished).toBe(false)

		// Only the creator may edit; unknown inventions 404; no token → 401.
		expect((await update('description=nope', '9999')).status).toBe(403)
		const unknown = await exports.default.fetch(
			`${ORIGIN}/api/inventions/v1/update?inventionId=999999&description=x`,
			{ headers: await bearer('3131') }
		)
		expect(unknown.status).toBe(404)
		const anon = await exports.default.fetch(
			`${ORIGIN}/api/inventions/v1/update?inventionId=${Invention.InventionId}&description=x`
		)
		expect(anon.status).toBe(401)
	})

	test('POST /api/inventions/v1/update takes the permission picker’s query params', async () => {
		const save = await exports.default.fetch(`${ORIGIN}/api/inventions/v6/save`, {
			method: 'POST',
			headers: { ...(await bearer('3232')), 'Content-Type': 'application/json' },
			body: JSON.stringify({ name: 'Posted Lamp', inventionDataFilename: 'a.inv' }),
		})
		const { Invention } = (await save.json()) as InventionSaveResult
		const post = async (query: string, sub = '3232'): Promise<Response> =>
			exports.default.fetch(
				`${ORIGIN}/api/inventions/v1/update?inventionId=${Invention.InventionId}&${query}`,
				{ method: 'POST', headers: await bearer(sub) }
			)

		// The picker posts the permission by CamelCase name, with no body at all.
		const permission = async (name: string): Promise<number> => {
			const res = await post(`permission=${name}`)
			expect(res.status).toBe(200)
			return ((await res.json()) as InventionSaveResult).Invention.GeneralPermission
		}
		expect(await permission('UseOnly')).toBe(20)
		expect(await permission('EditAndSave')).toBe(40)
		expect(await permission('Publish')).toBe(60)

		// Setting the permission is not publishing — that stays v3/publish's job.
		const still = await post('permission=Publish')
		expect(((await still.json()) as InventionSaveResult).Invention.IsPublished).toBe(false)

		// Same gate as the GET: creator only, and a token is required.
		expect((await post('permission=UseOnly', '9999')).status).toBe(403)
		const anonPost = await exports.default.fetch(
			`${ORIGIN}/api/inventions/v1/update?inventionId=${Invention.InventionId}&permission=Publish`,
			{ method: 'POST' }
		)
		expect(anonPost.status).toBe(401)
	})

	test('GET /api/inventions/v3/publish publishes + prices; search then lists it', async () => {
		const save = await exports.default.fetch(`${ORIGIN}/api/inventions/v6/save`, {
			method: 'POST',
			headers: { ...(await bearer('2121')), 'Content-Type': 'application/json' },
			body: JSON.stringify({ name: 'Publishable Lamp', inventionDataFilename: 'a.inv' }),
		})
		const { Invention } = (await save.json()) as InventionSaveResult
		const search = async (): Promise<number[]> => {
			const res = await exports.default.fetch(
				`${ORIGIN}/api/inventions/v2/search?value=${encodeURIComponent('Publishable Lamp')}`
			)
			return ((await res.json()) as SavedInvention[]).map((i) => i.InventionId)
		}

		// A saved draft is invisible until it's published.
		expect(await search()).toEqual([])

		const res = await exports.default.fetch(
			`${ORIGIN}/api/inventions/v3/publish?inventionId=${Invention.InventionId}&permissionLevel=charge&price=250`,
			{ headers: await bearer('2121') }
		)
		expect(res.status).toBe(200)
		const published = (await res.json()) as InventionSaveResult
		expect(published.Status).toBe(0)
		expect(published.Invention).toMatchObject({
			IsPublished: true,
			GeneralPermission: 80, // charge
			Price: 250,
		})
		expect(typeof published.Invention.FirstPublishedAt).toBe('string')

		expect(await search()).toEqual([Invention.InventionId])

		// Publishing with no permissionLevel defaults to UseOnly, and price to 0.
		const other = await exports.default.fetch(`${ORIGIN}/api/inventions/v6/save`, {
			method: 'POST',
			headers: { ...(await bearer('2121')), 'Content-Type': 'application/json' },
			body: JSON.stringify({ name: 'Plain Lamp', inventionDataFilename: 'a.inv' }),
		})
		const plain = ((await other.json()) as InventionSaveResult).Invention
		const defaulted = (await (
			await exports.default.fetch(
				`${ORIGIN}/api/inventions/v3/publish?inventionId=${plain.InventionId}`,
				{ headers: await bearer('2121') }
			)
		).json()) as InventionSaveResult
		expect(defaulted.Invention).toMatchObject({
			IsPublished: true,
			GeneralPermission: 20, // useonly
			Price: 0,
		})

		// Creator-gated like the other writes.
		const notMine = await exports.default.fetch(
			`${ORIGIN}/api/inventions/v3/publish?inventionId=${Invention.InventionId}`,
			{ headers: await bearer('9999') }
		)
		expect(notMine.status).toBe(403)
	})

	test('POST /api/inventions/v1/updateprice sets the price, creator only', async () => {
		const save = await exports.default.fetch(`${ORIGIN}/api/inventions/v6/save`, {
			method: 'POST',
			headers: { ...(await bearer('1212')), 'Content-Type': 'application/json' },
			body: JSON.stringify({ name: 'Priced Lamp', inventionDataFilename: 'a.inv' }),
		})
		const { Invention } = (await save.json()) as InventionSaveResult
		const updateprice = async (body: unknown, sub = '1212'): Promise<Response> =>
			exports.default.fetch(`${ORIGIN}/api/inventions/v1/updateprice`, {
				method: 'POST',
				headers: { ...(await bearer(sub)), 'Content-Type': 'application/json' },
				body: JSON.stringify(body),
			})

		const res = await updateprice({ InventionId: Invention.InventionId, Price: 500 })
		expect(res.status).toBe(200)
		const priced = (await res.json()) as InventionSaveResult
		expect(priced.Status).toBe(0)
		expect(priced.Invention.Price).toBe(500)

		// A negative price is rejected; other players can't reprice someone's invention.
		expect((await updateprice({ InventionId: Invention.InventionId, Price: -1 })).status).toBe(400)
		expect(
			(await updateprice({ InventionId: Invention.InventionId, Price: 10 }, '9999')).status
		).toBe(403)
	})

	test('GET /api/inventions/v1/fromcreators is an empty feed for now', async () => {
		// A stub: the client renders an empty array as "this creator has published nothing",
		// where a 404 would read as a row that failed to load.
		const res = await exports.default.fetch(
			`${ORIGIN}/api/inventions/v1/fromcreators?id=207&skip=0&take=100`
		)
		expect(res.status).toBe(200)
		expect(await res.json()).toEqual([])

		// The params are accepted and ignored, including a repeated `id` and none at all.
		expect(
			await (
				await exports.default.fetch(`${ORIGIN}/api/inventions/v1/fromcreators?id=1&id=2`)
			).json()
		).toEqual([])
		expect(
			await (await exports.default.fetch(`${ORIGIN}/api/inventions/v1/fromcreators`)).json()
		).toEqual([])
	})

	test('GET /api/inventions/v1/toptoday + v1/featured serve the invention feeds', async () => {
		const ids = async (res: Response): Promise<number[]> =>
			((await res.json()) as SavedInvention[]).map((i) => i.InventionId)

		// Both feeds start EMPTY, for different reasons: nothing is flagged IsFeatured, and
		// the only inventions acquired so far in this file are an unpublished one and an id
		// with no invention row — neither of which a public feed may show.
		expect(await ids(await exports.default.fetch(`${ORIGIN}/api/inventions/v1/toptoday`))).toEqual(
			[]
		)
		expect(await ids(await exports.default.fetch(`${ORIGIN}/api/inventions/v1/featured`))).toEqual(
			[]
		)

		const feedInvention = (
			id: number,
			downloads: number,
			extra: Partial<SavedInvention> = {}
		): SavedInvention =>
			({
				InventionId: id,
				CreatorPlayerId: 8080,
				Name: `Feed ${id}`,
				Description: '',
				ImageName: '',
				CurrentVersionNumber: 1,
				CurrentVersion: { InventionId: id, VersionNumber: 1, BlobName: '' },
				IsPublished: true,
				IsFeatured: false,
				HideFromPlayer: false,
				NumDownloads: downloads,
				CheerCount: 0,
				NumPlayersHaveUsedInRoom: 0,
				CreatedAt: '2026-07-01T00:00:00Z',
				...extra,
			}) as unknown as SavedInvention

		for (const inv of [
			feedInvention(201, 500),
			feedInvention(202, 9000, { IsFeatured: true, CreatedAt: '2026-07-02T00:00:00Z' }),
			feedInvention(203, 3000, { IsFeatured: true, CreatedAt: '2026-07-03T00:00:00Z' }),
			// Unpublished/hidden inventions stay out of both feeds, featured or not.
			feedInvention(204, 99999, { IsPublished: false, IsFeatured: true }),
			feedInvention(205, 99999, { HideFromPlayer: true, IsFeatured: true }),
		]) {
			await env.DB.prepare('INSERT INTO invention (data) VALUES (?1)')
				.bind(JSON.stringify(inv))
				.run()
		}

		// Recent acquisitions, which is what "top today" now counts: 201 picked up by three
		// players, 203 by one. 204/205 are acquired too — an unpublished and a hidden
		// invention can still be owned — and must not surface in a public feed.
		for (const accountId of [7001, 7002, 7003]) await grantInvention(env.DB, accountId, 201)
		await grantInvention(env.DB, 7001, 203)
		await grantInvention(env.DB, 7001, 204)
		await grantInvention(env.DB, 7002, 205)
		// 202 was acquired 25 hours ago, just past the trailing 24-hour window, so it is out —
		// the feed really does forget, rather than accumulating every acquisition ever.
		await env.DB.prepare(
			'INSERT INTO inventory_invention (account_id, invention_id, acquired_at) VALUES (?1, ?2, ?3)'
		)
			.bind(7004, 202, new Date(Date.now() - 25 * 60 * 60 * 1000).toISOString())
			.run()

		// Top: most acquisitions in the window first. Download counts no longer rank anything —
		// 202 has the biggest of them and is absent entirely.
		const top = await ids(await exports.default.fetch(`${ORIGIN}/api/inventions/v1/toptoday`))
		expect(top).toEqual([201, 203])

		// Featured: only the flagged, visible inventions — newest first. 201 is published but
		// unflagged, so it stays out however popular it is.
		const featured = await ids(await exports.default.fetch(`${ORIGIN}/api/inventions/v1/featured`))
		expect(featured).toEqual([203, 202])

		// skip/take paginate both feeds.
		const page = await exports.default.fetch(`${ORIGIN}/api/inventions/v1/toptoday?skip=1&take=1`)
		expect(await ids(page)).toEqual([203])
		// Pagination happens after the visibility filter, so the hidden/unpublished
		// acquisitions don't leave holes in a page.
		const firstPage = await exports.default.fetch(`${ORIGIN}/api/inventions/v1/toptoday?take=1`)
		expect(await ids(firstPage)).toEqual([201])
		const featuredPage = await exports.default.fetch(
			`${ORIGIN}/api/inventions/v1/featured?skip=1&take=1`
		)
		expect(await ids(featuredPage)).toEqual([202])
	})

	describe('POST /api/sanitize/v1', () => {
		const sanitize = async (body: Record<string, unknown>) =>
			exports.default.fetch(`${ORIGIN}/api/sanitize/v1`, {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify(body),
			})

		test('masks a swear one character at a time, keeping the rest of the text', async () => {
			// The body verbatim from the client, unread fields included — `ruleset` is
			// lowercase among PascalCase keys, which is what the reader has to tolerate.
			const res = await sanitize({
				Value: 'fuck',
				ReplacementChar: '*',
				Context: 'RoomChat',
				Intent: 1,
				ruleset: 0,
				PreRemoveBlockedCharacters: false,
			})
			expect(res.status).toBe(200)
			expect(await res.json()).toBe('****')

			// The shape of the message survives: only the swear is masked, and it comes back
			// the length it went in.
			expect(await (await sanitize({ Value: 'what the fuck man' })).json()).toBe(
				'what the **** man'
			)
		})

		test('leaves clean text alone', async () => {
			expect(await (await sanitize({ Value: 'Grape Escape' })).json()).toBe('Grape Escape')
			expect(await (await sanitize({ Value: '' })).json()).toBe('')
			expect(await (await sanitize({})).json()).toBe('')
		})

		test('honours ReplacementChar, defaulting to *', async () => {
			expect(await (await sanitize({ Value: 'fuck', ReplacementChar: '#' })).json()).toBe('####')
			// No ReplacementChar, and an empty one, both fall back rather than deleting the word.
			expect(await (await sanitize({ Value: 'fuck' })).json()).toBe('****')
			expect(await (await sanitize({ Value: 'fuck', ReplacementChar: '' })).json()).toBe('****')
		})

		test('masks the whole word a swear is part of', async () => {
			expect(await (await sanitize({ Value: 'a$$hole' })).json()).toBe('*******')
			expect(await (await sanitize({ Value: 'this is fucking cool' })).json()).toBe(
				'this is ******* cool'
			)
		})

		test('masks a swear spaced out letter by letter', async () => {
			expect(await (await sanitize({ Value: 'f u c k off' })).json()).toBe('******* off')
		})

		test('PreRemoveBlockedCharacters strips the characters used to break a word up', async () => {
			// A zero-width space inside the word: left alone it is text the filter reads as
			// two harmless halves, so the client asks for it to go first.
			const value = 'fu\u200Bck'
			expect(await (await sanitize({ Value: value })).json()).toBe(value)
			expect(
				await (await sanitize({ Value: value, PreRemoveBlockedCharacters: true })).json()
			).toBe('****')
		})
	})

	describe('POST /api/sanitize/v1/isPure', () => {
		const isPure = async (Value?: string, authed = true) =>
			exports.default.fetch(`${ORIGIN}/api/sanitize/v1/isPure`, {
				method: 'POST',
				headers: {
					'Content-Type': 'application/json',
					...(authed ? await bearer('42') : {}),
				},
				body: Value === undefined ? undefined : JSON.stringify({ Value }),
			})

		test('401s without a token', async () => {
			expect((await isPure('hello', false)).status).toBe(401)
		})

		test.each([
			'hello world',
			'My Cool Room',
			// The words a substring filter gets wrong. Rejecting these is worse than
			// missing a swear: the player is told the name is unacceptable and can't
			// see why.
			'Grape Escape',
			'Title Screen',
			'assassin',
			'Bass Pro Shop',
			'analysis of the class',
			'Scunthorpe United',
			'shiitake mushrooms',
			// Nothing to object to in an empty box — the client checks as you type.
			'',
		])('%j is pure', async (value) => {
			const res = await isPure(value)
			expect(res.status).toBe(200)
			expect(await res.json()).toEqual({ IsPure: true })
		})

		test.each([
			'fuck this',
			// Leetspeak and symbol substitution are folded back to letters.
			'sh1t',
			'a$$hole',
			'n1gger',
			// A swear anywhere in the string, not just on its own.
			'my totally fucking cool room',
			// Ours, on top of the dataset — see EXTRA_PATTERNS.
			'kys',
		])('%j is not pure', async (value) => {
			const res = await isPure(value)
			expect(res.status).toBe(200)
			expect(await res.json()).toEqual({ IsPure: false })
		})

		test('a body with no Value is pure rather than a bad request', async () => {
			const res = await isPure()
			expect(res.status).toBe(200)
			expect(await res.json()).toEqual({ IsPure: true })
		})
	})
})

describe('account', () => {
	test.each(['email', 'phone', 'anything'])(
		'GET /iam/me/channels/%s is an empty list',
		async (type) => {
			const res = await exports.default.fetch(`${ORIGIN}/iam/me/channels/${type}`)
			expect(res.status).toBe(200)
			expect(await res.json()).toEqual([])
		}
	)
})

describe('auth-gated endpoints', () => {
	test('401 without a bearer token', async () => {
		const res = await exports.default.fetch(`${ORIGIN}/api/consumables/v2/getUnlocked`)
		expect(res.status).toBe(401)
	})

	test('401 with a garbage token', async () => {
		const res = await exports.default.fetch(`${ORIGIN}/api/consumables/v2/getUnlocked`, {
			headers: { Authorization: 'Bearer not-a-real-token' },
		})
		expect(res.status).toBe(401)
	})
})

describe('custom avatar items', () => {
	test('minPriceForPublicItem is a bare 100', async () => {
		const res = await exports.default.fetch(
			`${ORIGIN}/api/customAvatarItems/v1/minPriceForPublicItem`
		)
		expect(res.status).toBe(200)
		expect(await res.json()).toBe(100)
	})

	test('POST creates an item from the multipart form and returns it', async () => {
		const form = new FormData()
		form.set(
			'metadata',
			JSON.stringify({
				Name: 'custom shirt 1',
				Description: 'custom shirt 2',
				Price: 0,
				BaseAvatarItemId: 2184,
				BaseAvatarItemColor: '#F55C1A',
				Accessibility: 0,
			})
		)
		form.set(
			'thumbnailImage',
			new File([new Uint8Array([1, 2, 3])], 'file.bin', { type: 'image/png' })
		)
		form.set('design', new File([new Uint8Array([4, 5, 6])], 'file.bin', { type: 'image/png' }))
		const res = await exports.default.fetch(`${ORIGIN}/api/customAvatarItems/v1`, {
			method: 'POST',
			headers: await bearer('205'),
			body: form,
		})
		expect(res.status).toBe(200)
		const body = (await res.json()) as {
			Value: Record<string, unknown>
			Success: boolean
			Error: null
			error_id: null
		}
		expect(body.Success).toBe(true)
		expect(body.Error).toBeNull()
		expect(body.error_id).toBeNull()
		expect(body.Value).toMatchObject({
			CreatorAccountId: 205,
			Name: 'custom shirt 1',
			Description: 'custom shirt 2',
			Price: 0,
			Accessibility: 0,
			ForceCannotPublish: false,
			IsFeatured: false,
			IsRecRoomApproved: false,
			BaseAvatarItemId: 2184,
			BaseAvatarItemColor: '#F55C1A',
			PreviewOrientation: 0,
			RankingContext: null,
			OutfitType: 0,
			CurrentSaves: [],
			PurchaseInfo: null,
		})
		const itemId = body.Value.CustomAvatarItemId as string
		expect(itemId).toMatch(/^[0-9a-f-]{36}$/)
		const date = (body.Value.CreatedAt as string).slice(0, 10)
		expect(body.Value.ThumbnailImageFilename).toBe(`avatar-item/${date}/${itemId}-thumb.png`)
		expect(body.Value.DesignFilename).toBe(`avatar-item/${date}/${itemId}-design.png`)
		expect(body.Value.CreatedAt).toBe(body.Value.ModifiedAt)

		// Both uploads landed in the image bucket under those keys.
		const thumb = await env.IMAGES.get(body.Value.ThumbnailImageFilename as string)
		expect(new Uint8Array((await thumb!.arrayBuffer()) as ArrayBuffer)).toEqual(
			new Uint8Array([1, 2, 3])
		)
		expect(thumb!.httpMetadata?.contentType).toBe('image/png')
		const design = await env.IMAGES.get(body.Value.DesignFilename as string)
		expect(new Uint8Array((await design!.arrayBuffer()) as ArrayBuffer)).toEqual(
			new Uint8Array([4, 5, 6])
		)

		const row = await env.DB.prepare(
			'SELECT name, creator_account_id FROM custom_avatar_item WHERE custom_avatar_item_id = ?1'
		)
			.bind(body.Value.CustomAvatarItemId)
			.first()
		expect(row).toEqual({ name: 'custom shirt 1', creator_account_id: 205 })
	})

	test('PUT edits the creator’s item, leaving nulled fields alone', async () => {
		const item = await createCustomAvatarItem(
			env.DB,
			{
				customAvatarItemId: crypto.randomUUID(),
				creatorAccountId: 205,
				name: 'Visor',
				description: 'shiny',
				price: 0,
				baseAvatarItemId: 1,
				baseAvatarItemColor: '#fff',
				accessibility: 0,
				designFilename: 'd',
				thumbnailImageFilename: 't',
			},
			new Date('2026-08-01T00:00:00Z')
		)
		const url = `${ORIGIN}/api/customAvatarItems/v1/${item.CustomAvatarItemId}`
		const res = await exports.default.fetch(url, {
			method: 'PUT',
			headers: { ...(await bearer('205')), 'content-type': 'application/json' },
			body: JSON.stringify({ Name: null, Description: null, Price: 100, Accessibility: 1 }),
		})
		expect(res.status).toBe(200)
		const body = (await res.json()) as {
			Value: Record<string, unknown>
			Success: boolean
			Error: null
		}
		expect(body.Success).toBe(true)
		expect(body.Value).toMatchObject({
			CustomAvatarItemId: item.CustomAvatarItemId,
			Name: 'Visor',
			Description: 'shiny',
			Price: 100,
			Accessibility: 1,
			CreatedAt: '2026-08-01T00:00:00.000Z',
		})
		expect(body.Value.ModifiedAt).not.toBe(item.ModifiedAt)

		// Someone else can't edit it; an unknown id 404s; a bad type 400s.
		const other = await exports.default.fetch(url, {
			method: 'PUT',
			headers: { ...(await bearer('9')), 'content-type': 'application/json' },
			body: JSON.stringify({ Price: 5 }),
		})
		expect(other.status).toBe(403)
		const missing = await exports.default.fetch(
			`${ORIGIN}/api/customAvatarItems/v1/${crypto.randomUUID()}`,
			{
				method: 'PUT',
				headers: { ...(await bearer('205')), 'content-type': 'application/json' },
				body: JSON.stringify({ Price: 5 }),
			}
		)
		expect(missing.status).toBe(404)
		const bad = await exports.default.fetch(url, {
			method: 'PUT',
			headers: { ...(await bearer('205')), 'content-type': 'application/json' },
			body: JSON.stringify({ Price: 'lots' }),
		})
		expect(bad.status).toBe(400)
		expect(await bad.json()).toMatchObject({ Success: false, Value: null })
		expect(await (await exports.default.fetch(url, { method: 'PUT' })).status).toBe(401)
	})

	test('DELETE removes the creator’s item and its bucket objects', async () => {
		// Create through the endpoint so the objects really exist in the bucket.
		const form = new FormData()
		form.set(
			'metadata',
			JSON.stringify({ Name: 'Gone', BaseAvatarItemId: 1, BaseAvatarItemColor: '#fff' })
		)
		form.set('thumbnailImage', new File([new Uint8Array([1])], 'file.bin', { type: 'image/png' }))
		form.set('design', new File([new Uint8Array([2])], 'file.bin', { type: 'image/png' }))
		const created = (await (
			await exports.default.fetch(`${ORIGIN}/api/customAvatarItems/v1`, {
				method: 'POST',
				headers: await bearer('205'),
				body: form,
			})
		).json()) as {
			Value: { CustomAvatarItemId: string; ThumbnailImageFilename: string; DesignFilename: string }
		}
		const { CustomAvatarItemId, ThumbnailImageFilename, DesignFilename } = created.Value
		expect(await env.IMAGES.get(ThumbnailImageFilename)).not.toBeNull()
		const url = `${ORIGIN}/api/customAvatarItems/v1/${CustomAvatarItemId}`

		// Not the creator → 403 and nothing changes.
		const other = await exports.default.fetch(url, { method: 'DELETE', headers: await bearer('9') })
		expect(other.status).toBe(403)
		expect(await env.IMAGES.get(ThumbnailImageFilename)).not.toBeNull()

		const res = await exports.default.fetch(url, { method: 'DELETE', headers: await bearer('205') })
		expect(res.status).toBe(200)
		expect(await res.json()).toMatchObject({
			Success: true,
			Error: null,
			Value: { CustomAvatarItemId, Name: 'Gone' },
		})
		expect(await env.IMAGES.get(ThumbnailImageFilename)).toBeNull()
		expect(await env.IMAGES.get(DesignFilename)).toBeNull()
		expect(
			await env.DB.prepare('SELECT 1 FROM custom_avatar_item WHERE custom_avatar_item_id = ?1')
				.bind(CustomAvatarItemId)
				.first()
		).toBeNull()

		// Gone now → 404; no token → 401.
		const again = await exports.default.fetch(url, {
			method: 'DELETE',
			headers: await bearer('205'),
		})
		expect(again.status).toBe(404)
		expect((await exports.default.fetch(url, { method: 'DELETE' })).status).toBe(401)
	})

	test('POST 400s without the files', async () => {
		const form = new FormData()
		form.set(
			'metadata',
			JSON.stringify({ Name: 'x', BaseAvatarItemId: 1, BaseAvatarItemColor: '#fff' })
		)
		const res = await exports.default.fetch(`${ORIGIN}/api/customAvatarItems/v1`, {
			method: 'POST',
			headers: await bearer(),
			body: form,
		})
		expect(res.status).toBe(400)
		expect(await res.json()).toMatchObject({ Success: false, Value: null })
	})

	test('POST 401s without a token', async () => {
		const res = await exports.default.fetch(`${ORIGIN}/api/customAvatarItems/v1`, {
			method: 'POST',
		})
		expect(res.status).toBe(401)
	})
})

describe('instant kick', () => {
	// The game session the kick names, and one belonging to the same room that must be
	// left out of it.
	const SESSION = 1013781
	const OTHER_SESSION = 1013782

	const hub = () => env.RECFLARE_NOTIFICATIONS_HUB.getByName('global')

	// Room instances are written by the `match` worker; seeded straight into the table
	// here, the way the presence rows below are.
	const seedInstance = async (roomInstanceId: number, maxCapacity = 0, isFull = false) =>
		env.DB.prepare('INSERT OR REPLACE INTO room_instance (data) VALUES (?1)')
			.bind(
				JSON.stringify({
					roomInstanceId,
					ownerAccountId: 42,
					roomId: 4,
					subRoomId: 4,
					location: '',
					dataBlob: '',
					eventId: 0,
					photonRegionId: 'us',
					photonRoomId: `photon-${roomInstanceId}`,
					name: '',
					maxCapacity,
					isFull,
					isPrivate: false,
					isInProgress: false,
					roomCode: '',
					roomInstanceType: 0,
					clubId: 0,
					EncryptVoiceChat: false,
					matchmakingPolicy: 0,
					allowNewUsers: true,
					joinDisabled: false,
					gameVersion: GAME_VERSION,
					createdAt: new Date().toISOString(),
				})
			)
			.run()

	const standIn = async (accountId: number, roomInstanceId: number) =>
		env.DB.prepare('INSERT OR REPLACE INTO presence (data) VALUES (?1)')
			.bind(
				JSON.stringify({
					accountId,
					roomInstance: { roomInstanceId, roomId: 4 },
					statusVisibility: 0,
					deviceClass: 0,
					vrMovementMode: 0,
					platform: 0,
					appVersion: GAME_VERSION,
					expiresAt: Math.floor(Date.now() / 1000) + PRESENCE_TTL_SECONDS,
				})
			)
			.run()

	const isPresent = async (accountId: number) =>
		(await env.DB.prepare('SELECT COUNT(*) AS n FROM presence WHERE account_id = ?1')
			.bind(accountId)
			.first<{ n: number }>())!.n === 1

	const isFull = async (roomInstanceId: number) =>
		(await env.DB.prepare('SELECT is_full AS full FROM room_instance WHERE id = ?1')
			.bind(roomInstanceId)
			.first<{ full: number }>())!.full === 1

	const kick = async (body: unknown, sub = '42') =>
		exports.default.fetch(`${ORIGIN}/api/PlayerReporting/v1/instantKick`, {
			method: 'POST',
			headers: { ...(await bearer(sub)), 'Content-Type': 'application/json' },
			body: JSON.stringify(body),
		})

	const frames = async () =>
		(await (await hub().fetch('http://do/all')).json()) as Array<{
			playerIds?: number[]
			ephemeral?: boolean
			notificationType: number
			data: Record<string, unknown>
		}>

	test('the room’s creator kicks a player out of the session they name', async () => {
		await hub().fetch('http://do/all', { method: 'DELETE' })
		// A full two-player instance: 205 is kicked, 206 stays.
		await seedInstance(SESSION, 2, true)
		await standIn(205, SESSION)
		await standIn(206, SESSION)

		const res = await kick({ GameSessionId: SESSION, PlayerIds: [205] })
		expect(res.status).toBe(200)
		expect(await res.json()).toEqual({ success: true, error: '' })

		// Presence is deleted, so they read offline at once — and only theirs is.
		expect(await isPresent(205)).toBe(false)
		expect(await isPresent(206)).toBe(true)
		// The instance lost a player, so it is no longer full.
		expect(await isFull(SESSION)).toBe(false)

		// One EPHEMERAL ModerationKick, addressed to the kicked player only. `IsBan` is
		// false — this ejects them from the session and nothing more.
		expect(await frames()).toEqual([
			{
				playerIds: [205],
				ephemeral: true,
				notificationType: 22, // NotificationType.ModerationKick
				data: {
					ReportCategory: -1, // KickReportCategory.Moderator
					Duration: 0,
					GameSessionId: SESSION,
					IsHostKick: true,
					Message: 'You have been kicked from KickRoom.',
					PlayerIdReporter: 42,
					IsBan: false,
					IsVoiceModAutoban: false,
					IsWarning: false,
					VoteKickReason: '',
					TimeoutStartedAt: null,
				},
			},
		])
	})

	// The gate that stops a creator kicking a stranger out of somebody else's session by
	// naming their account id.
	test('a player who is not in that session is skipped in silence', async () => {
		await hub().fetch('http://do/all', { method: 'DELETE' })
		await seedInstance(SESSION)
		await seedInstance(OTHER_SESSION)
		await standIn(207, OTHER_SESSION)

		// 207 stands in another instance; 208 is offline entirely.
		const res = await kick({ GameSessionId: SESSION, PlayerIds: [207, 208] })
		expect(res.status).toBe(200)
		expect(await res.json()).toEqual({ success: true, error: '' })
		expect(await isPresent(207)).toBe(true)
		expect(await frames()).toEqual([])
	})

	test('a room moderator may kick; a host, a stranger and no token may not', async () => {
		await seedInstance(SESSION)
		await standIn(209, SESSION)

		// 43 holds Moderator (20) on the room.
		expect((await kick({ GameSessionId: SESSION, PlayerIds: [209] }, '43')).status).toBe(200)
		expect(await isPresent(209)).toBe(false)

		await standIn(209, SESSION)
		// 44 is only a Host (10), and 99 holds nothing at all.
		for (const sub of ['44', '99']) {
			const res = await kick({ GameSessionId: SESSION, PlayerIds: [209] }, sub)
			expect(res.status, sub).toBe(403)
			expect(await res.json()).toEqual({ success: false, error: 'Forbidden' })
		}
		expect(await isPresent(209)).toBe(true)

		const anon = await exports.default.fetch(`${ORIGIN}/api/PlayerReporting/v1/instantKick`, {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({ GameSessionId: SESSION, PlayerIds: [209] }),
		})
		expect(anon.status).toBe(401)
	})

	// Otherwise a moderator could throw the room's own creator out of it.
	test('the room’s staff — and the caller — cannot be kicked', async () => {
		await hub().fetch('http://do/all', { method: 'DELETE' })
		await seedInstance(SESSION)
		await standIn(42, SESSION)
		await standIn(43, SESSION)

		// 43 (a moderator) names the creator, a fellow moderator and themselves.
		const res = await kick({ GameSessionId: SESSION, PlayerIds: [42, 43] }, '43')
		expect(res.status).toBe(200)
		expect(await isPresent(42)).toBe(true)
		expect(await isPresent(43)).toBe(true)
		expect(await frames()).toEqual([])
	})

	test('an unknown session 404s, and the body must name a session and players', async () => {
		await seedInstance(SESSION)
		const unknown = await kick({ GameSessionId: 999999, PlayerIds: [205] })
		expect(unknown.status).toBe(404)
		expect(await unknown.json()).toEqual({
			success: false,
			error: 'This game session does not exist!',
		})

		for (const [body, error] of [
			[{ PlayerIds: [205] }, 'GameSessionId is required'],
			[{ GameSessionId: 'nope', PlayerIds: [205] }, 'GameSessionId is required'],
			[{ GameSessionId: SESSION }, 'PlayerIds is required'],
			[{ GameSessionId: SESSION, PlayerIds: [] }, 'PlayerIds is required'],
			[{ GameSessionId: SESSION, PlayerIds: ['205'] }, 'PlayerIds is required'],
		] as Array<[unknown, string]>) {
			const res = await kick(body)
			expect(res.status, error).toBe(400)
			expect(await res.json()).toEqual({ success: false, error })
		}

		// A body that isn't JSON at all is the same shape, not a crash.
		const broken = await exports.default.fetch(`${ORIGIN}/api/PlayerReporting/v1/instantKick`, {
			method: 'POST',
			headers: { ...(await bearer()), 'Content-Type': 'application/json' },
			body: 'not json',
		})
		expect(broken.status).toBe(400)
		expect(await broken.json()).toEqual({ success: false, error: 'Invalid request body' })
	})
})

describe('vote to kick', () => {
	// Two live sessions, so a vote called in one can be checked against a player in the
	// other. Nothing reads `room_instance` here — the gate is presence alone.
	const SESSION = 1014079
	const OTHER_SESSION = 1014080

	const hub = () => env.RECFLARE_NOTIFICATIONS_HUB.getByName('global')

	const standIn = async (accountId: number, roomInstanceId: number) =>
		env.DB.prepare('INSERT OR REPLACE INTO presence (data) VALUES (?1)')
			.bind(
				JSON.stringify({
					accountId,
					roomInstance: { roomInstanceId, roomId: 4 },
					statusVisibility: 0,
					deviceClass: 0,
					vrMovementMode: 0,
					platform: 0,
					appVersion: GAME_VERSION,
					expiresAt: Math.floor(Date.now() / 1000) + PRESENCE_TTL_SECONDS,
				})
			)
			.run()

	// The body the client posts: `PlayerId=205&Response=True&Reason=…&GameSessionId=…`.
	const vote = async (fields: Record<string, string>, sub = '42') =>
		exports.default.fetch(`${ORIGIN}/api/PlayerReporting/v3/voteToKick`, {
			method: 'POST',
			headers: { ...(await bearer(sub)), 'Content-Type': 'application/x-www-form-urlencoded' },
			body: new URLSearchParams(fields),
		})

	const frames = async () =>
		(await (await hub().fetch('http://do/all')).json()) as Array<{
			playerId?: number
			ephemeral?: boolean
			notificationType: number
			data: Record<string, unknown>
		}>

	const FIELDS = {
		PlayerId: '205',
		Response: 'True',
		Reason: 'Inactive in games (AFK)',
		GameSessionId: String(SESSION),
	}

	test('the vote goes to everyone in the session except the caller', async () => {
		await hub().fetch('http://do/all', { method: 'DELETE' })
		// 42 calls the vote, 205 is voted on, 206 is a bystander; 207 stands elsewhere.
		await standIn(42, SESSION)
		await standIn(205, SESSION)
		await standIn(206, SESSION)
		await standIn(207, OTHER_SESSION)

		const res = await vote(FIELDS)
		expect(res.status).toBe(200)
		expect(await res.json()).toEqual({ success: true, error: '' })

		// One frame each for 205 and 206 — the player voted on gets it too (the vote is
		// called in front of them), the caller does not, and 207 is in another session.
		// `Data` is an ESCAPED JSON STRING, not a nested object: an object there fails the
		// client's decoder (`expected:'String Begin Token', actual:'{'`) and takes the whole
		// notification with it. `PlayerId` inside it is a STRING, as the reference relays it,
		// and `Response` is empty because the frame is the question, not an answer.
		const message = {
			ephemeral: true,
			notificationType: 2, // NotificationType.MessageReceived
			data: {
				FromPlayerId: 42,
				Type: MessageType.VoteToKick,
				Data: `{"PlayerId":"205","Response":"","GameSessionId":${SESSION}}`,
			},
		}
		const sent = await frames()
		expect(sent).toHaveLength(2)
		expect(sent).toContainEqual({
			...message,
			playerId: 205,
			data: { ...message.data, ToPlayerId: 205 },
		})
		expect(sent).toContainEqual({
			...message,
			playerId: 206,
			data: { ...message.data, ToPlayerId: 206 },
		})
	})

	test('both players have to be standing in the session', async () => {
		await hub().fetch('http://do/all', { method: 'DELETE' })
		await standIn(42, OTHER_SESSION)
		await standIn(205, SESSION)

		// The caller is somewhere else — a vote can't be called into a session you're not in.
		const away = await vote(FIELDS)
		expect(away.status).toBe(403)
		expect(await away.json()).toEqual({
			success: false,
			error: 'You are not in that game session!',
		})

		// And with the caller present, the player voted on has to be there too — offline,
		// or standing elsewhere, both refuse.
		await standIn(42, SESSION)
		await standIn(205, OTHER_SESSION)
		const elsewhere = await vote(FIELDS)
		expect(elsewhere.status).toBe(403)
		expect(await elsewhere.json()).toEqual({
			success: false,
			error: 'That player is not in that game session!',
		})
		expect((await vote({ ...FIELDS, PlayerId: '208' })).status).toBe(403)

		// Nothing was put to the room on any of those.
		expect(await frames()).toEqual([])
	})

	test('the body must name a player and a session, and the call needs a token', async () => {
		await standIn(42, SESSION)
		await standIn(205, SESSION)

		for (const [fields, error] of [
			[{ Response: 'True', GameSessionId: String(SESSION) }, 'PlayerId is required'],
			[{ PlayerId: 'nope', GameSessionId: String(SESSION) }, 'PlayerId is required'],
			[{ PlayerId: '205', Response: 'True' }, 'GameSessionId is required'],
			[{ PlayerId: '205', GameSessionId: 'nope' }, 'GameSessionId is required'],
		] as Array<[Record<string, string>, string]>) {
			const res = await vote(fields)
			expect(res.status, error).toBe(400)
			expect(await res.json()).toEqual({ success: false, error })
		}

		const anon = await exports.default.fetch(`${ORIGIN}/api/PlayerReporting/v3/voteToKick`, {
			method: 'POST',
			headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
			body: new URLSearchParams(FIELDS),
		})
		expect(anon.status).toBe(401)
	})

	// A vote called with nobody else there is a no-op rather than an error: the caller and
	// the player voted on are both here, so the gate passes, and there is simply no room
	// to put it to.
	test('a session holding only the two of them sends nothing', async () => {
		await hub().fetch('http://do/all', { method: 'DELETE' })
		await standIn(42, SESSION)
		await standIn(205, SESSION)
		await env.DB.prepare('DELETE FROM presence WHERE account_id NOT IN (42, 205)').run()

		const res = await vote(FIELDS)
		expect(res.status).toBe(200)
		expect(await res.json()).toEqual({ success: true, error: '' })
		// 205 is still in the session, so they still hear it — only the caller is dropped.
		expect((await frames()).map((f) => f.playerId)).toEqual([205])
	})
})

describe('player reports', () => {
	const submit = async (fields: Record<string, string>, headers?: Record<string, string>) =>
		exports.default.fetch(`${ORIGIN}/api/PlayerReporting/v3/create`, {
			method: 'POST',
			headers: { 'Content-Type': 'application/x-www-form-urlencoded', ...headers },
			body: new URLSearchParams(fields),
		})

	test('POST /api/PlayerReporting/v3/create records the report', async () => {
		const res = await submit(
			{
				PlayerIdReported: '205',
				ReportCategory: '100',
				Details: 'ya know',
				HeightReporter: '1.64',
				HeightReported: '1.65',
				RoomId: '58',
				RoomInstanceType: 'Public',
			},
			await bearer()
		)
		expect(res.status).toBe(200)
		// `error` is an empty string, not null — the real service's envelope.
		expect(await res.json()).toEqual({ success: true, error: '' })

		const [row] = await getReportsAgainst(env.DB, 205)
		expect(row).toMatchObject({
			// The reporter is the token's subject, not a body field.
			reporter_player_id: 42,
			reported_player_id: 205,
			report_category: 100,
			details: 'ya know',
			height_reporter: 1.64,
			height_reported: 1.65,
			room_id: 58,
			room_instance_type: 'Public',
		})
		expect(row?.created_at).toBeTruthy()
	})

	// Everything but the reported player is optional — a report raised outside a room
	// carries no RoomId, and 0 means "no room" rather than room zero.
	test('POST /api/PlayerReporting/v3/create stores absent fields as null', async () => {
		const res = await submit({ PlayerIdReported: '206', RoomId: '0' }, await bearer())
		expect(res.status).toBe(200)

		const [row] = await getReportsAgainst(env.DB, 206)
		expect(row).toMatchObject({
			reporter_player_id: 42,
			reported_player_id: 206,
			report_category: 0,
			details: null,
			height_reporter: null,
			height_reported: null,
			room_id: null,
			room_instance_type: null,
		})
	})

	// Append-only: a second report against the same player is a second row.
	test('POST /api/PlayerReporting/v3/create appends rather than dedupes', async () => {
		await submit({ PlayerIdReported: '207', Details: 'first' }, await bearer())
		await submit({ PlayerIdReported: '207', Details: 'second' }, await bearer())
		const rows = await getReportsAgainst(env.DB, 207)
		expect(rows).toHaveLength(2)
		// Newest first.
		expect(rows.map((r) => r.details)).toEqual(['second', 'first'])
	})

	test('POST /api/PlayerReporting/v3/create 401s without a bearer token', async () => {
		const res = await submit({ PlayerIdReported: '205' })
		expect(res.status).toBe(401)
	})

	test('POST /api/PlayerReporting/v3/create 400s without a reported player', async () => {
		const res = await submit({ Details: 'ya know' }, await bearer())
		expect(res.status).toBe(400)
		// Same envelope as the success branch — the client parses only one shape.
		expect(await res.json()).toEqual({ success: false, error: 'PlayerIdReported is required' })
	})

	// A report is filed unbanned; a moderator converting it into a ban is what the
	// `banned` / `ban_expires` columns are for. `match` and `auth` read exactly this.
	test('a report is filed unbanned', async () => {
		await submit({ PlayerIdReported: '210' }, await bearer())
		const [row] = await getReportsAgainst(env.DB, 210)
		expect(row).toMatchObject({ banned: 0, ban_expires: null })
		expect(await isPlayerBanned(env.DB, 210)).toBe(false)
	})

	test('banFromReport bans the reported player, permanently by default', async () => {
		await submit({ PlayerIdReported: '211', Details: 'the evidence' }, await bearer())
		const [row] = await getReportsAgainst(env.DB, 211)

		const banned = await banFromReport(env.DB, row!.id)
		expect(banned).toMatchObject({ banned: 1, ban_expires: null })
		// The report the ban was made from is still attached to it — the point of
		// banning on the row rather than in a table of its own.
		expect(banned?.details).toBe('the evidence')
		expect(await isPlayerBanned(env.DB, 211)).toBe(true)
		// It bans the REPORTED player, not the reporter who filed it.
		expect(await isPlayerBanned(env.DB, 42)).toBe(false)
	})

	// A timed ban lifts itself: nothing clears the flag, the expiry just passes.
	test('a ban with a past expiry is no longer in force', async () => {
		await submit({ PlayerIdReported: '212' }, await bearer())
		const [row] = await getReportsAgainst(env.DB, 212)
		await banFromReport(env.DB, row!.id, { banExpires: '2020-01-01T00:00:00.000Z' })

		expect(await isPlayerBanned(env.DB, 212)).toBe(false)
		// Still on the row, as the record that it happened.
		expect((await getReportsAgainst(env.DB, 212))[0]).toMatchObject({ banned: 1 })
		// And in force while it lasted.
		expect(await isPlayerBanned(env.DB, 212, new Date('2019-06-01T00:00:00.000Z'))).toBe(true)
	})

	test('a ban with a future expiry is in force', async () => {
		await submit({ PlayerIdReported: '213' }, await bearer())
		const [row] = await getReportsAgainst(env.DB, 213)
		const expires = new Date(Date.now() + 86_400_000).toISOString()
		await banFromReport(env.DB, row!.id, { banExpires: expires })

		expect(await isPlayerBanned(env.DB, 213)).toBe(true)
		expect((await getActiveBan(env.DB, 213))?.ban_expires).toBe(expires)
	})

	// Two bans in force: the longest-lasting one is the one reported, so a fresh short
	// ban can't shorten a standing permanent one.
	test('getActiveBan prefers the permanent ban', async () => {
		await submit({ PlayerIdReported: '214', Details: 'timed' }, await bearer())
		await submit({ PlayerIdReported: '214', Details: 'permanent' }, await bearer())
		const rows = await getReportsAgainst(env.DB, 214)
		const timed = rows.find((r) => r.details === 'timed')!
		const permanent = rows.find((r) => r.details === 'permanent')!
		await banFromReport(env.DB, timed.id, {
			banExpires: new Date(Date.now() + 3_600_000).toISOString(),
		})
		await banFromReport(env.DB, permanent.id)

		expect(await getActiveBan(env.DB, 214)).toMatchObject({ details: 'permanent' })
	})

	test('banFromReport with banned:false lifts the ban and clears the expiry', async () => {
		await submit({ PlayerIdReported: '215' }, await bearer())
		const [row] = await getReportsAgainst(env.DB, 215)
		await banFromReport(env.DB, row!.id, { banExpires: '2999-01-01T00:00:00.000Z' })
		expect(await isPlayerBanned(env.DB, 215)).toBe(true)

		const lifted = await banFromReport(env.DB, row!.id, { banned: false })
		expect(lifted).toMatchObject({ banned: 0, ban_expires: null })
		expect(await isPlayerBanned(env.DB, 215)).toBe(false)
	})

	// No such report — the caller can tell that from having banned nobody.
	test('banFromReport returns null for an unknown report', async () => {
		expect(await banFromReport(env.DB, 999_999)).toBeNull()
	})
})

describe('player warnings', () => {
	const MOD = ['gameClient', 'moderator']

	const issue = async (fields: Record<string, string>, headers?: Record<string, string>) =>
		exports.default.fetch(`${ORIGIN}/api/playerwarnings`, {
			method: 'POST',
			headers: { 'Content-Type': 'application/x-www-form-urlencoded', ...headers },
			body: new URLSearchParams(fields),
		})

	test('POST /api/playerwarnings records the warning', async () => {
		const res = await issue(
			{
				WarnedPlayerId: '205',
				ReportCategory: '101',
				DisplayReason: 'Sexual gestures',
				ModeratorNote: 'dfg',
			},
			await bearer('42', MOD)
		)
		expect(res.status).toBe(200)
		expect(await res.json()).toEqual({ success: true, error: '' })

		const [row] = await getWarningsAgainst(env.DB, 205)
		expect(row).toMatchObject({
			// The moderator is the token's subject, not a body field.
			moderator_player_id: 42,
			warned_player_id: 205,
			report_category: 101,
			display_reason: 'Sexual gestures',
			moderator_note: 'dfg',
		})
		expect(row?.created_at).toBeTruthy()
	})

	test('POST /api/playerwarnings stores absent fields as null', async () => {
		const res = await issue({ WarnedPlayerId: '206' }, await bearer('42', MOD))
		expect(res.status).toBe(200)

		const [row] = await getWarningsAgainst(env.DB, 206)
		expect(row).toMatchObject({
			warned_player_id: 206,
			report_category: 0,
			display_reason: null,
			moderator_note: null,
		})
	})

	// Append-only, like reports: warning the same player twice is two rows.
	test('POST /api/playerwarnings appends rather than dedupes', async () => {
		await issue({ WarnedPlayerId: '207', ModeratorNote: 'first' }, await bearer('42', MOD))
		await issue({ WarnedPlayerId: '207', ModeratorNote: 'second' }, await bearer('42', MOD))
		const rows = await getWarningsAgainst(env.DB, 207)
		expect(rows).toHaveLength(2)
		// Newest first.
		expect(rows.map((r) => r.moderator_note)).toEqual(['second', 'first'])
	})

	test('POST /api/playerwarnings 401s without a bearer token', async () => {
		const res = await issue({ WarnedPlayerId: '205' })
		expect(res.status).toBe(401)
	})

	// A valid token is not enough — a plain player's carries neither staff role.
	// Nothing is written on the rejected branch.
	test('POST /api/playerwarnings 403s without a staff role', async () => {
		for (const roles of [undefined, ['gameClient']]) {
			const res = await issue({ WarnedPlayerId: '208' }, await bearer('42', roles))
			expect(res.status).toBe(403)
			expect(await res.json()).toEqual({ success: false, error: 'Forbidden' })
		}
		expect(await getWarningsAgainst(env.DB, 208)).toHaveLength(0)
	})

	// `developer` gets in as well as `moderator` — staff hold both.
	test('POST /api/playerwarnings accepts the developer role', async () => {
		const res = await issue(
			{ WarnedPlayerId: '209' },
			await bearer('42', ['gameClient', 'developer'])
		)
		expect(res.status).toBe(200)
		expect(await getWarningsAgainst(env.DB, 209)).toHaveLength(1)
	})

	test('POST /api/playerwarnings 400s without a warned player', async () => {
		const res = await issue({ ModeratorNote: 'dfg' }, await bearer('42', MOD))
		expect(res.status).toBe(400)
		expect(await res.json()).toEqual({ success: false, error: 'WarnedPlayerId is required' })
	})
})

describe('rooms', () => {
	test('POST /api/rooms/v1/verifyRole checks creator + room roles', async () => {
		const verify = async (fields: Record<string, string>, sub?: string): Promise<boolean> => {
			const res = await exports.default.fetch(`${ORIGIN}/api/rooms/v1/verifyRole`, {
				method: 'POST',
				headers: {
					'Content-Type': 'application/x-www-form-urlencoded',
					...(sub ? await bearer(sub) : {}),
				},
				body: new URLSearchParams(fields).toString(),
			})
			expect(res.status).toBe(200)
			return (await res.json()) as boolean
		}

		// No token → false.
		expect(await verify({ roomId: '2', role: '255' })).toBe(false)
		// Creator (account 1 owns room 2) → true regardless of role.
		expect(await verify({ roomId: '2', role: '255', context: 'MakerPen' }, '1')).toBe(true)
		// Non-creator with no role in the room → false.
		expect(await verify({ roomId: '2', role: '30' }, '42')).toBe(false)
		// Account 42 holds Role 30 in room 3 → passes when requesting ≤ 30…
		expect(await verify({ roomId: '3', role: '30' }, '42')).toBe(true)
		// …but not a higher role.
		expect(await verify({ roomId: '3', role: '255' }, '42')).toBe(false)
		// Unknown room → false.
		expect(await verify({ roomId: '99999', role: '0' }, '42')).toBe(false)
	})
})

describe('images', () => {
	test('POST /api/images/v4/uploadsaved stores the file in R2 and returns its name', async () => {
		const bytes = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 1, 2, 3, 4])
		const fd = new FormData()
		fd.append('imgMeta', JSON.stringify({ savedImageType: 1 })) // ShareCamera
		fd.append('image', new File([bytes], 'avatar.png', { type: 'image/png' }))

		const res = await exports.default.fetch(`${ORIGIN}/api/images/v4/uploadsaved`, {
			method: 'POST',
			headers: await bearer(),
			body: fd,
		})
		expect(res.status).toBe(200)
		const { ImageName } = (await res.json()) as { ImageName: string }
		// Keyed by <type>/<date>/<uuid>.<ext> (the type folder mirrors the CDN layout).
		expect(ImageName).toMatch(
			/^sharecamera\/\d{4}-\d{2}-\d{2}\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.png$/
		)

		// The object is in the shared bucket under that key.
		const stored = await env.IMAGES.get(ImageName)
		expect(stored).not.toBeNull()
		expect(new Uint8Array(await stored!.arrayBuffer())).toEqual(bytes)

		// A metadata row was created, and it's readable by name via /api/images/v6.
		const meta = (await (
			await exports.default.fetch(`${ORIGIN}/api/images/v6?name=${ImageName}`)
		).json()) as { ImageName: string; PlayerId: number; SavedImageId: number; CheerCount: number }
		expect(meta.ImageName).toBe(ImageName)
		expect(meta.PlayerId).toBe(42)
		// `SavedImageId`, not `Id` — v6 renames like the player lists do.
		expect(typeof meta.SavedImageId).toBe('number')
		expect(meta.CheerCount).toBe(0)
	})

	test('GET /api/images/v1/slideshow is public and joins username + room name', async () => {
		// Seed a public image (Accessibility 1) taken in RecCenter (room 2) by account 42.
		await env.DB.prepare('INSERT INTO image (data) VALUES (?1)')
			.bind(
				JSON.stringify({
					Id: 9001,
					Type: 1,
					Accessibility: 1,
					AccessibilityLocked: false,
					ImageName: 'slide9001.jpg',
					Description: null,
					PlayerId: 42,
					TaggedPlayerIds: [7, 8],
					RoomId: 2,
					PlayerEventId: null,
					CreatedAt: new Date().toISOString(),
					CheerCount: 0,
					CommentCount: 0,
				})
			)
			.run()

		// No token — the slideshow is public.
		const res = await exports.default.fetch(`${ORIGIN}/api/images/v1/slideshow`)
		expect(res.status).toBe(200)
		const body = (await res.json()) as {
			Images: Array<Record<string, unknown>>
			ValidTill: string
		}
		expect(body.ValidTill).toMatch(/Z$/)
		const slide = body.Images.find((i) => i.SavedImageId === 9001)
		expect(slide).toMatchObject({
			SavedImageId: 9001,
			ImageName: 'slide9001.jpg',
			Username: 'Tester', // account 42 seeded above
			RoomName: 'RecCenter', // room 2
			RoomId: 2,
			SavedImageType: 1,
			Accessibility: 1,
			PlayerIds: [7, 8],
		})
	})

	// The feed is public and unauthenticated, so `take` is clamped rather than trusted:
	// without the cap a single anonymous request could pull the whole image table through
	// the two joins behind it.
	test('GET /api/images/v1/slideshow serves 10 by default and caps take at 100', async () => {
		// 120 public ShareCamera photos — more than both the default and the cap.
		for (let i = 0; i < 120; i++) {
			await createImage(env.DB, { imageName: `bulkslide${i}.jpg`, playerId: 42 })
		}
		const feed = async (query: string) => {
			const res = await exports.default.fetch(`${ORIGIN}/api/images/v1/slideshow${query}`)
			expect(res.status).toBe(200)
			return ((await res.json()) as { Images: unknown[] }).Images.length
		}

		expect(await feed('')).toBe(10)
		expect(await feed('?take=25')).toBe(25)
		expect(await feed('?take=500')).toBe(100)
		// Junk and non-positive takes fall back rather than erroring or emptying the stage.
		expect(await feed('?take=0')).toBe(10)
		expect(await feed('?take=-5')).toBe(10)
		expect(await feed('?take=lots')).toBe(10)
	})

	test('GET /api/images/v5/bulk resolves image records by id, in request order', async () => {
		const one = await createImage(env.DB, { imageName: 'bulkone.jpg', playerId: 7101 })
		const two = await createImage(env.DB, { imageName: 'bulktwo.jpg', playerId: 7102 })
		// Not public: a bulk lookup must not hand this back, or sequential ids would make
		// every private photo readable by anyone who counts.
		const hidden = await createImage(env.DB, {
			imageName: 'bulkhidden.jpg',
			playerId: 7103,
			accessibility: 0,
		})

		const bulk = async (query: string) =>
			(await (await exports.default.fetch(`${ORIGIN}/api/images/v5/bulk${query}`)).json()) as Array<
				Record<string, unknown>
			>

		// Request order, not id order — the client lines the answers up with what it asked for.
		const both = await bulk(`?ids=${two.Id}&ids=${one.Id}`)
		expect(both.map((i) => i.Id)).toEqual([two.Id, one.Id])
		// The RAW SavedImage: `Id`/`Type`, and TaggedPlayerIds present — not the
		// SavedImageId/SavedImageType projection the player photo lists serve.
		expect(both[0]).toMatchObject({
			Id: two.Id,
			Type: two.Type,
			ImageName: 'bulktwo.jpg',
			PlayerId: 7102,
			TaggedPlayerIds: [],
		})

		// An unknown id and a non-public one are absent rather than errors or holes, so the
		// answer can be shorter than the request.
		expect((await bulk(`?ids=${one.Id}&ids=999999&ids=${hidden.Id}`)).map((i) => i.Id)).toEqual([
			one.Id,
		])

		// No ids at all is an empty array.
		expect(await bulk('')).toEqual([])

		// More ids than D1 will bind in one query (100) — the lookup has to split.
		const many = [...Array.from({ length: 130 }, (_, i) => 800000 + i), one.Id, two.Id]
		expect((await bulk(`?${many.map((id) => `ids=${id}`).join('&')}`)).map((i) => i.Id)).toEqual([
			one.Id,
			two.Id,
		])
	})

	test('POST /api/images/v1/cheer persists, syncs CheerCount, and the bulk lookup reflects it', async () => {
		// Seed an image to cheer.
		// Its own player id: 700's photos are asserted on exactly in the player-list test.
		const img = await createImage(env.DB, { imageName: 'cheerme.jpg', playerId: 7001 })
		const cheerBody = JSON.stringify({ SavedImageId: img.Id, Cheer: true })

		// No token → 401.
		expect(
			(
				await exports.default.fetch(`${ORIGIN}/api/images/v1/cheer`, {
					method: 'POST',
					headers: { 'Content-Type': 'application/json' },
					body: cheerBody,
				})
			).status
		).toBe(401)

		const cheer = async (cheerVal: boolean, sub = '42') =>
			exports.default.fetch(`${ORIGIN}/api/images/v1/cheer`, {
				method: 'POST',
				headers: { ...(await bearer(sub)), 'Content-Type': 'application/json' },
				body: JSON.stringify({ SavedImageId: img.Id, Cheer: cheerVal }),
			})
		const cheerCount = async (): Promise<number> => {
			const row = await env.DB.prepare('SELECT data FROM image WHERE id = ?1')
				.bind(img.Id)
				.first<{ data: string }>()
			return (JSON.parse(row!.data) as { CheerCount: number }).CheerCount
		}

		// Account 42 cheers → CheerCount syncs to 1 (a real integer, not 1.0).
		expect((await cheer(true)).status).toBe(200)
		const rawAfter = await env.DB.prepare('SELECT data FROM image WHERE id = ?1')
			.bind(img.Id)
			.first<{ data: string }>()
		expect(rawAfter!.data).toContain('"CheerCount":1')
		expect(rawAfter!.data).not.toContain('"CheerCount":1.0')
		expect(await cheerCount()).toBe(1)

		// Re-cheering is idempotent on the count.
		await cheer(true)
		expect(await cheerCount()).toBe(1)

		// Un-cheer → count back to 0.
		await cheer(false)
		expect(await cheerCount()).toBe(0)
	})

	test('GET|PUT /api/players/v1/playerPhotoTaggingSetting round-trips the preference', async () => {
		const path = `${ORIGIN}/api/players/v1/playerPhotoTaggingSetting`
		const read = async (sub: string) => exports.default.fetch(path, { headers: await bearer(sub) })
		const write = async (sub: string, body: unknown) =>
			exports.default.fetch(path, {
				method: 'PUT',
				headers: { ...(await bearer(sub)), 'Content-Type': 'application/json' },
				body: JSON.stringify(body),
			})

		// Both are auth-gated.
		expect((await exports.default.fetch(path)).status).toBe(401)
		expect((await exports.default.fetch(path, { method: 'PUT' })).status).toBe(401)

		// A player who has never set one reads 0 — a bare integer, not an envelope.
		const initial = await read('710')
		expect(initial.status).toBe(200)
		expect(await initial.text()).toBe('0')

		// The PUT answers the stored value, and the GET agrees afterwards.
		expect(await (await write('710', { Setting: 2 })).text()).toBe('2')
		expect(await (await read('710')).text()).toBe('2')

		// It's stored under `playerPhotoTaggingSetting` in the player's settings bag...
		const stored = await env.RECFLARE_PLAYER_SETTINGS.get<Record<string, string>>(
			'player:710',
			'json'
		)
		expect(stored?.playerPhotoTaggingSetting).toBe('2')

		// ...and the write MERGES: the player's other settings survive it.
		await env.RECFLARE_PLAYER_SETTINGS.put(
			'player:711',
			JSON.stringify({ 'Recroom.OOBE': '77', playerPhotoTaggingSetting: '1' })
		)
		expect(await (await read('711')).text()).toBe('1')
		await write('711', { Setting: 0 })
		expect(
			await env.RECFLARE_PLAYER_SETTINGS.get<Record<string, string>>('player:711', 'json')
		).toEqual({ 'Recroom.OOBE': '77', playerPhotoTaggingSetting: '0' })

		// The setting is per-player.
		expect(await (await read('710')).text()).toBe('2')

		// A body with no readable Setting leaves the stored value alone rather than writing 0
		// — and answers what the player still has.
		expect(await (await write('710', { Nothing: true })).text()).toBe('2')
		expect(await (await read('710')).text()).toBe('2')

		// A form body and the lowercase spelling both parse, as does a numeric string.
		const form = await exports.default.fetch(path, {
			method: 'PUT',
			headers: {
				...(await bearer('710')),
				'Content-Type': 'application/x-www-form-urlencoded',
			},
			body: new URLSearchParams({ setting: '3' }).toString(),
		})
		expect(await form.text()).toBe('3')
		expect(await (await read('710')).text()).toBe('3')
	})

	test('GET /api/images/v5/cheered/bulk reports per-id cheer state for the caller (auth-gated)', async () => {
		const img = await createImage(env.DB, { imageName: 'bulkcheer.jpg', playerId: 701 })
		const other = 999999

		// No token → 401.
		expect(
			(await exports.default.fetch(`${ORIGIN}/api/images/v5/cheered/bulk?id=${img.Id}`)).status
		).toBe(401)

		const bulk = async (sub: string) =>
			(await (
				await exports.default.fetch(
					`${ORIGIN}/api/images/v5/cheered/bulk?id=${img.Id}&id=${other}`,
					{ headers: await bearer(sub) }
				)
			).json()) as Array<{ SavedImageId: number; IsCheered: boolean }>

		// Before cheering: one entry per requested id, in order, all false.
		expect(await bulk('42')).toEqual([
			{ SavedImageId: img.Id, IsCheered: false },
			{ SavedImageId: other, IsCheered: false },
		])

		// Account 42 cheers the image.
		await exports.default.fetch(`${ORIGIN}/api/images/v1/cheer`, {
			method: 'POST',
			headers: { ...(await bearer('42')), 'Content-Type': 'application/json' },
			body: JSON.stringify({ SavedImageId: img.Id, Cheer: true }),
		})

		// The cheerer sees it cheered; a different player does not.
		expect((await bulk('42')).find((x) => x.SavedImageId === img.Id)?.IsCheered).toBe(true)
		expect((await bulk('43')).find((x) => x.SavedImageId === img.Id)?.IsCheered).toBe(false)

		// No ids → empty array.
		const empty = await exports.default.fetch(`${ORIGIN}/api/images/v5/cheered/bulk`, {
			headers: await bearer('42'),
		})
		expect(await empty.json()).toEqual([])

		// The client POSTs the ids as a form body of repeated `id` fields — a photo grid asks
		// about a whole page at once, far more than belongs in a URL. Same answer as the GET.
		const posted = await exports.default.fetch(`${ORIGIN}/api/images/v5/cheered/bulk`, {
			method: 'POST',
			headers: {
				...(await bearer('42')),
				'Content-Type': 'application/x-www-form-urlencoded',
			},
			body: `id=${img.Id}&id=${other}`,
		})
		expect(posted.status).toBe(200)
		expect(await posted.json()).toEqual([
			{ SavedImageId: img.Id, IsCheered: true },
			{ SavedImageId: other, IsCheered: false },
		])
		expect(
			(await exports.default.fetch(`${ORIGIN}/api/images/v5/cheered/bulk`, { method: 'POST' }))
				.status
		).toBe(401)

		// A full page of ids: D1 caps a query at 100 bound parameters and the player id takes
		// one, so the lookup has to split rather than fail — the client really does send ~100.
		const page = [img.Id, ...Array.from({ length: 120 }, (_, i) => 900000 + i)]
		const fullPage = await exports.default.fetch(`${ORIGIN}/api/images/v5/cheered/bulk`, {
			method: 'POST',
			headers: {
				...(await bearer('42')),
				'Content-Type': 'application/x-www-form-urlencoded',
			},
			body: page.map((imageId) => `id=${imageId}`).join('&'),
		})
		expect(fullPage.status).toBe(200)
		const entries = (await fullPage.json()) as Array<{ SavedImageId: number; IsCheered: boolean }>
		// One entry per requested id, in request order, and the cheer still resolves from the
		// far side of the split.
		expect(entries).toHaveLength(page.length)
		expect(entries.map((e) => e.SavedImageId)).toEqual(page)
		expect(entries[0]).toEqual({ SavedImageId: img.Id, IsCheered: true })
		expect(entries.filter((e) => e.IsCheered)).toHaveLength(1)
	})

	test('GET /api/images/v6 serves the metadata projection, nothing nullable', async () => {
		const img = await createImage(env.DB, {
			imageName: 'v6shape.jpg',
			playerId: 7301,
			// No room, no event, no description: all three are null on the row.
		})
		const res = await exports.default.fetch(`${ORIGIN}/api/images/v6?name=v6shape.jpg`)
		expect(res.status).toBe(200)
		expect(await res.json()).toEqual({
			SavedImageId: img.Id,
			ImageName: 'v6shape.jpg',
			PlayerId: 7301,
			// Nulls on the row come out as 0 / "" — the client's DTO has no null to put there.
			RoomId: 0,
			PlayerEventId: 0,
			ClubId: 0,
			Description: '',
			Accessibility: 1,
			AccessibilityLocked: false,
			SavedImageType: 1,
			CreatedAt: img.CreatedAt,
			CheerCount: 0,
			CommentCount: 0,
		})
	})

	test('GET /api/images/v6 400s without a name and 404s for an unknown one', async () => {
		expect((await exports.default.fetch(`${ORIGIN}/api/images/v6`)).status).toBe(400)
		expect(
			(await exports.default.fetch(`${ORIGIN}/api/images/v6?name=doesnotexist.jpg`)).status
		).toBe(404)
	})

	test('POST /api/images/v4/uploadsaved records metadata from imgMeta', async () => {
		const fd = new FormData()
		// The client's real imgMeta shape (tagged players are `playerIds`).
		fd.append(
			'imgMeta',
			JSON.stringify({
				playerIds: [5, 6],
				savedImageType: 1,
				roomId: 777,
				playerEventId: 0,
				accessibility: 2,
			})
		)
		fd.append('image', new File([new Uint8Array([1, 2, 3])], 'pic.png', { type: 'image/png' }))
		const res = await exports.default.fetch(`${ORIGIN}/api/images/v4/uploadsaved`, {
			method: 'POST',
			headers: await bearer('42'),
			body: fd,
		})
		const { ImageName } = (await res.json()) as { ImageName: string }

		const meta = (await (
			await exports.default.fetch(`${ORIGIN}/api/images/v6?name=${ImageName}`)
		).json()) as {
			SavedImageType: number
			RoomId: number
			Accessibility: number
			PlayerEventId: number
			ClubId: number
			Description: string
		}
		expect(meta.SavedImageType).toBe(1)
		expect(meta.RoomId).toBe(777)
		expect(meta.Accessibility).toBe(2)
		// v6 carries no TaggedPlayerIds — the upload still records them, which the stored row
		// below proves. Nothing on this projection is nullable: a "none" event reads 0, not
		// null, and the club (which nothing here sets) reads 0 too.
		expect(meta).not.toHaveProperty('TaggedPlayerIds')
		expect(meta.PlayerEventId).toBe(0)
		expect(meta.ClubId).toBe(0)
		expect(meta.Description).toBe('')

		// The tagged players and the null event id, as actually stored.
		const row = await env.DB.prepare('SELECT data FROM image WHERE image_name = ?1')
			.bind(ImageName)
			.first<{ data: string }>()
		const stored = JSON.parse(row!.data) as {
			TaggedPlayerIds: number[]
			PlayerEventId: number | null
		}
		expect(stored.TaggedPlayerIds).toEqual([5, 6])
		// playerEventId 0 means "none" → stored as null, and serialized back out as 0.
		expect(stored.PlayerEventId).toBeNull()
	})

	test('POST /api/images/v4/uploadsaved records a profile thumbnail on the account', async () => {
		const bytes = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3])
		const fd = new FormData()
		// Type 4 = ProfileThumbnail. The client sends the file as image.dat.
		fd.append('imgMeta', JSON.stringify({ savedImageType: 4, roomId: -1 }))
		fd.append('image', new File([bytes], 'image.dat', { type: 'image/jpeg' }))

		const res = await exports.default.fetch(`${ORIGIN}/api/images/v4/uploadsaved`, {
			method: 'POST',
			headers: await bearer('42'),
			body: fd,
		})
		expect(res.status).toBe(200)
		const { ImageName } = (await res.json()) as { ImageName: string }
		// Type 4 → the `profile/` type folder, then <date>/<uuid>.<ext>.
		expect(ImageName).toMatch(
			/^profile\/\d{4}-\d{2}-\d{2}\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.jpg$/
		)

		// The account row now points its profileImage at the uploaded key.
		const row = await env.DB.prepare('SELECT data FROM account WHERE account_id = 42').first<{
			data: string
		}>()
		expect(JSON.parse(row!.data).profileImage).toBe(ImageName)
	})

	test('DELETE /api/images/v1/deletesaved removes the owner’s image (row + cheers + R2)', async () => {
		const ImageName = 'sharecamera/2026-07-17/delete-me.jpg'
		await env.IMAGES.put(ImageName, new Uint8Array([1, 2, 3]))
		await env.DB.prepare('INSERT INTO image (data) VALUES (?1)')
			.bind(
				JSON.stringify({
					Id: 8100,
					Type: 1,
					Accessibility: 1,
					AccessibilityLocked: false,
					ImageName,
					Description: null,
					PlayerId: 42, // owned by the default bearer account
					TaggedPlayerIds: [],
					RoomId: null,
					PlayerEventId: null,
					CreatedAt: new Date().toISOString(),
					CheerCount: 1,
					CommentCount: 0,
				})
			)
			.run()
		await env.DB.prepare(
			'INSERT INTO image_interaction (player_id, saved_image_id, cheered) VALUES (99, 8100, 1)'
		).run()

		const del = (headers: Record<string, string>) =>
			exports.default.fetch(`${ORIGIN}/api/images/v1/deletesaved`, {
				method: 'DELETE',
				headers: { 'Content-Type': 'application/json', ...headers },
				body: JSON.stringify({ ImageName }),
			})

		// No token → 401; a different account → 403 (still present afterwards).
		expect((await del({})).status).toBe(401)
		expect((await del(await bearer('43'))).status).toBe(403)
		expect(await getImageByName(env.DB, ImageName)).not.toBeNull()

		// Unknown image → 404.
		const unknown = await exports.default.fetch(`${ORIGIN}/api/images/v1/deletesaved`, {
			method: 'DELETE',
			headers: { 'Content-Type': 'application/json', ...(await bearer('42')) },
			body: JSON.stringify({ ImageName: 'sharecamera/nope.jpg' }),
		})
		expect(unknown.status).toBe(404)

		// Owner → 200, and the row, its cheers, and the R2 object are all gone.
		expect((await del(await bearer('42'))).status).toBe(200)
		expect(await getImageByName(env.DB, ImageName)).toBeNull()
		expect(await env.IMAGES.get(ImageName)).toBeNull()
		const cheers = await env.DB.prepare(
			'SELECT COUNT(*) AS n FROM image_interaction WHERE saved_image_id = 8100'
		).first<{ n: number }>()
		expect(cheers!.n).toBe(0)
	})

	test('POST /api/images/v4/uploadsaved 401s without a bearer token', async () => {
		const fd = new FormData()
		fd.append('image', new File([new Uint8Array([1, 2, 3])], 'avatar.png', { type: 'image/png' }))
		const res = await exports.default.fetch(`${ORIGIN}/api/images/v4/uploadsaved`, {
			method: 'POST',
			body: fd,
		})
		expect(res.status).toBe(401)
	})

	test('POST /api/images/v4/uploadsaved 400s without a file', async () => {
		const res = await exports.default.fetch(`${ORIGIN}/api/images/v4/uploadsaved`, {
			method: 'POST',
			headers: { ...(await bearer()), 'Content-Type': 'application/x-www-form-urlencoded' },
			body: 'foo=bar',
		})
		expect(res.status).toBe(400)
	})

	test('GET /api/images/v4/room/:id returns a public room feed, filtered/sorted/paginated', async () => {
		// Seed images in room 54: two public (one with more cheers, of different
		// types), one private (hidden), and one in another room (excluded).
		const seed = (img: Partial<SavedImage> & { Id: number }) =>
			env.DB.prepare('INSERT INTO image (data) VALUES (?1)').bind(
				JSON.stringify({
					Type: 1,
					Accessibility: 1,
					AccessibilityLocked: false,
					ImageName: `img${img.Id}.jpg`,
					Description: null,
					PlayerId: 42,
					TaggedPlayerIds: [],
					RoomId: 54,
					PlayerEventId: null,
					CreatedAt: '2026-01-01T00:00:00.000Z',
					CheerCount: 0,
					CommentCount: 0,
					...img,
				})
			)
		await env.DB.batch([
			seed({ Id: 101, CheerCount: 5, CreatedAt: '2026-02-01T00:00:00.000Z' }),
			seed({ Id: 102, CheerCount: 9, CreatedAt: '2026-01-15T00:00:00.000Z', Type: 3 }),
			seed({ Id: 103, Accessibility: 0 }), // private → hidden from the public feed
			seed({ Id: 104, RoomId: 99 }), // different room → excluded
		])

		// sort=1 → most cheered first (102 has 9, 101 has 5).
		const top = (await (
			await exports.default.fetch(`${ORIGIN}/api/images/v4/room/54?sort=1&filter=0&take=100&skip=0`)
		).json()) as SavedImage[]
		expect(top.map((i) => i.Id)).toEqual([102, 101])

		// sort=0 → newest first (101 is more recent than 102).
		const newest = (await (
			await exports.default.fetch(`${ORIGIN}/api/images/v4/room/54?sort=0`)
		).json()) as SavedImage[]
		expect(newest.map((i) => i.Id)).toEqual([101, 102])

		// filter=1 (ShareCamera) drops the Type-3 image (102).
		const filtered = (await (
			await exports.default.fetch(`${ORIGIN}/api/images/v4/room/54?filter=1`)
		).json()) as SavedImage[]
		expect(filtered.map((i) => i.Id)).toEqual([101])

		// take/skip paginate.
		const page = (await (
			await exports.default.fetch(`${ORIGIN}/api/images/v4/room/54?sort=1&take=1&skip=1`)
		).json()) as SavedImage[]
		expect(page.map((i) => i.Id)).toEqual([101])

		// A room with no images → empty array.
		expect(
			await (await exports.default.fetch(`${ORIGIN}/api/images/v4/room/12345`)).json()
		).toEqual([])
	})

	test('GET /api/images/v4/player/:id and v3/feed/player/:id return the player photos + feed', async () => {
		const seed = (img: Partial<SavedImage> & { Id: number }) =>
			env.DB.prepare('INSERT INTO image (data) VALUES (?1)').bind(
				JSON.stringify({
					Type: 1,
					Accessibility: 1,
					AccessibilityLocked: false,
					ImageName: `p${img.Id}.jpg`,
					Description: null,
					PlayerId: 700,
					TaggedPlayerIds: [],
					RoomId: null,
					PlayerEventId: null,
					CreatedAt: '2026-01-01T00:00:00.000Z',
					CheerCount: 0,
					CommentCount: 0,
					...img,
				})
			)
		await env.DB.batch([
			// Player 700's own photos (newest last so ordering is exercised).
			seed({ Id: 201, PlayerId: 700, CreatedAt: '2026-03-01T00:00:00.000Z' }),
			seed({ Id: 202, PlayerId: 700, CreatedAt: '2026-04-01T00:00:00.000Z' }),
			seed({ Id: 203, PlayerId: 700, Accessibility: 0 }), // private → hidden
			// Taken by someone else, but player 700 is tagged in it → feed only.
			seed({
				Id: 204,
				PlayerId: 999,
				TaggedPlayerIds: [700],
				CreatedAt: '2026-05-01T00:00:00.000Z',
			}),
			// Unrelated to 700 → in neither.
			seed({ Id: 205, PlayerId: 999, TaggedPlayerIds: [111] }),
		])

		// The lists serve the client's ImagesPlayer projection: the id and type are
		// SavedImageId/SavedImageType, and TaggedPlayerIds isn't part of it.
		type ImagesPlayer = { SavedImageId: number; SavedImageType: number; ImageName: string }

		// v4/player → only photos 700 *took*, public, newest first.
		const mine = (await (
			await exports.default.fetch(`${ORIGIN}/api/images/v4/player/700`)
		).json()) as ImagesPlayer[]
		expect(mine.map((i) => i.SavedImageId)).toEqual([202, 201])
		expect(mine[0]).toEqual({
			Accessibility: 1,
			AccessibilityLocked: false,
			CheerCount: 0,
			CommentCount: 0,
			CreatedAt: '2026-04-01T00:00:00.000Z',
			Description: null,
			ImageName: 'p202.jpg',
			PlayerEventId: null,
			PlayerId: 700,
			RoomId: null,
			SavedImageId: 202,
			SavedImageType: 1,
		})

		// take paginates.
		const one = (await (
			await exports.default.fetch(`${ORIGIN}/api/images/v4/player/700?take=1`)
		).json()) as ImagesPlayer[]
		expect(one.map((i) => i.SavedImageId)).toEqual([202])

		// v5/player is the same list with a sort option (0 = newest first).
		const sorted = (await (
			await exports.default.fetch(`${ORIGIN}/api/images/v5/player/700?sort=0`)
		).json()) as ImagesPlayer[]
		expect(sorted.map((i) => i.SavedImageId)).toEqual([202, 201])

		// v3/feed/player → photos taken *or* tagged in, newest first (204 is newest).
		const feed = (await (
			await exports.default.fetch(`${ORIGIN}/api/images/v3/feed/player/700?take=100`)
		).json()) as ImagesPlayer[]
		expect(feed.map((i) => i.SavedImageId)).toEqual([204, 202, 201])

		// A player with no photos → empty array on both.
		expect(
			await (await exports.default.fetch(`${ORIGIN}/api/images/v4/player/424242`)).json()
		).toEqual([])
		expect(
			await (await exports.default.fetch(`${ORIGIN}/api/images/v3/feed/player/424242`)).json()
		).toEqual([])
	})
})

describe('relationships', () => {
	// RelationshipType: 0 None, 1 FriendRequestSent, 2 FriendRequestReceived, 3 Friend.
	type Rel = { PlayerID: number; RelationshipType: number; Favorited: number }

	// Call a relationship mutation as `sub`, targeting `playerId` — the real client
	// shape: a GET with the target in `?id=`.
	async function mutate(path: string, sub: string, playerId: number) {
		return exports.default.fetch(`${ORIGIN}${path}?id=${playerId}`, {
			headers: await bearer(sub),
		})
	}

	// Fetch `sub`'s relationships, projected from their point of view.
	async function relationships(sub: string): Promise<Rel[]> {
		const res = await exports.default.fetch(`${ORIGIN}/api/relationships/v2/get`, {
			headers: await bearer(sub),
		})
		return (await res.json()) as Rel[]
	}

	// Standard ack the flag endpoints (favorite/ignore/mute + inverses) now return —
	// the relationship detail rides a RelationshipChanged hub notification instead.
	const ACK = { Success: true, Message: '' }

	// The notify DO is stubbed to record every notifyPlayer call (see vitest.config).
	type Notification = {
		playerId: number
		notificationType: number
		data: { PlayerID: number; RelationshipType: number; Favorited: number; Ignored: number }
	}
	const hub = () => env.RECFLARE_NOTIFICATIONS_HUB.getByName('global')

	/** Drop everything the hub stub has recorded so far. */
	async function resetNotifications() {
		await hub().fetch('http://do/all', { method: 'DELETE' })
	}

	/** Every notification pushed since the last reset, in order. */
	async function sentNotifications(): Promise<Notification[]> {
		return (await (await hub().fetch('http://do/all')).json()) as Notification[]
	}

	// POST a flag mutation the real client way (form body `PlayerId=<id>`), returning
	// the parsed ack body.
	async function ackFlag(path: string, sub: string, playerId: number) {
		return (await (
			await exports.default.fetch(`${ORIGIN}${path}`, {
				method: 'POST',
				headers: { ...(await bearer(sub)), 'Content-Type': 'application/x-www-form-urlencoded' },
				body: `PlayerId=${playerId}`,
			})
		).json()) as { Success: boolean; Message: string }
	}

	// A player's own-side flags read straight from the relationship row — the flag
	// endpoints return only an ack, so the effect is verified against the row itself.
	async function ownFlags(playerId: number, otherId: number) {
		const row = (await env.DB.prepare(
			`SELECT requester_id, requester_favorited, requester_ignored, requester_muted,
			        target_favorited, target_ignored, target_muted
			 FROM relationship
			 WHERE (requester_id = ?1 AND target_id = ?2) OR (requester_id = ?2 AND target_id = ?1)`
		)
			.bind(playerId, otherId)
			.first()) as Record<string, number> | null
		if (!row) return null
		const isRequester = row.requester_id === playerId
		return {
			Favorited: isRequester ? row.requester_favorited : row.target_favorited,
			Ignored: isRequester ? row.requester_ignored : row.target_ignored,
			Muted: isRequester ? row.requester_muted : row.target_muted,
		}
	}

	test('GET /api/relationships/v2/get is auth-gated', async () => {
		expect((await exports.default.fetch(`${ORIGIN}/api/relationships/v2/get`)).status).toBe(401)
	})

	test('mutations are auth-gated', async () => {
		for (const path of [
			'/api/relationships/v2/sendfriendrequest',
			'/api/relationships/v2/acceptfriendrequest',
			'/api/relationships/v2/removefriend',
			'/api/relationships/v2/addfriend',
			'/api/relationships/v1/ignore',
			'/api/relationships/v1/mute',
			'/api/relationships/v1/favorite',
			'/api/relationships/v1/unfavorite',
		]) {
			const res = await exports.default.fetch(`${ORIGIN}${path}?id=1`)
			expect(res.status).toBe(401)
		}
	})

	test('send → the two sides see Sent / Received; accept → both Friend; remove → gone', async () => {
		// 500 sends 501 a request.
		const sent = (await (
			await mutate('/api/relationships/v2/sendfriendrequest', '500', 501)
		).json()) as Rel
		expect(sent).toMatchObject({ PlayerID: 501, RelationshipType: 1 })

		// 500 sees it as Sent (1); 501 sees the mirror as Received (2).
		expect(await relationships('500')).toEqual([
			{ PlayerID: 501, RelationshipType: 1, Favorited: 0, Ignored: 0, Muted: 0 },
		])
		expect(await relationships('501')).toEqual([
			{ PlayerID: 500, RelationshipType: 2, Favorited: 0, Ignored: 0, Muted: 0 },
		])

		// 501 accepts → both are Friends (3).
		const accepted = (await (
			await mutate('/api/relationships/v2/acceptfriendrequest', '501', 500)
		).json()) as Rel
		expect(accepted).toMatchObject({ PlayerID: 500, RelationshipType: 3 })
		expect(await relationships('500')).toEqual([
			{ PlayerID: 501, RelationshipType: 3, Favorited: 0, Ignored: 0, Muted: 0 },
		])
		expect(await relationships('501')).toEqual([
			{ PlayerID: 500, RelationshipType: 3, Favorited: 0, Ignored: 0, Muted: 0 },
		])

		// 500 removes → both sides drop to None. The row is kept (that's where the
		// per-side flags live), so v2/get still reports the pair, now as None (0).
		expect((await mutate('/api/relationships/v2/removefriend', '500', 501)).status).toBe(200)
		expect(await relationships('500')).toEqual([
			{ PlayerID: 501, RelationshipType: 0, Favorited: 0, Ignored: 0, Muted: 0 },
		])
		expect(await relationships('501')).toEqual([
			{ PlayerID: 500, RelationshipType: 0, Favorited: 0, Ignored: 0, Muted: 0 },
		])
	})

	test('removefriend keeps the caller’s ignore flag', async () => {
		// 760 befriends 761 then ignores them; dropping the friendship must not
		// un-ignore them (the flag lives on the row the removal downgrades to None).
		await mutate('/api/relationships/v2/addfriend', '760', 761)
		await ackFlag('/api/relationships/v1/ignore', '760', 761)
		await mutate('/api/relationships/v2/removefriend', '760', 761)
		expect(await ownFlags(760, 761)).toMatchObject({ Ignored: 1 })
		expect(await relationships('760')).toEqual([
			{ PlayerID: 761, RelationshipType: 0, Favorited: 0, Ignored: 1, Muted: 0 },
		])
	})

	test('addfriend makes them friends directly', async () => {
		const res = (await (await mutate('/api/relationships/v2/addfriend', '510', 511)).json()) as Rel
		expect(res).toMatchObject({ PlayerID: 511, RelationshipType: 3 })
		expect(await relationships('511')).toEqual([
			{ PlayerID: 510, RelationshipType: 3, Favorited: 0, Ignored: 0, Muted: 0 },
		])
	})

	test('crossing friend requests become a friendship', async () => {
		await mutate('/api/relationships/v2/sendfriendrequest', '520', 521)
		// 521 sends back to 520 → the crossing requests resolve to Friend for both.
		const crossed = (await (
			await mutate('/api/relationships/v2/sendfriendrequest', '521', 520)
		).json()) as Rel
		expect(crossed).toMatchObject({ PlayerID: 520, RelationshipType: 3 })
		expect(await relationships('520')).toEqual([
			{ PlayerID: 521, RelationshipType: 3, Favorited: 0, Ignored: 0, Muted: 0 },
		])
	})

	test('a self-targeted request is rejected', async () => {
		expect((await mutate('/api/relationships/v2/sendfriendrequest', '530', 530)).status).toBe(400)
	})

	test('v1 ignore/mute set the caller’s own side of the relationship', async () => {
		type FullRel = { PlayerID: number; RelationshipType: number; Ignored: number; Muted: number }

		// 700 ignores 701 with no prior relationship → a bare None row, the caller's side
		// flagged. The response is now just the ack; the flag is verified on the row.
		expect(await ackFlag('/api/relationships/v1/ignore', '700', 701)).toEqual(ACK)
		expect(await ownFlags(700, 701)).toMatchObject({ Ignored: 1, Muted: 0 })
		// 700 then mutes 701 → same row, mute added, the earlier ignore preserved.
		expect(await ackFlag('/api/relationships/v1/mute', '700', 701)).toEqual(ACK)
		expect(await ownFlags(700, 701)).toMatchObject({ Ignored: 1, Muted: 1 })

		// The tricky case: the caller is the row's TARGET. 710 sends 711 a request
		// (710 = requester); 711 ignoring 710 must flag the target side, not the requester's.
		await mutate('/api/relationships/v2/sendfriendrequest', '710', 711)
		expect(await ackFlag('/api/relationships/v1/ignore', '711', 710)).toEqual(ACK)
		// 711 sees 710's request as Received (2) with their own Ignored set.
		expect((await relationships('711')) as unknown as FullRel[]).toEqual([
			expect.objectContaining({ PlayerID: 710, RelationshipType: 2, Ignored: 1 }),
		])
		// 710's own side is untouched — the requester never ignored anyone.
		expect((await relationships('710')) as unknown as FullRel[]).toEqual([
			expect.objectContaining({ PlayerID: 711, RelationshipType: 1, Ignored: 0 }),
		])
	})

	test('v1 unignore/unmute clear the caller’s own flags independently', async () => {
		// 800 ignores and mutes 801 (bare None row, both flags on the caller's side).
		await ackFlag('/api/relationships/v1/ignore', '800', 801)
		await ackFlag('/api/relationships/v1/mute', '800', 801)
		expect(await ownFlags(800, 801)).toMatchObject({ Ignored: 1, Muted: 1 })
		// unignore clears only Ignored; the mute is left in place.
		expect(await ackFlag('/api/relationships/v1/unignore', '800', 801)).toEqual(ACK)
		expect(await ownFlags(800, 801)).toMatchObject({ Ignored: 0, Muted: 1 })
		// unmute then clears Muted too.
		expect(await ackFlag('/api/relationships/v1/unmute', '800', 801)).toEqual(ACK)
		expect(await ownFlags(800, 801)).toMatchObject({ Ignored: 0, Muted: 0 })
	})

	test('v1 favorite/unfavorite toggle the caller’s own side, leaving the friendship intact', async () => {
		// 720 and 721 are friends; 720 favorites 721 — the real client shape, a GET with `?id=`.
		await mutate('/api/relationships/v2/addfriend', '720', 721)
		expect(await (await mutate('/api/relationships/v1/favorite', '720', 721)).json()).toEqual(ACK)
		// 720's own side is favorited; the friendship is intact.
		expect(await relationships('720')).toEqual([
			{ PlayerID: 721, RelationshipType: 3, Favorited: 1, Ignored: 0, Muted: 0 },
		])
		// Favoriting is one-sided: 721 does not see themselves as having favorited 720.
		expect(await relationships('721')).toEqual([
			{ PlayerID: 720, RelationshipType: 3, Favorited: 0, Ignored: 0, Muted: 0 },
		])

		// Unfavorite clears the flag but keeps the friendship.
		expect(await (await mutate('/api/relationships/v1/unfavorite', '720', 721)).json()).toEqual(ACK)
		expect(await relationships('720')).toEqual([
			{ PlayerID: 721, RelationshipType: 3, Favorited: 0, Ignored: 0, Muted: 0 },
		])
	})

	test('favoriting a player you have no relationship with is allowed', async () => {
		// Mirrors ignore/mute: a bare None row is created with the caller's side flagged.
		expect(await (await mutate('/api/relationships/v1/favorite', '730', 731)).json()).toEqual(ACK)
		expect(await ownFlags(730, 731)).toMatchObject({ Favorited: 1 })
		// The bare None row is reported by v2/get — it carries the flag.
		expect(await relationships('730')).toEqual([
			{ PlayerID: 731, RelationshipType: 0, Favorited: 1, Ignored: 0, Muted: 0 },
		])
	})

	test('a self-targeted favorite is rejected', async () => {
		expect((await mutate('/api/relationships/v1/favorite', '740', 740)).status).toBe(400)
	})

	test('a flag change pushes a RelationshipChanged notification with the relationship', async () => {
		// The relationship detail now rides a hub notification instead of the response.
		// The notify DO is stubbed to record its last notifyPlayer call (see vitest.config).
		await ackFlag('/api/relationships/v1/favorite', '750', 751)
		const res = await env.RECFLARE_NOTIFICATIONS_HUB.getByName('global').fetch('http://do/last')
		const last = (await res.json()) as {
			playerId: number
			notificationType: number
			data: { PlayerID: number; Favorited: number; RelationshipType: number }
		}
		expect(last.playerId).toBe(750) // sent to the caller
		expect(last.notificationType).toBe(1) // NotificationType.RelationshipChanged
		expect(last.data).toMatchObject({ PlayerID: 751, Favorited: 1, RelationshipType: 0 })
	})

	test('sendfriendrequest notifies both players with their own projection', async () => {
		await resetNotifications()
		await mutate('/api/relationships/v2/sendfriendrequest', '770', 771)

		// Both sides hear about it, each seeing the other player and their own side's
		// type: the sender Sent (1), the recipient Received (2).
		expect(await sentNotifications()).toEqual([
			{
				playerId: 770,
				notificationType: 1,
				data: { PlayerID: 771, RelationshipType: 1, Favorited: 0, Ignored: 0, Muted: 0 },
			},
			{
				playerId: 771,
				notificationType: 1,
				data: { PlayerID: 770, RelationshipType: 2, Favorited: 0, Ignored: 0, Muted: 0 },
			},
		])
	})

	test('accepting notifies both players as Friend', async () => {
		await mutate('/api/relationships/v2/sendfriendrequest', '780', 781)
		await resetNotifications()
		await mutate('/api/relationships/v2/acceptfriendrequest', '781', 780)

		const sent = await sentNotifications()
		expect(sent).toHaveLength(2)
		// Friend (3) is symmetric, so both sides see the same type, each pointing at the other.
		expect(sent).toEqual(
			expect.arrayContaining([
				expect.objectContaining({
					playerId: 780,
					data: expect.objectContaining({ PlayerID: 781, RelationshipType: 3 }),
				}),
				expect.objectContaining({
					playerId: 781,
					data: expect.objectContaining({ PlayerID: 780, RelationshipType: 3 }),
				}),
			])
		)
	})

	test('removefriend notifies both players with None', async () => {
		await mutate('/api/relationships/v2/addfriend', '790', 791)
		await resetNotifications()
		await mutate('/api/relationships/v2/removefriend', '790', 791)

		const sent = await sentNotifications()
		expect(sent).toHaveLength(2)
		expect(sent.map((n) => n.playerId).sort((a, b) => a - b)).toEqual([790, 791])
		for (const n of sent) expect(n.data.RelationshipType).toBe(0)
	})

	test('a no-op friend request notifies nobody', async () => {
		await mutate('/api/relationships/v2/sendfriendrequest', '810', 811)
		await resetNotifications()

		// Re-sending an already-outstanding request writes nothing, so nothing is pushed.
		await mutate('/api/relationships/v2/sendfriendrequest', '810', 811)
		expect(await sentNotifications()).toEqual([])

		// Likewise accepting something that isn't pending (810 has no request to accept).
		await mutate('/api/relationships/v2/acceptfriendrequest', '810', 811)
		expect(await sentNotifications()).toEqual([])
	})

	test('crossing requests notify both players as Friend', async () => {
		await mutate('/api/relationships/v2/sendfriendrequest', '820', 821)
		await resetNotifications()
		// 821's request crosses 820's → an immediate friendship, both sides told.
		await mutate('/api/relationships/v2/sendfriendrequest', '821', 820)

		const sent = await sentNotifications()
		expect(sent).toHaveLength(2)
		for (const n of sent) expect(n.data.RelationshipType).toBe(3)
	})
})

describe('friend online count', () => {
	// Presence is written by the `match` worker, so it's seeded straight into the table
	// here. `roomInstance` null is lobby presence — signed in, not in a room.
	async function setPresence(accountId: number, secondsLeft = PRESENCE_TTL_SECONDS) {
		await env.DB.prepare('INSERT OR REPLACE INTO presence (data) VALUES (?1)')
			.bind(
				JSON.stringify({
					accountId,
					roomInstance: null,
					statusVisibility: 0,
					deviceClass: 0,
					vrMovementMode: 0,
					platform: 0,
					appVersion: GAME_VERSION,
					expiresAt: Math.floor(Date.now() / 1000) + secondsLeft,
				})
			)
			.run()
	}

	async function friendOnlineCount(sub: string): Promise<number> {
		const res = await exports.default.fetch(`${ORIGIN}/api/messages/v1/friendOnlineStatus`, {
			method: 'POST',
			headers: await bearer(sub),
		})
		expect(res.status).toBe(200)
		const body = (await res.json()) as { success: boolean; value: { FriendsOnlineCount: number } }
		expect(body.success).toBe(true)
		return body.value.FriendsOnlineCount
	}

	// Make `a` and `b` friends the way the client does.
	async function befriend(a: string, b: number) {
		await exports.default.fetch(`${ORIGIN}/api/relationships/v2/addfriend?id=${b}`, {
			headers: await bearer(a),
		})
	}

	test('POST /api/messages/v1/friendOnlineStatus is auth-gated', async () => {
		const res = await exports.default.fetch(`${ORIGIN}/api/messages/v1/friendOnlineStatus`, {
			method: 'POST',
		})
		expect(res.status).toBe(401)
	})

	test('counts only friends who are online, from either side of the row', async () => {
		// 900 is friends with 901 (as requester) and with 902 (as target).
		await befriend('900', 901)
		await befriend('902', 900)
		// A pending request and a stranger, both online — neither is a friendship.
		await exports.default.fetch(`${ORIGIN}/api/relationships/v2/sendfriendrequest?id=903`, {
			headers: await bearer('900'),
		})

		expect(await friendOnlineCount('900')).toBe(0)

		// Both friends online, plus noise: the caller themselves, the pending request, and
		// an unrelated player.
		await setPresence(900)
		await setPresence(901)
		await setPresence(902)
		await setPresence(903)
		await setPresence(904)
		expect(await friendOnlineCount('900')).toBe(2)

		// One friend goes offline; the other still counts.
		await env.DB.prepare('DELETE FROM presence WHERE account_id = ?1').bind(901).run()
		expect(await friendOnlineCount('900')).toBe(1)
	})

	test('expired presence does not count, and unfriending drops the count', async () => {
		await befriend('910', 911)
		await setPresence(911, -1)
		expect(await friendOnlineCount('910')).toBe(0)

		await setPresence(911)
		expect(await friendOnlineCount('910')).toBe(1)

		await exports.default.fetch(`${ORIGIN}/api/relationships/v2/removefriend?id=911`, {
			headers: await bearer('910'),
		})
		expect(await friendOnlineCount('910')).toBe(0)
	})

	test('a player with no relationships counts zero', async () => {
		expect(await friendOnlineCount('920')).toBe(0)
	})
})

describe('messages', () => {
	// The notify DO is stubbed to record every notifyPlayer call (see vitest.config).
	type Sent = {
		playerId: number
		notificationType: number
		data: { FromPlayerId: number; ToPlayerId: number; Type: number; Data: string }
	}
	const hub = () => env.RECFLARE_NOTIFICATIONS_HUB.getByName('global')
	const pushed = async (): Promise<Sent[]> =>
		(await (await hub().fetch('http://do/all')).json()) as Sent[]

	const send = async (fields: Record<string, string>, headers?: Record<string, string>) => {
		await hub().fetch('http://do/all', { method: 'DELETE' })
		return exports.default.fetch(`${ORIGIN}/api/messages/v2/send`, {
			method: 'POST',
			headers: { 'Content-Type': 'application/x-www-form-urlencoded', ...headers },
			body: new URLSearchParams(fields),
		})
	}

	// NotificationType.MessageReceived — the same frame the Coach broadcast uses.
	const MESSAGE_RECEIVED = 2

	test('POST /api/messages/v2/send pushes MessageReceived to the recipient', async () => {
		const res = await send({ ToPlayerId: '2', Type: '10', Data: '' }, await bearer('42'))
		expect(res.status).toBe(200)
		expect(await res.json()).toEqual({ success: true, error: '' })

		expect(await pushed()).toEqual([
			{
				// Delivered to the recipient, not the sender.
				playerId: 2,
				notificationType: MESSAGE_RECEIVED,
				// FromPlayerId is the token's subject, not a body field.
				data: { FromPlayerId: 42, ToPlayerId: 2, Type: 10, Data: '' },
			},
		])
	})

	test('POST /api/messages/v2/send defaults Type and Data when omitted', async () => {
		const res = await send({ ToPlayerId: '2' }, await bearer('42'))
		expect(res.status).toBe(200)
		expect((await pushed())[0]?.data).toEqual({
			FromPlayerId: 42,
			ToPlayerId: 2,
			Type: 0,
			Data: '',
		})
	})

	test('POST /api/messages/v2/send 400s without a recipient, pushing nothing', async () => {
		const res = await send({ Type: '10' }, await bearer('42'))
		expect(res.status).toBe(400)
		expect(await res.json()).toEqual({ success: false, error: 'ToPlayerId is required' })
		expect(await pushed()).toEqual([])
	})

	test('POST /api/messages/v2/send is auth-gated', async () => {
		const res = await send({ ToPlayerId: '2' })
		expect(res.status).toBe(401)
		expect(await pushed()).toEqual([])
	})

	// The bulk form takes a JSON body, not the form encoding the single send uses.
	const sendMultiple = async (body: unknown, headers?: Record<string, string>) => {
		await hub().fetch('http://do/all', { method: 'DELETE' })
		return exports.default.fetch(`${ORIGIN}/api/messages/v1/sendMultiple`, {
			method: 'POST',
			headers: { 'Content-Type': 'application/json', ...headers },
			body: JSON.stringify(body),
		})
	}

	test('POST /api/messages/v1/sendMultiple pushes one frame per recipient', async () => {
		const res = await sendMultiple(
			{ ToPlayerIds: [205, 206], Type: 20, Data: 'hi' },
			await bearer('42')
		)
		expect(res.status).toBe(200)
		expect(await res.json()).toEqual({ success: true, error: '' })

		// Each frame is addressed to its own recipient; the sender is the token's subject.
		expect(await pushed()).toEqual([
			{
				playerId: 205,
				notificationType: MESSAGE_RECEIVED,
				data: { FromPlayerId: 42, ToPlayerId: 205, Type: 20, Data: 'hi' },
			},
			{
				playerId: 206,
				notificationType: MESSAGE_RECEIVED,
				data: { FromPlayerId: 42, ToPlayerId: 206, Type: 20, Data: 'hi' },
			},
		])
	})

	test('POST /api/messages/v1/sendMultiple defaults Type and Data, and de-duplicates ids', async () => {
		const res = await sendMultiple({ ToPlayerIds: [205, 205] }, await bearer('42'))
		expect(res.status).toBe(200)

		const sent = await pushed()
		expect(sent).toHaveLength(1)
		expect(sent[0]?.data).toEqual({ FromPlayerId: 42, ToPlayerId: 205, Type: 0, Data: '' })
	})

	test('POST /api/messages/v1/sendMultiple 400s with no usable recipient, pushing nothing', async () => {
		for (const body of [{ Type: 20 }, { ToPlayerIds: [] }, { ToPlayerIds: ['nope', 0] }]) {
			const res = await sendMultiple(body, await bearer('42'))
			expect(res.status).toBe(400)
			expect(await res.json()).toEqual({ success: false, error: 'ToPlayerIds is required' })
			expect(await pushed()).toEqual([])
		}
	})

	test('POST /api/messages/v1/sendMultiple is auth-gated', async () => {
		const res = await sendMultiple({ ToPlayerIds: [205] })
		expect(res.status).toBe(401)
		expect(await pushed()).toEqual([])
	})

	test('POST /api/messages/v3/delete accepts anything with an empty 200', async () => {
		// No message store, so no id can be real and nothing is gated — an unknown id, an
		// empty list and a missing body all land the same way.
		for (const body of [{ MessageIds: [1787377235629] }, { MessageIds: [] }, {}]) {
			const res = await exports.default.fetch(`${ORIGIN}/api/messages/v3/delete`, {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify(body),
			})
			expect(res.status).toBe(200)
			expect(await res.text()).toBe('')
		}
	})
})

describe('mutual friends', () => {
	// High, distinct ids so the friendships seeded here don't collide with the
	// relationship tests above.
	const CALLER = 800
	const OTHER = 801

	type Card = { AccountId: number; Username: string; DisplayName: string; ProfileImage: string }

	const mutuals = async (query: string, sub = String(CALLER)): Promise<Response> =>
		exports.default.fetch(`${ORIGIN}/api/relationships/mutualfriends${query}`, {
			headers: await bearer(sub),
		})

	beforeAll(async () => {
		const rel = (a: number, b: number, type = 3) =>
			env.DB.prepare(
				'INSERT INTO relationship (requester_id, target_id, relationship_type) VALUES (?1, ?2, ?3)'
			).bind(a, b, type)
		// 804 has no profileImage key at all — the projection must still answer a
		// string. 806 is deliberately given no account row.
		const account = (id: number, extra: Record<string, unknown>) =>
			env.DB.prepare('INSERT OR IGNORE INTO account (data) VALUES (?1)').bind(
				JSON.stringify({ accountId: id, username: `P${id}`, displayName: `Player ${id}`, ...extra })
			)

		await env.DB.batch([
			account(CALLER, { profileImage: 'p800.jpg' }),
			account(OTHER, { profileImage: 'p801.jpg' }),
			account(802, { profileImage: 'p802.jpg' }),
			account(803, { profileImage: 'p803.jpg' }),
			account(804, {}),
			// Seeded 804-first so the ascending order of the answer is the code's doing,
			// not the insertion order's.
			rel(CALLER, 804),
			rel(802, CALLER), // friendship recorded from the other direction
			rel(CALLER, 803),
			rel(CALLER, 806),
			rel(OTHER, 804), // shared → in the answer
			rel(OTHER, 802), // shared → in the answer
			rel(803, OTHER, 1), // only a pending request → NOT a friend of OTHER
			rel(OTHER, 806), // shared, but 806 has no account row → dropped
		])
	})

	test('GET /api/relationships/mutualfriends returns the shared friends', async () => {
		const res = await mutuals(`?id=${OTHER}`)
		expect(res.status).toBe(200)
		const cards = (await res.json()) as Card[]
		// 803 is only a pending request on OTHER's side, and 806 has no account row.
		expect(cards.map((p) => p.AccountId)).toEqual([802, 804])
		expect(cards[0]).toEqual({
			AccountId: 802,
			Username: 'P802',
			DisplayName: 'Player 802',
			ProfileImage: 'p802.jpg',
		})
		// No stored image → an empty string, never null/undefined.
		expect(cards[1]?.ProfileImage).toBe('')
	})

	// The degenerate cases answer an empty list rather than an error — this feeds a
	// profile panel, which would otherwise have nothing to render.
	// `?id=` is the only accepted form — `?playerId=` reads as no id at all.
	test('GET /api/relationships/mutualfriends answers [] for a missing/self/bad id', async () => {
		for (const query of ['', '?id=0', '?id=-5', '?id=abc', `?id=${CALLER}`, `?playerId=${OTHER}`]) {
			const res = await mutuals(query)
			expect(res.status, query).toBe(200)
			expect(await res.json(), query).toEqual([])
		}
	})

	// Symmetric: 802 and 803 aren't friends with each other, but both are friends with
	// 800, so 800 is what they have in common.
	test('GET /api/relationships/mutualfriends works between two other players', async () => {
		const cards = (await (await mutuals('?id=803', '802')).json()) as Card[]
		expect(cards.map((p) => p.AccountId)).toEqual([CALLER])
	})

	test('GET /api/relationships/mutualfriends answers [] with nothing in common', async () => {
		// 809 has no relationships at all.
		const cards = (await (await mutuals('?id=809', '802')).json()) as Card[]
		expect(cards).toEqual([])
	})

	test('GET /api/relationships/mutualfriends is auth-gated', async () => {
		const res = await exports.default.fetch(`${ORIGIN}/api/relationships/mutualfriends?id=${OTHER}`)
		expect(res.status).toBe(401)
	})
})

describe('player events', () => {
	const HOUR = 60 * 60 * 1000
	/** The longest window a write may store — an event lasts at most a day. */
	const DAY = 24 * HOUR
	/**
	 * Seconds precision, no milliseconds — the form the client sends and reads back.
	 *
	 * Anchored to one instant fixed when this suite is defined, NOT to `Date.now()` per
	 * call: the same offset is evaluated once to build a fixture and again to assert what
	 * came back, and a re-read clock makes those two strings differ by a second whenever
	 * the pair straddles a second boundary. Offsets are whole hours, so pinning the anchor
	 * leaves the upcoming/live/finished distinction the browse queries make intact.
	 */
	const NOW = Date.now()
	const at = (offsetMs: number): string =>
		new Date(NOW + offsetMs).toISOString().replace(/\.\d{3}Z$/, 'Z')

	const post = async (path: string, body: unknown, sub = '42'): Promise<Response> =>
		exports.default.fetch(`${ORIGIN}${path}`, {
			method: 'POST',
			headers: { ...(await bearer(sub)), 'content-type': 'application/json' },
			body: JSON.stringify(body),
		})

	// The write envelope's event, which is NOT the stored record: no `State`, plus `Tags`
	// and `BroadcastingRoomInstanceId`. Tests that want the record read it back over v1.
	const create = async (body: unknown, sub = '42'): Promise<PlayerEventEnvelope> => {
		const res = await post('/api/playerevents/v2', body, sub)
		expect(res.status).toBe(200)
		return ((await res.json()) as PlayerEventResult).PlayerEvent
	}

	const get = async (path: string, sub?: string): Promise<Response> =>
		exports.default.fetch(`${ORIGIN}${path}`, sub ? { headers: await bearer(sub) } : undefined)

	/**
	 * The stored RECORD behind an envelope's event — what the v1 reads serve. The envelope
	 * drops `State`, adds `Tags`/`BroadcastingRoomInstanceId`, and turns a null `ImageName`
	 * into `""`, so going back the other way undoes exactly those.
	 */
	const asRecord = (
		event: PlayerEventEnvelope,
		imageName: string | null = event.ImageName
	): PlayerEvent => {
		const { Tags: _tags, BroadcastingRoomInstanceId: _broadcast, ...rest } = event
		return { ...rest, ImageName: imageName, State: 0 }
	}

	// The fixture set every test below reads. Times are relative to the run so the
	// upcoming/live/finished distinction the browse queries make is real.
	let upcoming: PlayerEventEnvelope
	let clubEvent: PlayerEventEnvelope
	let liveEvent: PlayerEventEnvelope
	let pastEvent: PlayerEventEnvelope

	beforeAll(async () => {
		// Posted nested under `PlayerEvent` — the envelope form the client sends back.
		upcoming = await create({
			PlayerEvent: {
				ImageName: 'e63dcbffe8d14a7696bea7117dc3dd28.jpg',
				RoomId: 10916706,
				SubRoomId: 11195660,
				ClubId: null,
				Name: 'Building a Better Room Using Trigonometry',
				Description: '',
				StartTime: at(HOUR),
				EndTime: at(2 * HOUR),
				State: 0,
				Accessibility: 1,
				IsMultiInstance: false,
				SupportMultiInstanceRoomChat: true,
				DefaultBroadcastPermissions: 0,
				CanRequestBroadcastPermissions: 0,
			},
		})
		// …and this one at the top level, the other form in circulation.
		clubEvent = await create({
			RoomId: 23570830,
			ClubId: 7,
			Name: 'DUNGEONS Escape ROOM',
			Description: 'Try and escape the DUNGEONS with upto 4 players!',
			StartTime: at(3 * HOUR),
			EndTime: at(4 * HOUR),
			CanRequestBroadcastPermissions: 2147483647,
		})
		liveEvent = await create(
			{ RoomId: 3, ClubId: 7, Name: 'Live Jam', StartTime: at(-HOUR), EndTime: at(HOUR) },
			'43'
		)
		pastEvent = await create({
			RoomId: 3,
			Name: 'Trigonometry Retrospective',
			StartTime: at(-3 * HOUR),
			EndTime: at(-2 * HOUR),
		})
	})

	test('GET /api/playerevents/v1/tagfilters serves the event categories, auth-gated', async () => {
		expect((await get('/api/playerevents/v1/tagfilters')).status).toBe(401)

		const res = await get('/api/playerevents/v1/tagfilters', '42')
		expect(res.status).toBe(200)
		// Static — the categories the client offers, not derived from stored events.
		// Trending is null even in the reference: it needs recent-activity data.
		expect(await res.json()).toEqual({
			PinnedFilters: [
				'workshops',
				'celebration',
				'game',
				'meetup',
				'performance',
				'coop',
				'grandopening',
				'class',
				'competition',
			],
			PopularFilters: [
				'workshops',
				'celebration',
				'class',
				'coop',
				'competition',
				'game',
				'grandopening',
				'meetup',
				'performance',
			],
			TrendingFilters: null,
		})
	})

	test('POST /api/playerevents/v2 creates an event, auth-gated', async () => {
		const res = await exports.default.fetch(`${ORIGIN}/api/playerevents/v2`, {
			method: 'POST',
			body: '{}',
		})
		expect(res.status).toBe(401)

		// The envelope's event: the client's field set, plus `Tags` and
		// `BroadcastingRoomInstanceId`, and WITHOUT `State` — the bare record the v1 read
		// serves is the one that carries that.
		expect(upcoming).toEqual({
			Tags: [],
			PlayerEventId: upcoming.PlayerEventId,
			CreatorPlayerId: 42,
			ImageName: 'e63dcbffe8d14a7696bea7117dc3dd28.jpg',
			RoomId: 10916706,
			SubRoomId: 11195660,
			ClubId: null,
			Name: 'Building a Better Room Using Trigonometry',
			Description: '',
			StartTime: at(HOUR),
			EndTime: at(2 * HOUR),
			AttendeeCount: 1,
			Accessibility: 1,
			IsMultiInstance: false,
			SupportMultiInstanceRoomChat: true,
			DefaultBroadcastPermissions: 0,
			CanRequestBroadcastPermissions: 0,
			BroadcastingRoomInstanceId: null,
		})
		// Timestamps come back at seconds precision, as the client sends them.
		expect(upcoming.StartTime).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/)
	})

	// The one thing the event writes are strict about. Everything else here defaults a
	// missing or unusable field (a nameless event becomes "Untitled Event"), but a name or
	// description past the stored length can't be defaulted into anything sensible, and
	// truncating a player's description silently is worse than refusing the write.
	//
	// Deliberately length ONLY: an event name is a title, not an identifier — the fixture
	// above is called "Building a Better Room Using Trigonometry" — so the alphanumeric
	// rule that guards usernames and room names would be wrong here.
	test('POST /api/playerevents/v2 caps the name at 64 and the description at 512', async () => {
		expect((await post('/api/playerevents/v2', { Name: 'n'.repeat(65), RoomId: 3 })).status).toBe(
			400
		)
		expect((await post('/api/playerevents/v2', { Name: 'n'.repeat(64), RoomId: 3 })).status).toBe(
			200
		)

		const withDescription = (description: string) =>
			post('/api/playerevents/v2', { Name: 'Described', RoomId: 3, Description: description })
		expect((await withDescription('d'.repeat(513))).status).toBe(400)
		expect((await withDescription('d'.repeat(512))).status).toBe(200)
		// Counted in code points, so an emoji costs one character rather than two.
		expect((await withDescription('🎉'.repeat(512))).status).toBe(200)

		// Spaces and punctuation stay fine — this is a title, not an identifier.
		expect(
			(await post('/api/playerevents/v2', { Name: "Bob's Big Night (2)!", RoomId: 3 })).status
		).toBe(200)

		// The update path enforces the same limits, and a refusal leaves the event alone.
		const event = await create({ Name: 'EditMe', RoomId: 3 })
		const tooLong = await post(`/api/playerevents/v2/${event.PlayerEventId}`, {
			Name: 'n'.repeat(65),
		})
		expect(tooLong.status).toBe(400)
		const after = await get(`/api/playerevents/v1/${event.PlayerEventId}`)
		expect(((await after.json()) as PlayerEvent).Name).toBe('EditMe')
	})

	test('the event writes cap the window at 24 hours', async () => {
		const window = (StartTime: string, EndTime: string) =>
			post('/api/playerevents/v2', { Name: 'Windowed', RoomId: 3, StartTime, EndTime })

		// A day exactly is allowed — "at most one day", not "under one day".
		expect((await window(at(0), at(DAY))).status).toBe(200)
		// A second past it is not.
		expect((await window(at(0), at(DAY + 1000))).status).toBe(400)
		expect((await window(at(0), at(30 * DAY))).status).toBe(400)

		// A missing end defaults to an hour after the start, so it can never fail…
		expect(
			(await post('/api/playerevents/v2', { Name: 'Open ended', RoomId: 3, StartTime: at(DAY) }))
				.status
		).toBe(200)
		// …but an end alone is measured from now, which can.
		expect(
			(await post('/api/playerevents/v2', { Name: 'Far end', RoomId: 3, EndTime: at(2 * DAY) }))
				.status
		).toBe(400)
		expect(
			(await post('/api/playerevents/v2', { Name: 'Near end', RoomId: 3, EndTime: at(HOUR) }))
				.status
		).toBe(200)
		// A body naming neither is defaulted, as before.
		expect((await post('/api/playerevents/v2', { Name: 'Untimed', RoomId: 3 })).status).toBe(200)

		// A backwards window is refused too — `end - start` on one running a month
		// backwards is negative, which would sail past a "no longer than a day" check.
		expect((await window(at(3 * HOUR), at(HOUR))).status).toBe(400)
	})

	test('the 24-hour cap is checked on the window a write RESOLVES to', async () => {
		const event = await create({
			RoomId: 3,
			Name: 'Movable',
			StartTime: at(5 * HOUR),
			EndTime: at(6 * HOUR),
		})
		const path = `/api/playerevents/v2/${event.PlayerEventId}`

		// Moving one bound is measured against the STORED other one, not against a default:
		// a start dragged two days back leaves a window far longer than a day.
		expect((await post(path, { StartTime: at(-2 * DAY) })).status).toBe(400)
		expect((await post(path, { EndTime: at(2 * DAY) })).status).toBe(400)
		// Both bounds moved together stay inside the cap, so this is fine.
		expect((await post(path, { StartTime: at(2 * DAY), EndTime: at(2 * DAY + HOUR) })).status).toBe(
			200
		)
		// An edit that says nothing about the times is unaffected.
		expect((await post(path, { Name: 'Still Movable' })).status).toBe(200)

		// …and a refusal left the event where it was.
		const stored = (await (
			await get(`/api/playerevents/v1/${event.PlayerEventId}`)
		).json()) as PlayerEvent
		expect(stored.StartTime).toBe(at(2 * DAY))
		expect(stored.EndTime).toBe(at(2 * DAY + HOUR))
	})

	test('POST /api/playerevents/v2 answers the write envelope, not the bare event', async () => {
		const res = await post('/api/playerevents/v2', {
			Name: 'Enveloped',
			RoomId: 3,
			tags: [{ tag: 'music', type: 0 }],
		})
		const body = (await res.json()) as PlayerEventResult
		expect(body.Result).toBe(0)
		expect(body.PlayerEvent.Name).toBe('Enveloped')
		// The tags ride inline on the event AND in TagModifyResult. Inline they take the
		// caller's build shape — this token names no build, so the 2023 `{ Tag, Type }` pairs
		// (PascalCase: not the lowercase pairs the v1 read's `tags` serves). TagModifyResult
		// is names to every build.
		expect(body.PlayerEvent.Tags).toEqual([{ Tag: 'music', Type: 0 }])
		expect(body.TagModifyResult).toEqual({ Result: 0, Tags: ['music'] })
		// No `State`, and the broadcast instance is present and null.
		expect(body.PlayerEvent).not.toHaveProperty('State')
		expect(body.PlayerEvent.BroadcastingRoomInstanceId).toBeNull()
	})

	test('the v2 envelope shapes PlayerEvent.Tags per the caller’s build', async () => {
		// Rec Room reshaped this field without minting a new path, so one endpoint owes two
		// shapes: the 2023 build parses `{ Tag, Type }` pairs, the 2025 build bare names.
		// Serving either to the wrong build empties the event's chips instead of erroring.
		// A tag of this test's own: the `#tag` search tests assert exact result sets, and the
		// four events below would join any set they share a tag with.
		const PAIRS = [{ Tag: 'buildversions', Type: 0 }]
		const NAMES = ['buildversions']

		const created = async (version?: string) => {
			const res = await exports.default.fetch(`${ORIGIN}/api/playerevents/v2`, {
				method: 'POST',
				headers: {
					...(await bearer('42', undefined, version)),
					'content-type': 'application/json',
				},
				body: JSON.stringify({ Name: 'Versioned', RoomId: 3, Tags: NAMES }),
			})
			expect(res.status).toBe(200)
			return (await res.json()) as PlayerEventResult
		}

		// Newer than 20230414 is the 2025 client; that build, an older one, and a token naming
		// no build at all are all the 2023 client. Builds are date-stamped, so they compare as
		// strings.
		expect((await created('20250718.01')).PlayerEvent.Tags).toEqual(NAMES)
		expect((await created('20230414')).PlayerEvent.Tags).toEqual(PAIRS)
		expect((await created('20220101')).PlayerEvent.Tags).toEqual(PAIRS)
		const legacy = await created()
		expect(legacy.PlayerEvent.Tags).toEqual(PAIRS)
		// Only the inline field moves: TagModifyResult carries names to both builds.
		expect(legacy.TagModifyResult).toEqual({ Result: 0, Tags: NAMES })

		// The gate is on the ENVELOPE, not on the create: the read and the field edits answer
		// the same shape, so a client that made an event and one opening it cold agree.
		const eventId = legacy.PlayerEvent.PlayerEventId
		const read = async (version?: string) =>
			(
				(await (
					await exports.default.fetch(`${ORIGIN}/api/playerevents/v2/${eventId}`, {
						headers: await bearer('42', undefined, version),
					})
				).json()) as PlayerEventResult
			).PlayerEvent.Tags
		expect(await read('20250718.01')).toEqual(NAMES)
		expect(await read()).toEqual(PAIRS)
	})

	test('GET /api/playerevents/v2/:eventId serves the same envelope as the write', async () => {
		const written = await post('/api/playerevents/v2', {
			Name: 'ReadBack',
			RoomId: 3,
			tags: [{ tag: 'music', type: 0 }],
		})
		const created = (await written.json()) as PlayerEventResult

		const res = await get(`/api/playerevents/v2/${created.PlayerEvent.PlayerEventId}`)
		expect(res.status).toBe(200)
		expect(await res.json()).toEqual(created)

		expect((await get('/api/playerevents/v2/9999999')).status).toBe(404)
	})

	test('POST /api/playerevents/v2 pushes a PlayerEventCreated notification to the creator', async () => {
		// The notify DO is stubbed to record its last notifyPlayer call (see vitest.config).
		const event = await create({
			RoomId: 58,
			Name: 'Open Mic',
			Description: 'come hang',
			StartTime: at(HOUR),
			EndTime: at(3 * HOUR),
		})
		const res = await env.RECFLARE_NOTIFICATIONS_HUB.getByName('global').fetch('http://do/last')
		const last = (await res.json()) as {
			playerId: number
			notificationType: number
			data: Record<string, unknown>
		}
		expect(last.playerId).toBe(42) // the creator
		expect(last.notificationType).toBe(80) // NotificationType.PlayerEventCreated

		// camelCase, unlike the PascalCase record the response carries; `tags` and
		// `broadcastingRoomInstanceId` don't exist on the record, and `State` is dropped.
		// The real hub strips the null values from the frame before it goes on the wire.
		expect(last.data).toEqual({
			tags: [],
			playerEventId: event.PlayerEventId,
			creatorPlayerId: 42,
			roomId: 58,
			subRoomId: null,
			clubId: null,
			name: 'Open Mic',
			description: 'come hang',
			imageName: '', // empty string, not the record's null
			startTime: `${event.StartTime.slice(0, -1)}.0000000Z`,
			endTime: `${event.EndTime.slice(0, -1)}.0000000Z`,
			attendeeCount: 1,
			accessibility: 1,
			isMultiInstance: false,
			supportMultiInstanceRoomChat: false,
			defaultBroadcastPermissions: 0,
			canRequestBroadcastPermissions: 0,
			broadcastingRoomInstanceId: null,
		})
		// Tick precision on the frame; the stored record keeps its bare form.
		expect(event.StartTime).toMatch(/:\d{2}Z$/)
	})

	test('POST /api/playerevents/v2 takes the creator from the token, not the body', async () => {
		const event = await create({ Name: 'Not Yours', RoomId: 3, CreatorPlayerId: 999 })
		expect(event.CreatorPlayerId).toBe(42)
	})

	test('POST /api/playerevents/v2 defaults an empty body rather than rejecting it', async () => {
		const event = await create({})
		expect(event).toMatchObject({
			Name: 'Untitled Event',
			Description: '',
			RoomId: 0,
			SubRoomId: null,
			ClubId: null,
			// The envelope's ImageName is a string: the record's null reads as "" here.
			ImageName: '',
			AttendeeCount: 1,
			Accessibility: 1,
			IsMultiInstance: false,
			SupportMultiInstanceRoomChat: false,
			DefaultBroadcastPermissions: 0,
			CanRequestBroadcastPermissions: 0,
		})
		// A start with no end runs for an hour.
		expect(Date.parse(event.EndTime) - Date.parse(event.StartTime)).toBe(HOUR)
	})

	test('GET /api/playerevents/v1/:eventId serves the bare event', async () => {
		const res = await get(`/api/playerevents/v1/${upcoming.PlayerEventId}`)
		expect(res.status).toBe(200)
		// No envelope here — unlike the writes — and the bare RECORD, which carries `State`
		// and neither `Tags` nor `BroadcastingRoomInstanceId`.
		const body = await res.json()
		expect(body).toEqual(asRecord(upcoming))
		expect(Object.hasOwn(body as object, 'Tags')).toBe(false)
		expect(Object.hasOwn(body as object, 'State')).toBe(true)

		expect((await get('/api/playerevents/v1/999999')).status).toBe(404)
	})

	test('GET /api/playerevents/v1/:eventId?includeDetails=True adds only `tags`', async () => {
		const path = `/api/playerevents/v1/${upcoming.PlayerEventId}`
		// The flag's whole effect: the lowercase `tags` — the `{ tag, type }` pairs, not the
		// envelope's names. This event carries none.
		expect(await (await get(`${path}?includeDetails=True`)).json()).toEqual({
			...asRecord(upcoming),
			tags: [],
		})
		// Accepted case-insensitively — the client sends `True`.
		expect(await (await get(`${path}?includeDetails=true`)).json()).toEqual({
			...asRecord(upcoming),
			tags: [],
		})
		// Anything else is the bare record, with no `tags` key at all.
		expect(await (await get(`${path}?includeDetails=False`)).json()).toEqual(asRecord(upcoming))
		expect(await (await get(path)).json()).toEqual(asRecord(upcoming))
	})

	test('GET /api/playerevents/v1/bulk answers in request order, skipping unknown ids', async () => {
		const res = await get(
			`/api/playerevents/v1/bulk?id=${clubEvent.PlayerEventId}&id=999999&id=${upcoming.PlayerEventId}`
		)
		expect(res.status).toBe(200)
		const events = (await res.json()) as PlayerEvent[]
		// Request order, not id order — and the missing id leaves no hole.
		expect(events.map((e) => e.PlayerEventId)).toEqual([
			clubEvent.PlayerEventId,
			upcoming.PlayerEventId,
		])

		// No ids is an empty list, not every event.
		expect(await (await get('/api/playerevents/v1/bulk')).json()).toEqual([])
	})

	test('GET /api/playerevents/v1/search matches name and description, skipping finished events', async () => {
		const search = async (qs: string): Promise<PlayerEvent[]> =>
			(await (await get(`/api/playerevents/v1/search${qs}`)).json()) as PlayerEvent[]

		// Every term has to match, across name OR description.
		expect((await search('?query=dungeons+escape')).map((e) => e.PlayerEventId)).toEqual([
			clubEvent.PlayerEventId,
		])
		// …matched case-insensitively, and against the description too.
		expect((await search('?query=upto%204%20players')).map((e) => e.PlayerEventId)).toEqual([
			clubEvent.PlayerEventId,
		])

		// `pastEvent` matches on name but has already ended, so the browse query drops it.
		const trig = await search('?query=trigonometry')
		expect(trig.map((e) => e.PlayerEventId)).toEqual([upcoming.PlayerEventId])
		expect(trig.map((e) => e.PlayerEventId)).not.toContain(pastEvent.PlayerEventId)

		// Soonest first, and take/skip page through that order.
		const all = await search('')
		const starts = all.map((e) => e.StartTime)
		expect([...starts].sort()).toEqual(starts)
		expect(await search('?take=1')).toEqual([all[0]])
		expect(await search('?skip=1&take=1')).toEqual([all[1]])
	})

	test('GET /api/playerevents/v1 serves the browse feed as listings', async () => {
		const res = await get('/api/playerevents/v1')
		expect(res.status).toBe(200)
		const feed = (await res.json()) as Array<PlayerEvent & { BroadcastingRoomInstanceId: null }>

		// Upcoming and live, soonest first; what has already ended is left out.
		const ids = feed.map((e) => e.PlayerEventId)
		expect(ids).toContain(upcoming.PlayerEventId)
		expect(ids).toContain(liveEvent.PlayerEventId)
		expect(ids).not.toContain(pastEvent.PlayerEventId)
		const starts = feed.map((e) => e.StartTime)
		expect([...starts].sort()).toEqual(starts)

		// The listing projection — no `State`, and a null broadcasting instance — not the
		// stored record the by-id read serves.
		const entry = feed.find((e) => e.PlayerEventId === upcoming.PlayerEventId)!
		expect(entry).toEqual({
			...asRecord(upcoming),
			State: undefined,
			BroadcastingRoomInstanceId: null,
		})

		// The base event, exactly: the v2 envelope's event minus `Tags`, 17 keys.
		expect(Object.keys(entry).sort()).toEqual(
			Object.keys(upcoming)
				.filter((k) => k !== 'Tags')
				.sort()
		)
		expect(Object.keys(entry)).toHaveLength(17)

		// An event with no image serves `""` here, not the record's null.
		const imageless = await create({ RoomId: 3, Name: 'No Banner', StartTime: at(HOUR) })
		const withoutImage = (
			(await (await get('/api/playerevents/v1?take=50')).json()) as Array<{
				PlayerEventId: number
				ImageName: string
			}>
		).find((e) => e.PlayerEventId === imageless.PlayerEventId)!
		expect(withoutImage.ImageName).toBe('')
		expect(Object.hasOwn(entry, 'State')).toBe(false)

		// Paged like the other feeds.
		expect(await (await get('/api/playerevents/v1?take=1')).json()).toEqual([feed[0]])
		expect(await (await get('/api/playerevents/v1?skip=1&take=1')).json()).toEqual([feed[1]])
	})

	test('GET /api/playerevents/v1/search matches `#tag` terms against tags, not text', async () => {
		const search = async (qs: string): Promise<PlayerEvent[]> =>
			(await (await get(`/api/playerevents/v1/search${qs}`)).json()) as PlayerEvent[]

		// Two tagged events, one of which only MENTIONS the word in its description.
		const tagged = await create({
			RoomId: 3,
			Name: 'Sawdust Session',
			StartTime: at(HOUR),
			// Both forms in circulation: a bare name and the `{ tag, type }` pair.
			Tags: ['#Workshops', { tag: 'meetup', type: 2 }],
		})
		const textOnly = await create({
			RoomId: 3,
			Name: 'Talking About Workshops',
			Description: 'we discuss workshops, untagged',
			StartTime: at(HOUR),
		})

		// `#workshops` is the tag alone — the untagged event that says "workshops" twice
		// doesn't match.
		const byTag = await search('?query=%23workshops&sort=StartTime')
		expect(byTag.map((e) => e.PlayerEventId)).toEqual([tagged.PlayerEventId])
		// …and the bare word is the mirror image: a text search, which finds the event that
		// says "workshops" and NOT the one merely tagged with it.
		const byText = await search('?query=workshops')
		expect(byText.map((e) => e.PlayerEventId)).toEqual([textOnly.PlayerEventId])

		// Tag terms combine with text terms, and with each other (every one must match).
		expect((await search('?query=%23workshops+sawdust')).map((e) => e.PlayerEventId)).toEqual([
			tagged.PlayerEventId,
		])
		expect(await search('?query=%23workshops+%23meetup')).toHaveLength(1)
		expect(await search('?query=%23workshops+%23celebration')).toEqual([])
		expect(await search('?query=%23nosuchtag')).toEqual([])

		// The tags are what `includeDetails` serves — lowercased, `#` stripped, and the
		// type kept (defaulting to 0 for the bare-string form).
		const details = (await (
			await get(`/api/playerevents/v1/${tagged.PlayerEventId}?includeDetails=True`)
		).json()) as { tags: Array<{ tag: string; type: number }> }
		expect(details.tags).toEqual([
			{ tag: 'meetup', type: 2 },
			{ tag: 'workshops', type: 0 },
		])
		// …and they are NOT on the plain record, which every other read serves verbatim.
		expect(
			await (await get(`/api/playerevents/v1/${tagged.PlayerEventId}`)).json()
		).not.toHaveProperty('tags')

		// An update REPLACES the set; a body that says nothing about tags leaves it alone.
		await post(`/api/playerevents/v2/${tagged.PlayerEventId}`, { Tags: ['celebration'] })
		expect((await search('?query=%23celebration')).map((e) => e.PlayerEventId)).toEqual([
			tagged.PlayerEventId,
		])
		expect(await search('?query=%23workshops')).toEqual([])
		await post(`/api/playerevents/v2/${tagged.PlayerEventId}`, { Name: 'Sawdust Session II' })
		expect((await search('?query=%23celebration')).map((e) => e.PlayerEventId)).toEqual([
			tagged.PlayerEventId,
		])
		// An explicit empty list does clear them.
		await post(`/api/playerevents/v2/${tagged.PlayerEventId}`, { Tags: [] })
		expect(await search('?query=%23celebration')).toEqual([])
	})

	test('GET /api/playerevents/v1/searchlive serves what is running right now', async () => {
		const res = await get('/api/playerevents/v1/searchlive')
		expect(res.status).toBe(200)
		const ids = ((await res.json()) as PlayerEvent[]).map((e) => e.PlayerEventId)
		expect(ids).toContain(liveEvent.PlayerEventId)
		// Started in an hour / finished already — neither is live.
		expect(ids).not.toContain(upcoming.PlayerEventId)
		expect(ids).not.toContain(pastEvent.PlayerEventId)
	})

	test('GET /api/playerevents/v1/room/:roomId serves that room’s current and upcoming events', async () => {
		// A room of this test's own, so events other tests create can't drift into the shelf.
		const soon = await create({
			RoomId: 12,
			Name: 'Room 12 Soon',
			StartTime: at(2 * HOUR),
			EndTime: at(3 * HOUR),
		})
		const running = await create({
			RoomId: 12,
			Name: 'Room 12 Running',
			StartTime: at(-HOUR),
			EndTime: at(HOUR),
		})
		const finished = await create({
			RoomId: 12,
			Name: 'Room 12 Finished',
			StartTime: at(-3 * HOUR),
			EndTime: at(-2 * HOUR),
		})
		const elsewhere = await create({
			RoomId: 13,
			Name: 'Room 13 Soon',
			StartTime: at(HOUR),
			EndTime: at(2 * HOUR),
		})

		const res = await get('/api/playerevents/v1/room/12')
		expect(res.status).toBe(200)
		const events = (await res.json()) as PlayerEvent[]

		// Soonest first, and RUNNING counts as current: the filter is on the end time, so an
		// event stays on the shelf until it is over rather than vanishing when it starts.
		expect(events.map((e) => e.PlayerEventId)).toEqual([running.PlayerEventId, soon.PlayerEventId])
		// A finished event is dropped — the shelf answers what you can still turn up to — and
		// another room's event is not this room's business.
		expect(events.map((e) => e.PlayerEventId)).not.toContain(finished.PlayerEventId)
		expect(events.map((e) => e.PlayerEventId)).not.toContain(elsewhere.PlayerEventId)

		// A bare array of the STORED record, like `/searchlive` and the multi-club shelf —
		// not the base projection the browse feed serves, and not the single-club envelope.
		expect(events[0]).toEqual(asRecord(running, null))

		// A room with nothing scheduled, and a room id nothing knows about, are both empty.
		expect(await (await get('/api/playerevents/v1/room/999999')).json()).toEqual([])
	})

	test('GET /api/playerevents/v1/clubs is a bare array; /club/:id is a paged envelope', async () => {
		// The client deserializes the multi-club form as a list — an envelope here fails
		// with "expected:'[', actual:'{'". Do not unify the two.
		const many = await get('/api/playerevents/v1/clubs?id=7&id=8')
		expect(many.status).toBe(200)
		const events = (await many.json()) as PlayerEvent[]
		expect(events.map((e) => e.PlayerEventId)).toEqual([
			liveEvent.PlayerEventId, // started an hour ago — soonest first
			clubEvent.PlayerEventId,
		])

		// The single-club form does wrap its events with a paging cursor.
		const one = await get('/api/playerevents/v1/club/7')
		expect(one.status).toBe(200)
		expect(await one.json()).toEqual({ ContinuationToken: '', Events: events })

		// A club with no events, and the no-ids case.
		expect(await (await get('/api/playerevents/v1/club/8')).json()).toEqual({
			ContinuationToken: '',
			Events: [],
		})
		expect(await (await get('/api/playerevents/v1/clubs')).json()).toEqual([])
	})

	test('GET /api/playerevents/v1/all lists the caller’s own events, auth-gated', async () => {
		expect((await get('/api/playerevents/v1/all')).status).toBe(401)

		const mine = (await (await get('/api/playerevents/v1/all', '42')).json()) as {
			Created: PlayerEvent[]
			Responses: unknown[]
		}
		const ids = mine.Created.map((e) => e.PlayerEventId)
		expect(ids).toContain(upcoming.PlayerEventId)
		// 43 created that one, not 42.
		expect(ids).not.toContain(liveEvent.PlayerEventId)
		// Finished events stay in the creator's own list — only the browse queries drop them.
		expect(ids).toContain(pastEvent.PlayerEventId)
		// Nothing records an RSVP yet.
		expect(mine.Responses).toEqual([])

		const theirs = (await (await get('/api/playerevents/v1/all', '43')).json()) as {
			Created: PlayerEvent[]
		}
		expect(theirs.Created.map((e) => e.PlayerEventId)).toEqual([liveEvent.PlayerEventId])
	})

	test('POST /api/playerevents/v1/respond records an RSVP and recounts attendees', async () => {
		const respond = async (body: unknown, sub = '42'): Promise<Response> =>
			post('/api/playerevents/v1/respond', body, sub)

		const event = await create({ RoomId: 3, Name: 'RSVP Test', StartTime: at(HOUR) })
		const id = event.PlayerEventId
		// The creator is Going from create, which is where the initial 1 comes from.
		expect(event.AttendeeCount).toBe(1)
		expect(await countGoing(env.DB, id)).toBe(1)

		// 43 says Going → 2 attendees, and the envelope carries the updated event.
		const res = await respond({ PlayerEventId: id, Type: 0 }, '43')
		expect(res.status).toBe(200)
		const body = (await res.json()) as PlayerEventResult
		expect(body.Result).toBe(0)
		expect(body.PlayerEvent.AttendeeCount).toBe(2)
		expect(await getEventResponse(env.DB, id, 43)).toMatchObject({
			event_id: id,
			player_id: 43,
			status: 0,
		})

		// Changing the answer REPLACES it — one row per player, not a second RSVP.
		const changed = await respond({ PlayerEventId: id, Type: 2 }, '43')
		expect(((await changed.json()) as PlayerEventResult).PlayerEvent.AttendeeCount).toBe(1)
		expect(await getEventResponse(env.DB, id, 43)).toMatchObject({ player_id: 43, status: 2 })
		expect((await getEventAttendees(env.DB, id)).map((a) => a.player_id)).toEqual([42, 43])

		// Interested is a maybe — recorded, but not counted.
		await respond({ PlayerEventId: id, Type: 1 }, '43')
		expect(await countGoing(env.DB, id)).toBe(1)

		// And the count sticks on the stored event, not just the response.
		const fetched = (await (await get(`/api/playerevents/v1/${id}`)).json()) as PlayerEvent
		expect(fetched.AttendeeCount).toBe(1)
	})

	test('GET /api/playerevents/v1/:eventId/responses lists every RSVP, one per player', async () => {
		const event = await create({ RoomId: 3, Name: 'Guest List', StartTime: at(HOUR) })
		const id = event.PlayerEventId
		const responses = async (): Promise<
			Array<{
				PlayerEventResponseId: number
				PlayerEventId: number
				PlayerId: number
				CreatedAt: string
				Type: number
			}>
		> => (await (await get(`/api/playerevents/v1/${id}/responses`)).json()) as never

		// The creator's own Going row, from create.
		const initial = await responses()
		expect(initial).toEqual([
			{
				PlayerEventResponseId: expect.any(Number),
				PlayerEventId: id,
				PlayerId: 42,
				CreatedAt: expect.stringMatching(/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\dZ$/),
				Type: 0,
			},
		])

		// Declines and maybes are listed too — not just what AttendeeCount counts.
		await post('/api/playerevents/v1/respond', { PlayerEventId: id, Type: 2 }, '43')
		const withDecline = await responses()
		expect(withDecline.map((r) => [r.PlayerId, r.Type])).toEqual([
			[42, 0],
			[43, 2],
		])

		// Changing an answer updates the row in place: same id, new Type — never a second
		// entry for the player.
		await post('/api/playerevents/v1/respond', { PlayerEventId: id, Type: 1 }, '43')
		const changed = await responses()
		expect(changed).toHaveLength(2)
		expect(changed[1]!.PlayerEventResponseId).toBe(withDecline[1]!.PlayerEventResponseId)
		expect(changed[1]!.Type).toBe(1)

		// An unknown event is an empty list, not a 404 — like the other list reads.
		const unknown = await get('/api/playerevents/v1/999999/responses')
		expect(unknown.status).toBe(200)
		expect(await unknown.json()).toEqual([])
	})

	test('POST /api/playerevents/v1/respond rejects a bad body, an unknown event and no token', async () => {
		const event = await create({ RoomId: 3, Name: 'Guarded' })

		expect(
			(
				await exports.default.fetch(`${ORIGIN}/api/playerevents/v1/respond`, {
					method: 'POST',
					body: JSON.stringify({ PlayerEventId: event.PlayerEventId, Type: 0 }),
				})
			).status
		).toBe(401)

		// An unrecognized Type is rejected rather than defaulted — stored as Going it
		// would silently inflate the count.
		expect((await post('/api/playerevents/v1/respond', { PlayerEventId: 1, Type: 7 })).status).toBe(
			400
		)
		expect((await post('/api/playerevents/v1/respond', { Type: 0 })).status).toBe(400)
		expect((await post('/api/playerevents/v1/respond', {})).status).toBe(400)
		expect(
			(await post('/api/playerevents/v1/respond', { PlayerEventId: 999999, Type: 0 })).status
		).toBe(404)
	})

	test('POST /api/playerevents/v1/report files a report row against the event', async () => {
		const event = await create({ RoomId: 58, Name: 'Reportable', StartTime: at(HOUR) }, '43')

		const res = await post(
			'/api/playerevents/v1/report',
			{ ReportCategory: 101, PlayerEventId: event.PlayerEventId, Details: 'bad event' },
			'42'
		)
		expect(res.status).toBe(200)
		expect(await res.json()).toEqual({ success: true, error: '' })

		// One row in the shared report table, marked as an event report by `event_id` —
		// with the reported player and the room filled in FROM the event, not the body.
		const row = await env.DB.prepare('SELECT * FROM report WHERE event_id = ?1')
			.bind(event.PlayerEventId)
			.first<Record<string, unknown>>()
		expect(row).toMatchObject({
			reporter_player_id: 42,
			reported_player_id: 43, // the event's creator
			report_category: 101,
			details: 'bad event',
			room_id: 58,
			event_id: event.PlayerEventId,
			banned: 0, // filed unbanned, like any report
		})

		// A body with no usable event id, and one naming an event that doesn't exist —
		// both answer the same envelope shape as the success branch.
		expect(await (await post('/api/playerevents/v1/report', { Details: 'x' })).json()).toEqual({
			success: false,
			error: 'PlayerEventId is required',
		})
		const unknown = await post('/api/playerevents/v1/report', { PlayerEventId: 999999 })
		expect(unknown.status).toBe(404)
		expect(await unknown.json()).toEqual({ success: false, error: 'No such event' })

		// Auth-gated: the reporter comes from the token, so there's no filing one signed out.
		expect(
			(
				await exports.default.fetch(`${ORIGIN}/api/playerevents/v1/report`, {
					method: 'POST',
					body: JSON.stringify({ PlayerEventId: event.PlayerEventId }),
				})
			).status
		).toBe(401)
	})

	test('POST /api/playerevents/v1/bulkInvite adds invitees as Going without overwriting answers', async () => {
		const event = await create({ RoomId: 3, Name: 'Invite Test', StartTime: at(HOUR) })
		const id = event.PlayerEventId

		// 43 declines BEFORE being invited — the invite must not flip that back.
		await post('/api/playerevents/v1/respond', { PlayerEventId: id, Type: 2 }, '43')

		const res = await post(
			'/api/playerevents/v1/bulkInvite',
			// 42 is the caller (already on the event) and 187 is repeated — both are skipped.
			{ PlayerEventId: id, InvitedPlayerIds: [187, 2, 187, 42, 43] },
			'42'
		)
		expect(res.status).toBe(200)
		const body = (await res.json()) as PlayerEventResult
		expect(body.Result).toBe(0)
		// The creator plus the two newly invited — 43 keeps their decline, so isn't counted.
		expect(body.PlayerEvent.AttendeeCount).toBe(3)

		const responses = (await (await get(`/api/playerevents/v1/${id}/responses`)).json()) as Array<{
			PlayerId: number
			Type: number
		}>
		expect(
			responses.sort((a, b) => a.PlayerId - b.PlayerId).map((r) => [r.PlayerId, r.Type])
		).toEqual([
			[2, 0],
			[42, 0],
			[43, 2],
			[187, 0],
		])

		// Re-inviting is a no-op, not a reset: 43 still declines and the count holds.
		const again = await post(
			'/api/playerevents/v1/bulkInvite',
			{ PlayerEventId: id, InvitedPlayerIds: [187, 43] },
			'42'
		)
		expect(((await again.json()) as PlayerEventResult).PlayerEvent.AttendeeCount).toBe(3)

		// An empty list is a no-op that still answers the event.
		const none = await post('/api/playerevents/v1/bulkInvite', {
			PlayerEventId: id,
			InvitedPlayerIds: [],
		})
		expect(((await none.json()) as PlayerEventResult).PlayerEvent.AttendeeCount).toBe(3)
	})

	test('POST /api/playerevents/v1/bulkInvite notifies only the players it actually added', async () => {
		const hub = env.RECFLARE_NOTIFICATIONS_HUB.getByName('global')
		const event = await create({ RoomId: 3, Name: 'Invite Frames', StartTime: at(HOUR) })
		const id = event.PlayerEventId
		// 43 answers first, so the invite leaves them alone — and must not notify them.
		await post('/api/playerevents/v1/respond', { PlayerEventId: id, Type: 1 }, '43')

		await hub.fetch('http://do/all', { method: 'DELETE' })
		await post('/api/playerevents/v1/bulkInvite', { PlayerEventId: id, InvitedPlayerIds: [2, 43] })
		const sent = (await (await hub.fetch('http://do/all')).json()) as Array<{
			playerId: number
			notificationType: number
			data: Record<string, Record<string, unknown>>
		}>

		// One frame, to the one player who gained a row. 43 kept their answer, so nothing
		// changed for them and nothing is pushed.
		expect(sent).toHaveLength(1)
		expect(sent[0]!.playerId).toBe(2)
		expect(sent[0]!.notificationType).toBe(83) // PlayerEventResponseChanged

		// BOTH nested objects are present — the client dereferences them without a null
		// guard, so a missing one is a NullReferenceException rather than a blank field.
		expect(sent[0]!.data.PlayerEvent).toMatchObject({
			playerEventId: id,
			name: 'Invite Frames',
			attendeeCount: 2,
		})
		expect(sent[0]!.data.PlayerEventResponse).toEqual({
			PlayerEventResponseId: expect.any(Number),
			PlayerEventId: id,
			PlayerId: 2,
			CreatedAt: expect.stringMatching(/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\dZ$/),
			Type: 0,
		})
	})

	test('POST /api/playerevents/v1/bulkInvite is gated on the caller being on the event', async () => {
		const event = await create({ RoomId: 3, Name: 'Invite Gate', StartTime: at(HOUR) })
		const id = event.PlayerEventId
		const invite = async (body: unknown, sub = '42'): Promise<Response> =>
			post('/api/playerevents/v1/bulkInvite', body, sub)

		expect(
			(
				await exports.default.fetch(`${ORIGIN}/api/playerevents/v1/bulkInvite`, {
					method: 'POST',
					body: JSON.stringify({ PlayerEventId: id, InvitedPlayerIds: [2] }),
				})
			).status
		).toBe(401)

		// 44 has no response row on this event — not theirs to invite to.
		expect((await invite({ PlayerEventId: id, InvitedPlayerIds: [2] }, '44')).status).toBe(403)
		// …until they respond, which puts them on it.
		await post('/api/playerevents/v1/respond', { PlayerEventId: id, Type: 1 }, '44')
		expect((await invite({ PlayerEventId: id, InvitedPlayerIds: [2] }, '44')).status).toBe(200)

		expect((await invite({ PlayerEventId: 999999, InvitedPlayerIds: [2] })).status).toBe(404)
		expect((await invite({ InvitedPlayerIds: [2] })).status).toBe(400)
		expect((await invite({ PlayerEventId: id })).status).toBe(400)
		expect((await invite({})).status).toBe(400)
	})

	test('POST /api/playerevents/v2/:eventId edits only what the body carries, creator-only', async () => {
		const event = await create({
			RoomId: 5,
			SubRoomId: 6,
			ClubId: 9,
			Name: 'Original',
			Description: 'Original description',
			StartTime: at(5 * HOUR),
			EndTime: at(6 * HOUR),
		})
		const path = `/api/playerevents/v2/${event.PlayerEventId}`

		expect(
			(await exports.default.fetch(`${ORIGIN}${path}`, { method: 'POST', body: '{}' })).status
		).toBe(401)
		// 43 didn't create it.
		expect((await post(path, { Name: 'Hijacked' }, '43')).status).toBe(403)
		expect((await post('/api/playerevents/v2/999999', { Name: 'Nope' })).status).toBe(404)

		const res = await post(path, { Name: 'Renamed' })
		expect(res.status).toBe(200)
		const body = (await res.json()) as PlayerEventResult
		expect(body.Result).toBe(0)
		// Only the name moved; a partial post can't blank out the rest.
		expect(body.PlayerEvent).toEqual({ ...event, Name: 'Renamed' })

		// And it stuck — read back as the bare record, which the envelope's event is not.
		expect(await (await get(`/api/playerevents/v1/${event.PlayerEventId}`)).json()).toEqual(
			asRecord(body.PlayerEvent, null)
		)
	})

	test('POST /api/playerevents/v2/:eventId clears a nullable id when the body sends null', async () => {
		const event = await create({ RoomId: 5, SubRoomId: 6, ClubId: 9, Name: 'Clearable' })
		const res = await post(`/api/playerevents/v2/${event.PlayerEventId}`, {
			// Nested form again, and an explicit null — absent leaves the value alone,
			// null genuinely clears it.
			PlayerEvent: { ClubId: null, ImageName: null },
		})
		const updated = ((await res.json()) as PlayerEventResult).PlayerEvent
		expect(updated.ClubId).toBeNull()
		// Cleared on the record, which the envelope reports as "" — its ImageName is a string.
		expect(updated.ImageName).toBe('')
		expect(
			((await (await get(`/api/playerevents/v1/${event.PlayerEventId}`)).json()) as PlayerEvent)
				.ImageName
		).toBeNull()
		expect(updated.SubRoomId).toBe(6)
	})

	test('POST /api/playerevents/v2/delete/:eventId removes the event, its RSVPs and its tags', async () => {
		const event = await create({
			RoomId: 3,
			Name: 'Cancelled',
			StartTime: at(HOUR),
			Tags: [{ tag: 'meetup', type: 2 }],
		})
		const eventId = event.PlayerEventId
		// Someone else RSVPs, so there is more than the creator's own row to clean up.
		await post('/api/playerevents/v1/respond', { PlayerEventId: eventId, Type: 1 }, '43')

		const rows = async (table: string) =>
			(
				await env.DB.prepare(`SELECT COUNT(*) AS n FROM ${table} WHERE event_id = ?1`)
					.bind(eventId)
					.first<{ n: number }>()
			)?.n
		expect(await rows('event_attendee')).toBe(2)
		expect(await rows('event_tag')).toBe(1)

		// Auth-gated, and creator-only.
		expect(
			(
				await exports.default.fetch(`${ORIGIN}/api/playerevents/v2/delete/${eventId}`, {
					method: 'POST',
				})
			).status
		).toBe(401)
		expect((await post(`/api/playerevents/v2/delete/${eventId}`, {}, '43')).status).toBe(403)
		expect((await post('/api/playerevents/v2/delete/999999', {})).status).toBe(404)

		const res = await post(`/api/playerevents/v2/delete/${eventId}`, {})
		expect(res.status).toBe(200)
		// Both payload fields are null: the event is gone, so the envelope reports only that
		// the delete succeeded. NOT the shape the other v2 routes answer with.
		expect(await res.json()).toEqual({ PlayerEvent: null, Result: 0, TagModifyResult: null })

		// Gone, and nothing left hanging off it: orphan RSVPs would keep being counted and
		// orphan tags would keep answering `#tag` searches.
		expect((await get(`/api/playerevents/v1/${eventId}`)).status).toBe(404)
		expect(await rows('event_attendee')).toBe(0)
		expect(await rows('event_tag')).toBe(0)
	})

	test('DELETE /api/playerevents/v2/delete/:eventId works too', async () => {
		// The path names the verb, but a client reaching for the HTTP one is right as well.
		const event = await create({ RoomId: 3, Name: 'Also Cancelled', StartTime: at(HOUR) })
		const res = await exports.default.fetch(
			`${ORIGIN}/api/playerevents/v2/delete/${event.PlayerEventId}`,
			{ method: 'DELETE', headers: await bearer('42') }
		)
		expect(res.status).toBe(200)
		expect((await get(`/api/playerevents/v1/${event.PlayerEventId}`)).status).toBe(404)
	})

	test('POST /api/playerevents/v2/:eventId cannot move ownership or the attendee count', async () => {
		const event = await create({ RoomId: 5, Name: 'Fixed' })
		const res = await post(`/api/playerevents/v2/${event.PlayerEventId}`, {
			PlayerEventId: 424242,
			CreatorPlayerId: 43,
			AttendeeCount: 500,
		})
		const updated = ((await res.json()) as PlayerEventResult).PlayerEvent
		expect(updated.PlayerEventId).toBe(event.PlayerEventId)
		expect(updated.CreatorPlayerId).toBe(42)
		expect(updated.AttendeeCount).toBe(1)
	})

	// ---- Single-field edits (PUT …/v2/:eventId/:field) -----------------------

	/** A form-encoded single-field edit — the encoding the client sends on these. */
	const putForm = async (
		path: string,
		fields: Record<string, string>,
		sub: string | null = '42'
	): Promise<Response> =>
		exports.default.fetch(`${ORIGIN}${path}`, {
			method: 'PUT',
			headers: {
				...(sub === null ? {} : await bearer(sub)),
				'content-type': 'application/x-www-form-urlencoded',
			},
			body: new URLSearchParams(fields).toString(),
		})

	const putJson = async (path: string, body: unknown, sub = '42'): Promise<Response> =>
		exports.default.fetch(`${ORIGIN}${path}`, {
			method: 'PUT',
			headers: { ...(await bearer(sub)), 'content-type': 'application/json' },
			body: JSON.stringify(body),
		})

	/** The envelope's event out of a 200 from one of the edits. */
	const edited = async (res: Response): Promise<PlayerEventEnvelope> => {
		expect(res.status).toBe(200)
		const body = (await res.json()) as PlayerEventResult
		expect(body.Result).toBe(0)
		return body.PlayerEvent
	}

	test('PUT /api/playerevents/v2/:eventId/time moves either bound independently', async () => {
		const event = await create({
			RoomId: 5,
			Name: 'Reschedulable',
			StartTime: at(5 * HOUR),
			EndTime: at(6 * HOUR),
		})
		const path = `/api/playerevents/v2/${event.PlayerEventId}/time`

		// The client sends .NET tick precision; it is stored trimmed to seconds.
		const moved = await edited(
			await putForm(path, {
				startTime: at(7 * HOUR).replace('Z', '.0000000Z'),
				endTime: at(9 * HOUR).replace('Z', '.0000000Z'),
			})
		)
		expect(moved).toEqual({ ...event, StartTime: at(7 * HOUR), EndTime: at(9 * HOUR) })

		// One bound alone keeps the other.
		const nudged = await edited(await putForm(path, { endTime: at(10 * HOUR) }))
		expect(nudged.StartTime).toBe(at(7 * HOUR))
		expect(nudged.EndTime).toBe(at(10 * HOUR))

		// A day exactly is allowed — the cap is "at most a day", not "under a day".
		const full = await edited(await putForm(path, { endTime: at(7 * HOUR + DAY) }))
		expect(full.EndTime).toBe(at(7 * HOUR + DAY))
	})

	test('PUT /api/playerevents/v2/:eventId/time refuses rubbish and a backwards window', async () => {
		const event = await create({
			RoomId: 5,
			Name: 'Fixed Window',
			StartTime: at(5 * HOUR),
			EndTime: at(6 * HOUR),
		})
		const path = `/api/playerevents/v2/${event.PlayerEventId}/time`

		// Present but unparseable is refused rather than dropped: a reschedule that
		// silently did nothing is worse than a refusal.
		expect((await putForm(path, { startTime: 'tomorrowish' })).status).toBe(400)
		// An end before the start, checked against the STORED bound when only one is sent.
		expect((await putForm(path, { endTime: at(4 * HOUR) })).status).toBe(400)
		expect((await putForm(path, { startTime: at(9 * HOUR), endTime: at(8 * HOUR) })).status).toBe(
			400
		)
		// And a window longer than a day, resolved the same way.
		expect((await putForm(path, { endTime: at(5 * HOUR + DAY + 1000) })).status).toBe(400)
		expect((await putForm(path, { startTime: at(-DAY) })).status).toBe(400)
		expect(
			(await putForm(path, { startTime: at(2 * DAY), endTime: at(2 * DAY + DAY + 1000) })).status
		).toBe(400)
		// An empty body changes nothing, and is not an error.
		expect((await edited(await putForm(path, {}))).StartTime).toBe(at(5 * HOUR))
		// …and nothing stuck.
		const stored = (await (
			await get(`/api/playerevents/v1/${event.PlayerEventId}`)
		).json()) as PlayerEvent
		expect(stored.EndTime).toBe(at(6 * HOUR))
	})

	test('PUT /api/playerevents/v2/:eventId/accessibility takes the enum name', async () => {
		const event = await create({ RoomId: 5, Name: 'Visible', Accessibility: 1 })
		const path = `/api/playerevents/v2/${event.PlayerEventId}/accessibility`

		// The NAME is what the client sends here.
		expect((await edited(await putForm(path, { accessibility: 'Unlisted' }))).Accessibility).toBe(2)
		// Case-insensitively…
		expect((await edited(await putForm(path, { accessibility: 'private' }))).Accessibility).toBe(0)
		// …and the ordinal works too.
		expect((await edited(await putForm(path, { accessibility: '4' }))).Accessibility).toBe(4)

		// Anything else is refused rather than stored verbatim — guessing a visibility
		// wrong is what shows a private event to everyone.
		expect((await putForm(path, { accessibility: 'Secret' })).status).toBe(400)
		expect((await putForm(path, { accessibility: '9' })).status).toBe(400)
		expect((await putForm(path, {})).status).toBe(400)
		expect(
			((await (await get(`/api/playerevents/v1/${event.PlayerEventId}`)).json()) as PlayerEvent)
				.Accessibility
		).toBe(4)
	})

	test('PUT /api/playerevents/v2/:eventId/tags replaces the whole set from a bare array', async () => {
		const event = await create({ RoomId: 5, Name: 'Taggable', Tags: ['meetup'] })
		const path = `/api/playerevents/v2/${event.PlayerEventId}/tags`

		// A bare JSON array, not an object — and a replace, not a merge, so `meetup` goes.
		const tagged = await edited(await putJson(path, ['tag1', '#Class']))
		expect(tagged.Tags).toEqual([
			{ Tag: 'class', Type: 0 },
			{ Tag: 'tag1', Type: 0 },
		])
		// The envelope's TagModifyResult reports the same set the client redraws chips from.
		const body = (await (await putJson(path, ['workshops'])).json()) as PlayerEventResult
		expect(body.TagModifyResult).toEqual({ Result: 0, Tags: ['workshops'] })

		// `[]` clears them; a non-array body is refused.
		expect((await edited(await putJson(path, []))).Tags).toEqual([])
		expect((await putJson(path, { Tags: ['nope'] })).status).toBe(400)
		expect(
			(
				(await (
					await get(`/api/playerevents/v1/${event.PlayerEventId}?includeDetails=True`)
				).json()) as PlayerEvent & { tags: EventTag[] }
			).tags
		).toEqual([])
	})

	test('PUT /api/playerevents/v2/:eventId/description rewrites the blurb; absent clears it', async () => {
		const event = await create({ RoomId: 5, Name: 'Described', Description: 'The old blurb' })
		const path = `/api/playerevents/v2/${event.PlayerEventId}/description`

		const written = await edited(
			await putForm(path, { description: 'fthe description of said event' })
		)
		expect(written).toEqual({ ...event, Description: 'fthe description of said event' })

		// An emptied text box sends no field at all, which clears it.
		expect((await edited(await putForm(path, {}))).Description).toBe('')

		// Capped at the stored length, and refused rather than truncated.
		expect((await putForm(path, { description: 'd'.repeat(513) })).status).toBe(400)
		expect((await putForm(path, { description: 'd'.repeat(512) })).status).toBe(200)
	})

	test('PUT /api/playerevents/v2/:eventId/name retitles, refusing a blank or overlong one', async () => {
		const event = await create({ RoomId: 5, Name: 'Before' })
		const path = `/api/playerevents/v2/${event.PlayerEventId}/name`

		const renamed = await edited(
			await putForm(path, { name: 'an event in the future I should be able to editx' })
		)
		expect(renamed).toEqual({
			...event,
			Name: 'an event in the future I should be able to editx',
		})
		// Stored trimmed.
		expect((await edited(await putForm(path, { name: '  Padded  ' }))).Name).toBe('Padded')

		// A blank name renders as a blank row, and the whole-event update reads one as
		// "leave it alone" — so it is refused outright here.
		expect((await putForm(path, { name: '   ' })).status).toBe(400)
		expect((await putForm(path, {})).status).toBe(400)
		expect((await putForm(path, { name: 'n'.repeat(65) })).status).toBe(400)
		expect((await putForm(path, { name: 'n'.repeat(64) })).status).toBe(200)
	})

	test('the single-field edits are creator-only, like the whole-event update', async () => {
		const event = await create({ RoomId: 5, Name: 'Guarded' })
		const id = event.PlayerEventId
		for (const [field, fields] of [
			['time', { startTime: at(8 * HOUR) }],
			['accessibility', { accessibility: 'Public' }],
			['description', { description: 'nope' }],
			['name', { name: 'Hijacked' }],
		] as Array<[string, Record<string, string>]>) {
			expect((await putForm(`/api/playerevents/v2/${id}/${field}`, fields, null)).status).toBe(401)
			// 43 didn't create it.
			expect((await putForm(`/api/playerevents/v2/${id}/${field}`, fields, '43')).status).toBe(403)
			expect((await putForm(`/api/playerevents/v2/999999/${field}`, fields)).status).toBe(404)
		}
		// The tags edit takes JSON rather than a form, but is gated the same way.
		expect((await putJson(`/api/playerevents/v2/${id}/tags`, ['nope'], '43')).status).toBe(403)
		expect((await putJson('/api/playerevents/v2/999999/tags', ['nope'])).status).toBe(404)

		// Nothing moved.
		expect(await (await get(`/api/playerevents/v1/${id}`)).json()).toEqual(asRecord(event, null))
	})
})

describe('openapi', () => {
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
		// an incomplete spec. Hono's `:param` syntax becomes OpenAPI's `{param}`; the
		// `.on(['GET','POST'], …)` routes (the relationship mutations, invention update)
		// contribute both methods.
		const documented = new Set(
			Object.entries(spec.paths).flatMap(([path, ops]) =>
				Object.keys(ops).map((method) => `${method.toUpperCase()} ${path}`)
			)
		)
		expect([...documented].sort()).toEqual([
			'DELETE /api/customAvatarItems/v1/{id}',
			'DELETE /api/images/v1/deletesaved',
			'DELETE /api/playerevents/v2/delete/{eventId}',
			'GET /api/CircuitChipLists/{list}',
			'GET /api/PlayerReporting/v1/moderationBlockDetails',
			'GET /api/PlayerReporting/v1/voteToKickReasons',
			'GET /api/activities/charades/v1/words/{activity}',
			'GET /api/announcement/v1/get',
			'GET /api/communityboard/v2/current',
			'GET /api/config/v1/amplitude',
			'GET /api/config/v1/azurespeech',
			'GET /api/config/v1/backtrace',
			'GET /api/config/v2',
			'GET /api/consumables/v2/getUnlocked',
			'GET /api/customAvatarItems/v1/featured',
			'GET /api/customAvatarItems/v1/hot',
			'GET /api/customAvatarItems/v1/isCreationAllowedForAccount',
			'GET /api/customAvatarItems/v1/isCreationEnabled',
			'GET /api/customAvatarItems/v1/isRenderingEnabled',
			'GET /api/customAvatarItems/v1/minPriceForPublicItem',
			'GET /api/customAvatarItems/v1/search',
			'GET /api/customAvatarItems/v2/fromCreator/{accountId}',
			'GET /api/equipment/v2/getUnlocked',
			'GET /api/gameconfigs/v1/all',
			'GET /api/images/v1/slideshow',
			'GET /api/images/v2/named',
			'GET /api/images/v3/feed/player/{playerId}',
			'GET /api/images/v4/player/{playerId}',
			'GET /api/images/v4/room/{roomId}',
			'GET /api/images/v5/bulk',
			'GET /api/images/v5/cheered/bulk',
			'GET /api/images/v5/player/{playerId}',
			'GET /api/images/v6',
			'GET /api/inventions/v1',
			'GET /api/inventions/v1/details',
			'GET /api/inventions/v1/featured',
			'GET /api/inventions/v1/featureddormskins',
			'GET /api/inventions/v1/fromcreators',
			'GET /api/inventions/v1/fulllineageowner',
			'GET /api/inventions/v1/personaldetails/{inventionId}',
			'GET /api/inventions/v1/room',
			'GET /api/inventions/v1/tagfilters',
			'GET /api/inventions/v1/toptoday',
			'GET /api/inventions/v1/update',
			'GET /api/inventions/v1/version',
			'GET /api/inventions/v2/batch',
			'GET /api/inventions/v2/mine',
			'GET /api/inventions/v2/search',
			'GET /api/inventions/v3/publish',
			'GET /api/keepsakes/categories',
			'GET /api/keepsakes/globalconfig',
			'GET /api/keepsakes/rooms/{roomId}',
			'GET /api/messages/v1/favoriteFriendOnlineStatus',
			'GET /api/messages/v2/get',
			'GET /api/playerReputation/v1/{id}',
			'GET /api/playerReputation/v2/bulk',
			'GET /api/playerevents/v1',
			'GET /api/playerevents/v1/all',
			'GET /api/playerevents/v1/bulk',
			'GET /api/playerevents/v1/club/{clubId}',
			'GET /api/playerevents/v1/clubs',
			'GET /api/playerevents/v1/room/{roomId}',
			'GET /api/playerevents/v1/search',
			'GET /api/playerevents/v1/searchlive',
			'GET /api/playerevents/v1/tagfilters',
			'GET /api/playerevents/v1/{eventId}',
			'GET /api/playerevents/v1/{eventId}/responses',
			'GET /api/playerevents/v2/{eventId}',
			'GET /api/players/v1/playerPhotoTaggingSetting',
			'GET /api/players/v1/progression/{id}',
			'GET /api/players/v2/progression/bulk',
			'GET /api/progressionEvents/active',
			'GET /api/quickPlay/v1/getandclear',
			'GET /api/referee/files',
			'GET /api/relationships/mutualfriends',
			'GET /api/relationships/v1/favorite',
			'GET /api/relationships/v1/ignore',
			'GET /api/relationships/v1/mute',
			'GET /api/relationships/v1/unfavorite',
			'GET /api/relationships/v1/unignore',
			'GET /api/relationships/v1/unmute',
			'GET /api/relationships/v2/acceptfriendrequest',
			'GET /api/relationships/v2/addfriend',
			'GET /api/relationships/v2/get',
			'GET /api/relationships/v2/removefriend',
			'GET /api/relationships/v2/sendfriendrequest',
			'GET /api/roomkeys/v1/mine',
			'GET /api/roomkeys/v1/room',
			'GET /api/rooms/v1/filters',
			'GET /api/versioncheck/islandedversions',
			'GET /api/versioncheck/v4',
			'GET /iam/me/channels/{type}',
			'GET /outfits/me',
			'GET /outfits/me/saved',
			'GET /voice/config',
			'POST /api/PlayerCheer/v1/SetSelectedCheer',
			'POST /api/PlayerCheer/v1/create',
			'POST /api/PlayerReporting/v1/deviceId',
			'POST /api/PlayerReporting/v1/hile',
			'POST /api/PlayerReporting/v1/instantKick',
			'POST /api/PlayerReporting/v1/moderationBlockDetails',
			'POST /api/PlayerReporting/v1/referee',
			'POST /api/PlayerReporting/v3/create',
			'POST /api/PlayerReporting/v3/voteToKick',
			'POST /api/avatar/v1/lockeditems/bulk',
			'POST /api/avatar/v2/gifts/generate',
			'POST /api/customAvatarItems/GetCustomAvatarItemCurrentSavesForLegacyAvatarItems',
			'POST /api/customAvatarItems/v1',
			'POST /api/customAvatarItems/v1/bulk',
			'POST /api/customAvatarItems/v1/{id}/report',
			'POST /api/gamesight/event',
			'POST /api/images/v1/cheer',
			'POST /api/images/v4/uploadsaved',
			'POST /api/images/v5/cheered/bulk',
			'POST /api/inventions/v1/report',
			'POST /api/inventions/v1/settags',
			'POST /api/inventions/v1/update',
			'POST /api/inventions/v1/updateprice',
			'POST /api/inventions/v2/delete',
			'POST /api/inventions/v4/publish',
			'POST /api/inventions/v6/save',
			'POST /api/inventions/v9/save',
			'POST /api/messages/v1/friendOnlineStatus',
			'POST /api/messages/v1/sendMultiple',
			'POST /api/messages/v2/send',
			'POST /api/messages/v3/delete',
			'POST /api/playerReputation/v1/bulk',
			'POST /api/playerReputation/v2/bulk',
			'POST /api/playerevents/v1/bulkInvite',
			'POST /api/playerevents/v1/report',
			'POST /api/playerevents/v1/respond',
			'POST /api/playerevents/v2',
			'POST /api/playerevents/v2/delete/{eventId}',
			'POST /api/playerevents/v2/{eventId}',
			'POST /api/players/v1/progression/bulk',
			'POST /api/players/v2/progression/bulk',
			'POST /api/playerwarnings',
			'POST /api/relationships/v1/favorite',
			'POST /api/relationships/v1/ignore',
			'POST /api/relationships/v1/mute',
			'POST /api/relationships/v1/unfavorite',
			'POST /api/relationships/v1/unignore',
			'POST /api/relationships/v1/unmute',
			'POST /api/relationships/v2/acceptfriendrequest',
			'POST /api/relationships/v2/addfriend',
			'POST /api/relationships/v2/removefriend',
			'POST /api/relationships/v2/sendfriendrequest',
			'POST /api/rooms/v1/verifyRole',
			'POST /api/sanitize/v1',
			'POST /api/sanitize/v1/isPure',
			'POST /api/v1/progression/bulk',
			'POST /outfits/bulk',
			'POST /statsigUserProperties',
			'PUT /api/customAvatarItems/v1/{id}',
			'PUT /api/inventions/v2/metadata',
			'PUT /api/playerevents/v2/{eventId}/accessibility',
			'PUT /api/playerevents/v2/{eventId}/description',
			'PUT /api/playerevents/v2/{eventId}/name',
			'PUT /api/playerevents/v2/{eventId}/tags',
			'PUT /api/playerevents/v2/{eventId}/time',
			'PUT /api/players/v1/playerPhotoTaggingSetting',
			'PUT /outfits/me',
		])

		// Every operation carries a summary — an undescribed one renders as a bare path.
		for (const [path, ops] of Object.entries(spec.paths)) {
			for (const [method, op] of Object.entries(ops)) {
				expect(op.summary, `${method.toUpperCase()} ${path} has no summary`).toBeTruthy()
			}
		}
	})

	// Schemas are inlined rather than $ref'd into components: a `.meta({ id })`'d schema
	// used in a response emits a $ref this hono-openapi + zod v4 setup does not always
	// hoist, leaving a dangling reference that breaks the docs UI.
	test('the spec has no $refs', async () => {
		const res = await exports.default.fetch(`${ORIGIN}/openapi.json`)
		const raw = await res.text()
		expect(raw.match(/\$ref/g)).toBeNull()
	})

	// `z.int()` carries the safe-integer range as its bounds, which Scalar would
	// otherwise show as the example value for every integer field (-9007199254740991).
	// withCleanSpec() supplies a placeholder instead; this guards the wrapper staying
	// wired up.
	test('integer fields carry a placeholder example', async () => {
		const res = await exports.default.fetch(`${ORIGIN}/openapi.json`)
		const raw = await res.text()
		const integers = raw.match(/"type":"integer"/g) ?? []
		expect(integers.length).toBeGreaterThan(0)
		expect(raw.match(/"example":12345/g)?.length).toBe(integers.length)
	})
})

// A ban follows the player, not just the account row it was written on: an evader makes
// a new account in seconds, so the block also reaches accounts sharing a PROVEN platform
// identity or an IP with a banned one. See bans-db.ts — and note the IP arm is the coarse
// one, which is why `BAN_EVASION_MATCH` can narrow or disable both linked arms.
describe('ban evasion', () => {
	/** Seed an account with the IPs it signed up / last logged in from. */
	const account = async (id: number, ips: { signupIp?: string; lastLoginIp?: string } = {}) => {
		await env.DB.prepare('INSERT OR IGNORE INTO account (data) VALUES (?1)')
			.bind(JSON.stringify({ accountId: id, username: `Evader${id}`, ...ips }))
			.run()
	}

	/** Link a proven platform identity to an account, as a verified login does. */
	const link = async (id: number, platform: number, platformId: string) => {
		await env.DB.prepare(
			`INSERT OR IGNORE INTO platform_account (account_id, platform, platform_id, linked_at)
			 VALUES (?1, ?2, ?3, ?4)`
		)
			.bind(id, platform, platformId, new Date().toISOString())
			.run()
	}

	/** File a report against `playerId` and convert it into a ban. */
	const ban = async (playerId: number, banExpires: string | null = null) => {
		const row = await createReport(env.DB, { reporterPlayerId: 1, reportedPlayerId: playerId })
		await banFromReport(env.DB, row.id, { banExpires })
	}

	test('a banned account is matched directly', async () => {
		await account(7001)
		await ban(7001)
		expect(await resolveBan(env.DB, 7001)).toMatchObject({ via: 'account', bannedAccountId: 7001 })
	})

	test('an unrelated account is not matched', async () => {
		await account(7002, { signupIp: '198.51.100.9' })
		await link(7002, 0, 'steam-clean')
		expect(await resolveBan(env.DB, 7002)).toBeNull()
	})

	test('an account sharing a signup IP with a banned account is matched', async () => {
		await account(7010, { signupIp: '203.0.113.7' })
		await ban(7010)
		await account(7011, { signupIp: '203.0.113.7' })

		const match = await resolveBan(env.DB, 7011)
		expect(match).toMatchObject({ via: 'ip', bannedAccountId: 7010 })
	})

	// The IPs are compared as SETS: the new account's last-login IP against the banned
	// account's signup IP counts, which is the shape evasion actually takes (sign up
	// somewhere else, come back to the same connection).
	test('a last-login IP matching a banned signup IP is matched', async () => {
		await account(7012, { signupIp: '203.0.113.20' })
		await ban(7012)
		await account(7013, { signupIp: '198.51.100.1', lastLoginIp: '203.0.113.20' })

		expect(await resolveBan(env.DB, 7013)).toMatchObject({ via: 'ip', bannedAccountId: 7012 })
	})

	test('an account sharing a platform identity with a banned account is matched', async () => {
		await account(7020)
		await link(7020, 0, 'steam-76561')
		await ban(7020)
		await account(7021)
		await link(7021, 0, 'steam-76561')

		expect(await resolveBan(env.DB, 7021)).toMatchObject({ via: 'platform', bannedAccountId: 7020 })
	})

	// The same id on a DIFFERENT platform is a different person — ids are namespaced per
	// platform, so the arm matches the pair, not the bare id.
	test('the same platform id on another platform is not matched', async () => {
		await account(7022)
		await link(7022, 0, 'id-collision')
		await ban(7022)
		await account(7023)
		await link(7023, 1, 'id-collision')

		expect(await resolveBan(env.DB, 7023)).toBeNull()
	})

	// Two accounts that merely both lack an IP have nothing in common — "unknown" must
	// never match "unknown", or every IP-less account would be banned by the first one.
	test('accounts with no IP at all are not matched to each other', async () => {
		await account(7030)
		await ban(7030)
		await account(7031)
		expect(await resolveBan(env.DB, 7031)).toBeNull()
		// Nor does an empty-string IP, which is what a login outside the CF edge stores.
		await account(7032, { signupIp: '', lastLoginIp: '' })
		expect(await resolveBan(env.DB, 7032)).toBeNull()
	})

	test('an expired ban reaches nobody, linked or not', async () => {
		await account(7040, { signupIp: '203.0.113.40' })
		await link(7040, 0, 'steam-expired')
		await ban(7040, '2020-01-01T00:00:00.000Z')
		await account(7041, { signupIp: '203.0.113.40' })
		await link(7041, 0, 'steam-expired')

		expect(await resolveBan(env.DB, 7040)).toBeNull()
		expect(await resolveBan(env.DB, 7041)).toBeNull()
	})

	// The strongest evidence is reported: a player whose own account is banned is told
	// that, not that their network was.
	test('a direct ban outranks a linked one', async () => {
		await account(7050, { signupIp: '203.0.113.50' })
		await ban(7050)
		await account(7051, { signupIp: '203.0.113.50' })
		await ban(7051)

		expect(await resolveBan(env.DB, 7051)).toMatchObject({ via: 'account', bannedAccountId: 7051 })
	})

	test('a platform match outranks an IP one', async () => {
		await account(7060, { signupIp: '203.0.113.60' })
		await ban(7060)
		await account(7061)
		await link(7061, 0, 'steam-both')
		await ban(7061)
		// 7062 shares an IP with 7060 and a platform identity with 7061.
		await account(7062, { signupIp: '203.0.113.60' })
		await link(7062, 0, 'steam-both')

		expect(await resolveBan(env.DB, 7062)).toMatchObject({ via: 'platform', bannedAccountId: 7061 })
	})

	// A signup has no account yet — the identity the request carries is all there is to
	// go on, and refusing it there is what stops the next account being created at all.
	test('an identity with no account is matched on its IP and platform id', async () => {
		await account(7070, { signupIp: '203.0.113.70' })
		await link(7070, 0, 'steam-signup')
		await ban(7070)

		expect(await resolveBan(env.DB, null, { identity: { ip: '203.0.113.70' } })).toMatchObject({
			via: 'ip',
			bannedAccountId: 7070,
		})
		expect(
			await resolveBan(env.DB, null, { identity: { platform: 0, platformId: 'steam-signup' } })
		).toMatchObject({ via: 'platform', bannedAccountId: 7070 })
		// An identity that matches nothing is not blocked.
		expect(
			await resolveBan(env.DB, null, {
				identity: { ip: '198.51.100.200', platform: 0, platformId: 'steam-unknown' },
			})
		).toBeNull()
		// And an identity carrying nothing at all can't be matched to anyone.
		expect(await resolveBan(env.DB, null, { identity: {} })).toBeNull()
	})

	// The arms an operator can turn off — and the one they cannot.
	test('BAN_EVASION_MATCH arms narrow the linked matching only', async () => {
		await account(7080, { signupIp: '203.0.113.80' })
		await link(7080, 0, 'steam-arms')
		await ban(7080)
		await account(7081, { signupIp: '203.0.113.80' }) // shares the IP only
		await account(7082)
		await link(7082, 0, 'steam-arms') // shares the identity only

		const arms = (value: string | undefined) => ({ arms: banEvasionMatch(value) })
		// Default: both arms reach.
		expect(await resolveBan(env.DB, 7081, arms(undefined))).toMatchObject({ via: 'ip' })
		expect(await resolveBan(env.DB, 7082, arms(undefined))).toMatchObject({ via: 'platform' })
		// Platform only: the household bystander is let through, the evader isn't.
		expect(await resolveBan(env.DB, 7081, arms('platform'))).toBeNull()
		expect(await resolveBan(env.DB, 7082, arms('platform'))).toMatchObject({ via: 'platform' })
		// Off: neither linked arm reaches...
		expect(await resolveBan(env.DB, 7081, arms('off'))).toBeNull()
		expect(await resolveBan(env.DB, 7082, arms('off'))).toBeNull()
		// ...but the ban itself still applies to the account it was handed to.
		expect(await resolveBan(env.DB, 7080, arms('off'))).toMatchObject({ via: 'account' })
	})

	test('banEvasionMatch reads the knob', () => {
		expect(banEvasionMatch(undefined)).toEqual({ ip: true, platform: true })
		expect(banEvasionMatch('ip,platform')).toEqual({ ip: true, platform: true })
		expect(banEvasionMatch(' PLATFORM ')).toEqual({ ip: false, platform: true })
		expect(banEvasionMatch('ip')).toEqual({ ip: true, platform: false })
		expect(banEvasionMatch('off')).toEqual({ ip: false, platform: false })
		expect(banEvasionMatch('none')).toEqual({ ip: false, platform: false })
		expect(banEvasionMatch('')).toEqual({ ip: false, platform: false })
		// `off` wins over anything else in the list, and a typo is ignored rather than
		// fatal — this is read on the matchmake path.
		expect(banEvasionMatch('off,ip')).toEqual({ ip: false, platform: false })
		expect(banEvasionMatch('ipv6')).toEqual({ ip: false, platform: false })
		expect(banEvasionMatch('ip,typo')).toEqual({ ip: true, platform: false })
	})
})
