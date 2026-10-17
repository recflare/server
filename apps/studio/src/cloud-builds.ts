import { Hono } from 'hono'

import {
	canManageRoomById,
	getRoomById,
	getSubRoom,
	getSubRoomSaveById,
	publicStudioBundleFilename,
	studioBundleR2Key,
} from '@repo/domain'
import {
	generateStudioBuildValidationToken,
	validateAndGetAccountId,
	validateAndGetRoles,
} from '@repo/jwt'

import { parseMultipart } from './multipart'

import type { App } from './context'

export const CLOUD_JOB_SCHEMA = `CREATE TABLE IF NOT EXISTS studio_cloud_build_job (
 cloud_build_id TEXT PRIMARY KEY, payload TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'queued',
 lease_token TEXT, lease_until TEXT, attempts INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL
)`
interface Job {
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
		MainSceneProjectRelativePath: string
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
interface Artifact {
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
const textField = (value: unknown, fallback = '') => (typeof value === 'string' ? value : fallback)
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
async function privateAuth(request: Request, key: string | undefined) {
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
const app = new Hono<App>()
	.post('/cloud-builds/create', async (c) => {
		const secret = await c.env.JWT_SECRET.get()
		const accountId = await validateAndGetAccountId(c.req.raw, secret)
		const roles = await validateAndGetRoles(c.req.raw, secret)
		if (accountId === null) return c.body(null, 401)
		if (!roles?.includes('betastudio'))
			return c.json(fail('Studio upload authorization is required.'), 403)
		if (!c.env.CLOUD_BUILD_KEY) return c.json(fail('Cloud building is not configured.'), 503)
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
			'SELECT room_id FROM studio_cloud_build WHERE cloud_build_id = ?'
		)
			.bind(id)
			.first<{ room_id: number }>()
		if (!row || !(await canManageRoomById(c.env.DB, row.room_id, accountId)))
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
		if (!(await privateAuth(c.req.raw, c.env.CLOUD_BUILD_KEY))) return c.body(null, 401)
		return next()
	})
	.post('/internal/cloud-builds/claim', async (c) => {
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
		const result = await c.env.DB.prepare(
			"UPDATE studio_cloud_build_job SET lease_until=? WHERE cloud_build_id=? AND lease_token=? AND status IN ('building','publishing') AND lease_until>?"
		)
			.bind(
				new Date(Date.now() + 5 * 60 * 1000).toISOString(),
				c.req.param('id'),
				leaseToken,
				new Date().toISOString()
			)
			.run()
		return c.json({ active: result.meta.changes > 0 })
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
		const assets = new Set([job.unityAssetId, ...job.exports.map((item) => item.u)])
		let entries: unknown
		try {
			entries = JSON.parse(textField(form.artifacts, '[]'))
		} catch {
			return c.json(fail('Invalid build artifact metadata.'), 400)
		}
		if (!Array.isArray(entries) || !entries.every(isArtifact))
			return c.json(fail('Invalid build artifact metadata.'), 400)
		if (!entries.length || entries.length > assets.size * job.targets.length * 2)
			return c.json(fail('Missing build artifacts.'), 400)
		const seen = new Set<string>()
		for (const entry of entries) {
			const file = form[entry.field]
			const key = `${entry.unityAssetId}:${entry.target}:${entry.kind}`
			if (
				!assets.has(entry.unityAssetId) ||
				!job.targets.includes(entry.target) ||
				!['main', 'stripped'].includes(entry.kind) ||
				entry.version !== 5 ||
				!(file instanceof File) ||
				file.size === 0 ||
				seen.has(key)
			)
				return c.json(fail('Invalid build artifact.'), 400)
			seen.add(key)
		}
		for (const asset of assets)
			for (const target of job.targets)
				if (!seen.has(`${asset}:${target}:main`))
					return c.json(fail('A required asset bundle is missing.'), 400)
		const writes: D1PreparedStatement[] = []
		for (const entry of entries) {
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
				const file = form[entry.field] as File
				const bytes = await file.arrayBuffer()
				const hash = btoa(
					String.fromCharCode(...new Uint8Array(await crypto.subtle.digest('SHA-256', bytes)))
				)
				const baseFilename = publicStudioBundleFilename(
					job.roomId,
					entry.unityAssetId,
					entry.target === 2 ? 'android' : 'windows',
					entry.kind
				)
				const filename = baseFilename.replace('.assetbundle', `.${lease.lease_token}.assetbundle`)
				const key = studioBundleR2Key(filename)
				await c.env.CDN_ASSETS.put(key, bytes)
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
			// Recheck the lease and target inside the publication transaction. R2
			// uploads can outlast a lease, and a room can be deleted while compiling.
			const publicationTime = new Date().toISOString()
			const results = await c.env.DB.batch([
				c.env.DB.prepare(
					`UPDATE studio_cloud_build_job SET status='failed',lease_token=NULL
					 WHERE cloud_build_id=? AND lease_token=? AND status='publishing'
					 AND (lease_until<=? OR NOT EXISTS (
					 SELECT 1 FROM subroom_save s JOIN subroom r ON r.sub_room_id=s.sub_room_id
					 JOIN room ON room.room_id=r.room_id
					 WHERE s.sub_room_data_save_id=? AND s.sub_room_id=? AND r.room_id=?))`
				).bind(id, lease.lease_token, publicationTime, job.saveId, job.subRoomId, job.roomId),
				c.env.DB.prepare(
					`UPDATE studio_cloud_build SET completed_at=?,error='Build lease expired or target save removed.'
					 WHERE cloud_build_id=? AND completed_at='' AND EXISTS (
					 SELECT 1 FROM studio_cloud_build_job WHERE cloud_build_id=? AND status='failed')`
				).bind(publicationTime, id, id),
				...writes,
			])
			if (!results[results.length - 1].meta.changes) {
				await Promise.all(keys.map((key) => c.env.CDN_ASSETS.delete(key)))
				return c.json(fail('Build lease expired or target save removed.'), 409)
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
		return c.json(ok(null))
	})
export default app
