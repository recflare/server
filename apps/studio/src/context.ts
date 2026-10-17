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
	/** Private pull-worker credential; leave unset to disable cloud build dispatch. */
	CLOUD_BUILD_KEY?: string
	CLOUD_BUILD_TARGETS?: string
	CLOUD_BUILD_TEMPLATE_VERSION?: string
}

/** Variables can be extended */
export type Variables = SharedHonoVariables

export interface App extends HonoApp {
	Bindings: Env
	Variables: Variables
}
