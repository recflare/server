import type { HonoApp } from '@repo/hono-helpers'
import type { SharedHonoEnv, SharedHonoVariables } from '@repo/hono-helpers/src/types'

export type Env = SharedHonoEnv & {
	/** Base domain the auth/accounts hosts are derived from (see wrangler.jsonc). */
	DOMAIN: string
	/** Static-asset fetcher for the built React SPA (see wrangler.jsonc `assets`). */
	ASSETS: Fetcher
	/**
	 * The shared `recflare` D1. www asks it two things: the live presence head-count
	 * behind `/server-status`, and the caller's `account` row on the benefits claim —
	 * which is also the one place www WRITES (the `hasPlus`/`discordUserId` pair, through
	 * `@repo/domain`'s `updateAccount`, so the blob's shape stays in one module). Every
	 * table it can see is owned (and migrated) by another worker; www never migrates.
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
	/**
	 * The HS256 signing key every worker shares, out of the same account-level Secrets
	 * Store. www needs it for ONE thing: the benefits claim is the only route here that
	 * acts on behalf of a specific account (it writes `hasPlus` onto it), so it has to
	 * establish WHICH account is calling rather than take the SPA's word for it. Every
	 * other www route is either anonymous or hands the token straight to another worker.
	 *
	 * Resolve with `await env.JWT_SECRET.get()`; validate through `@repo/jwt` so the
	 * signature/exp checks are the ones every other worker runs.
	 */
	JWT_SECRET: SecretsStoreSecret
	/**
	 * The Discord application's client id. PUBLIC — it ships to the browser, which needs
	 * it to build the authorize URL — but kept in the Secrets Store beside its secret so
	 * one place configures the claim, exactly as TURNSTILE_SITE_KEY is.
	 */
	DISCORD_CLIENT_ID: SecretsStoreSecret
	/**
	 * The Discord application's client secret — what turns an authorization code into an
	 * access token. Never leaves this worker (see src/discord.ts).
	 */
	DISCORD_CLIENT_SECRET: SecretsStoreSecret
	/**
	 * The guild (Discord server) whose membership the benefits claim checks, and the roles
	 * within it that entitle a player to the benefits. Both hold Discord SNOWFLAKES — all
	 * digits, never a role's display name — kept as strings because a snowflake exceeds
	 * 2^53. Plain vars rather than secrets: any member of the server can read these off
	 * their own client, and none of them authorizes anything on its own.
	 *
	 * OPTIONAL because an operator who hasn't set up Discord has neither, and that is a
	 * supported state: it CLOSES the claim (see `discordConfig`) rather than opening an
	 * unverified one.
	 */
	DISCORD_GUILD_ID?: string
	/**
	 * The role ids inside DISCORD_GUILD_ID that grant Rec Room Plus — numeric snowflakes,
	 * separated by commas and/or whitespace, e.g. `"1077000000000000001,1077000000000000002"`.
	 * ANY one of them qualifies, so several tiers (a supporter role, a booster role, staff)
	 * can share the same benefit. Parsed by `parseRoleIds`; a value that parses to no ids at
	 * all closes the claim, exactly as an unset one does.
	 */
	DISCORD_BENEFITS_ROLE_IDS?: string
}

/** Variables can be extended */
export type Variables = SharedHonoVariables

export interface App extends HonoApp {
	Bindings: Env
	Variables: Variables
}
