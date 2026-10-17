import { adminSecretsStore, env, SELF } from 'cloudflare:test'
import { beforeAll, beforeEach, expect, it } from 'vitest'

import {
	ROOM_SCHEMA_DDL,
	STUDIO_CLOUD_BUILD_SCHEMA_DDL,
	SUBROOM_SCHEMA_DDL,
	UNITY_ASSET_SCHEMA_DDL,
} from '@repo/domain'

import { CLOUD_JOB_SCHEMA } from '../../cloud-builds'

import type { Env } from '../../context'

declare module 'cloudflare:test' {
	interface ProvidedEnv extends Env {}
}
const origin = 'https://example.com'
const key = 'cloud-worker-private-test-key'
const worker = { Authorization: `Bearer ${key}` }
const b64 = (value: string | ArrayBuffer) =>
	btoa(typeof value === 'string' ? value : String.fromCharCode(...new Uint8Array(value)))
		.replace(/=/g, '')
		.replace(/\+/g, '-')
		.replace(/\//g, '_')
async function auth(id = 42, studio = true) {
	const payload = b64(
		JSON.stringify({
			sub: String(id),
			role: studio ? ['betastudio'] : [],
			exp: Date.now() / 1000 + 600,
		})
	)
	const input = b64(JSON.stringify({ alg: 'HS256', typ: 'JWT' })) + '.' + payload
	const secret = await crypto.subtle.importKey(
		'raw',
		new TextEncoder().encode('test-key'),
		{ name: 'HMAC', hash: 'SHA-256' },
		false,
		['sign']
	)
	return {
		Authorization:
			'Bearer ' +
			input +
			'.' +
			b64(await crypto.subtle.sign('HMAC', secret, new TextEncoder().encode(input))),
	}
}
beforeAll(async () => {
	await adminSecretsStore(env.JWT_SECRET).create('test-key')
	env.CLOUD_BUILD_KEY = key
	env.CLOUD_BUILD_TARGETS = '0'
	for (const sql of [
		...ROOM_SCHEMA_DDL,
		...SUBROOM_SCHEMA_DDL,
		...STUDIO_CLOUD_BUILD_SCHEMA_DDL,
		...UNITY_ASSET_SCHEMA_DDL,
		CLOUD_JOB_SCHEMA,
	])
		await env.DB.prepare(sql).run()
	await env.DB.prepare('INSERT INTO room (data) VALUES (?)')
		.bind(
			JSON.stringify({
				RoomId: 3000,
				Name: 'CloudTest',
				CreatorAccountId: 42,
				Roles: [],
				Tags: [],
				Accessibility: 1,
			})
		)
		.run()
	await env.DB.prepare(
		'INSERT INTO subroom (sub_room_id,room_id,data,current_save_id) VALUES (3001,3000,?,3002)'
	)
		.bind(JSON.stringify({ Name: 'Home' }))
		.run()
	await env.DB.prepare(
		'INSERT INTO subroom_save (sub_room_data_save_id,sub_room_id,data) VALUES (3002,3001,?)'
	)
		.bind(JSON.stringify({ StudioSourceAsset: { Filename: 'manifest' }, UnitySubAssets: [] }))
		.run()
	await env.CDN_ASSETS.put(
		'roomunityasset/manifest',
		JSON.stringify({
			Version: 3,
			MainSceneProjectRelativePath: 'Assets/Test.unity',
			ExportPartitionVersion: 3,
			Files: [{ n: 'a'.repeat(40), p: 'Assets/Test.unity' }],
			Exports: [],
		})
	)
})
beforeEach(async () => {
	await env.DB.prepare('DELETE FROM studio_cloud_build_job').run()
	await env.DB.prepare('DELETE FROM studio_cloud_build').run()
	await env.CDN_ASSETS.put(
		'roomunityasset/manifest',
		JSON.stringify({
			Version: 3,
			MainSceneProjectRelativePath: 'Assets/Test.unity',
			ExportPartitionVersion: 3,
			Files: [{ n: 'a'.repeat(40), p: 'Assets/Test.unity' }],
			Exports: [],
		})
	)
})
async function create(id = 42, studio = true, extra = {}) {
	return SELF.fetch(origin + '/cloud-builds/create', {
		method: 'POST',
		headers: await auth(id, studio),
		body: new URLSearchParams({
			roomId: '3000',
			subRoomId: '3001',
			subRoomDataSaveId: '3002',
			autoPublish: 'false',
			...extra,
		}),
	})
}
async function claim() {
	const response = await SELF.fetch(origin + '/internal/cloud-builds/claim', {
		method: 'POST',
		headers: worker,
	})
	expect(response.status).toBe(200)
	return response.json<{
		job: {
			buildId: string
			unityAssetId: string
			targets: number[]
			exports: Array<{ e: string; u: string }>
		}
		leaseToken: string
		validationAccessToken: string
	}>()
}
it('rejects malformed source manifests and preserves compact SDK export identifiers', async () => {
	for (const manifest of [
		null,
		{ Files: [null] },
		{
			Version: 3,
			ExportPartitionVersion: 3,
			MainSceneProjectRelativePath: 'Assets/Test.unity',
			Files: [{ p: 'Assets/../Test.unity', n: 'a'.repeat(40) }],
		},
	]) {
		await env.CDN_ASSETS.put('roomunityasset/manifest', JSON.stringify(manifest))
		expect((await create()).status).toBe(400)
	}
	await env.CDN_ASSETS.put(
		'roomunityasset/manifest',
		JSON.stringify({
			Version: 3,
			ExportPartitionVersion: 3,
			MainSceneProjectRelativePath: 'Assets/Test.unity',
			Files: [{ p: 'Assets/Test.unity', n: 'a'.repeat(40) }],
			Exports: [{ e: 'object-1', d: [] }],
		})
	)
	expect((await create()).status).toBe(200)
	const lease = await claim()
	expect(lease.job.exports).toEqual([
		{ e: 'object-1', u: expect.stringMatching(/^[0-9a-f-]{36}$/) },
	])
})
it('requires Studio authorization and room ownership', async () => {
	expect((await create(42, false)).status).toBe(403)
	expect((await create(99)).status).toBe(403)
	expect((await create(42, true, { subRoomDataSaveId: '9999' })).status).toBe(400)
})
it('queues a numeric SDK build ID and returns the exact saved build contract', async () => {
	const response = await create()
	expect(response.status).toBe(200)
	const result = await response.json<{
		value: { cloudBuildId: string; completedAt: null; unityAssetId: string }
	}>()
	expect(result.value.cloudBuildId).toMatch(/^\d+$/)
	expect(BigInt(result.value.cloudBuildId)).toBeLessThan(1n << 63n)
	expect(result.value.completedAt).toBeNull()
	expect(
		(await (await create()).json<{ value: { cloudBuildId: string } }>()).value.cloudBuildId
	).toBe(result.value.cloudBuildId)
	const status = await SELF.fetch(
		origin + '/cloud-builds?cloudBuildId=' + result.value.cloudBuildId
	)
	expect((await status.json<{ value: unknown }>()).value).toEqual(result.value)
	const lease = await claim()
	expect(lease.job.buildId).toBe(result.value.cloudBuildId)
	expect(lease.job.targets).toEqual([0])
	const validation = JSON.parse(
		atob(lease.validationAccessToken.split('.')[1].replace(/-/g, '+').replace(/_/g, '/'))
	)
	expect(validation.aud).toBe('studio-build-validation')
	expect(validation.sub).toBeUndefined()
	expect(validation.buildId).toBe(lease.job.buildId)
	const wrong = await SELF.fetch(origin + `/internal/cloud-builds/${lease.job.buildId}/heartbeat`, {
		method: 'POST',
		headers: { ...worker, 'Content-Type': 'application/json' },
		body: JSON.stringify({ leaseToken: 'wrong' }),
	})
	expect(await wrong.json()).toEqual({ active: false })
	const form = new FormData()
	form.set('leaseToken', lease.leaseToken)
	form.set('error', 'Real compiler failure')
	expect(
		(
			await SELF.fetch(origin + `/internal/cloud-builds/${lease.job.buildId}/finish`, {
				method: 'POST',
				headers: worker,
				body: form,
			})
		).status
	).toBe(200)
	const failed = await SELF.fetch(origin + '/cloud-builds?cloudBuildId=' + lease.job.buildId)
	expect((await failed.json<{ value: { error: string; completedAt: string } }>()).value.error).toBe(
		'Real compiler failure'
	)
})
it('reclaims expired jobs with a new lease and rejects the stale worker', async () => {
	await create()
	const first = await claim()
	await env.DB.prepare(
		"UPDATE studio_cloud_build_job SET lease_until='2000-01-01' WHERE cloud_build_id=?"
	)
		.bind(first.job.buildId)
		.run()
	const second = await claim()
	expect(second.job.buildId).toBe(first.job.buildId)
	expect(second.leaseToken).not.toBe(first.leaseToken)
	const form = new FormData()
	form.set('leaseToken', first.leaseToken)
	form.set('error', 'stale worker')
	expect(
		(
			await SELF.fetch(origin + `/internal/cloud-builds/${first.job.buildId}/finish`, {
				method: 'POST',
				headers: worker,
				body: form,
			})
		).status
	).toBe(409)
})
it('gates worker dispatch, rejects incomplete artifacts, and stores real-format version 5 bundles', async () => {
	expect(
		(await SELF.fetch(origin + '/internal/cloud-builds/claim', { method: 'POST' })).status
	).toBe(401)
	await create(42, true, { autoPublish: 'true' })
	const lease = await claim()
	await env.DB.prepare(
		"INSERT INTO subroom_save (sub_room_data_save_id,sub_room_id,data) VALUES (3003,3001,'{}') ON CONFLICT DO NOTHING"
	).run()
	await env.DB.prepare('UPDATE subroom SET staged_save_id=3003 WHERE sub_room_id=3001').run()
	const form = new FormData()
	form.set('leaseToken', lease.leaseToken)
	form.set('artifacts', '[]')
	expect(
		(
			await SELF.fetch(origin + `/internal/cloud-builds/${lease.job.buildId}/finish`, {
				method: 'POST',
				headers: worker,
				body: form,
			})
		).status
	).toBe(400)
	form.set(
		'artifacts',
		JSON.stringify([
			{
				field: 'bundle0',
				unityAssetId: lease.job.unityAssetId,
				target: 0,
				kind: 'main',
				version: 5,
			},
		])
	)
	form.set('bundle0', new File(['UnityFS\0test-fixture-bundle'], 'bundle.assetbundle'))
	expect(
		(
			await SELF.fetch(origin + `/internal/cloud-builds/${lease.job.buildId}/finish`, {
				method: 'POST',
				headers: worker,
				body: form,
			})
		).status
	).toBe(200)
	const row = await env.DB.prepare(
		'SELECT version,hash,filename FROM unity_asset WHERE unity_asset_id=?'
	)
		.bind(lease.job.unityAssetId)
		.first<{ version: number; hash: string; filename: string }>()
	expect(row?.version).toBe(5)
	expect(row?.hash).toBeTruthy()
	expect(await (await env.CDN_ASSETS.get('room/' + row!.filename))?.text()).toBe(
		'UnityFS\0test-fixture-bundle'
	)
	const save = await env.DB.prepare(
		"SELECT json_extract(data,'$.UnityAssetId') AS asset FROM subroom_save WHERE sub_room_data_save_id=3002"
	).first<{ asset: string }>()
	expect(save?.asset).toBe(lease.job.unityAssetId)
	expect(
		await env.DB.prepare(
			'SELECT current_save_id,staged_save_id FROM subroom WHERE sub_room_id=3001'
		).first()
	).toMatchObject({ current_save_id: 3002, staged_save_id: 3003 })
})
it('cancels queued jobs without allowing a late worker to complete them', async () => {
	const response = await create()
	const { value } = await response.json<{ value: { cloudBuildId: string } }>()
	const lease = await claim()
	expect(lease.job.buildId).toBe(value.cloudBuildId)
	const cancel = await SELF.fetch(origin + '/cloud-builds/cancel', {
		method: 'POST',
		headers: await auth(),
		body: new URLSearchParams({ cloudBuildId: value.cloudBuildId }),
	})
	expect(cancel.status).toBe(200)
	const form = new FormData()
	form.set('leaseToken', lease.leaseToken)
	form.set('error', 'late failure')
	expect(
		(
			await SELF.fetch(origin + `/internal/cloud-builds/${lease.job.buildId}/finish`, {
				method: 'POST',
				headers: worker,
				body: form,
			})
		).status
	).toBe(409)
})

async function finish(lease: Awaited<ReturnType<typeof claim>>, artifacts: string) {
	const form = new FormData()
	form.set('leaseToken', lease.leaseToken)
	form.set('artifacts', artifacts)
	form.set('bundle', new File(['UnityFS\0test-fixture-bundle'], 'bundle.assetbundle'))
	return SELF.fetch(origin + `/internal/cloud-builds/${lease.job.buildId}/finish`, {
		method: 'POST',
		headers: worker,
		body: form,
	})
}
function artifacts(lease: Awaited<ReturnType<typeof claim>>) {
	return JSON.stringify([
		{ field: 'bundle', unityAssetId: lease.job.unityAssetId, target: 0, kind: 'main', version: 5 },
	])
}
it('rejects malformed artifact metadata without consuming the lease', async () => {
	await create()
	const lease = await claim()
	for (const value of ['{', 'null', '{}', '[null]', '[42]', '[{"field":false}]'])
		expect((await finish(lease, value)).status).toBe(400)
	expect((await finish(lease, artifacts(lease))).status).toBe(200)
})
it('publishes a built staged save and marks completion in one transaction', async () => {
	await env.DB.prepare(
		'UPDATE subroom SET current_save_id=3003,staged_save_id=3002 WHERE sub_room_id=3001'
	).run()
	await create(42, true, { autoPublish: 'true' })
	const lease = await claim()
	expect((await finish(lease, artifacts(lease))).status).toBe(200)
	expect(
		await env.DB.prepare(
			'SELECT current_save_id,staged_save_id FROM subroom WHERE sub_room_id=3001'
		).first()
	).toEqual({ current_save_id: 3002, staged_save_id: null })
})
it('rolls back completion and uploaded objects when room publication fails, allowing retry', async () => {
	await env.DB.prepare(
		"UPDATE room SET data=json_remove(data,'$.BecameRRStudioRoomAt') WHERE room_id=3000"
	).run()
	await env.DB.prepare(
		"CREATE TRIGGER fail_studio_publication BEFORE UPDATE ON room BEGIN SELECT RAISE(ABORT, 'publication fixture failure'); END"
	).run()
	await create(42, true, { autoPublish: 'true' })
	const lease = await claim()
	try {
		expect((await finish(lease, artifacts(lease))).status).toBe(500)
		expect(
			await env.DB.prepare('SELECT completed_at FROM studio_cloud_build WHERE cloud_build_id=?')
				.bind(lease.job.buildId)
				.first()
		).toEqual({ completed_at: '' })
		expect(
			await env.DB.prepare('SELECT status FROM studio_cloud_build_job WHERE cloud_build_id=?')
				.bind(lease.job.buildId)
				.first()
		).toEqual({ status: 'building' })
		expect(
			await env.CDN_ASSETS.get(`roomunityasset/studio-builds/${lease.job.buildId}/server-data.json`)
		).toBeNull()
		expect(
			await env.DB.prepare('SELECT unity_asset_id FROM unity_asset WHERE unity_asset_id=?')
				.bind(lease.job.unityAssetId)
				.first()
		).toBeNull()
	} finally {
		await env.DB.prepare('DROP TRIGGER fail_studio_publication').run()
	}
	expect((await finish(lease, artifacts(lease))).status).toBe(200)
})
it('fails a repeatedly expired job instead of leaving it queued forever', async () => {
	await create()
	const lease = await claim()
	await env.DB.prepare(
		"UPDATE studio_cloud_build_job SET attempts=3,lease_until='2000-01-01' WHERE cloud_build_id=?"
	)
		.bind(lease.job.buildId)
		.run()
	expect(await claim()).toBeNull()
	expect(
		await env.DB.prepare(
			'SELECT status,lease_token FROM studio_cloud_build_job WHERE cloud_build_id=?'
		)
			.bind(lease.job.buildId)
			.first()
	).toEqual({ status: 'failed', lease_token: null })
	const status = await SELF.fetch(origin + '/cloud-builds?cloudBuildId=' + lease.job.buildId)
	expect((await status.json<{ value: { error: string } }>()).value.error).toBe(
		'Build worker lease expired.'
	)
})

it('reuses one queued build when create requests arrive concurrently', async () => {
	const responses = await Promise.all([create(), create(), create()])
	const ids = await Promise.all(
		responses.map(async (response) => {
			expect(response.status).toBe(200)
			return (await response.json<{ value: { cloudBuildId: string } }>()).value.cloudBuildId
		})
	)
	expect(new Set(ids).size).toBe(1)
	expect(
		await env.DB.prepare('SELECT COUNT(*) AS count FROM studio_cloud_build_job').first()
	).toEqual({ count: 1 })
})

it('does not complete a build whose submitted save was deleted during compilation', async () => {
	await create()
	const lease = await claim()
	const save = await env.DB.prepare(
		'SELECT data FROM subroom_save WHERE sub_room_data_save_id=3002'
	).first<{ data: string }>()
	await env.DB.prepare('DELETE FROM subroom_save WHERE sub_room_data_save_id=3002').run()
	try {
		expect((await finish(lease, artifacts(lease))).status).toBe(409)
		expect(
			await env.DB.prepare('SELECT status FROM studio_cloud_build_job WHERE cloud_build_id=?')
				.bind(lease.job.buildId)
				.first()
		).toEqual({ status: 'failed' })
		expect(
			await env.DB.prepare('SELECT unity_asset_id FROM unity_asset WHERE unity_asset_id=?')
				.bind(lease.job.unityAssetId)
				.first()
		).toBeNull()
		expect(
			await env.CDN_ASSETS.get(`roomunityasset/studio-builds/${lease.job.buildId}/server-data.json`)
		).toBeNull()
	} finally {
		await env.DB.prepare(
			'INSERT INTO subroom_save (sub_room_data_save_id,sub_room_id,data) VALUES (3002,3001,?)'
		)
			.bind(save!.data)
			.run()
	}
})
