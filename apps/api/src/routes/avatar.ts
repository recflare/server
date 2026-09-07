import { Hono } from 'hono'
import { describeRoute } from 'hono-openapi'

import {
	CURRENT_OUTFIT_SLOT,
	getOutfit,
	getOutfitsByAccounts,
	inventionDescriptionRejection,
	inventionLongDescriptionRejection,
	inventionNameRejection,
	inventionTagRejection,
	MAX_BULK_OUTFIT_ACCOUNTS,
	setOutfit,
} from '@repo/domain'

import {
	createCustomAvatarItem,
	deleteCustomAvatarItem,
	getCustomAvatarItem,
	getCustomAvatarItems,
	listCustomAvatarItemsByCreator,
	listFeaturedCustomAvatarItems,
	listHotCustomAvatarItems,
	searchCustomAvatarItems,
	updateCustomAvatarItem,
} from '../custom-avatar-items-db'
import { authedId, unauthorized } from '../http'
import {
	createInvention,
	deleteInvention,
	getFeaturedInventions,
	getInventionById,
	getInventionsByIds,
	getInventionsByRoom,
	getInventionTagFilters,
	getInventionTags,
	getInventionVersion,
	getMyInventions,
	getTopInventions,
	INVENTION_TAG_RESULT,
	inventionDeleteResult,
	inventionSaveV9Failure,
	normalizeInventionTags,
	ownsAllInventions,
	parsePermissionLevel,
	publishInvention,
	searchInventions,
	setInventionPrice,
	setInventionTags,
	toSaveResult,
	toSaveResultV9,
	updateInvention,
} from '../inventions-db'
import {
	AUTHED,
	BareBoolean,
	BareInteger,
	BulkCustomAvatarItemsRequest,
	CreateCustomAvatarItemRequest,
	CustomAvatarItemList,
	CustomAvatarItemReportRequest,
	CustomAvatarItemResponse,
	CustomAvatarItemsPage,
	DeleteInventionRequest,
	ErrorResponse,
	form,
	GeneratedGift,
	GenerateGiftRequest,
	idParam,
	intQuery,
	InventionDeleteResult,
	InventionDetails,
	InventionDto,
	InventionPersonalDetails,
	InventionReportRequest,
	InventionSaveResult,
	InventionSaveV9Result,
	InventionVersionDto,
	json,
	JsonArray,
	jsonBody,
	LegacyAvatarItemSaves,
	OPTIONAL_AUTHED,
	OutfitSaveResponse,
	OutfitsBulkRequest,
	OutfitsBulkResponse,
	OutfitsMeRequest,
	OutfitsMeResponse,
	pageParams,
	PublishInventionRequest,
	SaveInventionRequest,
	SaveInventionV9Request,
	SetTagsRequest,
	SetTagsResponse,
	stringParam,
	stringQuery,
	SuccessErrorEnvelope,
	SuccessValueEnvelope,
	TagFilters,
	UNAUTHORIZED_RESPONSE,
	UpdateCustomAvatarItemRequest,
	UpdateInventionMetadataRequest,
	UpdatePriceRequest,
} from '../openapi'
import { createReport } from '../reports-db'

import type { Context } from 'hono'
import type { App } from '../context'
import type { InventionTag, SavedInvention } from '../inventions-db'

/**
 * The most ids `POST /api/customAvatarItems/v1/bulk` will resolve. A batch over this answers
 * EMPTY rather than being truncated.
 *
 * Empty rather than the first 100, because a truncated answer is indistinguishable from the
 * items simply not existing — the client reads the items it got back, not the ids it asked
 * about, so it cannot tell a cut-off batch from a batch of misses and would cache the
 * difference. Nothing renders this many custom items at once, so a batch this size is the
 * client doing something other than filling a screen.
 */
const BULK_CUSTOM_AVATAR_ITEM_CAP = 100

/**
 * The ids `POST /api/customAvatarItems/v1/bulk` was asked to resolve. They ride as repeated
 * `customAvatarItemIds` form fields, and the same spelling is read off the query string
 * too — the client's exact encoding here has not been pinned down, so both are accepted
 * rather than guessing one and answering nothing when it's the other.
 *
 * Each value may itself be a comma-separated list, and blanks are dropped rather than
 * failing the request: a stray id must not cost the caller the rest of the batch. The order
 * asked for is preserved, since `getCustomAvatarItems` answers in it.
 */
async function bulkCustomAvatarItemIds(c: Context<App>): Promise<string[]> {
	const raw = [...(c.req.queries('customAvatarItemIds') ?? [])]
	const body = await c.req.parseBody({ all: true }).catch(() => ({}) as Record<string, unknown>)
	const key = Object.keys(body).find((k) => k.toLowerCase() === 'customavataritemids')
	const posted = key === undefined ? [] : body[key]
	for (const value of Array.isArray(posted) ? posted : [posted]) {
		if (typeof value === 'string') raw.push(value)
	}
	return raw
		.flatMap((value) => value.split(','))
		.map((v) => v.trim())
		.filter((v) => v !== '')
}

/**
 * The gate every invention write runs through: the caller must be signed in, the
 * invention must exist, and it must be theirs. Yields the loaded invention, or why not —
 * as a reason and the status it maps to, so that a caller answering an envelope can put
 * the reason where its client will read it instead of in a body that client can't parse.
 * {@link creatorsInvention} is the rendering the older routes want.
 */
async function creatorsInventionResult(
	c: Context<App>,
	inventionId: number
): Promise<
	{ invention: SavedInvention } | { rejection: string; status: 400 | 401 | 403 | 404 }
> {
	const playerId = await authedId(c)
	if (playerId === null) return { rejection: 'Unauthorized', status: 401 }
	if (Number.isNaN(inventionId)) return { rejection: 'inventionId is required', status: 400 }

	const invention = await getInventionById(c.env.DB, inventionId)
	if (invention === null) return { rejection: 'No such invention', status: 404 }
	if (invention.CreatorPlayerId !== playerId) {
		return { rejection: 'Not your invention', status: 403 }
	}
	return { invention }
}

/**
 * {@link creatorsInventionResult} as the older invention writes answer it: the loaded
 * invention, or the response to return as-is (400 / 401 / 403 / 404).
 */
async function creatorsInvention(
	c: Context<App>,
	inventionId: number
): Promise<{ invention: SavedInvention } | { response: Response | Promise<Response> }> {
	const gate = await creatorsInventionResult(c, inventionId)
	if ('invention' in gate) return gate
	if (gate.status === 401) return { response: unauthorized(c) }
	if (gate.status === 404) return { response: c.notFound() }
	return { response: c.json({ error: gate.rejection }, gate.status) }
}

/**
 * The tags a `{ AutoTags, CustomTags }` request asks for, and whether they were taken —
 * the block the v9 save sends as `tagsRequest` and `v2/metadata` sends as `TagsRequest`.
 * Null when the client named no block at all, which each caller reads its own way: a save
 * stores no tags, an edit leaves the stored ones alone.
 *
 * Tags are held to the same rule `v1/settags` applies, but a tag that breaks it costs the
 * TAGS and not the write: both replies carry a tag result of their own precisely because
 * the two outcomes are separate, and refusing a save would make the player redo a build
 * over a hyphen. All the tags go rather than the offending one alone, so nothing is
 * silently half-applied — the creator re-submits the list and sees what took. Blanks are
 * skipped rather than counted against it; the client pads its lists with empties.
 */
function requestedTags(request: unknown): { tags: InventionTag[]; tagResult: number } | null {
	if (typeof request !== 'object' || request === null) return null

	const lists = request as Record<string, unknown>
	const strings = (v: unknown): string[] =>
		Array.isArray(v) ? v.filter((t): t is string => typeof t === 'string') : []
	const autoTags = strings(lists.AutoTags)
	const customTags = strings(lists.CustomTags)

	const rejected = [...autoTags, ...customTags].some((raw) => {
		const tag = raw.trim().toLowerCase()
		return tag !== '' && inventionTagRejection(tag) !== null
	})
	return rejected
		? { tags: [], tagResult: INVENTION_TAG_RESULT.rejected }
		: { tags: normalizeInventionTags(autoTags, customTags), tagResult: INVENTION_TAG_RESULT.success }
}

/**
 * What an invention save produced: the stored record and how its tags fared, or the one
 * message that refuses it. Both save routes go through {@link createInventionFromBody} to
 * get one of these and then render it their own way — v6 bare, v9 enveloped — because the
 * two versions disagree about the shape of a reply, not about what a save is.
 */
type InventionSaveOutcome =
	| { rejection: string }
	| { invention: SavedInvention; tags: InventionTag[]; tagResult: number }

/**
 * The invention save both `v6/save` and `v9/save` run through. v9 sends everything v6 does
 * plus what the invention points at (`referencedUnityAssetIds`), what it says about itself
 * (`longDescription`, `displayMetadataJson`, `convertedFromInventionId`), `ugcVersion` and
 * `hasBetaContent`, and the tags that until now needed a second `v1/settags` call. One
 * reader takes them all: a v6 client sends none of them, and each is optional, so parsing
 * them here changes nothing about the record a v6 save stores.
 */
async function createInventionFromBody(
	c: Context<App>,
	creatorPlayerId: number,
	body: Record<string, unknown>
): Promise<InventionSaveOutcome> {
	const str = (v: unknown): string | undefined => (typeof v === 'string' ? v : undefined)
	const num = (v: unknown): number | undefined => (typeof v === 'number' ? v : undefined)
	const bool = (v: unknown): boolean | undefined => (typeof v === 'boolean' ? v : undefined)
	const list = <T>(v: unknown, is: (x: unknown) => x is T): T[] | undefined =>
		Array.isArray(v) ? v.filter(is) : undefined
	const isString = (v: unknown): v is string => typeof v === 'string'
	const isNumber = (v: unknown): v is number => typeof v === 'number'

	const inventionDataFilename = str(body.inventionDataFilename)?.trim()
	if (!inventionDataFilename) return { rejection: 'inventionDataFilename is required' }

	// An omitted or blank name/description is defaulted by `createInvention` ("Untitled",
	// "No description yet"), so only a supplied one is held to the rules — otherwise
	// saving an unnamed invention would fail the 3-character minimum on a name the
	// player never typed.
	const name = str(body.name)?.trim()
	const nameRejection = name === undefined || name === '' ? null : inventionNameRejection(name)
	if (nameRejection !== null) return { rejection: nameRejection }

	const description = str(body.description)
	const descriptionRejection =
		description === undefined ? null : inventionDescriptionRejection(description)
	if (descriptionRejection !== null) return { rejection: descriptionRejection }

	// v9 folds `v1/settags` into the save; a client that names no tags gets none.
	const requested = requestedTags(body.tagsRequest) ?? {
		tags: [],
		tagResult: INVENTION_TAG_RESULT.success,
	}

	const invention = await createInvention(c.env.DB, c.env.CDN_ASSETS, {
		creatorPlayerId,
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
		referencedInventions: list(body.referencedInventions, isNumber),
		ugcVersion: num(body.ugcVersion),
		hasBetaContent: bool(body.hasBetaContent),
		referencedUnityAssetIds: list(body.referencedUnityAssetIds, isString),
		longDescription: str(body.longDescription),
		displayMetadataJson: str(body.displayMetadataJson),
		convertedFromInventionId: num(body.convertedFromInventionId),
		tags: requested.tags,
	})
	return { invention, ...requested }
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
	.get(
		'/api/customAvatarItems/v1/minPriceForPublicItem',
		describeRoute({
			tags: ['Avatar'],
			summary: 'Minimum token price for a public custom item',
			description:
				'The floor the creation UI enforces when listing a custom item publicly. A fixed `100`.',
			responses: { 200: json(BareInteger, 'A bare `100`') },
		}),
		(c) => c.json(100)
	)
	.post(
		'/api/customAvatarItems/v1',
		describeRoute({
			tags: ['Avatar'],
			summary: 'Create a custom avatar item',
			description:
				'Multipart: a `metadata` JSON text field plus two file parts, `thumbnailImage` ' +
				'(PNG) and `design` (the design blob). Inserts a `custom_avatar_item` row owned ' +
				'by the caller and answers with it in the PascalCase `{ Value, Success, Error, ' +
				'error_id }` envelope.\n\n' +
				'The two files go to the shared image bucket (`recflare-img`) under ' +
				'`avatar-item/<date>/<id>-thumb.png` and `avatar-item/<date>/<id>-design.png`; those ' +
				'keys are the `ThumbnailImageFilename` / `DesignFilename` on the row.',
			security: AUTHED,
			requestBody: form(CreateCustomAvatarItemRequest, 'The metadata and the two files'),
			responses: {
				200: json(CustomAvatarItemResponse, 'The created item'),
				400: json(CustomAvatarItemResponse, 'Missing or malformed metadata / files'),
				401: UNAUTHORIZED_RESPONSE,
			},
		}),
		async (c) => {
			const id = await authedId(c)
			if (id === null) return unauthorized(c)

			const fail = (message: string) =>
				c.json({ Value: null, Success: false, Error: message, error_id: null }, 400)

			const body = await c.req.parseBody().catch(() => ({}) as Record<string, unknown>)
			if (typeof body.metadata !== 'string') return fail('metadata is required')
			let meta: Record<string, unknown>
			try {
				const parsed: unknown = JSON.parse(body.metadata)
				if (!parsed || typeof parsed !== 'object') return fail('metadata must be a JSON object')
				meta = parsed as Record<string, unknown>
			} catch {
				return fail('metadata is not valid JSON')
			}
			if (typeof meta.Name !== 'string' || meta.Name.trim() === '') return fail('Name is required')
			if (typeof meta.BaseAvatarItemId !== 'number') return fail('BaseAvatarItemId is required')
			if (typeof meta.BaseAvatarItemColor !== 'string')
				return fail('BaseAvatarItemColor is required')
			if (!(body.thumbnailImage instanceof File)) return fail('thumbnailImage is required')
			if (!(body.design instanceof File)) return fail('design is required')

			// Both files go to the shared image bucket, foldered by upload date and keyed by
			// the item's id (chosen here so the keys can carry it). The `img` worker serves
			// them back by key.
			const customAvatarItemId = crypto.randomUUID()
			const prefix = `avatar-item/${new Date().toISOString().slice(0, 10)}/${customAvatarItemId}`
			const thumbnailImageFilename = `${prefix}-thumb.png`
			const designFilename = `${prefix}-design.png`
			await Promise.all([
				c.env.IMAGES.put(thumbnailImageFilename, await body.thumbnailImage.arrayBuffer(), {
					httpMetadata: { contentType: body.thumbnailImage.type || 'image/png' },
				}),
				c.env.IMAGES.put(designFilename, await body.design.arrayBuffer(), {
					httpMetadata: { contentType: body.design.type || 'image/png' },
				}),
			])

			const item = await createCustomAvatarItem(c.env.DB, {
				customAvatarItemId,
				creatorAccountId: id,
				name: meta.Name,
				description: typeof meta.Description === 'string' ? meta.Description : '',
				price: typeof meta.Price === 'number' ? meta.Price : 0,
				baseAvatarItemId: meta.BaseAvatarItemId,
				baseAvatarItemColor: meta.BaseAvatarItemColor,
				accessibility: typeof meta.Accessibility === 'number' ? meta.Accessibility : 0,
				designFilename,
				thumbnailImageFilename,
			})
			return c.json({ Value: item, Success: true, Error: null, error_id: null })
		}
	)
	.put(
		'/api/customAvatarItems/v1/:id{[0-9a-fA-F-]{36}}',
		describeRoute({
			tags: ['Avatar'],
			summary: 'Edit a custom avatar item',
			description:
				'A partial edit of `Name`, `Description`, `Price` and `Accessibility` — the client ' +
				'sends every field and nulls the ones it is not changing, so null means "leave ' +
				'alone". Only the creator may edit. `ModifiedAt` is bumped. Answers the updated ' +
				'item in the same `{ Value, Success, Error, error_id }` envelope as the create.',
			security: AUTHED,
			parameters: [stringParam('id', 'The `CustomAvatarItemId`')],
			requestBody: jsonBody(UpdateCustomAvatarItemRequest, 'The fields to change'),
			responses: {
				200: json(CustomAvatarItemResponse, 'The updated item'),
				400: json(CustomAvatarItemResponse, 'Malformed body'),
				401: UNAUTHORIZED_RESPONSE,
				403: json(CustomAvatarItemResponse, 'Not the creator'),
				404: json(CustomAvatarItemResponse, 'No such item'),
			},
		}),
		async (c) => {
			const id = await authedId(c)
			if (id === null) return unauthorized(c)
			const fail = (status: 400 | 403 | 404, message: string) =>
				c.json({ Value: null, Success: false, Error: message, error_id: null }, status)

			const itemId = c.req.param('id')
			const existing = await getCustomAvatarItem(c.env.DB, itemId)
			if (!existing) return fail(404, 'No such item')
			if (existing.CreatorAccountId !== id) return fail(403, 'Not your item')

			const body = (await c.req.json().catch(() => null)) as Record<string, unknown> | null
			if (!body) return fail(400, 'A JSON body is required')
			const str = (v: unknown, field: string): string | null | undefined => {
				if (v === null || v === undefined) return null
				if (typeof v !== 'string') throw new TypeError(`${field} must be a string`)
				return v
			}
			const int = (v: unknown, field: string): number | null => {
				if (v === null || v === undefined) return null
				if (typeof v !== 'number' || !Number.isInteger(v))
					throw new TypeError(`${field} must be an integer`)
				return v
			}
			let patch
			try {
				patch = {
					name: str(body.Name, 'Name'),
					description: str(body.Description, 'Description'),
					price: int(body.Price, 'Price'),
					accessibility: int(body.Accessibility, 'Accessibility'),
				}
			} catch (e) {
				return fail(400, (e as Error).message)
			}
			if (patch.name !== null && patch.name?.trim() === '')
				return fail(400, 'Name must not be blank')

			const item = await updateCustomAvatarItem(c.env.DB, itemId, patch)
			if (!item) return fail(404, 'No such item')
			return c.json({ Value: item, Success: true, Error: null, error_id: null })
		}
	)
	.delete(
		'/api/customAvatarItems/v1/:id{[0-9a-fA-F-]{36}}',
		describeRoute({
			tags: ['Avatar'],
			summary: 'Delete a custom avatar item',
			description:
				'Removes the item and its two bucket objects (thumbnail and design). Only the ' +
				'creator may delete. Answers the deleted item in the `{ Value, Success, Error, ' +
				'error_id }` envelope.',
			security: AUTHED,
			parameters: [stringParam('id', 'The `CustomAvatarItemId`')],
			responses: {
				200: json(CustomAvatarItemResponse, 'The deleted item'),
				401: UNAUTHORIZED_RESPONSE,
				403: json(CustomAvatarItemResponse, 'Not the creator'),
				404: json(CustomAvatarItemResponse, 'No such item'),
			},
		}),
		async (c) => {
			const id = await authedId(c)
			if (id === null) return unauthorized(c)
			const fail = (status: 403 | 404, message: string) =>
				c.json({ Value: null, Success: false, Error: message, error_id: null }, status)

			const itemId = c.req.param('id')
			const existing = await getCustomAvatarItem(c.env.DB, itemId)
			if (!existing) return fail(404, 'No such item')
			if (existing.CreatorAccountId !== id) return fail(403, 'Not your item')

			const item = await deleteCustomAvatarItem(c.env.DB, itemId)
			if (!item) return fail(404, 'No such item')
			// The row is gone; the objects follow. A missing key is a no-op for R2.
			await c.env.IMAGES.delete([item.ThumbnailImageFilename, item.DesignFilename])
			return c.json({ Value: item, Success: true, Error: null, error_id: null })
		}
	)

	// The featured custom-avatar-item feed: flagged (`is_featured`) AND published
	// (`Accessibility` != 0) items from the `custom_avatar_item` table.
	.get(
		'/api/customAvatarItems/v1/featured',
		describeRoute({
			tags: ['Avatar'],
			summary: 'Featured custom avatar items',
			description:
				'The curated feed: items with `IsFeatured` set that are also published ' +
				'(`Accessibility` 0 is unpublished and is excluded even when flagged), newest first, ' +
				'up to 50. Nothing sets the flag yet, so it stays empty until an operator does.',
			responses: { 200: json(CustomAvatarItemList, 'The items, newest first') },
		}),
		async (c) => c.json(await listFeaturedCustomAvatarItems(c.env.DB))
	)

	// The store's item search. The client sends the full set of `outfitTypes` it can render
	// plus paging, and expects a BARE ARRAY of items back — not the `{ Results, TotalResults }`
	// envelope `fromCreator` uses.
	//
	// Several parameters are accepted and not yet acted on; they are listed in the description
	// rather than dropped silently, because a caller cannot tell the difference between a filter
	// that was applied and one that was ignored by looking at the results.
	.get(
		'/api/customAvatarItems/v1/search',
		describeRoute({
			tags: ['Avatar'],
			summary: 'Search custom avatar items',
			description: [
				'The store’s item search: published items (`Accessibility` 0 is unpublished and is',
				'left out, from its creator too — `fromCreator` is where they see their own),',
				'newest first, as a BARE ARRAY.',
				'`searchQuery` matches an item’s NAME or its DESCRIPTION, case-insensitively, as a',
				'substring; `%` and `_` in it are literal.',
				'`outfitTypes` may repeat and acts as a whitelist; sending none means no filter',
				'rather than no results, since the client sends every type it can render.',
				'`minPrice`/`maxPrice` bound the price, inclusive.',
				'`skip`/`take` page the results, `take` capped at 200.',
				'`includeCoachItems=false` leaves out this server’s stock content.',
				'`itemTypes`, `ordering`, `unityAssetTarget` and `unityAssetVersion` are accepted and',
				'NOT yet acted on — nothing records purchase or wear counts to rank by, no per-target',
				'asset variants are stored, and custom avatar items are the only item type there is.',
				'`includePurchaseInfos` likewise: `PurchaseInfo` is null on every item for now,',
				'whatever it says.',
			].join(' '),
			parameters: [
				{
					name: 'searchQuery',
					in: 'query',
					required: false,
					description: 'Free text matched against the item’s name or description',
					schema: { type: 'string' },
				},
				{
					name: 'outfitTypes',
					in: 'query',
					required: false,
					description: 'OutfitType to include; repeat for several. None means all.',
					schema: { type: 'array', items: { type: 'integer' } },
				},
				{
					name: 'skip',
					in: 'query',
					required: false,
					description: 'Rows to skip (default 0)',
					schema: { type: 'integer', minimum: 0 },
				},
				{
					name: 'take',
					in: 'query',
					required: false,
					description: 'Rows to return (default 50, capped at 200)',
					schema: { type: 'integer', minimum: 0 },
				},
				{
					name: 'minPrice',
					in: 'query',
					required: false,
					description: 'Lowest price to include, inclusive',
					schema: { type: 'integer', minimum: 0 },
				},
				{
					name: 'maxPrice',
					in: 'query',
					required: false,
					description: 'Highest price to include, inclusive',
					schema: { type: 'integer', minimum: 0 },
				},
				{
					name: 'includeCoachItems',
					in: 'query',
					required: false,
					description: 'Include the Coach’s stock items (default true)',
					schema: { type: 'boolean' },
				},
			],
			responses: { 200: json(CustomAvatarItemList, 'The matching items, newest first') },
		}),
		async (c) => {
			// `?outfitTypes=0&outfitTypes=2&…` — repeated, so read every value. A non-numeric one is
			// dropped rather than turned into NaN, which would match nothing and quietly empty a
			// filter the caller believes they set.
			const outfitTypes = c.req
				.queries('outfitTypes')
				?.map((v) => Number.parseInt(v, 10))
				.filter((n) => Number.isInteger(n))

			// The client capitalises its booleans (`includeCoachItems=True`), so this is folded
			// before comparing; anything that isn't recognisably false leaves the default alone.
			const includeCoachItems = c.req.query('includeCoachItems')?.toLowerCase() !== 'false'

			const int = (name: string): number | undefined => {
				const raw = c.req.query(name)
				if (raw === undefined) return undefined
				const n = Number.parseInt(raw, 10)
				return Number.isInteger(n) ? n : undefined
			}

			return c.json(
				await searchCustomAvatarItems(c.env.DB, {
					searchQuery: c.req.query('searchQuery'),
					outfitTypes,
					includeCoachItems,
					minPrice: int('minPrice'),
					maxPrice: int('maxPrice'),
					skip: int('skip'),
					take: int('take'),
				})
			)
		}
	)

	// The "hot" (trending) custom-avatar-item feed: every published (`Accessibility` != 0)
	// item from the `custom_avatar_item` table. There is nothing to rank a trend from yet,
	// so it is the accessible items, newest first.
	.get(
		'/api/customAvatarItems/v1/hot',
		describeRoute({
			tags: ['Avatar'],
			summary: 'Trending custom avatar items',
			description:
				'The “hot” feed: the published items (`Accessibility` 0 is unpublished and is left ' +
				'out), newest first, up to 50. No purchase or wear counts are recorded, so there is ' +
				'no trend to rank by and recency stands in for one.',
			responses: { 200: json(CustomAvatarItemList, 'The items, newest first') },
		}),
		async (c) => c.json(await listHotCustomAvatarItems(c.env.DB))
	)

	// A batch lookup of custom avatar items by id, out of the `custom_avatar_item` table.
	// The reference filters its catalog down to the posted ids and returns the MATCHES AS A
	// BARE ARRAY — not the `{ Results, TotalResults }` page that catalog is written in, and
	// not a 404 for ids it doesn't hold.
	//
	// This is how a `1.<guid>` entity in a GENERIC discovery row (`lists`
	// `/algorithmiclists/:list?type=5`) gets resolved, so a row naming a custom item renders
	// nothing at all when this doesn't answer. It stubbed out `[]` while nothing stored custom
	// items; the table has existed since migration 0015 and the stub outlived it.
	//
	// Auth-gated, and the token is checked before anything else, as the reference does.
	//
	// A batch over {@link BULK_CUSTOM_AVATAR_ITEM_CAP} ids answers EMPTY. The client has been
	// seen posting far more ids than a screen could draw, and serving those is both a large
	// query and a large response for a request that is already not what it looks like. Empty is
	// the safe answer because a miss here is not an error: unknown ids are simply absent, so the
	// client already handles getting back fewer items than it asked about.
	.post(
		'/api/customAvatarItems/v1/bulk',
		describeRoute({
			tags: ['Avatar'],
			summary: 'Custom avatar items in bulk',
			description:
				'Resolves a batch of custom-avatar-item ids to their items: the posted ' +
				'`customAvatarItemIds` filtered against the `custom_avatar_item` table, returned ' +
				'as a BARE ARRAY of the ones that matched, in the order they were asked for. Not ' +
				'the `{ Results, TotalResults }` page the sibling custom-item reads serve — the ' +
				'reference keeps its catalog in that shape but answers this route with the ' +
				'filtered array alone.\n\n' +
				'A miss is not an error: unknown ids are simply absent from the response, and the ' +
				'client reads the items it got back rather than the ids it asked for. Unpublished ' +
				'items (`Accessibility` 0) miss for everyone but their creator, the same rule the ' +
				'feeds and the creator shelf apply.\n\n' +
				'Ids ride as repeated `customAvatarItemIds` form fields; a comma-separated value ' +
				'and the same spelling on the query string are both accepted, since the client’s ' +
				'exact encoding here has not been pinned down.\n\n' +
				'A batch of more than 100 ids answers an EMPTY array without reading the table: the ' +
				'client has been seen posting more than a screen could draw, and a miss is already ' +
				'not an error here.',
			security: AUTHED,
			requestBody: form(BulkCustomAvatarItemsRequest, 'The custom-avatar-item ids to resolve'),
			responses: {
				200: json(CustomAvatarItemList, 'The items that matched, in request order'),
				401: UNAUTHORIZED_RESPONSE,
			},
		}),
		async (c) => {
			const id = await authedId(c)
			if (id === null) return unauthorized(c)

			const ids = await bulkCustomAvatarItemIds(c)

			// Over the cap: empty, and the table is not touched. Answering the batch would be a
			// large query and a large response for a request that is already not what it looks
			// like — a screen does not draw this many items.
			if (ids.length > BULK_CUSTOM_AVATAR_ITEM_CAP) return c.json([])

			const items = await getCustomAvatarItems(c.env.DB, ids)
			// Unpublished items are held back from everyone but their creator — the same rule
			// the featured/hot feeds and the creator shelf apply, so an item can't be surfaced
			// through this route that the feeds hide.
			return c.json(
				items.filter((item) => item.Accessibility !== 0 || item.CreatorAccountId === id)
			)
		}
	)

	// Custom avatar items created by a given account, from the `custom_avatar_item` table,
	// in the paginated shape (matches the econ `customAvatarItems/v1/owned` shape). Auth is
	// optional: the creator themselves also sees their unpublished (`Accessibility` 0) items.
	.get(
		'/api/customAvatarItems/v2/fromCreator/:accountId{[0-9]+}',
		describeRoute({
			tags: ['Avatar'],
			summary: 'A creator’s custom avatar items',
			description:
				'The items an account has authored, newest first, in the same page shape as the ' +
				'`econ` worker’s `customAvatarItems/v1/owned`. Published items only — unless the ' +
				'bearer token is the creator’s, in which case their unpublished (`Accessibility` 0) ' +
				'items are included too. Paging is not applied (the client sends none), so ' +
				'`TotalResults` is the length of `Results`.',
			security: OPTIONAL_AUTHED,
			parameters: [idParam('accountId', 'Creator account id')],
			responses: { 200: json(CustomAvatarItemsPage, 'The creator’s items') },
		}),
		async (c) => {
			const accountId = Number.parseInt(c.req.param('accountId'), 10)
			const viewer = await authedId(c)
			return c.json(await listCustomAvatarItemsByCreator(c.env.DB, accountId, viewer === accountId))
		}
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
			tags: ['Avatar', '2025'],
			summary: 'The caller’s outfit',
			description:
				'The newer outfit read, on a bare un-prefixed path. Served from slot 0 of the shared ' +
				'`outfit` table — the newer client treats slot 0 as the outfit currently worn — and ' +
				'handed back exactly as it was saved, since the payload’s heavy fields are the ' +
				'client’s own JSON-in-a-string documents.\n\n' +
				'A player who has never saved gets the brand-new-account envelope, which is a ' +
				'different, flatter shape than a stored outfit: the four empty-string fields ' +
				'`FaceFeatures`, `HairColor`, `OutfitSelections` and `SkinColor`, and nothing else.',
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
				FaceFeatures: '',
				HairColor: '',
				OutfitSelections: '',
				SkinColor: '',
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
			tags: ['Avatar', '2025'],
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

	// Several players' worn outfits at once — what the client calls to dress everyone in a
	// room rather than asking per player. POST because the account list rides in the body.
	//
	// The answer is a MAP keyed by account id, not a list: the client looks each player up by
	// id, and a list would make it match up the order itself. An account with nothing saved is
	// left out of the map — see `getOutfitsByAccounts`.
	//
	// `UnityAssetTarget` / `UnityAssetVersion` name the baked-asset build the client would
	// like the outfits for. Nothing here bakes assets, so both are accepted and ignored.
	.post(
		'/outfits/bulk',
		describeRoute({
			tags: ['Avatar'],
			summary: 'Several players’ outfits',
			description:
				'The worn outfit (slot 0) of each account in `AccountIds`, keyed by account id — the ' +
				'call the client makes to dress a room full of players in one request.\n\n' +
				'A MAP rather than a list: the client looks each player up by id. The key is the id ' +
				'as a string, and the value is the same stored outfit `GET /outfits/me` serves, ' +
				'handed back exactly as it was saved. An account with nothing saved in slot 0 is ' +
				'ABSENT from the map rather than carrying a null — a map says “no outfit” by not ' +
				'having the key, and inventing one for a player who has never saved would dress them ' +
				'in something they never chose.\n\n' +
				'Repeated ids collapse, and at most 99 distinct accounts may be named — one query, ' +
				'one round trip, and a room holds nothing like that many players. A longer list is ' +
				'a 400 rather than a partial answer, which would read as “those players have no ' +
				'outfit”. `UnityAssetTarget` / `UnityAssetVersion` name a baked-asset build and are ' +
				'accepted and ignored: nothing here bakes assets.',
			security: AUTHED,
			requestBody: jsonBody(OutfitsBulkRequest, 'The accounts whose outfits are wanted'),
			responses: {
				200: json(OutfitsBulkResponse, 'The outfits that exist, keyed by account id'),
				400: json(ErrorResponse, 'Unparseable body, or more than 99 accounts'),
				401: UNAUTHORIZED_RESPONSE,
			},
		}),
		async (c) => {
			const id = await authedId(c)
			if (id === null) return unauthorized(c)

			const body = (await c.req.json().catch(() => null)) as Record<string, unknown> | null
			if (body === null) return c.json({ error: 'Invalid request body' }, 400)

			// Only the integers survive: the field is the client's, and a malformed entry is
			// dropped rather than turned into a NaN lookup that can never match a row.
			const accountIds = Array.isArray(body.AccountIds)
				? body.AccountIds.filter((v): v is number => Number.isInteger(v))
				: []
			// One query, one round trip — so the list has to fit D1's parameter cap. A room
			// holds nothing like this many players; a longer list is refused rather than
			// quietly answered in part, which would look like those accounts have no outfit.
			if (new Set(accountIds).size > MAX_BULK_OUTFIT_ACCOUNTS) {
				return c.json({ error: `At most ${MAX_BULK_OUTFIT_ACCOUNTS} accounts per request` }, 400)
			}

			const outfits = await getOutfitsByAccounts(c.env.DB, accountIds, CURRENT_OUTFIT_SLOT)
			const OutfitsByAccountId: Record<string, unknown> = {}
			for (const [accountId, outfit] of outfits) OutfitsByAccountId[String(accountId)] = outfit
			return c.json({ OutfitsByAccountId })
		}
	)

	// The caller's outfit wardrobe. An empty list for now — the outfits saved through
	// `PUT /outfits/me` are in the shared `outfit` table already, but which of them
	// belong in this list (and in what shape) has not been pinned down, so it answers []
	// rather than guessing.
	.get(
		'/outfits/me/saved',
		describeRoute({
			tags: ['Avatar', '2025'],
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
	// blob that isn't there — except `version=0`, which means "whichever is current"
	// rather than a number to match. Nothing has a version 0, so a caller sending it
	// doesn't know which version it wants, and matching it literally 404s an invention
	// that exists.
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
				'is not there.\n\n' +
				'`version=0` is the exception: it means “whichever is current” rather than a ' +
				'number to match, and gets the current version. No invention has a version 0 — a ' +
				'fresh save is version 1 — so a caller sending it does not know which version it ' +
				'wants, and matching it literally 404s an invention that exists.',
			parameters: [
				intQuery('inventionId', 'Invention id; required'),
				intQuery('version', 'Version number; required. `0` means the current version'),
			],
			responses: {
				200: json(InventionVersionDto, 'The version'),
				400: json(ErrorResponse, 'Missing inventionId or version'),
				404: { description: 'No such invention, or a version number that is not the current one' },
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

			const published = await publishInvention(c.env.DB, gate.invention.InventionId, {
				permissionLevel:
					permissionLevel === undefined ? undefined : parsePermissionLevel(permissionLevel),
				price: Number.isNaN(price) || price < 0 ? undefined : price,
			})
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

	// The featured dorm-skin feed (inventions that reskin the dorm). Nothing curates these
	// yet → an empty list, so the client's shelf renders empty rather than 404ing.
	.get(
		'/api/inventions/v1/featureddormskins',
		describeRoute({
			tags: ['Inventions'],
			summary: 'The featured dorm-skin feed',
			description: 'Curated dorm-skin inventions. Nothing is curated yet, so it is empty.',
			responses: { 200: json(JsonArray, 'An empty list') },
		}),
		(c) => c.json([])
	)

	// Inventions by particular creators (`?id=207&id=…`) — what the client fills a creator's
	// shelf, and the "from creators you follow" row, from.
	//
	// STUB: an empty list for now. It is the honest answer rather than a placeholder, since
	// the client reads it as "this creator has published nothing" and renders an empty
	// shelf, where a 404 would read as a row that failed to load. When it becomes real it is
	// a filter on the invention table's creator column, the same feed shape as `toptoday`
	// and `featured` above — `id` is repeatable, and `skip`/`take` page it.
	.get(
		'/api/inventions/v1/fromcreators',
		describeRoute({
			tags: ['Inventions'],
			summary: 'Inventions by particular creators (stub)',
			description:
				'The published inventions of the accounts named by `id` (repeatable), newest first — ' +
				'a creator’s shelf, and the "from creators you follow" row. STUB: always an empty ' +
				'array for now, which the client renders as "nothing published" rather than as a ' +
				'failed load. `id`, `skip` and `take` are accepted and, for the moment, ignored.',
			parameters: [
				intQuery('id', 'Creator account id; repeatable. Accepted and ignored by the stub'),
				...pageParams(100),
			],
			responses: { 200: json(InventionDto.array(), 'Empty — nothing is served here yet') },
		}),
		(c) => c.json([])
	)

	// Invention search/browse: published inventions matching `value` (matched against
	// name + description; absent → browse everything published), newest first.
	// Paginated via skip/take (take defaults to 100). Returns a bare array.
	//
	// Filtered, ordered and paged in SQL — it must not read the catalogue into memory to
	// answer one page.
	.get(
		'/api/inventions/v2/search',
		describeRoute({
			tags: ['Inventions'],
			summary: 'Search / browse inventions',
			description:
				'Published inventions matching `value`, newest first. `value` is split into terms ' +
				'and every term must match, each against the name and the description. An absent ' +
				'`value` browses everything published — that is the browse screen’s initial ' +
				'request. Tags are NOT searched: a `#tag` term from the browse screen’s filter ' +
				'chips is treated as text and matches nothing.',
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

	// Report a custom avatar item. Stored in the `report` table the player, event and invention
	// reports use — same fields, same moderation life — with `custom_avatar_item_id` set. See
	// migrations/0017_report_custom_avatar_item.sql.
	//
	// The item is named by the PATH, not the body, which is what distinguishes this from its
	// siblings; the body's `ReportedPlayerId` arrives NULL and is ignored, since the client does
	// not know who made the item.
	.post(
		'/api/customAvatarItems/v1/:id{[0-9a-fA-F-]{36}}/report',
		describeRoute({
			tags: ['Avatar', 'Moderation'],
			summary: 'Report a custom avatar item',
			description:
				'Files a report against a custom avatar item, named by the PATH. Stored as a row in ' +
				'the same `report` table a player report goes to (`POST /api/PlayerReporting/v3/create`), ' +
				'an event report and an invention report — the same submission with the same ' +
				'moderation life, which a moderator converts into a ban the same way. What marks it ' +
				'as an item report is `custom_avatar_item_id`; the row’s `reported_player_id` is the ' +
				'item’s CREATOR, read from the item. The body’s `ReportedPlayerId` is sent as null ' +
				'and IGNORED even when set — the client does not know who made the item, and letting ' +
				'a client name who a report is against would let it point one at anybody. Nothing ' +
				'fills `room_id`: an item isn’t tied to one room the way an event is.\n\n' +
				'The reporter is the caller (from the bearer token), never a body field. ' +
				'`ReportCategory` is stored verbatim — the enum is not mapped here. Nothing dedupes ' +
				'the rows: reporting the same item twice files two reports, and reporting your own ' +
				'is allowed rather than being a special case.\n\n' +
				'Answers the `{ success, error }` envelope the event and invention reports use, ' +
				'`error` being an empty string rather than null, on the rejected branches too so ' +
				'there is only one shape to parse.',
			security: AUTHED,
			parameters: [idParam('id', 'The custom avatar item’s guid')],
			requestBody: jsonBody(CustomAvatarItemReportRequest, 'The report'),
			responses: {
				200: json(SuccessErrorEnvelope, '`{ success: true, error: "" }`'),
				401: UNAUTHORIZED_RESPONSE,
				404: json(SuccessErrorEnvelope, 'No such custom avatar item'),
			},
		}),
		async (c) => {
			const reporterId = await authedId(c)
			if (reporterId === null) return unauthorized(c)

			const customAvatarItemId = c.req.param('id')

			// The item supplies the reported player. An unknown item is refused rather than filed
			// against nobody: the row's reported player has to be someone, and a report naming an
			// item that never existed isn't actionable.
			const item = await getCustomAvatarItem(c.env.DB, customAvatarItemId)
			if (item === null) return c.json({ success: false, error: 'No such item' }, 404)

			// A body that won't parse is not a reason to lose the report: the path already names
			// what is being reported and the token names who reported it, so an unreadable body
			// costs the category and the description, not the row.
			const body = await c.req
				.json<{ ReportCategory?: unknown; Details?: unknown }>()
				.catch(() => ({}) as Record<string, unknown>)
			const category = Number(body.ReportCategory)
			await createReport(c.env.DB, {
				reporterPlayerId: reporterId,
				reportedPlayerId: item.CreatorAccountId,
				reportCategory: Number.isInteger(category) ? category : 0,
				details: typeof body.Details === 'string' ? body.Details : null,
				customAvatarItemId,
			})

			return c.json({ success: true, error: '' })
		}
	)

	// Report an invention. Stored in the `report` table the player and event reports use —
	// same fields, same moderation life — with `invention_id` set. See
	// migrations/0016_report_invention.sql.
	.post(
		'/api/inventions/v1/report',
		describeRoute({
			tags: ['Inventions', 'Moderation'],
			summary: 'Report an invention',
			description:
				'Files a report against an invention. Stored as a row in the same `report` table a ' +
				'player report goes to (`POST /api/PlayerReporting/v3/create`) and an event report ' +
				'(`POST /api/playerevents/v1/report`) — it is the same submission with the same ' +
				'moderation life, and a moderator converts any of them into a ban the same way. ' +
				'What marks it as an invention report is `invention_id`; the row’s ' +
				'`reported_player_id` is the invention’s CREATOR — who a moderator would act ' +
				'against — read from the invention rather than sent by the client. Nothing fills ' +
				'`room_id`: an invention isn’t tied to one room the way an event is.\n\n' +
				'The reporter is the caller (from the bearer token), never a body field. ' +
				'`ReportCategory` is stored verbatim — the enum is not mapped here. Nothing ' +
				'dedupes the rows: reporting the same invention twice files two reports, and ' +
				'reporting your own is allowed rather than being a special case.\n\n' +
				'Answers the same `{ success, error }` envelope as the event report, `error` being ' +
				'an empty string rather than null, on the rejected branches too so there is only ' +
				'one shape to parse.',
			security: AUTHED,
			requestBody: jsonBody(InventionReportRequest, 'The report'),
			responses: {
				200: json(SuccessErrorEnvelope, '`{ success: true, error: "" }`'),
				400: json(SuccessErrorEnvelope, 'No usable `InventionId` in the body'),
				401: UNAUTHORIZED_RESPONSE,
				404: json(SuccessErrorEnvelope, 'No such invention'),
			},
		}),
		async (c) => {
			const reporterId = await authedId(c)
			if (reporterId === null) return unauthorized(c)

			const body = await c.req
				.json<{ InventionId?: unknown; ReportCategory?: unknown; Details?: unknown }>()
				.catch(() => ({}) as Record<string, unknown>)
			const inventionId = Number(body.InventionId)
			if (!Number.isInteger(inventionId)) {
				return c.json({ success: false, error: 'InventionId is required' }, 400)
			}

			// The invention supplies the reported player. An unknown invention is refused rather
			// than filed against nobody: the row's reported player has to be someone, and a
			// report naming an invention that never existed isn't actionable.
			const invention = await getInventionById(c.env.DB, inventionId)
			if (invention === null) return c.json({ success: false, error: 'No such invention' }, 404)

			const category = Number(body.ReportCategory)
			await createReport(c.env.DB, {
				reporterPlayerId: reporterId,
				reportedPlayerId: invention.CreatorPlayerId,
				reportCategory: Number.isInteger(category) ? category : 0,
				details: typeof body.Details === 'string' ? body.Details : null,
				inventionId,
			})

			return c.json({ success: true, error: '' })
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

			const outcome = await createInventionFromBody(c, id, body)
			if ('rejection' in outcome) return c.json({ error: outcome.rejection }, 400)
			return c.json(toSaveResult(outcome.invention))
		}
	)

	// The same save as the newer client sends it: v6's body plus the invention's
	// references, its long description and display metadata, what the saved blob is, and
	// the tags — which v6 clients set afterwards through `v1/settags`. It stores the same
	// record; what differs is the REPLY, which is enveloped. See `InventionSaveV9Result`:
	// the client reads `Success` and then `Value.Invention.InventionId`, and a body that
	// isn't this envelope — a bare `{ error }`, or the empty 401 the other routes answer —
	// takes it down rather than failing it, which is why every branch below answers one.
	.post(
		'/api/inventions/v9/save',
		describeRoute({
			tags: ['Inventions'],
			summary: 'Save a new invention (v9)',
			description:
				'`v6/save` plus the fields the newer client sends: `referencedUnityAssetIds`, ' +
				'`longDescription`, `displayMetadataJson`, `convertedFromInventionId`, ' +
				'`ugcVersion`, `hasBetaContent`, and a `tagsRequest` carrying the same ' +
				'`AutoTags`/`CustomTags` lists `v1/settags` takes. Every one is optional and is ' +
				'stored only when sent, so a body v6 would accept produces the same record here.' +
				'\n\n' +
				'The reply is where the two versions part: v9 is ENVELOPED as ' +
				'`{ Value, Success, Error, error_id }`, with v6’s ' +
				'`{ Status, Invention, InventionVersion }` inside `Value` alongside a ' +
				'`TagsResponse`. The client reads `Success` and then ' +
				'`Value.Invention.InventionId`; `Error` is the only text it ever shows a human.' +
				'\n\n' +
				'So a refusal is *also* a 200 carrying `{ Success: false, Error, Value: null }` — ' +
				'the client dereferences `Value` unguarded when `Success` is true, and treats ' +
				'anything that isn’t this envelope as a null one. Tags are held to the ' +
				'`v1/settags` rule (at most 15 letters each), but one that breaks it costs the ' +
				'tags and not the save: `TagsResponse.Result` comes back non-zero and the creator ' +
				're-submits them through `v1/settags`.\n\n' +
				'A freshly saved invention is private: it shows up only in the creator’s own list ' +
				'until they call `v3/publish`.',
			security: AUTHED,
			requestBody: jsonBody(SaveInventionV9Request, 'The invention metadata (camelCase)'),
			responses: {
				200: json(
					InventionSaveV9Result,
					'The envelope — the stored invention under `Value`, or `Success: false` with ' +
						'`Error` when the save was refused'
				),
				401: json(InventionSaveV9Result, 'The same envelope, refused — not an empty body'),
			},
		}),
		async (c) => {
			const id = await authedId(c)
			if (id === null) return c.json(inventionSaveV9Failure('Unauthorized'), 401)

			const body = (await c.req.json().catch(() => null)) as Record<string, unknown> | null
			if (body === null) return c.json(inventionSaveV9Failure('Invalid request body'))

			const outcome = await createInventionFromBody(c, id, body)
			return c.json(
				'rejection' in outcome
					? inventionSaveV9Failure(outcome.rejection)
					: toSaveResultV9(outcome.invention, outcome.tags, outcome.tagResult)
			)
		}
	)

	// Edit an invention's metadata, as the newer client sends it: one PUT with a PascalCase
	// body where every field but the id is nullable, and NULL means "leave this alone" —
	// the client sends the whole shape every time and marks the fields it isn't touching.
	// The tags ride along the way they do on `v9/save`, and the reply is that same
	// envelope: `v1/update` is the older client's version of this endpoint, query params
	// and a bare body and all.
	.put(
		'/api/inventions/v2/metadata',
		describeRoute({
			tags: ['Inventions'],
			summary: 'Edit an invention’s metadata (v2)',
			description:
				'Creator only. Every field but `InventionId` is nullable and a null one is left ' +
				'as it is — the client sends the whole shape on every edit — so this is a patch, ' +
				'not a replace. An empty string is not a null: it is how a creator CLEARS a ' +
				'description, long description or image. `Name` is the exception, since a nameless ' +
				'invention isn’t a thing the client can draw: it is held to the same 3–24 ' +
				'character rule `v6/save` enforces, which an empty name fails.\n\n' +
				'`TagsRequest` replaces both tag lists wholesale, exactly as `v1/settags` does; a ' +
				'null one leaves the stored tags alone. A tag that breaks the tag rule costs the ' +
				'tags and not the edit — `TagsResponse.Result` comes back non-zero.\n\n' +
				'Answers the enveloped result `v9/save` answers, carrying the UPDATED invention: ' +
				'the client re-renders the detail page from `Value.Invention`. Refusals — an ' +
				'unknown invention and someone else’s alike — are `Success: false` with a null ' +
				'`Value` rather than a bare error body, which that client cannot parse.',
			security: AUTHED,
			requestBody: jsonBody(UpdateInventionMetadataRequest, 'The fields to change'),
			responses: {
				200: json(
					InventionSaveV9Result,
					'The envelope — the updated invention under `Value`, or `Success: false` with ' +
						'`Error` when the edit was refused'
				),
				401: json(InventionSaveV9Result, 'The same envelope, refused — not an empty body'),
			},
		}),
		async (c) => {
			const body = (await c.req.json().catch(() => null)) as Record<string, unknown> | null
			if (body === null) return c.json(inventionSaveV9Failure('Invalid request body'))

			// The id rides in the body here, not the query string.
			const gate = await creatorsInventionResult(
				c,
				typeof body.InventionId === 'number' ? body.InventionId : Number.NaN
			)
			// Only a missing token is answered as a transport failure. An unknown invention
			// or someone else's is a domain answer the client is meant to read — its own
			// status enum has DoesNotExist and NotCreator members — so it goes in the
			// envelope, where the message reaches a human.
			if ('rejection' in gate) {
				return gate.status === 401
					? c.json(inventionSaveV9Failure(gate.rejection), 401)
					: c.json(inventionSaveV9Failure(gate.rejection))
			}

			// Null is "leave it"; a string, empty or not, is an edit.
			const edited = (key: string): string | undefined =>
				typeof body[key] === 'string' ? body[key] : undefined
			const name = edited('Name')?.trim()
			const description = edited('Description')
			const longDescription = edited('LongDescription')

			for (const rejection of [
				name === undefined ? null : inventionNameRejection(name),
				description === undefined ? null : inventionDescriptionRejection(description),
				longDescription === undefined
					? null
					: inventionLongDescriptionRejection(longDescription),
			]) {
				if (rejection !== null) return c.json(inventionSaveV9Failure(rejection))
			}

			// A null TagsRequest leaves the stored tags alone, and the reply still reports
			// them: the client reads the list back as the tags the invention now has, not as
			// the ones this call changed.
			const requested = requestedTags(body.TagsRequest)
			const updated = await updateInvention(c.env.DB, gate.invention.InventionId, {
				name,
				description,
				longDescription,
				imageName: edited('ImageName'),
				tags: requested?.tags,
			})
			if (updated === null) return c.json(inventionSaveV9Failure('No such invention'))
			return c.json(
				toSaveResultV9(
					updated,
					updated.Tags ?? [],
					requested?.tagResult ?? INVENTION_TAG_RESULT.success
				)
			)
		}
	)

	// Publish an invention, as the newer client sends it: a PascalCase body instead of a
	// query string, and an Accessibility of its own — where `v3/publish` only ever flipped
	// the published flag, this decides whether the result can be FOUND. Same enveloped
	// reply as `v9/save`, carrying the published invention.
	.post(
		'/api/inventions/v4/publish',
		describeRoute({
			tags: ['Inventions'],
			summary: 'Publish an invention (v4)',
			description:
				'What puts an invention into search and the feeds. Creator only.\n\n' +
				'`Permission` is the `GeneralPermission` other players get, as a raw ladder ' +
				'number (the publish sheet sends 20, UseOnly). `Accessibility` says where it can ' +
				'be found — 1 (Public) lists it, 2 (Unlisted) publishes it reachable by id but ' +
				'keeps it out of browse and search. A null `Price` leaves the price alone rather ' +
				'than zeroing it, so re-publishing something that was for sale doesn’t give it ' +
				'away; every field but `InventionId` is nullable and an omitted one keeps what ' +
				'the invention has.\n\n' +
				'Publishing is not undone here, and re-publishing doesn’t re-date the first ' +
				'publish. Refusals answer `Success: false` with a null `Value`, the way ' +
				'`v9/save` does.',
			security: AUTHED,
			requestBody: jsonBody(PublishInventionRequest, 'What the publish decides'),
			responses: {
				200: json(
					InventionSaveV9Result,
					'The envelope — the published invention under `Value`, or `Success: false` ' +
						'with `Error` when the publish was refused'
				),
				401: json(InventionSaveV9Result, 'The same envelope, refused — not an empty body'),
			},
		}),
		async (c) => {
			const body = (await c.req.json().catch(() => null)) as Record<string, unknown> | null
			if (body === null) return c.json(inventionSaveV9Failure('Invalid request body'))

			const gate = await creatorsInventionResult(
				c,
				typeof body.InventionId === 'number' ? body.InventionId : Number.NaN
			)
			// As on `v2/metadata`: only a missing token is a transport failure. The rest are
			// answers the client is meant to read out of the envelope.
			if ('rejection' in gate) {
				return gate.status === 401
					? c.json(inventionSaveV9Failure(gate.rejection), 401)
					: c.json(inventionSaveV9Failure(gate.rejection))
			}

			// Null is "leave it". The permission and accessibility are taken as sent rather
			// than checked against the ladder, the way `parsePermissionLevel` already accepts
			// a raw number: the ladders are the client's, and a level this server hasn't heard
			// of is better stored than swapped for one the creator didn't pick.
			const int = (key: string): number | undefined =>
				typeof body[key] === 'number' && Number.isInteger(body[key]) ? body[key] : undefined
			const price = int('Price')

			const published = await publishInvention(c.env.DB, gate.invention.InventionId, {
				permissionLevel: int('Permission'),
				accessibility: int('Accessibility'),
				// A negative price is dropped rather than stored, as it is on `v3/publish`.
				price: price !== undefined && price < 0 ? undefined : price,
			})
			if (published === null) return c.json(inventionSaveV9Failure('No such invention'))
			return c.json(toSaveResultV9(published, published.Tags ?? []))
		}
	)

	// Delete an invention. The newer client's shape: a POST with a PascalCase body
	// carrying nothing but the id. Auth-gated, creator only — the only thing that may
	// remove an invention is the account that made it, not a co-owner and not a buyer.
	//
	// The record and everything inside it (versions, tags, referenced-invention lists)
	// go in one DELETE; the data blob in R2 and the `inventory_invention` rows of
	// players who bought it are left alone. See `deleteInvention` for why.
	.post(
		'/api/inventions/v2/delete',
		describeRoute({
			tags: ['Inventions'],
			summary: 'Delete an invention',
			description:
				'Creator only — a buyer or a co-owner cannot delete someone else’s invention. ' +
				'The record goes entirely: its versions, tags and referenced-invention lists live ' +
				'in the same row.\n\n' +
				'What survives is deliberate. The data blob stays in storage, because nothing ' +
				'here knows whether another record still points at that filename. The ownership ' +
				'rows of players who bought it stay too — a delete must not rewrite what someone ' +
				'else paid for — and they fall out of every list on their own, since an owned id ' +
				'with no invention row behind it is skipped.\n\n' +
				'Answers the `{ Value, Success, Error, error_id }` envelope the other v2+ ' +
				'invention routes use, with `Value` NULL: the invention is gone, so there is ' +
				'nothing to redraw from and the client reads only `Success`. Refusals — an ' +
				'unknown invention and someone else’s alike — are `Success: false` with a ' +
				'message, not a bare error body that client cannot parse.',
			security: AUTHED,
			requestBody: jsonBody(DeleteInventionRequest, 'The invention to delete'),
			responses: {
				200: json(InventionDeleteResult, 'The delete envelope, `Value` null either way'),
				401: json(InventionDeleteResult, 'The same envelope, refused — not an empty body'),
			},
		}),
		async (c) => {
			const body = (await c.req.json().catch(() => null)) as Record<string, unknown> | null
			if (body === null) return c.json(inventionDeleteResult('Invalid request body'))

			// The id rides in the body, as it does on `v2/metadata` and `v4/publish`.
			const gate = await creatorsInventionResult(
				c,
				typeof body.InventionId === 'number' ? body.InventionId : Number.NaN
			)
			// As on those two: only a missing token is a transport failure. An unknown
			// invention or someone else's is a domain answer the client reads out of the
			// envelope, where the message reaches a human.
			if ('rejection' in gate) {
				return gate.status === 401
					? c.json(inventionDeleteResult(gate.rejection), 401)
					: c.json(inventionDeleteResult(gate.rejection))
			}

			// The gate already loaded the row, so a null here is a race — someone deleted it
			// between the two reads — and lands where the client would put it anyway: gone.
			const deleted = await deleteInvention(c.env.DB, gate.invention.InventionId)
			return c.json(
				deleted === null ? inventionDeleteResult('No such invention') : inventionDeleteResult()
			)
		}
	)
