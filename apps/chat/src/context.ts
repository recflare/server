import type { HonoApp } from '@repo/hono-helpers'
import type { SharedHonoEnv, SharedHonoVariables } from '@repo/hono-helpers/src/types'
// Type-only import (erased at build) of the DO class owned by the `notify` worker,
// so this worker can push websocket notifications through its RPC surface.
import type { NotificationsHub } from '../../notify/src/notifications-hub'

export type Env = SharedHonoEnv & {
	// Shared Secrets Store binding for the HS256 JWT signing key. Resolve the value
	// with `await env.JWT_SECRET.get()`; all workers bind the same store so tokens
	// signed by `auth` verify here.
	JWT_SECRET: SecretsStoreSecret
	/**
	 * Shared `recflare` D1 — this worker owns the `message` and thread tables. The
	 * caller's chat privacy settings (`/thread/chatPrivacySetting`) and `LatestPartyChat`
	 * live in `player_settings` (owned by the `playersettings` worker), alongside their
	 * other toggles.
	 */
	DB: D1Database
	/** The `notify` worker's NotificationsHub DO — pushes ChatMessageReceived to members. */
	RECFLARE_NOTIFICATIONS_HUB: DurableObjectNamespace<NotificationsHub>
}

/** Variables can be extended */
export type Variables = SharedHonoVariables

export interface App extends HonoApp {
	Bindings: Env
	Variables: Variables
}
