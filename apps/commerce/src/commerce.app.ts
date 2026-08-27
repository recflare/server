import { Hono } from 'hono'
import { describeRoute, openAPIRouteHandler } from 'hono-openapi'
import { useWorkersLogger } from 'workers-tagged-logger'

import { withCleanSpec, withNotFound, withOnError } from '@repo/hono-helpers'

import catalog from '../static/catalog-v1-all.json'
import {
	BareBoolean,
	boolQuery,
	CatalogSku,
	HealthResponse,
	InitiatePurchaseRequest,
	InitiatePurchaseResponse,
	json,
	JsonArray,
	jsonBody,
} from './openapi'

import type { App } from './context'

/**
 * Commerce routes. The `commerce` prefix maps to this worker's subdomain, so
 * method routes are served bare.
 */

/**
 * The transaction id every purchase initiation answers with. Real money never changes
 * hands here and nothing is persisted, so the client only needs a well-formed handle to
 * carry through the rest of its store flow.
 */
const PLACEHOLDER_TRANSACTION_ID = 1234567890

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

	.get(
		'/',
		describeRoute({
			tags: ['Service'],
			summary: 'Health check',
			description: 'Liveness probe for the commerce worker. No auth.',
			responses: { 200: json(HealthResponse, 'Service is up') },
		}),
		(c) => c.json({ service: 'commerce', status: 'ok' })
	)

	// Whether the player has ever spent money. A 404 here makes the client treat
	// it as an error, so we return `false` (no purchases).
	.get(
		'/purchase/v1/hasspentmoney',
		describeRoute({
			tags: ['Purchase'],
			summary: 'Whether the player has ever spent money',
			description: [
				'Always `false` — nobody buys anything on this server. A 404 here makes the client',
				'treat the call as an error, so the answer is the bare boolean rather than nothing.',
			].join(' '),
			responses: { 200: json(BareBoolean, 'Always false (no purchases)') },
		}),
		(c) => c.json(false)
	)

	// Begin a purchase. The client asks for a transaction handle before it takes the
	// player to the platform store; nothing is charged or recorded here, so the id is a
	// fixed placeholder and the posted body is ignored.
	.post(
		'/purchase/v1/initiatepurchase',
		describeRoute({
			tags: ['Purchase'],
			summary: 'Begin a purchase',
			description: [
				'Hands the client the transaction handle it carries through the rest of the store',
				'flow. Nothing is charged and no transaction is recorded, so the id is a fixed',
				'placeholder and the posted body is accepted and ignored — an absent or unparseable',
				'body is a 200, not a 400.',
			].join(' '),
			requestBody: jsonBody(InitiatePurchaseRequest, 'The purchase the player confirmed'),
			responses: { 200: json(InitiatePurchaseResponse, 'The (placeholder) transaction id') },
		}),
		(c) => c.json({ transactionId: PLACEHOLDER_TRANSACTION_ID })
	)

	// The purchasable SKU catalog (token packs, special offers), served from the
	// bundled static JSON. The client passes `?onlyAvailableSkus=true`; the bundled
	// catalog is already only the available SKUs, so the param doesn't change the
	// response.
	.get(
		'/api/catalog/v1/all',
		describeRoute({
			tags: ['Catalog'],
			summary: 'The purchasable SKU catalog',
			description: [
				'The token packs, bundles and special offers the store shows, served from the bundled',
				'static catalog. The client’s `onlyAvailableSkus` is accepted and ignored: the bundled',
				'catalog already contains only available SKUs.',
			].join(' '),
			parameters: [
				boolQuery('onlyAvailableSkus', 'Accepted and ignored — the catalog is already filtered'),
			],
			responses: { 200: json(CatalogSku.array(), 'Every available SKU') },
		}),
		(c) => c.json(catalog)
	)

	// Pending purchases the client asks the server to reconcile — platform transactions
	// it started but never saw finish. Nothing is ever recorded here, so there is never
	// anything pending and the answer is always an empty list. Accepts GET or POST since
	// the client may use either.
	.on(
		['GET', 'POST'],
		'/purchase/v1/cleanuppending',
		describeRoute({
			tags: ['Purchase'],
			summary: 'Reconcile pending purchases (no-op)',
			description: [
				'Always `[]` — no purchase is ever recorded, so nothing can be left pending. A 404',
				'here makes the client treat the call as an error, so the empty list is served',
				'instead. Accepts GET or POST.',
			].join(' '),
			responses: { 200: json(JsonArray, 'Always empty (nothing pending)') },
		}),
		(c) => c.json([])
	)

	// Current purchase campaigns (limited-time offers/promos). None exist, and
	// an empty list is the client's "no active campaigns" state.
	.get(
		'/purchasecampaign/allcurrent/v2',
		describeRoute({
			tags: ['Purchase'],
			summary: 'Current purchase campaigns',
			description: [
				'Limited-time offers and promos. Always `[]` — none exist, and an empty list is the',
				'client’s “no active campaigns” state.',
			].join(' '),
			responses: { 200: json(JsonArray, 'Always empty (no active campaigns)') },
		}),
		(c) => c.json([])
	)

	// Token-bundle purchase reminders (the "buy more tokens" nudge). None to show,
	// and an empty list is the client's "no reminders" state.
	.get(
		'/reminder/currentTokenBundles/v2',
		describeRoute({
			tags: ['Purchase'],
			summary: 'Token-bundle purchase reminders',
			description: [
				'The “buy more tokens” nudges. Always `[]` — there are none to show, and an empty list',
				'is the client’s “no reminders” state.',
			].join(' '),
			responses: { 200: json(JsonArray, 'Always empty (no reminders)') },
		}),
		(c) => c.json([])
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
					title: 'recflare commerce',
					version: '1.0.0',
					description: [
						'The store surface for recflare, a private-server reimplementation of the Rec Room',
						'backend: the SKU catalog the client shows and the purchase calls it makes around it.',
						'',
						'No money moves here. There is no store integration and no purchase storage, so the',
						'catalog is a bundled static asset, the campaign and reminder feeds are empty, and a',
						'purchase initiation answers with a placeholder transaction id.',
					].join('\n'),
				},
				servers: [{ url: 'https://commerce.recflare.net', description: 'Production' }],
			},
		})
	)
)

export default app
