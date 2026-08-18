import { Hono } from 'hono'
import { describeRoute } from 'hono-openapi'

import {
	CURRENT_OUTFIT_SLOT,
	getOutfit,
	inventionDescriptionRejection,
	inventionNameRejection,
	inventionTagRejection,
	setOutfit,
} from '@repo/domain'

import { authedId, unauthorized } from '../http'
import {
	createInvention,
	getFeaturedInventions,
	getInventionById,
	getInventionsByIds,
	getInventionsByRoom,
	getInventionTagFilters,
	getInventionTags,
	getInventionVersion,
	getMyInventions,
	getTopInventions,
	ownsAllInventions,
	parsePermissionLevel,
	publishInvention,
	searchInventions,
	setInventionPrice,
	setInventionTags,
	toSaveResult,
	updateInvention,
} from '../inventions-db'
import {
	AUTHED,
	BareBoolean,
	BulkCustomAvatarItemsRequest,
	CustomAvatarItemsPage,
	ErrorResponse,
	form,
	GeneratedGift,
	GenerateGiftRequest,
	idParam,
	intQuery,
	InventionDetails,
	InventionDto,
	InventionPersonalDetails,
	InventionSaveResult,
	InventionVersionDto,
	json,
	JsonArray,
	jsonBody,
	LegacyAvatarItemSaves,
	OutfitSaveResponse,
	OutfitsMeRequest,
	OutfitsMeResponse,
	pageParams,
	SaveInventionRequest,
	SetTagsRequest,
	SetTagsResponse,
	stringQuery,
	SuccessValueEnvelope,
	TagFilters,
	UNAUTHORIZED_RESPONSE,
	UpdatePriceRequest,
} from '../openapi'

import type { Context } from 'hono'
import type { App } from '../context'
import type { SavedInvention } from '../inventions-db'

/**
 * The gate every invention write runs through: the caller must be signed in, the
 * invention must exist, and it must be theirs. Yields the loaded invention, or the
 * error response to return as-is (401 / 404 / 403).
 */
async function creatorsInvention(
	c: Context<App>,
	inventionId: number
): Promise<{ invention: SavedInvention } | { response: Response | Promise<Response> }> {
	const playerId = await authedId(c)
	if (playerId === null) return { response: unauthorized(c) }
	if (Number.isNaN(inventionId)) {
		return { response: c.json({ error: 'inventionId is required' }, 400) }
	}
	const invention = await getInventionById(c.env.DB, inventionId)
	if (invention === null) return { response: c.notFound() }
	if (invention.CreatorPlayerId !== playerId) {
		return { response: c.json({ error: 'Not your invention' }, 403) }
	}
	return { invention }
}

/**
 * The `?id=1&id=2` list the invention batch endpoints take. `id` repeats, and each
 * value may itself be a comma-separated list; anything non-numeric is dropped.
 */
function inventionIdQuery(c: Context<App>): number[] {
	return (
		c.req
			.queries('id')
			?.flatMap((raw) => raw.split(','))
			.map((raw) => Number.parseInt(raw.trim(), 10))
			.filter((id) => !Number.isNaN(id)) ?? []
	)
}

// ---- Avatar gifts ----------------------------------------------------------
// The avatar read endpoints (`v4/items`, `v2`, `v2/set`, `v3/saved`, `v2/gifts`) and
// gift-box consume live in the `econ` worker, which the client calls on the econ host
// — not here. Only the gift `generate` action remains on this worker.
export const avatarRoutes = new Hono<App>({ strict: false })
	.post(
		'/api/avatar/v2/gifts/generate',
		describeRoute({
			tags: ['Avatar'],
			summary: 'Generate a gift box',
			description:
				'Mint the gift box a player earned (levelling up, a room reward). With no ' +
				'EarnableRewards catalog wired up this always falls back to a token gift of a ' +
				'random amount, and the box is not persisted — its `Id` is 0 and it cannot be ' +
				'opened through the `econ` worker’s consume endpoint.',
			security: AUTHED,
			requestBody: form(GenerateGiftRequest, 'Where the gift was earned'),
			responses: {
				200: json(GeneratedGift, 'The generated (unpersisted) gift'),
				401: UNAUTHORIZED_RESPONSE,
			},
		}),
		async (c) => {
			const id = await authedId(c)
			if (id === null) return unauthorized(c)

			const body = await c.req.parseBody().catch(() => ({}) as Record<string, unknown>)
			const giftContext =
				typeof body.GiftContext === 'string' ? Number.parseInt(body.GiftContext, 10) || 0 : 0
			const message = typeof body.Message === 'string' ? body.Message : ''
			const xp = typeof body.Xp === 'string' ? Number.parseInt(body.Xp, 10) || 0 : 0

			// No EarnableRewards binding → always fall back to a token gift.
			const tokenAmounts = [10, 25, 50, 100, 250, 500]
			const currency = tokenAmounts[Math.floor(Math.random() * tokenAmounts.length)]

			return c.json({
				Id: 0, // TODO: real id once gifts are persisted
				FromPlayerId: 1,
				ConsumableItemDesc: '',
				AvatarItemDesc: '',
				FriendlyName: '',
				AvatarItemType: 0,
				EquipmentPrefabName: '',
				EquipmentModificationGuid: '',
				CurrencyType: 2,
				Currency: currency,
				Xp: xp,
				Level: 0,
				Platform: -1,
				PlatformsToSpawnOn: -1,
				BalanceType: 0,
				GiftContext: giftContext,
				GiftRarity: 20,
				Message: message,
			})
		}
	)

	// A batch lookup of LOCKED avatar items — the items the client shows greyed out, so it
	// posts the ids it wants the locked state for. Nothing here locks avatar items (the
	// catalogs `econ` serves are all unlocked), so nothing comes back and the client renders
	// none as locked. Unlike its custom-item sibling above this one is NOT auth-gated: the
	// reference answers the empty array outright, without validating a token first.
	.post(
		'/api/avatar/v1/lockeditems/bulk',
		describeRoute({
			tags: ['Avatar'],
			summary: 'Locked avatar items in bulk',
			description:
				'Resolves a batch of avatar-item ids to the ones that are LOCKED for the caller, as ' +
				'a bare array. Nothing on this server locks avatar items, so it is always `[]` and ' +
				'the posted ids are not parsed — a miss is not an error, the client simply renders ' +
				'nothing as locked.\n\n' +
				'No auth, matching the reference, which returns the empty array without checking a ' +
				'token — in contrast to `/api/customAvatarItems/v1/bulk`, which validates one first.',
			responses: { 200: json(JsonArray, 'The locked items — always empty here') },
		}),
		(c) => c.json([])
	)

	// Custom avatar item gates — real Rec Room client endpoints with no backing
	// implementation yet; we enable them. Flip to `false` to disable the
	// corresponding flow. `isCreationAllowedForAccount` wraps its answer in the
	// success/value envelope; the other two return a bare JSON boolean.
	.get(
		'/api/customAvatarItems/v1/isCreationAllowedForAccount',
		describeRoute({
			tags: ['Avatar'],
			summary: 'May this account create custom items?',
			description:
				'A feature gate with no backing implementation — we answer yes. Note this one ' +
				'wraps its answer in the `{ success, value }` envelope while the two gates below ' +
				'return a bare boolean.',
			responses: { 200: json(SuccessValueEnvelope, 'Allowed') },
		}),
		(c) => c.json({ success: true, value: null })
	)
	.get(
		'/api/customAvatarItems/v1/isCreationEnabled',
		describeRoute({
			tags: ['Avatar'],
			summary: 'Is custom-item creation enabled?',
			description: 'A server-wide feature gate. Enabled; flip to `false` to disable the flow.',
			responses: { 200: json(BareBoolean, 'A bare `true`') },
		}),
		(c) => c.json(true)
	)
	.get(
		'/api/customAvatarItems/v1/isRenderingEnabled',
		describeRoute({
			tags: ['Avatar'],
			summary: 'Is custom-item rendering enabled?',
			description: 'A server-wide feature gate. Enabled; flip to `false` to disable the flow.',
			responses: { 200: json(BareBoolean, 'A bare `true`') },
		}),
		(c) => c.json(true)
	)

	// The featured custom-avatar-item feed. No curated items yet → an empty list.
	.get(
		'/api/customAvatarItems/v1/featured',
		describeRoute({
			tags: ['Avatar'],
			summary: 'Featured custom avatar items',
			description: 'The curated feed. Nothing is curated yet, so it is empty.',
			responses: { 200: json(JsonArray, 'An empty list') },
		}),
		(c) => c.json([])
	)

	// The "hot" (trending) custom-avatar-item feed. No items yet → an empty list.
	.get(
		'/api/customAvatarItems/v1/hot',
		describeRoute({
			tags: ['Avatar'],
			summary: 'Trending custom avatar items',
			description: 'The “hot” feed. No custom items exist yet, so it is empty.',
			responses: { 200: json(JsonArray, 'An empty list') },
		}),
		(c) => c.json([])
	)

	// A batch lookup of custom avatar items by id. The reference filters a static catalog
	// down to the posted ids and returns the MATCHES AS A BARE ARRAY — not the
	// `{ Results, TotalResults }` page its catalog file is written in, and not a 404 for
	// ids it doesn't hold. Nothing stores custom items here (the reference's own catalog
	// ships empty too), so every id misses and the array is empty.
	//
	// Auth-gated, and the token is checked before anything else, as the reference does.
	.post(
		'/api/customAvatarItems/v1/bulk',
		describeRoute({
			tags: ['Avatar'],
			summary: 'Custom avatar items in bulk',
			description:
				'Resolves a batch of custom-avatar-item ids to their items: the posted ' +
				'`customAvatarItemIds` filtered against the catalog, returned as a BARE ARRAY of ' +
				'the ones that matched. Not the `{ Results, TotalResults }` page the sibling ' +
				'custom-item reads serve — the reference keeps its catalog in that shape but ' +
				'answers this route with the filtered array alone.\n\n' +
				'A miss is not an error: unknown ids are simply absent from the response, and the ' +
				'client reads the items it got back rather than the ids it asked for. Nothing ' +
				'stores custom items here, so every id misses and this is always `[]` — which is ' +
				'why the posted ids are not parsed.',
			security: AUTHED,
			requestBody: form(BulkCustomAvatarItemsRequest, 'The custom-avatar-item ids to resolve'),
			responses: {
				200: json(JsonArray, 'The matching items — always empty here'),
				401: UNAUTHORIZED_RESPONSE,
			},
		}),
		async (c) => {
			const id = await authedId(c)
			if (id === null) return unauthorized(c)
			return c.json([])
		}
	)

	// Custom avatar items created by a given account. No storage yet → an empty
	// paginated result (matches the econ `customAvatarItems/v1/owned` shape).
	.get(
		'/api/customAvatarItems/v2/fromCreator/:accountId{[0-9]+}',
		describeRoute({
			tags: ['Avatar'],
			summary: 'A creator’s custom avatar items',
			description:
				'The items an account has authored. Nothing stores custom items yet, so this is an ' +
				'empty page — in the same shape as the `econ` worker’s `customAvatarItems/v1/owned`.',
			parameters: [idParam('accountId', 'Creator account id')],
			responses: { 200: json(CustomAvatarItemsPage, 'An empty page') },
		}),
		(c) => c.json({ Results: [], TotalResults: 0 })
	)

	// The client asks which legacy avatar items have been rebuilt as custom items, so it
	// can render the custom version instead. Nothing stores custom items yet, so nothing
	// has a save — an empty list means "use the legacy items as-is".
	.post(
		'/api/customAvatarItems/GetCustomAvatarItemCurrentSavesForLegacyAvatarItems',
		describeRoute({
			tags: ['Avatar'],
			summary: 'Custom-item saves for legacy avatar items',
			description:
				'Given a set of legacy avatar items, the custom-item saves that replace them, keyed ' +
				'by the legacy item’s `AvatarItemDesc`. Nothing stores custom items yet, so the map ' +
				'is always empty — which the client reads as “render the legacy items as-is”. The ' +
				'request body is ignored.\n\n' +
				'The value shape is the official one, recorded here for documentation; we never ' +
				'emit one until custom items are stored.',
			responses: { 200: json(LegacyAvatarItemSaves, 'An empty map') },
		}),
		(c) => c.json({ customAvatarItemSavesByAvatarItemDesc: {} })
	)

	// The newer outfit read, on a bare (un-prefixed) path. Auth-gated. The outfit the
	// player is wearing is slot 0 of the shared `outfit` table (the same table the `econ`
	// worker's saved-outfit slots live in); a player who has never saved gets the
	// brand-new-account envelope instead.
	.get(
		'/outfits/me',
		describeRoute({
			tags: ['Avatar'],
			summary: 'The caller’s outfit',
			description:
				'The newer outfit read, on a bare un-prefixed path. Served from slot 0 of the shared ' +
				'`outfit` table — the newer client treats slot 0 as the outfit currently worn — and ' +
				'handed back exactly as it was saved, since the payload’s heavy fields are the ' +
				'client’s own JSON-in-a-string documents.\n\n' +
				'A player who has never saved gets the brand-new-account envelope: all-null ' +
				'`LegacyData`, no `Selections`, `DataVersion` 9.',
			security: AUTHED,
			responses: {
				200: json(OutfitsMeResponse, 'The stored outfit, or the empty envelope'),
				401: UNAUTHORIZED_RESPONSE,
			},
		}),
		async (c) => {
			const id = await authedId(c)
			if (id === null) return unauthorized(c)

			const outfit = await getOutfit(c.env.DB, id, CURRENT_OUTFIT_SLOT)
			if (outfit !== null) return c.json(outfit)

			return c.json({
				LegacyData: {
					SelectionsV1: null,
					SelectionsV2: null,
					FaceFeatures: null,
					SkinColor: null,
					HairColor: null,
				},
				Selections: [],
				DataVersion: 9,
				CustomizationSettings: null,
				ThumbnailFileName: null,
				Name: null,
				Accessibility: 0,
				Slot: 0,
			})
		}
	)

	// Saving an outfit through the same bare path — into the slot the body names, which
	// is slot 0 for the outfit being worn. Stored verbatim: the heavy fields are the
	// client's own JSON-in-a-string documents, and re-encoding risks changing a payload
	// it has to parse back.
	//
	// Answers the bare `{ Success, Error, error_id }` envelope — no `Value` key, and NOT the
	// outfit that was just saved: the client keeps what it sent and only reads whether the
	// save worked.
	.put(
		'/outfits/me',
		describeRoute({
			tags: ['Avatar'],
			summary: 'Save the caller’s outfit',
			description:
				'Saves into the shared `outfit` table, in the slot the body names — slot 0 being the ' +
				'outfit worn, which is what the GET reads. Re-saving a slot overwrites it.\n\n' +
				'The payload is stored verbatim: its heavy fields (`SelectionsV2`, `FaceFeatures`, ' +
				'`CustomizationSettings`) are whole JSON documents encoded as strings by the ' +
				'client’s own serializer, so nothing here parses or re-encodes them.\n\n' +
				'The response is the base envelope with no `Value` key — three keys, and the outfit ' +
				'is not echoed back. The mixed casing (`Success`/`Error` but `error_id`) is the ' +
				'reference’s, not a typo.',
			security: AUTHED,
			requestBody: jsonBody(OutfitsMeRequest, 'The outfit to save'),
			responses: {
				200: json(OutfitSaveResponse, 'Saved — `{ Success: true, Error: null, error_id: null }`'),
				400: json(ErrorResponse, 'Unparseable body'),
				401: UNAUTHORIZED_RESPONSE,
			},
		}),
		async (c) => {
			const id = await authedId(c)
			if (id === null) return unauthorized(c)

			const body = (await c.req.json().catch(() => null)) as Record<string, unknown> | null
			if (body === null) return c.json({ error: 'Invalid request body' }, 400)

			// The client sends `Slot`; a body without one saves the worn outfit.
			const outfit = {
				...body,
				Slot: typeof body.Slot === 'number' ? body.Slot : CURRENT_OUTFIT_SLOT,
			}
			await setOutfit(c.env.DB, id, outfit)
			return c.json({ Success: true, Error: null, error_id: null })
		}
	)

	// The caller's outfit wardrobe. An empty list for now — the outfits saved through
	// `PUT /outfits/me` are in the shared `outfit` table already, but which of them
	// belong in this list (and in what shape) has not been pinned down, so it answers []
	// rather than guessing.
	.get(
		'/outfits/me/saved',
		describeRoute({
			tags: ['Avatar'],
			summary: 'The caller’s saved outfits',
			description:
				'The wardrobe behind the newer outfit screen. Empty for now: the outfits saved ' +
				'through `PUT /outfits/me` are in the shared `outfit` table, but which of them this ' +
				'list should carry, and in what shape, is not pinned down yet.',
			security: AUTHED,
			responses: {
				200: json(JsonArray, 'An empty list'),
				401: UNAUTHORIZED_RESPONSE,
			},
		}),
		async (c) => {
			const id = await authedId(c)
			if (id === null) return unauthorized(c)
			return c.json([])
		}
	)

	// A single invention by id (`?inventionId=…`). Returns the stored RRInvention,
	// or 404 when there's no such invention.
	.get(
		'/api/inventions/v1',
		describeRoute({
			tags: ['Inventions'],
			summary: 'One invention by id',
			description: 'The stored `RRInvention`. Public — an unpublished invention is served too.',
			parameters: [intQuery('inventionId', 'Invention id; required')],
			responses: {
				200: json(InventionDto, 'The invention'),
				400: json(ErrorResponse, 'Missing or non-numeric inventionId'),
				404: { description: 'No such invention' },
			},
		}),
		async (c) => {
			const inventionId = Number.parseInt(c.req.query('inventionId') ?? '', 10)
			if (Number.isNaN(inventionId)) return c.json({ error: 'inventionId is required' }, 400)
			const invention = await getInventionById(c.env.DB, inventionId)
			return invention ? c.json(invention) : c.notFound()
		}
	)

	// The tag filter chips on the invention browse screen. Derived from the tags in
	// use on published inventions — most popular first, top few pinned. Public.
	.get(
		'/api/inventions/v1/tagfilters',
		describeRoute({
			tags: ['Inventions'],
			summary: 'Invention browse filter chips',
			description:
				'The filter chips on the invention browse screen, derived from the tags actually in ' +
				'use on published inventions — most popular first, the top few pinned. ' +
				'`TrendingFilters` is null: that needs recent-activity data we do not keep, and the ' +
				'client treats null as absent.',
			responses: { 200: json(TagFilters, 'The chips in use') },
		}),
		async (c) => c.json(await getInventionTagFilters(c.env.DB))
	)

	// A batch of inventions by id (`?id=1&id=2`, and each `id` may itself be a
	// comma-separated list). Unknown ids are dropped rather than 404ing, and an empty
	// request is an empty list. Auth is optional and only widens what you see: an
	// unpublished invention comes back only to its creator. Bare array.
	.get(
		'/api/inventions/v2/batch',
		describeRoute({
			tags: ['Inventions'],
			summary: 'Inventions by id, in bulk',
			description:
				'Look up several inventions at once. Unknown ids are dropped rather than 404ing, ' +
				'and an empty request is an empty list. Auth is optional and only widens what you ' +
				'see: an unpublished invention comes back only to its creator.',
			parameters: [intQuery('id', 'Repeatable; each value may be a comma-separated list of ids')],
			responses: { 200: json(InventionDto.array(), 'The inventions the caller may see') },
		}),
		async (c) => {
			const ids = inventionIdQuery(c)
			if (ids.length === 0) return c.json([])

			const playerId = await authedId(c)
			const inventions = await getInventionsByIds(c.env.DB, ids)
			return c.json(
				inventions.filter(
					(i) => i.IsPublished || (playerId !== null && i.CreatorPlayerId === playerId)
				)
			)
		}
	)

	// Whether the caller owns every invention in a lineage (`?id=101&id=102&id=103`) —
	// the invention plus everything nested inside it, as the client enumerates it. One
	// bare `true`/`false` for the whole set, not a verdict per id. Auth-gated: the
	// question is about the caller.
	.get(
		'/api/inventions/v1/fulllineageowner',
		describeRoute({
			tags: ['Inventions'],
			summary: 'Does the caller own this whole lineage?',
			description:
				'Asked when saving an invention built out of other inventions: may this player use ' +
				'every piece? The client sends the whole lineage as repeated `id`s, and this ' +
				'answers a single bare `true`/`false` for the set — false as soon as one is not the ' +
				'caller’s. An invention is theirs if they created it or acquired it; an id with no ' +
				'invention behind it is not owned. Price and permission don’t enter into it — a ' +
				'free invention still has to be picked up, and that writes the same inventory row ' +
				'a paid one does.\n\n' +
				'Only the ids asked about are checked — this does not walk `ReferencedInventions` ' +
				'to widen the lineage, since the client knows what the thing it is holding is ' +
				'actually made of. No ids at all is `true`: nothing in an empty lineage is unowned.',
			security: AUTHED,
			parameters: [intQuery('id', 'Repeatable; each value may be a comma-separated list of ids')],
			responses: {
				200: json(BareBoolean, 'Whether the caller owns every invention asked about'),
				401: UNAUTHORIZED_RESPONSE,
			},
		}),
		async (c) => {
			const playerId = await authedId(c)
			if (playerId === null) return unauthorized(c)
			return c.json(await ownsAllInventions(c.env.DB, playerId, inventionIdQuery(c)))
		}
	)

	// A room's inventions (`?id=76`) — published inventions created in that room,
	// newest first. Paginated via skip/take (take defaults to 100). Bare array.
	.get(
		'/api/inventions/v1/room',
		describeRoute({
			tags: ['Inventions'],
			summary: 'A room’s inventions',
			description: 'Published inventions created in that room, newest first.',
			parameters: [intQuery('id', 'Room id; required'), ...pageParams(100)],
			responses: {
				200: json(InventionDto.array(), 'The room’s inventions'),
				400: json(ErrorResponse, 'Missing or non-numeric id'),
			},
		}),
		async (c) => {
			const roomId = Number.parseInt(c.req.query('id') ?? '', 10)
			if (Number.isNaN(roomId)) return c.json({ error: 'id is required' }, 400)
			const skip = Number.parseInt(c.req.query('skip') ?? '0', 10) || 0
			const take = Number.parseInt(c.req.query('take') ?? '100', 10) || 100
			return c.json(await getInventionsByRoom(c.env.DB, roomId, skip, take))
		}
	)

	// The signed-in player's own relationship to an invention (`/personaldetails/2`)
	// — just whether they're cheering it. We store no cheers (nothing can cheer an
	// invention yet), so this is always false; it stays a 200 for signed-out callers
	// too, since the client only reads the flag.
	.get(
		'/api/inventions/v1/personaldetails/:inventionId{[0-9]+}',
		describeRoute({
			tags: ['Inventions'],
			summary: 'The caller’s own relation to an invention',
			description:
				'Just whether the caller is cheering it. We store no cheers, so it is always false ' +
				'— and this stays a 200 for signed-out callers too, since the client only reads the ' +
				'flag.',
			parameters: [idParam('inventionId', 'Invention id')],
			responses: { 200: json(InventionPersonalDetails, 'Always not cheering') },
		}),
		(c) => c.json({ IsCheering: false })
	)

	// A single version of an invention (`?inventionId=…&version=…`) — the bare
	// RRInventionVersion, which carries the blob name the client downloads and the
	// SHA-256 of that blob. Public. Only the current version exists (nothing writes
	// version history yet), so any other version number 404s rather than naming a
	// blob that isn't there.
	.get(
		'/api/inventions/v1/version',
		describeRoute({
			tags: ['Inventions'],
			summary: 'One version of an invention',
			description:
				'The bare `RRInventionVersion`, which carries the blob name the client downloads ' +
				'and `BlobHash`, the base64 SHA-256 of that blob (null when the named blob was ' +
				'never uploaded). Only the current version exists — nothing writes version ' +
				'history yet — so any other version number 404s rather than naming a blob that ' +
				'is not there.',
			parameters: [
				intQuery('inventionId', 'Invention id; required'),
				intQuery('version', 'Version number; required'),
			],
			responses: {
				200: json(InventionVersionDto, 'The version'),
				400: json(ErrorResponse, 'Missing inventionId or version'),
				404: { description: 'No such invention, or not the current version' },
			},
		}),
		async (c) => {
			const inventionId = Number.parseInt(c.req.query('inventionId') ?? '', 10)
			if (Number.isNaN(inventionId)) return c.json({ error: 'inventionId is required' }, 400)
			const versionNumber = Number.parseInt(c.req.query('version') ?? '', 10)
			if (Number.isNaN(versionNumber)) return c.json({ error: 'version is required' }, 400)

			const version = await getInventionVersion(
				c.env.DB,
				c.env.CDN_ASSETS,
				inventionId,
				versionNumber
			)
			return version === null ? c.notFound() : c.json(version)
		}
	)

	// Edit an invention's metadata. The fields to change ride as QUERY PARAMS on both
	// verbs (`?inventionId=1&description=my+description`) — the client sends this as a
	// GET that writes in some places and as a bodyless POST in others (the permission
	// picker posts `?inventionId=84&permission=Publish`), so both are registered and
	// neither reads a body. Absent params keep their stored value; `permission` sets
	// what other players may do with it. An empty `description` clears it, but an empty
	// `name`/`imageName` is ignored rather than blanking the invention. Publishing and
	// pricing are separate endpoints. Auth-gated, creator only; answers the save envelope.
	.on(
		['GET', 'POST'],
		'/api/inventions/v1/update',
		describeRoute({
			tags: ['Inventions'],
			summary: 'Edit an invention’s metadata',
			description:
				'GET or POST — the client sends both, and the fields to change ride as query ' +
				'params either way; no body is read. Absent params keep their stored value. An ' +
				'empty `description` clears it, but an empty `name`/`imageName` is ignored rather ' +
				'than blanking the invention. A supplied name/description must satisfy the same ' +
				'rules `v6/save` enforces. Publishing and pricing are separate endpoints.',
			security: AUTHED,
			parameters: [
				intQuery('inventionId', 'Invention id; required'),
				stringQuery('name', '3–24 chars, letters/digits/spaces/dashes/colons; empty is ignored'),
				stringQuery('description', 'Max 512 chars; present-but-empty clears it'),
				stringQuery('imageName', 'New thumbnail; empty is ignored'),
				stringQuery('allowTrial', '`true`/`1` to allow trials'),
				stringQuery(
					'permission',
					'What other players get (`GeneralPermission`). The picker sends `UseOnly`, ' +
						'`EditAndSave` or `Publish`; any ladder name (case- and underscore-insensitive) ' +
						'or the raw number is accepted'
				),
			],
			responses: {
				200: json(InventionSaveResult, 'The updated invention, in the save envelope'),
				400: json(ErrorResponse, 'A supplied name or description breaks its rule'),
				401: UNAUTHORIZED_RESPONSE,
				403: json(ErrorResponse, 'Not the caller’s invention'),
				404: { description: 'No such invention' },
			},
		}),
		async (c) => {
			const gate = await creatorsInvention(c, Number.parseInt(c.req.query('inventionId') ?? '', 10))
			if ('response' in gate) return gate.response

			// Query params arrive as strings; only the ones actually present are applied.
			const nonEmpty = (name: string): string | undefined => {
				const v = c.req.query(name)?.trim()
				return v === undefined || v === '' ? undefined : v
			}
			const allowTrial = c.req.query('allowTrial')
			const permission = c.req.query('permission')

			// Only a name that's actually being changed is checked — an absent or empty one
			// keeps the stored name, which was already validated when it was set.
			const name = nonEmpty('name')
			const nameRejection = name === undefined ? null : inventionNameRejection(name)
			if (nameRejection !== null) return c.json({ error: nameRejection }, 400)

			// The description is checked on presence, not emptiness: empty is how a creator
			// clears it, and the length rule accepts that.
			const description = c.req.query('description')
			const descriptionRejection =
				description === undefined ? null : inventionDescriptionRejection(description)
			if (descriptionRejection !== null) return c.json({ error: descriptionRejection }, 400)

			const updated = await updateInvention(c.env.DB, gate.invention.InventionId, {
				name,
				// Present-but-empty clears the description, so this checks presence.
				description,
				imageName: nonEmpty('imageName'),
				allowTrial:
					allowTrial === undefined
						? undefined
						: allowTrial.toLowerCase() === 'true' || allowTrial === '1',
				generalPermission: permission === undefined ? undefined : parsePermissionLevel(permission),
			})
			return updated === null ? c.notFound() : c.json(toSaveResult(updated))
		}
	)

	// Publish an invention — this is what puts it into search and the feeds. Sets the
	// permission other players get (`permissionLevel`, defaulting to UseOnly) and its
	// `price`. Auth-gated, creator only; answers the save envelope.
	.get(
		'/api/inventions/v3/publish',
		describeRoute({
			tags: ['Inventions'],
			summary: 'Publish an invention',
			description:
				'What puts an invention into search and the feeds. Sets the permission other ' +
				'players get (defaulting to UseOnly) and its price. Another GET that writes.',
			security: AUTHED,
			parameters: [
				intQuery('inventionId', 'Invention id; required'),
				stringQuery('permissionLevel', 'A name like `useonly`, or the raw number'),
				intQuery('price', 'Price in tokens; negative is ignored'),
			],
			responses: {
				200: json(InventionSaveResult, 'The published invention, in the save envelope'),
				401: UNAUTHORIZED_RESPONSE,
				403: json(ErrorResponse, 'Not the caller’s invention'),
				404: { description: 'No such invention' },
			},
		}),
		async (c) => {
			const gate = await creatorsInvention(c, Number.parseInt(c.req.query('inventionId') ?? '', 10))
			if ('response' in gate) return gate.response

			const permissionLevel = c.req.query('permissionLevel')
			const price = Number.parseInt(c.req.query('price') ?? '', 10)

			const published = await publishInvention(
				c.env.DB,
				gate.invention.InventionId,
				permissionLevel === undefined ? undefined : parsePermissionLevel(permissionLevel),
				Number.isNaN(price) || price < 0 ? undefined : price
			)
			return published === null ? c.notFound() : c.json(toSaveResult(published))
		}
	)

	// Set an invention's price. Unlike update/publish this one POSTs a JSON body.
	// Auth-gated, creator only; answers the save envelope.
	.post(
		'/api/inventions/v1/updateprice',
		describeRoute({
			tags: ['Inventions'],
			summary: 'Set an invention’s price',
			description:
				'Unlike update/publish, this one POSTs a JSON body. Creator only; a negative price ' +
				'is rejected.',
			security: AUTHED,
			requestBody: jsonBody(UpdatePriceRequest, 'The invention and its new price'),
			responses: {
				200: json(InventionSaveResult, 'The repriced invention, in the save envelope'),
				400: json(ErrorResponse, 'Unparseable body, or a price below 0'),
				401: UNAUTHORIZED_RESPONSE,
				403: json(ErrorResponse, 'Not the caller’s invention'),
				404: { description: 'No such invention' },
			},
		}),
		async (c) => {
			const body = (await c.req.json().catch(() => null)) as Record<string, unknown> | null
			if (body === null) return c.json({ error: 'Invalid request body' }, 400)

			const inventionId = typeof body.InventionId === 'number' ? body.InventionId : Number.NaN
			const gate = await creatorsInvention(c, inventionId)
			if ('response' in gate) return gate.response

			const price = typeof body.Price === 'number' ? body.Price : Number.NaN
			if (Number.isNaN(price) || price < 0) return c.json({ error: 'Price must be >= 0' }, 400)

			const updated = await setInventionPrice(c.env.DB, gate.invention.InventionId, price)
			return updated === null ? c.notFound() : c.json(toSaveResult(updated))
		}
	)

	// Replace an invention's tags. `CustomTags` are the creator's own (Type 0),
	// `AutoTags` the ones the client derives from the invention (Type 2); both lists
	// are replaced wholesale. Auth-gated, and only the creator may retag their own
	// invention. Answers `{ Result, Tags }` — `Result` 0 is success, and `Tags` is the
	// flat list of tag *names* (auto first, then custom); the typed `{ Tag, Type }`
	// objects are what `v1/details` serves.
	.post(
		'/api/inventions/v1/settags',
		describeRoute({
			tags: ['Inventions'],
			summary: 'Replace an invention’s tags',
			description:
				'`CustomTags` are the creator’s own (Type 0), `AutoTags` the ones the client ' +
				'derives from the invention (Type 2); both lists are replaced wholesale. Creator ' +
				'only.\n\n' +
				'Every tag in either list must be at most 15 letters (a–z once lowercased); one ' +
				'that isn’t fails the whole call, so no tag is ever silently dropped.\n\n' +
				'Note the asymmetry: this answers the flat list of tag *names* (auto first, then ' +
				'custom), while `v1/details` serves the typed `{ Tag, Type }` objects.',
			security: AUTHED,
			requestBody: jsonBody(SetTagsRequest, 'The replacement tag lists'),
			responses: {
				200: json(SetTagsResponse, 'The resulting tag names'),
				400: json(ErrorResponse, 'Unparseable body, or a tag that breaks the rule'),
				401: UNAUTHORIZED_RESPONSE,
				403: json(ErrorResponse, 'Not the caller’s invention'),
				404: { description: 'No such invention' },
			},
		}),
		async (c) => {
			const body = (await c.req.json().catch(() => null)) as Record<string, unknown> | null
			if (body === null) return c.json({ error: 'Invalid request body' }, 400)

			const inventionId = typeof body.InventionId === 'number' ? body.InventionId : Number.NaN
			const gate = await creatorsInvention(c, inventionId)
			if ('response' in gate) return gate.response

			const strings = (v: unknown): string[] =>
				Array.isArray(v) ? v.filter((t): t is string => typeof t === 'string') : []

			const autoTags = strings(body.AutoTags)
			const customTags = strings(body.CustomTags)

			// Both lists are held to the tag rule, and one bad tag fails the whole call rather
			// than being dropped — a silently missing tag looks to the creator like a tag that
			// saved. Checked against the normalized form `setInventionTags` will store, so the
			// rejection quotes the tag as it would have been stored, not as it was typed.
			// Blanks are skipped, not rejected: the store already drops them, and the client
			// pads its list with empties.
			for (const raw of [...autoTags, ...customTags]) {
				const tag = raw.trim().toLowerCase()
				if (tag === '') continue
				const rejection = inventionTagRejection(tag)
				if (rejection !== null) {
					return c.json({ error: `${rejection} (“${tag}”)` }, 400)
				}
			}

			const tags = await setInventionTags(
				c.env.DB,
				gate.invention.InventionId,
				autoTags,
				customTags
			)
			return c.json({ Result: 0, Tags: (tags ?? []).map((t) => t.Tag) })
		}
	)

	// An invention's detail card (`?inventionId=…`) — just its tags, as `{ Tags }`.
	// Untagged inventions report an empty list. 404s on unknown ids.
	.get(
		'/api/inventions/v1/details',
		describeRoute({
			tags: ['Inventions'],
			summary: 'An invention’s detail card',
			description:
				'Which in practice is just its tags, as typed `{ Tag, Type }` objects. An untagged ' +
				'invention reports an empty list.',
			parameters: [intQuery('inventionId', 'Invention id; required')],
			responses: {
				200: json(InventionDetails, 'The invention’s tags'),
				400: json(ErrorResponse, 'Missing or non-numeric inventionId'),
				404: { description: 'No such invention' },
			},
		}),
		async (c) => {
			const inventionId = Number.parseInt(c.req.query('inventionId') ?? '', 10)
			if (Number.isNaN(inventionId)) return c.json({ error: 'inventionId is required' }, 400)
			const tags = await getInventionTags(c.env.DB, inventionId)
			return tags === null ? c.notFound() : c.json({ Tags: tags })
		}
	)

	// The "top today" invention feed — the inventions most acquired in the last 24 hours,
	// counted from the purchase rows the `econ` worker writes. A real day window, so an
	// empty list is a quiet day rather than a bug. Paginated via skip/take (take defaults
	// to 50, as the client asks for). Bare array.
	.get(
		'/api/inventions/v1/toptoday',
		describeRoute({
			tags: ['Inventions'],
			summary: 'The “top today” feed',
			description:
				'Published inventions ranked by how many players acquired them in the last 24 ' +
				'hours, counted from the purchase records — free grants included, one per ' +
				'player per invention. Genuinely a window: an invention nobody has picked up ' +
				'since yesterday falls off, and a day with no acquisitions at all serves an ' +
				'empty list. It trails the clock rather than resetting at midnight.',
			parameters: pageParams(50),
			responses: { 200: json(InventionDto.array(), 'The top inventions') },
		}),
		async (c) => {
			const skip = Number.parseInt(c.req.query('skip') ?? '0', 10) || 0
			const take = Number.parseInt(c.req.query('take') ?? '50', 10) || 50
			return c.json(await getTopInventions(c.env.DB, skip, take))
		}
	)

	// The featured invention feed — the curated (`IsFeatured`) inventions and nothing
	// else, newest first. Empty until someone flags one. Bare array, like toptoday.
	.get(
		'/api/inventions/v1/featured',
		describeRoute({
			tags: ['Inventions'],
			summary: 'The featured feed',
			description:
				'Curated (`IsFeatured`) inventions, newest first — published and non-hidden only. ' +
				'Serves an empty list while nothing is flagged rather than standing in the top ' +
				'feed: the client presents these as hand-picked, so a fallback would be a lie.',
			parameters: pageParams(50),
			responses: { 200: json(InventionDto.array(), 'The featured inventions') },
		}),
		async (c) => {
			const skip = Number.parseInt(c.req.query('skip') ?? '0', 10) || 0
			const take = Number.parseInt(c.req.query('take') ?? '50', 10) || 50
			return c.json(await getFeaturedInventions(c.env.DB, skip, take))
		}
	)

	// Invention search/browse: published inventions matching `value` (matched against
	// name + description; absent → browse everything published), newest first.
	// Paginated via skip/take (take defaults to 100). Returns a bare array.
	.get(
		'/api/inventions/v2/search',
		describeRoute({
			tags: ['Inventions'],
			summary: 'Search / browse inventions',
			description:
				'Published inventions matching `value` (matched against name and description), ' +
				'newest first. An absent `value` browses everything published — that is the ' +
				'browse screen’s initial request.',
			parameters: [
				stringQuery('value', 'Search text; absent browses everything'),
				...pageParams(100),
			],
			responses: { 200: json(InventionDto.array(), 'The matching inventions') },
		}),
		async (c) => {
			const value = c.req.query('value') ?? ''
			const skip = Number.parseInt(c.req.query('skip') ?? '0', 10) || 0
			const take = Number.parseInt(c.req.query('take') ?? '100', 10) || 100
			return c.json(await searchInventions(c.env.DB, value, skip, take))
		}
	)

	// The signed-in player's invention shelf ("my inventions"), newest first — the ones
	// they created AND the ones they bought (`inventory_invention`, written by the `econ`
	// worker's buyInvention). A bought invention stays on the shelf whatever happens to it
	// afterwards: unpublished or hidden since, the buyer paid for it.
	// Auth-gated; returns a bare array (empty when the player has neither).
	.get(
		'/api/inventions/v2/mine',
		describeRoute({
			tags: ['Inventions'],
			summary: 'The caller’s own inventions',
			description:
				'“My inventions”, newest first — the ones the caller created plus the ones they ' +
				'bought. Includes unpublished ones, which nobody else can see, and keeps a bought ' +
				'invention listed even if it has since been unpublished or hidden. Not paginated.',
			security: AUTHED,
			responses: {
				200: json(InventionDto.array(), 'The caller’s inventions'),
				401: UNAUTHORIZED_RESPONSE,
			},
		}),
		async (c) => {
			const id = await authedId(c)
			if (id === null) return unauthorized(c)
			return c.json(await getMyInventions(c.env.DB, id))
		}
	)

	// Save an invention's metadata. The data file itself is uploaded separately
	// through the `storage` worker and referenced here by `inventionDataFilename` —
	// the one required field, since an invention with no data blob is unusable. An
	// omitted name/description is defaulted rather than rejected. Auth-gated; returns
	// the `{ Status, Invention, InventionVersion }` envelope the client expects (the
	// invention carries its assigned inventionId).
	.post(
		'/api/inventions/v6/save',
		describeRoute({
			tags: ['Inventions'],
			summary: 'Save a new invention',
			description:
				'Records an invention’s metadata. The data file itself is uploaded separately ' +
				'through the `storage` worker and referenced here by `inventionDataFilename` — the ' +
				'one required field, since an invention with no data blob is unusable. An omitted ' +
				'name/description is defaulted rather than rejected; a supplied one must be 3–24 ' +
				'characters of letters, digits, spaces, dashes and colons (name) or at most 512 ' +
				'characters (description).\n\n' +
				'A freshly saved invention is private: it shows up only in the creator’s own list ' +
				'until they call `v3/publish`.',
			security: AUTHED,
			requestBody: jsonBody(SaveInventionRequest, 'The invention metadata (camelCase)'),
			responses: {
				200: json(InventionSaveResult, 'The stored invention, carrying its assigned id'),
				400: json(
					ErrorResponse,
					'Unparseable body, no inventionDataFilename, or an invalid name/description'
				),
				401: UNAUTHORIZED_RESPONSE,
			},
		}),
		async (c) => {
			const id = await authedId(c)
			if (id === null) return unauthorized(c)

			const body = (await c.req.json().catch(() => null)) as Record<string, unknown> | null
			if (body === null) return c.json({ error: 'Invalid request body' }, 400)

			const str = (v: unknown): string | undefined => (typeof v === 'string' ? v : undefined)
			const num = (v: unknown): number | undefined => (typeof v === 'number' ? v : undefined)

			const inventionDataFilename = str(body.inventionDataFilename)?.trim()
			if (!inventionDataFilename) {
				return c.json({ error: 'inventionDataFilename is required' }, 400)
			}

			// An omitted or blank name/description is defaulted by `createInvention` ("Untitled",
			// "No description yet"), so only a supplied one is held to the rules — otherwise
			// saving an unnamed invention would fail the 3-character minimum on a name the
			// player never typed.
			const name = str(body.name)?.trim()
			const nameRejection = name === undefined || name === '' ? null : inventionNameRejection(name)
			if (nameRejection !== null) return c.json({ error: nameRejection }, 400)

			const description = str(body.description)
			const descriptionRejection =
				description === undefined ? null : inventionDescriptionRejection(description)
			if (descriptionRejection !== null) return c.json({ error: descriptionRejection }, 400)

			const invention = await createInvention(c.env.DB, c.env.CDN_ASSETS, {
				creatorPlayerId: id,
				inventionDataFilename,
				name,
				description,
				imageName: str(body.imageName),
				instantiationCost: num(body.instantiationCost),
				lightsCost: num(body.lightsCost),
				chipsCost: num(body.chipsCost),
				cloudVariablesCost: num(body.cloudVariablesCost),
				aiCost: num(body.aiCost),
				creationRoomId: num(body.creationRoomId),
				referencedInventions: Array.isArray(body.referencedInventions)
					? body.referencedInventions.filter((v): v is number => typeof v === 'number')
					: undefined,
			})
			return c.json(toSaveResult(invention))
		}
	)
