import { Hono } from 'hono'
import { describeRoute, openAPIRouteHandler } from 'hono-openapi'
import { useWorkersLogger } from 'workers-tagged-logger'

import {
	consumeGift,
	createGift,
	getGift,
	getPendingGifts,
	grantInvention,
	ownsInvention,
} from '@repo/domain'
import { intVar, logger, withCleanSpec, withNotFound, withOnError } from '@repo/hono-helpers'
import { validateAndGetAccountId } from '@repo/jwt'

// Invention storage (owned by the `api` worker, on this same `recflare` database).
// Imported directly rather than copied: these are plain D1 helpers with no bindings of
// their own, and buyInvention has to read the very rows `api` writes.
import { getInventionById, toSaveResult } from '../../api/src/inventions-db'
// The notification-type ids the hub carries (owned by the `notify` worker). Imported
// as a value — the enum has no runtime dependencies.
import { NotificationType } from '../../notify/src/notification-types'
import adCarouselItems from '../static/ad-carousel-items.json'
import defaultAvatarItems from '../static/default-avatar-items.json'
import defaultAvatar from '../static/default-avatar.json'
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
	consumeConsumable,
	countConsumable,
	getConsumables,
	grantConsumable,
} from './consumables-db'
import { getEquipment, grantEquipment, setEquipmentFavorited } from './equipment-db'
import { getInventory, grantItem } from './inventory-db'
import {
	AUTHED,
	AvatarV2Dto,
	BalanceEntry,
	BuyInventionResponse,
	BuyItemRequest,
	BuyItemResponse,
	ChallengeProgressRequest,
	ChallengeProgressResponse,
	ConsumeConsumableRequest,
	ConsumeEnvelope,
	ConsumeGiftRequest,
	CustomAvatarItemsResponse,
	EquipmentUpdateRequest,
	ErrorResponse,
	form,
	json,
	JsonArray,
	jsonBody,
	JsonObject,
	OpaqueJsonBody,
	SaveOutfitRequest,
	SaveOutfitV4Response,
	SubscriptionResponse,
	UNAUTHORIZED_RESPONSE,
	UpdateObjectiveRequest,
	UpdateObjectiveResponse,
} from './openapi'
import { getOutfits, setOutfit } from './outfit-db'

import type { Context } from 'hono'
import type { GiftContent, StoredGift } from '@repo/domain'
import type { Avatar } from './avatar-db'
import type { ConsumeResult } from './consumables-db'
import type { App } from './context'
import type { Equipment } from './equipment-db'
import type { AvatarItem } from './inventory-db'
import type { Outfit } from './outfit-db'

/**
 * Economy Worker. Hosts the avatar/economy endpoints the game client calls on
 * the `econ` service (these are separate from the main `api` worker). Balances,
 * inventory (avatar items, equipment, bought inventions), consumables, saved outfits,
 * avatars and gift boxes are D1-backed;
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

/** Results.Unauthorized() equivalent — 401 with empty body. */
function unauthorized(c: Context<App>) {
	return c.body(null, 401)
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
 * Push a StorefrontBalanceUpdate to a player after their balance changes, mirroring the
 * reference's
 * `HubSendToPlayer(accountID, NotifFrame(StorefrontBalanceUpdate, {Balance, CurrencyType, BalanceType}))`.
 * The client applies it to the shown balance so a purchase reflects immediately, without
 * waiting for a `GET /balance` re-fetch.
 *
 * `Balance` is the CHANGE — negative for a debit, positive for a payout — not the
 * resulting total. The client ADDS what it receives to the balance it is already showing,
 * so sending the total made a 10,000-token player who earned 250 read 20,250: their own
 * balance plus the new total. That also makes this frame non-idempotent, so push exactly
 * once per change and never re-send it as a "refresh".
 *
 * `BalanceType` is -2 (account-wide, all platforms). Best-effort: a hub failure is logged
 * and swallowed, since the balance change has already committed.
 */
async function pushBalanceUpdate(
	c: Context<App>,
	accountId: number,
	currencyType: number,
	change: number
): Promise<void> {
	try {
		await c.env.RECFLARE_NOTIFICATIONS_HUB.getByName(HUB_INSTANCE).notifyPlayer(
			accountId,
			NotificationType.StorefrontBalanceUpdate,
			{
				Balance: change,
				CurrencyType: currencyType,
				BalanceType: ALL_PLATFORMS,
			}
		)
	} catch (err) {
		logger.error('failed to push StorefrontBalanceUpdate notification', {
			accountId,
			error: err instanceof Error ? err.message : String(err),
		})
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
 * Look up a store item by (storefront type, purchasable item id), reading the catalog
 * from the ASSETS binding (`sf{type}.json`). Returns null when there is no such
 * storefront or no item with that id in it.
 */
async function findStoreItem(
	c: Context<App>,
	storefrontType: number,
	purchasableItemId: number
): Promise<StoreItem | null> {
	const res = await c.env.ASSETS.fetch(new URL(`/sf${storefrontType}.json`, c.req.url))
	if (!res.ok) return null
	const storefront = (await res.json()) as Storefront
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
		Xp: 0,
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

	// Default base avatar items — empty stub for now. No auth.
	.get(
		'/api/avatar/v1/defaultbaseavataritems',
		listRoute('Default base avatar items', 'Empty stub for now'),
		(c) => c.json([])
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
			].join(' '),
			security: AUTHED,
			responses: {
				200: json(JsonArray, 'Owned items followed by the default catalog'),
				401: UNAUTHORIZED_RESPONSE,
			},
		}),
		async (c) => {
			const id = await authedId(c)
			if (id === null) return unauthorized(c)
			const owned = await getInventory(c.env.DB, id)
			return c.json([...owned, ...defaultAvatarItems])
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

	// NUX checklist — the client fetches this on the econ host during load. []
	// with no DB. A 404 here can abort the load orchestration before matchmake.
	.get(
		'/api/checklist/v1/current',
		listRoute('NUX checklist', 'The new-user checklist; [] for now. A 404 can abort load.', true),
		async (c) => {
			const id = await authedId(c)
			if (id === null) return unauthorized(c)
			return c.json([])
		}
	)

	// The player's item wishlist. [Authorize]; empty without a DB binding.
	.get(
		'/api/itemWishlists/v1/wishlist/me',
		listRoute('The player’s item wishlist', 'Empty for now', true),
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
				'price), not the new total. Pushes a StorefrontBalanceUpdate socket frame carrying the',
				'same change, which the client ADDS to the balance it is showing.',
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

			// Grant the item to the recipient. A gift-drop carries an avatar item, a consumable,
			// an equipment skin, or none of these (currency/xp drops aren't granted yet); grant
			// whichever it actually has.
			if (typeof item.GiftDrop.AvatarItemDesc === 'string' && item.GiftDrop.AvatarItemDesc !== '') {
				await grantItem(c.env.DB, receiverId, toAvatarItem(item.GiftDrop))
			}
			if (
				typeof item.GiftDrop.EquipmentModificationGuid === 'string' &&
				item.GiftDrop.EquipmentModificationGuid !== ''
			) {
				await grantEquipment(c.env.DB, receiverId, toEquipment(item.GiftDrop))
			}
			const isConsumable =
				typeof item.GiftDrop.ConsumableItemDesc === 'string' &&
				item.GiftDrop.ConsumableItemDesc !== ''
			const consumableCount = isConsumable ? CONSUMABLE_GRANT_COUNT : 0
			// Capture the granted consumable's row id and the player's pre-existing count so
			// the gift box can carry them — gift-consume fires ConsumableMappingAdded from these.
			let consumableMappingId = 0
			let consumablePreExisting = 0
			if (isConsumable) {
				consumablePreExisting = await countConsumable(
					c.env.DB,
					receiverId,
					item.GiftDrop.ConsumableItemDesc
				)
				consumableMappingId = await grantConsumable(
					c.env.DB,
					receiverId,
					item.GiftDrop.ConsumableItemDesc,
					consumableCount
				)
			}
			const { id: giftId } = await createGift(
				c.env.DB,
				receiverId,
				toGiftContent(
					item.GiftDrop,
					message,
					consumableCount,
					consumableMappingId,
					consumablePreExisting
				)
			)

			// Push the debit over the socket so the buyer's client updates the shown total
			// immediately — the buyer (`id`) is who was charged, in the currency they spent. The
			// frame carries the CHANGE, so a purchase is negative. Best-effort; the HTTP response
			// carries the same change either way.
			await pushBalanceUpdate(c, id, currencyType as number, -price.Price)

			// The response mirrors a captured real buyItem: `Balance` is the change applied (the
			// negated price), not the resulting balance (the client reads its new total from
			// `GET /balance/:type`); `BalanceType` is -2 (account-wide, all platforms). The Data
			// entry is the gift-drop the client received — it carries no FriendlyName or
			// consumable count (the count is a getUnlocked concept; each box is one instance).
			return c.json({
				BalanceUpdates: [
					{
						UpdateResponse: 0,
						Data: [
							{
								Id: giftId,
								FromPlayerId: fromPlayerId,
								ConsumableItemDesc: item.GiftDrop.ConsumableItemDesc,
								AvatarItemDesc: item.GiftDrop.AvatarItemDesc,
								AvatarItemType: item.GiftDrop.AvatarItemType ?? 0,
								EquipmentPrefabName: item.GiftDrop.EquipmentPrefabName,
								EquipmentModificationGuid: item.GiftDrop.EquipmentModificationGuid,
								CurrencyType: item.GiftDrop.CurrencyType,
								Currency: item.GiftDrop.Currency,
								Xp: 0,
								Level: 0,
								Platform: -1,
								PlatformsToSpawnOn: -1,
								BalanceType: ALL_PLATFORMS,
								GiftContext: Number.isInteger(gift?.GiftContext)
									? (gift?.GiftContext as number)
									: item.GiftDrop.Context,
								GiftRarity: item.GiftDrop.Rarity,
								Message: message,
							},
						],
					},
				],
				Balance: -price.Price,
				CurrencyType: currencyType,
				BalanceType: ALL_PLATFORMS,
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
				'balance. When tokens moved, both players get a StorefrontBalanceUpdate push carrying',
				'their CHANGE (the buyer’s negative, the creator’s positive), which the client adds to',
				'the balance it is showing — unlike this response body, which replaces it.',
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
				await creditCurrency(
					c.env.DB,
					invention.CreatorPlayerId,
					CurrencyType.RecCenterTokens,
					price,
					startingTokens
				)
				// The creator is a different, probably-online player: push the payout so a sale
				// lands on their shown balance without a re-fetch. Positive, because the frame
				// carries the change. Best-effort, as everywhere.
				await pushBalanceUpdate(c, invention.CreatorPlayerId, CurrencyType.RecCenterTokens, price)
			}

			// Unlike buyItem — whose `Balance` is the change applied — the reference server
			// answers this one with the RESULTING total (a first read seeds the buyer's starting
			// grant, as everywhere else). The socket frame below is the other way round: the HTTP
			// body REPLACES the shown balance, the push ADDS to it.
			const balance = await getBalance(c.env.DB, id, CurrencyType.RecCenterTokens, startingTokens)
			// A free invention moved nothing, so there is no change to push for it.
			if (price > 0) {
				await pushBalanceUpdate(c, id, CurrencyType.RecCenterTokens, -price)
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

	// Current weekly challenge. Served from the bundled static JSON until
	// per-rotation challenge data is wired up.
	.get(
		'/api/challenge/v2/getCurrent',
		describeRoute({
			tags: ['Econ'],
			summary: 'Current weekly challenge',
			description: 'Served from the bundled static challenge until per-rotation data is wired up.',
			responses: { 200: json(JsonObject, 'The current weekly challenge') },
		}),
		(c) => c.json(weeklyChallenge)
	)

	// Report progress on a weekly challenge. The client evaluates the challenge's rule
	// tree locally and posts ChallengeMapId/ChallengeId, that tree in `Config`, and
	// whether it now considers the challenge `Complete`. Stubbed: with no challenge-
	// progress DB yet we persist nothing and never mark a challenge complete (so the
	// gift flow isn't triggered). Echo the identifying fields back with Complete=false
	// so the client gets a well-formed, non-null body to deserialize.
	.post(
		'/api/challenge/v2/updateProgress',
		describeRoute({
			tags: ['Econ'],
			summary: 'Report weekly-challenge progress',
			description: [
				'Stubbed: with no challenge-progress store we persist nothing and never mark a',
				'challenge complete. Echoes the identifying fields back with `Complete: false` so the',
				'client gets a well-formed body.',
			].join(' '),
			requestBody: jsonBody(ChallengeProgressRequest, 'Challenge ids + the evaluated rule tree'),
			responses: { 200: json(ChallengeProgressResponse, 'Echoed fields, Complete false') },
		}),
		async (c) => {
			const body = await c.req
				.json<{
					ChallengeMapId?: string | number
					ChallengeId?: string | number
					Config?: string
				}>()
				.catch(() => ({}) as Record<string, never>)
			return c.json({
				ChallengeMapId: Number(body.ChallengeMapId) || 0,
				ChallengeId: Number(body.ChallengeId) || 0,
				Config: typeof body.Config === 'string' ? body.Config : '',
				Complete: false,
			})
		}
	)

	// Pending game rewards. Returns "[]".
	.get('/api/gamerewards/v1/pending', listRoute('Pending game rewards', 'Empty for now'), (c) =>
		c.json([])
	)

	// Request a game reward (client posts `rewardType`/`Message`, e.g.
	// FirstActivityOfDay). Stubbed: with no reward DB yet we grant nothing and return an
	// empty list of rewards — matching the `pending` shape so the client deserializes it.
	.post(
		'/api/gamerewards/v1/request',
		listRoute('Request a game reward', 'Stubbed — grants nothing, returns []'),
		(c) => c.json([])
	)

	// The player's room keys. Returns "[]".
	.get('/api/roomkeys/v1/mine', listRoute('The player’s room keys', 'Empty for now'), (c) =>
		c.json([])
	)
	// Room keys for a given room (client calls this on the econ host). [] with no DB.
	.get('/api/roomkeys/v1/room', listRoute('Room keys for a room', 'Empty for now'), (c) =>
		c.json([])
	)

	// Subscription lookup. Returns both fields null with no auth.
	.post(
		'/api/CampusCard/v1/UpdateAndGetSubscription',
		describeRoute({
			tags: ['Econ'],
			summary: 'Subscription lookup',
			description: 'No subscriptions yet — both fields null. No auth.',
			responses: { 200: json(SubscriptionResponse, 'Both fields null') },
		}),
		(c) => c.json({ subscription: null, platformAccountSubscribedPlayerId: null })
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
