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
 * feed's query and `is_published`/`hide_from_player` most of the "may anyone see this"
 * filter every feed shares (see `VISIBLE_IN_FEEDS`, which also excludes unlisted ones); json_extract of a JSON `true` is 1, so those columns are 1/0 — and
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
	/**
	 * Whether the blob uses content still in beta, sent from `v9/save` on. It sits on the
	 * VERSION, where the client's own `RRInventionVersion` carries it and for the same
	 * reason the costs do: it describes the one revision saved, not the invention across
	 * all of them. `UgcVersion`, which reads like its twin, is an INVENTION field — see
	 * {@link SavedInvention}. Absent on a record saved through `v6/save`, which sends
	 * neither; the client's decoder reads a missing member as its default, so an old
	 * record is not retroactively wrong.
	 */
	HasBetaContent?: boolean
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
	 * The rest of what `v9/save` sends, kept beside `ReferencedInventions` — the field
	 * they most resemble, and the one this record has always carried on the invention.
	 * Note the v9 client's own `RRInvention` has no `Referenced*` at all (its VERSION
	 * carries them) and no `LongDescription`/`ConvertedFromInventionId` (it sends both and
	 * never reads them back); they are stored anyway, because what the client sent is
	 * worth keeping, and `toSaveResultV9` puts each where that client expects it.
	 *
	 * `UgcVersion` is the exception that has to be got right rather than tolerated: it is
	 * an invention field there, not a version one, next to `CurrentVersionNumber`.
	 *
	 * `DisplayMetadataJson` is stored as the opaque string the client sent: it is the
	 * client's own display state (`{"0":0,"99":0}`), and re-encoding it would be
	 * inventing a schema for something only the client reads.
	 *
	 * Each is absent on a `v6/save` record, which sends none of them.
	 */
	ReferencedUnityAssetIds?: string[]
	UgcVersion?: number
	LongDescription?: string
	DisplayMetadataJson?: string
	ConvertedFromInventionId?: number
	/**
	 * Tags served by `v1/details` and written by `v1/settags`. Optional: the real
	 * `RRInvention` carries no Tags field, so an untagged invention's DTO stays
	 * identical to the real one. `v6/save` never sets it (that client tags in a second
	 * call); `v9/save` sets it when its `tagsRequest` names at least one tag.
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
 * `TagsResponse.Result` on a v9 save — the client's own tag-result enum, whose members
 * run Success 0 … ReservedWordViolation 13. Only Success is named: the members between
 * were not recovered from the client, and it never reads this field anyway, so a refused
 * tag needs only to be something other than Success.
 */
export const INVENTION_TAG_RESULT = {
	success: 0,
	rejected: 1,
} as const

/**
 * The `Invention` inside a v9 save response — the client's 28-key `RRInvention`, which is
 * NOT the record this server stores (that one mirrors the older shape the read endpoints
 * still serve). The differences that matter: no nested `CurrentVersion` (the version rides
 * beside it), no `Referenced*` (they moved onto the version), no `IsPublished` (the client
 * infers it from `FirstPublishedAt`), and `UgcVersion`/`LatestVersionNumber`/
 * `ForceCannotPublish`/`IsRecRoomApproved` that the stored record has no equivalent for.
 *
 * The client reads exactly one of these keys — `InventionId` — and its decoder null-checks
 * every member and drops the ones it doesn't know, so this projection is about being right
 * rather than about being parseable.
 */
export interface InventionV9Dto {
	InventionId: number
	ReplicationId: string
	CreatorPlayerId: number
	Name: string
	Description: string
	ImageName: string
	UgcVersion: number
	CurrentVersionNumber: number
	LatestVersionNumber: number
	Accessibility: number
	ForceCannotPublish: boolean
	ModifiedAt: string
	CreatedAt: string
	FirstPublishedAt: string | null
	CreationRoomId: number | null
	NumPlayersHaveUsedInRoom: number
	NumDownloads: number
	CheerCount: number
	CreatorPermission: number
	GeneralPermission: number
	IsAGInvention: boolean
	IsCertifiedInvention: boolean
	IsRecRoomApproved: boolean
	AllowTrial: boolean
	Price: number | null
	HideFromPlayer: boolean
	DisplayMetadataJson: string | null
}

/**
 * The `InventionVersion` inside a v9 save response — the client's 13-key
 * `RRInventionVersion`. It carries `HasBetaContent`, a `CreatedAt` of its own and a
 * nullable `UgcAccessibility` the stored version has no field for, and notably NO
 * `AICost`, which the request body still sends and this server still stores.
 *
 * Both `Referenced*` lists are emitted here even though the client's DTO has room for one:
 * which of the two it is wasn't recovered, and an unknown member is dropped silently while
 * a missing one would be the list the client asked for going astray.
 */
export interface InventionVersionV9Dto {
	InventionId: number
	ReplicationId: string
	VersionNumber: number
	HasBetaContent: boolean
	InstantiationCost: number
	LightsCost: number
	ChipsCost: number
	CloudVariablesCost: number
	BlobName: string
	BlobHash: string | null
	CreatedAt: string
	UgcAccessibility: number | null
	ReferencedInventions: number[]
	ReferencedUnityAssetIds: string[]
}

/** The tag half of a v9 save — `v1/settags`' answer, folded into the save response. */
export interface InventionTagsV9Dto {
	Result: number
	Tags: string[]
}

/** The four keys inside a v9 save envelope's `Value`. `Status` is 0 on success. */
export interface InventionSaveV9Value {
	Status: number
	Invention: InventionV9Dto
	InventionVersion: InventionVersionV9Dto
	TagsResponse: InventionTagsV9Dto
}

/**
 * What `v9/save` answers, and the whole reason it isn't just v6 with a bigger body: the
 * result is ENVELOPED, where v6 serves the bare `{ Status, Invention, InventionVersion }`.
 *
 * The client's contract is two fields deep. It checks `Success`, then reads
 * `Value.Invention.InventionId` and tags the invention with it; `Error` is the only text
 * that ever reaches a human (it is logged as "Invention datablob upload failed"). `Status`
 * is deserialized and never read on this route — the failure channel is the envelope, not
 * the 55-member status enum — and so are `InventionVersion` and `TagsResponse`.
 *
 * The one shape that CRASHES the client is `Success: true` with `Value` null or absent: it
 * dereferences `Value.Invention` unguarded. `Success: false` with a null `Value` is safe —
 * that branch reads only `Error` — which is why every refusal goes through
 * {@link inventionSaveV9Failure} rather than answering a bare `{ error }` like v6 does. A
 * body that doesn't deserialize into this envelope at all is the same crash, so even the
 * 401 answers it.
 */
export interface InventionSaveV9Result {
	Value: InventionSaveV9Value | null
	Success: boolean
	Error: string | null
	error_id: string | null
}

/**
 * Project a stored invention into the v9 save envelope. `tags` are the ones stored with
 * it, answered as the bare names `v1/settags` answers with; `tagResult` says whether they
 * were taken (see {@link INVENTION_TAG_RESULT}) — a tag the rules refuse costs the tags,
 * never the save, because the save is the thing the player would have to redo.
 *
 * Fields the stored record has no equivalent for are served as what they are here rather
 * than guessed: nothing forces an invention not to publish, and nothing in this server
 * approves one.
 */
export function toSaveResultV9(
	invention: SavedInvention,
	tags: InventionTag[],
	tagResult: number = INVENTION_TAG_RESULT.success
): InventionSaveV9Result {
	const version = invention.CurrentVersion
	return {
		Value: {
			Status: 0,
			Invention: {
				InventionId: invention.InventionId,
				ReplicationId: invention.ReplicationId,
				CreatorPlayerId: invention.CreatorPlayerId,
				Name: invention.Name,
				Description: invention.Description,
				ImageName: invention.ImageName,
				UgcVersion: invention.UgcVersion ?? 0,
				CurrentVersionNumber: invention.CurrentVersionNumber,
				// One save, one version: the newest is the current one.
				LatestVersionNumber: invention.CurrentVersionNumber,
				Accessibility: invention.Accessibility,
				ForceCannotPublish: false,
				ModifiedAt: invention.ModifiedAt,
				CreatedAt: invention.CreatedAt,
				FirstPublishedAt: invention.FirstPublishedAt,
				CreationRoomId: invention.CreationRoomId,
				NumPlayersHaveUsedInRoom: invention.NumPlayersHaveUsedInRoom,
				NumDownloads: invention.NumDownloads,
				CheerCount: invention.CheerCount,
				CreatorPermission: invention.CreatorPermission,
				GeneralPermission: invention.GeneralPermission,
				IsAGInvention: invention.IsAGInvention,
				IsCertifiedInvention: invention.IsCertifiedInvention,
				IsRecRoomApproved: false,
				AllowTrial: invention.AllowTrial,
				Price: invention.Price,
				HideFromPlayer: invention.HideFromPlayer,
				DisplayMetadataJson: invention.DisplayMetadataJson ?? null,
			},
			InventionVersion: {
				InventionId: version.InventionId,
				ReplicationId: version.ReplicationId,
				VersionNumber: version.VersionNumber,
				HasBetaContent: version.HasBetaContent ?? false,
				InstantiationCost: version.InstantiationCost,
				LightsCost: version.LightsCost,
				ChipsCost: version.ChipsCost,
				CloudVariablesCost: version.CloudVariablesCost,
				BlobName: version.BlobName,
				BlobHash: version.BlobHash,
				// The version is minted with the invention, so they share a timestamp.
				CreatedAt: invention.CreatedAt,
				UgcAccessibility: null,
				ReferencedInventions: invention.ReferencedInventions,
				ReferencedUnityAssetIds: invention.ReferencedUnityAssetIds ?? [],
			},
			TagsResponse: { Result: tagResult, Tags: tags.map((t) => t.Tag) },
		},
		Success: true,
		Error: null,
		error_id: null,
	}
}

/**
 * A refused v9 save. `Value` is null, which is safe precisely because `Success` is false:
 * the client reads `Error` on that branch and nothing else. See
 * {@link InventionSaveV9Result} for why the alternative — a bare `{ error }` body — would
 * take the client down instead.
 */
export function inventionSaveV9Failure(message: string): InventionSaveV9Result {
	return { Value: null, Success: false, Error: message, error_id: null }
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
	/**
	 * The rest of what `v9/save` sends. Every one is optional and is written onto the
	 * record only when the caller actually supplied it, so a `v6/save` — which sends
	 * none of them — stores and answers exactly the record it always did.
	 */
	ugcVersion?: number
	hasBetaContent?: boolean
	referencedUnityAssetIds?: string[]
	longDescription?: string | null
	displayMetadataJson?: string | null
	convertedFromInventionId?: number | null
	/** Tags to store with the record, already normalized by {@link normalizeInventionTags}. */
	tags?: InventionTag[]
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
 *
 * The fields `v9/save` added over `v6/save` are written only when the caller supplies
 * them, so the record a v6 client stores is byte-for-byte the one it always stored —
 * the new keys appear on new records rather than being back-filled with defaults onto
 * every old one.
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
			...(input.hasBetaContent === undefined ? {} : { HasBetaContent: input.hasBetaContent }),
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
		...(input.referencedUnityAssetIds === undefined
			? {}
			: { ReferencedUnityAssetIds: input.referencedUnityAssetIds }),
		...(input.ugcVersion === undefined ? {} : { UgcVersion: input.ugcVersion }),
		...(input.longDescription ? { LongDescription: input.longDescription } : {}),
		...(input.displayMetadataJson ? { DisplayMetadataJson: input.displayMetadataJson } : {}),
		...(typeof input.convertedFromInventionId === 'number'
			? { ConvertedFromInventionId: input.convertedFromInventionId }
			: {}),
		...(input.tags?.length ? { Tags: input.tags } : {}),
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
 * Invention search — the browse/search list the client shows when picking an invention to
 * spawn. Only published, non-hidden inventions are visible here (a player's own unpublished
 * ones come from `getInventionsByCreator`). Newest first, paginated via skip/take. Returns a
 * bare array — the shape the client expects from v2/search.
 *
 * `value` is split into terms on whitespace and `+`, and EVERY term must match (AND, not OR),
 * which is what makes typing more words narrow the list. Each is matched case-insensitively
 * against the NAME and the DESCRIPTION.
 *
 * Filtered, ordered and paged entirely IN SQL. It used to read every published invention into
 * memory, filter there and slice — which meant the cost of a search grew with the whole
 * catalogue no matter how narrow the query or how small the page, and a browse screen asking
 * for 100 rows paid for all of them. `Name`, `Description` and `CreatedAt` live inside the JSON
 * blob, so they are reached with `json_extract`; `is_published`/`hide_from_player` are already
 * generated columns.
 *
 * Both sides of the comparison are lowered rather than leaning on `LIKE`, which folds case for
 * ASCII only — and invention names are full of things it would not fold. `%` and `_` in a term
 * are escaped so a player searching for one finds it instead of matching everything.
 *
 * A term starting with `#` is NOT special here: the browse screen's filter chips send `#small`,
 * and a tag appears in no name or description, so those searches find nothing. Matching tags
 * needs them out of the JSON blob and into something indexable first; until then this stays a
 * text search rather than one that scans every row to look at its tags.
 */
export async function searchInventions(
	db: D1Database,
	value: string,
	skip: number,
	take: number
): Promise<SavedInvention[]> {
	const limit = Math.max(take, 0)
	const offset = Math.max(skip, 0)
	if (limit === 0) return []

	const where = [...VISIBLE_IN_FEEDS]
	const binds: Array<string | number> = []
	/** Bind a value and get its placeholder, so the numbering can't drift as terms are added. */
	const bind = (v: string | number): string => `?${binds.push(v)}`

	for (const term of value
		.trim()
		.toLowerCase()
		.split(/[\s+]+/)
		.filter(Boolean)) {
		const escaped = term.replace(/[\\%_]/g, (ch) => `\\${ch}`)
		const pattern = bind(`%${escaped}%`)
		where.push(
			`(lower(json_extract(data, '$.Name')) LIKE ${pattern} ESCAPE '\\'` +
				` OR lower(json_extract(data, '$.Description')) LIKE ${pattern} ESCAPE '\\')`
		)
	}

	const limitAt = bind(limit)
	const offsetAt = bind(offset)
	const { results } = await db
		.prepare(
			`SELECT data FROM invention WHERE ${where.join(' AND ')}
			 ORDER BY json_extract(data, '$.CreatedAt') DESC, id DESC
			 LIMIT ${limitAt} OFFSET ${offsetAt}`
		)
		.bind(...binds)
		.all<InventionRow>()
	return results.map((r) => JSON.parse(r.data) as SavedInvention)
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
			 WHERE ${VISIBLE_IN_FEEDS.join(' AND ')}
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
 * own (Type 0). Both lists are replaced wholesale, normalized as
 * {@link normalizeInventionTags} describes. Returns the stored tag list, or null when
 * there's no such invention.
 */
export async function setInventionTags(
	db: D1Database,
	inventionId: number,
	autoTags: string[],
	customTags: string[]
): Promise<InventionTag[] | null> {
	const invention = await getInventionById(db, inventionId)
	if (invention === null) return null

	const tags = normalizeInventionTags(autoTags, customTags)
	await writeInvention(db, { ...invention, Tags: tags })
	return tags
}

/**
 * The two tag lists as they are stored: auto first (Type 2), then custom (Type 0) —
 * the order they come back in — each trimmed, lowercased and de-duplicated across both
 * lists so `details` doesn't echo back near-duplicates. Blanks are dropped: the client
 * pads its lists with empties.
 *
 * Shared by `v1/settags` and by `v9/save`, which carries the same two lists in its
 * `tagsRequest` — a tag has to mean the same thing however it arrived.
 */
export function normalizeInventionTags(autoTags: string[], customTags: string[]): InventionTag[] {
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
	// Recovered from the client's own ladder; nothing here sends it, and no name for it
	// appears in `v1/update`'s picker.
	disallowkeylock: 15,
	useonly: 20,
	editandsave: 40,
	publish: 60,
	charge: 80,
	unlimited: 100,
} as const

/**
 * Where a published invention may be FOUND, which `v4/publish` sets and nothing before it
 * did — every record written before that endpoint carries 0, the value a save mints.
 *
 * Only `unlisted` is recovered from the client for certain; the other two mirror the room
 * accessibility enum, which they match member-for-member, and the publish sheet sends 1 for
 * an ordinary publish.
 *
 * Note what that leaves ambiguous: a stored 0 is either "private" or "written before this
 * enum meant anything", and the two are indistinguishable without a backfill. So the browse
 * filter excludes `unlisted` by name rather than requiring `public` — the latter reads
 * every invention published through `v3/publish` as private and empties the feeds.
 */
export const INVENTION_ACCESSIBILITY = {
	private: 0,
	public: 1,
	unlisted: 2,
} as const

/**
 * The "anyone may come across this" test the browse feeds and search share: published, not
 * hidden, and not unlisted. An unlisted invention is still reachable BY ID — that is what
 * unlisted means — so the by-id reads deliberately don't apply it.
 */
const VISIBLE_IN_FEEDS = [
	'is_published = 1',
	'hide_from_player = 0',
	`COALESCE(json_extract(data, '$.Accessibility'), 0) <> ${INVENTION_ACCESSIBILITY.unlisted}`,
]

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
	/**
	 * The rest of what `v2/metadata` can edit. Undefined leaves the stored value alone,
	 * which is how both editors say "not this field" — `v1/update` by omitting the query
	 * param, `v2/metadata` by sending the key as null.
	 */
	longDescription?: string
	tags?: InventionTag[]
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
		// Both of these are optional ON the record, so an untouched one resolves to
		// undefined and JSON.stringify drops the key — an invention that never had a long
		// description doesn't acquire an empty one by being edited.
		LongDescription: patch.longDescription ?? invention.LongDescription,
		Tags: patch.tags ?? invention.Tags,
	}
	await writeInvention(db, updated)
	return updated
}

/**
 * What a publish decides. Each is optional and an omitted one keeps what the invention
 * has — except the permission, which falls back to UseOnly, the level the older
 * `v3/publish` has always defaulted to when its query string named none.
 */
export interface InventionPublish {
	permissionLevel?: number
	accessibility?: number
	price?: number
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
	publish: InventionPublish = {}
): Promise<SavedInvention | null> {
	const invention = await getInventionById(db, inventionId)
	if (invention === null) return null

	const updated: SavedInvention = {
		...invention,
		IsPublished: true,
		GeneralPermission: publish.permissionLevel ?? INVENTION_PERMISSION.useonly,
		Accessibility: publish.accessibility ?? invention.Accessibility,
		// An unmentioned price is the price it already has, not zero: a republish that says
		// nothing about money must not quietly give away something that was for sale. A
		// first publish is unaffected — a fresh invention's price is 0 either way.
		Price: publish.price ?? invention.Price,
		// The FIRST publish is the one that gets dated; re-publishing doesn't reset it.
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

/**
 * Delete an invention (`v2/delete`), returning the record that was removed, or null
 * when there's no such row. The whole invention lives in the one JSON blob, so its
 * versions, tags and referenced-invention lists go with it in a single DELETE.
 *
 * Two things are deliberately LEFT behind.
 *
 * The data blob in R2 stays: it is named by the file the creator uploaded through the
 * `storage` worker, and nothing here knows whether another record still points at that
 * name (a converted invention carries the same lineage, and a save that reuses a
 * filename reuses the object). An orphan blob costs storage; a missing one breaks
 * whatever still references it.
 *
 * The `inventory_invention` rows stay too — deleting a creator's invention must not
 * rewrite what other players bought. They already fall out of every list on their own:
 * `getMyInventions` resolves owned ids against this table and an id with no row left
 * simply drops out, and `ownsAllInventions` reads a missing row as not-owned. Purging
 * them would also erase the acquisition history that ranks the "top today" feed.
 */
export async function deleteInvention(
	db: D1Database,
	inventionId: number
): Promise<SavedInvention | null> {
	const invention = await getInventionById(db, inventionId)
	if (invention === null) return null
	await db.prepare('DELETE FROM invention WHERE id = ?1').bind(inventionId).run()
	return invention
}

/**
 * What `v2/delete` answers: the same `{ Value, Success, Error, error_id }` envelope the
 * other newer-client invention routes use, with `Value` always NULL — the invention is
 * gone, so there is nothing for the client to redraw from and it reads only `Success`
 * (and `Error`, the one string that reaches a human). This is why the delete does not
 * borrow {@link InventionSaveV9Result}: that envelope's `Value` carries an invention the
 * client dereferences, and a delete has none to give.
 */
export interface InventionDeleteResult {
	Value: null
	Success: boolean
	Error: string | null
	error_id: string | null
}

/** The delete envelope: a refusal when given a message, success when given null. */
export function inventionDeleteResult(error: string | null = null): InventionDeleteResult {
	return { Value: null, Success: error === null, Error: error, error_id: null }
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
			   AND ${VISIBLE_IN_FEEDS.join(' AND ')}`
		)
		.bind(roomId)
		.all<InventionRow>()
	return results
		.map((r) => JSON.parse(r.data) as SavedInvention)
		.sort((a, b) => b.CreatedAt.localeCompare(a.CreatedAt) || b.InventionId - a.InventionId)
		.slice(skip, skip + take)
}

/**
 * The `version` that means "whichever is current" rather than a version number to match.
 *
 * Zero is not a version any invention has — a fresh save is version 1 — so a caller sending
 * it does not know which version it wants, and reading it literally finds nothing.
 */
const CURRENT_INVENTION_VERSION = 0

/**
 * A single version of an invention (`v1/version?inventionId=…&version=…`), which
 * is how the client resolves the blob to download for a given version number.
 *
 * We keep only the current version on the record — nothing writes version history
 * (there's no `v4/addversion` yet), and a fresh save is always version 1. So this
 * answers for the current version number and reports null for any other, rather
 * than inventing a version whose blob doesn't exist.
 *
 * VERSION 0 is the exception: it means "whichever version is current" rather than a
 * version number to match, and gets {@link CURRENT_INVENTION_VERSION}. The client asks
 * for 0 when it has an invention id but no version to go with it — a discovery row or a
 * spawn that carries the id alone — and there is no version 0 to find, so matching it
 * literally 404s and the invention silently fails to load. Answering with the current
 * version is what it would have asked for had it known the number.
 */
export async function getInventionVersion(
	db: D1Database,
	bucket: R2Bucket,
	inventionId: number,
	versionNumber: number
): Promise<InventionVersion | null> {
	const invention = await getInventionById(db, inventionId)
	if (invention === null) return null
	if (
		versionNumber !== CURRENT_INVENTION_VERSION &&
		invention.CurrentVersionNumber !== versionNumber
	) {
		return null
	}

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
