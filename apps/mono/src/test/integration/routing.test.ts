import { exports } from 'cloudflare:workers'
import { describe, expect, test } from 'vitest'

import type { Env } from '../../context'

declare module 'cloudflare:test' {
	interface ProvidedEnv extends Env {}
}

const ORIGIN = 'https://example.com'

// Must match the DOMAIN var default in apps/mono/wrangler.jsonc.
const TEST_DOMAIN = 'rec.example.com'

// The facade's job is routing, not business logic, so one request that reaches a
// mounted app through the path prefix is enough to prove the wiring. `api` serves a
// static game-config with no auth/DB, so it's a clean target. The api worker namespaces
// its own routes under `/api`, hence the `/api` prefix (service) + `/api/...` (real path).
describe('mono routing', () => {
	test('path prefix routes to the api worker (gameconfigs)', async () => {
		const res = await exports.default.fetch(`${ORIGIN}/api/api/gameconfigs/v1/all`)
		expect(res.status).toBe(200)
		// Reached the api app's real handler, not the facade's 404.
		expect(res.headers.get('content-type')).toContain('application/json')
	})

	test('root path (no service, no prefix) serves the ns discovery document', async () => {
		const res = await exports.default.fetch(`${ORIGIN}/`)
		expect(res.status).toBe(200)
		// The ns worker serves the service-discovery document. This worker is one host, so
		// every service in it is a path on the base domain (the DOMAIN var default in
		// wrangler.jsonc) — no per-service subdomains anywhere in the document.
		const doc = (await res.json()) as Record<string, string>
		expect(doc).toMatchObject({
			Auth: `https://${TEST_DOMAIN}/auth`,
			Rooms: `https://${TEST_DOMAIN}/rooms`,
			Matchmaking: `https://${TEST_DOMAIN}/match`,
		})
		expect(Object.values(doc).every((url) => url.startsWith(`https://${TEST_DOMAIN}/`))).toBe(true)
	})

	test('the ns service prefix serves that same document', async () => {
		const res = await exports.default.fetch(`${ORIGIN}/ns/`)
		expect(res.status).toBe(200)
		expect(await res.json()).toMatchObject({ Rooms: `https://${TEST_DOMAIN}/rooms` })
	})

	test('unknown service prefix returns the facade 404', async () => {
		const res = await exports.default.fetch(`${ORIGIN}/nope/whatever`)
		expect(res.status).toBe(404)
		expect(await res.json()).toMatchObject({ error: 'unknown_service' })
	})
})
