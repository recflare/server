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
	/** Shared `recflare` D1 (accounts table) — stores the player's avatar. */
	DB: D1Database
	/** Static storefront catalogs (`static/storefronts/sf*.json`), fetched by path. */
	ASSETS: Fetcher
	/** The `notify` worker's NotificationsHub DO — push websocket notifications to a player. */
	RECFLARE_NOTIFICATIONS_HUB: DurableObjectNamespace<NotificationsHub>
	/**
	 * The RecCenterTokens a new player is granted (see balance-db.ts). Optional — unset
	 * falls back to DEFAULT_STARTING_TOKENS, and 0 means players start broke.
	 *
	 * Typed `string | number` because a var declared in wrangler.jsonc `vars` arrives as a
	 * number while the same var set from the dashboard or `--var` arrives as a string —
	 * read it through `intVar`, never as a bare number.
	 */
	STARTING_TOKENS?: string | number
	/**
	 * The Discord supporter gift (see discord-role-gift.ts): Discord ROLE ids mapped to the
	 * RecCenterTokens a holder is boxed each time the cron fires, `<roleId>=<tokens>` pairs
	 * separated by commas, e.g. `928457923857943795=2500,2938479238479234=10000`. Role ids
	 * are snowflakes — all digits, never a role's name — kept as strings because one
	 * exceeds 2^53. One box per account per run: a holder of several mapped roles is paid
	 * the HIGHEST amount. Optional: unset, or parsing to no roles, leaves the cron off.
	 * Roles are read from `platform_account.role`, the snapshot `www`'s claim and daily
	 * sweep maintain, so this only ever pays players who have claimed on the website.
	 */
	DISCORD_ROLE_TOKENS?: string
}

/** Variables can be extended */
export type Variables = SharedHonoVariables

export interface App extends HonoApp {
	Bindings: Env
	Variables: Variables
}
