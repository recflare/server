import { cloudflareTest } from '@cloudflare/vitest-pool-workers'
import { defineConfig } from 'vitest/config'

export default defineConfig({
	plugins: [
		cloudflareTest({
			wrangler: { configPath: `${__dirname}/wrangler.jsonc` },
			miniflare: {
				bindings: {
					ENVIRONMENT: 'VITEST',
				},
				// The worker's RECFLARE_NOTIFICATIONS_HUB binding points at the `notify`
				// worker's DO (script_name: "notify"). That worker isn't part of this
				// isolated test, so provide a minimal stub exposing the same NotificationsHub
				// RPC surface — enough for the runtime to start and for notification sends to
				// no-op.
				//
				// The stub RECORDS what it was sent (`drainFrames`) rather than discarding it.
				// Pushes are best-effort and swallow their own errors, so a frame carrying the
				// wrong payload is otherwise invisible here — which is exactly how
				// StorefrontBalanceUpdate shipped with the resulting total in a field the
				// client adds to what it is already showing.
				workers: [
					{
						name: 'notify',
						modules: true,
						compatibilityDate: '2026-06-16',
						compatibilityFlags: ['nodejs_compat'],
						durableObjects: { RECFLARE_NOTIFICATIONS_HUB: 'NotificationsHub' },
						script: `
							import { DurableObject } from 'cloudflare:workers'
							export class NotificationsHub extends DurableObject {
								frames = []
								async notifyPlayer(accountId, notificationType, payload) {
									this.frames.push({ accountId, notificationType, payload })
									return { delivered: 0, queued: true }
								}
								async broadcast() { return { delivered: 0 } }
								/** Everything pushed since the last call, then forget it. */
								async drainFrames() {
									const drained = this.frames
									this.frames = []
									return drained
								}
							}
							export default { fetch() { return new Response('ok') } }
						`,
					},
				],
			},
		}),
	],
})
