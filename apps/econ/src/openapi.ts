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

/**
 * Optional bearer JWT — the empty requirement object makes "no credentials" a valid
 * alternative. For routes that serve public data but personalise it for a known caller
 * (the weekly challenge's per-player `Complete`) instead of 401ing.
 */
export const OPTIONAL_AUTHED: OpenAPIV3_1.SecurityRequirementObject[] = [{}, { bearerAuth: [] }]

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

/**
 * `GET /econ/roomEconConfig/:roomId` — a room's economy configuration. Only the
 * shop's sorting-tabs toggle is configurable, and nothing stores it yet.
 */
export const RoomEconConfig = z.object({
	RoomId: z.int().describe('Echoed back from the path'),
	EnableSortingTabs: z.boolean().describe('Always false — no per-room config is stored'),
})

/**
 * `GET /econ/customAvatarItems/v1/owned` — the caller's bought custom items, each the full
 * `CustomAvatarItem` record as the `api` worker serves it (see its `CustomAvatarItemDto`).
 */
export const CustomAvatarItemsResponse = z.object({
	Results: z.array(JsonObject),
	TotalResults: z.int(),
})

/**
 * A Rec Room Plus subscription (the client calls it a `CampusCard`). Nothing here sells one,
 * so this is the complimentary subscription reported by a caller whose token carries
 * `rn.plus` — stamped from `account.hasPlus`, which the website's Discord benefits claim
 * sets. See `plusSubscription` in econ.app.ts for why each field reads the way it does.
 */
export const SubscriptionDto = z.object({
	SubscriptionId: z.int().describe('Placeholder — no subscription is stored'),
	RecNetPlayerId: z.int().describe('The subscribed player: the caller'),
	PlatformType: z
		.int()
		.nullable()
		.describe(
			'Which store sold it: -1 All, 0 Steam, 1 Oculus, 2 PlayStation, 3 Xbox, 4 RecNet, ' +
				'5 IOS, 6 GooglePlay, 7 Standalone, 8 Pico. -1 here — no store did'
		),
	PlatformId: z.string().describe('Empty — no store account behind it'),
	PlatformPurchaseId: z.string().describe('Empty — nothing was purchased'),
	Level: z.int().describe('0 Gold, 1 Platinum'),
	Period: z.int().describe('0 Month, 1 Year, 2 ThreeMonth, 3 SixMonth'),
	ExpirationDate: z.string().describe('ISO 8601 UTC; a year out, recomputed per call'),
	IsAutoRenewing: z.boolean(),
	CreatedAt: z.string(),
	ModifiedAt: z.string(),
})

/**
 * One item as `GET /api/avatar/v4/items` serves it — camelCase, unlike the PascalCase
 * records the sibling item endpoints hand back. `avatarItemId` is 0 and `tagList` empty
 * for every item we have: neither the default catalog nor a storefront gift-drop carries
 * them.
 */
export const AvatarItemV4Dto = z.object({
	avatarItemId: z.int(),
	avatarItemDesc: z.string().describe('The comma-delimited item descriptor, commas and all'),
	friendlyName: z.string(),
	tooltip: z.string(),
	tagList: z.string(),
	avatarItemType: z.int(),
	rarity: z.int(),
	isBaseAvatarItem: z.boolean(),
})

/**
 * `POST /api/checklist/v1|v2/complete` JSON body — which checklist row was finished.
 * The client posts just `{ "ItemIndex": 1 }`; `Id` is the fallback key read when
 * `ItemIndex` is absent or 0.
 */
export const CompleteChecklistRequest = z.object({
	ItemIndex: z.int().describe('The row’s index — what the client actually sends'),
	Id: z.int().optional().describe('Fallback row id, read when ItemIndex is absent or 0'),
})

/**
 * `POST /api/checklist/v1|v2/complete` — the balance-update envelope, the same shape
 * buyItem answers with. `Balance` is the CHANGE applied, so a stubbed (ungranted)
 * completion reports 0. `UpdateResponse` 303 is the checklist-reward context.
 */
export const ChecklistCompleteResponse = z.object({
	BalanceUpdates: z.array(z.object({ UpdateResponse: z.int(), Data: z.array(JsonObject) })),
	Balance: z.int().describe('The change applied — 0 while completion is stubbed'),
	CurrencyType: z.int(),
	BalanceType: z.int().describe('-2 = account-wide'),
})

/**
 * One row of the new-user checklist (`GET /api/checklist/v1|v2/current`). `Objective` is
 * an `ObjectiveType` ordinal the client matches its own progress events against.
 */
export const ChecklistEntry = z.object({
	Order: z.int().describe('Position in the list, from 0'),
	Objective: z.int().describe('ObjectiveType ordinal, e.g. 38 = SaveOutfitSlot'),
	Count: z.int().describe('How many times the objective must happen'),
	CreditAmount: z.int().describe('Tokens awarded on completion'),
})

/**
 * `POST /api/CampusCard/v1/UpdateAndGetSubscription` — the caller's subscription, or `{}`
 * when they have none (which is everyone without the `developer` role). `{}` rather than a
 * `Subscription: null` envelope: an absent key is how the client reads "not subscribed".
 */
export const SubscriptionResponse = z.union([
	z.object({
		Subscription: SubscriptionDto,
		PlatformAccountSubscribedPlayerId: z
			.null()
			.describe('The platform account holding the sub, when it is shared. Never set here'),
	}),
	z.object({}).describe('`{}` — no subscription'),
])

/**
 * `GET /api/CampusCard/v1/SignUpBonus` — the Rec Room Plus sign-up bonus. Fixed values,
 * not per-account: `RRPlusSignUpBonusId` names the bonus that is running and the two
 * prices are the token window the free items are drawn from.
 */
export const RRPlusSignUpBonus = z.object({
	RRPlusSignUpBonusId: z.int().describe('Which sign-up bonus is running'),
	MinFreeItemsPrice: z.int().describe('Lowest token price a free item may have'),
	MaxFreeItemsPrice: z.int().describe('Highest token price a free item may have'),
})

/**
 * `GET /api/influencerpartnerprogram/influencers` — the ids of every influencer in the
 * partner program, which the client uses to badge them wherever they appear. An object
 * around the list, not a bare array.
 */
export const InfluencerIdsResponse = z.object({
	InfluencerIds: z
		.array(z.int())
		.describe('Account ids in the partner program. Empty — no programme runs here'),
})

/**
 * `GET /api/influencerpartnerprogram/influencer` and `…/myinfluencer` — one account's
 * standing in the partner program.
 *
 * A BARE NUMBER, not an object: the body is the literal `0`, which is the "not an
 * influencer" tier. Nobody on this server is one, so 0 is the answer for every account, the
 * caller's own included.
 */
export const InfluencerTierResponse = z
	.literal(0)
	.describe('The account’s partner tier. Always 0 — nobody here is an influencer')

/**
 * `GET /api/incentivizedreferrals/progress` — how far the caller has got with the
 * refer-a-friend rewards: how many referrals have been verified, and which rewards they
 * have taken from that track.
 *
 * A `{ success, value }` envelope with the payload nested — not the flat bodies the balance
 * routes answer with. Nothing here runs a referral programme, so the count is 0 and the
 * reward list is empty: a player who has referred nobody, which is everybody.
 */
export const ReferralProgressResponse = z.object({
	success: z.boolean(),
	value: z.object({
		ReferralsVerifiedCount: z.int().describe('Referrals that have been verified. Always 0'),
		PlayerReferralRewards: z
			.array(z.unknown())
			.describe('Rewards claimed off the referral track. Always empty'),
	}),
})

/**
 * `GET /api/makerai/checkfreetrialeligibility` — a BARE JSON boolean (`false`), not an
 * envelope and not a `{ value }` wrapper. The whole body is the answer.
 */
export const MakerAiFreeTrialEligibilityResponse = z
	.boolean()
	.describe('Whether the caller can start a Maker AI free trial; always false')

/** `POST /api/challenge/v2/updateProgress` — the identifying fields echoed back. */
export const ChallengeProgressResponse = z.object({
	ChallengeMapId: z.int(),
	ChallengeId: z.int(),
	Config: z
		.string()
		.describe('The STORED rule tree — a report carrying none keeps (and echoes) the last one'),
	Complete: z
		.boolean()
		.describe('The STORED completion — latches true within a rotation, so it may differ'),
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
 * How a bulk-purchase line names its item. A discriminated id: the client buys both
 * catalog items (a storefront `PurchasableItemId`, under `NumberId`, `Type` 0) and
 * guid-keyed ones (`Type` 1, a custom avatar item's `CustomAvatarItemId` under `Guid`),
 * which resolve against the `custom_avatar_item` table and are paid to their creator.
 */
export const ItemPurchaseMethodId = z.object({
	Type: z.int().describe('0 = NumberId (a storefront item); 1 = Guid (a custom avatar item)'),
	NumberId: z.int().nullable().optional().describe('The storefront PurchasableItemId'),
	Guid: z
		.string()
		.nullable()
		.optional()
		.describe('The `CustomAvatarItemId` of a custom avatar item, for Type 1'),
})

/**
 * `POST /api/items/bulkpurchase` — the whole bag's result.
 *
 * NOT buyItem's envelope. The wrapper is `{ Success, Error, error_id, Value }` — `error_id`
 * lowercase because the client renames that one member, the other three PascalCase — and
 * `Value` is a BalanceUpdateResponse: the RESULTING `{ Balance, CurrencyType, Platform }`
 * (buyItem reports the change instead) plus one `BalanceUpdates` entry per REQUESTED item.
 * `Value` is null whenever nothing was bought; the client's validator only cascades into a
 * non-null one, so that parses.
 *
 * Per-line reporting is each entry's `UpdateResponse`. `AllowPartialSuccess` is what lets
 * some of them come back non-OK while `Success` stays true.
 */
export const BulkPurchaseResponse = z.object({
	Success: z.boolean().describe('False only when the bag bought nothing at all'),
	Error: z.string().nullable().describe('Why nothing was bought; null on success'),
	error_id: z.string().nullable().describe('Always null — no error-id catalog here'),
	Value: z
		.object({
			Balance: z.int().describe('The RESULTING total in the bucket below, NOT buyItem’s change'),
			CurrencyType: z.int(),
			Platform: z
				.int()
				.describe(
					'The balance bucket — the client’s `BalanceType` under a [DataMember] rename. -2, ' +
						'account-wide: the reference server said 4 (RecNetPurchased) because it kept a ' +
						'wallet per store; this one keeps a single bucket, and the client SUMS its buckets'
				),
			BalanceUpdates: z
				.array(
					z.object({
						UpdateResponse: z
							.int()
							.describe(
								'This line’s outcome: 0 OK, 1 TooManyRequests, 2 NotEnoughCredit, ' +
									'3 AlreadyOwned, 4 NoItemAvailable, 5 CouponNotApplicable, ' +
									'6 RequestedPriceDoesNotMatch, 7 RequestedAmountNotAllowed, ' +
									'8 PlayerNotEligible, 9 RequestCannotBeRefunded, 10 PlayerNotApproved'
							),
						Data: z.object({
							GiftPackage: JsonObject.nullable().describe(
								'The box created for this line (20 keys; a custom item’s names it by ' +
									'`CustomAvatarItemId`). Null on a line that didn’t sell, ' +
									'and under `BypassGiftPackages` — the item is granted either way'
							),
							PurchasableItemId: z.int().nullable().describe('The catalog item this line named'),
							CustomAvatarItem: JsonObject.nullable().describe(
								'The whole `CustomAvatarItem` record on a guid-keyed line that sold; null otherwise'
							),
						}),
					})
				)
				.describe('One entry per REQUESTED item, in request order — failures included'),
		})
		.nullable()
		.describe('Null when nothing was bought'),
})

/**
 * The JSON body `POST /api/storefronts/v3/buyInvention` takes. The same two values the v2
 * GET reads off the query string (`inventionId`/`requestedPrice`), PascalCase in a body —
 * that is the only difference between the two routes.
 */
export const BuyInventionRequest = z.object({
	InventionId: z.int().describe('The invention to buy; missing or non-integer is 400'),
	RequestedPrice: z
		.int()
		.optional()
		.describe('The price the client rendered; a mismatch is 409. Absent reads as 0'),
})

/**
 * `GET /api/storefronts/v2/buyInvention` and `POST /api/storefronts/v3/buyInvention` — the
 * purchase result, identical for both. Two envelopes side by side: the balance update
 * (shaped like buyItem's, except `Balance` is the RESULTING total, not the change, and
 * `Data` is a single invention rather than a gift-drop list) and the invention envelope the
 * invention endpoints already serve.
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

/**
 * `POST /api/storefronts/v3/buyInvention` — the purchase result the 2025 client wants,
 * which is NOT v2's despite settling the identical purchase. Two differences, both
 * recovered from a capture of the real response:
 *
 *  - `InventionResponse` is the v9 SAVE envelope (`{ Value, Success, Error, error_id }`)
 *    rather than v6's bare `{ Status, Invention, InventionVersion }`, and its `Invention`
 *    is the client's 28-key `RRInvention`. A buy mints no version and takes no tags, so
 *    `InventionVersion` and `TagsResponse` are present and null.
 *  - The balance half is `BalanceResponseDTO`, so the bucket key is `Platform` — the
 *    client's `BalanceType` member under a [DataMember] rename, the same one the bulk
 *    purchase answers in. v2 spells it `BalanceType`; do not unify them.
 */
export const BuyInventionV3Response = z.object({
	InventionResponse: z
		.object({
			Value: z
				.object({
					Status: z.int().describe('0 on success'),
					Invention: JsonObject.describe('The bought invention as the 28-key `RRInvention`'),
					InventionVersion: z.null().describe('Always null — a buy mints no version'),
					TagsResponse: z.null().describe('Always null — a buy takes no tags'),
				})
				.describe('Never null under `Success: true` — the client dereferences it unguarded'),
			Success: z.boolean(),
			Error: z.string().nullable().describe('Null on success — not `""`'),
			error_id: z.string().nullable().describe('Always null — no error-id catalog here'),
		})
		.describe('The same envelope `POST /api/inventions/v9/save` returns'),
	BalanceUpdateResponse: z.object({
		BalanceUpdates: z.array(
			z.object({
				UpdateResponse: z.int(),
				Data: JsonObject.describe('The bought invention, the same `RRInvention` as above'),
			})
		),
		Balance: z.int().describe('The resulting balance — NOT the change, unlike buyItem'),
		CurrencyType: z.int().describe('2 = RecCenterTokens'),
		Platform: z
			.int()
			.describe(
				'The balance bucket — the client’s `BalanceType` under a [DataMember] rename. -2, ' +
					'account-wide: the capture said 0 (SteamPurchased) because the reference server ' +
					'kept a wallet per platform; this one keeps a single bucket, and the client SUMS them'
			),
	}),
})

/** buyItem / buyInvention error body (`{ error }`), returned on 400/403/404/409. */
/** The JSON body `POST /api/ugcPurchasables/v1/items/bulk` takes. */
export const UgcPurchasableBulkRequest = z.object({
	RoomId: z.number().int().describe('Echoed back on each item; not otherwise used'),
	Ids: z.array(
		z.object({
			itemType: z.number().int().describe('3 = custom avatar item (the only type served)'),
			itemId: z.string().describe('The `CustomAvatarItemId`'),
		})
	),
})

/** The client's `UgcPurchasableItem` — a store-facing view of a custom avatar item. */
export const UgcPurchasableItemDto = z.object({
	ItemType: z.number().int(),
	ItemId: z.string(),
	Name: z.string(),
	Description: z.string(),
	ImageName: z.string(),
	RoomId: z.number().int(),
	Price: z.number().int(),
	PurchaseCurrencyId: z.string().nullable(),
	CreatedAt: z.string(),
	ModifiedAt: z.string(),
})

/** What the bulk lookup answers: the resolved items, unknown ids omitted. */
export const UgcPurchasableItemList = z.array(UgcPurchasableItemDto)

/**
 * `POST /api/items/purchaseInfos` JSON body — the same `{ itemType, itemId }` reference
 * shape the UGC bulk lookup takes, minus the room. camelCase INSIDE the reference, which is
 * the client's own inconsistency: the response wraps this very object under a PascalCase
 * `ItemId` key without renaming its members.
 */
export const ItemPurchaseInfosRequest = z.object({
	Ids: z.array(
		z.object({
			itemType: z.number().int().describe('3 = custom avatar item (the only type served)'),
			itemId: z.string().describe('The `CustomAvatarItemId`'),
		})
	),
})

/** One `Prices[]` entry: what the item costs in one currency, and any sale on top. */
export const ItemPriceDto = z.object({
	CurrencyType: z.number().int().describe('2 = RecCenterTokens — what UGC items are priced in'),
	Price: z.number().int(),
	StorefrontSaleData: z
		.object({
			SalePercent: z.number().int(),
			SaleStartDate: z.string().nullable(),
			SaleEndDate: z.string().nullable(),
		})
		.nullable()
		.describe('Always a zero-percent sale here; nothing discounts UGC items yet'),
})

/** The client's `ItemPurchaseInfo` — how one item may be bought. */
export const ItemPurchaseInfoDto = z.object({
	ItemId: z.object({ itemType: z.number().int(), itemId: z.string() }),
	PurchaseMethodId: z.object({
		Type: z.number().int(),
		NumberId: z.number().int().nullable(),
		Guid: z.string().nullable(),
	}),
	Prices: z.array(ItemPriceDto),
	NewUntil: z.string().nullable(),
	AvailableAt: z.string().nullable(),
	AvailableUntil: z.string().nullable(),
	CanBeGifted: z.boolean(),
	CanApplySubscriberDiscount: z.boolean(),
	SubscribersOnly: z.boolean(),
	IsFeatured: z.boolean(),
})

/** What the purchase-info lookup answers: one entry per RESOLVED id, unknown ids omitted. */
export const ItemPurchaseInfoList = z.array(ItemPurchaseInfoDto)

/**
 * `POST /api/avatar/v1/lockeditems/bulk` JSON body — the descs the client wants the locked
 * state for. Currently accepted and not read; see the route.
 */
export const LockedItemsBulkRequest = z.object({
	AvatarItemDescriptions: z
		.array(z.string())
		.describe('The `AvatarItemDesc` of each item the client is about to draw'),
})

export const ErrorResponse = z.object({ error: z.string() })

/**
 * A room currency — a custom currency minted for use inside one room. The client's own model,
 * member for member and in its order (see the `notify` worker's `RoomCurrencyPayload`, which
 * the `RoomCurrencyCreated`/`Modified` frames carry: the create response and those frames are
 * the same object). `CurrencyType` is always 300 (RoomCurrency) — a room currency is told
 * apart from the others by its `CurrencyId`, not by its type.
 */
export const RoomCurrencyDto = z.object({
	CurrencyId: z.string().describe('GUID — how the client names this currency afterwards'),
	RoomId: z.int(),
	Name: z.string(),
	Description: z.string(),
	CurrencyType: z
		.literal(300)
		.describe('Always 300 (RoomCurrency) — the same enum `buyInvention` prices in'),
	Limit: z
		.int()
		.describe(
			'The most the room may award PER DAY — a faucet rate, not a holding cap. Stored and ' +
				'served, but not enforced: nothing tracks a day’s awards yet'
		),
	Shape: z.int().describe('A byte — the client’s index into its coin shapes; uninterpreted'),
	Color: z
		.int()
		.describe('The client’s index into its coin colours, signed — it sends -1 for none'),
	ImageName: z.string().nullable().describe('Null — custom coin art is not uploadable yet'),
	CreatedAt: z.string().describe('ISO-8601 UTC'),
	ModifiedAt: z.string().describe('ISO-8601 UTC; equal to `CreatedAt` until an edit'),
})

/**
 * The envelope `POST /api/roomcurrencies/v1/createCurrency` answers in. The client unwraps it
 * and hands its callers `Value` alone, so the envelope exists on the wire but never reaches
 * the code that uses the currency.
 *
 * PascalCase `Value`/`Success`/`Error` beside a lowercase `error_id` — the same mixed casing
 * the client's other envelopes use (see the `rooms` worker's isBanned and publish-state
 * envelopes). NOT the lowercase `{ success, error, value }` the room mutations answer with;
 * the two live in different workers and must not be unified.
 */
export const RoomCurrencyEnvelope = z.object({
	Value: RoomCurrencyDto.nullable().describe('The currency, or null on a failure'),
	Success: z.boolean(),
	Error: z.string().nullable().describe('Null on success; the failure message otherwise'),
	error_id: z.null().describe('Always null. Present as a key, and lowercase'),
})

/** `POST /api/roomcurrencies/v1/createCurrency` — form-encoded. */
export const CreateRoomCurrencyRequest = z.object({
	RoomId: z.string().describe('The room the currency belongs to'),
	Name: z.string().describe('Shown to players; profanity-masked like every typed string'),
	Description: z.string().optional().describe('Defaults to empty'),
	Limit: z
		.string()
		.optional()
		.describe('The most the room may award per day; defaults to 0. Not enforced yet'),
	Shape: z.string().optional().describe('Coin shape index; defaults to 0'),
	Color: z.string().optional().describe('Coin colour index; defaults to 0'),
})

/**
 * A room key — a named, priced admission ticket a room lists. The shape is the `RoomKey` the
 * live client was observed reading out of the create response, member for member and in its
 * order; the `LocalRoomKeyCreated` frame (the `notify` worker's `LocalRoomKeyPayload`) carries
 * the same object.
 *
 * `RoomKeyId` is a NUMBER, unlike a room currency's or consumable's GUID — the client's model
 * says so — with the `ReplicationId` GUID beside it. The create body's `Type` arrives as an
 * enum NAME (`Key`) and is served as the ORDINAL (0). `ImageName` is null, not '', until a key
 * can carry art.
 */
export const RoomKeyDto = z.object({
	RoomKeyId: z.int().describe('Autoincrement — how the client names this key afterwards'),
	ReplicationId: z.string().describe('GUID, minted alongside the id'),
	RoomId: z.int(),
	Name: z.string(),
	Description: z.string(),
	Price: z.int(),
	PurchaseCurrencyId: z
		.string()
		.nullable()
		.describe('A `room_currency` id, or null — the create body names none'),
	CreatedAt: z.string().describe('ISO-8601 UTC'),
	ImageName: z.string().nullable().describe('Null — a key cannot carry art yet'),
	Type: z.int().describe('The key type’s ordinal: 0 `Key`, the only one seen'),
})

/**
 * The envelope `POST /api/roomkeys/v1/create` answers in: `{ Status, RoomKey }`, observed from
 * the live client — NOT the `{ Value, Success, Error, error_id }` the room-currency and
 * consumable writes use, though they live in the same worker. `Status` is 0 on success. A
 * refusal answers a non-zero `Status` with a null `RoomKey`; only the success shape has been
 * observed, so the refusal code (1) is an assumption.
 */
export const RoomKeyEnvelope = z.object({
	Status: z.int().describe('0 on success; 1 on a refusal (the refusal code is an assumption)'),
	RoomKey: RoomKeyDto.nullable().describe('The key, or null on a refusal'),
})

/** `POST /api/roomkeys/v1/create` — form-encoded. */
export const CreateRoomKeyRequest = z.object({
	Type: z
		.string()
		.optional()
		.describe('The key type, as an enum NAME. Only `Key` has been seen; defaults to it'),
	RoomId: z.string().describe('The room the key opens'),
	Name: z.string().describe('Shown to players; profanity-masked like every typed string'),
	Description: z.string().optional().describe('Defaults to empty'),
	Price: z.string().optional().describe('What the key costs; defaults to 0'),
})

/**
 * One purchase offer on a room currency — a way to BUY that currency, priced in another
 * ("5 SuperTokens for 500 Rec Center Tokens"). The client's own model, member for member and
 * in its order.
 */
export const RoomCurrencyPurchaseOfferDto = z.object({
	CurrencyPurchaseOfferId: z.string().describe('GUID — names this offer'),
	CurrencyId: z.string().describe('GUID of the currency being SOLD'),
	Order: z.int().describe('Where it sits in the currency’s shop; the list is sorted by it'),
	Name: z.string(),
	CurrencyAmount: z.int().describe('How much of the currency the offer hands over'),
	Price: z.int().describe('What it costs'),
	ModifiedAt: z.string().describe('ISO-8601 UTC'),
})

/**
 * One room consumable — a thing a room sells, priced in the room's own currency. The client's
 * own model, member for member and in its order.
 *
 * Note `Price`/`PurchaseCurrencyId` here against the nested `PriceAndCurrency` the WRITE
 * takes: the client sends them nested and reads them flat, so the two shapes genuinely differ.
 */
export const RoomConsumableDto = z.object({
	RoomConsumableId: z.string().describe('GUID — how the client names this listing afterwards'),
	RoomId: z.int(),
	Name: z.string(),
	Description: z.string(),
	ImageName: z.string().nullable().describe('Null for a listing with no picture'),
	Price: z.int(),
	PurchaseCurrencyId: z
		.string()
		.nullable()
		.describe('A `room_currency` id — the room’s own money. Not resolved or validated yet'),
	ModifiedAt: z.string().describe('ISO-8601 UTC'),
	MaximumCountPerPurchase: z
		.int()
		.describe('How many may be bought at once. Stored and served; nothing buys one yet'),
})

/**
 * `PUT /api/roomconsumables/v1/roomConsumable` — JSON, creating a listing or replacing one.
 *
 * `RoomConsumableId` null (or absent) creates; naming an existing listing replaces it. An edit
 * REPLACES rather than merges — the client sends the whole form back — which is the opposite
 * of the currency edit, whose body is genuinely partial.
 */
export const UpsertRoomConsumableRequest = z.object({
	RoomConsumableId: z.string().nullable().optional().describe('Null to create; an id to replace'),
	RoomId: z.int().describe('The room whose shop this is. Ignored when editing — see the route'),
	Name: z.string(),
	Description: z.string().optional().describe('Defaults to empty'),
	ImageName: z.string().nullable().optional(),
	PriceAndCurrency: z
		.object({
			Price: z.int(),
			CurrencyId: z.string().nullable().optional().describe('A `room_currency` id'),
		})
		.optional()
		.describe('Collapsed into `Price`/`PurchaseCurrencyId` on the stored listing'),
	MaximumCountPerPurchase: z
		.int()
		.optional()
		.describe('The client has not been seen sending this; defaults to 0'),
})

/**
 * `POST /api/roomconsumables/v1/roomConsumable/awardBulk` — the consumables to give the
 * CALLER. `Requests` is a MAP keyed by consumable id, not a list: the id is the key, and each
 * value is what to do with it.
 */
export const AwardRoomConsumablesRequest = z.object({
	Requests: z
		.record(
			z.string(),
			z.object({
				Quantity: z.int().describe('How many to give; negative takes them away'),
				ConcurrencyCodes: z
					.object({
						CurrentConcurrencyCode: z.string().nullable().optional(),
						NewConcurrencyCode: z.string().nullable().optional(),
					})
					.optional()
					.describe('Accepted and IGNORED — no optimistic concurrency is implemented yet'),
			})
		)
		.describe('Keyed by consumable id'),
})

/**
 * One entry's result from the consumable award, in the order its key appeared in `Requests`.
 *
 * Shaped after the room-currency bulk award, which is the one response in this family the
 * client has been seen reading: success is PER ENTRY, so one bad id neither fails the others
 * nor the call, and `Response` is null when the entry failed.
 */
export const AwardRoomConsumableResult = z.object({
	ConsumableId: z.string(),
	Success: z.boolean(),
	Error: z.string().nullable().describe('Null on success'),
	Response: z
		.object({
			PlayerId: z.int(),
			ConsumableId: z.string(),
			Quantity: z.int().describe('The RESULTING total owned, never the change'),
			AwardedAt: z.string().describe('ISO-8601 UTC'),
		})
		.nullable(),
})

export const AwardRoomConsumableResultList = z.array(AwardRoomConsumableResult)

/**
 * The envelope the consumable write answers in — the same
 * `{ Value, Success, Error, error_id }` the room-currency writes use.
 */
export const RoomConsumableEnvelope = z.object({
	Value: RoomConsumableDto.nullable(),
	Success: z.boolean(),
	Error: z.string().nullable(),
	error_id: z.null(),
})

/**
 * One currency's shop, as `GET /api/roomcurrencies/v1/getPurchaseOffersBatch` groups them —
 * one entry per currency asked for, the whole answer an array of these.
 *
 * Grouped rather than flat even though every offer already carries its own `CurrencyId`: the
 * group is what says a currency was ASKED ABOUT, which a flat list cannot. A currency with no
 * shop still gets a group with an empty `PurchaseOffers`.
 */
export const RoomCurrencyPurchaseOffersDto = z.object({
	CurrencyId: z.string(),
	PurchaseOffers: z
		.array(RoomCurrencyPurchaseOfferDto)
		.describe('Sorted by `Order`; empty for a currency that sells nothing yet'),
})

/**
 * `POST /api/roomcurrencies/v1/createPurchaseOffer` — form-encoded.
 *
 * Note `Amount` here against `CurrencyAmount` on the offer it becomes: the body and the model
 * spell the same number differently, and the route maps between them rather than serving the
 * body’s spelling back.
 */
export const CreatePurchaseOfferRequest = z.object({
	CurrencyId: z.string().describe('The currency this offer sells'),
	Name: z.string().describe('The offer’s name; the client has been seen sending a GUID'),
	Amount: z.string().describe('How much of the currency the offer hands over (`CurrencyAmount`)'),
	Price: z.string().describe('What it costs'),
	Order: z.string().optional().describe('Where it sits in the shop; defaults to 0'),
})

/**
 * The envelope the create-offer endpoint answers in — the same
 * `{ Value, Success, Error, error_id }` the currency writes use, with the offer in `Value`.
 */
export const RoomCurrencyPurchaseOfferEnvelope = z.object({
	Value: RoomCurrencyPurchaseOfferDto.nullable(),
	Success: z.boolean(),
	Error: z.string().nullable(),
	error_id: z.null(),
})

/**
 * One entry of `POST /api/roomcurrencies/v1/awardCurrency/bulk` — a JSON ARRAY of these,
 * not an object wrapping one. Each names its own currency and recipient, so a single call can
 * pay several players, or one player in several currencies.
 */
export const AwardRoomCurrencyRequest = z.object({
	CurrencyId: z.string().describe('The room currency being awarded'),
	RecipientId: z.int().describe('The player receiving it'),
	Amount: z.int().describe('How much to add; negative deducts, and a balance floors at 0'),
	TransactionId: z
		.string()
		.optional()
		.describe(
			'The client’s id for this award, so a retry is the same award. NOT YET DEDUPLICATED — ' +
				'accepted and validated, but a replay currently awards twice'
		),
})

/** What one award actually did, on the result that reports it. */
export const AwardRoomCurrencyResponse = z.object({
	AccountId: z.int().describe('The player paid'),
	CurrencyId: z.string(),
	Balance: z.int().describe('The RESULTING total, never the change'),
	AmountAwarded: z
		.int()
		.describe(
			'What actually landed — less than asked for when the `Limit` or the zero floor clamped it'
		),
	AwardedAt: z.string().describe('ISO-8601 UTC'),
})

/**
 * One entry's result from `POST /api/roomcurrencies/v1/awardCurrency/bulk`, in the order sent.
 *
 * Success is PER ENTRY: `Success`/`Error` are this entry's alone and `Response` is null when
 * it failed, so one bad entry neither fails the others nor the call. That includes an entry
 * whose currency belongs to a room the caller cannot manage — a rejection here rather than a
 * 403 over everything. `AccountId` and `CurrencyId` are repeated outside `Response` so a
 * caller can line a failure up with what it sent, where there is no `Response` to read them
 * from.
 */
export const AwardRoomCurrencyResult = z.object({
	AccountId: z.int(),
	CurrencyId: z.string(),
	Success: z.boolean(),
	Error: z.string().nullable().describe('Null on success'),
	Response: AwardRoomCurrencyResponse.nullable().describe('Null when this entry failed'),
})

export const AwardRoomCurrencyResultList = z.array(AwardRoomCurrencyResult)

/**
 * `POST /api/roomcurrencies/v1/updateCurrency` — form-encoded. Names the currency by id
 * rather than by room: the room it belongs to is whichever one minted it, and an edit cannot
 * move it. Every field but `CurrencyId` is optional and an absent one is left as it was.
 */
export const UpdateRoomCurrencyRequest = z.object({
	CurrencyId: z.string().describe('The currency to edit, as the create response named it'),
	Name: z.string().optional().describe('Profanity-masked like every typed string'),
	Description: z.string().optional(),
	Limit: z.string().optional().describe('The most the room may award per day. Not enforced yet'),
	Shape: z.string().optional().describe('Coin shape index'),
	Color: z.string().optional().describe('Coin colour index, signed'),
})

// ---- Request schemas -------------------------------------------------------

/**
 * The `Gift` block both purchase bodies carry — present when buying an item for another
 * player. The caller is still the one debited.
 */
export const GiftBlock = z
	.object({
		ToPlayerId: z.int().optional(),
		Anonymous: z.boolean().optional(),
		Message: z.string().optional(),
		GiftContext: z.int().optional(),
	})
	.describe('Present when buying for another player; the caller still pays')

/** `POST /api/storefronts/v2/buyItem` JSON body. */
export const BuyItemRequest = z.object({
	StorefrontType: z.int().describe('Which storefront catalog (sf{N}.json)'),
	PurchasableItemId: z.int(),
	CurrencyType: z.int().describe('Must be a spendable account currency'),
	RequestedPrice: z.int().describe('The price the client rendered; a mismatch is 409'),
	Gift: GiftBlock.optional(),
})

/**
 * `POST /api/items/bulkpurchase` JSON body — the shopping bag, checked out in one call.
 * `StorefrontType` and `CurrencyType` are the bag's, not per line: every line is bought
 * from one catalog with one currency.
 */
export const BulkPurchaseRequest = z.object({
	PurchaseItemRequests: z
		.array(
			z.object({
				ItemPurchaseMethodId,
				RequestedPrice: z
					.int()
					.describe('The UNIT price the client rendered; a mismatch fails the line'),
				Gift: GiftBlock.nullable().optional(),
				CouponConsumablePlayerMappingId: z
					.int()
					.nullable()
					.optional()
					.describe('Unsupported — nothing issues coupons, so a non-null one fails the line'),
				DuplicateItemCount: z.int().optional().describe('Copies of this item; defaults to 1'),
			})
		)
		.describe('One line per item in the bag; at most Econ.BulkPurchaseCap (200) copies in total'),
	StorefrontType: z.int().describe('Which storefront catalog (sf{N}.json) every line comes from'),
	CurrencyType: z.int().describe('Must be a spendable account currency'),
	BypassGiftPackages: z
		.boolean()
		.optional()
		.describe('Grant the items without wrapping them in gift boxes'),
	AllowPartialSuccess: z
		.boolean()
		.optional()
		.describe('Buy the lines that work and report the rest; false is all-or-nothing'),
	ShoppingBagId: z
		.union([z.string(), z.int()])
		.nullable()
		.optional()
		.describe('The client’s bag id, echoed back untouched'),
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
	Config: z
		.string()
		.optional()
		.describe(
			'The client-evaluated rule tree, with its running count in `cc`; stored as the player’s progress'
		),
	Complete: z
		.union([z.string(), z.boolean()])
		.optional()
		.describe('The client’s verdict — sent as .NET’s `"True"`/`"False"`'),
})

/** `POST /api/gamerewards/v1/request` form body. */
export const GameRewardRequest = z.object({
	rewardType: z
		.string()
		.describe('The reward being asked for, e.g. `FirstActivityOfDay`, `PostGameActivity`'),
	Message: z.string().optional().describe('The message to show for the reward'),
	giftContext: z
		.string()
		.optional()
		.describe(
			'The activity it came from, e.g. `Soccer` — part of the cooldown key. A key of `quest-rewards.json` (`Dodgeball`, `Quest_Goblin_S`, …) also picks the prize from that activity’s table'
		),
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
