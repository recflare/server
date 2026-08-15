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

	test('the path style puts every service on the base domain', async () => {
		const doc = buildEndpoints(TEST_DOMAIN, 'path')
		expect(doc.Rooms).toBe(`https://${TEST_DOMAIN}/rooms`)
		expect(doc.Matchmaking).toBe(`https://${TEST_DOMAIN}/match`)
		expect(doc.Images).toBe(`https://${TEST_DOMAIN}/img`)
		expect(Object.values(doc).every((url) => url.startsWith(`https://${TEST_DOMAIN}/`))).toBe(true)
	})

	test('the default style gives every service its own host', async () => {
		const doc = buildEndpoints(TEST_DOMAIN)
		expect(doc.Rooms).toBe(`https://rooms.${TEST_DOMAIN}`)
		expect(doc.Images).toBe(`https://img.${TEST_DOMAIN}`)
	})

	test('unknown path returns 404', async () => {
		const res = await exports.default.fetch(`${ORIGIN}/nope`)
		expect(res.status).toBe(404)
	})
})
