import { resolver } from 'hono-openapi'
import { z } from 'zod'

import type { OpenAPIV3_1 } from 'openapi-types'

/**
 * OpenAPI schemas for the rooms worker.
 *
 * IMPORTANT: these are DESCRIPTIVE ONLY. They are passed to `describeRoute` to
 * generate the spec and are never wired into `hono-openapi`'s `validator()`. Same
 * rationale as the auth/accounts/match/econ/clubs workers: a reverse-engineered
 * protocol, lenient handlers, no runtime validation.
 *
 * Do NOT add `.meta({ id })` to these schemas — with this hono-openapi + zod v4 setup a
 * meta'd schema used in a response emits a `$ref` the framework doesn't always hoist
 * into `components.schemas`, leaving a dangling reference. Leaving meta off makes every
 * schema inline, which renders correctly in any tool.
 */

/** Emit a zod schema as an `application/json` response body. */
export function json(schema: z.ZodType, description: string) {
	return { description, content: { 'application/json': { schema: resolver(schema) } } }
}

function toOpenApiSchema(schema: z.ZodType): OpenAPIV3_1.SchemaObject {
	const { $schema: _$schema, additionalProperties: _extra, ...jsonSchema } = z.toJSONSchema(schema)
	return jsonSchema as OpenAPIV3_1.SchemaObject
}

/** A form-urlencoded / multipart request body (the client posts both). */
export function form(schema: z.ZodType, description: string): OpenAPIV3_1.RequestBodyObject {
	const s = toOpenApiSchema(schema)
	return {
		description,
		content: {
			'application/x-www-form-urlencoded': { schema: s },
			'multipart/form-data': { schema: s },
		},
	}
}

/** An `application/json` request body. */
export function jsonBody(schema: z.ZodType, description: string): OpenAPIV3_1.RequestBodyObject {
	return { description, content: { 'application/json': { schema: toOpenApiSchema(schema) } } }
}

/** Bearer-JWT security requirement, for the auth-gated routes. */
export const AUTHED = [{ bearerAuth: [] }]

/**
 * The 401 the auth-gated routes return. Most answer `{ error: 'Unauthorized' }`; the
 * subroom writes answer an empty body (see UNAUTHORIZED_EMPTY / UNAUTHORIZED_ENVELOPE).
 */
export const UNAUTHORIZED_RESPONSE = json(
	z.object({ error: z.literal('Unauthorized') }),
	'Missing or invalid bearer token'
)

/** The empty-body 401 the subroom-save route returns. */
export const UNAUTHORIZED_EMPTY = { description: 'Missing or invalid bearer token (empty body)' }

/** The 403 the owner/co-owner-gated routes return (empty body). */
export const FORBIDDEN_RESPONSE = {
	description: 'A valid token, but not the room’s creator or a co-owner (empty body)',
}

/** The 403 the friends-only routes return (empty body). */
export const NOT_FRIENDS_RESPONSE = {
	description:
		'A valid token, but the caller is not that player (nor a friend of theirs) (empty body)',
}

// ---- Parameters ------------------------------------------------------------

/** A digits-only id path parameter (the route patterns constrain these to `[0-9]+`). */
function idParam(name: string, description: string): OpenAPIV3_1.ParameterObject {
	return {
		name,
		in: 'path',
		required: true,
		description,
		schema: { type: 'string', pattern: '^[0-9]+$' },
	}
}

/** The `:roomId` path parameter. */
export const roomIdParam = idParam('roomId', 'Room id')

/** The `:subRoomId` path parameter. */
export const subRoomIdParam = idParam('subRoomId', 'Subroom id (globally unique, not per-room)')

/** The `:saveId` path parameter — a `subroom_save` id (globally unique, not per-subroom). */
export const saveIdParam = idParam('saveId', 'The save’s id, as `…/saves` lists it')

/** The `:playerId` path parameter (an account id). */
export const playerIdParam = idParam('playerId', 'The account whose list to read')

/** The `:playerId` path parameter on the unban route. */
export const bannedPlayerIdParam = idParam('playerId', 'The banned account to unban')

/** An optional string query parameter. */
export function stringQuery(name: string, description: string): OpenAPIV3_1.ParameterObject {
	return { name, in: 'query', required: false, description, schema: { type: 'string' } }
}

/** An optional integer query parameter. */
function intQuery(name: string, description: string): OpenAPIV3_1.ParameterObject {
	return { name, in: 'query', required: false, description, schema: { type: 'integer' } }
}

/** The `skip`/`take` pair every paginated room list accepts. */
export function pageParams(defaultTake: number): OpenAPIV3_1.ParameterObject[] {
	return [
		intQuery('skip', 'How many rooms to skip (default 0)'),
		intQuery('take', `How many rooms to return (default ${defaultTake})`),
	]
}

// ---- Core entities ---------------------------------------------------------

/** `GET /` — the liveness probe body. */
export const ServiceStatus = z.object({
	service: z.literal('rooms'),
	status: z.literal('ok'),
})

/** A room-role assignment. `Role`: 10 Host, 20 Moderator, 30 CoOwner, 255 Creator. */
export const RoomRoleDto = z.object({
	AccountId: z.int(),
	Role: z.int().describe('10 = Host, 20 = Moderator, 30 = CoOwner, 255 = Creator'),
	LastChangedByAccountId: z.int().nullable(),
	InvitedRole: z.int(),
})

/** A tag on a room. `Type` 0 = set by the owner, 2 = auto-derived (e.g. `rro`). */
export const RoomTagDto = z.object({
	Tag: z.string(),
	Type: z.int().describe('0 = owner-set, 2 = auto'),
})

/**
 * A room's engagement counters. `CheerCount`/`FavoriteCount` are aggregated from the
 * per-player `interaction` rows on every read. `VisitCount` is the room's lifetime
 * visits — the `room.visits` column, bumped by the `match` worker on every successful
 * matchmake into the room. Nothing records distinct visitors, so `VisitorCount` stays
 * at 0.
 */
export const RoomStatsDto = z.object({
	CheerCount: z.int(),
	FavoriteCount: z.int(),
	VisitorCount: z.int(),
	VisitCount: z.int(),
})

/** One of the images shown while the room loads. */
export const LoadScreenDto = z.object({
	ImageName: z.string().describe('A CDN bucket key under `room/`'),
	Title: z.string(),
	Subtitle: z.string(),
})

/**
 * The save as the room-save RESPONSE renders it — camelCase, and a different field set
 * from the PascalCase `CurrentSave` embedded in a room (no persistence/OM/UGC versions,
 * no moderation state, no asset arrays; but `unityAsset`/`unityAssetHash`/`dataBlobHash`
 * that `CurrentSave` doesn't show). The two are deliberately not unified.
 *
 * Also what `GET …/subrooms/{subRoomId}/saves/{saveId}` answers — one save fetched by id
 * is the same thing the save that created it returned, so both go through
 * `toSaveResponse`. Note the `…/saves` LIST is the third shape here: it serves the raw
 * PascalCase rows ({@link SubRoomDataSaveDto}), not this.
 */
export const SubRoomDataSaveResponseDto = z.object({
	subRoomDataSaveId: z.int(),
	subRoomId: z.int(),
	unityAssetId: z.string().nullable().describe('Null unless the save carried one'),
	unityAsset: z.string().nullable().describe('Always null — we resolve no baked assets'),
	unityAssetHash: z.string().nullable().describe('Always null — we resolve no baked assets'),
	dataBlob: z.string(),
	dataBlobHash: z.string().nullable().describe('Echoed from the request’s `SubRoomData.Hash`'),
	savedByAccountId: z.int().nullable(),
	savedOnPlatform: z
		.int()
		.describe(
			'Steam=0 Oculus=1 PlayStation=2 Xbox=3 RecNet=4 IOS=5 GooglePlay=6 Standalone=7 Pico=8'
		),
	savedOnDeviceClass: z.int().describe('Unknown=0 VR=1 Screen=2 Mobile=3 VRLow=4 Quest2=5'),
	description: z.string().nullable(),
	createdAt: z.string(),
})

/**
 * A subroom's most recent room save — the `SubRoomDataSave` the client reads to find the
 * scene-data blob to download. This is the ONLY place the loader looks for it, so a
 * subroom whose `CurrentSave` is missing loads no saved content at all.
 *
 * The array fields are always empty here: we neither resolve nor record referenced Unity
 * assets. They are still emitted because the client's parser expects them present.
 */
export const SubRoomDataSaveDto = z.object({
	UnitySubAssets: z.array(z.unknown()).describe('Always empty'),
	ReferencedUnityAssets: z.array(z.unknown()).describe('Always empty'),
	SubRoomDataSaveId: z.int().describe('Numbered from 1, incremented on every save'),
	SubRoomId: z.int().describe('The owning subroom — re-pointed when a subroom is cloned'),
	DataBlob: z.string().describe('The scene-data key the client downloads from the CDN'),
	ReferencedUnityAssetIds: z.array(z.string()).describe('Always empty'),
	PersistenceVersion: z.int(),
	OMVersion: z.int(),
	UgcSubVersion: z.int(),
	SavedByAccountId: z.int().nullable(),
	SavedOnPlatform: z.int().describe('0 — the save request carries no platform'),
	SavedOnDeviceClass: z.int().describe('0 — the save request carries no device class'),
	Description: z.string().describe('The save comment; empty string when none'),
	Tags: z.array(z.unknown()).describe('Always empty'),
	ModerationState: z.int(),
	CreatedAt: z.string(),
	UnityAssetId: z.string().optional().describe('Emitted only when the save carried one'),
})

/**
 * A subroom — a room's individual scene. Subrooms are their own table with a globally
 * unique, autoincrementing `SubRoomId` (the original game mints them from a single
 * sequence, not per-room); a room's `SubRooms` array is reconstructed on read.
 *
 * `CreatorAccountId` starts null on the seeded rooms and is filled in on the first save —
 * the client NREs on a null one. `CurrentSave` is null until the first save; the flat
 * `DataBlob`/`RoomDataBlob`/`DataSavedAt` fields are legacy and are NOT what the client
 * loads from.
 */
export const SubRoomDto = z.object({
	SubRoomId: z.int(),
	RoomId: z.int(),
	CreatorAccountId: z.int().nullable().describe('Null until the subroom’s first save'),
	UnitySceneId: z.string().describe('The Unity scene the client loads'),
	Name: z.string(),
	LastModeratedSaveModerationState: z.int(),
	IsSandbox: z.boolean(),
	MaxPlayers: z.int(),
	Accessibility: z
		.int()
		.describe('0 Private, 1 Public, 2 Unlisted, 3 Dev_only, 4 Dev_Unlisted — set independently'),
	ShouldAutoStageSaves: z.boolean(),
	StagedSubRoomDataSaveId: z.int().nullable(),
	CurrentSave: SubRoomDataSaveDto.nullable().describe(
		'The latest room save — where the client finds the scene blob. Null until first save'
	),
	DataBlob: z.string().optional().describe('Legacy flat key; the client reads `CurrentSave`'),
	RoomDataBlob: z.string().optional().describe('Uploaded room-data key; absent until first save'),
	DataSavedAt: z.string().optional().describe('ISO timestamp of the last save'),
	PersistenceVersion: z.int().optional(),
	InventionUsage: z.string().optional().describe('Recorded by a room save; absent until then'),
})

/** A room's localization settings — carried through verbatim; nothing localizes yet. */
export const LocalizationContextDto = z.object({
	TargetLocale: z.string().nullable(),
	Scope: z.string().nullable(),
	LocalizedFields: z.array(z.string()),
})

/**
 * A room, exactly as stored: each room is a single JSON blob in D1 and every read
 * serves it verbatim (PascalCase, the client-facing shape), with `SubRooms` re-attached
 * from the subroom table. The seed data comes from `static/ImportRooms.json`.
 */
export const RoomDto = z.object({
	RoomId: z.int(),
	Name: z.string().describe('Unique, case-insensitively'),
	Description: z.string(),
	ImageName: z.string().describe('A CDN bucket key served back under `room/`'),
	WarningMask: z.int().describe('Content-warning bit flags'),
	CustomWarning: z.string().nullable(),
	CreatorAccountId: z.int().describe('The room’s owner — always passes the role checks'),
	State: z.int(),
	Accessibility: z
		.int()
		.describe('0 = Private, 1 = Public, 2 = Unlisted. The room-browse feeds serve Public only'),
	PublishState: z.int(),
	SupportsLevelVoting: z.boolean(),
	IsRRO: z.boolean().describe('A Rec Room Original — the client renders a virtual `rro` tag'),
	IsRecRoomApproved: z.boolean(),
	ExcludeFromLists: z.boolean(),
	ExcludeFromSearch: z.boolean(),
	SupportsScreens: z.boolean(),
	SupportsWalkVR: z.boolean(),
	SupportsTeleportVR: z.boolean(),
	SupportsVRLow: z.boolean(),
	SupportsQuest2: z.boolean(),
	SupportsMobile: z.boolean(),
	SupportsJuniors: z.boolean(),
	MinLevel: z.int(),
	AgeRating: z.int(),
	CreatedAt: z.string(),
	PublishedAt: z.string(),
	BecameRRStudioRoomAt: z.string().nullable(),
	Stats: RoomStatsDto,
	RankingContext: z.unknown().nullable(),
	IsDorm: z.boolean().describe('Auto-provisioned personal room; excluded from every feed'),
	IsPlacePlay: z.boolean(),
	MaxPlayerCalculationMode: z.int(),
	MaxPlayers: z.int(),
	CloningAllowed: z.boolean().describe('False blocks `POST /rooms/{roomId}/clone`'),
	DisableMicAutoMute: z.boolean(),
	DisableRoomComments: z.boolean(),
	EncryptVoiceChat: z.boolean(),
	ToxmodEnabled: z.boolean(),
	LoadScreenLocked: z.boolean(),
	UgcVersion: z.int(),
	PersistenceVersion: z.int(),
	UgcSubVersion: z.int().nullable(),
	MinUgcSubVersion: z.int().nullable(),
	AutoLocalizeRoom: z.boolean(),
	LocalizationContext: LocalizationContextDto,
	IsDeveloperOwned: z.boolean(),
	RankedEntityId: z.string(),
	SubRooms: z.array(SubRoomDto).describe('Re-attached from the subroom table on every read'),
	Roles: z.array(RoomRoleDto),
	IsJuniorCreated: z.boolean(),
	Tags: z.array(RoomTagDto),
	PromoImages: z.array(z.unknown()),
	PromoExternalContent: z.array(z.unknown()),
	LoadScreens: z.array(LoadScreenDto),
	RestrictedCircuitsAllowListNames: z.array(z.string()),
	InventionUsage: z
		.string()
		.optional()
		.describe('Legacy: room saves used to write this here; it now lives on the SUBROOM'),
})

/** A paged room list (`PagedResultsDTO<RoomDTO>`) — search, hot, similar. */
export const PagedRooms = z.object({
	Results: z.array(RoomDto),
	TotalResults: z.int().describe('The full match count, not the page size'),
})

/**
 * A room lookup result: the room, or `{}` when nothing matched. The by-id/by-name
 * lookups answer an empty object rather than a 404 — the client reads that as "no room".
 */
export const RoomLookup = z.union([RoomDto, z.object({})])

/** The bare JSON string the lookup routes answer with when neither `id` nor `name` is given. */
export const MissingLookupParam = z
	.string()
	.describe("`\"Either 'id' or 'name' query parameter is required\"`")

// ---- Interaction -----------------------------------------------------------

/**
 * A player's own state on a room: whether they've cheered/favorited it, plus the last
 * visit. `LastVisitedAt` is stamped with "now" on every read rather than served from the
 * stored value — the client only uses it to order the recently-visited list.
 */
export const InteractionDto = z.object({
	Cheered: z.boolean(),
	Favorited: z.boolean(),
	LastVisitedAt: z.string().describe('Always "now" — not the stored visit time'),
})

// ---- Featured rooms --------------------------------------------------------

/** The compact room projection a featured-room group carries. */
export const FeaturedRoomDto = z.object({
	RoomId: z.int(),
	RoomName: z.string(),
	ImageName: z.string(),
	IsRecRoomApproved: z.boolean(),
	ExcludeFromLists: z.boolean(),
	ExcludeFromSearch: z.boolean(),
})

/** A time-boxed group of featured rooms. There's one, and it's always active. */
export const FeaturedRoomGroupDto = z.object({
	FeaturedRoomGroupId: z.int(),
	name: z.string(),
	StartAt: z.string(),
	EndAt: z.string(),
	Rooms: z.array(FeaturedRoomDto).describe('Randomly ordered — no editorial curation yet'),
})

// ---- Envelopes -------------------------------------------------------------
//
// The room writes answer one of two envelopes, both at HTTP 200 — the client reads the
// success flag, not the status. Which one a route uses is not ours to choose: it's what
// the client's deserializer for that call expects, so the two live side by side.

/**
 * The PascalCase result envelope (`Results.Ok(new RoomResult{...})`): a bare
 * success/failure with a message, carrying no entity. `ErrorId` is a stable code the
 * client may branch on; `Error` is the text it shows.
 */
export const RoomResultEnvelope = z.object({
	Success: z.boolean(),
	Value: z.unknown().nullable().describe('Always null — these routes carry no entity'),
	ErrorId: z
		.string()
		.nullable()
		.describe('e.g. `Rooms.DoesntExist`, `Rooms.NotOwner`; null on success'),
	Error: z.string().nullable().describe('The message shown to the player; null on success'),
})

/** The lowercase envelope carrying the updated room — the client re-renders from `value`. */
export const RoomEnvelope = z.object({
	success: z.boolean(),
	error: z.string().describe('Empty on success'),
	value: RoomDto.nullable(),
})

/**
 * What `POST /rooms/{roomId}/subrooms/{subRoomId}/data` answers: `value` carries BOTH the
 * updated room and the save that was just created. Note `error` is NULL here, not the
 * empty string the other room envelopes use.
 */
export const RoomSaveEnvelope = z.object({
	success: z.boolean(),
	error: z.string().nullable().describe('Null on success'),
	value: z
		.object({ room: RoomDto, subRoomDataSave: SubRoomDataSaveResponseDto })
		.nullable()
		.describe('Null on a rejection'),
})

/** The 401 the envelope-returning routes answer with — the only one that isn’t HTTP 200. */
export const UNAUTHORIZED_ENVELOPE = json(
	z.object({ success: z.literal(false), error: z.literal('Unauthorized'), value: z.null() }),
	'Missing or invalid bearer token'
)

// ---- Request bodies --------------------------------------------------------

/** `POST /rooms/{roomId}/clone` — also accepted as a `?name=` query param. */
export const CloneRoomRequest = z.object({
	name: z.string().describe('The new room’s name; must be unique'),
})

/** `PUT /rooms/{roomId}/description`. */
export const DescriptionRequest = z.object({
	description: z.string().describe('An absent field clears the description'),
})

/** `PUT /rooms/{roomId}/name`. */
export const NameRequest = z.object({
	name: z.string().describe('Non-empty, and not already taken by another room'),
})

/** `PUT /rooms/{roomId}/tags` — a toggle, not a set. */
export const TagRequest = z.object({
	tag: z.string().describe('Added when absent, removed when present'),
})

/** `PUT /rooms/{roomId}/image`. */
export const ImageRequest = z.object({
	imageName: z.string().describe('A key from the storage upload, stored un-prefixed'),
})

/** `PUT /rooms/{roomId}/roles/{accountId}`. */
export const RoleRequest = z.object({
	role: z.string().describe('The role tier: 10 Host, 20 Moderator, 30 CoOwner, 255 Creator'),
})

/** `POST /rooms/{roomId}/bans` — the player to ban from the room. */
export const BanRequest = z.object({
	id: z.string().describe('Account id of the player to ban'),
	banMask: z
		.string()
		.optional()
		.describe('Stored verbatim; meaning unknown — the client sends `0`. Defaults to 0'),
})

/** A stored room ban — what `POST /rooms/{roomId}/bans` answers in `value`. */
export const RoomBanDto = z.object({
	RoomId: z.int(),
	BannedPlayerId: z.int(),
	BanMask: z.int(),
	BannedByAccountId: z.int().describe('Who issued the ban'),
	CreatedAt: z.string(),
})

/**
 * One entry of `GET /rooms/{roomId}/bans` — the client's ban-list shape. camelCase and
 * a different field set from the {@link RoomBanDto} the write answers: no room id (the
 * path already says which room) and no ban mask.
 */
export const RoomBanEntryDto = z.object({
	accountId: z.int().describe('The banned player'),
	bannedByAccountId: z.int().describe('Who issued the ban'),
	banStartTime: z.string().describe('ISO 8601 UTC, when the ban was issued'),
})

/** The envelope the ban write answers — same shape as the room writes, `value` is the ban. */
export const RoomBanEnvelope = z.object({
	success: z.boolean(),
	error: z.string().describe('Empty on success'),
	value: RoomBanDto.nullable().describe('Null on a rejection'),
})

/** `PUT /rooms/{roomId}/warning`. */
export const WarningRequest = z.object({
	warningMask: z.string().describe('Content-warning bit flags, as an integer'),
	customWarning: z.string().optional().describe('Set when present; an empty value clears it'),
})

/** `PUT /rooms/{roomId}/cloning`. */
export const CloningRequest = z.object({
	cloningAllowed: z.string().describe('`True` / `False`'),
})

/**
 * `PUT /rooms/{roomId}/restrictions` — the room's platform/movement support flags. Only
 * the fields actually posted are changed, and the names are matched case-insensitively.
 */
export const RestrictionsRequest = z.object({
	supportsScreens: z.string().optional().describe('`True` / `False`'),
	supportsWalkVR: z.string().optional().describe('`True` / `False`'),
	supportsTeleportVR: z.string().optional().describe('`True` / `False`'),
	supportsVRLow: z.string().optional().describe('`True` / `False`'),
	supportsQuest2: z.string().optional().describe('`True` / `False`'),
	supportsMobile: z.string().optional().describe('`True` / `False`'),
	supportsJuniors: z.string().optional().describe('`True` / `False`'),
})

/** `PUT /rooms/{roomId}/loadscreen` — the posted screen replaces the whole list. */
export const LoadScreenRequest = z.object({
	imageName: z.string().describe('A key from the storage upload'),
	title: z.string().optional(),
	subtitle: z.string().optional(),
})

/** `PUT /rooms/{roomId}/accessibility`. */
export const AccessibilityRequest = z.object({
	accessibility: z.string().describe('0 = Private, 1 = Public, 2 = Unlisted'),
})

/**
 * `PUT /rooms/{roomId}/subrooms/{subRoomId}/accessibility`. Unlike the room-level route
 * above, the client sends the enum NAME here (`accessibility=Private`), so both the name
 * and the number are accepted.
 */
export const SubRoomAccessibilityRequest = z.object({
	accessibility: z
		.string()
		.describe(
			'A `RoomAccessibility` name — `Private`, `Public`, `Unlisted`, `Dev_only`, ' +
				'`Dev_Unlisted` (case-insensitive) — or its ordinal 0–4'
		),
})

/**
 * `PUT /rooms/{roomId}/subrooms/{subRoomId}/permissions` — the entries to change, keyed by
 * (`Permission`, `Role`). Only the pairs sent are touched. `Override` is the client's
 * checkbox: true stores the entry, false clears it back to the default.
 */
export const SubRoomPermissionsRequest = z
	.array(
		z.object({
			Permission: z
				.string()
				.describe('e.g. `CAN_SAVE_INVENTIONS`, `CAN_INVITE`, `CAN_USE_DELETE_ALL_BUTTON`'),
			Role: z.int().describe('The role tier the entry applies to (0 = everyone, 30 = co-owner)'),
			Override: z
				.boolean()
				.describe(
					'The override checkbox, and a JSON boolean unlike `Value`: true stores this entry, ' +
						'false DELETES any stored one so the pair falls back to its default'
				),
			Type: z.int().describe('Always 0 in what the client sends; stored verbatim'),
			Value: z
				.string()
				.describe(
					'A STRING, not a boolean — usually `True` / `False`, but kept verbatim: not every ' +
						'permission’s UI is a True/False picker. Ignored when `Override` is false'
				),
		})
	)
	.describe('An array — the client sends one even when changing a single permission')

/**
 * `POST /rooms/{roomId}/subrooms/{subRoomId}/publish_save` — promotes one save to live.
 * Any id from the subroom's history works, so this is both publish and restore.
 */
export const PublishSaveRequest = z.object({
	subRoomDataSaveId: z.string().describe('The `SubRoomDataSaveId` to make live'),
})

/** `POST /rooms/{roomId}/subrooms`. */
export const CreateSubRoomRequest = z.object({
	name: z.string().describe('The new subroom’s name'),
})

/** `PUT /rooms/{roomId}/subrooms/{subRoomId}/modify`. */
export const ModifySubRoomRequest = z.object({
	name: z.string().describe('Required — an empty name is rejected'),
	accessibility: z
		.string()
		.optional()
		.describe('A `RoomAccessibility` name (case-insensitive) or its ordinal 0–4'),
	maxPlayers: z.string().optional().describe('Ignored when not a positive integer'),
})

/**
 * `POST /rooms/{roomId}/subrooms/{subRoomId}/data` — the room save. The blobs are
 * uploaded to the CDN through the `storage` worker first; this call points the subroom
 * at them. Every field is optional: a save that carries only `SubRoomData` still stamps
 * the save time.
 */
export const SaveSubRoomDataRequest = z.object({
	SubRoomData: z
		.object({ Filename: z.string() })
		.optional()
		.describe('The uploaded scene-data blob — becomes the subroom’s `CurrentSave.DataBlob`'),
	RoomData: z
		.object({ Filename: z.string() })
		.optional()
		.describe('The uploaded room-level data blob — becomes `RoomDataBlob`'),
	Description: z
		.string()
		.optional()
		.describe('The save comment — a description of THIS revision, not the room’s description'),
	PersistenceVersion: z.int().optional().describe('Recorded on the save and the subroom'),
	InventionUsage: z.string().optional().describe('Recorded on the subroom'),
	UnityAssetId: z.string().nullable().optional().describe('Recorded on the save when set'),
	AutoPublish: z
		.boolean()
		.optional()
		.describe('True publishes the save immediately; otherwise it is staged'),
})

/**
 * `GET /rooms/{roomId}/subrooms/{subRoomId}/saves` — the room-history page. We keep no
 * save history (a save overwrites the subroom's blob inline), so it's always empty.
 */
export const SubRoomSavesPage = z.object({
	Results: z
		.array(SubRoomDataSaveDto)
		.describe('At most one — the current save; we keep no history'),
	TotalResults: z.int(),
	TotalCount: z.int().describe('Same value as `TotalResults` — the two references disagree'),
})

// ---- Session ---------------------------------------------------------------

/** One entry of the permission table the client applies when it spawns into a room. */
export const RoomPermissionDto = z.object({
	Override: z.boolean().describe('Always true on an entry that came from a subroom’s overrides'),
	Permission: z.string().describe('e.g. `CAN_USE_MAKER_PEN`, `CAN_SAVE_INVENTIONS`'),
	Role: z.int().describe('The role tier the permission applies to (0 = everyone)'),
	Type: z.int(),
	Value: z
		.string()
		.describe('A STRING, not a boolean — `True` on the defaults, anything on an override'),
})

/**
 * The permissions + Photon credentials the client needs to spawn into a room.
 *
 * `PhotonAccessToken` is deliberately empty: the reference server signs it with a
 * secret/algorithm we don't have, and our Photon setup accepts an empty token. The
 * global (Role 0) maker pen is granted only to the hardcoded dev accounts.
 *
 * `Permissions` is the default table with the overrides stored on the subroom the caller
 * is standing in merged over it (see
 * `PUT /rooms/{roomId}/subrooms/{subRoomId}/permissions`): an override replaces the
 * default with the same (`Permission`, `Role`), and one naming a new pair is appended.
 */
export const PhotonAccessTokenDto = z.object({
	Permissions: z.array(RoomPermissionDto),
	PhotonAccessToken: z.string().describe('Always empty — see above'),
	RoomInstanceId: z
		.int()
		.nullable()
		.describe('The caller’s current instance, from presence; null when they’re in none'),
})

/** `GET /rooms/{roomId}/playerdata/me` — per-room player data. Nothing stores any yet. */
export const PlayerDataDto = z.object({
	Data: z.string().describe('Always empty — no per-room player data is stored'),
})

/**
 * `GET /rooms/{roomId}/experience/player` — the caller's per-room experience/progression
 * entries. Stubbed empty; the element shape is unknown until something stores one.
 */
export const RoomExperiencePlayer = z
	.array(z.unknown())
	.describe('Always empty — no per-room experience is tracked')
