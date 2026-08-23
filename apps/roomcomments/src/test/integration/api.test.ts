import { adminSecretsStore, env, SELF } from 'cloudflare:test'
import { beforeAll, beforeEach, expect, it } from 'vitest'

import { ROOM_COMMENT_SCHEMA_DDL } from '@repo/domain'

import type { Env } from '../../context'

declare module 'cloudflare:test' {
	interface ProvidedEnv extends Env {}
}

const ORIGIN = 'https://example.com'

beforeAll(async () => {
	// Seed the shared JWT signing key into the local Secrets Store so .get() resolves.
	await adminSecretsStore(env.JWT_SECRET).create('test-signing-key')

	for (const stmt of ROOM_COMMENT_SCHEMA_DDL) await env.DB.prepare(stmt).run()
})

beforeEach(async () => {
	// Ids are the read cursor, so each test starts from a clean, predictable sequence.
	await env.DB.prepare('DELETE FROM room_comment').run()
	await env.DB.prepare(`DELETE FROM sqlite_sequence WHERE name = 'room_comment'`).run()
})

// Mint a token the way the `auth` worker does, signing with the shared test key seeded
// into the JWT_SECRET store.
const TEST_SECRET = 'test-signing-key'

function b64url(input: ArrayBuffer | string): string {
	const bytes = typeof input === 'string' ? new TextEncoder().encode(input) : new Uint8Array(input)
	let binary = ''
	for (const byte of bytes) binary += String.fromCharCode(byte)
	return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

async function bearer(sub = '205'): Promise<Record<string, string>> {
	const now = Math.floor(Date.now() / 1000)
	const signingInput = `${b64url(JSON.stringify({ alg: 'HS256', typ: 'JWT' }))}.${b64url(
		JSON.stringify({ sub, exp: now + 3600 })
	)}`
	const key = await crypto.subtle.importKey(
		'raw',
		new TextEncoder().encode(TEST_SECRET),
		{ name: 'HMAC', hash: 'SHA-256' },
		false,
		['sign']
	)
	const sig = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(signingInput))
	return { Authorization: `Bearer ${signingInput}.${b64url(sig)}` }
}

/** Post a comment the way the client does — form-encoded, positions as float text. */
async function postComment(
	roomId: number,
	fields: Record<string, string>,
	sub = '205'
): Promise<Response> {
	return SELF.fetch(`${ORIGIN}/comments/create/${roomId}`, {
		method: 'POST',
		headers: {
			...(await bearer(sub)),
			'content-type': 'application/x-www-form-urlencoded',
		},
		body: new URLSearchParams(fields).toString(),
	})
}

it('answers the health check', async () => {
	const res = await SELF.fetch(ORIGIN)
	expect(res.status).toBe(200)
	expect(await res.json()).toEqual({ service: 'roomcomments', status: 'ok' })
})

it('creates a comment and answers it as the client reads it', async () => {
	const res = await postComment(1162, {
		message: 'nice room',
		subRoomId: '1296',
		style: '0',
		positionX: '1.5',
		positionY: '0.0',
		positionZ: '-3.25',
	})
	expect(res.status).toBe(200)

	const comment = (await res.json()) as Record<string, unknown>
	expect(comment).toEqual({
		CommentId: 1,
		RoomId: 1162,
		SubRoomId: 1296,
		AccountId: 205,
		CreatedAt: expect.stringMatching(/^\d{4}-\d{2}-\d{2}T/),
		Message: 'nice room',
		Style: 0,
		// True even here, on the author's own brand-new comment — it is read state, and
		// nothing marks a comment read.
		Unread: true,
		PositionX: 1.5,
		PositionY: 0,
		PositionZ: -3.25,
	})
})

it('round-trips a C# float’s text as a number', async () => {
	// The digits the client actually posts: a float's shortest round-trip form. They go into
	// a REAL column and have to come back out identical, and as numbers — a quoted float
	// fails the client's parser.
	const res = await postComment(1162, {
		message: 'over here',
		subRoomId: '1307',
		style: '0',
		positionX: '-0.4979804',
		positionY: '1.568297',
		positionZ: '-0.05002981',
	})
	const comment = (await res.json()) as Record<string, unknown>
	expect(comment.PositionX).toBe(-0.4979804)
	expect(comment.PositionY).toBe(1.568297)
	expect(comment.PositionZ).toBe(-0.05002981)
})

it('serves a room’s comments newest first', async () => {
	await postComment(1162, { message: 'first', subRoomId: '1296' })
	await postComment(1162, { message: 'second', subRoomId: '1296' })
	// A different room's comments never bleed into this one.
	await postComment(99, { message: 'elsewhere', subRoomId: '1' })

	const res = await SELF.fetch(`${ORIGIN}/comments/get/1162?count=100&minId=-1`)
	expect(res.status).toBe(200)
	const comments = (await res.json()) as Array<Record<string, unknown>>
	expect(comments.map((x) => x.Message)).toEqual(['second', 'first'])
	expect(comments.map((x) => x.CommentId)).toEqual([2, 1])
})

it('treats minId as an exclusive cursor', async () => {
	await postComment(1162, { message: 'first', subRoomId: '1296' })
	await postComment(1162, { message: 'second', subRoomId: '1296' })
	await postComment(1162, { message: 'third', subRoomId: '1296' })

	// A client holding up to id 1 polls for what was written since — not id 1 again.
	const res = await SELF.fetch(`${ORIGIN}/comments/get/1162?count=100&minId=1`)
	const comments = (await res.json()) as Array<Record<string, unknown>>
	expect(comments.map((x) => x.CommentId)).toEqual([3, 2])
})

it('caps the page at count, keeping the newest', async () => {
	for (const message of ['a', 'b', 'c']) {
		await postComment(1162, { message, subRoomId: '1296' })
	}

	const res = await SELF.fetch(`${ORIGIN}/comments/get/1162?count=2&minId=-1`)
	const comments = (await res.json()) as Array<Record<string, unknown>>
	expect(comments.map((x) => x.Message)).toEqual(['c', 'b'])
})

it('narrows to one subroom when asked', async () => {
	await postComment(1162, { message: 'in 1296', subRoomId: '1296' })
	await postComment(1162, { message: 'in 1307', subRoomId: '1307' })

	const res = await SELF.fetch(`${ORIGIN}/comments/get/1162?subRoomId=1307`)
	const comments = (await res.json()) as Array<Record<string, unknown>>
	expect(comments.map((x) => x.Message)).toEqual(['in 1307'])
})

it('marks every comment unread, the reader’s own included', async () => {
	await postComment(1162, { message: 'mine', subRoomId: '1296' }, '205')
	await postComment(1162, { message: 'theirs', subRoomId: '1296' }, '999')

	const res = await SELF.fetch(`${ORIGIN}/comments/get/1162`, { headers: await bearer('205') })
	const comments = (await res.json()) as Array<Record<string, unknown>>
	expect(comments.map((x) => [x.Message, x.Unread])).toEqual([
		['theirs', true],
		['mine', true],
	])
})

it('serves the read without a token at all', async () => {
	await postComment(1162, { message: 'mine', subRoomId: '1296' }, '205')

	const res = await SELF.fetch(`${ORIGIN}/comments/get/1162`)
	expect(res.status).toBe(200)
	const comments = (await res.json()) as Array<Record<string, unknown>>
	expect(comments.map((x) => x.Unread)).toEqual([true])
})

it('has no comments for an unknown room — not a 404', async () => {
	const res = await SELF.fetch(`${ORIGIN}/comments/get/424242?count=100&minId=-1`)
	expect(res.status).toBe(200)
	expect(await res.json()).toEqual([])
})

it('refuses an unauthenticated create', async () => {
	const res = await SELF.fetch(`${ORIGIN}/comments/create/1162`, {
		method: 'POST',
		headers: { 'content-type': 'application/x-www-form-urlencoded' },
		body: new URLSearchParams({ message: 'hi', subRoomId: '1296' }).toString(),
	})
	expect(res.status).toBe(401)
	expect(await res.text()).toBe('')
})

it('refuses a blank message or a missing subroom', async () => {
	expect((await postComment(1162, { message: '   ', subRoomId: '1296' })).status).toBe(400)
	expect((await postComment(1162, { message: 'hi' })).status).toBe(400)

	const res = await SELF.fetch(`${ORIGIN}/comments/get/1162`)
	expect(await res.json()).toEqual([])
})

it('defaults an unparseable style and position to 0 rather than NaN', async () => {
	const res = await postComment(1162, {
		message: 'garbled',
		subRoomId: '1296',
		style: 'x',
		positionX: 'NaN',
	})
	const comment = (await res.json()) as Record<string, unknown>
	expect(comment.Style).toBe(0)
	expect(comment.PositionX).toBe(0)
	expect(comment.PositionY).toBe(0)
})

it('serves an openapi spec with no dangling refs', async () => {
	const res = await SELF.fetch(`${ORIGIN}/openapi.json`)
	expect(res.status).toBe(200)
	const spec = (await res.json()) as Record<string, unknown>
	expect(Object.keys(spec.paths as object).sort()).toEqual([
		'/',
		'/comments/create/{roomId}',
		'/comments/get/{roomId}',
	])
	expect(JSON.stringify(spec).match(/\$ref/g)).toBeNull()
})
