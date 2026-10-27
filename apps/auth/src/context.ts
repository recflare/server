import type { HonoApp } from '@repo/hono-helpers'
import type { SharedHonoEnv, SharedHonoVariables } from '@repo/hono-helpers/src/types'

export type Env = SharedHonoEnv & {
	// Shared rooms/accounts D1 database. The `auth` worker owns the `accounts`
	// table (creates accounts on signup, seeds the system + Coach accounts). Also
	// seeds new players' presence to the Orientation room (the shared `presence`
	// table, see @repo/domain) so the match heartbeat keeps them there.
	DB: D1Database
	// Shared Secrets Store binding for the HS256 signing key. Resolve the value with
	// `await env.JWT_SECRET.get()`. Every worker binds the same store, so tokens
	// signed here verify in all of them. Provisioned via `wrangler secrets-store`;
	// the store id is spliced into wrangler.jsonc at deploy time (RECFLARE_SECRETS_STORE).
	JWT_SECRET: SecretsStoreSecret
	// The Meta (Oculus) app secret, from the app's page in the Meta developer dashboard.
	// Bound from the same Secrets Store as JWT_SECRET; resolve it with `.get()`. Used
	// only to authenticate US to Meta's graph API when validating a login nonce (see
	// meta-nonce.ts) — it never leaves the worker. Unlike Steam, whose ticket verifies
	// offline, Meta logins are impossible without it, so an empty value fails those
	// logins with a 500 rather than silently trusting the client's platform_id.
	META_APP_SECRET: SecretsStoreSecret
	/**
	 * Cloudflare Email Sending (`send_email` in wrangler.jsonc). The one thing this worker
	 * mails is the password-recovery code (`POST /account/recoverpassword`); `accounts` binds
	 * the same for its email-change confirmation. The `from` address is `EMAIL_FROM` below
	 * (read through `emailSender`), whose domain has to be onboarded onto Email Sending
	 * (`wrangler email sending enable <domain>`, see DEPLOYING.md) or every send fails — which
	 * the route reports to the player as the email not going out, and nothing else is affected.
	 * Locally and in tests the binding logs the message instead of sending it.
	 */
	EMAIL: SendEmail
	/**
	 * The address recovery emails come from. Set for every worker from the root `.env`
	 * (`RECFLARE_EMAIL_FROM`); unset means `no-reply@<DOMAIN>`. Its domain must be one Email
	 * Sending has been enabled on — Cloudflare refuses a send from any other.
	 */
	EMAIL_FROM?: string
	// Signup caps, both optional (see auth.app.ts for what each arm counts and why).
	// Unset falls back to the DEFAULT_MAX_ACCOUNTS_* constants there; 0 disables that arm.
	// Typed `string | number` because a var declared in wrangler.jsonc `vars` arrives as a
	// number while the same var set from the dashboard or `--var` arrives as a string —
	// read them through `intVar`, never as a bare number.
	MAX_ACCOUNTS_PER_PLATFORM_ID?: string | number
	MAX_ACCOUNTS_PER_IP?: string | number
	MAX_ACCOUNTS_PER_DEVICE_ID?: string | number
	/**
	 * Whether `create_account` accepts a signup with NO platform identity — the password
	 * account the website makes (`www` `/api/signup`), or anything else that posts the
	 * grant without a `platform`. `on`/`off` (or true/false, 1/0); unset means OFF, so a
	 * server opens web signup deliberately. Read through `flagVar`. The `www` worker reads
	 * the same knob to hide its form and refuse its endpoint, so the two agree for free.
	 * Platform signups (Steam, Meta) are never governed by this — they always have an
	 * identity to authenticate with later, and the caps above are what limit them.
	 */
	PASSWORD_SIGNUP?: string | number | boolean
	/**
	 * Which linked arms a ban is enforced through, as a comma-separated list out of `ip`
	 * and `platform` — or `off` for neither. Unset means BOTH: a ban reaches the accounts
	 * that share a proven platform identity or an IP with the banned one, and refuses a
	 * signup from either, which is what stops an evader simply making a new account.
	 *
	 * The `ip` arm is coarse (households, NAT, campus and carrier networks share one
	 * address), so `platform` alone is the setting for a server whose players share
	 * networks. Whatever this says, a ban always applies to the account it was handed to.
	 * Read through `banEvasionMatch`; the `match` worker reads the same knob.
	 */
	BAN_EVASION_MATCH?: string
	/**
	 * The Discord role ids that may sign in on a ROLLOUT-GATED client build (see
	 * `ROLLOUT_GAME_VERSIONS` in @repo/domain) — numeric snowflakes, separated by commas
	 * and/or whitespace, exactly like `www`'s DISCORD_BENEFITS_ROLE_IDS. ANY one of them
	 * qualifies. A login whose posted `ver` is a gated build is refused unless the account's
	 * Discord link (`platform_account`, platform 101, written by the website's benefits
	 * claim) records one of these roles — or the account is STAFF (developer or moderator),
	 * who are always let in, configured roles or not.
	 *
	 * Unset — or parsing to no ids — leaves the gate CLOSED: nobody but staff gets a token on
	 * a gated build. That is the safe reading of "supporters only" when no supporter role has been
	 * named, and it keeps a build that isn't ready from being reachable by accident.
	 * Logins on every other build are never touched by this.
	 */
	DISCORD_ROLLOUT_ROLE_IDS?: string
	/**
	 * The Discord role ids whose holders get Rec Room Studio upload access — stamped into the
	 * token as `betastudio` exactly as the account's `hasStudio` flag is, so a whole Discord
	 * role can be let into Studio without touching anyone's account. Same grammar as
	 * DISCORD_ROLLOUT_ROLE_IDS above (snowflakes, commas and/or whitespace; ANY one qualifies),
	 * read from the same Discord link snapshot. Set for every worker from the root `.env`
	 * (`RECFLARE_STUDIO_ROLLOUT`): `studio` and `www` read it through the same
	 * `hasStudioAccess`, so what the token says, what the editor's access lookup says and
	 * what the website's `/api/studio-access` says agree. Unset, or naming no role, grants
	 * nobody — the flag alone decides. The flag still works beside it.
	 */
	STUDIO_ROLLOUT?: string
	/**
	 * The client builds a `/connect/token` grant may post as `ver` and still get a token:
	 * a comma-separated list of builds (`20230414,20250718`), or `off` for none. Unset means
	 * the default `SUPPORTED_GAME_VERSIONS` in @repo/domain. Set for every worker from the
	 * root `.env` (`RECFLARE_SUPPORTED_GAME_VERSIONS`), so this refuses exactly the builds
	 * `api`'s `/api/versioncheck/v4` tells to update — dropping a build from the list is how
	 * its players are made to upgrade. Read through `supportedGameBuilds`, which also folds
	 * in every build under rollout (below). A grant posting no `ver` is never gated.
	 */
	SUPPORTED_GAME_VERSIONS?: string
	/**
	 * The builds under staged rollout — the ones the Discord-role gate above applies to —
	 * overriding `ROLLOUT_GAME_VERSIONS` in @repo/domain: same format, or `off` to end the
	 * rollout and open those builds to every account. Set for every worker
	 * (`RECFLARE_ROLLOUT_GAME_VERSIONS`), so `match`'s rollout voice pool follows the same
	 * list. A build here is served whether or not `SUPPORTED_GAME_VERSIONS` names it. Read
	 * through `rolloutGameBuilds`.
	 */
	ROLLOUT_GAME_VERSIONS?: string
	/**
	 * Base domain, e.g. `recflare.net`. Injected for every worker at deploy time
	 * (`--var DOMAIN`). Studio's device-login response points the browser at
	 * `www.<domain>/device`, so auth has to know the same domain `ns` advertises.
	 */
	DOMAIN: string
	/**
	 * The same `SUBDOMAINS` JSON `ns` applies. A `www` override has to move the
	 * verification URI with the host the editor was told WWW lives on.
	 */
	SUBDOMAINS: string
}

/** Variables can be extended */
export type Variables = SharedHonoVariables

export interface App extends HonoApp {
	Bindings: Env
	Variables: Variables
}
