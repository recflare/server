import { useEffect, useState } from 'react'

import { Accessibility } from '@repo/domain/src/enums'

import { call, usernamesFor, where } from './api'

import type { ReactNode } from 'react'
import type { PlayerEvent, PlayerEventBase, PlayerEventResponse } from '../../../api/src/events-db'

/**
 * The public events page, at `/events`: a grid of the player events running now or
 * starting in the next two weeks, soonest first — running ones marked Live.
 *
 * Read from `api`'s browse feed (`GET /api/playerevents/v1`), the same list the game's
 * events screen opens on — Public events only, which the feed itself enforces.
 *
 * The rooms are looked up in one `rooms` bulk call, for the room name under each event and
 * for a picture when the event has no banner of its own. `excludePrivateRooms` leaves a room
 * that isn't public unnamed rather than advertising it.
 */

/** How many events the feed is asked for. One page of it: enough to fill the grid. */
const EVENT_COUNT = 60

/** How far ahead the page looks. Anything starting later isn't shown yet. */
const WINDOW_MS = 14 * 24 * 60 * 60 * 1000

/** The few room fields a tile shows. */
interface EventRoom {
	RoomId: number
	Name: string
	ImageName: string
}

async function fetchUpcomingEvents(): Promise<PlayerEventBase[]> {
	const events = await call<PlayerEventBase[]>(
		`${where().api}/api/playerevents/v1?take=${EVENT_COUNT}`
	)
	if (!Array.isArray(events)) return []
	// Running events are kept: they started already, so they're inside the window too.
	const cutoff = Date.now() + WINDOW_MS
	return events.filter((e) => Date.parse(e.StartTime) <= cutoff)
}

/** The public rooms behind a set of events, by id. Empty on failure: names are decoration. */
async function fetchEventRooms(events: Array<{ RoomId: number }>): Promise<Map<number, EventRoom>> {
	const ids = [...new Set(events.map((e) => e.RoomId).filter((id) => id > 0))]
	if (ids.length === 0) return new Map()
	const rooms = await call<EventRoom[]>(
		`${where().rooms}/rooms/bulk?id=${ids.join(',')}&excludePrivateRooms=True`
	).catch(() => [])
	return new Map(Array.isArray(rooms) ? rooms.map((r) => [r.RoomId, r]) : [])
}

export function EventsPage({
	ready,
	navigate,
}: {
	/** Whether `/api/config` has landed — every fetch here goes through `where()`. */
	ready: boolean
	navigate: (to: string) => void
}) {
	const [events, setEvents] = useState<PlayerEventBase[] | null>(null)
	const [rooms, setRooms] = useState<Map<number, EventRoom>>(new Map())
	const [error, setError] = useState('')

	useEffect(() => {
		if (!ready) return
		let cancelled = false
		void fetchUpcomingEvents()
			.then(async (list) => {
				if (cancelled) return
				setEvents(list)
				const found = await fetchEventRooms(list)
				if (!cancelled) setRooms(found)
			})
			.catch((e) => {
				if (!cancelled) setError(e instanceof Error ? e.message : String(e))
			})
		return () => {
			cancelled = true
		}
	}, [ready])

	return (
		<main className="shell home listing-page">
			<div className="listing-head">
				<h1>Events</h1>
				<p className="muted">
					What&apos;s on over the next two weeks, soonest first. RSVP and find more from the Events
					screen in game.
				</p>
			</div>
			{error ? (
				<p className="error">{error}</p>
			) : events === null ? (
				<p className="muted">Loading…</p>
			) : events.length === 0 ? (
				<p className="muted">Nothing scheduled right now. Check back soon.</p>
			) : (
				<ul className="tile-grid">
					{events.map((event) => (
						<EventTile
							key={event.PlayerEventId}
							event={event}
							room={rooms.get(event.RoomId)}
							navigate={navigate}
						/>
					))}
				</ul>
			)}
		</main>
	)
}

function EventTile({
	event,
	room,
	navigate,
}: {
	event: PlayerEventBase
	room: EventRoom | undefined
	navigate: (to: string) => void
}) {
	const start = new Date(event.StartTime)
	const end = new Date(event.EndTime)
	const now = Date.now()
	const live = start.getTime() <= now && now < end.getTime()
	const image = event.ImageName || room?.ImageName || ''

	return (
		<li className="tile">
			{/* The same link as the title. Left out of the tab order and hidden from screen
			    readers, so the tile isn't announced as two links to one place. */}
			<a
				className="tile-thumb-link"
				href={`/event/${event.PlayerEventId}`}
				tabIndex={-1}
				aria-hidden="true"
				onClick={(e) => {
					e.preventDefault()
					navigate(`/event/${event.PlayerEventId}`)
				}}
			>
				{image ? (
					<img
						className="tile-thumb"
						src={`${where().img}/${image}?width=512`}
						alt=""
						loading="lazy"
					/>
				) : (
					<div className="tile-thumb" />
				)}
			</a>
			<div className="tile-body">
				<p className="event-when">
					{live && <span className="badge live">Live</span>}
					<time dateTime={event.StartTime}>{formatWhen(start)}</time>
				</p>
				<h2 className="tile-name">
					<a
						href={`/event/${event.PlayerEventId}`}
						onClick={(e) => {
							e.preventDefault()
							navigate(`/event/${event.PlayerEventId}`)
						}}
					>
						{event.Name}
					</a>
				</h2>
				{room && (
					<a
						className="tile-sub"
						href={`/rooms/${room.RoomId}`}
						onClick={(e) => {
							e.preventDefault()
							navigate(`/rooms/${room.RoomId}`)
						}}
					>
						^{room.Name}
					</a>
				)}
				{event.Description && <p className="tile-desc">{event.Description}</p>}
				<p className="tile-stats">
					{event.AttendeeCount.toLocaleString()} going · {formatDuration(start, end)}
				</p>
			</div>
		</li>
	)
}

/** "Sat, Nov 1, 7:00 PM" in the visitor's own time zone. */
function formatWhen(date: Date): string {
	if (Number.isNaN(date.getTime())) return ''
	return date.toLocaleString(undefined, {
		weekday: 'short',
		month: 'short',
		day: 'numeric',
		hour: 'numeric',
		minute: '2-digit',
	})
}

/** "1h 30m", "45m". */
function formatDuration(start: Date, end: Date): string {
	const minutes = Math.max(0, Math.round((end.getTime() - start.getTime()) / 60_000))
	const h = Math.floor(minutes / 60)
	const m = minutes % 60
	return h === 0 ? `${m}m` : m === 0 ? `${h}h` : `${h}h ${m}m`
}

/**
 * The event id in `/event/<id>`, or in the game's share link `/d/event/<id>/<code>` (the
 * code is the `link` worker's share code; the id alone is enough to show the event, so it
 * isn't resolved). Null for any other path.
 */
export function eventIdFromPath(path: string): number | null {
	const match = /^\/(?:event|d\/event)\/(\d+)(?:\/[A-Za-z0-9]+)?\/?$/.exec(path)
	return match ? Number(match[1]) : null
}

/**
 * The answers a player can give, in the order the buttons show them. `Type` on
 * `POST /api/playerevents/v1/respond`; 3 (an unanswered invitation) is the server's own
 * mark and is never sent.
 */
const ANSWERS: Array<{ type: number; label: string }> = [
	{ type: 0, label: 'Going' },
	{ type: 1, label: 'Interested' },
	{ type: 2, label: 'Not going' },
]

/** The event, or null when there's no such event — `api` answers that with an empty 404. */
async function fetchEvent(eventId: number): Promise<PlayerEvent | null> {
	const res = await fetch(`${where().api}/api/playerevents/v1/${eventId}`)
	if (res.status === 404) return null
	if (!res.ok) throw new Error(`Couldn't load the event (${res.status}).`)
	return (await res.json()) as PlayerEvent
}

/** The caller's own answer to an event, from its guest list — null when they have none. */
async function fetchMyAnswer(eventId: number, accountId: number): Promise<number | null> {
	const rows = await call<PlayerEventResponse[]>(
		`${where().api}/api/playerevents/v1/${eventId}/responses`
	)
	return (Array.isArray(rows) ? rows : []).find((r) => r.PlayerId === accountId)?.Type ?? null
}

/**
 * One event's page, at `/event/<id>`: the event, its room and host, how many are going,
 * and — for a signed-in player — Going / Interested / Not going.
 *
 * PUBLIC events only. `api`'s by-id read answers for any event (the client fetches a
 * private one it was invited to by id), so the page checks `Accessibility` itself and
 * shows a private or unlisted event the same as a missing one.
 *
 * The answer goes through the same `POST /api/playerevents/v1/respond` the game sends, and
 * the count is redrawn from the event it answers with. The player's current answer is read
 * from the event's guest list, which is public.
 */
export function EventPage({
	eventId,
	account,
	ready,
	navigate,
}: {
	eventId: number
	/** undefined while the stored session is still being checked; null when signed out. */
	account: { accountId: number } | null | undefined
	ready: boolean
	navigate: (to: string) => void
}) {
	// undefined = loading; null = no such public event.
	const [event, setEvent] = useState<PlayerEvent | null | undefined>(undefined)
	const [room, setRoom] = useState<EventRoom | null>(null)
	const [host, setHost] = useState<{ username: string; displayName: string } | null>(null)
	const [error, setError] = useState('')
	const accountId = account?.accountId

	useEffect(() => {
		if (!ready) return
		let cancelled = false
		setEvent(undefined)
		setRoom(null)
		setHost(null)
		setError('')
		void fetchEvent(eventId)
			.then((found) => {
				if (cancelled) return
				const shown = found !== null && found.Accessibility === Accessibility.Public ? found : null
				setEvent(shown)
				if (shown === null) return
				void fetchEventRooms([shown]).then((rooms) => {
					if (!cancelled) setRoom(rooms.get(shown.RoomId) ?? null)
				})
				void usernamesFor([shown.CreatorPlayerId]).then((names) => {
					if (!cancelled) setHost(names.get(shown.CreatorPlayerId) ?? null)
				})
			})
			.catch((e) => {
				if (!cancelled) setError(e instanceof Error ? e.message : String(e))
			})
		return () => {
			cancelled = true
		}
	}, [eventId, ready])

	if (error) {
		return (
			<EventShell navigate={navigate}>
				<p className="error">{error}</p>
			</EventShell>
		)
	}
	if (event === undefined) {
		return (
			<EventShell navigate={navigate}>
				<p className="muted">Loading…</p>
			</EventShell>
		)
	}
	if (event === null) {
		return (
			<EventShell navigate={navigate}>
				<section className="card">
					<h1>Event not found</h1>
					<p className="muted">This event doesn&apos;t exist, or it isn&apos;t public.</p>
				</section>
			</EventShell>
		)
	}

	const start = new Date(event.StartTime)
	const end = new Date(event.EndTime)
	const now = Date.now()
	const live = start.getTime() <= now && now < end.getTime()
	const over = end.getTime() <= now
	const image = event.ImageName || room?.ImageName || ''
	const here = `/event/${eventId}`

	return (
		<EventShell navigate={navigate}>
			<section className="card event-hero">
				{image ? (
					<img className="event-hero-img" src={`${where().img}/${image}?width=1024`} alt="" />
				) : (
					<div className="event-hero-img" aria-hidden="true" />
				)}
				<div className="event-hero-body">
					<p className="event-when">
						{live && <span className="badge live">Live</span>}
						{over && <span className="badge">Ended</span>}
						<time dateTime={event.StartTime}>{formatWhen(start)}</time>
						<span className="muted">· {formatDuration(start, end)}</span>
					</p>
					<h1 className="event-hero-name">{event.Name}</h1>
					<p className="event-hero-meta muted">
						{room && (
							<>
								in{' '}
								<a
									href={`/rooms/${room.RoomId}`}
									onClick={(e) => {
										e.preventDefault()
										navigate(`/rooms/${room.RoomId}`)
									}}
								>
									^{room.Name}
								</a>
							</>
						)}
						{room && host && ' · '}
						{host && (
							<>
								hosted by{' '}
								<a
									href={`/user/${encodeURIComponent(host.username)}`}
									onClick={(e) => {
										e.preventDefault()
										navigate(`/user/${encodeURIComponent(host.username)}`)
									}}
								>
									{host.displayName || host.username}
								</a>
							</>
						)}
					</p>
					<p className="event-attending">
						<strong>{event.AttendeeCount.toLocaleString()}</strong>{' '}
						{event.AttendeeCount === 1 ? 'person' : 'people'} {over ? 'went' : 'going'}
					</p>
					{event.Description && <p className="event-hero-desc">{event.Description}</p>}
				</div>
			</section>

			{!over && (
				<section className="card">
					<h2>Are you going?</h2>
					{account === undefined ? (
						<p className="muted">Loading…</p>
					) : account === null || accountId === undefined ? (
						<>
							<p className="muted">Sign in to let the host know.</p>
							<p>
								<a
									className="cta"
									href={`/login?next=${encodeURIComponent(here)}`}
									onClick={(e) => {
										e.preventDefault()
										navigate(`/login?next=${encodeURIComponent(here)}`)
									}}
								>
									Sign in
								</a>
							</p>
						</>
					) : (
						<Rsvp
							eventId={eventId}
							accountId={accountId}
							onCount={(count) => setEvent({ ...event, AttendeeCount: count })}
						/>
					)}
				</section>
			)}
		</EventShell>
	)
}

/** The page frame, with the way back to the grid. */
function EventShell({
	navigate,
	children,
}: {
	navigate: (to: string) => void
	children: ReactNode
}) {
	return (
		<main className="shell wide listing-page">
			<p className="backlink">
				<a
					href="/events"
					onClick={(e) => {
						e.preventDefault()
						navigate('/events')
					}}
				>
					← All events
				</a>
			</p>
			{children}
		</main>
	)
}

/** Going / Interested / Not going, showing the player's current answer. */
function Rsvp({
	eventId,
	accountId,
	onCount,
}: {
	eventId: number
	accountId: number
	/** The event's attendee count after an answer lands. */
	onCount: (count: number) => void
}) {
	// undefined = loading; null = not answered (an open invitation reads the same way).
	const [answer, setAnswer] = useState<number | null | undefined>(undefined)
	const [pending, setPending] = useState<number | null>(null)
	const [error, setError] = useState('')

	useEffect(() => {
		let cancelled = false
		setAnswer(undefined)
		void fetchMyAnswer(eventId, accountId)
			.then((type) => {
				if (!cancelled) setAnswer(type === 3 ? null : type)
			})
			.catch(() => {
				if (!cancelled) setAnswer(null)
			})
		return () => {
			cancelled = true
		}
	}, [eventId, accountId])

	const respond = async (type: number) => {
		setPending(type)
		setError('')
		try {
			const result = await call<{ PlayerEvent?: { AttendeeCount?: number } }>(
				`${where().api}/api/playerevents/v1/respond`,
				{ json: { PlayerEventId: eventId, Type: type }, authed: true }
			)
			setAnswer(type)
			const count = result.PlayerEvent?.AttendeeCount
			if (typeof count === 'number') onCount(count)
		} catch (e) {
			setError(e instanceof Error ? e.message : String(e))
		} finally {
			setPending(null)
		}
	}

	return (
		<>
			<div className="rsvp" role="group" aria-label="Your answer">
				{ANSWERS.map(({ type, label }) => (
					<button
						key={type}
						type="button"
						className={answer === type ? 'active' : ''}
						aria-pressed={answer === type}
						disabled={answer === undefined || pending !== null}
						onClick={() => void respond(type)}
					>
						{pending === type ? 'Saving…' : label}
					</button>
				))}
			</div>
			{error && <p className="error">{error}</p>}
		</>
	)
}
