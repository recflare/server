import { resolver } from 'hono-openapi'
import { z } from 'zod'

import type { OpenAPIV3_1 } from 'openapi-types'

/**
 * OpenAPI schemas for the api worker.
 *
 * IMPORTANT: these are DESCRIPTIVE ONLY. They are passed to `describeRoute` to
 * generate the spec and are never wired into `hono-openapi`'s `validator()`. Same
 * rationale as the auth/accounts/match/econ workers: a reverse-engineered protocol,
 * lenient handlers, no runtime validation.
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

/** The empty-body 401 the auth-gated routes return. */
export const UNAUTHORIZED_RESPONSE = { description: 'Missing or invalid bearer token (empty body)' }

/** Bearer-JWT security requirement, for the auth-gated routes. */
export const AUTHED = [{ bearerAuth: [] }]

/** An integer path parameter (ids are constrained to `[0-9]+` by the route pattern). */
export function idParam(name: string, description: string): OpenAPIV3_1.ParameterObject {
	return { name, in: 'path', required: true, description, schema: { type: 'integer' } }
}

/** A string path parameter. */
export function stringParam(name: string, description: string): OpenAPIV3_1.ParameterObject {
	return { name, in: 'path', required: true, description, schema: { type: 'string' } }
}

/** An optional string query parameter. */
export function stringQuery(name: string, description: string): OpenAPIV3_1.ParameterObject {
	return { name, in: 'query', required: false, description, schema: { type: 'string' } }
}

/** An optional integer query parameter (`skip` / `take` / `sort` / `filter`). */
export function intQuery(name: string, description: string): OpenAPIV3_1.ParameterObject {
	return { name, in: 'query', required: false, description, schema: { type: 'integer' } }
}

/** The `skip`/`take` pair every paginated feed accepts. */
export function pageParams(defaultTake: number): OpenAPIV3_1.ParameterObject[] {
	return [
		intQuery('skip', 'How many entries to skip (default 0)'),
		intQuery('take', `How many entries to return (default ${defaultTake})`),
	]
}

// ---- Loose shapes ----------------------------------------------------------
// Several routes serve opaque static config blobs (the game configs, the charades word
// list) or empty-list stubs. Modelling every field adds noise without value, so these
// use deliberately loose schemas.

/** An opaque JSON object (a static config blob, a stub, …). */
export const JsonObject = z.record(z.string(), z.unknown())
/** An opaque JSON array (a static list served verbatim, or an empty-list stub). */
export const JsonArray = z.array(z.unknown())

/** A bare JSON boolean — several routes answer `true`/`false` with no envelope. */
export const BareBoolean = z.boolean()

/** A bare JSON string (`POST /api/sanitize/v1` echoes one back). */
export const BareString = z.string()

/** The `{ error }` body the 400 / 403 branches return. */
export const ErrorResponse = z.object({ error: z.string() })

/**
 * The `{ success, error }` envelope the report / warning writes and the message send
 * answer with — `error` is an empty string on success, never null, and the rejected
 * branches use the same shape so there is only one thing to parse.
 */
export const SuccessErrorEnvelope = z.object({
	success: z.boolean(),
	error: z.string().describe('Empty string when the call succeeded'),
})

// ---- Config ----------------------------------------------------------------

/** `GET /api/config/v1/amplitude` — analytics keys (all disabled on this server). */
export const AmplitudeConfig = z.object({
	AmplitudeKey: z.string(),
	StatSigKey: z.string(),
	RudderStackKey: z.string(),
	UseRudderStack: z.boolean(),
})

/** `GET /api/config/v1/azurespeech` — speech-to-text config; `Enabled` is false here. */
export const AzureSpeechConfig = z.object({
	Key: z.string(),
	Region: z.string(),
	Enabled: z.boolean(),
})

/** `GET /api/config/v1/backtrace` — the client's crash-reporter budget and filters. */
export const BacktraceConfig = z.object({
	ReportBudget: z.int(),
	FilterType: z.int(),
	SampleRate: z.int(),
	LogLineCount: z.int(),
	CaptureNativeCrashes: z.int(),
	AMRThresholdMS: z.int(),
	MessageCount: z.int(),
	MessageRegex: z.string(),
	VersionRegex: z.string(),
})

/**
 * `GET /statsigUserProperties` — the reference server answers this with a single
 * `success` carrying its `StatsigEnabled` config value, an INT rather than a bool.
 */
export const StatsigUserProperties = z.object({
	success: z.int().describe('The Statsig-enabled flag, as an int (1)'),
})

/**
 * `GET /api/config/v2` — the big client config blob (a static asset), with
 * `ShareBaseUrl` derived from the deploy-time base domain.
 */
export const ApiConfigV2 = JsonObject.describe(
	'The static client config, plus a ShareBaseUrl templated from the deploy domain'
)

/**
 * `GET /api/versioncheck/islandedversions` — builds islanded onto their own matchmaking
 * pool. Always empty here.
 */
export const IslandedVersions = z.array(z.string())

/** `GET /api/versioncheck/v4` — whether the client's `?v=` build is one we serve. */
export const VersionCheck = z.object({
	VersionStatus: z.int().describe('0 = current, 1 = client on a different build'),
	UpdateNotificationStage: z.int(),
	IsVersionIslanded: z.boolean(),
	IsCrossPlayDisabled: z.boolean(),
})

// ---- Social ----------------------------------------------------------------

/**
 * The per-player relationship projection (`RelationshipResponse`). `PlayerID` is the
 * OTHER player; the type and flags are taken from the caller's own side of the row, so
 * the two players in a pair see different projections of it.
 */
export const RelationshipDto = z.object({
	PlayerID: z.int().describe('The other player in the pair'),
	RelationshipType: z
		.int()
		.describe('0 = none, 1 = friend request sent, 2 = friend request received, 3 = friend'),
	Favorited: z.int().describe('0/1 — the caller‘s own flag'),
	Ignored: z.int().describe('0/1 — the caller‘s own flag'),
	Muted: z.int().describe('0/1 — the caller‘s own flag'),
})

/**
 * `POST /api/messages/v2/send` form body — a message sent to another player. Everything
 * is a string on the wire (it's form-encoded). The sender is NOT in the body — it's
 * taken from the bearer token.
 */
export const SendMessageRequest = z.object({
	ToPlayerId: z.string().describe('Account id of the recipient'),
	Type: z
		.string()
		.optional()
		.describe('The Message-model type, e.g. `10`. Passed through unmapped; defaults to 0'),
	Data: z.string().optional().describe('The message payload; often empty'),
})

/**
 * `POST /api/messages/v1/sendMultiple` JSON body — the same message fanned out to
 * several recipients. Unlike the form-encoded single send, this one is real JSON, so
 * `Type` arrives as a number and `ToPlayerIds` as an array of numbers. The sender is
 * still taken from the bearer token, not the body.
 */
export const SendMultipleMessagesRequest = z.object({
	ToPlayerIds: z.array(z.int()).describe('Account ids of the recipients'),
	Type: z
		.int()
		.optional()
		.describe('The Message-model type, e.g. `20`. Passed through unmapped; defaults to 0'),
	Data: z.string().optional().describe('The message payload; often empty'),
})

/**
 * `POST /api/messages/v1/friendOnlineStatus` — how many of the caller's friends are
 * online, wrapped in the client's `{ success, value }` envelope.
 */
export const FriendOnlineCountResponse = z.object({
	success: z.boolean(),
	value: z.object({
		FriendsOnlineCount: z.int().describe('Friends with live presence right now'),
	}),
})

/** The `{ Success, Message }` ack the flag toggles answer with. */
export const AckResponse = z.object({ Success: z.boolean(), Message: z.string() })

/**
 * One entry of `GET /api/relationships/mutualfriends` — a friend both players share.
 * A trimmed account card, not a relationship: no relationship type or flags.
 */
export const MutualFriendDto = z.object({
	AccountId: z.int(),
	Username: z.string(),
	DisplayName: z.string(),
	ProfileImage: z.string().describe('The image name; an empty string when the account has none'),
})

// ---- Progression -----------------------------------------------------------

/**
 * A player's reputation (cheer counters). Nobody has earned cheers yet, so every
 * counter is 0 and everyone has their full credit. `SelectedCheer` is an int (0 = none),
 * not null, and `IsCheerful` is true — the client reads it to decide whether the player
 * may hand out cheers at all.
 */
export const ReputationDto = z.object({
	AccountId: z.int(),
	IsCheerful: z.boolean(),
	Noteriety: z.int(),
	SelectedCheer: z.int().describe('0 = none selected'),
	CheerCredit: z.int(),
	CheerGeneral: z.int(),
	CheerHelpful: z.int(),
	CheerCreative: z.int(),
	CheerGreatHost: z.int(),
	CheerSportsman: z.int(),
	SubscriberCount: z.int(),
	SubscribedCount: z.int(),
})

/** A player's level/XP (`/api/players/v1/progression/:id`). */
export const ProgressionDto = z.object({
	PlayerId: z.int(),
	Level: z.int(),
	XP: z.int(),
})

/** The `Ids` form body the bulk POST endpoints take. */
export const BulkIdsRequest = z.object({
	Ids: z.string().describe('Comma-separated account ids, e.g. `1,2,3`'),
})

// ---- Inventions ------------------------------------------------------------

/** One version of an invention — carries the blob name the client downloads. */
export const InventionVersionDto = z.object({
	InventionId: z.int(),
	ReplicationId: z.string(),
	VersionNumber: z.int(),
	BlobName: z.string().describe('The `.inv` key in the storage worker‘s bucket'),
	BlobHash: z
		.string()
		.nullable()
		.describe('Base64 SHA-256 of the blob; null when it was never uploaded'),
	InstantiationCost: z.int(),
	LightsCost: z.int(),
	ChipsCost: z.int(),
	CloudVariablesCost: z.int(),
	AICost: z.int(),
})

/** A tag on an invention. `Type` 0 = custom (creator-submitted), 2 = auto-derived. */
export const InventionTagDto = z.object({
	Tag: z.string(),
	Type: z.int().describe('0 = custom, 2 = auto'),
})

/** A stored invention record (the reference's `RRInvention`). */
export const InventionDto = z.object({
	InventionId: z.int(),
	ReplicationId: z.string(),
	CreatorPlayerId: z.int(),
	Name: z.string(),
	Description: z.string(),
	ImageName: z.string(),
	CurrentVersionNumber: z.int(),
	CurrentVersion: InventionVersionDto,
	Accessibility: z.int(),
	IsPublished: z.boolean().describe('Unpublished inventions are visible only to their creator'),
	IsFeatured: z.boolean(),
	ModifiedAt: z.string(),
	CreatedAt: z.string(),
	FirstPublishedAt: z.string().nullable(),
	CreationRoomId: z.int(),
	NumPlayersHaveUsedInRoom: z.int(),
	NumDownloads: z.int(),
	CheerCount: z.int(),
	CreatorPermission: z.int(),
	GeneralPermission: z.int().describe('What other players may do with it once published'),
	IsAGInvention: z.boolean(),
	IsCertifiedInvention: z.boolean(),
	Price: z.int(),
	AllowTrial: z.boolean(),
	HideFromPlayer: z.boolean(),
	ReferencedInventions: z.array(z.int()),
	Tags: z
		.array(InventionTagDto)
		.optional()
		.describe('Unset on save — the real RRInvention carries no Tags field'),
})

/** The `{ Status, Invention, InventionVersion }` envelope every invention write answers. */
export const InventionSaveResult = z.object({
	Status: z.int().describe('0 = success'),
	Invention: InventionDto,
	InventionVersion: InventionVersionDto,
})

/** The tag filter chips on a browse screen, derived from the tags actually in use. */
export const TagFilters = z.object({
	PinnedFilters: z.array(z.string()),
	PopularFilters: z.array(z.string()),
	TrendingFilters: z
		.array(z.string())
		.nullable()
		.describe('Null — needs recent-activity data we don‘t keep'),
})

/** `GET /api/inventions/v1/details` — an invention's detail card is just its tags. */
export const InventionDetails = z.object({ Tags: z.array(InventionTagDto) })

/** `GET /api/inventions/v1/personaldetails/:id` — the caller's own relation to it. */
export const InventionPersonalDetails = z.object({
	IsCheering: z.boolean().describe('Always false — nothing can cheer an invention yet'),
})

/** `POST /api/inventions/v1/settags` JSON body — both lists are replaced wholesale. */
export const SetTagsRequest = z.object({
	InventionId: z.int(),
	AutoTags: z
		.array(z.string())
		.optional()
		.describe('Client-derived tags (Type 2); each at most 15 letters once lowercased'),
	CustomTags: z
		.array(z.string())
		.optional()
		.describe('Creator-submitted tags (Type 0); each at most 15 letters once lowercased'),
})

/** `POST /api/inventions/v1/settags` response — `Tags` is the flat list of tag NAMES. */
export const SetTagsResponse = z.object({
	Result: z.int().describe('0 = success'),
	Tags: z.array(z.string()).describe('Auto tags first, then custom'),
})

/** `POST /api/inventions/v1/updateprice` JSON body. */
export const UpdatePriceRequest = z.object({
	InventionId: z.int(),
	Price: z.int().describe('Must be >= 0'),
})

/** `POST /api/inventions/v6/save` JSON body — camelCase, unlike the read shapes. */
export const SaveInventionRequest = z.object({
	inventionDataFilename: z
		.string()
		.describe('The blob uploaded through the storage worker; the one required field'),
	name: z
		.string()
		.optional()
		.describe('3–24 chars: letters, digits, spaces, dashes, colons. Omitted/blank ⇒ “Untitled”'),
	description: z
		.string()
		.optional()
		.describe('At most 512 chars. Omitted/blank ⇒ “No description yet”'),
	imageName: z.string().optional(),
	instantiationCost: z.int().optional(),
	lightsCost: z.int().optional(),
	chipsCost: z.int().optional(),
	cloudVariablesCost: z.int().optional(),
	aiCost: z.int().optional(),
	creationRoomId: z.int().optional(),
	referencedInventions: z.array(z.int()).optional(),
})

// ---- Avatar / custom avatar items ------------------------------------------

/** `POST /api/avatar/v2/gifts/generate` — a generated gift box (always a token gift). */
export const GeneratedGift = z.object({
	Id: z.int().describe('Always 0 — gifts generated here are not persisted'),
	FromPlayerId: z.int(),
	ConsumableItemDesc: z.string(),
	AvatarItemDesc: z.string(),
	FriendlyName: z.string(),
	AvatarItemType: z.int(),
	EquipmentPrefabName: z.string(),
	EquipmentModificationGuid: z.string(),
	CurrencyType: z.int(),
	Currency: z.int().describe('A random token amount'),
	Xp: z.int(),
	Level: z.int(),
	Platform: z.int(),
	PlatformsToSpawnOn: z.int(),
	BalanceType: z.int(),
	GiftContext: z.int(),
	GiftRarity: z.int(),
	Message: z.string(),
})

/** `POST /api/avatar/v2/gifts/generate` form body. */
export const GenerateGiftRequest = z.object({
	GiftContext: z.string().optional().describe('Where the gift was earned'),
	Message: z.string().optional(),
	Xp: z.string().optional(),
})

/**
 * `POST /api/customAvatarItems/v1/bulk` form body. A repeated form field, not a JSON
 * array: the reference binds `[FromForm] List<string>`, so the client posts
 * `customAvatarItemIds=a&customAvatarItemIds=b`.
 */
export const BulkCustomAvatarItemsRequest = z.object({
	customAvatarItemIds: z
		.array(z.string())
		.describe('The ids to resolve; repeat the field once per id'),
})

/** A paginated custom-avatar-item page (no storage yet, so always empty). */
export const CustomAvatarItemsPage = z.object({
	Results: JsonArray,
	TotalResults: z.int(),
})

/**
 * One custom-item save — the rebuilt version of a legacy avatar item. This is the
 * official shape, recorded for documentation: nothing stores custom items yet, so we
 * never actually emit one of these.
 */
export const CustomAvatarItemSave = z.object({
	customAvatarItemSaveId: z.int().describe('The save’s id'),
	customAvatarItemId: z.string().describe('Guid of the custom item this save belongs to'),
	unityAssetId: z.string().describe('Guid of the built Unity asset'),
	createdAt: z.string().describe('ISO 8601 timestamp'),
	thumbnailFileName: z.string(),
	additionalConfiguration: z.string(),
	unityAsset: z.string(),
	unityAssetHash: z.string(),
})

/**
 * The custom-item saves that replace a set of legacy avatar items, keyed by the legacy
 * item's `AvatarItemDesc`. Nothing stores custom items yet, so the map is always empty —
 * the value shape is documented rather than served.
 */
export const LegacyAvatarItemSaves = z.object({
	customAvatarItemSavesByAvatarItemDesc: z.record(z.string(), CustomAvatarItemSave),
})

/**
 * `GET /outfits/me` — the outfit envelope. Either the outfit stored in slot 0, served
 * back exactly as it was saved, or (for a player who has never saved) the brand-new-
 * account form, where every field that would carry an outfit is null/empty and
 * `DataVersion` is 9.
 */
export const OutfitsMeResponse = z.object({
	LegacyData: z.object({
		SelectionsV1: z.string().nullable().describe('Semicolon-delimited legacy descriptors'),
		SelectionsV2: z.string().nullable().describe('JSON-in-a-string: `{ selections: [...] }`'),
		FaceFeatures: z.string().nullable().describe('JSON-in-a-string'),
		SkinColor: z.string().nullable(),
		HairColor: z.string().nullable(),
	}),
	Selections: JsonArray,
	DataVersion: z.int().describe('9 in the new-account envelope; whatever was saved otherwise'),
	CustomizationSettings: z
		.string()
		.nullable()
		.describe('JSON-in-a-string: the same outfit in the newer structured form'),
	ThumbnailFileName: z.string().nullable(),
	Name: z.string().nullable(),
	Accessibility: z.int(),
	Slot: z.int().describe('0 — the outfit being worn'),
})

/**
 * `PUT /outfits/me` JSON body — the outfit the client is saving, in the newer envelope.
 * The heavy fields are JSON-in-a-string, exactly as the client serialises them:
 * `SelectionsV2` and `CustomizationSettings` are whole documents encoded as strings, and
 * `FaceFeatures` likewise. Note the two formats overlap: `LegacyData` carries the old
 * flat descriptors while `CustomizationSettings` carries the same outfit in the new
 * structured form, and the client sends both. `Selections` arrives empty — the actual
 * selections are inside those strings.
 */
export const OutfitsMeRequest = z.object({
	DataVersion: z.int().describe('The client’s outfit format version (2 in observed saves)'),
	LegacyData: z.object({
		SelectionsV1: z.string().nullable().describe('Semicolon-delimited legacy descriptors'),
		SelectionsV2: z.string().nullable().describe('JSON-in-a-string: `{ selections: [...] }`'),
		FaceFeatures: z.string().nullable().describe('JSON-in-a-string'),
		SkinColor: z.string().nullable(),
		HairColor: z.string().nullable(),
	}),
	CustomizationSettings: z
		.string()
		.nullable()
		.describe('JSON-in-a-string: the same outfit in the newer structured form'),
	Selections: JsonArray.describe('Empty in observed saves'),
	Slot: z.int(),
	Name: z.string().nullable(),
	Accessibility: z.int(),
	ThumbnailFileName: z.string().nullable(),
})

/** The `{ success, value }` envelope `isCreationAllowedForAccount` wraps its answer in. */
export const SuccessValueEnvelope = z.object({ success: z.boolean(), value: z.null() })

// ---- Gameplay --------------------------------------------------------------

/** `POST /api/sanitize/v1` JSON body — the text to clean. */
export const SanitizeRequest = z.object({ Value: z.string() })

/** `POST /api/sanitize/v1/isPure` — whether the text is clean (always true here). */
export const IsPureResponse = z.object({ IsPure: z.boolean() })

/** `GET /api/keepsakes/globalconfig` — the keepsake feature switches. */
export const KeepsakeConfig = z.object({
	KeepsakeFeatureEnabled: z.boolean(),
	KeepsakeRoomLimit: z.int(),
	SocialXpBoostEnabled: z.boolean(),
})

/**
 * `GET /api/keepsakes/categories` — the keepsake catalog, as a counted result set
 * rather than the bare list the stubs around it serve. Empty until a catalog exists.
 */
export const KeepsakeCategories = z.object({
	Results: JsonArray.describe('The categories — empty, as no keepsake catalog is stored'),
	TotalResults: z.int().describe('How many results `Results` carries'),
})

/**
 * A scheduled player event (Rec Room's `PlayerEvent`) — the record every read endpoint
 * serves verbatim. The `State` / `Accessibility` / `*Permissions` ints are stored and
 * echoed as the client sends them; their enums aren't reversed yet.
 */
export const PlayerEventDto = z.object({
	PlayerEventId: z.int(),
	CreatorPlayerId: z.int(),
	ImageName: z.string().nullable().describe('Banner image; null until one is uploaded'),
	RoomId: z.int(),
	SubRoomId: z.int().nullable().describe('Null when the event doesn’t pin a subroom'),
	ClubId: z.int().nullable().describe('Null when the event isn’t a club’s'),
	Name: z.string(),
	Description: z.string(),
	StartTime: z.string().describe('ISO 8601 UTC, seconds precision (`2020-11-29T22:00:00Z`)'),
	EndTime: z.string().describe('ISO 8601 UTC, seconds precision'),
	AttendeeCount: z.int().describe('Starts at 1 — the creator attends their own event'),
	State: z.int().describe('0 = scheduled'),
	Accessibility: z.int(),
	IsMultiInstance: z.boolean(),
	SupportMultiInstanceRoomChat: z.boolean(),
	DefaultBroadcastPermissions: z.int(),
	CanRequestBroadcastPermissions: z.int(),
})

/**
 * `GET /api/playerevents/v1/:eventId?includeDetails=True` — the record plus the one
 * field the flag adds: the LOWERCASE `tags`, in an otherwise PascalCase record. Always
 * empty, since no event tags are stored; the key is absent altogether when the flag
 * isn't passed. The entry shape is the one the notification projection declares.
 */
export const PlayerEventDetailsDto = PlayerEventDto.extend({
	tags: z
		.array(z.object({ tag: z.string(), type: z.int() }))
		.optional()
		.describe('Present only with `includeDetails=True`, and always empty'),
})

/**
 * `GET /api/playerevents/v1` — the browse feed's listing. The same record minus
 * `State`, plus a `BroadcastingRoomInstanceId` (always null — nothing broadcasts an
 * event yet). That's the shape observed on this endpoint; the other reads serve the
 * stored record verbatim, so don't unify the two.
 */
export const PlayerEventListingDto = PlayerEventDto.omit({ State: true }).extend({
	BroadcastingRoomInstanceId: z
		.int()
		.nullable()
		.describe('Always null — no event broadcasts to a room instance yet'),
})

/** The `{ Result, TagModifyResult, PlayerEvent }` envelope the event writes answer with. */
export const PlayerEventResultDto = z.object({
	Result: z.int().describe('0 = success'),
	TagModifyResult: z
		.null()
		.describe('Always null — the write carries no tag edit, as no event tags are stored'),
	PlayerEvent: PlayerEventDto,
})

/**
 * The JSON body of an event create / update. Every field is optional: create defaults
 * what's missing, update leaves anything absent at its stored value. The fields may be
 * posted at the top level or nested under `PlayerEvent` — the client posts back the
 * same envelope it read — and both forms are accepted. `PlayerEventId`,
 * `CreatorPlayerId` and `AttendeeCount` are ignored if present: the id is assigned
 * here, the creator comes from the bearer token, and RSVPs aren't set by hand.
 */
export const PlayerEventRequest = PlayerEventDto.partial().extend({
	PlayerEvent: z
		.unknown()
		.optional()
		.describe('The event’s fields, if nested rather than posted at the top level'),
})

/**
 * `GET /api/playerevents/v1/:eventId/responses` — one player's RSVP to one event, as
 * the guest list serves it.
 */
export const PlayerEventResponseDto = z.object({
	PlayerEventResponseId: z.int().describe('Stable id of the RSVP row'),
	PlayerEventId: z.int(),
	PlayerId: z.int(),
	CreatedAt: z
		.string()
		.describe(
			'When the answer that stands was given — a changed answer updates the row, so this ' +
				'moves with it rather than recording the player’s first response'
		),
	Type: z.int().describe('0 Going, 1 Interested, 2 Can’t go'),
})

/** `POST /api/playerevents/v1/respond` JSON body — how the caller is answering. */
export const PlayerEventRespondRequest = z.object({
	PlayerEventId: z.int(),
	Type: z.int().describe('0 Going, 1 Interested, 2 Can’t go'),
})

/**
 * `POST /api/playerevents/v1/report` JSON body — a report against an event. JSON, note,
 * where the player report next to it is form-encoded. The reporter is NOT in the body:
 * it's the bearer token's player.
 */
export const PlayerEventReportRequest = z.object({
	PlayerEventId: z.int().describe('The event being reported'),
	ReportCategory: z
		.int()
		.optional()
		.describe('The reason picked in the report UI, e.g. `101`. Stored verbatim; unmapped'),
	Details: z.string().optional().describe('The free-text description the reporter typed'),
})

/** `POST /api/playerevents/v1/bulkInvite` JSON body — who to invite to which event. */
export const PlayerEventBulkInviteRequest = z.object({
	PlayerEventId: z.int(),
	InvitedPlayerIds: z
		.array(z.int())
		.describe('Ids to invite; duplicates and the caller are ignored'),
})

/** `GET /api/playerevents/v1/all` — the caller's created events and RSVPs. */
export const PlayerEventsAll = z.object({
	Created: z.array(PlayerEventDto).describe('Events the caller created, soonest first'),
	Responses: JsonArray.describe(
		'Events the caller RSVP’d to — always empty; RSVPs are stored, but this field’s ' +
			'entry shape has not been observed yet'
	),
})

/** `GET /api/playerevents/v1/club/:clubId` — the paged single-club event feed. */
export const PlayerEventsPage = z.object({
	ContinuationToken: z.string().describe('Empty = no next page'),
	Events: JsonArray,
})

// ---- Moderation ------------------------------------------------------------

/**
 * One row of `GET /api/PlayerReporting/v1/voteToKickReasons` — the label the client puts
 * on a vote-to-kick button, and the report category the kick is filed under if it passes.
 */
export const VoteToKickReason = z.object({
	Reason: z.string().describe('The label shown on the button'),
	ReportCategory: z
		.int()
		.describe('The category the resulting report is filed under: 101, 102, 103 or 6'),
})

/**
 * `GET|POST /api/PlayerReporting/v1/moderationBlockDetails` — always the "not blocked"
 * answer (no ban storage yet), mirroring the reference server's stub
 * `ReturnModerationBlockDetails()`. `ReportCategory` is `Unknown` (-1) rather than 0,
 * which is a real category, and `Message` is null — the client distinguishes "no
 * message" from a blank one, so we send null where the reference sends an empty string.
 * `IsVoiceModAutoban`/`TimeoutStartedAt` are on the DTO but unset by that stub, so
 * they carry their C# defaults (false / null).
 */
export const ModerationBlockDetails = z.object({
	ReportCategory: z.int().describe('-1 = ReportCategory.Unknown (0 is a real category)'),
	Duration: z.int(),
	GameSessionId: z.int(),
	IsBan: z.boolean(),
	IsHostKick: z.boolean(),
	IsVoiceModAutoban: z.boolean(),
	Message: z.string().nullable(),
	PlayerIdReporter: z.int().nullable(),
	TimeoutStartedAt: z.string().nullable(),
})

/**
 * `POST /api/PlayerReporting/v3/create` form body — a player report. Everything is a
 * string on the wire (it's form-encoded); only `PlayerIdReported` is required. The
 * reporter is NOT in the body — it's taken from the bearer token.
 */
export const CreateReportRequest = z.object({
	PlayerIdReported: z.string().describe('Account id of the player being reported'),
	ReportCategory: z
		.string()
		.optional()
		.describe('The reason picked in the report UI, e.g. `100`. Stored verbatim; unmapped'),
	Details: z.string().optional().describe('The free-text description the reporter typed'),
	HeightReporter: z
		.string()
		.optional()
		.describe('Reporter’s player height in metres at report time, e.g. `1.64`'),
	HeightReported: z.string().optional().describe('Reported player’s height in metres'),
	RoomId: z.string().optional().describe('Room the report was raised in, if any'),
	RoomInstanceType: z
		.string()
		.optional()
		.describe('Instance type name, e.g. `Public`. Stored verbatim'),
})

/**
 * `POST /api/playerwarnings` form body — a warning a moderator hands down. Everything
 * is a string on the wire (it's form-encoded); only `WarnedPlayerId` is required. The
 * moderator is NOT in the body — it's taken from the bearer token.
 */
export const CreateWarningRequest = z.object({
	WarnedPlayerId: z.string().describe('Account id of the player being warned'),
	ReportCategory: z
		.string()
		.optional()
		.describe('The reason category, e.g. `101`. Stored verbatim; unmapped'),
	DisplayReason: z
		.string()
		.optional()
		.describe('What the warned player is shown, e.g. `Sexual gestures`'),
	ModeratorNote: z.string().optional().describe('Internal note; never shown to the player'),
})

/** `POST /api/PlayerReporting/v1/deviceId` form body — the id rotation the client reports. */
export const DeviceIdRequest = z.object({
	oldDeviceId: z.string().optional().describe('The id the client thinks we hold'),
	newDeviceId: z.string().optional(),
	platform: z.string().optional(),
})

// ---- Rooms -----------------------------------------------------------------

/** `GET /api/quickPlay/v1/getandclear` — a pending quick-play action; all null = none. */
export const QuickPlayResponse = z.object({
	RoomName: z.string().nullable(),
	ActionCode: z.string().nullable(),
	TargetPlayerId: z.int().nullable(),
})

/** `POST /api/rooms/v1/verifyRole` form body. */
export const VerifyRoleRequest = z.object({
	roomId: z.string(),
	role: z.string().describe('The minimum role level required'),
	context: z.string().optional().describe('e.g. MakerPen — accepted and ignored'),
})

// ---- Images ----------------------------------------------------------------

/**
 * A stored image record. Note the room photo feed (`/api/images/v4/room/:roomId`)
 * serves this shape raw, while the player lists serve the `ImagesPlayer` projection
 * below — deliberately different, see the client-contract notes in CLAUDE.md.
 */
export const SavedImageDto = z.object({
	Id: z.int(),
	Type: z.int().describe('SavedImageType: 1 = share camera, 3 = room, 4 = profile, …'),
	Accessibility: z.int(),
	AccessibilityLocked: z.boolean(),
	ImageName: z.string().describe('The bucket key the img worker serves it back by'),
	Description: z.string().nullable(),
	PlayerId: z.int(),
	TaggedPlayerIds: z.array(z.int()),
	RoomId: z.int().nullable(),
	PlayerEventId: z.int().nullable(),
	CreatedAt: z.string(),
	CheerCount: z.int(),
	CommentCount: z.int(),
})

/**
 * The client's `ImagesPlayer` projection — the same record with `Id` → `SavedImageId`,
 * `Type` → `SavedImageType` and no `TaggedPlayerIds`. The player photo lists and feed
 * MUST serve this: the raw SavedImage renders blank thumbnails.
 */
export const ImagesPlayerDto = z.object({
	SavedImageId: z.int(),
	SavedImageType: z.int(),
	Accessibility: z.int(),
	AccessibilityLocked: z.boolean(),
	CheerCount: z.int(),
	CommentCount: z.int(),
	CreatedAt: z.string(),
	Description: z.string().nullable(),
	ImageName: z.string(),
	PlayerEventId: z.int().nullable(),
	PlayerId: z.int(),
	RoomId: z.int().nullable(),
})

/** One entry in the anonymous slideshow feed, joined to its creator and room. */
export const SlideshowImageDto = z.object({
	SavedImageId: z.int(),
	ImageName: z.string(),
	Username: z.string(),
	RoomName: z.string().nullable(),
	RoomId: z.int().nullable(),
	SavedImageType: z.int(),
	PlayerEventId: z.int().nullable(),
	Accessibility: z.int(),
	PlayerIds: z.array(z.int()),
})

/** `GET /api/images/v1/slideshow` — the feed plus a short cache hint. */
export const SlideshowResponse = z.object({
	Images: z.array(SlideshowImageDto),
	ValidTill: z.string().describe('ISO timestamp ~2 minutes out; the client refreshes against it'),
})

/** `POST /api/images/v4/uploadsaved` multipart body. */
export const UploadImageRequest = z.object({
	image: z.string().describe('The image file (`file` is accepted too)'),
	imgMeta: z
		.string()
		.optional()
		.describe(
			'A JSON `SavedImageMetaDTO`: { playerIds, savedImageType, roomId, playerEventId, accessibility, description }'
		),
})

/** `POST /api/images/v4/uploadsaved` — the stored bucket key. */
export const UploadImageResponse = z.object({
	ImageName: z.string().describe('The bucket key; the img worker serves the object by it'),
})

/** `DELETE /api/images/v1/deletesaved` JSON body. */
export const DeleteImageRequest = z.object({ ImageName: z.string() })

/** `POST /api/images/v1/cheer` JSON body. */
export const CheerImageRequest = z.object({
	SavedImageId: z.int(),
	Cheer: z.boolean().describe('True to cheer, false to un-cheer'),
})

/** The bare `{ success: true }` ack the image writes answer with. */
export const SuccessResponse = z.object({ success: z.boolean() })

/** One entry of `GET /api/images/v5/cheered/bulk`, one per requested id, in order. */
export const CheeredEntry = z.object({
	SavedImageId: z.int(),
	IsCheered: z.boolean(),
})
