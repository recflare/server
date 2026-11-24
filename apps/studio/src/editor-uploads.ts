import { Hono } from 'hono'

import {
	canManageRoomById,
	getSubRoom,
	publicStudioBundleFilename,
	studioBundleR2Key,
} from '@repo/domain'
import { validateAndGetAccountId, validateAndGetRoles } from '@repo/jwt'

import {
	MAX_BUNDLE_SIZE,
	PART_SIZE,
	readBundleDigest,
	signingConfig,
	signPart,
} from './artifact-multipart'
import {
	currentSaveId,
	getUserBuildCount,
	MAX_BUILDS_PER_INTERVAL,
	recordLocalCloudBuild,
} from './local-builds'

import type { Context } from 'hono'
import type { App, Env } from './context'
import type { BundleKind, BundlePlatform, StoredBundleFile } from './local-builds'

/**
 * `POST /cloud-builds/from-editor` takes the whole Windows + Android pair in one
 * multipart body. Cloudflare refuses a request body over 100 MB before the Worker runs,
 * and the Worker holds that body in its 128 MB of memory while it parses it, so a large
 * Studio room cannot be uploaded that way at all.
 *
 * This is the same upload through presigned R2 multipart parts, the way the cloud
 * builder already uploads its artifacts (artifact-multipart.ts): the bundle bytes go
 * from the caller straight to R2 and never cross the Worker.
 *
 *   1. `POST …/uploads/start` names the room, subroom and every bundle (platform, kind,
 *      size, SHA-256). Same gate as `from-editor`: `betastudio`, creator or co-owner,
 *      and a subroom with a current save. It mints the build's `unityAssetId` and opens
 *      one R2 multipart upload per bundle under a private staging key.
 *   2. `POST …/uploads/:session/:platform/:kind/part/:n` signs one part (16 MiB, 120 s,
 *      that object key and upload id only). The caller PUTs the part to R2.
 *   3. `POST …/uploads/:session/:platform/:kind/complete` completes the R2 upload and
 *      verifies size, SHA-256 and the UnityFS header against what `start` declared.
 *   4. `POST …/uploads/:session/finish` copies the verified bundles to their public
 *      keys and records them exactly as `from-editor` does (storeLocalCloudBuild).
 *
 * `…/uploads/:session/abort` drops a session. Sessions expire after an hour; expired
 * ones are swept on the next `start`.
 */

export const EDITOR_UPLOAD_SCHEMA = `CREATE TABLE IF NOT EXISTS studio_editor_upload (
 id TEXT PRIMARY KEY, session_id TEXT NOT NULL, account_id INTEGER NOT NULL,
 room_id INTEGER NOT NULL, sub_room_id INTEGER NOT NULL, unity_asset_id TEXT NOT NULL,
 platform TEXT NOT NULL, kind TEXT NOT NULL, object_key TEXT NOT NULL, upload_id TEXT NOT NULL,
 size INTEGER NOT NULL, hash TEXT NOT NULL, state TEXT NOT NULL DEFAULT 'open',
 created_at TEXT NOT NULL, UNIQUE(session_id,platform,kind))`

/** How long a session may stay unfinished before the sweep removes it. */
export const SESSION_TTL_MS = 60 * 60 * 1000
/** Unfinished sessions one account may hold at once. */
export const MAX_OPEN_SESSIONS = 2

const NOT_AUTHORIZED =
	'You do not have authorization to upload RecFlare Studio content at this time.'
const UPLOAD_FIRST =
	'Upload the room before building locally. The latest save is where this build is recorded.'
const BUNDLE_REQUIRED = 'Both a Windows bundle and an Android bundle are required.'
const PLATFORMS: readonly BundlePlatform[] = ['windows', 'android']
const KINDS: readonly BundleKind[] = ['main', 'stripped']
const HASH = /^[A-Za-z0-9+/]{43}=$/
const ID = /^[1-9]\d*$/

type State = 'open' | 'verifying' | 'verified' | 'publishing'

interface Row {
	id: string
	session_id: string
	account_id: number
	room_id: number
	sub_room_id: number
	unity_asset_id: string
	platform: BundlePlatform
	kind: BundleKind
	object_key: string
	upload_id: string
	size: number
	hash: string
	state: State
	created_at: string
}

interface DeclaredFile {
	platform: BundlePlatform
	kind: BundleKind
	size: number
	hash: string
}

function fail(
	c: Context<App>,
	status: 400 | 403 | 404 | 409 | 410 | 413 | 429 | 503,
	error: string
) {
	return c.json({ success: false, error, value: null }, status)
}

function positiveId(value: unknown): number | null {
	const raw = typeof value === 'number' ? String(value) : value
	if (typeof raw !== 'string' || !ID.test(raw)) return null
	const id = Number(raw)
	return Number.isSafeInteger(id) ? id : null
}

function parts(size: number): number {
	return Math.ceil(size / PART_SIZE)
}

function expired(row: Pick<Row, 'created_at'>, now = Date.now()): boolean {
	return Date.parse(row.created_at) + SESSION_TTL_MS <= now
}

/** Account id of a bearer holding `betastudio`, or the response refusing it. */
async function studioCaller(c: Context<App>): Promise<number | Response> {
	const secret = await c.env.JWT_SECRET.get()
	const accountId = await validateAndGetAccountId(c.req.raw, secret)
	const roles = await validateAndGetRoles(c.req.raw, secret)
	if (accountId == null || roles == null) return c.body(null, 401)
	// Same claim the editor treats as Full Studio access. Developer does not confer it.
	if (!roles.includes('betastudio')) return fail(c, 403, NOT_AUTHORIZED)
	return accountId
}

/** The caller's rows of one live session, or the response refusing it. */
async function sessionRows(c: Context<App>, accountId: number): Promise<Row[] | Response> {
	const { results } = await c.env.DB.prepare(
		'SELECT * FROM studio_editor_upload WHERE session_id=?1 AND account_id=?2'
	)
		.bind(c.req.param('session'), accountId)
		.all<Row>()
	// Another account's session id reads the same as an unknown one.
	if (results.length === 0) return fail(c, 404, 'Unknown upload session.')
	if (expired(results[0]!)) return fail(c, 410, 'This upload session has expired.')
	return results
}

function fileRow(c: Context<App>, rows: Row[]): Row | undefined {
	return rows.find(
		(row) => row.platform === c.req.param('platform') && row.kind === c.req.param('kind')
	)
}

function parseFiles(value: unknown): DeclaredFile[] | 'too-large' | null {
	if (!Array.isArray(value) || value.length < 2 || value.length > 4) return null
	const files: DeclaredFile[] = []
	const seen = new Set<string>()
	for (const item of value as Array<Record<string, unknown>>) {
		const platform = item?.platform as BundlePlatform
		const kind = item?.kind as BundleKind
		const size = item?.size
		const hash = item?.hash
		if (!PLATFORMS.includes(platform) || !KINDS.includes(kind)) return null
		if (!Number.isSafeInteger(size) || typeof hash !== 'string' || !HASH.test(hash)) return null
		if ((size as number) > MAX_BUNDLE_SIZE) return 'too-large'
		if ((size as number) < 8) return null
		const key = `${platform}.${kind}`
		if (seen.has(key)) return null
		seen.add(key)
		files.push({ platform, kind, size: size as number, hash })
	}
	if (!seen.has('windows.main') || !seen.has('android.main')) return null
	return files
}

async function abortObject(bucket: R2Bucket, row: Pick<Row, 'object_key' | 'upload_id' | 'state'>) {
	if (row.state === 'open') {
		try {
			await bucket.resumeMultipartUpload(row.object_key, row.upload_id).abort()
		} catch (error) {
			if (!/NoSuchUpload|does not exist|not found/i.test(String(error))) throw error
		}
	}
	await bucket.delete(row.object_key)
}

function finalKey(row: Row): { filename: string; key: string } {
	const filename = publicStudioBundleFilename(
		row.room_id,
		row.unity_asset_id,
		row.platform,
		row.kind
	)
	return { filename, key: studioBundleR2Key(filename) }
}

/**
 * Remove sessions older than {@link SESSION_TTL_MS}: abort their R2 uploads, delete their
 * staging objects, and delete a public copy only when no `unity_asset` row names it (a
 * finish that died between the copy and the record). Bounded per call; errors leave the
 * row for the next sweep.
 */
export async function cleanupEditorUploads(env: Env, now = Date.now()) {
	const cutoff = new Date(now - SESSION_TTL_MS).toISOString()
	const { results } = await env.DB.prepare(
		'SELECT * FROM studio_editor_upload WHERE created_at <= ?1 LIMIT 20'
	)
		.bind(cutoff)
		.all<Row>()
	for (const row of results) {
		try {
			await abortObject(env.CDN_ASSETS, row)
			const { filename, key } = finalKey(row)
			const published = await env.DB.prepare(
				'SELECT 1 AS ok FROM unity_asset WHERE unity_asset_id=?1 AND filename=?2'
			)
				.bind(row.unity_asset_id, filename)
				.first()
			if (!published) await env.CDN_ASSETS.delete(key)
			await env.DB.prepare('DELETE FROM studio_editor_upload WHERE id=?1').bind(row.id).run()
		} catch {
			/* Retry on the next sweep. */
		}
	}
}

const editorUploads = new Hono<App>()
	.post('/start', async (c) => {
		const accountId = await studioCaller(c)
		if (accountId instanceof Response) return accountId
		if (!(await signingConfig(c.env))) return fail(c, 503, 'R2 upload signing is not configured.')

		const body = (await c.req.json().catch(() => null)) as Record<string, unknown> | null
		const files = parseFiles(body?.files)
		if (files === 'too-large') return fail(c, 413, 'Bundle exceeds the 128 MiB upload limit.')
		if (!files) return fail(c, 400, BUNDLE_REQUIRED)

		const roomId = positiveId(body?.roomId)
		if (roomId == null) return fail(c, 404, 'No such room.')
		const allowed = await canManageRoomById(c.env.DB, roomId, accountId)
		if (allowed == null) return fail(c, 404, 'No such room.')
		if (!allowed) return fail(c, 403, 'This account cannot upload a build for that room.')
		const subRoomId = positiveId(body?.subRoomId)
		if (subRoomId == null) return fail(c, 404, 'No such subroom.')
		const sub = await getSubRoom(c.env.DB, roomId, subRoomId)
		if (!sub) return fail(c, 404, 'No such subroom.')
		if (currentSaveId(sub) == null) return fail(c, 400, UPLOAD_FIRST)

		await cleanupEditorUploads(c.env)
		const builds = await getUserBuildCount(c.env.DB, accountId)
		if (builds.subRoomTotalBuildCount >= MAX_BUILDS_PER_INTERVAL)
			return fail(c, 429, 'Too many Studio builds this hour.')
		const open = await c.env.DB.prepare(
			'SELECT COUNT(DISTINCT session_id) AS n FROM studio_editor_upload WHERE account_id=?1'
		)
			.bind(accountId)
			.first<{ n: number }>()
		if (Number(open?.n ?? 0) >= MAX_OPEN_SESSIONS)
			return fail(c, 429, 'Finish or abort an open upload first.')

		const sessionId = crypto.randomUUID()
		const unityAssetId = crypto.randomUUID()
		const createdAt = new Date().toISOString()
		const rows: Row[] = []
		try {
			for (const file of files) {
				const objectKey = `studio-editor-uploads/${sessionId}/${file.platform}.${file.kind}`
				const multipart = await c.env.CDN_ASSETS.createMultipartUpload(objectKey)
				rows.push({
					id: crypto.randomUUID(),
					session_id: sessionId,
					account_id: accountId,
					room_id: roomId,
					sub_room_id: subRoomId,
					unity_asset_id: unityAssetId,
					platform: file.platform,
					kind: file.kind,
					object_key: objectKey,
					upload_id: multipart.uploadId,
					size: file.size,
					hash: file.hash,
					state: 'open',
					created_at: createdAt,
				})
			}
			await c.env.DB.batch(
				rows.map((row) =>
					c.env.DB.prepare(
						`INSERT INTO studio_editor_upload
						 (id,session_id,account_id,room_id,sub_room_id,unity_asset_id,platform,kind,
						  object_key,upload_id,size,hash,created_at)
						 VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12,?13)`
					).bind(
						row.id,
						row.session_id,
						row.account_id,
						row.room_id,
						row.sub_room_id,
						row.unity_asset_id,
						row.platform,
						row.kind,
						row.object_key,
						row.upload_id,
						row.size,
						row.hash,
						row.created_at
					)
				)
			)
		} catch (error) {
			await Promise.allSettled(rows.map((row) => abortObject(c.env.CDN_ASSETS, row)))
			throw error
		}

		return c.json({
			success: true,
			error: null,
			value: {
				sessionId,
				unityAssetId,
				partSize: PART_SIZE,
				expiresAt: new Date(Date.parse(createdAt) + SESSION_TTL_MS).toISOString(),
				files: rows.map((row) => ({
					platform: row.platform,
					kind: row.kind,
					parts: parts(row.size),
				})),
			},
		})
	})

	.post('/:session/:platform/:kind/part/:part', async (c) => {
		const accountId = await studioCaller(c)
		if (accountId instanceof Response) return accountId
		const rows = await sessionRows(c, accountId)
		if (rows instanceof Response) return rows
		const row = fileRow(c, rows)
		const number = Number(c.req.param('part'))
		if (
			!row ||
			row.state !== 'open' ||
			!Number.isInteger(number) ||
			number < 1 ||
			number > parts(row.size)
		)
			return fail(c, 400, 'Invalid upload part.')
		const config = await signingConfig(c.env)
		if (!config) return fail(c, 503, 'R2 upload signing is not configured.')
		return c.json({ success: true, error: null, value: await signPart(config, row, number) })
	})

	.post('/:session/:platform/:kind/complete', async (c) => {
		const accountId = await studioCaller(c)
		if (accountId instanceof Response) return accountId
		const rows = await sessionRows(c, accountId)
		if (rows instanceof Response) return rows
		const row = fileRow(c, rows)
		if (!row) return fail(c, 404, 'Unknown bundle.')
		if (row.state === 'verified')
			return c.json({ success: true, error: null, value: { verified: true } })
		if (row.state !== 'open') return fail(c, 409, 'Upload verification in progress.')

		const body = (await c.req.json().catch(() => null)) as { parts?: R2UploadedPart[] } | null
		const uploaded = body?.parts
		if (
			!Array.isArray(uploaded) ||
			uploaded.length !== parts(row.size) ||
			uploaded.some((p, i) => p?.partNumber !== i + 1 || typeof p.etag !== 'string' || !p.etag)
		)
			return fail(c, 400, 'Invalid upload parts.')

		const lock = await c.env.DB.prepare(
			"UPDATE studio_editor_upload SET state='verifying' WHERE id=?1 AND state='open'"
		)
			.bind(row.id)
			.run()
		if (!lock.meta.changes) return fail(c, 409, 'Upload verification in progress.')

		let matches: boolean
		try {
			// A completed R2 upload survives a retried complete call.
			if (!(await c.env.CDN_ASSETS.head(row.object_key)))
				await c.env.CDN_ASSETS.resumeMultipartUpload(row.object_key, row.upload_id).complete(
					uploaded
				)
			const object = await c.env.CDN_ASSETS.head(row.object_key)
			if (!object || object.size !== row.size) {
				matches = false
			} else {
				const digest = await readBundleDigest(c.env.CDN_ASSETS, row.object_key, row.size)
				matches =
					digest.size === row.size &&
					digest.hash === row.hash &&
					new TextDecoder().decode(digest.prefix) === 'UnityFS\0'
			}
		} catch (error) {
			await c.env.DB.prepare(
				"UPDATE studio_editor_upload SET state='open' WHERE id=?1 AND state='verifying'"
			)
				.bind(row.id)
				.run()
			throw error
		}

		if (!matches) {
			// The R2 upload is finished, so these bytes can never become the declared ones:
			// drop the whole session and let the caller start over.
			await Promise.allSettled(
				rows.map((r) =>
					abortObject(c.env.CDN_ASSETS, r.id === row.id ? { ...r, state: 'verifying' } : r)
				)
			)
			await c.env.DB.prepare('DELETE FROM studio_editor_upload WHERE session_id=?1')
				.bind(row.session_id)
				.run()
			return fail(c, 400, 'The bundle does not match its declared size, hash or format.')
		}
		await c.env.DB.prepare("UPDATE studio_editor_upload SET state='verified' WHERE id=?1")
			.bind(row.id)
			.run()
		return c.json({ success: true, error: null, value: { verified: true } })
	})

	.post('/:session/finish', async (c) => {
		const accountId = await studioCaller(c)
		if (accountId instanceof Response) return accountId
		const rows = await sessionRows(c, accountId)
		if (rows instanceof Response) return rows
		if (rows.some((row) => row.state !== 'verified'))
			return fail(c, 400, 'Every bundle must be uploaded and verified first.')
		const { room_id: roomId, sub_room_id: subRoomId, unity_asset_id: unityAssetId } = rows[0]!
		// Roles can change during an upload; check again before anything is published.
		if (!(await canManageRoomById(c.env.DB, roomId, accountId)))
			return fail(c, 403, 'This account cannot upload a build for that room.')

		const lock = await c.env.DB.prepare(
			"UPDATE studio_editor_upload SET state='publishing' WHERE session_id=?1 AND state='verified'"
		)
			.bind(rows[0]!.session_id)
			.run()
		if (lock.meta.changes !== rows.length) return fail(c, 409, 'This upload is already finishing.')

		const stored: StoredBundleFile[] = []
		const unlock = () =>
			c.env.DB.prepare(
				"UPDATE studio_editor_upload SET state='verified' WHERE session_id=?1 AND state='publishing'"
			)
				.bind(rows[0]!.session_id)
				.run()
		let build: Awaited<ReturnType<typeof recordLocalCloudBuild>>
		try {
			for (const row of rows) {
				const { filename, key } = finalKey(row)
				const source = await c.env.CDN_ASSETS.get(row.object_key)
				if (!source) throw new Error('Verified bundle disappeared.')
				await c.env.CDN_ASSETS.put(key, source.body)
				stored.push({ platform: row.platform, kind: row.kind, filename, hash: row.hash })
			}
			// Deletes the public copies itself when it refuses or fails.
			build = await recordLocalCloudBuild(
				c.env.DB,
				c.env.CDN_ASSETS,
				roomId,
				subRoomId,
				accountId,
				unityAssetId,
				stored
			)
		} catch (error) {
			await Promise.allSettled(
				stored.map((file) => c.env.CDN_ASSETS.delete(studioBundleR2Key(file.filename)))
			)
			await unlock()
			throw error
		}
		if (!build) {
			await unlock()
			return fail(c, 400, UPLOAD_FIRST)
		}

		await Promise.allSettled(rows.map((row) => c.env.CDN_ASSETS.delete(row.object_key)))
		await c.env.DB.prepare('DELETE FROM studio_editor_upload WHERE session_id=?1')
			.bind(rows[0]!.session_id)
			.run()
		return c.json({
			success: true,
			error: null,
			value: {
				cloudBuildId: build.cloudBuildId,
				startedAt: build.startedAt,
				completedAt: build.completedAt,
				error: build.error,
				unityAssetId: build.unityAssetId,
				createdByAccountId: build.createdByAccountId,
			},
		})
	})

	.post('/:session/abort', async (c) => {
		const accountId = await studioCaller(c)
		if (accountId instanceof Response) return accountId
		const { results } = await c.env.DB.prepare(
			"SELECT * FROM studio_editor_upload WHERE session_id=?1 AND account_id=?2 AND state IN ('open','verified')"
		)
			.bind(c.req.param('session'), accountId)
			.all<Row>()
		for (const row of results) {
			await abortObject(c.env.CDN_ASSETS, row)
			await c.env.DB.prepare('DELETE FROM studio_editor_upload WHERE id=?1').bind(row.id).run()
		}
		return c.json({ success: true, error: null, value: { aborted: true } })
	})

export default editorUploads
