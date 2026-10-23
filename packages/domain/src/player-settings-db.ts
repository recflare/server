/**
 * The player settings map — the `player_settings` table on the shared `recflare` D1.
 *
 * One row per player, holding every setting they have as a flat `{ [Key]: Value }` JSON
 * record of strings in `data` — OOBE state, tutorial mask, chat privacy, the lot. The
 * `playersettings` worker owns the table (migration: apps/playersettings/migrations/
 * 0001_player_settings.sql) but `api`, `match` and `chat` each keep a setting of their own in
 * the same map, so every writer merges into the record rather than replacing it, and all of
 * them go through here.
 *
 * This replaced a Workers KV namespace (`RECFLARE_PLAYER_SETTINGS`, key `player:<id>`): the
 * row's `data` is byte-for-byte what the KV value was, which is what lets `runx admin
 * settings-import-kv` copy the old namespace across. The client is noisy — it re-posts
 * settings it already has at every login and menu change — and every write site has to read
 * the map first to merge into it, so comparing the result against what was read is free:
 * {@link putPlayerSettingsIfChanged} skips the write when the merged map is the one already
 * stored. (D1 reads are strongly consistent, so unlike KV a write here is visible to the next
 * read from any PoP.)
 */

export type PlayerSettings = Record<string, string>

/** Schema DDL (mirror of apps/playersettings/migrations/0001_player_settings.sql). */
export const PLAYER_SETTINGS_SCHEMA_DDL: string[] = [
	`CREATE TABLE IF NOT EXISTS player_settings (
		account_id INTEGER PRIMARY KEY,
		data TEXT NOT NULL
	)`,
]

/**
 * The player's stored settings, or null when they have none. A D1 failure THROWS rather than
 * reading as "none": a writer that mistook an outage for an empty map would then store its
 * one key over everything the player had. Read-only callers that would rather degrade wrap
 * this in their own `.catch`.
 */
export async function readPlayerSettings(
	db: D1Database,
	accountId: number
): Promise<PlayerSettings | null> {
	const row = await db
		.prepare('SELECT data FROM player_settings WHERE account_id = ?1')
		.bind(accountId)
		.first<{ data: string }>()
	return row === null ? null : (JSON.parse(row.data) as PlayerSettings)
}

/** Store `settings` as the player's whole map, replacing whatever row they had. */
export async function writePlayerSettings(
	db: D1Database,
	accountId: number,
	settings: PlayerSettings
): Promise<void> {
	await db
		.prepare(
			`INSERT INTO player_settings (account_id, data) VALUES (?1, ?2)
			 ON CONFLICT (account_id) DO UPDATE SET data = excluded.data`
		)
		.bind(accountId, JSON.stringify(settings))
		.run()
}

/** Drop the player's row entirely — their next read is a first read again. */
export async function deletePlayerSettings(db: D1Database, accountId: number): Promise<void> {
	await db.prepare('DELETE FROM player_settings WHERE account_id = ?1').bind(accountId).run()
}

/** Whether two settings maps hold the same keys with the same values. Order is irrelevant. */
export function samePlayerSettings(a: PlayerSettings | null, b: PlayerSettings | null): boolean {
	const left = a ?? {}
	const right = b ?? {}
	const keys = Object.keys(left)
	if (keys.length !== Object.keys(right).length) return false
	return keys.every((key) => key in right && left[key] === right[key])
}

/**
 * Store `next` as the player's settings unless it is what `existing` already says, in which
 * case nothing is written. Returns whether a write happened.
 *
 * `existing` is the map the caller read to build `next` from; passing the map it read (not a
 * fresh read) is the point — the comparison costs no database operation.
 */
export async function putPlayerSettingsIfChanged(
	db: D1Database,
	accountId: number,
	existing: PlayerSettings | null,
	next: PlayerSettings
): Promise<boolean> {
	if (existing !== null && samePlayerSettings(existing, next)) return false
	await writePlayerSettings(db, accountId, next)
	return true
}

/**
 * Merge `patch` into the player's settings, writing only if a value actually changed. The
 * result carries the merged map (what the player now has) and whether the row was written.
 *
 * Read-modify-write here isn't atomic; racing writers means one player toggling two of their
 * own options in the same instant, which every caller has accepted since before this helper
 * existed.
 */
export async function mergePlayerSettings(
	db: D1Database,
	accountId: number,
	patch: PlayerSettings
): Promise<{ settings: PlayerSettings; written: boolean }> {
	const existing = await readPlayerSettings(db, accountId)
	const settings: PlayerSettings = { ...existing, ...patch }
	const written = await putPlayerSettingsIfChanged(db, accountId, existing, settings)
	return { settings, written }
}
