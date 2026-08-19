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

import { glyphLength, MAX_EVENT_DESCRIPTION_LENGTH, MAX_EVENT_NAME_LENGTH } from '@repo/domain'

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
	`CREATE TABLE IF NOT EXISTS event_tag (
		event_id INTEGER NOT NULL,
		tag TEXT NOT NULL,
		type INTEGER NOT NULL DEFAULT 0,
		PRIMARY KEY (event_id, tag)
	)`,
	`CREATE INDEX IF NOT EXISTS idx_event_tag_tag ON event_tag (tag)`,
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

/**
 * One player's answer to one event.
 *
 * `id` is the row's SQLite `rowid` — the table has a composite primary key, so it's a
 * rowid table and the implicit id is free. It's what the RSVP list serves as
 * `PlayerEventResponseId`, and it's stable: a changed answer is an UPDATE through the
 * composite key (same rowid), and nothing ever deletes an RSVP row.
 */
export interface EventAttendeeRow {
	id: number
	event_id: number
	player_id: number
	status: number
	responded_at: string
}

/**
 * One RSVP as `GET /api/playerevents/v1/:eventId/responses` serves it — the PascalCase
 * projection of an `event_attendee` row.
 *
 * `CreatedAt` is the stored `responded_at`, so it's the time of the answer CURRENTLY
 * recorded, not of the player's first one: changing your mind updates the row in place
 * (one row per player per event), and the client shows the answer that stands.
 */
export interface PlayerEventResponse {
	PlayerEventResponseId: number
	PlayerEventId: number
	PlayerId: number
	CreatedAt: string
	Type: number
}

/** Project an RSVP row into the response the RSVP list serves. */
export function toEventResponse(row: EventAttendeeRow): PlayerEventResponse {
	return {
		PlayerEventResponseId: row.id,
		PlayerEventId: row.event_id,
		PlayerId: row.player_id,
		CreatedAt: row.responded_at,
		Type: row.status,
	}
}

/**
 * One tag on an event — the categories the browse screen's filter chips name
 * (`workshops`, `meetup`, …). `tag` is stored and matched lowercased; `type` is the
 * client's tag-category int, echoed back as sent (its enum isn't reversed yet).
 *
 * Tags live in their own table, NOT on the event blob: the blob is the DTO every read
 * serves verbatim, and tags surface only behind `includeDetails=True`.
 */
export interface EventTag {
	tag: string
	type: number
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
 * The event as the `v2` envelope carries it: {@link PlayerEventBase} plus `Tags`, a plain
 * array of tag NAMES. (The stored tags are `{ tag, type }` pairs, which is what the v1
 * read's lowercase `tags` serves.) Defined on top of the base rather than beside it, so the
 * feed and the envelope cannot drift apart on the fields they share.
 */
export interface PlayerEventEnvelope extends PlayerEventBase {
	Tags: string[]
}

/**
 * The envelope the `v2` routes answer with — the event nested under a status, rather than
 * the bare record the `v1` reads serve. `Result` is 0 on success.
 *
 * `TagModifyResult` reports the tag edit that rides along with a write: its `Result` is 0
 * and its `Tags` echo the tags the event now carries, which is what the client redraws its
 * tag chips from. It is an OBJECT — it used to be served as null, back when no event tags
 * were stored.
 */
export interface PlayerEventResult {
	PlayerEvent: PlayerEventEnvelope
	Result: number
	TagModifyResult: { Result: number; Tags: string[] }
}

/**
 * Wrap a stored event and its tags in the `v2` envelope. `tags` are the event's stored tag
 * names — pass what `getEventTags` returns, so the answer reflects what was actually
 * written rather than what was asked for.
 */
export function toEventResult(event: PlayerEvent, tags: EventTag[] = []): PlayerEventResult {
	const names = tags.map((t) => t.tag)
	return {
		PlayerEvent: { Tags: names, ...toEventBase(event) },
		Result: 0,
		TagModifyResult: { Result: 0, Tags: names },
	}
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

/**
 * The client's BASE event — the 17-key shape the browse feed (`GET /api/playerevents/v1`)
 * serves, and the same thing the v2 envelope carries once `Tags` is added. PascalCase like
 * the stored record, but not identical to it — don't unify them:
 *
 * - it drops `State`, which neither the feed nor the envelope carries;
 * - it carries `BroadcastingRoomInstanceId`, which the record has no field for (nothing
 *   broadcasts an event yet, so it is always null);
 * - its `ImageName` is a string: an event with no image reads `""`, where the record holds
 *   null.
 *
 * The by-id / bulk / search reads serve the stored RECORD verbatim instead, `State` and
 * nullable `ImageName` included. Two shapes; keep them apart.
 */
export interface PlayerEventBase extends Omit<PlayerEvent, 'State' | 'ImageName'> {
	ImageName: string
	BroadcastingRoomInstanceId: number | null
}

/** Project a stored event into the base shape the feed serves and the envelope wraps. */
export function toEventBase(event: PlayerEvent): PlayerEventBase {
	const { State: _State, ...rest } = event
	return { ...rest, ImageName: event.ImageName ?? '', BroadcastingRoomInstanceId: null }
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
 *
 * `tags` are passed in rather than read from the event: they live in their own table,
 * and the callers that have them already looked them up.
 */
export function toEventNotification(
	event: PlayerEvent,
	tags: EventTag[] = []
): PlayerEventNotification {
	return {
		tags,
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

/** An event's tags, alphabetical so a list read is stable. */
export async function getEventTags(db: D1Database, eventId: number): Promise<EventTag[]> {
	const { results } = await db
		.prepare('SELECT tag, type FROM event_tag WHERE event_id = ?1 ORDER BY tag')
		.bind(eventId)
		.all<EventTag>()
	return results
}

/**
 * Replace an event's tags with the given set — the tag edit that rides along with a
 * create or update. A replace, not a merge: the client posts the whole set it wants,
 * so an untagging is a post with the tag left out.
 */
export async function setEventTags(
	db: D1Database,
	eventId: number,
	tags: EventTag[]
): Promise<void> {
	const statements = [db.prepare('DELETE FROM event_tag WHERE event_id = ?1').bind(eventId)]
	for (const { tag, type } of tags) {
		statements.push(
			db
				.prepare(
					`INSERT INTO event_tag (event_id, tag, type) VALUES (?1, ?2, ?3)
					 ON CONFLICT (event_id, tag) DO UPDATE SET type = ?3`
				)
				.bind(eventId, tag, type)
		)
	}
	await db.batch(statements)
}

/**
 * Fields a create or update supplies, camelCased. Every one is optional: create
 * defaults what's missing, and update leaves anything absent at its stored value —
 * which is why the nullable ids are `number | null` rather than merely absent, so a
 * posted `"ClubId": null` can genuinely clear a club.
 */
export interface EventInput {
	/** The whole tag set to store; absent leaves the event's tags alone. */
	tags?: EventTag[]
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

/**
 * Read the `Tags` a create/update body carries, or undefined when it carries none (an
 * update that says nothing about tags leaves them alone; `[]` genuinely clears them).
 *
 * Both forms in circulation are accepted — a bare string (`"workshops"`) and the
 * `{ tag, type }` object the notification frame carries — since the browse chips are
 * plain names while the client's own event model pairs each with a category int. Tags
 * are lowercased (the search matches them lowercased, and `#Workshops` and `#workshops`
 * are the same chip), a leading `#` is stripped, and blanks/duplicates are dropped.
 */
function parseEventTags(raw: unknown): EventTag[] | undefined {
	if (!Array.isArray(raw)) return undefined
	const byTag = new Map<string, EventTag>()
	for (const entry of raw) {
		const source = (typeof entry === 'object' && entry !== null ? entry : {}) as Record<
			string,
			unknown
		>
		const name = typeof entry === 'string' ? entry : (source.tag ?? source.Tag)
		if (typeof name !== 'string') continue
		const tag = name.trim().replace(/^#/, '').toLowerCase()
		if (tag === '') continue
		byTag.set(tag, { tag, type: asInt(source.type ?? source.Type) ?? 0 })
	}
	return [...byTag.values()]
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
		tags: parseEventTags(obj.Tags ?? obj.tags),
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
	// Tags ride along with the write but live in their own table — they are not part of
	// the stored blob, since that blob is the DTO every read serves verbatim.
	if (input.tags !== undefined) await setEventTags(db, event.PlayerEventId, input.tags)
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

/**
 * Add invited players to an event as Going — the bulk invite. Returns the updated
 * event (with its recounted `AttendeeCount`) and the rows actually created, or null
 * when there's no such event.
 *
 * An invite only ever INSERTS: a player who already has a row keeps the answer they
 * gave, so being invited can't flip a decline back to Going, and re-inviting the same
 * player is a no-op rather than a reset. Since the rows land as Going, the invited
 * count toward `AttendeeCount` from the moment they're invited — see the route.
 *
 * `added` is what `RETURNING` gave back, so it holds exactly the new rows: a conflict
 * inserts nothing and returns nothing. That's what the route notifies on — a player
 * whose existing answer was left alone gets no frame, because nothing changed for them.
 *
 * Ids are deduplicated by the composite primary key; an empty list is a no-op that
 * still returns the event.
 */
export async function inviteToEvent(
	db: D1Database,
	eventId: number,
	playerIds: number[]
): Promise<{ event: PlayerEvent; added: EventAttendeeRow[] } | null> {
	const event = await getEventById(db, eventId)
	if (event === null) return null
	if (playerIds.length === 0) return { event, added: [] }

	const at = eventTime(Date.now())
	const inserts = await db.batch<EventAttendeeRow>(
		playerIds.map((playerId) =>
			db
				.prepare(
					`INSERT INTO event_attendee (event_id, player_id, status, responded_at)
					 VALUES (?1, ?2, ?3, ?4)
					 ON CONFLICT (event_id, player_id) DO NOTHING
					 RETURNING rowid AS id, *`
				)
				.bind(eventId, playerId, EVENT_RESPONSE.going, at)
		)
	)
	const added = inserts.flatMap((r) => r.results)

	const updated: PlayerEvent = { ...event, AttendeeCount: await countGoing(db, eventId) }
	await writeEvent(db, updated)
	return { event: updated, added }
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
		.prepare('SELECT rowid AS id, * FROM event_attendee WHERE event_id = ?1 AND player_id = ?2')
		.bind(eventId, playerId)
		.first<EventAttendeeRow>()
}

/**
 * Everyone who answered an event, in the order they responded — the guest list behind
 * `GET /api/playerevents/v1/:eventId/responses`. Ties on the timestamp (the creator's
 * own Going row shares its second with a fast first RSVP) break on the player id, so
 * the order is stable.
 */
export async function getEventAttendees(
	db: D1Database,
	eventId: number
): Promise<EventAttendeeRow[]> {
	const { results } = await db
		.prepare(
			`SELECT rowid AS id, * FROM event_attendee
			 WHERE event_id = ?1 ORDER BY responded_at, player_id`
		)
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
	// A body that says nothing about tags leaves them alone, like every other field
	// here; an explicit `[]` clears them.
	if (input.tags !== undefined) await setEventTags(db, eventId, input.tags)
	return updated
}

/**
 * Delete an event and everything hanging off it — its RSVPs (`event_attendee`) and its tags
 * (`event_tag`) — in one batch, so a cancelled event can't leave rows behind that the
 * attendee counts and the `#tag` search would still find. Event ids are assigned in
 * sequence and never reused, but orphan rows would still be counted against whatever id
 * they name.
 *
 * Answers the event as it was, so the caller can report what it deleted; `null` when there
 * was no such event.
 */
export async function deleteEvent(db: D1Database, eventId: number): Promise<PlayerEvent | null> {
	const event = await getEventById(db, eventId)
	if (event === null) return null
	await db.batch([
		db.prepare('DELETE FROM event_attendee WHERE event_id = ?1').bind(eventId),
		db.prepare('DELETE FROM event_tag WHERE event_id = ?1').bind(eventId),
		db.prepare('DELETE FROM event WHERE id = ?1').bind(eventId),
	])
	return event
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
 * Event search — the browse query on the player-events screen. Term by term, an empty
 * query browsing everything upcoming; paginated via skip/take, soonest first.
 *
 * A term is matched one of two ways, and the `#` decides which:
 *
 * - `#workshops` is a TAG term — it matches only an event tagged `workshops`, and never
 *   the word appearing in a name or description. That's what the browse screen's filter
 *   chips send.
 * - `workshops` is a TEXT term, matched case-insensitively against the name and the
 *   description, as before.
 *
 * Every term has to match, and the two kinds combine: `#workshops trigonometry` is the
 * workshops-tagged events whose text also mentions trigonometry.
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
	const terms = query.trim().toLowerCase().split(/\s+/).filter(Boolean)
	// A `#` prefix makes a term a tag; the rest are matched against the text. A bare `#`
	// is dropped rather than treated as a tag nothing can carry.
	const tags = terms.filter((t) => t.startsWith('#')).map((t) => t.slice(1))
	const textTerms = terms.filter((t) => !t.startsWith('#'))

	// end_time is a generated column of an ISO-8601 UTC string, so it compares
	// lexicographically — that filter stays in SQL, and so does the tag one: an event
	// has to carry EVERY tag asked for, which is the count of matching tag rows.
	const wanted = tags.filter(Boolean)
	const sql =
		wanted.length === 0
			? 'SELECT data FROM event WHERE end_time >= ?1'
			: `SELECT data FROM event WHERE end_time >= ?1 AND (
					SELECT COUNT(DISTINCT tag) FROM event_tag
					WHERE event_tag.event_id = event.id
					  AND tag IN (${wanted.map((_, i) => `?${i + 2}`).join(', ')})
				) = ${wanted.length}`
	const { results } = await db
		.prepare(sql)
		.bind(eventTime(Date.now()), ...wanted)
		.all<EventRow>()
	let events = results.map((r) => JSON.parse(r.data) as PlayerEvent)

	for (const term of textTerms) {
		events = events.filter(
			(e) => e.Name.toLowerCase().includes(term) || e.Description.toLowerCase().includes(term)
		)
	}

	return events.sort(bySoonest).slice(skip, skip + take)
}
