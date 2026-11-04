import { createHash } from 'node:crypto'
import { Hono } from 'hono'

import { presignUrl } from '@repo/hono-helpers'

import type { Artifact, Job } from './cloud-builds'
import type { App, Env } from './context'

export const PART_SIZE = 16 * 1024 * 1024
export const MAX_BUNDLE_SIZE = 128 * 1024 * 1024
export const UPLOAD_SCHEMA = `CREATE TABLE IF NOT EXISTS studio_artifact_upload (
 id TEXT PRIMARY KEY, build_id TEXT NOT NULL, lease TEXT NOT NULL,
 artifact TEXT NOT NULL, object_key TEXT NOT NULL, final_key TEXT NOT NULL, upload_id TEXT NOT NULL,
 size INTEGER NOT NULL, hash TEXT NOT NULL, state TEXT NOT NULL DEFAULT 'open',
 created_at TEXT NOT NULL, UNIQUE(build_id,lease,artifact))`
type Upload = {
	id: string
	build_id: string
	lease: string
	artifact: string
	object_key: string
	final_key: string
	upload_id: string
	size: number
	hash: string
	state: string
}
type Signer = { accountId: string; bucket: string; accessKeyId: string; secretAccessKey: string }
export async function signPart(config: Signer, upload: Upload, number: number) {
	const length = Math.min(PART_SIZE, upload.size - (number - 1) * PART_SIZE)
	const headers = { 'Content-Length': String(length), 'Content-Type': 'application/octet-stream' }
	const url = await presignUrl({
		method: 'PUT',
		host: `${config.accountId}.r2.cloudflarestorage.com`,
		path: `/${config.bucket}/${upload.object_key}`,
		region: 'auto',
		accessKeyId: config.accessKeyId,
		secretAccessKey: config.secretAccessKey,
		expiresIn: 120,
		query: { uploadId: upload.upload_id, partNumber: String(number) },
		headers: { 'content-length': String(length), 'content-type': 'application/octet-stream' },
	})
	return { url, headers, length }
}
async function signingConfig(env: Env): Promise<Signer | null> {
	try {
		const accountId = env.R2_ACCOUNT_ID?.trim() ?? ''
		const accessKeyId = (await env.R2_ACCESS_KEY_ID?.get())?.trim() ?? ''
		const secretAccessKey = (await env.R2_SECRET_ACCESS_KEY?.get())?.trim() ?? ''
		const bucket = env.R2_CDN_BUCKET?.trim() || 'recflare-cdn'
		return /^[a-f0-9]{32}$/.test(accountId) &&
			/^[a-z0-9-]+$/.test(bucket) &&
			accessKeyId &&
			secretAccessKey &&
			accessKeyId.toLowerCase() !== 'off' &&
			secretAccessKey.toLowerCase() !== 'off'
			? { accountId, bucket, accessKeyId, secretAccessKey }
			: null
	} catch {
		return null
	}
}

async function active(env: Env, build: string, lease: string) {
	return env.DB.prepare(
		"SELECT payload FROM studio_cloud_build_job WHERE cloud_build_id=? AND lease_token=? AND status='building' AND lease_until>?"
	)
		.bind(build, lease, new Date().toISOString())
		.first<{ payload: string }>()
}
export async function cleanupUploads(env: Env) {
	const rows = await env.DB.prepare(
		`SELECT u.* FROM studio_artifact_upload u LEFT JOIN studio_cloud_build_job j ON j.cloud_build_id=u.build_id
 WHERE j.cloud_build_id IS NULL OR j.lease_token IS NOT u.lease OR j.status NOT IN ('building','publishing') OR j.lease_until<=? LIMIT 20`
	)
		.bind(new Date().toISOString())
		.all<Upload>()
	for (const row of rows.results) {
		try {
			if (row.state !== 'verified' && !(await env.CDN_ASSETS.head(row.object_key))) {
				try {
					await env.CDN_ASSETS.resumeMultipartUpload(row.object_key, row.upload_id).abort()
				} catch (error) {
					if (!/NoSuchUpload|does not exist|not found/i.test(String(error))) throw error
				}
			}
			await env.CDN_ASSETS.delete(row.object_key)
			const artifact = JSON.parse(row.artifact) as Artifact
			const published = await env.DB.prepare(
				'SELECT filename FROM unity_asset WHERE unity_asset_id=? AND target=? AND kind=? AND version=?'
			)
				.bind(artifact.unityAssetId, artifact.target, artifact.kind, artifact.version)
				.first<{ filename: string }>()
			if (!published || !row.final_key.endsWith(published.filename))
				await env.CDN_ASSETS.delete(row.final_key)
			await env.DB.prepare('DELETE FROM studio_artifact_upload WHERE id=?').bind(row.id).run()
		} catch {
			/* Retry on the next claim; never delete a public bundle here. */
		}
	}
}
export function multipartArtifacts(
	allowed: (job: Job, entry: Artifact) => boolean,
	location: (job: Job, lease: string, entry: Artifact) => { key: string }
) {
	return new Hono<App>()
		.use('/:id/uploads/*', async (c, next) => {
			if (!(await active(c.env, c.req.param('id'), c.req.header('X-Studio-Lease') ?? '')))
				return c.json({ error: 'Inactive build lease.' }, 409)
			return next()
		})
		.post('/:id/uploads/start', async (c) => {
			if (!(await signingConfig(c.env)))
				return c.json({ error: 'R2 upload signing is not configured.' }, 503)
			const lease = c.req.header('X-Studio-Lease')!
			const job = JSON.parse((await active(c.env, c.req.param('id'), lease))!.payload)
			const body = await c.req.json<{ artifact: Artifact; size: number; hash: string }>()
			if (Number.isSafeInteger(body.size) && body.size > MAX_BUNDLE_SIZE)
				return c.json({ error: 'Bundle exceeds the 128 MiB upload limit.' }, 413)
			if (
				!body.artifact ||
				!allowed(job, body.artifact) ||
				!Number.isSafeInteger(body.size) ||
				body.size < 8 ||
				body.size > MAX_BUNDLE_SIZE ||
				!/^[A-Za-z0-9+/]{43}=$/.test(body.hash)
			)
				return c.json({ error: 'Invalid artifact upload.' }, 400)
			const artifact = JSON.stringify({
				unityAssetId: body.artifact.unityAssetId,
				target: body.artifact.target,
				kind: body.artifact.kind,
				version: body.artifact.version,
			})
			let row = await c.env.DB.prepare(
				'SELECT * FROM studio_artifact_upload WHERE build_id=? AND lease=? AND artifact=?'
			)
				.bind(job.buildId, lease, artifact)
				.first<Upload>()
			if (row && (row.size !== body.size || row.hash !== body.hash))
				return c.json({ error: 'Artifact changed during upload.' }, 409)
			if (!row) {
				const id = crypto.randomUUID(),
					key = `studio-upload-parts/${job.buildId}/${lease}/${id}`
				const multipart = await c.env.CDN_ASSETS.createMultipartUpload(key)
				try {
					await c.env.DB.prepare(
						'INSERT INTO studio_artifact_upload(id,build_id,lease,artifact,object_key,final_key,upload_id,size,hash,created_at) VALUES(?,?,?,?,?,?,?,?,?,?)'
					)
						.bind(
							id,
							job.buildId,
							lease,
							artifact,
							key,
							location(job, lease, body.artifact).key,
							multipart.uploadId,
							body.size,
							body.hash,
							new Date().toISOString()
						)
						.run()
				} catch {
					await multipart.abort()
					return c.json({ error: 'Upload initialization raced; retry.' }, 503)
				}
				row = (await c.env.DB.prepare('SELECT * FROM studio_artifact_upload WHERE id=?')
					.bind(id)
					.first<Upload>())!
			}
			return c.json({
				id: row.id,
				partSize: PART_SIZE,
				parts: Math.ceil(row.size / PART_SIZE),
				verified: row.state === 'verified',
			})
		})
		.post('/:id/uploads/:upload/part/:part', async (c) => {
			const row = await c.env.DB.prepare(
				"SELECT * FROM studio_artifact_upload WHERE id=? AND build_id=? AND lease=? AND state='open'"
			)
				.bind(c.req.param('upload'), c.req.param('id'), c.req.header('X-Studio-Lease'))
				.first<Upload>()
			const number = Number(c.req.param('part'))
			if (row && row.size > MAX_BUNDLE_SIZE)
				return c.json({ error: 'Bundle exceeds the 128 MiB upload limit.' }, 413)
			if (
				!row ||
				!Number.isInteger(number) ||
				number < 1 ||
				number > Math.ceil(row.size / PART_SIZE)
			)
				return c.json({ error: 'Invalid upload part.' }, 400)
			const config = await signingConfig(c.env)
			if (!config) return c.json({ error: 'R2 upload signing is not configured.' }, 503)
			return c.json(await signPart(config, row, number))
		})
		.post('/:id/uploads/:upload/complete', async (c) => {
			const row = await c.env.DB.prepare(
				'SELECT * FROM studio_artifact_upload WHERE id=? AND build_id=? AND lease=?'
			)
				.bind(c.req.param('upload'), c.req.param('id'), c.req.header('X-Studio-Lease'))
				.first<Upload>()
			if (!row) return c.json({ error: 'Unknown upload.' }, 404)
			if (row.size > MAX_BUNDLE_SIZE)
				return c.json({ error: 'Bundle exceeds the 128 MiB upload limit.' }, 413)
			if (row.state === 'verified') return c.json({ verified: true })
			const body = await c.req.json<{ parts: R2UploadedPart[] }>()
			if (
				!Array.isArray(body.parts) ||
				body.parts.length !== Math.ceil(row.size / PART_SIZE) ||
				body.parts.some((p, i) => p.partNumber !== i + 1 || typeof p.etag !== 'string' || !p.etag)
			)
				return c.json({ error: 'Invalid upload parts.' }, 400)
			const lock = await c.env.DB.prepare(
				"UPDATE studio_artifact_upload SET state='verifying' WHERE id=? AND state='open'"
			)
				.bind(row.id)
				.run()
			if (!lock.meta.changes) return c.json({ error: 'Upload verification in progress.' }, 409)
			try {
				// A completed R2 upload survives a control-request retry.
				if (!(await c.env.CDN_ASSETS.head(row.object_key)))
					await c.env.CDN_ASSETS.resumeMultipartUpload(row.object_key, row.upload_id).complete(
						body.parts
					)
				const object = await c.env.CDN_ASSETS.head(row.object_key)
				if (!object || object.size !== row.size) throw new Error('Artifact size mismatch.')
				const hash = createHash('sha256'),
					prefix: number[] = []
				let size = 0
				// Bound R2 reads as well as uploads; do not keep one large verification
				// response stream open for the entire object.
				while (size < row.size) {
					const length = Math.min(PART_SIZE, row.size - size)
					const part = await c.env.CDN_ASSETS.get(row.object_key, {
						range: { offset: size, length },
					})
					if (!part) throw new Error('Artifact disappeared during verification.')
					const chunk = new Uint8Array(await part.arrayBuffer())
					if (chunk.byteLength !== length) throw new Error('Artifact range size mismatch.')
					size += chunk.byteLength
					hash.update(chunk)
					for (const byte of chunk.subarray(0, Math.max(0, 8 - prefix.length))) prefix.push(byte)
				}
				if (
					size !== row.size ||
					new TextDecoder().decode(new Uint8Array(prefix)) !== 'UnityFS\0' ||
					hash.digest('base64') !== row.hash
				)
					throw new Error('Artifact content verification failed.')
				if (!(await active(c.env, row.build_id, row.lease)))
					throw new Error('Build lease expired during verification.')
				const key = row.final_key
				await c.env.DB.prepare(
					"UPDATE studio_artifact_upload SET state='storing' WHERE id=? AND state='verifying'"
				)
					.bind(row.id)
					.run()
				const source = await c.env.CDN_ASSETS.get(row.object_key)
				if (!source) throw new Error('Verified artifact disappeared.')
				await c.env.CDN_ASSETS.put(key, source.body, { customMetadata: { studioHash: row.hash } })
				await c.env.DB.prepare("UPDATE studio_artifact_upload SET state='verified' WHERE id=?")
					.bind(row.id)
					.run()
				await c.env.CDN_ASSETS.delete(row.object_key)
				return c.json({ verified: true })
			} catch (error) {
				await c.env.DB.prepare(
					"UPDATE studio_artifact_upload SET state='open' WHERE id=? AND state IN ('verifying','storing')"
				)
					.bind(row.id)
					.run()
				throw error
			}
		})
		.post('/:id/uploads/:upload/abort', async (c) => {
			const row = await c.env.DB.prepare(
				'SELECT * FROM studio_artifact_upload WHERE id=? AND build_id=? AND lease=?'
			)
				.bind(c.req.param('upload'), c.req.param('id'), c.req.header('X-Studio-Lease'))
				.first<Upload>()
			if (row?.state === 'open') {
				await c.env.CDN_ASSETS.resumeMultipartUpload(row.object_key, row.upload_id).abort()
				await c.env.CDN_ASSETS.delete(row.object_key)
				await c.env.DB.prepare('DELETE FROM studio_artifact_upload WHERE id=?').bind(row.id).run()
			}
			return c.json({ aborted: true })
		})
}
