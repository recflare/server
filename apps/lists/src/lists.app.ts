import { Hono } from 'hono'
import { useWorkersLogger } from 'workers-tagged-logger'

import { getHotRooms } from '@repo/domain'
import { withNotFound, withOnError } from '@repo/hono-helpers'
import { validateAndGetAccountId } from '@repo/jwt'

import type { Context } from 'hono'
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
 * What the ids in a list ARE. One enum shared by the curated lists' `Type` and the
 * algorithmic lists' — a BYTE on the client, so only 0–255 round-trips.
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
 * The canned discovery pages served by `GET /curatedlists`, keyed by the `Name` the client
 * asks for. `ItemIds` are discovery row keys (strings), `Description` is null but
 * `ImageName` must be a string, and `CreatedAt` keeps its 7-digit fractional seconds — all
 * as the client's parser expects them.
 *
 * `ListId` is ours to choose and is deliberately SMALL. The reference's ids are 64-bit
 * (`624765592684307326`), past what a JS number holds exactly, so serving them verbatim
 * meant carrying them as bigints and hand-writing the JSON to keep the digits — machinery
 * for an id nothing on this server looks up. What the id has to be is stable and unique
 * per page: the client caches a list against it, so two pages sharing one id would serve
 * each other's rows from cache, and changing a page's id would drop its cache. Renumber
 * only when the page's contents are meant to be re-fetched.
 */
const CURATED_LISTS = [
	{
		ListId: 1,
		CreatorAccountId: 1,
		Name: 'Discovery.PageSource.PlayExplore',
		Description: null,
		ImageName: 'DefaultRoomImage.jpg',
		Type: ListEntityType.DiscoverySection,
		ItemIds: [
			'Rooms_New_PlayHighlight_TabsTest_Explore',
			'RoomCategories_MoodPlaylists_FeelingLucky',
			'Rooms_RecentlyUpdated_TabsTest_Explore',
			'Rooms_Battle_AlgoEndpoint_PlayHighlight_TabsTest_Explore',
			'Rooms_Quests_AlgoEndpoint_PlayHighlight_TabsTest_Explore',
			'Rooms_Roleplay_AlgoEndpoint_PlayHighlight_TabsTest_Explore',
			'Rooms_Horror_AlgoEndpoint_PlayHighlight_TabsTest_Explore',
			'Rooms_Hangout_AlgoEndpoint_PlayHighlight_TabsTest_Explore',
			'Rooms_Casual_AlgoEndpoint_PlayHighlight_TabsTest_Explore',
			'Rooms_Explore_AlgoEndpoint_PlayHighlight_TabsTest_Explore',
		],
		Accessibility: 1,
		CreatedAt: '2025-04-23T18:27:03.2643786Z',
	},
	{
		ListId: 2,
		CreatorAccountId: 1,
		Name: 'Discovery.PageSource.PlayLibrary',
		Description: null,
		ImageName: 'DefaultRoomImage.jpg',
		Type: ListEntityType.DiscoverySection,
		// The library page: what you were playing, saved, favorited and made. Note the
		// second row is a `PlayHighlight` key rather than a `PlayLibrary` one — that is the
		// reference's own naming, not a typo to tidy.
		ItemIds: [
			'Rooms_ContinuePlaying_PlayLibrary',
			'Rooms_SavedForLater_PlayHighlight',
			'Rooms_Favorites_PlayLibrary',
			'Rooms_MyRooms_Play',
		],
		Accessibility: 1,
		CreatedAt: '2025-04-23T18:25:31.5308539Z',
	},
]

/**
 * The entities an algorithmic list hands back (`GET /algorithmiclists/:list`) — ROOMS, which
 * is what a Play/Explore row is built from. Nothing ranks anything here yet, so one canned
 * set answers every row: rooms 2–6, the low ids this server's own rooms occupy, so a
 * discovery row resolves to something real instead of five dead ids.
 *
 * `Id` is a STRING even though a room id is a number, and `Context` is where the reference
 * server attributes the ranking/experiment that produced the entity. Nothing produced these,
 * so it is null on every one rather than a made-up context the client would carry into
 * telemetry.
 */
const ALGORITHMIC_LIST_ENTITIES: Array<{ Id: string; Context: string | null }> = [
	'2',
	'3',
	'4',
	'5',
	'6',
].map((Id) => ({ Id, Context: null }))

/**
 * The row key that serves the LIVE hot-room ranking rather than the canned entities — the
 * same feed the rooms worker's `/rooms/hot` answers, which is what a "Hot" row on a
 * discovery page is supposed to show. Matched case-insensitively, since the key reaches us
 * from a curated page's `ItemIds` and its casing is the reference's, not ours.
 */
const HOT_LIST_KEY = 'hotlist'

/** How many rooms the hot row carries. A discovery carousel shows a page, not the world. */
const HOT_LIST_SIZE = 20

/**
 * The entity type an algorithmic list reports when the query names none. The client always
 * sends `?type=`, and `Rooms` is what it asks for; falling back to `Accounts` (0, the enum's
 * zero value) would have the row resolve room ids against the account service.
 */
const DEFAULT_ALGORITHMIC_LIST_TYPE = ListEntityType.Rooms

/**
 * Each page keyed by its lowercased `Name` — the only thing a request decides is which one
 * it gets. Each entry is an ARRAY of one list: the endpoint answers a collection, and the
 * client reads it as such however many entries come back.
 */
const CURATED_LIST_PAGES = new Map(CURATED_LISTS.map((list) => [list.Name.toLowerCase(), [list]]))

/**
 * What a request that names no page — or names one nothing is captured for — gets: the
 * Explore page. A 404 or an empty array renders as an empty Play page, so answering with
 * SOMETHING is the better failure, and it is also what the reference was observed doing
 * for a `name` this server has no list under.
 */
const DEFAULT_CURATED_LIST_PAGE = CURATED_LIST_PAGES.get('discovery.pagesource.playexplore')!

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

	// The curated lists behind a discovery page (`GET /curatedlists`). The client asks with
	// `?creatorAccountId=&type=&name=`, and `name` is the page it wants
	// (`Discovery.PageSource.PlayExplore`, `…PlayLibrary`): it picks which canned page comes
	// back, matched case-insensitively. Nothing curates lists here, so the pages are static
	// captures — the same stand-in posture as `/curatedlists/bulk` above.
	//
	// `creatorAccountId` and `type` are accepted and IGNORED, deliberately: the reference was
	// observed answering a `type=5` request with a `Type` 7 list, so filtering on them would
	// answer nothing where it answers a page. An unknown `name` falls back to Explore rather
	// than an empty array, which renders as an empty Play page.
	//
	// `ItemIds` are the discovery ROWS the page is built from (algorithm/section keys), not
	// room ids — the client resolves each one itself.
	.get('/curatedlists', async (c) => {
		const name = c.req.query('name') ?? ''
		return c.json(CURATED_LIST_PAGES.get(name.toLowerCase()) ?? DEFAULT_CURATED_LIST_PAGE)
	})

	// One discovery ROW's contents (`GET /algorithmiclists/:list?type=1`). `:list` is the row
	// key the curated page above lists in its `ItemIds` (e.g.
	// `Rooms_Battle_AlgoEndpoint_PlayHighlight_TabsTest_Explore`), and the answer is the
	// ranked entities that fill it, which the client then resolves by id itself.
	//
	// `HotList` is ranked for real — the same feed the rooms worker's `/rooms/hot` serves.
	// Every other row still serves the canned entities, and an unknown row key gets them too
	// rather than a 404, which the client renders as a row that failed to load. `Type` is
	// echoed back from the query: it tells the client what the `Id`s ARE (rooms, players, …),
	// so answering with a type the caller didn't ask for would have it resolve the ids
	// against the wrong service.
	.get('/algorithmiclists/:list', async (c) => {
		// Echoed, but only when it fits the byte the client reads it back into — anything
		// outside 0–255 can't round-trip, so a nonsense `?type=` gets the default instead of a
		// number that would break the response on the way in.
		const type = Number.parseInt(c.req.query('type') ?? '', 10)
		const echoed = type >= 0 && type <= MAX_LIST_ENTITY_TYPE ? type : DEFAULT_ALGORITHMIC_LIST_TYPE

		// `HotList` is real: it serves the same ranking the rooms worker's `/rooms/hot` feed
		// does — live player count first, then engagement — so the Hot row on a discovery page
		// shows the rooms people are actually in. Only the ids travel; the client resolves each
		// room itself, which is why this reads the ranking and throws the room blobs away.
		if (c.req.param('list').toLowerCase() === HOT_LIST_KEY) {
			const { Results } = await getHotRooms(c.env.DB, '', 0, HOT_LIST_SIZE)
			return c.json({
				Type: echoed,
				Entities: Results.map((room) => ({ Id: String(room.RoomId), Context: null })),
			})
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
