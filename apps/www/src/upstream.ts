import type { Env } from './context'

/**
 * The www worker is a backend-for-frontend (BFF): the browser only ever talks to
 * www, and www forwards to the `auth` and `accounts` workers server-side. That
 * keeps the JWT off other origins and sidesteps CORS (those workers set no CORS
 * headers). Hosts are derived from the shared base domain (`auth.<DOMAIN>`,
 * `accounts.<DOMAIN>`), matching how the workers are deployed.
 */

export const authBase = (env: Env): string => `https://auth.${env.DOMAIN}`
export const accountsBase = (env: Env): string => `https://accounts.${env.DOMAIN}`
export const notifyBase = (env: Env): string => `https://notify.${env.DOMAIN}`
export const apiBase = (env: Env): string => `https://api.${env.DOMAIN}`
export const imgBase = (env: Env): string => `https://img.${env.DOMAIN}`

/**
 * POST a form-urlencoded body to an upstream worker. The auth/accounts endpoints
 * read their inputs via Hono's `parseBody()`, so they expect form fields (not
 * JSON). `bearer`, when given, authenticates the caller.
 */
export async function postForm(
	url: string,
	fields: Record<string, string>,
	bearer?: string,
	clientIp?: string,
	internalSecret?: string
): Promise<Response> {
	const headers: Record<string, string> = {
		'content-type': 'application/x-www-form-urlencoded',
	}
	if (bearer) headers.authorization = `Bearer ${bearer}`
	if (clientIp) headers['x-forwarded-client-ip'] = clientIp
	if (internalSecret) headers['x-internal-secret'] = internalSecret
	return fetch(url, {
		method: 'POST',
		headers,
		body: new URLSearchParams(fields).toString(),
	})
}
