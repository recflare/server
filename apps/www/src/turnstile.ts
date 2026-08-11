import { logger } from '@repo/hono-helpers'

import type { Env } from './context'

/**
 * Cloudflare Turnstile, the bot check in front of web signup. Two keys make a widget:
 * the SITE key, which is public (it ships in the page markup so the browser can render
 * the widget), and the SECRET key, which stays on the worker and is the only thing that
 * can turn a widget token into a verdict. Both are held in the shared Secrets Store.
 *
 * The verdict is fetched server-side, here in the BFF — never from the browser, which
 * would hand the secret to anyone who viewed source. The browser's only job is to carry
 * the widget's token to `POST /api/signup`.
 *
 * Turnstile is what makes web signup safe to leave open: `auth`'s per-IP cap is the only
 * other thing standing in front of the password/anonymous account path (it has no
 * platform identity to count), and that cap is coarse enough that it can't be the whole
 * defence. So the keypair IS the switch — no keypair, no signup (see `turnstileKeys`).
 * Nothing is ever inferred from the environment, so a worker can't end up with signup
 * open and no bot check behind it.
 */

/** Turnstile's verdict endpoint. Called from the worker only; the secret never leaves it. */
const SITEVERIFY_URL = 'https://challenges.cloudflare.com/turnstile/v0/siteverify'

/**
 * The keypair web signup runs on, or null when there isn't one — which is what closes
 * signup (`/api/config` reports it, `/api/signup` refuses). Both keys come from the
 * account-level Secrets Store the whole monorepo shares (see context.ts), so they're
 * resolved per request rather than read off `env` as strings.
 *
 * Both must resolve. Half a configuration (a site key whose secret is missing from the
 * store) counts as unconfigured rather than as a widget whose token nobody can check, and
 * says so in the log — it's otherwise indistinguishable from signup being deliberately
 * off. A `.get()` that throws (secret absent from the store, binding not deployed, store
 * unreachable) is treated the same way, so a Worker that can't read its keys closes the
 * door instead of 500ing on the homepage.
 *
 * `.get()` caches per isolate, so changing a value in the store needs a `www` redeploy to
 * take effect on a warm worker — the same caveat the shared JWT_SECRET carries.
 *
 * For local dev, seed the two names into the LOCAL store (miniflare's, not your account's)
 * with Turnstile's documented always-passes test keypair — see apps/www/README.md. That
 * pair belongs to no account and passes without a human. Deliberately not a built-in
 * fallback: the same code path then runs everywhere.
 */
export async function turnstileKeys(
	env: Env
): Promise<{ siteKey: string; secretKey: string } | null> {
	const [siteKey, secretKey] = await Promise.all([
		readSecret(env.TURNSTILE_SITE_KEY, 'TURNSTILE_SITE_KEY'),
		readSecret(env.TURNSTILE_SECRET_KEY, 'TURNSTILE_SECRET_KEY'),
	])
	if (siteKey !== '' && secretKey !== '') return { siteKey, secretKey }
	if (siteKey !== '' || secretKey !== '') {
		logger.error('turnstile is half-configured, so web signup is closed', {
			hasSiteKey: siteKey !== '',
			hasSecretKey: secretKey !== '',
		})
	}
	return null
}

/**
 * One Secrets Store value as a string, or '' when it can't be read. The binding is
 * declared in wrangler.jsonc, so it's always present on `env`; what varies is whether the
 * store actually holds the secret — a missing one throws here rather than resolving empty.
 */
async function readSecret(secret: SecretsStoreSecret, name: string): Promise<string> {
	try {
		return (await secret.get()) ?? ''
	} catch (err) {
		logger.error('failed to read a turnstile key from the secrets store', {
			secret: name,
			error: String(err),
		})
		return ''
	}
}

/** Turnstile's siteverify response, narrowed to the fields we act on. */
interface SiteVerifyResponse {
	success?: boolean
	'error-codes'?: string[]
}

/**
 * Ask Turnstile whether a widget token is good. `remoteIp` is the client's real IP per
 * Cloudflare (`CF-Connecting-IP`), which Turnstile cross-checks against the one that
 * solved the challenge; it's omitted when absent rather than sent empty.
 *
 * A token is single-use, so a failed verdict means the widget has to be reset before the
 * player can retry — the client does that (see the signup form).
 *
 * Any failure to reach Turnstile is a rejection, not a pass: this is the only bot check
 * in front of signup, so a broken verdict path must not open the door.
 */
export async function verifyTurnstile(
	secretKey: string,
	token: string,
	remoteIp?: string
): Promise<boolean> {
	const fields: Record<string, string> = { secret: secretKey, response: token }
	if (remoteIp) fields.remoteip = remoteIp

	try {
		const res = await fetch(SITEVERIFY_URL, {
			method: 'POST',
			headers: { 'content-type': 'application/x-www-form-urlencoded' },
			body: new URLSearchParams(fields).toString(),
		})
		if (!res.ok) {
			logger.error('turnstile siteverify failed', { status: res.status })
			return false
		}
		const verdict = (await res.json()) as SiteVerifyResponse
		if (verdict.success !== true) {
			// The codes name the reason (`invalid-input-response`, `timeout-or-duplicate`,
			// `invalid-input-secret`, …) — the last of those is a misconfiguration, not a bot,
			// and this log line is the only place it shows up.
			logger.info('turnstile rejected a signup', { codes: verdict['error-codes'] ?? [] })
			return false
		}
		return true
	} catch (err) {
		logger.error('turnstile siteverify threw', { error: String(err) })
		return false
	}
}
