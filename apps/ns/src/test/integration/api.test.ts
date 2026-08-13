import { exports } from 'cloudflare:workers'
import { describe, expect, test } from 'vitest'

import '../../ns.app'

import { buildEndpoints } from '../../endpoints'

const ORIGIN = 'https://example.com'

// Must match the DOMAIN var default in apps/ns/wrangler.jsonc.
const TEST_DOMAIN = 'rec.example.com'

describe('ns endpoints', () => {
	test('GET / returns the endpoints document', async () => {
		const res = await exports.default.fetch(`${ORIGIN}/`)
		expect(res.status).toBe(200)
		const body = await res.json()
		expect(body).toEqual(buildEndpoints(TEST_DOMAIN))
	})

	test('a subdomain override redirects that service only', () => {
		const endpoints = buildEndpoints(TEST_DOMAIN, '{"moderation":"api"}')
		expect(endpoints.Moderation).toBe(`https://api.${TEST_DOMAIN}`)
		expect(endpoints.API).toBe(`https://api.${TEST_DOMAIN}`)
		expect(endpoints.Accounts).toBe(`https://accounts.${TEST_DOMAIN}`)
	})

	test('a malformed override object is ignored', () => {
		for (const bad of ['', '{', 'null', '[]', '{"moderation":42}', '{"moderation":""}']) {
			expect(buildEndpoints(TEST_DOMAIN, bad)).toEqual(buildEndpoints(TEST_DOMAIN))
		}
	})

	test('unknown path returns 404', async () => {
		const res = await exports.default.fetch(`${ORIGIN}/nope`)
		expect(res.status).toBe(404)
	})
})
