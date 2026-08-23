import { Hono } from 'hono'
import { describeRoute, openAPIRouteHandler } from 'hono-openapi'
import { useWorkersLogger } from 'workers-tagged-logger'

import { createRoomComment, DEFAULT_COMMENT_COUNT, getRoomComments } from '@repo/domain'
import { withCleanSpec, withNotFound, withOnError } from '@repo/hono-helpers'
import { validateAndGetAccountId } from '@repo/jwt'

import {
	AUTHED,
	CommentCreateBody,
	form,
	HealthResponse,
	json,
	RoomCommentEntry,
	UNAUTHORIZED_RESPONSE,
} from './openapi'

import type { Context } from 'hono'
import type { App } from './context'

/**
 * Room Comments Worker. Serves the notes a player pins in a room's scene — a message, a
 * bubble style and the point in the subroom it floats at — which everyone standing there
 * sees.
 *
 * The read is deliberately NOT gated: a comment is a fixture of the room, visible to
 * whoever walks in, and the client fetches the list on load. Writing needs a token, since
 * the comment is signed with the author's account id.
 */

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

/** A path/query integer, or null when it's absent or not a number. */
function intOrNull(value: string | undefined): number | null {
	if (value === undefined || value.trim() === '') return null
	const n = Number(value)
	return Number.isFinite(n) ? Math.trunc(n) : null
}

/** A form field as a float. Unparseable text (and an absent field) is 0, not NaN. */
function floatOrZero(value: unknown): number {
	if (typeof value !== 'string') return 0
	const n = Number(value)
	return Number.isFinite(n) ? n : 0
}

/**
 * The longest comment that is stored. The client's own box stops well short of this; the
 * cap is here so a hand-rolled request can't park a megabyte in a room.
 */
const MAX_COMMENT_LENGTH = 1000

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

	// Root health check.
	.get(
		'/',
		describeRoute({
			tags: ['Service'],
			summary: 'Health check',
			description: 'Liveness probe for the roomcomments worker. No auth.',
			responses: { 200: json(HealthResponse, 'Service is up') },
		}),
		(c) => c.json({ service: 'roomcomments', status: 'ok' })
	)

	// A room's comments, newest first.
	.get(
		'/comments/get/:roomId',
		describeRoute({
			tags: ['Room Comments'],
			summary: 'A room’s comments',
			description: [
				'The comments pinned in a room, newest first. Public — a comment is a fixture of the',
				'room and the client fetches the list on load, so no token is needed. `Unread` is',
				'always true; nothing marks a comment read.',
				'',
				'`minId` is an EXCLUSIVE cursor, which is why the client’s "give me everything"',
				'sentinel is `-1` rather than `0`: a client holding comments up to id N polls with',
				'`minId=N` and gets only what was written since. `count` caps the page (default',
				`${DEFAULT_COMMENT_COUNT}, max 500\`); because the order is newest-first, a fresh client`,
				'asking a busy room for 100 gets the 100 that are actually on the wall rather than the',
				'oldest hundred.',
				'',
				'An unknown room simply has no comments — `[]`, not a 404.',
			].join(' '),
			parameters: [
				{
					name: 'roomId',
					in: 'path',
					required: true,
					schema: { type: 'integer' },
					description: 'The room to read',
				},
				{
					name: 'count',
					in: 'query',
					schema: { type: 'integer' },
					description: `How many to serve (default ${DEFAULT_COMMENT_COUNT}, clamped to 1–500)`,
				},
				{
					name: 'minId',
					in: 'query',
					schema: { type: 'integer' },
					description: 'Exclusive id cursor; `-1` (the default) serves the newest page',
				},
				{
					name: 'subRoomId',
					in: 'query',
					schema: { type: 'integer' },
					description: 'Narrow to one subroom; omitted, the whole room’s comments are served',
				},
			],
			responses: { 200: json(RoomCommentEntry.array(), 'The room’s comments, newest first') },
		}),
		async (c) => {
			const roomId = intOrNull(c.req.param('roomId'))
			if (roomId === null) return c.json([])

			return c.json(
				await getRoomComments(c.env.DB, roomId, {
					count: intOrNull(c.req.query('count')) ?? undefined,
					minId: intOrNull(c.req.query('minId')) ?? undefined,
					subRoomId: intOrNull(c.req.query('subRoomId')),
				})
			)
		}
	)

	// Leave a comment in a room. Auth-gated: the comment is signed with the caller's id.
	.post(
		'/comments/create/:roomId',
		describeRoute({
			tags: ['Room Comments'],
			summary: 'Leave a comment in a room',
			description: [
				'Pins a comment in a subroom’s scene at the given point. The author is the bearer',
				'token’s account — the body carries no account id.',
				'',
				'Answers the created comment itself, so the client can render the bubble it just placed',
				'without re-fetching the list. `Unread` is true on it like everywhere else — it is read',
				'state, not a per-viewer flag, and the author’s own new comment is no exception.',
				'',
				'`positionX/Y/Z` arrive as a C# float’s round-trip text and go back out as numbers.',
				`A blank \`message\` or a missing \`subRoomId\` is a 400; longer than ${MAX_COMMENT_LENGTH}`,
				'characters is truncated rather than rejected.',
			].join(' '),
			security: AUTHED,
			parameters: [
				{
					name: 'roomId',
					in: 'path',
					required: true,
					schema: { type: 'integer' },
					description: 'The room to comment in',
				},
			],
			requestBody: form(CommentCreateBody, 'The comment, form-encoded as the client posts it'),
			responses: {
				200: json(RoomCommentEntry, 'The comment as stored'),
				400: { description: 'Unusable room id, blank message, or missing subroom (empty body)' },
				401: UNAUTHORIZED_RESPONSE,
			},
		}),
		async (c) => {
			const playerId = await authedId(c)
			if (playerId === null) return unauthorized(c)

			const roomId = intOrNull(c.req.param('roomId'))
			if (roomId === null) return c.body(null, 400)

			const body = await c.req.parseBody().catch(() => ({}) as Record<string, unknown>)

			const subRoomId = intOrNull(typeof body.subRoomId === 'string' ? body.subRoomId : undefined)
			if (subRoomId === null) return c.body(null, 400)

			const message = (typeof body.message === 'string' ? body.message : '')
				.trim()
				.slice(0, MAX_COMMENT_LENGTH)
			if (message === '') return c.body(null, 400)

			const comment = await createRoomComment(c.env.DB, roomId, playerId, {
				subRoomId,
				message,
				style: intOrNull(typeof body.style === 'string' ? body.style : undefined) ?? 0,
				positionX: floatOrZero(body.positionX),
				positionY: floatOrZero(body.positionY),
				positionZ: floatOrZero(body.positionZ),
			})
			if (comment === null) return c.body(null, 400)

			return c.json(comment)
		}
	)

// The generated spec. Documentation only — no request is validated against it (see
// openapi.ts). `hide: true` keeps this route out of its own output.
app.get(
	'/openapi.json',
	describeRoute({ hide: true }),
	withCleanSpec(
		openAPIRouteHandler(app, {
			documentation: {
				info: {
					title: 'recflare roomcomments',
					version: '1.0.0',
					description: [
						'Room comments for recflare, a private-server reimplementation of the Rec Room',
						'backend — the notes a player pins in a room’s scene, each with a message, a bubble',
						'style and the point in the subroom it floats at.',
						'',
						'Reads are public — a comment is a fixture of the room, so no token is needed. Writing',
						'needs one, since the comment is signed with the caller’s account id.',
						'',
						'`Unread` is always true. Nothing marks a comment read, and it is read state rather',
						'than a per-viewer flag: the create response carries `Unread: true` for the author’s',
						'own brand-new comment too.',
					].join('\n'),
				},
				servers: [{ url: 'https://roomcomments.recflare.net', description: 'Production' }],
				components: {
					securitySchemes: {
						bearerAuth: {
							type: 'http',
							scheme: 'bearer',
							bearerFormat: 'JWT',
							description: 'An `access_token` from the auth worker’s `POST /connect/token`.',
						},
					},
				},
			},
		})
	)
)

export default app
