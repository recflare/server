import { getRoomsByIds, MAX_SHOWCASED_ROOMS, setListItems, showcaseListKey } from '@repo/domain'
import { Accessibility } from '@repo/domain/src/enums'
import { logger } from '@repo/hono-helpers'
import { validateAndGetAccountId } from '@repo/jwt'

import type { Context } from 'hono'
import type { Room } from '@repo/domain'
import type { App } from './context'

/**
 * The player's own showcase: the up-to-five rooms `rooms` serves for `GET /showcase/:playerId`,
 * the rail the game draws on their profile. Stored as the player's `__Showcase_Rooms` list
 * (`lists-db`), the same table as Saved for Later. The game has no screen that edits it, so
 * the account page does, through this one route; it READS back through the game's own
 * `rooms` endpoint. The token names the account, never the body.
 */

const caller = async (c: Context<App>): Promise<number | null> =>
	validateAndGetAccountId(c.req.raw, await c.env.JWT_SECRET.get())

/**
 * Whether `room` may be showcased by `accountId`: one they OWN — created — that the profile
 * can show (public, not a dorm, not taken out of lists). A co-owner manages a room but doesn't
 * own it, so co-owned rooms are refused even though "My rooms" lists them. The visibility half
 * mirrors what `rooms` filters on read: the picker reads back through that endpoint, so a pick
 * it wouldn't serve would vanish from the picker and be dropped on the next save.
 */
const showcasable = (room: Room, accountId: number) =>
	room.CreatorAccountId === accountId &&
	room.IsDorm !== true &&
	room.Accessibility === Accessibility.Public &&
	room.ExcludeFromLists !== true

/**
 * `PUT /api/account/showcase` — replace the caller's showcase with `{ roomIds: number[] }`, in
 * the order the rail should show them. At most {@link MAX_SHOWCASED_ROOMS}, and each must be a
 * public room the caller created. Answers `{ roomIds }` as stored.
 */
export async function setShowcaseHandler(c: Context<App>) {
	const accountId = await caller(c)
	if (accountId === null) return c.body(null, 401)

	const body = (await c.req.json().catch(() => null)) as { roomIds?: unknown } | null
	if (body === null || typeof body !== 'object' || !Array.isArray(body.roomIds)) {
		return c.json({ error: 'Expected a JSON body with a `roomIds` array' }, 400)
	}
	const roomIds = [...new Set(body.roomIds)]
	if (!roomIds.every((id): id is number => Number.isSafeInteger(id) && (id as number) > 0)) {
		return c.json({ error: 'Every room id must be a positive integer' }, 400)
	}
	if (roomIds.length > MAX_SHOWCASED_ROOMS) {
		return c.json({ error: `You can showcase at most ${MAX_SHOWCASED_ROOMS} rooms` }, 400)
	}

	const rooms = new Map(
		(await getRoomsByIds(c.env.DB, roomIds)).map((room) => [Number(room.RoomId), room] as const)
	)
	const refused = roomIds.filter((id) => {
		const room = rooms.get(id)
		return room === undefined || !showcasable(room, accountId)
	})
	if (refused.length > 0) {
		return c.json(
			{ error: `Only public rooms you made can be showcased (not ${refused.join(', ')})` },
			403
		)
	}

	const list = await setListItems(c.env.DB, showcaseListKey(accountId), roomIds.map(String))
	logger.info('a player set their room showcase', { accountId, count: roomIds.length })
	return c.json({ roomIds: list.ItemIds.map(Number) })
}
