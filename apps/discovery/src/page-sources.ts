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
