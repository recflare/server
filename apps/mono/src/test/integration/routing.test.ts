import { adminSecretsStore, env } from 'cloudflare:test'
import { exports } from 'cloudflare:workers'
import { beforeAll, describe, expect, test } from 'vitest'

import type { Env } from '../../context'

declare module 'cloudflare:test' {
	interface ProvidedEnv extends Env {}
}

const ORIGIN = 'https://example.com'

// The facade's job is routing, not business logic, so one request that reaches a
// mounted app through the path prefix is enough to prove the wiring. `api` serves a
// static game-config with no DB behind it, so it's a clean target. The api worker namespaces
// its own routes under `/api`, hence the `/api` prefix (service) + `/api/...` (real path).
describe('mono routing', () => {
	// `gameconfigs` reads the token's build claim to pick which catalog to serve, so it
	// resolves JWT_SECRET even for an unauthenticated request. Seed the key into the local
	// Secrets Store or the handler throws before the routing assertion can run.
	beforeAll(async () => {
		await adminSecretsStore(env.JWT_SECRET).create('test-signing-key')
	})

	test('path prefix routes to the api worker (gameconfigs)', async () => {
		const res = await exports.default.fetch(`${ORIGIN}/api/api/gameconfigs/v1/all`)
		expect(res.status).toBe(200)
		// Reached the api app's real handler, not the facade's 404.
		expect(res.headers.get('content-type')).toContain('application/json')
	})

	test('root path (no service, no prefix) serves the ns discovery document', async () => {
		const res = await exports.default.fetch(`${ORIGIN}/`)
		expect(res.status).toBe(200)
		// The ns worker serves the service-discovery document.
		expect(await res.json()).toHaveProperty('Auth')
	})

	test('unknown service prefix returns the facade 404', async () => {
		const res = await exports.default.fetch(`${ORIGIN}/nope/whatever`)
		expect(res.status).toBe(404)
		expect(await res.json()).toMatchObject({ error: 'unknown_service' })
	})
})
