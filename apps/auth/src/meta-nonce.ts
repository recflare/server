/**
 * Verification of a Meta (Oculus) `platform_auth` nonce, against Meta's graph API.
 *
 * Steam's ticket is signed by Steam, so we verify it offline with no network and no
 * credential (see steam-ticket.ts). Meta's user proof is the opposite: an opaque
 * nonce that means nothing on its own. The only way to know it is genuine is to ask
 * Meta — which is why this path makes an outbound request on every Meta login and
 * cannot work at all without the app secret.
 *
 * A Meta login posts
 *
 *   platform_auth = {"Nonce":"<64 chars>","AppId":"1232175103309633","Source":"logged in user"}
 *   platform_id   = <the Meta user id>
 *
 * and validation is what BINDS those two together: `user_nonce_validate` answers
 * "was this nonce issued to this user, for this app?". So the posted `platform_id` is
 * an *input* here rather than something read out of a ticket, and a spoofed one fails
 * — a nonce Meta issued to user A does not validate as user B. The id is therefore
 * proven exactly as much as a Steam ticket's SteamID64 is, and is safe to bind to an
 * account. (It's an app-scoped id: it identifies the player within this app only.)
 *
 * The `AppId` comes from the payload rather than config because it must be the app the
 * nonce was issued for — a different one simply fails, since the access token below
 * pairs it with our secret. `Source` is informational and ignored.
 *
 * Shape and retry policy follow the reference Go server's utils/oculus.go.
 */

/** Meta's nonce-validation endpoint. Takes a form body, answers `{"is_valid":true}`. */
const NONCE_VALIDATE_URL = 'https://graph.oculus.com/user_nonce_validate'

/**
 * Graph error codes worth retrying — 1 (unknown) and 2 (service temporarily
 * unavailable) are Meta-side hiccups, not a verdict on the nonce. Anything else is a
 * real answer and retrying it just delays a login that is going to fail anyway.
 */
const TRANSIENT_ERROR_CODES = new Set([1, 2])

/**
 * Attempts per verification. A login is latency-sensitive and a nonce is single-use
 * with a short life, so this is deliberately small: two quick retries (250ms, 1s of
 * backoff) ride out a blip, and a longer outage fails the login rather than hanging
 * the client on a headset loading screen.
 */
const MAX_ATTEMPTS = 3

/** The trustworthy identity proven by a validated nonce. */
export interface VerifiedMetaIdentity {
	/** The Meta user id the nonce was issued to — app-scoped, numeric. */
	userId: string
	/** The Meta app the nonce was issued for. */
	appId: string
}

/**
 * The outcome of a verification. Failures carry a `reason` for the server log: the
 * client is told only that its platform_auth was rejected (it can't act on more), but
 * an operator debugging a headset that won't log in needs to know whether Meta said
 * "bad nonce", "bad access token" (the wrong app secret) or nothing at all.
 */
export type MetaVerification =
	{ ok: true; identity: VerifiedMetaIdentity } | { ok: false; reason: string }

/** The `{Nonce, AppId}` a Meta `platform_auth` payload carries. */
export interface MetaPlatformAuth {
	nonce: string
	appId: string
}

/**
 * Parse a Meta `platform_auth` payload, or null when it isn't one. The `AppId` must be
 * numeric — it is interpolated into the access token below, and this is what keeps a
 * client-supplied string out of that credential.
 */
export function parseMetaPlatformAuth(platformAuth: string): MetaPlatformAuth | null {
	let parsed: { Nonce?: unknown; AppId?: unknown }
	try {
		parsed = JSON.parse(platformAuth) as { Nonce?: unknown; AppId?: unknown }
	} catch {
		return null
	}
	const { Nonce: nonce, AppId: appId } = parsed
	if (typeof nonce !== 'string' || nonce === '') return null
	if (typeof appId !== 'string' || !/^\d+$/.test(appId)) return null
	return { nonce, appId }
}

/** The graph response we care about; everything else in the body is ignored. */
interface NonceValidateResponse {
	is_valid?: boolean
	error?: { message?: string; code?: number; type?: string; is_transient?: boolean }
}

/** One validation round-trip. `retryable` says whether another attempt could differ. */
async function validateOnce(
	form: URLSearchParams,
	fetcher: typeof fetch
): Promise<{ ok: boolean; retryable: boolean; reason: string }> {
	let res: Response
	try {
		res = await fetcher(NONCE_VALIDATE_URL, {
			method: 'POST',
			headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
			body: form.toString(),
		})
	} catch (err) {
		return { ok: false, retryable: true, reason: `request failed: ${String(err)}` }
	}

	let body: NonceValidateResponse
	try {
		body = (await res.json()) as NonceValidateResponse
	} catch {
		// A non-JSON body is Meta's edge (a 5xx error page, a rate-limit page), not a
		// verdict — treat it the way a dropped connection is treated.
		return { ok: false, retryable: true, reason: `HTTP ${res.status} with a non-JSON body` }
	}

	if (body.error) {
		const { code, message, is_transient } = body.error
		return {
			ok: false,
			retryable: is_transient === true || (code !== undefined && TRANSIENT_ERROR_CODES.has(code)),
			reason: `graph error ${code ?? '?'}: ${message ?? 'no message'}`,
		}
	}
	if (body.is_valid !== true) return { ok: false, retryable: false, reason: 'nonce rejected' }
	return { ok: true, retryable: false, reason: '' }
}

/**
 * Verify a Meta `platform_auth` payload against the `userId` it is claimed for, and
 * return the identity it proves. Only ever succeeds for a nonce Meta itself confirms
 * was issued to that user for that app.
 *
 * `appSecret` is the app's secret from the Meta developer dashboard; without it no
 * Meta login can be verified, so callers must treat an unset secret as a server
 * misconfiguration rather than a bad credential. `fetcher` is injectable so tests can
 * run the retry and response handling without reaching the network.
 */
export async function verifyMetaNonce(
	platformAuth: string,
	userId: string,
	appSecret: string,
	fetcher?: typeof fetch
): Promise<MetaVerification> {
	if (appSecret === '') return { ok: false, reason: 'no app secret configured' }
	// The user id is what the nonce is checked against, so an absent or non-numeric one
	// can't be verified — reject before spending a round-trip on it.
	if (!/^\d+$/.test(userId)) return { ok: false, reason: 'missing or non-numeric platform_id' }
	const auth = parseMetaPlatformAuth(platformAuth)
	if (!auth) return { ok: false, reason: 'malformed platform_auth payload' }

	// `OC|<app id>|<app secret>` is Meta's app access token — it authenticates the
	// *app*, which is why the secret never leaves the server.
	const form = new URLSearchParams({
		nonce: auth.nonce,
		user_id: userId,
		access_token: `OC|${auth.appId}|${appSecret}`,
	})

	// Resolved per call, not at module load, so a test's stubbed global is honoured.
	const doFetch = fetcher ?? globalThis.fetch
	let last = { ok: false, retryable: false, reason: 'not attempted' }
	for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
		last = await validateOnce(form, doFetch)
		if (last.ok) return { ok: true, identity: { userId, appId: auth.appId } }
		if (!last.retryable || attempt === MAX_ATTEMPTS) break
		await new Promise((resolve) => setTimeout(resolve, attempt * attempt * 250))
	}
	return { ok: false, reason: last.reason }
}
