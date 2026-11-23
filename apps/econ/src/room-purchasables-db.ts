/**
 * Everything a room sells, in one list — what `GET /api/ugcPurchasables/v1/items/room/:roomId`
 * answers. There is no table of its own: the list is assembled on read from the tables that
 * hold a room's listings — `room_key` (room-key-db), `room_consumable` (room-consumable-db),
 * the purchase offers inside `room_currency` (room-currency-db) and `room_offer`
 * (room-offer-db) — each projected into the client's 10-key `UgcPurchasableItem` with
 * `ItemType` saying which it is. One shape for four kinds of thing, which is the point of the route: the client
 * draws the room's shop from it without knowing which table a line came from.
 */
import { getRoomConsumables } from './room-consumable-db'
import { getPurchaseOffers, getRoomCurrencies } from './room-currency-db'
import { getRoomKeys } from './room-key-db'
import { getRoomOffers } from './room-offer-db'

/**
 * The client's `UGCPurchasableItemType` enum, numeric on the wire: RoomKey 0, RoomConsumable 1,
 * RoomCurrencyPurchaseOffer 2, CustomAvatarItem 3, StoreUGCAvatarItem 4, RoomOffer 5,
 * UNDEFINED 6. The same numbering as the `itemType` inside the `{ itemType, itemId }`
 * reference `…/items/bulk` and `/api/items/purchaseInfos` take, where a custom avatar item is
 * 3 (`UGC_ITEM_TYPE_CUSTOM_AVATAR_ITEM`). Currency packs were once served as 3 here, from an
 * earlier misreading of the enum — which the client reads as a custom avatar item.
 */
export const ROOM_PURCHASABLE_TYPE = {
	roomKey: 0,
	roomConsumable: 1,
	roomCurrencyPurchaseOffer: 2,
	customAvatarItem: 3,
	storeUgcAvatarItem: 4,
	roomOffer: 5,
} as const

/**
 * One line of a room's shop — the client's `UgcPurchasableItem`, 10 keys. `ItemId` is a bare
 * GUID string, with the kind beside it as `ItemType`, not the `{ itemType, itemId }` struct
 * the bulk lookups use. `Price` is a `long` in the client's model. `ImageName` is null for a
 * listing with no art, as the key and consumable routes already serve it.
 */
export interface RoomPurchasable {
	ItemType: number
	ItemId: string
	Name: string
	Description: string
	ImageName: string | null
	RoomId: number
	Price: number
	/** A `room_currency` id the line is charged in, or null for tokens. */
	PurchaseCurrencyId: string | null
	/** ISO-8601 UTC. */
	CreatedAt: string
	/** ISO-8601 UTC. */
	ModifiedAt: string
}

/**
 * A room's shop: its keys, then its consumables, then the purchase offers of each of its
 * currencies, then its room offers. Each kind keeps its own module's order. A room that sells nothing is `[]` —
 * never `{}` or an empty body, which the client's decoder throws on.
 *
 * What stands in for what each table lacks:
 *  - A key is named by its `ReplicationId`, the GUID minted beside its numeric `RoomKeyId`
 *    (`ItemId` is a Guid in the client's model). Nothing records when a key was last edited,
 *    so `ModifiedAt` is its `CreatedAt`.
 *  - A consumable records only `ModifiedAt`, which stands as its `CreatedAt` too.
 *  - A purchase offer is a pack of the room's currency sold for TOKENS, so its
 *    `PurchaseCurrencyId` is null, and the one timestamp it keeps serves as both. Its `Name`
 *    is `<amount> <currency name>` ("444 Gems"), NOT the stored `Name`: the client names an
 *    offer by a GUID when it creates one, and that is what the shop showed. It takes the
 *    currency's description and coin art, having none of its own.
 *  - A room offer is named by its `OriginId`. Its `PriceUnitId` is the room currency it is
 *    priced in (null: tokens), the same value its purchase checks. Every offer is listed,
 *    whatever its `Visibility`, as `GET /econ/roomOffer/room/{roomId}` lists them.
 */
export async function getRoomPurchasables(
	db: D1Database,
	roomId: number
): Promise<RoomPurchasable[]> {
	const [keys, consumables, currencies, roomOffers] = await Promise.all([
		getRoomKeys(db, roomId),
		getRoomConsumables(db, roomId),
		getRoomCurrencies(db, roomId),
		getRoomOffers(db, roomId),
	])
	const offers = await getPurchaseOffers(
		db,
		currencies.map((currency) => currency.CurrencyId)
	)
	const currencyById = new Map(currencies.map((currency) => [currency.CurrencyId, currency]))

	return [
		...keys.map((key): RoomPurchasable => ({
			ItemType: ROOM_PURCHASABLE_TYPE.roomKey,
			ItemId: key.ReplicationId,
			Name: key.Name,
			Description: key.Description,
			ImageName: key.ImageName,
			RoomId: key.RoomId,
			Price: key.Price,
			PurchaseCurrencyId: key.PurchaseCurrencyId,
			CreatedAt: key.CreatedAt,
			ModifiedAt: key.CreatedAt,
		})),
		...consumables.map((consumable): RoomPurchasable => ({
			ItemType: ROOM_PURCHASABLE_TYPE.roomConsumable,
			ItemId: consumable.RoomConsumableId,
			Name: consumable.Name,
			Description: consumable.Description,
			ImageName: consumable.ImageName,
			RoomId: consumable.RoomId,
			Price: consumable.Price,
			PurchaseCurrencyId: consumable.PurchaseCurrencyId,
			CreatedAt: consumable.ModifiedAt,
			ModifiedAt: consumable.ModifiedAt,
		})),
		...offers.flatMap((shop) => {
			const currency = currencyById.get(shop.CurrencyId)
			return shop.PurchaseOffers.map((offer): RoomPurchasable => ({
				ItemType: ROOM_PURCHASABLE_TYPE.roomCurrencyPurchaseOffer,
				ItemId: offer.CurrencyPurchaseOfferId,
				Name: `${offer.CurrencyAmount} ${currency?.Name ?? ''}`.trim(),
				Description: currency?.Description ?? '',
				ImageName: currency?.ImageName ?? null,
				RoomId: roomId,
				Price: offer.Price,
				PurchaseCurrencyId: null,
				CreatedAt: offer.ModifiedAt,
				ModifiedAt: offer.ModifiedAt,
			}))
		}),
		...roomOffers.map((offer): RoomPurchasable => ({
			ItemType: ROOM_PURCHASABLE_TYPE.roomOffer,
			ItemId: offer.OriginId,
			Name: offer.Name,
			Description: offer.Description,
			ImageName: offer.ImageName,
			RoomId: offer.RoomId,
			Price: offer.Price,
			PurchaseCurrencyId: typeof offer.PriceUnitId === 'string' ? offer.PriceUnitId : null,
			CreatedAt: offer.CreatedAt,
			ModifiedAt: offer.ModifiedAt,
		})),
	]
}
