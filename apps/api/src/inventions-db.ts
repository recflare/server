/**
 * Saved-invention storage on the shared `recflare` D1 database. Each invention is
 * a single JSON blob in the `data` column; queryable fields (Id, CreatorPlayerId, the
 * visibility flags) are SQLite generated (virtual) columns extracted from that JSON —
 * the same JSON-blob pattern the image/rooms/accounts tables use.
 *
 * The `api` worker owns this schema/migration (migrations/0002_invention.sql,
 * applied under its own `migrations_table`). The invention's data file itself is
 * uploaded separately through the `storage` worker (under the `invention/` prefix)
 * and referenced here by `CurrentVersion.BlobName`; only the metadata lives here.
 *
 * The stored/returned DTO mirrors Rec Room's `RRInvention` (PascalCase), including
 * the nested `CurrentVersion` that carries the blob name and per-version costs —
 * shaped after a real `GET /api/inventions/v1?inventionId=…` response.
 *
 * Who OWNS an invention is a separate table (`inventory_invention`, written by the
 * `econ` worker at purchase time); this module only reads it — to fold bought inventions
 * into the caller's own list, and to rank the "top today" feed by what players actually
 * picked up today. See @repo/domain's inventory-invention-db.ts.
 */
import { getInventionAcquisitionCounts, getOwnedInventionIds } from '@repo/domain'

/**
 * Schema DDL (mirror of migrations/0002_invention.sql + 0003_invention_featured.sql +
 * 0008_invention_visibility.sql, sans any seed rows). `is_featured` backs the featured
 * feed's query and `is_published`/`hide_from_player` the "may anyone see this" filter
 * every feed shares; json_extract of a JSON `true` is 1, so those columns are 1/0 — and
 * NULL when the key is missing, which fails a `= 1` or `= 0` test either way.
 */
export const SCHEMA_DDL: string[] = [
	`CREATE TABLE IF NOT EXISTS invention (
		data TEXT NOT NULL,
		id INTEGER GENERATED ALWAYS AS (json_extract(data, '$.InventionId')) VIRTUAL,
		creator_player_id INTEGER GENERATED ALWAYS AS (json_extract(data, '$.CreatorPlayerId')) VIRTUAL,
		is_featured INTEGER GENERATED ALWAYS AS (json_extract(data, '$.IsFeatured')) VIRTUAL,
		is_published INTEGER GENERATED ALWAYS AS (json_extract(data, '$.IsPublished')) VIRTUAL,
		hide_from_player INTEGER GENERATED ALWAYS AS (json_extract(data, '$.HideFromPlayer')) VIRTUAL
	)`,
	`CREATE UNIQUE INDEX IF NOT EXISTS idx_invention_id ON invention (id)`,
	`CREATE INDEX IF NOT EXISTS idx_invention_creator ON invention (creator_player_id)`,
	`CREATE INDEX IF NOT EXISTS idx_invention_featured ON invention (is_featured)`,
]

/** A single saved version of an invention (Rec Room's `RRInventionVersion`). */
export interface InventionVersion {
	InventionId: number
	ReplicationId: string
	VersionNumber: number
	BlobName: string
	BlobHash: string | null
	InstantiationCost: number
	LightsCost: number
	ChipsCost: number
	CloudVariablesCost: number
	AICost: number
}

/**
 * Where a tag came from. 1 is a third kind the real API emits (the size bucket,
 * e.g. `medium`) that nothing here produces, so it's named but unused.
 */
export const INVENTION_TAG_TYPE = {
	custom: 0, // user submitted
	unknown: 1,
	auto: 2, // derived from the invention itself, e.g. `useonly` / `lowink`
} as const

/**
 * A tag on an invention (Rec Room's `RRInventionTag`). Stored on the record and
 * echoed back through `v1/details`; `v1/settags` answers with the bare tag names.
 */
export interface InventionTag {
	Tag: string
	Type: number
}

/** A stored invention record (Rec Room's `RRInvention`; returned by save / mine). */
export interface SavedInvention {
	InventionId: number
	ReplicationId: string
	CreatorPlayerId: number
	Name: string
	Description: string
	ImageName: string
	CurrentVersionNumber: number
	CurrentVersion: InventionVersion
	Accessibility: number
	IsPublished: boolean
	IsFeatured: boolean
	ModifiedAt: string
	CreatedAt: string
	FirstPublishedAt: string | null
	CreationRoomId: number
	NumPlayersHaveUsedInRoom: number
	NumDownloads: number
	CheerCount: number
	CreatorPermission: number
	GeneralPermission: number
	IsAGInvention: boolean
	IsCertifiedInvention: boolean
	Price: number
	AllowTrial: boolean
	HideFromPlayer: boolean
	ReferencedInventions: number[]
	/**
	 * Tags served by `v1/details` and written by `v1/settags`. Optional and unset on
	 * save: the real `RRInvention` carries no Tags field and the client sends no tags
	 * when saving, so an untagged invention's DTO stays identical to the real one.
	 */
	Tags?: InventionTag[]
}

interface InventionRow {
	data: string
}

/**
 * What the client expects back from `v6/save`: the invention and its version side
 * by side under a status envelope, rather than the single nested `RRInvention` the
 * read endpoints return. `Status` is 0 on success.
 */
export interface InventionSaveResult {
	Status: number
	Invention: SavedInvention
	InventionVersion: InventionVersion
}

/** Wrap a stored invention in the save envelope, lifting out its current version. */
export function toSaveResult(invention: SavedInvention): InventionSaveResult {
	return { Status: 0, Invention: invention, InventionVersion: invention.CurrentVersion }
}

/**
 * Invention data blobs are named `<name>.inv`, and the client expects the extension
 * on the `BlobName` it reads back. Uploads through the `storage` worker already land
 * under an `.inv` key, so this is a no-op for them; it's here so a `BlobName` we hand
 * the client can never be missing the extension.
 */
function inventionBlobName(filename: string): string {
	return filename.toLowerCase().endsWith('.inv') ? filename : `${filename}.inv`
}

/** Base64 — the encoding the real API's hash fields (`BlobHash`) come back in. */
function toBase64(bytes: ArrayBuffer): string {
	return btoa(String.fromCharCode(...new Uint8Array(bytes)))
}

/**
 * The hash of an invention's data blob: its SHA-256, base64-encoded, matching the
 * real API's `BlobHash`. Read from the checksum the `storage` worker records at
 * upload time, so this is normally a HEAD with no body transfer; a blob stored
 * before that (or by anything else) is downloaded and digested instead.
 *
 * Null when the blob isn't in the bucket — a metadata-only save names a file that
 * was never uploaded, and a hash of nothing would be worse than the absent hash the
 * field already allows for.
 */
export async function inventionBlobHash(
	bucket: R2Bucket,
	blobName: string
): Promise<string | null> {
	const key = `invention/${inventionBlobName(blobName)}`
	const head = await bucket.head(key)
	if (head === null) return null
	const recorded = head.checksums.sha256
	if (recorded !== undefined) return toBase64(recorded)

	const object = await bucket.get(key)
	return object === null
		? null
		: toBase64(await crypto.subtle.digest('SHA-256', await object.arrayBuffer()))
}

/**
 * Fields the client supplies on save (camelCase); everything else is defaulted here.
 * `inventionDataFilename` is the one the caller must supply — an invention with no
 * data blob is unusable. An empty `name`/`description` is defaulted, not rejected.
 */
export interface NewInvention {
	creatorPlayerId: number
	inventionDataFilename: string
	name?: string | null
	description?: string | null
	imageName?: string | null
	instantiationCost?: number
	lightsCost?: number
	chipsCost?: number
	cloudVariablesCost?: number
	aiCost?: number
	creationRoomId?: number | null
	referencedInventions?: number[]
}

/**
 * Insert a new invention record, returning the stored row. A freshly saved
 * invention is private/unpublished — it shows up only in the creator's own list
 * until they publish it, so Accessibility/IsPublished/FirstPublishedAt reflect that.
 *
 * It is, however, fully permissioned from the start: the creator gets Unlimited over
 * their own invention, and so does everyone else once it's published — publishing is
 * what narrows `GeneralPermission` down (to UseOnly by default). Trials are allowed.
 * The client's `creatorAccountRole` is ignored: it's the player's role in the room
 * they built it in, not a permission over the invention.
 */
export async function createInvention(
	db: D1Database,
	bucket: R2Bucket,
	input: NewInvention
): Promise<SavedInvention> {
	// Sequential id: one past the current max (the table starts empty).
	const row = await db
		.prepare('SELECT COALESCE(MAX(id), 0) + 1 AS next FROM invention')
		.first<{ next: number }>()
	const inventionId = row?.next ?? 1
	const now = new Date().toISOString()
	const blobName = inventionBlobName(input.inventionDataFilename)
	const invention: SavedInvention = {
		InventionId: inventionId,
		ReplicationId: crypto.randomUUID(),
		CreatorPlayerId: input.creatorPlayerId,
		Name: input.name?.trim() || 'Untitled',
		Description: input.description?.trim() || 'No description yet',
		ImageName: input.imageName ?? '',
		CurrentVersionNumber: 1,
		CurrentVersion: {
			InventionId: inventionId,
			ReplicationId: crypto.randomUUID(),
			VersionNumber: 1,
			BlobName: blobName,
			BlobHash: await inventionBlobHash(bucket, blobName),
			InstantiationCost: input.instantiationCost ?? 0,
			LightsCost: input.lightsCost ?? 0,
			ChipsCost: input.chipsCost ?? 0,
			CloudVariablesCost: input.cloudVariablesCost ?? 0,
			AICost: input.aiCost ?? 0,
		},
		Accessibility: 0,
		IsPublished: false,
		IsFeatured: false,
		ModifiedAt: now,
		CreatedAt: now,
		FirstPublishedAt: null,
		CreationRoomId: input.creationRoomId ?? 0,
		NumPlayersHaveUsedInRoom: 0,
		NumDownloads: 0,
		CheerCount: 0,
		CreatorPermission: INVENTION_PERMISSION.unlimited,
		GeneralPermission: INVENTION_PERMISSION.unlimited,
		IsAGInvention: false,
		IsCertifiedInvention: false,
		Price: 0,
		AllowTrial: true,
		HideFromPlayer: false,
		ReferencedInventions: input.referencedInventions ?? [],
	}
	await db.prepare('INSERT INTO invention (data) VALUES (?1)').bind(JSON.stringify(invention)).run()
	return invention
}

/**
 * The inventions a player has created — their "my inventions" list, newest first.
 * Uses the creator_player_id index; the per-player set is small, so ordering is
 * done in memory. Returns a bare array of SavedInvention.
 */
export async function getInventionsByCreator(
	db: D1Database,
	creatorPlayerId: number
): Promise<SavedInvention[]> {
	const { results } = await db
		.prepare('SELECT data FROM invention WHERE creator_player_id = ?1')
		.bind(creatorPlayerId)
		.all<InventionRow>()
	return results
		.map((r) => JSON.parse(r.data) as SavedInvention)
		.sort((a, b) => b.CreatedAt.localeCompare(a.CreatedAt) || b.InventionId - a.InventionId)
}

/**
 * The player's "my inventions" shelf (`v2/mine`): everything they created, plus
 * everything they BOUGHT. Ownership of a bought invention lives in the
 * `inventory_invention` table the `econ` worker writes at purchase time — a creator is
 * never listed there (they own theirs through `CreatorPlayerId`), so the two sets are
 * disjoint in practice and merged by id anyway.
 *
 * Bought inventions are returned whatever their state: unpublished or hidden since the
 * purchase, they are still on the shelf of the player who paid for them. An owned id
 * with no invention row left (deleted) simply drops out. Newest first, like the other
 * invention lists; not paginated.
 */
export async function getMyInventions(db: D1Database, playerId: number): Promise<SavedInvention[]> {
	const [created, ownedIds] = await Promise.all([
		getInventionsByCreator(db, playerId),
		getOwnedInventionIds(db, playerId),
	])
	const bought = await getInventionsByIds(db, ownedIds)

	const byId = new Map<number, SavedInvention>()
	for (const invention of [...created, ...bought]) byId.set(invention.InventionId, invention)
	return [...byId.values()].sort(
		(a, b) => b.CreatedAt.localeCompare(a.CreatedAt) || b.InventionId - a.InventionId
	)
}

/**
 * Whether a player owns EVERY invention in a list — the `v1/fulllineageowner` check,
 * which the client runs when saving an invention BUILT OUT OF other inventions: it is
 * asking whether this player may use each piece. An invention is the player's if they
 * created it (`CreatorPlayerId`) or acquired it (a row in `inventory_invention`); an id
 * with no invention row is not owned, so a deleted or made-up id makes the whole answer
 * false.
 *
 * Ownership is the whole test — price and `GeneralPermission` deliberately don't enter
 * into it. A free invention still has to be picked up before it can be used, and econ's
 * buyInvention writes the same inventory row for a 0-token acquisition as for a paid
 * one, so "acquired" already covers "free". Reading permission here as a second way to
 * qualify would let a player build on an invention they never took.
 *
 * The lineage is whatever the CLIENT asks about: it sends the invention plus every
 * invention nested inside it as repeated `id`s, so this checks exactly the ids given
 * and does not walk `ReferencedInventions` itself. Walking it here would answer a
 * different question than the one asked — the client knows which pieces the thing it
 * is holding is actually made of, and stale references on an old record don't.
 *
 * An empty list is owned: no invention in it is unowned. The client never asks that,
 * but false would read as "you don't own something" with nothing to name.
 */
export async function ownsAllInventions(
	db: D1Database,
	playerId: number,
	inventionIds: number[]
): Promise<boolean> {
	if (inventionIds.length === 0) return true

	// The client repeats an id when the same invention is nested more than once.
	const unique = [...new Set(inventionIds)]
	const [inventions, ownedIds] = await Promise.all([
		getInventionsByIds(db, unique),
		getOwnedInventionIds(db, playerId),
	])

	const bought = new Set(ownedIds)
	const creators = new Map(inventions.map((i) => [i.InventionId, i.CreatorPlayerId]))
	return unique.every((id) => creators.get(id) === playerId || (creators.has(id) && bought.has(id)))
}

/**
 * Invention search — the browse/search list the client shows when picking an
 * invention to spawn. Only published, non-hidden inventions are visible here (a
 * player's own unpublished ones come from `getInventionsByCreator`). `value` is
 * matched case-insensitively against the name and description, term by term; an
 * empty `value` browses everything published. Paginated via skip/take, newest
 * first. Returns a bare array — the shape the client expects from v2/search.
 */
export async function searchInventions(
	db: D1Database,
	value: string,
	skip: number,
	take: number
): Promise<SavedInvention[]> {
	let inventions = await publicInventions(db)

	const terms = value
		.trim()
		.toLowerCase()
		.split(/[\s+]+/)
		.filter(Boolean)
	for (const term of terms) {
		inventions = inventions.filter(
			(i) => i.Name.toLowerCase().includes(term) || i.Description.toLowerCase().includes(term)
		)
	}

	return inventions
		.sort((a, b) => b.CreatedAt.localeCompare(a.CreatedAt) || b.InventionId - a.InventionId)
		.slice(skip, skip + take)
}

/**
 * Every invention any player may see: published and not hidden. The feeds and
 * search all draw from this set; a player's own unpublished inventions reach them
 * only through `getInventionsByCreator`. `featuredOnly` narrows to the curated
 * ones via the indexed `is_featured` column.
 */
async function publicInventions(db: D1Database, featuredOnly = false): Promise<SavedInvention[]> {
	// All three are generated columns off the JSON blob, so the filter stays in SQL.
	const { results } = await db
		.prepare(
			`SELECT data FROM invention
			 WHERE is_published = 1
			   AND hide_from_player = 0
			   ${featuredOnly ? 'AND is_featured = 1' : ''}`
		)
		.all<InventionRow>()
	return results.map((r) => JSON.parse(r.data) as SavedInvention)
}

/** Length of the "today" window — a trailing day, not the calendar one. */
const TOP_TODAY_WINDOW_MS = 24 * 60 * 60 * 1000

/** 24 hours ago, as the ISO timestamp `acquired_at` is compared against. */
function startOfWindow(): string {
	return new Date(Date.now() - TOP_TODAY_WINDOW_MS).toISOString()
}

/**
 * The "top today" feed — the inventions other players picked up in the last 24 hours,
 * most first.
 *
 * Ranked from the acquisitions the `econ` worker records in `inventory_invention` at
 * purchase time, grouped by invention, rather than from the lifetime counters on the
 * invention itself: those never reset, so "top today" used to mean "top ever" and the
 * shelf only changed when something overtook a total built up over months.
 *
 * "Today" is a TRAILING 24 hours, not the calendar UTC day, so the feed doesn't empty
 * itself at midnight UTC and slowly refill through the small hours — it always covers a
 * full day's worth of activity. It is still genuinely a window: an invention nobody has
 * picked up since yesterday falls off, and the feed IS EMPTY when nothing at all was
 * acquired in a day. Nothing stands in for it, the same way the featured feed serves
 * nothing while nothing is curated.
 *
 * An acquired invention that has since been unpublished or hidden drops out: this is a
 * public feed, so it is filtered like every other one. Paginated via skip/take AFTER
 * that filtering, so a hidden invention doesn't leave a hole in a page.
 */
export async function getTopInventions(
	db: D1Database,
	skip: number,
	take: number
): Promise<SavedInvention[]> {
	const counts = await getInventionAcquisitionCounts(db, startOfWindow())
	if (counts.length === 0) return []

	// getInventionsByIds answers in the order it is asked, so the ranking survives the
	// load; ids with no invention row left (deleted) simply drop out.
	const ranked = await getInventionsByIds(
		db,
		counts.map((c) => c.inventionId)
	)
	return ranked.filter((i) => i.IsPublished && !i.HideFromPlayer).slice(skip, skip + take)
}

/**
 * The featured feed — published inventions flagged `IsFeatured`, newest first.
 * Selected on the indexed `is_featured` column rather than by parsing every public
 * invention.
 *
 * Curated means curated: when nothing is flagged this serves an EMPTY list rather than
 * standing in the top feed. It used to fall back, from when no invention could be
 * featured at all, but a fallback makes the shelf lie — the client labels these as
 * hand-picked, and a feed that silently becomes "top today" hides the fact that nobody
 * has picked anything.
 */
export async function getFeaturedInventions(
	db: D1Database,
	skip: number,
	take: number
): Promise<SavedInvention[]> {
	const featured = await publicInventions(db, true)
	return featured
		.sort((a, b) => b.CreatedAt.localeCompare(a.CreatedAt) || b.InventionId - a.InventionId)
		.slice(skip, skip + take)
}

/**
 * Replace an invention's tags (the `v1/settags` write). Auto tags are the ones the
 * client derives from the invention itself (Type 2); custom tags are the creator's
 * own (Type 0). Both lists are replaced wholesale — auto first, then custom, the
 * order the tags come back in — and are lowercased/trimmed and de-duplicated so
 * `details` doesn't echo back near-duplicates. Returns the stored tag list, or null
 * when there's no such invention.
 */
export async function setInventionTags(
	db: D1Database,
	inventionId: number,
	autoTags: string[],
	customTags: string[]
): Promise<InventionTag[] | null> {
	const invention = await getInventionById(db, inventionId)
	if (invention === null) return null

	const tags: InventionTag[] = []
	const seen = new Set<string>()
	for (const [list, type] of [
		[autoTags, INVENTION_TAG_TYPE.auto],
		[customTags, INVENTION_TAG_TYPE.custom],
	] as const) {
		for (const raw of list) {
			const tag = raw.trim().toLowerCase()
			if (tag === '' || seen.has(tag)) continue
			seen.add(tag)
			tags.push({ Tag: tag, Type: type })
		}
	}

	await writeInvention(db, { ...invention, Tags: tags })
	return tags
}

/**
 * What other players may do with a published invention — the `GeneralPermission`
 * ladder, each level implying the ones below it. `v1/update` takes these by name or
 * number (`permission=useonly` / `permission=20`), and `v3/publish` defaults to
 * UseOnly.
 */
export const INVENTION_PERMISSION = {
	unassigned: 0,
	limitedoneuseonly: 10,
	useonly: 20,
	editandsave: 40,
	publish: 60,
	charge: 80,
	unlimited: 100,
} as const

/**
 * Parse a permission level the way the client sends it: a name (`useonly`,
 * `edit_and_save`) or the raw number. Undefined when it's neither.
 */
export function parsePermissionLevel(value: string): number | undefined {
	const key = value.trim().toLowerCase().replace(/_/g, '')
	if (key in INVENTION_PERMISSION) {
		return INVENTION_PERMISSION[key as keyof typeof INVENTION_PERMISSION]
	}
	const numeric = Number.parseInt(value.trim(), 10)
	return Number.isNaN(numeric) ? undefined : numeric
}

/** Fields `v1/update` can change. Anything left undefined keeps its stored value. */
export interface InventionPatch {
	name?: string
	description?: string
	imageName?: string
	allowTrial?: boolean
	generalPermission?: number
}

/**
 * Apply an edit to an invention's metadata (the `v1/update` write). Only the keys
 * present on the patch change; everything else — versions, counters, published
 * state — is left alone. Publishing and pricing are deliberately *not* here: they
 * go through `publishInvention` / `setInventionPrice`, as they do in the real API.
 * Returns the updated invention, or null when there's no such row.
 */
export async function updateInvention(
	db: D1Database,
	inventionId: number,
	patch: InventionPatch
): Promise<SavedInvention | null> {
	const invention = await getInventionById(db, inventionId)
	if (invention === null) return null

	const updated: SavedInvention = {
		...invention,
		Name: patch.name ?? invention.Name,
		Description: patch.description ?? invention.Description,
		ImageName: patch.imageName ?? invention.ImageName,
		AllowTrial: patch.allowTrial ?? invention.AllowTrial,
		GeneralPermission: patch.generalPermission ?? invention.GeneralPermission,
	}
	await writeInvention(db, updated)
	return updated
}

/**
 * Publish an invention (`v3/publish`) — what puts it into search and the feeds.
 * Publishing sets the permission other players get (UseOnly unless the creator asks
 * for another level) and its price, and the first publish stamps `FirstPublishedAt`.
 * Returns the published invention, or null when there's no such row.
 */
export async function publishInvention(
	db: D1Database,
	inventionId: number,
	permissionLevel: number | undefined,
	price: number | undefined
): Promise<SavedInvention | null> {
	const invention = await getInventionById(db, inventionId)
	if (invention === null) return null

	const updated: SavedInvention = {
		...invention,
		IsPublished: true,
		GeneralPermission: permissionLevel ?? INVENTION_PERMISSION.useonly,
		Price: price ?? 0,
		FirstPublishedAt: invention.FirstPublishedAt ?? new Date().toISOString(),
	}
	await writeInvention(db, updated)
	return updated
}

/**
 * Set an invention's price (`v1/updateprice`). Returns the updated invention, or
 * null when there's no such row; the caller rejects negative prices.
 */
export async function setInventionPrice(
	db: D1Database,
	inventionId: number,
	price: number
): Promise<SavedInvention | null> {
	const invention = await getInventionById(db, inventionId)
	if (invention === null) return null
	const updated: SavedInvention = { ...invention, Price: price }
	await writeInvention(db, updated)
	return updated
}

/** The tag filter chips the client offers when browsing inventions. */
export interface InventionTagFilters {
	PinnedFilters: string[]
	PopularFilters: string[]
	TrendingFilters: string[] | null
}

/**
 * The tag filters shown on the invention browse screen (`v1/tagfilters`), derived
 * from the tags actually in use: the most common tags across published inventions,
 * most popular first, with the top few pinned. `TrendingFilters` is null — that
 * needs recent-activity tracking we don't keep, and the client treats it as absent.
 *
 * With no published, tagged inventions this is empty, which just means no chips.
 */
export async function getInventionTagFilters(db: D1Database): Promise<InventionTagFilters> {
	const counts = new Map<string, number>()
	for (const invention of await publicInventions(db)) {
		for (const tag of invention.Tags ?? []) {
			counts.set(tag.Tag, (counts.get(tag.Tag) ?? 0) + 1)
		}
	}

	const popular = [...counts.entries()]
		.sort(([tagA, countA], [tagB, countB]) => countB - countA || tagA.localeCompare(tagB))
		.slice(0, 20)
		.map(([tag]) => tag)

	return {
		PinnedFilters: popular.slice(0, 5),
		PopularFilters: popular,
		TrendingFilters: null,
	}
}

/**
 * Look up a batch of inventions by id (`v2/batch?id=1&id=2`). Returns whatever
 * exists, in the order the ids were asked for; unknown ids are simply absent. The
 * caller decides who may see what — an unpublished invention is visible only to its
 * creator — so this returns the rows unfiltered.
 */
export async function getInventionsByIds(
	db: D1Database,
	inventionIds: number[]
): Promise<SavedInvention[]> {
	if (inventionIds.length === 0) return []
	const placeholders = inventionIds.map((_, i) => `?${i + 1}`).join(', ')
	const { results } = await db
		.prepare(`SELECT data FROM invention WHERE id IN (${placeholders})`)
		.bind(...inventionIds)
		.all<InventionRow>()

	const byId = new Map<number, SavedInvention>()
	for (const row of results) {
		const invention = JSON.parse(row.data) as SavedInvention
		byId.set(invention.InventionId, invention)
	}
	return inventionIds.map((id) => byId.get(id)).filter((i): i is SavedInvention => i !== undefined)
}

/**
 * The inventions belonging to a room (`v1/room?id=…`) — the ones created there,
 * matched on `CreationRoomId`. Published, non-hidden only, so this can't expose a
 * creator's drafts to everyone else in the room. Newest first, paginated via
 * skip/take; bare array, like the other invention lists.
 */
export async function getInventionsByRoom(
	db: D1Database,
	roomId: number,
	skip: number,
	take: number
): Promise<SavedInvention[]> {
	const { results } = await db
		.prepare(
			`SELECT data FROM invention
			 WHERE json_extract(data, '$.CreationRoomId') = ?1
			   AND is_published = 1
			   AND hide_from_player = 0`
		)
		.bind(roomId)
		.all<InventionRow>()
	return results
		.map((r) => JSON.parse(r.data) as SavedInvention)
		.sort((a, b) => b.CreatedAt.localeCompare(a.CreatedAt) || b.InventionId - a.InventionId)
		.slice(skip, skip + take)
}

/**
 * A single version of an invention (`v1/version?inventionId=…&version=…`), which
 * is how the client resolves the blob to download for a given version number.
 *
 * We keep only the current version on the record — nothing writes version history
 * (there's no `v4/addversion` yet), and a fresh save is always version 1. So this
 * answers for the current version number and reports null for any other, rather
 * than inventing a version whose blob doesn't exist.
 */
export async function getInventionVersion(
	db: D1Database,
	bucket: R2Bucket,
	inventionId: number,
	versionNumber: number
): Promise<InventionVersion | null> {
	const invention = await getInventionById(db, inventionId)
	if (invention === null) return null
	if (invention.CurrentVersionNumber !== versionNumber) return null

	// A version saved before its blob finished uploading (or before we hashed on
	// save at all) carries no hash. Hash it now and keep the result, so the other
	// invention endpoints serve it too and this stays a one-time cost per blob.
	// ModifiedAt is deliberately left alone: reading a version is not an edit.
	if (invention.CurrentVersion.BlobHash === null) {
		const hash = await inventionBlobHash(bucket, invention.CurrentVersion.BlobName)
		if (hash !== null) {
			invention.CurrentVersion = { ...invention.CurrentVersion, BlobHash: hash }
			await storeInvention(db, invention)
		}
	}
	return invention.CurrentVersion
}

/** Persist an edited invention record, bumping ModifiedAt. */
async function writeInvention(db: D1Database, invention: SavedInvention): Promise<void> {
	await storeInvention(db, { ...invention, ModifiedAt: new Date().toISOString() })
}

/** Write a record back as it stands — for changes that aren't edits (see above). */
async function storeInvention(db: D1Database, invention: SavedInvention): Promise<void> {
	await db
		.prepare('UPDATE invention SET data = ?1 WHERE id = ?2')
		.bind(JSON.stringify(invention), invention.InventionId)
		.run()
}

/**
 * The tags shown on an invention's detail card (`v1/details`). Returns null when
 * there's no such invention, so the route can 404 rather than pretend the id is a
 * real, untagged invention. Untagged inventions come back as an empty list — which
 * is every invention today, since nothing writes tags yet.
 */
export async function getInventionTags(
	db: D1Database,
	inventionId: number
): Promise<InventionTag[] | null> {
	const invention = await getInventionById(db, inventionId)
	return invention === null ? null : (invention.Tags ?? [])
}

/** Look up a single invention by its numeric id, or null when there's no such row. */
export async function getInventionById(
	db: D1Database,
	inventionId: number
): Promise<SavedInvention | null> {
	const row = await db
		.prepare('SELECT data FROM invention WHERE id = ?1')
		.bind(inventionId)
		.first<InventionRow>()
	return row ? (JSON.parse(row.data) as SavedInvention) : null
}
