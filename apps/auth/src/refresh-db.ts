/**
 * Refresh-token storage on the shared `recflare` D1 database (owned by the `auth`
 * worker, migration 0003). Only a SHA-256 hash of each token is stored — never the
 * raw value — alongside the account it logs in and an absolute expiry. Tokens are
 * single-use: redeeming one deletes it, so a fresh token is issued each refresh
 * (rotation) and a replayed token stops working.
 *
 * The platform identity is NOT kept here (dropped in 0006); a refreshed token takes
 * it from the account, which is where the bound identity actually lives.
 */

/** Refresh tokens live this long (s) before the client must log in again. */
export const REFRESH_TTL_SECONDS = 30 * 24 * 60 * 60 // 30 days

/** Schema DDL (mirror of migrations/0003_refresh_tokens.sql + 0006). */
export const REFRESH_SCHEMA_DDL: string[] = [
	`CREATE TABLE IF NOT EXISTS refresh_tokens (
		token_hash TEXT PRIMARY KEY,
		account_id INTEGER NOT NULL,
		created_at INTEGER NOT NULL,
		expires_at INTEGER NOT NULL
	)`,
	`CREATE INDEX IF NOT EXISTS idx_refresh_tokens_account ON refresh_tokens (account_id)`,
	`CREATE INDEX IF NOT EXISTS idx_refresh_tokens_expires ON refresh_tokens (expires_at)`,
]

/** SHA-256 hex of the token. Tokens are high-entropy random, so no salt is needed. */
async function hashToken(token: string): Promise<string> {
	const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(token))
	return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('')
}

/**
 * Mint and persist a new refresh token for the given account, returning the raw
 * token — the only moment it exists in plaintext (only its hash is stored).
 */
export async function issueRefreshToken(db: D1Database, accountId: number): Promise<string> {
	const token = `${crypto.randomUUID()}`
	const now = Math.floor(Date.now() / 1000)
	await db
		.prepare(
			`INSERT INTO refresh_tokens (token_hash, account_id, created_at, expires_at)
			 VALUES (?1, ?2, ?3, ?4)`
		)
		.bind(await hashToken(token), accountId, now, now + REFRESH_TTL_SECONDS)
		.run()
	return token
}

/**
 * Attempts per redemption. D1 occasionally answers a perfectly good statement with
 * `D1_ERROR: internal error` — a storage-side hiccup carrying a support reference, not a
 * verdict on the query. Unretried, one of those logs a player out: the grant throws, the
 * shared error handler turns it into a 500, and the client falls back to the login
 * screen with a refresh token it never got to spend.
 *
 * Deliberately small, like the Meta nonce retry next door: a refresh blocks the client on
 * a loading screen, so two quick retries ride out a blip and a longer outage fails fast
 * rather than hanging.
 */
const MAX_ATTEMPTS = 3

/**
 * Redeem a refresh token: if it exists and hasn't expired, delete it (single-use
 * rotation) and return the account it logs in; otherwise return null. The delete is
 * atomic (`DELETE ... RETURNING`), so a token can't be redeemed twice — a
 * concurrent second attempt finds no row. An expired token is deleted and rejected.
 *
 * A D1 error is retried (see {@link MAX_ATTEMPTS}). That is safe precisely BECAUSE the
 * statement is atomic and single-use: an attempt that actually committed before failing
 * to answer leaves no row, so the retry returns null and the player re-logs in — exactly
 * what a replayed token does. There is no interleaving in which retrying redeems one
 * token twice, and none in which it lands worse than the 500 it replaces.
 *
 * Only the D1 call is retried; the hashing around it is pure.
 */
export async function consumeRefreshToken(db: D1Database, token: string): Promise<number | null> {
	const now = Math.floor(Date.now() / 1000)
	const statement = db
		.prepare(
			`DELETE FROM refresh_tokens WHERE token_hash = ?1
			 RETURNING account_id AS accountId, expires_at AS expiresAt`
		)
		.bind(await hashToken(token))

	let row: { accountId: number; expiresAt: number } | null = null
	for (let attempt = 1; ; attempt++) {
		try {
			row = await statement.first<{ accountId: number; expiresAt: number }>()
			break
		} catch (err) {
			// The last attempt rethrows: a D1 outage is a 500, not a silent "bad token" that
			// would tell the player to log in again over something that isn't their fault.
			if (attempt === MAX_ATTEMPTS) throw err
			await new Promise((resolve) => setTimeout(resolve, attempt * attempt * 250))
		}
	}

	if (!row || row.expiresAt < now) return null
	return row.accountId
}
