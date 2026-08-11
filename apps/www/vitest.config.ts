import { cloudflareTest } from '@cloudflare/vitest-pool-workers'
import { defineConfig } from 'vitest/config'

export default defineConfig({
	plugins: [
		cloudflareTest({
			wrangler: { configPath: `${__dirname}/wrangler.jsonc` },
			miniflare: {
				// Stands in for the `auth` service binding wrangler.jsonc declares — the real
				// worker isn't part of this project's test run, and without an override the
				// runtime refuses to start ("no such service is defined"). It echoes the
				// forwarded `cf-connecting-ip` back so a test can assert the browser's IP
				// actually survives the hop (see src/upstream.ts `postAuthForm`); every other
				// auth call in the tests fails before reaching it.
				serviceBindings: {
					AUTH: (request: Request) =>
						new Response(
							JSON.stringify({
								error: 'invalid_grant',
								error_description: request.headers.get('cf-connecting-ip') ?? 'no ip',
							}),
							{ status: 400, headers: { 'content-type': 'application/json' } }
						),
				},
				bindings: {
					ENVIRONMENT: 'VITEST',
					// The Turnstile keypair is NOT bound here: both keys come from the Secrets
					// Store now, and the tests seed the local store with the test pair (see
					// src/test/integration/api.test.ts). A plain binding of the same name would
					// shadow the store binding with a string.
				},
			},
		}),
	],
})
