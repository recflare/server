import { resolver } from 'hono-openapi'
import { z } from 'zod'

import type { OpenAPIV3_1 } from 'openapi-types'

/**
 * OpenAPI schemas for the discovery worker.
 *
 * IMPORTANT: these are DESCRIPTIVE ONLY. They are passed to `describeRoute` to generate
 * the spec and are never wired into `hono-openapi`'s `validator()`. Same rationale as
 * the other workers: a reverse-engineered protocol, lenient handlers, no runtime
 * validation.
 *
 * Do NOT add `.meta({ id })` to these schemas — with this hono-openapi + zod v4 setup a
 * meta'd schema used in a response emits a `$ref` the framework doesn't always hoist into
 * `components.schemas`, leaving a dangling reference. Leaving meta off makes every schema
 * inline, which renders correctly in any tool.
 */

/** Emit a zod schema as an `application/json` response body. */
export function json(schema: z.ZodType, description: string) {
	return { description, content: { 'application/json': { schema: resolver(schema) } } }
}

/** The `{type}` path parameter, which is the filename in `static/`. */
export const PAGE_SOURCE_PARAM: OpenAPIV3_1.ParameterObject = {
	name: 'type',
	in: 'path',
	required: true,
	description: [
		'The page source — `WatchHome`, `PlayHighlight`, `CommunityBoard`, `PlayMenuTabs`,',
		'`PlayCategories`, `StoreFeatured`, `StoreClothing`, `StoreConsumables`, `bulk` at the',
		'time of writing. It names a file in `static/` (`<type>.json`) and is matched exactly,',
		'case included, so the set is whatever is published rather than anything this worker',
		'enumerates.',
	].join(' '),
	// Deliberately not an `enum`: the accepted values are the published files, and a spec
	// that froze today's list would be wrong the moment one is added.
	schema: { type: 'string', example: 'WatchHome' },
}

// ---- Response schemas ------------------------------------------------------

/** `GET /` — the liveness probe body. */
export const ServiceStatus = z.object({
	service: z.literal('discovery'),
	status: z.literal('ok'),
})

/**
 * How one carousel on a discovery page is filled and drawn. `source`/`sourceMetadata`
 * name a feed (`Hot`, `Recent`, `PlaylistById` + an id, `CarouselEndpoint` + a slug, …)
 * that the client resolves against the `rooms`/`api` workers itself — this worker only
 * says WHICH carousels a page has and in what order, never their contents.
 */
export const DiscoverySection = z.object({
	id: z.string().describe('Unique id of this section on this page, e.g. `Rooms_RRO_WatchHome`'),
	sectionType: z.int().describe('What the section lists (0 rooms, 1 accounts, 4 store items, …)'),
	sectionSubType: z.string().describe('The section’s kind, shared across pages, e.g. `Rooms_RRO`'),
	source: z.string().describe('The feed that fills the section'),
	sourceMetadata: z
		.string()
		.nullable()
		.describe('Argument to `source` — a carousel slug, a playlist id, … `null` when it takes none'),
	displayMetadata: z
		.string()
		.nullable()
		.describe(
			'How the section is drawn (`DisplayTitle`, `numRows`, `backgroundColor`, …), as an ' +
				'embedded JSON *string* the client parses itself — not an object. Its booleans and ' +
				'numbers are quoted in most sections and bare in some; both forms are live in the ' +
				'captures, so the client evidently takes either. `null` where a section is drawn ' +
				'however its type says (several store and play-highlight sections).'
		),
})

/** `GET /sections/pagesource/{type}` — a page's sections, in the order they are drawn. */
export const DiscoverySections = DiscoverySection.array()
