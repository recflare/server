import { presignUrl } from './r2-presign'

import type { Env } from './context'

/**
 * Developer video uploads: a staff member picks a video, www hands back a short-lived presigned
 * `PUT` for the shared `recflare-cdn` bucket, and the browser sends the file straight to R2. The
 * bytes never pass through a Worker, whose request body limit is far below a video's size.
 *
 * The `cdn` worker serves the result at `/video/<name>` (the developer remote-video screen's
 * source). This module only plans the key and signs; the handler (src/staff.ts) gates and audits.
 */

/** How long the presigned URL stays valid. The upload starts the moment it is issued. */
export const VIDEO_UPLOAD_TTL_SECONDS = 900

/** The bucket's default name — the one every worker binds as `CDN_ASSETS` (wrangler.jsonc). */
const DEFAULT_BUCKET = 'recflare-cdn'

/**
 * What the form accepts, by extension. The server — not the browser's guess at a `File.type`,
 * which is empty for some containers — decides the content type, and the signature binds it, so
 * the file is stored with a type a player can actually stream.
 */
const VIDEO_TYPES: Record<string, string> = {
	mp4: 'video/mp4',
	m4v: 'video/mp4',
	webm: 'video/webm',
	mov: 'video/quicktime',
}

export interface VideoUploadPlan {
	/** The R2 object key, `video/<name>-<id>.<ext>`: what the `cdn` worker serves at `/<key>`. */
	key: string
	contentType: string
}

/**
 * The key and content type for a chosen filename, or `null` for one the form does not accept.
 *
 * The name is reduced to `[a-z0-9._-]` and given a random suffix, so two uploads of
 * `intro.mp4` are two objects and nobody replaces another developer's video by reusing a name.
 */
export function planVideoUpload(filename: string): VideoUploadPlan | null {
	const dot = filename.lastIndexOf('.')
	const ext = dot === -1 ? '' : filename.slice(dot + 1).toLowerCase()
	const contentType = VIDEO_TYPES[ext]
	if (contentType === undefined) return null

	const stem =
		filename
			.slice(0, dot)
			.toLowerCase()
			.replace(/[^a-z0-9._-]+/g, '-')
			.replace(/^[-.]+|[-.]+$/g, '')
			.slice(0, 60) || 'video'
	return { key: `video/${stem}-${crypto.randomUUID().slice(0, 8)}.${ext}`, contentType }
}

export interface R2UploadConfig {
	accountId: string
	bucket: string
	accessKeyId: string
	secretAccessKey: string
}

/**
 * The S3 credentials for the CDN bucket, or `null` when the operator has not set them up — the
 * upload then answers 503 rather than signing with nothing. A Secrets Store binding that has no
 * value throws on `get()`, and a placeholder (the deploy needs the binding to resolve) reads as
 * empty; both mean "not configured".
 */
export async function r2UploadConfig(env: Env): Promise<R2UploadConfig | null> {
	const accountId = env.R2_ACCOUNT_ID?.trim()
	if (!accountId) return null
	try {
		const accessKeyId = (await env.R2_ACCESS_KEY_ID.get()).trim()
		const secretAccessKey = (await env.R2_SECRET_ACCESS_KEY.get()).trim()
		if (!accessKeyId || !secretAccessKey) return null
		return {
			accountId,
			bucket: env.CDN_BUCKET_NAME?.trim() || DEFAULT_BUCKET,
			accessKeyId,
			secretAccessKey,
		}
	} catch {
		return null
	}
}

/** A presigned `PUT` for `plan.key`, pinned to the plan's content type. */
export function presignVideoUpload(config: R2UploadConfig, plan: VideoUploadPlan): Promise<string> {
	return presignUrl({
		method: 'PUT',
		host: `${config.accountId}.r2.cloudflarestorage.com`,
		path: `/${config.bucket}/${plan.key}`,
		region: 'auto',
		accessKeyId: config.accessKeyId,
		secretAccessKey: config.secretAccessKey,
		expiresIn: VIDEO_UPLOAD_TTL_SECONDS,
		headers: { 'content-type': plan.contentType },
	})
}
