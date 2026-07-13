/**
 * Per-player objective progress — the daily/weekly challenge checklist the client
 * shows. The client reports progress as it plays (`/api/objectives/v1/updateobjective`)
 * and reads it back on load (`/api/objectives/v1/myprogress`).
 *
 * An objective is identified by its (group, index) within a player's set, so updates
 * upsert on that triple rather than allocating ids. `has_claimed_reward` is latched
 * the first time an objective completes — the reference awards progression XP at that
 * moment, and the flag is what stops it being awarded twice.
 */

/** Schema DDL (mirror of migrations/0015_objective.sql and 0016_objective_group.sql). */
export const SCHEMA_DDL: string[] = [
	`CREATE TABLE IF NOT EXISTS objective (
		account_id INTEGER NOT NULL,
		group_id INTEGER NOT NULL,
		idx INTEGER NOT NULL,
		progress REAL NOT NULL DEFAULT 0,
		visual_progress REAL NOT NULL DEFAULT 0,
		is_completed INTEGER NOT NULL DEFAULT 0,
		is_rewarded INTEGER NOT NULL DEFAULT 0,
		has_claimed_reward INTEGER NOT NULL DEFAULT 0,
		PRIMARY KEY (account_id, group_id, idx)
	)`,
	`CREATE INDEX IF NOT EXISTS idx_objective_account ON objective (account_id)`,
	// A player's objective *groups* — the daily/weekly sets. The client clears a group
	// once it's done with it (`cleargroup`), which stamps `cleared_at`.
	`CREATE TABLE IF NOT EXISTS objective_group (
		account_id INTEGER NOT NULL,
		group_id INTEGER NOT NULL,
		is_completed INTEGER NOT NULL DEFAULT 0,
		cleared_at TEXT,
		PRIMARY KEY (account_id, group_id)
	)`,
]

/** One objective's progress, as the client reads it back from `myprogress`. */
export interface Objective {
	Group: number
	Index: number
	Progress: number
	VisualProgress: number
	IsCompleted: boolean
	HasClaimedReward: boolean
}

/** What the client posts when it makes progress on an objective. */
export interface ObjectiveUpdate {
	Group: number
	Index: number
	Progress: number
	VisualProgress: number
	IsCompleted: boolean
	IsRewarded: boolean
}

/**
 * Record progress on an objective. Upserts on (account, group, index).
 * `has_claimed_reward` latches on the first completion and never unlatches, so an
 * objective that completes twice (or is replayed by the client) only ever pays out
 * once. Returns true when this call is the one that completed it.
 */
export async function updateObjective(
	db: D1Database,
	accountId: number,
	update: ObjectiveUpdate
): Promise<boolean> {
	const existing = await db
		.prepare(
			`SELECT is_completed, has_claimed_reward FROM objective
			 WHERE account_id = ?1 AND group_id = ?2 AND idx = ?3`
		)
		.bind(accountId, update.Group, update.Index)
		.first<{ is_completed: number; has_claimed_reward: number }>()

	const wasCompleted = existing?.is_completed === 1
	const newlyCompleted = update.IsCompleted && !wasCompleted
	const hasClaimedReward = existing?.has_claimed_reward === 1 || newlyCompleted

	await db
		.prepare(
			`INSERT INTO objective
			   (account_id, group_id, idx, progress, visual_progress,
			    is_completed, is_rewarded, has_claimed_reward)
			 VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)
			 ON CONFLICT(account_id, group_id, idx) DO UPDATE SET
			   progress = ?4,
			   visual_progress = ?5,
			   is_completed = ?6,
			   is_rewarded = ?7,
			   has_claimed_reward = ?8`
		)
		.bind(
			accountId,
			update.Group,
			update.Index,
			update.Progress,
			update.VisualProgress,
			update.IsCompleted ? 1 : 0,
			update.IsRewarded ? 1 : 0,
			hasClaimedReward ? 1 : 0
		)
		.run()

	return newlyCompleted
}

/** An objective group's state, as `myprogress` and `cleargroup` report it. */
export interface ObjectiveGroup {
	Group: number
	IsCompleted: boolean
	ClearedAt: string
}

/**
 * Clear an objective group — the client saying it's finished with that set (its
 * dailies rolled over, say). Stamps the clear time and marks the group completed,
 * returning the group as the client reads it back.
 *
 * The group's individual objectives are deliberately left in place: the client still
 * renders what was achieved, and `updateobjective` overwrites them by (group, index)
 * when the next set is issued.
 */
export async function clearObjectiveGroup(
	db: D1Database,
	accountId: number,
	group: number
): Promise<ObjectiveGroup> {
	const clearedAt = new Date().toISOString()
	await db
		.prepare(
			`INSERT INTO objective_group (account_id, group_id, is_completed, cleared_at)
			 VALUES (?1, ?2, 1, ?3)
			 ON CONFLICT(account_id, group_id) DO UPDATE SET is_completed = 1, cleared_at = ?3`
		)
		.bind(accountId, group, clearedAt)
		.run()
	return { Group: group, IsCompleted: true, ClearedAt: clearedAt }
}

/** A player's objective groups, or an empty list when they've cleared none. */
export async function getObjectiveGroups(
	db: D1Database,
	accountId: number
): Promise<ObjectiveGroup[]> {
	const { results } = await db
		.prepare(
			`SELECT group_id, is_completed, cleared_at FROM objective_group
			 WHERE account_id = ?1 ORDER BY group_id`
		)
		.bind(accountId)
		.all<{ group_id: number; is_completed: number; cleared_at: string | null }>()

	return results.map((r) => ({
		Group: r.group_id,
		IsCompleted: r.is_completed === 1,
		ClearedAt: r.cleared_at ?? '',
	}))
}

/** A player's objectives, or an empty list when they've made no progress yet. */
export async function getObjectives(db: D1Database, accountId: number): Promise<Objective[]> {
	const { results } = await db
		.prepare(
			`SELECT group_id, idx, progress, visual_progress, is_completed, has_claimed_reward
			 FROM objective WHERE account_id = ?1
			 ORDER BY group_id, idx`
		)
		.bind(accountId)
		.all<{
			group_id: number
			idx: number
			progress: number
			visual_progress: number
			is_completed: number
			has_claimed_reward: number
		}>()

	return results.map((r) => ({
		Group: r.group_id,
		Index: r.idx,
		Progress: r.progress,
		VisualProgress: r.visual_progress,
		IsCompleted: r.is_completed === 1,
		HasClaimedReward: r.has_claimed_reward === 1,
	}))
}
