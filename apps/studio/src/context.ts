import type { HonoApp } from '@repo/hono-helpers'
import type { SharedHonoEnv, SharedHonoVariables } from '@repo/hono-helpers/src/types'

export type Env = SharedHonoEnv & {
	/**
	 * Shared Secrets Store binding for the HS256 JWT signing key. Resolve the value with
	 * `await env.JWT_SECRET.get()`; every worker binds the same store, so tokens signed by
	 * `auth` verify here.
	 */
	JWT_SECRET: SecretsStoreSecret
	// Shared `recflare` D1. Room ownership lives in the `room` blob (the `rooms`
	// worker owns that schema) and who is standing where lives in `presence`.
	// This worker migrates its own cloud-build table (`studio_cloud_build`), writes
	// each bundle it stores as a row of the rooms worker's `unity_asset`, and only
	// reads the room tables.
	DB: D1Database
	// Shared `recflare-cdn` bucket. Local Studio builds land under
	// `room/studio/<roomId>/`. The same bucket name the rooms and cdn workers bind.
	CDN_ASSETS: R2Bucket
	// Shared `recflare-img` bucket (also bound by `api` / `img` / `mono`). The web avatar upload
	// puts an item's thumbnail here, where the image host serves it from.
	IMAGES: R2Bucket
	/**
	 * Private pull-worker credential, out of the shared Secrets Store (same store as
	 * JWT_SECRET). Read it through `cloudBuildKey()` in cloud-builds.ts, never `.get()`
	 * directly: the value `off` (or an unreadable secret) means cloud building is disabled.
	 */
	CLOUD_BUILD_KEY: SecretsStoreSecret
	CLOUD_BUILD_TARGETS?: string
	CLOUD_BUILD_TEMPLATE_VERSION?: string
	/** R2 key of an operator-published template catalog; unset disables downloads. */
	STUDIO_DISTRIBUTION_MANIFEST?: string
	/**
	 * Discord role ids whose holders have Studio upload access without the account's
	 * `hasStudio` flag (`RECFLARE_STUDIO_ROLLOUT` in the root `.env`; the same var `auth`
	 * stamps `betastudio` from). The access lookups here rebuild the role from the account
	 * rather than a token, so they read it through the same `hasStudioAccess`.
	 */
	STUDIO_ROLLOUT?: string
}

/** Variables can be extended */
export type Variables = SharedHonoVariables

export interface App extends HonoApp {
	Bindings: Env
	Variables: Variables
}
