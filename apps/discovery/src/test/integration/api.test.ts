import { SELF } from 'cloudflare:test'
import { describe, expect, it } from 'vitest'

/** Every layout published in `static/` today. Each is served under its own filename. */
const PAGE_SOURCES = [
	'WatchHome',
	'PlayHighlight',
	'CommunityBoard',
	'PlayMenuTabs',
	'PlayCategories',
	'StoreCategories',
	'StoreFeatured',
	'StoreClothing',
	'StoreConsumables',
]

interface Section {
	id: string
	sectionType: number
	sectionSubType: string
	source: string
	sourceMetadata: string | null
	displayMetadata: string | null
}

/** Fetch a page source and return its parsed body. */
async function pageSource(type: string) {
	const res = await SELF.fetch(`https://discovery.example.com/sections/pagesource/${type}`)
	expect(res.status).toBe(200)
	expect(res.headers.get('content-type')).toContain('application/json')
	return (await res.json()) as Section[]
}

describe('GET /', () => {
	it('answers the liveness probe', async () => {
		const res = await SELF.fetch('https://discovery.example.com/')
		expect(res.status).toBe(200)
		expect(await res.json()).toEqual({ service: 'discovery', status: 'ok' })
	})
})

describe('GET /sections/pagesource/:type', () => {
	// The point of the ASSETS binding: `{type}` is the filename, so every published file
	// is reachable without the worker knowing its name.
	it.each(PAGE_SOURCES)('serves %s', async (type) => {
		const sections = await pageSource(type)
		expect(sections.length).toBeGreaterThan(0)
		for (const section of sections) {
			expect(typeof section.id).toBe('string')
			expect(typeof section.sectionType).toBe('number')
			expect(typeof section.source).toBe('string')
			// An embedded JSON *string* the client parses itself, not an object — or null,
			// which several store and play-highlight sections use.
			if (section.displayMetadata !== null) {
				expect(typeof section.displayMetadata).toBe('string')
				expect(() => JSON.parse(section.displayMetadata as string)).not.toThrow()
			}
		}
	})

	it('serves the file verbatim', async () => {
		const sections = await pageSource('WatchHome')
		expect(sections[0]).toEqual({
			id: 'Rooms_ForYou_WatchHome',
			sectionType: 0,
			sectionSubType: 'Rooms_ForYou',
			source: 'CarouselEndpoint',
			sourceMetadata: 'foryou',
			displayMetadata: expect.stringContaining('"DisplayTitle":"Recommended For You"'),
		})
	})

	// The store page builder drops a section it doesn't like SILENTLY — no error reaches the
	// client, the carousel just isn't drawn. Every section of the page we author ourselves
	// has to survive it: a non-empty displayMetadata that parses, sectionType 4
	// (StoreItemsSection) or 13 (DiscoverySection), and for 13 a source of exactly
	// `CuratedList` or `PageSource` carrying its argument.
	//
	// Only StoreCategories is checked this strictly. The other store pages are reference
	// captures served verbatim, and StoreFeatured carries a CustomAvatarItemsSection (8)
	// that this builder would drop — that is the reference's data, not a mistake to fix here.
	it('StoreCategories only carries sections the store page builder keeps', async () => {
		for (const section of await pageSource('StoreCategories')) {
			expect([4, 13]).toContain(section.sectionType)
			expect(section.displayMetadata).toBeTruthy()
			expect(() => JSON.parse(section.displayMetadata as string)).not.toThrow()
			if (section.sectionType === 13) {
				expect(['CuratedList', 'PageSource']).toContain(section.source)
				expect(section.sourceMetadata).toBeTruthy()
			}
		}
	})

	it('serves the StoreCategories page', async () => {
		const sections = await pageSource('StoreCategories')
		expect(sections[0]).toEqual({
			id: 'store-featured',
			// StoreItemsSection: a store CATEGORY is drawn as the product carousel.
			sectionType: 4,
			sectionSubType: 'StoreCategory_Featured',
			source: 'CuratedList',
			// The curated list the `lists` worker serves from /curatedlists/bulk.
			sourceMetadata: '17859340',
			displayMetadata: expect.stringContaining('"DisplayTitle":"Featured"'),
		})
		// displayMetadata must be non-empty and parse, or the builder drops the section.
		const display = JSON.parse(sections[0].displayMetadata as string) as {
			categoryUriNames: string
		}
		expect(display.categoryUriNames).toBe('featured,new')
	})

	// The asset manifest is case-sensitive and there is no index to fold case against, so
	// the name has to match the file exactly.
	it('404s a name whose case does not match the file', async () => {
		const res = await SELF.fetch('https://discovery.example.com/sections/pagesource/watchhome')
		expect(res.status).toBe(404)
	})

	it('404s an unpublished page source', async () => {
		const res = await SELF.fetch('https://discovery.example.com/sections/pagesource/nope')
		expect(res.status).toBe(404)
	})

	// The name reaches the ASSETS binding as a filename, so anything that could climb out
	// of `static/` is refused before it gets there.
	it.each(['..', '%2e%2e%2fwrangler.jsonc', 'sub%2Fdir', 'WatchHome.json'])(
		'404s a name that could not be a file in static/ (%s)',
		async (type) => {
			const res = await SELF.fetch(`https://discovery.example.com/sections/pagesource/${type}`)
			expect(res.status).toBe(404)
		}
	)

	it('answers 304 when the etag matches', async () => {
		const first = await SELF.fetch('https://discovery.example.com/sections/pagesource/WatchHome')
		const etag = first.headers.get('etag')
		expect(etag).toBeTruthy()

		const second = await SELF.fetch('https://discovery.example.com/sections/pagesource/WatchHome', {
			headers: { 'if-none-match': etag as string },
		})
		expect(second.status).toBe(304)
	})

	// `run_worker_first` keeps the layouts off their own asset URLs: the only way to a file
	// is the documented route.
	it('does not serve the files at their asset paths', async () => {
		const res = await SELF.fetch('https://discovery.example.com/WatchHome.json')
		expect(res.status).toBe(404)
	})
})

describe('GET /sections/bulk', () => {
	/** Fetch a set of section ids and return the parsed rows. */
	async function bulk(ids: string[]) {
		const query = ids.map((id) => `id=${encodeURIComponent(id)}`).join('&')
		const res = await SELF.fetch(`https://discovery.example.com/sections/bulk?${query}`)
		expect(res.status).toBe(200)
		expect(res.headers.get('content-type')).toContain('application/json')
		return (await res.json()) as Section[]
	}

	// The ids arrive as a REPEATED parameter, not a delimited one. Reading only the first
	// would drop every row but one and leave the page nearly empty.
	it('serves every id the query repeats', async () => {
		const ids = [
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
		]
		const sections = await bulk(ids)
		expect(sections.map((s) => s.id)).toEqual(ids)
	})

	it('serves the catalogue rows verbatim', async () => {
		const sections = await bulk(['RoomCategories_MoodPlaylists_FeelingLucky'])
		expect(sections).toEqual([
			{
				id: 'RoomCategories_MoodPlaylists_FeelingLucky',
				// RoomCategoryListSection.
				sectionType: 12,
				sectionSubType: 'RoomCategories',
				source: 'CuratedList',
				sourceMetadata: 'RoomCategories.MoodPlaylists.AlgoEndpoint.FeelingLucky',
				displayMetadata: expect.stringContaining('"DisplayTitle":"I\'m Feeling Lucky"'),
			},
		])
	})

	// The answer is the catalogue filtered, so it is ordered by the FILE and not by the
	// query, and an id can only ever come back once however many times it is asked for.
	it('answers in catalogue order regardless of the query order', async () => {
		const sections = await bulk([
			'Rooms_RecentlyUpdated_TabsTest_Explore',
			'Rooms_New_PlayHighlight_TabsTest_Explore',
		])
		expect(sections.map((s) => s.id)).toEqual([
			'Rooms_New_PlayHighlight_TabsTest_Explore',
			'Rooms_RecentlyUpdated_TabsTest_Explore',
		])
	})

	it('yields a repeated id once', async () => {
		const sections = await bulk([
			'Rooms_New_PlayHighlight_TabsTest_Explore',
			'Rooms_New_PlayHighlight_TabsTest_Explore',
		])
		expect(sections.map((s) => s.id)).toEqual(['Rooms_New_PlayHighlight_TabsTest_Explore'])
	})

	// An unknown id is left out rather than erroring: one stale id in a page's list must not
	// take the rest of the page down with it.
	it('skips ids that match nothing', async () => {
		const sections = await bulk(['nope', 'Rooms_MyRooms_Play', 'also-nope'])
		expect(sections.map((s) => s.id)).toEqual(['Rooms_MyRooms_Play'])
	})

	it('answers an empty array when no id matches', async () => {
		expect(await bulk(['nope'])).toEqual([])
	})

	// No ids asked for means nothing wanted — NOT the whole catalogue.
	it('answers an empty array when the query names no ids', async () => {
		const res = await SELF.fetch('https://discovery.example.com/sections/bulk')
		expect(res.status).toBe(200)
		expect(await res.json()).toEqual([])
	})

	// The catalogue is a file in `static/` like the layouts, so the page-source route reaches
	// it too — `{type}` is the filename and nothing indexes which files are pages. Harmless
	// and asserted so the overlap is a known fact rather than a surprise; the client asks for
	// the catalogue through this route's `?id=` filter, never as a page.
	it('is also reachable through the page-source route, unfiltered', async () => {
		const res = await SELF.fetch('https://discovery.example.com/sections/pagesource/sections')
		expect(res.status).toBe(200)
		expect((await res.json()) as Section[]).toHaveLength(14)
	})

	// The response is a SUBSET of the file, so it must never be answered with the file's
	// etag — a client that cached the file would otherwise be told its copy is still good.
	it('ignores a conditional request matching the catalogue file', async () => {
		const sections = await bulk(['Rooms_MyRooms_Play'])
		expect(sections).toHaveLength(1)

		const res = await SELF.fetch(
			'https://discovery.example.com/sections/bulk?id=Rooms_MyRooms_Play',
			{ headers: { 'if-none-match': '"anything"' } }
		)
		expect(res.status).toBe(200)
		expect((await res.json()) as Section[]).toHaveLength(1)
	})
})

describe('GET /openapi.json', () => {
	it('generates a spec with no dangling $refs', async () => {
		const res = await SELF.fetch('https://discovery.example.com/openapi.json')
		expect(res.status).toBe(200)
		const spec = (await res.json()) as { paths: Record<string, unknown> }
		expect(Object.keys(spec.paths)).toContain('/sections/pagesource/{type}')
		expect(Object.keys(spec.paths)).toContain('/sections/bulk')
		expect(JSON.stringify(spec).match(/\$ref/g)).toBeNull()
	})
})
