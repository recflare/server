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
	 * The shared `recflare` D1. This worker owns (and migrates) one table on it,
	 * `roomie_api_key` — each player's own sealed OpenAI key — and counts its rate limits on
	 * `auth`'s `rate_limit`.
	 */
	DB: D1Database
	/**
	 * The keyring the Roomie API keys are sealed with (see src/roomie-key.ts). Bound by this
	 * worker ALONE: no other worker can open a stored key. Missing or malformed, Roomie
	 * conversation is simply unavailable — keys can't be stored, and stored ones aren't used.
	 */
	ROOMIE_KEY_ENCRYPTION_KEY: SecretsStoreSecret
	/** The OpenAI Realtime model session tokens are minted for. Unset: `gpt-realtime`. */
	ROOMIE_REALTIME_MODEL?: string
	/**
	 * Where OpenAI is reached. Unset in production (plain `fetch` to api.openai.com); the
	 * tests bind a stub worker here so no request leaves the test.
	 */
	OPENAI?: Fetcher
}

/** Variables can be extended */
export type Variables = SharedHonoVariables

export interface App extends HonoApp {
	Bindings: Env
	Variables: Variables
}
