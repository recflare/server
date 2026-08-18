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
	'bulk',
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

describe('GET /openapi.json', () => {
	it('generates a spec with no dangling $refs', async () => {
		const res = await SELF.fetch('https://discovery.example.com/openapi.json')
		expect(res.status).toBe(200)
		const spec = (await res.json()) as { paths: Record<string, unknown> }
		expect(Object.keys(spec.paths)).toContain('/sections/pagesource/{type}')
		expect(JSON.stringify(spec).match(/\$ref/g)).toBeNull()
	})
})
