import { createHash } from 'node:crypto'
import { adminSecretsStore, env } from 'cloudflare:test'
import { beforeAll, beforeEach, describe, expect, it } from 'vitest'

import {
	ROOM_SCHEMA_DDL,
	STUDIO_CLOUD_BUILD_SCHEMA_DDL,
	studioBundleR2Key,
	SUBROOM_SCHEMA_DDL,
	UNITY_ASSET_SCHEMA_DDL,
} from '@repo/domain'

import { SCHEMA_DDL as CUSTOM_AVATAR_ITEM_SCHEMA_DDL } from '../../../../api/src/custom-avatar-items-db'
import editorUploads, {
	cleanupEditorUploads,
	EDITOR_UPLOAD_SCHEMA,
	SESSION_TTL_MS,
} from '../../editor-uploads'

import type { Env } from '../../context'

declare module 'cloudflare:test' {
	interface ProvidedEnv extends Env {}
}

const ORIGIN = 'https://example.com'
const ROOM = 4000
const SUB = 4001
const SAVE = 4002
const UNSAVED_SUB = 4003

const b64url = (value: string | ArrayBuffer) =>
	btoa(typeof value === 'string' ? value : String.fromCharCode(...new Uint8Array(value)))
		.replace(/=/g, '')
		.replace(/\+/g, '-')
		.replace(/\//g, '_')

async function bearer(id = 42, roles = ['betastudio']) {
	const payload = b64url(
		JSON.stringify({ sub: String(id), role: roles, exp: Date.now() / 1000 + 600 })
	)
	const input = b64url(JSON.stringify({ alg: 'HS256', typ: 'JWT' })) + '.' + payload
	const secret = await crypto.subtle.importKey(
		'raw',
		new TextEncoder().encode('test-key'),
		{ name: 'HMAC', hash: 'SHA-256' },
		false,
		['sign']
	)
	const signature = await crypto.subtle.sign('HMAC', secret, new TextEncoder().encode(input))
	return { Authorization: `Bearer ${input}.${b64url(signature)}` }
}

const signing: Partial<Env> = {
	R2_ACCOUNT_ID: 'a'.repeat(32),
	R2_CDN_BUCKET: 'test-bucket',
	R2_ACCESS_KEY_ID: { get: async () => 'test-id' } as SecretsStoreSecret,
	R2_SECRET_ACCESS_KEY: { get: async () => 'test-secret' } as SecretsStoreSecret,
}

async function call(
	path: string,
	body: unknown = {},
	{ id = 42, roles = ['betastudio'], config = signing, auth = true } = {}
) {
	return editorUploads.request(
		ORIGIN + path,
		{
			method: 'POST',
			headers: {
				'Content-Type': 'application/json',
				...(auth ? await bearer(id, roles) : {}),
			},
			body: JSON.stringify(body),
		},
		{ ...env, ...config }
	)
}

function bundle(size: number, fill = 7): Uint8Array {
	const bytes = new Uint8Array(size).fill(fill)
	bytes.set(new TextEncoder().encode('UnityFS\0'))
	return bytes
}

function sha256(bytes: Uint8Array): string {
	return createHash('sha256').update(bytes).digest('base64')
}

const windows = bundle(16 * 1024 * 1024 + 9, 1)
const android = bundle(64, 2)

function declared(extra: Array<Record<string, unknown>> = []) {
	return [
		{ platform: 'windows', kind: 'main', size: windows.length, hash: sha256(windows) },
		{ platform: 'android', kind: 'main', size: android.length, hash: sha256(android) },
		...extra,
	]
}

interface Started {
	sessionId: string
	unityAssetId: string
	partSize: number
	files: Array<{ platform: string; kind: string; parts: number }>
}

async function start(files = declared(), roomId = ROOM, subRoomId = SUB, id = 42) {
	return call('/start', { roomId, subRoomId, files }, { id })
}

async function row(sessionId: string, platform: string, kind = 'main') {
	return env.DB.prepare(
		'SELECT object_key, upload_id, state FROM studio_editor_upload WHERE session_id=?1 AND platform=?2 AND kind=?3'
	)
		.bind(sessionId, platform, kind)
		.first<{ object_key: string; upload_id: string; state: string }>()
}

/** Stand in for the caller's PUTs: upload the parts straight through the binding. */
async function uploadParts(sessionId: string, platform: string, bytes: Uint8Array) {
	const r = (await row(sessionId, platform))!
	const multipart = env.CDN_ASSETS.resumeMultipartUpload(r.object_key, r.upload_id)
	const parts: R2UploadedPart[] = []
	const partSize = 16 * 1024 * 1024
	for (let offset = 0, n = 1; offset < bytes.length; offset += partSize, n++)
		parts.push(await multipart.uploadPart(n, bytes.subarray(offset, offset + partSize)))
	return parts
}

async function uploadAndComplete(sessionId: string, platform: string, bytes: Uint8Array) {
	const parts = await uploadParts(sessionId, platform, bytes)
	return call(`/${sessionId}/${platform}/main/complete`, { parts })
}

beforeAll(async () => {
	await adminSecretsStore(env.JWT_SECRET).create('test-key')
	for (const sql of [
		...ROOM_SCHEMA_DDL,
		...SUBROOM_SCHEMA_DDL,
		...STUDIO_CLOUD_BUILD_SCHEMA_DDL,
		...UNITY_ASSET_SCHEMA_DDL,
		...CUSTOM_AVATAR_ITEM_SCHEMA_DDL,
		EDITOR_UPLOAD_SCHEMA,
	])
		await env.DB.prepare(sql).run()
	await env.DB.prepare('INSERT INTO room (data) VALUES (?)')
		.bind(
			JSON.stringify({
				RoomId: ROOM,
				Name: 'EditorUploads',
				CreatorAccountId: 42,
				Roles: [{ AccountId: 77, Role: 30, InvitedRole: 0 }],
				Tags: [],
				Accessibility: 1,
			})
		)
		.run()
	await env.DB.prepare(
		'INSERT INTO subroom (sub_room_id,room_id,data,current_save_id) VALUES (?1,?2,?3,?4)'
	)
		.bind(SUB, ROOM, JSON.stringify({ Name: 'Home' }), SAVE)
		.run()
	await env.DB.prepare(
		'INSERT INTO subroom (sub_room_id,room_id,data,current_save_id) VALUES (?1,?2,?3,NULL)'
	)
		.bind(UNSAVED_SUB, ROOM, JSON.stringify({ Name: 'Unsaved' }))
		.run()
	await env.DB.prepare(
		'INSERT INTO subroom_save (sub_room_data_save_id,sub_room_id,data) VALUES (?1,?2,?3)'
	)
		.bind(SAVE, SUB, JSON.stringify({ SubRoomDataSaveId: SAVE, UnitySubAssets: [] }))
		.run()
})

beforeEach(async () => {
	await env.DB.prepare('DELETE FROM studio_editor_upload').run()
	await env.DB.prepare('DELETE FROM studio_cloud_build').run()
})

describe('presigned from-editor uploads', () => {
	it('uses the from-editor gate', async () => {
		expect((await call('/start', {}, { auth: false })).status).toBe(401)
		expect((await call('/start', {}, { roles: ['gameClient'] })).status).toBe(403)
		// Account 99 holds no role in the room; 77 is a co-owner.
		expect((await start(declared(), ROOM, SUB, 99)).status).toBe(403)
		expect((await start(declared(), ROOM, SUB, 77)).status).toBe(200)
		expect((await start(declared(), 999999, SUB)).status).toBe(404)
		expect((await start(declared(), ROOM, 999999)).status).toBe(404)
		expect((await start(declared(), ROOM, UNSAVED_SUB)).status).toBe(400)
	})

	it('stays off without R2 signing credentials', async () => {
		const off = {
			R2_ACCESS_KEY_ID: { get: async () => 'off' } as SecretsStoreSecret,
			R2_SECRET_ACCESS_KEY: { get: async () => 'off' } as SecretsStoreSecret,
		}
		const res = await call(
			'/start',
			{ roomId: ROOM, subRoomId: SUB, files: declared() },
			{ config: { ...signing, ...off } }
		)
		expect(res.status).toBe(503)
	})

	it('validates the declared bundles before opening anything', async () => {
		const tooBig = declared()
		tooBig[0]!.size = 128 * 1024 * 1024 + 1
		expect((await start(tooBig)).status).toBe(413)
		expect((await start(declared().slice(0, 1))).status).toBe(400)
		expect((await start([...declared(), declared()[0]!])).status).toBe(400)
		const badHash = declared()
		badHash[1]!.hash = 'nope'
		expect((await start(badHash)).status).toBe(400)
		expect(
			await env.DB.prepare('SELECT COUNT(*) AS n FROM studio_editor_upload').first<{ n: number }>()
		).toEqual({ n: 0 })
	})

	it('signs parts for its own object only, verifies, and records the build', async () => {
		const res = await start()
		expect(res.status).toBe(200)
		const { value: plan } = await res.json<{ value: Started }>()
		expect(plan.partSize).toBe(16 * 1024 * 1024)
		expect(plan.files).toEqual([
			{ platform: 'windows', kind: 'main', parts: 2 },
			{ platform: 'android', kind: 'main', parts: 1 },
		])

		const win = (await row(plan.sessionId, 'windows'))!
		const signed = await (
			await call(`/${plan.sessionId}/windows/main/part/2`)
		).json<{ value: { url: string; length: number } }>()
		const url = new URL(signed.value.url)
		expect(url.hostname).toBe('a'.repeat(32) + '.r2.cloudflarestorage.com')
		expect(url.pathname).toBe(`/test-bucket/${win.object_key}`)
		expect(url.searchParams.get('uploadId')).toBe(win.upload_id)
		expect(url.searchParams.get('X-Amz-Expires')).toBe('120')
		expect(signed.value.length).toBe(9)
		expect((await call(`/${plan.sessionId}/windows/main/part/3`)).status).toBe(400)
		expect((await call(`/${plan.sessionId}/windows/stripped/part/1`)).status).toBe(400)
		// Another account cannot see the session at all.
		expect((await call(`/${plan.sessionId}/windows/main/part/1`, {}, { id: 77 })).status).toBe(404)

		expect((await call(`/${plan.sessionId}/finish`)).status).toBe(400)
		expect((await uploadAndComplete(plan.sessionId, 'windows', windows)).status).toBe(200)
		expect((await call(`/${plan.sessionId}/finish`)).status).toBe(400)
		expect((await uploadAndComplete(plan.sessionId, 'android', android)).status).toBe(200)

		const finish = await call(`/${plan.sessionId}/finish`)
		expect(finish.status).toBe(200)
		const { value: build } = await finish.json<{ value: { unityAssetId: string } }>()
		expect(build.unityAssetId).toBe(plan.unityAssetId)

		const { results: assets } = await env.DB.prepare(
			"SELECT target, filename, hash FROM unity_asset WHERE unity_asset_id=?1 AND kind='main' ORDER BY target"
		)
			.bind(plan.unityAssetId)
			.all<{ target: number; filename: string; hash: string }>()
		expect(assets.map((a) => [a.target, a.hash])).toEqual([
			[0, sha256(windows)],
			[2, sha256(android)],
		])
		const stored = await env.CDN_ASSETS.get(studioBundleR2Key(assets[1]!.filename))
		expect(new Uint8Array(await stored!.arrayBuffer())).toEqual(android)
		const save = await env.DB.prepare(
			"SELECT json_extract(data,'$.UnityAssetId') AS id FROM subroom_save WHERE sub_room_data_save_id=?1"
		)
			.bind(SAVE)
			.first<{ id: string }>()
		expect(save?.id).toBe(plan.unityAssetId)
		expect(await env.CDN_ASSETS.head(win.object_key)).toBeNull()
		expect(
			await env.DB.prepare('SELECT COUNT(*) AS n FROM studio_editor_upload').first<{ n: number }>()
		).toEqual({ n: 0 })
	})

	it('drops a session whose bytes do not match the declaration', async () => {
		const { value: plan } = await (await start()).json<{ value: Started }>()
		const forged = bundle(android.length, 9)
		const res = await uploadAndComplete(plan.sessionId, 'android', forged)
		expect(res.status).toBe(400)
		const staged = await row(plan.sessionId, 'windows')
		expect(staged).toBeNull()
		expect((await call(`/${plan.sessionId}/finish`)).status).toBe(404)
	})

	it('limits open sessions per account and sweeps expired ones', async () => {
		const first = await (await start()).json<{ value: Started }>()
		expect((await start()).status).toBe(200)
		expect((await start()).status).toBe(429)

		const staged = (await row(first.value.sessionId, 'windows'))!
		await env.DB.prepare('UPDATE studio_editor_upload SET created_at=?1 WHERE session_id=?2')
			.bind(new Date(Date.now() - SESSION_TTL_MS - 1000).toISOString(), first.value.sessionId)
			.run()
		expect((await call(`/${first.value.sessionId}/windows/main/part/1`)).status).toBe(410)
		await cleanupEditorUploads(env)
		expect(await row(first.value.sessionId, 'windows')).toBeNull()
		expect(await env.CDN_ASSETS.head(staged.object_key)).toBeNull()
		expect((await start()).status).toBe(200)
	})

	it('aborts an unfinished session', async () => {
		const { value: plan } = await (await start()).json<{ value: Started }>()
		expect((await call(`/${plan.sessionId}/abort`)).status).toBe(200)
		expect(await row(plan.sessionId, 'windows')).toBeNull()
	})
})
