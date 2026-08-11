import { resolver } from 'hono-openapi'
import { z } from 'zod'

import type { OpenAPIV3_1 } from 'openapi-types'

/**
 * OpenAPI schemas for the econ worker.
 *
 * IMPORTANT: these are DESCRIPTIVE ONLY. They are passed to `describeRoute` to
 * generate the spec and are never wired into `hono-openapi`'s `validator()`. Same
 * rationale as the auth/accounts/match workers: a reverse-engineered protocol, lenient
 * handlers, no runtime validation.
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

// ---- Loose shapes ----------------------------------------------------------
// Several routes serve opaque static catalogs (avatar items, the weekly challenge) or
// empty-list stubs. Modelling every catalog field adds noise without value, so these
// use deliberately loose schemas.

/** An opaque JSON object (a catalog entry, an avatar blob, …). */
export const JsonObject = z.record(z.string(), z.unknown())
/** An opaque JSON array (a static catalog served verbatim). */
export const JsonArray = z.array(z.unknown())

// ---- Response schemas ------------------------------------------------------

/**
 * The public avatar render subset (`GET /api/avatar/v2/:id`) — the fields needed to
 * draw another player's avatar. The stored blob also holds OutfitSelectionsV2 /
 * CustomAvatarItems, which this view omits.
 */
export const AvatarV2Dto = z.object({
	OutfitSelections: z.unknown(),
	FaceFeatures: z.unknown(),
	SkinColor: z.unknown(),
	HairColor: z.unknown(),
})

/**
 * The `{ error, success, value }` envelope both consume routes return. Always HTTP 200,
 * even for a missing/already-gone target — the client parses this to finish the action,
 * so a bare 200 reads as a failure.
 */
export const ConsumeEnvelope = z.object({
	error: z.string(),
	success: z.boolean(),
	value: z.null(),
})

/** One currency balance entry (`GET /api/storefronts/v4/balance/:currencyType`). */
export const BalanceEntry = z.object({
	CurrencyType: z.int(),
	Platform: z.int().describe('-2 = all platforms (account-wide)'),
	Balance: z.int(),
})

/** `GET /econ/customAvatarItems/v1/owned` — paginated owned custom items. */
export const CustomAvatarItemsResponse = z.object({
	Results: JsonArray,
	TotalResults: z.int(),
})

/** `POST /api/CampusCard/v1/UpdateAndGetSubscription` — both fields null (no subs yet). */
export const SubscriptionResponse = z.object({
	subscription: z.null(),
	platformAccountSubscribedPlayerId: z.null(),
})

/** `POST /api/challenge/v2/updateProgress` — the identifying fields echoed back. */
export const ChallengeProgressResponse = z.object({
	ChallengeMapId: z.int(),
	ChallengeId: z.int(),
	Config: z.string(),
	Complete: z.boolean().describe('Always false — no challenge-progress store yet'),
})

/**
 * `POST /api/objectives/v1/updateobjective` — the group the objective belongs to, after
 * the update. camelCase, unlike the PascalCase body the client posts and the PascalCase
 * `ObjectiveGroups` entries `myprogress` serves — three spellings of the same group.
 */
export const UpdateObjectiveResponse = z.object({
	group: z.int().describe('Echoed back from the request'),
	isCompleted: z.boolean().describe('Always false — no objectives store yet'),
	clearedAt: z.string().describe('When the group was cleared — now, since nothing persists'),
})

/**
 * `POST /api/storefronts/v2/buyItem` — the purchase result. `Balance` is the CHANGE
 * applied (the negated price), not the resulting total; the client reads its new total
 * from `GET /balance/:type`. `BalanceType` -2 is account-wide. Each `Data` entry is the
 * gift-drop the recipient received.
 */
export const BuyItemResponse = z.object({
	BalanceUpdates: z.array(
		z.object({
			UpdateResponse: z.int(),
			Data: z.array(JsonObject).describe('The gift-drop(s) granted'),
		})
	),
	Balance: z.int().describe('The change applied (negated price), not the new total'),
	CurrencyType: z.int(),
	BalanceType: z.int().describe('-2 = account-wide'),
})

/**
 * `GET /api/storefronts/v2/buyInvention` — the purchase result. Two envelopes side by
 * side: the balance update (shaped like buyItem's, except `Balance` is the RESULTING
 * total, not the change, and `Data` is a single invention rather than a gift-drop list)
 * and the invention envelope the invention endpoints already serve.
 */
export const BuyInventionResponse = z.object({
	BalanceUpdateResponse: z.object({
		Balance: z.int().describe('The resulting balance — NOT the change, unlike buyItem'),
		BalanceType: z.int().describe('-2 = account-wide'),
		CurrencyType: z.int().describe('2 = RecCenterTokens'),
		BalanceUpdates: z.array(
			z.object({
				UpdateResponse: z.int(),
				Data: JsonObject.describe('The bought invention (`RRInvention`)'),
			})
		),
	}),
	InventionResponse: z
		.object({
			Status: z.int(),
			Invention: JsonObject,
			InventionVersion: JsonObject,
		})
		.describe('The same envelope `POST /api/inventions/v6/save` returns'),
})

/** buyItem / buyInvention error body (`{ error }`), returned on 400/403/404/409. */
export const ErrorResponse = z.object({ error: z.string() })

// ---- Request schemas -------------------------------------------------------

/** `POST /api/storefronts/v2/buyItem` JSON body. */
export const BuyItemRequest = z.object({
	StorefrontType: z.int().describe('Which storefront catalog (sf{N}.json)'),
	PurchasableItemId: z.int(),
	CurrencyType: z.int().describe('Must be a spendable account currency'),
	RequestedPrice: z.int().describe('The price the client rendered; a mismatch is 409'),
	Gift: z
		.object({
			ToPlayerId: z.int().optional(),
			Anonymous: z.boolean().optional(),
			Message: z.string().optional(),
			GiftContext: z.int().optional(),
		})
		.optional()
		.describe('Present when buying for another player; the caller still pays'),
})

/** `POST /api/consumables/v1/consume` JSON body. */
export const ConsumeConsumableRequest = z.object({
	Id: z.int().describe('The consumable row id to spend from'),
	DeltaCount: z.int().optional().describe('How many to spend; defaults to 1'),
})

/** `POST /api/avatar/v2/gifts/consume` form body (posted with a trailing slash). */
export const ConsumeGiftRequest = z.object({
	Id: z.string().describe('The gift-box id to open'),
	UnlockedLevel: z.string().optional().describe('Consumable-level hint; unused'),
})

/** `POST /api/challenge/v2/updateProgress` JSON body. */
export const ChallengeProgressRequest = z.object({
	ChallengeMapId: z.union([z.string(), z.int()]).optional(),
	ChallengeId: z.union([z.string(), z.int()]).optional(),
	Config: z.string().optional().describe('The client-evaluated rule tree'),
})

/**
 * `POST /api/objectives/v1/updateobjective` JSON body — one objective's state as the
 * client now sees it. `Index`/`Group` identify it within `myprogress`; the rest is the
 * progress it wants persisted.
 */
export const UpdateObjectiveRequest = z.object({
	Index: z.int().describe('Which objective within the group'),
	Group: z.int().describe('Which objective group'),
	Progress: z.int().optional(),
	VisualProgress: z.int().optional().describe('What the client animates towards'),
	IsCompleted: z.boolean().optional(),
	HasClaimedReward: z.boolean().optional(),
})

/** `POST /api/avatar/v3/saved/set` JSON body — an outfit with a target `Slot`. */
export const SaveOutfitRequest = z
	.object({ Slot: z.int().describe('Which slot to overwrite; a non-integer is 400') })
	.catchall(z.unknown())
	.describe('Plus opaque outfit fields (OutfitSelectionsV2, FaceFeatures, …) stored verbatim')

/**
 * `POST /api/avatar/v4/saved/set` response — a lean acknowledgement. Unlike v3 (which
 * echoes the whole outfit), v4 answers just the success flag and the slot it wrote.
 */
export const SaveOutfitV4Response = z.object({
	Success: z.boolean(),
	Slot: z.int().describe('The slot that was written'),
})

/**
 * `PUT /api/equipment/v1/update` JSON body — the client's favourite toggles. It echoes
 * back the whole entry it was served, but only `Favorited` is written; the rest is
 * ignored (as on the reference server).
 */
export const EquipmentUpdateRequest = z.array(
	z
		.object({
			ModificationGuid: z.string().describe('Identifies the owned equipment row'),
			Favorited: z.boolean(),
		})
		.catchall(z.unknown())
		.describe('Plus the echoed-back PrefabName / FriendlyName / Tooltip / Rarity, all ignored')
)

/** An opaque JSON body stored verbatim (the avatar blob for `POST /api/avatar/v2/set`). */
export const OpaqueJsonBody = JsonObject.describe('Stored verbatim and echoed back')
