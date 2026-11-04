import { Hono } from 'hono'

import {
	AVATAR_STUDIO_SLOTS,
	avatarItemAccessBit,
	avatarStudioFlags,
	avatarStudioItem,
	avatarStudioSave,
	canManageRoom,
	canManageRoomById,
	getRoomById,
	getSubRoom,
	getSubRoomSaveById,
	publicStudioBundleFilename,
	publishAvatarSave,
	studioBundleR2Key,
} from '@repo/domain'
import {
	generateStudioBuildValidationToken,
	validateAndGetAccountId,
	validateAndGetRoles,
} from '@repo/jwt'

import { cleanupUploads, multipartArtifacts } from './artifact-multipart'
import { parseMultipart } from './multipart'

import type { Context } from 'hono'
import type { App, Env } from './context'

export const CLOUD_JOB_SCHEMA = `CREATE TABLE IF NOT EXISTS studio_cloud_build_job (
 cloud_build_id TEXT PRIMARY KEY, payload TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'queued',
 lease_token TEXT, lease_until TEXT, attempts INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL
)`
export interface Job {
	kind?: 'avatar'
	avatarItemId?: string
	avatar?: {
		itemId: string
		outfitType: number
		bodyType: number
		configuration: string
		name: string
		createdAt: string
		price: number
		creatorAccountId: number
		canCreateRoomieEquipment: boolean
		permittedItemTypes: number[]
	}
	buildId: string
	roomId: number
	subRoomId: number
	saveId: number
	accountId: number
	unityAssetId: string
	autoPublish: boolean
	templateVersion: number
	targets: number[]
	manifest: {
		Version: number
		MainSceneProjectRelativePath?: string
		MainPrefabProjectRelativePath?: string
		ExportPartitionVersion: number
		Files: Array<{ n: string; p: string; g?: string }>
		Exports?: Array<{ e: string; d?: string[] }>
	}
	room: unknown
	exports: Array<{ e: string; u: string }>
}
interface Lease {
	payload: string
	lease_token: string
	lease_until: string
}
const ok = (value: unknown) => ({ success: true, error: null, value })
const fail = (error: string) => ({ success: false, error, value: null })
const ID = /^[1-9]\d*$/
const guid = () => crypto.randomUUID()
const textField = (value: unknown, fallback = '') => (typeof value === 'string' ? value : fallback)
export interface Artifact {
	field: string
	unityAssetId: string
	target: number
	kind: string
	version: number
}
function isArtifact(value: unknown): value is Artifact {
	if (typeof value !== 'object' || value === null) return false
	const entry = value as Record<string, unknown>
	return (
		typeof entry.field === 'string' &&
		typeof entry.unityAssetId === 'string' &&
		typeof entry.target === 'number' &&
		typeof entry.kind === 'string' &&
		typeof entry.version === 'number'
	)
}
function artifactAllowed(job: Job, entry: Artifact) {
	return (
		[job.unityAssetId, ...job.exports.map((item) => item.u)].includes(entry.unityAssetId) &&
		job.targets.includes(entry.target) &&
		(job.kind === 'avatar' ? ['main', 'stripped', 'material'] : ['main', 'stripped']).includes(
			entry.kind
		) &&
		entry.version === (job.kind === 'avatar' && entry.kind === 'material' ? 6 : 5)
	)
}
function artifactLocation(job: Job, leaseToken: string, entry: Artifact) {
	const base = publicStudioBundleFilename(
		job.roomId,
		entry.unityAssetId,
		entry.target === 2 ? 'android' : 'windows',
		entry.kind
	)
	const filename =
		job.kind === 'avatar'
			? `${entry.target === 2 ? 'quest/' : ''}studio-avatar/${job.avatarItemId}/${entry.unityAssetId}/${leaseToken}.${entry.kind}.assetbundle`
			: base.replace('.assetbundle', `.${leaseToken}.assetbundle`)
	return {
		filename,
		key: job.kind === 'avatar' ? `avatar/${filename}` : studioBundleR2Key(filename),
	}
}
function numericId() {
	return (
		(BigInt(crypto.getRandomValues(new Uint32Array(1))[0] & 0x7fffffff) << 32n) |
		BigInt(crypto.getRandomValues(new Uint32Array(1))[0]) |
		1n
	).toString()
}
interface CloudBuildRecord {
	cloud_build_id: string
	started_at: string
	completed_at: string | null
	error: string | null
	unity_asset_id: string
	created_by_account_id: number
}
function wire(row: CloudBuildRecord) {
	return {
		cloudBuildId: row.cloud_build_id,
		startedAt: row.started_at,
		completedAt: row.completed_at || null,
		error: row.error,
		unityAssetId: row.unity_asset_id,
		createdByAccountId: row.created_by_account_id,
		serverDataFileName:
			row.completed_at && !row.error
				? `studio-builds/${row.cloud_build_id}/server-data.json`
				: null,
	}
}
/**
 * The pull worker's credential, resolved per request from the Secrets Store. Returns ''
 * when cloud building is off: the secret holds the literal `off` (the binding has to
 * resolve for the worker to deploy, so that is how an operator opts out) or can't be read.
 * Every gate on "is cloud building configured" goes through here.
 */
export async function cloudBuildKey(env: Env): Promise<string> {
	try {
		const key = (await env.CLOUD_BUILD_KEY.get()) ?? ''
		return key === 'off' ? '' : key
	} catch {
		return ''
	}
}
async function privateAuth(request: Request, key: string) {
	if (!key) return false
	const wanted = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(`Bearer ${key}`))
	const got = await crypto.subtle.digest(
		'SHA-256',
		new TextEncoder().encode(request.headers.get('authorization') ?? '')
	)
	return new Uint8Array(wanted).every((byte, i) => byte === new Uint8Array(got)[i])
}
async function pendingBuild(db: D1Database, roomId: number, subRoomId: number, saveId: number) {
	return db
		.prepare(
			"SELECT b.* FROM studio_cloud_build b JOIN studio_cloud_build_job j USING(cloud_build_id) WHERE b.room_id=? AND b.sub_room_id=? AND b.sub_room_data_save_id=? AND j.status IN ('queued','building','publishing') ORDER BY b.started_at DESC LIMIT 1"
		)
		.bind(roomId, subRoomId, saveId)
		.first<CloudBuildRecord>()
}
async function pendingAvatarBuild(db: D1Database, itemId: string, saveId: number) {
	return db
		.prepare(
			"SELECT b.* FROM studio_cloud_build b JOIN studio_avatar_build a USING(cloud_build_id) JOIN studio_cloud_build_job j USING(cloud_build_id) WHERE a.item_id=? AND a.save_id=? AND j.status IN ('queued','building','publishing') LIMIT 1"
		)
		.bind(itemId, saveId)
		.first<CloudBuildRecord>()
}
const app = new Hono<App>()
	.get('/cloud-builds/custom-avatar-item/:itemId{[0-9a-fA-F-]{36}}', async (c) => {
		const id = await validateAndGetAccountId(c.req.raw, await c.env.JWT_SECRET.get())
		if (id === null) return c.body(null, 401)
		const item = await avatarStudioItem(c.env.DB, c.req.param('itemId'))
		if (!item || item.CreatorAccountId !== id) return c.body(null, 403)
		const skip = Math.max(0, Number(c.req.query('skip')) || 0),
			take = Math.min(10000, Math.max(1, Number(c.req.query('take')) || 100))
		const { results } = await c.env.DB.prepare(
			'SELECT b.* FROM studio_cloud_build b JOIN studio_avatar_build a USING(cloud_build_id) WHERE a.item_id=? ORDER BY b.started_at DESC'
		)
			.bind(item.CustomAvatarItemId)
			.all<CloudBuildRecord>()
		return c.json({
			results: results.slice(skip, skip + take).map(wire),
			totalResults: results.length,
		})
	})
	.post(
		'/cloud-builds/custom-avatar-item/:itemId{[0-9a-fA-F-]{36}}/save/:saveId{[1-9][0-9]*}',
		(c) => enqueueAvatar(c, c.req.param('itemId'), Number(c.req.param('saveId')))
	)
	.post('/cloud-builds/custom-avatar-item/create-for-new-build-version', async (c) => {
		const form = await c.req.parseBody()
		const itemId = String(form.customAvatarItemId ?? ''),
			assetId = String(form.unityAssetId ?? '')
		const row = await c.env.DB.prepare(
			'SELECT id FROM avatar_studio_save WHERE item_id=? AND unity_asset_id=? ORDER BY id DESC LIMIT 1'
		)
			.bind(itemId, assetId)
			.first<{ id: number }>()
		if (!row) return c.notFound()
		return enqueueAvatar(c, itemId, row.id, form)
	})
	.post('/cloud-builds/create', async (c) => {
		const secret = await c.env.JWT_SECRET.get()
		const accountId = await validateAndGetAccountId(c.req.raw, secret)
		const roles = await validateAndGetRoles(c.req.raw, secret)
		if (accountId === null) return c.body(null, 401)
		if (!roles?.includes('betastudio'))
			return c.json(fail('Studio upload authorization is required.'), 403)
		if (!(await cloudBuildKey(c.env))) return c.json(fail('Cloud building is not configured.'), 503)
		const form = await c.req.parseBody()
		const ids = ['roomId', 'subRoomId', 'subRoomDataSaveId'].map((key) => textField(form[key]))
		if (ids.some((id) => !ID.test(id) || !Number.isSafeInteger(Number(id))))
			return c.json(fail('Invalid room, subroom, or save ID.'), 400)
		const [roomId, subRoomId, saveId] = ids.map(Number)
		if (!(await canManageRoomById(c.env.DB, roomId, accountId)))
			return c.json(fail('This account cannot build this room.'), 403)
		if (!(await getSubRoom(c.env.DB, roomId, subRoomId)))
			return c.json(fail('No such subroom.'), 404)
		const pending = await pendingBuild(c.env.DB, roomId, subRoomId, saveId)
		if (pending) return c.json(ok(wire(pending)))
		const save = await getSubRoomSaveById(c.env.DB, subRoomId, saveId)
		const source = save?.StudioSourceAsset as { Filename?: string } | undefined
		if (!source?.Filename) return c.json(fail('This save has no Studio source project.'), 400)
		const object = await c.env.CDN_ASSETS.get(`roomunityasset/${source.Filename}`)
		if (!object) return c.json(fail('The uploaded Studio source manifest is missing.'), 400)
		if (object.size > 8 * 1024 * 1024) return c.json(fail('Source manifest exceeds limit.'), 413)
		let manifest: Job['manifest']
		try {
			manifest = await object.json<Job['manifest']>()
		} catch {
			return c.json(fail('Invalid Studio source manifest JSON.'), 400)
		}
		if (
			!manifest ||
			manifest.Version !== 3 ||
			manifest.ExportPartitionVersion !== 3 ||
			typeof manifest.MainSceneProjectRelativePath !== 'string' ||
			!manifest.MainSceneProjectRelativePath.startsWith('Assets/') ||
			!manifest.MainSceneProjectRelativePath.endsWith('.unity') ||
			!Array.isArray(manifest.Files) ||
			manifest.Files.length > 100000 ||
			manifest.Files.some(
				(file) =>
					!file ||
					typeof file.p !== 'string' ||
					!(file.p.startsWith('Assets/') || file.p.startsWith('Packages/')) ||
					file.p
						.split('/')
						.some(
							(part) =>
								part === '..' ||
								part === '.' ||
								part === '' ||
								part.toLowerCase().endsWith('.bundle')
						) ||
					file.p.includes('\\') ||
					file.p.includes(':') ||
					/\.(cs|dll|exe|so|dylib|rsp|asmdef|asmref)$/i.test(file.p) ||
					!/^[a-z0-9]{40}$/.test(file.n)
			) ||
			!manifest.Files.some((file) => file.p === manifest.MainSceneProjectRelativePath) ||
			new Set(manifest.Files.map((file) => file.p.toLowerCase())).size !== manifest.Files.length ||
			(manifest.Exports !== undefined &&
				(!Array.isArray(manifest.Exports) ||
					manifest.Exports.some(
						(item) =>
							!item ||
							typeof item.e !== 'string' ||
							!item.e ||
							(item.d !== undefined &&
								(!Array.isArray(item.d) || item.d.some((id) => typeof id !== 'string')))
					) ||
					new Set(manifest.Exports.map((item) => item.e)).size !== manifest.Exports.length))
		)
			return c.json(fail('Invalid Studio source file manifest.'), 400)
		const targets = (c.env.CLOUD_BUILD_TARGETS ?? '0,2').split(',').map(Number)
		if (!targets.length || targets.some((target) => target !== 0 && target !== 2))
			return c.json(fail('Invalid build target configuration.'), 503)
		const requested = textField(form.buildAssetBundleTypes).split(',').filter(Boolean).map(Number)
		if (requested.some((target) => !targets.includes(target)))
			return c.json(fail('Requested build platform is unavailable.'), 400)
		const now = new Date().toISOString()
		const job: Job = {
			buildId: numericId(),
			roomId,
			subRoomId,
			saveId,
			accountId,
			unityAssetId: guid(),
			autoPublish: textField(form.autoPublish).toLowerCase() === 'true',
			templateVersion: Number(c.env.CLOUD_BUILD_TEMPLATE_VERSION ?? 169),
			targets: requested.length ? requested : targets,
			manifest,
			room: await getRoomById(c.env.DB, roomId),
			exports: (manifest.Exports ?? []).map((item) => ({
				e: item.e,
				u: guid(),
			})),
		}
		// The initial lookup is only a fast path. Check again inside the creation
		// transaction so concurrent retries cannot dispatch two builds for one save.
		const created = await c.env.DB.batch([
			c.env.DB.prepare(
				`INSERT INTO studio_cloud_build (cloud_build_id,room_id,sub_room_id,sub_room_data_save_id,unity_asset_id,created_by_account_id,started_at,completed_at,error)
				 SELECT ?,?,?,?,?,?,?,'',NULL WHERE NOT EXISTS (
				 SELECT 1 FROM studio_cloud_build b JOIN studio_cloud_build_job j USING(cloud_build_id)
				 WHERE b.room_id=? AND b.sub_room_id=? AND b.sub_room_data_save_id=? AND j.status IN ('queued','building','publishing'))`
			).bind(
				job.buildId,
				roomId,
				subRoomId,
				saveId,
				job.unityAssetId,
				accountId,
				now,
				roomId,
				subRoomId,
				saveId
			),
			c.env.DB.prepare(
				'INSERT INTO studio_cloud_build_job (cloud_build_id,payload,created_at) SELECT ?,?,? WHERE EXISTS (SELECT 1 FROM studio_cloud_build WHERE cloud_build_id=?)'
			).bind(job.buildId, JSON.stringify(job), now, job.buildId),
		])
		if (!created[0].meta.changes) {
			const existing = await pendingBuild(c.env.DB, roomId, subRoomId, saveId)
			return existing
				? c.json(ok(wire(existing)))
				: c.json(fail('Build state changed; retry creation.'), 409)
		}
		return c.json(
			ok(
				wire({
					cloud_build_id: job.buildId,
					started_at: now,
					completed_at: null,
					error: null,
					unity_asset_id: job.unityAssetId,
					created_by_account_id: accountId,
				})
			)
		)
	})
	.get('/cloud-builds', async (c) => {
		const id = c.req.query('cloudBuildId') ?? ''
		if (!ID.test(id)) return c.json(fail('Invalid build ID.'), 400)
		const row = await c.env.DB.prepare('SELECT * FROM studio_cloud_build WHERE cloud_build_id = ?')
			.bind(id)
			.first<CloudBuildRecord>()
		return row ? c.json(ok(wire(row))) : c.json(fail('No such build.'), 404)
	})
	.on(['POST', 'PUT'], '/cloud-builds/cancel', async (c) => {
		const accountId = await validateAndGetAccountId(c.req.raw, await c.env.JWT_SECRET.get())
		if (accountId === null) return c.body(null, 401)
		const form = await c.req.parseBody()
		const id = textField(form.cloudBuildId)
		const row = await c.env.DB.prepare(
			'SELECT room_id,created_by_account_id FROM studio_cloud_build WHERE cloud_build_id = ?'
		)
			.bind(id)
			.first<{ room_id: number; created_by_account_id: number }>()
		if (
			!row ||
			!(row.room_id === 0
				? row.created_by_account_id === accountId
				: await canManageRoomById(c.env.DB, row.room_id, accountId))
		)
			return c.json(fail('No accessible build.'), 404)
		await c.env.DB.batch([
			c.env.DB.prepare(
				"UPDATE studio_cloud_build_job SET status='cancelled',lease_token=NULL WHERE cloud_build_id=? AND status IN ('queued','building')"
			).bind(id),
			c.env.DB.prepare(
				"UPDATE studio_cloud_build SET completed_at=?,error='Build cancelled.' WHERE cloud_build_id=? AND completed_at='' AND EXISTS (SELECT 1 FROM studio_cloud_build_job WHERE cloud_build_id=studio_cloud_build.cloud_build_id AND status='cancelled')"
			).bind(new Date().toISOString(), id),
		])
		return c.json(ok(null))
	})
	.use('/internal/cloud-builds/*', async (c, next) => {
		if (!(await privateAuth(c.req.raw, await cloudBuildKey(c.env)))) return c.body(null, 401)
		return next()
	})
	.post('/internal/cloud-builds/claim', async (c) => {
		await cleanupUploads(c.env)
		const now = new Date().toISOString()
		await c.env.DB.batch([
			c.env.DB.prepare(
				"UPDATE studio_cloud_build SET error='Build worker lease expired.',completed_at=? WHERE completed_at='' AND cloud_build_id IN (SELECT cloud_build_id FROM studio_cloud_build_job WHERE lease_until<? AND ((status='building' AND attempts>=3) OR status='publishing'))"
			).bind(now, now),
			c.env.DB.prepare(
				"UPDATE studio_cloud_build_job SET status='failed',lease_token=NULL WHERE lease_until<? AND ((status='building' AND attempts>=3) OR status='publishing')"
			).bind(now),
		])
		const token = guid()
		const until = new Date(Date.now() + 5 * 60 * 1000).toISOString()
		const lease = await c.env.DB.prepare(
			`UPDATE studio_cloud_build_job SET status='building',lease_token=?,lease_until=?,attempts=attempts+1
		 WHERE cloud_build_id=(SELECT cloud_build_id FROM studio_cloud_build_job WHERE (status='queued' OR (status='building' AND lease_until<?)) AND attempts<3 ORDER BY created_at LIMIT 1)
		 RETURNING payload,lease_token,lease_until`
		)
			.bind(token, until, now)
			.first<Lease>()
		if (!lease) return c.json(null)
		const job = JSON.parse(lease.payload) as Job
		return c.json({
			job,
			leaseToken: token,
			leaseUntil: until,
			validationAccessToken: await generateStudioBuildValidationToken(
				job.buildId,
				await c.env.JWT_SECRET.get()
			),
		})
	})
	.post('/internal/cloud-builds/:id/heartbeat', async (c) => {
		const { leaseToken } = await c.req.json<{ leaseToken: string }>()
		const leaseUntil = new Date(Date.now() + 5 * 60 * 1000).toISOString()
		const result = await c.env.DB.prepare(
			"UPDATE studio_cloud_build_job SET lease_until=? WHERE cloud_build_id=? AND lease_token=? AND status IN ('building','publishing') AND lease_until>?"
		)
			.bind(leaseUntil, c.req.param('id'), leaseToken, new Date().toISOString())
			.run()
		return c.json(result.meta.changes > 0 ? { active: true, leaseUntil } : { active: false })
	})
	.route('/internal/cloud-builds', multipartArtifacts(artifactAllowed, artifactLocation))
	.post('/internal/cloud-builds/:id/artifacts', async (c) => {
		const lease = await c.env.DB.prepare(
			"SELECT payload,lease_token,lease_until FROM studio_cloud_build_job WHERE cloud_build_id=? AND lease_token=? AND status='building' AND lease_until>?"
		)
			.bind(c.req.param('id'), c.req.header('X-Studio-Lease'), new Date().toISOString())
			.first<Lease>()
		if (!lease) return c.json(fail('Build lease expired or cancelled.'), 409)
		const job = JSON.parse(lease.payload) as Job
		let entry: unknown
		try {
			entry = JSON.parse(c.req.header('X-Studio-Artifact') ?? 'null')
		} catch {
			entry = null
		}
		if (!isArtifact(entry) || !artifactAllowed(job, entry))
			return c.json(fail('Invalid build artifact.'), 400)
		// Bound each upload independently of the total size of a multi-target build.
		const length = Number(c.req.header('Content-Length'))
		if (!Number.isSafeInteger(length) || length < 8 || length > 64 * 1024 * 1024)
			return c.json(
				fail('Artifact upload requires a Content-Length between 8 bytes and 64 MiB.'),
				413
			)
		const bytes = await c.req.arrayBuffer()
		if (bytes.byteLength !== length || new TextDecoder().decode(bytes.slice(0, 8)) !== 'UnityFS\0')
			return c.json(fail('Artifact is not a UnityFS asset bundle.'), 400)
		const hash = btoa(
			String.fromCharCode(...new Uint8Array(await crypto.subtle.digest('SHA-256', bytes)))
		)
		const { key } = artifactLocation(job, lease.lease_token, entry)
		await c.env.CDN_ASSETS.put(key, bytes, { customMetadata: { studioHash: hash } })
		return c.json(ok(null))
	})
	.post('/internal/cloud-builds/:id/finish', async (c) => {
		const form = await parseMultipart(c.req.raw)
		const id = c.req.param('id')
		const lease = await c.env.DB.prepare(
			"SELECT payload,lease_token,lease_until FROM studio_cloud_build_job WHERE cloud_build_id=? AND lease_token=? AND status='building' AND lease_until>?"
		)
			.bind(id, textField(form.leaseToken), new Date().toISOString())
			.first<Lease>()
		if (!lease) return c.json(fail('Build lease expired or cancelled.'), 409)
		const job = JSON.parse(lease.payload) as Job
		const error = typeof form.error === 'string' ? form.error.slice(0, 16000) : null
		if (error) {
			await c.env.DB.batch([
				c.env.DB.prepare(
					"UPDATE studio_cloud_build_job SET status='failed' WHERE cloud_build_id=? AND lease_token=? AND status='building'"
				).bind(id, lease.lease_token),
				c.env.DB.prepare(
					"UPDATE studio_cloud_build SET error=?,completed_at=? WHERE cloud_build_id=? AND EXISTS (SELECT 1 FROM studio_cloud_build_job WHERE cloud_build_id=? AND lease_token=? AND status='failed')"
				).bind(error, new Date().toISOString(), id, id, lease.lease_token),
			])
			return c.json(ok(null))
		}
		if (job.kind === 'avatar') {
			const item = await avatarStudioItem(c.env.DB, job.avatarItemId!)
			const save = await avatarStudioSave(c.env.DB, job.avatarItemId!, job.saveId)
			if (
				!item ||
				!save ||
				item.CreatorAccountId !== job.accountId ||
				!((await avatarStudioFlags(c.env.DB, job.accountId)) & avatarItemAccessBit(item.OutfitType))
			) {
				await c.env.DB.batch([
					c.env.DB.prepare(
						"UPDATE studio_cloud_build_job SET status='failed',lease_token=NULL WHERE cloud_build_id=? AND lease_token=? AND status='building'"
					).bind(id, lease.lease_token),
					c.env.DB.prepare(
						"UPDATE studio_cloud_build SET completed_at=?,error='Avatar source or authorization was removed.' WHERE cloud_build_id=? AND completed_at=''"
					).bind(new Date().toISOString(), id),
				])
				return c.json(fail('Avatar source or authorization was removed.'), 409)
			}
		}
		const assets = new Set([job.unityAssetId, ...job.exports.map((item) => item.u)])
		let entries: unknown
		try {
			entries = JSON.parse(textField(form.artifacts, '[]'))
		} catch {
			return c.json(fail('Invalid build artifact metadata.'), 400)
		}
		if (!Array.isArray(entries) || !entries.every(isArtifact))
			return c.json(fail('Invalid build artifact metadata.'), 400)
		if (
			!entries.length ||
			entries.length > assets.size * job.targets.length * (job.kind === 'avatar' ? 3 : 2)
		)
			return c.json(fail('Missing build artifacts.'), 400)
		const seen = new Set<string>()
		const staged = form.staged === 'true'
		const stagedHashes = new Map<string, string>()
		for (const entry of entries) {
			const file = form[entry.field]
			const key = `${entry.unityAssetId}:${entry.target}:${entry.kind}`
			if (staged && artifactAllowed(job, entry)) {
				const object = await c.env.CDN_ASSETS.head(
					artifactLocation(job, lease.lease_token, entry).key
				)
				if (object?.size && object.customMetadata?.studioHash)
					stagedHashes.set(key, object.customMetadata.studioHash)
			}
			if (
				!assets.has(entry.unityAssetId) ||
				!job.targets.includes(entry.target) ||
				!(job.kind === 'avatar' ? ['main', 'stripped', 'material'] : ['main', 'stripped']).includes(
					entry.kind
				) ||
				entry.version !== (job.kind === 'avatar' && entry.kind === 'material' ? 6 : 5) ||
				(staged ? !stagedHashes.has(key) : !(file instanceof File) || file.size === 0) ||
				seen.has(key)
			)
				return c.json(fail('Invalid build artifact.'), 400)
			seen.add(key)
		}
		for (const asset of assets)
			for (const target of job.targets)
				if (!seen.has(`${asset}:${target}:main`))
					return c.json(fail('A required asset bundle is missing.'), 400)
		if (
			job.kind === 'avatar' &&
			job.targets.some((target) => !seen.has(`${job.unityAssetId}:${target}:material`))
		)
			return c.json(fail('An avatar material bundle is missing.'), 400)
		const writes: D1PreparedStatement[] = []
		for (const entry of staged ? [] : entries) {
			const file = form[entry.field] as File
			if (new TextDecoder().decode(await file.slice(0, 8).arrayBuffer()) !== 'UnityFS\0')
				return c.json(fail('Artifact is not a UnityFS asset bundle.'), 400)
		}
		const locked = await c.env.DB.prepare(
			"UPDATE studio_cloud_build_job SET status='publishing' WHERE cloud_build_id=? AND lease_token=? AND status='building' AND lease_until>?"
		)
			.bind(id, lease.lease_token, new Date().toISOString())
			.run()
		if (!locked.meta.changes) return c.json(fail('Build lease expired or cancelled.'), 409)
		const keys: string[] = []
		try {
			for (const entry of entries) {
				const { filename, key } = artifactLocation(job, lease.lease_token, entry)
				let hash = stagedHashes.get(`${entry.unityAssetId}:${entry.target}:${entry.kind}`)!
				if (!staged) {
					const bytes = await (form[entry.field] as File).arrayBuffer()
					hash = btoa(
						String.fromCharCode(...new Uint8Array(await crypto.subtle.digest('SHA-256', bytes)))
					)
					await c.env.CDN_ASSETS.put(key, bytes)
				}
				keys.push(key)
				writes.push(
					c.env.DB.prepare(
						"INSERT INTO unity_asset (unity_asset_id,target,version,kind,filename,hash) SELECT ?,?,?,?,?,? WHERE EXISTS (SELECT 1 FROM studio_cloud_build_job WHERE cloud_build_id=? AND lease_token=? AND status='publishing') ON CONFLICT(unity_asset_id,target,version,kind) DO UPDATE SET filename=excluded.filename,hash=excluded.hash"
					).bind(
						entry.unityAssetId,
						entry.target,
						entry.version,
						entry.kind,
						filename,
						hash,
						id,
						lease.lease_token
					)
				)
			}
			const serverDataKey = `roomunityasset/studio-builds/${id}/server-data.json`
			await c.env.CDN_ASSETS.put(serverDataKey, JSON.stringify({ Exports: job.exports }))
			keys.push(serverDataKey)
			// The exact submitted save is linked; a newer draft must never be replaced.
			if (job.kind !== 'avatar')
				writes.push(
					c.env.DB.prepare(
						"UPDATE subroom_save SET data=json_set(data,'$.UnityAssetId',?,'$.ServerData',json(?)) WHERE sub_room_data_save_id=? AND sub_room_id=? AND EXISTS (SELECT 1 FROM studio_cloud_build_job WHERE cloud_build_id=? AND lease_token=? AND status='publishing')"
					).bind(
						job.unityAssetId,
						JSON.stringify({ Exports: job.exports }),
						job.saveId,
						job.subRoomId,
						id,
						lease.lease_token
					)
				)
			if (job.kind !== 'avatar') {
				writes.push(
					c.env.DB.prepare(
						`UPDATE room SET data=json_set(data,'$.BecameRRStudioRoomAt',?)
					 WHERE room_id=? AND json_type(data,'$.BecameRRStudioRoomAt') IS NOT 'text'
					 AND EXISTS (SELECT 1 FROM studio_cloud_build_job WHERE cloud_build_id=? AND lease_token=? AND status='publishing')`
					).bind(new Date().toISOString(), job.roomId, id, lease.lease_token)
				)
				if (job.autoPublish) {
					// Test and update the staging slot in the same statement. A draft saved
					// during compilation must not be replaced by this build's older save.
					writes.push(
						c.env.DB.prepare(
							`UPDATE subroom SET current_save_id=?,
						 staged_save_id=CASE WHEN staged_save_id=? THEN NULL ELSE staged_save_id END
						 WHERE room_id=? AND sub_room_id=? AND COALESCE(staged_save_id,current_save_id)=?
						 AND EXISTS (SELECT 1 FROM subroom_save WHERE sub_room_data_save_id=? AND sub_room_id=?)
						 AND EXISTS (SELECT 1 FROM studio_cloud_build_job WHERE cloud_build_id=? AND lease_token=? AND status='publishing')`
						).bind(
							job.saveId,
							job.saveId,
							job.roomId,
							job.subRoomId,
							job.saveId,
							job.saveId,
							job.subRoomId,
							id,
							lease.lease_token
						)
					)
				}
			}

			writes.push(
				c.env.DB.prepare(
					"UPDATE studio_cloud_build SET completed_at=?,error=NULL WHERE cloud_build_id=? AND EXISTS (SELECT 1 FROM studio_cloud_build_job WHERE cloud_build_id=? AND lease_token=? AND status='publishing')"
				).bind(new Date().toISOString(), id, id, lease.lease_token)
			)
			writes.push(
				c.env.DB.prepare(
					"UPDATE studio_cloud_build_job SET status='completed',lease_token=NULL WHERE cloud_build_id=? AND lease_token=? AND status='publishing'"
				).bind(id, lease.lease_token)
			)
			// Recheck authority, lease and target inside the final publication transaction.
			const publicationTime = new Date().toISOString()
			const roomRow =
				job.kind !== 'avatar'
					? await c.env.DB.prepare('SELECT data FROM room WHERE room_id=?')
							.bind(job.roomId)
							.first<{ data: string }>()
					: null
			const authorizedRoom =
				roomRow && canManageRoom(JSON.parse(roomRow.data), job.accountId) ? roomRow.data : null
			const targetExists =
				job.kind === 'avatar'
					? `SELECT 1 FROM avatar_studio_save s JOIN custom_avatar_item i ON i.custom_avatar_item_id=s.item_id
				 JOIN avatar_studio_access a ON a.account_id=json_extract(i.data,'$.CreatorAccountId')
				 WHERE s.id=? AND s.item_id=? AND s.unity_asset_id=? AND a.account_id=? AND (a.flags & ?)<>0`
					: `SELECT 1 FROM subroom_save s JOIN subroom r ON r.sub_room_id=s.sub_room_id
				 JOIN room ON room.room_id=r.room_id
				 WHERE s.sub_room_data_save_id=? AND s.sub_room_id=? AND r.room_id=? AND room.data=?`
			const targetBindings =
				job.kind === 'avatar'
					? [
							job.saveId,
							job.avatarItemId!,
							job.unityAssetId,
							job.accountId,
							avatarItemAccessBit(job.avatar!.outfitType),
						]
					: [job.saveId, job.subRoomId, job.roomId, authorizedRoom]
			const results = await c.env.DB.batch([
				c.env.DB.prepare(
					`UPDATE studio_cloud_build_job SET status='failed',lease_token=NULL
					 WHERE cloud_build_id=? AND lease_token=? AND status='publishing'
					 AND (lease_until<=? OR NOT EXISTS (${targetExists}))`
				).bind(id, lease.lease_token, publicationTime, ...targetBindings),
				c.env.DB.prepare(
					`UPDATE studio_cloud_build SET completed_at=?,error='Build lease expired or target authorization/save removed.'
					 WHERE cloud_build_id=? AND completed_at='' AND EXISTS (
					 SELECT 1 FROM studio_cloud_build_job WHERE cloud_build_id=? AND status='failed')`
				).bind(publicationTime, id, id),
				...writes,
			])
			if (!results[results.length - 1].meta.changes) {
				await Promise.all(keys.map((key) => c.env.CDN_ASSETS.delete(key)))
				return c.json(fail('Build lease expired or target authorization/save removed.'), 409)
			}
		} catch (error) {
			await Promise.all(keys.map((key) => c.env.CDN_ASSETS.delete(key)))
			await c.env.DB.prepare(
				"UPDATE studio_cloud_build_job SET status='building' WHERE cloud_build_id=? AND lease_token=? AND status='publishing'"
			)
				.bind(id, lease.lease_token)
				.run()
			throw error
		}
		if (job.kind === 'avatar') {
			const item = await avatarStudioItem(c.env.DB, job.avatarItemId!)
			const save = await avatarStudioSave(c.env.DB, job.avatarItemId!, job.saveId)
			if (
				item &&
				save &&
				(job.autoPublish || (item.Accessibility === 0 && save.update_current === 1))
			) {
				await publishAvatarSave(c.env.DB, item.CustomAvatarItemId, save.id, true)
			}
			return c.json(ok(null))
		}

		return c.json(ok(null))
	})
export default app

async function enqueueAvatar(
	c: Context<App>,
	itemId: string,
	saveId: number,
	supplied?: Record<string, unknown>
) {
	const accountId = await validateAndGetAccountId(c.req.raw, await c.env.JWT_SECRET.get())
	if (accountId === null) return c.body(null, 401)
	const item = await avatarStudioItem(c.env.DB, itemId),
		save = await avatarStudioSave(c.env.DB, itemId, saveId)
	if (!item || !save) return c.notFound()
	if (item.OutfitType === 1000)
		return c.json(fail('Badge images publish directly and do not require a Unity build.'), 400)
	const roles = await validateAndGetRoles(c.req.raw, await c.env.JWT_SECRET.get())
	if (
		item.CreatorAccountId !== accountId ||
		!roles?.includes('betastudio') ||
		!((await avatarStudioFlags(c.env.DB, accountId)) & avatarItemAccessBit(item.OutfitType))
	)
		return c.body(null, 403)
	if (!(await cloudBuildKey(c.env))) return c.json(fail('Cloud building is not configured.'), 503)
	const pending = await pendingAvatarBuild(c.env.DB, itemId, saveId)
	if (pending) return c.json(ok(wire(pending)))
	const object = await c.env.CDN_ASSETS.get('avatarunityasset/' + save.source_filename)
	if (!object || object.size > 8 * 1024 * 1024)
		return c.json(fail('Missing or oversized avatar source manifest.'), 400)
	let manifest: Job['manifest']
	try {
		manifest = await object.json<Job['manifest']>()
	} catch {
		return c.json(fail('Invalid source manifest JSON.'), 400)
	}
	const main = manifest?.MainPrefabProjectRelativePath
	if (
		!manifest ||
		manifest.Version !== 3 ||
		typeof main !== 'string' ||
		!main.startsWith('Assets/') ||
		!main.endsWith('.prefab') ||
		!Array.isArray(manifest.Files) ||
		!manifest.Files.length ||
		manifest.Files.length > 100000 ||
		!manifest.Files.some((f) => f?.p === main) ||
		manifest.Files.some(
			(f) =>
				!f ||
				typeof f.p !== 'string' ||
				!/^(Assets|Packages)\//.test(f.p) ||
				f.p.includes('\\') ||
				f.p.includes(':') ||
				f.p
					.split('/')
					.some(
						(p) => p === '..' || p === '.' || p === '' || p.toLowerCase().endsWith('.bundle')
					) ||
				/\.(cs|dll|exe|so|dylib|rsp|asmdef|asmref)$/i.test(f.p) ||
				!/^[a-z0-9]{40}$/.test(f.n)
		) ||
		new Set(manifest.Files.map((f) => f.p.toLowerCase())).size !== manifest.Files.length
	)
		return c.json(fail('Invalid avatar source file manifest.'), 400)
	const form = supplied ?? (await c.req.parseBody())
	if (form.pipelineVersion !== undefined && String(form.pipelineVersion) !== '2')
		return c.json(fail('Unsupported avatar build pipeline.'), 400)
	const targets = (c.env.CLOUD_BUILD_TARGETS ?? '0,2').split(',').map(Number)
	if (!targets.length || targets.some((t) => t !== 0 && t !== 2))
		return c.json(fail('Invalid build targets.'), 503)
	const access = await avatarStudioFlags(c.env.DB, accountId)
	const permittedItemTypes = AVATAR_STUDIO_SLOTS.filter(
		(slot) =>
			(access & avatarItemAccessBit(slot)) !== 0 &&
			(![104, 203].includes(slot) || roles.includes('developer'))
	)
	const job: Job = {
		kind: 'avatar',
		avatarItemId: itemId,
		avatar: {
			itemId,
			outfitType: item.OutfitType,
			bodyType: save.body_type,
			configuration: save.configuration,
			name: String(item.Name ?? ''),
			createdAt: save.created_at,
			price: Number(item.Price ?? 0),
			creatorAccountId: accountId,
			canCreateRoomieEquipment: roles.includes('developer'),
			permittedItemTypes,
		},
		buildId: numericId(),
		roomId: 0,
		subRoomId: 0,
		saveId,
		accountId,
		unityAssetId: save.unity_asset_id,
		autoPublish: textField(form.autoPublish).toLowerCase() === 'true',
		templateVersion: Number(c.env.CLOUD_BUILD_TEMPLATE_VERSION ?? 169),
		targets,
		manifest,
		room: null,
		exports: [],
	}
	const now = new Date().toISOString()
	// As for rooms, reserve the build and its queue/link rows in one transaction.
	const created = await c.env.DB.batch([
		c.env.DB.prepare(
			`INSERT INTO studio_cloud_build(cloud_build_id,room_id,sub_room_id,sub_room_data_save_id,unity_asset_id,created_by_account_id,started_at,completed_at,error)
			 SELECT ?,0,0,?,?,?,?,'',NULL WHERE NOT EXISTS (
			 SELECT 1 FROM studio_avatar_build a JOIN studio_cloud_build_job j USING(cloud_build_id)
			 WHERE a.item_id=? AND a.save_id=? AND j.status IN ('queued','building','publishing'))`
		).bind(job.buildId, saveId, job.unityAssetId, accountId, now, itemId, saveId),
		c.env.DB.prepare(
			'INSERT INTO studio_avatar_build(cloud_build_id,item_id,save_id) SELECT ?,?,? WHERE EXISTS (SELECT 1 FROM studio_cloud_build WHERE cloud_build_id=?)'
		).bind(job.buildId, itemId, saveId, job.buildId),
		c.env.DB.prepare(
			'INSERT INTO studio_cloud_build_job(cloud_build_id,payload,created_at) SELECT ?,?,? WHERE EXISTS (SELECT 1 FROM studio_cloud_build WHERE cloud_build_id=?)'
		).bind(job.buildId, JSON.stringify(job), now, job.buildId),
	])
	if (!created[0].meta.changes) {
		const existing = await pendingAvatarBuild(c.env.DB, itemId, saveId)
		return existing
			? c.json(ok(wire(existing)))
			: c.json(fail('Build state changed; retry creation.'), 409)
	}
	return c.json(
		ok(
			wire({
				cloud_build_id: job.buildId,
				started_at: now,
				completed_at: null,
				unity_asset_id: job.unityAssetId,
				created_by_account_id: accountId,
				error: null,
			})
		)
	)
}
