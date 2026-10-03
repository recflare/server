/**
 * The RecFlare Studio upload whitelist, on the shared `recflare` D1 database.
 *
 * Rec Room Studio decides Full access by reading the access token for a `role`
 * claim whose value is exactly `betastudio`. Nothing else grants it. Auth owns
 * the table (apps/auth/migrations/0012_studio_beta_access.sql) and reads it when
 * it mints a token. The website owns the staff endpoints that insert and delete
 * rows. A dedicated table, rather than a flag on the account blob, so the grant
 * never rides out on an account DTO.
 *
 * `STUDIO_BETA_ACCESS_SCHEMA_DDL` mirrors that migration so tests can build the
 * table directly. A missing table is an error: auth consults it on every token,
 * and a quiet miss would sign everyone in as Limited.
 */

export const STUDIO_BETA_ACCESS_SCHEMA_DDL: string[] = [
	`CREATE TABLE IF NOT EXISTS studio_beta_access (
		account_id INTEGER PRIMARY KEY,
		granted_by INTEGER NOT NULL,
		granted_at TEXT NOT NULL
	)`,
]

/** One whitelist row, as the website lists it. */
export interface StudioBetaAccess {
	accountId: number
	/** Staff account that added the row. A repeat add leaves this as it was. */
	grantedBy: number
	/** ISO-8601 time the row was inserted. */
	grantedAt: string
}

interface StudioBetaAccessRow {
	account_id: number
	granted_by: number
	granted_at: string
}

const toAccess = (row: StudioBetaAccessRow): StudioBetaAccess => ({
	accountId: row.account_id,
	grantedBy: row.granted_by,
	grantedAt: row.granted_at,
})

/** Whether this account's next token should carry `betastudio`. */
export async function hasStudioBetaAccess(db: D1Database, accountId: number): Promise<boolean> {
	const row = await db
		.prepare('SELECT 1 AS ok FROM studio_beta_access WHERE account_id = ?1')
		.bind(accountId)
		.first<{ ok: number }>()
	return row !== null
}

/** Every account on the whitelist, oldest grant first. */
export async function listStudioBetaAccess(db: D1Database): Promise<StudioBetaAccess[]> {
	const { results } = await db
		.prepare(
			`SELECT account_id, granted_by, granted_at
			 FROM studio_beta_access
			 ORDER BY granted_at, account_id`
		)
		.all<StudioBetaAccessRow>()
	return results.map(toAccess)
}

/**
 * Put an account on the whitelist.
 *
 * Idempotent: a second grant leaves the original `granted_by` and `granted_at`
 * in place and returns false. True means a row was inserted.
 */
export async function grantStudioBetaAccess(
	db: D1Database,
	accountId: number,
	grantedBy: number
): Promise<boolean> {
	const res = await db
		.prepare(
			`INSERT INTO studio_beta_access (account_id, granted_by, granted_at)
			 VALUES (?1, ?2, ?3)
			 ON CONFLICT(account_id) DO NOTHING`
		)
		.bind(accountId, grantedBy, new Date().toISOString())
		.run()
	return (res.meta.changes ?? 0) > 0
}

/** Take an account off the whitelist. True when a row was actually deleted. */
export async function revokeStudioBetaAccess(db: D1Database, accountId: number): Promise<boolean> {
	const res = await db
		.prepare('DELETE FROM studio_beta_access WHERE account_id = ?1')
		.bind(accountId)
		.run()
	return (res.meta.changes ?? 0) > 0
}
