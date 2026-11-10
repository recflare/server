import { adminSecretsStore, env, SELF } from 'cloudflare:test'
import { beforeAll, beforeEach, expect, it } from 'vitest'

import {
	AVATAR_STUDIO_SCHEMA,
	avatarSaveDto,
	avatarStudioSave,
	publishAvatarSave,
	ROOM_SCHEMA_DDL,
	STUDIO_CLOUD_BUILD_SCHEMA_DDL,
	UNITY_ASSET_SCHEMA_DDL,
} from '@repo/domain'
import { generateToken } from '@repo/jwt'

import { SCHEMA_DDL, toQuestCustomAvatarItem } from '../../../../api/src/custom-avatar-items-db'
import { UPLOAD_SCHEMA } from '../../artifact-multipart'
import { CLOUD_JOB_SCHEMA } from '../../cloud-builds'

import type { Env } from '../../context'

declare module 'cloudflare:test' {
	interface ProvidedEnv extends Env {}
}
const origin = 'https://example.com',
	itemId = '11111111-1111-1111-1111-111111111111',
	assetId = '22222222-2222-2222-2222-222222222222'
const worker = { Authorization: 'Bearer private-avatar-worker-key' }
async function auth(id = 42, roles = ['betastudio']) {
	return {
		Authorization: 'Bearer ' + (await generateToken(String(id), 'fixture', 0, 'test-key', roles)),
	}
}
const manifest = {
	Version: 3,
	MainPrefabProjectRelativePath: 'Assets/Hat.prefab',
	Files: [{ n: 'a'.repeat(40), p: 'Assets/Hat.prefab' }],
}
beforeAll(async () => {
	await adminSecretsStore(env.JWT_SECRET).create('test-key')
	await adminSecretsStore(env.CLOUD_BUILD_KEY).create('private-avatar-worker-key')
	env.CLOUD_BUILD_TARGETS = '0,2'
	for (const sql of [
		...SCHEMA_DDL,
		...ROOM_SCHEMA_DDL,
		...AVATAR_STUDIO_SCHEMA,
		...STUDIO_CLOUD_BUILD_SCHEMA_DDL,
		...UNITY_ASSET_SCHEMA_DDL,
		CLOUD_JOB_SCHEMA,
		UPLOAD_SCHEMA,
	])
		await env.DB.prepare(sql).run()
})
beforeEach(async () => {
	for (const table of [
		'studio_cloud_build_job',
		'studio_cloud_build',
		'studio_avatar_build',
		'unity_asset',
		'avatar_studio_save',
		'avatar_studio_access',
		'custom_avatar_item',
	])
		await env.DB.prepare('DELETE FROM ' + table).run()
	await env.DB.prepare("INSERT INTO avatar_studio_access VALUES (42,1,'now','now')").run()
	await env.DB.prepare('INSERT INTO custom_avatar_item(data) VALUES (?)')
		.bind(
			JSON.stringify({
				CustomAvatarItemId: itemId,
				CreatorAccountId: 42,
				OutfitType: 0,
				Accessibility: 0,
				Name: 'Hat',
				CurrentSaves: [],
			})
		)
		.run()
	await env.DB.prepare(
		"INSERT INTO avatar_studio_save(id,item_id,body_type,unity_asset_id,source_filename,source_hash,thumbnail,configuration,update_current,created_at) VALUES (1,?,1,?,'source','hash','thumb','{}',1,'2026-10-18')"
	)
		.bind(itemId, assetId)
		.run()
	await env.CDN_ASSETS.put('avatarunityasset/source', JSON.stringify(manifest))
})
async function create(id = 42) {
	return SELF.fetch(origin + '/cloud-builds/custom-avatar-item/' + itemId + '/save/1', {
		method: 'POST',
		headers: await auth(id),
		body: new URLSearchParams({ pipelineVersion: '2', autoPublish: 'true' }),
	})
}
async function claim() {
	const r = await SELF.fetch(origin + '/internal/cloud-builds/claim', {
		method: 'POST',
		headers: worker,
	})
	return r.json<{ job: { buildId: string; kind: string; manifest: unknown }; leaseToken: string }>()
}
function artifacts(lease: { leaseToken: string }, materialVersion = 6) {
	const form = new FormData()
	form.set('leaseToken', lease.leaseToken)
	const entries = []
	for (const target of [0, 2])
		for (const kind of ['main', 'material', 'stripped']) {
			const field = `bundle${target}${kind}`
			form.set(
				field,
				new File(['UnityFS\0avatar fixture ' + target + kind], field + '.assetbundle')
			)
			entries.push({
				field,
				unityAssetId: assetId,
				target,
				kind,
				version: kind === 'material' ? materialVersion : 5,
			})
		}
	form.set('artifacts', JSON.stringify(entries))
	return form
}
it('authorizes per-account access and rejects builds from other owners', async () => {
	expect((await SELF.fetch(origin + '/access/override/42')).status).toBe(401)
	expect(
		(await SELF.fetch(origin + '/access/override/42', { headers: await auth(43) })).status
	).toBe(403)
	expect(
		await (await SELF.fetch(origin + '/access/override/42', { headers: await auth() })).json()
	).toMatchObject({ AccountId: 42, StudioAccess: 1, AvatarStudioAccess: 1 })
	expect(
		await (await SELF.fetch(origin + '/access/override/42', { headers: await auth(42, []) })).json()
	).toMatchObject({ AvatarStudioAccess: 0 })
	expect((await create(43)).status).toBe(403)
})
it('serializes SQLite and ISO access timestamps as SDK-compatible UTC DateTimes', async () => {
	await env.DB.prepare(
		'UPDATE avatar_studio_access SET flags=15,created_at=?,modified_at=? WHERE account_id=42'
	)
		.bind('2026-10-19T00:45:00.372Z', '2026-10-19 16:44:56')
		.run()
	expect(
		await (await SELF.fetch(origin + '/access/override/42', { headers: await auth() })).json()
	).toMatchObject({
		AvatarStudioAccess: 15,
		CreatedAt: '2026-10-19T00:45:00.372Z',
		ModifiedAt: '2026-10-19T16:44:56.000Z',
	})
})
it('builds and publishes prefab revisions with real SDK main/material version distinctions', async () => {
	expect((await create()).status).toBe(200)
	const lease = await claim()
	expect(lease.job.kind).toBe('avatar')
	expect(lease.job.manifest).toMatchObject(manifest)
	const finish = () => origin + '/internal/cloud-builds/' + lease.job.buildId + '/finish'
	expect(
		(await SELF.fetch(finish(), { method: 'POST', headers: worker, body: artifacts(lease, 5) }))
			.status
	).toBe(400)
	expect(
		(await SELF.fetch(finish(), { method: 'POST', headers: worker, body: artifacts(lease) })).status
	).toBe(200)
	const row = await env.DB.prepare('SELECT data FROM custom_avatar_item').first<{ data: string }>()
	const item = JSON.parse(row!.data)
	expect(item.CurrentSaves).toHaveLength(1)
	expect(item.CurrentSaves[0]).toMatchObject({
		CustomAvatarItemSaveId: 1,
		BodyType: 1,
		OutfitType: 0,
	})
	expect(item.CurrentSaves[0].UnityAsset).toMatch(/^studio-avatar\//)
	expect(item.CurrentSaves[0].UnityAsset2).toContain('.material.assetbundle')
	expect(item.CurrentSaves[0]).not.toHaveProperty('SourceUnityAssetFilename')
	const saved = await avatarStudioSave(env.DB, itemId, 1),
		dto = await avatarSaveDto(env.DB, saved!)
	expect(dto.BakedAssets).toHaveLength(4)
	expect(dto.BakedAssets.map((a) => a.Version).sort()).toEqual([5, 5, 6, 6])
	const quest = toQuestCustomAvatarItem(item).CurrentSaves[0]
	expect(quest.UnityAssetHash).toBe(
		dto.BakedAssets.find((a) => a.Target === 2 && a.Version === 5)?.Hash
	)
	expect(quest.UnityAssetHash).not.toBe(item.CurrentSaves[0].UnityAssetHash)
	expect((await env.CDN_ASSETS.get('avatar/' + dto.UnityAsset))?.size).toBeGreaterThan(8)
	expect(
		(await SELF.fetch(finish(), { method: 'POST', headers: worker, body: artifacts(lease) })).status
	).toBe(409)
	const count = await SELF.fetch(origin + '/cloud-builds/get-build-count-for-user', {
		headers: await auth(),
	})
	expect(await count.json()).toMatchObject({
		value: { subRoomTotalBuildCount: 0, avatarItemTotalBuildCount: 1 },
	})
})
it('rejects source code paths and cannot cancel another account’s build', async () => {
	await env.CDN_ASSETS.put(
		'avatarunityasset/source',
		JSON.stringify({ ...manifest, Files: [null] })
	)
	expect((await create()).status).toBe(400)
	await env.CDN_ASSETS.put(
		'avatarunityasset/source',
		JSON.stringify({
			...manifest,
			Files: [...manifest.Files, { n: 'a'.repeat(40), p: 'Assets/Code.cs' }],
		})
	)
	expect((await create()).status).toBe(400)
	await env.CDN_ASSETS.put('avatarunityasset/source', JSON.stringify(manifest))
	await create()
	const lease = await claim()
	expect(
		(
			await SELF.fetch(origin + '/cloud-builds/cancel', {
				method: 'PUT',
				body: new URLSearchParams({ cloudBuildId: lease.job.buildId }),
			})
		).status
	).toBe(401)
	expect(
		(
			await SELF.fetch(origin + '/cloud-builds/cancel', {
				method: 'PUT',
				headers: await auth(43),
				body: new URLSearchParams({ cloudBuildId: lease.job.buildId }),
			})
		).status
	).toBe(404)
	expect(
		(
			await SELF.fetch(origin + '/cloud-builds/cancel', {
				method: 'PUT',
				headers: await auth(),
				body: new URLSearchParams({ cloudBuildId: lease.job.buildId }),
			})
		).status
	).toBe(200)
	expect(
		(
			await SELF.fetch(origin + '/internal/cloud-builds/' + lease.job.buildId + '/finish', {
				method: 'POST',
				headers: worker,
				body: artifacts(lease),
			})
		).status
	).toBe(409)
})
it('does not publish a deleted item or an older revision after a newer save', async () => {
	await create()
	const lease = await claim()
	await env.DB.prepare(
		'INSERT INTO avatar_studio_save(item_id,body_type,unity_asset_id,source_filename,source_hash,thumbnail,configuration,created_at) SELECT item_id,body_type,unity_asset_id,source_filename,source_hash,thumbnail,configuration,created_at FROM avatar_studio_save WHERE id=1'
	).run()
	expect(
		(
			await SELF.fetch(origin + '/internal/cloud-builds/' + lease.job.buildId + '/finish', {
				method: 'POST',
				headers: worker,
				body: artifacts(lease),
			})
		).status
	).toBe(200)
	const item = await env.DB.prepare('SELECT data FROM custom_avatar_item').first<{ data: string }>()
	expect(JSON.parse(item!.data).CurrentSaves).toEqual([])
	await env.DB.prepare('DELETE FROM studio_cloud_build_job').run()
	await env.DB.prepare('DELETE FROM studio_cloud_build').run()
	await env.DB.prepare('DELETE FROM studio_avatar_build').run()
	await create()
	const deleted = await claim()
	await env.DB.prepare('DELETE FROM custom_avatar_item').run()
	expect(
		(
			await SELF.fetch(origin + '/internal/cloud-builds/' + deleted.job.buildId + '/finish', {
				method: 'POST',
				headers: worker,
				body: artifacts(deleted),
			})
		).status
	).toBe(409)
})

it('deduplicates concurrent avatar requests and allows a new build after failure', async () => {
	const responses = await Promise.all([create(), create(), create()])
	const ids = await Promise.all(
		responses.map(async (response) => {
			expect(response.status).toBe(200)
			return (await response.json<{ value: { cloudBuildId: string } }>()).value.cloudBuildId
		})
	)
	expect(new Set(ids).size).toBe(1)
	for (const table of ['studio_cloud_build', 'studio_avatar_build', 'studio_cloud_build_job'])
		expect(await env.DB.prepare('SELECT COUNT(*) AS n FROM ' + table).first()).toEqual({ n: 1 })
	await env.DB.prepare("UPDATE studio_cloud_build_job SET status='failed'").run()
	expect(
		(await (await create()).json<{ value: { cloudBuildId: string } }>()).value.cloudBuildId
	).not.toBe(ids[0])
})
it.each([false, true])(
	'checks automatic avatar revision ordering in the write, including CAS retry=%s, preserving explicit restore',
	async (retry) => {
		await env.DB.prepare("INSERT INTO unity_asset VALUES (?,0,5,'main','old.bundle','hash')")
			.bind(assetId)
			.run()
		let intercepted = false
		const DB = new Proxy(env.DB, {
			get(target, key) {
				if (key === 'prepare')
					return (sql: string) => {
						const wrap = (statement: D1PreparedStatement): D1PreparedStatement =>
							new Proxy(statement, {
								get(stmt, method) {
									if (method === 'bind') return (...values: unknown[]) => wrap(stmt.bind(...values))
									if (method === 'run' && sql.startsWith('UPDATE custom_avatar_item'))
										return async () => {
											if (!intercepted) {
												intercepted = true
												await target
													.prepare(
														"INSERT INTO avatar_studio_save(id,item_id,body_type,unity_asset_id,source_filename,source_hash,thumbnail,configuration,created_at) SELECT 2,item_id,body_type,'new-identity',source_filename,source_hash,thumbnail,configuration,created_at FROM avatar_studio_save WHERE id=1"
													)
													.run()
												if (retry)
													await target
														.prepare(
															"UPDATE custom_avatar_item SET data=json_set(data,'$.Name','Concurrent metadata')"
														)
														.run()
											}
											return stmt.run()
										}
									const value = Reflect.get(stmt, method)
									return typeof value === 'function' ? value.bind(stmt) : value
								},
							})
						return wrap(target.prepare(sql))
					}
				const value = Reflect.get(target, key)
				return typeof value === 'function' ? value.bind(target) : value
			},
		})
		expect(await publishAvatarSave(DB, itemId, 1, true)).toBe(false)
		expect(intercepted).toBe(true)
		let item = JSON.parse(
			(await env.DB.prepare('SELECT data FROM custom_avatar_item').first<{ data: string }>())!.data
		)
		expect(item.CurrentSaves).toEqual([])
		expect(await publishAvatarSave(env.DB, itemId, 1)).toBe(true)
		item = JSON.parse(
			(await env.DB.prepare('SELECT data FROM custom_avatar_item').first<{ data: string }>())!.data
		)
		expect(item.CurrentSaves[0].CustomAvatarItemSaveId).toBe(1)
		if (retry) expect(item.Name).toBe('Concurrent metadata')
	}
)
