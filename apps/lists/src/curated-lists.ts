import { DEFAULT_LIST_IMAGE } from '@repo/domain'

import curatedLists from '../static/curated-lists.json'

import type { CuratedList } from '@repo/domain'

export type { CuratedList }

/**
 * The PAGE-SOURCE enum, kept for reference. NOT what a list's `Type` is — see the note on
 * `resolveCuratedList`: the captures and the client's own queries both put the
 * `ListEntityType` there (what the `ItemIds` ARE), not the page. Nothing reads this.
 *
 * `None` is the client's unset sentinel; it never reaches the wire, and nothing is captured
 * under it.
 */
export const CuratedListType = {
	WatchHome: 0,
	PlayHighlight: 1,
	CommunityBoard: 2,
	MobileHome: 3,
	StoreFeatured: 4,
	StoreClothing: 5,
	StoreConsumables: 6,
	PlayCategories: 7,
	StoreInventions: 8,
	TitleScreen: 9,
	PlayMenuTabs: 10,
	OrientationStoreFeatured: 11,
	AppNavPortalPanel: 12,
	WWPanelList: 13,
	RecRoomPlusBenefits: 14,
	RecCenterStorefront: 15,
	RecCenterCommunityContent: 16,
	None: 999,
} as const

/**
 * Every list this server serves, all of them in `static/curated-lists.json` — drop a
 * capture into that array and it is served; nothing else needs editing. (One file per list
 * would read better, but wrangler bundles with esbuild, which has no glob import: a
 * directory can only be picked up by naming every file in an `import`. `import.meta.glob`
 * is a Vite feature — vitest runs through Vite and would resolve it, while the deployed
 * build ships the call verbatim and throws at runtime, so tests would pass and the worker
 * would not.)
 *
 * Nothing curates lists here, so these are static captures; ORDER matters only in that the
 * first list of a given type is that page's default (see `BY_TYPE`).
 *
 * `ItemIds` are the discovery ROWS each page is built from (the section keys the `discovery`
 * worker serves under `/sections/pagesource/*`), not room or item ids: the client resolves
 * each row itself.
 */
const CURATED_LISTS: CuratedList[] = curatedLists

/**
 * A list's `ListId` is the reference's own, and those are 64-bit
 * (`624765592684307326`) — past what a JS number holds exactly, so parsing one rounds it
 * (…307326 → …307300). The captures therefore carry it as a STRING, which survives the
 * round trip, and this puts the digits back on the wire unquoted: the client's field is a
 * number, and a quoted id fails its parser.
 *
 * Only a run of digits is unquoted, so a malformed id is left alone rather than corrupting
 * the JSON — the integration tests assert every capture has one.
 */
export function serializeCuratedList(list: CuratedList): string {
	return JSON.stringify(list).replace(/"ListId":"(\d+)"/, '"ListId":$1')
}

/** Names are matched case-insensitively — the casing that reaches us is the client's. */
function nameKey(name: string): string {
	return name.toLowerCase()
}

/** All three keys the query carries. The most specific match wins. */
const BY_CREATOR_TYPE_NAME = new Map<string, CuratedList>()
/** Same list without the creator — the client sometimes asks with a creator nothing owns. */
const BY_TYPE_NAME = new Map<string, CuratedList>()
/** By name alone, for a name whose `type` doesn't line up with what it is captured under. */
const BY_NAME = new Map<string, CuratedList>()
/**
 * By type alone: the page's DEFAULT list, which answers a request that names NO list — only
 * a request that names none. A request that DOES name one and matches nothing is a miss and
 * 404s; handing it the page default answers a question nobody asked, under a heading that
 * belongs to another list.
 */
const BY_TYPE = new Map<number, CuratedList>()

for (const list of CURATED_LISTS) {
	const name = nameKey(list.Name)
	BY_CREATOR_TYPE_NAME.set(`${list.CreatorAccountId}/${list.Type}/${name}`, list)
	if (!BY_TYPE_NAME.has(`${list.Type}/${name}`)) BY_TYPE_NAME.set(`${list.Type}/${name}`, list)
	if (!BY_NAME.has(name)) BY_NAME.set(name, list)
	// First captured wins, so a page with more than one list defaults to whichever sits
	// earliest in `static/curated-lists.json`.
	if (!BY_TYPE.has(list.Type)) BY_TYPE.set(list.Type, list)
}

/**
 * The prefix the reference gives a list the CLIENT owns and creates for itself, rather than
 * one a person named — `__SavedForLater_Rooms` is the one in play. It matters because these
 * are the only names that must be allowed to come back EMPTY: see `resolveCuratedList`.
 */
const RESERVED_LIST_PREFIX = '__'

/** Whether a name is one of the client's own reserved playlists rather than a curated page. */
export function isReservedListName(name: string | undefined): boolean {
	return (name ?? '').startsWith(RESERVED_LIST_PREFIX)
}

/**
 * The list a reserved name answers when nobody owns one yet — the name asked for, with no
 * items. A player who has saved nothing has an empty Saved for Later, not somebody else's
 * list; `CreatorAccountId` is echoed from the query so the client still sees the list it
 * asked for. `ListId` is 0: nothing was stored, so there is no id to hand back, and the
 * client's field is a non-nullable number.
 */
function emptyReservedList(creatorAccountId: string | undefined, type: number, name: string) {
	return {
		ListId: '0',
		CreatorAccountId: Number.parseInt(creatorAccountId ?? '', 10) || 0,
		Name: name,
		Description: null,
		ImageName: DEFAULT_LIST_IMAGE,
		Type: type,
		ItemIds: [],
		Accessibility: 1,
		CreatedAt: new Date(0).toISOString(),
	} satisfies CuratedList
}

/**
 * The list behind `GET /curatedlists?creatorAccountId=&type=&name=` once D1 has been asked
 * and had nothing — the static captures, resolved most-specific first. UNDEFINED when
 * nothing matches, which the route turns into a 404: a name this server has nothing under
 * is a list that does not exist, and answering it with an unrelated capture puts one page's
 * rows under another page's heading.
 *
 * `type` is the `ListEntityType`: what the `ItemIds` ARE. (The client asks for
 * `__SavedForLater_Rooms` with `type=1`, Rooms, and every capture here is `type=7`,
 * DiscoverySection — which is exactly what their ItemIds hold. It is NOT the page-source
 * enum, whose 7 is PlayCategories and would make two of the three captures wrong.)
 *
 * Two things still answer without a name match:
 *
 *  - A RESERVED name (`__SavedForLater_Rooms`), which comes back EMPTY rather than missing:
 *    it is a list the client creates for itself, so "the player has saved nothing" is the
 *    right answer until they do, and an empty list hides the row the way its
 *    `minItemsToShowSection` asks for.
 *  - A request naming no list at all, which gets the page default for its type — the only
 *    list it could be asking for.
 */
export function resolveCuratedList(
	creatorAccountId: string | undefined,
	type: string | undefined,
	name: string | undefined
): CuratedList | undefined {
	const key = nameKey(name ?? '')
	const parsedType = Number.parseInt(type ?? '', 10)
	const hasType = Number.isInteger(parsedType)

	return (
		(hasType ? BY_CREATOR_TYPE_NAME.get(`${creatorAccountId}/${parsedType}/${key}`) : undefined) ??
		(hasType ? BY_TYPE_NAME.get(`${parsedType}/${key}`) : undefined) ??
		BY_NAME.get(key) ??
		(isReservedListName(name)
			? emptyReservedList(creatorAccountId, hasType ? parsedType : 0, name ?? '')
			: undefined) ??
		(key === '' && hasType ? BY_TYPE.get(parsedType) : undefined)
	)
}
