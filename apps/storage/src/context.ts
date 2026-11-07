import type { HonoApp } from '@repo/hono-helpers'
import type { SharedHonoEnv, SharedHonoVariables } from '@repo/hono-helpers/src/types'

export type Env = SharedHonoEnv & {
	/** Maximum accepted binary upload size in bytes. */
	MAX_UPLOAD_BYTES?: string | number
	// Shared Secrets Store binding for the HS256 JWT signing key. Resolve the value
	// with `await env.JWT_SECRET.get()`; all workers bind the same store so tokens
	// signed by `auth` verify here.
	JWT_SECRET: SecretsStoreSecret
	// Shared CDN R2 bucket (`recflare-cdn`, owned by the `cdn` worker). Client
	// uploads are written here under a per-FileType subfolder; the `cdn` worker
	// serves them back.
	CDN_ASSETS: R2Bucket
	/**
	 * Cloudflare account id for the R2 S3 endpoint (`<id>.r2.cloudflarestorage.com`), which the
	 * developer video upload presigns against (src/video-upload.ts) — the one thing the
	 * `CDN_ASSETS` binding cannot supply. `RECFLARE_R2_ACCOUNT_ID` in the root `.env`. OPTIONAL:
	 * unset closes `POST /upload/video` (503).
	 */
	R2_ACCOUNT_ID?: string
	/**
	 * An R2 API token's access key id and secret, scoped to Object Read & Write on the CDN bucket
	 * — what signs the upload URL. Same account-level Secrets Store as JWT_SECRET; the bindings
	 * must resolve for the deploy, so an operator who wants no video uploads creates them with any
	 * placeholder value, which leaves the route closed.
	 */
	R2_ACCESS_KEY_ID: SecretsStoreSecret
	R2_SECRET_ACCESS_KEY: SecretsStoreSecret
}

/** Variables can be extended */
export type Variables = SharedHonoVariables

export interface App extends HonoApp {
	Bindings: Env
	Variables: Variables
}
