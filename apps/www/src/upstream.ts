import { authFailure } from './auth-messages'

import type { AuthAction, AuthFailure } from './auth-messages'
import type { Env } from './context'

/**
 * Where the other workers live. Derived from the shared base domain, matching how they
 * are deployed. www serves these to the SPA (`/api/config`), which calls them DIRECTLY —
 * the same endpoints the game uses, as rec.net's own site did. The only one www still
 * calls itself is `auth`, for the Turnstile-gated signup grant (see `postAuthForm`).
 */

export const authBase = (env: Env): string => `https://auth.${env.DOMAIN}`
export const accountsBase = (env: Env): string => `https://accounts.${env.DOMAIN}`
export const notifyBase = (env: Env): string => `https://notify.${env.DOMAIN}`
export const apiBase = (env: Env): string => `https://api.${env.DOMAIN}`
export const imgBase = (env: Env): string => `https://img.${env.DOMAIN}`
export const roomsBase = (env: Env): string => `https://rooms.${env.DOMAIN}`
export const cdnBase = (env: Env): string => `https://cdn.${env.DOMAIN}`
export const storageBase = (env: Env): string => `https://storage.${env.DOMAIN}`

/**
 * POST a form body to the `auth` worker, carrying the browser's real IP across.
 *
 * The browser could post `/connect/token` itself — it does exactly that to sign in — but
 * not to SIGN UP: that grant is gated by Turnstile, whose secret key can't ship to a
 * page. So signup goes through www, and www has to solve a problem the browser doesn't
 * have: `auth` reads the caller's address from `CF-Connecting-IP` and records it as the
 * account's immutable `signupIp`, and a Worker subrequest to https://auth.<DOMAIN>
 * re-enters the Cloudflare edge, which REPLACES that header with Cloudflare's own
 * address. Every web signup therefore recorded one shared IP, and auth's per-IP cap —
 * 3 accounts, never decaying — refused the fourth web account ever created, for everybody.
 *
 * Going through the service binding skips the edge, so the header set here is the one
 * auth reads. That is safe precisely because the edge does overwrite it on the public
 * route: a game client (or the SPA signing in) posting `/connect/token` directly still
 * cannot spoof its own IP, so no shared secret is needed to tell the callers apart.
 *
 * `clientIp` is the caller's own edge-set `cf-connecting-ip`, and must never be anything
 * a browser supplied. Absent, no header is sent at all — auth's `clientIp` then reads
 * empty, which SKIPS the cap rather than counting every such signup together.
 *
 * Falls back to the public hostname when the binding is absent (local `vite dev` — see
 * `Env.AUTH`); the edge then overwrites the header again, which is the old behaviour.
 */
export async function postAuthForm(
	env: Env,
	path: string,
	fields: Record<string, string>,
	opts: { bearer?: string; clientIp?: string } = {}
): Promise<Response> {
	const headers: Record<string, string> = {
		'content-type': 'application/x-www-form-urlencoded',
	}
	if (opts.bearer) headers.authorization = `Bearer ${opts.bearer}`
	if (opts.clientIp) headers['cf-connecting-ip'] = opts.clientIp

	const request = new Request(`${authBase(env)}${path}`, {
		method: 'POST',
		headers,
		body: new URLSearchParams(fields).toString(),
	})
	return env.AUTH ? env.AUTH.fetch(request) : fetch(request)
}

/**
 * Read a failed `auth` response into something worth showing. The translation itself is
 * shared with the browser (see `auth-messages.ts`); this only unpacks the body. A
 * non-JSON one — from something in front of auth, like an edge error page — falls
 * through to the generic line for the action.
 */
export async function readAuthError(res: Response, action: AuthAction): Promise<AuthFailure> {
	const parsed = (await res.json().catch(() => null)) as {
		error?: unknown
		error_description?: unknown
	} | null
	const body = parsed ?? {}
	const code = typeof body.error === 'string' ? body.error : ''
	const description = typeof body.error_description === 'string' ? body.error_description : ''

	return authFailure(action, res.status, code, description)
}
