/**
 * A player's own OpenAI API key for Roomie, on the shared `recflare` D1 database (owned by
 * the `ai` worker, migration 0001). One row per account.
 *
 * The row holds only AES-GCM ciphertext; encrypting and decrypting happen in the `ai`
 * worker, the only one bound to `ROOMIE_KEY_ENCRYPTION_KEY` (see apps/ai/src/roomie-key.ts).
 * Everything else — `moderation` asking whether Roomie is enabled for a player — only ever
 * asks whether a row EXISTS ({@link hasRoomieKey}), never reads one.
 */

/** Schema DDL (mirror of apps/ai/migrations/0001_roomie_api_key.sql). */
export const ROOMIE_API_KEY_SCHEMA_DDL: string[] = [
	`CREATE TABLE IF NOT EXISTS roomie_api_key (
		account_id INTEGER PRIMARY KEY,
		key_version INTEGER NOT NULL,
		iv BLOB NOT NULL,
		ciphertext BLOB NOT NULL,
		created_at INTEGER NOT NULL,
		updated_at INTEGER NOT NULL
	)`,
]

/** A stored key: ciphertext and the encryption-key version that sealed it. */
export interface RoomieKeyRow {
	accountId: number
	keyVersion: number
	iv: Uint8Array
	ciphertext: Uint8Array
	createdAt: number
	updatedAt: number
}

interface RawRow {
	account_id: number
	key_version: number
	iv: ArrayBuffer | number[]
	ciphertext: ArrayBuffer | number[]
	created_at: number
	updated_at: number
}

// D1 returns BLOB columns as number arrays (and some runtimes as ArrayBuffers).
const bytes = (value: ArrayBuffer | number[]) =>
	value instanceof ArrayBuffer ? new Uint8Array(value) : Uint8Array.from(value)

/** Whether the account has a key on file. Reads no key material. */
export async function hasRoomieKey(db: D1Database, accountId: number): Promise<boolean> {
	const row = await db
		.prepare('SELECT 1 AS present FROM roomie_api_key WHERE account_id = ?1')
		.bind(accountId)
		.first<{ present: number }>()
	return row !== null
}

/** When the account's key was last set, or null when none is on file. Reads no key material. */
export async function roomieKeyUpdatedAt(
	db: D1Database,
	accountId: number
): Promise<number | null> {
	const row = await db
		.prepare('SELECT updated_at FROM roomie_api_key WHERE account_id = ?1')
		.bind(accountId)
		.first<{ updated_at: number }>()
	return row?.updated_at ?? null
}

/** The account's sealed key, or null. Only the `ai` worker can do anything with it. */
export async function getRoomieKeyRow(
	db: D1Database,
	accountId: number
): Promise<RoomieKeyRow | null> {
	const row = await db
		.prepare(
			'SELECT account_id, key_version, iv, ciphertext, created_at, updated_at FROM roomie_api_key WHERE account_id = ?1'
		)
		.bind(accountId)
		.first<RawRow>()
	if (row === null) return null
	return {
		accountId: row.account_id,
		keyVersion: row.key_version,
		iv: bytes(row.iv),
		ciphertext: bytes(row.ciphertext),
		createdAt: row.created_at,
		updatedAt: row.updated_at,
	}
}

/**
 * Store (or replace) the account's sealed key. `created_at` survives a replacement, so it
 * says when the player first set one; `updated_at` says when this one was.
 */
export async function putRoomieKeyRow(
	db: D1Database,
	accountId: number,
	sealed: { keyVersion: number; iv: Uint8Array; ciphertext: Uint8Array },
	now = Math.floor(Date.now() / 1000)
): Promise<void> {
	await db
		.prepare(
			`INSERT INTO roomie_api_key (account_id, key_version, iv, ciphertext, created_at, updated_at)
			 VALUES (?1, ?2, ?3, ?4, ?5, ?5)
			 ON CONFLICT (account_id) DO UPDATE SET
				key_version = excluded.key_version,
				iv = excluded.iv,
				ciphertext = excluded.ciphertext,
				updated_at = excluded.updated_at`
		)
		.bind(accountId, sealed.keyVersion, sealed.iv, sealed.ciphertext, now)
		.run()
}

/**
 * Re-seal a stored key under a newer encryption-key version (rotation), keeping both
 * timestamps: the player did not change their key.
 */
export async function resealRoomieKeyRow(
	db: D1Database,
	accountId: number,
	sealed: { keyVersion: number; iv: Uint8Array; ciphertext: Uint8Array }
): Promise<void> {
	await db
		.prepare(
			'UPDATE roomie_api_key SET key_version = ?2, iv = ?3, ciphertext = ?4 WHERE account_id = ?1'
		)
		.bind(accountId, sealed.keyVersion, sealed.iv, sealed.ciphertext)
		.run()
}

/** Forget the account's key. True when one was on file. */
export async function deleteRoomieKey(db: D1Database, accountId: number): Promise<boolean> {
	const result = await db
		.prepare('DELETE FROM roomie_api_key WHERE account_id = ?1')
		.bind(accountId)
		.run()
	return (result.meta.changes ?? 0) > 0
}
