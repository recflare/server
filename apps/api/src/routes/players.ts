import { Hono } from 'hono'
import { describeRoute } from 'hono-openapi'

// The `playersettings` worker owns this KV map; its defaults are imported as a value
// (a plain array, no runtime dependencies) so a first write from here seeds the same
// settings that worker's first read would have.
import { DEFAULT_SETTINGS } from '../../../playersettings/src/default-settings'
import { authedId, unauthorized } from '../http'
import {
	AUTHED,
	BareBoolean,
	json,
	jsonBody,
	PhotoTaggingSetting,
	SetPhotoTaggingSettingRequest,
	UNAUTHORIZED_RESPONSE,
} from '../openapi'

import type { Context } from 'hono'
import type { App } from '../context'

/**
 * Player-account preferences. These live in the same per-player KV bag the
 * `playersettings` worker serves (`player:{id}` → `{ key: value }`), just under a
 * dedicated route the client calls by name — the reference keeps the photo-tagging
 * setting on the player record, but a settings key is the same thing without a table.
 */

/** The settings key the photo-tagging preference is stored under. */
const PHOTO_TAGGING_KEY = 'PlayerPhotoTaggingSetting'

/**
 * `PlayerPhotoTaggingSetting` — who may tag this player in a photo. Serialized as the
 * ordinal, not the name: the reference server leaves `JsonStringEnumConverter` off, so
 * the client's decoder is reading a number.
 */
const PHOTO_TAGGING_VALUES = ['Anyone', 'Friends', 'NoOne'] as const

/** `Anyone` — what a player who has never set one reads back as. */
const PHOTO_TAGGING_DEFAULT = 0

/** The caller's KV key in the shared player-settings bag. */
function settingsKey(id: number): string {
	return `player:${id}`
}

/**
 * Coerce a posted setting to its ordinal. Accepts the number the client sends and the
 * enum NAME as well, so a client that spells it out still lands on the right value.
 * `null` when the body carries nothing recognizable — the caller answers `false`.
 */
function parsePhotoTaggingSetting(raw: unknown): number | null {
	if (typeof raw === 'number' && Number.isInteger(raw)) {
		return raw >= 0 && raw < PHOTO_TAGGING_VALUES.length ? raw : null
	}
	if (typeof raw !== 'string' || raw === '') return null

	const asNumber = Number.parseInt(raw, 10)
	if (!Number.isNaN(asNumber)) {
		return asNumber >= 0 && asNumber < PHOTO_TAGGING_VALUES.length ? asNumber : null
	}

	const named = PHOTO_TAGGING_VALUES.findIndex((v) => v.toLowerCase() === raw.toLowerCase())
	return named === -1 ? null : named
}

/**
 * The `Setting` field out of a PUT body: JSON (what the client posts, `{ "Setting": 1 }`),
 * or a form-urlencoded `Setting` for hand-rolled callers. Either casing is accepted.
 */
async function readSetting(c: Context<App>): Promise<number | null> {
	const contentType = c.req.header('content-type') ?? ''

	if (contentType.includes('application/json')) {
		const body = await c.req.json<unknown>().catch(() => null)
		if (body === null || typeof body !== 'object') return null
		const rec = body as Record<string, unknown>
		return parsePhotoTaggingSetting(rec.Setting ?? rec.setting)
	}

	const form = await c.req.parseBody().catch(() => ({}) as Record<string, unknown>)
	return parsePhotoTaggingSetting(form.Setting ?? form.setting)
}

// ---- Players ---------------------------------------------------------------
export const playerRoutes = new Hono<App>({ strict: false })
	.get(
		'/api/players/v1/playerPhotoTaggingSetting',
		describeRoute({
			tags: ['Players'],
			summary: 'Who may tag the caller in photos',
			description:
				'The caller’s `PlayerPhotoTaggingSetting` as the enum ORDINAL — `0` Anyone, `1` ' +
				'Friends, `2` NoOne — read from the `PlayerPhotoTaggingSetting` key of the shared ' +
				'player-settings bag the `playersettings` worker serves. A player who has never set ' +
				'one reads back `0` (Anyone), which is the reference’s default; nothing is written ' +
				'on a read.',
			security: AUTHED,
			responses: {
				200: json(PhotoTaggingSetting, 'The setting, as its ordinal'),
				401: UNAUTHORIZED_RESPONSE,
			},
		}),
		async (c) => {
			const id = await authedId(c)
			if (id === null) return unauthorized(c)

			const stored = await c.env.RECFLARE_PLAYER_SETTINGS.get<Record<string, string>>(
				settingsKey(id),
				'json'
			)
			const parsed = parsePhotoTaggingSetting(stored?.[PHOTO_TAGGING_KEY])
			return c.json(parsed ?? PHOTO_TAGGING_DEFAULT)
		}
	)
	.put(
		'/api/players/v1/playerPhotoTaggingSetting',
		describeRoute({
			tags: ['Players'],
			summary: 'Set who may tag the caller in photos',
			description:
				'Writes `{ "Setting": 0 | 1 | 2 }` to the caller’s `PlayerPhotoTaggingSetting` key ' +
				'and answers a bare `true`, as the reference does (it answers `false` when there was ' +
				'nothing to update — here, when the body carries no recognizable setting). The enum ' +
				'NAME is accepted alongside the ordinal. The write MERGES into the player’s settings ' +
				'bag, so it leaves every other key alone; a player with no bag yet is seeded with the ' +
				'`playersettings` defaults first, so this write can’t cost them that seeding.',
			security: AUTHED,
			requestBody: jsonBody(SetPhotoTaggingSettingRequest, 'The setting to store'),
			responses: {
				200: json(BareBoolean, 'True when the setting was written'),
				401: UNAUTHORIZED_RESPONSE,
			},
		}),
		async (c) => {
			const id = await authedId(c)
			if (id === null) return unauthorized(c)

			const setting = await readSetting(c)
			if (setting === null) return c.json(false)

			const kvKey = settingsKey(id)
			const existing = await c.env.RECFLARE_PLAYER_SETTINGS.get<Record<string, string>>(
				kvKey,
				'json'
			)
			const base =
				existing && Object.keys(existing).length > 0
					? existing
					: Object.fromEntries(DEFAULT_SETTINGS.map((s) => [s.Key, s.Value]))

			await c.env.RECFLARE_PLAYER_SETTINGS.put(
				kvKey,
				JSON.stringify({ ...base, [PHOTO_TAGGING_KEY]: String(setting) })
			)
			return c.json(true)
		}
	)
