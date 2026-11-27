import type { HonoApp } from '@repo/hono-helpers'
import type { SharedHonoEnv, SharedHonoVariables } from '@repo/hono-helpers/src/types'

export type Env = SharedHonoEnv & {
	/**
	 * Shared Secrets Store binding for the HS256 JWT signing key. Resolve the value with
	 * `await env.JWT_SECRET.get()`; every worker binds the same store, so tokens signed by
	 * `auth` verify here.
	 */
	JWT_SECRET: SecretsStoreSecret
	/**
	 * The shared `recflare` D1, read only to ask whether a player has a Roomie API key on
	 * file (`roomie_api_key`, owned by the `ai` worker). Never key material.
	 */
	DB: D1Database
}

/** Variables can be extended */
export type Variables = SharedHonoVariables

export interface App extends HonoApp {
	Bindings: Env
	Variables: Variables
}
