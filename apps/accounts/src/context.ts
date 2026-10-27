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
	// Shared rooms/accounts D1 database (schema owned by the `auth` worker). Used
	// to look up accounts in bulk/by id and to create new accounts.
	DB: D1Database
	// SignalR notifications hub (DO owned by the `notify` worker). Bound here to
	// push AccountUpdate/SelfAccountUpdate notifications on profile mutations.
	RECFLARE_NOTIFICATIONS_HUB: DurableObjectNamespace<NotificationsHub>
	/**
	 * Cloudflare Email Sending (`send_email` in wrangler.jsonc). The one thing this worker
	 * mails is the code that confirms an email change (`POST /account/me/email`), from
	 * `EMAIL_FROM` below (read through `emailSender`); `auth` binds the same for password
	 * recovery. The sender's domain has to be onboarded onto Email Sending (see DEPLOYING.md)
	 * or every send fails — reported to the player as the email not going out. Locally and
	 * in tests the binding logs the message instead of sending it.
	 */
	EMAIL: SendEmail
	/** See `auth`: the address emails come from; unset means `no-reply@<DOMAIN>`. */
	EMAIL_FROM?: string
	/**
	 * Base domain, e.g. `recflare.net`, injected for every worker at deploy time
	 * (`--var DOMAIN`). The confirmation email links to `www.<domain>/confirm-email`.
	 */
	DOMAIN: string
	/** The same `SUBDOMAINS` JSON `ns` applies: a `www` override moves that link's host. */
	SUBDOMAINS: string
}

/** Variables can be extended */
export type Variables = SharedHonoVariables

export interface App extends HonoApp {
	Bindings: Env
	Variables: Variables
}
