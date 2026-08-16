import type { HonoApp } from '@repo/hono-helpers'
import type { SharedHonoEnv, SharedHonoVariables } from '@repo/hono-helpers/src/types'
// Type-only import (erased at build) of the DO class owned by the `notify`
// worker, so the cross-worker RPC stub is fully typed.
import type { NotificationsHub } from '../../notify/src/notifications-hub'

export type Env = SharedHonoEnv & {
	// Shared Secrets Store binding for the HS256 JWT signing key. Resolve the value
	// with `await env.JWT_SECRET.get()`; all workers bind the same store so tokens
	// signed by `auth` verify here.
	JWT_SECRET: SecretsStoreSecret
	/**
	 * Base domain the share-link URL is derived from, e.g. `rec.example.com`.
	 * Injected at deploy time via `--var DOMAIN`; defaults in `wrangler.jsonc`
	 * for local dev and tests.
	 */
	DOMAIN: string
	// Shared rooms database (schema/migrations owned by the `rooms` worker). Used
	// read-only here to resolve room roles for `/api/rooms/v1/verifyRole`.
	DB: D1Database
	// Image bucket (shared with the `img` worker, which serves objects back by
	// key). Uploaded saved images are written here.
	IMAGES: R2Bucket
	// Shared CDN bucket (owned by the `cdn` worker, written by `storage`). Read
	// here only to hash an invention's uploaded data blob under `invention/`.
	CDN_ASSETS: R2Bucket
	// Per-player settings bag (KV owned by the `playersettings` worker, which serves
	// the same map at `/playersettings`). Key `player:<id>` → JSON `{ key: value }`;
	// read/written here for the player preferences the client calls by name.
	RECFLARE_PLAYER_SETTINGS: KVNamespace
	// SignalR notifications hub (DO owned by the `notify` worker). Bound here to
	// push RelationshipChanged notifications when a player's relationship changes.
	RECFLARE_NOTIFICATIONS_HUB: DurableObjectNamespace<NotificationsHub>
}

/** Variables can be extended */
export type Variables = SharedHonoVariables

export interface App extends HonoApp {
	Bindings: Env
	Variables: Variables
}
