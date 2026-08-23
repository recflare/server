import type { HonoApp } from '@repo/hono-helpers'
import type { SharedHonoEnv, SharedHonoVariables } from '@repo/hono-helpers/src/types'

export type Env = SharedHonoEnv & {
	/**
	 * Static-asset fetcher for the page layouts in `static/` (see wrangler.jsonc
	 * `assets`). Fetched by filename so `{type}` is a wildcard; the binding is the only
	 * way in, since `run_worker_first` keeps the runtime from serving the files directly.
	 */
	ASSETS: Fetcher
}

/** Variables can be extended */
export type Variables = SharedHonoVariables

export interface App extends HonoApp {
	Bindings: Env
	Variables: Variables
}
