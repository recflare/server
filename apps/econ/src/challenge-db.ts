/**
 * Weekly-challenge progress on the shared `recflare` D1 database — one row per
 * (account, challenge), written by `POST /api/challenge/v2/updateProgress` and read back
 * by `GET /api/challenge/v2/getCurrent` to stamp each challenge's per-player `Complete`.
 *
 * Only the completion flag is stored, not the `Config` rule tree the client posts with it.
 * That tree is the challenge's DEFINITION (it comes from static/weekly-challenge.json and
 * is identical for everyone), decorated with the client's running count in `cc`; the
 * server evaluates none of it, so persisting a per-player copy would only be a second,
 * staler copy of the catalog. See .agents/weekly-challenge-config/SKILL.md for the grammar.
 *
 * Completion LATCHES within a rotation: the client reports progress repeatedly, and a
 * report that arrives with the challenge no longer complete (a fresh session, a reordered
 * retry) must not un-finish something already finished. A report carrying a different
 * `ChallengeMapId` is a new rotation and REPLACES the row instead — challenge ids are only
 * unique within a rotation, so a challenge that returns in a later week would otherwise
 * start out already complete on the old week's row.
 *
 * Finishing enough of a rotation's challenges earns its `Gift`, which is handed out from the
 * same `updateProgress` call that reaches the threshold. That payout is gated by a
 * second table here, `challenge_gift` — one row per (account, rotation), claimed once.
 *
 * The `econ` worker owns both tables and their migrations
 * (apps/econ/migrations/0009_challenge_status.sql, 0011_challenge_gift.sql).
 */

/** Schema DDL (mirror of migrations 0009_challenge_status.sql) — also builds the table in tests. */
export const CHALLENGE_STATUS_SCHEMA_DDL: string[] = [
	`CREATE TABLE IF NOT EXISTS challenge_status (
		account_id INTEGER NOT NULL,
		challenge_id INTEGER NOT NULL,
		challenge_map_id INTEGER NOT NULL,
		complete INTEGER NOT NULL,
		updated_at TEXT NOT NULL,
		PRIMARY KEY (account_id, challenge_id)
	)`,
]

/** One challenge's progress as the client reports it. */
export interface ChallengeProgress {
	challengeMapId: number
	challengeId: number
	complete: boolean
}

/**
 * Record a progress report and return the completion the row now holds — which is what the
 * response must echo, since it isn't always what was posted: within a rotation `complete`
 * only ever goes false → true (see the latching note above), so a `false` report against a
 * finished challenge answers `true`.
 *
 * SQLite evaluates every `DO UPDATE SET` expression against the pre-update row, so the
 * `CASE` can compare the stored `challenge_map_id` with the incoming one while the same
 * statement overwrites it.
 */
export async function recordChallengeProgress(
	db: D1Database,
	accountId: number,
	progress: ChallengeProgress
): Promise<boolean> {
	const row = await db
		.prepare(
			`INSERT INTO challenge_status (account_id, challenge_id, challenge_map_id, complete, updated_at)
			 VALUES (?1, ?2, ?3, ?4, ?5)
			 ON CONFLICT (account_id, challenge_id) DO UPDATE SET
			   complete = CASE
			     WHEN challenge_status.challenge_map_id = excluded.challenge_map_id
			     THEN MAX(challenge_status.complete, excluded.complete)
			     ELSE excluded.complete
			   END,
			   challenge_map_id = excluded.challenge_map_id,
			   updated_at = excluded.updated_at
			 RETURNING complete`
		)
		.bind(
			accountId,
			progress.challengeId,
			progress.challengeMapId,
			progress.complete ? 1 : 0,
			new Date().toISOString()
		)
		.first<{ complete: number }>()
	return row?.complete === 1
}

/**
 * The ids of the challenges a player has finished in one rotation. Scoped to the rotation
 * so a stale row from an earlier week — same challenge id, different `challenge_map_id` —
 * doesn't show up pre-completed before the client has reported anything against it.
 *
 * Also what earning the rotation's `Gift` is decided from: it is due once ENOUGH of the
 * challenges in static/weekly-challenge.json appear here — three of the five a week
 * publishes, not all of them (see `CHALLENGES_REQUIRED_FOR_GIFT` in econ.app.ts).
 */
export async function getCompletedChallengeIds(
	db: D1Database,
	accountId: number,
	challengeMapId: number
): Promise<Set<number>> {
	const { results } = await db
		.prepare(
			`SELECT challenge_id FROM challenge_status
			 WHERE account_id = ?1 AND challenge_map_id = ?2 AND complete = 1`
		)
		.bind(accountId, challengeMapId)
		.all<{ challenge_id: number }>()
	return new Set(results.map((r) => r.challenge_id))
}

/** Schema DDL (mirror of migrations 0011_challenge_gift.sql) — also builds the table in tests. */
export const CHALLENGE_GIFT_SCHEMA_DDL: string[] = [
	`CREATE TABLE IF NOT EXISTS challenge_gift (
		account_id INTEGER NOT NULL,
		challenge_map_id INTEGER NOT NULL,
		granted_at TEXT NOT NULL,
		PRIMARY KEY (account_id, challenge_map_id)
	)`,
]

/**
 * Take the one gift a rotation owes a player, returning whether this call is the one that
 * got it — `false` means it was already handed out and the caller must grant nothing.
 *
 * The client keeps reporting progress after the set is finished, so "has this been paid?"
 * has to be asked and answered in ONE statement: a read-then-insert would let two reports
 * that land together both see no row and both pay out. `ON CONFLICT … DO NOTHING` with
 * `RETURNING` gives us that — the second insert matches the existing row, writes nothing
 * and returns nothing.
 *
 * The gate is deliberately at-most-once: the row is claimed BEFORE the items are granted,
 * so a failure mid-grant loses the reward rather than risking a second one. It is a faucet,
 * and a stuck one is easier to notice and re-grant by hand than a leaking one.
 */
export async function claimChallengeGift(
	db: D1Database,
	accountId: number,
	challengeMapId: number,
	now: Date = new Date()
): Promise<boolean> {
	const row = await db
		.prepare(
			`INSERT INTO challenge_gift (account_id, challenge_map_id, granted_at)
			 VALUES (?1, ?2, ?3)
			 ON CONFLICT (account_id, challenge_map_id) DO NOTHING
			 RETURNING granted_at`
		)
		.bind(accountId, challengeMapId, now.toISOString())
		.first<{ granted_at: string }>()
	return row !== null
}
