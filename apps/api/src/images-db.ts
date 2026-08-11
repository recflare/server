/**
 * Image-metadata storage on the shared `recflare` D1 database. Each image is a
 * single JSON blob in the `data` column; queryable fields (Id, ImageName,
 * PlayerId, RoomId) are SQLite generated (virtual) columns extracted from that
 * JSON — the same JSON-blob pattern the rooms/accounts tables use.
 *
 * Mirror of `apps/img/src/images-db.ts` — the `img` worker owns the schema and
 * migration; this worker (which handles uploads + reads) keeps a copy in sync.
 */

/** Schema DDL (mirror of migrations/0001_image.sql, sans any seed rows). */
export const SCHEMA_DDL: string[] = [
	`CREATE TABLE IF NOT EXISTS image (
		data TEXT NOT NULL,
		id INTEGER GENERATED ALWAYS AS (json_extract(data, '$.Id')) VIRTUAL,
		image_name TEXT GENERATED ALWAYS AS (json_extract(data, '$.ImageName')) VIRTUAL,
		player_id INTEGER GENERATED ALWAYS AS (json_extract(data, '$.PlayerId')) VIRTUAL,
		room_id INTEGER GENERATED ALWAYS AS (json_extract(data, '$.RoomId')) VIRTUAL
	)`,
	`CREATE UNIQUE INDEX IF NOT EXISTS idx_image_id ON image (id)`,
	`CREATE INDEX IF NOT EXISTS idx_image_image_name ON image (image_name)`,
	`CREATE INDEX IF NOT EXISTS idx_image_player_id ON image (player_id)`,
	`CREATE INDEX IF NOT EXISTS idx_image_room_id ON image (room_id)`,
	// A player's interaction with a saved image — one row per (player, image). Only
	// `cheered` for now; named generically so other per-user interactions (e.g.
	// favorited) can be added as columns. This worker writes it (cheer endpoints) and
	// keeps the image's denormalized `CheerCount` in sync from it. Schema owned by the
	// `img` worker (migrations/0002_image_interaction.sql) — keep in sync.
	`CREATE TABLE IF NOT EXISTS image_interaction (
		player_id INTEGER NOT NULL,
		saved_image_id INTEGER NOT NULL,
		cheered INTEGER NOT NULL DEFAULT 0,
		created_at TEXT,
		PRIMARY KEY (player_id, saved_image_id)
	)`,
	`CREATE INDEX IF NOT EXISTS idx_image_interaction_image ON image_interaction (saved_image_id)`,
]

/**
 * Saved-image categories from the reference's `SavedImageType` enum — the value of a
 * stored image's `Type` (and the client's `imgMeta.savedImageType` on upload). Lives
 * here in the image data layer so both the upload route and the slideshow query share
 * one definition.
 */
export const SavedImageType = {
	None: 0,
	ShareCamera: 1,
	OutfitThumbnail: 2,
	RoomThumbnail: 3,
	ProfileThumbnail: 4,
	InventionThumbnail: 5,
} as const

/** A stored image record (the client-facing SavedImage shape). */
export interface SavedImage {
	Id: number
	/** A {@link SavedImageType} value. */
	Type: number
	Accessibility: number
	AccessibilityLocked: boolean
	ImageName: string
	Description: string | null
	PlayerId: number
	TaggedPlayerIds: number[]
	RoomId: number | null
	PlayerEventId: number | null
	CreatedAt: string
	CheerCount: number
	CommentCount: number
}

interface ImageRow {
	data: string
}

/** Fields supplied at upload time (from `imgMeta`); everything else defaults. */
export interface NewImage {
	imageName: string
	playerId: number
	type?: number
	accessibility?: number
	roomId?: number | null
	description?: string | null
	taggedPlayerIds?: number[]
	playerEventId?: number | null
}

/** Insert a new image record for an upload, returning the stored row. */
export async function createImage(db: D1Database, input: NewImage): Promise<SavedImage> {
	// Sequential id: one past the current max (the table starts empty).
	const row = await db
		.prepare('SELECT COALESCE(MAX(id), 0) + 1 AS next FROM image')
		.first<{ next: number }>()
	const image: SavedImage = {
		Id: row?.next ?? 1,
		Type: input.type ?? 1,
		Accessibility: input.accessibility ?? 1,
		AccessibilityLocked: false,
		ImageName: input.imageName,
		Description: input.description ?? null,
		PlayerId: input.playerId,
		TaggedPlayerIds: input.taggedPlayerIds ?? [],
		RoomId: input.roomId ?? null,
		PlayerEventId: input.playerEventId ?? null,
		CreatedAt: new Date().toISOString(),
		CheerCount: 0,
		CommentCount: 0,
	}
	await db.prepare('INSERT INTO image (data) VALUES (?1)').bind(JSON.stringify(image)).run()
	return image
}

/**
 * Recompute an image's `CheerCount` from the `image_interaction` rows and write it
 * back into the blob (nothing reads a generated column for it, but the client-facing
 * blob must stay accurate). CAST to INTEGER: D1 binds a JS number as a SQLite REAL,
 * which json_set would otherwise store as `"CheerCount":3.0`. Returns the fresh count.
 */
async function syncImageCheerCount(db: D1Database, savedImageId: number): Promise<number> {
	const row = await db
		.prepare(
			'SELECT COUNT(*) AS n FROM image_interaction WHERE saved_image_id = ?1 AND cheered = 1'
		)
		.bind(savedImageId)
		.first<{ n: number }>()
	const count = row?.n ?? 0
	await db
		.prepare(
			"UPDATE image SET data = json_set(data, '$.CheerCount', CAST(?2 AS INTEGER)) WHERE id = ?1"
		)
		.bind(savedImageId, count)
		.run()
	return count
}

/**
 * Set (or clear) a player's cheer on a saved image — upserts the one row per
 * (player, image) — then resyncs the image's `CheerCount`. Idempotent: re-cheering
 * an already-cheered image is a no-op on the count.
 */
export async function setImageCheer(
	db: D1Database,
	playerId: number,
	savedImageId: number,
	cheer: boolean
): Promise<void> {
	await db
		.prepare(
			`INSERT INTO image_interaction (player_id, saved_image_id, cheered, created_at)
			 VALUES (?1, ?2, ?3, ?4)
			 ON CONFLICT(player_id, saved_image_id) DO UPDATE SET cheered = ?3`
		)
		.bind(playerId, savedImageId, cheer ? 1 : 0, new Date().toISOString())
		.run()
	await syncImageCheerCount(db, savedImageId)
}

/**
 * Which of the given saved-image ids the player has cheered — the set of cheered
 * ids (a subset of `ids`). Backs the bulk `cheered` lookup. Empty input → empty set.
 */
export async function getCheeredImageIds(
	db: D1Database,
	playerId: number,
	ids: number[]
): Promise<Set<number>> {
	if (ids.length === 0) return new Set()
	const inList = ids.map((_, i) => `?${i + 2}`).join(',')
	const { results } = await db
		.prepare(
			`SELECT saved_image_id AS id FROM image_interaction
			 WHERE player_id = ?1 AND cheered = 1 AND saved_image_id IN (${inList})`
		)
		.bind(playerId, ...ids)
		.all<{ id: number }>()
	return new Set(results.map((r) => r.id))
}

/** Look up an image record by its ImageName (the R2 key / filename), or null. */
export async function getImageByName(db: D1Database, name: string): Promise<SavedImage | null> {
	const row = await db
		.prepare('SELECT data FROM image WHERE image_name = ?1')
		.bind(name)
		.first<ImageRow>()
	return row ? (JSON.parse(row.data) as SavedImage) : null
}

/**
 * Delete an image's metadata row plus any per-player interactions (cheers) recorded
 * against it, in one batch — the row keyed by ImageName (the R2 key), its interactions
 * by the image's `Id`. Authorization and removing the object from R2 are the caller's
 * responsibility (see the deletesaved route).
 */
export async function deleteImage(db: D1Database, image: SavedImage): Promise<void> {
	await db.batch([
		db.prepare('DELETE FROM image WHERE image_name = ?1').bind(image.ImageName),
		db.prepare('DELETE FROM image_interaction WHERE saved_image_id = ?1').bind(image.Id),
	])
}

/**
 * The public images taken in a room, for the room's photo feed. Only publicly
 * accessible images (Accessibility === 1) are returned. `filter` narrows by
 * `SavedImageType` (0 = all types); `sort` orders the feed — `1` puts the most
 * cheered first (ties broken by newest), anything else is newest-first. Paginated
 * via skip/take; returns a bare array of SavedImage. The per-room set is small, so
 * the room_id index does the lookup and filtering/sorting happens in memory.
 *
 * NOTE: the exact `sort`/`filter` enum values are best guesses — the client sends
 * `sort=1&filter=1`, and this treats them as most-cheered / ShareCamera.
 */
export async function getImagesByRoom(
	db: D1Database,
	roomId: number,
	sort: number,
	filter: number,
	skip: number,
	take: number
): Promise<SavedImage[]> {
	const { results } = await db
		.prepare('SELECT data FROM image WHERE room_id = ?1')
		.bind(roomId)
		.all<ImageRow>()
	let images = results
		.map((r) => JSON.parse(r.data) as SavedImage)
		.filter((img) => img.Accessibility === 1)

	if (filter > 0) images = images.filter((img) => img.Type === filter)

	images.sort(sort === 1 ? (a, b) => b.CheerCount - a.CheerCount || newestFirst(a, b) : newestFirst)

	return images.slice(skip, skip + take)
}

/** Newest-first order: most recent CreatedAt, ties broken by higher Id. */
const newestFirst = (a: SavedImage, b: SavedImage) =>
	b.CreatedAt.localeCompare(a.CreatedAt) || b.Id - a.Id

/**
 * The public images a player has taken — their photo list, newest first.
 * Paginated via skip/take; returns a bare array of SavedImage. Uses the
 * player_id index; the per-player set is small, so filtering/sorting is in memory.
 */
export async function getImagesByPlayer(
	db: D1Database,
	playerId: number,
	sort: number,
	skip: number,
	take: number
): Promise<SavedImage[]> {
	const { results } = await db
		.prepare('SELECT data FROM image WHERE player_id = ?1')
		.bind(playerId)
		.all<ImageRow>()
	return results
		.map((r) => JSON.parse(r.data) as SavedImage)
		.filter((img) => img.Accessibility === 1)
		.sort(sort === 1 ? (a, b) => b.CheerCount - a.CheerCount || newestFirst(a, b) : newestFirst)
		.slice(skip, skip + take)
}

/**
 * The client-facing projection of a saved image for the player photo lists (the
 * reference's `ImagesPlayer`). Same data as the stored record, but the id and type
 * are renamed — `Id` → `SavedImageId`, `Type` → `SavedImageType` — and the tagged
 * player ids aren't part of it. The client deserializes into this shape, so a raw
 * SavedImage leaves it without an image id and its thumbnails come up blank.
 */
export interface ImagesPlayer {
	Accessibility: number
	AccessibilityLocked: boolean
	CheerCount: number
	CommentCount: number
	CreatedAt: string
	Description: string | null
	ImageName: string
	PlayerEventId: number | null
	PlayerId: number
	RoomId: number | null
	SavedImageId: number
	SavedImageType: number
}

/** Project a stored image to the client's ImagesPlayer shape. */
export function toImagesPlayer(img: SavedImage): ImagesPlayer {
	return {
		Accessibility: img.Accessibility,
		AccessibilityLocked: img.AccessibilityLocked,
		CheerCount: img.CheerCount,
		CommentCount: img.CommentCount,
		CreatedAt: img.CreatedAt,
		Description: img.Description,
		ImageName: img.ImageName,
		PlayerEventId: img.PlayerEventId,
		PlayerId: img.PlayerId,
		RoomId: img.RoomId,
		SavedImageId: img.Id,
		SavedImageType: img.Type,
	}
}

/** How many recent images the slideshow feed returns when the caller doesn't say. */
export const SLIDESHOW_LIMIT = 10

/**
 * The most a caller can ask the slideshow feed for. The endpoint is public and
 * unauthenticated, so the cap is what keeps an arbitrary `take` from turning into a
 * scan of the whole image table plus the two batched joins behind it.
 */
export const SLIDESHOW_MAX_LIMIT = 100

/** The slideshow projection of an image — creator username + room name joined in. */
export interface SlideshowImage {
	SavedImageId: number
	ImageName: string
	Username: string
	RoomName: string | null
	RoomId: number | null
	SavedImageType: number
	PlayerEventId: number | null
	Accessibility: number
	PlayerIds: number[]
}

/** Build the `?1,?2,…` placeholder list for an `IN (…)` clause. */
const placeholders = (n: number): string =>
	Array.from({ length: n }, (_, i) => `?${i + 1}`).join(',')

/** Map account ids → username, resolved from the shared accounts table. */
async function getUsernames(db: D1Database, ids: number[]): Promise<Map<number, string>> {
	if (ids.length === 0) return new Map()
	const { results } = await db
		.prepare(
			`SELECT account_id AS id, json_extract(data, '$.username') AS username
			 FROM account WHERE account_id IN (${placeholders(ids.length)})`
		)
		.bind(...ids)
		.all<{ id: number; username: string }>()
	return new Map(results.map((r) => [r.id, r.username]))
}

/** Map room ids → room name, resolved from the shared rooms table. */
async function getRoomNames(db: D1Database, ids: number[]): Promise<Map<number, string>> {
	if (ids.length === 0) return new Map()
	const { results } = await db
		.prepare(
			`SELECT room_id AS id, json_extract(data, '$.Name') AS name
			 FROM room WHERE room_id IN (${placeholders(ids.length)})`
		)
		.bind(...ids)
		.all<{ id: number; name: string }>()
	return new Map(results.map((r) => [r.id, r.name]))
}

/**
 * The global slideshow feed — the most recent publicly-listable ShareCamera photos
 * across all rooms (Accessibility 0 or 1, Type 1), newest first, capped at `limit`.
 * Only ShareCamera images are surfaced (not room/profile/invention thumbnails). Each
 * row is joined to its creator's username and (if any) its room's name. Returns the
 * projected SlideshowImage shape. Usernames/room names are resolved in two batched
 * lookups to avoid an N+1 across the (at most `limit`) images.
 */
export async function getSlideshowImages(
	db: D1Database,
	limit = SLIDESHOW_LIMIT
): Promise<SlideshowImage[]> {
	const { results } = await db
		.prepare(
			`SELECT data FROM image
			 WHERE json_extract(data, '$.Accessibility') IN (0, 1)
			   AND json_extract(data, '$.Type') = ?1
			 ORDER BY id DESC LIMIT ?2`
		)
		.bind(SavedImageType.ShareCamera, limit)
		.all<ImageRow>()
	const images = results.map((r) => JSON.parse(r.data) as SavedImage)

	const roomIds = [...new Set(images.map((i) => i.RoomId).filter((v): v is number => v != null))]
	const usernames = await getUsernames(db, [...new Set(images.map((i) => i.PlayerId))])
	const roomNames = await getRoomNames(db, roomIds)

	return images.map((img) => ({
		SavedImageId: img.Id,
		ImageName: img.ImageName,
		// Fall back to the synthesized "Player<id>" name for accounts not in the table.
		Username: usernames.get(img.PlayerId) ?? `Player${img.PlayerId}`,
		RoomName: img.RoomId != null ? (roomNames.get(img.RoomId) ?? null) : null,
		RoomId: img.RoomId,
		SavedImageType: img.Type,
		PlayerEventId: img.PlayerEventId,
		Accessibility: img.Accessibility,
		PlayerIds: img.TaggedPlayerIds,
	}))
}

/**
 * A player's photo feed — the public images they took plus the ones they're
 * tagged in (TaggedPlayerIds). Newest first, paginated via skip/take; returns a
 * bare array of SavedImage. The tagged-in match uses json_each over the stored
 * TaggedPlayerIds array (there's no index for it).
 */
export async function getPlayerFeed(
	db: D1Database,
	playerId: number,
	skip: number,
	take: number
): Promise<SavedImage[]> {
	const { results } = await db
		.prepare(
			`SELECT data FROM image
			 WHERE player_id = ?1
			    OR EXISTS (SELECT 1 FROM json_each(image.data, '$.TaggedPlayerIds') WHERE value = ?1)`
		)
		.bind(playerId)
		.all<ImageRow>()
	return results
		.map((r) => JSON.parse(r.data) as SavedImage)
		.filter((img) => img.Accessibility === 1)
		.sort(newestFirst)
		.slice(skip, skip + take)
}
