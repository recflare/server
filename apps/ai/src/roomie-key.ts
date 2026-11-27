/**
 * A player's own OpenAI API key, which their Roomie talks to OpenAI Realtime with.
 *
 * WRITE-ONLY by design. A player sets or removes the key (from the website); nothing ever
 * returns it — not to the player, not to staff, not to the game. The game connects to OpenAI
 * itself and needs a credential to do it, so `POST /realtime-session/create` hands it an
 * EPHEMERAL client secret minted here with the stored key ({@link mintClientSecret}): a token
 * good for opening one session in the next few minutes. Sniffing game traffic, or a modified
 * client, yields that token and never the key.
 *
 * At rest the key is AES-256-GCM ciphertext (`roomie_api_key`, see @repo/domain's
 * roomie-key-db.ts) under `ROOMIE_KEY_ENCRYPTION_KEY`, a secret only this worker binds. The
 * additional authenticated data names the account and the encryption-key version, so a row
 * copied onto another account (to spend someone else's key) fails to decrypt, and so does a
 * row whose version is tampered with.
 *
 * `ROOMIE_KEY_ENCRYPTION_KEY` is a keyring: `<version>:<base64 32 bytes>` entries separated by
 * commas, the FIRST being the current one. A bare base64 value is version 1. To rotate, put a
 * new entry first and keep the old ones until every row has been re-sealed — a row sealed
 * under an older version is re-sealed under the current one the next time it is used.
 *
 * Nothing in this module logs a key, a ciphertext or an OpenAI response body (OpenAI's error
 * messages quote part of the key they rejected).
 */

/** One encryption key and the version rows sealed with it record. */
interface RingKey {
	version: number
	key: CryptoKey
}

/** The parsed `ROOMIE_KEY_ENCRYPTION_KEY`: the current key first, older ones after. */
export interface Keyring {
	current: RingKey
	byVersion: Map<number, CryptoKey>
}

/** A sealed key, as stored. */
export interface Sealed {
	keyVersion: number
	iv: Uint8Array
	ciphertext: Uint8Array
}

function base64Bytes(text: string): Uint8Array | null {
	try {
		const binary = atob(text.trim())
		return Uint8Array.from(binary, (c) => c.charCodeAt(0))
	} catch {
		return null
	}
}

/**
 * Parse the keyring secret, or null when it is missing or malformed — which turns the whole
 * feature off (no key can be stored or used) rather than failing every Roomie request.
 */
export async function parseKeyring(secret: string | null | undefined): Promise<Keyring | null> {
	if (!secret) return null
	const entries: RingKey[] = []
	for (const part of secret.split(',')) {
		const trimmed = part.trim()
		if (!trimmed) continue
		const colon = trimmed.indexOf(':')
		const version = colon === -1 ? 1 : Number(trimmed.slice(0, colon))
		const raw = base64Bytes(colon === -1 ? trimmed : trimmed.slice(colon + 1))
		if (!Number.isSafeInteger(version) || version < 1 || raw === null || raw.length !== 32)
			return null
		const key = await crypto.subtle.importKey('raw', raw, 'AES-GCM', false, ['encrypt', 'decrypt'])
		entries.push({ version, key })
	}
	if (entries.length === 0) return null
	const byVersion = new Map<number, CryptoKey>()
	for (const entry of entries) {
		if (byVersion.has(entry.version)) return null
		byVersion.set(entry.version, entry.key)
	}
	return { current: entries[0]!, byVersion }
}

/** What the ciphertext is bound to: this feature, the encryption-key version, the account. */
const aad = (version: number, accountId: number) =>
	new TextEncoder().encode(`recflare:roomie-api-key:v${version}:account:${accountId}`)

/** Seal `apiKey` for `accountId` under the keyring's current key. */
export async function sealKey(ring: Keyring, accountId: number, apiKey: string): Promise<Sealed> {
	const iv = crypto.getRandomValues(new Uint8Array(12))
	const ciphertext = await crypto.subtle.encrypt(
		{ name: 'AES-GCM', iv, additionalData: aad(ring.current.version, accountId) },
		ring.current.key,
		new TextEncoder().encode(apiKey)
	)
	return { keyVersion: ring.current.version, iv, ciphertext: new Uint8Array(ciphertext) }
}

/**
 * Open a sealed key for `accountId`, or null when it can't be: its version is no longer in the
 * keyring, or the ciphertext, version or account doesn't match what sealed it.
 */
export async function openKey(
	ring: Keyring,
	accountId: number,
	sealed: Sealed
): Promise<string | null> {
	const key = ring.byVersion.get(sealed.keyVersion)
	if (!key) return null
	try {
		const plain = await crypto.subtle.decrypt(
			{ name: 'AES-GCM', iv: sealed.iv, additionalData: aad(sealed.keyVersion, accountId) },
			key,
			sealed.ciphertext
		)
		return new TextDecoder().decode(plain)
	} catch {
		return null
	}
}

/**
 * Whether `value` looks like an OpenAI API key: `sk-` and then URL-safe characters
 * (`sk-proj-…`, `sk-svcacct-…` and legacy `sk-…` keys alike). Only a shape check; whether
 * OpenAI accepts it is {@link mintClientSecret}'s question.
 */
export function isOpenAiKeyShape(value: unknown): value is string {
	return typeof value === 'string' && /^sk-[A-Za-z0-9_-]{20,500}$/.test(value)
}

/** The realtime model a session token is minted for, unless the operator overrides it. */
export const DEFAULT_REALTIME_MODEL = 'gpt-realtime'

/** How long a minted session token stays valid for OPENING a session (s). */
const CLIENT_SECRET_TTL_SECONDS = 600

export type MintResult =
	| { ok: true; clientSecret: string; sessionId: string | null }
	/**
	 * `rejected`: OpenAI refused the key itself (revoked, mistyped). `forbidden`: the key is
	 * valid but may not use Realtime (a restricted key without that permission, or a project
	 * without access). `unavailable`: OpenAI couldn't be reached or failed on its side.
	 */
	| { ok: false; reason: 'rejected' | 'forbidden' | 'unavailable'; status: number }

/**
 * Mint an ephemeral Realtime client secret with `apiKey` (`POST /v1/realtime/client_secrets`).
 * Creating one costs nothing — usage is billed only once the game opens a session with it —
 * which also makes it the check run when a key is saved: it exercises exactly the
 * permission Roomie needs.
 */
export async function mintClientSecret(
	fetcher: Pick<Fetcher, 'fetch'> | undefined,
	apiKey: string,
	model: string
): Promise<MintResult> {
	let res: Response
	try {
		res = await (fetcher ?? { fetch }).fetch('https://api.openai.com/v1/realtime/client_secrets', {
			method: 'POST',
			headers: { authorization: `Bearer ${apiKey}`, 'content-type': 'application/json' },
			body: JSON.stringify({
				expires_after: { anchor: 'created_at', seconds: CLIENT_SECRET_TTL_SECONDS },
				session: { type: 'realtime', model },
			}),
		})
	} catch {
		return { ok: false, reason: 'unavailable', status: 0 }
	}
	if (res.status === 401) return { ok: false, reason: 'rejected', status: res.status }
	if (res.status === 403) return { ok: false, reason: 'forbidden', status: res.status }
	if (!res.ok) return { ok: false, reason: 'unavailable', status: res.status }
	const body = (await res.json().catch(() => null)) as {
		value?: unknown
		session?: { id?: unknown }
	} | null
	if (!body || typeof body.value !== 'string' || body.value === '') {
		return { ok: false, reason: 'unavailable', status: res.status }
	}
	const sessionId = typeof body.session?.id === 'string' ? body.session.id : null
	return { ok: true, clientSecret: body.value, sessionId }
}
