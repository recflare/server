import type { HonoApp } from '@repo/hono-helpers'
import type { SharedHonoEnv, SharedHonoVariables } from '@repo/hono-helpers/src/types'

export type Env = SharedHonoEnv & {
	/** Base domain the auth/accounts hosts are derived from (see wrangler.jsonc). */
	DOMAIN: string
	/** Static-asset fetcher for the built React SPA (see wrangler.jsonc `assets`). */
	ASSETS: Fetcher
	/**
	 * The shared `recflare` D1, bound READ-ONLY in practice: the only thing www asks it
	 * is the live presence head-count behind `/server-status`. Every table it can see is
	 * owned (and migrated) by another worker.
	 */
	DB: D1Database
	/**
	 * Service binding to the `auth` worker — how the BFF reaches it, so the browser's real
	 * IP survives the hop (see wrangler.jsonc and src/upstream.ts `postAuthForm`).
	 *
	 * OPTIONAL because a deployed www always has it (it's declared in wrangler.jsonc) but
	 * standalone local dev doesn't: `vite dev` runs www on its own against a deployed
	 * DOMAIN, with no `auth` session to bind to. Absent, `postAuthForm` falls back to
	 * fetching auth.<DOMAIN> — the pre-binding behaviour, correct except for the IP.
	 */
	AUTH?: Fetcher
	/**
	 * The Turnstile widget's public site key. Public by design — it ships to the browser so
	 * the widget can render — but it lives in the Secrets Store beside its secret, so one
	 * place configures signup and there's a single place to look.
	 *
	 * Resolve the value with `await env.TURNSTILE_SITE_KEY.get()`.
	 */
	TURNSTILE_SITE_KEY: SecretsStoreSecret
	/**
	 * The Turnstile widget's secret key — the one that turns a widget token into a verdict.
	 * Same shared account-level store as JWT_SECRET; the store id is spliced into
	 * wrangler.jsonc at deploy time (RECFLARE_SECRETS_STORE).
	 *
	 * Store values survive a deploy, so both are created once and left alone. Either one
	 * failing to resolve closes web signup — see src/turnstile.ts.
	 */
	TURNSTILE_SECRET_KEY: SecretsStoreSecret
}

/** Variables can be extended */
export type Variables = SharedHonoVariables

export interface App extends HonoApp {
	Bindings: Env
	Variables: Variables
}
