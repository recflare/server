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
}

/** Variables can be extended */
export type Variables = SharedHonoVariables

export interface App extends HonoApp {
	Bindings: Env
	Variables: Variables
}
