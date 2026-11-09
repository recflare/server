/**
 * Two-factor sign-in on the shared `recflare` D1 database (owned by the `auth` worker,
 * migration 0017). Opt-in per account: an account whose `method` is `totp` or `email` has
 * its PASSWORD grant on `/connect/token` held for a second factor, which the client is asked
 * for through the OAuth-style `error` codes it understands (see TWO_FACTOR_ERRORS) and sends
 * back on a re-POST of the same form.
 *
 *  - `totp` — an authenticator app (RFC 6238: HMAC-SHA1, 6 digits, 30 s steps), accepted one
 *    step either side of now for clock drift. The last step accepted is stored and only a
 *    LATER step is accepted after it, so a code that was seen (shoulder-surfed, logged) can't
 *    be replayed inside its window.
 *  - `email` — a six-digit code mailed to the account's (confirmed) address, under
 *    @repo/domain's email-code rules as purpose `login`: one guess per code, a 2-minute resend
 *    cooldown, 5 a day.
 *
 * A pending sign-in is a `login_challenge` row keyed by the client's `login_context` (hashed;
 * it is the client's to choose and echo back), so the guesses made against one sign-in are
 * counted together. The retry still carries — and re-proves — the password; the challenge is
 * what correlates it, not a credential.
 */

/** Which second factor an account's password grant must also pass. */
export type TwoFactorMethod = 'none' | 'totp' | 'email'

/**
 * The `error` values the client acts on, exactly as it matches them (spaces included).
 * Nothing outside this table means anything to it — see the token grant.
 */
export const TWO_FACTOR_ERRORS = {
	totpRequired: 'continue_2fa',
	totpWrong: 'invalid 2fa_code',
	emailRequired: 'security_code required',
	emailWrong: 'invalid security_code',
} as const

/** Schema DDL (mirror of migrations/0017_two_factor.sql). */
export const TWO_FACTOR_SCHEMA_DDL: string[] = [
	`CREATE TABLE IF NOT EXISTS account_2fa (
		account_id INTEGER PRIMARY KEY,
		method TEXT NOT NULL DEFAULT 'none',
		totp_secret TEXT,
		totp_pending_secret TEXT,
		totp_last_step INTEGER NOT NULL DEFAULT 0,
		updated_at INTEGER NOT NULL
	)`,
	`CREATE TABLE IF NOT EXISTS login_challenge (
		context_hash TEXT PRIMARY KEY,
		account_id INTEGER NOT NULL,
		method TEXT NOT NULL,
		attempts INTEGER NOT NULL DEFAULT 0,
		created_at INTEGER NOT NULL,
		expires_at INTEGER NOT NULL
	)`,
	`CREATE INDEX IF NOT EXISTS idx_login_challenge_expires ON login_challenge (expires_at)`,
]

// ---- TOTP (RFC 4226 / 6238) ------------------------------------------------

export const TOTP_STEP_SECONDS = 30
export const TOTP_DIGITS = 6
/** Steps either side of now a code is still accepted at — ±30 s of clock drift. */
export const TOTP_WINDOW = 1
/** Secret length in bytes: 160 bits, what RFC 4226 recommends for HMAC-SHA1. */
const TOTP_SECRET_BYTES = 20

const BASE32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567'

export function base32Encode(bytes: Uint8Array): string {
	let out = ''
	let bits = 0
	let value = 0
	for (const byte of bytes) {
		value = (value << 8) | byte
		bits += 8
		while (bits >= 5) {
			out += BASE32[(value >>> (bits - 5)) & 31]
			bits -= 5
		}
	}
	if (bits > 0) out += BASE32[(value << (5 - bits)) & 31]
	return out
}

/** Decode base32 (case-insensitive, spaces and padding ignored); null when malformed. */
export function base32Decode(text: string): Uint8Array | null {
	const clean = text.toUpperCase().replace(/[\s=]/g, '')
	const out: number[] = []
	let bits = 0
	let value = 0
	for (const ch of clean) {
		const idx = BASE32.indexOf(ch)
		if (idx < 0) return null
		value = (value << 5) | idx
		bits += 5
		if (bits >= 8) {
			out.push((value >>> (bits - 8)) & 0xff)
			bits -= 8
		}
	}
	return new Uint8Array(out)
}

/** A fresh authenticator secret, base32 — what the player types or scans into their app. */
export function newTotpSecret(): string {
	return base32Encode(crypto.getRandomValues(new Uint8Array(TOTP_SECRET_BYTES)))
}

/** The HOTP code for `counter` under `key` (RFC 4226 §5.3 dynamic truncation). */
export async function hotp(key: Uint8Array, counter: number): Promise<string> {
	const msg = new ArrayBuffer(8)
	const view = new DataView(msg)
	// Counters fit in 53 bits; split into the two big-endian 32-bit halves.
	view.setUint32(0, Math.floor(counter / 2 ** 32))
	view.setUint32(4, counter >>> 0)
	const hmacKey = await crypto.subtle.importKey(
		'raw',
		key,
		{ name: 'HMAC', hash: 'SHA-1' },
		false,
		['sign']
	)
	const mac = new Uint8Array(await crypto.subtle.sign('HMAC', hmacKey, msg))
	const offset = mac[mac.length - 1]! & 0x0f
	const binary =
		((mac[offset]! & 0x7f) << 24) |
		(mac[offset + 1]! << 16) |
		(mac[offset + 2]! << 8) |
		mac[offset + 3]!
	return String(binary % 10 ** TOTP_DIGITS).padStart(TOTP_DIGITS, '0')
}

/** The TOTP time step `nowMs` falls in. */
export const totpStep = (nowMs: number = Date.now()): number =>
	Math.floor(nowMs / 1000 / TOTP_STEP_SECONDS)

/**
 * The step `code` is valid for under `secret`, within {@link TOTP_WINDOW} of now and strictly
 * after `afterStep` (the last one accepted, for replay protection) — or null when it matches
 * none. Every candidate is computed and compared in full so the time taken says nothing about
 * which step (if any) matched.
 */
export async function matchTotp(
	secret: string,
	code: string,
	afterStep = 0,
	nowMs: number = Date.now()
): Promise<number | null> {
	const key = base32Decode(secret)
	if (key === null || key.length === 0) return null
	const digits = code.replace(/\s/g, '')
	if (!new RegExp(`^\\d{${TOTP_DIGITS}}$`).test(digits)) return null
	const now = totpStep(nowMs)
	let matched: number | null = null
	for (let step = now - TOTP_WINDOW; step <= now + TOTP_WINDOW; step++) {
		const candidate = await hotp(key, step)
		if (constantTimeEqual(candidate, digits) && step > afterStep && matched === null) {
			matched = step
		}
	}
	return matched
}

function constantTimeEqual(a: string, b: string): boolean {
	if (a.length !== b.length) return false
	let diff = 0
	for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i)
	return diff === 0
}

/**
 * The `otpauth://` URI an authenticator app scans as a QR code. `issuer` is the server's
 * domain, `label` the account's username, so the entry reads "<domain> (<username>)".
 */
export function otpauthUri(secret: string, issuer: string, label: string): string {
	const name = encodeURIComponent(`${issuer}:${label}`)
	const params = new URLSearchParams({
		secret,
		issuer,
		algorithm: 'SHA1',
		digits: String(TOTP_DIGITS),
		period: String(TOTP_STEP_SECONDS),
	})
	return `otpauth://totp/${name}?${params.toString()}`
}

// ---- Account settings ------------------------------------------------------

export interface TwoFactorSettings {
	method: TwoFactorMethod
	totpSecret: string | null
	totpPendingSecret: string | null
	totpLastStep: number
}

const NO_TWO_FACTOR: TwoFactorSettings = {
	method: 'none',
	totpSecret: null,
	totpPendingSecret: null,
	totpLastStep: 0,
}

/** The account's two-factor settings; an account with no row has none. */
export async function getTwoFactor(db: D1Database, accountId: number): Promise<TwoFactorSettings> {
	const row = await db
		.prepare(
			`SELECT method, totp_secret AS totpSecret, totp_pending_secret AS totpPendingSecret,
				totp_last_step AS totpLastStep
			 FROM account_2fa WHERE account_id = ?1`
		)
		.bind(accountId)
		.first<TwoFactorSettings>()
	if (!row) return NO_TWO_FACTOR
	const method: TwoFactorMethod =
		row.method === 'totp' || row.method === 'email' ? row.method : 'none'
	return { ...row, method }
}

async function upsertTwoFactor(
	db: D1Database,
	accountId: number,
	fields: Partial<Omit<TwoFactorSettings, 'totpLastStep'>> & { totpLastStep?: number }
): Promise<void> {
	const current = await getTwoFactor(db, accountId)
	const next = { ...current, ...fields }
	await db
		.prepare(
			`INSERT INTO account_2fa (account_id, method, totp_secret, totp_pending_secret, totp_last_step, updated_at)
			 VALUES (?1, ?2, ?3, ?4, ?5, ?6)
			 ON CONFLICT (account_id) DO UPDATE SET
				method = excluded.method,
				totp_secret = excluded.totp_secret,
				totp_pending_secret = excluded.totp_pending_secret,
				totp_last_step = excluded.totp_last_step,
				updated_at = excluded.updated_at`
		)
		.bind(
			accountId,
			next.method,
			next.totpSecret,
			next.totpPendingSecret,
			next.totpLastStep,
			Math.floor(Date.now() / 1000)
		)
		.run()
}

/**
 * Start enrolling an authenticator: store a fresh secret as PENDING and return it. Nothing
 * about sign-in changes until {@link confirmTotp} sees a code from it, so a player who never
 * finishes the scan isn't locked out. Replaces any earlier pending secret.
 */
export async function beginTotpSetup(db: D1Database, accountId: number): Promise<string> {
	const secret = newTotpSecret()
	await upsertTwoFactor(db, accountId, { totpPendingSecret: secret })
	return secret
}

/**
 * Finish enrolling: when `code` is valid for the pending secret, it becomes the account's
 * secret and `totp` its method (replacing an `email` method). False when there is no pending
 * secret or the code doesn't match it.
 */
export async function confirmTotp(
	db: D1Database,
	accountId: number,
	code: string
): Promise<boolean> {
	const current = await getTwoFactor(db, accountId)
	if (current.totpPendingSecret === null) return false
	const step = await matchTotp(current.totpPendingSecret, code)
	if (step === null) return false
	await upsertTwoFactor(db, accountId, {
		method: 'totp',
		totpSecret: current.totpPendingSecret,
		totpPendingSecret: null,
		// The confirming code is spent: it can't then sign in a second time.
		totpLastStep: step,
	})
	return true
}

/** Make emailed codes the account's second factor (dropping any authenticator). */
export async function enableEmailTwoFactor(db: D1Database, accountId: number): Promise<void> {
	await upsertTwoFactor(db, accountId, {
		method: 'email',
		totpSecret: null,
		totpPendingSecret: null,
		totpLastStep: 0,
	})
}

/** Turn two-factor sign-in off, forgetting any authenticator secret. */
export async function disableTwoFactor(db: D1Database, accountId: number): Promise<void> {
	await db.prepare('DELETE FROM account_2fa WHERE account_id = ?1').bind(accountId).run()
	await db.prepare('DELETE FROM login_challenge WHERE account_id = ?1').bind(accountId).run()
}

/**
 * Check a sign-in's TOTP code against the account's secret and, when it matches a step later
 * than the last one accepted, record that step. The record is a conditional UPDATE, so two
 * sign-ins racing with the same code can't both win.
 */
export async function spendTotpCode(
	db: D1Database,
	accountId: number,
	settings: TwoFactorSettings,
	code: string
): Promise<boolean> {
	if (settings.totpSecret === null) return false
	const step = await matchTotp(settings.totpSecret, code, settings.totpLastStep)
	if (step === null) return false
	const claimed = await db
		.prepare(
			'UPDATE account_2fa SET totp_last_step = ?2 WHERE account_id = ?1 AND totp_last_step < ?2'
		)
		.bind(accountId, step)
		.run()
	return (claimed.meta.changes ?? 0) > 0
}

// ---- Pending sign-ins ------------------------------------------------------

/** A pending sign-in lapses this long (s) after it was opened. */
export const LOGIN_CHALLENGE_TTL_SECONDS = 10 * 60

/** Codes one pending sign-in may try before every further guess is refused unchecked. */
export const LOGIN_CHALLENGE_MAX_ATTEMPTS = 5

async function sha256Hex(text: string): Promise<string> {
	const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text))
	return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('')
}

/**
 * The challenge key for a sign-in: the client's `login_context` when it sent one, else the
 * account itself (one pending sign-in per account), hashed either way.
 */
export const loginChallengeKey = (loginContext: string, accountId: number): Promise<string> =>
	sha256Hex(loginContext !== '' ? `ctx:${loginContext}` : `account:${accountId}`)

/**
 * Open the pending sign-in under `key` for this account and method, or keep the live one.
 * A row under the same key for a DIFFERENT account or method (a reused context), or a lapsed
 * one, is replaced, guesses and all. Lapsed rows everywhere are purged as a side effect.
 */
export async function openLoginChallenge(
	db: D1Database,
	key: string,
	accountId: number,
	method: Exclude<TwoFactorMethod, 'none'>
): Promise<void> {
	const now = Math.floor(Date.now() / 1000)
	await db.batch([
		db.prepare('DELETE FROM login_challenge WHERE expires_at < ?1').bind(now),
		db
			.prepare(
				`INSERT INTO login_challenge (context_hash, account_id, method, attempts, created_at, expires_at)
				 VALUES (?1, ?2, ?3, 0, ?4, ?5)
				 ON CONFLICT (context_hash) DO UPDATE SET
					account_id = excluded.account_id,
					method = excluded.method,
					attempts = 0,
					created_at = excluded.created_at,
					expires_at = excluded.expires_at
				 WHERE login_challenge.account_id != excluded.account_id
					OR login_challenge.method != excluded.method
					OR login_challenge.expires_at < ?4`
			)
			.bind(key, accountId, method, now, now + LOGIN_CHALLENGE_TTL_SECONDS),
	])
}

/**
 * Count one guess against the pending sign-in under `key` (opening it first if it isn't
 * there — the client may have lost or never sent its context) and return the guesses made so
 * far, this one included.
 */
export async function countLoginChallengeAttempt(
	db: D1Database,
	key: string,
	accountId: number,
	method: Exclude<TwoFactorMethod, 'none'>
): Promise<number> {
	await openLoginChallenge(db, key, accountId, method)
	const row = await db
		.prepare(
			'UPDATE login_challenge SET attempts = attempts + 1 WHERE context_hash = ?1 RETURNING attempts'
		)
		.bind(key)
		.first<{ attempts: number }>()
	return row?.attempts ?? 1
}

/** Close the pending sign-in under `key` — it passed. */
export async function closeLoginChallenge(db: D1Database, key: string): Promise<void> {
	await db.prepare('DELETE FROM login_challenge WHERE context_hash = ?1').bind(key).run()
}
