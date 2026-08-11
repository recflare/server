/**
 * Player-event storage on the shared `recflare` D1 database. Each event is a single
 * JSON blob in the `data` column; queryable fields (id, creator, club, start time)
 * are SQLite generated (virtual) columns extracted from that JSON — the same
 * JSON-blob pattern the image/invention/rooms/accounts tables use.
 *
 * The `api` worker owns this schema/migration (migrations/0006_event.sql and
 * 0007_event_attendee.sql, applied under its own `migrations_table` so they don't
 * clash with the other workers' migrations on the shared database).
 *
 * The stored record IS the DTO: every read endpoint serves the blob verbatim, so the
 * field set and casing here are exactly what the client parses. Timestamps are
 * normalized to `2020-11-29T22:00:00Z` (no fractional seconds) to match.
 *
 * RSVPs live alongside in `event_attendee`, one row per player per event. That one is
 * genuinely columnar (like the relationship/report tables), so it's a normal
 * relational table rather than a JSON blob.
 */

import {
	glyphLength,
	MAX_EVENT_DESCRIPTION_LENGTH,
	MAX_EVENT_NAME_LENGTH,
} from '@repo/domain'

/**
 * Schema DDL (mirror of migrations/0006_event.sql + 0007_event_attendee.sql, sans any
 * seed rows).
 */
export const SCHEMA_DDL: string[] = [
	`CREATE TABLE IF NOT EXISTS event (
		data TEXT NOT NULL,
		id INTEGER GENERATED ALWAYS AS (json_extract(data, '$.PlayerEventId')) VIRTUAL,
		creator_player_id INTEGER GENERATED ALWAYS AS (json_extract(data, '$.CreatorPlayerId')) VIRTUAL,
		room_id INTEGER GENERATED ALWAYS AS (json_extract(data, '$.RoomId')) VIRTUAL,
		club_id INTEGER GENERATED ALWAYS AS (json_extract(data, '$.ClubId')) VIRTUAL,
		start_time TEXT GENERATED ALWAYS AS (json_extract(data, '$.StartTime')) VIRTUAL,
		end_time TEXT GENERATED ALWAYS AS (json_extract(data, '$.EndTime')) VIRTUAL
	)`,
	`CREATE UNIQUE INDEX IF NOT EXISTS idx_event_id ON event (id)`,
	`CREATE INDEX IF NOT EXISTS idx_event_creator ON event (creator_player_id)`,
	`CREATE INDEX IF NOT EXISTS idx_event_club ON event (club_id)`,
	`CREATE INDEX IF NOT EXISTS idx_event_start ON event (start_time)`,
	`CREATE TABLE IF NOT EXISTS event_attendee (
		event_id INTEGER NOT NULL,
		player_id INTEGER NOT NULL,
		status INTEGER NOT NULL,
		responded_at TEXT NOT NULL,
		PRIMARY KEY (event_id, player_id)
	)`,
	`CREATE INDEX IF NOT EXISTS idx_event_attendee_player ON event_attendee (player_id)`,
]

/**
 * How a player answered an event invitation — the `Type` on
 * `POST /api/playerevents/v1/respond`, stored as `event_attendee.status`.
 *
 * Only `going` counts toward an event's `AttendeeCount`: interested is a maybe, and
 * declining is recorded rather than deleted so the client can show the player their own
 * answer (and so changing your mind is an update, not an insert).
 */
export const EVENT_RESPONSE = {
	going: 0,
	interested: 1,
	cantGo: 2,
} as const

/** The response types, for validating an incoming `Type`. */
const EVENT_RESPONSE_VALUES: number[] = Object.values(EVENT_RESPONSE)

/** Whether a number is one of the three response types. */
export function isEventResponseType(value: number): boolean {
	return EVENT_RESPONSE_VALUES.includes(value)
}

/** One player's answer to one event. */
export interface EventAttendeeRow {
	event_id: number
	player_id: number
	status: number
	responded_at: string
}

/**
 * A scheduled player event (Rec Room's `PlayerEvent`) — a room, a window of time and
 * the settings the event runs under. Served verbatim by every read endpoint.
 *
 * `SubRoomId`/`ClubId`/`ImageName` are genuinely nullable: an event can name the room
 * without pinning a subroom, needn't belong to a club, and has no banner until one is
 * uploaded. The three `*Permissions`/`State`/`Accessibility` ints are stored as the
 * client sends them — their enums aren't reversed yet, so nothing here interprets
 * them beyond the defaults below.
 */
export interface PlayerEvent {
	PlayerEventId: number
	CreatorPlayerId: number
	ImageName: string | null
	RoomId: number
	SubRoomId: number | null
	ClubId: number | null
	Name: string
	Description: string
	/** ISO 8601 UTC, seconds precision (`2020-11-29T22:00:00Z`). */
	StartTime: string
	EndTime: string
	AttendeeCount: number
	State: number
	Accessibility: number
	IsMultiInstance: boolean
	SupportMultiInstanceRoomChat: boolean
	DefaultBroadcastPermissions: number
	CanRequestBroadcastPermissions: number
}

interface EventRow {
	data: string
}

/**
 * The envelope the create/update writes answer with — the event nested under a status,
 * rather than the bare record the read endpoints serve. `Result` is 0 on success.
 *
 * `TagModifyResult` is always null: the real API reports the outcome of the tag edit
 * that rides along with the write, and we store no event tags (see the tag-filter
 * chips, which are static). The field stays present because the client's parser
 * expects it.
 */
export interface PlayerEventResult {
	Result: number
	TagModifyResult: null
	PlayerEvent: PlayerEvent
}

/** Wrap a stored event in the write envelope. */
export function toEventResult(event: PlayerEvent): PlayerEventResult {
	return { Result: 0, TagModifyResult: null, PlayerEvent: event }
}

/**
 * The projection of an event carried on a hub notification frame (`PlayerEventCreated`
 * and its siblings). Deliberately NOT the stored record, in three ways — don't unify
 * them:
 *
 * - it is camelCase, where the record and every read endpoint are PascalCase;
 * - it carries `tags` and `broadcastingRoomInstanceId`, which the record has no fields
 *   for (no event tags are stored, and nothing broadcasts an event yet, so both are
 *   empty/null), and drops `State`;
 * - its timestamps are padded to .NET tick precision (`…T19:00:00.0000000Z`) while the
 *   record stores them bare. That asymmetry is the reference server's: its notification
 *   frames carry the padded form and its event reads don't.
 */
export interface PlayerEventNotification {
	tags: Array<{ tag: string; type: number }>
	playerEventId: number
	creatorPlayerId: number
	roomId: number
	subRoomId: number | null
	clubId: number | null
	name: string
	description: string
	imageName: string
	startTime: string
	endTime: string
	attendeeCount: number
	accessibility: number
	isMultiInstance: boolean
	supportMultiInstanceRoomChat: boolean
	defaultBroadcastPermissions: number
	canRequestBroadcastPermissions: number
	broadcastingRoomInstanceId: number | null
}

/** Pad a stored timestamp out to .NET tick precision (seven fractional digits). */
function toTickPrecision(iso: string): string {
	const match = /^(.*?)(?:\.(\d+))?Z$/.exec(iso)
	if (match === null) return iso
	return `${match[1]}.${(match[2] ?? '').padEnd(7, '0').slice(0, 7)}Z`
}

/**
 * Project a stored event into its notification frame. `imageName` becomes an empty
 * string rather than null when the event has no banner: the frame carries `""`, and a
 * null wouldn't survive the trip anyway — the hub drops null values from `Msg`.
 */
export function toEventNotification(event: PlayerEvent): PlayerEventNotification {
	return {
		tags: [],
		playerEventId: event.PlayerEventId,
		creatorPlayerId: event.CreatorPlayerId,
		roomId: event.RoomId,
		subRoomId: event.SubRoomId,
		clubId: event.ClubId,
		name: event.Name,
		description: event.Description,
		imageName: event.ImageName ?? '',
		startTime: toTickPrecision(event.StartTime),
		endTime: toTickPrecision(event.EndTime),
		attendeeCount: event.AttendeeCount,
		accessibility: event.Accessibility,
		isMultiInstance: event.IsMultiInstance,
		supportMultiInstanceRoomChat: event.SupportMultiInstanceRoomChat,
		defaultBroadcastPermissions: event.DefaultBroadcastPermissions,
		canRequestBroadcastPermissions: event.CanRequestBroadcastPermissions,
		broadcastingRoomInstanceId: null,
	}
}

/**
 * Normalize a timestamp to the form the client sends and reads back —
 * `2020-11-29T22:00:00Z`, with no fractional seconds. `toISOString()` always emits
 * milliseconds, which the samples never carry, so they're trimmed.
 */
function eventTime(ms: number): string {
	return new Date(ms).toISOString().replace(/\.\d{3}Z$/, 'Z')
}

/**
 * Fields a create or update supplies, camelCased. Every one is optional: create
 * defaults what's missing, and update leaves anything absent at its stored value —
 * which is why the nullable ids are `number | null` rather than merely absent, so a
 * posted `"ClubId": null` can genuinely clear a club.
 */
export interface EventInput {
	imageName?: string | null
	roomId?: number
	subRoomId?: number | null
	clubId?: number | null
	name?: string
	description?: string
	startTime?: string
	endTime?: string
	state?: number
	accessibility?: number
	isMultiInstance?: boolean
	supportMultiInstanceRoomChat?: boolean
	defaultBroadcastPermissions?: number
	canRequestBroadcastPermissions?: number
}

/** Read a value as an integer, or undefined when absent / not a number. */
function asInt(value: unknown): number | undefined {
	if (typeof value === 'number' && Number.isFinite(value)) return Math.trunc(value)
	if (typeof value === 'string') {
		const n = Number.parseInt(value, 10)
		if (!Number.isNaN(n)) return n
	}
	return undefined
}

/**
 * Parse a posted event body into an {@link EventInput}.
 *
 * Accepts the event's fields either at the top level or nested under `PlayerEvent`:
 * the client posts the same envelope it reads back, and both forms are in circulation.
 * A field the body doesn't carry stays undefined (create defaults it, update keeps the
 * stored value); an explicit `null` on one of the nullable ids is preserved so it can
 * clear the value. Timestamps are normalized here, so an unparseable one is dropped
 * rather than stored.
 */
/**
 * Why a parsed event body can't be stored, or `null` when it's fine.
 *
 * Length only. An event name is a title, not an identifier — "Building a Better Room
 * Using Trigonometry" is a real one — so the alphanumeric rule the account and room
 * names carry would be wrong here. Absent fields are skipped: an update posts only what
 * it changes, and create defaults a missing name rather than refusing it.
 *
 * The name is measured AFTER trimming, matching what create/update actually store.
 */
export function eventInputRejection(input: EventInput): string | null {
	const name = input.name?.trim()
	if (name !== undefined && glyphLength(name) > MAX_EVENT_NAME_LENGTH) {
		return `Event names can be at most ${MAX_EVENT_NAME_LENGTH} characters.`
	}
	if (
		input.description !== undefined &&
		glyphLength(input.description) > MAX_EVENT_DESCRIPTION_LENGTH
	) {
		return `Event descriptions can be at most ${MAX_EVENT_DESCRIPTION_LENGTH} characters.`
	}
	return null
}

export function parseEventBody(body: unknown): EventInput {
	const outer = (typeof body === 'object' && body !== null ? body : {}) as Record<string, unknown>
	const nested = outer.PlayerEvent
	const obj = (typeof nested === 'object' && nested !== null ? nested : outer) as Record<
		string,
		unknown
	>

	const has = (key: string): boolean => Object.hasOwn(obj, key)
	// A nullable id: absent leaves it alone, an explicit null clears it.
	const nullableInt = (key: string): number | null | undefined => {
		if (!has(key)) return undefined
		return obj[key] === null ? null : asInt(obj[key])
	}
	const time = (key: string): string | undefined => {
		const raw = obj[key]
		if (typeof raw !== 'string') return undefined
		const parsed = Date.parse(raw)
		return Number.isNaN(parsed) ? undefined : eventTime(parsed)
	}
	const bool = (key: string): boolean | undefined => {
		const raw = obj[key]
		if (typeof raw === 'boolean') return raw
		if (raw === 'true') return true
		if (raw === 'false') return false
		return undefined
	}
	// The banner name: same absent/null distinction as the nullable ids.
	const nullableString = (key: string): string | null | undefined => {
		if (!has(key)) return undefined
		if (obj[key] === null) return null
		return typeof obj[key] === 'string' ? (obj[key] as string) : undefined
	}

	return {
		imageName: nullableString('ImageName'),
		roomId: asInt(obj.RoomId),
		subRoomId: nullableInt('SubRoomId'),
		clubId: nullableInt('ClubId'),
		name: typeof obj.Name === 'string' ? obj.Name : undefined,
		description: typeof obj.Description === 'string' ? obj.Description : undefined,
		startTime: time('StartTime'),
		endTime: time('EndTime'),
		state: asInt(obj.State),
		accessibility: asInt(obj.Accessibility),
		isMultiInstance: bool('IsMultiInstance'),
		supportMultiInstanceRoomChat: bool('SupportMultiInstanceRoomChat'),
		defaultBroadcastPermissions: asInt(obj.DefaultBroadcastPermissions),
		canRequestBroadcastPermissions: asInt(obj.CanRequestBroadcastPermissions),
	}
}

/** How long an event runs when the body names a start but no end. */
const DEFAULT_DURATION_MS = 60 * 60 * 1000

/**
 * Insert a new event, returning the stored record.
 *
 * Lenient about what the body carries, like the other writes here: an event with no
 * name or no time window is defaulted rather than rejected, because a rejection the
 * client can't render is worse than a placeholder the creator can edit. `State` starts
 * at 0 (scheduled). The creator comes from the bearer token, never the body.
 *
 * The creator is recorded as Going in `event_attendee`, which is what makes
 * `AttendeeCount` start at 1: the count is derived from that table, so the creator
 * needs a row there for the number to stay right once other players respond.
 */
export async function createEvent(
	db: D1Database,
	creatorPlayerId: number,
	input: EventInput
): Promise<PlayerEvent> {
	// Sequential id: one past the current max (the table starts empty).
	const row = await db
		.prepare('SELECT COALESCE(MAX(id), 0) + 1 AS next FROM event')
		.first<{ next: number }>()
	const now = Date.now()
	const startTime = input.startTime ?? eventTime(now)
	const event: PlayerEvent = {
		PlayerEventId: row?.next ?? 1,
		CreatorPlayerId: creatorPlayerId,
		ImageName: input.imageName ?? null,
		RoomId: input.roomId ?? 0,
		SubRoomId: input.subRoomId ?? null,
		ClubId: input.clubId ?? null,
		Name: input.name?.trim() || 'Untitled Event',
		Description: input.description ?? '',
		StartTime: startTime,
		EndTime: input.endTime ?? eventTime(Date.parse(startTime) + DEFAULT_DURATION_MS),
		AttendeeCount: 1,
		State: input.state ?? 0,
		Accessibility: input.accessibility ?? 1,
		IsMultiInstance: input.isMultiInstance ?? false,
		SupportMultiInstanceRoomChat: input.supportMultiInstanceRoomChat ?? false,
		DefaultBroadcastPermissions: input.defaultBroadcastPermissions ?? 0,
		CanRequestBroadcastPermissions: input.canRequestBroadcastPermissions ?? 0,
	}
	await db.batch([
		db.prepare('INSERT INTO event (data) VALUES (?1)').bind(JSON.stringify(event)),
		db
			.prepare(
				`INSERT INTO event_attendee (event_id, player_id, status, responded_at)
				 VALUES (?1, ?2, ?3, ?4)`
			)
			.bind(event.PlayerEventId, creatorPlayerId, EVENT_RESPONSE.going, eventTime(now)),
	])
	return event
}

/**
 * Record a player's answer to an event, replacing whatever they said before — one row
 * per player per event, so changing your mind is an update rather than a second RSVP.
 * The event's `AttendeeCount` is recomputed from the table afterwards.
 *
 * Returns the updated event, or null when there's no such event. Anyone who can see an
 * event may respond to it, the creator included (they're already Going from create, and
 * nothing stops them declining their own event).
 */
export async function setEventResponse(
	db: D1Database,
	eventId: number,
	playerId: number,
	status: number
): Promise<PlayerEvent | null> {
	const event = await getEventById(db, eventId)
	if (event === null) return null

	await db
		.prepare(
			`INSERT INTO event_attendee (event_id, player_id, status, responded_at)
			 VALUES (?1, ?2, ?3, ?4)
			 ON CONFLICT (event_id, player_id) DO UPDATE SET status = ?3, responded_at = ?4`
		)
		.bind(eventId, playerId, status, eventTime(Date.now()))
		.run()

	const updated: PlayerEvent = { ...event, AttendeeCount: await countGoing(db, eventId) }
	await writeEvent(db, updated)
	return updated
}

/** How many players said they're Going — an event's `AttendeeCount`. */
export async function countGoing(db: D1Database, eventId: number): Promise<number> {
	const row = await db
		.prepare('SELECT COUNT(*) AS going FROM event_attendee WHERE event_id = ?1 AND status = ?2')
		.bind(eventId, EVENT_RESPONSE.going)
		.first<{ going: number }>()
	return row?.going ?? 0
}

/** One player's answer to one event, or null when they haven't responded. */
export async function getEventResponse(
	db: D1Database,
	eventId: number,
	playerId: number
): Promise<EventAttendeeRow | null> {
	return db
		.prepare('SELECT * FROM event_attendee WHERE event_id = ?1 AND player_id = ?2')
		.bind(eventId, playerId)
		.first<EventAttendeeRow>()
}

/** Everyone who answered an event, in the order they responded. Backs a future guest list. */
export async function getEventAttendees(
	db: D1Database,
	eventId: number
): Promise<EventAttendeeRow[]> {
	const { results } = await db
		.prepare('SELECT * FROM event_attendee WHERE event_id = ?1 ORDER BY responded_at, player_id')
		.bind(eventId)
		.all<EventAttendeeRow>()
	return results
}

/** Overwrite an event's stored blob in place. */
async function writeEvent(db: D1Database, event: PlayerEvent): Promise<void> {
	await db
		.prepare('UPDATE event SET data = ?1 WHERE id = ?2')
		.bind(JSON.stringify(event), event.PlayerEventId)
		.run()
}

/**
 * Apply an edit to an event. Only the fields the body carried change; everything else
 * keeps its stored value, so a partial post can't blank out the rest of the event.
 * The id, the creator and the attendee count are not editable — ownership doesn't
 * transfer and RSVPs aren't set by hand. Returns the updated event, or null when
 * there's no such row.
 */
export async function updateEvent(
	db: D1Database,
	eventId: number,
	input: EventInput
): Promise<PlayerEvent | null> {
	const event = await getEventById(db, eventId)
	if (event === null) return null

	const updated: PlayerEvent = {
		...event,
		ImageName: input.imageName === undefined ? event.ImageName : input.imageName,
		RoomId: input.roomId ?? event.RoomId,
		SubRoomId: input.subRoomId === undefined ? event.SubRoomId : input.subRoomId,
		ClubId: input.clubId === undefined ? event.ClubId : input.clubId,
		Name: input.name?.trim() || event.Name,
		Description: input.description ?? event.Description,
		StartTime: input.startTime ?? event.StartTime,
		EndTime: input.endTime ?? event.EndTime,
		State: input.state ?? event.State,
		Accessibility: input.accessibility ?? event.Accessibility,
		IsMultiInstance: input.isMultiInstance ?? event.IsMultiInstance,
		SupportMultiInstanceRoomChat:
			input.supportMultiInstanceRoomChat ?? event.SupportMultiInstanceRoomChat,
		DefaultBroadcastPermissions:
			input.defaultBroadcastPermissions ?? event.DefaultBroadcastPermissions,
		CanRequestBroadcastPermissions:
			input.canRequestBroadcastPermissions ?? event.CanRequestBroadcastPermissions,
	}
	await writeEvent(db, updated)
	return updated
}

/** One event by id, or null when there's no such row. */
export async function getEventById(db: D1Database, eventId: number): Promise<PlayerEvent | null> {
	const row = await db
		.prepare('SELECT data FROM event WHERE id = ?1')
		.bind(eventId)
		.first<EventRow>()
	return row ? (JSON.parse(row.data) as PlayerEvent) : null
}

/**
 * Several events by id — the bulk fetch. Answers in the order the ids were asked for
 * (the client renders them in the order it requested), skipping ids with no row rather
 * than leaving a hole. Duplicated ids resolve to the same event.
 */
export async function getEventsByIds(db: D1Database, ids: number[]): Promise<PlayerEvent[]> {
	if (ids.length === 0) return []
	const placeholders = ids.map((_, i) => `?${i + 1}`).join(', ')
	const { results } = await db
		.prepare(`SELECT data FROM event WHERE id IN (${placeholders})`)
		.bind(...ids)
		.all<EventRow>()
	const byId = new Map<number, PlayerEvent>()
	for (const r of results) {
		const event = JSON.parse(r.data) as PlayerEvent
		byId.set(event.PlayerEventId, event)
	}
	return ids.map((id) => byId.get(id)).filter((e): e is PlayerEvent => e !== undefined)
}

/**
 * The events a player created — their "my events" list, soonest first. Uses the
 * creator_player_id index; the per-player set is small, so ordering is done in memory.
 */
export async function getEventsByCreator(
	db: D1Database,
	creatorPlayerId: number
): Promise<PlayerEvent[]> {
	const { results } = await db
		.prepare('SELECT data FROM event WHERE creator_player_id = ?1')
		.bind(creatorPlayerId)
		.all<EventRow>()
	return results.map((r) => JSON.parse(r.data) as PlayerEvent).sort(bySoonest)
}

/**
 * The events belonging to a set of clubs — the events shelf on a club's page, soonest
 * first. Selected on the indexed club_id column. An empty id list is an empty shelf
 * rather than every event.
 */
export async function getEventsByClubs(db: D1Database, clubIds: number[]): Promise<PlayerEvent[]> {
	if (clubIds.length === 0) return []
	const placeholders = clubIds.map((_, i) => `?${i + 1}`).join(', ')
	const { results } = await db
		.prepare(`SELECT data FROM event WHERE club_id IN (${placeholders})`)
		.bind(...clubIds)
		.all<EventRow>()
	return results.map((r) => JSON.parse(r.data) as PlayerEvent).sort(bySoonest)
}

/**
 * The events happening right now — started and not yet finished. Backs the "happening
 * now" browse query. Both bounds compare lexicographically on the generated ISO-8601
 * columns, so the whole filter stays in SQL.
 */
export async function getLiveEvents(db: D1Database, now = Date.now()): Promise<PlayerEvent[]> {
	const at = eventTime(now)
	const { results } = await db
		.prepare('SELECT data FROM event WHERE start_time <= ?1 AND end_time >= ?1')
		.bind(at)
		.all<EventRow>()
	return results.map((r) => JSON.parse(r.data) as PlayerEvent).sort(bySoonest)
}

/** Soonest start first; ties broken by id so paging is stable. */
function bySoonest(a: PlayerEvent, b: PlayerEvent): number {
	return a.StartTime.localeCompare(b.StartTime) || a.PlayerEventId - b.PlayerEventId
}

/**
 * Event search — the browse query on the player-events screen. `query` is matched
 * case-insensitively against the name and description, term by term; an empty query
 * browses everything upcoming. Paginated via skip/take, soonest first.
 *
 * Events that have already finished are excluded: this backs a browse screen, where a
 * name match on something that ended last month is noise. The per-event history a
 * creator wants comes from `getEventsByCreator`, which keeps them.
 */
export async function searchEvents(
	db: D1Database,
	query: string,
	skip: number,
	take: number
): Promise<PlayerEvent[]> {
	// end_time is a generated column of an ISO-8601 UTC string, so it compares
	// lexicographically — the filter stays in SQL.
	const { results } = await db
		.prepare('SELECT data FROM event WHERE end_time >= ?1')
		.bind(eventTime(Date.now()))
		.all<EventRow>()
	let events = results.map((r) => JSON.parse(r.data) as PlayerEvent)

	const terms = query.trim().toLowerCase().split(/\s+/).filter(Boolean)
	for (const term of terms) {
		events = events.filter(
			(e) => e.Name.toLowerCase().includes(term) || e.Description.toLowerCase().includes(term)
		)
	}

	return events.sort(bySoonest).slice(skip, skip + take)
}
