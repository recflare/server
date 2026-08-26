/**
 * A room's leaderboard on the shared `recflare` D1 database: how many wins each player has
 * in each room.
 *
 * One table, one row per (player, room), created the first time a player posts a stat for
 * the room via `POST /leaderboard/CheckAndSetStat`. A player with no row is not on that
 * room's board: the reads answer that as an empty slice or {@link UNRANKED} rather than
 * inserting on a read.
 *
 * `wins` is what the client posts as `StatValue`. The client's `StatChannel` is NOT stored —
 * this server keeps one board per room, and every channel writes to and reads from it.
 *
 * Ranks are 1-based and total: the board is ordered by `wins` (highest first unless the
 * client asks for ascending) with ties broken on the lower `player_id`, so two players with
 * the same score never share a rank and a rank is stable between two reads.
 *
 * The `leaderboard` worker owns the schema/migrations (migrations/0001_leaderboard.sql,
 * applied under its own `migrations_table` so they don't clash with the other workers'
 * migrations that share the database).
 */

/** Schema DDL (mirror of migrations/0001_leaderboard.sql). */
export const SCHEMA_DDL: string[] = [
	`CREATE TABLE IF NOT EXISTS leaderboard (
		player_id INTEGER NOT NULL,
		room_id INTEGER NOT NULL,
		wins INTEGER NOT NULL DEFAULT 0,
		PRIMARY KEY (player_id, room_id)
	)`,
	`CREATE INDEX IF NOT EXISTS leaderboard_room_wins ON leaderboard (room_id, wins DESC, player_id)`,
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
	wins: number
}

/** The ORDER BY for a board. Ties break on the lower player id either way. */
function order(sortAscending: boolean): string {
	return sortAscending ? 'wins ASC, player_id ASC' : 'wins DESC, player_id ASC'
}

/**
 * A page of a room's board: ranks `rankStart`..`rankEnd`, both 1-based and inclusive.
 * A `rankStart` below 1 is clamped to the top; an empty or inverted range is an empty page.
 */
export async function getRanks(
	db: D1Database,
	roomId: number,
	rankStart: number,
	rankEnd: number,
	sortAscending: boolean
): Promise<LeaderboardEntry[]> {
	const start = Math.max(1, rankStart)
	const limit = rankEnd - start + 1
	if (limit <= 0) return []
	const { results } = await db
		.prepare(
			`SELECT player_id, wins FROM leaderboard WHERE room_id = ?1
			 ORDER BY ${order(sortAscending)} LIMIT ?2 OFFSET ?3`
		)
		.bind(roomId, limit, start - 1)
		.all<LeaderboardRow>()
	return results.map((r, i) => ({ PlayerId: r.player_id, Score: r.wins, Rank: start + i }))
}

/**
 * One player's standing on a room's board: their score and 1-based rank, or
 * {@link UNRANKED} with {@link NO_SCORE} when they have no row there.
 *
 * The rank is one more than the count of players placed ahead — a higher score, or the
 * same score and a lower id — so it matches the position {@link getRanks} would give.
 */
export async function getPlayerRank(
	db: D1Database,
	roomId: number,
	playerId: number,
	sortAscending: boolean
): Promise<LeaderboardEntry> {
	const ahead = sortAscending
		? '(wins < ?3 OR (wins = ?3 AND player_id < ?2))'
		: '(wins > ?3 OR (wins = ?3 AND player_id < ?2))'
	const mine = await db
		.prepare('SELECT wins FROM leaderboard WHERE room_id = ?1 AND player_id = ?2')
		.bind(roomId, playerId)
		.first<{ wins: number }>()
	if (!mine) return { PlayerId: playerId, Score: NO_SCORE, Rank: UNRANKED }
	const count = await db
		.prepare(`SELECT COUNT(*) AS n FROM leaderboard WHERE room_id = ?1 AND ${ahead}`)
		.bind(roomId, playerId, mine.wins)
		.first<{ n: number }>()
	return { PlayerId: playerId, Score: mine.wins, Rank: (count?.n ?? 0) + 1 }
}

/**
 * The rows around one player on a room's board: `windowSize` entries on either side of
 * their rank, clamped to the board. A player who isn't on the board gets the top of it —
 * a full window's worth — so the screen still draws something.
 */
export async function getNearbyScores(
	db: D1Database,
	roomId: number,
	playerId: number,
	windowSize: number,
	sortAscending: boolean
): Promise<LeaderboardEntry[]> {
	const window = Math.min(Math.max(windowSize, 1), 50)
	const mine = await getPlayerRank(db, roomId, playerId, sortAscending)
	if (mine.Rank === UNRANKED) return getRanks(db, roomId, 1, window * 2 + 1, sortAscending)
	return getRanks(db, roomId, mine.Rank - window, mine.Rank + window, sortAscending)
}

/**
 * A compare-and-set of one player's wins in one room, the write behind
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
	roomId: number,
	playerId: number,
	value: number,
	expected: number | null
): Promise<boolean> {
	const result = await db
		.prepare(
			`INSERT INTO leaderboard (player_id, room_id, wins) VALUES (?1, ?2, ?3)
			 ON CONFLICT (player_id, room_id) DO UPDATE SET wins = excluded.wins
			 WHERE ?4 IS NULL OR wins = ?4`
		)
		.bind(playerId, roomId, value, expected)
		.run()
	return (result.meta.changes ?? 0) > 0
}
