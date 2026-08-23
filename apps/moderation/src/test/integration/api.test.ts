import { SELF } from 'cloudflare:test'
import { expect, it } from 'vitest'

it('response with hello world', async () => {
	const res = await SELF.fetch('https://example.com')
	expect(res.status).toBe(200)
	expect(await res.text()).toMatchInlineSnapshot(`"hello, world!"`)
})

it('serves empty voice moderation credentials', async () => {
	const res = await SELF.fetch('https://example.com/voice/config')
	expect(res.status).toBe(200)
	expect(await res.json()).toEqual({ AccountId: '', ApiKey: '' })
})
