import { Hono } from 'hono'
import { describeRoute, openAPIRouteHandler } from 'hono-openapi'
import { useWorkersLogger } from 'workers-tagged-logger'

import {
	addXp,
	consumeGift,
	createGift,
	getGift,
	getOutfits,
	getPendingGifts,
	grantInvention,
	levelReward,
	levelsReached,
	ownsInvention,
	setOutfit,
} from '@repo/domain'
import { intVar, logger, withCleanSpec, withNotFound, withOnError } from '@repo/hono-helpers'
import { validateAndGetAccountId, validateAndGetRoles } from '@repo/jwt'

// Invention storage (owned by the `api` worker, on this same `recflare` database).
// Imported directly rather than copied: these are plain D1 helpers with no bindings of
// their own, and buyInvention has to read the very rows `api` writes.
import { getInventionById, toSaveResult } from '../../api/src/inventions-db'
// The notification-type ids the hub carries, and the payload shapes recovered from the
// client's own decoder (both owned by the `notify` worker). Imported rather than copied so
// the frames this worker builds are typed by the shapes the client actually parses — a
// wrong or renamed key (see the `Platform`/`BalanceType` trap) fails the build here.
import { BalanceAddType } from '../../notify/src/notification-payloads'
import { NotificationType } from '../../notify/src/notification-types'
import adCarouselItems from '../static/ad-carousel-items.json'
import defaultAvatarItems from '../static/default-avatar-items.json'
import defaultAvatar from '../static/default-avatar.json'
import defaultBaseAvatarItems from '../static/default-base-avatar-items.json'
import myProgress from '../static/my-progress.json'
import weeklyChallenge from '../static/weekly-challenge.json'
import { getAvatar, setAvatar } from './avatar-db'
import {
	ALL_PLATFORMS,
	creditCurrency,
	CurrencyType,
	DEFAULT_STARTING_TOKENS,
	ensureStartingBalances,
	getBalance,
	isSpendable,
	spendCurrency,
} from './balance-db'
import {
	claimChallengeGift,
	getCompletedChallengeIds,
	recordChallengeProgress,
} from './challenge-db'
import {
	consumeConsumable,
	countConsumable,
	getConsumables,
	grantConsumable,
} from './consumables-db'
import { getEquipment, grantEquipment, setEquipmentFavorited } from './equipment-db'
import { getInventory, grantItem, toAvatarItemV4 } from './inventory-db'
import {
	AUTHED,
	AvatarItemV4Dto,
	AvatarV2Dto,
	BalanceEntry,
	BulkPurchaseRequest,
	BulkPurchaseResponse,
	BuyInventionResponse,
	BuyItemRequest,
	BuyItemResponse,
	ChallengeProgressRequest,
	ChallengeProgressResponse,
	ChecklistCompleteResponse,
	ChecklistEntry,
	CompleteChecklistRequest,
	ConsumeConsumableRequest,
	ConsumeEnvelope,
	ConsumeGiftRequest,
	CustomAvatarItemsResponse,
	EquipmentUpdateRequest,
	ErrorResponse,
	form,
	GameRewardRequest,
	InfluencerIdsResponse,
	json,
	JsonArray,
	jsonBody,
	JsonObject,
	MakerAiFreeTrialEligibilityResponse,
	OpaqueJsonBody,
	OPTIONAL_AUTHED,
	ReferralProgressResponse,
	RoomEconConfig,
	RRPlusSignUpBonus,
	SaveOutfitRequest,
	SaveOutfitV4Response,
	SubscriptionResponse,
	UNAUTHORIZED_RESPONSE,
	UpdateObjectiveRequest,
	UpdateObjectiveResponse,
} from './openapi'
import { claimReward } from './reward-db'

import type { Context } from 'hono'
import type { GiftContent, Outfit, Progression, StoredGift, XpGrant } from '@repo/domain'
import type {
	BalanceResponsePayload,
	PurchaseBalanceModificationPayload,
} from '../../notify/src/notification-payloads'
import type { Avatar } from './avatar-db'
import type { ConsumeResult } from './consumables-db'
import type { App } from './context'
import type { Equipment } from './equipment-db'
import type { AvatarItem } from './inventory-db'

/**
 * Economy Worker. Hosts the avatar/economy endpoints the game client calls on
 * the `econ` service (these are separate from the main `api` worker). Balances,
 * inventory (avatar items, equipment, bought inventions), consumables, saved outfits,
 * avatars, gift boxes, weekly-challenge progress and game-reward eligibility are D1-backed;
 * storefront catalogs are static assets (`sf{N}.json`) served via the ASSETS
 * binding. Some routes are still empty-list stubs (room keys, wishlist, …).
 *
 * Auth-gated routes validate the Bearer JWT issued by the `auth` worker.
 */

/**
 * Resolve the account id from a Bearer token. Returns `null` when the header is
 * missing, the token is invalid, or the `sub` claim isn't an integer.
 */
async function authedId(c: Context<App>): Promise<number | null> {
	return validateAndGetAccountId(c.req.raw, await c.env.JWT_SECRET.get())
}

/**
 * The `role` claim from a Bearer token — the operator-granted roles the auth worker stamps
 * from the account's flags, so a plain player's token is just `['gameClient']`. `null` when
 * the request carries no valid token; an empty array means a valid token with no roles.
 * Shaped to mirror {@link authedId}.
 */
async function authedRoles(c: Context<App>): Promise<string[] | null> {
	return validateAndGetRoles(c.req.raw, await c.env.JWT_SECRET.get())
}

/** Results.Unauthorized() equivalent — 401 with empty body. */
function unauthorized(c: Context<App>) {
	return c.body(null, 401)
}

/**
 * A boolean the client may send either as a JSON `true` or as .NET's `bool.ToString()`
 * output — `"True"`/`"False"`, capitalized. `Boolean(value)` is a trap here: the string
 * `"False"` is truthy, so a client reporting "not complete" would read as complete.
 * Anything unrecognised (missing, `null`, `""`) is false.
 */
function parseBool(value: string | boolean | undefined): boolean {
	return typeof value === 'boolean' ? value : String(value).toLowerCase() === 'true'
}

/**
 * Shared parse/validate/store for the save-outfit routes (v3 and v4). Persists the
 * posted outfit into its `Slot` verbatim and returns the stored `Outfit`; on the
 * unauth or bad-body path it returns the Response to send directly (401, or 400 for a
 * non-object body or missing/non-integer `Slot`). Callers format the success body — v3
 * echoes the whole outfit, v4 answers a lean `{ Success, Slot }` ack.
 */
async function persistPostedOutfit(c: Context<App>): Promise<Outfit | Response> {
	const id = await authedId(c)
	if (id === null) return unauthorized(c)
	const body = (await c.req.json().catch(() => null)) as Record<string, unknown> | null
	if (body === null || typeof body !== 'object' || Array.isArray(body)) {
		return c.body(null, 400)
	}
	if (!Number.isInteger(body.Slot)) return c.body(null, 400)
	const outfit = body as Outfit
	await setOutfit(c.env.DB, id, outfit)
	return outfit
}

/** The notifications hub is a single global DO instance (see the `notify` worker). */
const HUB_INSTANCE = 'global'

/**
 * Push a ConsumableMappingRemoved notification to a player after they consume a
 * consumable, mirroring the reference's
 * `HubSendToPlayer(accountID, NotifFrame(ConsumableMappingRemoved, {...}))` — the
 * client uses it to update/remove the item from inventory. Best-effort: a hub failure
 * is logged and swallowed, since the consume has already committed.
 */
async function pushConsumableRemoved(
	c: Context<App>,
	accountId: number,
	consumed: ConsumeResult
): Promise<void> {
	try {
		await c.env.RECFLARE_NOTIFICATIONS_HUB.getByName(HUB_INSTANCE).notifyPlayer(
			accountId,
			NotificationType.ConsumableMappingRemoved,
			{
				Id: consumed.id,
				ConsumableItemDesc: consumed.consumableItemDesc,
				CreatedAt: consumed.createdAt,
				Count: consumed.remaining,
				InitialCount: consumed.previousCount,
				IsActive: false,
				ActiveDurationMinutes: 0,
				IsTransferable: false,
			}
		)
	} catch (err) {
		logger.error('failed to push ConsumableMappingRemoved notification', {
			accountId,
			error: err instanceof Error ? err.message : String(err),
		})
	}
}

/**
 * Push a ConsumableMappingAdded notification to a player after they open a gift box
 * that carried a consumable, mirroring the reference's
 * `HubSendToPlayer(accountID, NotifFrame(ConsumableMappingAdded, {...}))` — the client
 * uses it to show the newly-unlocked consumable. The mapping id and pre-existing count
 * were stamped onto the box at purchase (see toGiftContent). Best-effort like the
 * removed push.
 */
async function pushConsumableAdded(
	c: Context<App>,
	accountId: number,
	gift: StoredGift
): Promise<void> {
	try {
		await c.env.RECFLARE_NOTIFICATIONS_HUB.getByName(HUB_INSTANCE).notifyPlayer(
			accountId,
			NotificationType.ConsumableMappingAdded,
			{
				Id: gift.ConsumableMappingId ?? 0,
				ConsumableItemDesc: gift.ConsumableItemDesc,
				CreatedAt: new Date().toISOString(),
				Count: gift.ConsumableCount,
				InitialCount: gift.ConsumablePreExistingCount ?? 0,
				IsActive: false,
				ActiveDurationMinutes: 0,
				IsTransferable: false,
			}
		)
	} catch (err) {
		logger.error('failed to push ConsumableMappingAdded notification', {
			accountId,
			error: err instanceof Error ? err.message : String(err),
		})
	}
}

/**
 * THE BALANCE-FRAME RULE, which both balance bugs came from getting wrong.
 *
 * The client holds a balance PER `(CurrencyType, Platform)` bucket and shows the SUM of the
 * buckets. Every `StorefrontBalance*` frame is an absolute SET of the one bucket it names —
 * not a change to apply — so:
 *
 *  1. `Balance` is the RESULTING TOTAL. Sending the change sets the bucket TO that change.
 *  2. The bucket key on the wire is `Platform`. The client's property is called
 *     `BalanceType` but carries a `[DataMember]` rename, and its decoder drops unknown
 *     members in silence — so a frame that says `BalanceType` lands in `Platform` 0,
 *     `SteamPurchased`, and creates a SECOND bucket that is added to the real one forever.
 *  3. That bucket must be the same one `GET /api/storefronts/v4/balance/:type` reports,
 *     `ALL_PLATFORMS`. One account-wide bucket per currency is the whole model here; a
 *     frame naming any other Platform is a phantom balance, not a per-store nicety.
 *
 * Both live bugs were rule 2 or 3, and both looked like the frame being "additive":
 *  - A player who earned 250 on 10,000 read 20,250 — `BalanceType: -2` was dropped, so the
 *    total landed in a phantom Steam bucket beside the real one.
 *  - A player who spent 900 of 17,500 read 34,100, then 33,200 once the purchase response's
 *    -900 reached the real bucket — same phantom bucket, this time from `Platform: RecNet`.
 * Neither was additivity: the totals were right, the bucket was wrong. Frames as specified
 * here are idempotent, so re-sending one or racing a `GET /balance` cannot drift the total.
 *
 * See apps/notify/src/notification-payloads.ts for the payload shapes this is recovered
 * from — the interfaces there type these calls, so a wrong key is now a build error.
 */

/**
 * Push a StorefrontBalanceUpdate (61) — "your balance in this bucket is now X" — after a
 * player's balance changes for a reason that is not their own purchase. `balance` is their
 * resulting TOTAL in that currency, per the rule above.
 *
 * A player who is reading the HTTP response for the same change gets this too: it sets the
 * bucket to the same total the body reports, so the two agree rather than compound. Pushing
 * it is what saves them a `GET /balance` re-fetch.
 *
 * Best-effort: a hub failure is logged and swallowed, since the change has already committed.
 */
async function pushBalanceUpdate(
	c: Context<App>,
	accountId: number,
	currencyType: number,
	balance: number
): Promise<void> {
	// `satisfies` rather than a type annotation: the hub takes a Record<string, unknown>, and
	// an interface (unlike an inferred object type) has no implicit index signature to match
	// it. This still checks every key against the shape the client's decoder parses.
	const payload = {
		Balance: balance,
		CurrencyType: currencyType,
		Platform: ALL_PLATFORMS,
	} satisfies BalanceResponsePayload
	try {
		await c.env.RECFLARE_NOTIFICATIONS_HUB.getByName(HUB_INSTANCE).notifyPlayer(
			accountId,
			NotificationType.StorefrontBalanceUpdate,
			payload
		)
	} catch (err) {
		logger.error('failed to push StorefrontBalanceUpdate notification', {
			accountId,
			error: err instanceof Error ? err.message : String(err),
		})
	}
}

/**
 * Push a StorefrontBalancePurchase (62) — the frame the reference sends when the balance
 * moved because the player BOUGHT something, as opposed to the plain update above. Same
 * absolute-set semantics: `balance` is the resulting total.
 *
 * `Delta` (the negated price) and `BalanceAddType` are display/telemetry only — the client
 * logs them and then stores `Balance` outright, so a correct `Delta` beside a stale
 * `Balance` still leaves the player's balance wrong. `Platform` is `ALL_PLATFORMS`, NOT
 * `RecNetPurchased`: it has to name the bucket `GET /balance` reports, and sending RecNet
 * here is exactly what doubled a buyer's tokens on screen. Best-effort, as above.
 */
async function pushBalancePurchase(
	c: Context<App>,
	accountId: number,
	currencyType: number,
	delta: number,
	balance: number
): Promise<void> {
	const payload = {
		BalanceAddType: BalanceAddType.CommercePurchase,
		Delta: delta,
		Balance: balance,
		Platform: ALL_PLATFORMS,
		CurrencyType: currencyType,
	} satisfies PurchaseBalanceModificationPayload
	try {
		await c.env.RECFLARE_NOTIFICATIONS_HUB.getByName(HUB_INSTANCE).notifyPlayer(
			accountId,
			NotificationType.StorefrontBalancePurchase,
			payload
		)
	} catch (err) {
		logger.error('failed to push StorefrontBalancePurchase notification', {
			accountId,
			error: err instanceof Error ? err.message : String(err),
		})
	}
}

/** The operator-granted role that comes with a complimentary subscription. */
const DEVELOPER_ROLE = 'developer'

/** `SubscriptionLevel.Gold`. 1 is Platinum. */
const SUBSCRIPTION_LEVEL_GOLD = 0

/** `SubscriptionPeriod.Year`. 0 is Month, 2 ThreeMonth, 3 SixMonth. */
const SUBSCRIPTION_PERIOD_YEAR = 1

/**
 * `PlatformType.All` (-1) — the subscription belongs to no single store, which is the honest
 * answer when no store sold it. The rest of the enum: 0 Steam, 1 Oculus, 2 PlayStation,
 * 3 Xbox, 4 RecNet, 5 IOS, 6 GooglePlay, 7 Standalone, 8 Pico.
 */
const SUBSCRIPTION_PLATFORM_ALL = -1

/** The id every reported subscription carries — a placeholder, since none is stored. */
const STUB_SUBSCRIPTION_ID = 1

/**
 * The complimentary subscription a `developer` account reports — Rec Room Plus, which the
 * client's API calls a `CampusCard`.
 *
 * Nothing here sells subscriptions, so holding the role IS the subscription: it's how the
 * paid-tier surfaces get exercised without a store. Every field is computed per call and
 * none of it is persisted, so this is not a record of anything — revoking the role revokes
 * the subscription, and no expiry sweep or renewal exists.
 *
 * `ExpirationDate` is a year out from THIS call rather than a fixed date: a hard-coded one
 * lapses on a day nobody is expecting, and the client would start showing an expired
 * subscription with no way to renew it. `IsAutoRenewing` tells the client the same thing.
 * The dates are milliseconds-precision ISO like the rest of this worker's timestamps.
 */
function developerSubscription(accountId: number) {
	const now = new Date()
	// Calendar arithmetic, not now + 365 days: setUTCFullYear lands on the same date next
	// year whether or not a leap day falls in between.
	const expires = new Date(now)
	expires.setUTCFullYear(expires.getUTCFullYear() + 1)
	return {
		SubscriptionId: STUB_SUBSCRIPTION_ID,
		RecNetPlayerId: accountId,
		PlatformType: SUBSCRIPTION_PLATFORM_ALL,
		PlatformId: '',
		PlatformPurchaseId: '',
		Level: SUBSCRIPTION_LEVEL_GOLD,
		Period: SUBSCRIPTION_PERIOD_YEAR,
		ExpirationDate: expires.toISOString(),
		IsAutoRenewing: true,
		CreatedAt: now.toISOString(),
		ModifiedAt: now.toISOString(),
	}
}

/**
 * Project a stored avatar into the public render subset returned by
 * `GET /api/avatar/v2/:id` — the fields needed to draw another player's avatar
 * (the full blob also holds `OutfitSelectionsV2`/`CustomAvatarItems`, which this
 * view omits).
 */
function toAvatarV2Dto(avatar: Avatar) {
	return {
		OutfitSelections: avatar.OutfitSelections,
		FaceFeatures: avatar.FaceFeatures,
		SkinColor: avatar.SkinColor,
		HairColor: avatar.HairColor,
	}
}

/**
 * The subset of a storefront catalog (`static/storefronts/sf{N}.json`) that `buyItem`
 * reads: each store item carries the `GiftDrop` describing what you get and a list of
 * `Prices` per currency. The catalogs hold more fields (SubscriberPrices, IsFeatured,
 * …) that the purchase path doesn't need.
 */
interface StoreGiftDrop {
	FriendlyName: string
	Tooltip: string
	ConsumableItemDesc: string
	AvatarItemDesc: string
	AvatarItemType: number | null
	EquipmentPrefabName: string
	EquipmentModificationGuid: string
	Rarity: number
	Context: number
	Currency: number
	CurrencyType: number
	/**
	 * A QUERY drop — a loot box rather than an item. Its item fields are all empty on
	 * purpose: what the player gets is rolled at grant time from everything of the target
	 * rarity they don't already own (see {@link rollQueryDrop}). sf2's "Star Boxes" set and
	 * sf3's "Random box" family are the two that ship; sf2's tooltip says it outright — "A
	 * random 4-star item that you don't have."
	 */
	IsQuery?: boolean
	/**
	 * The rarity a query drop rolls at, when it differs from the box's own `Rarity`. The
	 * sf2 boxes carry both and they agree; sf3's don't carry it at all, hence the fallback
	 * to `Rarity`.
	 */
	QueryRedirectRarity?: number
	/**
	 * XP the drop pays out. No storefront catalog sets it — a bought item is an item — but a
	 * game reward is XP in a gift box, so the box and its notification carry the amount from
	 * here. The XP itself is banked in `progression`, not read back off the box.
	 */
	Xp?: number
}
interface StorePrice {
	CurrencyType: number
	Price: number
}
interface StoreItem {
	GiftDrop: StoreGiftDrop
	Prices: StorePrice[]
	PurchasableItemId: number
}
interface Storefront {
	StoreItems: StoreItem[]
}

/** The `Gift` block of a buyItem body — present when buying an item for another player. */
interface GiftRequest {
	ToPlayerId?: number
	Anonymous?: boolean
	Message?: string
	GiftContext?: number
}

/**
 * Read a storefront catalog (`sf{type}.json`) from the ASSETS binding. Null when there is
 * no such storefront.
 *
 * Separate from {@link findStoreItem} so a caller resolving SEVERAL items from one
 * storefront reads (and parses) it once: sf3 alone is over a thousand items, and a bulk
 * purchase carries up to `BULK_PURCHASE_CAP` lines.
 */
async function loadStorefront(c: Context<App>, storefrontType: number): Promise<Storefront | null> {
	const res = await c.env.ASSETS.fetch(new URL(`/sf${storefrontType}.json`, c.req.url))
	if (!res.ok) return null
	return (await res.json()) as Storefront
}

/**
 * Look up a store item by (storefront type, purchasable item id), reading the catalog
 * from the ASSETS binding (`sf{type}.json`). Returns null when there is no such
 * storefront or no item with that id in it.
 */
async function findStoreItem(
	c: Context<App>,
	storefrontType: number,
	purchasableItemId: number
): Promise<StoreItem | null> {
	const storefront = await loadStorefront(c, storefrontType)
	if (storefront === null) return null
	return storefront.StoreItems.find((it) => it.PurchasableItemId === purchasableItemId) ?? null
}

/** Build the owned avatar-item DTO granted into the buyer's inventory from a gift-drop. */
function toAvatarItem(giftDrop: StoreGiftDrop): AvatarItem {
	return {
		AvatarItemType: giftDrop.AvatarItemType,
		AvatarItemDesc: giftDrop.AvatarItemDesc,
		PlatformMask: -1,
		FriendlyName: giftDrop.FriendlyName,
		Tooltip: giftDrop.Tooltip,
		Rarity: giftDrop.Rarity,
	}
}

/** Build the owned equipment DTO granted into the buyer's inventory from a gift-drop. */
function toEquipment(giftDrop: StoreGiftDrop): Equipment {
	return {
		ModificationGuid: giftDrop.EquipmentModificationGuid,
		PrefabName: giftDrop.EquipmentPrefabName,
		FriendlyName: giftDrop.FriendlyName,
		Tooltip: giftDrop.Tooltip,
		Rarity: giftDrop.Rarity,
		PlatformMask: -1,
		Favorited: false,
	}
}

/** Quantity of a consumable granted per purchase — our storefront catalogs don't specify one. */
const CONSUMABLE_GRANT_COUNT = 1

/** The "Coach" system account — the sender a self-buy or anonymous gift is attributed to. */
const COACH_ACCOUNT_ID = 1

/** Build the stored gift-box content (the client's rendered "gift box") from a gift-drop. */
function toGiftContent(
	giftDrop: StoreGiftDrop,
	message: string,
	consumableCount: number,
	consumableMappingId = 0,
	consumablePreExistingCount = 0
): GiftContent {
	return {
		ConsumableItemDesc: giftDrop.ConsumableItemDesc,
		ConsumableCount: consumableCount,
		ConsumableMappingId: consumableMappingId,
		ConsumablePreExistingCount: consumablePreExistingCount,
		AvatarItemDesc: giftDrop.AvatarItemDesc,
		AvatarItemType: giftDrop.AvatarItemType,
		CurrencyType: giftDrop.CurrencyType,
		Currency: giftDrop.Currency,
		Xp: giftDrop.Xp ?? 0,
		PackageType: 0,
		Message: message,
		EquipmentPrefabName: giftDrop.EquipmentPrefabName,
		EquipmentModificationGuid: giftDrop.EquipmentModificationGuid,
		GiftRarity: giftDrop.Rarity,
		Platform: -1,
		PlatformsToSpawnOn: -1,
		BalanceType: null,
	}
}

/**
 * Push a GiftPackageReceivedImmediate notification for a gift box the player didn't ask
 * for, mirroring the reference's
 * `HubSendToPlayer(accountID, NotifFrame(GiftPackageReceivedImmediate, {...}))` — the
 * client pops the "you got something" panel from it instead of waiting for the next read of
 * `GET /api/avatar/v2/gifts`.
 *
 * The payload is the reference's field-for-field: the stored box's contents plus its `Id`,
 * a `FromGiftDropId` of 0 (the reference never populates it either) and the
 * platform/balance constants. `Xp` is the drop's, so a game reward's box announces the XP it
 * paid; `Level` is 0, since nothing levels a player up yet.
 *
 * "Immediate" (31) rather than GiftPackageReceived (30) is what the reference sends for a
 * box handed over by the server: a purchase gifted to another player, an admin token grant,
 * a report reward. This is the same case — the player is being handed a box they never
 * clicked for. Best-effort: a hub failure is logged and swallowed, since the gift itself is
 * already granted and stored.
 */
async function pushGiftReceived(
	c: Context<App>,
	accountId: number,
	gift: GrantedGift,
	message: string,
	fromPlayerId: number
): Promise<void> {
	try {
		await c.env.RECFLARE_NOTIFICATIONS_HUB.getByName(HUB_INSTANCE).notifyPlayer(
			accountId,
			NotificationType.GiftPackageReceivedImmediate,
			{
				Id: gift.id,
				FromGiftDropId: 0,
				FromPlayerId: fromPlayerId,
				ConsumableItemDesc: gift.drop.ConsumableItemDesc,
				AvatarItemDesc: gift.drop.AvatarItemDesc,
				AvatarItemType: gift.drop.AvatarItemType ?? 0,
				EquipmentPrefabName: gift.drop.EquipmentPrefabName,
				EquipmentModificationGuid: gift.drop.EquipmentModificationGuid,
				CurrencyType: gift.drop.CurrencyType,
				Currency: gift.drop.Currency,
				Xp: gift.drop.Xp ?? 0,
				Level: 0,
				Platform: -1,
				PlatformsToSpawnOn: -1,
				BalanceType: ALL_PLATFORMS,
				GiftContext: gift.drop.Context,
				GiftRarity: gift.drop.Rarity,
				Message: message,
			}
		)
	} catch (err) {
		logger.error('failed to push GiftPackageReceivedImmediate notification', {
			accountId,
			giftId: gift.id,
			error: err instanceof Error ? err.message : String(err),
		})
	}
}

/**
 * Push a PlayerProgressionLevelUpdate so the client's level bar moves when XP lands, instead
 * of waiting for its next progression read. `XP` is the progress into the current level (the
 * ladder spends the rest on the level-ups), which is what the bar draws against the
 * `LevelProgressionMaps` the client is served.
 *
 * Best-effort: the XP is already banked, so a hub failure costs a bar animation, not the
 * reward.
 */
async function pushProgressionUpdate(
	c: Context<App>,
	accountId: number,
	progression: Progression
): Promise<void> {
	try {
		await c.env.RECFLARE_NOTIFICATIONS_HUB.getByName(HUB_INSTANCE).notifyPlayer(
			accountId,
			NotificationType.PlayerProgressionLevelUpdate,
			{ PlayerId: progression.PlayerId, Level: progression.Level, XP: progression.XP }
		)
	} catch (err) {
		logger.error('failed to push PlayerProgressionLevelUpdate notification', {
			accountId,
			error: err instanceof Error ? err.message : String(err),
		})
	}
}

/**
 * The catalog a query drop rolls from: sf3, the general store. It is the only catalog with
 * a real pool at every rarity (1161 items against 8–40 in the themed ones), it's where the
 * "Random box" family itself sells, and a box promising "a random 4-star item" plainly
 * means the whole item universe rather than whichever seasonal shelf it was bought from.
 */
const ROLL_STOREFRONT_TYPE = 3

/** Every item in the roll catalog, or `[]` if it can't be read (a roll then yields nothing). */
async function loadRollCatalog(c: Context<App>): Promise<StoreItem[]> {
	const storefront = await loadStorefront(c, ROLL_STOREFRONT_TYPE)
	return storefront?.StoreItems ?? []
}

/**
 * Whether the player already owns what a drop carries — the question a query drop's "an
 * item that you don't have" turns on, and the one that decides whether the weekly gift
 * hands over its item or rolls the fallback box instead.
 *
 * Ownership is boolean for avatar items and equipment, which is what makes "already have
 * it" meaningful. A drop carrying neither (a consumable, a currency drop, an empty query
 * box) counts as owned: there is nothing ownable to hand over, so callers offering a
 * fallback should take it.
 */
async function ownsGiftDrop(
	db: D1Database,
	accountId: number,
	giftDrop: StoreGiftDrop
): Promise<boolean> {
	if (typeof giftDrop.AvatarItemDesc === 'string' && giftDrop.AvatarItemDesc !== '') {
		const owned = await getInventory(db, accountId)
		return owned.some((item) => item.AvatarItemDesc === giftDrop.AvatarItemDesc)
	}
	if (
		typeof giftDrop.EquipmentModificationGuid === 'string' &&
		giftDrop.EquipmentModificationGuid !== ''
	) {
		const owned = await getEquipment(db, accountId)
		return owned.some((eq) => eq.ModificationGuid === giftDrop.EquipmentModificationGuid)
	}
	return true
}

/** How a query drop is rolled — what it may land on, and whose catalog copy to use. */
interface RollOptions {
	/**
	 * Restrict the roll to avatar items, leaving equipment skins out of the pool. Off by
	 * default: a bought box says "a random item", and the catalog's own boxes mean both.
	 */
	avatarItemsOnly?: boolean
	/**
	 * The roll catalog, when the caller has already read it — it's the big one (sf3), and a
	 * caller granting several boxes at once shouldn't re-read it per box.
	 */
	rollCatalog?: StoreItem[]
}

/**
 * Roll a query drop: pick, uniformly at random, one item of `rarity` from the roll catalog
 * that the player doesn't already own. Returns null when the pool is empty — an unreadable
 * catalog, a rarity nothing is published at, or a player who owns every item of that tier.
 *
 * The pool is deliberately narrow. Other query drops are excluded (a box that rolls a box
 * would either loop or hand over an unopenable one), and so is everything that isn't an
 * avatar item or a piece of equipment: "an item you don't have" only means anything for
 * things owned once, and consumables stack, so a consumable would be rollable forever and
 * would crowd out the real prizes.
 *
 * `avatarItemsOnly` narrows it further to things worn on the avatar, leaving equipment
 * skins out — a level-up prize should be something the player can see on themselves, not a
 * skin for a weapon they may not own. It also skips the equipment read entirely, since
 * nothing in the pool can match it.
 */
async function rollQueryDrop(
	c: Context<App>,
	accountId: number,
	rarity: number,
	options: RollOptions = {}
): Promise<StoreGiftDrop | null> {
	const [catalog, ownedItems, ownedEquipment] = await Promise.all([
		options.rollCatalog ?? loadRollCatalog(c),
		getInventory(c.env.DB, accountId),
		options.avatarItemsOnly === true ? [] : getEquipment(c.env.DB, accountId),
	])
	const haveItem = new Set(ownedItems.map((item) => item.AvatarItemDesc))
	const haveEquipment = new Set(ownedEquipment.map((eq) => eq.ModificationGuid))
	const pool = catalog.filter(({ GiftDrop: drop }) => {
		if (drop.IsQuery === true || drop.Rarity !== rarity) return false
		if (typeof drop.AvatarItemDesc === 'string' && drop.AvatarItemDesc !== '') {
			return !haveItem.has(drop.AvatarItemDesc)
		}
		if (options.avatarItemsOnly === true) return false
		if (
			typeof drop.EquipmentModificationGuid === 'string' &&
			drop.EquipmentModificationGuid !== ''
		) {
			return !haveEquipment.has(drop.EquipmentModificationGuid)
		}
		return false
	})
	const rolled = pool[Math.floor(Math.random() * pool.length)]
	return rolled?.GiftDrop ?? null
}

/**
 * A gift box that was just created, and the drop it ended up holding. The drop is the
 * RESOLVED one — what a query drop rolled, not the box that promised it — so a caller
 * announcing the gift names the item the player actually won.
 *
 * `id` is 0 when no box was created (`skipGiftBox`) — the drop was still granted.
 */
interface GrantedGift {
	id: number
	drop: StoreGiftDrop
}

/** How a drop is handed over: how a query one rolls, plus how it is wrapped. */
interface GrantOptions extends RollOptions {
	/**
	 * How many of the drop to hand over in ONE box — a bulk line's `DuplicateItemCount`.
	 * Only a consumable stacks, so this multiplies the consumable count and nothing else;
	 * callers must refuse a count above 1 for anything owned once. Defaults to 1.
	 */
	copies?: number
	/**
	 * Grant the drop without creating the gift box that renders it — what a bulk purchase's
	 * `BypassGiftPackages` asks for. Ownership never depended on the box (it is granted here,
	 * not when the box is opened), so this only skips the "open it" moment; a caller setting
	 * it is saying its own UI announces the items.
	 */
	skipGiftBox?: boolean
}

/**
 * Pick a random consumable from the roll catalog — the reward the published level table
 * hands out for the early levels.
 *
 * Unlike a clothing roll this one has no rarity and no ownership filter: the table names no
 * star tier for a consumable, and consumables STACK, so "one you don't have" is meaningless
 * (a second Confetti Cannon is a fine prize). Returns a concrete drop rather than a query
 * one, so the grant path just grants it.
 */
function rollConsumableDrop(catalog: StoreItem[]): StoreGiftDrop | null {
	const pool = catalog.filter(
		({ GiftDrop: drop }) =>
			drop.IsQuery !== true &&
			typeof drop.ConsumableItemDesc === 'string' &&
			drop.ConsumableItemDesc !== ''
	)
	return pool[Math.floor(Math.random() * pool.length)]?.GiftDrop ?? null
}

/**
 * Hand a gift-drop to a player: grant whatever it turns out to carry (an avatar item, an
 * equipment skin, a consumable, or none of these — currency/xp drops aren't granted yet)
 * and create the gift box that renders it.
 *
 * A query drop is ROLLED here first, so what gets granted — and what the box shows — is the
 * item the player actually won, not the box that promised it. A roll with nothing left to
 * give falls through with the box itself, which grants nothing: no worse than not rolling,
 * and the warning says which rarity ran dry.
 *
 * Both faucets share this — a storefront purchase and the weekly-challenge reward — so a
 * drop lands in a player's inventory the same way whichever one it came from. The item is
 * granted here, not when the box is opened: consuming a box only deletes the row.
 */
async function grantGiftDrop(
	c: Context<App>,
	accountId: number,
	drop: StoreGiftDrop,
	message: string,
	options: GrantOptions = {}
): Promise<GrantedGift> {
	let giftDrop = drop
	if (drop.IsQuery === true) {
		const rarity = drop.QueryRedirectRarity ?? drop.Rarity
		const rolled = await rollQueryDrop(c, accountId, rarity, options)
		if (rolled === null) {
			logger.warn('query gift-drop rolled nothing', {
				accountId,
				rarity,
				friendlyName: drop.FriendlyName,
			})
		} else {
			giftDrop = rolled
		}
	}
	const db = c.env.DB
	if (typeof giftDrop.AvatarItemDesc === 'string' && giftDrop.AvatarItemDesc !== '') {
		await grantItem(db, accountId, toAvatarItem(giftDrop))
	}
	if (
		typeof giftDrop.EquipmentModificationGuid === 'string' &&
		giftDrop.EquipmentModificationGuid !== ''
	) {
		await grantEquipment(db, accountId, toEquipment(giftDrop))
	}
	const isConsumable =
		typeof giftDrop.ConsumableItemDesc === 'string' && giftDrop.ConsumableItemDesc !== ''
	const consumableCount = isConsumable ? CONSUMABLE_GRANT_COUNT * (options.copies ?? 1) : 0
	// Capture the granted consumable's row id and the player's pre-existing count so the
	// gift box can carry them — gift-consume fires ConsumableMappingAdded from these.
	let consumableMappingId = 0
	let consumablePreExisting = 0
	if (isConsumable) {
		consumablePreExisting = await countConsumable(db, accountId, giftDrop.ConsumableItemDesc)
		consumableMappingId = await grantConsumable(
			db,
			accountId,
			giftDrop.ConsumableItemDesc,
			consumableCount
		)
	}
	if (options.skipGiftBox === true) return { id: 0, drop: giftDrop }
	const { id } = await createGift(
		db,
		accountId,
		toGiftContent(giftDrop, message, consumableCount, consumableMappingId, consumablePreExisting)
	)
	return { id, drop: giftDrop }
}

/**
 * One `BalanceUpdates[].Data` entry: the gift-drop a player RECEIVED, as both purchase
 * endpoints report it. `granted.drop` is the resolved drop — the rolled prize for a query
 * box, not the box that promised it — or a query purchase answers with every item field
 * empty and the client draws an empty box.
 *
 * It carries no FriendlyName or consumable count (the count is a getUnlocked concept; each
 * box is one instance). `giftContext` is the requesting `Gift` block's, when it named one;
 * otherwise the drop's own.
 */
function toBalanceUpdateData(
	granted: GrantedGift,
	fromPlayerId: number,
	message: string,
	giftContext: number | null
): Record<string, unknown> {
	const drop = granted.drop
	return {
		Id: granted.id,
		FromPlayerId: fromPlayerId,
		ConsumableItemDesc: drop.ConsumableItemDesc,
		AvatarItemDesc: drop.AvatarItemDesc,
		AvatarItemType: drop.AvatarItemType ?? 0,
		EquipmentPrefabName: drop.EquipmentPrefabName,
		EquipmentModificationGuid: drop.EquipmentModificationGuid,
		CurrencyType: drop.CurrencyType,
		Currency: drop.Currency,
		Xp: drop.Xp ?? 0,
		Level: 0,
		Platform: -1,
		PlatformsToSpawnOn: -1,
		BalanceType: ALL_PLATFORMS,
		GiftContext: giftContext ?? drop.Context,
		GiftRarity: drop.Rarity,
		Message: message,
	}
}

/**
 * `Econ.BulkPurchaseCap` — the most copies one bulk purchase may carry. The client reads
 * the same 200 out of its game config (apps/api/static/gameconfigs-v1-all.json) and caps
 * the bag with it, so this is the server side of a limit the client already knows; a
 * request over it is a client that ignored its own config, not a bigger shopping trip.
 */
const BULK_PURCHASE_CAP = 200

/**
 * `UpdateResponse` — the outcome of ONE `BalanceUpdates` entry, from the client's own enum.
 * This is where a bulk purchase reports per line: the bag answers one entry per REQUESTED
 * item, and `AllowPartialSuccess` is what lets some of them come back non-OK while the
 * envelope's `Success` stays true. (buyItem's single `UpdateResponse: 0` is this same OK.)
 *
 * The members this server can produce are the ones a catalog purchase can fail on;
 * `TooManyRequests`, `PlayerNotEligible`, `RequestCannotBeRefunded` and `PlayerNotApproved`
 * belong to rate limiting, entitlements and refunds, none of which exist here. `AlreadyOwned`
 * is deliberately unused too: buyItem lets a player re-buy an item they own (the grant
 * upserts), and one purchase path refusing what the other allows would be worse than either.
 */
const UpdateResponse = {
	OK: 0,
	TooManyRequests: 1,
	NotEnoughCredit: 2,
	AlreadyOwned: 3,
	NoItemAvailable: 4,
	CouponNotApplicable: 5,
	RequestedPriceDoesNotMatch: 6,
	RequestedAmountNotAllowed: 7,
	PlayerNotEligible: 8,
	RequestCannotBeRefunded: 9,
	PlayerNotApproved: 10,
} as const

/** The discriminated item id a bulk-purchase line names its item by. */
interface PurchaseMethodId {
	Type: number
	NumberId: number | null
	Guid: string | null
}

/** One line of a `POST /api/items/bulkpurchase` body. */
interface PurchaseItemRequest {
	ItemPurchaseMethodId?: Partial<PurchaseMethodId> | null
	RequestedPrice?: number
	Gift?: GiftRequest | null
	CouponConsumablePlayerMappingId?: number | null
	DuplicateItemCount?: number
}

/**
 * A line that could not be bought: the `UpdateResponse` its entry carries, and the message
 * that fills the envelope's single `Error` when the bag as a whole is refused.
 */
interface BulkLineFailure {
	method: PurchaseMethodId
	code: number
	error: string
}

/** A line that resolved to something buyable, with the catalog's own price. */
interface BulkPurchaseLine {
	method: PurchaseMethodId
	item: StoreItem
	/** The UNIT price from the catalog — `count` copies cost `price * count`. */
	price: number
	count: number
	gift: GiftRequest | null
}

/**
 * One `BalanceUpdates[].Data` — what a single requested item turned into. Unlike buyItem's,
 * it NAMES the purchase rather than describing the drop: the client already has the catalog
 * entry for `PurchasableItemId`, so the only thing it can't reconstruct is the box.
 *
 * `CustomAvatarItem` is the UGC counterpart of `PurchasableItemId`, and both it and
 * `GiftPackage` are null on a line that didn't sell. Nothing here fills `CustomAvatarItem`:
 * no catalog we serve sells guid-keyed items.
 */
interface BulkPurchaseData {
	GiftPackage: Record<string, unknown> | null
	PurchasableItemId: number | null
	CustomAvatarItem: null
}

/** `ItemPurchaseMethodId.Type` for a numeric (storefront `PurchasableItemId`) id. */
const PURCHASE_METHOD_NUMBER_ID = 0

/**
 * The gift box as `GiftPackage` carries it — the same DTO family as buyItem's
 * `BalanceUpdates[].Data` entry, but with the four keys that shape doesn't carry
 * (`PlayerId`, `CustomAvatarItemId`, `Signature`, `IsSignatureValid`) and without its
 * `Level`. Twenty keys, in the order the client's own member list names them.
 *
 * `Platform`/`PlatformsToSpawnOn` are the platform MASK (-1, all) — the balance bucket is
 * the separate `BalanceType` beside them, unlike the envelope's `Value.Platform`, which IS
 * a renamed `BalanceType`. `Signature` is null and `IsSignatureValid` false: a box the
 * server minted was never signed for peer-to-peer transfer.
 */
function toGiftPackage(
	granted: GrantedGift,
	playerId: number,
	fromPlayerId: number,
	message: string,
	giftContext: number | null
): Record<string, unknown> {
	const drop = granted.drop
	return {
		Id: granted.id,
		PlayerId: playerId,
		FromPlayerId: fromPlayerId,
		ConsumableItemDesc: drop.ConsumableItemDesc,
		AvatarItemType: drop.AvatarItemType ?? 0,
		AvatarItemDesc: drop.AvatarItemDesc,
		CustomAvatarItemId: null,
		EquipmentPrefabName: drop.EquipmentPrefabName,
		EquipmentModificationGuid: drop.EquipmentModificationGuid,
		CurrencyType: drop.CurrencyType,
		Currency: drop.Currency,
		Xp: drop.Xp ?? 0,
		GiftContext: giftContext ?? drop.Context,
		GiftRarity: drop.Rarity,
		Message: message,
		Signature: null,
		IsSignatureValid: false,
		Platform: -1,
		PlatformsToSpawnOn: -1,
		BalanceType: ALL_PLATFORMS,
	}
}

/**
 * Normalise the id a line named its item by. A line that sent no id at all still resolves
 * to something, so this never returns null — the checks in {@link resolveBulkLine} are what
 * reject it.
 */
function toPurchaseMethodId(raw: Partial<PurchaseMethodId> | null | undefined): PurchaseMethodId {
	const id = typeof raw === 'object' && raw !== null ? raw : {}
	return {
		Type: Number.isInteger(id.Type) ? (id.Type as number) : PURCHASE_METHOD_NUMBER_ID,
		NumberId: Number.isInteger(id.NumberId) ? (id.NumberId as number) : null,
		Guid: typeof id.Guid === 'string' ? id.Guid : null,
	}
}

/**
 * Resolve one line against the bag's catalog: what it wants, how many, and at what price.
 * Returns the failure — with the `UpdateResponse` its entry will carry — instead when the
 * line can't be bought.
 *
 * Pure — the catalog is passed in — so the whole bag resolves from ONE storefront read.
 * The price check is buyItem's, per line: `RequestedPrice` is the UNIT price the client
 * rendered, and a mismatch means the catalog moved under a stale client rather than that
 * the player agreed to today's price.
 */
function resolveBulkLine(
	line: PurchaseItemRequest,
	storefront: Storefront | null,
	currencyType: number
): BulkPurchaseLine | BulkLineFailure {
	const method = toPurchaseMethodId(line.ItemPurchaseMethodId)
	// Guid-keyed ids name UGC / custom avatar items, which no catalog here sells. Failing the
	// line (rather than the request) is what lets a bag of ordinary items still go through.
	if (method.Type !== PURCHASE_METHOD_NUMBER_ID || method.NumberId === null) {
		return {
			method,
			code: UpdateResponse.NoItemAvailable,
			error: 'Only numeric storefront item ids can be bought',
		}
	}
	// Nothing issues coupons, so a line claiming one would otherwise be charged full price
	// for a discount it thinks it applied.
	if (
		line.CouponConsumablePlayerMappingId !== null &&
		line.CouponConsumablePlayerMappingId !== undefined
	) {
		return {
			method,
			code: UpdateResponse.CouponNotApplicable,
			error: 'Coupons are not supported',
		}
	}
	const count = line.DuplicateItemCount ?? 1
	if (!Number.isInteger(count) || count < 1) {
		return {
			method,
			code: UpdateResponse.RequestedAmountNotAllowed,
			error: 'DuplicateItemCount must be a positive integer',
		}
	}
	if (storefront === null) {
		return { method, code: UpdateResponse.NoItemAvailable, error: 'No such storefront' }
	}
	const item = storefront.StoreItems.find((it) => it.PurchasableItemId === method.NumberId)
	if (item === undefined) {
		return { method, code: UpdateResponse.NoItemAvailable, error: 'Item not found' }
	}
	// Only a consumable stacks. An avatar item or an equipment skin is owned once, so a
	// second copy would grant nothing while charging for it — and the bag answers ONE entry
	// (one box) per requested item, which is the same statement from the wire's side.
	if (count > 1 && item.GiftDrop.ConsumableItemDesc === '') {
		return {
			method,
			code: UpdateResponse.RequestedAmountNotAllowed,
			error: 'This item can only be bought once per line',
		}
	}
	const price = item.Prices.find((p) => p.CurrencyType === currencyType)
	if (price === undefined) {
		return {
			method,
			code: UpdateResponse.NoItemAvailable,
			error: 'Currency type not available for this item',
		}
	}
	if (!Number.isInteger(line.RequestedPrice)) {
		return {
			method,
			code: UpdateResponse.RequestedPriceDoesNotMatch,
			error: 'RequestedPrice is required',
		}
	}
	if (line.RequestedPrice !== price.Price) {
		return {
			method,
			code: UpdateResponse.RequestedPriceDoesNotMatch,
			error: 'Price has changed',
		}
	}
	const gift = typeof line.Gift === 'object' && line.Gift !== null ? line.Gift : null
	return { method, item, price: price.Price, count, gift }
}

/** Whether a resolved line is buyable or is already a failure. */
function isBulkLine(resolved: BulkPurchaseLine | BulkLineFailure): resolved is BulkPurchaseLine {
	return 'item' in resolved
}

/**
 * XP paid for a claimed game reward. One flat amount for every reward type, matching the
 * one flat cooldown they share — "First Game of the Day" and "Activity completed!" are the
 * same size of pat on the back until there's reason to price them apart.
 *
 * Deliberately smaller than the 10 XP the first level costs: a single action shouldn't be a
 * level-up, let alone two of them. At 5 it takes two rewards to reach level 2, and the early
 * levels are paced by the hourly cooldown rather than cleared in one match.
 */
const GAME_REWARD_XP = 5

/**
 * `GiftContext.GameRewards` — what the box says it came from, so the client files it under
 * gameplay rewards rather than a purchase or a player's gift. (`51` is the tokens variant,
 * for when a reward pays currency instead of XP.)
 */
const GIFT_CONTEXT_GAME_REWARDS = 50

/** Shown on the box when the client asks for a reward without saying what to call it. */
const DEFAULT_GAME_REWARD_MESSAGE = 'Reward earned!'

/**
 * The gift-drop a claimed game reward hands over: XP in a box, no item. Every item field is
 * empty on purpose — this is not a purchase and not a roll, so `grantGiftDrop` grants
 * nothing into the inventory and only creates the box. The XP is banked in `progression`;
 * the copy here is what the box and its notification display.
 */
function toGameRewardDrop(): StoreGiftDrop {
	return {
		FriendlyName: '',
		Tooltip: '',
		ConsumableItemDesc: '',
		AvatarItemDesc: '',
		AvatarItemType: null,
		EquipmentPrefabName: '',
		EquipmentModificationGuid: '',
		Rarity: 0,
		Context: GIFT_CONTEXT_GAME_REWARDS,
		Currency: 0,
		CurrencyType: 0,
		Xp: GAME_REWARD_XP,
	}
}

/**
 * The box a CLOTHING level-up hands over: a query drop at the level's own tier, rolled from
 * AVATAR ITEMS only. The published table calls these levels "N-Star Clothing", so the prize
 * has to be something the player can wear and be seen in — never an equipment skin for a
 * weapon they may not own. This is the one roll that narrows the pool that far.
 */
function toLevelUpDrop(rarity: number): StoreGiftDrop {
	return {
		FriendlyName: '',
		Tooltip: '',
		ConsumableItemDesc: '',
		AvatarItemDesc: '',
		AvatarItemType: null,
		EquipmentPrefabName: '',
		EquipmentModificationGuid: '',
		Rarity: rarity,
		Context: GIFT_CONTEXT_GAME_REWARDS,
		Currency: 0,
		CurrencyType: 0,
		IsQuery: true,
	}
}

/**
 * Hand over the rewards a run of level-ups earned — ONE PER LEVEL crossed, since the
 * published table names a reward for every level and a single grant can cross several (a
 * large enough grant could clear the first three levels at 10 XP each). Each arrives as a
 * gift box, announced like any other unasked-for gift.
 *
 * Which reward is per level, not per tier: the early levels pay CONSUMABLES and the rest pay
 * clothing at a rising star rating. The catalog is read once and shared across the boxes.
 * Best-effort as a whole: the XP is banked and the levels are already stored, so a failed
 * roll costs a prize, not the level.
 */
async function grantLevelUpGifts(
	c: Context<App>,
	accountId: number,
	grant: XpGrant
): Promise<void> {
	const levels = levelsReached(grant)
	if (levels.length === 0) return
	try {
		const rollCatalog = await loadRollCatalog(c)
		for (const level of levels) {
			const reward = levelReward(level)
			if (reward === null) continue
			const message = `Level ${level}!`
			// A consumable is rolled to a concrete drop up front; clothing rides the query path,
			// which rolls it against what the player already owns.
			const drop =
				reward.kind === 'consumable'
					? rollConsumableDrop(rollCatalog)
					: toLevelUpDrop(reward.rarity)
			if (drop === null) {
				logger.warn('level up reward rolled nothing', { accountId, level, kind: reward.kind })
				continue
			}
			const granted = await grantGiftDrop(c, accountId, drop, message, {
				avatarItemsOnly: reward.kind === 'clothing',
				rollCatalog,
			})
			await pushGiftReceived(c, accountId, granted, message, COACH_ACCOUNT_ID)
			logger.info('level up gift granted', {
				accountId,
				level,
				kind: reward.kind,
				rarity: reward.kind === 'clothing' ? reward.rarity : null,
				giftId: granted.id,
				avatarItemDesc: granted.drop.AvatarItemDesc,
				consumableItemDesc: granted.drop.ConsumableItemDesc,
			})
		}
	} catch (err) {
		logger.error('failed to grant level up gift', {
			accountId,
			levels,
			error: err instanceof Error ? err.message : String(err),
		})
	}
}

/**
 * The rotation's reward, as static/weekly-challenge.json writes it. Same item vocabulary as
 * a storefront `GiftDrop` but with `Context`/`Rarity` spelled `GiftContext`/`GiftRarity`,
 * so it has to be translated before the grant path can read it (see
 * {@link toChallengeGiftDrop}).
 *
 * `FriendlyName`/`Tooltip` are OPTIONAL because the captured rotation has neither — the
 * client resolves the reward's name from the item itself, falling back to
 * `FallbackGiftName`. A rotation we publish can carry them to name the granted item
 * properly without a code change.
 */
interface ChallengeGift {
	AvatarItemDesc: string
	AvatarItemType: number
	ConsumableItemDesc: string
	EquipmentPrefabName: string
	EquipmentModificationGuid: string
	GiftContext: number
	GiftRarity: number
	Xp: number
	FriendlyName?: string
	Tooltip?: string
}

/** The message on the gift box the weekly reward arrives in. */
const CHALLENGE_GIFT_MESSAGE = 'Weekly challenge complete!'

/**
 * The star rating → `Rarity` ladder, indexed by stars - 1. Pinned by sf2's "Star Boxes"
 * item set, whose three members name their own tier and carry the rarity they roll at:
 * 2-Star → 10, 3-Star → 20, 4-Star → 30. The ends are extrapolated from sf3's parallel
 * "Random box" family (Common 0, Uncommon 10, Rare 20, Epic 30, Legendary 50), which is the
 * same ladder under the other naming.
 */
const STAR_RARITY = [0, 10, 20, 30, 50]

/** The tier a "4-Star Box" rolls at, used when a rotation's fallback name doesn't parse. */
const DEFAULT_FALLBACK_STARS = 4

/**
 * The rarity the rotation's `FallbackGiftName` promises, read off the leading star count
 * ("4-Star Box" → 30). That string is the whole specification of the consolation prize —
 * it is what the client renders when the gift resolves to a box rather than a named item —
 * so a rotation can retune the tier by renaming it, with no code change.
 */
function fallbackGiftRarity(): number {
	const stars = Number(/^(\d+)-star/i.exec(weeklyChallenge.FallbackGiftName)?.[1])
	return STAR_RARITY[stars - 1] ?? STAR_RARITY[DEFAULT_FALLBACK_STARS - 1] ?? 0
}

/**
 * Translate the rotation's `Gift` block into the storefront gift-drop shape the grant path
 * reads. The renamed fields are the whole point — feeding one shape to the other's reader
 * silently drops the rarity and context.
 *
 * The reward carries no price, so `Currency`/`CurrencyType` are zero: the box shows an
 * item, not a payout. Display strings come from the block when it carries them; a block
 * that doesn't (the captured rotation names neither) borrows them from the catalog entry
 * selling the same item, so the granted item reads as itself — "Camera Skin (Comic)" rather
 * than the name of the box it might have arrived in.
 */
function toChallengeGiftDrop(catalog: StoreItem[]): StoreGiftDrop {
	const gift = weeklyChallenge.Gift as ChallengeGift
	const sold = catalog.find(
		({ GiftDrop: drop }) =>
			(gift.EquipmentModificationGuid !== '' &&
				drop.EquipmentModificationGuid === gift.EquipmentModificationGuid) ||
			(gift.AvatarItemDesc !== '' && drop.AvatarItemDesc === gift.AvatarItemDesc)
	)?.GiftDrop
	return {
		FriendlyName: gift.FriendlyName ?? sold?.FriendlyName ?? weeklyChallenge.FallbackGiftName,
		Tooltip: gift.Tooltip ?? sold?.Tooltip ?? '',
		ConsumableItemDesc: gift.ConsumableItemDesc,
		AvatarItemDesc: gift.AvatarItemDesc,
		AvatarItemType: gift.AvatarItemType,
		EquipmentPrefabName: gift.EquipmentPrefabName,
		EquipmentModificationGuid: gift.EquipmentModificationGuid,
		// The block's own `GiftRarity` is 0 in the captured rotation even though the item it
		// names sells at rarity 5, so the catalog's rarity wins where there is one.
		Rarity: sold?.Rarity ?? gift.GiftRarity,
		Context: gift.GiftContext,
		Currency: 0,
		CurrencyType: 0,
	}
}

/**
 * The consolation box: a query drop at the rarity `FallbackGiftName` promises, named after
 * it. Handed over instead of the rotation's item when that item would be a duplicate, which
 * is what the fallback name is for — the reward reads "the Camera Skin, or a 4-Star Box".
 */
function toChallengeFallbackDrop(): StoreGiftDrop {
	return {
		FriendlyName: weeklyChallenge.FallbackGiftName,
		Tooltip: '',
		ConsumableItemDesc: '',
		AvatarItemDesc: '',
		AvatarItemType: null,
		EquipmentPrefabName: '',
		EquipmentModificationGuid: '',
		Rarity: fallbackGiftRarity(),
		Context: (weeklyChallenge.Gift as ChallengeGift).GiftContext,
		Currency: 0,
		CurrencyType: 0,
		IsQuery: true,
	}
}

/**
 * How many of a rotation's challenges earn its gift. A week presents five and asks for
 * three: the reward is for playing most of the week's set, not for clearing all of it, so
 * the two a player can't reach (a quest they don't own, a mode they don't like) don't sink
 * the whole week.
 */
const CHALLENGES_REQUIRED_FOR_GIFT = 3

/**
 * How many completions this rotation's gift needs. `CompletedRequired` makes the set
 * all-or-nothing when it's true — the reading its name and the partial default suggest —
 * and a rotation shorter than the threshold can only ever ask for what it publishes.
 */
function challengesRequiredForGift(): number {
	const published = weeklyChallenge.Challenges.length
	return weeklyChallenge.CompletedRequired
		? published
		: Math.min(CHALLENGES_REQUIRED_FOR_GIFT, published)
}

/**
 * Award the rotation's `Gift` if this player has just earned it, doing nothing otherwise.
 * Called after each completing progress report, since `updateProgress` is the only place a
 * challenge is ever finished — there is no separate claim endpoint, and the client never
 * asks for this reward.
 *
 * Earning it takes {@link challengesRequiredForGift} of the rotation's challenges, counted
 * from `challenge_status`. Only challenges the rotation still publishes count: a report can
 * carry an id this week's set no longer lists (an edited rotation under a live client), and
 * three of those shouldn't buy a gift the player never worked for.
 *
 * What lands is the `Gift` block's item — or, if the player already owns it, the box named
 * by `FallbackGiftName`, which rolls something they don't have at that tier. Finishing the
 * week can't be worth nothing, and the rotation's reward is one fixed item that plenty of
 * players will have bought already.
 *
 * A grant that throws is swallowed: the client is reporting gameplay progress, and failing
 * that report (which it would then retry with the same completion) is worse than missing
 * the reward — the claim row is already taken, so the miss is permanent but visible in the
 * logs. An empty rotation earns nothing: its threshold clamps to zero, which every player
 * would otherwise meet without playing.
 */
async function awardChallengeGift(c: Context<App>, accountId: number): Promise<void> {
	try {
		if (weeklyChallenge.Challenges.length === 0) return
		const complete = await getCompletedChallengeIds(
			c.env.DB,
			accountId,
			weeklyChallenge.ChallengeMapId
		)
		const done = weeklyChallenge.Challenges.filter((ch) => complete.has(ch.ChallengeId)).length
		if (done < challengesRequiredForGift()) return
		// Claim first: this is what stops the next report paying out a second time.
		const claimed = await claimChallengeGift(c.env.DB, accountId, weeklyChallenge.ChallengeMapId)
		if (!claimed) return
		const catalog = await loadRollCatalog(c)
		const reward = toChallengeGiftDrop(catalog)
		const duplicate = await ownsGiftDrop(c.env.DB, accountId, reward)
		const granted = await grantGiftDrop(
			c,
			accountId,
			duplicate ? toChallengeFallbackDrop() : reward,
			CHALLENGE_GIFT_MESSAGE,
			{ rollCatalog: catalog }
		)
		// Nobody asked for this box, so the client has no reason to re-read the gifts list:
		// the notification is what makes the reward show up at the moment the set is finished.
		// From "Coach", the same system sender a self-buy is attributed to — the rotation is
		// the server handing something over, not another player.
		await pushGiftReceived(c, accountId, granted, CHALLENGE_GIFT_MESSAGE, COACH_ACCOUNT_ID)
		logger.info('weekly challenge gift granted', {
			accountId,
			challengeMapId: weeklyChallenge.ChallengeMapId,
			giftId: granted.id,
			fallbackRoll: duplicate,
			challengesComplete: done,
		})
	} catch (err) {
		logger.error('failed to grant weekly challenge gift', {
			accountId,
			challengeMapId: weeklyChallenge.ChallengeMapId,
			error: err instanceof Error ? err.message : String(err),
		})
	}
}

/**
 * The default NUX checklist for a brand-new account. `Objective` is an `ObjectiveType`
 * ordinal (from the client's `ProgressionManager`) that the client matches its own
 * progress events against — the names below are what those ordinals mean.
 */
const DEFAULT_CHECKLIST = [
	{ Order: 0, Objective: 38, Count: 1, CreditAmount: 25 }, // SaveOutfitSlot
	{ Order: 1, Objective: 32, Count: 1, CreditAmount: 25 }, // VisitACustomRoom
	{ Order: 2, Objective: 2, Count: 1, CreditAmount: 25 }, // AddAFriend
	{ Order: 3, Objective: 30, Count: 1, CreditAmount: 25 }, // GoToRecCenter
	{ Order: 4, Objective: 6, Count: 1, CreditAmount: 25 }, // CheerAPlayer
]

/** The `UpdateResponse` context a checklist reward is reported under. */
const CHECKLIST_REWARD_CONTEXT = 303

/**
 * A concise `describeRoute` spec for a route that serves an opaque JSON array — either
 * a static catalog served verbatim or an empty-list stub. `auth` adds the bearer
 * requirement + a 401 response.
 */
function listRoute(summary: string, description: string, auth = false) {
	return describeRoute({
		tags: ['Econ'],
		summary,
		description,
		...(auth ? { security: AUTHED } : {}),
		responses: {
			200: json(JsonArray, description),
			...(auth ? { 401: UNAUTHORIZED_RESPONSE } : {}),
		},
	})
}

// strict: false so trailing-slash routes (e.g. `/gifts/consume/`, which the client
// posts with a trailing slash) match either form. Mirrors the `api` worker.
const app = new Hono<App>({ strict: false })
	.use(
		'*',
		// middleware
		(c, next) =>
			useWorkersLogger(c.env.NAME, {
				environment: c.env.ENVIRONMENT,
				release: c.env.SENTRY_RELEASE,
			})(c, next)
	)

	.onError(withOnError())
	.notFound(withNotFound())

	// Default-unlocked avatar items, served from the bundled static JSON.
	.get(
		'/api/avatar/v1/defaultunlocked',
		listRoute('Default-unlocked avatar items', 'The bundled default avatar-item catalog'),
		(c) => c.json(defaultAvatarItems)
	)

	// The base items UGC clothing is built on top of — served from bundled static JSON,
	// separate from the `defaultunlocked` catalog. No auth.
	.get(
		'/api/avatar/v1/defaultbaseavataritems',
		listRoute('Default base avatar items', 'The bundled base items UGC clothing builds on'),
		(c) => c.json(defaultBaseAvatarItems)
	)

	// The player's avatar items — the items they've bought (from `buyItem`, stored in
	// the inventory table) prepended to the default catalog. A player who has bought
	// nothing gets just the catalog.
	.get(
		'/api/avatar/v4/items',
		describeRoute({
			tags: ['Avatar'],
			summary: 'The player’s avatar items',
			description: [
				'The items the player has bought (from buyItem, in the inventory table) prepended',
				'to the default catalog. A player who has bought nothing gets just the catalog.',
				'Both sources are projected into the camelCase v4 DTO — the sibling item endpoints',
				'(`defaultunlocked`, `defaultbaseavataritems`) serve their records raw instead.',
			].join(' '),
			security: AUTHED,
			responses: {
				200: json(AvatarItemV4Dto.array(), 'Owned items followed by the default catalog'),
				401: UNAUTHORIZED_RESPONSE,
			},
		}),
		async (c) => {
			const id = await authedId(c)
			if (id === null) return unauthorized(c)
			const owned = await getInventory(c.env.DB, id)
			return c.json([...owned, ...defaultAvatarItems].map(toAvatarItemV4))
		}
	)

	// The player's owned custom avatar items. [Authorize]; paginated. Empty stub for
	// now (no DB binding). The client downloads these when custom-item creation is
	// allowed; a 404 here surfaces as "Failed to download unlocked avatar items".
	.get(
		'/econ/customAvatarItems/v1/owned',
		describeRoute({
			tags: ['Avatar'],
			summary: 'Owned custom avatar items',
			description: [
				'Paginated owned custom items. Empty stub for now. The client requests this when',
				'custom-item creation is allowed; a 404 shows as “Failed to download unlocked',
				'avatar items”.',
			].join(' '),
			security: AUTHED,
			responses: {
				200: json(CustomAvatarItemsResponse, 'Paginated results (empty for now)'),
				401: UNAUTHORIZED_RESPONSE,
			},
		}),
		async (c) => {
			const id = await authedId(c)
			if (id === null) return unauthorized(c)
			return c.json({ Results: [], TotalResults: 0 })
		}
	)

	// The player's objectives progress. Serves a static JSON file verbatim with
	// no auth — same default for everyone until there's a DB binding to track
	// per-player progress.
	.get(
		'/api/objectives/v1/myprogress',
		describeRoute({
			tags: ['Econ'],
			summary: 'Objectives progress',
			description:
				'Serves the bundled static progress verbatim (no per-player store yet). No auth.',
			responses: { 200: json(JsonObject, 'The bundled objectives-progress default') },
		}),
		(c) => c.json(myProgress)
	)

	// Clears a group of objectives. No per-player progress to clear yet, so this
	// is a no-op that returns an empty array (a 404 here breaks the client). Accepts
	// GET or POST since the client may use either.
	.on(
		['GET', 'POST'],
		'/api/objectives/v1/cleargroup',
		describeRoute({
			tags: ['Econ'],
			summary: 'Clear an objectives group (no-op)',
			description: 'No per-player progress to clear yet → []. Accepts GET or POST.',
			responses: { 200: json(JsonArray, 'Always empty for now') },
		}),
		(c) => c.json([])
	)

	// Report one objective's progress. The client posts the whole objective as it now
	// sees it (Index/Group identify it within `myprogress`) and reads back the state of
	// the GROUP that objective belongs to — camelCase here, unlike the PascalCase body it
	// posted. Stubbed: with no objectives store yet we persist nothing, echo the group
	// back and never complete it, so the reward-claim flow isn't triggered. `clearedAt`
	// is the clear time, which for a group we didn't clear is just now.
	.post(
		'/api/objectives/v1/updateobjective',
		describeRoute({
			tags: ['Econ'],
			summary: 'Report objective progress',
			description: [
				'Stubbed: with no objectives store we persist nothing and never complete a group.',
				'Echoes `Group` back as camelCase `group` with `isCompleted: false` so the client',
				'gets a well-formed body.',
			].join(' '),
			requestBody: jsonBody(UpdateObjectiveRequest, 'The objective as the client now sees it'),
			responses: { 200: json(UpdateObjectiveResponse, 'The echoed group, never completed') },
		}),
		async (c) => {
			const body = await c.req
				.json<{ Group?: string | number }>()
				.catch(() => ({}) as Record<string, never>)
			return c.json({
				group: Number(body.Group) || 0,
				isCompleted: false,
				clearedAt: new Date().toISOString(),
			})
		}
	)

	// The player's avatar, stored as a JSON blob on their account row. Falls back
	// to the default outfit when they haven't saved one — the client's parser NREs
	// on an empty OutfitSelections (real RecNet never returns one).
	.get(
		'/api/avatar/v2',
		describeRoute({
			tags: ['Avatar'],
			summary: 'The player’s own avatar',
			description: [
				'The avatar JSON blob stored on the account row, or the default outfit when none is',
				'saved (the client NREs on an empty OutfitSelections).',
			].join(' '),
			security: AUTHED,
			responses: {
				200: json(JsonObject, 'The stored avatar blob (or the default)'),
				401: UNAUTHORIZED_RESPONSE,
			},
		}),
		async (c) => {
			const id = await authedId(c)
			if (id === null) return unauthorized(c)
			return c.json((await getAvatar(c.env.DB, id)) ?? defaultAvatar)
		}
	)

	// Save the player's avatar. [Authorize]. Stores the posted JSON payload verbatim
	// on the account row and echoes it back. 400 on a non-object body; 404 when the
	// caller has no account row to attach it to.
	.post(
		'/api/avatar/v2/set',
		describeRoute({
			tags: ['Avatar'],
			summary: 'Save the player’s avatar',
			description: 'Stores the posted JSON blob verbatim on the account row and echoes it back.',
			security: AUTHED,
			requestBody: jsonBody(OpaqueJsonBody, 'The avatar blob'),
			responses: {
				200: json(JsonObject, 'The saved avatar (echoed back)'),
				400: { description: 'Body was not a JSON object (empty body)' },
				401: UNAUTHORIZED_RESPONSE,
				404: { description: 'No account row to attach it to (empty body)' },
			},
		}),
		async (c) => {
			const id = await authedId(c)
			if (id === null) return unauthorized(c)
			const avatar = (await c.req.json().catch(() => null)) as Record<string, unknown> | null
			if (avatar === null || typeof avatar !== 'object' || Array.isArray(avatar)) {
				return c.body(null, 400)
			}
			if (!(await setAvatar(c.env.DB, id, avatar))) return c.body(null, 404)
			return c.json(avatar)
		}
	)

	// NUX checklist — the client fetches this on the econ host during load, on either
	// version path. A 404 here can abort the load orchestration before matchmake. We
	// serve the default brand-new-account list to everyone: nothing records per-player
	// checklist progress yet, so it never shrinks as steps are done.
	.on(
		'GET',
		['/api/checklist/v1/current', '/api/checklist/v2/current'],
		describeRoute({
			tags: ['Econ'],
			summary: 'NUX checklist',
			description:
				'The new-user checklist, as the default brand-new-account list — nothing records ' +
				'per-player progress yet, so the same rows come back however much the player has ' +
				'done. `Objective` is an `ObjectiveType` ordinal the client matches its own ' +
				'progress events against. v1 and v2 serve the same list.',
			security: AUTHED,
			responses: {
				200: json(ChecklistEntry.array(), 'The checklist rows, in `Order`'),
				401: UNAUTHORIZED_RESPONSE,
			},
		}),
		async (c) => {
			const id = await authedId(c)
			if (id === null) return unauthorized(c)
			return c.json(DEFAULT_CHECKLIST)
		}
	)

	// Mark a checklist row done. [Authorize]. Stubbed: there is no objective-progress
	// table to record the completion in, and no reward ledger to make the 25-token grant
	// once-only — without one, re-posting the same row would mint tokens indefinitely, so
	// we grant nothing and report a change of 0. The envelope is still the balance-update
	// shape the client parses, so the flow completes instead of erroring.
	.on(
		'POST',
		['/api/checklist/v1/complete', '/api/checklist/v2/complete'],
		describeRoute({
			tags: ['Econ'],
			summary: 'Complete a checklist row (stub)',
			description:
				'Marks a NUX checklist row done. Stubbed: nothing records the completion (no ' +
				'objective-progress table) and nothing is granted — a reward is worth 25 XP and 25 ' +
				'tokens, but making that once-only needs a ledger we do not have, and without one ' +
				're-posting the same row would mint tokens indefinitely. The response is still the ' +
				'balance-update envelope, with `Balance` (the change) 0. v1 and v2 behave alike.',
			security: AUTHED,
			requestBody: jsonBody(CompleteChecklistRequest, 'Which row was completed — `{ ItemIndex }`'),
			responses: {
				200: json(ChecklistCompleteResponse, 'The balance-update envelope, granting nothing'),
				401: UNAUTHORIZED_RESPONSE,
			},
		}),
		async (c) => {
			const id = await authedId(c)
			if (id === null) return unauthorized(c)
			// The body names the row (`{ ItemIndex: 1 }`, or `Id` as a fallback) — read only
			// once there is somewhere to record it.
			return c.json({
				BalanceUpdates: [{ UpdateResponse: CHECKLIST_REWARD_CONTEXT, Data: [] }],
				Balance: 0,
				CurrencyType: CurrencyType.RecCenterTokens,
				BalanceType: -2,
			})
		}
	)

	// The caller's item wishlist. [Authorize]; empty — nothing stores wishlists yet.
	.get(
		'/api/itemWishlists/v1/wishlist/me',
		listRoute('The player’s item wishlist', 'Empty for now', true),
		async (c) => {
			const id = await authedId(c)
			if (id === null) return unauthorized(c)
			return c.json([])
		}
	)

	// Another player's item wishlist, by account id — what the client reads to show what
	// somebody else is hoping for (and to mark items in the store as already wished for).
	// Empty like `/me`: nothing stores wishlists, so there is nothing to show for anyone.
	//
	// Registered AFTER `/me` so that path stays its own route rather than being read as an
	// account id — the pattern here is digits-only, so it could not swallow `me`, but the
	// order also says which is the special case.
	.get(
		'/api/itemWishlists/v1/wishlist/:accountId{[0-9]+}',
		describeRoute({
			tags: ['Econ'],
			summary: 'Another player’s item wishlist',
			description: [
				'The wishlist of the account named in the path, as a bare array. Empty for now —',
				'nothing on this server stores wishlists, so every player’s is empty, and an empty',
				'list is what the client renders as “nothing wished for” where a 404 would read as a',
				'failed load.',
			].join(' '),
			security: AUTHED,
			parameters: [
				{
					name: 'accountId',
					in: 'path',
					required: true,
					description: 'The account whose wishlist to read',
					schema: { type: 'string', pattern: '^[0-9]+$' },
				},
			],
			responses: {
				200: json(JsonArray, 'That player’s wishlist — empty for now'),
				401: UNAUTHORIZED_RESPONSE,
			},
		}),
		async (c) => {
			const id = await authedId(c)
			if (id === null) return unauthorized(c)
			return c.json([])
		}
	)

	// The player's saved outfits. [Authorize]. Served back as the client posted them
	// (see /saved/set); a player who has saved none gets [].
	.get(
		'/api/avatar/v3/saved',
		describeRoute({
			tags: ['Avatar'],
			summary: 'The player’s saved outfits',
			description: 'Served back as the client posted them (see /saved/set); [] when none.',
			security: AUTHED,
			responses: {
				200: json(JsonArray, 'Saved outfits (empty when none)'),
				401: UNAUTHORIZED_RESPONSE,
			},
		}),
		async (c) => {
			const id = await authedId(c)
			if (id === null) return unauthorized(c)
			return c.json(await getOutfits(c.env.DB, id))
		}
	)

	// Save an outfit into one of the player's slots. [Authorize]. The posted `Slot` is
	// the slot to write, and re-saving a slot overwrites it — that's the avatar screen's
	// "save over this outfit". The payload is stored verbatim and echoed back: its inner
	// fields (OutfitSelectionsV2, FaceFeatures, …) are JSON-in-a-string from the client's
	// own serializer, so re-encoding them risks handing back something it can't parse.
	//
	// A missing/non-integer `Slot` is a 400 rather than a default slot — guessing would
	// silently overwrite an outfit the player didn't mean to touch.
	//
	// v3 and v4 share this handler: newer clients POST to /v4/saved/set with the same
	// payload shape (Slot, PreviewImageName, OutfitSelections(V2), FaceFeatures, Skin/HairColor,
	// CustomAvatarItems) and expect the same slot-overwrite semantics, so they store into the
	// same outfit table and read back through /api/avatar/v3/saved.
	.post(
		'/api/avatar/v3/saved/set',
		describeRoute({
			tags: ['Avatar'],
			summary: 'Save an outfit into a slot',
			description: [
				'Writes the posted outfit into the given `Slot` (overwriting it) and echoes it back.',
				'The payload is stored verbatim — its inner fields are JSON-in-a-string from the',
				'client’s own serializer. A missing/non-integer `Slot` is a 400 (guessing would',
				'silently overwrite another outfit).',
			].join(' '),
			security: AUTHED,
			requestBody: jsonBody(SaveOutfitRequest, 'The outfit, with a target Slot'),
			responses: {
				200: json(JsonObject, 'The saved outfit (echoed back)'),
				400: { description: 'Non-object body or missing/non-integer Slot (empty body)' },
				401: UNAUTHORIZED_RESPONSE,
			},
		}),
		async (c) => {
			const result = await persistPostedOutfit(c)
			if (result instanceof Response) return result
			return c.json(result)
		}
	)

	// v4 of the save-outfit route. Same payload, table and slot-overwrite semantics as v3
	// (see above) — newer clients moved to /v4/saved/set. The one difference is the response:
	// v4 answers a lean `{ Success, Slot }` acknowledgement rather than echoing the whole
	// outfit back. The outfit is read back through /api/avatar/v3/saved either way.
	.post(
		'/api/avatar/v4/saved/set',
		describeRoute({
			tags: ['Avatar'],
			summary: 'Save an outfit into a slot (v4)',
			description: [
				'Writes the posted outfit into the given `Slot` (overwriting it), same as',
				'`POST /api/avatar/v3/saved/set`, but answers a lean `{ Success, Slot }` ack instead',
				'of echoing the outfit. A missing/non-integer `Slot` is a 400.',
			].join(' '),
			security: AUTHED,
			requestBody: jsonBody(SaveOutfitRequest, 'The outfit, with a target Slot'),
			responses: {
				200: json(SaveOutfitV4Response, 'Save acknowledgement'),
				400: { description: 'Non-object body or missing/non-integer Slot (empty body)' },
				401: UNAUTHORIZED_RESPONSE,
			},
		}),
		async (c) => {
			const result = await persistPostedOutfit(c)
			if (result instanceof Response) return result
			return c.json({ Success: true, Slot: result.Slot })
		}
	)

	// Pending avatar gifts for the player — the unopened gift boxes from their purchases
	// (and, once gifting lands, from other players). [Authorize]. The client opens each
	// box and consumes it via the consume route below; the item itself was already
	// granted at purchase, so an unopened box is cosmetic.
	.get(
		'/api/avatar/v2/gifts',
		describeRoute({
			tags: ['Gifts'],
			summary: 'Pending gift boxes',
			description: [
				'The player’s unopened gift boxes from their purchases (and, later, from other',
				'players). The item was already granted at purchase, so an unopened box is cosmetic.',
			].join(' '),
			security: AUTHED,
			responses: {
				200: json(JsonArray, 'Unopened gift boxes (empty when none)'),
				401: UNAUTHORIZED_RESPONSE,
			},
		}),
		async (c) => {
			const id = await authedId(c)
			if (id === null) return unauthorized(c)
			return c.json(await getPendingGifts(c.env.DB, id))
		}
	)

	// Open (consume) a gift box. [Authorize]. The client posts this on the econ host after
	// the box animation, form-encoded as `Id=<giftId>&UnlockedLevel=<n>`. Opening just
	// deletes the box — the item was granted into the inventory at purchase, so there's
	// nothing to grant here — an avatar-item drop was granted into the inventory table and a
	// consumable drop into the consumable table, both at purchase. (`UnlockedLevel`, a
	// consumable-level hint, is unused.)
	//
	// Always answers 200 with the `{ error, success, value }` envelope — even with no token,
	// a zero id, or a box that is already gone. A captured real consume returns this envelope,
	// not an empty body: the client parses it to finish opening the box, so a bare 200 reads
	// as a failure and the consumable never finishes unlocking. The delete is scoped to the
	// caller's account, so an unauthenticated or mismatched call is simply a no-op. Mirrors
	// the same route on the `api` worker (the client may call either host).
	.post(
		'/api/avatar/v2/gifts/consume',
		describeRoute({
			tags: ['Gifts'],
			summary: 'Open (consume) a gift box',
			description: [
				'Deletes the box (the item was already granted at purchase). Always answers the',
				'`{ error, success, value }` envelope with HTTP 200 — even with no token, a zero id,',
				'or a box already gone — because the client parses it to finish opening the box. The',
				'delete is scoped to the caller; opening someone else’s box is 403. Also served by',
				'the `api` worker.',
			].join(' '),
			requestBody: form(ConsumeGiftRequest, 'The gift-box id'),
			responses: {
				200: json(ConsumeEnvelope, 'Success envelope'),
				403: { description: 'The box belongs to another player (empty body)' },
			},
		}),
		async (c) => {
			const id = await authedId(c)
			const body = await c.req.parseBody().catch(() => ({}) as Record<string, unknown>)
			const giftId = typeof body.Id === 'string' ? Number.parseInt(body.Id, 10) || 0 : 0
			if (id !== null && giftId !== 0) {
				// Scoped delete: only the box's owner deletes it. A returned box means it was
				// theirs and is now consumed.
				const gift = await consumeGift(c.env.DB, id, giftId)
				if (gift !== null) {
					// If the box carried a consumable, tell the client it now has it (so it shows
					// up in inventory without a refetch). Avatar-item boxes carry no ConsumableItemDesc.
					if (gift.ConsumableItemDesc !== '') await pushConsumableAdded(c, id, gift)
				} else {
					// Nothing was consumed: either the box is already gone (a harmless no-op —
					// re-opening your own consumed box still succeeds) or it belongs to another
					// player, which is forbidden.
					const other = await getGift(c.env.DB, giftId)
					if (other !== null && other.accountId !== id) return c.body(null, 403)
				}
			}
			return c.json({ error: '', success: true, value: null })
		}
	)

	// A player's avatar by account id, projected to the public render subset (used
	// to draw other players' avatars). No auth — like the accounts `/account/:id`
	// lookup. Falls back to the default outfit when the player hasn't saved one.
	// Registered after the static `/api/avatar/v2/*` routes so `:id` can't shadow them.
	.get(
		'/api/avatar/v2/:id',
		describeRoute({
			tags: ['Avatar'],
			summary: 'Another player’s avatar (render subset)',
			description: [
				'The public render subset used to draw another player’s avatar. No auth. Falls back',
				'to the default outfit when the player hasn’t saved one.',
			].join(' '),
			parameters: [
				{
					name: 'id',
					in: 'path',
					required: true,
					description: 'Account id; non-numeric is 400',
					schema: { type: 'string' },
				},
			],
			responses: {
				200: json(AvatarV2Dto, 'The render subset'),
				400: { description: 'Non-numeric id (empty body)' },
			},
		}),
		async (c) => {
			const accountId = Number.parseInt(c.req.param('id'), 10)
			if (Number.isNaN(accountId)) return c.body(null, 400)
			return c.json(toAvatarV2Dto((await getAvatar(c.env.DB, accountId)) ?? defaultAvatar))
		}
	)

	// Unlocked equipment. [Authorize]. The equipment skins the player has bought (from
	// `buyItem`, stored in the `equipment` table). A player who has bought none gets an
	// empty list.
	.get(
		'/api/equipment/v2/getUnlocked',
		listRoute('Unlocked equipment', 'The equipment skins the player has bought', true),
		async (c) => {
			const id = await authedId(c)
			if (id === null) return unauthorized(c)
			return c.json(await getEquipment(c.env.DB, id))
		}
	)

	// Favourite/un-favourite owned equipment. [Authorize]. The client PUTs the entries
	// it wants changed (one request can carry several) and reads nothing back. Only
	// `Favorited` is written — the rest of each entry is the client echoing what it was
	// served, and a guid the caller doesn't own matches no row and is dropped.
	.put(
		'/api/equipment/v1/update',
		describeRoute({
			tags: ['Equipment'],
			summary: 'Update owned equipment',
			description: [
				'Applies the posted `Favorited` flags to the caller’s owned equipment, matched by',
				'`ModificationGuid`. Everything else in each entry is ignored, and a guid the caller',
				'doesn’t own is silently skipped. Empty body on success.',
			].join(' '),
			security: AUTHED,
			requestBody: jsonBody(EquipmentUpdateRequest, 'The entries to update'),
			responses: {
				200: { description: 'Applied (empty body)' },
				400: { description: 'Body isn’t a JSON array (empty body)' },
				401: UNAUTHORIZED_RESPONSE,
			},
		}),
		async (c) => {
			const id = await authedId(c)
			if (id === null) return unauthorized(c)
			const body = (await c.req.json().catch(() => null)) as unknown
			if (!Array.isArray(body)) return c.body(null, 400)
			const updates = body
				.filter((e): e is Record<string, unknown> => typeof e === 'object' && e !== null)
				.filter((e) => typeof e.ModificationGuid === 'string' && e.ModificationGuid !== '')
				.map((e) => ({
					ModificationGuid: e.ModificationGuid as string,
					Favorited: e.Favorited === true,
				}))
			await setEquipmentFavorited(c.env.DB, id, updates)
			return c.body(null, 200)
		}
	)

	// Room consumables/currencies for a given room. Stubbed as empty lists so the
	// client doesn't 404.
	.get(
		'/api/roomconsumables/v1/roomConsumable/room/:roomId',
		listRoute('Room consumables', 'Empty stub so the client doesn’t 404'),
		(c) => c.json([])
	)
	.get(
		'/api/roomconsumables/v1/roomConsumable/room/:roomId/me',
		listRoute('The caller’s room consumables', 'Empty stub'),
		(c) => c.json([])
	)
	.get('/api/roomcurrencies/v1/currencies', listRoute('Room currencies', 'Empty stub'), (c) =>
		c.json([])
	)
	.get('/api/roomcurrencies/v1/getAllBalances', listRoute('Room balances', 'Empty stub'), (c) =>
		c.json([])
	)

	// The room-economy surface the client asks for on entering a room: the room's own
	// inventory/offers/gift-drop shops and the caller's slice of them. Nothing here is
	// stored yet, so every one is an empty list — the client reads that as "this room
	// sells nothing" and renders no shop, where a 404 stalls the room load instead.
	//
	// The `/player` and `purchaseCounts` variants are caller-scoped but deliberately
	// unauthed, matching the `roomConsumable/.../me` stub above: an empty list is the
	// same answer for every caller, so there's nothing to protect until something
	// writes here. Gate them when they start returning real data.
	.get(
		'/econ/roomInventory/room/:roomId',
		listRoute('A room’s inventory', 'Empty stub so the client doesn’t 404'),
		(c) => c.json([])
	)
	.get(
		'/econ/roomInventory/room/:roomId/player',
		listRoute('The caller’s inventory in a room', 'Empty stub'),
		(c) => c.json([])
	)
	.get(
		'/econ/roomInventoryItemTags/room/:roomId',
		listRoute('A room’s inventory item tags', 'Empty stub'),
		(c) => c.json([])
	)
	.get('/econ/roomOffer/room/:roomId', listRoute('A room’s offers', 'Empty stub'), (c) =>
		c.json([])
	)
	.get(
		'/econ/roomOffer/room/:roomId/purchaseCounts',
		listRoute('Per-offer purchase counts for a room', 'Empty stub'),
		(c) => c.json([])
	)
	.get(
		'/econ/roomGiftDropShops/room/:roomId',
		listRoute('A room’s gift-drop shops', 'Empty stub'),
		(c) => c.json([])
	)

	// A room's economy config, asked for alongside the room-economy lists above. The only
	// setting is whether the room's shop UI groups its offers into sorting tabs; nothing
	// stores per-room config yet, so every room answers false and the client renders one
	// flat list. [Authorize] — unlike the empty-list stubs above this is a real answer the
	// client acts on, so it takes the same token the rest of the econ surface does.
	.get(
		'/econ/roomEconConfig/:roomId',
		describeRoute({
			tags: ['Econ'],
			summary: 'A room’s economy config',
			description: [
				'Whether the room’s shop groups offers into sorting tabs. No per-room config is',
				'stored, so this is always false; the `RoomId` is echoed from the path.',
			].join(' '),
			security: AUTHED,
			responses: {
				200: json(RoomEconConfig, 'The room’s economy config'),
				400: { description: 'Non-numeric roomId (empty body)' },
				401: UNAUTHORIZED_RESPONSE,
			},
		}),
		async (c) => {
			const id = await authedId(c)
			if (id === null) return unauthorized(c)
			const roomId = Number.parseInt(c.req.param('roomId'), 10)
			if (Number.isNaN(roomId)) return c.body(null, 400)
			return c.json({ RoomId: roomId, EnableSortingTabs: false })
		}
	)

	// The UGC items a room sells (the creator-made things on sale inside it). Same empty
	// stub as the room-economy routes above and asked for on the same room load: nothing
	// stores room UGC purchasables yet, and an empty list reads as "this room sells
	// nothing" where a 404 stalls the load.
	.get(
		'/api/ugcPurchasables/v1/items/room/:roomId',
		listRoute('A room’s UGC purchasables', 'Empty stub so the client doesn’t 404'),
		(c) => c.json([])
	)

	// Unlocked consumables. [Authorize]. The consumables the player has bought (from
	// `buyItem`, stored in the `consumable` table), grouped by item into the client's
	// unlocked-consumable DTO. A player who has bought none gets an empty list.
	.get(
		'/api/consumables/v2/getUnlocked',
		describeRoute({
			tags: ['Consumables'],
			summary: 'Unlocked consumables',
			description: [
				'The consumables the player has bought (from buyItem, in the consumable table),',
				'grouped by item into the unlocked-consumable DTO (Ids/CreatedAts per instance,',
				'Count their sum). [] when they’ve bought none.',
			].join(' '),
			security: AUTHED,
			responses: {
				200: json(JsonArray, 'Grouped unlocked consumables (empty when none)'),
				401: UNAUTHORIZED_RESPONSE,
			},
		}),
		async (c) => {
			const id = await authedId(c)
			if (id === null) return unauthorized(c)
			return c.json(await getConsumables(c.env.DB, id))
		}
	)

	// Consume a quantity of an owned consumable instance. [Authorize]. Body is JSON
	// `{ Id, DeltaCount }` where `Id` is the consumable row id. Reduces that instance's
	// count by DeltaCount, deleting the row once it hits zero. Scoped to the caller so
	// they can only consume their own. Envelope mirrors the gift-consume ack.
	.post(
		'/api/consumables/v1/consume',
		describeRoute({
			tags: ['Consumables'],
			summary: 'Consume a quantity of an owned consumable',
			description: [
				'Reduces the given consumable instance’s count by `DeltaCount` (default 1), deleting',
				'the row at zero. Scoped to the caller. Pushes a ConsumableMappingRemoved socket',
				'notification. Envelope mirrors the gift-consume ack.',
			].join(' '),
			security: AUTHED,
			requestBody: jsonBody(ConsumeConsumableRequest, 'The consumable id and delta'),
			responses: {
				200: json(ConsumeEnvelope, 'Success envelope'),
				401: UNAUTHORIZED_RESPONSE,
			},
		}),
		async (c) => {
			const id = await authedId(c)
			if (id === null) return unauthorized(c)
			const body = await c.req
				.json<{ Id?: unknown; DeltaCount?: unknown }>()
				.catch(() => ({}) as { Id?: unknown; DeltaCount?: unknown })
			const consumableId = typeof body.Id === 'number' ? body.Id : Number.NaN
			const delta = typeof body.DeltaCount === 'number' ? body.DeltaCount : 1
			if (!Number.isNaN(consumableId) && delta > 0) {
				const consumed = await consumeConsumable(c.env.DB, id, consumableId, delta)
				// Notify the player so their client removes/updates the item in inventory.
				if (consumed !== null) await pushConsumableRemoved(c, id, consumed)
			}
			return c.json({ error: '', success: true, value: null })
		}
	)

	// Currency balance. [Authorize]. The trailing int is a CurrencyType — the client
	// fetches `/balance/2` (RecCenterTokens) on load. Backed by the `balance` table; a
	// player who has never been granted gets their starting balance on this first read.
	//
	// An unknown or non-account-scoped currency (a room currency, ProgressionEvent,
	// Invalid) returns a 0 balance rather than 404: the client treats a failed balance
	// fetch as a load error, and "you have none of that" is the honest answer anyway.
	.get(
		'/api/storefronts/v4/balance/:currencyType',
		describeRoute({
			tags: ['Storefront'],
			summary: 'Currency balance',
			description: [
				'The player’s balance in a CurrencyType (the client fetches `/balance/2`,',
				'RecCenterTokens, on load). A first read seeds their starting balance. An unknown or',
				'non-account currency returns a 0 balance rather than 404.',
			].join(' '),
			security: AUTHED,
			parameters: [
				{
					name: 'currencyType',
					in: 'path',
					required: true,
					description: 'CurrencyType integer; non-numeric is 400',
					schema: { type: 'string' },
				},
			],
			responses: {
				200: json(BalanceEntry.array(), 'A single-entry balance array'),
				400: { description: 'Non-numeric currencyType (empty body)' },
				401: UNAUTHORIZED_RESPONSE,
			},
		}),
		async (c) => {
			const id = await authedId(c)
			if (id === null) return unauthorized(c)
			const currencyType = Number.parseInt(c.req.param('currencyType'), 10)
			if (Number.isNaN(currencyType)) return c.body(null, 400)
			const amount = isSpendable(currencyType)
				? await getBalance(
						c.env.DB,
						id,
						currencyType,
						intVar(c.env.STARTING_TOKENS, DEFAULT_STARTING_TOKENS)
					)
				: 0
			return c.json([{ CurrencyType: currencyType, Platform: ALL_PLATFORMS, Balance: amount }])
		}
	)

	// Gift-drop storefront. Serves `static/storefronts/sf{id}.json` for the requested
	// storefront id via the ASSETS binding; 404s when no such catalog exists.
	.get(
		'/api/storefronts/v3/giftdropstore/:id',
		describeRoute({
			tags: ['Storefront'],
			summary: 'Gift-drop storefront catalog',
			description: 'Serves the `sf{id}.json` catalog via the ASSETS binding. 404 when none exists.',
			parameters: [
				{
					name: 'id',
					in: 'path',
					required: true,
					description: 'Storefront id (selects sf{id}.json)',
					schema: { type: 'string' },
				},
			],
			responses: {
				200: json(JsonObject, 'The storefront catalog'),
				404: { description: 'No such storefront catalog' },
			},
		}),
		async (c) => {
			const id = c.req.param('id')
			const res = await c.env.ASSETS.fetch(new URL(`/sf${id}.json`, c.req.url))
			if (!res.ok) return c.notFound()
			return c.json(await res.json())
		}
	)

	// Buy a storefront item. [Authorize]. The client posts the storefront/item ids, the
	// currency and the price it sees; we look the item up in that storefront's catalog,
	// confirm the price the client sent still matches, debit the buyer atomically, grant
	// the item into the recipient's inventory, and hand back a gift box.
	//
	// The buyer is always the caller; a `Gift` block routes the item (and box) to another
	// player, but the caller pays. Ownership is persisted at purchase — the gift box is
	// only the cosmetic "open it" moment, so the grant does not wait for the box to be
	// opened (see /api/avatar/v2/gifts/consume on the `api` worker, which just deletes it).
	//
	// `RequestedPrice` is the price the client rendered; rejecting a mismatch stops a stale
	// client (or a tampered request) from buying at a price the catalog no longer offers.
	.post(
		'/api/storefronts/v2/buyItem',
		describeRoute({
			tags: ['Storefront'],
			summary: 'Buy a storefront item',
			description: [
				'Looks the item up in its storefront catalog, confirms the client’s `RequestedPrice`',
				'still matches, debits the buyer atomically, grants the item (into the inventory or',
				'consumable table), and returns a gift box. A `Gift` block routes the item to another',
				'player, but the caller always pays. `Balance` in the response is the CHANGE (negated',
				'price), not the new total. Pushes a StorefrontBalancePurchase socket frame that SETS the',
				'buyer’s account-wide bucket to the RESULTING total, so the frame, this body and a',
				'`GET /balance` re-fetch all agree (`Delta` there is display-only).',
			].join(' '),
			security: AUTHED,
			requestBody: jsonBody(BuyItemRequest, 'The item, currency, price, and optional Gift'),
			responses: {
				200: json(BuyItemResponse, 'The purchase result (gift box + balance change)'),
				400: json(ErrorResponse, 'Invalid body, unavailable currency, or insufficient balance'),
				401: UNAUTHORIZED_RESPONSE,
				404: json(ErrorResponse, 'No such item'),
				409: json(ErrorResponse, 'The price has changed since the client rendered it'),
			},
		}),
		async (c) => {
			const id = await authedId(c)
			if (id === null) return unauthorized(c)

			const body = (await c.req.json().catch(() => null)) as Record<string, unknown> | null
			if (body === null || typeof body !== 'object' || Array.isArray(body)) {
				return c.json({ error: 'Invalid request body' }, 400)
			}
			const storefrontType = body.StorefrontType
			const purchasableItemId = body.PurchasableItemId
			const currencyType = body.CurrencyType
			const requestedPrice = body.RequestedPrice
			if (
				!Number.isInteger(storefrontType) ||
				!Number.isInteger(purchasableItemId) ||
				!Number.isInteger(currencyType) ||
				!Number.isInteger(requestedPrice)
			) {
				return c.json(
					{
						error:
							'StorefrontType, PurchasableItemId, CurrencyType and RequestedPrice are required',
					},
					400
				)
			}

			const item = await findStoreItem(c, storefrontType as number, purchasableItemId as number)
			if (item === null) return c.json({ error: 'Item not found' }, 404)

			const price = item.Prices.find((p) => p.CurrencyType === currencyType)
			if (price === undefined) {
				return c.json({ error: 'Currency type not available for this item' }, 400)
			}
			if (price.Price !== requestedPrice) {
				return c.json({ error: 'Price has changed' }, 409)
			}
			// The item's currency must be an account balance we can debit (RecCenterTokens et al),
			// not a room-scoped or non-spendable currency.
			if (!isSpendable(currencyType as number)) {
				return c.json({ error: 'Currency type is not spendable' }, 400)
			}

			const gift = (
				typeof body.Gift === 'object' && body.Gift !== null ? body.Gift : null
			) as GiftRequest | null
			const receiverId = Number.isInteger(gift?.ToPlayerId) ? (gift?.ToPlayerId as number) : id
			// A named (non-anonymous) gift shows the sender; a self-purchase or an anonymous gift
			// is attributed to the "Coach" system account (id 1), never a null/0 sender.
			const fromPlayerId = gift !== null && gift.Anonymous !== true ? id : COACH_ACCOUNT_ID
			const message = typeof gift?.Message === 'string' ? gift.Message : 'A gift for you <3'

			const startingTokens = intVar(c.env.STARTING_TOKENS, DEFAULT_STARTING_TOKENS)
			// Debit the buyer atomically; a false return means they couldn't afford it and
			// nothing changed, so no item is granted.
			const paid = await spendCurrency(
				c.env.DB,
				id,
				currencyType as number,
				price.Price,
				startingTokens
			)
			if (!paid) return c.json({ error: 'Insufficient balance' }, 400)

			// Grant the item to the recipient, with the gift box that renders it. A box (an
			// `IsQuery` drop, e.g. sf2's "4-Star Unique Box") rolls its prize in here, and
			// `granted.drop` is what the roll landed on — the response has to describe THAT, not
			// the box, or a query purchase answers with every item field empty and the client
			// draws an empty box.
			const granted = await grantGiftDrop(c, receiverId, item.GiftDrop, message)

			// Push the spend to the buyer (`id` — the caller is who was charged) so their client
			// updates without waiting for a `GET /balance` re-fetch. StorefrontBalancePurchase
			// SETS the account-wide bucket to the resulting total read back from D1, so it agrees
			// with both the response body below and any re-fetch instead of compounding with them
			// — see the frame rule above pushBalanceUpdate. Best-effort.
			const newBalance = await getBalance(c.env.DB, id, currencyType as number, startingTokens)
			await pushBalancePurchase(c, id, currencyType as number, -price.Price, newBalance)

			// The response mirrors a captured real buyItem: `Balance` is the change applied (the
			// negated price), not the resulting balance (the client reads its new total from
			// `GET /balance/:type`); `BalanceType` is -2 (account-wide, all platforms).
			return c.json({
				BalanceUpdates: [
					{
						UpdateResponse: 0,
						Data: [
							toBalanceUpdateData(
								granted,
								fromPlayerId,
								message,
								Number.isInteger(gift?.GiftContext) ? (gift?.GiftContext as number) : null
							),
						],
					},
				],
				Balance: -price.Price,
				CurrencyType: currencyType,
				BalanceType: ALL_PLATFORMS,
			})
		}
	)

	// Check out a whole shopping bag. [Authorize]. The client posts every line it has in the
	// bag — an item id, `DuplicateItemCount` copies, the unit price it rendered and an
	// optional Gift — plus the ONE storefront and the ONE currency they all share.
	//
	// The whole bag is debited in ONE `spendCurrency` call. Charging line by line would let a
	// bag half-succeed on a race with another spend, and would push a balance frame per line.
	//
	// The response is NOT buyItem's envelope. It is `{ Success, Error, error_id, Value }`
	// (`error_id` lowercase — the client renames that one member; the other three are
	// PascalCase), and `Value` is a BalanceUpdateResponse: the RESULTING `{ Balance,
	// CurrencyType, Platform }` — `Platform` there being a renamed `BalanceType`, i.e. the
	// bucket, not a store — plus ONE `BalanceUpdates` entry per REQUESTED item.
	//
	// Per-line reporting is that entry's `UpdateResponse`: a line that didn't sell comes back
	// non-OK with a null `GiftPackage`, and `AllowPartialSuccess` is what lets those sit
	// beside successful ones while `Success` stays true. Without it, one bad line refuses the
	// whole bag — `Success: false`, the reason in `Error`, a null `Value`, nothing charged.
	.post(
		'/api/items/bulkpurchase',
		describeRoute({
			tags: ['Storefront'],
			summary: 'Buy a bag of storefront items',
			description: [
				'Resolves every line against the bag’s storefront catalog (one read for the whole',
				'bag), confirms each line’s `RequestedPrice` still matches, debits the total in ONE',
				'atomic spend, grants what sold, and answers the `{ Success, Error, error_id, Value }`',
				'envelope. `Value.Balance` is the RESULTING total (not buyItem’s change) in the',
				'`Platform` bucket named beside it, and `BalanceUpdates` carries one entry per',
				'REQUESTED item, each with its own `UpdateResponse`. `AllowPartialSuccess` lets some',
				'of those be non-OK while `Success` stays true; without it a single bad line refuses',
				'the bag and nothing is charged.',
			].join(' '),
			security: AUTHED,
			requestBody: jsonBody(BulkPurchaseRequest, 'The bag: its lines, storefront and currency'),
			responses: {
				200: json(BulkPurchaseResponse, 'The bag’s result, or `Success: false` if nothing sold'),
				400: json(BulkPurchaseResponse, 'A request that could not be evaluated at all'),
				401: UNAUTHORIZED_RESPONSE,
			},
		}),
		async (c) => {
			const id = await authedId(c)
			if (id === null) return unauthorized(c)

			// Every refusal answers the same envelope, so a client that only knows how to parse
			// this shape never has to special-case one. A null `Value` is legal here (the client's
			// validator only cascades into a non-null one), and it is the honest answer: nothing
			// was bought, so there is no balance to report and nothing to render.
			const refuse = (error: string, status: 200 | 400 = 200) =>
				c.json({ Success: false, Error: error, error_id: null, Value: null }, status)

			const body = (await c.req.json().catch(() => null)) as {
				PurchaseItemRequests?: PurchaseItemRequest[]
				StorefrontType?: number
				CurrencyType?: number
				BypassGiftPackages?: boolean
				AllowPartialSuccess?: boolean
				ShoppingBagId?: string | number | null
			} | null
			if (body === null || typeof body !== 'object' || Array.isArray(body)) {
				return refuse('Invalid request body', 400)
			}
			const lines = body.PurchaseItemRequests
			if (!Array.isArray(lines) || lines.length === 0) {
				return refuse('PurchaseItemRequests must be a non-empty array', 400)
			}
			const storefrontType = body.StorefrontType
			const currencyType = body.CurrencyType
			if (!Number.isInteger(storefrontType) || !Number.isInteger(currencyType)) {
				return refuse('StorefrontType and CurrencyType are required', 400)
			}
			// The bag's currency must be an account balance we can debit, exactly as buyItem's.
			if (!isSpendable(currencyType as number)) {
				return refuse('Currency type is not spendable', 400)
			}
			const allowPartial = body.AllowPartialSuccess === true
			const skipGiftBox = body.BypassGiftPackages === true

			// One catalog read for the bag; every line resolves against it in memory.
			const storefront = await loadStorefront(c, storefrontType as number)
			const resolved = lines.map((line) =>
				resolveBulkLine(line, storefront, currencyType as number)
			)
			const buyable = resolved.filter(isBulkLine)

			const copies = buyable.reduce((n, line) => n + line.count, 0)
			if (copies > BULK_PURCHASE_CAP) {
				return refuse(`A bulk purchase is capped at ${BULK_PURCHASE_CAP} items`, 400)
			}
			// All-or-nothing: one unbuyable line stops the bag before anything is charged, and the
			// client is told why by the first thing that was wrong with it.
			const firstFailure = resolved.find((line): line is BulkLineFailure => !isBulkLine(line))
			if (!allowPartial && firstFailure !== undefined) return refuse(firstFailure.error)

			// Decide what the balance covers BEFORE spending: lines are taken in request order
			// while they fit, so a bag that overruns still buys the items the player put in first.
			// The read is only for choosing; the single spend below is what actually settles, and
			// its `amount >= ?` guard is what makes that safe against a concurrent spend.
			const startingTokens = intVar(c.env.STARTING_TOKENS, DEFAULT_STARTING_TOKENS)
			const balance = await getBalance(c.env.DB, id, currencyType as number, startingTokens)
			const affordable: BulkPurchaseLine[] = []
			let total = 0
			for (const line of buyable) {
				const cost = line.price * line.count
				if (total + cost > balance) continue
				total += cost
				affordable.push(line)
			}
			const bought = new Set(affordable)
			// Without partial success an unaffordable line fails the whole bag — including the
			// lines that would have fitted, since the player asked for all of it or none.
			if (!allowPartial && affordable.length !== buyable.length) {
				return refuse('Insufficient balance')
			}
			// Nothing sold at all: there is no purchase to report, so this is a refusal rather
			// than a `Success: true` bag full of non-OK entries.
			if (affordable.length === 0) {
				return refuse(firstFailure?.error ?? 'Insufficient balance')
			}

			// One atomic debit for the whole bag. A false return means another request spent the
			// tokens between the read above and here, so nothing is granted and nothing changed.
			if (
				total > 0 &&
				!(await spendCurrency(c.env.DB, id, currencyType as number, total, startingTokens))
			) {
				return refuse('Insufficient balance')
			}

			// A query drop (a loot box) rolls against sf3, the big catalog. Read it ONCE for the
			// whole bag and only when a line actually holds one — a bag of ordinary items should
			// not pull a thousand-item catalog in to grant them.
			const rollCatalog = affordable.some((line) => line.item.GiftDrop.IsQuery === true)
				? await loadRollCatalog(c)
				: undefined

			// Grant what sold, keeping each line's box so the entry built below can carry it.
			const packages = new Map<BulkPurchaseLine, Record<string, unknown> | null>()
			for (const line of affordable) {
				// Same routing as buyItem: a Gift block sends the item (and its box) to another
				// player while the caller pays, a named gift shows the sender, and a self-buy or an
				// anonymous gift is attributed to the "Coach" system account.
				const gift = line.gift
				const receiverId = Number.isInteger(gift?.ToPlayerId) ? (gift?.ToPlayerId as number) : id
				const fromPlayerId = gift !== null && gift.Anonymous !== true ? id : COACH_ACCOUNT_ID
				const message = typeof gift?.Message === 'string' ? gift.Message : 'A gift for you <3'
				// One box per requested item, holding all `count` copies — the wire has one
				// `GiftPackage` per entry, and only a consumable can be asked for more than once
				// (`resolveBulkLine` refuses a bigger count on anything owned once).
				const granted = await grantGiftDrop(c, receiverId, line.item.GiftDrop, message, {
					rollCatalog,
					skipGiftBox,
					copies: line.count,
				})
				packages.set(
					line,
					// Null under `BypassGiftPackages`, which is the flag asking for exactly that —
					// the item is granted either way.
					skipGiftBox
						? null
						: toGiftPackage(
								granted,
								receiverId,
								fromPlayerId,
								message,
								Number.isInteger(gift?.GiftContext) ? (gift?.GiftContext as number) : null
							)
				)
			}

			// One entry per REQUESTED item, in request order — the failures included, which is
			// where a partial bag says what it left behind.
			const updates = resolved.map((line) => {
				if (!isBulkLine(line)) {
					return {
						UpdateResponse: line.code,
						Data: {
							GiftPackage: null,
							PurchasableItemId: line.method.NumberId,
							CustomAvatarItem: null,
						} satisfies BulkPurchaseData,
					}
				}
				return {
					UpdateResponse: bought.has(line) ? UpdateResponse.OK : UpdateResponse.NotEnoughCredit,
					Data: {
						GiftPackage: packages.get(line) ?? null,
						PurchasableItemId: line.method.NumberId,
						CustomAvatarItem: null,
					} satisfies BulkPurchaseData,
				}
			})

			// One frame for the whole bag, not one per line: it SETS the account-wide bucket to the
			// resulting total read back from D1, so it agrees with the `Value.Balance` below and
			// with a `GET /balance` re-fetch instead of compounding — see the frame rule above
			// pushBalanceUpdate. Nothing moved on a free bag, so nothing is sent and the balance
			// read for the affordability check above still stands.
			let newBalance = balance
			if (total > 0) {
				newBalance = await getBalance(c.env.DB, id, currencyType as number, startingTokens)
				await pushBalancePurchase(c, id, currencyType as number, -total, newBalance)
			}
			return c.json({
				Success: true,
				Error: null,
				error_id: null,
				Value: {
					// The RESULTING total, unlike buyItem's change — and the bucket it belongs to.
					// `Platform` here is the client's `BalanceType` under a [DataMember] rename. A
					// capture from the reference server says 4 (RecNetPurchased) because it kept a
					// wallet per store; this server keeps ONE account-wide bucket, and the client SUMS
					// its buckets, so naming any other platform invents a second balance beside the
					// real one. See the frame rule above pushBalanceUpdate.
					Balance: newBalance,
					CurrencyType: currencyType,
					Platform: ALL_PLATFORMS,
					BalanceUpdates: updates,
				},
			})
		}
	)

	// Buy an invention. [Authorize]. A GET, despite being a purchase — the client sends
	// `?inventionId=…&requestedPrice=…` with no body, so that's what we answer.
	//
	// A priced invention is settled player-to-player: the buyer is debited its `Price` in
	// RecCenterTokens and the CREATOR is credited the same amount — no house cut, so the
	// tokens are moved rather than minted or burned. A free invention (`Price` 0) skips the
	// money entirely: nothing is debited and nobody is paid. The stored price is confirmed
	// against the price the client rendered first, so a stale or tampered client can't buy
	// at a price the creator no longer offers (409), and an unaffordable one is a 400 —
	// the same "Insufficient balance" buyItem answers with.
	//
	// Ownership is recorded in `inventory_invention`; the creator is not sold their own
	// invention (they own it already, via CreatorPlayerId) and a re-buy is a 409 rather
	// than a second row. The invention's `NumDownloads` counter is deliberately NOT
	// bumped: that column lives on the `invention` table the `api` worker owns, and this
	// worker only reads it.
	.get(
		'/api/storefronts/v2/buyInvention',
		describeRoute({
			tags: ['Storefront'],
			summary: 'Buy an invention',
			description: [
				'Looks the invention up by id, confirms the client’s `requestedPrice` still matches',
				'its stored `Price`, debits the buyer and pays the creator that price in',
				'RecCenterTokens (a free invention moves nothing), records ownership in',
				'`inventory_invention`, and returns the invention alongside the buyer’s resulting',
				'balance. When tokens moved, both players get a socket push carrying their RESULTING',
				'total — the buyer a StorefrontBalancePurchase, the CREATOR a StorefrontBalanceUpdate —',
				'which sets the account-wide bucket their client shows, agreeing with this body.',
				'A GET because that is how the client sends it.',
			].join(' '),
			security: AUTHED,
			parameters: [
				{
					name: 'inventionId',
					in: 'query',
					required: true,
					description: 'Invention id; missing or non-numeric is 400',
					schema: { type: 'integer' },
				},
				{
					name: 'requestedPrice',
					in: 'query',
					required: false,
					description: 'The price the client rendered; a mismatch is 409. Defaults to 0',
					schema: { type: 'integer' },
				},
			],
			responses: {
				200: json(BuyInventionResponse, 'The purchase result (invention + balance)'),
				400: json(
					ErrorResponse,
					'Missing/non-numeric inventionId, buying your own, or insufficient balance'
				),
				401: UNAUTHORIZED_RESPONSE,
				403: json(ErrorResponse, 'The invention is not published, so it is not for sale'),
				404: json(ErrorResponse, 'No such invention'),
				409: json(ErrorResponse, 'Already owned, or the price has changed'),
			},
		}),
		async (c) => {
			const id = await authedId(c)
			if (id === null) return unauthorized(c)

			const inventionId = Number.parseInt(c.req.query('inventionId') ?? '', 10)
			if (Number.isNaN(inventionId)) return c.json({ error: 'inventionId is required' }, 400)
			// Absent/non-numeric requestedPrice reads as 0, which only matches a free invention —
			// a priced one then fails the confirmation below rather than selling for nothing.
			const requestedPrice = Number.parseInt(c.req.query('requestedPrice') ?? '0', 10) || 0

			const invention = await getInventionById(c.env.DB, inventionId)
			if (invention === null) return c.json({ error: 'Invention not found' }, 404)
			// An unpublished invention is a draft: it isn't on sale, not even for free.
			if (!invention.IsPublished) return c.json({ error: 'Invention is not for sale' }, 403)
			if (invention.CreatorPlayerId === id) {
				return c.json({ error: 'Cannot buy your own invention' }, 400)
			}
			if (await ownsInvention(c.env.DB, id, inventionId)) {
				return c.json({ error: 'Already owned' }, 409)
			}

			// The price the client rendered must still be the stored one: a mismatch is a stale
			// catalog or a tampered request, never a sale.
			if (invention.Price !== requestedPrice) {
				return c.json({ error: 'Price has changed' }, 409)
			}

			const startingTokens = intVar(c.env.STARTING_TOKENS, DEFAULT_STARTING_TOKENS)
			// Inventions are priced in RecCenterTokens only — the store shows no other currency
			// for them, and `Price` carries no currency of its own to pick a different one from.
			const price = invention.Price
			if (price > 0) {
				// Debit the buyer atomically; false means they couldn't afford it and nothing
				// changed, so no ownership is recorded and the creator is not paid.
				const paid = await spendCurrency(
					c.env.DB,
					id,
					CurrencyType.RecCenterTokens,
					price,
					startingTokens
				)
				if (!paid) return c.json({ error: 'Insufficient balance' }, 400)
			}

			// Grant before paying out: these are three separate D1 writes with no transaction
			// around them, so order them by what a failure costs. A buyer who paid and got the
			// invention but left the creator unpaid is recoverable; a buyer charged for nothing
			// is not.
			await grantInvention(c.env.DB, id, inventionId)

			if (price > 0) {
				// Seed the creator's signup grant BEFORE crediting them: `creditCurrency` upserts
				// the balance row, and `ensureStartingBalances` is an INSERT OR IGNORE, so a
				// creator who had never touched their balance would otherwise have the row created
				// here and lose their starting tokens forever.
				await ensureStartingBalances(c.env.DB, invention.CreatorPlayerId, startingTokens)
				const creatorBalance = await creditCurrency(
					c.env.DB,
					invention.CreatorPlayerId,
					CurrencyType.RecCenterTokens,
					price,
					startingTokens
				)
				// The creator is a different, probably-online player with no response to read:
				// push the sale so it lands on their shown balance without a re-fetch. The frame
				// carries their resulting TOTAL (what `creditCurrency` returns), not the payout —
				// sending the payout would set their whole balance to it. A plain update rather
				// than a purchase frame: they sold, they didn't buy. Best-effort, as everywhere.
				await pushBalanceUpdate(
					c,
					invention.CreatorPlayerId,
					CurrencyType.RecCenterTokens,
					creatorBalance
				)
			}

			// Unlike buyItem — whose `Balance` is the change applied — the reference server
			// answers this one with the RESULTING total (a first read seeds the buyer's starting
			// grant, as everywhere else). The buyer's frame carries that same total, so the body
			// and the push land the client on one number.
			const balance = await getBalance(c.env.DB, id, CurrencyType.RecCenterTokens, startingTokens)
			// A free invention moved nothing, so there is no purchase to report.
			if (price > 0) {
				await pushBalancePurchase(c, id, CurrencyType.RecCenterTokens, -price, balance)
			}
			return c.json({
				BalanceUpdateResponse: {
					Balance: balance,
					BalanceType: ALL_PLATFORMS,
					CurrencyType: CurrencyType.RecCenterTokens,
					BalanceUpdates: [{ UpdateResponse: 0, Data: invention }],
				},
				// The same `{ Status, Invention, InventionVersion }` envelope the invention
				// save/read endpoints serve — the client re-renders the invention from it.
				InventionResponse: toSaveResult(invention),
			})
		}
	)

	// Storefront ad-carousel items. Served from the bundled static JSON — one
	// placeholder banner with no purchasable items until real promo data exists.
	.get(
		'/api/storefronts/v1/adcarouselitems',
		listRoute('Storefront ad-carousel items', 'The bundled carousel (one placeholder banner)'),
		(c) => c.json(adCarouselItems)
	)

	// Current weekly challenge. The rotation itself is the bundled static JSON (its format
	// is documented in the README) but each challenge's `Complete` is per-player, so the
	// caller's rows from `challenge_status` are stamped over the static `false`s.
	// Auth is OPTIONAL: without a valid bearer the static catalog is served unchanged
	// rather than 401, since the rotation is public information and a 404/401 on this
	// route can stall the client's load orchestration.
	.get(
		'/api/challenge/v2/getCurrent',
		describeRoute({
			tags: ['Econ'],
			summary: 'Current weekly challenge',
			description: [
				'The bundled static rotation, with each challenge’s `Complete` stamped from the',
				'caller’s progress rows. Auth is optional — unauthenticated callers get the static',
				'catalog with every `Complete` false.',
			].join(' '),
			security: OPTIONAL_AUTHED,
			responses: { 200: json(JsonObject, 'The current weekly challenge') },
		}),
		async (c) => {
			const id = await authedId(c)
			if (id === null) return c.json(weeklyChallenge)
			const complete = await getCompletedChallengeIds(c.env.DB, id, weeklyChallenge.ChallengeMapId)
			if (complete.size === 0) return c.json(weeklyChallenge)
			// Rebuild rather than mutate: the static import is module state shared by every
			// request this isolate serves, so stamping it in place would leak one player's
			// completions to the next caller.
			return c.json({
				...weeklyChallenge,
				Challenges: weeklyChallenge.Challenges.map((challenge) => ({
					...challenge,
					Complete: complete.has(challenge.ChallengeId),
				})),
			})
		}
	)

	// Report progress on a weekly challenge. [Authorize]. The client evaluates the
	// challenge's rule tree locally and posts ChallengeMapId/ChallengeId, that tree in
	// `Config`, and whether it now considers the challenge `Complete`. Only the
	// completion is persisted (keyed by account + challenge); `Config` is the catalog's
	// own definition plus the client's running count, so storing it would duplicate
	// static data. Echoes the identifying fields back with the completion the row now
	// holds — which is not always what was posted, since completion latches within a
	// rotation.
	.post(
		'/api/challenge/v2/updateProgress',
		describeRoute({
			tags: ['Econ'],
			summary: 'Report weekly-challenge progress',
			description: [
				'Persists the reported completion into `challenge_status`, keyed by account +',
				'challenge. `Config` is accepted and echoed but not stored. Completion latches within',
				'a rotation, so the echoed `Complete` is the stored value, not the posted one.',
			].join(' '),
			security: AUTHED,
			requestBody: jsonBody(ChallengeProgressRequest, 'Challenge ids + the evaluated rule tree'),
			responses: {
				200: json(ChallengeProgressResponse, 'Echoed fields with the stored completion'),
				401: UNAUTHORIZED_RESPONSE,
			},
		}),
		async (c) => {
			const id = await authedId(c)
			if (id === null) return unauthorized(c)
			const body = await c.req
				.json<{
					ChallengeMapId?: string | number
					ChallengeId?: string | number
					Config?: string
					Complete?: string | boolean
				}>()
				.catch(() => ({}) as Record<string, never>)
			const challengeMapId = Number(body.ChallengeMapId) || 0
			const challengeId = Number(body.ChallengeId) || 0
			// Nothing to key a row on — echo the body back rather than writing a (0, 0) row.
			const complete =
				challengeId === 0
					? parseBool(body.Complete)
					: await recordChallengeProgress(c.env.DB, id, {
							challengeMapId,
							challengeId,
							complete: parseBool(body.Complete),
						})
			// This report may have been the last one of the set. Only a completing report on
			// the LIVE rotation can be — an old rotation's set can no longer be finished, and
			// an unfinished challenge means the set isn't either, so neither is worth a read.
			// The response is unchanged whether or not a gift was won: the client learns about
			// the box from `GET /api/avatar/v2/gifts`, and adding a field here would be
			// inventing response shape the client never sent us.
			if (complete && challengeId !== 0 && challengeMapId === weeklyChallenge.ChallengeMapId) {
				await awardChallengeGift(c, id)
			}
			return c.json({
				ChallengeMapId: challengeMapId,
				ChallengeId: challengeId,
				Config: typeof body.Config === 'string' ? body.Config : '',
				Complete: complete,
			})
		}
	)

	// Pending game rewards. Returns "[]".
	.get('/api/gamerewards/v1/pending', listRoute('Pending game rewards', 'Empty for now'), (c) =>
		c.json([])
	)

	// Request a game reward. [Authorize]. The client asks whenever it thinks one is due,
	// posting the type and the message to show for it (`rewardType=FirstActivityOfDay&
	// Message=First Game of the Day`, or `rewardType=PostGameActivity&Message=Activity
	// completed!&giftContext=Soccer`) — so whether a reward is actually OWED is decided
	// here, from `reward_status`: one claim per type per activity per hour, atomically.
	//
	// A claim pays GAME_REWARD_XP into `progression` and hands over a gift box carrying that
	// XP, announced with the same GiftPackageReceivedImmediate frame the weekly gift uses —
	// the client posted the message to show, so the box wears it. An on-cooldown ask changes
	// nothing and pays nothing.
	//
	// The response stays `[]` either way. It is what the client already accepts, and the box
	// is how a reward is delivered, so there is no captured shape to put the payout in — the
	// reference answers its own (different, selection-based) flow with a success envelope,
	// not a list of rewards.
	//
	// `giftContext` (the activity, e.g. `Soccer`) is part of the cooldown key: the first
	// activity of the day is per ACTIVITY, so a player who moves from Soccer to Paintball is
	// owed another reward while a second Soccer match inside the hour is not. An ask that
	// sends no context keys on `''`.
	.post(
		'/api/gamerewards/v1/request',
		describeRoute({
			tags: ['Econ'],
			summary: 'Request a game reward',
			description: [
				'Claims one reward of `rewardType` in `giftContext` per hour per player, recorded in',
				'`reward_status`. The cooldown is per (type, activity), so a different activity is',
				'owed another reward while the same one is not; an ask with no `giftContext` keys on',
				'the empty context. The reward rides in a gift box, so a claim and a rejected',
				'(on-cooldown) ask both answer `[]`.',
			].join(' '),
			security: AUTHED,
			requestBody: form(GameRewardRequest, 'The reward type and its display message'),
			responses: {
				200: json(JsonArray, 'The rewards granted — always [] while the payload is stubbed'),
				401: UNAUTHORIZED_RESPONSE,
			},
		}),
		async (c) => {
			const id = await authedId(c)
			if (id === null) return unauthorized(c)
			const body = await c.req.parseBody().catch(() => ({}) as Record<string, unknown>)
			const rewardType = typeof body.rewardType === 'string' ? body.rewardType : ''
			// No type, nothing to gate: don't write a row keyed on an empty string.
			if (rewardType === '') return c.json([])
			const giftContext = typeof body.giftContext === 'string' ? body.giftContext : ''
			const claimed = await claimReward(c.env.DB, id, rewardType, giftContext)
			// On cooldown: nothing was claimed, so nothing is paid and nothing is announced.
			if (claimed === null) return c.json([])
			const message =
				typeof body.Message === 'string' && body.Message !== ''
					? body.Message
					: DEFAULT_GAME_REWARD_MESSAGE
			// Bank the XP first: it is the reward, and the box is the wrapper the client shows.
			// A failure here must not leave a box promising XP that was never credited.
			const { progression, levelsGained } = await addXp(c.env.DB, id, GAME_REWARD_XP)
			const granted = await grantGiftDrop(c, id, toGameRewardDrop(), message)
			await pushGiftReceived(c, id, granted, message, COACH_ACCOUNT_ID)
			// Every grant moves the bar, whether or not it crossed a level.
			await pushProgressionUpdate(c, id, progression)
			// …and every level crossed is worth a box of its own tier.
			await grantLevelUpGifts(c, id, { progression, levelsGained })
			logger.info('game reward claimed', {
				accountId: id,
				rewardType,
				giftContext,
				grantCount: claimed,
				message,
				xp: GAME_REWARD_XP,
				level: progression.Level,
				levelsGained,
				levelXp: progression.XP,
				giftId: granted.id,
			})
			return c.json([])
		}
	)

	// The player's room keys. Returns "[]".
	.get('/api/roomkeys/v1/mine', listRoute('The player’s room keys', 'Empty for now'), (c) =>
		c.json([])
	)
	// Room keys for a given room (client calls this on the econ host). [] with no DB.
	.get('/api/roomkeys/v1/room', listRoute('Room keys for a room', 'Empty for now'), (c) =>
		c.json([])
	)

	// The Rec Room Plus sign-up bonus: which bonus is running and the token price window
	// the free items are drawn from. Fixed numbers, the same for every caller.
	//
	// Unauthenticated, like the subscription lookup below and for the same reason: the
	// client reads this while putting the RR+ page together, nothing in the answer is
	// per-account, and a 401 would only be a way for that load to stall. (The `api` copy of
	// this path does validate a token, mirroring the reference server.)
	.get(
		'/api/CampusCard/v1/SignUpBonus',
		describeRoute({
			tags: ['Econ'],
			summary: 'Rec Room Plus sign-up bonus',
			description: [
				'The bonus a player gets for taking out Rec Room Plus: which bonus is running',
				'(`RRPlusSignUpBonusId`) and the token price window the free items are picked from.',
				'Fixed values — nothing here is per-account or stored, so no auth is required and',
				'every caller gets the same three numbers.',
			].join(' '),
			responses: { 200: json(RRPlusSignUpBonus, 'The running sign-up bonus') },
		}),
		(c) =>
			c.json({
				RRPlusSignUpBonusId: 3,
				MinFreeItemsPrice: 6000,
				MaxFreeItemsPrice: 10000,
			})
	)

	// Subscription lookup (Rec Room Plus, the client's `CampusCard`). There is no store to
	// buy one from, so the `developer` role stands in for a paid subscription: a developer
	// reports an active Gold year, everyone else reports none. Nothing is stored — see
	// `developerSubscription`.
	//
	// Auth is OPTIONAL, and a missing or invalid token answers "no subscription" rather than
	// 401: the client posts this while loading, so an error here can stall its load
	// orchestration, and "you aren't subscribed" is the truthful answer for an anonymous
	// caller anyway. The role is read from the token's `role` claim, never from the body.
	.post(
		'/api/CampusCard/v1/UpdateAndGetSubscription',
		describeRoute({
			tags: ['Econ'],
			summary: 'Subscription lookup',
			description: [
				'The caller’s Rec Room Plus subscription. Nothing sells subscriptions here, so the',
				'operator-granted `developer` role stands in for one: a developer’s token reports an',
				'active Gold (`Level` 0) yearly (`Period` 1) subscription on `PlatformType` -1 (All),',
				'expiring a year from the call, and every other caller gets `{}`. Auth is optional —',
				'a missing or invalid token reads as “not subscribed”, not 401. Nothing is persisted:',
				'the role IS the subscription, so revoking it revokes this.',
			].join(' '),
			responses: {
				200: json(SubscriptionResponse, 'The subscription, or `{}` for no subscription'),
			},
		}),
		async (c) => {
			const roles = await authedRoles(c)
			if (!roles?.includes(DEVELOPER_ROLE)) return c.json({})
			const id = await authedId(c)
			if (id === null) return c.json({})
			return c.json({
				Subscription: developerSubscription(id),
				PlatformAccountSubscribedPlayerId: null,
			})
		}
	)

	// The subscription seasons running right now (the RR+ seasonal reward tracks). Nothing
	// here runs a season, so this is an empty-list stub — the client reads it as "no season
	// in progress" and skips the seasonal UI, where a 404 stalls the RR+ page load.
	.get(
		'/api/subscriptionseasons/v1/seasons/current',
		listRoute('Current subscription seasons', 'Empty stub — no RR+ season is running'),
		(c) => c.json([])
	)

	// Whether the caller can start a Maker AI free trial. Always false, mirroring the
	// reference server: nothing here runs trials, and false is the answer that leaves the
	// client's creation UI in its normal state rather than offering a trial that can't
	// start. The body is a BARE JSON `false` — not an envelope, not `{ value: false }`.
	//
	// Auth-gated (401 on a missing or invalid token) even though the answer is the same for
	// everyone, because the reference validates the token before answering and eligibility
	// is a per-account question the moment anything does run trials.
	.get(
		'/api/makerai/checkfreetrialeligibility',
		describeRoute({
			tags: ['Econ'],
			summary: 'Maker AI free-trial eligibility',
			description: [
				'Whether the caller can start a Maker AI free trial. Always `false` — nothing here',
				'runs trials. The body is a bare JSON boolean, not an envelope.',
			].join(' '),
			security: AUTHED,
			responses: {
				200: json(MakerAiFreeTrialEligibilityResponse, 'Always `false`'),
				401: UNAUTHORIZED_RESPONSE,
			},
		}),
		async (c) => {
			const id = await authedId(c)
			if (id === null) return unauthorized(c)
			return c.json(false)
		}
	)

	// The caller's progress through the refer-a-friend rewards: how many of their referrals
	// have been verified, and which rewards they have taken from that track.
	//
	// Nothing here runs a referral programme, so nobody has referred anybody: the count is 0
	// and the reward list is empty. That is a real answer rather than a stub — it is what a
	// player who has referred nobody sees — so the client draws an untouched track, which is
	// exactly the state this server is in.
	//
	// The payload is NESTED under `value`, unlike econ's flat balance bodies.
	.get(
		'/api/incentivizedreferrals/progress',
		describeRoute({
			tags: ['Econ'],
			summary: 'The caller’s referral-reward progress',
			description: [
				'How many of the caller’s referrals have been verified and which referral rewards they',
				'have claimed, under a `{ success, value }` envelope. Always 0 and empty — no referral',
				'programme runs here — which the client renders as an untouched reward track.',
			].join(' '),
			security: AUTHED,
			responses: {
				200: json(ReferralProgressResponse, 'The caller’s progress — always zero'),
				401: UNAUTHORIZED_RESPONSE,
			},
		}),
		async (c) => {
			const id = await authedId(c)
			if (id === null) return unauthorized(c)
			return c.json({
				success: true,
				value: { ReferralsVerifiedCount: 0, PlayerReferralRewards: [] },
			})
		}
	)

	// Everyone in the influencer partner program, by account id — the list the client keeps
	// so it can badge an influencer wherever they turn up, rather than asking per player.
	//
	// Empty: no programme runs here, so there is nobody to list. Note this is the LIST
	// counterpart of the single-account check below, and the two answer very differently —
	// that one 404s to say "not an influencer", this one is a 200 carrying an empty list,
	// because "nobody is" is a complete answer to "who is?".
	//
	// `take` is accepted and ignored; there is nothing to page through.
	.get(
		'/api/influencerpartnerprogram/influencers',
		describeRoute({
			tags: ['Econ'],
			summary: 'Every influencer in the partner program',
			description: [
				'The account ids in the influencer partner program, as `{ InfluencerIds }` — an object',
				'around the list, not a bare array. Always empty here: no programme runs on this',
				'server. `take` is accepted and ignored, there being nothing to page.',
			].join(' '),
			security: AUTHED,
			parameters: [
				{
					name: 'take',
					in: 'query',
					required: false,
					description: 'How many ids to return. Accepted and ignored.',
					schema: { type: 'integer' },
				},
			],
			responses: {
				200: json(InfluencerIdsResponse, 'The influencer ids — always empty'),
				401: UNAUTHORIZED_RESPONSE,
			},
		}),
		async (c) => {
			const id = await authedId(c)
			if (id === null) return unauthorized(c)
			return c.json({ InfluencerIds: [] })
		}
	)

	// Whether the caller is in the influencer partner program. NOBODY is: this server runs
	// no such program, and "not an influencer" is a 404 rather than a body saying so — the
	// reference answers 404 with an EMPTY body typed `application/json`, which is what the
	// client branches on. A 200 carrying null or `{}` is a different answer to it.
	//
	// Deliberately built by hand rather than through `c.notFound()`: the worker's not-found
	// handler answers its own body, and this has to be empty with that content type.
	//
	// `accountId` is accepted and ignored — the reference binds it and never reads it, the
	// answer being the same for everyone. The token is still validated first, so an
	// unauthenticated caller gets 401 rather than the 404.
	.get(
		'/api/influencerpartnerprogram/influencer',
		describeRoute({
			tags: ['Econ'],
			summary: 'The caller’s influencer partner program status',
			description: [
				'Always 404 with an EMPTY body typed `application/json` — this server runs no partner',
				'program, and 404 is how the reference says “not an influencer”. `accountId` is',
				'accepted and ignored; the answer is the same for every caller. Auth is checked first,',
				'so a missing or invalid token is 401, not 404.',
			].join(' '),
			security: AUTHED,
			parameters: [
				{
					name: 'accountId',
					in: 'query',
					required: false,
					description: 'The account being asked about. Accepted and ignored.',
					schema: { type: 'integer' },
				},
			],
			responses: {
				404: { description: 'Not in the partner program — always. Empty body' },
				401: UNAUTHORIZED_RESPONSE,
			},
		}),
		async (c) => {
			const id = await authedId(c)
			if (id === null) return unauthorized(c)
			return c.body('', 404, { 'Content-Type': 'application/json' })
		}
	)

// The generated spec. Documentation only — no request is validated against it (see
// openapi.ts). `hide: true` keeps this route out of its own output.
app.get(
	'/openapi.json',
	describeRoute({ hide: true }),
	withCleanSpec(
		openAPIRouteHandler(app, {
			documentation: {
				info: {
					title: 'recflare econ',
					version: '1.0.0',
					description: [
						'Avatar and economy endpoints for recflare, a private-server reimplementation of the',
						'Rec Room backend. The client calls these on the `econ` host; many are also served by',
						'the `api` worker. Storefront catalogs are static assets (`sf{N}.json`); balances,',
						'inventory, consumables, saved outfits and gift boxes are D1-backed.',
					].join('\n'),
				},
				servers: [{ url: 'https://econ.recflare.net', description: 'Production' }],
				components: {
					securitySchemes: {
						bearerAuth: {
							type: 'http',
							scheme: 'bearer',
							bearerFormat: 'JWT',
							description: 'An `access_token` from the auth worker’s `POST /connect/token`.',
						},
					},
				},
			},
		})
	)
)

export default app
