/**
 * Friendship / relationship storage on the shared `recflare` D1 database.
 *
 * Unlike the JSON-blob tables in this database (rooms/accounts/image), a
 * relationship is genuinely columnar, so it gets a normal relational table
 * (mirroring the Go/GORM `Relationship` model). Exactly ONE row exists per
 * unordered pair of players: the player who initiated is the `requester`, the
 * other is the `target`. `relationship_type` is stored from the requester's
 * point of view; when we project the row for the *target* we flip
 * Sent↔Received (Friend/None are symmetric).
 *
 * The `api` worker owns the schema/migration (migrations/0001_relationship.sql,
 * applied under its own `migrations_table` so it doesn't clash with the other
 * workers' migrations that share the database) and every mutation here is reached
 * through its social routes. The reads are shared: `match` pushes a presence update
 * to a player's friends when they change rooms, and both `match` and `rooms` gate
 * follow-a-friend on {@link areFriends}.
 */

/** Relationship state from the perspective of the player asking (mirrors the reference). */
export enum RelationshipType {
	None = 0,
	FriendRequestSent = 1,
	FriendRequestReceived = 2,
	Friend = 3,
}

/** Schema DDL (mirror of migrations/0001_relationship.sql, sans seed rows). */
export const RELATIONSHIP_SCHEMA_DDL: string[] = [
	`CREATE TABLE IF NOT EXISTS relationship (
		id INTEGER PRIMARY KEY AUTOINCREMENT,
		requester_id INTEGER NOT NULL,
		target_id INTEGER NOT NULL,
		relationship_type INTEGER NOT NULL DEFAULT 0,
		requester_favorited INTEGER NOT NULL DEFAULT 0,
		requester_ignored INTEGER NOT NULL DEFAULT 0,
		requester_muted INTEGER NOT NULL DEFAULT 0,
		target_favorited INTEGER NOT NULL DEFAULT 0,
		target_ignored INTEGER NOT NULL DEFAULT 0,
		target_muted INTEGER NOT NULL DEFAULT 0
	)`,
	`CREATE UNIQUE INDEX IF NOT EXISTS idx_relationship ON relationship (requester_id, target_id)`,
	`CREATE INDEX IF NOT EXISTS idx_relationship_target ON relationship (target_id)`,
]

/** A stored relationship row (snake_case columns, one row per player pair). */
interface RelationshipRow {
	requester_id: number
	target_id: number
	relationship_type: number
	requester_favorited: number
	requester_ignored: number
	requester_muted: number
	target_favorited: number
	target_ignored: number
	target_muted: number
}

/** The per-player relationship projection returned to the client (RelationshipResponse). */
export interface RelationshipResponse {
	Favorited: number
	Ignored: number
	Muted: number
	PlayerID: number
	RelationshipType: RelationshipType
}

/**
 * The result of a friend-graph mutation. These changes are visible to BOTH players, and
 * each sees a different projection of the same row (the target of a request sees
 * `FriendRequestReceived` where the sender sees `Sent`), so callers get both — `self` for
 * the HTTP response and the acting player's notification, `other` for the target's.
 *
 * `changed` is false when the mutation was a no-op: re-sending a request that's already
 * outstanding, befriending someone you're already friends with, accepting something that
 * isn't pending. Nothing was written, so no RelationshipChanged notification should go out
 * (the reference server is likewise silent on its no-change branch).
 */
export interface RelationshipChange {
	self: RelationshipResponse
	other: RelationshipResponse
	changed: boolean
}

/** The projection reported for a pair with no stored relationship. */
function noneResponse(otherId: number): RelationshipResponse {
	return {
		PlayerID: otherId,
		RelationshipType: RelationshipType.None,
		Favorited: 0,
		Ignored: 0,
		Muted: 0,
	}
}

/** Flip a pending request to the other side's point of view; Friend/None are symmetric. */
function flipType(type: number): RelationshipType {
	if (type === RelationshipType.FriendRequestSent) return RelationshipType.FriendRequestReceived
	if (type === RelationshipType.FriendRequestReceived) return RelationshipType.FriendRequestSent
	return type as RelationshipType
}

/**
 * Project a stored row into the RelationshipResponse for `playerId` (who must be
 * one of the pair). `PlayerID` is the *other* player; the type and the
 * favorited/ignored/muted flags are taken from `playerId`'s side of the row.
 */
function toResponse(row: RelationshipRow, playerId: number): RelationshipResponse {
	const isRequester = row.requester_id === playerId
	return {
		PlayerID: isRequester ? row.target_id : row.requester_id,
		RelationshipType: isRequester ? (row.relationship_type as RelationshipType) : flipType(row.relationship_type),
		Favorited: isRequester ? row.requester_favorited : row.target_favorited,
		Ignored: isRequester ? row.requester_ignored : row.target_ignored,
		Muted: isRequester ? row.requester_muted : row.target_muted,
	}
}

/** Project a written row for both players in the pair. */
function toChange(
	row: RelationshipRow,
	playerId: number,
	otherId: number,
	changed: boolean
): RelationshipChange {
	return { self: toResponse(row, playerId), other: toResponse(row, otherId), changed }
}

/** Find the single row for an unordered pair (either direction), or null. */
async function findPair(db: D1Database, a: number, b: number): Promise<RelationshipRow | null> {
	return db
		.prepare(
			`SELECT * FROM relationship
			 WHERE (requester_id = ?1 AND target_id = ?2) OR (requester_id = ?2 AND target_id = ?1)`
		)
		.bind(a, b)
		.first<RelationshipRow>()
}

/**
 * All of a player's relationships, projected from that player's point of view.
 *
 * `None` rows are included: they are how an unfriending, or an ignore/mute of someone you
 * were never friends with, is recorded, and they still carry that player's
 * favorited/ignored/muted flags. Dropping them would lose the flags on the client.
 */
export async function getRelationshipsForPlayer(
	db: D1Database,
	playerId: number
): Promise<RelationshipResponse[]> {
	const { results } = await db
		.prepare(
			`SELECT * FROM relationship
			 WHERE requester_id = ?1 OR target_id = ?1`
		)
		.bind(playerId)
		.all<RelationshipRow>()
	return results.map((row) => toResponse(row, playerId))
}

/**
 * The ids of everyone a player is actually friends with — `Friend` rows only, from
 * either side of the pair (the row records one direction, the friendship is mutual).
 * Pending requests and `None` rows are excluded, unlike
 * {@link getRelationshipsForPlayer}, which reports the whole graph.
 */
export async function getFriendIds(db: D1Database, playerId: number): Promise<number[]> {
	const { results } = await db
		.prepare(
			`SELECT CASE WHEN requester_id = ?1 THEN target_id ELSE requester_id END AS id
			 FROM relationship
			 WHERE relationship_type = ?2 AND (requester_id = ?1 OR target_id = ?1)`
		)
		.bind(playerId, RelationshipType.Friend)
		.all<{ id: number }>()
	return results.map((r) => r.id)
}

/**
 * Whether two players are mutual friends. The single relationship row for the pair sits
 * in either direction, so both are checked. A targeted single-row read — cheaper than
 * {@link getFriendIds} when all you need is "are these two friends?" (e.g. gating a
 * follow-a-friend matchmake).
 */
export async function areFriends(
	db: D1Database,
	playerId: number,
	otherId: number
): Promise<boolean> {
	const row = await db
		.prepare(
			`SELECT 1 AS ok FROM relationship
			 WHERE relationship_type = ?3
			   AND ((requester_id = ?1 AND target_id = ?2) OR (requester_id = ?2 AND target_id = ?1))
			 LIMIT 1`
		)
		.bind(playerId, otherId, RelationshipType.Friend)
		.first<{ ok: number }>()
	return row !== null
}

/**
 * How many of a player's friends are online right now — the friend graph joined to live
 * `presence`, which is the count the client's friends panel shows. `Friend` rows only,
 * from either side of the pair, and only unexpired presence (rows outlive the player by
 * up to the TTL, exactly as every other presence read treats them). Lobby (null-instance)
 * presence counts: those friends are signed in, just not in a room.
 *
 * A friend's `statusVisibility` is deliberately NOT consulted — nothing else in the stack
 * filters presence on it (the batch `/player` lookup reports it and lets the client
 * decide), so hiding people here would disagree with the list the panel then renders.
 */
export async function countOnlineFriends(
	db: D1Database,
	playerId: number,
	now = Math.floor(Date.now() / 1000)
): Promise<number> {
	const row = await db
		.prepare(
			`SELECT COUNT(*) AS n FROM relationship r
			 JOIN presence p
			   ON p.account_id = CASE WHEN r.requester_id = ?1 THEN r.target_id ELSE r.requester_id END
			 WHERE r.relationship_type = ?2
			   AND (r.requester_id = ?1 OR r.target_id = ?1)
			   AND p.expires_at > ?3`
		)
		.bind(playerId, RelationshipType.Friend, now)
		.first<{ n: number }>()
	return row?.n ?? 0
}

/** How many mutual friends the mutual-friends lookup will return at most. */
export const MUTUAL_FRIENDS_LIMIT = 100

/**
 * The ids two players are both friends with — the intersection of their friend lists,
 * ascending and capped at {@link MUTUAL_FRIENDS_LIMIT}. Each player's friends are a
 * small set, so the intersection is done in memory rather than as a SQL INTERSECT.
 */
export async function getMutualFriendIds(
	db: D1Database,
	playerId: number,
	otherId: number
): Promise<number[]> {
	const [mine, theirs] = await Promise.all([
		getFriendIds(db, playerId),
		getFriendIds(db, otherId),
	])
	const ours = new Set(theirs)
	return mine
		.filter((id) => ours.has(id))
		.sort((a, b) => a - b)
		.slice(0, MUTUAL_FRIENDS_LIMIT)
}

/**
 * Persist `type` for the pair, with `requesterId` recorded as the row's
 * requester. Inserts a new row or, if one already exists for the pair (either
 * direction), rewrites it so the requester is normalized to `requesterId` and
 * the flags are preserved for whichever side each player is on. Returns the
 * row as written, for the caller to project onto whichever side it needs.
 */
async function upsertPair(
	db: D1Database,
	requesterId: number,
	targetId: number,
	type: RelationshipType
): Promise<RelationshipRow> {
	const existing = await findPair(db, requesterId, targetId)
	if (!existing) {
		await db
			.prepare(
				`INSERT INTO relationship (requester_id, target_id, relationship_type)
				 VALUES (?1, ?2, ?3)`
			)
			.bind(requesterId, targetId, type)
			.run()
		return {
			requester_id: requesterId,
			target_id: targetId,
			relationship_type: type,
			requester_favorited: 0,
			requester_ignored: 0,
			requester_muted: 0,
			target_favorited: 0,
			target_ignored: 0,
			target_muted: 0,
		}
	}

	// Keep each player's flags with that player as the row is normalized to
	// requester = requesterId.
	const reqIsRequester = existing.requester_id === requesterId
	const reqFlags = {
		favorited: reqIsRequester ? existing.requester_favorited : existing.target_favorited,
		ignored: reqIsRequester ? existing.requester_ignored : existing.target_ignored,
		muted: reqIsRequester ? existing.requester_muted : existing.target_muted,
	}
	const tgtFlags = {
		favorited: reqIsRequester ? existing.target_favorited : existing.requester_favorited,
		ignored: reqIsRequester ? existing.target_ignored : existing.requester_ignored,
		muted: reqIsRequester ? existing.target_muted : existing.requester_muted,
	}
	await db
		.prepare(
			`UPDATE relationship
			 SET requester_id = ?1, target_id = ?2, relationship_type = ?3,
			     requester_favorited = ?4, requester_ignored = ?5, requester_muted = ?6,
			     target_favorited = ?7, target_ignored = ?8, target_muted = ?9
			 WHERE (requester_id = ?1 AND target_id = ?2) OR (requester_id = ?2 AND target_id = ?1)`
		)
		.bind(
			requesterId,
			targetId,
			type,
			reqFlags.favorited,
			reqFlags.ignored,
			reqFlags.muted,
			tgtFlags.favorited,
			tgtFlags.ignored,
			tgtFlags.muted
		)
		.run()
	return {
		requester_id: requesterId,
		target_id: targetId,
		relationship_type: type,
		requester_favorited: reqFlags.favorited,
		requester_ignored: reqFlags.ignored,
		requester_muted: reqFlags.muted,
		target_favorited: tgtFlags.favorited,
		target_ignored: tgtFlags.ignored,
		target_muted: tgtFlags.muted,
	}
}

/**
 * Send a friend request from `requesterId` to `targetId`. If the target already
 * has a pending request out to the requester, the two become friends instead
 * (the request crosses an existing one). Already-friends, and re-sending a request
 * that's already outstanding, are no-ops.
 */
export async function sendFriendRequest(
	db: D1Database,
	requesterId: number,
	targetId: number
): Promise<RelationshipChange> {
	const existing = await findPair(db, requesterId, targetId)
	if (existing) {
		// Already friends, or we already have a request out to them — nothing to write.
		if (
			existing.relationship_type === RelationshipType.Friend ||
			(existing.requester_id === requesterId &&
				existing.relationship_type === RelationshipType.FriendRequestSent)
		) {
			return toChange(existing, requesterId, targetId, false)
		}
		// The target already requested us → crossing requests become a friendship.
		if (
			existing.requester_id === targetId &&
			existing.relationship_type === RelationshipType.FriendRequestSent
		) {
			const row = await upsertPair(db, requesterId, targetId, RelationshipType.Friend)
			return toChange(row, requesterId, targetId, true)
		}
	}
	const row = await upsertPair(db, requesterId, targetId, RelationshipType.FriendRequestSent)
	return toChange(row, requesterId, targetId, true)
}

/**
 * `accepterId` accepts a pending friend request from `otherId`. Only upgrades to
 * Friend when a request from `otherId` is actually pending; otherwise the current
 * state is returned as a no-op. (The reference server answers 403 there instead;
 * we stay lenient, but either way nothing changed.)
 */
export async function acceptFriendRequest(
	db: D1Database,
	accepterId: number,
	otherId: number
): Promise<RelationshipChange> {
	const existing = await findPair(db, accepterId, otherId)
	if (
		existing &&
		existing.requester_id === otherId &&
		existing.relationship_type === RelationshipType.FriendRequestSent
	) {
		const row = await upsertPair(db, otherId, accepterId, RelationshipType.Friend)
		return toChange(row, accepterId, otherId, true)
	}
	return existing
		? toChange(existing, accepterId, otherId, false)
		: { self: noneResponse(otherId), other: noneResponse(accepterId), changed: false }
}

/**
 * Directly make `requesterId` and `targetId` friends (no pending request step).
 */
export async function addFriend(
	db: D1Database,
	requesterId: number,
	targetId: number
): Promise<RelationshipChange> {
	const existing = await findPair(db, requesterId, targetId)
	if (existing && existing.relationship_type === RelationshipType.Friend) {
		return toChange(existing, requesterId, targetId, false)
	}
	const row = await upsertPair(db, requesterId, targetId, RelationshipType.Friend)
	return toChange(row, requesterId, targetId, true)
}

/**
 * Remove any relationship between the two players (unfriend / cancel request /
 * decline).
 *
 * The row is set to `None` rather than deleted, matching the reference server: the
 * per-player favorited/ignored/muted flags live on that row and must survive an
 * unfriending (someone you ignored stays ignored after you drop them as a friend).
 */
export async function removeFriend(
	db: D1Database,
	playerId: number,
	otherId: number
): Promise<RelationshipChange> {
	await db
		.prepare(
			`UPDATE relationship SET relationship_type = ?3
			 WHERE (requester_id = ?1 AND target_id = ?2) OR (requester_id = ?2 AND target_id = ?1)`
		)
		.bind(playerId, otherId, RelationshipType.None)
		.run()
	const updated = await findPair(db, playerId, otherId)
	return updated
		? toChange(updated, playerId, otherId, true)
		: { self: noneResponse(otherId), other: noneResponse(playerId), changed: true }
}

/** A per-player relationship flag — each is stored on the player's own side of the row. */
export type RelationshipFlag = 'favorited' | 'ignored' | 'muted'

/**
 * Set one of `playerId`'s per-side flags (favorited/ignored/muted) on their
 * relationship with `otherId`. These flags are stored per player, so the write
 * targets the caller's OWN side of the row — `requester_*` when the caller
 * initiated the pair, `target_*` otherwise. When the pair has no relationship yet
 * (you can ignore/mute someone you aren't friends with) a fresh `None` row is
 * created with the caller as requester. Returns the relationship from `playerId`'s
 * point of view. The `flag`/side names are a fixed union, so interpolating them
 * into the SQL is safe (same pattern as the room interaction toggles).
 */
export async function setRelationshipFlag(
	db: D1Database,
	playerId: number,
	otherId: number,
	flag: RelationshipFlag,
	value: boolean
): Promise<RelationshipResponse> {
	const existing = await findPair(db, playerId, otherId)
	const v = value ? 1 : 0
	if (!existing) {
		// New row: the caller is the requester, so the flag lives on the requester side.
		await db
			.prepare(
				`INSERT INTO relationship (requester_id, target_id, relationship_type, requester_${flag})
				 VALUES (?1, ?2, ?3, ?4)`
			)
			.bind(playerId, otherId, RelationshipType.None, v)
			.run()
	} else {
		// Update whichever side the caller is on, leaving the other player's flag alone.
		const side = existing.requester_id === playerId ? 'requester' : 'target'
		await db
			.prepare(
				`UPDATE relationship SET ${side}_${flag} = ?3
				 WHERE (requester_id = ?1 AND target_id = ?2) OR (requester_id = ?2 AND target_id = ?1)`
			)
			.bind(playerId, otherId, v)
			.run()
	}

	const updated = await findPair(db, playerId, otherId)
	return updated ? toResponse(updated, playerId) : noneResponse(otherId)
}
