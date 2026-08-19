/**
 * Player progression — the level and XP shown on a profile — on the shared `recflare` D1.
 * One row per account, created on the first grant.
 *
 * Two workers share it, so it lives here rather than in either: `econ` WRITES it (game
 * rewards pay XP out) and `api` READS it (`GET /api/players/v{1,2}/progression/…`). Same
 * split as the gift boxes next door.
 *
 * A missing row is not an error — it means "nothing earned yet", which is exactly the
 * level-1/0-XP default the progression endpoints already served, so reads fall back to it
 * rather than inserting on a GET.
 *
 * `level` is stored rather than derived, because `xp` is NOT lifetime XP: a level-up spends
 * the tier's cost out of it (see {@link LEVEL_REQUIRED_XP}), so the pair is a level plus the
 * progress into the next one — which is exactly what the client's bar draws.
 *
 * The `econ` worker owns the migration (apps/econ/migrations/0012_progression.sql), being
 * the writer.
 */

/** Schema DDL (mirror of apps/econ/migrations/0012_progression.sql). */
export const PROGRESSION_SCHEMA_DDL: string[] = [
	`CREATE TABLE IF NOT EXISTS progression (
		account_id INTEGER PRIMARY KEY,
		level INTEGER NOT NULL DEFAULT 1,
		xp INTEGER NOT NULL DEFAULT 0
	)`,
]

/**
 * XP to leave each level, indexed BY LEVEL — `LEVEL_REQUIRED_XP[1]` is what a level-1 player
 * spends to reach level 2. Copied from the `LevelProgressionMaps` the client is served in
 * `apps/api/static/api-config-v2.json`, which is the same ladder the reference reads out of
 * `configv2.json`: both sides have to agree or the client's bar fills to a different mark
 * than the server levels at. An `api` test asserts the two stay identical.
 *
 * Index 0 is the level-0 entry the config carries (cost 0, unreachable — players start at
 * level 1), and the tiers step 10 → 20 → 45 → 115 → 360 → 1080 every ten levels.
 *
 * What each level PAYS OUT is a separate table, {@link LEVEL_REWARDS}.
 */
export const LEVEL_REQUIRED_XP: readonly number[] = [
	0, 10, 10, 10, 20, 20, 20, 20, 20, 20, 20, 45, 45, 45, 45, 45, 45, 45, 45, 45, 45, 115, 115, 115,
	115, 115, 115, 115, 115, 115, 115, 360, 360, 360, 360, 360, 360, 360, 360, 360, 360, 1080, 1080,
	1080, 1080, 1080, 1080, 1080, 1080, 1080, 1080,
]

/** A consumable reward rather than a clothing item — no star tier of its own. */
export const CONSUMABLE_REWARD = -1

/**
 * The reward for REACHING each level, indexed by level: a `Rarity` for a clothing item, or
 * {@link CONSUMABLE_REWARD} for a consumable. Transcribed from Rec Room's published
 * level-reward table, in the star ratings it uses — 2-Star is rarity 10, 3-Star 20, 4-Star
 * 30, 5-Star 50 (the ladder in the econ worker's query-drop section).
 *
 * The shape is worth reading: consumables carry the first ten levels (six of them), which
 * are minutes apart at 10–20 XP each; clothing takes over and holds 2-Star until 21; the
 * 20s alternate 2- and 3-Star; the 30s alternate 3- and 4-Star; the 40s are solid 4-Star,
 * and level 50 is the only 5-Star in the game's progression.
 *
 * This is NOT the coarse `GiftRarity` the served config carries (a flat 10 to level 14, 20
 * to 39, 30 to 49, 50 at the cap). The two disagree in places — level 15 is 2-Star here and
 * 20 there — and this table is the one we grant from, being per-level and explicit. See the
 * econ README.
 */
// prettier-ignore — the row-per-decade layout is the table; packing it hides the shape.
// prettier-ignore
export const LEVEL_REWARDS: readonly number[] = [
	// Level 0 is not a level anyone reaches; 0 is "no reward" rather than a rarity.
	0,
	// 1–10: consumables interleaved with the first clothing drops.
	CONSUMABLE_REWARD, 10, CONSUMABLE_REWARD, 10, CONSUMABLE_REWARD,
	CONSUMABLE_REWARD, CONSUMABLE_REWARD, 10, CONSUMABLE_REWARD, 10,
	// 11–20: 2-Star clothing all the way.
	10, 10, 10, 10, 10, 10, 10, 10, 10, 10,
	// 21–30: 2-Star alternating with 3-Star.
	10, 20, 10, 20, 10, 20, 10, 20, 10, 20,
	// 31–40: 3-Star with a 4-Star every few levels.
	30, 20, 20, 20, 30, 20, 20, 20, 20, 30,
	// 41–50: 4-Star to the top, then the game's only 5-Star.
	30, 30, 30, 30, 30, 30, 30, 30, 30, 50,
]

/** What reaching a level pays out, or null when it pays nothing. */
export type LevelReward = { kind: 'consumable' } | { kind: 'clothing'; rarity: number }

/**
 * The reward for reaching `level`, or null for a level that carries none (level 0, or any
 * level past the end of the table).
 */
export function levelReward(level: number): LevelReward | null {
	const reward = LEVEL_REWARDS[level]
	if (reward === undefined || reward === 0) return null
	return reward === CONSUMABLE_REWARD
		? { kind: 'consumable' }
		: { kind: 'clothing', rarity: reward }
}

/** The last level the ladder defines. At the top XP still accrues, but nothing levels. */
export const MAX_LEVEL = LEVEL_REQUIRED_XP.length - 1

/**
 * Spend XP on levels: while the current level's cost is met, subtract it and step up. The
 * remainder stays as progress into the next level, and a big enough grant can cross several
 * at once (a 25 XP grant would take a fresh player from level 1 to level 3, the first two
 * levels costing 10 each).
 *
 * A cost of 0 or less stops the loop rather than looping forever — the level-0 entry is 0,
 * and a future config could zero one by mistake.
 */
export function applyLevelUps(level: number, xp: number): { level: number; xp: number } {
	let currentLevel = level
	let remaining = xp
	while (currentLevel < MAX_LEVEL) {
		const cost = LEVEL_REQUIRED_XP[currentLevel] ?? 0
		if (cost <= 0 || remaining < cost) break
		remaining -= cost
		currentLevel += 1
	}
	return { level: currentLevel, xp: remaining }
}

/** A player's progression, as the client's progression DTO renders it. */
export interface Progression {
	PlayerId: number
	Level: number
	XP: number
}

/** What a player with no row has: nothing earned yet. */
export function defaultProgression(accountId: number): Progression {
	return { PlayerId: accountId, Level: 1, XP: 0 }
}

/** What a player holds after a grant, plus how many levels the grant took them up. */
export interface XpGrant {
	progression: Progression
	levelsGained: number
}

/**
 * The levels a grant took the player THROUGH, in order — `[2, 3]` for a grant that lifts a
 * fresh player from level 1 to level 3. One entry per level reached, which is one reward
 * each; an empty list when the grant only moved the bar, which is the common case for a
 * game reward.
 */
export function levelsReached(grant: XpGrant): number[] {
	const from = grant.progression.Level - grant.levelsGained
	return Array.from({ length: grant.levelsGained }, (_, i) => from + i + 1)
}

/**
 * Add XP to a player, spend it on any levels it now pays for, and return what they hold —
 * with the levels gained, which is what a caller announces ("you reached level 3") and what
 * a future level-up reward would hang off.
 *
 * The XP add is one statement, so two rewards landing together can't both read the same
 * stale total and write it back — the client fires reward requests off right after a match.
 * The level-up is a second write on the row the first one returned: the ladder is a pure
 * function of that row, so a concurrent grant either lands before it (and is included) or
 * after it (and levels up itself). Neither loses XP; the worst case is a level-up announced
 * one grant late.
 *
 * Non-positive amounts are dropped rather than written: nothing takes XP away, and a 0 XP
 * grant would otherwise create a row that says the same as no row at all.
 */
export async function addXp(db: D1Database, accountId: number, xp: number): Promise<XpGrant> {
	if (xp <= 0) return { progression: await getProgression(db, accountId), levelsGained: 0 }
	const row = await db
		.prepare(
			`INSERT INTO progression (account_id, level, xp) VALUES (?1, 1, ?2)
			 ON CONFLICT (account_id) DO UPDATE SET xp = progression.xp + excluded.xp
			 RETURNING level, xp`
		)
		.bind(accountId, xp)
		.first<{ level: number; xp: number }>()
	if (row === null) return { progression: defaultProgression(accountId), levelsGained: 0 }

	const leveled = applyLevelUps(row.level, row.xp)
	const levelsGained = leveled.level - row.level
	if (levelsGained > 0) {
		await db
			.prepare('UPDATE progression SET level = ?2, xp = ?3 WHERE account_id = ?1')
			.bind(accountId, leveled.level, leveled.xp)
			.run()
	}
	return {
		progression: { PlayerId: accountId, Level: leveled.level, XP: leveled.xp },
		levelsGained,
	}
}

/** One player's progression, defaulted when they've earned nothing yet. */
export async function getProgression(db: D1Database, accountId: number): Promise<Progression> {
	const row = await db
		.prepare('SELECT level, xp FROM progression WHERE account_id = ?1')
		.bind(accountId)
		.first<{ level: number; xp: number }>()
	if (row === null) return defaultProgression(accountId)
	return { PlayerId: accountId, Level: row.level, XP: row.xp }
}

/**
 * Progressions for a list of ids, in the order asked and one per id — the bulk lookups
 * render a profile card per entry, so an id with no row still gets its default rather than
 * being dropped from the list.
 */
export async function getProgressions(
	db: D1Database,
	accountIds: number[]
): Promise<Progression[]> {
	if (accountIds.length === 0) return []
	const placeholders = accountIds.map((_, i) => `?${i + 1}`).join(', ')
	const { results } = await db
		.prepare(`SELECT account_id, level, xp FROM progression WHERE account_id IN (${placeholders})`)
		.bind(...accountIds)
		.all<{ account_id: number; level: number; xp: number }>()
	const stored = new Map(results.map((r) => [r.account_id, r]))
	return accountIds.map((id) => {
		const row = stored.get(id)
		return row === undefined
			? defaultProgression(id)
			: { PlayerId: id, Level: row.level, XP: row.xp }
	})
}
