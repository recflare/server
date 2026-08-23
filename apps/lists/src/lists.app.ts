import { Hono } from 'hono'
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
import { withNotFound, withOnError } from '@repo/hono-helpers'
import { validateAndGetAccountId } from '@repo/jwt'

import { resolveCuratedList, serializeCuratedList } from './curated-lists'

import type { Context } from 'hono'
import type { CuratedList, Room } from '@repo/domain'
import type { App } from './context'

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
 * The fallback entities for a row with no live feed behind it (`GET /algorithmiclists/:list`)
 * — ROOMS, which is what a Play/Explore row is built from. Rooms 2–6, the low ids this
 * server's own rooms occupy, so an unranked row resolves to something real instead of five
 * dead ids. The rows in `ROW_FEEDS` are ranked for real and never reach this.
 *
 * `Id` is a STRING even though a room id is a number, and `Context` is where the reference
 * server attributes the ranking/experiment that produced the entity. Nothing produced these,
 * so it is null on every one rather than a made-up context the client would carry into
 * telemetry.
 */
const ALGORITHMIC_LIST_ENTITIES: Array<{ Id: string; Context: string | null }> = [].map((Id) => ({ Id, Context: null }))

/** How many rooms a row carries. A discovery carousel shows a page, not the world. */
const LIST_SIZE = 20

/**
 * A row's rooms as the entities the client reads back. Only the ids travel — it resolves
 * each room against the `rooms` worker itself — so `Id` is the room id as a STRING and
 * `Context` (the ranking attribution) is null, exactly as in `ALGORITHMIC_LIST_ENTITIES`.
 */
function toEntities(rooms: Room[]): Array<{ Id: string; Context: string | null }> {
	return rooms.map((room) => ({ Id: String(room.RoomId), Context: null }))
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

	.get('/', async (c) => {
		return c.text('hello, world!')
	})

	// Bulk curated-list lookup — the client asks for a set of lists by repeating `?id=`.
	// Nothing curates lists here yet, so this serves one canned list: `ItemIds` are strings
	// (not numbers) and `Description` may be null, but `ImageName` has to be a string — the
	// client's parser reads it straight into a string field. A 404 shows as a failed load
	// instead, so an unknown id still answers 200.
	.get('/curatedlists/bulk', async (c) => {
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
	})

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
	// Nothing else distinguishes the two requests: both are the same three parameters, and a
	// name nobody owns still has to answer something (see `resolveCuratedList`).
	.get('/curatedlists', async (c) => {
		const creatorAccountId = c.req.query('creatorAccountId')
		const type = c.req.query('type')
		const name = c.req.query('name')

		const list =
			(await ownedList(c, creatorAccountId, type, name)) ??
			resolveCuratedList(creatorAccountId, type, name)

		// Serialized by hand rather than through `c.json`: the reference's `ListId`s are
		// 64-bit and are carried as strings so their digits survive being parsed — see
		// `serializeCuratedList`, which puts them back on the wire as numbers.
		return c.body(serializeCuratedList(list), 200, { 'content-type': 'application/json' })
	})

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
	.put('/curatedlists/:name/items/:itemId/createlistifneeded', async (c) => {
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
	})

	// One discovery ROW's contents (`GET /algorithmiclists/:list?type=1`). `:list` is the row
	// key the curated page above lists in its `ItemIds` (e.g.
	// `Rooms_Battle_AlgoEndpoint_PlayHighlight_TabsTest_Explore`), and the answer is the
	// ranked entities that fill it, which the client then resolves by id itself.
	//
	// `HotList`, `recentlyupdated` and `new` are ranked for real (see `ROW_FEEDS`), and
	// `recentlyvisited` is per-caller (see `PERSONAL_ROW_FEEDS`). Every other row still serves
	// the canned entities, and an unknown row key gets them too rather than a 404, which the
	// client renders as a row that failed to load. `Type` is echoed back from the query: it
	// tells the client what the `Id`s ARE (rooms, players, …), so answering with a type the
	// caller didn't ask for would have it resolve the ids against the wrong service.
	.get('/algorithmiclists/:list', async (c) => {
		// Echoed, but only when it fits the byte the client reads it back into — anything
		// outside 0–255 can't round-trip, so a nonsense `?type=` gets the default instead of a
		// number that would break the response on the way in.
		const type = Number.parseInt(c.req.query('type') ?? '', 10)
		const echoed = type >= 0 && type <= MAX_LIST_ENTITY_TYPE ? type : DEFAULT_ALGORITHMIC_LIST_TYPE

		const key = c.req.param('list').toLowerCase()

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

		return c.json({ Type: echoed, Entities: ALGORITHMIC_LIST_ENTITIES })
	})

	// Contextual features — the client posts the context it's in and reads back whether the
	// call was accepted. Auth-gated, and the answer is a bare `{ success, error_id, error }`
	// with no payload: the reference server acknowledges the post and carries nothing back,
	// so there is nothing here to serve statically beyond the acknowledgement itself. The
	// body is read for the log only.
	.post('/contextualfeatures', async (c) => {
		const id = await authedId(c)
		if (id === null) return unauthorized(c)

		return c.json({ success: true, error_id: null, error: null })
	})

export default app
