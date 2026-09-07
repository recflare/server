/**
 * Password hashing, shared by everything that reads or writes an account's
 * credential: the `auth` worker (/connect/token credential login and
 * /account/me/changepassword) and the `admin` CLI (`runx admin set-password`).
 * It lives here in @repo/domain — next to the account storage the hash is written
 * into — so there is exactly one definition of the on-disk format and a hash minted
 * by one caller always verifies in another.
 *
 * PBKDF2-SHA256 with a random per-password salt, stored as `salt:hash` (both
 * base64). The raw password is never persisted.
 */
const ITERATIONS = 100_000

const b64 = (bytes: Uint8Array): string => btoa(String.fromCharCode(...bytes))
const fromB64 = (s: string): Uint8Array<ArrayBuffer> =>
	Uint8Array.from(atob(s), (ch) => ch.charCodeAt(0))

/**
 * The salt is `Uint8Array<ArrayBuffer>` rather than a bare `Uint8Array` because the latter
 * is `Uint8Array<ArrayBufferLike>`, which admits a `SharedArrayBuffer` — and the DOM lib's
 * `BufferSource` does not. Both callers already produce a plain-ArrayBuffer view
 * (`getRandomValues` and `fromB64`), so this only writes down what was always true; without
 * it, any worker whose tsconfig includes the DOM lib (`www`, for its React client) fails to
 * compile on the `deriveBits` call below.
 */
async function deriveBits(
	password: string,
	salt: Uint8Array<ArrayBuffer>
): Promise<Uint8Array<ArrayBuffer>> {
	const keyMaterial = await crypto.subtle.importKey(
		'raw',
		new TextEncoder().encode(password),
		'PBKDF2',
		false,
		['deriveBits']
	)
	const bits = await crypto.subtle.deriveBits(
		{ name: 'PBKDF2', salt, iterations: ITERATIONS, hash: 'SHA-256' },
		keyMaterial,
		256
	)
	return new Uint8Array(bits)
}

/** Hash a password into a `salt:hash` string (both base64). */
export async function hashPassword(password: string): Promise<string> {
	const salt = crypto.getRandomValues(new Uint8Array(16))
	return `${b64(salt)}:${b64(await deriveBits(password, salt))}`
}

/** Verify a password against a stored `salt:hash`. */
export async function verifyPassword(password: string, stored: string): Promise<boolean> {
	const [saltB64, hashB64] = stored.split(':')
	if (!saltB64 || !hashB64) return false
	const actual = b64(await deriveBits(password, fromB64(saltB64)))
	return actual === hashB64
}
