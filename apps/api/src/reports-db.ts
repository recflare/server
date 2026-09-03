/**
 * Player-report storage on the shared `recflare` D1 database.
 *
 * Like the relationship table (and unlike the JSON-blob tables here — rooms /
 * accounts / image / invention), a report is genuinely columnar, so it gets a
 * normal relational table. Rows are append-only in the sense that nothing rewrites
 * what a player submitted: the table is a log of exactly what was reported.
 *
 * The `api` worker owns this schema/migration (migrations/0004_report.sql,
 * 0009_report_ban.sql, 0011_report_event.sql, 0016_report_invention.sql and
 * 0017_report_custom_avatar_item.sql, applied under its own `migrations_table` so it
 * doesn't clash with the other workers' migrations that share the database).
 *
 * A reported player EVENT, INVENTION or CUSTOM AVATAR ITEM lands here too, rather than in a
 * table of its own: same fields, same moderation life. Such a row carries `event_id`,
 * `invention_id` or `custom_avatar_item_id`, and its `reported_player_id` is that thing's
 * CREATOR — see `POST /api/playerevents/v1/report`, `POST /api/inventions/v1/report` and
 * `POST /api/customAvatarItems/v1/{id}/report`. The three id columns are mutually exclusive;
 * a row with none of them is an ordinary player report. They are three columns rather than
 * one polymorphic id because the keys differ in TYPE: two numbers and a guid.
 *
 * A report is also where an ACCOUNT-WIDE ban lives: acting on a report sets `banned`
 * on that same row (see `banFromReport`), so the ban carries the evidence for it. It is
 * ENFORCED by `match`, which refuses every matchmake for a banned player, and DESCRIBED
 * by `/api/PlayerReporting/v1/moderationBlockDetails`, which tells the banned player why
 * (via `getActiveBan`). `auth` still issues a banned account a token — that is what lets
 * the client reach the block screen — and reads this table only for ban EVASION (an
 * account sharing a device or network with a banned one; see bans-db). This is distinct
 * from the per-room `room_ban` table the rooms worker owns: that one keeps a player out
 * of ONE room, this one out of the game.
 */

/**
 * Schema DDL (mirror of migrations/0004_report.sql + 0009_report_ban.sql +
 * 0011_report_event.sql + 0016_report_invention.sql + 0017_report_custom_avatar_item.sql).
 *
 * None of `event_id`, `invention_id` or `custom_avatar_item_id` is indexed: each is written
 * on every report of its kind and read by nothing — no query here filters on any of them,
 * and the reads that do exist go by player or by the ban flag. 0011's partial index over
 * `event_id` was dropped in 0016 rather than mirrored. Add one back alongside the query that
 * needs it.
 */
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
		ban_expires TEXT,
		event_id INTEGER,
		invention_id INTEGER,
		custom_avatar_item_id TEXT
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
	/**
	 * The player event this report is against, or NULL for an ordinary player report —
	 * which is what tells the two kinds apart. See `POST /api/playerevents/v1/report`:
	 * `reported_player_id` and `room_id` are filled in from the event itself.
	 */
	event_id: number | null
	/**
	 * The invention this report is against, or NULL for any other kind — mutually exclusive
	 * with `event_id`. See `POST /api/inventions/v1/report`: `reported_player_id` is the
	 * invention's creator, read from the invention itself. No `room_id` comes with it; an
	 * invention isn't tied to one room the way an event is.
	 */
	invention_id: number | null
	/**
	 * The custom avatar item this report is against, or NULL for any other kind — mutually
	 * exclusive with the two above. TEXT because such an item is keyed by a GUID where an
	 * event and an invention are keyed by numbers. See
	 * `POST /api/customAvatarItems/v1/{id}/report`: `reported_player_id` is the item's
	 * creator, read from the item, because the client sends `ReportedPlayerId: null` here —
	 * it does not know who made it.
	 */
	custom_avatar_item_id: string | null
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
	/** Set only when reporting a player EVENT; absent on an ordinary player report. */
	eventId?: number | null
	/** Set only when reporting an INVENTION; never set alongside `eventId`. */
	inventionId?: number | null
	/** Set only when reporting a CUSTOM AVATAR ITEM; never set alongside the two above. */
	customAvatarItemId?: string | null
}

/** Record a submitted report, returning the stored row (with its assigned id). */
export async function createReport(db: D1Database, input: NewReport): Promise<ReportRow> {
	const row = await db
		.prepare(
			`INSERT INTO report (
				reporter_player_id, reported_player_id, report_category, details,
				height_reporter, height_reported, room_id, room_instance_type, created_at,
				event_id, invention_id, custom_avatar_item_id
			 ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12)
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
			new Date().toISOString(),
			input.eventId ?? null,
			input.inventionId ?? null,
			input.customAvatarItemId ?? null
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
 * Whether a player is banned right now. The hot-path form of `getActiveBan`, for a caller
 * that has nothing to say about WHICH report did it. `moderationBlockDetails` is the
 * caller that does, and reads `getActiveBan` itself.
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
