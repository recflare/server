/**
 * A room's leaderboards on the shared `recflare` D1 database: each player's value on each
 * of a room's stat channels.
 *
 * One table, one row per (player, room, channel), created the first time a player posts a
 * stat for that channel of the room via `POST /leaderboard/CheckAndSetStat`. A player with
 * no row is not on that board: the reads answer that as an empty slice or {@link UNRANKED}
 * rather than inserting on a read.
 *
 * A board is a (room, channel) pair — `stat_channel` is the client's `StatChannel`, which of
 * the room's tracked stats this is, and `stat_value` is what it posts as `StatValue`. What a
 * channel counts (wins, laps, a time) is the room's business; the server only orders on it.
 *
 * Ranks are 1-based and total: the board is ordered by `stat_value` (highest first unless
 * the client asks for ascending) with ties broken on the lower `player_id`, so two players
 * with the same score never share a rank and a rank is stable between two reads.
 *
 * A board can be read through a FRIENDS filter (the client's `FilterType` 1): the same rows
 * restricted to the viewer and the people they are friends with, ranked among themselves —
 * so a player who is 40th globally can be 2nd among friends. Friendship is the `api`
 * worker's `relationship` table on the same database, read here through a subquery rather
 * than an `IN (...)` list so a player with hundreds of friends doesn't hit D1's bind limit.
 *
 * The `leaderboard` worker owns the schema/migrations (migrations/0001_leaderboard.sql,
 * applied under its own `migrations_table` so they don't clash with the other workers'
 * migrations that share the database).
 */

import { RelationshipType } from '@repo/domain'

/** Schema DDL (mirror of migrations/0001_leaderboard.sql). */
export const SCHEMA_DDL: string[] = [
	`CREATE TABLE IF NOT EXISTS leaderboard (
		player_id INTEGER NOT NULL,
		room_id INTEGER NOT NULL,
		stat_channel INTEGER NOT NULL,
		stat_value INTEGER NOT NULL DEFAULT 0,
		PRIMARY KEY (player_id, room_id, stat_channel)
	)`,
	`CREATE INDEX IF NOT EXISTS leaderboard_board_value
		ON leaderboard (room_id, stat_channel, stat_value DESC, player_id)`,
]

/**
 * The rank a player who isn't on the board gets. `Rank` is 1-based: a 0 would render as
 * first place and a negative one may not render at all. A number far past the end of any
 * real board reads as last, which is what an unscored player is, and is recognisable in a
 * log or a screenshot as a sentinel rather than a real standing.
 */
export const UNRANKED = 99999

/** The score behind {@link UNRANKED}: no stat has ever been stored, and 0 is "no score". */
export const NO_SCORE = 0

/**
 * One row of a board as the client renders it — the same three fields `GetPlayerRank`
 * answers, so a row and a standing are the one shape.
 */
export interface LeaderboardEntry {
	PlayerId: number
	Score: number
	Rank: number
}

interface LeaderboardRow {
	player_id: number
	stat_value: number
}

/** Which board: one of a room's stat channels, optionally seen through one player's friends. */
export interface Board {
	roomId: number
	statChannel: number
	/** When set, only this player and their friends are on the board. */
	friendsOf?: number
}

/**
 * The WHERE clause selecting a board's rows, with the room and channel bound as `?1`/`?2`
 * and, for a friends board, the viewer as `?3`. Callers number any further parameters from
 * {@link Scope.next}.
 */
interface Scope {
	where: string
	binds: number[]
	next: number
}

function scope(board: Board): Scope {
	if (board.friendsOf === undefined) {
		return {
			where: 'room_id = ?1 AND stat_channel = ?2',
			binds: [board.roomId, board.statChannel],
			next: 3,
		}
	}
	return {
		where: `room_id = ?1 AND stat_channel = ?2 AND (player_id = ?3 OR player_id IN (
			SELECT CASE WHEN requester_id = ?3 THEN target_id ELSE requester_id END
			FROM relationship
			WHERE relationship_type = ${RelationshipType.Friend} AND (requester_id = ?3 OR target_id = ?3)
		))`,
		binds: [board.roomId, board.statChannel, board.friendsOf],
		next: 4,
	}
}

/** The ORDER BY for a board. Ties break on the lower player id either way. */
function order(sortAscending: boolean): string {
	return sortAscending ? 'stat_value ASC, player_id ASC' : 'stat_value DESC, player_id ASC'
}

/**
 * A page of a board: ranks `rankStart`..`rankEnd`, both 1-based and inclusive.
 * A `rankStart` below 1 is clamped to the top; an empty or inverted range is an empty page.
 */
export async function getRanks(
	db: D1Database,
	board: Board,
	rankStart: number,
	rankEnd: number,
	sortAscending: boolean
): Promise<LeaderboardEntry[]> {
	const start = Math.max(1, rankStart)
	const limit = rankEnd - start + 1
	if (limit <= 0) return []
	const s = scope(board)
	const { results } = await db
		.prepare(
			`SELECT player_id, stat_value FROM leaderboard WHERE ${s.where}
			 ORDER BY ${order(sortAscending)} LIMIT ?${s.next} OFFSET ?${s.next + 1}`
		)
		.bind(...s.binds, limit, start - 1)
		.all<LeaderboardRow>()
	return results.map((r, i) => ({ PlayerId: r.player_id, Score: r.stat_value, Rank: start + i }))
}

/**
 * One player's standing on a board: their score and 1-based rank, or
 * {@link UNRANKED} with {@link NO_SCORE} when they have no row there.
 *
 * The rank is one more than the count of players placed ahead — a higher score, or the
 * same score and a lower id — so it matches the position {@link getRanks} would give.
 */
export async function getPlayerRank(
	db: D1Database,
	board: Board,
	playerId: number,
	sortAscending: boolean
): Promise<LeaderboardEntry> {
	const s = scope(board)
	const mine = await db
		.prepare(`SELECT stat_value FROM leaderboard WHERE ${s.where} AND player_id = ?${s.next}`)
		.bind(...s.binds, playerId)
		.first<{ stat_value: number }>()
	if (!mine) return { PlayerId: playerId, Score: NO_SCORE, Rank: UNRANKED }
	const [pid, val] = [s.next, s.next + 1]
	const ahead = sortAscending
		? `(stat_value < ?${val} OR (stat_value = ?${val} AND player_id < ?${pid}))`
		: `(stat_value > ?${val} OR (stat_value = ?${val} AND player_id < ?${pid}))`
	const count = await db
		.prepare(`SELECT COUNT(*) AS n FROM leaderboard WHERE ${s.where} AND ${ahead}`)
		.bind(...s.binds, playerId, mine.stat_value)
		.first<{ n: number }>()
	return { PlayerId: playerId, Score: mine.stat_value, Rank: (count?.n ?? 0) + 1 }
}

/** The most rows either side of a player `GetNearbyScores` will serve, whatever it asks. */
export const MAX_WINDOW = 10

/**
 * The rows around one player on a board: `windowSize` entries on either side of their
 * rank (at most {@link MAX_WINDOW}), clamped to the board. A player who isn't on the board
 * gets the top of it — a full window's worth — so the screen still draws something.
 */
export async function getNearbyScores(
	db: D1Database,
	board: Board,
	playerId: number,
	windowSize: number,
	sortAscending: boolean
): Promise<LeaderboardEntry[]> {
	const window = Math.min(Math.max(windowSize, 1), MAX_WINDOW)
	const mine = await getPlayerRank(db, board, playerId, sortAscending)
	if (mine.Rank === UNRANKED) return getRanks(db, board, 1, window * 2 + 1, sortAscending)
	return getRanks(db, board, mine.Rank - window, mine.Rank + window, sortAscending)
}

/**
 * A compare-and-set of one player's value on one board, the write behind
 * `POST /leaderboard/CheckAndSetStat`.
 *
 * `expected` is what the client believes is stored: with a number, the row is written only
 * if it still holds that value, which is how a stale client is kept from walking a board
 * backwards; with null the client believes nothing is stored, and the value is written
 * regardless — a row that exists is overwritten rather than the write being refused, since
 * the client's belief about a fresh room is the one it can't have checked.
 *
 * Returns whether the write landed.
 */
export async function checkAndSetStat(
	db: D1Database,
	board: Board,
	playerId: number,
	value: number,
	expected: number | null
): Promise<boolean> {
	const result = await db
		.prepare(
			`INSERT INTO leaderboard (player_id, room_id, stat_channel, stat_value)
			 VALUES (?1, ?2, ?3, ?4)
			 ON CONFLICT (player_id, room_id, stat_channel) DO UPDATE SET stat_value = excluded.stat_value
			 WHERE ?5 IS NULL OR stat_value = ?5`
		)
		.bind(playerId, board.roomId, board.statChannel, value, expected)
		.run()
	return (result.meta.changes ?? 0) > 0
}
