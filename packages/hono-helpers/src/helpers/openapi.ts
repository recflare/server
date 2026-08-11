import type { Handler, MiddlewareHandler } from 'hono'

/**
 * Zod 4 encodes `z.int()` as `{ type: 'integer', minimum: -9007199254740991, maximum:
 * 9007199254740991 }` — the safe-integer range. That is accurate, but Scalar (and most
 * spec viewers) derive the displayed example from `minimum` when a schema carries no
 * `example` of its own, so every integer field in the docs rendered as
 * `-9007199254740991`.
 *
 * The bounds are left alone; we just supply a neutral placeholder so the viewer has
 * something better to show.
 */
const PLACEHOLDER_INTEGER = 12345

/** Recursively add a placeholder example to integer schemas that lack one. */
function addIntegerExamples(node: unknown): void {
	if (Array.isArray(node)) {
		for (const item of node) addIntegerExamples(item)
		return
	}
	if (node === null || typeof node !== 'object') return

	const obj = node as Record<string, unknown>
	if (obj.type === 'integer' && obj.example === undefined && obj.examples === undefined) {
		// Don't contradict a schema that really is narrow (`z.int().max(10)`, an enum-ish
		// range) — the placeholder only goes in where it's a legal value.
		const min = obj.minimum
		const max = obj.maximum
		const tooLow = typeof min === 'number' && PLACEHOLDER_INTEGER < min
		const tooHigh = typeof max === 'number' && PLACEHOLDER_INTEGER > max
		if (!tooLow && !tooHigh) obj.example = PLACEHOLDER_INTEGER
	}
	for (const value of Object.values(obj)) addIntegerExamples(value)
}

/**
 * hono-openapi registers a `validator('form', …)` body under `multipart/form-data` ONLY,
 * and there is no way to ask it for another media type: its media selection reads
 * `options?.media ?? target === 'json' ? 'application/json' : 'multipart/form-data'`,
 * which by JS precedence is `((options?.media ?? target) === 'json') ? … : …` — so the
 * `media` option can never produce anything else.
 *
 * That leaves the spec claiming a validated route accepts only multipart, when the real
 * callers (the Rec Room client and the website) post `application/x-www-form-urlencoded`
 * and Hono's `parseBody()` reads both. So the urlencoded variant is mirrored back in.
 *
 * Safe because nothing here documents a genuinely multipart-only body — there are no file
 * uploads on these workers, and hand-written form bodies already declare both types. If
 * one is ever added, it will need to opt out of this.
 */
function mirrorFormBodies(node: unknown): void {
	if (Array.isArray(node)) {
		for (const item of node) mirrorFormBodies(item)
		return
	}
	if (node === null || typeof node !== 'object') return

	const obj = node as Record<string, unknown>
	const content = obj.content
	if (content !== null && typeof content === 'object') {
		const media = content as Record<string, unknown>
		const multipart = media['multipart/form-data']
		if (multipart !== undefined && media['application/x-www-form-urlencoded'] === undefined) {
			media['application/x-www-form-urlencoded'] = multipart
		}
	}
	for (const value of Object.values(obj)) mirrorFormBodies(value)
}

/**
 * Wrap `openAPIRouteHandler(...)` so the generated document gets example values for its
 * integer fields, and so a validated form body documents both content types it really
 * accepts. Nothing about the runtime behaviour changes — this only corrects the document.
 *
 * ```ts
 * app.get('/openapi.json', describeRoute({ hide: true }), withCleanSpec(openAPIRouteHandler(app, { ... })))
 * ```
 */
export function withCleanSpec(handler: Handler | MiddlewareHandler): Handler {
	return async (c, next) => {
		const res = await (handler as Handler)(c, next)
		if (!(res instanceof Response)) return res as never
		const spec: unknown = await res.json()
		addIntegerExamples(spec)
		mirrorFormBodies(spec)
		return c.json(spec as Record<string, unknown>)
	}
}
