import { Hono } from 'hono'
import { describeRoute } from 'hono-openapi'

import { getRoomById } from '@repo/domain'

import { authedId } from '../http'
import {
	AUTHED,
	BareBoolean,
	form,
	json,
	JsonArray,
	QuickPlayResponse,
	TagFilters,
	VerifyRoleRequest,
} from '../openapi'

import type { App } from '../context'

// ---- Room keys / quick play / rooms ----------------------------------------
export const roomRoutes = new Hono<App>({ strict: false })
	.get(
		'/api/roomkeys/v1/mine',
		describeRoute({
			tags: ['Rooms'],
			summary: 'The caller’s room keys',
			description: 'Nothing issues room keys yet, so this is an empty list.',
			responses: { 200: json(JsonArray, 'An empty list') },
		}),
		(c) => c.json([])
	)
	.get(
		'/api/roomkeys/v1/room',
		describeRoute({
			tags: ['Rooms'],
			summary: 'A room’s keys',
			description: 'Nothing issues room keys yet, so this is an empty list.',
			responses: { 200: json(JsonArray, 'An empty list') },
		}),
		(c) => c.json([])
	)
	.get(
		'/api/quickPlay/v1/getandclear',
		describeRoute({
			tags: ['Rooms'],
			summary: 'Take the pending quick-play action',
			description:
				'A read-and-clear of whatever quick-play action is queued for the caller (joining ' +
				'a friend, an invite deep link). Nothing queues one yet, so all three fields are ' +
				'null — which the client reads as “nothing to do”.',
			responses: { 200: json(QuickPlayResponse, 'All null — no pending action') },
		}),
		(c) => c.json({ RoomName: null, ActionCode: null, TargetPlayerId: null })
	)

	// Room search filters. The client deserializes this into an object (not an
	// array) — shape from the 2025 reference.
	.get(
		'/api/rooms/v1/filters',
		describeRoute({
			tags: ['Rooms'],
			summary: 'Room browse filter chips',
			description:
				'The filter chips on the room browse screen. Static, taken from the 2025 ' +
				'reference. The client deserializes this as an OBJECT, not an array — and unlike ' +
				'the invention/event filters, `TrendingFilters` here is a real list.',
			responses: { 200: json(TagFilters, 'The filter chips') },
		}),
		(c) =>
			c.json({
				PinnedFilters: [
					'recroomoriginal',
					'community',
					'featured',
					'quest',
					'pvp',
					'hangout',
					'game',
					'art',
					'store',
					'tutorial',
					'fandom',
					'performance',
					'action',
					'horror',
				],
				PopularFilters: ['pvp', 'quest', 'game', 'hangout', 'art'],
				TrendingFilters: [
					'roleplay',
					'nomp',
					'rp',
					'casual',
					'fun',
					'action',
					'military',
					'sports',
				],
			})
	)

	// Verify the caller holds at least `role` in a room. Params come from the form
	// body (falling back to the query string). Returns a bare `true`/`false`: the
	// room creator always passes; otherwise the caller needs a Roles entry with
	// `Role >= role`. Any failure (no token, unknown room, insufficient role) is
	// `false`. The `context` field (e.g. MakerPen) is accepted and ignored.
	.post(
		'/api/rooms/v1/verifyRole',
		describeRoute({
			tags: ['Rooms'],
			summary: 'Verify the caller’s role in a room',
			description:
				'Whether the caller holds at least `role` in the room — the gate the client checks ' +
				'before letting someone into the Maker Pen. The room’s creator always passes; ' +
				'anyone else needs a `Roles` entry at that level or higher.\n\n' +
				'Answers a bare `true`/`false`, and every failure is `false` rather than an error ' +
				'status: no token, an unknown room, and an insufficient role are indistinguishable ' +
				'to the client. Params are read from the form body, falling back to the query ' +
				'string. Room data is read from the shared rooms database (owned by the `rooms` ' +
				'worker).',
			security: AUTHED,
			requestBody: form(VerifyRoleRequest, 'The room and the role level to check'),
			responses: { 200: json(BareBoolean, 'Whether the caller holds the role') },
		}),
		async (c) => {
			const body = (await c.req.parseBody().catch(() => ({}))) as Record<string, unknown>
			const param = (name: string): string => {
				// (named `fromBody` rather than `form` — the openapi helper owns that name here)
				const fromBody = body[name]
				if (typeof fromBody === 'string' && fromBody !== '') return fromBody
				return c.req.query(name) ?? ''
			}
			const roomId = Number.parseInt(param('roomId'), 10)
			const rawRole = param('role').trim()
			const role = /^-?\d+$/.test(rawRole) ? Number(rawRole) : Number.NaN

			const accountId = await authedId(c)
			if (accountId === null || Number.isNaN(roomId)) return c.json(false)

			const room = await getRoomById(c.env.DB, roomId)
			if (!room) return c.json(false)

			// The creator always passes.
			if (room.CreatorAccountId === accountId) return c.json(true)

			// Otherwise the caller needs a room role at least as high as requested.
			const roles = Array.isArray(room.Roles) ? (room.Roles as Array<Record<string, unknown>>) : []
			const hasRole = roles.some(
				(r) => r.AccountId === accountId && typeof r.Role === 'number' && r.Role >= (role || 0)
			)
			return c.json(hasRole)
		}
	)
