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

export const GrantRoomBadgeRequest = z.object({
	TargetAccountId: z.int().positive(),
	BadgeCustomAvatarItemId: z.uuid(),
	RoomInstanceId: z.int().positive(),
	GrantMessage: z.string().nullable().optional(),
})

export const GrantRoomBadgeResponse = z.object({
	ResponseCode: z.union([z.literal(0), z.literal(1), z.literal(2)]),
	ErrorMessage: z.string().nullable(),
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
 * around the list, not a bare array. `ContinuationToken` is the paging cursor; always null
 * here, the whole list fitting in one page.
 */
export const InfluencerIdsResponse = z.object({
	InfluencerIds: z
		.array(z.int())
		.describe('Account ids in the partner program — every account flagged `isInfluencer`'),
	ContinuationToken: z
		.null()
		.describe('Paging cursor for the next page. Always null — the list is served whole'),
})

/**
 * `GET /api/influencerpartnerprogram/influencer` and `…/myinfluencer` — the account id of
 * the influencer an account supports.
 *
 * A BARE NUMBER, not an object: the body is the literal id, or `0` when the account
 * supports nobody. The write (`POST …/support`) does NOT answer in this shape; see
 * `SupportInfluencerResponse`.
 */
export const SupportedInfluencerResponse = z
	.int()
	.describe('The account id of the influencer this account supports; 0 for nobody')

/** `POST /api/influencerpartnerprogram/support` — the influencer the caller picks. */
export const SupportInfluencerBody = z.object({
	influencerAccountId: z
		.int()
		.describe('The account id of the influencer to support. Must be flagged `isInfluencer`'),
})

/** `POST /api/influencerpartnerprogram/remove` — the influencer the caller stops supporting. */
export const RemoveInfluencerBody = z.object({
	influencerAccountId: z
		.int()
		.describe('The account id of the influencer to stop supporting — the caller’s current pick'),
})

/**
 * The reply to `POST /api/influencerpartnerprogram/support` and `…/remove` — a bare
 * `{ Success, Error, error_id }` status envelope with NO `Value`: the pick is read back from
 * `…/myinfluencer`, not from this reply. The same mixed casing as `RoomCurrencyEnvelope`
 * (PascalCase `Success`/`Error` beside a lowercase `error_id`), minus the payload.
 */
export const SupportInfluencerResponse = z.object({
	Success: z.boolean().describe('Always true — every refusal is an empty 400 instead'),
	Error: z.null().describe('Always null'),
	error_id: z.null().describe('Always null. Present as a key, and lowercase'),
})

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
 * `GET /api/storefronts/v1/buyRoomKey` — the client's `RoomKeyPurchaseResponseDTO`, recovered
 * from its decoder: the room-key envelope `/api/roomkeys/v1/create` answers in, beside a
 * BalanceUpdateResponse whose bucket key is `Platform` (NOT the `BalanceType` the invention
 * buys echo) and whose entry `Data` is the key again.
 *
 * Every enum here reads an OMITTED key as its 0 member — `Status` 0 is success,
 * `UpdateResponse` 0 is OK, `Platform` 0 is SteamPurchased — so all three are always sent.
 */
export const BuyRoomKeyResponse = z.object({
	RoomKeyResponse: z.object({
		Status: z.int().describe('0 on success; 1 on a refusal'),
		RoomKey: JsonObject.nullable().describe(
			'The bought key (the 10-key room key); null on a refusal'
		),
	}),
	BalanceUpdateResponse: z.object({
		BalanceUpdates: z.array(
			z.object({
				UpdateResponse: z
					.int()
					.describe(
						'0 OK, 2 NotEnoughCredit, 3 AlreadyOwned, 4 NoItemAvailable, ' +
							'6 RequestedPriceDoesNotMatch'
					),
				Data: JsonObject.nullable().describe('The key the request named; null when it named none'),
			})
		),
		Balance: z.int().describe('The buyer’s RESULTING token total, not the change'),
		CurrencyType: z.int().describe('2 = RecCenterTokens'),
		Platform: z.int().describe('-2 — the one account-wide bucket every balance surface names'),
	}),
})

/** `POST /api/storefronts/v1/PurchaseRoomKeyWithCurrency` — form-encoded. */
export const PurchaseRoomKeyWithCurrencyRequest = z.object({
	RoomKeyId: z.string().describe('The key to buy — a `room_key` id'),
	RequestedPrice: z.string().describe('The price the client rendered; must equal the key’s'),
	RequestedPurchaseCurrencyId: z
		.string()
		.describe('The room currency to pay in; must be the key’s own `PurchaseCurrencyId`'),
})

/**
 * `POST /api/storefronts/v1/PurchaseRoomKeyWithCurrency` — the client's
 * `RoomKeyPurchaseWithCurrencyResponseDTO`, recovered from its decoder. A BARE object, no
 * envelope, and NOT buyRoomKey's shape: the outer `Balance` is an OBJECT (the 4-key
 * room-currency balance) holding a numeric `Balance`, and there is no `Platform` anywhere.
 */
export const PurchaseRoomKeyWithCurrencyResponse = z.object({
	Balance: z.object({
		AccountId: z.int().describe('The buyer'),
		CurrencyId: z.string().describe('The room currency paid in'),
		Balance: z.int().describe('What the buyer holds of it afterwards — the RESULTING total'),
		ModifiedAt: z.string().describe('ISO-8601 UTC'),
	}),
	RoomKeyResponse: z.object({
		Status: z.int().describe('0 on success; 1 on a refusal. Always sent — omitted reads as 0'),
		RoomKey: JsonObject.nullable().describe('The bought key; null on a refusal'),
	}),
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
 * `GET /api/ugcPurchasables/v1/items/room/{roomId}` — one line of a room's shop. The same
 * 10 keys as the bulk lookup's item, with `ItemType` naming the kind (0 room key, 1 room
 * consumable, 3 currency purchase offer) and `ImageName` nullable, as a key or consumable
 * without art is served everywhere else.
 */
export const RoomPurchasableDto = UgcPurchasableItemDto.extend({
	ItemType: z
		.number()
		.int()
		.describe('0 RoomKey, 1 RoomConsumable, 3 RoomCurrencyItem (a currency pack for tokens)'),
	ItemId: z
		.string()
		.describe('A bare GUID — the key’s ReplicationId, the consumable’s or offer’s id'),
	ImageName: z.string().nullable().describe('Null for a listing with no art'),
	PurchaseCurrencyId: z
		.string()
		.nullable()
		.describe('The room currency the line is charged in; null for tokens'),
})

/** The room’s shop — a bare array, empty for a room that sells nothing. */
export const RoomPurchasableList = z.array(RoomPurchasableDto)

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

/** `POST /api/storefronts/v1/purchasableitems` — store listings by id. */
export const PurchasableItemsRequest = z.object({
	PurchasableItemIds: z
		.array(z.number().int())
		.nullable()
		.describe('The listings to resolve, by `PurchasableItemId`'),
	GiftDropIds: z
		.array(z.number().int())
		.nullable()
		.describe('Sent by the client (observed null); accepted and ignored'),
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
		.describe('A `room_currency` id, or null for tokens — which a new key is priced in'),
	CreatedAt: z.string().describe('ISO-8601 UTC'),
	ImageName: z.string().nullable().describe('The key’s art; null until an edit sets one'),
	Type: z.int().describe('The key type’s ordinal: 0 `Key`, the only one seen'),
})

/** A held key as `GET /api/roomkeys/v1/mine` serves it — the room key plus two fields. */
export const HeldRoomKeyDto = RoomKeyDto.extend({
	ImageName: z.string().describe('The key’s art; "" when it has none (NOT null, unlike the list)'),
	IsGiftable: z.boolean().describe('Always false — gifting keys is not modelled'),
	Visibility: z.int().describe('Always 0 — not modelled'),
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
	Price: z
		.string()
		.optional()
		.describe('What the key costs, in tokens; defaults to 0. At most 1000'),
})

/**
 * `PUT /api/roomkeys/v1/updateAll` — form-encoded. "All" is the FIELDS, not the keys: the body
 * names one key and carries every editable field of it
 * (`RoomKeyId=43&Name=key1&Description=…&Price=1000&PurchaseCurrencyId=`). For the two
 * fields that can be emptied — `PurchaseCurrencyId` and `ImageName` — a BLANK value is an
 * instruction to clear it; only a field absent from the body is left alone.
 */
export const UpdateRoomKeyRequest = z.object({
	RoomKeyId: z.string().describe('The key to edit'),
	Name: z.string().optional().describe('Left alone when absent; profanity-masked'),
	Description: z.string().optional().describe('Left alone when absent; profanity-masked'),
	Price: z
		.string()
		.optional()
		.describe('Left alone when absent. At most 1000 in tokens, 1000000000 in a room currency'),
	PurchaseCurrencyId: z
		.string()
		.optional()
		.describe(
			'EMPTY means tokens; otherwise a `room_currency` id of the key’s own room. Left alone when absent'
		),
	ImageName: z
		.string()
		.optional()
		.describe('The key’s art. EMPTY clears it (served as null). Left alone when absent'),
})

/**
 * `POST /api/roomkeys/v1/awardbulk` — a BARE JSON ARRAY of the keys to award, as the client
 * posts it. `AccountId` is accepted and IGNORED: the token says who is awarded.
 */
export const AwardRoomKeysRequest = z.array(
	z.object({
		RoomKeyId: z.int().describe('The key to award — a `room_key` id'),
		AccountId: z
			.int()
			.optional()
			.describe('Accepted and IGNORED — the caller is who is awarded the key'),
	})
)

/**
 * `POST /api/roomkeys/v1/awardbulk` answers an ARRAY OF ENVELOPES — every element its own
 * `{ Value, Success, Error, error_id }` around one award (recovered from the client's
 * decoder). Not a bare array of awards, and not one envelope wrapping a list. Only the
 * success form has been observed; a failed entry's null `Value` is an assumption.
 */
export const AwardRoomKeyResultList = z.array(
	z.object({
		Value: z
			.object({
				RoomKeyId: z.int(),
				AccountId: z.int().describe('Who now holds the key — the caller'),
			})
			.nullable()
			.describe('The award, or null on a failure'),
		Success: z.boolean(),
		Error: z.string().nullable().describe('Null on success; the failure message otherwise'),
		error_id: z.null().describe('Always null. Present as a key, and lowercase'),
	})
)

/**
 * `POST /api/roomkeys/v1/owns/bulk` — a BARE JSON ARRAY of (player, key) pairs to check.
 * Unlike the award's, this `AccountId` is READ: it names whose keys are being asked about.
 */
export const OwnsRoomKeysRequest = z.array(
	z.object({
		AccountId: z.int().describe('The player being asked about'),
		RoomKeyId: z.int().describe('The key — a `room_key` id'),
	})
)

/** `POST /api/roomkeys/v1/owns/bulk` — a bare array, one answer per pair in the order asked. */
export const OwnsRoomKeysResponse = z.array(
	z.object({
		AccountId: z.int(),
		RoomKeyId: z.int(),
		DoesPlayerOwnRoomKey: z.boolean(),
	})
)

/**
 * One wishlist entry — the client's five-key DTO, in its order. An element of the GET's bare
 * array and the `Value` of the add/remove envelope.
 *
 * `PurchasableItemId` is a plain int on the client, so an entry for a custom avatar item
 * carries 0 there and the item's GUID in `CustomAvatarItemId`; a storefront-item entry has
 * the id and a null GUID. Exactly one of the two names the item.
 */
export const WishlistItemDto = z.object({
	WishlistItemId: z.string().describe('GUID — the client’s `Guid`, so never an int'),
	AccountId: z.int().describe('Whose list the entry is on'),
	PurchasableItemId: z
		.int()
		.describe('The storefront item wished for, or 0 when the entry names a custom avatar item'),
	CustomAvatarItemId: z
		.string()
		.nullable()
		.describe('The custom avatar item wished for, or null when the entry names a storefront item'),
	CreatedAt: z.string().describe('ISO-8601 UTC'),
})

/** `GET /api/itemWishlists/v1/wishlist/me|{accountId}` — a bare array, newest wish first. */
export const WishlistItemList = z.array(WishlistItemDto)

/**
 * The envelope `wishlist/add` and `wishlist/remove` answer in — the same `{ Value, Success,
 * Error, error_id }` the room-currency writes use. The client reads `add`’s `Value` and
 * discards `remove`’s, but parses both as this shape: a bare entry or a 204 fails the same
 * way `Success: false` does. `Error` is shown to the player verbatim behind “Wishlist error: ”.
 */
export const WishlistEnvelope = z.object({
	Value: WishlistItemDto.nullable().describe(
		'The entry added or removed; null on a refusal, or on removing an item that wasn’t listed'
	),
	Success: z.boolean(),
	Error: z.string().nullable().describe('Null on success; the failure message otherwise'),
	error_id: z.null().describe('Always null. Present as a key, and lowercase'),
})

/**
 * `wishlist/add` and `wishlist/remove` — form-encoded. The client posts BOTH fields every
 * time with the unused one empty (`purchasableItemId=1534&customAvatarItemId=`); either may
 * also be omitted. Exactly one has to name an item.
 */
export const WishlistItemRequest = z.object({
	purchasableItemId: z
		.string()
		.optional()
		.describe('The storefront item, as a positive integer; empty or absent for a custom item'),
	customAvatarItemId: z
		.string()
		.optional()
		.describe('The custom avatar item’s GUID; empty or absent for a storefront item'),
})

/**
 * `POST /api/itemWishlists/v1/isonwishlist/bulk` — form-encoded. `accountIds` is REPEATED,
 * once per account (`accountIds=205&accountIds=207`); a comma-separated single value is
 * accepted too. The item is named as on add/remove.
 */
export const IsOnWishlistBulkRequest = WishlistItemRequest.extend({
	accountIds: z
		.array(z.string())
		.describe('The players to ask about, repeated once per id — answered in this order'),
})

/**
 * `isonwishlist/bulk`’s answer: a bare POSITIONAL array of booleans, one per `accountIds`
 * entry in the order posted. A short array leaves the tail reading as “not wished for”, so
 * every id gets an element — an unknown player’s is false.
 */
export const IsOnWishlistBulkResponse = z.array(z.boolean())

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
 * The client's `RoomConsumableInventoryItem` — what a player owns of one consumable. The
 * element of `GET …/roomConsumable/room/{roomId}/me` and the purchase's `InventoryItem`.
 */
export const RoomConsumableInventoryItemDto = z.object({
	RoomConsumableId: z.string(),
	AccountId: z.int().describe('Who owns them'),
	Count: z.int().describe('The RESULTING total owned, never the change'),
	ConcurrencyCode: z
		.string()
		.nullable()
		.describe('The last `NewConcurrencyCode` written — stored, not checked'),
	ModifiedAt: z.string().describe('ISO-8601 UTC — the last write'),
	Consumable: RoomConsumableDto.extend({
		ImageName: z.string().describe('"" when the listing has no picture (NOT null)'),
		IsGiftable: z.boolean().describe('Always false — not modelled'),
		Visibility: z.int().describe('Always 0 — not modelled'),
	}).describe('The listing — the catalogue element plus two fields'),
})

/**
 * `PUT /api/roomconsumables/v1/roomconsumable/{id}/purchase/{tokens|currency}` — the client's
 * `RoomConsumablePurchaseRequest`, four keys in declaration order (from its formatter). One
 * route for both kinds of price: `ExpectedPriceAndCurrency.CurrencyId` null is TOKENS.
 */
export const PurchaseRoomConsumableRequest = z.object({
	ConcurrencyCodes: z
		.object({
			CurrentConcurrencyCode: z.string().nullable().optional(),
			NewConcurrencyCode: z.string().nullable().optional(),
		})
		.optional()
		.describe('Accepted and IGNORED — no optimistic concurrency is implemented yet'),
	ExpectedPriceAndCurrency: z
		.object({
			Price: z.int().describe('The UNIT price the client rendered; must equal the listing’s'),
			CurrencyId: z
				.string()
				.nullable()
				.describe('The listing’s room currency, or null for a listing priced in tokens'),
		})
		.describe('What the client showed — refused unless it is the listing’s own'),
	Quantity: z.int().describe('How many to buy; at least 1, at most `MaximumCountPerPurchase`'),
	GiftRecipientAccountId: z
		.int()
		.nullable()
		.optional()
		.describe('Who receives them; null for the buyer. The buyer pays either way'),
})

/**
 * The consumable purchase's answer, observed from the live client. The refusal form (`Status`
 * 1, a null `InventoryItem`) is an assumption — only success has been observed.
 */
export const PurchaseRoomConsumableResponse = z.object({
	BalanceUpdateResult: z
		.int()
		.describe(
			'An UpdateResponse: 0 OK, 2 NotEnoughCredit, 4 NoItemAvailable, ' +
				'6 RequestedPriceDoesNotMatch, 7 RequestedAmountNotAllowed, 8 PlayerNotEligible'
		),
	CurrencyBalanceResponse: z
		.object({
			AccountId: z.int().describe('The BUYER — who paid, even for a gift'),
			CurrencyId: z
				.string()
				.nullable()
				.describe('The room currency paid in; null for a listing priced in tokens'),
			Balance: z.int().describe('What the buyer holds of it afterwards — the RESULTING total'),
			ModifiedAt: z.string().describe('ISO-8601 UTC'),
		})
		.describe('What the buyer now holds of what they paid in'),
	OperationResult: z.object({
		Status: z.int().describe('0 on success; 1 on a refusal. Always sent — omitted reads as 0'),
		InventoryItem: RoomConsumableInventoryItemDto.nullable().describe(
			'What the recipient now owns of the consumable; null on a refusal'
		),
	}),
})

/**
 * `PUT /api/roomconsumables/v1/roomConsumable/{id}/consume` — just the concurrency pair, at the
 * TOP level (not nested under `ConcurrencyCodes` as the purchase sends it). Uses up one.
 */
export const ConsumeRoomConsumableRequest = z.object({
	CurrentConcurrencyCode: z.string().nullable().optional().describe('Accepted and NOT checked'),
	NewConcurrencyCode: z
		.string()
		.nullable()
		.optional()
		.describe('Stored and echoed back as the item’s `ConcurrencyCode`'),
})

/** The consume's answer: the purchase's `OperationResult`, alone. */
export const ConsumeRoomConsumableResponse = z.object({
	Status: z.int().describe('0 on success; 1 on a refusal. Always sent — omitted reads as 0'),
	InventoryItem: RoomConsumableInventoryItemDto.nullable().describe(
		'What the caller holds afterwards (`Count` the resulting total, 0 included); null on a refusal'
	),
})

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

/** `POST /api/roomcurrencies/v1/deletePurchaseOffer` — form-encoded. */
export const DeletePurchaseOfferRequest = z.object({
	PurchaseOfferId: z
		.string()
		.describe('The offer to take down, by its `CurrencyPurchaseOfferId` (any letter case)'),
})

/**
 * The envelope the create- and delete-offer endpoints answer in — the same
 * `{ Value, Success, Error, error_id }` the currency writes use, with the offer (as created,
 * or as it stood when removed) in `Value`.
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
 * `POST /api/roomCurrencies/v2/purchase` — form-encoded
 * (`PurchaseOfferId=ffab4157-…&RequestedAmount=444&RequestedPrice=555`). The offer alone says
 * which currency is being bought; the two numbers are what the client rendered, and must match
 * the offer.
 */
export const PurchaseRoomCurrencyRequest = z.object({
	PurchaseOfferId: z.string().describe('The offer — a `CurrencyPurchaseOfferId`'),
	RequestedAmount: z.string().describe('How much room currency; must equal the offer’s'),
	RequestedPrice: z
		.string()
		.describe(
			'What it costs in tokens; must equal the offer’s, except for the room’s owner and co-owners, who are shown 0 and pay nothing'
		),
})

/**
 * What a player holds of one room currency, as `GET /api/roomcurrencies/v1/getBalance` answers
 * it. `ModifiedAt` is the time of the response: `room_balance` keeps no modification time.
 */
export const RoomCurrencyBalance = z.object({
	AccountId: z.int().describe('The player the balance belongs to'),
	CurrencyId: z.string().describe('The room currency'),
	Balance: z.int().describe('What the player holds of it; 0 when they have never earned any'),
	ModifiedAt: z.string().describe('ISO-8601 UTC; the time of the response'),
})

/**
 * What `POST /api/roomCurrencies/v2/purchase` answers: both balances the purchase moved,
 * inside the `{ Value, Success, Error, error_id }` envelope the room-currency writes use.
 * Each `Balance` is a RESULTING total. Only the success form has been observed; a refusal's
 * null `Value` is an assumption.
 */
export const PurchaseRoomCurrencyEnvelope = z.object({
	Value: z
		.object({
			CurrencyBalanceResponse: z.object({
				AccountId: z.int().describe('The buyer'),
				CurrencyId: z.string().describe('The room currency bought'),
				Balance: z.int().describe('What the buyer now holds of it'),
				ModifiedAt: z.string().describe('ISO-8601 UTC'),
			}),
			TokenBalanceResponse: z.object({
				Balance: z.int().describe('The buyer’s resulting token total'),
				CurrencyType: z.int().describe('2 = RecCenterTokens'),
				Platform: z.int().describe('-2 — the one account-wide bucket every balance surface names'),
			}),
		})
		.nullable()
		.describe('Null on a refusal'),
	Success: z.boolean(),
	Error: z.string().nullable().describe('Null on success; the refusal otherwise'),
	error_id: z.null().describe('Always null. Present as a key, and lowercase'),
})

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

/**
 * `POST /api/consumables/v1/query/bulk` form body — `descriptors` repeated once per
 * consumable to look up.
 */
export const QueryConsumablesRequest = z.object({
	descriptors: z
		.union([z.string(), z.array(z.string())])
		.optional()
		.describe('A ConsumableItemDesc; the key repeats for each one asked about'),
})

/**
 * `POST /api/consumables/v1/updateActive` JSON body — the client marking one of its
 * consumables active or not. Accepted and NOT acted on yet; see the route.
 */
export const UpdateActiveConsumableRequest = z.object({
	Id: z.int().describe('The consumable row id'),
	IsActive: z.boolean().describe('Whether the consumable is now in use'),
	ActivatedByRoomie: z
		.boolean()
		.optional()
		.describe('Whether a roommate, rather than the owner, activated it'),
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
