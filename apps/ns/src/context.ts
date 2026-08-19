import type { HonoApp } from '@repo/hono-helpers'
import type { SharedHonoEnv, SharedHonoVariables } from '@repo/hono-helpers/src/types'

export type Env = SharedHonoEnv & {
	/**
	 * Base domain the service hosts are derived from, e.g. `rec.example.com`.
	 * Injected at deploy time via `--var DOMAIN`; defaults in `wrangler.jsonc`
	 * for local dev and tests.
	 */
	DOMAIN: string

	/**
	 * Per-service subdomain overrides as a raw JSON object keyed by default subdomain,
	 * e.g. `{"moderation":"api"}`. The operator's `RECFLARE_SUBDOMAINS`, injected at deploy
	 * time via `--var SUBDOMAINS`; defaults to `{}` in `wrangler.jsonc`. See
	 * `parseOverrides` in `endpoints.ts`.
	 */
	SUBDOMAINS: string
}

/** Variables can be extended */
export type Variables = SharedHonoVariables

export interface App extends HonoApp {
	Bindings: Env
	Variables: Variables
}
