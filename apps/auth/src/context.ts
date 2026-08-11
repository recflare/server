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
	// Signup caps, both optional (see auth.app.ts for what each arm counts and why).
	// Unset falls back to the DEFAULT_MAX_ACCOUNTS_* constants there; 0 disables that arm.
	// Typed `string | number` because a var declared in wrangler.jsonc `vars` arrives as a
	// number while the same var set from the dashboard or `--var` arrives as a string —
	// read them through `intVar`, never as a bare number.
	MAX_ACCOUNTS_PER_PLATFORM_ID?: string | number
	MAX_ACCOUNTS_PER_IP?: string | number
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
}

/** Variables can be extended */
export type Variables = SharedHonoVariables

export interface App extends HonoApp {
	Bindings: Env
	Variables: Variables
}
