import { cloudflareTest } from '@cloudflare/vitest-pool-workers'
import { defineConfig } from 'vitest/config'

export default defineConfig({
	test: {
		// The facade bundles all 13 worker apps (see mono.app.ts), so the first request in
		// a run pays a cold start for the lot of it — ~3.4s even on an idle machine. The
		// 5s default leaves no headroom for that, and the whole-monorepo run puts 21
		// projects on the CPU at once, which pushed these tests into flaky timeouts.
		testTimeout: 30_000,
	},
	plugins: [
		cloudflareTest({
			wrangler: { configPath: `${__dirname}/wrangler.jsonc` },
			miniflare: {
				bindings: {
					ENVIRONMENT: 'VITEST',
				},
			},
		}),
	],
})
