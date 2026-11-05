/**
 * Image-metadata storage on the shared `recflare` D1 database. Each image is a
 * single JSON blob in the `data` column; queryable fields (Id, ImageName,
 * PlayerId, RoomId, Type, Accessibility, CreatedAt) are SQLite generated (virtual) columns extracted from that
 * JSON — the same JSON-blob pattern the rooms/accounts tables use.
 *
 * The `img` worker owns the schema/migrations (migrations/0001_image.sql,
 * 0002_image_interaction.sql, 0003_image_slideshow_index.sql and 0004_image_tag.sql, applied with its own `migrations_table` so they don't
 * clash with the other workers' migrations on the shared database); the `api` worker
 * handles uploads, cheers and the photo feeds. Other workers (`clubs`, for a club's
 * gallery) only read: they store an image *name* but have to serve the client the
 * whole image record, since the client deserializes those into its `SavedImage`
 * type, not into strings.
 */

/** Schema DDL (mirror of the `img` worker's migrations, sans any seed rows). */
export const IMAGE_SCHEMA_DDL: string[] = [
	`CREATE TABLE IF NOT EXISTS image (
		data TEXT NOT NULL,
		id INTEGER GENERATED ALWAYS AS (json_extract(data, '$.Id')) VIRTUAL,
		image_name TEXT GENERATED ALWAYS AS (json_extract(data, '$.ImageName')) VIRTUAL,
		player_id INTEGER GENERATED ALWAYS AS (json_extract(data, '$.PlayerId')) VIRTUAL,
		room_id INTEGER GENERATED ALWAYS AS (json_extract(data, '$.RoomId')) VIRTUAL,
		type INTEGER GENERATED ALWAYS AS (json_extract(data, '$.Type')) VIRTUAL,
		accessibility INTEGER GENERATED ALWAYS AS (json_extract(data, '$.Accessibility')) VIRTUAL,
		created_at TEXT GENERATED ALWAYS AS (json_extract(data, '$.CreatedAt')) VIRTUAL
	)`,
	`CREATE UNIQUE INDEX IF NOT EXISTS idx_image_id ON image (id)`,
	`CREATE INDEX IF NOT EXISTS idx_image_image_name ON image (image_name)`,
	`CREATE INDEX IF NOT EXISTS idx_image_player_id ON image (player_id)`,
	`CREATE INDEX IF NOT EXISTS idx_image_room_id ON image (room_id)`,
	// The slideshow's window scan (migrations/0003): public photos by recency, so the feed
	// reads only the recent window's rows rather than json_extracting the whole table.
	`CREATE INDEX IF NOT EXISTS idx_image_slideshow ON image (type, accessibility, created_at)`,
	// A player's interaction with a saved image — one row per (player, image). Only
	// `cheered` for now; named generically so other per-user interactions (e.g.
	// favorited) can be added as columns. The `api` worker writes it (cheer endpoints)
	// and keeps the image's denormalized `CheerCount` in sync from it.
	`CREATE TABLE IF NOT EXISTS image_interaction (
		player_id INTEGER NOT NULL,
		saved_image_id INTEGER NOT NULL,
		cheered INTEGER NOT NULL DEFAULT 0,
		created_at TEXT,
		PRIMARY KEY (player_id, saved_image_id)
	)`,
	`CREATE INDEX IF NOT EXISTS idx_image_interaction_image ON image_interaction (saved_image_id)`,
	// Who is tagged in which photo (migrations/0004), so a player's tagged-in photos are an
	// index lookup rather than a json_each scan of every image. The blob's TaggedPlayerIds
	// stays the record; the triggers keep this in step with it on insert/delete (tags are
	// only set on upload, so nothing updates them).
	`CREATE TABLE IF NOT EXISTS image_tag (
		player_id INTEGER NOT NULL,
		saved_image_id INTEGER NOT NULL,
		PRIMARY KEY (player_id, saved_image_id)
	) WITHOUT ROWID`,
	`CREATE INDEX IF NOT EXISTS idx_image_tag_image ON image_tag (saved_image_id)`,
	`CREATE TRIGGER IF NOT EXISTS image_tag_after_insert AFTER INSERT ON image BEGIN
		INSERT OR IGNORE INTO image_tag (player_id, saved_image_id)
		SELECT value, NEW.id FROM json_each(NEW.data, '$.TaggedPlayerIds') WHERE value IS NOT NULL;
	END`,
	`CREATE TRIGGER IF NOT EXISTS image_tag_after_delete AFTER DELETE ON image BEGIN
		DELETE FROM image_tag WHERE saved_image_id = OLD.id;
	END`,
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

/** Build the `?1,?2,…` placeholder list for an `IN (…)` clause. */
const placeholders = (n: number): string =>
	Array.from({ length: n }, (_, i) => `?${i + 1}`).join(',')

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

/** How many image ids one cheer lookup may bind: D1's 100-parameter cap, less the player id. */
const CHEER_ID_LIMIT = 99

/**
 * Which of the given saved-image ids the player has cheered — the set of cheered
 * ids (a subset of `ids`). Backs the bulk `cheered` lookup. Empty input → empty set.
 */
export async function getCheeredImageIds(
	db: D1Database,
	playerId: number,
	ids: number[]
): Promise<Set<number>> {
	const cheered = new Set<number>()
	// D1 caps a query at 100 bound parameters and the player id takes one of them, so a
	// photo grid asking about more images than that is split across queries rather than
	// failing the whole read. The client really does send a page of ~100 at a time.
	for (let i = 0; i < ids.length; i += CHEER_ID_LIMIT) {
		const page = ids.slice(i, i + CHEER_ID_LIMIT)
		const inList = page.map((_, n) => `?${n + 2}`).join(',')
		const { results } = await db
			.prepare(
				`SELECT saved_image_id AS id FROM image_interaction
			 WHERE player_id = ?1 AND cheered = 1 AND saved_image_id IN (${inList})`
			)
			.bind(playerId, ...page)
			.all<{ id: number }>()
		for (const row of results) cheered.add(row.id)
	}
	return cheered
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
 * Look up one image record by id, or null. Whatever its accessibility — unlike
 * {@link getImagesByIds} this does not filter, so the caller decides who may see a
 * private one.
 */
export async function getImageById(db: D1Database, id: number): Promise<SavedImage | null> {
	const row = await db.prepare('SELECT data FROM image WHERE id = ?1').bind(id).first<ImageRow>()
	return row ? (JSON.parse(row.data) as SavedImage) : null
}

/**
 * Look up image records by name (the R2 key), returned keyed by ImageName. One query
 * for the whole set; names with no record are simply absent from the map.
 */
export async function getSavedImagesByNames(
	db: D1Database,
	names: string[]
): Promise<Map<string, SavedImage>> {
	if (names.length === 0) return new Map()
	const { results } = await db
		.prepare(`SELECT data FROM image WHERE image_name IN (${placeholders(names.length)})`)
		.bind(...names)
		.all<ImageRow>()
	return new Map(
		results.map((r) => {
			const image = JSON.parse(r.data) as SavedImage
			return [image.ImageName, image]
		})
	)
}

/** How many image ids one bulk lookup may bind: D1 caps a query at 100 parameters. */
const IMAGE_ID_LIMIT = 100

/**
 * Look up image records by id — the bulk lookup behind `GET /api/images/v5/bulk`.
 * Returned in REQUEST order, so the caller can line the answers up with what it asked
 * for; an id with no record, or one that isn't public, is simply absent rather than a
 * hole in the list.
 *
 * Public-only, like the room feed ({@link getImagesByRoom}) and the player lists when
 * anyone but the owner reads them ({@link getImagesByPlayer}). Image ids are sequential,
 * so serving whatever an id names would make a private photo readable by anyone who
 * counts.
 */
export async function getImagesByIds(db: D1Database, ids: number[]): Promise<SavedImage[]> {
	if (ids.length === 0) return []

	const found = new Map<number, SavedImage>()
	// D1 caps a query at 100 bound parameters, and the client asks about a whole photo
	// grid at once, so a large request is split rather than failing outright.
	for (let i = 0; i < ids.length; i += IMAGE_ID_LIMIT) {
		const page = ids.slice(i, i + IMAGE_ID_LIMIT)
		const { results } = await db
			.prepare(`SELECT data FROM image WHERE id IN (${placeholders(page.length)})`)
			.bind(...page)
			.all<ImageRow>()
		for (const row of results) {
			const image = JSON.parse(row.data) as SavedImage
			if (image.Accessibility === 1) found.set(image.Id, image)
		}
	}

	return ids.map((id) => found.get(id)).filter((image): image is SavedImage => image !== undefined)
}

/**
 * A minimal SavedImage for an image name with no metadata row — enough for the client
 * to render the picture. Uploads normally write a row first, so this only covers a
 * name that was set directly (or whose row was since deleted).
 */
export function placeholderSavedImage(imageName: string): SavedImage {
	return {
		Id: 0,
		Type: 1,
		Accessibility: 1,
		AccessibilityLocked: false,
		ImageName: imageName,
		Description: null,
		PlayerId: 0,
		TaggedPlayerIds: [],
		RoomId: null,
		PlayerEventId: null,
		CreatedAt: new Date(0).toISOString(),
		CheerCount: 0,
		CommentCount: 0,
	}
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
 * Set an image's `Accessibility` (0 private, 1 public) in place on the stored record.
 * Authorization — the caller must be the image's `PlayerId`, and a locked image
 * (`AccessibilityLocked`, set by moderation) refuses — is the route's job
 * (see modifyaccessibility).
 */
export async function setImageAccessibility(
	db: D1Database,
	image: SavedImage,
	accessibility: number
): Promise<void> {
	await db
		.prepare(
			"UPDATE image SET data = json_set(data, '$.Accessibility', CAST(?2 AS INTEGER)) WHERE id = ?1"
		)
		.bind(image.Id, accessibility)
		.run()
}

/**
 * Set an image's `Description` in place on the stored record; `null` clears it.
 * Authorization (the caller must be the image's `PlayerId`) is the route's job
 * (see modifydescription).
 */
export async function setImageDescription(
	db: D1Database,
	image: SavedImage,
	description: string | null
): Promise<void> {
	// json_set with a bound NULL stores SQL NULL, not JSON null, so spell the null out.
	const sql =
		description === null
			? "UPDATE image SET data = json_set(data, '$.Description', json('null')) WHERE id = ?1"
			: "UPDATE image SET data = json_set(data, '$.Description', ?2) WHERE id = ?1"
	const stmt = db.prepare(sql)
	await (description === null ? stmt.bind(image.Id) : stmt.bind(image.Id, description)).run()
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
 * Whether a read of `playerId`'s photos should include the ones they keep private:
 * only when the viewer IS that player. Nobody else — not a friend, not a co-owner,
 * not staff — sees a private photo through the player lists; the owner's own view is
 * the one exception to "every image read here is public-only", and it exists because
 * the profile a player opens on themselves (in game and on the website) is where they
 * find the photos they haven't shared yet.
 */
const ownView = (playerId: number, viewerId: number | null | undefined): boolean =>
	viewerId != null && viewerId === playerId

/**
 * Whether an image belongs in a player's photo list: a camera photo, not one of the
 * thumbnails filed under the same player (their outfits, room and invention pictures,
 * profile shots — every other {@link SavedImageType}). Those are stored as images too,
 * and until this was applied they surfaced in the list beside the real photos.
 */
const isPhoto = (img: SavedImage): boolean => img.Type === SavedImageType.ShareCamera

/**
 * The camera photos a player has taken ({@link isPhoto}) — their photo list, newest
 * first. Public only, unless `viewerId` is the player themself (see {@link ownView}),
 * in which case their private photos are in the list too.
 * Paginated via skip/take; returns a bare array of SavedImage. Uses the
 * player_id index; the per-player set is small, so filtering/sorting is in memory.
 */
export async function getImagesByPlayer(
	db: D1Database,
	playerId: number,
	sort: number,
	skip: number,
	take: number,
	viewerId?: number | null
): Promise<SavedImage[]> {
	const { results } = await db
		.prepare('SELECT data FROM image WHERE player_id = ?1')
		.bind(playerId)
		.all<ImageRow>()
	const own = ownView(playerId, viewerId)
	return results
		.map((r) => JSON.parse(r.data) as SavedImage)
		.filter((img) => isPhoto(img) && (own || img.Accessibility === 1))
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

/**
 * The bulk-lookup projection (`GET /api/images/v5/bulk`): the {@link ImagesPlayer} shape
 * plus a `ClubId`. Images aren't filed under clubs here, so it is always null — but the
 * key is part of the shape and must be present.
 */
export interface ImagesBulk {
	SavedImageId: number
	ImageName: string
	PlayerId: number
	RoomId: number | null
	PlayerEventId: number | null
	ClubId: number | null
	Description: string | null
	Accessibility: number
	AccessibilityLocked: boolean
	SavedImageType: number
	CreatedAt: string
	CheerCount: number
	CommentCount: number
}

/** Project a stored image to the bulk lookup's {@link ImagesBulk} shape. */
export function toImagesBulk(img: SavedImage): ImagesBulk {
	return {
		SavedImageId: img.Id,
		ImageName: img.ImageName,
		PlayerId: img.PlayerId,
		RoomId: img.RoomId,
		PlayerEventId: img.PlayerEventId,
		ClubId: null,
		Description: img.Description,
		Accessibility: img.Accessibility,
		AccessibilityLocked: img.AccessibilityLocked,
		SavedImageType: img.Type,
		CreatedAt: img.CreatedAt,
		CheerCount: img.CheerCount,
		CommentCount: img.CommentCount,
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

/** The slideshow ranks photos taken in this many days by cheers. */
export const SLIDESHOW_DAYS = 7

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
 * The global slideshow feed — PUBLIC ShareCamera photos across all rooms (Accessibility 1,
 * Type 1), the most cheered of those taken in the last {@link SLIDESHOW_DAYS} days first
 * (newest breaks ties), capped at `limit`. When the window holds fewer than `limit`, older
 * photos follow newest first, so a quiet stretch still fills the feed instead of serving it
 * short or empty. Accessibility 0 is a private photo — the same bar every other public
 * image read here applies — and the feed is anonymous, so it must never surface one. Only
 * ShareCamera images are surfaced (not room/profile/invention thumbnails), and only ones
 * taken in a room: a photo with no `RoomId` (null, or the 0/-1 "none" a client may send)
 * stays out, since the slideshow captions every photo with where it was taken. Each row is
 * joined to its creator's username and (if any) its room's name, resolved in two batched
 * lookups to avoid an N+1 across the (at most `limit`) images.
 */
export async function getSlideshowImages(
	db: D1Database,
	limit = SLIDESHOW_LIMIT
): Promise<SlideshowImage[]> {
	const since = new Date(Date.now() - SLIDESHOW_DAYS * 24 * 60 * 60 * 1000).toISOString()
	// Two reads, both on idx_image_slideshow, so D1 bills for the window's photos rather than
	// the whole table. The ranking needs every photo in the window (any of them could be
	// the most cheered); the top-up walks the index newest-first and stops at `limit`.
	const { results: recent } = await db
		.prepare(
			`SELECT data FROM image
			 WHERE type = ?1 AND accessibility = 1 AND room_id > 0 AND created_at >= ?2
			 ORDER BY json_extract(data, '$.CheerCount') DESC, created_at DESC
			 LIMIT ?3`
		)
		.bind(SavedImageType.ShareCamera, since, limit)
		.all<ImageRow>()
	const results =
		recent.length >= limit
			? recent
			: recent.concat(
					(
						await db
							.prepare(
								`SELECT data FROM image
								 WHERE type = ?1 AND accessibility = 1 AND room_id > 0 AND created_at < ?2
								 ORDER BY created_at DESC
								 LIMIT ?3`
							)
							.bind(SavedImageType.ShareCamera, since, limit - recent.length)
							.all<ImageRow>()
					).results
				)
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
 * A player's photo feed — the public camera photos ({@link isPhoto}) they took plus the
 * ones they're tagged in (TaggedPlayerIds). Newest first, paginated via skip/take; returns a
 * bare array of SavedImage. The tagged-in half reads `image_tag`, and the filtering,
 * ordering and paging all happen in SQL, so a page reads only the player's own and
 * tagged-in rows rather than the whole table. The unary `+` on `type`/`accessibility`
 * keeps the planner off `idx_image_slideshow`, which it otherwise picks and which scans
 * every photo; this way it looks up exactly the ids the subquery names.
 *
 * When `viewerId` is the player themself ({@link ownView}) the photos they TOOK come
 * through private ones included, as on {@link getImagesByPlayer}. A photo someone
 * else took and tagged them in stays public-only either way: its privacy is the
 * taker's to decide, and being tagged in it doesn't grant a view of it.
 */
export async function getPlayerFeed(
	db: D1Database,
	playerId: number,
	skip: number,
	take: number,
	viewerId?: number | null
): Promise<SavedImage[]> {
	const { results } = await db
		.prepare(
			`SELECT data FROM image
			 WHERE id IN (
			         SELECT id FROM image WHERE player_id = ?1
			         UNION
			         SELECT saved_image_id FROM image_tag WHERE player_id = ?1
			       )
			   AND +type = ?2
			   AND (+accessibility = 1 OR (?3 AND player_id = ?1))
			 ORDER BY created_at DESC, id DESC
			 LIMIT ?4 OFFSET ?5`
		)
		.bind(playerId, SavedImageType.ShareCamera, ownView(playerId, viewerId) ? 1 : 0, Math.max(0, take), Math.max(0, skip))
		.all<ImageRow>()
	return results.map((r) => JSON.parse(r.data) as SavedImage)
}
