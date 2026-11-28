import { useEffect, useRef, useState } from 'react'

import { call, useAction, usernamesFor, where } from './api'

import type { FormEvent } from 'react'
import type { ChatMessage } from '../../../chat/src/message-db'
import type { ChatThread } from '../../../chat/src/thread-db'
import type { PublicAccount } from './api'

/**
 * The website's messages, at `/messages` and `/messages/<threadId>`: the same chat threads
 * the game shows, read and posted through the `chat` worker's own endpoints.
 *
 * Polls rather than holding the game's notification socket. A message sent here still
 * reaches players in game live, because `chat` pushes it to them whoever posted it.
 *
 * New conversations are offered with FRIENDS only. `Friends` is the default chat privacy a
 * player has, and `chat` stores that setting without enforcing it, so the picker is what
 * keeps the website from being a way to message strangers. For the same reason messages from
 * a player the viewer has blocked are not shown.
 */

const THREAD_POLL_MS = 15_000
const MESSAGE_POLL_MS = 4_000
const THREAD_COUNT = 50
const MESSAGE_COUNT = 100
const MAX_LENGTH = 500

/** `senderPlayerId` of the join and leave notices. */
const SYSTEM_SENDER = -5
/** `RelationshipType.Friend`. */
const FRIEND = 3
/** `ChatModerationState.Hidden`. */
const HIDDEN = 2
/** The `ChatResult` a banned sender is refused with. */
const PLAYER_BANNED = 14

type Thread = Omit<ChatThread, 'latestMessage'> & { latestMessage?: ChatMessage | null }
type OpenThread = Thread & { messages: ChatMessage[] }

interface Relationship {
	PlayerID: number
	RelationshipType: number
	Ignored: number
}

type Names = Map<number, PublicAccount>

/**
 * The words in a message, or null for one only the game can draw (an invite, an image).
 * `contents` is the client's `{ Type, Version, Data }` envelope; Type 0 is text, and a
 * Version 2 `Data` opens with a `<=>` marker the game strips.
 */
export function messageText(contents: string, names: Names): string | null {
	let envelope: { Type?: unknown; Version?: unknown; Data?: unknown }
	try {
		envelope = JSON.parse(contents) as typeof envelope
	} catch {
		return contents
	}
	if (envelope?.Type !== 0 || typeof envelope.Data !== 'string') return null
	const data = envelope.Version === 2 ? envelope.Data.replace(/^<=>/, '') : envelope.Data
	return data.replace(/<@U(\d+)>/g, (_, id: string) => `@${nameOf(Number(id), names)}`)
}

const nameOf = (id: number, names: Names) => names.get(id)?.username ?? `player ${id}`

function titleOf(thread: Thread, me: number, names: Names): string {
	if (thread.chatThreadName) return thread.chatThreadName
	const others = thread.playerIds.filter((id) => id !== me)
	return others.length === 0 ? 'Just you' : others.map((id) => `@${nameOf(id, names)}`).join(', ')
}

const timeOf = (iso: string) =>
	new Date(iso).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' })

/** Run `load` now and then every `ms`, skipping turns while the tab is hidden. */
function usePoll(load: (stale: () => boolean) => Promise<void>, ms: number, key: unknown) {
	const [error, setError] = useState('')
	const latest = useRef(load)
	latest.current = load
	useEffect(() => {
		let stopped = false
		let timer: number | undefined
		const stale = () => stopped
		const turn = async (first: boolean) => {
			if (first || document.visibilityState === 'visible') {
				try {
					await latest.current(stale)
					if (!stopped) setError('')
				} catch (err) {
					if (!stopped) setError(err instanceof Error ? err.message : String(err))
				}
			}
			// Chained rather than an interval, so a slow answer can't overlap the next request.
			if (!stopped) timer = window.setTimeout(() => void turn(false), ms)
		}
		void turn(true)
		return () => {
			stopped = true
			window.clearTimeout(timer)
		}
	}, [ms, key])
	return error
}

export function MessagesPage({
	account,
	path,
	navigate,
}: {
	/** undefined while the session is still being checked, null when signed out. */
	account: { accountId: number } | null | undefined
	path: string
	navigate: (to: string) => void
}) {
	if (account === undefined) return <main className="shell wide" />
	if (account === null) {
		return (
			<main className="shell wide">
				<h1>Messages</h1>
				<p>
					<button className="primary" onClick={() => navigate('/login?next=%2Fmessages')}>
						Sign in
					</button>{' '}
					to read your messages.
				</p>
			</main>
		)
	}
	const id = Number(path.split('/')[2])
	return (
		<Inbox
			me={account.accountId}
			openId={Number.isInteger(id) && id > 0 ? id : null}
			navigate={navigate}
		/>
	)
}

function Inbox({
	me,
	openId,
	navigate,
}: {
	me: number
	openId: number | null
	navigate: (to: string) => void
}) {
	const [threads, setThreads] = useState<Thread[] | null>(null)
	const [relationships, setRelationships] = useState<Relationship[]>([])
	const [names, setNames] = useState<Names>(new Map())
	const start = useAction()

	/** Add the names of any of these players not looked up yet. */
	const learn = async (ids: number[]) => {
		const unknown = ids.filter((id) => id > 0 && !names.has(id))
		if (unknown.length === 0) return
		const found = await usernamesFor(unknown)
		setNames((known) => new Map([...known, ...found]))
	}

	const error = usePoll(
		async (stale) => {
			const [list, related] = await Promise.all([
				call<Thread[]>(`${where().chat}/thread?MessageCount=${THREAD_COUNT}`, { authed: true }),
				call<Relationship[]>(`${where().api}/api/relationships/v2/get`, { authed: true }),
			])
			if (stale()) return
			setThreads(list)
			setRelationships(related)
			await learn([...list.flatMap((t) => t.playerIds), ...related.map((r) => r.PlayerID)])
		},
		THREAD_POLL_MS,
		openId
	)

	const blocked = new Set(relationships.filter((r) => r.Ignored === 1).map((r) => r.PlayerID))
	const friends = relationships
		.filter((r) => r.RelationshipType === FRIEND && r.Ignored !== 1)
		.map((r) => r.PlayerID)
		.sort((a, b) => nameOf(a, names).localeCompare(nameOf(b, names)))

	const startWith = (friendId: number) =>
		void start.run(async () => {
			const thread = await call<OpenThread>(`${where().chat}/thread/withmembers`, {
				authed: true,
				form: { ids: String(friendId), messageCount: '1' },
			})
			navigate(`/messages/${thread.chatThreadId}`)
			return ''
		})

	return (
		<main className="shell wide">
			<h1>Messages</h1>
			<div className={`messages${openId === null ? '' : ' open'}`}>
				<aside className="messages-list">
					<select
						aria-label="New message"
						value=""
						disabled={start.pending || friends.length === 0}
						onChange={(e) => startWith(Number(e.target.value))}
					>
						<option value="" disabled>
							{friends.length === 0 ? 'Add friends to message them' : 'New message to…'}
						</option>
						{friends.map((id) => (
							<option key={id} value={id}>
								@{nameOf(id, names)}
							</option>
						))}
					</select>
					{(error || start.error) && <p className="error">{error || start.error}</p>}
					{threads?.length === 0 && <p>No conversations yet.</p>}
					{threads?.map((thread) => {
						const latest = thread.latestMessage
						const unread =
							!!latest &&
							latest.senderPlayerId !== me &&
							latest.chatMessageId > thread.lastReadMessageId &&
							thread.chatThreadId !== openId
						const preview =
							!latest || latest.moderationState === HIDDEN || blocked.has(latest.senderPlayerId)
								? ''
								: (messageText(latest.contents, names) ?? 'Sent something to view in game')
						return (
							<button
								key={thread.chatThreadId}
								className={`messages-thread${thread.chatThreadId === openId ? ' active' : ''}${unread ? ' unread' : ''}`}
								onClick={() => navigate(`/messages/${thread.chatThreadId}`)}
							>
								<strong>{titleOf(thread, me, names)}</strong>
								<span>{preview}</span>
							</button>
						)
					})}
				</aside>
				{openId === null ? (
					<p className="messages-empty">Pick a conversation.</p>
				) : (
					<Conversation
						key={openId}
						threadId={openId}
						me={me}
						names={names}
						blocked={blocked}
						learn={learn}
						navigate={navigate}
					/>
				)}
			</div>
		</main>
	)
}

function Conversation({
	threadId,
	me,
	names,
	blocked,
	learn,
	navigate,
}: {
	threadId: number
	me: number
	names: Names
	blocked: Set<number>
	learn: (ids: number[]) => Promise<void>
	navigate: (to: string) => void
}) {
	const [thread, setThread] = useState<OpenThread | null>(null)
	const [draft, setDraft] = useState('')
	const send = useAction()
	const log = useRef<HTMLOListElement>(null)
	const read = useRef(0)

	const error = usePoll(
		async (stale) => {
			const next = await call<OpenThread>(
				`${where().chat}/thread/${threadId}?messageCount=${MESSAGE_COUNT}`,
				{ authed: true }
			)
			if (stale()) return
			setThread(next)
			await learn([...next.playerIds, ...next.messages.map((m) => m.senderPlayerId)])
			// Newest first, so the head is the one to mark. Only for a tab someone is looking at.
			const newest = next.messages[0]?.chatMessageId ?? 0
			if (newest > read.current && document.visibilityState === 'visible') {
				await call(`${where().chat}/thread/${threadId}/read`, { authed: true, method: 'PUT' })
				read.current = newest
			}
		},
		MESSAGE_POLL_MS,
		threadId
	)

	const newestId = thread?.messages[0]?.chatMessageId
	useEffect(() => {
		log.current?.scrollTo({ top: log.current.scrollHeight })
	}, [newestId])

	const submit = (e: FormEvent) => {
		e.preventDefault()
		const text = draft.trim()
		if (text === '' || send.pending) return
		void send.run(async () => {
			const res = await call<{ ChatResult: number; chatThread: OpenThread | null }>(
				`${where().chat}/thread/${threadId}`,
				{
					authed: true,
					form: { messageContents: JSON.stringify({ Type: 0, Version: 1, Data: text }) },
				}
			)
			if (res.ChatResult === PLAYER_BANNED) throw new Error('You can’t send messages while banned.')
			if (res.ChatResult !== 0) throw new Error('That message couldn’t be sent.')
			if (res.chatThread) setThread(res.chatThread)
			setDraft('')
			return ''
		})
	}

	const shown = (thread?.messages ?? [])
		.filter((m) => m.moderationState !== HIDDEN && !blocked.has(m.senderPlayerId))
		.reverse()

	return (
		<section className="messages-conversation">
			<header>
				<button className="linkish messages-back" onClick={() => navigate('/messages')}>
					← All
				</button>
				<strong>{thread ? titleOf(thread, me, names) : ''}</strong>
			</header>
			<ol ref={log}>
				{shown.map((m) =>
					m.senderPlayerId === SYSTEM_SENDER ? (
						<li key={m.chatMessageId} className="notice">
							{messageText(m.contents, names)}
						</li>
					) : (
						<li key={m.chatMessageId} className={m.senderPlayerId === me ? 'mine' : ''}>
							<small>
								{m.senderPlayerId === me ? 'You' : `@${nameOf(m.senderPlayerId, names)}`} ·{' '}
								{timeOf(m.timeSent)}
							</small>
							<p>{messageText(m.contents, names) ?? <em>Sent something to view in game</em>}</p>
						</li>
					)
				)}
			</ol>
			{(error || send.error) && <p className="error">{send.error || error}</p>}
			<form onSubmit={submit}>
				<input
					aria-label="Message"
					placeholder="Write a message"
					maxLength={MAX_LENGTH}
					value={draft}
					onChange={(e) => setDraft(e.target.value)}
					disabled={thread === null}
				/>
				<button type="submit" disabled={thread === null || send.pending || draft.trim() === ''}>
					Send
				</button>
			</form>
		</section>
	)
}
