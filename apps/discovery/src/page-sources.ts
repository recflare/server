import type { Context } from 'hono'
import type { App } from './context'

/**
 * The discovery page layouts, one file per page source in `static/`, served through the
 * ASSETS binding (see wrangler.jsonc). `{type}` IS the filename: it is passed through to
 * `static/<type>.json` unchanged, so publishing a new page source is dropping in a file —
 * nothing in this worker enumerates or knows their names.
 *
 * Case included: the asset manifest is case-sensitive, so a file must be named exactly as
 * the client asks for it (`WatchHome.json`, not `watchhome.json`). Nothing here folds the
 * case, because there is no index to fold it against.
 */

/**
 * What may reach the binding as a filename. Deliberately narrow — no dots, no slashes,
 * nothing that could climb out of `static/` — so a path traversal is a 404 from this
 * worker rather than a request the asset server has to be trusted to refuse.
 */
const SAFE_NAME = /^[A-Za-z0-9_-]+$/

/**
 * Fetch `static/<type>.json` through the ASSETS binding. `null` when no such file is
 * published, or when the name isn't one a file could have.
 *
 * The asset response is handed back whole rather than parsed and re-serialized: it
 * already carries the right content type and an etag, so a client that sends
 * `If-None-Match` gets its 304 for free.
 */
export async function fetchPageSource(c: Context<App>, type: string): Promise<Response | null> {
	if (!SAFE_NAME.test(type)) return null

	// Forwarding the original request keeps its conditional headers, so the binding
	// answers 304 on a match; only the URL is rewritten to the asset's path.
	const res = await c.env.ASSETS.fetch(new Request(new URL(`/${type}.json`, c.req.url), c.req.raw))
	return res.ok || res.status === 304 ? res : null
}

/**
 * The file holding every section the client can ask for by id — the union of the rows the
 * page sources draw from, which `/sections/bulk` filters. It is a plain file in `static/`
 * like the page layouts, but it is NOT a page source: nothing draws it as a page, so it is
 * deliberately not reachable through `/sections/pagesource/:type` (`SAFE_NAME` would let it
 * through; the route simply isn't what asks for it).
 */
export const SECTIONS_CATALOGUE = 'sections'

/**
 * One row of a section file, as it is stored. Read as a bare record rather than a typed
 * section because the rows are served back UNCHANGED — only `id` is ever looked at, and a
 * field this worker doesn't model has to survive the round trip rather than be dropped by
 * a projection.
 */
export type SectionRow = Record<string, unknown>

/**
 * Read and parse `static/<name>.json`. `null` when no such file is published.
 *
 * Unlike `fetchPageSource` this does NOT forward the caller's request. The body is needed
 * here to filter, and forwarding would let a caller whose `If-None-Match` happens to match
 * the FILE's etag get a bodiless 304 — wrong for a response that is a subset of the file
 * rather than the file itself.
 */
export async function readSections(c: Context<App>, name: string): Promise<SectionRow[] | null> {
	if (!SAFE_NAME.test(name)) return null

	const res = await c.env.ASSETS.fetch(new URL(`/${name}.json`, c.req.url))
	if (!res.ok) return null

	const rows: unknown = await res.json()
	return Array.isArray(rows) ? (rows as SectionRow[]) : null
}
