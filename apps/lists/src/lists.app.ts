import { Hono } from 'hono'
import { describeRoute, openAPIRouteHandler } from 'hono-openapi'
import { useWorkersLogger } from 'workers-tagged-logger'

import {
	Accessibility,
	addPlayerListItem,
	getHotRooms,
	getNewRooms,
	getPlayerList,
	getRecentlyUpdatedRooms,
	getVisitedRooms,
} from '@repo/domain'
import { withCleanSpec, withNotFound, withOnError } from '@repo/hono-helpers'
import { validateAndGetAccountId } from '@repo/jwt'

import { CatalogKind, UNSELLABLE_RARITIES } from '../../econ/src/catalog-load'
import { placeholderCuratedList, resolveCuratedList, serializeCuratedList } from './curated-lists'
import {
	ALGORITHMIC_LIST_PARAM,
	ALGORITHMIC_TYPE_PARAM,
	AlgorithmicList,
	AUTHED,
	ContextualFeaturesAck,
	CREATOR_ACCOUNT_ID_PARAM,
	CuratedListRead,
	CuratedListSaved,
	CuratedListsBulk,
	form,
	ITEM_ID_PARAM,
	json,
	LIST_IDS_PARAM,
	LIST_NAME_PARAM,
	LIST_TYPE_PARAM,
	SAVE_LIST_NAME_PARAM,
	SaveItemBody,
	UNAUTHORIZED_RESPONSE,
} from './openapi'

import type { Context } from 'hono'
import type { CuratedList, Room } from '@repo/domain'
import type { CatalogKindValue } from '../../econ/src/catalog-load'
import type { App } from './context'

// The item catalog's sellable-rarity rule, from the worker that owns the table. Imported
// rather than restated so a row can never offer an id the storefront omits.

/**
 * Resolve the account id from a Bearer token. Returns `null` when the header is missing,
 * the token is invalid, or the `sub` claim isn't an integer.
 */
async function authedId(c: Context<App>): Promise<number | null> {
	return validateAndGetAccountId(c.req.raw, await c.env.JWT_SECRET.get())
}

/** Results.Unauthorized() equivalent — 401 with empty body. */
function unauthorized(c: Context<App>) {
	return c.body(null, 401)
}

/**
 * What the ids in an ALGORITHMIC list are — a BYTE on the client, so only 0–255
 * round-trips. Not the curated lists' `Type`, which names the page a list belongs to
 * (see `CuratedListType` in `curated-lists.ts`); the two are different enums that happen to
 * share a field name.
 *
 * It is what tells the client which service to resolve the ids against, which is why the
 * algorithmic route echoes back the type it was asked for rather than asserting one of its
 * own: a row asked for `Rooms` and handed `Accounts` would look up room ids in the account
 * service and render nothing.
 */
const ListEntityType = {
	Accounts: 0,
	Rooms: 1,
	Inventions: 2,
	CustomAvatarItems: 3,
	PurchasableItems: 4,
	Generic: 5,
	ChipAndPort: 6,
	DiscoverySection: 7,
	DiscoverySectionSubType: 8,
} as const

/** The largest value the client's byte-wide `Type` can carry back. */
const MAX_LIST_ENTITY_TYPE = 255

/**
 * One entity of an algorithmic list. `Id` is a STRING even though most of the things a row
 * names (rooms, items) are numbered, and `Context` is where the reference server attributes
 * the ranking or experiment that produced the entity — nothing here produces one, so it is
 * null on every entity rather than a made-up context the client would carry into telemetry.
 */
interface ListEntity {
	Id: string
	Context: string | null
}

/** Ids as the entities the client reads back — see `ListEntity`. */
function entities(ids: string[]): ListEntity[] {
	return ids.map((Id) => ({ Id, Context: null }))
}

/**
 * What a row with nothing behind it answers (`GET /algorithmiclists/:list`): NO entities.
 * The row still answers 200 — a 404 renders as a carousel that failed to load rather than
 * one the client hides — but it names nothing, because there is no honest answer for a row
 * this server has never heard of. It once served rooms 2–6 so an unranked row resolved to
 * something real; that put the same five stock rooms under every unimplemented heading,
 * which reads as a broken row rather than an absent one. The rows with a real answer are in
 * `ROW_FEEDS`, `PERSONAL_ROW_FEEDS` and `STATIC_ROW_ENTITIES`.
 */
const ALGORITHMIC_LIST_ENTITIES: ListEntity[] = []

/** How many rooms a row carries. A discovery carousel shows a page, not the world. */
const LIST_SIZE = 20

/**
 * A row's rooms as the entities the client reads back. Only the ids travel — it resolves
 * each room against the `rooms` worker itself — so `Id` is the room id as a STRING and
 * `Context` (the ranking attribution) is null, like every other entity.
 */
function toEntities(rooms: Room[]): ListEntity[] {
	return entities(rooms.map((room) => String(room.RoomId)))
}

/**
 * The feed the Hot row is drawn from: `community`, which is the hot ranking with the rooms
 * the Coach account (id 1) created dropped. Those are this server's stock/seeded rooms, and
 * a "Hot" row that is mostly Rec Center is a row about the server rather than about what
 * players are doing. The pseudo-tag is the rooms worker's own — see `getHotRooms` — so the
 * definition of "community" stays in one place.
 */
const HOT_LIST_FEED = 'community'

/** What fills one row: the rooms it serves, in the order it serves them. */
type RowFeed = (db: D1Database) => Promise<Room[]>

/**
 * The browse feeds answer a `{ Results, TotalResults }` PAGE; a row serves a bare list, and
 * the total is meaningless here — a carousel shows what it shows. This unwraps one so the
 * table below reads as a list of rankings rather than of destructurings.
 */
const ranked =
	(feed: (db: D1Database) => Promise<{ Results: Room[] }>): RowFeed =>
	async (db) =>
		(await feed(db)).Results

/**
 * A CATEGORY row: the public, listable rooms carrying one tag, ordered the way the hot feed
 * orders anything — live player count first, then engagement — so the busiest rooms in the
 * category lead. `getHotRooms` already means "rooms with this tag, most active first" when
 * handed a real tag, so a category row is that call with the tag pinned.
 *
 * Only the `new`/`community` pseudo-tags get special treatment in there, so a category row
 * must never be given one of those names.
 */
const tagRow = (tag: string): RowFeed => ranked((db) => getHotRooms(db, tag, 0, LIST_SIZE))

/**
 * The rows that serve a LIVE ranking, keyed by the row slug, each answering the rooms that
 * fill it. Everything not in this table falls back to the canned entities, so adding a real
 * row is adding a line here rather than another branch in the handler.
 *
 * Keys are lowercase and looked up folded: a slug reaches us from a curated page's `ItemIds`
 * or a discovery section's `sourceMetadata`, and the casing there is the reference's rather
 * than ours (`HotList`, `recentlyupdated`).
 *
 * Every row here yields ROOMS — a discovery carousel is a room carousel — and only the ids
 * travel, which is why each of these reads a ranking and throws the room blobs away: the
 * client resolves each room against the `rooms` worker itself.
 *
 * The three "what's happening" rows — Hot, Recently Updated, New — share one notion of
 * which rooms are eligible (public, listable, and made by a PLAYER rather than by the Coach
 * account), so none of them can show a room its siblings hide. A CATEGORY row deliberately
 * does not: `quest` is carried by five rooms on this server and every one of them is the
 * Coach's, so filtering them out would leave the Quests carousel permanently empty. A
 * category row asks what a room is about, not who made it.
 *
 * The definitions live in `@repo/domain` next to the browse feeds they are cousins of.
 */
const ROW_FEEDS: Record<string, RowFeed> = {
	// The same ranking the rooms worker's `/rooms/hot` serves — live player count first,
	// then engagement — so the Hot row shows the rooms people are actually in.
	hotlist: ranked((db) => getHotRooms(db, HOT_LIST_FEED, 0, LIST_SIZE)),

	// Ordered by when each room's live scene was last PUBLISHED. A staged save doesn't
	// count: nothing anyone else can load has changed, so it must not float the room.
	recentlyupdated: ranked((db) => getRecentlyUpdatedRooms(db, 0, LIST_SIZE)),

	// Newest player-made rooms by creation time. Distinct from the browse screen's `tag=new`
	// chip, which selects on the RRO flag instead — see `getNewRooms`.
	new: ranked((db) => getNewRooms(db, 0, LIST_SIZE)),

	// The category rows. Each names its tag OUTRIGHT rather than deriving one from the slug,
	// because the mapping is not mechanical — `quests_algoendpoint` is plural and its tag
	// `quest` is singular, while the six below happen to match. Deriving would quietly invent
	// a `quests` tag no room carries and serve an empty carousel under a category heading.
	quests_algoendpoint: tagRow('quest'),
	battle_algoendpoint: tagRow('battle'),
	roleplay_algoendpoint: tagRow('roleplay'),
	horror_algoendpoint: tagRow('horror'),
	hangout_algoendpoint: tagRow('hangout'),
	casual_algoendpoint: tagRow('casual'),
	explore_algoendpoint: tagRow('explore'),
}

/**
 * Rows whose contents are a PROPERTY OF THE CALLER rather than a ranking — the same slug
 * answers a different list for every player, so these are looked up separately and only
 * these ever read the token. A row here is answered from the caller's own account id; there
 * is nothing sensible to serve a caller who has no token (see the handler).
 *
 * Deliberately NOT filtered to public/listable/player-made the way the `ROW_FEEDS` rankings
 * are. This is the player's own history: a room they visited that has since gone private is
 * still a room they can get back to, and hiding it here while
 * `rooms` `GET /rooms/visitedby/me` still lists it would have the same history read two ways.
 */
const PERSONAL_ROW_FEEDS: Record<string, (db: D1Database, accountId: number) => Promise<Room[]>> = {
	// Rooms the caller has been in, most recently visited first — the "Continue Playing"
	// carousel as an algorithmic row. Backed by the `interaction` table's `last_visited_at`,
	// which the `match` heartbeat stamps, and served straight from `getVisitedRooms` so this
	// row and `rooms` `GET /rooms/visitedby/me` can never disagree about where someone has been.
	recentlyvisited: (db, accountId) => getVisitedRooms(db, accountId, 0, LIST_SIZE),
}

/**
 * What a GENERIC row's ids look like. A `Generic` row is the one kind that can name things
 * of MORE THAN ONE sort in a single list, so the sort travels in the id itself: the client
 * splits each `Id` on `.` and reads the half in front as which service resolves the half
 * behind it.
 *
 * `<prefix>.<id>`, with EXACTLY ONE dot — the split is checked for two halves, so a bare
 * `257` and a `0.1.2` are both dropped rather than resolved:
 *
 * - `0.<int>`  → a PurchasableItem, the store item of that id
 * - `1.<guid>` → a CustomAvatarItem, the UGC item of that guid
 *
 * Which is why these ids are written out as the strings they go on the wire as: the prefix
 * is part of the id here, not decoration this server adds, and `Type` (5) says only that
 * the ids are self-describing — never what any one of them is.
 */
const GENERIC_ID_PREFIX = {
	PurchasableItem: '0',
	CustomAvatarItem: '1',
} as const

/**
 * How many entities a GENERIC row serves. The reference's store carousels are a screenful, and
 * the client draws what fits and scrolls the rest, so this is a "plenty to look at" number
 * rather than one it must match.
 */
const GENERIC_ROW_SIZE = 50

/** What a store row draws from the catalog. */
interface StoreRowRule {
	/** Avatar items (worn) or skins (held). */
	kind: CatalogKindValue
	/**
	 * Substrings, ANY of which the item's name may contain, matched case-insensitively. Absent
	 * means the whole kind.
	 *
	 * A crude stand-in for a category: the catalog records no slot or category for an item, so a
	 * row that wants "headwear" has nothing to filter on but the name. Several are ORed because
	 * one category is several words — a "top" is a shirt or a jacket — while the rule as a whole
	 * is ANDed with the kind and rarity clauses.
	 *
	 * It matches ANYWHERE in the name, so `hat` takes "Top Hat" and "Hatchet" alike. That is the
	 * known cost of having nothing better to ask; narrow these when the catalog grows a real
	 * category to filter on.
	 */
	nameContains?: string[]
}

/**
 * What each store row draws. A slug not named here draws the whole avatar-item catalog, which
 * is what every store row did before any of them had a rule of its own.
 *
 * The slug is the only thing that distinguishes these: they are all asked for as `type=4`
 * (PurchasableItems) and all answer bare `catalog_id`s, so nothing in the request but the row
 * key says which items the row is about.
 */
const STORE_ROW_RULES: Record<string, StoreRowRule> = {
	// Equipment skins — the Maker Pen, the sword, the disc golf disc and so on.
	skinsitems: { kind: CatalogKind.Skin },
	// Wearable categories, by name for want of anything better to filter on.
	headwearitems: { kind: CatalogKind.AvatarItem, nameContains: ['hat'] },
	topsitems: { kind: CatalogKind.AvatarItem, nameContains: ['shirt', 'jacket', 'dress'] },
	handsitems: { kind: CatalogKind.AvatarItem, nameContains: ['glove', 'hand', 'wrist'] },
	hairitems: { kind: CatalogKind.AvatarItem, nameContains: ['hair'] },
	facialhairitems: {
		kind: CatalogKind.AvatarItem,
		nameContains: ['beard', 'mustache'],
	},
	waistitems: { kind: CatalogKind.AvatarItem, nameContains: ['belt'] },
	accessoriesitems: {
		kind: CatalogKind.AvatarItem,
		nameContains: ['earrings', 'hearing aids'],
	},
	footwearitems: {
		kind: CatalogKind.AvatarItem,
		nameContains: ['shoes', 'sneakers', 'sandals', 'boots'],
	},
	bottomsitems: { kind: CatalogKind.AvatarItem, nameContains: ['pants', 'shorts'] },
	shoulderitems: {
		kind: CatalogKind.AvatarItem,
		nameContains: ['quiver', 'backpack', 'sword'],
	},
}

/** What a slug with no rule of its own draws: the whole avatar-item catalog. */
const DEFAULT_STORE_ROW_RULE: StoreRowRule = { kind: CatalogKind.AvatarItem }

/**
 * A random handful of catalog ids matching one {@link StoreRowRule}, read live from the
 * `catalog` table (owned by the `econ` worker, on this same `recflare` database). Backs the
 * GENERIC row and every flavour of the PURCHASABLE ITEMS row, which differ only in what they
 * ask for and how they spell what they get.
 *
 * Random because nothing here RANKS store items yet — there is no popularity, no recency, no
 * personalisation to sort by — and a random draw is at least honestly arbitrary where a fixed
 * hand-picked list pretended to be a ranking. It also exercises the whole catalog instead of
 * the same ten ids forever, which is the point of pointing it at the table.
 *
 * {@link isSellableRarity} is applied whatever the kind: the generated storefront omits the
 * developer/unreleased tier — `catalog_id` 10002 is in the table and NOT in sf1704 — and an id
 * no storefront sells renders as nothing, indistinguishable from an id the client failed to
 * parse. No skin carries that rarity today, so the clause costs them nothing and stops a future
 * capture that does from leaking one into a row.
 *
 * The number in each id is the `catalog_id`, which is exactly what the generated storefront
 * lists an avatar item under as its `PurchasableItemId` — one number resolves a row entity and a
 * store item, with no second numbering between them. It is clear of every captured storefront's
 * own ids by construction (see `CATALOG_ID_BASE`). It is a LOAD-ORDER surrogate, reassigned by
 * every catalog load, which is fine for a row built and consumed within one request but is why
 * nothing may store one.
 *
 * WORTH KNOWING for skins: no generated storefront lists them — sf1704 is avatar items only —
 * so a client handed a skin's id has nothing to resolve it against yet, and the row will draw
 * as nothing until a storefront carries them.
 *
 * An empty result is served as an empty row rather than falling back to canned ids: the table
 * being empty means the catalog was never loaded (`runx catalog load`), and a fallback would
 * hide that behind a row that looks fine.
 */
async function randomCatalogIds(c: Context<App>, rule: StoreRowRule): Promise<number[]> {
	const binds: Array<string | number> = []
	/** Bind a value and get its placeholder, so the numbering can't drift as clauses are added. */
	const bind = (v: string | number): string => `?${binds.push(v)}`

	const where = [`kind = ${bind(rule.kind)}`, 'catalog_id IS NOT NULL']
	where.push(`rarity NOT IN (${UNSELLABLE_RARITIES.map((r) => bind(r)).join(', ')})`)

	if (rule.nameContains !== undefined && rule.nameContains.length > 0) {
		// Lowered on both sides rather than leaning on LIKE, which folds case for ASCII only —
		// and item names are not all ASCII. `%` and `_` are escaped so a rule containing one
		// matches it literally instead of everything. The needles are ORed with each other and
		// the group ANDed with the rest, so a multi-word category widens what it takes without
		// escaping the kind and rarity filters.
		const any = rule.nameContains
			.map((needle) => {
				const escaped = needle.toLowerCase().replace(/[\\%_]/g, (ch) => `\\${ch}`)
				return `lower(friendly_name) LIKE ${bind(`%${escaped}%`)} ESCAPE '\\'`
			})
			.join(' OR ')
		where.push(`(${any})`)
	}

	const { results } = await c.env.DB.prepare(
		`SELECT catalog_id FROM catalog WHERE ${where.join(' AND ')}
		 ORDER BY RANDOM() LIMIT ${bind(GENERIC_ROW_SIZE)}`
	)
		.bind(...binds)
		.all<{ catalog_id: number }>()
	return results.map((r) => r.catalog_id)
}

/**
 * A GENERIC row's entities: the same store items, under the `0.` PurchasableItem prefix that
 * a Generic row's composite ids require.
 */
async function genericRowEntities(c: Context<App>): Promise<ListEntity[]> {
	const ids = await randomCatalogIds(c, DEFAULT_STORE_ROW_RULE)
	return entities(ids.map((id) => `${GENERIC_ID_PREFIX.PurchasableItem}.${id}`))
}

/**
 * A PURCHASABLE ITEMS row's entities: the same store items as the Generic row, but with BARE
 * ids and no prefix.
 *
 * That difference is the whole distinction between the two types and must not be tidied away.
 * A typed row's `Type` is what tells the client which service to resolve its ids against, so
 * the ids themselves are plain; only a Generic row, which can name things of more than one
 * sort, carries the sort inside each id. Serving `0.10000` here would have the client look up
 * a purchasable item literally called "0.10000".
 */
async function purchasableItemRowEntities(c: Context<App>, key: string): Promise<ListEntity[]> {
	const ids = await randomCatalogIds(c, STORE_ROW_RULES[key] ?? DEFAULT_STORE_ROW_RULE)
	return entities(ids.map((id) => String(id)))
}

/**
 * Rows served from a FIXED id list — a carousel somebody picked by hand, with no ranking
 * behind it. Keyed and looked up exactly like `ROW_FEEDS` (lowercase, folded), and checked
 * after it, so a row that later grows a real feed is promoted by moving its line up there.
 *
 * Unlike the room rows, these do NOT all name rooms: the store's carousels name purchasable
 * items, which is why the ids are written out as the strings they go on the wire as rather
 * than derived from anything. The `Type` the response reports is still the caller's — see
 * the handler.
 *
 * The slugs are the reference's own and several do not match the heading they render under
 * (`summerpartycarousel` fills a medieval row). Key on the SLUG regardless: it is what the
 * discovery section's `sourceMetadata` names, so renaming one to something that reads better
 * would leave that section pointing at nothing.
 */
const STATIC_ROW_ENTITIES: Record<string, ListEntity[]> = {
	// Empty. The store carousels that lived here —
	// `summerpartycarousel` (the Featured page's "Medieval Masterpieces from the Community")
	// and `newitems` (the Clothing page's "New") — are asked for with `?type=5`, and Generic is
	// answered by the TYPE from the catalog table now, so a static entry for either was already
	// unreachable. See {@link genericRowEntities}.
	//
	// The table stays because it is the right home for a row somebody picks by hand, and the
	// handler still consults it; nothing is hand-picked at the moment.
}

/**
 * The entity type an algorithmic list reports when the query names none. The client always
 * sends `?type=`, and `Rooms` is what it asks for; falling back to `Accounts` (0, the enum's
 * zero value) would have the row resolve room ids against the account service.
 */
const DEFAULT_ALGORITHMIC_LIST_TYPE = ListEntityType.Rooms

/**
 * The stored list the query names, if a player owns one. Undefined when any of the three
 * keys is missing or unparseable — a player list is owned by an account and typed, so a
 * query that names neither cannot be asking for one, and there is no read to make.
 *
 * Not auth-gated: the client asks for its own lists by passing its account id rather than by
 * being logged in, `Accessibility` is a property of the list rather than of the reader, and
 * the endpoint has never taken a token. A list read here is only ever ids the client then
 * resolves itself.
 */
async function ownedList(
	c: Context<App>,
	creatorAccountId: string | undefined,
	type: string | undefined,
	name: string | undefined
): Promise<CuratedList | undefined> {
	const accountId = Number.parseInt(creatorAccountId ?? '', 10)
	const listType = Number.parseInt(type ?? '', 10)
	if (!Number.isInteger(accountId) || !Number.isInteger(listType) || !name) return undefined

	return getPlayerList(c.env.DB, accountId, listType, name)
}

/**
 * One field of a form-urlencoded body, matched case-insensitively and falling back to the
 * query string. The client puts this call's parameters in the BODY (`accessibility=0&type=1`),
 * but the same parameters ride the query string everywhere else on this worker, and a PUT
 * whose body failed to parse would otherwise silently create a list with the wrong type.
 */
function bodyField(
	body: Record<string, unknown>,
	c: Context<App>,
	name: string
): string | undefined {
	const key = Object.keys(body).find((k) => k.toLowerCase() === name.toLowerCase())
	const value = key === undefined ? undefined : body[key]
	return typeof value === 'string' ? value : c.req.query(name)
}

/** An integer field, or `fallback` when it is absent or not one. */
function intField(
	body: Record<string, unknown>,
	c: Context<App>,
	name: string,
	fallback: number
): number {
	const parsed = Number.parseInt(bodyField(body, c, name) ?? '', 10)
	return Number.isInteger(parsed) ? parsed : fallback
}

const app = new Hono<App>()
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

	// Root health check.
	.get(
		'/',
		describeRoute({
			tags: ['Service'],
			summary: 'Health check',
			description: 'Liveness probe for the lists worker. No auth; the body is plain text.',
			responses: {
				200: {
					description: 'Service is up',
					content: { 'text/plain': { schema: { type: 'string', example: 'hello, world!' } } },
				},
			},
		}),
		async (c) => {
			return c.text('hello, world!')
		}
	)

	// Bulk curated-list lookup — the client asks for a set of lists by repeating `?id=`.
	// Nothing curates lists here yet, so this serves one canned list: `ItemIds` are strings
	// (not numbers) and `Description` may be null, but `ImageName` has to be a string — the
	// client's parser reads it straight into a string field. A 404 shows as a failed load
	// instead, so an unknown id still answers 200.
	.get(
		'/curatedlists/bulk',
		describeRoute({
			tags: ['Lists', '2025'],
			summary: 'Curated lists by id',
			description: [
				'A set of curated lists, asked for by repeating `?id=`. Nothing curates lists here yet,',
				'so this serves ONE canned list whatever is asked for — an unknown id included, because',
				'a 404 shows as a row that failed to load rather than one the client hides.',
				'',
				'The canned list is shaped the way the client parses one: `ItemIds` are strings rather',
				'than numbers, `Description` may be null, and `ImageName` has to be a string — the',
				'client reads it straight into a string field.',
			].join('\n'),
			parameters: [LIST_IDS_PARAM],
			responses: { 200: json(CuratedListsBulk, 'The canned list, as a one-element array') },
		}),
		async (c) => {
			return c.json([
				{
					ListId: 17859340,
					CreatorAccountId: 1,
					Name: 'My List',
					Description: null,
					ImageName: '',
					Type: ListEntityType.Rooms,
					ItemIds: ['123', '456'],
					CreatedAt: '2025-07-18T00:00:00Z',
				},
			])
		}
	)

	// One curated list (`GET /curatedlists?creatorAccountId=&type=&name=`). The client reads
	// back ONE list object — not a collection — and asks for two different things through the
	// same three parameters:
	//
	//  - A discovery PAGE's row set, which is a static capture in `static/curated-lists.json`
	//    (`ItemIds` are the discovery section keys the page is built from, not room ids).
	//  - A PLAYER's own playlist, which lives in D1 — the `list` / `list_item` tables this
	//    worker owns. `__SavedForLater_Rooms` is the one the client creates for itself: the
	//    Play menu's "Saved for Later" row is `MyPlaylistByName` pointed at that name, and it
	//    is asked for with the player's own id and `type=1` (Rooms), so its `ItemIds` are
	//    room ids.
	//
	// D1 is asked FIRST, so a player's own list wins over a capture that happens to share its
	// name — the captures are this server's fixtures and a player's list is their data.
	// Nothing else distinguishes the two requests: both are the same three parameters.
	//
	// A name that matches NEITHER answers an EMPTY PLACEHOLDER list, 200 — a whole list object
	// echoing the name and type asked for, with no `ItemIds`. The client breaks on anything that
	// is not a list: a bare `{}` breaks it, and so did the 404 this sent before that. The
	// fallbacks it had originally were worse still — an unrelated capture, putting one page's
	// rows under another page's heading, which reads as real content. Empty `ItemIds` is what
	// keeps the placeholder from reading as content of its own. The exceptions are the client's
	// own reserved playlists and a request naming no list at all; both are real answers, not
	// misses (see `resolveCuratedList`).
	.get(
		'/curatedlists',
		describeRoute({
			tags: ['Lists', '2025'],
			summary: 'One curated list',
			description: [
				'ONE list object — not a collection — asked for with the same three parameters whether',
				'the client wants a discovery PAGE’s row set or a PLAYER’s own playlist:',
				'',
				'- A page’s rows are a static capture in `static/curated-lists.json`, whose `ItemIds`',
				'  are the discovery section keys the page is built from (not room ids).',
				'- A player’s playlist lives in D1, in the `list` / `list_item` tables this worker owns.',
				'  `__SavedForLater_Rooms` is the one the client creates for itself — the Play menu’s',
				'  “Saved for Later” row, asked for with the player’s own id and `type=1` (Rooms), so its',
				'  `ItemIds` are room ids.',
				'',
				'D1 is asked FIRST, so a player’s own list wins over a capture that happens to share its',
				'name: the captures are this server’s fixtures and a player’s list is their data.',
				'',
				'Not auth-gated — the client names the owner rather than proving it, `Accessibility` is a',
				'property of the list rather than of the reader, and the answer is only ever ids the',
				'client then resolves itself.',
				'',
				'A name matching NEITHER answers an EMPTY PLACEHOLDER: a whole list object echoing the',
				'name and `type` asked for, with no `ItemIds`. The client breaks on anything that is',
				'not a list, so a miss cannot be `{}` or a 404; and answering it with an unrelated',
				'capture would put one page’s rows under another page’s heading, which reads as real',
				'content. The two exceptions resolve to real lists rather than placeholders — a',
				'reserved `__` playlist nobody owns yet, and a request naming no list at all, which',
				'gets the page default for its `type`.',
			].join('\n'),
			parameters: [CREATOR_ACCOUNT_ID_PARAM, LIST_TYPE_PARAM, LIST_NAME_PARAM],
			responses: {
				200: json(CuratedListRead, 'The list, or an empty placeholder when there is no such list'),
			},
		}),
		async (c) => {
			const creatorAccountId = c.req.query('creatorAccountId')
			const type = c.req.query('type')
			const name = c.req.query('name')

			// No such list: a well-formed but EMPTY list echoing what was asked for. The client
			// BREAKS on a bare `{}`, and broke differently on the 404 this sent before it, so the
			// answer has to be a list — "there is no such list" expressed as a list with nothing in
			// it. Empty `ItemIds` is what keeps it from reading as content.
			const list =
				(await ownedList(c, creatorAccountId, type, name)) ??
				resolveCuratedList(creatorAccountId, type, name) ??
				placeholderCuratedList(creatorAccountId, type, name)

			// Serialized by hand rather than through `c.json`: the reference's `ListId`s are
			// 64-bit and are carried as strings so their digits survive being parsed — see
			// `serializeCuratedList`, which puts them back on the wire as numbers.
			return c.body(serializeCuratedList(list), 200, { 'content-type': 'application/json' })
		}
	)

	// Save an item into one of the caller's own lists, creating the list if they don't have
	// it yet (`PUT /curatedlists/:name/items/:itemId/createlistifneeded`) — what the client
	// calls when someone saves a room for later. The path names the list and the item
	// (`/curatedlists/__SavedForLater_Rooms/items/953/createlistifneeded`), and the form body
	// carries `accessibility` and `type`.
	//
	// AUTH-GATED, and the owner is the TOKEN's account: unlike the read, this call names no
	// `creatorAccountId`, so the only account it could mean is the caller's — and a route
	// that took an owner from the client would let anyone write into anyone's list.
	//
	// Answers the list as it now stands rather than an acknowledgement, so the row the client
	// re-renders is the one this call just changed.
	.put(
		'/curatedlists/:name/items/:itemId/createlistifneeded',
		describeRoute({
			tags: ['Lists', '2025'],
			summary: 'Save an item into the caller’s list',
			description: [
				'Saves an item into one of the caller’s own lists, creating the list when they have none',
				'by that name — what the client calls when someone saves a room for later. The path names',
				'the list and the item; the form body carries `accessibility` and `type`, both of which',
				'apply only on creation.',
				'',
				'AUTH-GATED, and the owner is the TOKEN’s account: unlike the read, this call names no',
				'`creatorAccountId`, so the only account it could mean is the caller’s — and taking an',
				'owner from the client would let anyone write into anyone’s list.',
				'',
				'Answers the list as it now stands rather than an acknowledgement, so the row the client',
				're-renders is the one this call just changed. Saving the same item twice leaves it in',
				'the list once.',
				'',
				'The response drops `Accessibility`, which the read keeps. That is a real difference in',
				'what the client is sent, not an oversight — every other key, and their order, is the',
				'read’s.',
			].join('\n'),
			security: AUTHED,
			parameters: [SAVE_LIST_NAME_PARAM, ITEM_ID_PARAM],
			requestBody: form(SaveItemBody, 'Applied only when the list is created'),
			responses: {
				200: json(CuratedListSaved, 'The list as it now stands, without `Accessibility`'),
				401: UNAUTHORIZED_RESPONSE,
			},
		}),
		async (c) => {
			const accountId = await authedId(c)
			if (accountId === null) return unauthorized(c)

			const body = await c.req.parseBody().catch(() => ({}) as Record<string, unknown>)
			const list = await addPlayerListItem(
				c.env.DB,
				{
					creatorAccountId: accountId,
					name: c.req.param('name'),
					// The `ListEntityType`, saying what the item ids in this list ARE. Rooms when the
					// body names none: every list the client creates this way is a room list, and the
					// type is part of the list's identity, so guessing another would strand the list
					// where the client's own read (`?type=1`) can't find it.
					type: intField(body, c, 'type', ListEntityType.Rooms),
					// PRIVATE by default. A list a player builds for themselves is theirs to see;
					// the client sends `accessibility=0` and this only applies on creation anyway.
					accessibility: intField(body, c, 'accessibility', Accessibility.Private),
				},
				c.req.param('itemId')
			)

			// The SAVE's projection of a list drops `Accessibility`; the read's keeps it. That is a
			// real difference in what the client is sent, not an oversight — don't unify them.
			// Every other key, and their order, is the read's.
			const { Accessibility: _accessibility, ...saved } = list

			// Serialized by hand for the same reason the read is: the 64-bit `ListId` has to reach
			// the client unquoted with every digit intact.
			return c.body(serializeCuratedList(saved), 200, { 'content-type': 'application/json' })
		}
	)

	// One discovery ROW's contents (`GET /algorithmiclists/:list?type=1`). `:list` is the row
	// key the curated page above lists in its `ItemIds` (e.g.
	// `Rooms_Battle_AlgoEndpoint_PlayHighlight_TabsTest_Explore`), and the answer is the
	// ranked entities that fill it, which the client then resolves by id itself.
	//
	// `HotList`, `recentlyupdated` and `new` are ranked for real (see `ROW_FEEDS`),
	// `recentlyvisited` is per-caller (see `PERSONAL_ROW_FEEDS`), and a few are hand-picked id
	// lists (see `STATIC_ROW_ENTITIES`). Every other row — an unknown key included — answers an
	// EMPTY 200 rather than a 404, which the client renders as a row that failed to load
	// instead of one it hides. `Type` is echoed back from the query: it
	// tells the client what the `Id`s ARE (rooms, players, …), so answering with a type the
	// caller didn't ask for would have it resolve the ids against the wrong service.
	//
	// `?type=5` (Generic) is the exception that is answered by the TYPE and not by the slug:
	// its ids are `<prefix>.<id>` composites the client resolves per entity (see
	// `genericRowEntities`), so no ranking of bare room ids can fill such a row.
	.get(
		'/algorithmiclists/:list',
		describeRoute({
			tags: ['Lists', '2025'],
			summary: 'One discovery row’s contents',
			description: [
				'The entities that fill one discovery row. `{list}` is the row key a curated page lists',
				'in its `ItemIds` (e.g. `Rooms_Battle_AlgoEndpoint_PlayHighlight_TabsTest_Explore`), and',
				'only the IDS travel — the client resolves each room or item itself.',
				'',
				'`HotList`, `recentlyupdated` and `new` are ranked live off the same room tables the',
				'`rooms` worker’s browse feeds read, so a row and its feed can’t disagree. The',
				'`*_algoendpoint` category rows serve the public rooms carrying one tag, busiest first.',
				'`recentlyvisited` is per-caller and is the one row that reads the token; without one it',
				'answers EMPTY rather than 401ing, since canned rooms would claim the caller visited',
				'rooms they never did — and an empty carousel is what a brand-new account legitimately',
				'has. A couple of store rows are hand-picked id lists.',
				'',
				'Every other row — an unknown key included — answers an EMPTY 200 rather than a 404,',
				'which the client renders as a row that failed to load instead of one it hides.',
				'',
				'`?type=5` (Generic) is answered by the TYPE rather than by the slug, because a Generic',
				'row’s ids are `<prefix>.<id>` composites — exactly one dot, `0.<int>` a purchasable',
				'item and `1.<guid>` a custom avatar item — that the client resolves one at a time.',
				'It serves a random draw of sellable purchasable items from the `catalog` table, since',
				'nothing here ranks store items yet; the number in each id is the `catalog_id`, which',
				'is the same `PurchasableItemId` the generated storefront carries.',
				'`?type=4` (PurchasableItems) is answered by the type too, from the same draw, but',
				'with BARE ids: a typed row’s `Type` already says what its ids are, so only a Generic',
				'row needs the prefix. There the SLUG picks what is drawn: `skinsitems` returns',
				'equipment skins, and `headwearitems` / `topsitems` / `handsitems` / `hairitems` /',
				'`facialhairitems` / `waistitems` / `accessoriesitems` / `footwearitems` /',
				'`bottomsitems` / `shoulderitems` return avatar items whose names contain one of that row’s words —',
				'“hat”, “shirt”/“jacket”/“dress”, “glove”/“hand”/“wrist”, “hair”,',
				'“beard”/“mustache”, “belt”,',
				'“earrings”/“hearing aids”, “shoes”/“sneakers”/“sandals”/“boots”, “pants”/“shorts”,',
				'“quiver”/“backpack”/“sword”. Every other row returns the whole avatar-item catalog.',
				'The name match is a stand-in — the catalog records no',
				'category — so it takes anything the word appears in. No generated storefront lists',
				'skins yet, so a client has nothing to resolve those ids against.',
			].join('\n'),
			parameters: [ALGORITHMIC_LIST_PARAM, ALGORITHMIC_TYPE_PARAM],
			responses: { 200: json(AlgorithmicList, 'The row’s entities, possibly none') },
		}),
		async (c) => {
			// Echoed, but only when it fits the byte the client reads it back into — anything
			// outside 0–255 can't round-trip, so a nonsense `?type=` gets the default instead of a
			// number that would break the response on the way in.
			const type = Number.parseInt(c.req.query('type') ?? '', 10)
			const echoed =
				type >= 0 && type <= MAX_LIST_ENTITY_TYPE ? type : DEFAULT_ALGORITHMIC_LIST_TYPE

			const key = c.req.param('list').toLowerCase()

			// GENERIC is answered by the TYPE rather than by the row. Every other kind of row
			// serves bare ids of one sort — room ids, item ids — and it is `Type` that tells the
			// client which service to resolve them against; a Generic row instead carries the sort
			// inside each id (see `GENERIC_ID_PREFIX`), so a caller asking for 5 cannot be served
			// a ranking of bare room ids no matter which slug it named. A random draw from the
			// item catalog until something here ranks store items.
			if (echoed === ListEntityType.Generic) {
				return c.json({ Type: echoed, Entities: await genericRowEntities(c) })
			}

			// PURCHASABLE ITEMS is answered by the type as well, and from the same catalogue draw —
			// but with BARE ids. A typed row's `Type` is what tells the client which service to
			// resolve its ids against, so the ids are plain; the `0.` prefix belongs to Generic
			// alone, where it is the only thing saying what each id IS.
			// The SLUG picks what is drawn here, unlike Generic: `skinsitems` draws equipment skins,
			// the `headwearitems`-style rows draw avatar items whose names say so, everything else
			// draws the whole avatar-item catalog. They are all `type=4` and all answer bare ids, so
			// the row key is the only thing in the request that says which.
			if (echoed === ListEntityType.PurchasableItems) {
				return c.json({ Type: echoed, Entities: await purchasableItemRowEntities(c, key) })
			}

			// A per-caller row needs to know who is asking, so it is the one kind of row that
			// reads the token. No token — or one that doesn't resolve — answers an EMPTY row
			// rather than 401ing or falling through to the canned entities: this is a row about
			// what the caller has done, and canned rooms would claim they visited rooms they
			// never did. An empty carousel is also what a brand-new account legitimately has.
			const personal = PERSONAL_ROW_FEEDS[key]
			if (personal !== undefined) {
				const accountId = await authedId(c)
				const rooms = accountId === null ? [] : await personal(c.env.DB, accountId)
				return c.json({ Type: echoed, Entities: toEntities(rooms) })
			}

			// A row with a live feed behind it serves that; everything else gets the canned
			// entities. Only the ids travel — the client resolves each room itself — so the
			// ranking is read for its order and the room blobs are thrown away.
			const feed = ROW_FEEDS[key]
			if (feed !== undefined) {
				return c.json({ Type: echoed, Entities: toEntities(await feed(c.env.DB)) })
			}

			// Then the hand-picked rows, which are already entities: the ids are the answer.
			const canned = STATIC_ROW_ENTITIES[key]
			if (canned !== undefined) {
				return c.json({ Type: echoed, Entities: canned })
			}

			return c.json({ Type: echoed, Entities: ALGORITHMIC_LIST_ENTITIES })
		}
	)

	// Contextual features — the client posts the context it's in and reads back whether the
	// call was accepted. Auth-gated, and the answer is a bare `{ success, error_id, error }`
	// with no payload: the reference server acknowledges the post and carries nothing back,
	// so there is nothing here to serve statically beyond the acknowledgement itself. The
	// body is read for the log only.
	.post(
		'/contextualfeatures',
		describeRoute({
			tags: ['Lists', '2025'],
			summary: 'Acknowledge a contextual-features post',
			description: [
				'The client posts the context it is in and reads back whether the call was accepted.',
				'Auth-gated, and the answer is a bare `{ success, error_id, error }` with no payload:',
				'the reference server acknowledges the post and carries nothing back, so there is',
				'nothing here to serve beyond the acknowledgement itself. The body is read for the log',
				'only.',
			].join('\n'),
			security: AUTHED,
			responses: {
				200: json(ContextualFeaturesAck, 'Accepted'),
				401: UNAUTHORIZED_RESPONSE,
			},
		}),
		async (c) => {
			const id = await authedId(c)
			if (id === null) return unauthorized(c)

			return c.json({ success: true, error_id: null, error: null })
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
					title: 'recflare lists',
					version: '1.0.0',
					description: [
						'Curated and algorithmic lists for recflare, a private-server reimplementation of the',
						'Rec Room backend. A discovery page is built from these: the `discovery` worker says',
						'which carousels a page has, and this worker says what is in them.',
						'',
						'Two kinds of list. A CURATED list is named — either a static capture of a page’s row',
						'set, or a player’s own playlist in D1 (`__SavedForLater_Rooms`, the Play menu’s',
						'“Saved for Later”). An ALGORITHMIC list is a ranking asked for by row slug: the hot,',
						'recently-updated and new feeds, the room categories, and the caller’s own recently',
						'visited rooms.',
						'',
						'Only IDS travel. Every list answers ids the client resolves against the `rooms` and',
						'`commerce` workers itself, which is why a list carries a `Type` saying what its ids',
						'ARE — answering with a type the caller didn’t ask for would have it look the ids up',
						'against the wrong service.',
						'',
						'A row with nothing behind it answers an empty 200 rather than a 404: the client',
						'renders a failed row for an error and hides an empty one, and an empty carousel is',
						'the honest answer for a ranking this server has nothing for.',
						'',
						'Reads are unauthenticated — the client names the owner rather than proving it, and a',
						'list is only ever ids. Writing needs a token, since the list written into is the',
						'caller’s own.',
					].join('\n'),
				},
				servers: [{ url: 'https://lists.recflare.net', description: 'Production' }],
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
