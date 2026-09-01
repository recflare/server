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

/**
 * A bearer token is honoured but not required: anonymous is a valid alternative. For routes
 * that serve public data but show more to a known caller (a creator's own unpublished
 * custom avatar items) instead of 401ing.
 */
export const OPTIONAL_AUTHED: OpenAPIV3_1.SecurityRequirementObject[] = [{}, { bearerAuth: [] }]

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

/** A bare JSON integer (e.g. `/api/customAvatarItems/v1/minPriceForPublicItem`). */
export const BareInteger = z.number().int()

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

/** `GET /api/config/v1/amplitude` — the client's analytics keys (blank; RudderStack and StatSig off). */
export const AmplitudeConfig = z.object({
	AmplitudeKey: z.string(),
	UseRudderStack: z.boolean(),
	RudderStackKey: z.string(),
	UseStatSig: z.boolean(),
	StatSigKey: z.string(),
	StatSigEnvironment: z.number().int(),
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
 * `success` carrying its `StatsigEnabled` config value, a BOOL rather than an int.
 */
export const StatsigUserProperties = z.object({
	success: z.boolean().describe('The Statsig-enabled flag (true)'),
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
 * `POST /api/messages/v3/delete` JSON body — the messages the client is dropping from
 * its inbox. Ids are the `Id` of a stored message, which this server has never issued:
 * with no message store the list is only ever echoed back as accepted.
 */
export const DeleteMessagesRequest = z.object({
	MessageIds: z.array(z.int()).describe('Ids of the messages to delete'),
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
 * A player's reputation (cheer counters), read from the `reputation` table. A player
 * nobody has cheered yet has no row and reads back all-zero with full cheer credit.
 * `SelectedCheer` is an int (0 = none), not null, and `IsCheerful` is a bool the client
 * reads to decide whether the player may hand out cheers at all.
 *
 * `CheerCredit` is the odd one out: it is what the player has left to GIVE (out of 20 per
 * day), not something they have received, and it comes from `player_cheer` rather than
 * from the reputation row.
 */
export const ReputationDto = z.object({
	AccountId: z.int(),
	IsCheerful: z.boolean(),
	Noteriety: z.int(),
	SelectedCheer: z.int().describe('The cheer pinned to the profile; 0 = none selected'),
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

/**
 * The form body of `POST /api/PlayerCheer/v1/create`. Nothing here is stored beyond the
 * counter the cheer increments: `Anonymous` is spent on the notification it triggers and
 * `RoomId` is dropped outright — see the route.
 */
export const CheerPlayerRequest = z.object({
	PlayerIdTo: z.string().describe('The account being cheered'),
	CheerCategory: z
		.string()
		.describe('0 General, 10 Helpful, 20 Sportmanship, 30 GreatHost, 40 Creative'),
	RoomId: z
		.string()
		.optional()
		.describe(
			'The room it happened in. Accepted but NOT used — the audience for the cheer’s ' +
				'effect comes from the caller’s live presence, so a client cannot aim it at a room ' +
				'it is not in'
		),
	Anonymous: z
		.string()
		.optional()
		.describe(
			'`True`/`False` (default `False`). Not stored — it picks the `PlayerCheerAnonymous` ' +
				'message type (sender 0) over `PlayerCheer` for the frame that plays the cheer'
		),
})

/** The form body of `POST /api/PlayerCheer/v1/SetSelectedCheer`. */
export const SetSelectedCheerRequest = z.object({
	CheerCategory: z
		.string()
		.describe(
			'The category to pin: 0 General, 10 Helpful, 20 Sportmanship, 30 GreatHost, 40 Creative; -1 unpins'
		),
})

/**
 * What a cheer answers — the reference's PascalCase `{ Success, Message }`, NOT the
 * lowercase `{ success, error }` envelope the reports use, and `Message` is NULL on success
 * where that one sends an empty string. On a refusal it names the reason (out of credit,
 * bad category, cheering yourself), which the client shows the player.
 */
export const CheerPlayerResponse = z.object({
	Success: z.boolean(),
	Message: z.string().nullable().describe('Null when the cheer landed'),
})

/** The `metadata` JSON field of a custom-avatar-item creation. */
export const CreateCustomAvatarItemMetadata = z.object({
	Name: z.string(),
	Description: z.string().optional(),
	Price: z.number().int().optional(),
	BaseAvatarItemId: z.number().int(),
	BaseAvatarItemColor: z.string().describe('Hex colour, e.g. `#F55C1A`'),
	Accessibility: z.number().int().optional(),
})

/** The multipart body `POST /api/customAvatarItems/v1` takes. */
export const CreateCustomAvatarItemRequest = z.object({
	metadata: z.string().describe('JSON `CreateCustomAvatarItemMetadata`, posted as a text field'),
	thumbnailImage: z.string().describe('The thumbnail PNG (binary file part)'),
	design: z.string().describe('The design blob (binary file part)'),
})

/** The client's `CustomAvatarItem` record. */
export const CustomAvatarItemDto = z.object({
	CustomAvatarItemId: z.string(),
	CreatorAccountId: z.number().int(),
	Name: z.string(),
	Description: z.string(),
	Price: z.number().int(),
	Accessibility: z.number().int(),
	ForceCannotPublish: z.boolean(),
	IsFeatured: z.boolean(),
	IsRecRoomApproved: z.boolean(),
	BaseAvatarItemId: z.number().int(),
	BaseAvatarItemColor: z.string(),
	DesignFilename: z.string(),
	ThumbnailImageFilename: z.string(),
	CreatedAt: z.string(),
	ModifiedAt: z.string(),
	PreviewOrientation: z.number().int(),
	RankingContext: z.null(),
	OutfitType: z.number().int(),
	CurrentSaves: z.array(z.unknown()),
	PurchaseInfo: z.null(),
})

/** The JSON body `PUT /api/customAvatarItems/v1/:id` takes; null leaves a field unchanged. */
export const UpdateCustomAvatarItemRequest = z.object({
	Name: z.string().nullable().optional(),
	Description: z.string().nullable().optional(),
	Price: z.number().int().nullable().optional(),
	Accessibility: z.number().int().nullable().optional(),
})

/** A bare list of custom avatar items (the featured feed). */
export const CustomAvatarItemList = z.array(CustomAvatarItemDto)

/** The PascalCase `{ Value, Success, Error, error_id }` envelope custom-avatar-item routes answer with. */
export const CustomAvatarItemResponse = z.object({
	Value: CustomAvatarItemDto.nullable(),
	Success: z.boolean(),
	Error: z.string().nullable(),
	error_id: z.string().nullable(),
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
	HasBetaContent: z
		.boolean()
		.optional()
		.describe('Set from `v9/save` on — absent on a version saved through `v6/save`'),
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
	ReferencedUnityAssetIds: z
		.array(z.string())
		.optional()
		.describe('Set from `v9/save` on — absent on an invention saved through `v6/save`'),
	UgcVersion: z
		.int()
		.optional()
		.describe('An invention field, not a version one — set from `v9/save` on'),
	LongDescription: z.string().optional().describe('Set from `v9/save` on, when non-empty'),
	DisplayMetadataJson: z
		.string()
		.optional()
		.describe('The client’s own display state, stored as the opaque string it sent'),
	ConvertedFromInventionId: z
		.int()
		.optional()
		.describe('The invention this one was converted from, when `v9/save` named one'),
	Tags: z
		.array(InventionTagDto)
		.optional()
		.describe(
			'The real RRInvention carries no Tags field. Unset by `v6/save`; set by `v9/save` ' +
				'when its `tagsRequest` names at least one tag'
		),
})

/** The `{ Status, Invention, InventionVersion }` envelope every invention write answers. */
export const InventionSaveResult = z.object({
	Status: z.int().describe('0 = success'),
	Invention: InventionDto,
	InventionVersion: InventionVersionDto,
})

/**
 * The `Invention` a v9 save answers with — the newer client's own `RRInvention`, which is
 * not the record this server stores or the read endpoints serve: no nested
 * `CurrentVersion` (the version rides beside it), no `Referenced*` (those moved onto the
 * version), no `IsPublished`.
 */
export const InventionV9Dto = z.object({
	InventionId: z.int(),
	ReplicationId: z.string(),
	CreatorPlayerId: z.int(),
	Name: z.string(),
	Description: z.string(),
	ImageName: z.string(),
	UgcVersion: z.int().describe('The UGC format the blob was written in; 0 when unsent'),
	CurrentVersionNumber: z.int(),
	LatestVersionNumber: z.int().describe('The same as CurrentVersionNumber on a fresh save'),
	Accessibility: z.int(),
	ForceCannotPublish: z.boolean().describe('Always false — nothing here forbids publishing'),
	ModifiedAt: z.string(),
	CreatedAt: z.string(),
	FirstPublishedAt: z.string().nullable(),
	CreationRoomId: z.int().nullable(),
	NumPlayersHaveUsedInRoom: z.int(),
	NumDownloads: z.int(),
	CheerCount: z.int(),
	CreatorPermission: z.int(),
	GeneralPermission: z.int(),
	IsAGInvention: z.boolean(),
	IsCertifiedInvention: z.boolean(),
	IsRecRoomApproved: z.boolean().describe('Always false — nothing here approves an invention'),
	AllowTrial: z.boolean(),
	Price: z.int().nullable(),
	HideFromPlayer: z.boolean(),
	DisplayMetadataJson: z.string().nullable(),
})

/**
 * The `InventionVersion` a v9 save answers with. It carries `HasBetaContent`, a `CreatedAt`
 * of its own and a nullable `UgcAccessibility`, and notably no `AICost` — which the request
 * still sends and this server still stores.
 */
export const InventionVersionV9Dto = z.object({
	InventionId: z.int(),
	ReplicationId: z.string(),
	VersionNumber: z.int(),
	HasBetaContent: z.boolean(),
	InstantiationCost: z.int(),
	LightsCost: z.int(),
	ChipsCost: z.int(),
	CloudVariablesCost: z.int(),
	BlobName: z.string(),
	BlobHash: z.string().nullable(),
	CreatedAt: z.string(),
	UgcAccessibility: z.int().nullable().describe('Always null — versions carry no accessibility'),
	ReferencedInventions: z.array(z.int()),
	ReferencedUnityAssetIds: z.array(z.string()),
})

/**
 * What `v9/save` answers — the enveloped result. The client checks `Success` and then reads
 * `Value.Invention.InventionId`; `Error` is the only text it shows a human, and `Status`,
 * `InventionVersion` and `TagsResponse` are deserialized and never read. `Success: true`
 * with a null `Value` crashes it, so a refusal is `Success: false` with `Value: null`.
 */
export const InventionSaveV9Result = z.object({
	Value: z
		.object({
			Status: z.int().describe('0 = success; the client never reads it on this route'),
			Invention: InventionV9Dto,
			InventionVersion: InventionVersionV9Dto,
			TagsResponse: z.object({
				Result: z.int().describe('0 = success; non-zero when a tag broke the tag rule'),
				Tags: z.array(z.string()).describe('The stored tag NAMES, auto first, then custom'),
			}),
		})
		.nullable()
		.describe('Null when Success is false — and only then'),
	Success: z.boolean(),
	Error: z.string().nullable().describe('The refusal message; the only text the client shows'),
	error_id: z.string().nullable().describe('Always null'),
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

/**
 * `PUT /api/inventions/v2/metadata` JSON body — PascalCase, and every field but the id is
 * NULLABLE: the newer client sends the whole shape on every edit and marks the fields it
 * isn't touching as null. An empty string is not a null — it clears the field.
 */
export const UpdateInventionMetadataRequest = z.object({
	InventionId: z.int(),
	Name: z
		.string()
		.nullable()
		.optional()
		.describe('3–24 chars, letters/digits/spaces/dashes/colons; null leaves it alone'),
	Description: z.string().nullable().optional().describe('Max 512 chars; empty clears it'),
	LongDescription: z.string().nullable().optional().describe('Empty clears it'),
	ImageName: z.string().nullable().optional().describe('New thumbnail; empty clears it'),
	TagsRequest: z
		.object({
			AutoTags: z.array(z.string()).nullable().optional(),
			CustomTags: z.array(z.string()).nullable().optional(),
		})
		.nullable()
		.optional()
		.describe('Replaces both lists wholesale, as `v1/settags` does; null leaves them alone'),
})

/**
 * `POST /api/inventions/v4/publish` JSON body — PascalCase, and nullable the way
 * `v2/metadata`'s is: a null field keeps what the invention already has.
 */
export const PublishInventionRequest = z.object({
	InventionId: z.int(),
	Permission: z
		.int()
		.nullable()
		.optional()
		.describe(
			'The `GeneralPermission` other players get, as a raw ladder number: Unassigned 0, ' +
				'LimitedOneUseOnly 10, DisallowKeyLock 15, UseOnly 20, EditAndSave 40, Publish 60, ' +
				'Charge 80, Unlimited 100. Null publishes as UseOnly'
		),
	Accessibility: z
		.int()
		.nullable()
		.optional()
		.describe('Private 0, Public 1, Unlisted 2. Unlisted stays out of browse and search'),
	Price: z
		.int()
		.nullable()
		.optional()
		.describe('Price in tokens; null leaves it as it is, and a negative one is ignored'),
})

/** `POST /api/inventions/v2/delete` JSON body — the id and nothing else. */
export const DeleteInventionRequest = z.object({
	InventionId: z.int().describe('The invention to delete; the caller must have created it'),
})

/**
 * What `v2/delete` answers — the same `{ Value, Success, Error, error_id }` envelope the
 * other newer-client invention routes use, with `Value` always null. The invention is
 * gone, so there is nothing for the client to redraw from: it reads `Success`, and
 * `Error` when that is false.
 */
export const InventionDeleteResult = z.object({
	Value: z.null().describe('Always null — the invention no longer exists'),
	Success: z.boolean(),
	Error: z.string().nullable().describe('The refusal message; null on success'),
	error_id: z.string().nullable().describe('Always null'),
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
	creatorAccountRole: z
		.int()
		.optional()
		.describe('Accepted and ignored — a room role, not a permission over the invention'),
})

/**
 * `POST /api/inventions/v9/save` JSON body — `v6`’s fields plus what the invention
 * points at, what it says about itself, and the tags that used to need a second
 * `v1/settags` call.
 */
export const SaveInventionV9Request = SaveInventionRequest.extend({
	ugcVersion: z.int().optional().describe('The UGC format the blob was written in'),
	hasBetaContent: z.boolean().optional(),
	referencedUnityAssetIds: z.array(z.string()).optional(),
	longDescription: z.string().optional().describe('Stored when non-empty'),
	displayMetadataJson: z
		.string()
		.optional()
		.describe('Opaque client display state, e.g. `{"0":0,"99":0}`; stored verbatim'),
	convertedFromInventionId: z.int().nullable().optional(),
	tagsRequest: z
		.object({
			AutoTags: z.array(z.string()).nullable().optional(),
			CustomTags: z.array(z.string()).nullable().optional(),
		})
		.optional()
		.describe('The same two lists `v1/settags` takes, folded into the save'),
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

/** A paginated custom-avatar-item page, out of the `custom_avatar_item` table. */
export const CustomAvatarItemsPage = z.object({
	Results: CustomAvatarItemList,
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

/** `GET /outfits/me` — the outfit stored in slot 0, served back exactly as it was saved. */
export const StoredOutfit = z.object({
	LegacyData: z.object({
		SelectionsV1: z.string().nullable().describe('Semicolon-delimited legacy descriptors'),
		SelectionsV2: z.string().nullable().describe('JSON-in-a-string: `{ selections: [...] }`'),
		FaceFeatures: z.string().nullable().describe('JSON-in-a-string'),
		SkinColor: z.string().nullable(),
		HairColor: z.string().nullable(),
	}),
	Selections: JsonArray,
	DataVersion: z.int().describe('The client’s outfit format version, as saved'),
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
 * `GET /outfits/me` for a player who has never saved — the brand-new-account envelope.
 * Flatter than a stored outfit rather than a nulled-out copy of it: four empty strings and
 * nothing else, no `LegacyData`, no `Selections`, no `DataVersion`. `OutfitSelections` is
 * the flat field name here, not `SelectionsV1`/`SelectionsV2`.
 */
export const EmptyOutfit = z.object({
	FaceFeatures: z.string(),
	HairColor: z.string(),
	OutfitSelections: z.string(),
	SkinColor: z.string(),
})

/** `GET /outfits/me` — the stored outfit, or the empty envelope for a new player. */
export const OutfitsMeResponse = z.union([StoredOutfit, EmptyOutfit])

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

/**
 * `POST /outfits/bulk` JSON body — whose outfits to fetch. The client sends the accounts it
 * needs to dress (a room's roster, typically), and the two `UnityAsset*` fields name the
 * baked-asset build it would like them for.
 */
export const OutfitsBulkRequest = z.object({
	AccountIds: z.array(z.int()).describe('The accounts whose worn outfit is wanted'),
	UnityAssetTarget: z
		.string()
		.nullable()
		.describe('Baked-asset platform. Accepted and ignored — nothing bakes assets here'),
	UnityAssetVersion: z
		.string()
		.nullable()
		.describe('Baked-asset version. Accepted and ignored, like its sibling'),
})

/**
 * `POST /outfits/bulk` — the worn outfit of each account asked for, keyed by account id.
 *
 * The key is the id as a STRING (a JSON object key always is) and the value is the same
 * stored outfit `GET /outfits/me` serves. An account with nothing saved is ABSENT from the
 * map rather than present with a null — a map expresses "no outfit" by not carrying the key.
 */
export const OutfitsBulkResponse = z.object({
	OutfitsByAccountId: z
		.record(z.string(), StoredOutfit)
		.describe('Keyed by account id as a string. Accounts with no saved outfit are omitted'),
})

/**
 * `PUT /outfits/me` — the base envelope, with NO `Value` key: three keys and that is the
 * whole body. The save answers only whether it worked; the client keeps the outfit it just
 * sent rather than re-rendering from a response, so nothing here echoes the outfit back.
 *
 * Note the mixed casing — `Success` and `Error` are PascalCase, `error_id` is snake_case.
 * That is what the reference sends, and the client's decoder matches on the exact names, so
 * do not "tidy" it into one convention.
 */
export const OutfitSaveResponse = z.object({
	Success: z.boolean(),
	Error: z.string().nullable().describe('Null on success'),
	error_id: z.string().nullable().describe('Null on success. snake_case, unlike its siblings'),
})

/** The `{ success, value }` envelope `isCreationAllowedForAccount` wraps its answer in. */
export const SuccessValueEnvelope = z.object({ success: z.boolean(), value: z.null() })

// ---- Gameplay --------------------------------------------------------------

/**
 * `POST /api/sanitize/v1` (and `/isPure`) JSON body. Only `Value` is acted on, plus
 * `ReplacementChar` and `PreRemoveBlockedCharacters` on the sanitize route; the rest are
 * what the client sends, kept here so the spec shows a real request.
 */
export const SanitizeRequest = z.object({
	Value: z.string().describe('The text to clean or check'),
	ReplacementChar: z
		.string()
		.optional()
		.describe('The mask a swear’s characters are replaced with. Defaults to `*`'),
	PreRemoveBlockedCharacters: z
		.boolean()
		.optional()
		.describe('Strip control and zero-width characters before filtering'),
	Context: z.string().optional().describe('The surface being checked, e.g. `RoomChat`. Ignored'),
	Intent: z.int().optional().describe('Reference filtering intent. Ignored'),
	ruleset: z
		.int()
		.optional()
		.describe('Reference ruleset — lowercase, as the client sends it. Ignored'),
})

/** `POST /api/sanitize/v1/isPure` — whether the text is free of profanity. */
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
	EndTime: z
		.string()
		.describe('ISO 8601 UTC, seconds precision; at most 24 hours after `StartTime`'),
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
		.describe('Present only with `includeDetails=True`; the stored `{ tag, type }` pairs'),
})

/**
 * The client's BASE event, 17 keys — what `GET /api/playerevents/v1` serves, and what the
 * v2 envelope carries once `Tags` is added. The stored record minus `State`, with
 * `ImageName` as a string (`""`, not null) and a `BroadcastingRoomInstanceId` (always null —
 * nothing broadcasts an event yet).
 *
 * The by-id, bulk and search reads serve the stored RECORD verbatim instead, so don't unify
 * the two.
 */
export const PlayerEventBaseDto = PlayerEventDto.omit({ State: true, ImageName: true }).extend({
	ImageName: z.string().describe('Empty string when the event has no image, never null'),
	BroadcastingRoomInstanceId: z
		.int()
		.nullable()
		.describe('Always null — no event broadcasts to a room instance yet'),
})

/**
 * The event as the v2 envelope carries it: the stored record MINUS `State`, PLUS `Tags`
 * and `BroadcastingRoomInstanceId`. `ImageName` is `""` rather than null when there is no
 * image.
 *
 * `Tags` has two shapes, picked from the caller's build: Rec Room reshaped it without
 * minting a new path, so a build newer than `20230414` gets the tag NAMES and every older
 * one (and any caller whose token names no build) gets the `{ Tag, Type }` pairs. Neither
 * is the lowercase `{ tag, type }` the v1 read serves.
 */
export const PlayerEventEnvelopeDto = PlayerEventBaseDto.extend({
	Tags: z
		.union([z.array(z.string()), z.array(z.object({ Tag: z.string(), Type: z.int() }))])
		.describe(
			'The event’s tags: names for a build newer than 20230414, `{ Tag, Type }` pairs for ' +
				'that build and older'
		),
})

/**
 * The `{ PlayerEvent, Result, TagModifyResult }` envelope the v2 routes answer with — the
 * writes and `GET /api/playerevents/v2/{eventId}`.
 *
 * `TagModifyResult` reports the tag edit that rides along with a write: `Result` 0 and the
 * tags the event now carries. It is an object — it was served as null back when no event
 * tags were stored.
 */
export const PlayerEventResultDto = z.object({
	PlayerEvent: PlayerEventEnvelopeDto,
	Result: z.int().describe('0 = success'),
	TagModifyResult: z.object({
		Result: z.int().describe('0 = success'),
		Tags: z.array(z.string()).describe('The tags the event now carries'),
	}),
})

/**
 * The envelope a delete answers with. Same three keys as {@link PlayerEventResultDto},
 * but both payload fields are null — the event is gone, so there is nothing to redraw
 * and the client reads only `Result`.
 */
export const PlayerEventDeletedDto = z.object({
	PlayerEvent: z.null(),
	Result: z.int().describe('0 = success'),
	TagModifyResult: z.null(),
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
 * `PUT /api/playerevents/v2/{eventId}/time` form body — the event's window, moved. Both
 * bounds are optional; an absent one keeps its stored value, so the start can be nudged
 * without restating the end. The RESOLVED window must end after it starts and run no
 * longer than 24 hours.
 */
export const PlayerEventTimeRequest = z.object({
	startTime: z
		.string()
		.optional()
		.describe('New start, any parseable ISO 8601 — the client sends .NET tick precision'),
	endTime: z.string().optional().describe('New end, same form'),
})

/**
 * `PUT /api/playerevents/v2/{eventId}/accessibility` form body. The client sends the
 * `RoomAccessibility` NAME, as it does on the subroom route in `rooms`; the ordinal is
 * accepted too.
 */
export const PlayerEventAccessibilityRequest = z.object({
	accessibility: z
		.string()
		.describe(
			'`Private`, `Public`, `Unlisted`, `Dev_only` or `Dev_Unlisted` (case-insensitive) — ' +
				'or its ordinal 0–4'
		),
})

/** `PUT /api/playerevents/v2/{eventId}/name` form body. */
export const PlayerEventNameRequest = z.object({
	name: z.string().describe('The new title; blank is refused — an event always has a name'),
})

/** `PUT /api/playerevents/v2/{eventId}/description` form body. */
export const PlayerEventDescriptionRequest = z.object({
	description: z.string().optional().describe('The new blurb; absent clears it'),
})

/**
 * `PUT /api/playerevents/v2/{eventId}/tags` body — a BARE JSON ARRAY of tag names
 * (`["tag1","class"]`), not an object. The whole set the event should carry.
 */
export const PlayerEventTagsRequest = z.array(z.string()).describe('The event’s whole tag set')

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

/**
 * `POST /api/inventions/v1/report` JSON body — a report against an invention. JSON, like
 * the event report and unlike the form-encoded player report. The reporter is NOT in the
 * body: it's the bearer token's player, and neither is the invention's creator, who is
 * read from the invention.
 */
/**
 * `POST /api/customAvatarItems/v1/{id}/report` JSON body. The item is named by the PATH, not
 * the body, and `ReportedPlayerId` arrives NULL — the client does not know who made the item,
 * so the creator is read off the item instead.
 */
export const CustomAvatarItemReportRequest = z.object({
	ReportCategory: z
		.int()
		.optional()
		.describe('The reason picked in the report UI. Stored verbatim; unmapped'),
	Details: z.string().optional().describe('The free-text description the reporter typed'),
	ReportedPlayerId: z
		.int()
		.nullable()
		.optional()
		.describe('Sent as null and IGNORED — the reported player is the item’s creator'),
})

export const InventionReportRequest = z.object({
	InventionId: z.int().describe('The invention being reported'),
	ReportCategory: z
		.int()
		.optional()
		.describe('The reason picked in the report UI. Stored verbatim; unmapped'),
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
 * `GET /api/images/v6` — an image's metadata by bucket key. A third projection of the same
 * row: renamed like `ImagesPlayer` (`SavedImageId`/`SavedImageType`, no `TaggedPlayerIds`)
 * but carrying `ClubId`, and with no nullable fields — `RoomId`, `PlayerEventId` and
 * `ClubId` are 0 where the row holds null, `Description` is `""`. Don't unify it with the
 * other two.
 */
export const ImageMetadataDto = z.object({
	SavedImageId: z.int(),
	ImageName: z.string().describe('The bucket key the img worker serves it back by'),
	PlayerId: z.int(),
	RoomId: z.int().describe('0 when the photo was not taken in a room'),
	PlayerEventId: z.int().describe('0 when it belongs to no event'),
	ClubId: z.int().describe('Always 0 — nothing here associates an image with a club'),
	Description: z.string().describe('Empty string, never null'),
	Accessibility: z.int(),
	AccessibilityLocked: z.boolean(),
	SavedImageType: z.int().describe('1 = share camera, 3 = room, 4 = profile, …'),
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

/**
 * `POST /api/images/v5/cheered/bulk` form body — the saved-image ids to report cheer state
 * for, as a REPEATED `id` field (`id=651&id=570&…`), one value per id. The client sends a
 * whole photo-grid page this way, around a hundred ids at a time.
 */
export const CheeredBulkRequest = z.object({
	id: z.string().describe('Repeated once per image id; each value may also be comma-separated'),
})

/** `POST /api/images/v1/cheer` JSON body. */
export const CheerImageRequest = z.object({
	SavedImageId: z.int(),
	Cheer: z.boolean().describe('True to cheer, false to un-cheer'),
})

/**
 * `PUT /api/players/v1/playerPhotoTaggingSetting` JSON body — who may tag the caller in
 * photos. The value is an opaque enum ordinal: it is stored and served back untouched, so
 * whatever the client means by a given number survives a round trip without this server
 * needing to know the enum.
 */
export const PhotoTaggingSettingRequest = z.object({
	Setting: z.int().describe('The preference’s enum ordinal, stored verbatim'),
})

/**
 * `GET|PUT /api/players/v1/playerPhotoTaggingSetting` — a BARE JSON integer, not an
 * envelope and not a `{ value }` wrapper. Both routes answer the setting the player now
 * has: the reference's GET and its PUT both `Ok(...)` the stored value.
 */
export const PhotoTaggingSettingResponse = z
	.int()
	.describe('The caller’s photo-tagging preference; 0 until they set one')

/** The bare `{ success: true }` ack the image writes answer with. */
export const SuccessResponse = z.object({ success: z.boolean() })

/** One entry of `GET /api/images/v5/cheered/bulk`, one per requested id, in order. */
export const CheeredEntry = z.object({
	SavedImageId: z.int(),
	IsCheered: z.boolean(),
})
