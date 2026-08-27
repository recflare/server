import { resolver } from 'hono-openapi'
import { z } from 'zod'

import type { OpenAPIV3_1 } from 'openapi-types'

/**
 * OpenAPI schemas for the lists worker.
 *
 * IMPORTANT: these are DESCRIPTIVE ONLY. They are passed to `describeRoute` to generate
 * the spec and are never wired into `hono-openapi`'s `validator()`. Same rationale as
 * the other workers: a reverse-engineered protocol, lenient handlers, no runtime
 * validation.
 *
 * Do NOT add `.meta({ id })` to these schemas — with this hono-openapi + zod v4 setup a
 * meta'd schema used in a response emits a `$ref` the framework doesn't always hoist into
 * `components.schemas`, leaving a dangling reference. Leaving meta off makes every schema
 * inline, which renders correctly in any tool.
 */

/** Emit a zod schema as an `application/json` response body. */
export function json(schema: z.ZodType, description: string) {
	return { description, content: { 'application/json': { schema: resolver(schema) } } }
}

function toOpenApiSchema(schema: z.ZodType): OpenAPIV3_1.SchemaObject {
	const { $schema: _$schema, additionalProperties: _extra, ...jsonSchema } = z.toJSONSchema(schema)
	return jsonSchema as OpenAPIV3_1.SchemaObject
}

/**
 * A form-encoded request body. The client posts `application/x-www-form-urlencoded`; Hono's
 * `parseBody()` also reads multipart, so both are documented on the one body.
 */
export function form(schema: z.ZodType, description: string): OpenAPIV3_1.RequestBodyObject {
	const f = toOpenApiSchema(schema)
	return {
		description,
		content: {
			'application/x-www-form-urlencoded': { schema: f },
			'multipart/form-data': { schema: f },
		},
	}
}

/** The empty-body 401 the auth-gated routes return. */
export const UNAUTHORIZED_RESPONSE = { description: 'Missing or invalid bearer token (empty body)' }

/** Bearer-JWT security requirement, for the auth-gated routes. */
export const AUTHED = [{ bearerAuth: [] }]

// ---- Parameters ------------------------------------------------------------

/**
 * The repeated `?id=` query the bulk lookup selects on — repetition, not a delimiter, so
 * `explode: true` form style rather than one comma-joined value.
 *
 * Documented for the shape of the request only: nothing curates lists here yet, so the
 * answer is the same canned list whatever is asked for (see `CuratedListsBulk`).
 */
export const LIST_IDS_PARAM: OpenAPIV3_1.ParameterObject = {
	name: 'id',
	in: 'query',
	required: false,
	description: [
		'A list id to look up, repeated once per list wanted. Ignored today — the canned list',
		'is served whatever is asked for, an unknown id included, because a 404 renders as a',
		'row that failed to load rather than one the client hides.',
	].join(' '),
	style: 'form',
	explode: true,
	schema: { type: 'array', items: { type: 'string' } },
	example: ['17859340'],
}

/**
 * `?creatorAccountId=` on the read. NOT auth: the client asks for its own lists by naming
 * its account id, and `Accessibility` is a property of the list rather than of the reader.
 */
export const CREATOR_ACCOUNT_ID_PARAM: OpenAPIV3_1.ParameterObject = {
	name: 'creatorAccountId',
	in: 'query',
	required: false,
	description: [
		'Who owns the list. Matched exactly against a stored list, and used as the most',
		'specific key against the static captures — a creator nothing owns falls back to',
		'matching on type and name. Echoed back on an unowned reserved list, so the client',
		'still sees the list it asked for.',
	].join(' '),
	schema: { type: 'integer', example: 42 },
}

/**
 * `?type=` on the read — the `ListEntityType`, which is what the `ItemIds` ARE. See the
 * note on `resolveCuratedList`: it is NOT the page-source enum, even though the captures
 * are pages.
 */
export const LIST_TYPE_PARAM: OpenAPIV3_1.ParameterObject = {
	name: 'type',
	in: 'query',
	required: false,
	description: [
		'The `ListEntityType` — what the list’s `ItemIds` are: 0 Accounts · 1 Rooms ·',
		'2 Inventions · 3 CustomAvatarItems · 4 PurchasableItems · 5 Generic · 6 ChipAndPort ·',
		'7 DiscoverySection · 8 DiscoverySectionSubType. Part of a list’s identity, not a',
		'filter: `__SavedForLater_Rooms` is asked for with `type=1` (its items are room ids)',
		'while every static capture is `type=7` (its items are discovery section keys).',
	].join(' '),
	schema: { type: 'integer', example: 1 },
}

/** `?name=` on the read — the list itself. */
export const LIST_NAME_PARAM: OpenAPIV3_1.ParameterObject = {
	name: 'name',
	in: 'query',
	required: false,
	description: [
		'The list’s name, matched case-insensitively (the casing that arrives is the',
		'client’s). Naming NO list asks for the page default for `type`; naming one that',
		'matches nothing is a 404, unless it is one of the client’s own reserved `__`',
		'playlists, which answers empty.',
	].join(' '),
	schema: { type: 'string', example: '__SavedForLater_Rooms' },
}

/** `{name}` on the save — the list written into, created when the caller has none. */
export const SAVE_LIST_NAME_PARAM: OpenAPIV3_1.ParameterObject = {
	name: 'name',
	in: 'path',
	required: true,
	description: [
		'The caller’s list to save into, created if they have none by that name.',
		'`__SavedForLater_Rooms` is the one the client creates for itself — the Play menu’s',
		'“Saved for Later” row.',
	].join(' '),
	schema: { type: 'string', example: '__SavedForLater_Rooms' },
}

/** `{itemId}` on the save — what goes into the list, as a string. */
export const ITEM_ID_PARAM: OpenAPIV3_1.ParameterObject = {
	name: 'itemId',
	in: 'path',
	required: true,
	description: [
		'The item to save, as a string — a room id for the room lists the client builds this',
		'way. Saving the same item twice leaves it in the list once.',
	].join(' '),
	schema: { type: 'string', example: '953' },
}

/**
 * `{list}` on a discovery row — the row SLUG, which is what a curated page's `ItemIds` and
 * a discovery section's `sourceMetadata` name.
 */
export const ALGORITHMIC_LIST_PARAM: OpenAPIV3_1.ParameterObject = {
	name: 'list',
	in: 'path',
	required: true,
	description: [
		'The row key, matched case-insensitively. `HotList`, `recentlyupdated` and `new` are',
		'ranked for real; `recentlyvisited` is per-caller; the seven `*_algoendpoint` category',
		'rows serve the public rooms carrying one tag; `summerpartycarousel` and `newitems` are',
		'hand-picked store ids. Every other key — an unknown one included — answers an empty',
		'row with a 200.',
	].join(' '),
	// Deliberately not an `enum`: an unknown slug is a legal request that answers an empty
	// row, so freezing today's keys here would document a rejection that never happens.
	schema: { type: 'string', example: 'HotList' },
}

/** `?type=` on a discovery row — echoed back, saying what the row's `Id`s are. */
export const ALGORITHMIC_TYPE_PARAM: OpenAPIV3_1.ParameterObject = {
	name: 'type',
	in: 'query',
	required: false,
	description: [
		'The `ListEntityType` the caller wants the row’s ids read as, ECHOED back on the',
		'response — it tells the client which service to resolve the ids against. A BYTE on',
		'the client, so a value outside 0–255 (or none at all) is answered with 1, Rooms,',
		'which is what the client always asks for.',
	].join(' '),
	schema: { type: 'integer', minimum: 0, maximum: 255, example: 1 },
}

// ---- Response schemas ------------------------------------------------------

/**
 * One curated list as the client parses it, out of D1 or out of a static capture.
 *
 * `ListId` is a NUMBER on the wire — a quoted id fails the client's parser — and the
 * reference's ids are 64-bit (`624765592684307326`), past what a JS number holds exactly.
 * They are carried as strings internally and unquoted on the way out, so this is `number`
 * rather than a bounded integer.
 */
const CuratedListFields = {
	ListId: z
		.number()
		.describe('64-bit; 0 on an unowned reserved list, since nothing was stored to have an id'),
	CreatorAccountId: z.int().describe('The owner; echoed from the query on a reserved list'),
	Name: z.string(),
	Description: z.string().nullable(),
	ImageName: z
		.string()
		.nullable()
		.describe(
			'A STRING on any list the client draws a tile for — it reads this straight into a string field, and empty or null renders that tile blank. `DefaultRoomImage.jpg` where nothing set one. Null only on a list with no tile to draw, like the `RoomGenreTags` capture, whose items are genre names rather than rooms.'
		),
	Type: z.int().describe('The `ListEntityType` — what the `ItemIds` are'),
	ItemIds: z
		.string()
		.array()
		.describe(
			'Strings even where they stand for numeric ids, in the order they were added — which is the order the row displays them.'
		),
	CreatedAt: z.string().describe('ISO-8601 UTC'),
}

/**
 * The READ's projection, which keeps `Accessibility`. The save's drops it — a real
 * difference in what the client is sent, not an oversight; don't unify them.
 */
export const CuratedListRead = z.object({
	...CuratedListFields,
	Accessibility: z
		.int()
		.optional()
		.describe(
			'The `Accessibility` enum — 0 Private · 1 Public (its Unlisted/Dev members exist but nothing sets one on a list). Carried by every list the read serves, stored or captured; absent from the canned bulk list and from the save’s response.'
		),
})

/** The SAVE's projection: every key of the read, in the read's order, minus `Accessibility`. */
export const CuratedListSaved = z.object(CuratedListFields)

/** `GET /curatedlists/bulk` — a list per id asked for; today one canned list, always. */
export const CuratedListsBulk = CuratedListRead.array()

/**
 * One entity of a row. `Id` is a STRING even though most of what a row names (rooms, store
 * items) is numbered, and `Context` is where the reference attributes the ranking or
 * experiment that produced the entity — nothing here produces one, so it is null on every
 * entity rather than a made-up context the client would carry into telemetry.
 */
export const ListEntityDto = z.object({
	Id: z.string().describe('The room/item id the client resolves itself'),
	Context: z.string().nullable().describe('Ranking attribution; always null here'),
})

/**
 * `GET /algorithmiclists/{list}` — one discovery row's contents. Only ids travel: the
 * client resolves each room or item against the `rooms`/`commerce` workers itself.
 */
export const AlgorithmicList = z.object({
	Type: z.int().describe('The `ListEntityType`, echoed from `?type=` — see the parameter'),
	Entities: ListEntityDto.array().describe('Empty for a row with nothing behind it'),
})

/**
 * `POST /contextualfeatures` — the bare acknowledgement, with no payload. The reference
 * server carries nothing back, so there is nothing here to serve beyond the ack itself.
 */
export const ContextualFeaturesAck = z.object({
	success: z.literal(true),
	error_id: z.null(),
	error: z.null(),
})

// ---- Request schemas -------------------------------------------------------

/**
 * The form-encoded save body the client sends (`accessibility=0&type=1`). Both fields are
 * also read off the query string: the same parameters ride the query everywhere else on
 * this worker, and a body that failed to parse would otherwise silently create a list with
 * the wrong type.
 */
export const SaveItemBody = z.object({
	type: z
		.string()
		.optional()
		.describe(
			'The `ListEntityType` the list is created with (integer, as text). Rooms (1) when absent — every list the client creates this way is a room list, and the type is part of the list’s identity, so another value would strand it where the client’s own `?type=1` read can’t find it.'
		),
	accessibility: z
		.string()
		.optional()
		.describe(
			'The `Accessibility` enum — 0 Private · 1 Public (integer, as text). PRIVATE when absent: a list a player builds for themselves is theirs to see, and the client sends `accessibility=0`. Applied only on creation — a later save leaves an existing list’s accessibility alone.'
		),
})
