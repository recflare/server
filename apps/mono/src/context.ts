import type { SharedHonoEnv, SharedHonoVariables } from '@repo/hono-helpers/src/types'
// Type-only import (erased at build) of the DO class this worker re-exports from its
// entry. The parameter has to be here, not just on `match`'s Env: `scheduled` hands this
// worker's superset Env straight to `matchScheduled`, and a bare `DurableObjectNamespace`
// is not assignable to the `DurableObjectNamespace<NotificationsHub>` that one declares.
import type { NotificationsHub } from '../../notify/src/notifications-hub'

/**
 * Union of every mounted worker's bindings.
 *
 * Because the split workers already share the same underlying resources — one
 * `recflare` D1, one Secrets Store, the shared R2 buckets, the single KV namespace and
 * the Notifications Durable Object — this is a de-duplicated union, not a migration.
 * Each mounted app reads only the subset it needs; a superset `Env` is assignable to
 * each app's narrower `Env`, so the sub-apps type-check unchanged.
 */
export type Env = SharedHonoEnv & {
	/**
	 * Base domain this worker answers on, e.g. `rec.example.com` — injected from
	 * `RECFLARE_DOMAIN` by both `run-wrangler-dev` and `run-wrangler-deploy`, with a
	 * placeholder default in `wrangler.jsonc` for tests and an unconfigured checkout.
	 *
	 * Read by the mounted `ns` app to build the service-discovery document — the thing a
	 * client is pointed at — so it has to name the host that actually reaches this worker:
	 * the tunnel/LAN hostname when running it locally, and the apex of the domain when
	 * deployed (`RECFLARE_SUBDOMAINS='{"mono":"@"}'`, `just deploy-mono`). Every service
	 * mounted here is served from a PATH on that one host, so the document says
	 * `https://<domain>/rooms` and nothing else would answer there.
	 */
	DOMAIN: string
	// HS256 JWT signing key (shared Secrets Store). Tokens signed by `auth` verify everywhere.
	JWT_SECRET: SecretsStoreSecret
	// Meta (Oculus) app secret, from the same store. Read only by `auth`, to validate a
	// headset login's nonce with Meta (see apps/auth/src/meta-nonce.ts).
	META_APP_SECRET: SecretsStoreSecret
	// Shared `recflare` database (accounts, auth, api, clubs, match, rooms, …).
	DB: D1Database
	// Image storage bucket (api, img).
	IMAGES: R2Bucket
	// Binary room-data CDN bucket (cdn, rooms, storage).
	CDN_ASSETS: R2Bucket
	// Per-player settings (playersettings).
	RECFLARE_PLAYER_SETTINGS: KVNamespace
	// Real-time notifications hub. The class is defined in `notify` and re-exported by
	// this worker's entry so the binding resolves in-process (no `script_name`).
	RECFLARE_NOTIFICATIONS_HUB: DurableObjectNamespace<NotificationsHub>
}

export type Variables = SharedHonoVariables
