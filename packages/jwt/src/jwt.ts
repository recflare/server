/**
 * HS256 JWT generation and validation, built on Hono's `hono/jwt` helpers (Web
 * Crypto under the hood) so we don't hand-roll signing, base64url, or claim
 * (exp/nbf) checks.
 *
 * The signing key is supplied by the caller from the shared `JWT_SECRET` binding
 * (a Cloudflare secret in deployed envs, `.dev.vars` locally) — see each worker's
 * context.ts. `auth` signs tokens; every worker validates them with the same key.
 */

import { sign, verify } from 'hono/jwt'

import { GAME_VERSION } from '@repo/domain'

// Token lifetime in seconds (mirrored in the `expires_in` response field).
// @todo Allegedly, the game is supposed to refresh tokens every 3600 seconds, but it doesn't.
// It's possible our refresh_token implementation is broken, but for now we just make the token
// last a day so the client doesn't have to refresh it.
export const TOKEN_TTL_SECONDS = 86400

/**
 * Validate an HS256 token and return its `sub` (account id) claim, or `null` when
 * the token is malformed, has a bad signature, or is expired/not-yet-valid.
 * `verify` throws on all of those, so a rejection just means "no valid id".
 * Internal — callers use {@link validateAndGetAccountId}, which takes the request.
 */
async function getAccountIdFromToken(token: string, secret: string): Promise<string | null> {
	try {
		const payload = await verify(token, secret, 'HS256') // checks exp/nbf/signature
		return typeof payload.sub === 'string' ? payload.sub : null
	} catch {
		return null
	}
}

/**
 * Validate a request's auth and return the caller's integer account id, or `null`
 * when it carries no valid credential. Today that means the `sub` claim of a
 * bearer token in the `Authorization` header; taking the whole `Request` (rather
 * than a pre-extracted header) keeps that detail here, so if how we carry auth
 * changes (a cookie, a different header) callers don't. Returns `null` when there
 * is no valid bearer token, the token is invalid/expired, or `sub` isn't an integer.
 */
export async function validateAndGetAccountId(
	request: Request,
	secret: string
): Promise<number | null> {
	const authHeader = request.headers.get('Authorization')
	if (!authHeader || !authHeader.toLowerCase().startsWith('bearer ')) return null

	const token = authHeader.slice('bearer '.length)
	const accountId = await getAccountIdFromToken(token, secret)
	if (!accountId) return null

	const id = Number.parseInt(accountId, 10)
	return Number.isNaN(id) ? null : id
}

/**
 * Validate a request's bearer token and return its `role` claim — the array of role
 * strings stamped by {@link generateToken} (e.g. `['gameClient', 'moderator']`) — or
 * `null` when the request carries no valid token (missing/malformed/expired). A valid
 * token with no `role` claim yields `[]`. Callers gate privileged actions on a specific
 * role being present; the shape mirrors {@link validateAndGetAccountId} so a handler can
 * ask for the id or the roles the same way.
 */
export async function validateAndGetRoles(
	request: Request,
	secret: string
): Promise<string[] | null> {
	const authHeader = request.headers.get('Authorization')
	if (!authHeader || !authHeader.toLowerCase().startsWith('bearer ')) return null

	const token = authHeader.slice('bearer '.length)
	try {
		const payload = await verify(token, secret, 'HS256') // checks exp/nbf/signature
		return Array.isArray(payload.role)
			? payload.role.filter((r): r is string => typeof r === 'string')
			: []
	} catch {
		return null
	}
}

/**
 * Validate a request's bearer token and return its `rn.ver` claim — the game build the
 * caller posted to `/connect/token`, stamped by {@link generateToken}. `null` when the
 * request carries no valid token, and `null` too when a valid token has no `rn.ver` (an
 * older token, issued before the claim carried the client's own value): callers fall back
 * to what they stored or to GAME_VERSION rather than writing an empty version, which
 * breaks the client's presence handling.
 */
export async function validateAndGetVersion(
	request: Request,
	secret: string
): Promise<string | null> {
	const authHeader = request.headers.get('Authorization')
	if (!authHeader || !authHeader.toLowerCase().startsWith('bearer ')) return null

	const token = authHeader.slice('bearer '.length)
	try {
		const payload = await verify(token, secret, 'HS256') // checks exp/nbf/signature
		const version = payload['rn.ver']
		return typeof version === 'string' && version !== '' ? version : null
	} catch {
		return null
	}
}

/** Scopes stamped onto every token (as a claim array). */
const TOKEN_SCOPES = [
	'profile',
	'rn',
	'rn.accounts',
	'rn.accounts.gc',
	'rn.api',
	'rn.chat',
	'rn.clubs',
	'rn.commerce',
	'rn.match.read',
	'rn.match.write',
	'rn.notify',
	'rn.rooms',
	'rn.storage',
	'offline_access',
]

/**
 * Base roles every token carries — the client needs `gameClient` to operate.
 * Elevated roles (e.g. `developer`, `moderator`) are NOT baked in here; the auth
 * worker passes them per-account as `extraRoles` from the account's role flags, so
 * a plain player's token stays `['gameClient']` and only granted accounts get more.
 */
const BASE_ROLES = ['gameClient']

/**
 * The claims the Photon auth token carries beyond `sub`/`exp`/`aud`, describing who
 * (and on what) is connecting. All of them go on the wire as STRINGS, including the
 * numeric ones — that's how the real token encodes them.
 */
export interface PhotonAuthClaims {
	/** The platform-native id (e.g. a SteamID64) — `rn.platid`. */
	platformId: string
	/** PlatformType int (0 = Steam) — `rn.plat`. */
	platform: number
	/** DeviceClass int (2 = PC/standalone) — `rn.deviceclass`. */
	deviceClass: number
	/** The Photon application the token is for — the `aud` claim. */
	audience: string
}

/**
 * Mint the short-lived HS256 token the client hands to Photon as its custom auth
 * credential (`photonAuthToken` on `GET /player/connection-info`). The claim set
 * mirrors the real one — `sub`, `rn.platid`, `rn.plat`, `rn.deviceclass`, `rn.env`,
 * `exp`, `aud` — rather than being a second copy of the login token: it identifies
 * the connecting player to the realtime server and nothing else, so none of the
 * scopes or roles from {@link generateToken} belong on it.
 *
 * Signed with the same shared `JWT_SECRET` as every other token here. A real Photon
 * Cloud application would verify this against a secret configured in its dashboard;
 * self-hosted, nothing verifies it yet — so treat it as identifying, not authorizing.
 * `rn.env` is `prod` because that's what the client is built against, regardless of
 * which environment this worker is running in.
 */
export async function generatePhotonAuthToken(
	accountId: number,
	claims: PhotonAuthClaims,
	secret: string
): Promise<string> {
	return sign(
		{
			sub: String(accountId),
			'rn.platid': claims.platformId,
			'rn.plat': String(claims.platform),
			'rn.deviceclass': String(claims.deviceClass),
			'rn.env': 'prod',
			exp: Math.floor(Date.now() / 1000) + TOKEN_TTL_SECONDS,
			aud: claims.audience,
		},
		secret
	)
}

export async function generateToken(
	accountId: string,
	platformId: string,
	platform: number,
	secret: string,
	extraRoles: string[] = [],
	privileges: string[] = [],
	version: string = GAME_VERSION
): Promise<string> {
	const now = Math.floor(Date.now() / 1000)
	// The client reads `role`/`scope` (and expects a well-formed iss/aud) to
	// authorize itself; a token with only `sub` is rejected before login finishes.
	return sign(
		{
			iss: 'https://auth.recflare.net',
			aud: 'https://auth.recflare.net',
			nbf: now,
			iat: now,
			exp: now + TOKEN_TTL_SECONDS,
			auth_time: now,
			amr: 'cached_login',
			client_id: 'recroom',
			sub: accountId,
			idp: 'local',
			platform,
			platform_id: platformId,
			// The CLIENT's build, as it posted it to /connect/token (`ver`) — not this
			// server's GAME_VERSION, which is only the fallback for a grant that names none
			// (a refresh, or a caller that isn't the game). Presence reads it back off the
			// token, so a player's reported version is the build they are actually running.
			'rn.ver': version,
			'rn.plat': platform,
			role: [...BASE_ROLES, ...extraRoles],
			// `rn.privilege` LOOKS like a scope but is a claim: the client reads it out of
			// the same claims dictionary it reads `role` from, and it never appears in
			// `scope`. Omitted entirely when empty, so an unrestricted token is byte-for-byte
			// what it was before privileges existed.
			...(privileges.length > 0 ? { 'rn.privilege': privileges } : {}),
			scope: TOKEN_SCOPES,
			jti: crypto.randomUUID(),
		},
		secret
	)
}
