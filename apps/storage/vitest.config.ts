import { cloudflareTest } from '@cloudflare/vitest-pool-workers'
import { defineConfig } from 'vitest/config'

export default defineConfig({
	plugins: [
		cloudflareTest({
			wrangler: { configPath: `${__dirname}/wrangler.jsonc` },
			miniflare: {
				bindings: {
					ENVIRONMENT: 'VITEST',
					// Opens the developer video upload's account half; the S3 token halves come from
					// the Secrets Store and are seeded (or deliberately not) by the tests.
					R2_ACCOUNT_ID: 'test-account',
				},
			},
		}),
	],
})
