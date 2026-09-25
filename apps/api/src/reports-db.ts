/**
 * Player-report storage on the shared `recflare` D1 database.
 *
 * Like the relationship table (and unlike the JSON-blob tables here — rooms /
 * accounts / image / invention), a report is genuinely columnar, so it gets a
 * normal relational table. Rows are append-only in the sense that nothing rewrites
 * what a player submitted: the table is a log of exactly what was reported.
 *
 * The `api` worker owns this schema/migration (migrations/0004_report.sql,
 * 0009_report_ban.sql, 0011_report_event.sql, 0016_report_invention.sql,
 * 0017_report_custom_avatar_item.sql, 0020_report_ban_audit.sql and
 * 0025_report_chat_message.sql, applied under its own `migrations_table` so it doesn't clash
 * with the other workers' migrations that share the database).
 *
 * The moderation-side READS here — `searchReports`, `getTopReported`, `getBansInForce` —
 * are not called by any endpoint on this worker. They back the staff panel served by
 * `www` (`/api/staff/*`), which imports them: the endpoints are a recflare addition with
 * no counterpart in the real service, and those live on `www` rather than on the workers
 * that reimplement the game's own API. The SQL stays here, with the table that owns it.
 *
 * A reported player EVENT, INVENTION or CUSTOM AVATAR ITEM lands here too, rather than in a
 * table of its own: same fields, same moderation life. Such a row carries `event_id`,
 * `invention_id` or `custom_avatar_item_id`, and its `reported_player_id` is that thing's
 * CREATOR — see `POST /api/playerevents/v1/report`, `POST /api/inventions/v1/report` and
 * `POST /api/customAvatarItems/v1/{id}/report`. A reported CHAT MESSAGE is the fourth kind:
 * `chat_message_id`, with the message's SENDER as the reported player — see
 * `POST /api/chatreport/createChatReport`. The four id columns are mutually exclusive; a row
 * with none of them is an ordinary player report. They are separate columns rather than one
 * polymorphic id because the keys differ in TYPE (numbers and a guid) and in what they key.
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
 * 0011_report_event.sql + 0016_report_invention.sql + 0017_report_custom_avatar_item.sql +
 * 0020_report_ban_audit.sql + 0025_report_chat_message.sql + 0029_report_ban_lifted.sql).
 *
 * None of `event_id`, `invention_id`, `custom_avatar_item_id` or `chat_message_id` is
 * indexed: each is written on every report of its kind and read by nothing — no query here filters on any of them,
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
		custom_avatar_item_id TEXT,
		banned_by_player_id INTEGER,
		banned_at TEXT,
		chat_message_id INTEGER,
		unbanned_by_player_id INTEGER,
		unbanned_at TEXT
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
	/**
	 * The moderator who set `banned` on this row, or NULL when nobody has (and cleared
	 * again when a ban is lifted). Read per-row by the staff panel; nothing filters on it.
	 */
	banned_by_player_id: number | null
	/**
	 * ISO-8601 UTC instant the ban was HANDED DOWN — distinct from `created_at`, which is
	 * when the report was filed, and the two can be months apart. This is what the client's
	 * block screen counts the ban from (see `banBlockDetails`); rows written before
	 * 0020_report_ban_audit.sql carry NULL and fall back to `created_at`.
	 */
	banned_at: string | null
	/**
	 * The chat message this report is against, or NULL for any other kind — mutually
	 * exclusive with `event_id`, `invention_id` and `custom_avatar_item_id`. See
	 * `POST /api/chatreport/createChatReport`: `reported_player_id` is the message's SENDER,
	 * read from the `message` table, because the body names no player. The thread the client
	 * also posts is not kept — a message id is unique across threads, so it is the whole
	 * reference.
	 */
	chat_message_id: number | null
	/**
	 * The moderator who LIFTED the ban that once stood on this row, or NULL when none has
	 * been lifted — including while one stands: a re-ban clears it, with `unbanned_at`. A
	 * lift wipes the four ban columns above, so without this pair a lifted ban is
	 * indistinguishable from a report nobody acted on, and the staff panel offered to ban
	 * again. Read per row by the panel; nothing filters on it.
	 */
	unbanned_by_player_id: number | null
	/** ISO-8601 UTC instant the ban was lifted; NULL with `unbanned_by_player_id`. */
	unbanned_at: string | null
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
	/** Set only when reporting a CHAT MESSAGE; never set alongside the three above. */
	chatMessageId?: number | null
}

/** Record a submitted report, returning the stored row (with its assigned id). */
export async function createReport(db: D1Database, input: NewReport): Promise<ReportRow> {
	const row = await db
		.prepare(
			`INSERT INTO report (
				reporter_player_id, reported_player_id, report_category, details,
				height_reporter, height_reported, room_id, room_instance_type, created_at,
				event_id, invention_id, custom_avatar_item_id, chat_message_id
			 ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13)
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
			input.customAvatarItemId ?? null,
			input.chatMessageId ?? null
		)
		.first<ReportRow>()
	// RETURNING always yields the inserted row; the non-null assert keeps the caller
	// from having to handle an impossible null.
	return row!
}

/**
 * Every report filed against a player, newest first — unpaged, because it is the whole
 * history a moderator reads on one account (`www`: `GET /api/staff/players/:id`), not a
 * feed. `searchReports` is the paged, filtered form for looking across accounts.
 */
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
 * `bannedBy` is the acting moderator, and is recorded alongside `banned_at` — the instant
 * the ban was handed down, which is NOT the report's `created_at` and is what the client's
 * block screen counts from. A lift clears all four columns together: an unbanned row must
 * not keep an audit trail saying a ban runs from somewhere, and `banned = 0` with a
 * `banned_at` still set would read as a ban to anything checking the timestamp.
 *
 * A lift instead SIGNS `unbanned_by_player_id`/`unbanned_at` with the same `bannedBy` and
 * the same instant, and a re-ban clears those two — a standing ban has not been lifted.
 * That is what lets the staff panel tell "a colleague let this player back in" from
 * "nobody has acted on this report", so a second moderator doesn't undo the first.
 *
 * Returns the updated row, or null when there is no report with that id — so the caller
 * can tell "banned" from "banned nobody" (wrangler's `d1 execute --json` reports no
 * changes count, hence RETURNING).
 */
export async function banFromReport(
	db: D1Database,
	reportId: number,
	options: { banned?: boolean; banExpires?: string | null; bannedBy?: number | null } = {}
): Promise<ReportRow | null> {
	const banned = options.banned ?? true
	const now = new Date().toISOString()
	return db
		.prepare(
			`UPDATE report
			 SET banned = ?2, ban_expires = ?3, banned_by_player_id = ?4, banned_at = ?5,
			     unbanned_by_player_id = ?6, unbanned_at = ?7
			 WHERE id = ?1
			 RETURNING *`
		)
		.bind(
			reportId,
			banned ? 1 : 0,
			banned ? (options.banExpires ?? null) : null,
			banned ? (options.bannedBy ?? null) : null,
			banned ? now : null,
			banned ? null : (options.bannedBy ?? null),
			banned ? null : now
		)
		.first<ReportRow>()
}

/**
 * A page of reports matching a moderator's filters — the staff panel's search
 * (`www`: `GET /api/staff/reports`).
 *
 * Every filter is optional and ANDed; an empty filter set is the whole table, newest
 * first. `ORDER BY id DESC` rather than by `created_at`: the id is AUTOINCREMENT, so it is
 * already chronological, and it is the primary key — ordering by the timestamp column,
 * which is unindexed, would sort the whole result set. The date window is applied to
 * `created_at` (an ISO-8601 string, so a lexical comparison IS a chronological one) and
 * `to` is EXCLUSIVE, which is what makes a day-boundary window composable.
 *
 * `banned` filters on the FLAG, not on whether a ban is in force: a moderator reviewing
 * what has been actioned wants the expired ones too (`getBansInForce` is the other
 * question). The count is a second statement rather than a window function, so the caller
 * can page without re-deriving the total — it counts the same predicate, unpaged.
 */
export interface ReportSearch {
	reportedPlayerId?: number | null
	reporterPlayerId?: number | null
	reportCategory?: number | null
	/** true = banned rows only, false = unbanned only, null/undefined = both. */
	banned?: boolean | null
	/** ISO-8601; inclusive lower bound on `created_at`. */
	from?: string | null
	/** ISO-8601; EXCLUSIVE upper bound on `created_at`. */
	to?: string | null
}

/** A page of search results, plus how many rows the filters match in total. */
export interface ReportPage {
	reports: ReportRow[]
	total: number
}

export async function searchReports(
	db: D1Database,
	filters: ReportSearch = {},
	page: { skip?: number; take?: number } = {}
): Promise<ReportPage> {
	// Built as a parallel list of clauses and binds so a filter is added in one place and
	// can't drift between the page query and the count query, which share both.
	const clauses: string[] = []
	const binds: Array<number | string> = []
	const where = (sql: string, value: number | string) => {
		binds.push(value)
		clauses.push(sql.replace('?', `?${binds.length}`))
	}

	if (filters.reportedPlayerId != null) where('reported_player_id = ?', filters.reportedPlayerId)
	if (filters.reporterPlayerId != null) where('reporter_player_id = ?', filters.reporterPlayerId)
	if (filters.reportCategory != null) where('report_category = ?', filters.reportCategory)
	if (filters.banned != null) where('banned = ?', filters.banned ? 1 : 0)
	if (filters.from) where('created_at >= ?', filters.from)
	if (filters.to) where('created_at < ?', filters.to)

	const predicate = clauses.length === 0 ? '' : ` WHERE ${clauses.join(' AND ')}`
	// Clamped rather than trusted: `take` reaches this from a query string, and an
	// unbounded one would hand a moderator's browser the entire table.
	const take = Math.min(Math.max(page.take ?? 50, 1), 200)
	const skip = Math.max(page.skip ?? 0, 0)

	const [rows, count] = await db.batch<ReportRow | { total: number }>([
		db
			.prepare(
				`SELECT * FROM report${predicate} ORDER BY id DESC LIMIT ?${binds.length + 1} OFFSET ?${binds.length + 2}`
			)
			.bind(...binds, take, skip),
		db.prepare(`SELECT COUNT(*) AS total FROM report${predicate}`).bind(...binds),
	])

	return {
		reports: rows.results as ReportRow[],
		total: (count.results as Array<{ total: number }>)[0]?.total ?? 0,
	}
}

/** One report by id, or null. The detail behind a search row. */
export async function getReportById(db: D1Database, reportId: number): Promise<ReportRow | null> {
	return db.prepare('SELECT * FROM report WHERE id = ?1').bind(reportId).first<ReportRow>()
}

/** A player who has collected reports, as the staff panel's triage list shows them. */
export interface ReportedPlayerTally {
	playerId: number
	/** Reports filed against them inside the window. */
	reports: number
	/**
	 * How many DIFFERENT accounts filed those reports. The number that actually means
	 * something: one player filing forty reports against someone they are feuding with
	 * should not outrank four unconnected players filing one each.
	 */
	distinctReporters: number
	/** `created_at` of the most recent report in the window. */
	lastReportAt: string
	/** Whether a ban is in force against them right now — so the list can skip the done ones. */
	bannedNow: boolean
}

/**
 * The players with the most reports against them — the staff panel's triage list
 * (`www`: `GET /api/staff/reports/top-reported`).
 *
 * WINDOWED by default (30 days), because the unwindowed version ossifies: an account that
 * collected reports a year ago and stopped would sit at the top forever, above whoever is
 * a problem this week. Pass `sinceDays: null` for all time.
 *
 * Ranked by distinct reporters FIRST and raw count second, for the reason
 * `distinctReporters` exists at all. `minReports` keeps the long tail of single reports
 * out — almost every report is a one-off, and a list of them is not a triage list.
 *
 * `GROUP BY reported_player_id` rides `idx_report_reported`. The in-force ban is decided
 * in the same statement (a correlated EXISTS over the partial `idx_report_banned`) rather
 * than with a round trip per player.
 */
export async function getTopReported(
	db: D1Database,
	options: { sinceDays?: number | null; minReports?: number; take?: number; now?: Date } = {}
): Promise<ReportedPlayerTally[]> {
	const now = options.now ?? new Date()
	const sinceDays = options.sinceDays === undefined ? 30 : options.sinceDays
	// An all-time window is expressed as a floor no timestamp can precede, so the SQL keeps
	// one shape rather than growing a second predicate.
	const since =
		sinceDays === null
			? '0000-01-01T00:00:00.000Z'
			: new Date(now.getTime() - sinceDays * 86_400_000).toISOString()
	const minReports = Math.max(options.minReports ?? 3, 1)
	const take = Math.min(Math.max(options.take ?? 50, 1), 200)

	const { results } = await db
		.prepare(
			`SELECT
				r.reported_player_id AS playerId,
				COUNT(*) AS reports,
				COUNT(DISTINCT r.reporter_player_id) AS distinctReporters,
				MAX(r.created_at) AS lastReportAt,
				EXISTS (
					SELECT 1 FROM report b
					WHERE b.reported_player_id = r.reported_player_id AND b.banned = 1
						AND (b.ban_expires IS NULL OR b.ban_expires > ?2)
				) AS bannedNow
			 FROM report r
			 WHERE r.created_at >= ?1
			 GROUP BY r.reported_player_id
			 HAVING COUNT(*) >= ?3
			 ORDER BY distinctReporters DESC, reports DESC, lastReportAt DESC
			 LIMIT ?4`
		)
		.bind(since, now.toISOString(), minReports, take)
		.all<Omit<ReportedPlayerTally, 'bannedNow'> & { bannedNow: number }>()

	return results.map((row) => ({ ...row, bannedNow: row.bannedNow === 1 }))
}

/**
 * Every ban in force right now, MOST RECENTLY HANDED DOWN FIRST — the staff panel's
 * standing-bans list (`www`: `GET /api/staff/bans`).
 *
 * "In force" is `getActiveBan`'s test applied to the whole table rather than to one
 * player: a row whose `ban_expires` has passed has served its time and is not listed,
 * though it stays as the record that it happened. A player with several in force appears
 * once per ban — each is a separate report, and which report justified which ban is the
 * point of the list.
 *
 * Ordered by WHEN THE BAN LANDED because the list's job is catching mistakes: the ban most
 * likely to be wrong is the one just handed down, and a moderator who has slipped goes
 * looking for it at the top. Ordering by severity instead (longest-lasting first, as this
 * did) buries a fresh one-day ban under every permanent ban ever issued — exactly the
 * wrong way round for the one read this list exists to serve.
 *
 * `COALESCE(banned_at, created_at)`: a ban set before 0020_report_ban_audit.sql added
 * `banned_at` has only its report's date to sort by, which is the same fallback the block
 * screen uses. Without the coalesce those rows would sort as NULL — all together at one
 * end, in no order at all.
 */
export async function getBansInForce(
	db: D1Database,
	now: Date = new Date(),
	take = 200
): Promise<ReportRow[]> {
	const { results } = await db
		.prepare(
			`SELECT * FROM report
			 WHERE banned = 1 AND (ban_expires IS NULL OR ban_expires > ?1)
			 ORDER BY COALESCE(banned_at, created_at) DESC, id DESC
			 LIMIT ?2`
		)
		.bind(now.toISOString(), Math.min(Math.max(take, 1), 500))
		.all<ReportRow>()
	return results
}

// ---- Block details ----------------------------------------------------------

/**
 * `Duration` on a permanent ban. The client's field is a 32-bit int of seconds that PAIRS
 * with `TimeoutStartedAt` — start + duration is the end of the block — so a ban with no
 * end gets the largest value the field holds, 68 years past its start.
 */
export const PERMANENT_BAN_DURATION = 2_147_483_647

/**
 * The "not blocked" answer — the reference server's stub `ReturnModerationBlockDetails()`,
 * widened to every key the client's `ModerationBlockDetail` decoder names (16 on the wire;
 * the 2025 build's formatter reads them all). The ones past the stub's nine are the block
 * kinds and screen dressings this server never uses — a device ban, a warning, the
 * vote-kick reason, an associated account, the creator code of conduct, the top/bottom
 * message overrides — so they carry their "none" values on every answer.
 */
export const NOT_BLOCKED = {
	ReportCategory: -1,
	Duration: 0,
	GameSessionId: 0,
	IsHostKick: false,
	Message: null,
	PlayerIdReporter: null,
	IsBan: false,
	IsVoiceModAutoban: false,
	IsDeviceBan: false,
	IsWarning: false,
	VoteKickReason: null,
	TimeoutStartedAt: null,
	AssociatedAccountUsername: null,
	ShowCreatorCodeOfConduct: false,
	TopMessageOverride: null,
	BottomMessageOverride: null,
}

/**
 * The block details for a ban in force — the `report` row a moderator set `banned` on.
 *
 * Shared by the two places a player meets an account ban: `api`'s `moderationBlockDetails`
 * (the screen at sign-in) and `www`'s live `ModerationKick` frame (the screen when the ban is
 * handed down mid-session). Built once here so both screens describe the same ban.
 *
 * `Duration` and `TimeoutStartedAt` are a PAIR in the client: the block runs from the
 * start for the duration. The start is `banned_at`, the instant the ban was handed down
 * (see 0020_report_ban_audit.sql), and the duration is the seconds from there to
 * `ban_expires`, so the two sum to the expiry; or `PERMANENT_BAN_DURATION` when there is
 * none.
 *
 * It falls back to the report's `created_at` for a row banned before that column existed.
 * The two can be months apart, and using `created_at` as the start — which is what this
 * did before there was anything else to use — misreports both halves of the pair: a 7-day
 * ban applied to a 30-day-old report told the player their block began a month ago and
 * ended three weeks ago. Every pre-migration row still reads exactly as it used to, which
 * is the point of the fallback rather than a coalesce to now.
 *
 * The category is the one the report was
 * filed under, so the client's ban screen names the reason. `Message` is a fixed "Rule
 * violation" rather than the report's `details` — those are the REPORTER's words, and the
 * banned player isn't shown them, for the same reason `PlayerIdReporter` stays null: the
 * reporter is not a host who kicked them, and naming them would tell the banned player who
 * reported them. Everything else keeps its `NOT_BLOCKED` value: the other block kinds and
 * screen dressings, none of which this server hands out.
 */
export function banBlockDetails(ban: ReportRow) {
	const startedAtIso = ban.banned_at ?? ban.created_at
	const startedAt = Date.parse(startedAtIso)
	const duration =
		ban.ban_expires === null
			? PERMANENT_BAN_DURATION
			: Math.max(1, Math.ceil((Date.parse(ban.ban_expires) - startedAt) / 1000))
	return {
		...NOT_BLOCKED,
		ReportCategory: ban.report_category,
		Duration: duration,
		IsBan: true,
		Message: 'Rule violation',
		TimeoutStartedAt: startedAtIso,
	}
}
