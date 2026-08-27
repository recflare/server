/**
 * Player reputation — the cheer counters on a profile — and the daily cheer credit that
 * pays for handing one out, on the shared `recflare` D1 database.
 *
 * Two tables, because they answer two different questions:
 *
 * - `reputation` is what a player has RECEIVED: one counter per cheer category, plus the
 *   assorted profile numbers the DTO carries. One row per account, created the first time
 *   somebody cheers them — a missing row means "nobody has cheered them yet", which is
 *   exactly the all-zero default the reputation endpoints already served, so reads fall
 *   back to it rather than inserting on a GET.
 * - `player_cheer` is what a player has left to GIVE: a credit that refills to
 *   {@link DAILY_CHEER_CREDIT} once the window in `created` is a day old. One row per
 *   account, created the first time they spend one.
 *
 * One of the client's fields is deliberately NOT a column. `CheerCredit` sits alongside
 * the counters in the client's record but is `player_cheer.cheers_left` with the rollover
 * applied — storing it twice would let the number a player reads drift from the one the
 * spend checks. `SelectedCheer` (the cheer pinned to the profile, set by
 * `POST /api/PlayerCheer/v1/SetSelectedCheer`) and `IsCheerful` (a profile flag every
 * reference serves as true) ARE columns, added in 0014 — the `ReputationUpdate` frame is
 * the record trimmed, nothing more, so both come off the row.
 *
 * The `api` worker owns the schema/migrations (migrations/0013_reputation.sql and
 * 0014_reputation_selected_cheer.sql, applied under its own `migrations_table` so they
 * don't clash with the other workers' migrations that share the database).
 */

/** Schema DDL (mirror of migrations/0013_reputation.sql + 0014, folded into one CREATE). */
export const SCHEMA_DDL: string[] = [
	`CREATE TABLE IF NOT EXISTS reputation (
		account_id INTEGER PRIMARY KEY,
		noteriety INTEGER NOT NULL DEFAULT 0,
		cheer_general INTEGER NOT NULL DEFAULT 0,
		cheer_helpful INTEGER NOT NULL DEFAULT 0,
		cheer_creative INTEGER NOT NULL DEFAULT 0,
		cheer_great_host INTEGER NOT NULL DEFAULT 0,
		cheer_sportsman INTEGER NOT NULL DEFAULT 0,
		subscriber_count INTEGER NOT NULL DEFAULT 0,
		subscribed_count INTEGER NOT NULL DEFAULT 0,
		is_cheerful INTEGER NOT NULL DEFAULT 1,
		selected_cheer INTEGER NOT NULL DEFAULT 0
	)`,
	`CREATE TABLE IF NOT EXISTS player_cheer (
		player_id INTEGER PRIMARY KEY,
		cheers_left INTEGER NOT NULL,
		created TEXT NOT NULL
	)`,
]

/**
 * The cheer categories the client posts as `CheerCategory`. The gaps are the client's —
 * the enum steps by ten, so it can grow without renumbering.
 */
export enum CheerCategory {
	None = -1,
	General = 0,
	Helpful = 10,
	Sportmanship = 20,
	GreatHost = 30,
	Creative = 40,
}

/**
 * The `reputation` column each category counts into. Doubles as the whitelist the spend
 * interpolates into its SQL: a category that isn't a key here never reaches the query.
 * `None` is absent deliberately — it is the client's "no category", not a counter.
 */
const CHEER_COLUMN: Partial<Record<CheerCategory, string>> = {
	[CheerCategory.General]: 'cheer_general',
	[CheerCategory.Helpful]: 'cheer_helpful',
	[CheerCategory.Sportmanship]: 'cheer_sportsman',
	[CheerCategory.GreatHost]: 'cheer_great_host',
	[CheerCategory.Creative]: 'cheer_creative',
}

/** Whether `value` names a category that counts — i.e. anything but `None`. */
export function isCheerCategory(value: number): value is CheerCategory {
	return value in CHEER_COLUMN
}

/** How many cheers a player may hand out per window. */
export const DAILY_CHEER_CREDIT = 20

/** How long a credit window lasts before it refills. */
export const CHEER_WINDOW_MS = 24 * 60 * 60 * 1000

/** A stored reputation row (snake_case columns, one row per account). */
interface ReputationRow {
	account_id: number
	noteriety: number
	cheer_general: number
	cheer_helpful: number
	cheer_creative: number
	cheer_great_host: number
	cheer_sportsman: number
	subscriber_count: number
	subscribed_count: number
	/** SQLite boolean: 0 / 1. */
	is_cheerful: number
	selected_cheer: number
}

/**
 * A player's reputation as the client's DTO renders it — and, trimmed, as the
 * `ReputationUpdate` frame carries it.
 *
 * `Noteriety` (the reference's spelling), `SubscriberCount` and `SubscribedCount` are
 * columns nothing writes yet. `IsCheerful` is a column nothing writes either, defaulted
 * true like every reference serves it. `SelectedCheer` is the pinned cheer, 0 = none.
 */
export interface Reputation {
	AccountId: number
	IsCheerful: boolean
	Noteriety: number
	SelectedCheer: number
	CheerCredit: number
	CheerGeneral: number
	CheerHelpful: number
	CheerCreative: number
	CheerGreatHost: number
	CheerSportsman: number
	SubscriberCount: number
	SubscribedCount: number
}

/**
 * What a player with no row has: nobody has cheered them, and they hold their full credit.
 * `credit` is passed in rather than defaulted because a player can have spent cheers
 * without having received any — the two tables are independent.
 */
export function defaultReputation(accountId: number, credit = DAILY_CHEER_CREDIT): Reputation {
	return {
		AccountId: accountId,
		IsCheerful: true,
		Noteriety: 0,
		SelectedCheer: 0,
		CheerCredit: credit,
		CheerGeneral: 0,
		CheerHelpful: 0,
		CheerCreative: 0,
		CheerGreatHost: 0,
		CheerSportsman: 0,
		SubscriberCount: 0,
		SubscribedCount: 0,
	}
}

/** Project a stored row onto the DTO, with the credit read from `player_cheer`. */
function toReputation(row: ReputationRow, credit: number): Reputation {
	return {
		AccountId: row.account_id,
		IsCheerful: row.is_cheerful !== 0,
		Noteriety: row.noteriety,
		SelectedCheer: row.selected_cheer,
		CheerCredit: credit,
		CheerGeneral: row.cheer_general,
		CheerHelpful: row.cheer_helpful,
		CheerCreative: row.cheer_creative,
		CheerGreatHost: row.cheer_great_host,
		CheerSportsman: row.cheer_sportsman,
		SubscriberCount: row.subscriber_count,
		SubscribedCount: row.subscribed_count,
	}
}

/**
 * The instant a credit window has to have started AFTER for the stored `cheers_left` to
 * still apply. Anything at or before it has rolled over. ISO-8601 UTC is fixed-width, so
 * SQLite's string comparison orders these correctly — no date functions needed.
 */
function windowCutoff(now: Date): string {
	return new Date(now.getTime() - CHEER_WINDOW_MS).toISOString()
}

/**
 * How many cheers each of `playerIds` has left to give, in the order asked — a read, so
 * a window that has rolled over reads as a full credit WITHOUT writing the reset back.
 * The reset is the spend's job; doing it here would refill a player's credit every time
 * somebody looked at their profile.
 */
export async function getCheerCredits(
	db: D1Database,
	playerIds: number[],
	now: Date = new Date()
): Promise<Map<number, number>> {
	const credits = new Map<number, number>()
	if (playerIds.length === 0) return credits
	const placeholders = playerIds.map((_, i) => `?${i + 2}`).join(', ')
	const { results } = await db
		.prepare(
			`SELECT player_id, cheers_left FROM player_cheer
			 WHERE created > ?1 AND player_id IN (${placeholders})`
		)
		.bind(windowCutoff(now), ...playerIds)
		.all<{ player_id: number; cheers_left: number }>()
	for (const row of results) credits.set(row.player_id, row.cheers_left)
	return credits
}

/** One player's remaining cheer credit (see {@link getCheerCredits} — also a pure read). */
export async function getCheerCredit(
	db: D1Database,
	playerId: number,
	now: Date = new Date()
): Promise<number> {
	const credits = await getCheerCredits(db, [playerId], now)
	return credits.get(playerId) ?? DAILY_CHEER_CREDIT
}

/**
 * Reputations for a list of ids, in the order asked and one per id — the bulk lookups
 * render a profile card per entry, so an id with no row still gets its default rather
 * than being dropped from the list.
 */
export async function getReputations(
	db: D1Database,
	accountIds: number[],
	now: Date = new Date()
): Promise<Reputation[]> {
	if (accountIds.length === 0) return []
	const placeholders = accountIds.map((_, i) => `?${i + 1}`).join(', ')
	const [{ results }, credits] = await Promise.all([
		db
			.prepare(`SELECT * FROM reputation WHERE account_id IN (${placeholders})`)
			.bind(...accountIds)
			.all<ReputationRow>(),
		getCheerCredits(db, accountIds, now),
	])
	const stored = new Map(results.map((r) => [r.account_id, r]))
	return accountIds.map((id) => {
		const credit = credits.get(id) ?? DAILY_CHEER_CREDIT
		const row = stored.get(id)
		return row === undefined ? defaultReputation(id, credit) : toReputation(row, credit)
	})
}

/** One player's reputation, defaulted when nobody has cheered them yet. */
export async function getReputation(
	db: D1Database,
	accountId: number,
	now: Date = new Date()
): Promise<Reputation> {
	const [reputation] = await getReputations(db, [accountId], now)
	return reputation!
}

/**
 * Take one cheer out of a player's daily credit, resolving the credit they have left, or
 * null when they had none to spend.
 *
 * One statement, so two cheers fired off together can't both read the same stale credit
 * and write it back — the client lets a player cheer several people in a row. The three
 * cases fold into the upsert:
 *
 * - no row: insert one at `DAILY_CHEER_CREDIT - 1`, window starting now;
 * - the window rolled over (`created` at or before the cutoff): reset to
 *   `DAILY_CHEER_CREDIT - 1` and start a fresh window, which is what makes the credit
 *   refill lazily rather than needing a cron;
 * - the window is live: decrement, keeping the window's original start so a player who
 *   spends all day still refills 24h after their FIRST cheer, not their last.
 *
 * The `WHERE` on the update is the refusal: a live window with nothing left updates no
 * row, so `RETURNING` yields nothing and the caller answers "out of cheers".
 */
export async function spendCheerCredit(
	db: D1Database,
	playerId: number,
	now: Date = new Date()
): Promise<number | null> {
	const cutoff = windowCutoff(now)
	const row = await db
		.prepare(
			`INSERT INTO player_cheer (player_id, cheers_left, created) VALUES (?1, ?2, ?3)
			 ON CONFLICT (player_id) DO UPDATE SET
				cheers_left = CASE WHEN player_cheer.created <= ?4
					THEN ?2 ELSE player_cheer.cheers_left - 1 END,
				created = CASE WHEN player_cheer.created <= ?4
					THEN ?3 ELSE player_cheer.created END
			 WHERE player_cheer.created <= ?4 OR player_cheer.cheers_left > 0
			 RETURNING cheers_left`
		)
		.bind(playerId, DAILY_CHEER_CREDIT - 1, now.toISOString(), cutoff)
		.first<{ cheers_left: number }>()
	return row === null ? null : row.cheers_left
}

/**
 * Count a received cheer against `accountId`'s category counter, returning the reputation
 * they now hold. Creates the row on the first cheer they ever receive.
 *
 * The column is looked up in {@link CHEER_COLUMN} rather than built from the category, so
 * only the five known names can reach the SQL; an unknown category is rejected by the
 * route before it gets here.
 */
export async function addCheer(
	db: D1Database,
	accountId: number,
	category: CheerCategory,
	now: Date = new Date()
): Promise<Reputation> {
	const column = CHEER_COLUMN[category]
	if (column === undefined) throw new Error(`unknown cheer category ${category}`)
	const [row, credit] = await Promise.all([
		db
			.prepare(
				`INSERT INTO reputation (account_id, ${column}) VALUES (?1, 1)
				 ON CONFLICT (account_id) DO UPDATE SET ${column} = reputation.${column} + 1
				 RETURNING *`
			)
			.bind(accountId)
			.first<ReputationRow>(),
		getCheerCredit(db, accountId, now),
	])
	// RETURNING always yields the upserted row; the non-null assert keeps the caller from
	// having to handle an impossible null.
	return toReputation(row!, credit)
}

/**
 * Pin `category` as `accountId`'s selected cheer — the badge the client shows on their
 * profile — returning the reputation they now hold. `None` (-1) unpins it, stored as 0 the
 * way the DTO reads "nothing selected". Creates the row if nobody has cheered them yet:
 * a player can pin a badge before ever receiving a cheer.
 */
export async function setSelectedCheer(
	db: D1Database,
	accountId: number,
	category: CheerCategory,
	now: Date = new Date()
): Promise<Reputation> {
	const selected = category === CheerCategory.None ? 0 : category
	const [row, credit] = await Promise.all([
		db
			.prepare(
				`INSERT INTO reputation (account_id, selected_cheer) VALUES (?1, ?2)
				 ON CONFLICT (account_id) DO UPDATE SET selected_cheer = ?2
				 RETURNING *`
			)
			.bind(accountId, selected)
			.first<ReputationRow>(),
		getCheerCredit(db, accountId, now),
	])
	return toReputation(row!, credit)
}
