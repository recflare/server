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
				// isolated test, so provide a minimal stub service exposing the same
				// NotificationsHub RPC surface — enough for the runtime to start and for
				// notification sends to no-op.
				workers: [
					{
						name: 'notify',
						modules: true,
						compatibilityDate: '2026-06-16',
						compatibilityFlags: ['nodejs_compat'],
						durableObjects: { RECFLARE_NOTIFICATIONS_HUB: 'NotificationsHub' },
						// notifyPlayer records every call so tests can assert the notifications the
						// worker pushed (type + payload). GET /all for the whole list, DELETE to
						// reset it between assertions.
						script: `
							import { DurableObject } from 'cloudflare:workers'
							export class NotificationsHub extends DurableObject {
								sent = []
								async notifyPlayer(playerId, notificationType, data) {
									this.sent.push({ playerId, notificationType, data })
									return { delivered: 0, queued: true }
								}
								async broadcast() { return { delivered: 0 } }
								async fetch(request) {
									if (request.method === 'DELETE') {
										this.sent = []
										return new Response(null, { status: 204 })
									}
									return Response.json(this.sent)
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
