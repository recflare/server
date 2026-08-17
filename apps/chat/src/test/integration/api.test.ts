import { adminSecretsStore, env, SELF } from 'cloudflare:test'
import { beforeAll, beforeEach, describe, expect, it } from 'vitest'

import '../../chat.app'

import { NotificationType } from '../../../../notify/src/notification-types'
import {
	ChatModerationState,
	getMessage,
	getThreadMessages,
	insertMessage,
	SCHEMA_DDL,
} from '../../message-db'
import {
	createThread,
	findThreadWithMembers,
	getThreadForPlayer,
	getThreadsForPlayer,
	isThreadMember,
	leftChatContents,
	markThreadRead,
	postMessage,
	removeThreadMember,
	setThreadFavorited,
	startedChatContents,
	SYSTEM_SENDER_ID,
	THREAD_SCHEMA_DDL,
} from '../../thread-db'

import type { Env } from '../../context'
import type { ChatMessage } from '../../message-db'

declare module 'cloudflare:test' {
	interface ProvidedEnv extends Env {}
}

const ORIGIN = 'https://example.com'

// Mint a token the way the `auth` worker does, signing with the shared test key seeded
// into the JWT_SECRET store.
const TEST_SECRET = 'test-signing-key'

function b64url(input: ArrayBuffer | string): string {
	const bytes = typeof input === 'string' ? new TextEncoder().encode(input) : new Uint8Array(input)
	let binary = ''
	for (const byte of bytes) binary += String.fromCharCode(byte)
	return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

async function bearer(sub: number): Promise<Record<string, string>> {
	const now = Math.floor(Date.now() / 1000)
	const signingInput = `${b64url(JSON.stringify({ alg: 'HS256', typ: 'JWT' }))}.${b64url(
		JSON.stringify({ sub: String(sub), exp: now + 3600 })
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

beforeAll(async () => {
	// Seed the shared JWT signing key into the local Secrets Store so .get() resolves.
	await adminSecretsStore(env.JWT_SECRET).create(TEST_SECRET)
	for (const stmt of SCHEMA_DDL) await env.DB.prepare(stmt).run()
	for (const stmt of THREAD_SCHEMA_DDL) await env.DB.prepare(stmt).run()
})

describe('chat endpoints', () => {
	it('GET / reports service status', async () => {
		const res = await SELF.fetch(`${ORIGIN}/`)
		expect(res.status).toBe(200)
		expect(await res.json()).toEqual({ service: 'chat', status: 'ok' })
	})

	it('GET /thread 401s without a token', async () => {
		const res = await SELF.fetch(`${ORIGIN}/thread`)
		expect(res.status).toBe(401)
	})

	it('GET /thread serves the caller their own threads', async () => {
		const player = 881001
		const thread = await createThread(env.DB, [player, 881002])
		const latest = await postMessage(env.DB, {
			chatThreadId: thread,
			senderPlayerId: 881002,
			timeSent: '2022-02-21T18:08:56.0362822',
			contents: '{"Type":0,"Version":1,"Data":"hi"}',
		})

		const res = await SELF.fetch(`${ORIGIN}/thread?MessageCount=16&Mode=0`, {
			headers: await bearer(player),
		})
		expect(res.status).toBe(200)
		expect(await res.json()).toEqual([
			{
				latestMessage: latest,
				chatThreadId: thread,
				playerIds: [player, 881002],
				lastReadMessageId: 0,
				chatThreadName: '',
				chatThreadType: 0,
				snoozedUntil: null,
				isFavorited: false,
			},
		])
	})

	it('GET /thread/:id/message serves the thread newest first', async () => {
		const player = 881003
		const thread = await createThread(env.DB, [player, 881004])
		const older = await postMessage(env.DB, {
			chatThreadId: thread,
			senderPlayerId: 881004,
			timeSent: '2022-02-19T22:13:56.7224503',
			contents: '{"Type":0,"Version":1,"Data":"on discord?"}',
		})
		const newer = await postMessage(env.DB, {
			chatThreadId: thread,
			senderPlayerId: 881004,
			timeSent: '2022-02-21T18:08:56.0362822',
			contents: '{"Type":0,"Version":1,"Data":"hi"}',
		})

		const res = await SELF.fetch(`${ORIGIN}/thread/${thread}/message?MessageCount=16&Mode=0`, {
			headers: await bearer(player),
		})
		expect(res.status).toBe(200)
		expect(await res.json()).toEqual([newer, older])
	})

	it('GET /thread/:id/message honours MessageCount', async () => {
		const player = 881005
		const thread = await createThread(env.DB, [player])
		for (const data of ['one', 'two', 'three']) {
			await postMessage(env.DB, {
				chatThreadId: thread,
				senderPlayerId: player,
				contents: JSON.stringify({ Type: 0, Version: 1, Data: data }),
			})
		}

		const res = await SELF.fetch(`${ORIGIN}/thread/${thread}/message?MessageCount=2`, {
			headers: await bearer(player),
		})
		expect(await res.json()).toHaveLength(2)
	})

	// A thread's existence is itself private, so a non-member gets the same 404 as for a
	// thread that never existed — not a 403 that confirms it's there.
	it('GET /thread/:id/message hides threads the caller is not in', async () => {
		const thread = await createThread(env.DB, [881006, 881007])
		const res = await SELF.fetch(`${ORIGIN}/thread/${thread}/message`, {
			headers: await bearer(881008),
		})
		expect(res.status).toBe(404)

		const missing = await SELF.fetch(`${ORIGIN}/thread/999999/message`, {
			headers: await bearer(881008),
		})
		expect(missing.status).toBe(404)
	})
})

describe('message storage', () => {
	// A real message as the client sends it, kept verbatim (including the JSON-in-a-string
	// `contents` envelope) so the round-trip is tested against the actual payload shape.
	const CONTENTS =
		'{"Type":0,"Version":1,"Data":"This is jordanparki7 from your Oculus friends. We\'re friends in Rec Room now!"}'

	it('round-trips a message, assigning an id', async () => {
		const stored = await insertMessage(env.DB, {
			chatThreadId: 116181128,
			senderPlayerId: 10441985,
			timeSent: '2022-05-22T12:47:03.6536656',
			contents: CONTENTS,
		})
		expect(stored.chatMessageId).toBeGreaterThan(0)
		expect(stored).toEqual({
			chatMessageId: stored.chatMessageId,
			chatThreadId: 116181128,
			senderPlayerId: 10441985,
			timeSent: '2022-05-22T12:47:03.6536656',
			contents: CONTENTS,
			moderationState: ChatModerationState.None,
		})
		expect(await getMessage(env.DB, stored.chatMessageId)).toEqual(stored)
	})

	it('defaults timeSent to now', async () => {
		const stored = await insertMessage(env.DB, {
			chatThreadId: 999,
			senderPlayerId: 42,
			contents: CONTENTS,
		})
		expect(Date.parse(stored.timeSent)).toBeGreaterThan(Date.now() - 60_000)
	})

	it('lists a thread newest first and pages backwards', async () => {
		const thread = 116181129
		const first = await insertMessage(env.DB, {
			chatThreadId: thread,
			senderPlayerId: 1,
			contents: CONTENTS,
		})
		const second = await insertMessage(env.DB, {
			chatThreadId: thread,
			senderPlayerId: 2,
			contents: CONTENTS,
		})

		const page = await getThreadMessages(env.DB, thread)
		expect(page.map((m) => m.chatMessageId)).toEqual([second.chatMessageId, first.chatMessageId])

		const older = await getThreadMessages(env.DB, thread, { before: second.chatMessageId })
		expect(older.map((m) => m.chatMessageId)).toEqual([first.chatMessageId])

		// Messages from other threads never leak into a thread's listing.
		expect(await getThreadMessages(env.DB, 404)).toEqual([])
	})
})

describe('thread storage', () => {
	// The viewing player from the captured thread-list response.
	const VIEWER = 10441985

	function contents(data: string): string {
		return JSON.stringify({ Type: 0, Version: 1, Data: data })
	}

	it('renders the thread list in the shape the client expects', async () => {
		const dm = await createThread(env.DB, [9489959, VIEWER])
		const latest = await postMessage(env.DB, {
			chatThreadId: dm,
			senderPlayerId: VIEWER,
			timeSent: '2022-05-22T12:47:03.6536656',
			contents: contents(
				"This is jordanparki7 from your Oculus friends. We're friends in Rec Room now!"
			),
		})
		await markThreadRead(env.DB, dm, VIEWER, latest.chatMessageId)

		const [thread] = await getThreadsForPlayer(env.DB, VIEWER)
		expect(thread).toEqual({
			latestMessage: latest,
			chatThreadId: dm,
			playerIds: [9489959, VIEWER],
			lastReadMessageId: latest.chatMessageId,
			chatThreadName: '',
			chatThreadType: 0,
			snoozedUntil: null,
			isFavorited: false,
		})
	})

	it('keeps a named group thread with all its members', async () => {
		const members = [VIEWER, 10452682, 12534039, 12535328, 12631702]
		const group = await createThread(env.DB, members, 'Group Chat =]')
		await postMessage(env.DB, {
			chatThreadId: group,
			senderPlayerId: VIEWER,
			contents: contents('sussy baka'),
		})

		const thread = await getThreadForPlayer(env.DB, group, VIEWER)
		expect(thread?.chatThreadName).toBe('Group Chat =]')
		expect(thread?.playerIds).toEqual(members.sort((a, b) => a - b))
	})

	// System notices ("Player <@U…> started a chat") and player messages both carry
	// markup the server must not touch — the mention token, and HTML entities the
	// client escaped itself. Stored and served back byte-for-byte.
	it('stores message contents verbatim, markup and all', async () => {
		const thread = await createThread(env.DB, [VIEWER, 29565301])
		const notice = await postMessage(env.DB, {
			chatThreadId: thread,
			senderPlayerId: 29565301,
			contents: contents('Player <@U29565301> started a chat'),
		})
		const escaped = await postMessage(env.DB, {
			chatThreadId: thread,
			senderPlayerId: 29563053,
			contents: contents('Ly2 bae &lt;&lt;&lt;333'),
		})

		expect(await getMessage(env.DB, notice.chatMessageId)).toEqual(notice)
		expect((await getMessage(env.DB, escaped.chatMessageId))?.contents).toBe(escaped.contents)
	})

	it('orders threads newest first and honours the page size', async () => {
		const viewer = 777001
		const older = await createThread(env.DB, [viewer, 1])
		const newer = await createThread(env.DB, [viewer, 2])
		await postMessage(env.DB, {
			chatThreadId: older,
			senderPlayerId: viewer,
			contents: contents('first'),
		})
		await postMessage(env.DB, {
			chatThreadId: newer,
			senderPlayerId: viewer,
			contents: contents('second'),
		})

		const threads = await getThreadsForPlayer(env.DB, viewer)
		expect(threads.map((t) => t.chatThreadId)).toEqual([newer, older])
		expect(await getThreadsForPlayer(env.DB, viewer, { limit: 1 })).toHaveLength(1)
	})

	it('gates reads on membership', async () => {
		const thread = await createThread(env.DB, [777002, 777003])
		expect(await isThreadMember(env.DB, thread, 777002)).toBe(true)
		expect(await isThreadMember(env.DB, thread, 777004)).toBe(false)
		// A non-member sees neither the thread nor its place in their own list.
		expect(await getThreadForPlayer(env.DB, thread, 777004)).toBeNull()
		expect(await getThreadsForPlayer(env.DB, 777004)).toEqual([])
	})

	it('keeps read state, favorites, and snoozes per viewer', async () => {
		const a = 777005
		const b = 777006
		const thread = await createThread(env.DB, [a, b])
		const first = await postMessage(env.DB, {
			chatThreadId: thread,
			senderPlayerId: a,
			contents: contents('one'),
		})
		const second = await postMessage(env.DB, {
			chatThreadId: thread,
			senderPlayerId: b,
			contents: contents('two'),
		})

		await markThreadRead(env.DB, thread, a, second.chatMessageId)
		await setThreadFavorited(env.DB, thread, a, true)
		await markThreadRead(env.DB, thread, b, first.chatMessageId)

		const forA = await getThreadForPlayer(env.DB, thread, a)
		const forB = await getThreadForPlayer(env.DB, thread, b)
		expect(forA?.lastReadMessageId).toBe(second.chatMessageId)
		expect(forA?.isFavorited).toBe(true)
		expect(forB?.lastReadMessageId).toBe(first.chatMessageId)
		expect(forB?.isFavorited).toBe(false)

		// A late ack from a second client can't walk the thread back to unread.
		await markThreadRead(env.DB, thread, a, first.chatMessageId)
		expect((await getThreadForPlayer(env.DB, thread, a))?.lastReadMessageId).toBe(
			second.chatMessageId
		)
	})

	it('leaves an empty thread with no latest message', async () => {
		const thread = await createThread(env.DB, [777007])
		expect(await getThreadForPlayer(env.DB, thread, 777007)).toMatchObject({
			latestMessage: null,
			lastReadMessageId: 0,
			playerIds: [777007],
		})
	})

	it('drops a removed member from the roster but keeps the thread', async () => {
		const thread = await createThread(env.DB, [777008, 777009])
		await postMessage(env.DB, {
			chatThreadId: thread,
			senderPlayerId: 777008,
			contents: contents('mellon'),
		})
		await removeThreadMember(env.DB, thread, 777009)

		expect(await getThreadForPlayer(env.DB, thread, 777009)).toBeNull()
		expect((await getThreadForPlayer(env.DB, thread, 777008))?.playerIds).toEqual([777008])
	})
})

// The party thread is a stub until its real shape is observed off a live client; these
// pin down only what the stub promises — auth, and an object body rather than a 404.
describe('GET /thread/party', () => {
	it('answers an empty object', async () => {
		const res = await SELF.fetch(`${ORIGIN}/thread/party?maxCount=1&mode=0`, {
			headers: await bearer(883001),
		})
		expect(res.status).toBe(200)
		expect(await res.json()).toEqual({})
	})

	it('401s without a token', async () => {
		const res = await SELF.fetch(`${ORIGIN}/thread/party?maxCount=1&mode=0`)
		expect(res.status).toBe(401)
	})
})

describe('POST /thread/withmembers', () => {
	async function withMembers(caller: number, body: string) {
		return SELF.fetch(`${ORIGIN}/thread/withmembers`, {
			method: 'POST',
			headers: {
				...(await bearer(caller)),
				'Content-Type': 'application/x-www-form-urlencoded',
			},
			body,
		})
	}

	it('opens a thread with the named players plus the caller', async () => {
		const caller = 882001
		const res = await withMembers(caller, 'ids=2&ids=155&messageCount=50')
		expect(res.status).toBe(200)

		const thread = (await res.json()) as {
			chatThreadId: number
			playerIds: number[]
			messages: unknown[]
		}
		// A page of messages, not the list's single latestMessage. A brand-new thread
		// isn't empty: it opens with the system "started a chat" notice.
		expect(thread.messages).toEqual([
			expect.objectContaining({
				senderPlayerId: SYSTEM_SENDER_ID,
				contents: startedChatContents(caller),
			}),
		])
		expect(thread).toMatchObject({
			playerIds: [2, 155, caller],
			lastReadMessageId: 0,
			chatThreadName: '',
			snoozedUntil: null,
			isFavorited: false,
		})
		expect(thread).not.toHaveProperty('latestMessage')

		// The thread is real: it shows up in the caller's list, and its members can read it.
		expect((await getThreadsForPlayer(env.DB, caller)).map((t) => t.chatThreadId)).toContain(
			thread.chatThreadId
		)
		expect(await isThreadMember(env.DB, thread.chatThreadId, 155)).toBe(true)
	})

	// Two nulls GetChatBetweenPlayers can't survive: lastReadMessageId deserializes into
	// a non-nullable int ("expected 'Number Token', actual 'null'"), and chatThreadName
	// is dereferenced unchecked (NullReferenceException). Unread is 0, unnamed is ''.
	it('never serializes lastReadMessageId or chatThreadName as null', async () => {
		const res = await withMembers(882008, 'ids=153')
		const body = await res.text()
		expect(body).not.toContain('"lastReadMessageId":null')
		expect(body).not.toContain('"chatThreadName":null')

		const thread = JSON.parse(body) as { lastReadMessageId: number; chatThreadName: string }
		expect(thread.lastReadMessageId).toBe(0)
		expect(thread.chatThreadName).toBe('')
	})

	it('collapses duplicate ids and the caller naming themselves', async () => {
		const caller = 882002
		const res = await withMembers(caller, `ids=${caller}&ids=882003&ids=882003`)
		expect(((await res.json()) as { playerIds: number[] }).playerIds).toEqual([caller, 882003])
	})

	// Fetch-or-create: reopening a chat with the same people must land back in the
	// conversation that already has the history, not a fresh empty one.
	it('returns the existing thread rather than opening a second', async () => {
		const caller = 882004
		const first = (await (await withMembers(caller, 'ids=882005')).json()) as {
			chatThreadId: number
		}
		await postMessage(env.DB, {
			chatThreadId: first.chatThreadId,
			senderPlayerId: 882005,
			contents: '{"Type":0,"Version":1,"Data":"hi"}',
		})

		const second = (await (await withMembers(caller, 'ids=882005')).json()) as {
			chatThreadId: number
			messages: unknown[]
		}
		expect(second.chatThreadId).toBe(first.chatThreadId)
		// The opening notice plus the real message — reopening adds neither a thread nor
		// a second notice.
		expect(second.messages).toHaveLength(2)
	})

	// Membership is matched as a whole set, so a DM isn't mistaken for a group that
	// happens to contain the same two people.
	it('does not confuse a subset or superset for the same thread', async () => {
		const caller = 882009
		const pair = (await (await withMembers(caller, 'ids=882010')).json()) as {
			chatThreadId: number
		}
		const trio = (await (await withMembers(caller, 'ids=882010&ids=882011')).json()) as {
			chatThreadId: number
		}
		expect(trio.chatThreadId).not.toBe(pair.chatThreadId)
	})

	it('honours messageCount when paging the thread', async () => {
		const caller = 882012
		const opened = (await (await withMembers(caller, 'ids=882013')).json()) as {
			chatThreadId: number
		}
		for (const data of ['one', 'two', 'three']) {
			await postMessage(env.DB, {
				chatThreadId: opened.chatThreadId,
				senderPlayerId: caller,
				contents: JSON.stringify({ Type: 0, Version: 1, Data: data }),
			})
		}

		const paged = (await (await withMembers(caller, 'ids=882013&messageCount=2')).json()) as {
			messages: unknown[]
		}
		expect(paged.messages).toHaveLength(2)
	})

	it('rejects a thread with nobody else in it', async () => {
		const caller = 882006
		expect((await withMembers(caller, '')).status).toBe(400)
		expect((await withMembers(caller, `ids=${caller}`)).status).toBe(400)
		expect((await withMembers(caller, 'ids=notanumber')).status).toBe(400)
	})

	it('rejects an oversized roster', async () => {
		const ids = Array.from({ length: 60 }, (_, i) => `ids=${883000 + i}`).join('&')
		expect((await withMembers(882007, ids)).status).toBe(400)
	})

	it('401s without a token', async () => {
		const res = await SELF.fetch(`${ORIGIN}/thread/withmembers`, {
			method: 'POST',
			headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
			body: 'ids=2',
		})
		expect(res.status).toBe(401)
	})
})

describe('POST /thread', () => {
	async function createViaPost(caller: number, body: string) {
		return SELF.fetch(`${ORIGIN}/thread`, {
			method: 'POST',
			headers: {
				...(await bearer(caller)),
				'Content-Type': 'application/x-www-form-urlencoded',
			},
			body,
		})
	}

	// The call the client actually makes after /thread/withmembers: members, blank
	// contents. A blank field must not post an empty message, and reports
	// invalid-arguments rather than success.
	it('opens a thread with no message when messageContents is blank', async () => {
		const caller = 884001
		const res = await createViaPost(caller, 'ids=155&ids=2&messageContents=')
		expect(res.status).toBe(200)

		const body = (await res.json()) as {
			chatThread: { chatThreadId: number; latestMessage: { senderPlayerId: number } | null }
			chatResult: number
		}
		expect(body.chatResult).toBe(1)
		expect(body.chatThread).toMatchObject({ playerIds: [2, 155, caller] })

		// Nothing of the caller's was posted — but the thread still isn't empty: it opens
		// with the system notice, which is what the client needs to render it at all.
		const messages = await getThreadMessages(env.DB, body.chatThread.chatThreadId)
		expect(messages).toEqual([
			expect.objectContaining({
				senderPlayerId: SYSTEM_SENDER_ID,
				contents: startedChatContents(caller),
			}),
		])
		expect(body.chatThread.latestMessage?.senderPlayerId).toBe(SYSTEM_SENDER_ID)
	})

	it('posts the first message when messageContents is given', async () => {
		const caller = 884002
		const contents = '{"Type":0,"Version":1,"Data":"hi"}'
		const res = await createViaPost(
			caller,
			`ids=884003&messageContents=${encodeURIComponent(contents)}`
		)

		const body = (await res.json()) as {
			chatThread: {
				chatThreadId: number
				latestMessage: { contents: string; senderPlayerId: number } | null
			}
			chatResult: number
		}
		expect(body.chatResult).toBe(0)
		// Stored verbatim, attributed to the caller, and already the thread's latest.
		expect(body.chatThread.latestMessage).toMatchObject({ contents, senderPlayerId: caller })
		// The opening notice, then the caller's message.
		expect(await getThreadMessages(env.DB, body.chatThread.chatThreadId)).toHaveLength(2)
	})

	// Sending to people you already have a thread with appends to it, rather than
	// stranding the message in a second conversation.
	it('appends to the existing thread with the same members', async () => {
		const caller = 884005
		const first = (await (
			await createViaPost(caller, 'ids=884006&messageContents=%7B%22Data%22%3A%22one%22%7D')
		).json()) as { chatThread: { chatThreadId: number } }
		const second = (await (
			await createViaPost(caller, 'ids=884006&messageContents=%7B%22Data%22%3A%22two%22%7D')
		).json()) as { chatThread: { chatThreadId: number } }

		expect(second.chatThread.chatThreadId).toBe(first.chatThread.chatThreadId)
		// The opening notice, then both messages.
		expect(await getThreadMessages(env.DB, first.chatThread.chatThreadId)).toHaveLength(3)
	})

	it('rejects a thread with nobody else in it', async () => {
		expect((await createViaPost(884004, 'messageContents=')).status).toBe(400)
	})

	it('401s without a token', async () => {
		const res = await SELF.fetch(`${ORIGIN}/thread`, {
			method: 'POST',
			headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
			body: 'ids=2&messageContents=',
		})
		expect(res.status).toBe(401)
	})
})

describe('GET /thread/:id', () => {
	async function openThread(caller: number, chatThreadId: number, query = '?messageCount=50') {
		return SELF.fetch(`${ORIGIN}/thread/${chatThreadId}${query}`, {
			headers: await bearer(caller),
		})
	}

	it('opens a thread with its recent messages, newest first', async () => {
		const caller = 885001
		const chatThreadId = await createThread(env.DB, [caller, 885002])
		const older = await postMessage(env.DB, {
			chatThreadId,
			senderPlayerId: 885002,
			timeSent: '2022-02-19T22:13:56.7224503',
			contents: '{"Type":0,"Version":1,"Data":"on discord?"}',
		})
		const newer = await postMessage(env.DB, {
			chatThreadId,
			senderPlayerId: 885002,
			timeSent: '2022-02-21T18:08:56.0362822',
			contents: '{"Type":0,"Version":1,"Data":"hi"}',
		})

		const res = await openThread(caller, chatThreadId)
		expect(res.status).toBe(200)

		// An object, not a bare array: the client parses this one as a thread and rejects
		// an array outright ("expected '{', actual '['").
		const body = await res.text()
		expect(body.startsWith('{')).toBe(true)

		const thread = JSON.parse(body) as { messages: unknown[] }
		expect(thread).toMatchObject({
			chatThreadId,
			playerIds: [caller, 885002],
			lastReadMessageId: 0,
			chatThreadName: '',
			snoozedUntil: null,
			isFavorited: false,
		})
		expect(thread.messages).toEqual([newer, older])
		expect(thread).not.toHaveProperty('latestMessage')
	})

	// The sibling route serves the same messages as a bare array — the two shapes are
	// deliberately different, and the client depends on which is which.
	it('carries the same messages /thread/:id/message serves as an array', async () => {
		const caller = 885010
		const chatThreadId = await createThread(env.DB, [caller, 885011])
		await postMessage(env.DB, {
			chatThreadId,
			senderPlayerId: 885011,
			contents: '{"Type":0,"Version":1,"Data":"hi"}',
		})

		const thread = (await (await openThread(caller, chatThreadId)).json()) as {
			messages: unknown[]
		}
		const messages = await (
			await SELF.fetch(`${ORIGIN}/thread/${chatThreadId}/message?MessageCount=50`, {
				headers: await bearer(caller),
			})
		).json()
		expect(Array.isArray(messages)).toBe(true)
		expect(thread.messages).toEqual(messages)
	})

	it('honours messageCount', async () => {
		const caller = 885003
		const chatThreadId = await createThread(env.DB, [caller, 885004])
		for (const data of ['one', 'two', 'three']) {
			await postMessage(env.DB, {
				chatThreadId,
				senderPlayerId: caller,
				contents: JSON.stringify({ Type: 0, Version: 1, Data: data }),
			})
		}

		const res = await openThread(caller, chatThreadId, '?messageCount=2')
		expect(((await res.json()) as { messages: unknown[] }).messages).toHaveLength(2)
	})

	// A thread opened moments ago has nothing in it and still has to open — an empty
	// messages array, not a 404.
	it('opens an empty thread with an empty messages array', async () => {
		const caller = 885005
		const chatThreadId = await createThread(env.DB, [caller, 885006])

		const res = await openThread(caller, chatThreadId)
		expect(res.status).toBe(200)

		const { messages } = (await res.json()) as { messages: unknown[] }
		// Built directly by createThread with no starter, so genuinely empty.
		expect(messages).toEqual([])
	})

	it('hides threads the caller is not in', async () => {
		const chatThreadId = await createThread(env.DB, [885007, 885008])
		expect((await openThread(885009, chatThreadId)).status).toBe(404)
		expect((await openThread(885009, 999999)).status).toBe(404)
	})

	it('401s without a token', async () => {
		const res = await SELF.fetch(`${ORIGIN}/thread/1?messageCount=50`)
		expect(res.status).toBe(401)
	})
})

describe('ChatMessageReceived push', () => {
	/** The stubbed hub (see vitest.config.ts) records what it was sent. */
	interface SentNotification {
		playerId: number
		notificationType: NotificationType
		data: Record<string, unknown>
	}
	const hub = env.RECFLARE_NOTIFICATIONS_HUB as unknown as {
		getByName(name: string): { takeSent(): Promise<SentNotification[]> }
	}

	async function send(caller: number, body: string) {
		return SELF.fetch(`${ORIGIN}/thread`, {
			method: 'POST',
			headers: {
				...(await bearer(caller)),
				'Content-Type': 'application/x-www-form-urlencoded',
			},
			body,
		})
	}

	beforeEach(async () => {
		await hub.getByName('global').takeSent()
	})

	// Every member is notified, the sender included: the client doesn't fold the HTTP
	// response into its thread cache, so without a self-push its own message doesn't
	// show until the next refetch.
	it('notifies every member of the thread, sender included', async () => {
		const caller = 886001
		const contents = '{"Type":0,"Version":1,"Data":"hi"}'
		const res = await send(
			caller,
			`ids=886002&ids=886003&messageContents=${encodeURIComponent(contents)}`
		)
		const { chatThread } = (await res.json()) as {
			chatThread: { chatThreadId: number; latestMessage: { chatMessageId: number } }
		}

		const sent = await hub.getByName('global').takeSent()
		expect(sent.map((n) => n.playerId).sort((a, b) => a - b)).toEqual([caller, 886002, 886003])
		expect(
			sent.every((n) => n.notificationType === NotificationType.ChatMessageReceived)
		).toBe(true)
		expect(sent[0]!.data).toEqual({
			chatMessageId: chatThread.latestMessage.chatMessageId,
			chatThreadId: chatThread.chatThreadId,
			senderPlayerId: caller,
			timeSent: expect.any(String),
			contents,
			moderationState: 0,
		})
	})

	it('pushes nothing when there is no message to push', async () => {
		await send(886004, 'ids=886005&messageContents=')
		expect(await hub.getByName('global').takeSent()).toEqual([])
	})
})

// A membership row whose thread row is gone must never be resolved to: it would hand
// back an id nothing can render ("thread N vanished after creation"), and because the
// oldest match wins it would keep winning on every later call.
describe('orphaned membership rows', () => {
	it('ignores members of a thread whose message_thread row is gone', async () => {
		const caller = 887001
		const other = 887002
		const orphaned = await createThread(env.DB, [caller, other])
		await env.DB.prepare('DELETE FROM message_thread WHERE chat_thread_id = ?1')
			.bind(orphaned)
			.run()

		expect(await findThreadWithMembers(env.DB, [caller, other])).toBeNull()

		// Opening the chat recovers: a usable thread comes back, and it isn't the orphan.
		const res = await SELF.fetch(`${ORIGIN}/thread/withmembers`, {
			method: 'POST',
			headers: {
				...(await bearer(caller)),
				'Content-Type': 'application/x-www-form-urlencoded',
			},
			body: `ids=${other}&messageCount=50`,
		})
		expect(res.status).toBe(200)

		const thread = (await res.json()) as { chatThreadId: number; playerIds: number[] }
		expect(thread.chatThreadId).not.toBe(orphaned)
		expect(thread.playerIds).toEqual([caller, other])

		// And it stays stable — the orphan never wins a later lookup.
		expect(await findThreadWithMembers(env.DB, [caller, other])).toBe(thread.chatThreadId)
	})
})

describe('marking a thread read', () => {
	async function read(caller: number, path: string, method = 'POST') {
		return SELF.fetch(`${ORIGIN}${path}`, { method, headers: await bearer(caller) })
	}

	it('moves the pointer to a specific message, on both verbs', async () => {
		const caller = 888001
		const chatThreadId = await createThread(env.DB, [caller, 888002])
		const first = await postMessage(env.DB, {
			chatThreadId,
			senderPlayerId: 888002,
			contents: '{"Type":0,"Version":1,"Data":"one"}',
		})
		const second = await postMessage(env.DB, {
			chatThreadId,
			senderPlayerId: 888002,
			contents: '{"Type":0,"Version":1,"Data":"two"}',
		})

		const res = await read(caller, `/thread/${chatThreadId}/message/${first.chatMessageId}/read`)
		expect(res.status).toBe(200)
		// The bare ChatResult integer, not an envelope.
		expect(await res.json()).toBe(0)
		expect((await getThreadForPlayer(env.DB, chatThreadId, caller))?.lastReadMessageId).toBe(
			first.chatMessageId
		)

		await read(caller, `/thread/${chatThreadId}/message/${second.chatMessageId}/read`, 'PUT')
		expect((await getThreadForPlayer(env.DB, chatThreadId, caller))?.lastReadMessageId).toBe(
			second.chatMessageId
		)
	})

	it('marks the whole thread read without a message id', async () => {
		const caller = 888003
		const chatThreadId = await createThread(env.DB, [caller, 888004])
		const latest = await postMessage(env.DB, {
			chatThreadId,
			senderPlayerId: 888004,
			contents: '{"Type":0,"Version":1,"Data":"hi"}',
		})

		expect((await read(caller, `/thread/${chatThreadId}/read`)).status).toBe(200)
		expect((await getThreadForPlayer(env.DB, chatThreadId, caller))?.lastReadMessageId).toBe(
			latest.chatMessageId
		)
	})

	// The client acks whatever id it was shown — including the synthetic message's
	// 9007199254740976. Clamping keeps that from stranding the thread as read forever.
	it('clamps an id beyond the thread to the real latest message', async () => {
		const caller = 888005
		const chatThreadId = await createThread(env.DB, [caller, 888006])
		const real = await postMessage(env.DB, {
			chatThreadId,
			senderPlayerId: 888006,
			contents: '{"Type":0,"Version":1,"Data":"hi"}',
		})

		await read(caller, `/thread/${chatThreadId}/message/9007199254740976/read`)
		expect((await getThreadForPlayer(env.DB, chatThreadId, caller))?.lastReadMessageId).toBe(
			real.chatMessageId
		)

		// A later real message is still unread, rather than swallowed by the bogus ack.
		const next = await postMessage(env.DB, {
			chatThreadId,
			senderPlayerId: 888006,
			contents: '{"Type":0,"Version":1,"Data":"later"}',
		})
		expect(
			(await getThreadForPlayer(env.DB, chatThreadId, caller))?.lastReadMessageId
		).toBeLessThan(next.chatMessageId)
	})

	it('never moves the pointer backwards', async () => {
		const caller = 888007
		const chatThreadId = await createThread(env.DB, [caller, 888008])
		const first = await postMessage(env.DB, {
			chatThreadId,
			senderPlayerId: 888008,
			contents: '{"Type":0,"Version":1,"Data":"one"}',
		})
		const second = await postMessage(env.DB, {
			chatThreadId,
			senderPlayerId: 888008,
			contents: '{"Type":0,"Version":1,"Data":"two"}',
		})

		await read(caller, `/thread/${chatThreadId}/message/${second.chatMessageId}/read`)
		await read(caller, `/thread/${chatThreadId}/message/${first.chatMessageId}/read`)
		expect((await getThreadForPlayer(env.DB, chatThreadId, caller))?.lastReadMessageId).toBe(
			second.chatMessageId
		)
	})

	it('is gated on membership and auth', async () => {
		const chatThreadId = await createThread(env.DB, [888009, 888010])
		expect((await read(888011, `/thread/${chatThreadId}/read`)).status).toBe(404)

		const anon = await SELF.fetch(`${ORIGIN}/thread/${chatThreadId}/read`, { method: 'POST' })
		expect(anon.status).toBe(401)
	})
})

describe('POST /thread/:id', () => {
	// The exact body the client sends: a Version 2 envelope whose Data carries a `<=>`
	// prefix. Nothing in the worker parses it, so it must survive byte-for-byte.
	const CONTENTS = '{"Type":0,"Version":2,"Data":"<=>hey"}'

	async function send(caller: number, path: string, contents = CONTENTS) {
		return SELF.fetch(`${ORIGIN}${path}`, {
			method: 'POST',
			headers: {
				...(await bearer(caller)),
				'Content-Type': 'application/x-www-form-urlencoded',
			},
			body: `messageContents=${encodeURIComponent(contents)}`,
		})
	}

	it('appends to an existing thread and answers the send wrapper', async () => {
		const caller = 889001
		const chatThreadId = await createThread(env.DB, [caller, 889002], null, caller)

		const res = await send(caller, `/thread/${chatThreadId}`)
		expect(res.status).toBe(200)

		const body = (await res.json()) as {
			chatResult: number
			chatThread: {
				chatThreadId: number
				playerIds: number[]
				lastReadMessageId: number
				chatThreadType: number
				messages: ChatMessage[]
			}
		}
		expect(body.chatResult).toBe(0)

		// The whole thread comes back, newest message first, with the opening notice
		// beneath it — the shape the client re-renders the conversation from.
		expect(body.chatThread).toMatchObject({ chatThreadId, playerIds: [caller, 889002] })
		expect(body.chatThread.messages).toHaveLength(2)
		expect(body.chatThread.messages[0]).toMatchObject({
			chatThreadId,
			senderPlayerId: caller,
			contents: CONTENTS,
			moderationState: 0,
		})
		expect(body.chatThread.messages[1]).toMatchObject({ senderPlayerId: SYSTEM_SENDER_ID })

		// Sending marks the thread read for the sender, so it doesn't come back unread.
		expect(body.chatThread.lastReadMessageId).toBe(body.chatThread.messages[0]!.chatMessageId)

		// And it's stored, not just echoed.
		expect(await getThreadMessages(env.DB, chatThreadId)).toEqual(body.chatThread.messages)
	})

	it('accepts the /thread/:id/message spelling too', async () => {
		const caller = 889003
		const chatThreadId = await createThread(env.DB, [caller, 889004], null, caller)

		const res = await send(caller, `/thread/${chatThreadId}/message`)
		expect(((await res.json()) as { chatResult: number }).chatResult).toBe(0)
		expect(await getThreadMessages(env.DB, chatThreadId)).toHaveLength(2)
	})

	it('pushes ChatMessageReceived to every member', async () => {
		const hub = env.RECFLARE_NOTIFICATIONS_HUB as unknown as {
			getByName(name: string): {
				takeSent(): Promise<
					Array<{ playerId: number; notificationType: NotificationType }>
				>
			}
		}
		const caller = 889005
		const chatThreadId = await createThread(env.DB, [caller, 889006], null, caller)
		await hub.getByName('global').takeSent()

		await send(caller, `/thread/${chatThreadId}`)
		const sent = await hub.getByName('global').takeSent()
		expect(sent.map((n) => n.playerId).sort((a, b) => a - b)).toEqual([caller, 889006])
		expect(
			sent.every((n) => n.notificationType === NotificationType.ChatMessageReceived)
		).toBe(true)
	})

	it('reports invalid arguments for blank contents without storing anything', async () => {
		const caller = 889007
		const chatThreadId = await createThread(env.DB, [caller, 889008], null, caller)

		const res = await send(caller, `/thread/${chatThreadId}`, '   ')
		expect(res.status).toBe(200)

		const body = (await res.json()) as { chatResult: number; chatThread: { messages: unknown[] } }
		expect(body.chatResult).toBe(1)
		// The thread still comes back — only the opening notice is in it.
		expect(body.chatThread.messages).toHaveLength(1)
		expect(await getThreadMessages(env.DB, chatThreadId)).toHaveLength(1)
	})

	it('is gated on membership and auth', async () => {
		const chatThreadId = await createThread(env.DB, [889009, 889010], null, 889009)
		expect((await send(889011, `/thread/${chatThreadId}`)).status).toBe(404)

		const anon = await SELF.fetch(`${ORIGIN}/thread/${chatThreadId}`, {
			method: 'POST',
			headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
			body: 'messageContents=hi',
		})
		expect(anon.status).toBe(401)
	})
})

describe('POST /thread/:id/member/:playerId', () => {
	async function addMember(caller: number, chatThreadId: number, playerId: number) {
		return SELF.fetch(`${ORIGIN}/thread/${chatThreadId}/member/${playerId}`, {
			method: 'POST',
			headers: await bearer(caller),
		})
	}

	it('adds a player to a thread the caller is in', async () => {
		const caller = 890001
		const chatThreadId = await createThread(env.DB, [caller, 890002], null, caller)

		const res = await addMember(caller, chatThreadId, 890003)
		expect(res.status).toBe(200)
		expect(await res.json()).toBe(0)

		expect(await isThreadMember(env.DB, chatThreadId, 890003)).toBe(true)
		// The new member sees the thread, its history included.
		const thread = await getThreadForPlayer(env.DB, chatThreadId, 890003)
		expect(thread?.playerIds).toEqual([caller, 890002, 890003])
	})

	it('reports the player is already on the thread', async () => {
		const caller = 890004
		const chatThreadId = await createThread(env.DB, [caller, 890005], null, caller)
		expect(await (await addMember(caller, chatThreadId, 890005)).json()).toBe(4)
	})

	// A non-member gets the same answer as for a thread that doesn't exist, so the
	// endpoint can't be used to probe for threads.
	it('refuses a caller who is not on the thread', async () => {
		const chatThreadId = await createThread(env.DB, [890006, 890007], null, 890006)
		expect(await (await addMember(890008, chatThreadId, 890009)).json()).toBe(3)
		expect(await isThreadMember(env.DB, chatThreadId, 890009)).toBe(false)

		expect(await (await addMember(890008, 999999, 890009)).json()).toBe(3)
	})

	it('401s without a token', async () => {
		const res = await SELF.fetch(`${ORIGIN}/thread/1/member/2`, { method: 'POST' })
		expect(res.status).toBe(401)
	})
})

describe('renaming and leaving a thread', () => {
	async function post(caller: number, path: string, body?: string, method = 'POST') {
		return SELF.fetch(`${ORIGIN}${path}`, {
			method,
			headers: {
				...(await bearer(caller)),
				...(body === undefined ? {} : { 'Content-Type': 'application/x-www-form-urlencoded' }),
			},
			body,
		})
	}

	it('renames a thread for everyone on it', async () => {
		const caller = 891001
		const chatThreadId = await createThread(env.DB, [caller, 891002], null, caller)

		const res = await post(caller, `/thread/${chatThreadId}/rename`, 'name=my%20chat')
		expect(res.status).toBe(200)
		expect(await res.json()).toBe(0)

		// Both members see the new name.
		expect((await getThreadForPlayer(env.DB, chatThreadId, caller))?.chatThreadName).toBe('my chat')
		expect((await getThreadForPlayer(env.DB, chatThreadId, 891002))?.chatThreadName).toBe('my chat')
	})

	it('clears the name back to unnamed, never null', async () => {
		const caller = 891003
		const chatThreadId = await createThread(env.DB, [caller, 891004], 'Group Chat =]', caller)

		await post(caller, `/thread/${chatThreadId}/rename`, 'name=')
		expect((await getThreadForPlayer(env.DB, chatThreadId, caller))?.chatThreadName).toBe('')
	})

	it('truncates an overlong name rather than rejecting it', async () => {
		const caller = 891005
		const chatThreadId = await createThread(env.DB, [caller, 891006], null, caller)

		await post(caller, `/thread/${chatThreadId}/rename`, `name=${'x'.repeat(200)}`)
		expect((await getThreadForPlayer(env.DB, chatThreadId, caller))?.chatThreadName).toHaveLength(
			128
		)
	})

	it('refuses to rename a thread the caller is not on', async () => {
		const chatThreadId = await createThread(env.DB, [891007, 891008], null, 891007)
		expect(await (await post(891009, `/thread/${chatThreadId}/rename`, 'name=nope')).json()).toBe(3)
		expect((await getThreadForPlayer(env.DB, chatThreadId, 891007))?.chatThreadName).toBe('')
	})

	it('leaves a thread, posting the notice and keeping the history', async () => {
		const caller = 891010
		const stayer = 891011
		const chatThreadId = await createThread(env.DB, [caller, stayer], null, caller)
		await postMessage(env.DB, {
			chatThreadId,
			senderPlayerId: caller,
			contents: '{"Type":0,"Version":1,"Data":"bye"}',
		})

		const res = await post(caller, `/thread/${chatThreadId}/leave`)
		expect(res.status).toBe(200)
		expect(await res.json()).toBe(0)

		// Gone for the leaver, intact for everyone else.
		expect(await isThreadMember(env.DB, chatThreadId, caller)).toBe(false)
		expect(await getThreadForPlayer(env.DB, chatThreadId, caller)).toBeNull()

		const remaining = await getThreadForPlayer(env.DB, chatThreadId, stayer)
		expect(remaining?.playerIds).toEqual([stayer])
		expect(remaining?.latestMessage).toMatchObject({
			senderPlayerId: SYSTEM_SENDER_ID,
			contents: leftChatContents(caller),
		})
		// Opening notice, the message, and the leave notice.
		expect(await getThreadMessages(env.DB, chatThreadId)).toHaveLength(3)
	})

	it('accepts DELETE for leave as well as POST', async () => {
		const caller = 891012
		const chatThreadId = await createThread(env.DB, [caller, 891013], null, caller)

		expect(
			await (await post(caller, `/thread/${chatThreadId}/leave`, undefined, 'DELETE')).json()
		).toBe(0)
		expect(await isThreadMember(env.DB, chatThreadId, caller)).toBe(false)
	})

	it('reports membership-not-found when leaving a thread you are not on', async () => {
		const chatThreadId = await createThread(env.DB, [891014, 891015], null, 891014)
		expect(await (await post(891016, `/thread/${chatThreadId}/leave`)).json()).toBe(3)
		// Nothing was posted to a thread the caller has no business touching.
		expect(await getThreadMessages(env.DB, chatThreadId)).toHaveLength(1)
	})

	it('401s without a token', async () => {
		const rename = await SELF.fetch(`${ORIGIN}/thread/1/rename`, { method: 'POST' })
		expect(rename.status).toBe(401)
		const leave = await SELF.fetch(`${ORIGIN}/thread/1/leave`, { method: 'POST' })
		expect(leave.status).toBe(401)
	})
})

describe('POST /thread/:id/snooze', () => {
	async function snooze(caller: number, chatThreadId: number, body: string) {
		return SELF.fetch(`${ORIGIN}/thread/${chatThreadId}/snooze`, {
			method: 'POST',
			headers: {
				...(await bearer(caller)),
				'Content-Type': 'application/x-www-form-urlencoded',
			},
			body,
		})
	}

	it('snoozes and unsnoozes for the caller alone', async () => {
		const caller = 892001
		const other = 892002
		const chatThreadId = await createThread(env.DB, [caller, other], null, caller)

		const res = await snooze(caller, chatThreadId, 'snooze=True')
		expect(res.status).toBe(200)
		expect(await res.json()).toBe(0)

		expect((await getThreadForPlayer(env.DB, chatThreadId, caller))?.snoozedUntil).toBe(
			'9999-12-31T23:59:59Z'
		)
		// Snoozing is per-member: the other player is untouched.
		expect((await getThreadForPlayer(env.DB, chatThreadId, other))?.snoozedUntil).toBeNull()

		await snooze(caller, chatThreadId, 'snooze=False')
		expect((await getThreadForPlayer(env.DB, chatThreadId, caller))?.snoozedUntil).toBeNull()
	})

	it('refuses a thread the caller is not on', async () => {
		const chatThreadId = await createThread(env.DB, [892003, 892004], null, 892003)
		expect(await (await snooze(892005, chatThreadId, 'snooze=True')).json()).toBe(3)
	})

	it('401s without a token', async () => {
		const res = await SELF.fetch(`${ORIGIN}/thread/1/snooze`, {
			method: 'POST',
			headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
			body: 'snooze=True',
		})
		expect(res.status).toBe(401)
	})
})

describe('PUT /thread/:id/favorite', () => {
	async function favorite(caller: number, chatThreadId: number, body: string, method = 'PUT') {
		return SELF.fetch(`${ORIGIN}/thread/${chatThreadId}/favorite`, {
			method,
			headers: {
				...(await bearer(caller)),
				'Content-Type': 'application/x-www-form-urlencoded',
			},
			body,
		})
	}

	it('favorites and unfavorites for the caller alone', async () => {
		const caller = 893001
		const other = 893002
		const chatThreadId = await createThread(env.DB, [caller, other], null, caller)

		const res = await favorite(caller, chatThreadId, 'favorite=True')
		expect(res.status).toBe(200)
		expect(await res.json()).toBe(0)

		expect((await getThreadForPlayer(env.DB, chatThreadId, caller))?.isFavorited).toBe(true)
		// Per-member, like snoozing: the other player's inbox is untouched.
		expect((await getThreadForPlayer(env.DB, chatThreadId, other))?.isFavorited).toBe(false)

		await favorite(caller, chatThreadId, 'favorite=False')
		expect((await getThreadForPlayer(env.DB, chatThreadId, caller))?.isFavorited).toBe(false)
	})

	it('accepts POST as well as PUT', async () => {
		const caller = 893003
		const chatThreadId = await createThread(env.DB, [caller, 893004], null, caller)

		expect(await (await favorite(caller, chatThreadId, 'favorite=True', 'POST')).json()).toBe(0)
		expect((await getThreadForPlayer(env.DB, chatThreadId, caller))?.isFavorited).toBe(true)
	})

	it('refuses a thread the caller is not on', async () => {
		const chatThreadId = await createThread(env.DB, [893005, 893006], null, 893005)
		expect(await (await favorite(893007, chatThreadId, 'favorite=True')).json()).toBe(3)
	})

	it('401s without a token', async () => {
		const res = await SELF.fetch(`${ORIGIN}/thread/1/favorite`, {
			method: 'PUT',
			headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
			body: 'favorite=True',
		})
		expect(res.status).toBe(401)
	})
})

describe('openapi', () => {
	it('GET /openapi.json documents every route', async () => {
		const res = await SELF.fetch(`${ORIGIN}/openapi.json`)
		expect(res.status).toBe(200)
		const spec = (await res.json()) as {
			openapi: string
			paths: Record<string, Record<string, { summary?: string }>>
		}
		expect(spec.openapi).toMatch(/^3\.1/)

		// The spec route hides itself.
		expect(spec.paths['/openapi.json']).toBeUndefined()

		// Every schema inlines — a `$ref` here means a schema picked up a `.meta({ id })`
		// and emitted a reference the framework didn't hoist into components.schemas.
		expect(JSON.stringify(spec).includes('"$ref"')).toBe(false)

		// Every route the worker serves is described. This is the drift guard: adding a
		// route without a describeRoute() block fails here rather than silently shipping
		// an incomplete spec. Hono's `:param` syntax becomes OpenAPI's `{param}`; the
		// `.on([...], …)` routes contribute every method they were registered for.
		const documented = new Set(
			Object.entries(spec.paths).flatMap(([path, ops]) =>
				Object.keys(ops).map((method) => `${method.toUpperCase()} ${path}`)
			)
		)
		expect([...documented].sort()).toEqual([
			'DELETE /thread/{id}/leave',
			'GET /',
			'GET /thread',
			'GET /thread/party',
			'GET /thread/{id}',
			'GET /thread/{id}/message',
			'POST /thread',
			'POST /thread/withmembers',
			'POST /thread/{id}',
			'POST /thread/{id}/favorite',
			'POST /thread/{id}/leave',
			'POST /thread/{id}/member/{playerId}',
			'POST /thread/{id}/message',
			'POST /thread/{id}/message/{messageId}/read',
			'POST /thread/{id}/read',
			'POST /thread/{id}/rename',
			'POST /thread/{id}/snooze',
			'PUT /thread/{id}/favorite',
			'PUT /thread/{id}/message/{messageId}/read',
			'PUT /thread/{id}/read',
			'PUT /thread/{id}/rename',
			'PUT /thread/{id}/snooze',
		])

		// Every operation carries a summary — a path present but undescribed is not
		// documentation.
		for (const ops of Object.values(spec.paths)) {
			for (const op of Object.values(ops)) expect(op.summary).toBeTruthy()
		}
	})
})
