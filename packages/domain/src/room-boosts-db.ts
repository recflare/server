/**
 * Room boosts (2026 client). A player spends a *Room Boost* consumable in a room — the client's
 * Boost button posts econ's `POST /api/consumables/v1/consume` once per unit, with that room's
 * `RoomId` and a fresh GUID `RequestId` each — and the room carries the boost for
 * {@link ROOM_BOOST_ACTIVE_DAYS} days. The client only ever READS counts: the room's active
 * count (room cards, the room panel, `BoostCount` on the room DTO) and each player's active count
 * in the room (the "is boosting" badge on nametags), through the `rooms` routes
 * `GET /rooms/{id}/boosts/count`, `GET /rooms/{id}/boosts/{accountId}/count` and
 * `POST /rooms/{id}/boosts/counts`, plus the `RoomBoosted` / `RoomBoostCountUpdated` frames.
 *
 * One `room_boost` row per boost request. The `rooms` worker owns the table
 * (migrations/0035_room_boost.sql); `econ` writes it when a boost is consumed. Rows are never
 * deleted by expiry: "active" is computed from `created_at`.
 */

/** The Room Boost consumable's `ConsumableItemDesc` (store item 32322, `RoomBoostHelper.PurchasableBundleId`). */
export const ROOM_BOOST_DESC = 'wH7shWdU0E6xpw0d60ZdtA'

/**
 * How long a boost stays active. The client calls its counts "active"
 * (`GetActiveRoomBoostCount`), so boosts expire, but the duration is in neither the client nor
 * the game config: this server's choice.
 */
export const ROOM_BOOST_ACTIVE_DAYS = 30

/** Schema DDL (mirror of the rooms worker's migrations/0035_room_boost.sql). */
export const ROOM_BOOST_SCHEMA_DDL: string[] = [
	`CREATE TABLE IF NOT EXISTS room_boost (
		id INTEGER PRIMARY KEY AUTOINCREMENT,
		room_id INTEGER NOT NULL,
		account_id INTEGER NOT NULL,
		request_id TEXT NOT NULL UNIQUE,
		amount INTEGER NOT NULL DEFAULT 1,
		created_at TEXT NOT NULL
	)`,
	`CREATE INDEX IF NOT EXISTS idx_room_boost_room ON room_boost (room_id, created_at)`,
	`CREATE INDEX IF NOT EXISTS idx_room_boost_player ON room_boost (room_id, account_id, created_at)`,
]

/**
 * SQL for "now minus the active window", in the same ISO-8601 form `created_at` is stored in
 * (`toISOString()`), so the two compare as strings.
 */
const ACTIVE_SINCE_SQL = `strftime('%Y-%m-%dT%H:%M:%fZ', 'now', '-${ROOM_BOOST_ACTIVE_DAYS} days')`

/**
 * A correlated subquery for the active boost units of the room `table` names (`room` or a join
 * alias): what every room read selects as `boosts` and serves as the DTO's `BoostCount`.
 */
export function activeBoostsSql(table: string): string {
	return `(SELECT COALESCE(SUM(amount), 0) FROM room_boost
		WHERE room_boost.room_id = ${table}.room_id AND room_boost.created_at > ${ACTIVE_SINCE_SQL})`
}

/** A room's active boost units (0 when none, also for an unknown room). */
export async function getRoomBoostCount(db: D1Database, roomId: number): Promise<number> {
	const row = await db
		.prepare(
			`SELECT COALESCE(SUM(amount), 0) AS n FROM room_boost
			 WHERE room_id = ?1 AND created_at > ${ACTIVE_SINCE_SQL}`
		)
		.bind(roomId)
		.first<{ n: number }>()
	return row?.n ?? 0
}

/**
 * Several players' active boost units in one room, every asked id included (0 for none).
 * `accountIds` is expected de-duplicated and bounded by the caller.
 */
export async function getPlayerRoomBoostCounts(
	db: D1Database,
	roomId: number,
	accountIds: number[]
): Promise<Map<number, number>> {
	const counts = new Map(accountIds.map((id) => [id, 0]))
	if (accountIds.length === 0) return counts
	const { results } = await db
		.prepare(
			`SELECT account_id, SUM(amount) AS n FROM room_boost
			 WHERE room_id = ?1 AND created_at > ${ACTIVE_SINCE_SQL}
			   AND account_id IN (SELECT value FROM json_each(?2))
			 GROUP BY account_id`
		)
		.bind(roomId, JSON.stringify(accountIds))
		.all<{ account_id: number; n: number }>()
	for (const r of results) counts.set(r.account_id, r.n)
	return counts
}

/**
 * Claim a boost request: insert its row with `units`, unless a row with that `requestId`
 * already exists. Answers false for a request already recorded — the client retries a consume
 * it got no answer to, and a retry must neither spend nor count twice. The claim comes BEFORE
 * the consumable is spent (see econ's consume route), so two copies of one request racing each
 * other cannot both spend: only one insert wins the unique `request_id`.
 */
export async function claimRoomBoost(
	db: D1Database,
	boost: { roomId: number; accountId: number; requestId: string; units: number },
	now = new Date()
): Promise<boolean> {
	const { meta } = await db
		.prepare(
			`INSERT OR IGNORE INTO room_boost (room_id, account_id, request_id, amount, created_at)
			 VALUES (?1, ?2, ?3, ?4, ?5)`
		)
		.bind(boost.roomId, boost.accountId, boost.requestId, boost.units, now.toISOString())
		.run()
	return meta.changes > 0
}

/**
 * Settle a claimed request once the spend is known: `units` 0 (nothing was spent) drops the
 * claim, so a request that spent nothing counts nothing; otherwise it records what was spent.
 */
export async function settleRoomBoost(
	db: D1Database,
	requestId: string,
	units: number
): Promise<void> {
	if (units <= 0) {
		await db.prepare('DELETE FROM room_boost WHERE request_id = ?1').bind(requestId).run()
	} else {
		await db
			.prepare('UPDATE room_boost SET amount = ?2 WHERE request_id = ?1')
			.bind(requestId, units)
			.run()
	}
}

/**
 * The rooms whose boosts lapsed between `from` and `to` (a row's window ends
 * {@link ROOM_BOOST_ACTIVE_DAYS} days after `created_at`): the rooms whose active count the
 * expiry sweep re-announces. Distinct room ids.
 */
export async function getRoomsWithLapsedBoosts(
	db: D1Database,
	from: Date,
	to: Date
): Promise<number[]> {
	const window = ROOM_BOOST_ACTIVE_DAYS * 24 * 60 * 60 * 1000
	const { results } = await db
		.prepare(
			`SELECT DISTINCT room_id FROM room_boost WHERE created_at > ?1 AND created_at <= ?2`
		)
		.bind(
			new Date(from.getTime() - window).toISOString(),
			new Date(to.getTime() - window).toISOString()
		)
		.all<{ room_id: number }>()
	return results.map((r) => r.room_id)
}
