import { cloudflareTest } from '@cloudflare/vitest-pool-workers'
import { defineConfig } from 'vitest/config'

export default defineConfig({
	plugins: [
		cloudflareTest({
			wrangler: { configPath: `${__dirname}/wrangler.jsonc` },
			miniflare: {
				bindings: {
					ENVIRONMENT: 'VITEST',
					// Signing is off in `wrangler.jsonc`; turn it on here so the `?sig=p1`
					// path stays covered. The flag-off behaviour is tested by calling the
					// app directly with an overridden env.
					IMG_SIGNING_ENABLED: true,
				},
			},
		}),
	],
})
