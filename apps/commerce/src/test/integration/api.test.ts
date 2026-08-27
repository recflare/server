import { SELF } from 'cloudflare:test'
import { describe, expect, it } from 'vitest'

import '../../commerce.app'

const ORIGIN = 'https://example.com'

describe('commerce endpoints', () => {
	it('GET / reports service status', async () => {
		const res = await SELF.fetch(`${ORIGIN}/`)
		expect(res.status).toBe(200)
		expect(await res.json()).toEqual({ service: 'commerce', status: 'ok' })
	})

	it('GET /purchase/v1/hasspentmoney returns false', async () => {
		const res = await SELF.fetch(`${ORIGIN}/purchase/v1/hasspentmoney`)
		expect(res.status).toBe(200)
		expect(await res.json()).toBe(false)
	})

	it('POST /purchase/v1/initiatepurchase returns a transaction id', async () => {
		const res = await SELF.fetch(`${ORIGIN}/purchase/v1/initiatepurchase`, {
			method: 'POST',
			headers: { 'content-type': 'application/json' },
			body: JSON.stringify({ skuId: 178, platform: 'Standalone' }),
		})
		expect(res.status).toBe(200)
		expect(await res.json()).toEqual({ transactionId: 1234567890 })
	})

	it('POST /purchase/v1/initiatepurchase ignores the body entirely', async () => {
		const res = await SELF.fetch(`${ORIGIN}/purchase/v1/initiatepurchase`, { method: 'POST' })
		expect(res.status).toBe(200)
		expect(await res.json()).toEqual({ transactionId: 1234567890 })
	})

	it('GET /api/catalog/v1/all serves the SKU catalog', async () => {
		const res = await SELF.fetch(`${ORIGIN}/api/catalog/v1/all?onlyAvailableSkus=true`)
		expect(res.status).toBe(200)
		const skus = (await res.json()) as Array<{ skuId: number }>
		expect(Array.isArray(skus)).toBe(true)
		expect(skus.length).toBeGreaterThan(0)
		expect(skus[0]).toHaveProperty('skuId')
	})

	it('GET|POST /purchase/v1/cleanuppending returns []', async () => {
		for (const method of ['GET', 'POST']) {
			const res = await SELF.fetch(`${ORIGIN}/purchase/v1/cleanuppending`, { method })
			expect(res.status).toBe(200)
			expect(await res.json()).toEqual([])
		}
	})

	it('GET /purchasecampaign/allcurrent/v2 returns []', async () => {
		const res = await SELF.fetch(`${ORIGIN}/purchasecampaign/allcurrent/v2`)
		expect(res.status).toBe(200)
		expect(await res.json()).toEqual([])
	})

	it('GET /reminder/currentTokenBundles/v2 returns []', async () => {
		const res = await SELF.fetch(`${ORIGIN}/reminder/currentTokenBundles/v2`)
		expect(res.status).toBe(200)
		expect(await res.json()).toEqual([])
	})

	it('GET /openapi.json documents every route', async () => {
		const res = await SELF.fetch(`${ORIGIN}/openapi.json`)
		expect(res.status).toBe(200)
		const spec = (await res.json()) as {
			openapi: string
			paths: Record<string, Record<string, { summary?: string }>>
		}
		expect(spec.openapi).toMatch(/^3\.1/)

		// The spec route hides itself.
		expect(spec.paths['/openapi.json']).toBeUndefined()

		// Every route the worker serves is described. This is the drift guard: adding a
		// route without a describeRoute() block fails here rather than silently shipping
		// an incomplete spec.
		const documented = new Set(
			Object.entries(spec.paths).flatMap(([path, ops]) =>
				Object.keys(ops).map((method) => `${method.toUpperCase()} ${path}`)
			)
		)
		expect([...documented].sort()).toEqual([
			'GET /',
			'GET /api/catalog/v1/all',
			'GET /purchase/v1/cleanuppending',
			'GET /purchase/v1/hasspentmoney',
			'GET /purchasecampaign/allcurrent/v2',
			'GET /reminder/currentTokenBundles/v2',
			'POST /purchase/v1/cleanuppending',
			'POST /purchase/v1/initiatepurchase',
		])

		// Every operation carries a summary — a path present but undescribed is not
		// documentation.
		for (const ops of Object.values(spec.paths)) {
			for (const op of Object.values(ops)) expect(op.summary).toBeTruthy()
		}

		// Schemas are inlined rather than $ref'd into components: a `.meta({ id })`'d
		// schema used in a response emits a $ref this hono-openapi + zod v4 setup does
		// not always hoist, leaving a dangling reference.
		expect(JSON.stringify(spec).includes('"$ref"')).toBe(false)
	})
})
