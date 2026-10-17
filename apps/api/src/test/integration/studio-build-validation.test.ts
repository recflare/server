import { adminSecretsStore, env, SELF } from 'cloudflare:test'
import { beforeAll, expect, it } from 'vitest'

import { generateStudioBuildValidationToken, validateAndGetAccountId } from '@repo/jwt'

import type { Env } from '../../context'

declare module 'cloudflare:test' {
	interface ProvidedEnv extends Env {}
}
beforeAll(async () => {
	await adminSecretsStore(env.JWT_SECRET).create('test-key')
})
it('allows build validation credentials to check text without granting an account identity', async () => {
	const token = await generateStudioBuildValidationToken('123456', 'test-key')
	const headers = { Authorization: 'Bearer ' + token }
	expect(
		await validateAndGetAccountId(new Request('https://example.com', { headers }), 'test-key')
	).toBeNull()
	const response = await SELF.fetch('https://example.com/api/sanitize/v2/isAllowed/bulk', {
		method: 'POST',
		headers,
		body: new URLSearchParams('Values=hello&Values=fuck'),
	})
	expect(response.status).toBe(200)
	expect(await response.json()).toEqual({
		Success: true,
		Error: null,
		Value: { ArePure: [true, false] },
	})
	expect(
		(
			await SELF.fetch('https://example.com/api/PlayerCheer/v1/create', {
				method: 'POST',
				headers,
				body: new URLSearchParams(),
			})
		).status
	).toBe(401)
})
it('rejects an invalid build validation signature', async () => {
	const token = await generateStudioBuildValidationToken('123456', 'wrong-key')
	expect(
		(
			await SELF.fetch('https://example.com/api/sanitize/v2/isAllowed/bulk', {
				method: 'POST',
				headers: { Authorization: 'Bearer ' + token },
				body: new URLSearchParams('Values=hello'),
			})
		).status
	).toBe(401)
})
