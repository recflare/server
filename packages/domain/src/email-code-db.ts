/**
 * One-shot codes sent by email, on the shared `recflare` D1 database (owned by the `auth`
 * worker, migration 0014). Two things are confirmed this way, each a `purpose`:
 *
 *  - `password_reset` — "Forgot password" (`auth` `/account/recoverpassword` issues the
 *    code, `/account/resetpassword` spends it). Payload: none.
 *  - `email_change` — the CURRENT address approving a change away from it (`accounts`
 *    `/account/me/email` issues it, `/account/me/email/confirm` spends it). Payload: the
 *    new address. Spending it issues the next:
 *  - `email_verify` — the NEW address confirming it is reachable, and the step that applies
 *    the change; the only step for an account with no address yet. Payload: the new address.
 *
 * The rules, all of which exist because a six-digit code is guessable:
 *
 *  - ONE pending code per account and purpose; a new request replaces the old, so the latest
 *    email is the one that works.
 *  - ONE attempt per code. A wrong guess BURNS the row (`code_hash` goes NULL) rather than
 *    leaving it open to the next guess — the player has to request a fresh email, which is
 *    what "restart" means. The row itself stays, so the resend cooldown below still counts
 *    from the last email.
 *  - A code lapses after {@link EMAIL_CODE_TTL_SECONDS}.
 *  - A fresh email goes out at most once per {@link EMAIL_CODE_RESEND_COOLDOWN_SECONDS} per
 *    account and purpose, and at most {@link EMAIL_CODE_DAILY_LIMIT} times a day, however
 *    often one is asked for — recovery can be requested by anyone who knows an address, and
 *    without this it would be a way to flood someone's inbox (a cooldown alone still allows
 *    hundreds a day). Refused, nothing is issued and nothing should be sent.
 *
 * Only a PBKDF2 hash of the code is stored (the same `hashPassword` as an account's
 * password), never the code: a copy of the table shouldn't be a way into every account with
 * a code in flight.
 */

import { hashPassword, verifyPassword } from './password'
import { takeRateLimit } from './rate-limit-db'

/** What a code is for; one pending code per account and purpose. */
export type EmailCodePurpose = 'password_reset' | 'email_change' | 'email_verify'

/** A code is good for this long (s) after the email is sent. */
export const EMAIL_CODE_TTL_SECONDS = 30 * 60

/** Another email for the same purpose to the same account is refused within this long (s). */
export const EMAIL_CODE_RESEND_COOLDOWN_SECONDS = 2 * 60

/**
 * Codes sent per account and purpose per {@link EMAIL_CODE_DAILY_WINDOW_SECONDS}, counting
 * only emails that were actually issued (not refused repeats). Enough for anyone genuinely
 * struggling with a code; a loop pointed at someone's address gets this many and then
 * silence until tomorrow.
 */
export const EMAIL_CODE_DAILY_LIMIT = 5
export const EMAIL_CODE_DAILY_WINDOW_SECONDS = 24 * 60 * 60

/** The code's length in digits. The emails and the website's forms all print it this wide. */
export const EMAIL_CODE_LENGTH = 6

/** Schema DDL (mirror of apps/auth/migrations/0014_email_code.sql). */
export const EMAIL_CODE_SCHEMA_DDL: string[] = [
	`CREATE TABLE IF NOT EXISTS email_code (
		account_id INTEGER NOT NULL,
		purpose TEXT NOT NULL,
		code_hash TEXT,
		payload TEXT,
		created_at INTEGER NOT NULL,
		expires_at INTEGER NOT NULL,
		PRIMARY KEY (account_id, purpose)
	)`,
]

/** A fresh code: {@link EMAIL_CODE_LENGTH} decimal digits, leading zeros included. */
export function newEmailCode(): string {
	// Rejection-sampled from a uint32 so every code is equally likely — a bare modulo
	// would favour the low codes slightly.
	const limit = 10 ** EMAIL_CODE_LENGTH
	const cap = Math.floor(2 ** 32 / limit) * limit
	const buf = new Uint32Array(1)
	let n: number
	do {
		crypto.getRandomValues(buf)
		n = buf[0]!
	} while (n >= cap)
	return String(n % limit).padStart(EMAIL_CODE_LENGTH, '0')
}

/**
 * Whether `code` is shaped like one of ours: exactly {@link EMAIL_CODE_LENGTH} digits. Checked
 * before the hash so a malformed guess doesn't spend a PBKDF2 round — but a malformed guess
 * still counts as a guess, see {@link completeEmailCode}.
 */
export const isEmailCodeShaped = (code: string): boolean =>
	new RegExp(`^\\d{${EMAIL_CODE_LENGTH}}$`).test(code)

/** Why {@link beginEmailCode} issued nothing. The player is told about the first; the second too. */
export type EmailCodeRefusal = 'cooldown' | 'quota'

export type EmailCodeIssue =
	{ code: string; refused?: never } | { code?: never; refused: EmailCodeRefusal }

/**
 * Issue a code for the account and purpose, replacing any pending one, and return it — the
 * only moment it exists in plaintext. `payload` rides along to be handed back when the code
 * is spent. Refuses — nothing changed, the pending code and ITS payload stand, and nothing
 * should be sent — with `cooldown` when a code for this account and purpose was issued less
 * than the cooldown ago (burned or not), and with `quota` when {@link EMAIL_CODE_DAILY_LIMIT}
 * have been issued today. `force` skips the cooldown only, for a caller that has its own
 * reason to know the send is not a repeat (a code going to a DIFFERENT address than the last
 * one, or a step a previous code has just unlocked); the daily cap always applies.
 */
export async function beginEmailCode(
	db: D1Database,
	purpose: EmailCodePurpose,
	accountId: number,
	payload: string | null = null,
	{ force = false }: { force?: boolean } = {}
): Promise<EmailCodeIssue> {
	const now = Math.floor(Date.now() / 1000)
	if (!force) {
		const recent = await db
			.prepare(
				'SELECT created_at AS createdAt FROM email_code WHERE account_id = ?1 AND purpose = ?2'
			)
			.bind(accountId, purpose)
			.first<{ createdAt: number }>()
		if (recent && now - recent.createdAt < EMAIL_CODE_RESEND_COOLDOWN_SECONDS) {
			return { refused: 'cooldown' }
		}
	}
	// Counted after the cooldown, so only codes that would actually go out spend the day's
	// allowance — a loop re-asking inside the cooldown gets nothing and costs the account's
	// real owner nothing.
	const quota = await takeRateLimit(
		db,
		`email_code:${purpose}:${accountId}`,
		EMAIL_CODE_DAILY_LIMIT,
		EMAIL_CODE_DAILY_WINDOW_SECONDS
	)
	if (!quota.allowed) return { refused: 'quota' }

	const code = newEmailCode()
	await db
		.prepare(
			`INSERT INTO email_code (account_id, purpose, code_hash, payload, created_at, expires_at)
			 VALUES (?1, ?2, ?3, ?4, ?5, ?6)
			 ON CONFLICT (account_id, purpose) DO UPDATE SET
				code_hash = excluded.code_hash,
				payload = excluded.payload,
				created_at = excluded.created_at,
				expires_at = excluded.expires_at`
		)
		.bind(accountId, purpose, await hashPassword(code), payload, now, now + EMAIL_CODE_TTL_SECONDS)
		.run()
	return { code }
}

/**
 * The payload of the account's LIVE code for a purpose — issued, not burned, not lapsed — or
 * null when there is none. What a page asks to show "a code is on its way to …" after a
 * reload. Says nothing about the code itself.
 */
export async function pendingEmailCode(
	db: D1Database,
	purpose: EmailCodePurpose,
	accountId: number
): Promise<{ payload: string | null; expiresAt: number } | null> {
	const now = Math.floor(Date.now() / 1000)
	const row = await db
		.prepare(
			`SELECT payload, expires_at AS expiresAt FROM email_code
			 WHERE account_id = ?1 AND purpose = ?2 AND code_hash IS NOT NULL AND expires_at >= ?3`
		)
		.bind(accountId, purpose, now)
		.first<{ payload: string | null; expiresAt: number }>()
	return row ?? null
}

/**
 * Drop the account's pending code for a purpose, cooldown and all — for when the email it
 * was issued for never went out, so the player can ask again straight away.
 */
export async function cancelEmailCode(
	db: D1Database,
	purpose: EmailCodePurpose,
	accountId: number
): Promise<void> {
	await db
		.prepare('DELETE FROM email_code WHERE account_id = ?1 AND purpose = ?2')
		.bind(accountId, purpose)
		.run()
}

export type EmailCodeOutcome =
	{ outcome: 'ok'; payload: string | null } | { outcome: 'wrong' } | { outcome: 'none' }

/**
 * Spend the account's pending code for a purpose. `ok` deletes the row and hands back the
 * payload it was issued with. `wrong` means the code didn't match — the row is BURNED, and
 * the player has to request a new email. `none` means there was nothing to match against:
 * no request, a lapsed one (deleted here), or one already burned. The two failures are told
 * apart for the log only; the player is told the same thing either way, so a guesser learns
 * nothing from the answer about whether a code is in flight.
 */
export async function completeEmailCode(
	db: D1Database,
	purpose: EmailCodePurpose,
	accountId: number,
	code: string
): Promise<EmailCodeOutcome> {
	const now = Math.floor(Date.now() / 1000)
	const row = await db
		.prepare(
			`SELECT code_hash AS codeHash, payload, expires_at AS expiresAt FROM email_code
			 WHERE account_id = ?1 AND purpose = ?2`
		)
		.bind(accountId, purpose)
		.first<{ codeHash: string | null; payload: string | null; expiresAt: number }>()
	if (!row || row.codeHash === null) return { outcome: 'none' }
	if (row.expiresAt < now) {
		await cancelEmailCode(db, purpose, accountId)
		return { outcome: 'none' }
	}

	const matches = isEmailCodeShaped(code) && (await verifyPassword(code, row.codeHash))
	if (!matches) {
		// Burn, don't delete: the row's `created_at` is what the resend cooldown counts from.
		await db
			.prepare('UPDATE email_code SET code_hash = NULL WHERE account_id = ?1 AND purpose = ?2')
			.bind(accountId, purpose)
			.run()
		return { outcome: 'wrong' }
	}

	await cancelEmailCode(db, purpose, accountId)
	return { outcome: 'ok', payload: row.payload }
}

/**
 * The address a worker's emails come from: `EMAIL_FROM` (set for every worker from the root
 * `.env` as `RECFLARE_EMAIL_FROM`), else `no-reply@<DOMAIN>`. Its domain must be one Email
 * Sending has been enabled on (`wrangler email sending enable`, see DEPLOYING.md) — Cloudflare
 * refuses a send from any other.
 */
export function emailSender(env: { DOMAIN: string; EMAIL_FROM?: string }): string {
	return env.EMAIL_FROM?.trim() || `no-reply@${env.DOMAIN}`
}

/** Escape text for the HTML half of an email. */
export const escapeHtml = (s: string): string =>
	s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')
