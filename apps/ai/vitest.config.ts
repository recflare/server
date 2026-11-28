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
				// OpenAI, stubbed: `POST /v1/realtime/client_secrets` answers by the key it was
				// called with, so a test picks the outcome by the key it saves. `GET /__last`
				// returns the last request the stub saw (to check what was sent), `DELETE /__last`
				// forgets it. The 401 quotes part of the key the way OpenAI's real error does, so
				// a test can prove that text never reaches a response.
				serviceBindings: { OPENAI: 'openai' },
				workers: [
					{
						name: 'openai',
						modules: true,
						compatibilityDate: '2026-06-16',
						script: `
							let last = null
							export default {
								async fetch(request) {
									const url = new URL(request.url)
									if (url.pathname === '/__last') {
										if (request.method === 'DELETE') { last = null; return new Response(null, { status: 204 }) }
										return Response.json(last)
									}
									const auth = request.headers.get('authorization') ?? ''
									const body = await request.text()
									last = { method: request.method, url: request.url, authorization: auth, body }
									if (url.pathname !== '/v1/realtime/client_secrets') return new Response('not found', { status: 404 })
									const key = auth.replace(/^Bearer /, '')
									if (key.startsWith('sk-test-revoked')) {
										return Response.json({ error: { message: 'Incorrect API key provided: ' + key.slice(0, 12) + '****' } }, { status: 401 })
									}
									if (key.startsWith('sk-test-norealtime')) return Response.json({ error: { message: 'Missing scopes' } }, { status: 403 })
									if (key.startsWith('sk-test-flaky')) return new Response('upstream error', { status: 500 })
									return Response.json({
										value: 'ek_test_ephemeral_secret',
										expires_at: Math.floor(Date.now() / 1000) + 600,
										session: { id: 'sess_test_123', type: 'realtime', model: JSON.parse(body).session.model },
									})
								},
							}
						`,
					},
				],
			},
		}),
	],
})
