import { resolver } from 'hono-openapi'
import { z } from 'zod'

import type { OpenAPIV3_1 } from 'openapi-types'

/**
 * OpenAPI schemas for the commerce worker.
 *
 * IMPORTANT: these are DESCRIPTIVE ONLY. They are passed to `describeRoute` to
 * generate the spec and are never wired into `hono-openapi`'s `validator()`. Same
 * rationale as the auth/accounts/econ/match/playersettings workers: a reverse-engineered
 * protocol, lenient handlers, no runtime validation.
 *
 * Do NOT add `.meta({ id })` to these schemas — with this hono-openapi + zod v4 setup a
 * meta'd schema used in a response emits a `$ref` the framework doesn't always hoist
 * into `components.schemas`, leaving a dangling reference. Leaving meta off makes every
 * schema inline, which renders correctly in any tool.
 */

/** Emit a zod schema as an `application/json` response body. */
export function json(schema: z.ZodType, description: string) {
	return { description, content: { 'application/json': { schema: resolver(schema) } } }
}

function toOpenApiSchema(schema: z.ZodType): OpenAPIV3_1.SchemaObject {
	const { $schema: _$schema, additionalProperties: _extra, ...jsonSchema } = z.toJSONSchema(schema)
	return jsonSchema as OpenAPIV3_1.SchemaObject
}

/** An `application/json` request body. */
export function jsonBody(schema: z.ZodType, description: string): OpenAPIV3_1.RequestBodyObject {
	return { description, content: { 'application/json': { schema: toOpenApiSchema(schema) } } }
}

/** An optional boolean query parameter. */
export function boolQuery(name: string, description: string): OpenAPIV3_1.ParameterObject {
	return { name, in: 'query', required: false, description, schema: { type: 'boolean' } }
}

// ---- Loose shapes ----------------------------------------------------------

/** An opaque JSON object — a body whose fields haven't been reversed yet. */
export const JsonObject = z.record(z.string(), z.unknown())
/** An opaque JSON array (an empty-list stub). */
export const JsonArray = z.array(z.unknown())

/** A bare JSON boolean — `hasspentmoney` answers `false` with no envelope. */
export const BareBoolean = z.boolean()

// ---- Service ---------------------------------------------------------------

/** `GET /` — the root health check. */
export const HealthResponse = z.object({
	service: z.literal('commerce'),
	status: z.literal('ok'),
})

// ---- Catalog ---------------------------------------------------------------

/**
 * The per-SKU `data` blob. `giftDropIds` are the drops granted when the SKU is redeemed
 * (empty for the bundles, which grant their contents directly); `message` is the label the
 * store shows on the purchase.
 */
export const CatalogSkuData = z.object({
	giftDropIds: z.array(z.int()),
	message: z.string(),
	subscriptionPurchase: z
		.unknown()
		.optional()
		.describe('Present only on the subscription SKU; its shape is not reversed yet'),
})

/**
 * One purchasable SKU from `GET /api/catalog/v1/all` — a token pack, a bundle or a
 * special offer. `price` is in cents on the store the client is running against, and the
 * per-store id fields are only present where that SKU ships on that store, so all of them
 * are optional except the Oculus/Apple/Google ids the reference catalog always carries.
 */
export const CatalogSku = z.object({
	skuId: z.int(),
	name: z.string(),
	description: z.string().describe('Often an empty string for token packs'),
	imageName: z.string().describe('The store tile image; the img worker serves it by name'),
	price: z.int().describe('Store price in cents, e.g. 99 = $0.99'),
	oculusSkuId: z.string(),
	appleProductId: z.string(),
	googlePlaySkuId: z.string(),
	picoSkuId: z.string().optional(),
	xboxProductId: z.string().optional(),
	xboxStoreId: z.string().optional(),
	psnProductLabel: z.string().optional(),
	psnEntitlementLabel: z.string().optional(),
	nintendoSkuId: z.string().optional(),
	isSingleUse: z.boolean(),
	shouldAppearInTokenStore: z.boolean(),
	dataSchemaVersion: z.int(),
	data: CatalogSkuData,
})

// ---- Purchase --------------------------------------------------------------

/**
 * `POST /purchase/v1/initiatepurchase` body — what the client sends when the player
 * confirms a purchase (the SKU and the store it is being bought on). Accepted and
 * ignored: the field names have not been reversed yet, and nothing here talks to a store.
 */
export const InitiatePurchaseRequest = JsonObject.describe(
	'The client’s purchase-initiation payload; accepted and ignored'
)

/**
 * `POST /purchase/v1/initiatepurchase` — the handle the client carries through the rest
 * of the store flow. Nothing is persisted, so this is a fixed placeholder id.
 */
export const InitiatePurchaseResponse = z.object({
	transactionId: z.int().describe('Placeholder — no transaction is recorded'),
})
