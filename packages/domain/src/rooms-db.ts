/**
 * Room storage on the shared `recflare` D1 database. Each room is a single JSON
 * blob in the `data` column; queryable fields (RoomId, Name, CreatorAccountId,
 * IsDorm) are SQLite generated (virtual) columns extracted from that JSON and
 * indexed. This keeps the room shape flexible while still allowing fast lookups
 * by id/name/creator — the same JSON-blob pattern `accounts-db` uses.
 *
 * `ROOM_SCHEMA_DDL` mirrors the head schema after all migrations (`0001_init.sql`
 * created the table as `rooms`; `0005_rename_room.sql` renamed it to `room`); the
 * room data is seeded from `apps/rooms/static/ImportRooms.json` by
 * `migrations/0002_import_rooms.sql`. Tests apply `ROOM_SCHEMA_DDL` then seed the
 * imported rooms directly.
 *
 * This module is the single source of truth for the helpers: the `rooms` worker
 * (which owns the schema/migrations) uses the read/write set; the `match` worker
 * uses the room lookups plus the dorm helpers; the `api` worker binds the same
 * database read-only and uses `getRoomById`. Each imports the subset it needs.
 */

import { Accessibility, Role } from './enums'
import { countPlayersByRoom } from './presence-db'

/** Schema DDL (mirror of the head migration schema, sans the seed INSERT). */
export const ROOM_SCHEMA_DDL: string[] = [
	`CREATE TABLE IF NOT EXISTS room (
		data TEXT NOT NULL,
		room_id INTEGER GENERATED ALWAYS AS (json_extract(data, '$.RoomId')) VIRTUAL,
		name TEXT GENERATED ALWAYS AS (json_extract(data, '$.Name')) VIRTUAL,
		name_lower TEXT GENERATED ALWAYS AS (lower(json_extract(data, '$.Name'))) VIRTUAL,
		creator_account_id INTEGER GENERATED ALWAYS AS (json_extract(data, '$.CreatorAccountId')) VIRTUAL,
		is_dorm INTEGER GENERATED ALWAYS AS (json_extract(data, '$.IsDorm')) VIRTUAL,
		-- Lifetime visit counter (migrations/0011_room_visits.sql, which appends it here):
		-- bumped once per successful matchmake into the room by {@link recordRoomVisit},
		-- and served as the room's \`Stats.VisitCount\`. A real column rather than a field
		-- in the blob so a visit is one atomic UPDATE that can't lose a concurrent
		-- read-modify-write of the whole room.
		visits INTEGER NOT NULL DEFAULT 0
	)`,
	`CREATE UNIQUE INDEX IF NOT EXISTS idx_rooms_room_id ON room (room_id)`,
	`CREATE INDEX IF NOT EXISTS idx_rooms_name_lower ON room (name_lower)`,
	`CREATE INDEX IF NOT EXISTS idx_rooms_creator ON room (creator_account_id)`,
	// Per-player interaction state with a room (cheered/favorited + last visit).
	// One row per (player, room); cheer/favorite are toggled in place.
	`CREATE TABLE IF NOT EXISTS interaction (
		player_id INTEGER NOT NULL,
		room_id INTEGER NOT NULL,
		cheered INTEGER NOT NULL DEFAULT 0,
		favorited INTEGER NOT NULL DEFAULT 0,
		last_visited_at TEXT,
		PRIMARY KEY (player_id, room_id)
	)`,
	// Per-room player bans (migrations/0010_room_ban.sql). One row per (room, player),
	// so re-banning someone already banned updates their row rather than appending.
	// `ban_mask` is the client's `banMask` field kept verbatim — its meaning isn't known
	// yet (the client sends 0), so nothing interprets it.
	//
	// Deliberately NOT in the room's `data` blob: that blob is served to the client
	// verbatim as the room, and a ban list is not something every reader of a room
	// should receive.
	`CREATE TABLE IF NOT EXISTS room_ban (
		room_id INTEGER NOT NULL,
		banned_player_id INTEGER NOT NULL,
		ban_mask INTEGER NOT NULL DEFAULT 0,
		banned_by_account_id INTEGER NOT NULL,
		created_at TEXT NOT NULL,
		PRIMARY KEY (room_id, banned_player_id)
	)`,
	`CREATE INDEX IF NOT EXISTS idx_room_ban_player ON room_ban (banned_player_id)`,
]

/**
 * Subroom schema DDL (mirror of migrations/0007_subrooms.sql). Subrooms are
 * first-class entities with their own globally-unique, autoincrementing id — the
 * original game mints `SubRoomId` from a single sequence, not per-room — so they
 * live in their own table rather than inside the room JSON blob. `data` holds the
 * rest of the subroom's client shape; `sub_room_id`/`room_id` are the authoritative
 * columns (re-injected over `data` on read). Rooms re-embed their `SubRooms` array
 * on read (see {@link getRoomById}); nothing persists SubRooms back into the room blob.
 */
export const SUBROOM_SCHEMA_DDL: string[] = [
	`CREATE TABLE IF NOT EXISTS subroom (
		sub_room_id INTEGER PRIMARY KEY AUTOINCREMENT,
		room_id INTEGER NOT NULL,
		data TEXT NOT NULL,
		current_save_id INTEGER,
		staged_save_id INTEGER
	)`,
	`CREATE INDEX IF NOT EXISTS idx_subroom_room ON subroom (room_id)`,
	// Room saves (migrations/0008_subroom_saves.sql). A save is its own entity with a
	// globally-unique, autoincrementing `SubRoomDataSaveId` — the same reason subrooms got
	// their own table in 0007. It HAS to be global because a subroom points at saves by
	// bare id: `current_save_id` is the live/published save the loader downloads,
	// `staged_save_id` the creator's unpublished one. Per-subroom numbering would make
	// every subroom's first save id 1 and those pointers ambiguous.
	//
	// `data` holds the save's client shape minus its two id fields; the columns are
	// authoritative and are re-injected on read, exactly how `subroom` treats its own ids.
	// A subroom's `CurrentSave` is inlined from `current_save_id` on every read and is
	// never stored in the subroom blob.
	//
	// Part of this DDL rather than its own export: reading a subroom joins this table, so
	// applying one without the other yields a schema that can't serve a room.
	`CREATE TABLE IF NOT EXISTS subroom_save (
		sub_room_data_save_id INTEGER PRIMARY KEY AUTOINCREMENT,
		sub_room_id INTEGER NOT NULL,
		data TEXT NOT NULL
	)`,
	`CREATE INDEX IF NOT EXISTS idx_subroom_save_sub ON subroom_save (sub_room_id)`,
	// Per-subroom permission overrides (migrations/0009_subroom_permissions.sql). The room
	// owner's permission table for one subroom, keyed by (permission, role) — that pair is
	// what the client's PUT addresses, and re-sending it overwrites the stored row rather
	// than appending a second one.
	//
	// A row IS an override, which is why the client's `Override` flag is not a column: it's
	// the checkbox next to the permission, so clearing it deletes the row and the pair falls
	// back to its default. `value` is the client's string, stored verbatim.
	//
	// Deliberately NOT in the subroom's `data` blob: that blob is served to the client
	// verbatim as part of the room, and these overrides are read on one path only
	// (`GET /photon_access_token`, where they overwrite the matching default entries).
	`CREATE TABLE IF NOT EXISTS subroom_permission (
		sub_room_id INTEGER NOT NULL,
		permission TEXT NOT NULL,
		role INTEGER NOT NULL,
		type INTEGER NOT NULL DEFAULT 0,
		value TEXT NOT NULL,
		PRIMARY KEY (sub_room_id, permission, role)
	)`,
]

/** A stored room — the parsed JSON blob (full client-facing room response). */
export type Room = Record<string, unknown>

/** A room role assignment (the client's RoomRole shape). */
interface RoomRole {
	AccountId: number
	Role: number
	LastChangedByAccountId: number | null
	InvitedRole: number
}

/**
 * Room roles that confer owner-level management of a room: Creator (255) and
 * CoOwner (30). The reference gates its room-admin actions on this set. (Host and
 * Moderator are lower tiers and are deliberately excluded.)
 */
const MANAGE_ROLES: ReadonlySet<number> = new Set([Role.Creator, Role.CoOwner])

/**
 * Whether an account may manage a room — its creator, or the holder of a
 * Creator/CoOwner role on the room's `Roles`. This is the owner-or-co-owner gate
 * the reference applies to room-admin actions (editing room data, viewing a room's
 * live instances). Shared so the `rooms` and `match` workers apply the same check
 * rather than each re-deriving the role set.
 */
export function canManageRoom(room: Room, accountId: number): boolean {
	if (room.CreatorAccountId === accountId) return true
	const roles = Array.isArray(room.Roles) ? (room.Roles as RoomRole[]) : []
	return roles.some((r) => r.AccountId === accountId && MANAGE_ROLES.has(r.Role))
}

/** A player banned from a room (a `room_ban` row). */
export interface RoomBan {
	RoomId: number
	BannedPlayerId: number
	/** The client's `banMask`, stored verbatim — its meaning isn't known yet. */
	BanMask: number
	BannedByAccountId: number
	CreatedAt: string
}

interface RoomBanRow {
	room_id: number
	banned_player_id: number
	ban_mask: number
	banned_by_account_id: number
	created_at: string
}

const toRoomBan = (row: RoomBanRow): RoomBan => ({
	RoomId: row.room_id,
	BannedPlayerId: row.banned_player_id,
	BanMask: row.ban_mask,
	BannedByAccountId: row.banned_by_account_id,
	CreatedAt: row.created_at,
})

/**
 * Ban a player from a room, returning the stored ban. One row per (room, player):
 * re-banning someone already banned rewrites their row with the new mask and issuer
 * rather than appending a second one, so the call is idempotent.
 */
export async function banPlayerFromRoom(
	db: D1Database,
	roomId: number,
	bannedPlayerId: number,
	banMask: number,
	bannedByAccountId: number
): Promise<RoomBan> {
	const row = await db
		.prepare(
			`INSERT INTO room_ban (room_id, banned_player_id, ban_mask, banned_by_account_id, created_at)
			 VALUES (?1, ?2, ?3, ?4, ?5)
			 ON CONFLICT(room_id, banned_player_id) DO UPDATE SET
				 ban_mask = ?3, banned_by_account_id = ?4, created_at = ?5
			 RETURNING *`
		)
		.bind(roomId, bannedPlayerId, banMask, bannedByAccountId, new Date().toISOString())
		.first<RoomBanRow>()
	// RETURNING always yields the upserted row.
	return toRoomBan(row!)
}

/**
 * Lift a player's ban on a room, returning the ban that was removed — or null when
 * they weren't banned, which lets the caller tell a real unban from a no-op.
 */
export async function unbanPlayerFromRoom(
	db: D1Database,
	roomId: number,
	bannedPlayerId: number
): Promise<RoomBan | null> {
	const row = await db
		.prepare('DELETE FROM room_ban WHERE room_id = ?1 AND banned_player_id = ?2 RETURNING *')
		.bind(roomId, bannedPlayerId)
		.first<RoomBanRow>()
	return row ? toRoomBan(row) : null
}

/** Everyone banned from a room, most recently banned first. */
export async function getRoomBans(db: D1Database, roomId: number): Promise<RoomBan[]> {
	const { results } = await db
		.prepare('SELECT * FROM room_ban WHERE room_id = ?1 ORDER BY created_at DESC')
		.bind(roomId)
		.all<RoomBanRow>()
	return results.map(toRoomBan)
}

/** Whether a player is banned from a room. */
export async function isPlayerBannedFromRoom(
	db: D1Database,
	roomId: number,
	playerId: number
): Promise<boolean> {
	const row = await db
		.prepare('SELECT 1 AS hit FROM room_ban WHERE room_id = ?1 AND banned_player_id = ?2')
		.bind(roomId, playerId)
		.first<{ hit: number }>()
	return row !== null
}

/**
 * Clone an existing room into a new one owned by `accountId`. Copies the source
 * room's content (scene/subrooms/settings), assigning a fresh RoomId, the given
 * name, and the new owner. The clone starts with an empty tag set — the source's
 * tags (including the `base` template tag) do not carry over, so the owner tags the
 * clone from scratch — `IsRRO` is cleared so the client doesn't render a virtual
 * "RRO" tag on it, and it starts PRIVATE rather than inheriting the source's
 * visibility. Returns the new room, or null when the source isn't in D1 or disallows
 * cloning.
 */
export async function cloneRoom(
	db: D1Database,
	sourceRoomId: number,
	name: string,
	accountId: number
): Promise<Room | null> {
	const source = await getRoomById(db, sourceRoomId)
	if (!source || source.CloningAllowed === false) return null

	const row = await db
		.prepare('SELECT MAX(room_id) AS maxId FROM room')
		.first<{ maxId: number | null }>()
	const newRoomId = (row?.maxId ?? 0) + 1

	// Ownership is reset to the cloner — the source room's Roles (its creator and
	// any co-owners, e.g. the seeded base-room roles for accounts 1/2) must NOT
	// carry over, or the clone would still list the template's owner as owner.
	const roles: RoomRole[] = [
		{ AccountId: accountId, Role: Role.Creator, LastChangedByAccountId: null, InvitedRole: 0 },
	]

	const cloned: Room = {
		...source,
		RoomId: newRoomId,
		Name: name,
		CreatorAccountId: accountId,
		IsDorm: false,
		// Start fresh: drop every tag the source carried (including `base`).
		Tags: [],
		// A user clone is not a Rec Room Original — clear the inherited flag, or the
		// client renders a virtual "RRO" tag on the clone.
		IsRRO: false,
		// A brand-new room is unpublished: the owner publishes it by setting the room's
		// accessibility. Inheriting the source's would put the clone straight into the
		// public feeds (hot/search/recommendations/similar all key on Accessibility === 1)
		// the moment it was made — every clone of a PUBLIC source, template or player room.
		Accessibility: Accessibility.Private,
		Roles: roles,
		// A fresh room has no engagement of its own — don't inherit the source's counters
		// (the derived ones are recomputed per read, but the clone is returned as-is here).
		Stats: storedStats(source.Stats),
		CreatedAt: new Date().toISOString(),
	}

	// serializeRoom drops the hydrated SubRooms from the blob; the clone's subrooms are
	// inserted into the subroom table below with fresh globally-unique ids.
	await db.prepare('INSERT INTO room (data) VALUES (?1)').bind(serializeRoom(cloned)).run()
	const sourceSubRooms = Array.isArray(source.SubRooms) ? (source.SubRooms as SubRoom[]) : []
	const clonedSubRooms: SubRoom[] = []
	for (const sub of sourceSubRooms) {
		clonedSubRooms.push(await insertSubRoom(db, newRoomId, { ...sub, CreatorAccountId: accountId }))
	}
	cloned.SubRooms = clonedSubRooms
	// Inherited from the (parsed) source in practice; defaulted here too so a clone is
	// never the one room shape missing them.
	attachRoomDtoDefaults(cloned)
	return cloned
}

/** Set a room's Description in place (the caller is responsible for the owner check). */
export async function setRoomDescription(
	db: D1Database,
	roomId: number,
	description: string
): Promise<void> {
	await db
		.prepare("UPDATE room SET data = json_set(data, '$.Description', ?2) WHERE room_id = ?1")
		.bind(roomId, description)
		.run()
}

/** Set a room's Name in place (the caller checks ownership + name uniqueness first). */
export async function setRoomName(db: D1Database, roomId: number, name: string): Promise<void> {
	await db
		.prepare("UPDATE room SET data = json_set(data, '$.Name', ?2) WHERE room_id = ?1")
		.bind(roomId, name)
		.run()
}

/** Set a room's ImageName in place (the caller is responsible for the owner check). */
export async function setRoomImage(
	db: D1Database,
	roomId: number,
	imageName: string
): Promise<void> {
	await db
		.prepare("UPDATE room SET data = json_set(data, '$.ImageName', ?2) WHERE room_id = ?1")
		.bind(roomId, imageName)
		.run()
}

/**
 * Merge a set of top-level fields into a room's JSON blob and write it back. Used by
 * the room-settings mutations whose values include booleans (cloning, platform
 * restrictions) — rewriting the whole blob preserves proper JSON booleans, whereas a
 * `json_set` bind would store `true`/`false` as `1`/`0`. The caller supplies the
 * already-loaded, permission-checked room. Returns the updated room.
 */
export async function updateRoomFields(
	db: D1Database,
	roomId: number,
	room: Room,
	patch: Record<string, unknown>
): Promise<Room> {
	const updated: Room = { ...room, ...patch }
	await db
		.prepare('UPDATE room SET data = ?2 WHERE room_id = ?1')
		.bind(roomId, serializeRoom(updated))
		.run()
	return updated
}

/**
 * Set a target account's room `Role` — updating their existing `Roles` entry or
 * appending a new one — and stamp `LastChangedByAccountId` with the editor. The
 * caller supplies the already-loaded room (after its owner/co-owner check) to avoid
 * a re-read; the whole room JSON is rewritten. Returns the updated room.
 */
export async function setRoomRole(
	db: D1Database,
	roomId: number,
	targetAccountId: number,
	role: number,
	changedByAccountId: number,
	room: Room
): Promise<Room> {
	const roles = Array.isArray(room.Roles) ? (room.Roles as RoomRole[]) : []
	const existing = roles.find((r) => r.AccountId === targetAccountId)
	if (existing) {
		existing.Role = role
		existing.LastChangedByAccountId = changedByAccountId
	} else {
		roles.push({
			AccountId: targetAccountId,
			Role: role,
			LastChangedByAccountId: changedByAccountId,
			InvitedRole: 0,
		})
	}
	const updated: Room = { ...room, Roles: roles }
	await db
		.prepare('UPDATE room SET data = ?2 WHERE room_id = ?1')
		.bind(roomId, serializeRoom(updated))
		.run()
	return updated
}

/**
 * Mutually-exclusive "main" room tags. The UI presents these as radio buttons, so
 * setting one clears any other main tag. Compared case-insensitively.
 */
const MAIN_TAGS = new Set(['pvp', 'quest', 'game', 'hangout', 'art'])

/**
 * Add a user tag (`Type: 0`) to a room's `Tags`, skipping it when already present
 * (case-insensitive). The caller supplies the already-loaded room (owner-checked)
 * to avoid a re-read; the whole room JSON is rewritten. Returns the updated room.
 */
export async function toggleRoomTag(
	db: D1Database,
	roomId: number,
	room: Room,
	tag: string
): Promise<Room> {
	const tags = Array.isArray(room.Tags) ? (room.Tags as Array<Record<string, unknown>>) : []
	const lower = tag.toLowerCase()
	const tagLower = (t: Record<string, unknown>): string => String(t?.Tag).toLowerCase()
	const existing = tags.findIndex((t) => tagLower(t) === lower)

	// The client has no delete/patch endpoint — the same call toggles a tag: remove
	// it if already present, add it otherwise. Adding a main tag is a radio pick, so
	// it also clears any other main tag already set.
	let nextTags: Array<Record<string, unknown>>
	if (existing !== -1) {
		nextTags = tags.filter((_, i) => i !== existing)
	} else if (MAIN_TAGS.has(lower)) {
		nextTags = [...tags.filter((t) => !MAIN_TAGS.has(tagLower(t))), { Tag: tag, Type: 0 }]
	} else {
		nextTags = [...tags, { Tag: tag, Type: 0 }]
	}

	const updated: Room = { ...room, Tags: nextTags }
	await db
		.prepare('UPDATE room SET data = ?2 WHERE room_id = ?1')
		.bind(roomId, serializeRoom(updated))
		.run()
	return updated
}

/** Find a subroom (by SubRoomId) inside an already-hydrated room's `SubRooms`, or undefined. */
export function findSubRoom(room: Room, subRoomId: number): SubRoom | undefined {
	const subRooms = Array.isArray(room.SubRooms) ? (room.SubRooms as SubRoom[]) : []
	return subRooms.find((s) => s.SubRoomId === subRoomId)
}

/** Fields from the client's room-save POST body. */
export interface SaveSubRoomDataInput {
	/** Uploaded blob key for this subroom's scene data (becomes `CurrentSave.DataBlob`). */
	subRoomDataFilename?: string
	/** `SubRoomData.Hash` — echoed back as the save response's `dataBlobHash`. */
	subRoomDataHash?: string
	/** Uploaded blob key for the room-level METADATA blob (a separate upload). */
	roomDataFilename?: string
	/**
	 * The save comment — a description of THIS revision, typed into the client's save box.
	 * It belongs to the save (and shows up in the `…/saves` history); it is not the room's
	 * public description, which only `PUT /rooms/:id/description` sets.
	 */
	description?: string
	persistenceVersion?: number
	inventionUsage?: string
	/** Optional baked-asset id; emitted on the save only when present. */
	unityAssetId?: string
	/**
	 * The client's `AutoPublish`. True publishes the save outright (the author wants it
	 * live now); false/absent stages it for a manual `publish_save`. Dorms ignore this and
	 * always publish.
	 */
	autoPublish?: boolean
}

/**
 * A subroom's `CurrentSave` — the `SubRoomDataSave` the client reads to find the scene
 * data blob to download. The loader looks ONLY here: a subroom with no `CurrentSave`
 * loads nothing, no matter what the (legacy, flat) `DataBlob` field says.
 */
export type SubRoomDataSave = Record<string, unknown>

/**
 * The scene-data blob key the client should download for a subroom. Prefers the
 * authoritative `CurrentSave.DataBlob` and falls back to the flat `DataBlob` that
 * subrooms written before `CurrentSave` existed (and the `0001_init.sql` dorm seed)
 * still carry. Shared so the `match` and `auth` room-instance payloads resolve the
 * blob the same way the client's own loader does.
 */
export function subRoomDataBlob(sub: SubRoom | undefined | null): string {
	const save = sub?.CurrentSave
	if (save && typeof save === 'object') {
		const blob = (save as SubRoomDataSave).DataBlob
		if (typeof blob === 'string' && blob !== '') return blob
	}
	return typeof sub?.DataBlob === 'string' ? sub.DataBlob : ''
}

/** Fields that vary between a real save and one reconstructed from the legacy shape. */
interface BuildSaveInput {
	subRoomId: unknown
	dataBlob: string
	dataBlobHash: string | null
	persistenceVersion: number
	savedByAccountId: unknown
	description: string
	createdAt: string
	unityAssetId?: string
}

/**
 * Build a `SubRoomDataSave` in the shape the client parses — the reference's `MapSave`
 * projection. The four array fields are always empty (we neither resolve nor record
 * referenced Unity assets) but must be PRESENT, and `UnityAssetId` is emitted only when
 * the save actually carried one, exactly as the reference does. There is deliberately no
 * `DataBlobHash`: it is commented out of the reference DTO and absent from its output.
 *
 * `SavedOnPlatform`/`SavedOnDeviceClass` are 0 — the reference fills them from the saving
 * player's live platform/device, which the save request doesn't carry and we don't track.
 *
 * Shared by the save path and the legacy-shape reconstruction so the two can't drift.
 */
function buildSubRoomSave(input: BuildSaveInput): SubRoomDataSave {
	const save: SubRoomDataSave = {
		UnitySubAssets: [],
		ReferencedUnityAssets: [],
		SubRoomId: input.subRoomId,
		DataBlob: input.dataBlob,
		// The client sends `SubRoomData.Hash` (usually null); the room-save response echoes
		// it as `dataBlobHash`. One observed room payload carries it on `CurrentSave` and
		// another omits it, so storing it and letting it ride along is the safe reading.
		DataBlobHash: input.dataBlobHash,
		ReferencedUnityAssetIds: [],
		PersistenceVersion: input.persistenceVersion,
		OMVersion: 0,
		UgcSubVersion: 0,
		SavedByAccountId: input.savedByAccountId,
		SavedOnPlatform: 0,
		SavedOnDeviceClass: 0,
		Description: input.description,
		Tags: [],
		ModerationState: 0,
		CreatedAt: input.createdAt,
	}
	if (input.unityAssetId) save.UnityAssetId = input.unityAssetId
	return save
}

/**
 * Build a save row from a subroom stored in the pre-`CurrentSave` shape, where the blob
 * key sat in the flat `DataBlob`/`DataSavedAt`/`PersistenceVersion` fields. Those
 * subrooms hold real saved content the client cannot see (it reads `CurrentSave` only),
 * so they get a save of their own rather than reading as never-saved. Mirrors backfill 2
 * of migration 0008 — keep the two in sync.
 *
 * Returns null when there is genuinely nothing saved, the honest answer for a fresh
 * subroom.
 */
function legacySubRoomSave(sub: SubRoom): SubRoomDataSave | null {
	const blob = sub.DataBlob
	if (typeof blob !== 'string' || blob === '') return null
	const savedAt = typeof sub.DataSavedAt === 'string' ? sub.DataSavedAt : new Date(0).toISOString()
	return buildSubRoomSave({
		subRoomId: sub.SubRoomId,
		dataBlob: blob,
		dataBlobHash: null,
		persistenceVersion: typeof sub.PersistenceVersion === 'number' ? sub.PersistenceVersion : 0,
		// The legacy shape never recorded who saved; the subroom's creator is the best
		// available answer (the save path is owner/co-owner gated).
		savedByAccountId: sub.CreatorAccountId ?? null,
		description: '',
		createdAt: savedAt,
	})
}

/**
 * Persist a room-save against a specific subroom. Everything the save carries belongs to
 * that subroom's revision — nothing is written to the room. Returns the updated
 * (hydrated) room AND the save that was just created — the route answers with both — or
 * null when the room or subroom doesn't exist.
 *
 * Whether the save goes live is the client's call: `AutoPublish: true` publishes it
 * outright, otherwise it becomes the subroom's `staged_save_id` with the live
 * `current_save_id` untouched, so what players load doesn't change until the room's
 * creator publishes (see {@link publishSubRoomSave}). Dorms always publish — they have
 * no publish flow in the client.
 */
export async function saveSubRoomData(
	db: D1Database,
	roomId: number,
	subRoomId: number,
	accountId: number,
	input: SaveSubRoomDataInput
): Promise<{ room: Room; save: SubRoomDataSave } | null> {
	const room = await getRoomById(db, roomId)
	if (!room) return null
	// Read off the already-hydrated room rather than re-querying the subroom and its
	// save — getRoomById has both, and this path is write-heavy enough already.
	const sub = findSubRoom(room, subRoomId)
	if (!sub) return null

	// Populate the subroom's creator on first save — it starts null, and the
	// client NREs on a null CreatorAccountId. Only the owner reaches this path.
	if (sub.CreatorAccountId == null) sub.CreatorAccountId = accountId

	// Append a new save row. The blob the loader downloads lives on the save — a subroom
	// whose current_save_id resolves to nothing loads nothing — so this never touches the
	// flat DataBlob field. Previous saves stay in the table as history.
	//
	// A staged save carries forward from the previous STAGED one when there is one, so a
	// creator's second edit builds on their first rather than on what's live.
	const staged =
		typeof sub.StagedSubRoomDataSaveId === 'number'
			? await getSubRoomSaveById(db, subRoomId, sub.StagedSubRoomDataSaveId)
			: null
	const previous =
		staged ??
		(sub.CurrentSave && typeof sub.CurrentSave === 'object'
			? (sub.CurrentSave as SubRoomDataSave)
			: undefined)
	const priorVersion = previous?.PersistenceVersion
	const priorBlob = previous?.DataBlob
	const save = await insertSubRoomSave(
		db,
		subRoomId,
		buildSubRoomSave({
			subRoomId,
			// A save that carries no new blob (e.g. a description-only save) keeps the one
			// the subroom already loads from.
			dataBlob: input.subRoomDataFilename ?? (typeof priorBlob === 'string' ? priorBlob : ''),
			dataBlobHash: input.subRoomDataHash ?? null,
			persistenceVersion:
				input.persistenceVersion ?? (typeof priorVersion === 'number' ? priorVersion : 0),
			savedByAccountId: accountId,
			// The save comment — empty string, not null, when the save carries none (the
			// reference's `roomDesc ?? ""`).
			description: input.description ?? '',
			createdAt: new Date().toISOString(),
			unityAssetId: input.unityAssetId,
		})
	)
	const saveId = Number(save.SubRoomDataSaveId)
	if (input.roomDataFilename) sub.RoomDataBlob = input.roomDataFilename
	sub.DataSavedAt = new Date().toISOString()
	if (input.persistenceVersion !== undefined) sub.PersistenceVersion = input.persistenceVersion
	if (input.inventionUsage !== undefined) sub.InventionUsage = input.inventionUsage

	// Nothing here touches the ROOM. A room save is a revision of one SUBROOM, and every
	// field it carries describes that revision: `Description` is the save comment shown in
	// the `…/saves` history, `PersistenceVersion` and `InventionUsage` describe the scene
	// just saved. They used to be copied onto the room as well, which meant each save
	// silently replaced the room's public description with the save comment. The room's own
	// fields are edited through their own routes (`PUT /rooms/:id/description` and
	// friends), so the room row is not rewritten here at all.

	// Publish outright when the client asked to (`AutoPublish`), or for a dorm — a dorm is
	// the player's own private space with no publish step in the client, so staging one
	// would leave their edits permanently invisible. Otherwise stage it and wait for
	// `publish_save`. One round trip for the rest of the save.
	const publishNow = input.autoPublish === true || room.IsDorm === true
	await db.batch([
		publishNow
			? db
					.prepare(
						'UPDATE subroom SET current_save_id = ?2, staged_save_id = NULL WHERE sub_room_id = ?1'
					)
					.bind(subRoomId, saveId)
			: db
					.prepare('UPDATE subroom SET staged_save_id = ?2 WHERE sub_room_id = ?1')
					.bind(subRoomId, saveId),
		db
			.prepare('UPDATE subroom SET data = ?2 WHERE sub_room_id = ?1')
			.bind(subRoomId, serializeSubRoom(sub, roomId)),
	])

	// Re-hydrate so the returned room reflects the just-saved subroom.
	await attachSubRooms(db, [room])
	return { room, save }
}

/**
 * Publish one of a subroom's saves by id: make it the `current_save_id` players load.
 * This is the manual step every non-dorm room save waits on ({@link saveSubRoomData}
 * only stages). Because it takes an explicit id it doubles as restore-a-save — the id
 * can be any save in the subroom's history, not just the staged one.
 *
 * The staging slot is cleared only when the save being published IS the staged one, so
 * restoring an older version doesn't silently discard newer unpublished work.
 *
 * The id is looked up scoped to the subroom, so one subroom can't publish another's save
 * (ids are globally unique, so an unscoped lookup would happily resolve).
 *
 * Returns the updated (hydrated) room, or a reason: `not_found` (no such room/subroom) /
 * `unknown_save` (no such save on this subroom).
 */
export async function publishSubRoomSave(
	db: D1Database,
	roomId: number,
	subRoomId: number,
	saveId: number
): Promise<{ ok: true; room: Room } | { ok: false; reason: 'not_found' | 'unknown_save' }> {
	const sub = await getSubRoom(db, roomId, subRoomId)
	if (!sub) return { ok: false, reason: 'not_found' }
	if (!(await getSubRoomSaveById(db, subRoomId, saveId))) {
		return { ok: false, reason: 'unknown_save' }
	}

	await db
		.prepare(
			`UPDATE subroom SET current_save_id = ?2,
			   staged_save_id = CASE WHEN staged_save_id = ?2 THEN NULL ELSE staged_save_id END
			 WHERE sub_room_id = ?1`
		)
		.bind(subRoomId, saveId)
		.run()

	const room = await getRoomById(db, roomId)
	if (!room) return { ok: false, reason: 'not_found' }
	return { ok: true, room }
}

/** Fields from the client's subroom `modify` form (each applied only when supplied). */
export interface ModifySubRoomInput {
	name?: string
	accessibility?: number
	maxPlayers?: number
}

/**
 * Modify a subroom's settings in place — its Name, Accessibility, and MaxPlayers
 * (the fields the client's subroom `modify` form carries). Only the supplied fields
 * are changed; the subroom row is updated in the `subroom` table. Returns the updated
 * (hydrated) room, or null when the room or subroom doesn't exist.
 */
export async function modifySubRoom(
	db: D1Database,
	roomId: number,
	subRoomId: number,
	input: ModifySubRoomInput
): Promise<Room | null> {
	const sub = await getSubRoom(db, roomId, subRoomId)
	if (!sub) return null

	if (input.name !== undefined) sub.Name = input.name
	if (input.accessibility !== undefined) sub.Accessibility = input.accessibility
	if (input.maxPlayers !== undefined) sub.MaxPlayers = input.maxPlayers
	await updateSubRoom(db, sub)

	return getRoomById(db, roomId)
}

/**
 * Clone an existing subroom into a new subroom of the same room, owned by
 * `accountId`. The copy keeps the source's scene/settings (and its saved data
 * blobs, so it loads identical content) but gets a fresh globally-unique SubRoomId
 * minted from the `subroom` table's autoincrement sequence. Returns the updated
 * (hydrated) room and the new subroom, or null when the room or source subroom
 * doesn't exist.
 */
export async function cloneSubRoom(
	db: D1Database,
	roomId: number,
	subRoomId: number,
	accountId: number
): Promise<{ room: Room; subRoom: SubRoom } | null> {
	const source = await getSubRoom(db, roomId, subRoomId)
	if (!source) return null

	const subRoom = await insertSubRoom(db, roomId, { ...source, CreatorAccountId: accountId })
	const room = await getRoomById(db, roomId)
	if (!room) return null
	return { room, subRoom }
}

/** Fallback scene, used only when a room has no existing subroom to inherit from. */
const DEFAULT_SUBROOM_SCENE = '76d98498-60a1-430c-ab76-b54a29b7a163'

/**
 * The scene a brand-new subroom inherits: the room's own first (existing) subroom —
 * lowest SubRoomId — read from the subroom table. Falls back to the base sandbox scene
 * only when the room has no subrooms yet.
 */
async function baseSubRoomScene(db: D1Database, roomId: number): Promise<string> {
	const row = await db
		.prepare('SELECT data FROM subroom WHERE room_id = ?1 ORDER BY sub_room_id LIMIT 1')
		.bind(roomId)
		.first<{ data: string }>()
	const scene = row ? (JSON.parse(row.data) as SubRoom).UnitySceneId : undefined
	return typeof scene === 'string' ? scene : DEFAULT_SUBROOM_SCENE
}

/**
 * Create a new (empty) subroom in a room, owned by `accountId` and named `name`. It
 * inherits the room's existing subroom scene (see {@link baseSubRoomScene}) with a clean
 * save, and gets a fresh globally-unique SubRoomId. Returns the updated (hydrated) room
 * and the new subroom, or null when the room doesn't exist.
 */
export async function createSubRoom(
	db: D1Database,
	roomId: number,
	accountId: number,
	name: string
): Promise<{ room: Room; subRoom: SubRoom } | null> {
	const room = await getRoomById(db, roomId)
	if (!room) return null

	const subRoom = await insertSubRoom(db, roomId, {
		Name: name,
		CreatorAccountId: accountId,
		UnitySceneId: await baseSubRoomScene(db, roomId),
		MaxPlayers: 4,
		Accessibility: Accessibility.Unlisted,
		IsSandbox: true,
		LastModeratedSaveModerationState: 0,
		ShouldAutoStageSaves: true,
		// Nothing saved yet — the first room save mints one and points current_save_id
		// at it. Until then the subroom reads with `CurrentSave: null`.
	})
	// Refresh the hydrated SubRooms so the returned room includes the one just inserted.
	await attachSubRooms(db, [room])
	return { room, subRoom }
}

/**
 * Delete a subroom from a room. Refuses to remove a room's only subroom (that would
 * leave it with no scene to load). Any saved-data blob the subroom pointed at is left in
 * R2 (like {@link deleteRoom} leaves a room's images). Returns the updated (hydrated)
 * room on success, or a reason: `not_found` (no such subroom) / `last_subroom`.
 */
export async function deleteSubRoom(
	db: D1Database,
	roomId: number,
	subRoomId: number
): Promise<{ ok: true; room: Room } | { ok: false; reason: 'not_found' | 'last_subroom' }> {
	const subRooms = await getSubRooms(db, roomId)
	if (!subRooms.some((s) => s.SubRoomId === subRoomId)) return { ok: false, reason: 'not_found' }
	if (subRooms.length <= 1) return { ok: false, reason: 'last_subroom' }

	await db.batch([
		db
			.prepare('DELETE FROM subroom WHERE room_id = ?1 AND sub_room_id = ?2')
			.bind(roomId, subRoomId),
		// The saves go with it — nothing can reference them once the subroom is gone.
		// The blobs they point at are left in R2, like a deleted room's images.
		db.prepare('DELETE FROM subroom_save WHERE sub_room_id = ?1').bind(subRoomId),
		// So do its permission overrides — subroom ids are minted from one global
		// sequence, but leaving orphans would still be dead rows nothing can reach.
		db.prepare('DELETE FROM subroom_permission WHERE sub_room_id = ?1').bind(subRoomId),
	])

	const room = await getRoomById(db, roomId)
	if (!room) return { ok: false, reason: 'not_found' }
	return { ok: true, room }
}

interface RoomRow {
	data: string
	visits: number
}

/**
 * The columns every room read selects. `visits` is authoritative for the room's
 * `Stats.VisitCount` (the blob keeps it at 0 — see {@link storedStats}), so it has to
 * come back with the blob on every read; a join aliases them (`r.data AS data`).
 */
const ROOM_COLUMNS = 'data, visits'

/**
 * Two keys on the client's room DTO that nothing here stores, defaulted on every read so
 * the key is PRESENT rather than absent — the seed blobs and every room written since
 * predate them, so they can't come from the data:
 *
 * - `BoostCount` — how many boosts the room is carrying. No boost feature exists here, so
 *   it is 0 for every room.
 * - `CurrentSnapshotId` — the room's published snapshot. Nothing takes snapshots, so it is
 *   null, which is also what the reference serves for a room that has none.
 *
 * Defaulted rather than assigned, so a stored value wins if either is ever really written
 * (a blob keeps whatever `serializeRoom` last put in it).
 */
function attachRoomDtoDefaults(room: Room): void {
	room.BoostCount ??= 0
	room.CurrentSnapshotId ??= null
}

/**
 * Parse a room row: the stored blob with the counters the columns own folded back in.
 * `visits` is a real column, so a room read straight from the DB carries the live count.
 */
const parseRow = (row: RoomRow): Room => {
	const room = JSON.parse(row.data) as Room
	room.Stats = { ...storedStats(room.Stats), VisitCount: row.visits ?? 0 }
	attachRoomDtoDefaults(room)
	return room
}

const parseOne = (row: RoomRow | null): Room | null => (row ? parseRow(row) : null)
const parseAll = (rows: RoomRow[]): Room[] => rows.map(parseRow)

// ---- Subrooms -------------------------------------------------------------
// Subrooms are their own table (globally-unique autoincrement `sub_room_id`); a
// room's `SubRooms` array is reconstructed on read and never stored in the room blob.

/** A stored subroom — the parsed JSON blob (its client shape). */
export type SubRoom = Record<string, unknown>

interface SubRoomRow {
	sub_room_id: number
	room_id: number
	data: string
	current_save_id: number | null
	staged_save_id: number | null
}

/** The columns every subroom read needs — the blob plus its two save pointers. */
const SUBROOM_COLUMNS = 'sub_room_id, room_id, data, current_save_id, staged_save_id'

/**
 * Materialize a subroom row into its client shape, with the columns authoritative.
 * `CurrentSave` is left undefined here and filled in by {@link attachCurrentSaves} — it
 * lives in `subroom_save`, and resolving it per row would be a query each. Callers must
 * go through the helpers below so the key is never missing: the client reads the scene
 * blob from `CurrentSave` and nowhere else, so a subroom without one loads nothing.
 */
const parseSubRoomRow = (row: SubRoomRow): SubRoom => ({
	...(JSON.parse(row.data) as SubRoom),
	SubRoomId: row.sub_room_id,
	RoomId: row.room_id,
	// Served from the column, not the blob — the creator's unpublished save (unused for
	// now, but the client expects the key present).
	StagedSubRoomDataSaveId: row.staged_save_id,
})

/**
 * Serialize a subroom for storage — drop the id/room columns and the save fields that
 * are columns or their own table, so the blob never holds a stale copy of either.
 */
const serializeSubRoom = (sub: SubRoom, roomId: number): string => {
	const {
		SubRoomId: _id,
		RoomId: _room,
		CurrentSave: _save,
		StagedSubRoomDataSaveId: _staged,
		...rest
	} = sub
	return JSON.stringify({ ...rest, RoomId: roomId })
}

/**
 * Serialize a room for a full-blob write, dropping any hydrated `SubRooms` so it never
 * gets denormalized back into the room JSON (subrooms are the `subroom` table's job) and
 * zeroing the derived engagement counters (those are the `interaction` table's job — see
 * {@link attachStats}), so a write can't bake a snapshot of them into the blob.
 */
const serializeRoom = (room: Room): string => {
	const { SubRooms: _subRooms, Stats: stats, ...rest } = room
	return JSON.stringify({ ...rest, Stats: storedStats(stats) })
}

/**
 * Fill in each subroom's `CurrentSave` from `subroom_save`, in ONE query for the whole
 * batch. Every subroom ends up with the key present — null when it points at no save
 * (never saved) or the pointer dangles — because the client's loader reads it directly.
 *
 * `rows` must line up with `subs` positionally; the pointer lives on the row, not the
 * parsed blob.
 */
async function attachCurrentSaves(
	db: D1Database,
	subs: SubRoom[],
	rows: SubRoomRow[]
): Promise<void> {
	const saveIds = [...new Set(rows.map((r) => r.current_save_id).filter((id) => id != null))]
	const byId = new Map<number, SubRoomDataSave>()
	if (saveIds.length > 0) {
		const placeholders = saveIds.map((_, i) => `?${i + 1}`).join(',')
		const { results } = await db
			.prepare(
				`SELECT sub_room_data_save_id, sub_room_id, data FROM subroom_save
				 WHERE sub_room_data_save_id IN (${placeholders})`
			)
			.bind(...saveIds)
			.all<SubRoomSaveRow>()
		for (const r of results) byId.set(r.sub_room_data_save_id, parseSubRoomSaveRow(r))
	}
	subs.forEach((sub, i) => {
		const id = rows[i]!.current_save_id
		sub.CurrentSave = id == null ? null : (byId.get(id) ?? null)
	})
}

/** Parse subroom rows and resolve their `CurrentSave` in one batched query. */
async function parseSubRoomRows(db: D1Database, rows: SubRoomRow[]): Promise<SubRoom[]> {
	const subs = rows.map(parseSubRoomRow)
	await attachCurrentSaves(db, subs, rows)
	return subs
}

/** Attach each room's `SubRooms` array from the subroom table (one batched query). */
async function attachSubRooms(db: D1Database, rooms: Room[]): Promise<void> {
	const ids = rooms.map((r) => Number(r.RoomId)).filter((n) => Number.isFinite(n))
	if (ids.length === 0) {
		for (const room of rooms) room.SubRooms = []
		return
	}
	const placeholders = ids.map((_, i) => `?${i + 1}`).join(',')
	const { results } = await db
		.prepare(
			`SELECT ${SUBROOM_COLUMNS} FROM subroom
			 WHERE room_id IN (${placeholders}) ORDER BY sub_room_id`
		)
		.bind(...ids)
		.all<SubRoomRow>()
	const subs = await parseSubRoomRows(db, results)
	const byRoom = new Map<number, SubRoom[]>()
	results.forEach((r, i) => {
		const list = byRoom.get(r.room_id) ?? []
		list.push(subs[i]!)
		byRoom.set(r.room_id, list)
	})
	for (const room of rooms) room.SubRooms = byRoom.get(Number(room.RoomId)) ?? []
}

// ---- Room stats -----------------------------------------------------------
// A room's cheer/favorite counters are DERIVED from the `interaction` table rather than
// stored: they're recomputed on every read, so a cheer shows up immediately and the
// counts can't drift from the per-player rows they're made of. The blob keeps them at 0
// (see {@link serializeRoom}).
//
// `VisitCount` is neither stored in the blob nor derived: it's the `room.visits` column,
// incremented by {@link recordRoomVisit} on each matchmake and read back with the blob
// (see {@link parseRow}). It can't be derived the way cheers are — a visit leaves no
// per-player row to count — and it can't live in the blob, where a read-modify-write of
// the whole room would drop concurrent visits. `VisitorCount` (distinct visitors) is
// still left as the blob has it: `interaction.last_visited_at` is only stamped by the
// cheer/favorite toggles, so counting those rows would report cheerers as visitors.

/** One room's derived engagement counters (the aggregate maps below key these by RoomId). */
export interface RoomStats {
	CheerCount: number
	FavoriteCount: number
}

interface RoomStatsRow {
	room_id: number
	cheers: number
	favorites: number
}

/** The counters a room starts life with (and the shape the client expects). */
const ZERO_STATS = { CheerCount: 0, FavoriteCount: 0, VisitorCount: 0, VisitCount: 0 }

/** D1 caps a query at 100 bound parameters, and a feed page can carry more ids than that. */
const STATS_ID_LIMIT = 90

/** A room's RoomId, or 0 for a blob without one. */
const roomIdOf = (room: Room): number => (typeof room.RoomId === 'number' ? room.RoomId : 0)

/**
 * The `Stats` object to persist: whatever the room carried, with the counters the
 * columns/tables own back at 0 so the blob never holds a stale copy of them.
 */
function storedStats(stats: unknown): Record<string, unknown> {
	const stored =
		typeof stats === 'object' && stats !== null ? (stats as Record<string, unknown>) : {}
	return { ...ZERO_STATS, ...stored, CheerCount: 0, FavoriteCount: 0, VisitCount: 0 }
}

/**
 * Count one visit to a room — the `match` worker calls this on every successful
 * matchmake (see its `enterRoom`), which is the only way a player ever lands in a room.
 * A blind `visits = visits + 1` UPDATE: it's the whole write, so simultaneous visitors
 * can't clobber each other, and an unknown room id simply matches nothing.
 */
export async function recordRoomVisit(db: D1Database, roomId: number): Promise<void> {
	await db.prepare('UPDATE room SET visits = visits + 1 WHERE room_id = ?1').bind(roomId).run()
}

/**
 * Cheer/favorite counts per room, aggregated from `interaction` in ONE grouped query.
 * Restricted to `roomIds` when given (a feed page), otherwise covering every room —
 * which is also what a page too large to bind gets, since scanning the whole table is
 * cheaper than splitting the query. Rooms nobody has interacted with are absent.
 */
export async function getRoomStats(
	db: D1Database,
	roomIds?: number[]
): Promise<Map<number, RoomStats>> {
	const byRoom = new Map<number, RoomStats>()
	if (roomIds && roomIds.length === 0) return byRoom
	const ids = roomIds && roomIds.length <= STATS_ID_LIMIT ? roomIds : []
	const where =
		ids.length > 0 ? `WHERE room_id IN (${ids.map((_, i) => `?${i + 1}`).join(',')})` : ''
	const { results } = await db
		.prepare(
			`SELECT room_id, SUM(cheered) AS cheers, SUM(favorited) AS favorites
			 FROM interaction ${where} GROUP BY room_id`
		)
		.bind(...ids)
		.all<RoomStatsRow>()
	for (const r of results) {
		byRoom.set(r.room_id, { CheerCount: r.cheers ?? 0, FavoriteCount: r.favorites ?? 0 })
	}
	return byRoom
}

/**
 * Overwrite each room's derived counters from the interaction table, in one query for
 * the whole batch. Callers that already aggregated (the feeds rank by these counts, so
 * they need them before paging) pass their map in rather than paying for a second query.
 */
async function attachStats(
	db: D1Database,
	rooms: Room[],
	stats?: Map<number, RoomStats>
): Promise<void> {
	if (rooms.length === 0) return
	const byRoom = stats ?? (await getRoomStats(db, [...new Set(rooms.map(roomIdOf))]))
	for (const room of rooms) {
		const counts = byRoom.get(roomIdOf(room))
		// `storedStats` zeroes VisitCount (the blob doesn't own it), so carry over the
		// value `parseRow` folded in from the `visits` column rather than losing it here.
		const stats = (room.Stats ?? {}) as Record<string, unknown>
		room.Stats = {
			...storedStats(stats),
			VisitCount: typeof stats.VisitCount === 'number' ? stats.VisitCount : 0,
			CheerCount: counts?.CheerCount ?? 0,
			FavoriteCount: counts?.FavoriteCount ?? 0,
		}
	}
}

/** Hydrate a single room's `SubRooms` and derived `Stats` (no-op for null). */
async function hydrateRoom(db: D1Database, room: Room | null): Promise<Room | null> {
	if (room) await hydrateRooms(db, [room])
	return room
}

/** Hydrate many rooms' `SubRooms` and derived `Stats` (one batched query each). */
async function hydrateRooms(
	db: D1Database,
	rooms: Room[],
	stats?: Map<number, RoomStats>
): Promise<Room[]> {
	await Promise.all([attachSubRooms(db, rooms), attachStats(db, rooms, stats)])
	return rooms
}

/** A single subroom of a room (columns authoritative), or null if it doesn't exist. */
export async function getSubRoom(
	db: D1Database,
	roomId: number,
	subRoomId: number
): Promise<SubRoom | null> {
	const row = await db
		.prepare(`SELECT ${SUBROOM_COLUMNS} FROM subroom WHERE room_id = ?1 AND sub_room_id = ?2`)
		.bind(roomId, subRoomId)
		.first<SubRoomRow>()
	if (!row) return null
	return (await parseSubRoomRows(db, [row]))[0]!
}

/** All of a room's subrooms, ordered by SubRoomId. */
export async function getSubRooms(db: D1Database, roomId: number): Promise<SubRoom[]> {
	const { results } = await db
		.prepare(`SELECT ${SUBROOM_COLUMNS} FROM subroom WHERE room_id = ?1 ORDER BY sub_room_id`)
		.bind(roomId)
		.all<SubRoomRow>()
	return parseSubRoomRows(db, results)
}

// ---- Subroom saves --------------------------------------------------------

interface SubRoomSaveRow {
	sub_room_data_save_id: number
	sub_room_id: number
	data: string
}

/** Materialize a save row, with its two id columns authoritative over the blob. */
const parseSubRoomSaveRow = (row: SubRoomSaveRow): SubRoomDataSave => ({
	...(JSON.parse(row.data) as SubRoomDataSave),
	SubRoomDataSaveId: row.sub_room_data_save_id,
	SubRoomId: row.sub_room_id,
})

/** Serialize a save for storage — the id columns own those two fields, not the blob. */
const serializeSubRoomSave = (save: SubRoomDataSave): string => {
	const { SubRoomDataSaveId: _id, SubRoomId: _sub, ...rest } = save
	return JSON.stringify(rest)
}

/**
 * Insert a save for a subroom, minting a fresh globally-unique `SubRoomDataSaveId` from
 * the table's autoincrement sequence. Returns the stored save with its new id.
 */
async function insertSubRoomSave(
	db: D1Database,
	subRoomId: number,
	save: SubRoomDataSave
): Promise<SubRoomDataSave> {
	const row = await db
		.prepare(
			'INSERT INTO subroom_save (sub_room_id, data) VALUES (?1, ?2) RETURNING sub_room_data_save_id'
		)
		.bind(subRoomId, serializeSubRoomSave(save))
		.first<{ sub_room_data_save_id: number }>()
	return { ...save, SubRoomDataSaveId: row!.sub_room_data_save_id, SubRoomId: subRoomId }
}

/**
 * A subroom's save history, newest first. Unlike the old inline model this is real
 * history: every save is its own row and none are overwritten.
 */
export async function getSubRoomSaves(
	db: D1Database,
	subRoomId: number
): Promise<SubRoomDataSave[]> {
	const { results } = await db
		.prepare(
			`SELECT sub_room_data_save_id, sub_room_id, data FROM subroom_save
			 WHERE sub_room_id = ?1 ORDER BY sub_room_data_save_id DESC`
		)
		.bind(subRoomId)
		.all<SubRoomSaveRow>()
	return results.map(parseSubRoomSaveRow)
}

/**
 * A single save by its globally-unique id, scoped to the subroom that owns it (the
 * restore-a-save lookup). Null when the id is unknown or belongs to another subroom.
 */
export async function getSubRoomSaveById(
	db: D1Database,
	subRoomId: number,
	saveId: number
): Promise<SubRoomDataSave | null> {
	const row = await db
		.prepare(
			`SELECT sub_room_data_save_id, sub_room_id, data FROM subroom_save
			 WHERE sub_room_data_save_id = ?1 AND sub_room_id = ?2`
		)
		.bind(saveId, subRoomId)
		.first<SubRoomSaveRow>()
	return row ? parseSubRoomSaveRow(row) : null
}

// ---- Subroom permissions --------------------------------------------------

/**
 * One entry of a subroom's permission table, in the client's own shape. `Value` is a
 * STRING, not a boolean — usually `"True"`/`"False"`, but a permission whose UI isn't a
 * True/False picker carries something else, so it is stored and served verbatim. `Role`
 * is the tier the entry applies to (0 = everyone, 30 = co-owner, …). `Permission` + `Role`
 * identify an entry: the client PUTs the pair it wants changed, and the same pair
 * overwrites the matching default in the photon access token's table.
 *
 * `Override` is the row's own existence, not data: the client's UI is a checkbox ("is
 * this permission overridden in this subroom?") plus a True/False picker for the value.
 * Unchecking it means "fall back to the default", so an entry arriving with
 * `Override: false` DELETES the stored row rather than storing anything. Every stored
 * entry is therefore an override, and reads always serve `Override: true`.
 */
export interface RoomPermission {
	Permission: string
	Role: number
	Override: boolean
	Type: number
	Value: string
}

interface RoomPermissionRow {
	permission: string
	role: number
	type: number
	value: string
}

const toRoomPermission = (row: RoomPermissionRow): RoomPermission => ({
	// A stored row IS the override — the table holds nothing else (see RoomPermission).
	Override: true,
	Permission: row.permission,
	Role: row.role,
	Type: row.type,
	Value: row.value,
})

/** The permission columns, in the order the read/copy statements use. */
const PERMISSION_COLUMNS = 'permission, role, type, value'

/**
 * A subroom's stored permission overrides, in the order they were first set. Empty for a
 * subroom whose owner has never overridden a permission — the photon access token then
 * serves its defaults untouched.
 */
export async function getSubRoomPermissions(
	db: D1Database,
	subRoomId: number
): Promise<RoomPermission[]> {
	const { results } = await db
		.prepare(
			`SELECT ${PERMISSION_COLUMNS} FROM subroom_permission WHERE sub_room_id = ?1 ORDER BY rowid`
		)
		.bind(subRoomId)
		.all<RoomPermissionRow>()
	return results.map(toRoomPermission)
}

/**
 * Apply permission changes to a subroom, keyed by (`Permission`, `Role`). Only the pairs
 * supplied are touched; every other stored entry is left alone.
 *
 * `Override` decides which way an entry goes, mirroring the checkbox the client draws
 * next to each permission: true STORES the `Value` for that pair (overwriting whatever
 * was there), false CLEARS it, so the pair falls back to the photon access token's
 * default. Clearing a pair that was never overridden is a no-op.
 */
export async function setSubRoomPermissions(
	db: D1Database,
	subRoomId: number,
	permissions: RoomPermission[]
): Promise<void> {
	if (permissions.length === 0) return
	const upsert = db.prepare(
		`INSERT INTO subroom_permission (sub_room_id, ${PERMISSION_COLUMNS})
		 VALUES (?1, ?2, ?3, ?4, ?5)
		 ON CONFLICT (sub_room_id, permission, role)
		 DO UPDATE SET type = excluded.type, value = excluded.value`
	)
	const clear = db.prepare(
		'DELETE FROM subroom_permission WHERE sub_room_id = ?1 AND permission = ?2 AND role = ?3'
	)
	await db.batch(
		permissions.map((p) =>
			p.Override
				? upsert.bind(subRoomId, p.Permission, p.Role, p.Type, p.Value)
				: clear.bind(subRoomId, p.Permission, p.Role)
		)
	)
}

/**
 * Copy a subroom's permission overrides onto another subroom — a clone inherits the
 * source's permission table along with its scene and settings. Replaces any entry the
 * destination already holds for the same (permission, role).
 */
async function copySubRoomPermissions(
	db: D1Database,
	fromSubRoomId: number,
	toSubRoomId: number
): Promise<void> {
	await db
		.prepare(
			`INSERT OR REPLACE INTO subroom_permission (sub_room_id, ${PERMISSION_COLUMNS})
			 SELECT ?2, ${PERMISSION_COLUMNS} FROM subroom_permission WHERE sub_room_id = ?1`
		)
		.bind(fromSubRoomId, toSubRoomId)
		.run()
}

/**
 * Insert a subroom for a room, minting a fresh globally-unique SubRoomId from the
 * table's autoincrement sequence. Returns the created subroom (with its new id).
 */
export async function insertSubRoom(
	db: D1Database,
	roomId: number,
	sub: SubRoom
): Promise<SubRoom> {
	const row = await db
		.prepare('INSERT INTO subroom (room_id, data) VALUES (?1, ?2) RETURNING sub_room_id')
		.bind(roomId, serializeSubRoom(sub, roomId))
		.first<{ sub_room_id: number }>()
	const subRoomId = row!.sub_room_id
	const created: SubRoom = {
		...sub,
		SubRoomId: subRoomId,
		RoomId: roomId,
		CurrentSave: null,
		StagedSubRoomDataSaveId: null,
	}
	// The permission overrides follow the copy too — they live in their own table (keyed by
	// the id the caller is cloning FROM), so unlike the rest of the settings they aren't
	// carried by the blob. A fresh subroom (`createSubRoom`) passes no id and copies nothing.
	if (typeof sub.SubRoomId === 'number') {
		await copySubRoomPermissions(db, sub.SubRoomId, subRoomId)
	}
	// A copied subroom (room clone, subroom clone) carries the source's save. It gets its
	// OWN row — a save belongs to exactly one subroom, so sharing the source's id would
	// make the copy's content follow the source's future saves.
	if (sub.CurrentSave && typeof sub.CurrentSave === 'object') {
		const copy = await insertSubRoomSave(db, subRoomId, sub.CurrentSave as SubRoomDataSave)
		await setCurrentSave(db, subRoomId, Number(copy.SubRoomDataSaveId))
		created.CurrentSave = copy
	}
	return created
}

/** Overwrite a subroom's stored data blob in place. */
async function updateSubRoom(db: D1Database, sub: SubRoom): Promise<void> {
	await db
		.prepare('UPDATE subroom SET data = ?2 WHERE sub_room_id = ?1')
		.bind(sub.SubRoomId, serializeSubRoom(sub, Number(sub.RoomId)))
		.run()
}

/** Point a subroom at its live/published save, clearing any staged one. */
async function setCurrentSave(db: D1Database, subRoomId: number, saveId: number): Promise<void> {
	await db
		.prepare(
			'UPDATE subroom SET current_save_id = ?2, staged_save_id = NULL WHERE sub_room_id = ?1'
		)
		.bind(subRoomId, saveId)
		.run()
}

/**
 * Seed a room together with its subrooms — inserts the room (SubRooms stripped from the
 * blob) and each embedded subroom into the `subroom` table, preserving explicit ids. Any
 * subroom carrying a `CurrentSave` gets it inserted into `subroom_save` and pointed at,
 * mirroring 0008's backfill the way this mirrors 0007's.
 */
export async function seedRoomWithSubRooms(db: D1Database, room: Room): Promise<void> {
	const roomId = Number(room.RoomId)
	const subRooms = Array.isArray(room.SubRooms) ? (room.SubRooms as SubRoom[]) : []
	await db.prepare('INSERT OR IGNORE INTO room (data) VALUES (?1)').bind(serializeRoom(room)).run()
	for (const sub of subRooms) {
		const subRoomId = Number(sub.SubRoomId)
		await db
			.prepare('INSERT INTO subroom (sub_room_id, room_id, data) VALUES (?1, ?2, ?3)')
			.bind(subRoomId, roomId, serializeSubRoom(sub, roomId))
			.run()
		const seeded = sub.CurrentSave ?? legacySubRoomSave(sub)
		if (seeded && typeof seeded === 'object') {
			const save = await insertSubRoomSave(db, subRoomId, seeded as SubRoomDataSave)
			await setCurrentSave(db, subRoomId, Number(save.SubRoomDataSaveId))
		}
	}
}

/** Look up a single room by its RoomId. */
export async function getRoomById(db: D1Database, roomId: number): Promise<Room | null> {
	return hydrateRoom(
		db,
		parseOne(
			await db
				.prepare(`SELECT ${ROOM_COLUMNS} FROM room WHERE room_id = ?1`)
				.bind(roomId)
				.first<RoomRow>()
		)
	)
}

/**
 * Delete a room and every player's interaction (cheer/favorite/visit) with it, in one
 * batch. Deliberately leaves transient `room_instance`/`presence` rows (they expire on
 * their own) and any images taken in the room (those live in the api/img world and
 * outlast the room). Authorization and removing the room image from the CDN bucket are
 * the caller's responsibility (see the DELETE /rooms/:id route).
 */
export async function deleteRoom(db: D1Database, roomId: number): Promise<void> {
	await db.batch([
		db.prepare('DELETE FROM room WHERE room_id = ?1').bind(roomId),
		db.prepare('DELETE FROM interaction WHERE room_id = ?1').bind(roomId),
		// Saves and permission overrides first — both are keyed by subroom, so they'd be
		// unreachable once the subrooms themselves are gone.
		db
			.prepare(
				'DELETE FROM subroom_save WHERE sub_room_id IN (SELECT sub_room_id FROM subroom WHERE room_id = ?1)'
			)
			.bind(roomId),
		db
			.prepare(
				'DELETE FROM subroom_permission WHERE sub_room_id IN (SELECT sub_room_id FROM subroom WHERE room_id = ?1)'
			)
			.bind(roomId),
		db.prepare('DELETE FROM subroom WHERE room_id = ?1').bind(roomId),
	])
}

/** Look up a single room by name (case-insensitive exact match). */
export async function getRoomByName(db: D1Database, name: string): Promise<Room | null> {
	return hydrateRoom(
		db,
		parseOne(
			await db
				.prepare(`SELECT ${ROOM_COLUMNS} FROM room WHERE name_lower = ?1`)
				.bind(name.toLowerCase())
				.first<RoomRow>()
		)
	)
}

/** Look up multiple rooms by RoomId. */
export async function getRoomsByIds(db: D1Database, ids: number[]): Promise<Room[]> {
	if (ids.length === 0) return []
	const placeholders = ids.map((_, i) => `?${i + 1}`).join(',')
	const { results } = await db
		.prepare(`SELECT ${ROOM_COLUMNS} FROM room WHERE room_id IN (${placeholders})`)
		.bind(...ids)
		.all<RoomRow>()
	return hydrateRooms(db, parseAll(results))
}

/** All rooms created by an account (e.g. their dorm). */
export async function getRoomsByCreator(db: D1Database, accountId: number): Promise<Room[]> {
	const { results } = await db
		.prepare(`SELECT ${ROOM_COLUMNS} FROM room WHERE creator_account_id = ?1`)
		.bind(accountId)
		.all<RoomRow>()
	return hydrateRooms(db, parseAll(results))
}

/**
 * How many rooms an account has made, for the per-account room cap. Dorms don't
 * count: every player gets one auto-provisioned, so counting it would silently cost
 * them a slot they never asked for.
 */
export async function countRoomsByCreator(db: D1Database, accountId: number): Promise<number> {
	const row = await db
		.prepare(
			`SELECT COUNT(*) AS n FROM room
			 WHERE creator_account_id = ?1
			   AND COALESCE(is_dorm, 0) = 0`
		)
		.bind(accountId)
		.first<{ n: number }>()
	return row?.n ?? 0
}

/**
 * An account's public, non-dorm rooms — the publicly viewable "rooms owned by
 * <player>" list (excludes private rooms, dorms, and list-excluded rooms).
 */
export async function getPublicRoomsByCreator(db: D1Database, accountId: number): Promise<Room[]> {
	return (await getRoomsByCreator(db, accountId)).filter(
		(r) => r.IsDorm !== true && r.Accessibility === 1 && r.ExcludeFromLists !== true
	)
}

/**
 * Rooms the player has favorited (interaction.favorited = 1), most recently
 * interacted first. Joins the `interaction` table to `rooms`, so a favorited room
 * no longer in D1 is simply absent. Paginated via skip/take; returns a bare array
 * of rooms (the client's room-source loaders expect a plain list).
 */
export async function getFavoritedRooms(
	db: D1Database,
	playerId: number,
	skip: number,
	take: number
): Promise<Room[]> {
	const { results } = await db
		.prepare(
			`SELECT r.data AS data, r.visits AS visits
			 FROM interaction i
			 JOIN room r ON r.room_id = i.room_id
			 WHERE i.player_id = ?1 AND i.favorited = 1
			 ORDER BY i.last_visited_at DESC`
		)
		.bind(playerId)
		.all<RoomRow>()
	return hydrateRooms(db, parseAll(results).slice(skip, skip + take))
}

/**
 * Rooms the player has visited (an interaction row with a `last_visited_at`),
 * most recent first. Like favorites, it joins `interaction` to `rooms`, so a
 * visited room no longer in D1 is simply absent. Paginated via skip/take; returns
 * a bare array of rooms (the client's room-source loaders expect a plain list).
 */
export async function getVisitedRooms(
	db: D1Database,
	playerId: number,
	skip: number,
	take: number
): Promise<Room[]> {
	const { results } = await db
		.prepare(
			`SELECT r.data AS data, r.visits AS visits
			 FROM interaction i
			 JOIN room r ON r.room_id = i.room_id
			 WHERE i.player_id = ?1 AND i.last_visited_at IS NOT NULL
			 ORDER BY i.last_visited_at DESC`
		)
		.bind(playerId)
		.all<RoomRow>()
	return hydrateRooms(db, parseAll(results).slice(skip, skip + take))
}

/** A player's interaction state with a room. */
export interface Interaction {
	Cheered: boolean
	Favorited: boolean
}

interface InteractionRow {
	cheered: number
	favorited: number
}

const toInteraction = (row: InteractionRow | null): Interaction => ({
	Cheered: row?.cheered === 1,
	Favorited: row?.favorited === 1,
})

/** Read a player's interaction with a room (defaults to all-false if none). */
export async function getInteraction(
	db: D1Database,
	playerId: number,
	roomId: number
): Promise<Interaction> {
	return toInteraction(
		await db
			.prepare('SELECT cheered, favorited FROM interaction WHERE player_id = ?1 AND room_id = ?2')
			.bind(playerId, roomId)
			.first<InteractionRow>()
	)
}

/** Upsert+toggle a single boolean column, returning the resulting interaction. */
async function toggleInteraction(
	db: D1Database,
	playerId: number,
	roomId: number,
	column: 'cheered' | 'favorited'
): Promise<Interaction> {
	const now = new Date().toISOString()
	// First interaction defaults the toggled column to 1; subsequent calls flip it.
	return toInteraction(
		await db
			.prepare(
				`INSERT INTO interaction (player_id, room_id, ${column}, last_visited_at)
				 VALUES (?1, ?2, 1, ?3)
				 ON CONFLICT(player_id, room_id)
				 DO UPDATE SET ${column} = NOT ${column}, last_visited_at = ?3
				 RETURNING cheered, favorited`
			)
			.bind(playerId, roomId, now)
			.first<InteractionRow>()
	)
}

/** Toggle the player's cheer on a room, returning the resulting interaction. */
export async function toggleCheer(
	db: D1Database,
	playerId: number,
	roomId: number
): Promise<Interaction> {
	return toggleInteraction(db, playerId, roomId, 'cheered')
}

/** Toggle the player's favorite on a room, returning the resulting interaction. */
export async function toggleFavorite(
	db: D1Database,
	playerId: number,
	roomId: number
): Promise<Interaction> {
	return toggleInteraction(db, playerId, roomId, 'favorited')
}

/**
 * Explicitly clear a single interaction flag on a room (the DELETE counterpart to
 * the cheer/favorite toggles). Idempotent: only clears an existing interaction row
 * and never creates one, so clearing a flag on a room the player never interacted
 * with doesn't add a spurious visited/favorited entry. Returns the interaction.
 */
async function clearInteraction(
	db: D1Database,
	playerId: number,
	roomId: number,
	column: 'cheered' | 'favorited'
): Promise<Interaction> {
	await db
		.prepare(`UPDATE interaction SET ${column} = 0 WHERE player_id = ?1 AND room_id = ?2`)
		.bind(playerId, roomId)
		.run()
	return getInteraction(db, playerId, roomId)
}

/** Clear the player's cheer on a room (DELETE cheer), returning the interaction. */
export async function removeCheer(
	db: D1Database,
	playerId: number,
	roomId: number
): Promise<Interaction> {
	return clearInteraction(db, playerId, roomId, 'cheered')
}

/** Clear the player's favorite on a room (DELETE favorite), returning the interaction. */
export async function removeFavorite(
	db: D1Database,
	playerId: number,
	roomId: number
): Promise<Interaction> {
	return clearInteraction(db, playerId, roomId, 'favorited')
}

/**
 * Search-tag aliases: a queried `#tag` also matches these stored tag names.
 * The client's pinned filters don't always match how rooms are tagged (e.g. it
 * searches `recroomoriginal`, but rooms are tagged `rro`).
 */
const TAG_ALIASES: Record<string, string[]> = {
	recroomoriginal: ['rro'],
}

/** A room's tag names, lowercased (empty when it has no Tags array). */
function roomTags(room: Room): string[] {
	const tags = room.Tags
	if (!Array.isArray(tags)) return []
	return tags
		.map((t) => (t as Record<string, unknown> | null)?.Tag)
		.filter((v): v is string => typeof v === 'string')
		.map((v) => v.toLowerCase())
}

/** True if the room carries any of the given (lowercased) tags. */
function roomHasAnyTag(room: Room, tags: Set<string>): boolean {
	return roomTags(room).some((t) => tags.has(t))
}

/**
 * Search public, non-dorm rooms. The query is split into terms (space/`+`):
 * `#tag` terms match the room's Tags; plain terms match the room name
 * (substring). All terms must match. Returns a paginated `{ Results, TotalResults }`.
 * The dataset is small, so this filters in memory rather than in SQL.
 */
export async function searchRooms(
	db: D1Database,
	query: string,
	skip: number,
	take: number
): Promise<{ Results: Room[]; TotalResults: number }> {
	const q = query.trim().toLowerCase()
	if (q === '') return { Results: [], TotalResults: 0 }
	const terms = q.split(/[\s+]+/).filter(Boolean)

	const { results } = await db.prepare(`SELECT ${ROOM_COLUMNS} FROM room`).all<RoomRow>()
	let rooms = parseAll(results).filter((r) => r.IsDorm !== true && r.Accessibility === 1)

	for (const term of terms) {
		if (term.startsWith('#')) {
			const tag = term.slice(1)
			const accepted = new Set([tag, ...(TAG_ALIASES[tag] ?? [])])
			rooms = rooms.filter((r) => roomHasAnyTag(r, accepted))
		} else {
			rooms = rooms.filter((r) => typeof r.Name === 'string' && r.Name.toLowerCase().includes(term))
		}
	}

	return {
		Results: await hydrateRooms(db, rooms.slice(skip, skip + take)),
		TotalResults: rooms.length,
	}
}

/**
 * Engagement score used to order the hot feed (cheers weigh most, then favorites).
 * Cheers/favorites come from the caller's aggregated {@link getRoomStats} map — ranking
 * happens before hydration, so the room blob's copies are still zero at this point.
 */
function hotScore(room: Room, stats: Map<number, RoomStats>): number {
	const counts = stats.get(roomIdOf(room))
	const stored = room.Stats as Record<string, unknown> | null | undefined
	const visitors = typeof stored?.VisitorCount === 'number' ? stored.VisitorCount : 0
	return (counts?.CheerCount ?? 0) * 3 + (counts?.FavoriteCount ?? 0) * 2 + visitors
}

/**
 * The browse screen's "New" chip posts `tag=new` to the hot feed, but `new` is a
 * PSEUDO-tag: no room carries it. It means "recently created by a player", so it
 * selects the non-RRO rooms and orders them newest-first instead of by population.
 */
const NEW_TAG = 'new'

/**
 * The browse screen's "Community" chip posts `tag=community`, another PSEUDO-tag no
 * room carries. It means "made by a player", which here is every room whose creator
 * isn't the Coach account — the system account that owns the seeded Rec Room rooms.
 * Unlike {@link NEW_TAG} it only filters: the page keeps the feed's normal
 * live-population ordering.
 */
const COMMUNITY_TAG = 'community'

/** The system account (`Coach`) that owns the seeded first-party rooms. */
const COACH_ACCOUNT_ID = 1

/**
 * True if the room is a Rec Room Original. `IsRRO` is the flag the client renders a
 * virtual "RRO" tag from; the auto-derived `rro` tag is checked too so a room that only
 * carries the tag isn't mistaken for player-made.
 */
function isRRO(room: Room): boolean {
	return room.IsRRO === true || roomHasAnyTag(room, new Set(['rro']))
}

/** A room's CreatedAt as epoch millis; 0 (i.e. oldest) when it's missing or unparseable. */
function createdAt(room: Room): number {
	const ts = typeof room.CreatedAt === 'string' ? Date.parse(room.CreatedAt) : NaN
	return Number.isNaN(ts) ? 0 : ts
}

/**
 * The "hot" rooms feed: public, non-dorm rooms not excluded from lists, ordered
 * by how many players are in them RIGHT NOW (live presence summed across the
 * room's instances), and optionally filtered to a single `tag` (with the same
 * aliases as search). "Hot" is a live-population feed, so current players lead;
 * rooms nobody is in — and the all-zero seed data — fall back to the stored
 * engagement score, then to RoomId order so paging stays stable. Paginated via
 * skip/take; returns `{ Results, TotalResults }` like search. The dataset is
 * small, so this filters/sorts in memory rather than in SQL.
 *
 * `tag=new` and `tag=community` are the filters that aren't tag lookups — see
 * {@link NEW_TAG} and {@link COMMUNITY_TAG}.
 */
export async function getHotRooms(
	db: D1Database,
	tag: string,
	skip: number,
	take: number
): Promise<{ Results: Room[]; TotalResults: number }> {
	const { results } = await db.prepare(`SELECT ${ROOM_COLUMNS} FROM room`).all<RoomRow>()
	let rooms = parseAll(results).filter(
		(r) => r.IsDorm !== true && r.Accessibility === 1 && r.ExcludeFromLists !== true
	)

	const t = tag.trim().toLowerCase()
	if (t === NEW_TAG) {
		// Newest player-made rooms first; RoomId (which is minted in creation order)
		// breaks ties so rooms created in the same instant still page stably.
		const fresh = rooms
			.filter((r) => !isRRO(r))
			.sort((a, b) => createdAt(b) - createdAt(a) || roomIdOf(b) - roomIdOf(a))
		return {
			Results: await hydrateRooms(db, fresh.slice(skip, skip + take)),
			TotalResults: fresh.length,
		}
	}

	if (t === COMMUNITY_TAG) {
		rooms = rooms.filter((r) => r.CreatorAccountId !== COACH_ACCOUNT_ID)
	} else if (t !== '') {
		const accepted = new Set([t, ...(TAG_ALIASES[t] ?? [])])
		rooms = rooms.filter((r) => roomHasAnyTag(r, accepted))
	}

	const players = await countPlayersByRoom(db)
	const playerCount = (r: Room): number => players.get(roomIdOf(r)) ?? 0
	const stats = await getRoomStats(db)
	rooms.sort(
		(a, b) =>
			playerCount(b) - playerCount(a) ||
			hotScore(b, stats) - hotScore(a, stats) ||
			roomIdOf(a) - roomIdOf(b)
	)
	return {
		Results: await hydrateRooms(db, rooms.slice(skip, skip + take), stats),
		TotalResults: rooms.length,
	}
}

/**
 * Recommended rooms feed: public, non-dorm rooms not excluded from lists, ranked
 * by engagement (same score as the hot feed). Unlike the hot feed this returns a
 * bare array — the client's recommendation room-source loader expects a plain
 * list, like the other `*by/me`/base sources. The `splitTest*` A/B params the
 * client passes don't change the result. Paginated via skip/take; the dataset is
 * small, so this filters/sorts in memory rather than in SQL.
 */
export async function getRecommendedRooms(
	db: D1Database,
	skip: number,
	take: number
): Promise<Room[]> {
	const { results } = await db.prepare(`SELECT ${ROOM_COLUMNS} FROM room`).all<RoomRow>()
	const stats = await getRoomStats(db)
	return hydrateRooms(
		db,
		parseAll(results)
			.filter((r) => r.IsDorm !== true && r.Accessibility === 1 && r.ExcludeFromLists !== true)
			.sort((a, b) => hotScore(b, stats) - hotScore(a, stats) || roomIdOf(a) - roomIdOf(b))
			.slice(skip, skip + take),
		stats
	)
}

/** Compact room projection carried by a featured-room group. */
export interface FeaturedRoom {
	RoomId: number
	RoomName: string
	ImageName: string
	IsRecRoomApproved: boolean
	ExcludeFromLists: boolean
	ExcludeFromSearch: boolean
}

/** A time-boxed group of featured rooms, as returned by `/featuredrooms/current`. */
export interface FeaturedRoomGroup {
	FeaturedRoomGroupId: number
	name: string
	StartAt: string
	EndAt: string
	Rooms: FeaturedRoom[]
}

/**
 * Featured rooms group: public, non-dorm rooms not excluded from lists, in random
 * order. There's no editorial curation behind this yet, so "featured" is just a
 * random shuffle of the eligible rooms wrapped in a single always-active group.
 * Small dataset, so done in memory.
 */
export async function getFeaturedRooms(db: D1Database): Promise<FeaturedRoomGroup> {
	const { results } = await db.prepare(`SELECT ${ROOM_COLUMNS} FROM room`).all<RoomRow>()
	const rooms = parseAll(results).filter(
		(r) => r.IsDorm !== true && r.Accessibility === 1 && r.ExcludeFromLists !== true
	)
	// Fisher–Yates shuffle so the feed varies between requests.
	for (let i = rooms.length - 1; i > 0; i--) {
		const j = Math.floor(Math.random() * (i + 1))
		;[rooms[i], rooms[j]] = [rooms[j], rooms[i]]
	}

	const str = (v: unknown): string => (typeof v === 'string' ? v : '')
	const num = (v: unknown): number => (typeof v === 'number' ? v : 0)
	return {
		FeaturedRoomGroupId: 1,
		name: 'Featured Rooms',
		StartAt: '2025-12-01T11:01:00Z',
		EndAt: '9999-12-08T11:00:00Z',
		Rooms: rooms.map((r) => ({
			RoomId: num(r.RoomId),
			RoomName: str(r.Name),
			ImageName: str(r.ImageName),
			IsRecRoomApproved: r.IsRecRoomApproved === true,
			ExcludeFromLists: r.ExcludeFromLists === true,
			ExcludeFromSearch: r.ExcludeFromSearch === true,
		})),
	}
}

/**
 * Rooms similar to a target room: public, non-dorm rooms (excluding the target)
 * that share at least one tag with it, ranked by shared-tag count then
 * engagement. Returns a paginated `{ Results, TotalResults }` (the client's
 * RoomSimilarity source expects an object, not a bare array); empty if the target
 * isn't in D1 or is untagged. Small dataset, so done in memory.
 */
export async function getSimilarRooms(
	db: D1Database,
	roomId: number,
	skip: number,
	take: number
): Promise<{ Results: Room[]; TotalResults: number }> {
	const empty = { Results: [] as Room[], TotalResults: 0 }
	const target = await getRoomById(db, roomId)
	if (!target) return empty
	const targetTags = new Set(roomTags(target))
	if (targetTags.size === 0) return empty

	const { results } = await db.prepare(`SELECT ${ROOM_COLUMNS} FROM room`).all<RoomRow>()
	const sharedCount = (r: Room): number => roomTags(r).filter((t) => targetTags.has(t)).length
	const stats = await getRoomStats(db)

	const scored = parseAll(results)
		.filter(
			(r) =>
				roomIdOf(r) !== roomId &&
				r.IsDorm !== true &&
				r.Accessibility === 1 &&
				r.ExcludeFromLists !== true
		)
		.map((room) => ({ room, shared: sharedCount(room) }))
		.filter((x) => x.shared > 0)

	scored.sort(
		(a, b) =>
			b.shared - a.shared ||
			hotScore(b.room, stats) - hotScore(a.room, stats) ||
			roomIdOf(a.room) - roomIdOf(b.room)
	)
	const rooms = scored.map((x) => x.room)
	return {
		Results: await hydrateRooms(db, rooms.slice(skip, skip + take), stats),
		TotalResults: rooms.length,
	}
}

/**
 * "Base" rooms — the template rooms tagged `base` that the client offers as
 * starting points when creating a room. Unlike the public feeds these are
 * returned regardless of accessibility (most base rooms aren't publicly listed).
 * Ordered by RoomId for stable paging. Paginated via skip/take; returns a bare
 * array. Small dataset, so done in memory.
 */
export async function getBaseRooms(db: D1Database, skip: number, take: number): Promise<Room[]> {
	const { results } = await db.prepare(`SELECT ${ROOM_COLUMNS} FROM room`).all<RoomRow>()
	const base = new Set(['base'])
	return hydrateRooms(
		db,
		parseAll(results)
			.filter((r) => roomHasAnyTag(r, base))
			.sort((a, b) => roomIdOf(a) - roomIdOf(b))
			.slice(skip, skip + take)
	)
}

/** The seeded template dorm (RoomId 1) that personal dorms are cloned from. */
const DORM_TEMPLATE_ROOM_ID = 1

/** A player's username from the shared accounts table (for naming their dorm), or null. */
export async function getUsername(db: D1Database, accountId: number): Promise<string | null> {
	const row = await db
		.prepare('SELECT data FROM account WHERE account_id = ?1')
		.bind(accountId)
		.first<{ data: string }>()
	if (!row) return null
	const account = JSON.parse(row.data) as { username?: string }
	return typeof account.username === 'string' ? account.username : null
}

/** A player's personal dorm room (owned by them, IsDorm), or null if none yet. */
export async function getDormRoom(db: D1Database, accountId: number): Promise<Room | null> {
	return hydrateRoom(
		db,
		parseOne(
			await db
				.prepare(
					`SELECT ${ROOM_COLUMNS} FROM room WHERE creator_account_id = ?1 AND is_dorm = 1 LIMIT 1`
				)
				.bind(accountId)
				.first<RoomRow>()
		)
	)
}

/**
 * The player's personal dorm room, created on first access. Cloned from the
 * seeded template dorm (RoomId 1) but owned by the player and flagged IsDorm — so
 * matchmaking routes them into their own dorm and they can save it via the
 * owner-gated room-save. Idempotent: returns the existing dorm once created.
 *
 * NOTE: this is the one place the match worker writes to the rooms table (the
 * `rooms` worker otherwise owns the schema).
 */
export async function getOrCreateDormRoom(db: D1Database, accountId: number): Promise<Room> {
	const existing = await getDormRoom(db, accountId)
	if (existing) return existing

	const template = await getRoomById(db, DORM_TEMPLATE_ROOM_ID)
	const idRow = await db
		.prepare('SELECT COALESCE(MAX(room_id), 1) + 1 AS next FROM room')
		.first<{ next: number }>()
	const roomId = idRow?.next ?? 2

	// Reuse the template's subroom (scene/capacity), owned by the player, starting
	// from a clean save. Fall back to the base dorm scene if the template is absent.
	const templateSub =
		template && Array.isArray(template.SubRooms) && template.SubRooms.length > 0
			? (template.SubRooms[0] as Record<string, unknown>)
			: { SubRoomId: 1, UnitySceneId: '76d98498-60a1-430c-ab76-b54a29b7a163', MaxPlayers: 4 }

	// Named after the owner: `@<username>'s Dorm` (falls back to the account id).
	const username = (await getUsername(db, accountId)) ?? `Player${accountId}`

	const room: Room = {
		...(template ?? { Accessibility: Accessibility.Unlisted }),
		RoomId: roomId,
		Name: `@${username}'s Dorm`,
		CreatorAccountId: accountId,
		IsDorm: true,
		Roles: [
			{ AccountId: accountId, Role: Role.Creator, LastChangedByAccountId: null, InvitedRole: 0 },
		],
		// Counters start at zero rather than inheriting the template dorm's (see cloneRoom).
		Stats: storedStats(template?.Stats),
		CreatedAt: new Date().toISOString(),
	}
	// serializeRoom drops any SubRooms carried over from the template; the dorm's own
	// subroom is inserted into the subroom table below with a fresh globally-unique id.
	await db.prepare('INSERT INTO room (data) VALUES (?1)').bind(serializeRoom(room)).run()
	const subRoom = await insertSubRoom(db, roomId, { ...templateSub, CreatorAccountId: accountId })
	room.SubRooms = [subRoom]
	// The template carries these (it was parsed), but a dorm minted without one wouldn't.
	attachRoomDtoDefaults(room)
	return room
}
