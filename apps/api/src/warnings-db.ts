/**
 * Moderator-issued player warnings on the shared `recflare` D1 database.
 *
 * The counterpart to the `report` table (see reports-db.ts): a report is what a
 * player submits, a warning is what a moderator hands down. Same shape of storage —
 * columnar rather than a JSON blob, append-only, nothing dedupes or acts on the
 * rows yet.
 *
 * The `api` worker owns this schema/migration (migrations/0005_warning.sql,
 * applied under its own `migrations_table` so it doesn't clash with the other
 * workers' migrations that share the database).
 */

/** Schema DDL (mirror of migrations/0005_warning.sql, sans seed rows). */
export const SCHEMA_DDL: string[] = [
	`CREATE TABLE IF NOT EXISTS warning (
		id INTEGER PRIMARY KEY AUTOINCREMENT,
		moderator_player_id INTEGER NOT NULL,
		warned_player_id INTEGER NOT NULL,
		report_category INTEGER NOT NULL DEFAULT 0,
		display_reason TEXT,
		moderator_note TEXT,
		created_at TEXT NOT NULL
	)`,
	`CREATE INDEX IF NOT EXISTS idx_warning_warned ON warning (warned_player_id)`,
	`CREATE INDEX IF NOT EXISTS idx_warning_moderator ON warning (moderator_player_id)`,
]

/** A stored warning row (snake_case columns, one row per warning issued). */
export interface WarningRow {
	id: number
	/** The moderator who issued it, from their bearer token. */
	moderator_player_id: number
	warned_player_id: number
	report_category: number
	/** What the warned player is shown, e.g. `Sexual gestures`. */
	display_reason: string | null
	/** Internal note — never surfaced to the warned player. */
	moderator_note: string | null
	created_at: string
}

/**
 * A warning as issued — everything but the moderator (which comes from the bearer
 * token) and the timestamp. Only the warned player is required; the rest are
 * optional and stored as NULL when absent.
 */
export interface NewWarning {
	moderatorPlayerId: number
	warnedPlayerId: number
	reportCategory?: number
	displayReason?: string | null
	moderatorNote?: string | null
}

/** Record an issued warning, returning the stored row (with its assigned id). */
export async function createWarning(db: D1Database, input: NewWarning): Promise<WarningRow> {
	const row = await db
		.prepare(
			`INSERT INTO warning (
				moderator_player_id, warned_player_id, report_category,
				display_reason, moderator_note, created_at
			 ) VALUES (?1, ?2, ?3, ?4, ?5, ?6)
			 RETURNING *`
		)
		.bind(
			input.moderatorPlayerId,
			input.warnedPlayerId,
			input.reportCategory ?? 0,
			input.displayReason ?? null,
			input.moderatorNote ?? null,
			new Date().toISOString()
		)
		.first<WarningRow>()
	// RETURNING always yields the inserted row; the non-null assert keeps the caller
	// from having to handle an impossible null.
	return row!
}

/** Every warning issued against a player, newest first. Backs a future moderation view. */
export async function getWarningsAgainst(db: D1Database, playerId: number): Promise<WarningRow[]> {
	const { results } = await db
		.prepare('SELECT * FROM warning WHERE warned_player_id = ?1 ORDER BY id DESC')
		.bind(playerId)
		.all<WarningRow>()
	return results
}
