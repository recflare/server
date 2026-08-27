/**
 * Weekly-challenge progress on the shared `recflare` D1 database — one row per
 * (account, challenge), written by `POST /api/challenge/v2/updateProgress` and read back
 * by `GET /api/challenge/v2/getCurrent` to stamp each challenge's per-player state.
 *
 * The CLIENT owns the evaluating: it walks the challenge's rule tree locally and posts the
 * tree back with its own progress written into the nodes — `cc` on a counter is the running
 * count, `c` marks a satisfied node (see .agents/skills/weekly-challenge-config/SKILL.md for
 * the grammar). So the posted `Config` is not the catalog's copy of the definition, it is
 * per-player STATE, and it is stored here alongside the completion flag; the server still
 * evaluates none of it. `getCurrent` serves the static challenge with the stored `Config`
 * and `Complete` overwritten onto it, which is how partial progress survives a session:
 * without it a player who had two of three kills started over on every login.
 *
 * Completion LATCHES within a rotation: the client reports progress repeatedly, and a
 * report that arrives with the challenge no longer complete (a fresh session, a reordered
 * retry) must not un-finish something already finished. `config` does NOT latch — it is the
 * running tally, so the newest report wins — but a report that carries none leaves the
 * stored tree alone rather than blanking it. A report carrying a different `ChallengeMapId`
 * is a new rotation and REPLACES the row instead — challenge ids are only unique within a
 * rotation, so a challenge that returns in a later week would otherwise start out already
 * complete, and half-counted, on the old week's row.
 *
 * Finishing enough of a rotation's challenges earns its `Gift`, which is handed out from the
 * same `updateProgress` call that reaches the threshold. That payout is gated by a
 * second table here, `challenge_gift` — one row per (account, rotation), claimed once.
 *
 * The `econ` worker owns both tables and their migrations
 * (apps/econ/migrations/0009_challenge_status.sql, 0011_challenge_gift.sql,
 * 0014_challenge_status_config.sql).
 */

/**
 * Schema DDL (mirror of migrations 0009_challenge_status.sql + 0014_challenge_status_config.sql)
 * — also builds the table in tests.
 */
export const CHALLENGE_STATUS_SCHEMA_DDL: string[] = [
	`CREATE TABLE IF NOT EXISTS challenge_status (
		account_id INTEGER NOT NULL,
		challenge_id INTEGER NOT NULL,
		challenge_map_id INTEGER NOT NULL,
		complete INTEGER NOT NULL,
		config TEXT,
		updated_at TEXT NOT NULL,
		PRIMARY KEY (account_id, challenge_id)
	)`,
]

/** One challenge's progress as the client reports it. */
export interface ChallengeProgress {
	challengeMapId: number
	challengeId: number
	complete: boolean
	/** The client-evaluated rule tree, or null when the report carried none. */
	config: string | null
}

/** What a stored row holds for one challenge, as `getCurrent` overwrites it onto the catalog. */
export interface ChallengeStatus {
	complete: boolean
	/** The last tree the client posted; null means it never posted one — serve the static tree. */
	config: string | null
}

/**
 * Record a progress report and return the state the row now holds — which is what the
 * response must echo, since it isn't always what was posted: within a rotation `complete`
 * only ever goes false → true (see the latching note above), so a `false` report against a
 * finished challenge answers `true`, and a report with no `Config` answers the tree already
 * stored.
 *
 * SQLite evaluates every `DO UPDATE SET` expression against the pre-update row, so the
 * `CASE`s can compare the stored `challenge_map_id` with the incoming one while the same
 * statement overwrites it.
 */
export async function recordChallengeProgress(
	db: D1Database,
	accountId: number,
	progress: ChallengeProgress
): Promise<ChallengeStatus> {
	const row = await db
		.prepare(
			`INSERT INTO challenge_status (account_id, challenge_id, challenge_map_id, complete, config, updated_at)
			 VALUES (?1, ?2, ?3, ?4, ?5, ?6)
			 ON CONFLICT (account_id, challenge_id) DO UPDATE SET
			   complete = CASE
			     WHEN challenge_status.challenge_map_id = excluded.challenge_map_id
			     THEN MAX(challenge_status.complete, excluded.complete)
			     ELSE excluded.complete
			   END,
			   config = CASE
			     WHEN challenge_status.challenge_map_id = excluded.challenge_map_id
			     THEN COALESCE(excluded.config, challenge_status.config)
			     ELSE excluded.config
			   END,
			   challenge_map_id = excluded.challenge_map_id,
			   updated_at = excluded.updated_at
			 RETURNING complete, config`
		)
		.bind(
			accountId,
			progress.challengeId,
			progress.challengeMapId,
			progress.complete ? 1 : 0,
			progress.config,
			new Date().toISOString()
		)
		.first<{ complete: number; config: string | null }>()
	return { complete: row?.complete === 1, config: row?.config ?? null }
}

/**
 * What a player has stored for one rotation's challenges, keyed by challenge id. Scoped to
 * the rotation so a stale row from an earlier week — same challenge id, different
 * `challenge_map_id` — doesn't show up pre-completed, or half-counted, before the client has
 * reported anything against it.
 *
 * Read by `getCurrent` to overwrite the static rotation, and by the gift path: the `Gift` is
 * due once ENOUGH of the week's own challenges are complete here — three of the five a
 * rotation publishes, not all of them (see `CHALLENGES_REQUIRED_FOR_GIFT` in econ.app.ts).
 * The rotation itself is generated per week by src/challenge-rotation.ts.
 */
export async function getChallengeStatuses(
	db: D1Database,
	accountId: number,
	challengeMapId: number
): Promise<Map<number, ChallengeStatus>> {
	const { results } = await db
		.prepare(
			`SELECT challenge_id, complete, config FROM challenge_status
			 WHERE account_id = ?1 AND challenge_map_id = ?2`
		)
		.bind(accountId, challengeMapId)
		.all<{ challenge_id: number; complete: number; config: string | null }>()
	return new Map(
		results.map((r) => [r.challenge_id, { complete: r.complete === 1, config: r.config }])
	)
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
