/**
 * What a refused `auth` `/connect/token` grant means to somebody filling in a form.
 *
 * Shared by the worker and the browser, because the two halves of the site refuse in
 * different places and have to say the same thing. Signup is refused SERVER-side (it
 * goes through www for the Turnstile check — see www.app.ts), while sign-in is refused
 * by `auth` directly, which the SPA calls itself. Without this shared table the second
 * one would put a bare OAuth code on screen.
 *
 * No runtime dependencies, so it's safe to pull into the client bundle.
 */

/** Which grant was being made, so a shared refusal reads right on either form. */
export type AuthAction = 'signup' | 'login'

/**
 * Keyed on the exact `error_description` auth sends (see its `/connect/token` handler).
 * The platform arms aren't reachable from the web today — signup posts `create_account`
 * with no platform, sign-in posts `password` — but they're mapped anyway so a future web
 * flow that does assert one can't regress to a bare code.
 */
const AUTH_MESSAGES: Record<string, string> = {
	'too many accounts created from this network':
		'Too many accounts have already been created from your network. Try again later, or from a different connection.',
	'account limit reached for this platform account':
		'This platform account has already created as many accounts as it is allowed.',
	'invalid account_id or password': 'That username or password is incorrect.',
	'account_id or username is required': 'Username and password are required.',
	'invalid or missing platform_auth': 'Your platform sign-in could not be verified.',
	'unsupported platform; only Steam and Meta can be verified':
		'That platform cannot be verified — only Steam and Meta are supported.',
	'no linked account for this platform identity':
		'No account is linked to this platform sign-in yet. Sign in with your password once to link it.',
	'refresh_token is invalid or expired': 'Your session has expired. Please sign in again.',
	// An account that shares a device or network with a BANNED one. Phrased for BOTH the
	// person evading a ban and the housemate of one — the IP arm cannot tell them apart —
	// and for both forms, since signup and sign-in send the same description. A directly
	// banned account is not refused a sign-in at all (auth issues it a token so the game
	// client can show the block screen), which is why there is no "banned" entry here.
	'this device or network is blocked':
		'This device or network is blocked. If you think that is a mistake, contact the server operator.',
}

/** Fallbacks when nothing above matched, so a player never reads an OAuth code. */
const GENERIC_MESSAGES: Record<AuthAction, { rejected: string; broken: string }> = {
	signup: {
		rejected: 'Your account could not be created. Please check your details and try again.',
		broken:
			'Accounts cannot be created right now. This is a problem on our end — please try again later.',
	},
	login: {
		rejected: 'You could not be signed in. Please check your details and try again.',
		broken:
			'Sign-in is unavailable right now. This is a problem on our end — please try again later.',
	},
}

/** Message for an `auth` that couldn't be reached at all (the request itself threw). */
export const authUnreachable = (action: AuthAction): string => GENERIC_MESSAGES[action].broken

/** A rejected `/connect/token` grant, translated. */
export interface AuthFailure {
	/** The sentence to put in front of the player. */
	message: string
	/** 400 when the grant was refused, 502 when `auth` itself couldn't proceed. */
	status: 400 | 502
	/** The raw `error`/`error_description` pair, for the operator's log line only. */
	upstream: string
}

/**
 * Translate a refusal auth has already answered.
 *
 * auth answers the OAuth shape — `{ error: 'invalid_grant', error_description: … }` —
 * where `error` is one of three machine codes and the DESCRIPTION carries the actual
 * reason. Showing that body verbatim put "invalid_grant" on screen for every failure,
 * including the ones a player can act on (the per-network signup cap). An unrecognised
 * description falls back to the generic line for the action rather than leaking whatever
 * it did say — those are written for an operator.
 */
export function authFailure(
	action: AuthAction,
	status: number,
	code: string,
	description: string
): AuthFailure {
	// A 5xx (or a `server_error`) is an operator misconfiguration — an unset JWT_SECRET,
	// an unset META_APP_SECRET — not something the player got wrong. Don't send them back
	// to re-check a form that was fine; the real reason is in auth's log, not theirs.
	const broken = status >= 500 || code === 'server_error'
	const generic = GENERIC_MESSAGES[action]

	return {
		message:
			(!broken && AUTH_MESSAGES[description]) || (broken ? generic.broken : generic.rejected),
		status: broken ? 502 : 400,
		upstream: description ? `${code || 'unknown'}: ${description}` : code || `HTTP ${status}`,
	}
}
