import { SELF } from 'cloudflare:test'
import { expect, it } from 'vitest'

const ORIGIN = 'https://example.com'

it('response with hello world', async () => {
	const res = await SELF.fetch(ORIGIN)
	expect(res.status).toBe(200)
	expect(await res.text()).toMatchInlineSnapshot(`"hello, world!"`)
})

it('acknowledges a single event', async () => {
	const res = await SELF.fetch(`${ORIGIN}/data/event`, {
		method: 'POST',
		headers: { 'Content-Type': 'application/json' },
		body: JSON.stringify({ EventName: 'SessionStart', SessionId: crypto.randomUUID() }),
	})
	expect(res.status).toBe(200)
	expect(await res.json()).toEqual({})
})

// The batch path answers with an ARRAY, not the singular path's object — the client
// decodes the two differently, so this asserts the shape, not just the status.
it('acknowledges an event batch', async () => {
	const res = await SELF.fetch(`${ORIGIN}/data/events`, {
		method: 'POST',
		headers: { 'Content-Type': 'application/json' },
		body: JSON.stringify([
			{ EventName: 'SessionStart', SessionId: crypto.randomUUID() },
			{ EventName: 'RoomEntered', SessionId: crypto.randomUUID() },
		]),
	})
	expect(res.status).toBe(200)
	expect(await res.json()).toEqual([])
})

// The sink takes whatever the client sends — an unparseable body still has to succeed on
// either path, since the client treats a failed post as a reason to retry the batch.
it('acknowledges an unreadable body on both event paths', async () => {
	const single = await SELF.fetch(`${ORIGIN}/data/event`, { method: 'POST', body: 'not json' })
	expect(single.status).toBe(200)
	expect(await single.json()).toEqual({})

	const batch = await SELF.fetch(`${ORIGIN}/data/events`, { method: 'POST', body: 'not json' })
	expect(batch.status).toBe(200)
	expect(await batch.json()).toEqual([])
})

it('serves an empty sampling configuration', async () => {
	const res = await SELF.fetch(`${ORIGIN}/sampling?sessionId=e9a899ce-ce46-447d-bb22-11e82ed68f8d`)
	expect(res.status).toBe(200)
	expect(await res.json()).toEqual({})
})

// The client always sends `sessionId`, but nothing here reads it, so a missing one must
// not turn into a 400 the client would have to handle.
it('serves the sampling configuration without a sessionId', async () => {
	const res = await SELF.fetch(`${ORIGIN}/sampling`)
	expect(res.status).toBe(200)
	expect(await res.json()).toEqual({})
})
