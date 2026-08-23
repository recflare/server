import type { HonoApp } from '@repo/hono-helpers'
import type { SharedHonoEnv, SharedHonoVariables } from '@repo/hono-helpers/src/types'

export type Env = SharedHonoEnv & {
	// Shared Secrets Store binding for the HS256 JWT signing key. Resolve the value
	// with `await env.JWT_SECRET.get()`; all workers bind the same store so tokens
	// signed by `auth` verify here.
	JWT_SECRET: SecretsStoreSecret
	// R2 bucket holding CDN binaries: signature blobs under `sigs/<name>` and
	// room build data under `room/<name>`.
	CDN_ASSETS: R2Bucket
	// Static-asset fetcher for the JSON configs in `static/config/` (see wrangler.jsonc
	// `assets`). Fetched by filename so `/config/:name` serves whatever is published;
	// the binding is the only way in, since `run_worker_first` keeps the runtime from
	// serving the files directly.
	ASSETS: Fetcher
}

/** Variables can be extended */
export type Variables = SharedHonoVariables

export interface App extends HonoApp {
	Bindings: Env
	Variables: Variables
}
