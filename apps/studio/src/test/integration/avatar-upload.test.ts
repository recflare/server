import { adminSecretsStore, env, SELF } from 'cloudflare:test'
import { beforeAll, expect, it } from 'vitest'

import { AVATAR_STUDIO_SCHEMA, UNITY_ASSET_SCHEMA_DDL } from '@repo/domain'
import { SCHEMA_DDL as ACCOUNT_SCHEMA_DDL, updateAccount } from '@repo/domain/src/accounts-db'
import { AUDIT_LOG_SCHEMA_DDL } from '@repo/domain/src/audit-db'
import { generateToken } from '@repo/jwt'

import { SCHEMA_DDL as CUSTOM_AVATAR_ITEM_SCHEMA_DDL } from '../../../../api/src/custom-avatar-items-db'
import { PLATFORM_SCHEMA_DDL } from '../../../../auth/src/platform-db'

import type { Env } from '../../context'

declare module 'cloudflare:test' {
	interface ProvidedEnv extends Env {}
}

const tokenFor = async (id: number, roles: string[]) =>
	generateToken(String(id), 'fixture', 0, 'test-key', roles)

beforeAll(async () => {
	await adminSecretsStore(env.JWT_SECRET).create('test-key')
	for (const sql of [
		...ACCOUNT_SCHEMA_DDL,
		...PLATFORM_SCHEMA_DDL,
		...AUDIT_LOG_SCHEMA_DDL,
		...CUSTOM_AVATAR_ITEM_SCHEMA_DDL,
		...AVATAR_STUDIO_SCHEMA,
		...UNITY_ASSET_SCHEMA_DDL,
	])
		await env.DB.prepare(sql).run()
})

// The website's avatar bundle upload: it writes what a finished Studio build writes, and
// publishes straight away.

const UNITY_FS = (extra = 16) =>
	new Uint8Array([
		...new TextEncoder().encode('UnityFS\0'),
		...Array.from({ length: extra }, () => 7),
	])
const PNG = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10, 0, 0, 0, 0])

/** One body-type set's fields, prefixed `v<index>_` the way the form names them. */
function avatarSet(index: number, bodyType: number, overrides: Record<string, string | File> = {}) {
	const fields: Record<string, string | File> = {
		bodyType: String(bodyType),
		thumbnail: new File([PNG], 'thumb.png', { type: 'image/png' }),
	}
	for (const field of ['windowsMain', 'windowsMaterial', 'androidMain', 'androidMaterial']) {
		fields[field] = new File([UNITY_FS()], `${field}.assetbundle`)
	}
	return Object.fromEntries(
		Object.entries({ ...fields, ...overrides }).map(([key, value]) => [`v${index}_${key}`, value])
	)
}

function avatarUploadForm(
	overrides: Record<string, string | File> = {},
	sets: Array<Record<string, string | File>> = [avatarSet(0, 4)]
): FormData {
	const form = new FormData()
	form.set('name', 'Web Hat')
	form.set('description', 'Made on the site')
	form.set('outfitType', '100')
	form.set('price', '5')
	for (const set of sets) for (const [key, value] of Object.entries(set)) form.set(key, value)
	for (const [key, value] of Object.entries(overrides)) form.set(key, value)
	return form
}

async function uploadAvatar(accountId: number, form: FormData, roles = ['gameClient']) {
	return SELF.fetch('https://example.com/avatar-items', {
		method: 'POST',
		headers: { authorization: `Bearer ${await tokenFor(accountId, roles)}` },
		body: form,
	})
}

async function grantAvatarUpload(accountId: number) {
	await updateAccount(env.DB, accountId, { username: `Uploader${accountId}`, hasStudio: true })
	await env.DB.prepare(
		'INSERT OR REPLACE INTO avatar_studio_access(account_id,flags,created_at,modified_at) VALUES (?,?,?,?)'
	)
		.bind(accountId, 1, 'now', 'now')
		.run()
}

it('refuses an avatar upload with no session, and from an account that is not on the list', async () => {
	const anonymous = await SELF.fetch('https://example.com/avatar-items', {
		method: 'POST',
		body: avatarUploadForm(),
	})
	expect(anonymous.status).toBe(401)

	await updateAccount(env.DB, 8701, { username: 'NoAccess' })
	const refused = await uploadAvatar(8701, avatarUploadForm())
	expect(refused.status).toBe(403)
	expect(
		await env.DB.prepare(
			'SELECT COUNT(*) AS n FROM custom_avatar_item WHERE creator_account_id=8701'
		).first('n')
	).toBe(0)
})

it('publishes an uploaded avatar bundle pair as a custom avatar item', async () => {
	await grantAvatarUpload(8702)
	const res = await uploadAvatar(8702, avatarUploadForm())
	expect(res.status).toBe(200)
	const { value } = (await res.json()) as { value: { customAvatarItemId: string } }

	const row = await env.DB.prepare(
		'SELECT data FROM custom_avatar_item WHERE custom_avatar_item_id=?'
	)
		.bind(value.customAvatarItemId)
		.first<{ data: string }>()
	const item = JSON.parse(row!.data)
	expect(item).toMatchObject({
		Name: 'Web Hat',
		CreatorAccountId: 8702,
		OutfitType: 100,
		Price: 5,
		Accessibility: 1,
		IsStudioAuthored: true,
	})
	// Published: the current save carries the Windows main bundle the client downloads.
	expect(item.CurrentSaves).toHaveLength(1)
	expect(item.CurrentSaves[0].UnityAsset).toContain(`studio-avatar/${value.customAvatarItemId}/`)

	const assets = await env.DB.prepare(
		'SELECT target,version,kind,filename FROM unity_asset WHERE unity_asset_id=? ORDER BY target,kind'
	)
		.bind(item.CurrentSaves[0].UnityAssetId)
		.all<{ target: number; version: number; kind: string; filename: string }>()
	expect(assets.results.map((a) => [a.target, a.kind, a.version])).toEqual([
		[0, 'main', 5],
		[0, 'material', 6],
		[2, 'main', 5],
		[2, 'material', 6],
	])
	// Every bundle is in the bucket the game reads, Android's under `quest/`.
	for (const a of assets.results) {
		expect(await env.CDN_ASSETS.head(`avatar/${a.filename}`)).not.toBeNull()
		expect(a.filename.startsWith('quest/')).toBe(a.target === 2)
	}
	expect(await env.IMAGES.head(item.ThumbnailImageFilename)).not.toBeNull()
})

it('rejects an avatar upload whose bundle is not a Unity bundle, and stores nothing', async () => {
	await grantAvatarUpload(8703)
	const res = await uploadAvatar(
		8703,
		avatarUploadForm({
			v0_androidMain: new File([new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8, 9])], 'x.bundle'),
		})
	)
	expect(res.status).toBe(400)
	expect(
		await env.DB.prepare(
			'SELECT COUNT(*) AS n FROM custom_avatar_item WHERE creator_account_id=8703'
		).first('n')
	).toBe(0)
	expect((await env.CDN_ASSETS.list({ prefix: 'avatar/' })).objects.length).toBe(
		(await env.DB.prepare('SELECT COUNT(*) AS n FROM unity_asset').first<number>('n'))!
	)
})

it('keeps the developer-only avatar slots to developers', async () => {
	await grantAvatarUpload(8704)
	expect((await uploadAvatar(8704, avatarUploadForm({ outfitType: '104' }))).status).toBe(403)
	expect(
		(await uploadAvatar(8704, avatarUploadForm({ outfitType: '104' }), ['gameClient', 'developer']))
			.status
	).toBe(200)
	// Badges are images, not bundles, and have their own flow in Studio.
	expect((await uploadAvatar(8704, avatarUploadForm({ outfitType: '1000' }))).status).toBe(400)
})

it('publishes one item with a save per body type', async () => {
	await grantAvatarUpload(8705)
	const res = await uploadAvatar(8705, avatarUploadForm({}, [avatarSet(0, 1), avatarSet(1, 2)]))
	expect(res.status).toBe(200)
	const { value } = (await res.json()) as { value: { customAvatarItemId: string } }

	const row = await env.DB.prepare(
		'SELECT data FROM custom_avatar_item WHERE custom_avatar_item_id=?'
	)
		.bind(value.customAvatarItemId)
		.first<{ data: string }>()
	const item = JSON.parse(row!.data)
	// One item; the game picks the save matching the wearer's body.
	expect(
		item.CurrentSaves.map((save: { BodyType: number }) => save.BodyType).toSorted(
			(a: number, b: number) => a - b
		)
	).toEqual([1, 2])
	const [first, second] = item.CurrentSaves
	expect(first.UnityAssetId).not.toBe(second.UnityAssetId)
	expect(first.UnityAsset).not.toBe(second.UnityAsset)
	for (const save of item.CurrentSaves) {
		expect(
			await env.DB.prepare('SELECT COUNT(*) AS n FROM unity_asset WHERE unity_asset_id=?')
				.bind(save.UnityAssetId)
				.first('n')
		).toBe(4)
	}
	expect(JSON.parse(first.AdditionalConfiguration)).toMatchObject({ d: { n: 'Web Hat', o: 100 } })
})

it('refuses duplicate or missing body-type sets, and a bad later set stores nothing', async () => {
	await grantAvatarUpload(8706)
	const count = async () =>
		env.DB.prepare(
			'SELECT COUNT(*) AS n FROM custom_avatar_item WHERE creator_account_id=8706'
		).first('n')

	expect(
		(await uploadAvatar(8706, avatarUploadForm({}, [avatarSet(0, 1), avatarSet(1, 1)]))).status
	).toBe(400)
	expect((await uploadAvatar(8706, avatarUploadForm({}, []))).status).toBe(400)
	// The second set's bundle is not a Unity bundle: the first set must not be left behind.
	const bad = avatarSet(1, 2, { windowsMain: new File([new Uint8Array(12)], 'x.bundle') })
	expect((await uploadAvatar(8706, avatarUploadForm({}, [avatarSet(0, 1), bad]))).status).toBe(400)
	expect(await count()).toBe(0)
	expect((await env.CDN_ASSETS.list({ prefix: 'avatar/' })).objects.length).toBe(
		(await env.DB.prepare('SELECT COUNT(*) AS n FROM unity_asset').first<number>('n'))!
	)
})

it('answers the browser: a CORS preflight, and the allow-origin header even on a refusal', async () => {
	const origin = 'https://www.rec.example.com'
	const preflight = await SELF.fetch('https://example.com/avatar-items', {
		method: 'OPTIONS',
		headers: {
			origin,
			'access-control-request-method': 'POST',
			'access-control-request-headers': 'authorization',
		},
	})
	expect(preflight.status).toBeLessThan(300)
	expect(preflight.headers.get('access-control-allow-origin')).toBe('*')
	expect(preflight.headers.get('access-control-allow-headers')?.toLowerCase()).toContain(
		'authorization'
	)

	// A refusal has to carry it too, or the page can't read why it was refused.
	const refused = await SELF.fetch('https://example.com/avatar-items', {
		method: 'POST',
		headers: { origin },
		body: avatarUploadForm(),
	})
	expect(refused.status).toBe(401)
	expect(refused.headers.get('access-control-allow-origin')).toBe('*')
})
