import { Hono } from 'hono'
import { describeRoute } from 'hono-openapi'

import {
	createImage,
	deleteImage,
	getCheeredImageIds,
	getImageByName,
	getImagesByIds,
	getImagesByPlayer,
	getImagesByRoom,
	getPlayerFeed,
	getSlideshowImages,
	SavedImageType,
	setImageCheer,
	SLIDESHOW_LIMIT,
	SLIDESHOW_MAX_LIMIT,
	toImagesPlayer,
} from '@repo/domain'

import { authedId, unauthorized } from '../http'
import {
	AUTHED,
	CheeredBulkRequest,
	CheeredEntry,
	CheerImageRequest,
	DeleteImageRequest,
	ErrorResponse,
	form,
	idParam,
	ImagesPlayerDto,
	intQuery,
	json,
	JsonArray,
	jsonBody,
	pageParams,
	PhotoTaggingSettingRequest,
	PhotoTaggingSettingResponse,
	SavedImageDto,
	SlideshowResponse,
	stringQuery,
	SuccessResponse,
	UNAUTHORIZED_RESPONSE,
	UploadImageRequest,
	UploadImageResponse,
} from '../openapi'

import type { Context } from 'hono'
import type { App } from '../context'

/** Bucket folder each SavedImageType is stored under; unknown types fall back to `none`. */
const typeFolder: Record<number, string> = {
	[SavedImageType.None]: 'none',
	[SavedImageType.ShareCamera]: 'sharecamera',
	[SavedImageType.OutfitThumbnail]: 'outfit',
	[SavedImageType.RoomThumbnail]: 'room',
	[SavedImageType.ProfileThumbnail]: 'profile',
	[SavedImageType.InventionThumbnail]: 'invention',
}

/**
 * The player-settings key the photo-tagging preference is stored under, in the same
 * per-player bag the `playersettings` worker owns (`player:<id>` → `{ key: value }`). It
 * gets its own endpoints rather than being written through `/playersettings` because the
 * client asks for it by name, but there is no separate store behind it — which is why the
 * write below merges.
 *
 * Unlike the loose matching `match` does for `avoidJuniors`, the spelling is exact: nothing
 * but these two routes reads or writes this key, so there is no client spelling to guess.
 */
const PHOTO_TAGGING_KEY = 'playerPhotoTaggingSetting'

/**
 * The preference a player has before they have ever set one. The value is an opaque enum
 * ordinal to this server (see `PhotoTaggingSettingRequest`), and 0 is what an unset .NET
 * enum reads as — the reference's own default.
 */
const PHOTO_TAGGING_DEFAULT = 0

/** The player's settings map, or null when they have none / KV is unreachable. */
async function getPlayerSettings(
	env: App['Bindings'],
	accountId: number
): Promise<Record<string, string> | null> {
	return env.RECFLARE_PLAYER_SETTINGS.get<Record<string, string>>(
		`player:${accountId}`,
		'json'
	).catch(() => null)
}

/** The caller's stored photo-tagging preference, or the default when they have none. */
async function readPhotoTaggingSetting(env: App['Bindings'], accountId: number): Promise<number> {
	const stored = await getPlayerSettings(env, accountId)
	const raw = stored?.[PHOTO_TAGGING_KEY]
	const parsed = Number.parseInt(String(raw ?? ''), 10)
	return Number.isNaN(parsed) ? PHOTO_TAGGING_DEFAULT : parsed
}

/**
 * Write the preference back into the player's settings map.
 *
 * The write MERGES, as the `playersettings` worker's own PUT does: the map holds every
 * setting the player has (OOBE state, tutorial mask, …), so storing this one on its own
 * would wipe the rest. Read-modify-write on KV isn't atomic, but the same is true there,
 * and racing writers here means one player toggling two of their own options at once.
 */
async function writePhotoTaggingSetting(
	env: App['Bindings'],
	accountId: number,
	setting: number
): Promise<void> {
	const stored = (await getPlayerSettings(env, accountId)) ?? {}
	await env.RECFLARE_PLAYER_SETTINGS.put(
		`player:${accountId}`,
		JSON.stringify({ ...stored, [PHOTO_TAGGING_KEY]: String(setting) })
	)
}

/**
 * The posted `Setting`, out of a JSON body (`{ "Setting": 1 }`, what the client sends) or a
 * form one. Both casings are accepted, and a numeric string parses — the value is an
 * integer either way. `undefined` when the body carries nothing readable, which the caller
 * treats as "leave it alone" rather than as a write of 0.
 */
async function readPostedSetting(c: Context<App>): Promise<number | undefined> {
	const body = (c.req.header('content-type') ?? '').includes('application/json')
		? ((await c.req.json().catch(() => null)) as Record<string, unknown> | null)
		: await c.req.parseBody().catch(() => null)
	if (body === null || typeof body !== 'object' || Array.isArray(body)) return undefined

	const raw = (body as Record<string, unknown>).Setting ?? (body as Record<string, unknown>).setting
	if (typeof raw === 'number') return Number.isFinite(raw) ? Math.trunc(raw) : undefined
	if (typeof raw !== 'string') return undefined
	const parsed = Number.parseInt(raw.trim(), 10)
	return Number.isNaN(parsed) ? undefined : parsed
}

/**
 * The saved-image ids a cheer lookup is asking about, from wherever the client put them.
 *
 * The client POSTs them as a form body of repeated `id` fields — a photo grid asks about a
 * whole page at once, ~100 ids, which is more than it wants to hang off a URL — and the
 * same repeated-field spelling also works as a query string, which is how the GET form of
 * this route takes them. Both are read, so one handler serves either.
 *
 * Each value may itself be a comma-separated list, and unparseable entries are dropped
 * rather than failing the request: a stray id must not cost the caller the rest of the page.
 */
async function cheerLookupIds(c: Context<App>): Promise<number[]> {
	const raw = [...(c.req.queries('id') ?? [])]
	if (c.req.method !== 'GET') {
		const body = await c.req.parseBody({ all: true }).catch(() => ({}) as Record<string, unknown>)
		const key = Object.keys(body).find((k) => k.toLowerCase() === 'id')
		const posted = key === undefined ? [] : body[key]
		for (const value of Array.isArray(posted) ? posted : [posted]) {
			if (typeof value === 'string') raw.push(value)
		}
	}
	return raw
		.flatMap((value) => value.split(','))
		.map((value) => Number.parseInt(value.trim(), 10))
		.filter((imageId) => !Number.isNaN(imageId))
}

/**
 * One `{ SavedImageId, IsCheered }` per requested id, in request order — the shared
 * handler behind both the GET and the POST form of the bulk cheer lookup. The cheer state
 * is the CALLER's, so two players asking about the same photo get different answers.
 */
async function cheerLookup(c: Context<App>) {
	const id = await authedId(c)
	if (id === null) return unauthorized(c)
	const ids = await cheerLookupIds(c)
	const cheered = await getCheeredImageIds(c.env.DB, id, ids)
	return c.json(ids.map((imageId) => ({ SavedImageId: imageId, IsCheered: cheered.has(imageId) })))
}

// ---- Images ----------------------------------------------------------------
export const imageRoutes = new Hono<App>({ strict: false })
	.get(
		'/api/images/v2/named',
		describeRoute({
			tags: ['Images'],
			summary: 'Named images',
			description:
				'The named-image catalog (UI art the client looks up by name). Not hydrated yet.',
			responses: { 200: json(JsonArray, 'An empty list') },
		}),
		(c) => c.json([])
	) // TODO: hydrate from JSON/namedimages.json
	.post(
		'/api/images/v4/uploadsaved',
		describeRoute({
			tags: ['Images'],
			summary: 'Upload a saved image',
			description:
				'Stores a photo in the shared image bucket under a random key, foldered by image ' +
				'type and upload date (e.g. `sharecamera/2026-06-15/…`) so the bucket stays ' +
				'browsable. The returned `ImageName` is that key — the `img` worker serves the ' +
				'object back by it, slashes and all.\n\n' +
				'The `imgMeta` multipart field is a JSON `SavedImageMetaDTO` describing the upload; ' +
				'malformed JSON is tolerated and the image is still stored, just untyped. A ' +
				'`savedImageType` of 4 (profile thumbnail) additionally becomes the account’s ' +
				'avatar, persisted on the account row.',
			security: AUTHED,
			requestBody: form(UploadImageRequest, 'The image file plus its metadata'),
			responses: {
				200: json(UploadImageResponse, 'The stored bucket key'),
				400: json(ErrorResponse, 'No file in the request'),
				401: UNAUTHORIZED_RESPONSE,
			},
		}),
		async (c) => {
			const id = await authedId(c)
			if (id === null) return unauthorized(c)

			const body = await c.req.parseBody().catch(() => ({}) as Record<string, unknown>)
			// The client posts the file as `image`; accept `file` too for safety.
			const candidate = body.image ?? body.file
			if (!(candidate instanceof File)) return c.json({ error: 'No file found in request' }, 400)
			const file = candidate

			// `imgMeta` is a JSON blob describing the upload (`SavedImageMetaDTO`),
			// posted as a multipart field. It carries the metadata we record on the image
			// (savedImageType, roomId, accessibility, description, taggedPlayerIds, …).
			let meta: Record<string, unknown> = {}
			if (typeof body.imgMeta === 'string') {
				try {
					const parsed = JSON.parse(body.imgMeta)
					if (parsed && typeof parsed === 'object') meta = parsed as Record<string, unknown>
				} catch {
					// Malformed imgMeta — treat as an untyped upload (still stored).
				}
			}
			// imgMeta shape: {playerIds, savedImageType, roomId, playerEventId, accessibility}.
			const num = (v: unknown): number | undefined => (typeof v === 'number' ? v : undefined)
			const savedImageType = num(meta.savedImageType) ?? SavedImageType.None
			// roomId / playerEventId use 0 or -1 as "none" — store null in that case.
			const roomId = num(meta.roomId)
			const playerEventId = num(meta.playerEventId)

			const valid = ['.png', '.jpg', '.jpeg', '.gif', '.webp', '.bmp']
			const dot = file.name.lastIndexOf('.')
			const ext = dot >= 0 ? file.name.slice(dot).toLowerCase() : ''
			const extension = valid.includes(ext) ? ext : '.jpg'

			// Store the upload in the shared image bucket under a random key, foldered by
			// the image type and then the upload date (e.g. `sharecamera/2026-06-15/`) so
			// the bucket stays browsable over time. The `img` worker serves it back by that
			// key (slashes and all), which is the returned ImageName.
			const typePrefix = (typeFolder[savedImageType] ?? typeFolder[SavedImageType.None]) + '/'
			const datePrefix = new Date().toISOString().slice(0, 10) + '/'
			const name = typePrefix + datePrefix + crypto.randomUUID() + extension
			await c.env.IMAGES.put(name, await file.arrayBuffer(), {
				httpMetadata: { contentType: file.type || 'image/jpeg' },
			})

			// A profile thumbnail becomes the account's avatar — persist it on the
			// account row (a JSON blob in the shared accounts table) so it sticks.
			if (savedImageType === SavedImageType.ProfileThumbnail) {
				await c.env.DB.prepare(
					"UPDATE account SET data = json_set(data, '$.profileImage', ?2) WHERE account_id = ?1"
				)
					.bind(id, name)
					.run()
			}

			// Record the image metadata (the `image` table the img worker owns), pulling
			// the fields the client provided in imgMeta.
			await createImage(c.env.DB, {
				imageName: name,
				playerId: id,
				type: savedImageType,
				accessibility: num(meta.accessibility),
				roomId: roomId !== undefined && roomId > 0 ? roomId : null,
				description: typeof meta.description === 'string' ? meta.description : null,
				taggedPlayerIds: Array.isArray(meta.playerIds)
					? meta.playerIds.filter((v): v is number => typeof v === 'number')
					: undefined,
				playerEventId: playerEventId !== undefined && playerEventId > 0 ? playerEventId : null,
			})

			return c.json({ ImageName: name })
		}
	)

	// Delete one of the caller's saved images ({ ImageName }). Auth-gated. Looks the
	// image up by name, refuses unless the caller took it (PlayerId), then removes the
	// metadata row (and its cheers) and the object from R2. 404 for an unknown image,
	// 403 for someone else's.
	.delete(
		'/api/images/v1/deletesaved',
		describeRoute({
			tags: ['Images'],
			summary: 'Delete one of the caller’s photos',
			description:
				'Looks the image up by name and refuses unless the caller took it, then removes ' +
				'the metadata row (and its cheers) and the object from the bucket. The metadata ' +
				'goes first; the R2 delete is idempotent, so a missing object is fine.',
			security: AUTHED,
			requestBody: jsonBody(DeleteImageRequest, 'The image to delete'),
			responses: {
				200: json(SuccessResponse, 'Deleted'),
				400: json(ErrorResponse, 'No ImageName given'),
				401: UNAUTHORIZED_RESPONSE,
				403: json(ErrorResponse, 'Not the caller’s image'),
				404: { description: 'No image by that name' },
			},
		}),
		async (c) => {
			const id = await authedId(c)
			if (id === null) return unauthorized(c)

			const body = (await c.req.json().catch(() => null)) as { ImageName?: unknown } | null
			const imageName = typeof body?.ImageName === 'string' ? body.ImageName : ''
			if (imageName === '') return c.json({ error: 'ImageName is required' }, 400)

			const image = await getImageByName(c.env.DB, imageName)
			if (!image) return c.notFound()
			if (image.PlayerId !== id) return c.json({ error: 'Not your image' }, 403)

			// Drop the metadata (and cheers) first, then the object. An R2 delete is
			// idempotent, so a missing object is fine.
			await deleteImage(c.env.DB, image)
			await c.env.IMAGES.delete(imageName)

			return c.json({ success: true })
		}
	)

	// A room's photo feed — the public images taken in that room. `sort` orders the
	// feed (1 = most cheered, else newest) and `filter` narrows by SavedImageType
	// (0 = all). Paginated via skip/take (take defaults to 100). Returns a bare array.
	.get(
		'/api/images/v4/room/:roomId{[0-9]+}',
		describeRoute({
			tags: ['Images'],
			summary: 'A room’s photo feed',
			description:
				'The public images taken in that room.\n\n' +
				'This feed serves the RAW `SavedImage` record — unlike the player photo lists ' +
				'below, which must serve the `ImagesPlayer` projection. The inconsistency is real ' +
				'and load-bearing: both render correctly as they are, and unifying them breaks one ' +
				'of them.',
			parameters: [
				idParam('roomId', 'Room id'),
				intQuery('sort', '1 = most cheered; anything else = newest first'),
				intQuery('filter', 'Narrow by SavedImageType; 0 = all'),
				...pageParams(100),
			],
			responses: { 200: json(SavedImageDto.array(), 'The room’s photos') },
		}),
		async (c) => {
			const roomId = Number.parseInt(c.req.param('roomId'), 10)
			const sort = Number.parseInt(c.req.query('sort') ?? '0', 10) || 0
			const filter = Number.parseInt(c.req.query('filter') ?? '0', 10) || 0
			const skip = Number.parseInt(c.req.query('skip') ?? '0', 10) || 0
			const take = Number.parseInt(c.req.query('take') ?? '100', 10) || 100
			return c.json(await getImagesByRoom(c.env.DB, roomId, sort, filter, skip, take))
		}
	)

	// A player's photos — the public images that player has taken, newest first.
	// Paginated via skip/take (take defaults to 100). Returns a bare array of the
	// client's ImagesPlayer projection (SavedImageId/SavedImageType, not Id/Type).
	.get(
		'/api/images/v4/player/:playerId{[0-9]+}',
		describeRoute({
			tags: ['Images'],
			summary: 'A player’s photos',
			description:
				'The public images that player has taken, newest first. Serves the client’s ' +
				'`ImagesPlayer` projection (`SavedImageId`/`SavedImageType`, no `TaggedPlayerIds`) ' +
				'— the raw `SavedImage` renders blank thumbnails here.',
			parameters: [idParam('playerId', 'Account id'), ...pageParams(100)],
			responses: { 200: json(ImagesPlayerDto.array(), 'The player’s photos') },
		}),
		async (c) => {
			const playerId = Number.parseInt(c.req.param('playerId'), 10)
			const skip = Number.parseInt(c.req.query('skip') ?? '0', 10) || 0
			const take = Number.parseInt(c.req.query('take') ?? '100', 10) || 100
			const images = await getImagesByPlayer(c.env.DB, playerId, 0, skip, take)
			return c.json(images.map(toImagesPlayer))
		}
	)

	// A player's photos with a sort option. `sort` orders the list (1 = most
	// cheered, else newest). Paginated via skip/take (take defaults to 100). Bare array.
	.get(
		'/api/images/v5/player/:playerId{[0-9]+}',
		describeRoute({
			tags: ['Images'],
			summary: 'A player’s photos, sortable',
			description: 'v4 plus a `sort` option. Same `ImagesPlayer` projection — see the note on v4.',
			parameters: [
				idParam('playerId', 'Account id'),
				intQuery('sort', '1 = most cheered; anything else = newest first'),
				...pageParams(100),
			],
			responses: { 200: json(ImagesPlayerDto.array(), 'The player’s photos') },
		}),
		async (c) => {
			const playerId = Number.parseInt(c.req.param('playerId'), 10)
			const sort = Number.parseInt(c.req.query('sort') ?? '0', 10) || 0
			const skip = Number.parseInt(c.req.query('skip') ?? '0', 10) || 0
			const take = Number.parseInt(c.req.query('take') ?? '100', 10) || 100
			const images = await getImagesByPlayer(c.env.DB, playerId, sort, skip, take)
			return c.json(images.map(toImagesPlayer))
		}
	)

	// A player's photo feed — the public images they took plus ones they're tagged
	// in, newest first. Paginated via skip/take (take defaults to 100). Bare array of
	// the same ImagesPlayer projection the player photo lists use.
	.get(
		'/api/images/v3/feed/player/:playerId{[0-9]+}',
		describeRoute({
			tags: ['Images'],
			summary: 'A player’s photo feed',
			description:
				'The public images they took PLUS the ones they are tagged in, newest first — the ' +
				'photo tab on a profile. Same `ImagesPlayer` projection as the player photo lists.',
			parameters: [idParam('playerId', 'Account id'), ...pageParams(100)],
			responses: { 200: json(ImagesPlayerDto.array(), 'The player’s feed') },
		}),
		async (c) => {
			const playerId = Number.parseInt(c.req.param('playerId'), 10)
			const skip = Number.parseInt(c.req.query('skip') ?? '0', 10) || 0
			const take = Number.parseInt(c.req.query('take') ?? '100', 10) || 100
			const images = await getPlayerFeed(c.env.DB, playerId, skip, take)
			return c.json(images.map(toImagesPlayer))
		}
	)

	// Global slideshow feed — the most recent publicly-listable ShareCamera photos
	// (Accessibility 0 or 1, Type 1) across all rooms, newest first, each joined to its
	// creator's username and room name. Public (no auth): it only surfaces already-public
	// images and backs the anonymous homepage slideshow. Returns `{ Images, ValidTill }`,
	// where ValidTill is a short (2-minute) cache hint the client refreshes against.
	// Serves 10 by default and never more than SLIDESHOW_MAX_LIMIT (100): it's public and
	// unauthenticated, so an unclamped `take` would let anyone ask for the whole image
	// table — and the callers that rotate one photo at a time (the website's hero) don't
	// want a long feed anyway.
	.get(
		'/api/images/v1/slideshow',
		describeRoute({
			tags: ['Images'],
			summary: 'The global slideshow feed',
			description:
				'The most recent publicly-listable ShareCamera photos across all rooms, newest ' +
				'first, each joined to its creator’s username and room name.\n\n' +
				'Deliberately public — it surfaces only already-public images and backs the ' +
				'anonymous homepage slideshow. `ValidTill` is a short (2-minute) cache hint the ' +
				'client refreshes against.',
			parameters: [
				intQuery(
					'take',
					`How many photos to return (default ${SLIDESHOW_LIMIT}, capped at ${SLIDESHOW_MAX_LIMIT})`
				),
			],
			responses: { 200: json(SlideshowResponse, 'The feed plus its cache hint') },
		}),
		async (c) => {
			// Junk, zero and negative takes fall back to the default rather than 400ing or
			// serving an empty stage — the caller is a homepage, and no photos reads as the
			// server being down.
			const asked = Number.parseInt(c.req.query('take') ?? '', 10)
			const take = asked > 0 ? Math.min(asked, SLIDESHOW_MAX_LIMIT) : SLIDESHOW_LIMIT
			const Images = await getSlideshowImages(c.env.DB, take)
			const ValidTill = new Date(Date.now() + 2 * 60 * 1000).toISOString()
			return c.json({ Images, ValidTill })
		}
	)

	// Bulk image metadata by id (`?ids=207&ids=106`) — the client resolving a set of photo
	// ids it already holds. A bare array in REQUEST order, so it can line the records up
	// with what it asked for; an id with no record (or one that isn't public) is simply
	// absent, which is why this answers 200 with a short list rather than 404ing the lot.
	//
	// Serves the RAW `SavedImage`, like `v6` (metadata by filename) and the room feed — NOT
	// the `ImagesPlayer` projection the player photo LISTS use. Those are a rendered grid,
	// where the raw record comes up blank; this is a metadata lookup.
	//
	// Public-only, as every image read here is: ids are sequential, so honouring whatever
	// id is named would hand out private photos to anyone who counts.
	.get(
		'/api/images/v5/bulk',
		describeRoute({
			tags: ['Images'],
			summary: 'Image metadata by id, in bulk',
			description:
				'The stored `SavedImage` records for the given ids (`?ids=207&ids=106`), as a bare ' +
				'array in request order. An id with no record, or one that is not public, is absent ' +
				'from the answer rather than an error — the list can be shorter than the request. ' +
				'Serves the raw `SavedImage` (as `v6` does), not the `ImagesPlayer` projection the ' +
				'player photo lists use.',
			parameters: [
				intQuery('ids', 'Repeatable; each value may also be a comma-separated list of image ids'),
			],
			responses: { 200: json(SavedImageDto.array(), 'The matching records, in request order') },
		}),
		async (c) => {
			const ids =
				c.req
					.queries('ids')
					?.flatMap((raw) => raw.split(','))
					.map((raw) => Number.parseInt(raw.trim(), 10))
					.filter((imageId) => !Number.isNaN(imageId)) ?? []
			return c.json(await getImagesByIds(c.env.DB, ids))
		}
	)

	// Image metadata by filename. Returns the stored SavedImage record, or 404 when
	// there's no metadata row for that name.
	.get(
		'/api/images/v6',
		describeRoute({
			tags: ['Images'],
			summary: 'Image metadata by filename',
			description:
				'The stored `SavedImage` record for a bucket key. 404s when the object exists but ' +
				'has no metadata row.',
			parameters: [stringQuery('name', 'The image name (bucket key); required')],
			responses: {
				200: json(SavedImageDto, 'The image record'),
				400: json(ErrorResponse, 'No name given'),
				404: { description: 'No metadata for that name' },
			},
		}),
		async (c) => {
			const name = c.req.query('name') ?? ''
			if (name === '') return c.json({ error: 'name is required' }, 400)
			const image = await getImageByName(c.env.DB, name)
			return image ? c.json(image) : c.notFound()
		}
	)

	// Cheer / un-cheer a saved image ({ SavedImageId, Cheer }). Auth-gated. Persists the
	// caller's cheer to `image_interaction` and resyncs the image's CheerCount.
	.post(
		'/api/images/v1/cheer',
		describeRoute({
			tags: ['Images'],
			summary: 'Cheer or un-cheer a photo',
			description:
				'Persists the caller’s cheer and resyncs the image’s `CheerCount`. A body naming no ' +
				'`SavedImageId` is accepted and ignored — the ack is the same either way.',
			security: AUTHED,
			requestBody: jsonBody(CheerImageRequest, 'The image and the new cheer state'),
			responses: {
				200: json(SuccessResponse, 'Recorded'),
				401: UNAUTHORIZED_RESPONSE,
			},
		}),
		async (c) => {
			const id = await authedId(c)
			if (id === null) return unauthorized(c)
			const body = (await c.req.json().catch(() => null)) as {
				SavedImageId?: number
				Cheer?: boolean
			} | null
			if (body && typeof body.SavedImageId === 'number') {
				await setImageCheer(c.env.DB, id, body.SavedImageId, body.Cheer === true)
			}
			return c.json({ success: true })
		}
	)

	// Whether the caller has cheered each of the given saved-image ids (`?id=55&id=54`,
	// and each `id` may itself be a comma-separated list). Auth-gated. Returns one
	// `{ SavedImageId, IsCheered }` per requested id, in order.
	//
	// The client actually POSTs this (see below); the GET form is kept because it is the
	// same lookup and costs one line, and a URL of ids is the easier thing to hand a
	// browser or a curl.
	.get(
		'/api/images/v5/cheered/bulk',
		describeRoute({
			tags: ['Images'],
			summary: 'Which photos the caller has cheered',
			description:
				'One `{ SavedImageId, IsCheered }` per requested id, in request order — the client ' +
				'fills in the cheer buttons on a photo grid from this.',
			security: AUTHED,
			parameters: [
				intQuery('id', 'Repeatable; each value may be a comma-separated list of image ids'),
			],
			responses: {
				200: json(CheeredEntry.array(), 'One entry per requested id, in order'),
				401: UNAUTHORIZED_RESPONSE,
			},
		}),
		cheerLookup
	)

	// The same lookup as a POST, which is the form the client sends: the ids ride in a
	// form-urlencoded body of repeated `id` fields (`id=651&id=570&…`) rather than the query
	// string, because a photo grid asks about a full page at once — around a hundred ids,
	// more than belongs in a URL. Same auth, same answer, same order.
	.post(
		'/api/images/v5/cheered/bulk',
		describeRoute({
			tags: ['Images'],
			summary: 'Which photos the caller has cheered (bulk POST)',
			description:
				'One `{ SavedImageId, IsCheered }` per requested id, in request order — the client ' +
				'fills in the cheer buttons on a photo grid from this. The ids are a form body of ' +
				'repeated `id` fields (`id=651&id=570&…`), which is how the client sends a page of ' +
				'~100 at once; the query string is read too, so the GET form of this path answers ' +
				'identically.',
			security: AUTHED,
			requestBody: form(CheeredBulkRequest, 'The image ids, as repeated `id` fields'),
			responses: {
				200: json(CheeredEntry.array(), 'One entry per requested id, in order'),
				401: UNAUTHORIZED_RESPONSE,
			},
		}),
		cheerLookup
	)

	// Who may tag the caller in photos. The preference lives in the player-settings bag
	// (`playerPhotoTaggingSetting`), not in a store of its own — these two routes exist
	// because the client asks for it by name rather than through `/playersettings`.
	//
	// A bare JSON integer, not an envelope, and an opaque one: the value is an enum ordinal
	// the client defines, stored and served back untouched, so it round-trips whatever the
	// client means by it. A player who has never set one reads 0.
	.get(
		'/api/players/v1/playerPhotoTaggingSetting',
		describeRoute({
			tags: ['Images'],
			summary: 'The caller’s photo-tagging preference',
			description:
				'Who may tag the caller in photos, as a bare JSON integer (the enum ordinal the ' +
				'client defines — stored and served back untouched). `0` until the player sets one. ' +
				'Stored as one key in the player-settings bag the `playersettings` worker owns.',
			security: AUTHED,
			responses: {
				200: json(PhotoTaggingSettingResponse, 'The caller’s setting; 0 if never set'),
				401: UNAUTHORIZED_RESPONSE,
			},
		}),
		async (c) => {
			const id = await authedId(c)
			if (id === null) return unauthorized(c)
			return c.json(await readPhotoTaggingSetting(c.env, id))
		}
	)

	// Set the caller's photo-tagging preference. Answers the stored value, as the reference
	// does — the client re-renders the toggle from the response rather than from what it
	// sent.
	//
	// A body with no readable `Setting` leaves the stored preference ALONE and answers it,
	// rather than writing the 0 an unbound .NET model would have carried: the value is
	// opaque here, so a guess is indistinguishable from a real choice once it's stored.
	.put(
		'/api/players/v1/playerPhotoTaggingSetting',
		describeRoute({
			tags: ['Images'],
			summary: 'Set the caller’s photo-tagging preference',
			description:
				'Stores `Setting` as the caller’s photo-tagging preference and answers the stored ' +
				'value (a bare integer), which is what the client re-renders the toggle from. The ' +
				'write merges into the player-settings bag, so the player’s other settings are left ' +
				'alone. `Setting` is also read from a form body, and from a `setting` spelling; a ' +
				'body carrying no readable value is a no-op that answers the current setting.',
			security: AUTHED,
			requestBody: jsonBody(PhotoTaggingSettingRequest, 'The preference to store'),
			responses: {
				200: json(PhotoTaggingSettingResponse, 'The setting the caller now has'),
				401: UNAUTHORIZED_RESPONSE,
			},
		}),
		async (c) => {
			const id = await authedId(c)
			if (id === null) return unauthorized(c)

			const setting = await readPostedSetting(c)
			if (setting === undefined) return c.json(await readPhotoTaggingSetting(c.env, id))

			await writePhotoTaggingSetting(c.env, id, setting)
			return c.json(setting)
		}
	)
