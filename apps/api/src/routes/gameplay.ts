import { Hono } from 'hono'
import { describeRoute } from 'hono-openapi'

import charadesWords from '../../static/charades.json'
import communityBoard from '../../static/community-board.json'
import { authedId, unauthorized } from '../http'
import {
	AUTHED,
	BareString,
	idParam,
	IsPureResponse,
	json,
	JsonArray,
	jsonBody,
	JsonObject,
	KeepsakeCategories,
	KeepsakeConfig,
	SanitizeRequest,
	stringParam,
	UNAUTHORIZED_RESPONSE,
} from '../openapi'
import {
	censorSwears,
	containsSwears,
	DEFAULT_REPLACEMENT_CHAR,
	removeBlockedCharacters,
} from '../sanitize'

import type { Context } from 'hono'
import type { App } from '../context'

/**
 * A sanitize request, as the client posts it:
 *
 * ```json
 * { "Value": "...", "ReplacementChar": "*", "Context": "RoomChat",
 *   "Intent": 1, "ruleset": 0, "PreRemoveBlockedCharacters": false }
 * ```
 *
 * Fields are read case-insensitively because the client's own casing isn't consistent —
 * it sends `ruleset` lowercase among otherwise PascalCase keys, and a reader that trusts
 * one spelling silently ignores the other.
 *
 * `Context` ("RoomChat", and whatever else names the surface being checked), `Intent` and
 * `ruleset` are read but not acted on: they select among the reference's several
 * filtering policies and this server has one, so honouring them would mean inventing
 * differences between them. A body that isn't JSON, or carries no `Value`, reads as the
 * empty string — nothing to object to, rather than a bad request.
 */
async function sanitizeRequest(
	c: Context<App>
): Promise<{ value: string; replacementChar: string; preRemoveBlockedCharacters: boolean }> {
	const body = await c.req
		.json<Record<string, unknown>>()
		.catch(() => ({}) as Record<string, unknown>)
	const field = (name: string): unknown => {
		const key = Object.keys(body).find((k) => k.toLowerCase() === name.toLowerCase())
		return key === undefined ? undefined : body[key]
	}
	const value = field('Value')
	const replacementChar = field('ReplacementChar')
	return {
		value: typeof value === 'string' ? value : '',
		replacementChar:
			typeof replacementChar === 'string' && replacementChar !== ''
				? replacementChar
				: DEFAULT_REPLACEMENT_CHAR,
		preRemoveBlockedCharacters: field('PreRemoveBlockedCharacters') === true,
	}
}

// Text sanitization, keepsakes, objectives/events/rewards, and the misc analytics
// sinks the client hits during load.
export const gameplayRoutes = new Hono<App>({ strict: false })
	// Text sanitization (display names, room names, chat). `v1` masks the swears in the
	// text and hands it back; `isPure` answers the same question as a yes/no.
	.post(
		'/api/sanitize/v1',
		describeRoute({
			tags: ['Gameplay'],
			summary: 'Sanitize a string',
			description:
				'Masks any swear in the posted `Value` and returns the cleaned text as a bare JSON ' +
				'string. Each character of a swear becomes the request’s `ReplacementChar` (`*` when ' +
				'it names none), so the shape of the message survives; text with nothing to object ' +
				'to comes back untouched. `PreRemoveBlockedCharacters` strips control and zero-width ' +
				'characters first — the ones used to break a word up so a filter misses it. ' +
				'`Context`, `Intent` and `ruleset` are accepted and ignored: they pick among the ' +
				'reference’s filtering policies, and this server has one.',
			requestBody: jsonBody(SanitizeRequest, 'The text to clean'),
			responses: { 200: json(BareString, 'The cleaned text (a bare JSON string)') },
		}),
		async (c) => {
			const { value, replacementChar, preRemoveBlockedCharacters } = await sanitizeRequest(c)
			const text = preRemoveBlockedCharacters ? removeBlockedCharacters(value) : value
			return c.json(censorSwears(text, replacementChar))
		}
	)
	// The yes/no form of the filter, and the one that actually filters: the client asks
	// this before it accepts a display name, a room name or an invention title. Auth-gated,
	// as the reference is — the client only ever asks while logged in.
	.post(
		'/api/sanitize/v1/isPure',
		describeRoute({
			tags: ['Gameplay'],
			summary: 'Whether a string is clean',
			description:
				'Reports whether the posted `Value` contains a swear — the check the client runs ' +
				'against a display name, room name or invention title before it accepts one. ' +
				'Matching is word-boundary aware, so ordinary words that contain a swear ' +
				'(`analysis`, `Scunthorpe`, `class`) are pure, while leetspeak (`sh1t`, `a$$hole`) ' +
				'is not. An empty or absent `Value` is pure.',
			security: AUTHED,
			requestBody: jsonBody(SanitizeRequest, 'The text to check'),
			responses: {
				200: json(IsPureResponse, 'Whether the text is clean'),
				401: UNAUTHORIZED_RESPONSE,
			},
		}),
		async (c) => {
			const id = await authedId(c)
			if (id === null) return unauthorized(c)
			const { value } = await sanitizeRequest(c)
			return c.json({ IsPure: !containsSwears(value) })
		}
	)

	// ---- Activities -----------------------------------------------------------
	// Word bank for the Charades activity. The client requests the list by
	// activity name (`.../words/Charades`); other activities have no data yet.
	.get(
		'/api/activities/charades/v1/words/:activity',
		describeRoute({
			tags: ['Gameplay'],
			summary: 'An activity’s word bank',
			description:
				'The words the Charades activity draws from. The client asks by activity name ' +
				'(`.../words/Charades`); the name is not matched on, so every activity gets the ' +
				'charades list — no other activity has data yet.',
			parameters: [stringParam('activity', 'Activity name, e.g. `Charades`. Not matched on.')],
			responses: { 200: json(JsonArray, 'The word list') },
		}),
		(c) => c.json(charadesWords)
	)

	// Keepsakes (room mementos). Stubbed empty.
	.get(
		'/api/keepsakes/globalconfig',
		describeRoute({
			tags: ['Gameplay'],
			summary: 'Keepsake feature switches',
			description:
				'Whether keepsakes (room mementos) are on and how many a room may hold. The ' +
				'feature reports as enabled, but nothing stores keepsakes yet.',
			responses: { 200: json(KeepsakeConfig, 'The keepsake config') },
		}),
		(c) =>
			c.json({ KeepsakeFeatureEnabled: true, KeepsakeRoomLimit: 10, SocialXpBoostEnabled: false })
	)
	.get(
		'/api/keepsakes/rooms/:roomId',
		describeRoute({
			tags: ['Gameplay'],
			summary: 'A room’s keepsakes',
			description:
				'No keepsake storage yet. Answers 204 with no body rather than an empty list — ' +
				'that is what the reference does, and the client treats a body here as data.',
			parameters: [idParam('roomId', 'Room id')],
			responses: { 204: { description: 'No keepsakes (empty body)' } },
		}),
		(c) => c.body(null, 204)
	)
	// A counted result set, NOT the bare list the stubs around it serve: the client parses
	// this one as an object and an array fails it outright — "expected:'{', actual:'[', at
	// offset:0", logged as "Failed to get keepsake categories" — which takes the keepsake
	// load down with it. `TotalResults` is the length of `Results`, not a total behind a
	// page; the reference returns `results.Length`.
	.get(
		'/api/keepsakes/categories',
		describeRoute({
			tags: ['Gameplay'],
			summary: 'Keepsake categories',
			description:
				'No keepsake catalog yet, so the result set is empty — but it IS a result set ' +
				'(`{ Results, TotalResults }`), not the empty list the stubs around it serve. ' +
				"The client parses this one as an object and fails on an array (\"expected '{', " +
				"actual '['\"), taking the keepsake load down with it. `TotalResults` counts " +
				'`Results` itself — there is no paging here.',
			responses: { 200: json(KeepsakeCategories, 'An empty result set') },
		}),
		(c) => c.json({ Results: [], TotalResults: 0 })
	)

	// ---- Objectives / events / rewards ---------------------------------------
	// Objectives live on the `econ` host (`updateobjective` / `myprogress`), which is
	// where the client calls them — they are not served here.
	.get(
		'/api/communityboard/v2/current',
		describeRoute({
			tags: ['Gameplay'],
			summary: 'The current community board',
			description:
				'The rotating community board on the home screen — featured player, featured room ' +
				'group, announcement and image strips. Served verbatim from a static blob.',
			responses: { 200: json(JsonObject, 'The community board') },
		}),
		(c) => c.json(communityBoard)
	)
	// Player events live in their own controller (routes/events.ts) — they're D1-backed
	// now, unlike the stubs around them here.
	.get(
		'/api/announcement/v1/get',
		describeRoute({
			tags: ['Gameplay'],
			summary: 'Announcements',
			description: 'The announcement banners on the home screen. Not hydrated yet.',
			responses: { 200: json(JsonArray, 'An empty list') },
		}),
		(c) => c.json([])
	) // TODO: hydrate from JSON/announcements.json

	// GameSight attribution/analytics event sink. Accept and ack without persisting.
	.post(
		'/api/gamesight/event',
		describeRoute({
			tags: ['Gameplay'],
			summary: 'Analytics event sink',
			description:
				'The client’s GameSight attribution/analytics events. Accepted and dropped — ' +
				'nothing is persisted. Answers 200 with an empty body.',
			responses: { 200: { description: 'Accepted (empty body)' } },
		}),
		(c) => c.body(null, 200)
	)
