import { useCallback, useState } from 'react'

import { isStaff } from '@repo/jwt/src/roles'

/**
 * The SPA's worker plumbing: the session token, where the workers live, and the one
 * `call` every view makes its requests through.
 *
 * Extracted from App.tsx so the moderation panel (Moderation.tsx) can share it — App
 * RENDERS that panel, so it can't be the module the panel imports from. The token is
 * module-level mutable state, which belongs in a module of its own rather than in
 * whichever component happened to define it first.
 *
 * The SPA calls the SAME endpoints the game does — `auth` for tokens and the password
 * change, `accounts` for the profile, `api` for the photo feed, `notify` for the admin
 * broadcasts — rather than proxying each one through `www`, exactly as rec.net's own site
 * did. Those workers answer CORS for it (see their `withDefaultCors()`), and the access
 * token lives here in the browser. `www` serves only what cannot leave the server: the
 * site config, Turnstile-gated signup, the Discord benefits claim, and the staff
 * moderation endpoints (see www.app.ts).
 */

/** Where each worker lives. From `/api/config`, never baked into this build. */
export interface Hosts {
	auth: string
	accounts: string
	api: string
	img: string
	notify: string
	rooms: string
	cdn: string
	storage: string
	studio: string
}

/**
 * The session's access token, in localStorage so a reload stays signed in.
 *
 * Readable by page JS, which the httpOnly cookie this replaced was not — that is the
 * tradeoff that comes with the browser calling the workers itself, and it's the same
 * posture the game client has. Nothing third-party runs on this origin except the
 * Turnstile widget, which is Cloudflare's own.
 */
const TOKEN_KEY = 'rf_token'
let token: string | null = localStorage.getItem(TOKEN_KEY)

export function setToken(next: string | null) {
	token = next
	if (next === null) localStorage.removeItem(TOKEN_KEY)
	else localStorage.setItem(TOKEN_KEY, next)
}

/**
 * Whether a session token is stored — what the app asks on startup to decide between
 * "check who this is" and "signed out". A getter rather than an exported `token`, so the
 * only way to change it stays {@link setToken} and nothing can drift from localStorage.
 */
export const hasToken = (): boolean => token !== null

/**
 * The session's `authorization` header, or none when signed out — for the rare read that has
 * to see a raw status (a 404 meaning "not there") and so can't go through {@link call}.
 */
export function authHeader(): Record<string, string> {
	return token ? { authorization: `Bearer ${token}` } : {}
}

/**
 * Filled in once `/api/config` lands, before any worker call is made — a module value
 * rather than a prop threaded through every form, since the components that call a
 * worker only render after the config resolves.
 */
let hosts: Hosts | null = null

/** Record where the workers live, once `/api/config` has said. */
export function setHosts(next: Hosts) {
	hosts = next
}

/** The hostnames, once known. Throws rather than guessing a domain. */
export function where(): Hosts {
	if (hosts === null) throw new Error('Still starting up — please reload the page.')
	return hosts
}

/** The session token's `role` claim, decoded WITHOUT verifying it. Malformed reads as none. */
function tokenRoles(): string[] {
	const payload = token?.split('.')[1]
	if (!payload) return []
	try {
		const b64 = payload.replace(/-/g, '+').replace(/_/g, '/')
		const padded = b64.padEnd(b64.length + ((4 - (b64.length % 4)) % 4), '=')
		const claims = JSON.parse(atob(padded)) as { role?: unknown }
		return Array.isArray(claims.role) ? (claims.role as string[]) : []
	} catch {
		return []
	}
}

/**
 * Whether the session token carries an admin role. Decodes the `role` claim WITHOUT
 * verifying it — a page holds no signing key, and faking one here only reveals buttons
 * whose endpoints reject the same token. A malformed token reads as "not admin".
 */
export function isAdmin(): boolean {
	// Only decides whether to SHOW the staff controls; every worker behind them checks the
	// verified token against the same `STAFF_ROLES`.
	return isStaff(tokenRoles())
}

/**
 * Whether the session token carries the `developer` role — the staff gifts are narrowed to
 * it (www's `requireDeveloper`). Cosmetic in the same way as {@link isAdmin}.
 */
export function isDeveloper(): boolean {
	return tokenRoles().includes('developer')
}

/**
 * An OAuth machine code (`invalid_grant`, `server_error`) rather than a sentence — a
 * lower_snake_case word with no spaces. A worker that speaks OAuth puts one of these in
 * `error`, where the readable reason is in `error_description`.
 */
const isErrorCode = (s: string) => /^[a-z][a-z\d]*(_[a-z\d]+)+$/.test(s)

/**
 * The message worth showing for a refusal. `error` wins, since that's where a worker
 * puts a sentence it wrote for the player — but NOT when it's a bare OAuth code, which
 * tells nobody anything. Some refusals carry no body at all (accounts answers a
 * malformed email with an empty 400), hence the last-resort line.
 */
function errorMessage(data: Record<string, unknown>, status: number): string {
	const error = typeof data.error === 'string' ? data.error : ''
	const description = typeof data.error_description === 'string' ? data.error_description : ''
	return (
		(error && !(isErrorCode(error) && description) && error) ||
		description ||
		error ||
		`Request failed (${status})`
	)
}

interface CallOptions {
	method?: 'GET' | 'POST' | 'PUT' | 'DELETE'
	/** Form fields — auth and accounts read their input with Hono's `parseBody()`. */
	form?: Record<string, string>
	/** A JSON body — what notify's internal endpoints take instead. */
	json?: unknown
	/**
	 * A multipart body — what `storage`'s `/upload` takes, since it carries a file. Passed
	 * to `fetch` as-is: the browser writes the `content-type` itself, because only it
	 * knows the boundary it generated.
	 */
	multipart?: FormData
	/** Send the session token. */
	authed?: boolean
	/**
	 * What to say when the worker refuses with a 400 and NO body. Several accounts routes
	 * do exactly that (email, display name, bio), so without this the player reads
	 * "Request failed (400)" — the status, not the reason.
	 */
	refusal?: string
}

/** Call a worker. Returns the parsed body, or throws with something worth showing. */
export async function call<T = Record<string, unknown>>(
	url: string,
	opts: CallOptions = {}
): Promise<T> {
	const headers: Record<string, string> = {}
	if (opts.authed && token) headers.authorization = `Bearer ${token}`
	let body: string | FormData | undefined
	if (opts.form) {
		headers['content-type'] = 'application/x-www-form-urlencoded'
		body = new URLSearchParams(opts.form).toString()
	} else if (opts.json !== undefined) {
		headers['content-type'] = 'application/json'
		body = JSON.stringify(opts.json)
	} else if (opts.multipart) {
		// Deliberately no content-type: setting one would omit the boundary.
		body = opts.multipart
	}

	const res = await fetch(url, {
		method: opts.method ?? (body === undefined ? 'GET' : 'POST'),
		headers,
		body,
	})
	const data = (await res.json().catch(() => ({}))) as Record<string, unknown>

	if (!res.ok) {
		// Expired or revoked. Cleared here so no caller has to remember to.
		if (res.status === 401 && opts.authed) {
			setToken(null)
			throw new Error('Your session has expired. Please sign in again.')
		}
		// Only when the body really is empty — a worker that did send a reason keeps it.
		if (opts.refusal !== undefined && res.status === 400 && Object.keys(data).length === 0) {
			throw new Error(opts.refusal)
		}
		throw new Error(errorMessage(data, res.status))
	}
	return data as T
}

/** Small hook wrapping a submit handler with pending/error/success state. */
export function useAction() {
	const [pending, setPending] = useState(false)
	const [error, setError] = useState('')
	const [done, setDone] = useState('')

	const run = useCallback(async (fn: () => Promise<string>) => {
		setPending(true)
		setError('')
		setDone('')
		try {
			setDone(await fn())
		} catch (err) {
			setError(err instanceof Error ? err.message : String(err))
		} finally {
			setPending(false)
		}
	}, [])

	return { pending, error, done, run }
}

/**
 * The public account behind an exact `@username`, or null when nobody has the name.
 * `accounts`' `GET /account/username/:name` is an indexed equality lookup — NOT the
 * prefix search, which this once went through and filtered client-side; one profile view
 * then cost a 20-row index walk, and the search bar's typeahead already keeps that query
 * busy enough. A 404 is the one non-ok answer that means "no such player"; anything else
 * is a real failure and throws.
 */
export async function accountByUsername(input: string): Promise<PublicAccount | null> {
	const name = input.trim().replace(/^@/, '')
	if (name === '') return null
	const res = await fetch(`${where().accounts}/account/username/${encodeURIComponent(name)}`)
	if (res.status === 404) return null
	const data = (await res.json().catch(() => ({}))) as Record<string, unknown>
	if (!res.ok) throw new Error(errorMessage(data, res.status))
	return data as unknown as PublicAccount
}

/**
 * Resolve an `@username` to the account id the workers address a player by. An exact
 * match only: a prefix match is a different player, and acting on whoever happened to
 * sort first would be worse than refusing.
 */
export async function accountIdForUsername(input: string): Promise<number> {
	const name = input.trim().replace(/^@/, '')
	if (name === '') throw new Error('Enter a username.')
	const found = await accountByUsername(name)
	if (typeof found?.accountId !== 'number') throw new Error(`There's no player called @${name}.`)
	return found.accountId
}

/** A player as `accounts` serves them publicly — what a bulk lookup hands back. */
export interface PublicAccount {
	accountId: number
	username: string
	displayName: string
	profileImage: string
	bannerImage: string
	createdAt: string
}

/**
 * Names for a set of account ids, through `accounts`' bulk lookup — the same endpoint the
 * game uses to put names on a friends list.
 *
 * The staff endpoints deliberately return ids only: a report row stores ids, and joining
 * names onto it server-side would couple `www`'s moderation reads to a table `auth` owns.
 * So the page asks the real service instead, in one request for the whole page of results.
 *
 * Every requested id comes back — `accounts` synthesizes a default row for one it has
 * never seen — so a lookup can't silently drop a player and leave a blank cell. A failed
 * request resolves EMPTY rather than throwing: names are decoration on a moderation table
 * whose ids are the real content, and losing them must not blank the table.
 */
export async function usernamesFor(ids: number[]): Promise<Map<number, PublicAccount>> {
	const unique = [...new Set(ids.filter((id) => Number.isInteger(id) && id > 0))]
	if (unique.length === 0) return new Map()
	const accounts = await call<PublicAccount[]>(
		`${where().accounts}/account/bulk?id=${unique.join(',')}`
	).catch(() => [])
	return new Map(Array.isArray(accounts) ? accounts.map((a) => [a.accountId, a]) : [])
}
