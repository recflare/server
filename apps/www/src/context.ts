import type { HonoApp } from '@repo/hono-helpers'
import type { SharedHonoEnv, SharedHonoVariables } from '@repo/hono-helpers/src/types'
import type { NotificationsHub } from '../../notify/src/notifications-hub'

export type Env = SharedHonoEnv & {
	/** Base domain the auth/accounts hosts are derived from (see wrangler.jsonc). */
	DOMAIN: string
	/** Static-asset fetcher for the built React SPA (see wrangler.jsonc `assets`). */
	ASSETS: Fetcher
	/**
	 * The shared `recflare` D1. www asks it three things: the live presence head-count
	 * behind `/server-status`, the caller's `account` row on the benefits claim — which
	 * WRITES the `hasPlus`/`discordUserId` pair, through `@repo/domain`'s `updateAccount`,
	 * so the blob's shape stays in one module — and the `report`/`warning` tables behind
	 * the staff moderation panel (`/api/staff/*`), which writes reports and bans through
	 * `api`'s reports-db for the same reason. Every table it can see is owned (and
	 * migrated) by another worker; www never migrates.
	 */
	DB: D1Database
	/**
	 * SignalR notifications hub (DO owned by the `notify` worker). Bound mainly for one thing: a
	 * ban handed down from the staff panel ejects the player from the instance they are
	 * standing in, which needs a `ModerationKick` frame pushed to them (see src/staff.ts).
	 * Without it a ban would only bite on their next matchmake. A staff token gift uses it
	 * too, to set the player's balance and show them the box.
	 */
	RECFLARE_NOTIFICATIONS_HUB: DurableObjectNamespace<NotificationsHub>
	/**
	 * Which ban-EVASION arms the operator enforces — the same knob `match` and `auth`
	 * read, parsed by the same `banEvasionMatch` (in `api`'s bans-db, which owns the
	 * policy). www reads it so the staff panel's "who else would this ban reach" preview
	 * shows what would ACTUALLY happen rather than every possible match.
	 *
	 * It must carry the same value as those workers'. An operator who narrows it on
	 * `match` but not here gets a preview that overstates the blast radius — alarming
	 * rather than dangerous, but wrong. Unset means both arms, as it does everywhere else.
	 * Undeclared in wrangler.jsonc, as it is there: an operator who wants it sets it.
	 */
	BAN_EVASION_MATCH?: string
	/**
	 * The signup token grant — the same knob `econ` reads, injected into every worker from
	 * RECFLARE_STARTING_TOKENS at deploy. www needs it for a staff token gift, which seeds a
	 * never-touched balance with the signup grant before crediting, exactly as econ does; a
	 * different value here would start that player on the wrong amount. Unset means
	 * DEFAULT_STARTING_TOKENS, as it does in econ.
	 */
	STARTING_TOKENS?: string | number
	/**
	 * The most RecCenterTokens one staff token gift can carry (see src/staff.ts). A typo guard
	 * rather than a policy, since a credit can't be taken back. Unset means
	 * DEFAULT_MAX_TOKEN_GIFT (10,000).
	 */
	MAX_TOKEN_GIFT?: string | number
	/**
	 * The most XP one staff XP gift can carry (see src/staff.ts), a typo guard like
	 * MAX_TOKEN_GIFT. Unset means DEFAULT_MAX_XP_GIFT (100).
	 */
	MAX_XP_GIFT?: string | number
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
	/**
	 * The bot user's token for the scheduled role refresh (discord-roles.ts). Optional in
	 * effect: the binding must exist for the deploy, but a placeholder value just leaves the
	 * sweep off. The claim never reads it.
	 */
	DISCORD_BOT_TOKEN: SecretsStoreSecret
}

/** Variables can be extended */
export type Variables = SharedHonoVariables & {
	/**
	 * The acting moderator's account id on a `/api/staff/*` request, set by `requireStaff`
	 * once it has validated the token. Stashed so a handler reads it without verifying the
	 * same token a second time — and so a handler can only get at it behind that gate.
	 */
	staffId: number
	/**
	 * The roles on that same token, set beside `staffId` so `requireDeveloper` can narrow a
	 * staff route to developers without verifying the token again.
	 */
	staffRoles: string[]
}

export interface App extends HonoApp {
	Bindings: Env
	Variables: Variables
}
