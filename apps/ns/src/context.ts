import type { HonoApp } from '@repo/hono-helpers'
import type { SharedHonoEnv, SharedHonoVariables } from '@repo/hono-helpers/src/types'
import type { EndpointStyle } from './endpoints'

export type Env = SharedHonoEnv & {
	/**
	 * Base domain the service hosts are derived from, e.g. `rec.example.com`.
	 * Injected at deploy time via `--var DOMAIN`; defaults in `wrangler.jsonc`
	 * for local dev and tests.
	 */
	DOMAIN: string
	/**
	 * `path` to serve every service from a path on `DOMAIN` (`https://<domain>/rooms`)
	 * instead of from its own subdomain. Set only by the combined `mono` worker, which is
	 * one Worker routing on that first path segment; anything else (the split deployment)
	 * leaves it unset and gets the per-service hosts.
	 */
	ENDPOINT_STYLE?: EndpointStyle
}

/** Variables can be extended */
export type Variables = SharedHonoVariables

export interface App extends HonoApp {
	Bindings: Env
	Variables: Variables
}
