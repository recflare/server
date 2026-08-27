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
						// worker pushed (type + payload). GET the DO for the most recent one,
						// GET /all for the whole list (friend-graph changes notify both players),
						// DELETE to reset it between assertions.
						//
						// notifyPlayersEphemeral lands in the same list, tagged `ephemeral` and
						// carrying `playerIds` rather than `playerId` — the two sends differ in
						// whether an offline recipient gets the frame later, which is a thing worth
						// asserting (a cheer's effect is broadcast to a room this way).
						script: `
							import { DurableObject } from 'cloudflare:workers'
							export class NotificationsHub extends DurableObject {
								sent = []
								async notifyPlayer(playerId, notificationType, data) {
									this.sent.push({ playerId, notificationType, data })
									return { delivered: 0, queued: true }
								}
								async notifyPlayersEphemeral(playerIds, notificationType, data) {
									this.sent.push({ playerIds, ephemeral: true, notificationType, data })
									return { delivered: 0 }
								}
								async broadcast() { return { delivered: 0 } }
								async fetch(request) {
									if (request.method === 'DELETE') {
										this.sent = []
										return new Response(null, { status: 204 })
									}
									if (new URL(request.url).pathname === '/all') return Response.json(this.sent)
									return Response.json(this.sent.at(-1) ?? null)
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
