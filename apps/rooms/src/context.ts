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
	// Shared `recflare` D1. Owns the rooms tables (JSON blob + generated columns,
	// see rooms-db.ts) and migrates the shared `presence` table, which is read here
	// to resolve the caller's current room instance for the photon access token.
	DB: D1Database
	// SignalR notifications hub (DO owned by the `notify` worker). Bound here to
	// push RoomUpdate notifications when a room is mutated.
	RECFLARE_NOTIFICATIONS_HUB: DurableObjectNamespace<NotificationsHub>
	// Shared `recflare-cdn` R2 bucket (the `cdn`/`storage` workers own it). Room
	// images/files live here under the `room/` key prefix; bound so deleting a room
	// can remove its image object.
	CDN_ASSETS: R2Bucket
	// The per-player settings map the `playersettings` worker owns (`player:<id>` → JSON
	// `{ key: value }`). Holds the dorm the player picked through `PUT /dormroom/me`; every
	// write MERGES into the map, since it carries every other setting the player has.
	RECFLARE_PLAYER_SETTINGS: KVNamespace
	// How many rooms one account may create (optional). Unset falls back to
	// DEFAULT_MAX_ROOMS_PER_ACCOUNT in rooms.app.ts; 0 lifts the cap. Typed
	// `string | number` because a var declared in wrangler.jsonc `vars` arrives as a
	// number while the same var set from the dashboard or `--var` arrives as a string —
	// read it through `intVar`, never as a bare number.
	MAX_ROOMS_PER_ACCOUNT?: string | number
	// The same cap for a Rec Room Plus subscriber (token `rn.plus`). Unset falls back to
	// DEFAULT_MAX_ROOMS_PER_ACCOUNT_PLUS (100); 0 lifts it for subscribers. Read via `intVar`.
	MAX_ROOMS_PER_ACCOUNT_PLUS?: string | number
}

/** Variables can be extended */
export type Variables = SharedHonoVariables

export interface App extends HonoApp {
	Bindings: Env
	Variables: Variables
}
