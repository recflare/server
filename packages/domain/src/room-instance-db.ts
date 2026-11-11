/**
 * Room instances — live sessions of a room. Stored with the same JSON-blob pattern
 * as the rooms/accounts tables: the full instance is a JSON blob in `data`, and
 * every field is a SQLite generated (virtual) column extracted from it (snake_case
 * per the reference's `[Column]` names). `id` is a sequential key held in the blob.
 *
 * The `rooms` worker owns the schema (migrations/0004_room_instance.sql); the
 * `match` worker finds/creates instances here at matchmake time. This module is the
 * single source of truth for the helpers — both workers import it from
 * `@repo/domain`. Columns marked `[JsonIgnore]` in the reference (owner_account_id,
 * data_blob, allow_new_users, join_disabled) live in the blob but are dropped from
 * the client DTO (`toDto`) — as does `game_version`, which is this server's own
 * addition (migrations/0012_room_instance_version.sql) and keys matchmaking so that
 * only players on the same client build share an instance. It is stored as a BUILD —
 * the bare `YYYYMMDD` (`gameBuild`), never the client's `20250718.01` — so point releases
 * of one build share a session; migrations/0028_room_instance_build.sql stripped the
 * rows written before that held.
 */

import { countPlayersInInstance, gameBuild, getPlayerIdsByRoomInstance } from './presence-db'

/** Schema DDL (mirror of migrations/0004_room_instance.sql). */
export const ROOM_INSTANCE_SCHEMA_DDL: string[] = [
	`CREATE TABLE IF NOT EXISTS room_instance (
		data TEXT NOT NULL,
		id INTEGER GENERATED ALWAYS AS (json_extract(data, '$.roomInstanceId')) VIRTUAL,
		owner_account_id INTEGER GENERATED ALWAYS AS (json_extract(data, '$.ownerAccountId')) VIRTUAL,
		room_id INTEGER GENERATED ALWAYS AS (json_extract(data, '$.roomId')) VIRTUAL,
		sub_room_id INTEGER GENERATED ALWAYS AS (json_extract(data, '$.subRoomId')) VIRTUAL,
		location TEXT GENERATED ALWAYS AS (json_extract(data, '$.location')) VIRTUAL,
		data_blob TEXT GENERATED ALWAYS AS (json_extract(data, '$.dataBlob')) VIRTUAL,
		event_id INTEGER GENERATED ALWAYS AS (json_extract(data, '$.eventId')) VIRTUAL,
		photon_region_id TEXT GENERATED ALWAYS AS (json_extract(data, '$.photonRegionId')) VIRTUAL,
		photon_room_id TEXT GENERATED ALWAYS AS (json_extract(data, '$.photonRoomId')) VIRTUAL,
		name TEXT GENERATED ALWAYS AS (json_extract(data, '$.name')) VIRTUAL,
		max_capacity INTEGER GENERATED ALWAYS AS (json_extract(data, '$.maxCapacity')) VIRTUAL,
		is_full INTEGER GENERATED ALWAYS AS (json_extract(data, '$.isFull')) VIRTUAL,
		is_private INTEGER GENERATED ALWAYS AS (json_extract(data, '$.isPrivate')) VIRTUAL,
		is_in_progress INTEGER GENERATED ALWAYS AS (json_extract(data, '$.isInProgress')) VIRTUAL,
		room_code TEXT GENERATED ALWAYS AS (json_extract(data, '$.roomCode')) VIRTUAL,
		room_instance_type INTEGER GENERATED ALWAYS AS (json_extract(data, '$.roomInstanceType')) VIRTUAL,
		club_id INTEGER GENERATED ALWAYS AS (json_extract(data, '$.clubId')) VIRTUAL,
		encrypt_voice_chat INTEGER GENERATED ALWAYS AS (json_extract(data, '$.EncryptVoiceChat')) VIRTUAL,
		matchmaking_policy INTEGER GENERATED ALWAYS AS (json_extract(data, '$.matchmakingPolicy')) VIRTUAL,
		allow_new_users INTEGER GENERATED ALWAYS AS (json_extract(data, '$.allowNewUsers')) VIRTUAL,
		join_disabled INTEGER GENERATED ALWAYS AS (json_extract(data, '$.joinDisabled')) VIRTUAL,
		created_at TEXT GENERATED ALWAYS AS (json_extract(data, '$.createdAt')) VIRTUAL,
		game_version TEXT GENERATED ALWAYS AS (json_extract(data, '$.gameVersion')) VIRTUAL
	)`,
	`CREATE UNIQUE INDEX IF NOT EXISTS idx_room_instance_id ON room_instance (id)`,
	`CREATE UNIQUE INDEX IF NOT EXISTS idx_room_instance_photon_room_id ON room_instance (photon_room_id)`,
	`CREATE INDEX IF NOT EXISTS idx_room_instance_room_id ON room_instance (room_id)`,
]

/** Client-facing RoomInstance JSON (JsonPropertyName keys; JsonIgnore omitted). */
export interface RoomInstanceDto {
	roomInstanceId: number
	roomId: number
	subRoomId: number
	location: string
	eventId: number
	photonRegionId: string
	photonRoomId: string
	name: string
	maxCapacity: number
	isFull: boolean
	isPrivate: boolean
	isInProgress: boolean
	roomCode: string
	roomInstanceType: number
	clubId: number
	// PascalCase JSON key, per the reference's `[JsonPropertyName("EncryptVoiceChat")]`.
	EncryptVoiceChat: boolean
	matchmakingPolicy: number
	createdAt: string
}

/**
 * The owner's view of one live instance of their room (`match`:
 * `GET /room/:roomId/instances`). Deliberately NOT the client `RoomInstanceDto`:
 * it's a management listing, so it carries who is in there (`playerIds`, from live
 * presence) and drops the connection details (photon ids, data blob, room code) an
 * owner has no business reading for a session they aren't in.
 */
export interface RoomInstanceSummary {
	roomInstanceId: number
	roomId: number
	subRoomId: number
	isFull: boolean
	createdAt: string
	playerIds: number[]
}

/**
 * The full stored instance — the DTO plus the fields that live in the blob but never
 * reach the client: the reference's `[JsonIgnore]` columns, and `gameVersion`, which is
 * this server's own (see {@link NewRoomInstance.gameVersion}). Exported for the callers
 * that need one of those — {@link getStoredRoomInstance} is how they read it — since the
 * DTO deliberately drops them.
 */
export interface StoredRoomInstance extends RoomInstanceDto {
	ownerAccountId: number
	dataBlob: string
	allowNewUsers: boolean
	joinDisabled: boolean
	gameVersion: string
}

/** Fields for a new instance; `roomInstanceId` and `createdAt` are assigned here. */
export interface NewRoomInstance {
	ownerAccountId: number
	roomId: number
	photonRoomId: string
	subRoomId?: number
	location?: string
	dataBlob?: string
	eventId?: number
	photonRegionId?: string
	name?: string
	maxCapacity?: number
	isFull?: boolean
	isPrivate?: boolean
	isInProgress?: boolean
	roomCode?: string
	roomInstanceType?: number
	clubId?: number
	encryptVoiceChat?: boolean
	matchmakingPolicy?: number
	allowNewUsers?: boolean
	joinDisabled?: boolean
	/**
	 * The game build this session runs — the `rn.ver` of the player whose matchmake
	 * created it. Players only ever share an instance with others on the same build (see
	 * {@link getJoinableInstance}), because two builds in one Photon room disagree about
	 * how the scene and its objects serialize. Omitted (`''`) means "unknown", which
	 * matches nothing: rows written before the field existed are never joined into.
	 *
	 * Stored as the BUILD (`gameBuild`): a caller may hand over the client's full
	 * `20250718.01` and the row carries `20250718`, the same key every lookup here
	 * normalizes its argument to — a `.2` point release of that date joins this session.
	 */
	gameVersion?: string
}

/** Project a stored instance to the client DTO (JsonIgnore fields dropped). */
function toDto(s: StoredRoomInstance): RoomInstanceDto {
	return {
		roomInstanceId: s.roomInstanceId,
		roomId: s.roomId,
		subRoomId: s.subRoomId,
		location: s.location,
		eventId: s.eventId,
		photonRegionId: s.photonRegionId,
		photonRoomId: s.photonRoomId,
		name: s.name,
		maxCapacity: s.maxCapacity,
		isFull: s.isFull,
		isPrivate: s.isPrivate,
		isInProgress: s.isInProgress,
		roomCode: s.roomCode,
		roomInstanceType: s.roomInstanceType,
		clubId: s.clubId,
		EncryptVoiceChat: s.EncryptVoiceChat,
		matchmakingPolicy: s.matchmakingPolicy,
		createdAt: s.createdAt,
	}
}

const parse = (data: string): StoredRoomInstance => JSON.parse(data) as StoredRoomInstance

/**
 * Ids start high (above 1_000_000) so an instance id never collides with the
 * dorm's fixed roomInstanceId of 1 — the client keys room transitions off the id,
 * so a room instance that returned 1 would look like "still in the dorm".
 */
const ID_BASE = 1_000_000

/** Insert a new room instance, returning it as a client DTO. */
export async function createRoomInstance(
	db: D1Database,
	input: NewRoomInstance
): Promise<RoomInstanceDto> {
	const idRow = await db
		.prepare(`SELECT COALESCE(MAX(id), ${ID_BASE}) + 1 AS next FROM room_instance`)
		.first<{ next: number }>()
	const stored: StoredRoomInstance = {
		roomInstanceId: idRow?.next ?? ID_BASE + 1,
		ownerAccountId: input.ownerAccountId,
		roomId: input.roomId,
		subRoomId: input.subRoomId ?? 0,
		location: input.location ?? '',
		dataBlob: input.dataBlob ?? '',
		eventId: input.eventId ?? 0,
		photonRegionId: input.photonRegionId ?? 'us',
		photonRoomId: input.photonRoomId,
		name: input.name ?? '',
		maxCapacity: input.maxCapacity ?? 0,
		isFull: input.isFull ?? false,
		isPrivate: input.isPrivate ?? false,
		isInProgress: input.isInProgress ?? false,
		roomCode: input.roomCode ?? '',
		roomInstanceType: input.roomInstanceType ?? 0,
		clubId: input.clubId ?? 0,
		EncryptVoiceChat: input.encryptVoiceChat ?? false,
		matchmakingPolicy: input.matchmakingPolicy ?? 0,
		allowNewUsers: input.allowNewUsers ?? true,
		joinDisabled: input.joinDisabled ?? false,
		gameVersion: gameBuild(input.gameVersion) ?? '',
		createdAt: new Date().toISOString(),
	}
	await db
		.prepare('INSERT INTO room_instance (data) VALUES (?1)')
		.bind(JSON.stringify(stored))
		.run()
	return toDto(stored)
}

/** Look up a room instance by its id (roomInstanceId). */
export async function getRoomInstance(db: D1Database, id: number): Promise<RoomInstanceDto | null> {
	const row = await db
		.prepare('SELECT data FROM room_instance WHERE id = ?1')
		.bind(id)
		.first<{ data: string }>()
	return row ? toDto(parse(row.data)) : null
}

/**
 * The stored instance behind {@link getRoomInstance} — the same row, un-projected, so a
 * caller can read the fields the client DTO drops (`ownerAccountId`, `gameVersion`, the
 * join flags). Server-side only: never answer a client with this shape.
 */
export async function getStoredRoomInstance(
	db: D1Database,
	id: number
): Promise<StoredRoomInstance | null> {
	const row = await db
		.prepare('SELECT data FROM room_instance WHERE id = ?1')
		.bind(id)
		.first<{ data: string }>()
	if (!row) return null
	const stored = parse(row.data)
	// A row written before the build stamp existed has no `gameVersion` at all; it reads
	// as `''` (the "unknown build" the type promises) rather than as undefined, so a
	// caller comparing builds doesn't have to know the field is younger than the table.
	// Read as a build, like it is written: a row the backfill hasn't reached yet still
	// compares as its date.
	return { ...stored, gameVersion: gameBuild(stored.gameVersion) ?? '' }
}

/**
 * Flip an instance's `isInProgress` flag, rewriting the JSON blob (the generated
 * `is_in_progress` column follows it). Returns the updated DTO, or null when the
 * instance doesn't exist.
 */
export async function setRoomInstanceInProgress(
	db: D1Database,
	id: number,
	isInProgress: boolean
): Promise<RoomInstanceDto | null> {
	const row = await db
		.prepare('SELECT data FROM room_instance WHERE id = ?1')
		.bind(id)
		.first<{ data: string }>()
	if (!row) return null
	const stored = parse(row.data)
	stored.isInProgress = isInProgress
	await db
		.prepare('UPDATE room_instance SET data = ?1 WHERE id = ?2')
		.bind(JSON.stringify(stored), id)
		.run()
	return toDto(stored)
}

/**
 * Flip an instance's `isPrivate` flag, rewriting the JSON blob (the generated
 * `is_private` column follows it). Returns the updated DTO, or null when the
 * instance doesn't exist.
 *
 * Marking an instance private is what closes it to strangers: {@link
 * getJoinableInstance} only ever reuses instances with `is_private = 0`, so a public
 * matchmake stops landing new players here the moment this is set. Everyone already
 * inside stays — this shuts the door, it doesn't clear the room.
 */
export async function setRoomInstancePrivate(
	db: D1Database,
	id: number,
	isPrivate: boolean
): Promise<RoomInstanceDto | null> {
	const row = await db
		.prepare('SELECT data FROM room_instance WHERE id = ?1')
		.bind(id)
		.first<{ data: string }>()
	if (!row) return null
	const stored = parse(row.data)
	stored.isPrivate = isPrivate
	await db
		.prepare('UPDATE room_instance SET data = ?1 WHERE id = ?2')
		.bind(JSON.stringify(stored), id)
		.run()
	return toDto(stored)
}

/**
 * How matchmaking treats an instance (`matchmakingPolicy`). Set by whoever is standing
 * in it via `PUT /roominstance/:id/matchpolicy` (the `match` worker).
 */
export const MatchmakingPolicy = {
	/** Normal matchmaking — the instance accepts new players. */
	Default: 0,
	/** Deprioritise this instance; matchmaking sends players elsewhere when it can. */
	Avoid: 1,
	/** Exclude this instance from matchmaking entirely. */
	Ignore: 2,
} as const

/** Whether a number names a {@link MatchmakingPolicy}. */
export function isMatchmakingPolicy(value: number): boolean {
	return Object.values(MatchmakingPolicy).includes(value as 0 | 1 | 2)
}

/**
 * Set an instance's `matchmakingPolicy`, rewriting the JSON blob (the generated
 * `matchmaking_policy` column follows it). Returns the updated DTO, or null when the
 * instance doesn't exist.
 *
 * `Ignore` (2) takes the instance out of both reuse searches ({@link getJoinableInstance}
 * and {@link getSharedPrivateInstance}) — nobody matchmakes into it again until the policy
 * is lowered; `Avoid` (1) ranks it behind every `Default` instance. Direct joins (an
 * invite, a room code, the owner picking a session) are not matchmaking and are unaffected,
 * and everyone already inside stays.
 */
export async function setRoomInstanceMatchmakingPolicy(
	db: D1Database,
	id: number,
	policy: number
): Promise<RoomInstanceDto | null> {
	const row = await db
		.prepare('SELECT data FROM room_instance WHERE id = ?1')
		.bind(id)
		.first<{ data: string }>()
	if (!row) return null
	const stored = parse(row.data)
	stored.matchmakingPolicy = policy
	await db
		.prepare('UPDATE room_instance SET data = ?1 WHERE id = ?2')
		.bind(JSON.stringify(stored), id)
		.run()
	return toDto(stored)
}

/**
 * Recompute an instance's `isFull` flag from live match presence: full once the
 * number of players currently present in the instance reaches its `maxCapacity`
 * (capacity 0 — unset — is never full). Rewrites the JSON blob (the generated
 * `is_full` column follows it) only when the flag actually changes. Returns the
 * new fullness, or null when the instance has no row (e.g. the synthetic
 * dorm/orientation instances). Matchmaking calls this for the instance a player
 * enters and the one they leave, so the flag matchmaking selects on stays accurate.
 */
export async function refreshInstanceFullness(
	db: D1Database,
	roomInstanceId: number
): Promise<boolean | null> {
	const row = await db
		.prepare('SELECT data FROM room_instance WHERE id = ?1')
		.bind(roomInstanceId)
		.first<{ data: string }>()
	if (!row) return null
	const stored = parse(row.data)
	const count = await countPlayersInInstance(db, roomInstanceId)
	const isFull = stored.maxCapacity > 0 && count >= stored.maxCapacity
	if (stored.isFull !== isFull) {
		stored.isFull = isFull
		await db
			.prepare('UPDATE room_instance SET data = ?1 WHERE id = ?2')
			.bind(JSON.stringify(stored), roomInstanceId)
			.run()
	}
	return isFull
}

/**
 * Restamp the `maxCapacity` of every live instance of a subroom and recompute each one's
 * `isFull` against it. Called by the subroom settings write (`modifySubRoom`), which is
 * the ONE place a subroom's `MaxPlayers` changes after creation.
 *
 * An instance's `maxCapacity` is a copy of the subroom's cap taken when the instance was
 * created, and it is what everything enforces — the fullness recompute, the join
 * searches' `is_full` filter, the served DTO. It is a copy rather than a live read
 * because the instance is read on every matchmake, heartbeat and presence fan-out, and
 * a subroom lookup on each of those is D1 cost paid for a setting that changes rarely.
 * So the copy is invalidated at the write instead: without this, an owner who raised
 * the cap mid-session found the running instance still refusing players at the old
 * number until it was torn down. Returns the number of instances rewritten.
 */
export async function resyncInstanceCapacity(
	db: D1Database,
	roomId: number,
	subRoomId: number,
	maxCapacity: number,
	now = Math.floor(Date.now() / 1000)
): Promise<number> {
	const { results } = await db
		.prepare('SELECT data FROM room_instance WHERE room_id = ?1 AND sub_room_id = ?2')
		.bind(roomId, subRoomId)
		.all<{ data: string }>()
	let rewritten = 0
	for (const row of results) {
		const stored = parse(row.data)
		const count = await countPlayersInInstance(db, stored.roomInstanceId, now)
		const isFull = maxCapacity > 0 && count >= maxCapacity
		if (stored.maxCapacity === maxCapacity && stored.isFull === isFull) continue
		stored.maxCapacity = maxCapacity
		stored.isFull = isFull
		await db
			.prepare('UPDATE room_instance SET data = ?1 WHERE id = ?2')
			.bind(JSON.stringify(stored), stored.roomInstanceId)
			.run()
		rewritten++
	}
	return rewritten
}

/**
 * How long (s) a room instance is left alone after it's created, even with nobody in
 * it. Every path that creates an instance writes the creator's presence in the same
 * request, so an empty instance is normally already abandoned — but the two writes
 * aren't atomic, and a cron firing in between would delete the instance the player is
 * being handed. One cron interval of slack closes that window.
 */
export const EMPTY_INSTANCE_GRACE_SECONDS = 300

/**
 * Delete room instances with no presence rows pointing at them — the sessions left
 * behind when every player quit or timed out. Nothing reuses them (matchmaking would
 * happily hand a joiner an instance whose Photon room has long since emptied), so
 * they're pure accumulation: one row per room visit, forever.
 *
 * Emptiness is a plain "are there any rows" test — expiry is not consulted, because
 * {@link deleteExpiredPresence} is what retires a lapsed row and must have run first.
 * Run out of that order and a crashed player's stale row keeps their instance alive
 * until the following sweep.
 *
 * Instances younger than `graceSeconds` are skipped (see
 * {@link EMPTY_INSTANCE_GRACE_SECONDS}). Nothing else is: a DORM is swept like any
 * other room once its owner leaves it empty, and gets a fresh row — a new Photon room —
 * the next time they walk in. Its persistence is the dorm ROOM and the scene saved in it,
 * which live on the room, not on a session of it; the row here is worth no more than an
 * empty Photon room nobody can be pointed at.
 *
 * Note that a deleted id is not retired: {@link createRoomInstance} allocates
 * `MAX(id) + 1`, so sweeping the newest row hands its number to the next instance
 * created. Nothing may treat an instance id as a durable reference to one session.
 *
 * Returns the ids deleted.
 */
export async function deleteEmptyRoomInstances(
	db: D1Database,
	graceSeconds = EMPTY_INSTANCE_GRACE_SECONDS,
	now = Date.now()
): Promise<number[]> {
	// `createdAt` is an ISO-8601 UTC timestamp, which sorts lexicographically in the
	// same order it sorts chronologically — so a string compare is a time compare.
	const createdBefore = new Date(now - graceSeconds * 1000).toISOString()
	const { results } = await db
		.prepare(
			`DELETE FROM room_instance
			 WHERE created_at < ?1
			   AND NOT EXISTS (
			     SELECT 1 FROM presence WHERE presence.room_instance_id = room_instance.id
			   )
			 RETURNING json_extract(data, '$.roomInstanceId') AS id`
		)
		.bind(createdBefore)
		.all<{ id: number }>()
	return results.map((r) => r.id)
}

/**
 * Delete EVERY instance of a room, occupied or not — the staff "Clear instances" button
 * for a room whose sessions are stuck. Presence is left alone: a player still in a
 * deleted instance keeps their row until it expires or they move, and their next
 * matchmake lands them in a fresh instance.
 *
 * Returns the ids deleted.
 */
export async function deleteRoomInstancesByRoom(db: D1Database, roomId: number): Promise<number[]> {
	const { results } = await db
		.prepare(
			`DELETE FROM room_instance WHERE room_id = ?1
			 RETURNING json_extract(data, '$.roomInstanceId') AS id`
		)
		.bind(roomId)
		.all<{ id: number }>()
	return results.map((r) => r.id)
}

/**
 * Take every instance of a room out of matchmaking, ahead of deleting it — set to `Ignore`,
 * which both instance searches skip — and return their ids. The instance clear does this
 * BEFORE re-matchmaking the players out of them: deleted first, their ids could be handed
 * straight back out ({@link createRoomInstance} allocates `MAX(id) + 1`), and a player
 * "moved" to an instance with the id they were already in looks to the client like no move.
 */
export async function retireRoomInstances(db: D1Database, roomId: number): Promise<number[]> {
	const { results } = await db
		.prepare(
			`UPDATE room_instance SET data = json_set(data, '$.matchmakingPolicy', ?2)
			 WHERE room_id = ?1
			 RETURNING json_extract(data, '$.roomInstanceId') AS id`
		)
		.bind(roomId, MatchmakingPolicy.Ignore)
		.all<{ id: number }>()
	return results.map((r) => r.id)
}

/** Delete the named instances; returns the ids actually deleted. */
export async function deleteRoomInstances(db: D1Database, ids: number[]): Promise<number[]> {
	if (ids.length === 0) return []
	const { results } = await db
		.prepare(
			`DELETE FROM room_instance WHERE id IN (SELECT value FROM json_each(?1))
			 RETURNING json_extract(data, '$.roomInstanceId') AS id`
		)
		.bind(JSON.stringify(ids))
		.all<{ id: number }>()
	return results.map((r) => r.id)
}

/**
 * The most popular joinable public instance of a room (not private, not full, joins
 * enabled, not already in progress unless `joinInProgress`, not set to `Ignore`) that is running `gameVersion`,
 * or null when there's none to join. Used by matchmaking to reuse an existing instance
 * before creating a new one. An instance set to `Avoid` is a candidate, but ranks behind
 * every `Default` one however busy it is (see {@link MatchmakingPolicy}).
 *
 * Within a policy (and the not-started-before-in-progress tier below), the instance with
 * the most LIVE players — unexpired `presence` rows — wins, and the oldest breaks a tie.
 * Players are gathered where the people are rather than spread across whichever instance
 * happens to be oldest; `is_full` caps it, so the busiest fills and the next busiest takes
 * the overflow. A player who wants a quieter one changes instance, which re-matchmakes
 * with their current instance excluded and so lands them in the next one down.
 *
 * The build is part of the search, not a detail of it — which is why it's a required
 * argument rather than an optional filter a caller can forget. Two builds in one Photon
 * room disagree about how the scene and its objects serialize, so a player is only ever
 * placed with others on their own build; a room busy with players on another build looks
 * empty here and the caller creates a fresh instance beside them. Instances written
 * before the field existed carry no version and so match nobody — they are joined into
 * again only after they empty out and the sweep retires them.
 *
 * A room's subrooms are separate places, so `subRoomId` scopes the search: joining
 * subroom 35 must never drop you into a live instance of subroom 1. Omitting it
 * matches any subroom.
 *
 * `excludeInstanceId` drops one instance from the search — the one the player is
 * already in. Matchmaking must land them in a *different* instance (the client keys
 * the room transition off a changing `roomInstanceId`), so re-matchmaking into the
 * only instance of a room they're already in must skip it and fall through to a
 * fresh instance rather than hand back the same id. A no-op when they're not in this
 * room; instance ids are globally unique.
 *
 * `gameVersion` is matched as a BUILD ({@link gameBuild}): `20250718.01` and `20250718.2`
 * both find the `20250718` session, which is what the rows store.
 *
 * `eventId` scopes the search to one player event's sessions, and the default 0 to the
 * room's ordinary ones — the two never mix. An event matchmake only reuses an instance
 * stamped with that event, so its guests gather in the event's session rather than
 * scattering into whatever public instance the room has open; and a plain room matchmake
 * never lands in an event's session, which for a private event is its guest list's alone.
 *
 * `joinInProgress` admits instances whose game has already started — set when the
 * subroom says `SupportsJoinInProgress`, so a player drops into a running round instead
 * of being given an empty instance beside it. A not-yet-started instance still ranks
 * ahead of a running one (within the same matchmaking policy), so a waiting lobby fills
 * before anyone is put mid-game.
 */
export async function getJoinableInstance(
	db: D1Database,
	roomId: number,
	gameVersion: string,
	subRoomId?: number,
	excludeInstanceId?: number,
	eventId = 0,
	joinInProgress = false,
	now = Math.floor(Date.now() / 1000)
): Promise<RoomInstanceDto | null> {
	const binds: Array<number | string> = [roomId, gameBuild(gameVersion) ?? '', eventId, now]
	const filters: string[] = []
	if (subRoomId !== undefined) {
		binds.push(subRoomId)
		filters.push(`AND sub_room_id = ?${binds.length}`)
	}
	if (excludeInstanceId !== undefined) {
		binds.push(excludeInstanceId)
		filters.push(`AND id != ?${binds.length}`)
	}
	const row = await db
		.prepare(
			`SELECT data FROM room_instance
			 WHERE room_id = ?1 AND game_version = ?2 AND COALESCE(event_id, 0) = ?3
			   AND is_private = 0 AND is_full = 0 AND join_disabled = 0
			   ${joinInProgress ? '' : 'AND is_in_progress = 0'}
			   AND matchmaking_policy != ${MatchmakingPolicy.Ignore} ${filters.join(' ')}
			 ORDER BY matchmaking_policy, is_in_progress, (
			   SELECT COUNT(*) FROM presence
			    WHERE presence.room_instance_id = room_instance.id AND presence.expires_at > ?4
			 ) DESC, id
			 LIMIT 1`
		)
		.bind(...binds)
		.first<{ data: string }>()
	return row ? toDto(parse(row.data)) : null
}

/**
 * The ONE private session of an unpublished room — the instance of `subRoomId` running
 * `gameVersion` that the room's people share — or null when nobody has opened one. The
 * complement of {@link getJoinableInstance}: that search only ever reuses PUBLIC instances,
 * and an unpublished room has none (every instance of it is private, see the match
 * worker's `resolveRoomInstance`), so without this each of the room's people who
 * matchmaked in got a private instance of their own and never found each other — a
 * co-owner answering the creator's "come look at this" landed in an empty copy of the
 * room beside them.
 *
 * Scoped like the public search: by subroom (separate places) and by build (a session
 * belongs to one client version; another build's session reads as nothing to join and the
 * caller opens one beside it). Full instances and ones set to `Ignore` are skipped — there
 * is nothing to put a player into, or its people asked that nobody be matched in — and
 * `excludeInstanceId` drops the one the caller is already standing in,
 * because the client keys its room transition off a CHANGING instance id and hangs when
 * handed the same one back.
 *
 * That exclusion is also why the search prefers the instance with the most live players
 * in it over the oldest: a creator re-entering the subroom they're in is moved to a fresh
 * instance, and the one they left sits empty for the sweep's grace window. A co-owner
 * arriving in the meantime must land with the creator, not in the abandoned shell.
 */
export async function getSharedPrivateInstance(
	db: D1Database,
	roomId: number,
	gameVersion: string,
	subRoomId: number,
	excludeInstanceId?: number,
	now = Math.floor(Date.now() / 1000)
): Promise<RoomInstanceDto | null> {
	const binds: Array<number | string> = [roomId, gameBuild(gameVersion) ?? '', subRoomId, now]
	let exclude = ''
	if (excludeInstanceId !== undefined) {
		binds.push(excludeInstanceId)
		exclude = `AND id != ?${binds.length}`
	}
	const row = await db
		.prepare(
			`SELECT data FROM room_instance
			 WHERE room_id = ?1 AND game_version = ?2 AND sub_room_id = ?3
			   AND is_private = 1 AND is_full = 0
			   AND matchmaking_policy != ${MatchmakingPolicy.Ignore} ${exclude}
			 ORDER BY (
			   SELECT COUNT(*) FROM presence
			    WHERE presence.room_instance_id = room_instance.id AND presence.expires_at > ?4
			 ) DESC, id
			 LIMIT 1`
		)
		.bind(...binds)
		.first<{ data: string }>()
	return row ? toDto(parse(row.data)) : null
}

/**
 * All instances of a given room — every build's, unless `gameVersion` scopes it to the
 * sessions running one (matched as a build, like the other lookups). An instance belongs
 * to a single client build (see {@link getJoinableInstance}), so a caller looking for one
 * to place a player in wants the scoped form; a caller counting or listing what's live
 * wants them all.
 */
export async function getRoomInstancesByRoom(
	db: D1Database,
	roomId: number,
	gameVersion?: string
): Promise<RoomInstanceDto[]> {
	const { results } = await db
		.prepare(
			`SELECT data FROM room_instance WHERE room_id = ?1${
				gameVersion === undefined ? '' : ' AND game_version = ?2'
			}`
		)
		.bind(...(gameVersion === undefined ? [roomId] : [roomId, gameBuild(gameVersion) ?? '']))
		.all<{ data: string }>()
	return results.map((r) => toDto(parse(r.data)))
}

/**
 * A room's instances as the owner's management listing sees them — the
 * {@link RoomInstanceSummary} projection, each with the players currently standing
 * in it. Presence is read once for the whole room (one grouped query), so this stays
 * two reads regardless of how many instances are live; an instance nobody is in
 * (everyone timed out, or it was just created) gets an empty `playerIds`.
 */
export async function getRoomInstanceSummariesByRoom(
	db: D1Database,
	roomId: number
): Promise<RoomInstanceSummary[]> {
	const [{ results }, playersByInstance] = await Promise.all([
		db
			.prepare('SELECT data FROM room_instance WHERE room_id = ?1 ORDER BY id')
			.bind(roomId)
			.all<{ data: string }>(),
		getPlayerIdsByRoomInstance(db, roomId),
	])
	return results.map((r) => {
		const s = parse(r.data)
		return {
			roomInstanceId: s.roomInstanceId,
			roomId: s.roomId,
			subRoomId: s.subRoomId,
			isFull: s.isFull,
			createdAt: s.createdAt,
			playerIds: playersByInstance.get(s.roomInstanceId) ?? [],
		}
	})
}
