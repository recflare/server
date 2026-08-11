/**
 * Player-report storage on the shared `recflare` D1 database.
 *
 * Like the relationship table (and unlike the JSON-blob tables here — rooms /
 * accounts / image / invention), a report is genuinely columnar, so it gets a
 * normal relational table. Rows are append-only in the sense that nothing rewrites
 * what a player submitted: the table is a log of exactly what was reported.
 *
 * The `api` worker owns this schema/migration (migrations/0004_report.sql and
 * 0009_report_ban.sql, applied under its own `migrations_table` so it doesn't clash
 * with the other workers' migrations that share the database).
 *
 * A report is also where an ACCOUNT-WIDE ban lives: acting on a report sets `banned`
 * on that same row (see `banFromReport`), so the ban carries the evidence for it. Two
 * workers read it — `match` refuses every matchmake for a banned player, and `auth`
 * refuses to issue them a token at all — both via `isPlayerBanned`. This is distinct
 * from the per-room `room_ban` table the rooms worker owns: that one keeps a player
 * out of ONE room, this one out of the game.
 *
 * `/api/PlayerReporting/v1/moderationBlockDetails` is NOT wired to it yet and still
 * answers "not blocked" unconditionally.
 */

/** Schema DDL (mirror of migrations/0004_report.sql + 0009_report_ban.sql). */
export const SCHEMA_DDL: string[] = [
	`CREATE TABLE IF NOT EXISTS report (
		id INTEGER PRIMARY KEY AUTOINCREMENT,
		reporter_player_id INTEGER NOT NULL,
		reported_player_id INTEGER NOT NULL,
		report_category INTEGER NOT NULL DEFAULT 0,
		details TEXT,
		height_reporter REAL,
		height_reported REAL,
		room_id INTEGER,
		room_instance_type TEXT,
		created_at TEXT NOT NULL,
		banned INTEGER NOT NULL DEFAULT 0,
		ban_expires TEXT
	)`,
	`CREATE INDEX IF NOT EXISTS idx_report_reported ON report (reported_player_id)`,
	`CREATE INDEX IF NOT EXISTS idx_report_reporter ON report (reporter_player_id)`,
	`CREATE INDEX IF NOT EXISTS idx_report_banned ON report (reported_player_id) WHERE banned = 1`,
]

/** A stored report row (snake_case columns, one row per submission). */
export interface ReportRow {
	id: number
	reporter_player_id: number
	reported_player_id: number
	report_category: number
	details: string | null
	/** Player height in metres, as the client measured it at report time. */
	height_reporter: number | null
	height_reported: number | null
	room_id: number | null
	/** The instance's `RoomInstanceType` name, e.g. `Public`. Stored verbatim. */
	room_instance_type: string | null
	created_at: string
	/** 1 when a moderator turned this report into a ban of `reported_player_id`. */
	banned: number
	/** ISO-8601 UTC instant the ban lifts; NULL means it never does. */
	ban_expires: string | null
}

/**
 * A report as submitted — everything but the reporter (which comes from the bearer
 * token) and the timestamp. Only the reported player is required; the client omits
 * fields it has no value for (a report raised outside a room carries no `RoomId`),
 * so the rest are optional and stored as NULL when absent.
 */
export interface NewReport {
	reporterPlayerId: number
	reportedPlayerId: number
	reportCategory?: number
	details?: string | null
	heightReporter?: number | null
	heightReported?: number | null
	roomId?: number | null
	roomInstanceType?: string | null
}

/** Record a submitted report, returning the stored row (with its assigned id). */
export async function createReport(db: D1Database, input: NewReport): Promise<ReportRow> {
	const row = await db
		.prepare(
			`INSERT INTO report (
				reporter_player_id, reported_player_id, report_category, details,
				height_reporter, height_reported, room_id, room_instance_type, created_at
			 ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)
			 RETURNING *`
		)
		.bind(
			input.reporterPlayerId,
			input.reportedPlayerId,
			input.reportCategory ?? 0,
			input.details ?? null,
			input.heightReporter ?? null,
			input.heightReported ?? null,
			input.roomId ?? null,
			input.roomInstanceType ?? null,
			new Date().toISOString()
		)
		.first<ReportRow>()
	// RETURNING always yields the inserted row; the non-null assert keeps the caller
	// from having to handle an impossible null.
	return row!
}

/** Every report filed against a player, newest first. Backs a future moderation view. */
export async function getReportsAgainst(db: D1Database, playerId: number): Promise<ReportRow[]> {
	const { results } = await db
		.prepare('SELECT * FROM report WHERE reported_player_id = ?1 ORDER BY id DESC')
		.bind(playerId)
		.all<ReportRow>()
	return results
}

/**
 * The ban currently in force against a player, or null when they aren't banned.
 *
 * "In force" is narrower than `banned = 1`: a row whose `ban_expires` has passed is a
 * ban that has SERVED ITS TIME, and the player is let back in without anyone having to
 * go and clear the flag — the row stays as the record that it happened. A permanent ban
 * carries no expiry at all (NULL), which is why that arm is checked separately rather
 * than by comparing against some far-future date.
 *
 * When several bans are in force, the longest-lasting one wins: permanent first (NULL
 * sorts ahead because `ban_expires IS NOT NULL` is 0 for it), then the latest expiry. So
 * a fresh short ban can never shorten a standing one.
 */
export async function getActiveBan(
	db: D1Database,
	playerId: number,
	now: Date = new Date()
): Promise<ReportRow | null> {
	return db
		.prepare(
			`SELECT * FROM report
			 WHERE reported_player_id = ?1 AND banned = 1
				 AND (ban_expires IS NULL OR ban_expires > ?2)
			 ORDER BY ban_expires IS NOT NULL, ban_expires DESC
			 LIMIT 1`
		)
		.bind(playerId, now.toISOString())
		.first<ReportRow>()
}

/**
 * Whether a player is banned right now. The hot-path form of `getActiveBan` — `match`
 * calls it on every matchmake and `auth` on every token grant, and neither has anything
 * to say about WHICH report did it.
 */
export async function isPlayerBanned(
	db: D1Database,
	playerId: number,
	now: Date = new Date()
): Promise<boolean> {
	return (await getActiveBan(db, playerId, now)) !== null
}

/**
 * Turn a report into a ban of the player it was filed against — the moderator action the
 * `banned` column exists for. `banExpires` is an ISO-8601 UTC instant, or null for a
 * permanent ban. Passing `banned: false` lifts the ban and clears the expiry, leaving the
 * report itself intact.
 *
 * Returns the updated row, or null when there is no report with that id — so the caller
 * can tell "banned" from "banned nobody" (wrangler's `d1 execute --json` reports no
 * changes count, hence RETURNING).
 */
export async function banFromReport(
	db: D1Database,
	reportId: number,
	options: { banned?: boolean; banExpires?: string | null } = {}
): Promise<ReportRow | null> {
	const banned = options.banned ?? true
	return db
		.prepare('UPDATE report SET banned = ?2, ban_expires = ?3 WHERE id = ?1 RETURNING *')
		.bind(reportId, banned ? 1 : 0, banned ? (options.banExpires ?? null) : null)
		.first<ReportRow>()
}
