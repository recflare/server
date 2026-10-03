import { adminSecretsStore, env, SELF } from 'cloudflare:test'
import { beforeAll, describe, expect, it } from 'vitest'

import {
	PRESENCE_SCHEMA_DDL,
	ROOM_SCHEMA_DDL,
	SUBROOM_SCHEMA_DDL,
	setPresence,
} from '@repo/domain'

import { STUDIO_CLOUD_BUILD_SCHEMA_DDL } from '../../local-builds'

import type { Env } from '../../context'

declare module 'cloudflare:test' {
	interface ProvidedEnv extends Env {}
}

const ORIGIN = 'https://example.com'
const TEST_SECRET = 'test-signing-key'

function b64url(input: ArrayBuffer | string): string {
	const bytes = typeof input === 'string' ? new TextEncoder().encode(input) : new Uint8Array(input)
	let binary = ''
	for (const byte of bytes) binary += String.fromCharCode(byte)
	return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

async function bearer(sub: string, roles?: string[]): Promise<Record<string, string>> {
	const now = Math.floor(Date.now() / 1000)
	const payload: Record<string, unknown> = { sub, exp: now + 3600 }
	if (roles != null) payload.role = roles
	const signingInput = `${b64url(JSON.stringify({ alg: 'HS256', typ: 'JWT' }))}.${b64url(
		JSON.stringify(payload)
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

async function insertRoom(roomId: number, creatorAccountId: number, roles: unknown[]): Promise<void> {
	await env.DB.prepare('INSERT INTO room (data) VALUES (?1)')
		.bind(
			JSON.stringify({
				RoomId: roomId,
				Name: `Room ${roomId}`,
				CreatorAccountId: creatorAccountId,
				IsDorm: false,
				Accessibility: 1,
				Roles: roles,
			})
		)
		.run()
}

async function standIn(
	accountId: number,
	roomId: number,
	subRoomId: number,
	{ expired = false }: { expired?: boolean } = {}
): Promise<void> {
	if (expired) {
		await env.DB.prepare('INSERT OR REPLACE INTO presence (data) VALUES (?1)')
			.bind(
				JSON.stringify({
					accountId,
					roomInstance: { roomInstanceId: 800000 + accountId, roomId, subRoomId },
					expiresAt: Math.floor(Date.now() / 1000) - 10,
				})
			)
			.run()
		return
	}
	await setPresence(env.DB, {
		accountId,
		roomInstance: { roomInstanceId: 800000 + accountId, roomId, subRoomId },
		statusVisibility: 0,
		deviceClass: 0,
		vrMovementMode: 0,
		platform: 0,
		appVersion: 'test',
	})
}

beforeAll(async () => {
	await adminSecretsStore(env.JWT_SECRET).create(TEST_SECRET)
	for (const stmt of STUDIO_CLOUD_BUILD_SCHEMA_DDL) await env.DB.prepare(stmt).run()
})

it('response with hello world', async () => {
	const res = await SELF.fetch('https://example.com')
	expect(res.status).toBe(200)
	expect(await res.text()).toMatchInlineSnapshot(`"hello, world!"`)
})

it('lists no cloud builds for a room', async () => {
	const res = await SELF.fetch(
		'https://example.com/cloud-builds/for-room?roomId=1&subRoomId=1&skip=0&take=20'
	)
	expect(res.status).toBe(200)
	expect(await res.json()).toEqual({ results: [], totalResults: 0 })
})

describe('GET /collaboration/owners-in-room', () => {
	const roomId = 1106
	const subRoomId = 22941

	beforeAll(async () => {
		for (const stmt of ROOM_SCHEMA_DDL) await env.DB.prepare(stmt).run()
		for (const stmt of PRESENCE_SCHEMA_DDL) await env.DB.prepare(stmt).run()
		// Creator 1, co-owner 7, another co-owner 11, moderator 8, pending invite 9.
		await insertRoom(roomId, 1, [
			{ AccountId: 1, Role: 255, InvitedRole: 0 },
			{ AccountId: 7, Role: 30, InvitedRole: 0 },
			{ AccountId: 11, Role: 30, InvitedRole: 0 },
			{ AccountId: 13, Role: 30, InvitedRole: 0 },
			{ AccountId: 8, Role: 20, InvitedRole: 0 },
			{ AccountId: 9, Role: 0, InvitedRole: 30 },
		])
		await standIn(1, roomId, subRoomId)
		await standIn(7, roomId, subRoomId)
		await standIn(11, roomId, 22942)
		await standIn(8, roomId, subRoomId)
		await standIn(9, roomId, subRoomId)
		await standIn(10, roomId, subRoomId)
		await standIn(12, 9999, subRoomId)
		await standIn(13, roomId, subRoomId, { expired: true })
	})

	it('requires a bearer token', async () => {
		const res = await SELF.fetch(
			`${ORIGIN}/collaboration/owners-in-room?roomId=${roomId}&subRoomId=${subRoomId}`
		)
		expect(res.status).toBe(401)
	})

	it('lists co-owners whose presence is in this room and subroom', async () => {
		const res = await SELF.fetch(
			`${ORIGIN}/collaboration/owners-in-room?roomId=${roomId}&subRoomId=${subRoomId}`,
			{ headers: await bearer('42') }
		)
		expect(res.status).toBe(200)
		// 1 (creator) and 7 (role 30) are in subroom 22941. 11 is a co-owner in the
		// other subroom. 13 is a co-owner whose presence has expired. 8 is a
		// moderator, 9 is only invited, 10 has no role.
		expect(await res.json()).toEqual({ success: true, error: null, value: [1, 7] })
	})

	it('returns an empty list for an unknown room', async () => {
		const res = await SELF.fetch(
			`${ORIGIN}/collaboration/owners-in-room?roomId=404&subRoomId=${subRoomId}`,
			{ headers: await bearer('42') }
		)
		expect(res.status).toBe(200)
		expect(await res.json()).toEqual({ success: true, error: null, value: [] })
	})

	it('returns an empty list when the query ids are missing', async () => {
		const res = await SELF.fetch(`${ORIGIN}/collaboration/owners-in-room`, {
			headers: await bearer('42'),
		})
		expect(res.status).toBe(200)
		expect(await res.json()).toEqual({ success: true, error: null, value: [] })
	})
})

const LOCAL_ROOM = 7701
const LOCAL_SUB = 8801
const LOCAL_SAVE = 88001
const UNSAVED_SUB = 8802
const UPLOAD_FIRST =
	'Upload the room before building locally. The latest save is where this build is recorded.'
const BUNDLE_REQUIRED = 'Both a Windows bundle and an Android bundle are required.'
const NOT_AUTHORIZED =
	'You do not have authorization to upload RecFlare Studio content at this time.'
const STUDIO_ROLES = ['gameClient', 'screenshare', 'betastudio']

async function insertSubRoom(
	roomId: number,
	subRoomId: number,
	saveId: number | null
): Promise<void> {
	await env.DB.prepare(
		`INSERT INTO subroom (sub_room_id, room_id, data, current_save_id, staged_save_id)
		 VALUES (?1, ?2, ?3, ?4, NULL)`
	)
		.bind(subRoomId, roomId, JSON.stringify({ Name: 'Home' }), saveId)
		.run()
	if (saveId == null) return
	await env.DB.prepare(
		`INSERT INTO subroom_save (sub_room_data_save_id, sub_room_id, data) VALUES (?1, ?2, ?3)`
	)
		.bind(saveId, subRoomId, JSON.stringify({ DataBlob: 'scene' }))
		.run()
}

function bundleFile(name: string, bytes: number[]): File {
	return new File([new Uint8Array(bytes)], name)
}

async function postBuild(
	tokenSub: string | null,
	fields: Record<string, string | File>,
	roles: string[] = STUDIO_ROLES
): Promise<Response> {
	const body = new FormData()
	for (const [key, value] of Object.entries(fields)) body.append(key, value)
	return SELF.fetch(`${ORIGIN}/cloud-builds/from-editor`, {
		method: 'POST',
		headers: tokenSub == null ? undefined : await bearer(tokenSub, roles),
		body,
	})
}

async function studioFlag(roomId: number): Promise<string | null> {
	const row = await env.DB.prepare(
		`SELECT json_extract(data, '$.BecameRRStudioRoomAt') AS at FROM room WHERE room_id = ?1`
	)
		.bind(roomId)
		.first<{ at: string | null }>()
	return row?.at ?? null
}

describe('local cloud builds', () => {
	beforeAll(async () => {
		for (const stmt of ROOM_SCHEMA_DDL) await env.DB.prepare(stmt).run()
		for (const stmt of SUBROOM_SCHEMA_DDL) await env.DB.prepare(stmt).run()
		// Creator 42, co-owner 77. Account 99 has no role.
		await insertRoom(LOCAL_ROOM, 42, [{ AccountId: 77, Role: 30, InvitedRole: 0 }])
		await insertSubRoom(LOCAL_ROOM, LOCAL_SUB, LOCAL_SAVE)
		await insertSubRoom(LOCAL_ROOM, UNSAVED_SUB, null)
	})

	const both = {
		roomId: String(LOCAL_ROOM),
		subRoomId: String(LOCAL_SUB),
		windows: bundleFile('win.assetbundle', [1, 2, 3, 4]),
		android: bundleFile('quest bundle.assetbundle', [5, 6]),
	}

	it('requires a bearer token', async () => {
		const res = await postBuild(null, both)
		expect(res.status).toBe(401)
	})

	it('rejects an account without studio access', async () => {
		const res = await postBuild('42', both, ['gameClient', 'screenshare'])
		expect(res.status).toBe(403)
		expect(await res.json()).toEqual({ success: false, error: NOT_AUTHORIZED, value: null })
		expect(await studioFlag(LOCAL_ROOM)).toBeNull()
	})

	it('rejects an unknown room', async () => {
		const res = await postBuild('42', { ...both, roomId: '7699' })
		expect(res.status).toBe(404)
		expect(await res.json()).toEqual({ success: false, error: 'No such room.', value: null })
	})

	it('rejects an account that does not own the room', async () => {
		// 8809 is not a subroom. Ownership is checked before the subroom, so this stays 403.
		const res = await postBuild('99', { ...both, subRoomId: '8809' })
		expect(res.status).toBe(403)
		expect(await res.json()).toEqual({
			success: false,
			error: 'This account cannot upload a build for that room.',
			value: null,
		})
	})

	it('rejects an unknown subroom', async () => {
		const res = await postBuild('42', { ...both, subRoomId: '8809' })
		expect(res.status).toBe(404)
		expect(await res.json()).toEqual({ success: false, error: 'No such subroom.', value: null })
	})

	it('rejects a build that is missing a platform', async () => {
		const res = await postBuild('42', {
			roomId: both.roomId,
			subRoomId: both.subRoomId,
			windows: both.windows,
		})
		expect(res.status).toBe(400)
		expect(await res.json()).toEqual({ success: false, error: BUNDLE_REQUIRED, value: null })
	})

	it('rejects an empty bundle', async () => {
		const res = await postBuild('42', { ...both, windows: bundleFile('win.assetbundle', []) })
		expect(res.status).toBe(400)
		expect(await res.json()).toEqual({ success: false, error: BUNDLE_REQUIRED, value: null })
	})

	it('rejects a subroom that has no save yet', async () => {
		const res = await postBuild('42', { ...both, subRoomId: String(UNSAVED_SUB) })
		expect(res.status).toBe(400)
		expect(await res.json()).toEqual({ success: false, error: UPLOAD_FIRST, value: null })
		expect(await studioFlag(LOCAL_ROOM)).toBeNull()
	})

	it('stores both bundles on the latest save and lists the build', async () => {
		expect(await studioFlag(LOCAL_ROOM)).toBeNull()
		const created = await postBuild('42', {
			...both,
			windowsStripped: bundleFile('win.Stripped.assetbundle', [7, 8, 9]),
		})
		expect(created.status).toBe(200)
		const first = (await created.json()) as {
			success: boolean
			error: null
			value: {
				cloudBuildId: string
				startedAt: string
				completedAt: string
				error: null
				unityAssetId: string
				createdByAccountId: number
			}
		}
		expect(first.success).toBe(true)
		expect(first.error).toBeNull()
		expect(first.value.createdByAccountId).toBe(42)
		expect(first.value.completedAt).toBe(first.value.startedAt)
		expect(first.value.error).toBeNull()
		expect(await studioFlag(LOCAL_ROOM)).toBe(first.value.startedAt)

		const save = await env.DB.prepare(
			`SELECT json_extract(data, '$.UnityAssetId') AS id
			 FROM subroom_save WHERE sub_room_data_save_id = ?1`
		)
			.bind(LOCAL_SAVE)
			.first<{ id: string }>()
		expect(save?.id).toBe(first.value.unityAssetId)

		const buildRow = await env.DB.prepare(
			`SELECT sub_room_data_save_id, error, completed_at
			 FROM studio_cloud_build WHERE cloud_build_id = ?1`
		)
			.bind(first.value.cloudBuildId)
			.first<{ sub_room_data_save_id: number; error: string | null; completed_at: string }>()
		expect(buildRow).toEqual({
			sub_room_data_save_id: LOCAL_SAVE,
			error: null,
			completed_at: first.value.startedAt,
		})

		const { results: files } = await env.DB.prepare(
			`SELECT platform, kind, filename, byte_length, r2_key
			 FROM studio_unity_asset_file WHERE unity_asset_id = ?1
			 ORDER BY platform, kind`
		)
			.bind(first.value.unityAssetId)
			.all<{
				platform: string
				kind: string
				filename: string
				byte_length: number
				r2_key: string
			}>()
		const publicName = (platform: string, kind: string) =>
			`${first.value.unityAssetId.replace(/-/g, '')}.${platform}.${kind}.assetbundle`
		expect(
			files.map((file) => [file.platform, file.kind, file.filename, file.byte_length])
		).toEqual([
			['android', 'main', publicName('android', 'main'), 2],
			['windows', 'main', publicName('windows', 'main'), 4],
			['windows', 'stripped', publicName('windows', 'stripped'), 3],
		])
		const win = files.find((file) => file.platform === 'windows' && file.kind === 'main')
		const stored = await env.CDN_ASSETS.get(win!.r2_key)
		expect(stored).not.toBeNull()
		expect([...new Uint8Array(await stored!.arrayBuffer())]).toEqual([1, 2, 3, 4])

		const again = await postBuild('42', both)
		expect(again.status).toBe(200)
		const second = (await again.json()) as typeof first
		expect(second.value.cloudBuildId).not.toBe(first.value.cloudBuildId)
		expect(await studioFlag(LOCAL_ROOM)).toBe(first.value.startedAt)
		const saveAfter = await env.DB.prepare(
			`SELECT json_extract(data, '$.UnityAssetId') AS id
			 FROM subroom_save WHERE sub_room_data_save_id = ?1`
		)
			.bind(LOCAL_SAVE)
			.first<{ id: string }>()
		expect(saveAfter?.id).toBe(second.value.unityAssetId)

		await env.DB.prepare(
			`UPDATE studio_cloud_build SET started_at = '2000-01-01T00:00:00.000Z' WHERE cloud_build_id = ?1`
		)
			.bind(first.value.cloudBuildId)
			.run()
		const listed = await SELF.fetch(
			`${ORIGIN}/cloud-builds/for-room?roomId=${LOCAL_ROOM}&subRoomId=${LOCAL_SUB}&skip=0&take=20`
		)
		expect(listed.status).toBe(200)
		const page = (await listed.json()) as {
			results: Array<{ cloudBuildId: string; startedAt: string; createdByAccountId: number }>
			totalResults: number
		}
		expect(page.totalResults).toBe(2)
		expect(page.results.map((row) => row.cloudBuildId)).toEqual([
			second.value.cloudBuildId,
			first.value.cloudBuildId,
		])
		expect(page.results[0]!.createdByAccountId).toBe(42)
		expect(page.results[1]!.startedAt).toBe('2000-01-01T00:00:00.000Z')

		const past = await SELF.fetch(
			`${ORIGIN}/cloud-builds/for-room?roomId=${LOCAL_ROOM}&subRoomId=${LOCAL_SUB}&skip=20&take=20`
		)
		expect(await past.json()).toEqual({ results: [], totalResults: 2 })

		const bad = await SELF.fetch(
			`${ORIGIN}/cloud-builds/for-room?roomId=${LOCAL_ROOM}&subRoomId=${LOCAL_SUB}&skip=-1&take=20`
		)
		expect(await bad.json()).toEqual({ results: [], totalResults: 0 })

		const coOwner = await postBuild('77', both)
		expect(coOwner.status).toBe(200)
		const third = (await coOwner.json()) as typeof first
		expect(third.value.createdByAccountId).toBe(77)
		expect(await studioFlag(LOCAL_ROOM)).toBe(first.value.startedAt)
	})
})
