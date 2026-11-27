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
	Accessibility,
	glyphLength,
	MAX_EVENT_DESCRIPTION_LENGTH,
	MAX_EVENT_DURATION_MS,
	MAX_EVENT_NAME_LENGTH,
} from '@repo/domain'

/**
 * Schema DDL (mirror of migrations/0006_event.sql + 0007_event_attendee.sql +
 * 0010_event_tag.sql + 0028_event_id_seq.sql + 0038_event_broadcast.sql, sans any seed
 * rows).
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
	`CREATE INDEX IF NOT EXISTS idx_event_room ON event (room_id)`,
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
	// The id sequence: AUTOINCREMENT so an id is never handed out twice, whatever gets
	// deleted. See {@link nextEventId}. The migration also seeds it past the existing
	// events; on a fresh database there are none, so the seed is omitted here.
	`CREATE TABLE IF NOT EXISTS event_id_seq (
		id INTEGER PRIMARY KEY AUTOINCREMENT
	)`,
	// The broadcast running for an event, if any: one row per event, written only by
	// `match` (`POST /tachyon/broadcast`) when the room server starts or stops one. Its own
	// table rather than a key on the blob, because every edit rewrites the blob whole and a
	// broadcast starting mid-edit must be neither lost nor brought back by it. Reads join
	// it in through EVENT_COLUMNS.
	`CREATE TABLE IF NOT EXISTS event_broadcast (
		event_id INTEGER PRIMARY KEY,
		room_instance_id INTEGER NOT NULL,
		broadcaster_id INTEGER NOT NULL,
		started_at TEXT NOT NULL
	)`,
]

/**
 * What every event read selects: the stored blob with `BroadcastingRoomInstanceId` set from
 * `event_broadcast` (JSON null while nothing is broadcasting). Pair it with
 * {@link withBroadcast} over the same table or alias. The key is never stored (see
 * {@link writeEvent}), so the blob stays the record, and every projection, the raw reads
 * included, carries the live value without a second query.
 */
function eventColumns(table = 'event'): string {
	return `json_set(${table}.data, '$.BroadcastingRoomInstanceId', event_broadcast.room_instance_id) AS data`
}

/** The join behind {@link eventColumns}. */
function withBroadcast(table = 'event'): string {
	return `LEFT JOIN event_broadcast ON event_broadcast.event_id = ${table}.id`
}

/** `SELECT ${EVENT_COLUMNS} WHERE …` — {@link eventColumns} over the bare `event` table. */
const EVENT_COLUMNS = `${eventColumns()} FROM event ${withBroadcast()}`

/**
 * How a player answered an event invitation — the `Type` on
 * `POST /api/playerevents/v1/respond`, stored as `event_attendee.status`.
 *
 * Only `going` counts toward an event's `AttendeeCount`: interested is a maybe, and
 * declining is recorded rather than deleted so the client can show the player their own
 * answer (and so changing your mind is an update, not an insert).
 *
 * `pending` is not an answer: it's the row a bulk invite writes for the invitee, before
 * they've said anything. It's what the client shows as an open invitation — an invite
 * that landed as Going looked like the player had already accepted. Only the server
 * writes it; `respond` won't take it as a `Type`.
 */
export const EVENT_RESPONSE = {
	going: 0,
	interested: 1,
	cantGo: 2,
	pending: 3,
} as const

/** The answers a player may give — every type but `pending`, for validating an incoming `Type`. */
const EVENT_ANSWER_VALUES: number[] = [
	EVENT_RESPONSE.going,
	EVENT_RESPONSE.interested,
	EVENT_RESPONSE.cantGo,
]

/** Whether a number is one of the three answers a player can give (never `pending`). */
export function isEventResponseType(value: number): boolean {
	return EVENT_ANSWER_VALUES.includes(value)
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
	/**
	 * The room instance the event is being broadcast from, or null. The 2026 client reads
	 * `PlayerEvent.IsBroadcasting` as this having a value. NOT stored on the blob: every read
	 * fills it in from `event_broadcast` ({@link EVENT_COLUMNS}), which only the room
	 * server's report writes, and {@link writeEvent} drops it again. Optional because a
	 * record that was just built (a create) has not been read back yet.
	 */
	BroadcastingRoomInstanceId?: number | null
}

interface EventRow {
	data: string
}

/**
 * A tag as the `v2` envelope carries it to a build newer than 20230414: the PascalCase
 * form of the stored `{ tag, type }` pair. NOT the lowercase pair the v1 read serves —
 * three casings of one tag, and the client parses each in exactly one place.
 */
export interface PlayerEventEnvelopeTag {
	Tag: string
	Type: number
}

/**
 * The event as the `v2` envelope carries it: {@link PlayerEventBase} plus `Tags`. Defined
 * on top of the base rather than beside it, so the feed and the envelope cannot drift
 * apart on the fields they share.
 *
 * `Tags` is the one field whose shape depends on the caller's BUILD, because Rec Room
 * changed it under the same unversioned path rather than minting a `v3`: the 2023 build
 * (20230414 and older) parses `["celebration"]` and anything newer parses
 * `[{ Tag, Type }]`. Serving either one to the other build leaves the event's tag chips
 * empty — the decoder drops what it can't read rather than erroring.
 * {@link toEventResult} picks; nothing else should. `TagModifyResult.Tags` is NOT part of
 * this: it is a `List<string>` to every build.
 */
export interface PlayerEventEnvelope extends PlayerEventBase {
	Tags: string[] | PlayerEventEnvelopeTag[]
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
 * Wrap a stored event and its tags in the `v2` envelope. `tags` are the event's stored
 * tags — pass what `getEventTags` returns, so the answer reflects what was actually
 * written rather than what was asked for.
 *
 * `pairedTags` picks the shape of `PlayerEvent.Tags` for the caller's build (see
 * {@link PlayerEventEnvelope}): the `{ Tag, Type }` pairs of a build newer than 20230414
 * when set, the 2023 build's bare names when not. It changes nothing else —
 * `TagModifyResult.Tags` is a name list to both builds.
 */
export function toEventResult(
	event: PlayerEvent,
	tags: EventTag[] = [],
	pairedTags = false
): PlayerEventResult {
	const names = tags.map((t) => t.tag)
	const carried = pairedTags ? tags.map((t) => ({ Tag: t.tag, Type: t.type })) : names
	return {
		PlayerEvent: { Tags: carried, ...toEventBase(event) },
		Result: 0,
		TagModifyResult: { Result: 0, Tags: names },
	}
}

/**
 * The envelope a DELETE answers with. Both payload fields are null: the reference reports
 * only that the delete happened, and the client reads nothing but `Result` — there is no
 * event left to redraw. Deliberately NOT {@link toEventResult}'s shape, even though both
 * are the v2 envelope.
 */
export interface PlayerEventDeletedResult {
	PlayerEvent: null
	Result: number
	TagModifyResult: null
}

/** The one value {@link PlayerEventDeletedResult} ever takes: a successful delete. */
export const EVENT_DELETED_RESULT: PlayerEventDeletedResult = {
	PlayerEvent: null,
	Result: 0,
	TagModifyResult: null,
}

/**
 * The projection of an event carried on a hub notification frame (`PlayerEventCreated`
 * and its siblings). Deliberately NOT the stored record, in three ways — don't unify
 * them:
 *
 * - it is camelCase, where the record and every read endpoint are PascalCase;
 * - it carries `tags`, which live in their own table, and `broadcastingRoomInstanceId`
 *   (null while nothing is broadcasting), and drops `State`;
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
 * The client's BASE event — the 17-key shape the browse feed (`GET /api/playerevents/v1`),
 * the room shelf (`.../room/{roomId}`) and the bulk read (`POST|GET .../bulk`) all serve,
 * and the same thing the v2 envelope carries once `Tags` is added. Those three are one
 * generic helper over one element type on the client side, so they are shape-identical by
 * construction there; `toEventBase` is what holds that here.
 *
 * PascalCase like the stored record, but not identical to it — don't unify them:
 *
 * - it drops `State`, which neither the feed nor the envelope carries;
 * - it always carries `BroadcastingRoomInstanceId` (null while nothing is broadcasting),
 *   which a record that was just created does not hold yet;
 * - its `ImageName` is a string: an event with no image reads `""`, where the record holds
 *   null.
 *
 * The by-id, search, searchlive and club reads serve the stored RECORD verbatim instead,
 * `State` and nullable `ImageName` included. Two shapes; keep them apart.
 */
export interface PlayerEventBase extends Omit<PlayerEvent, 'State' | 'ImageName'> {
	ImageName: string
	BroadcastingRoomInstanceId: number | null
}

/** Project a stored event into the base shape the feed serves and the envelope wraps. */
export function toEventBase(event: PlayerEvent): PlayerEventBase {
	const { State: _State, ...rest } = event
	return {
		...rest,
		ImageName: event.ImageName ?? '',
		BroadcastingRoomInstanceId: event.BroadcastingRoomInstanceId ?? null,
	}
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
		broadcastingRoomInstanceId: event.BroadcastingRoomInstanceId ?? null,
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
 * Normalize one posted timestamp into the stored form, or undefined when it isn't a
 * usable date.
 *
 * Exported for the single-field time edit (`PUT …/v2/{id}/time`), which has to tell an
 * ABSENT bound — leave the stored one alone — from an unusable one, which it refuses.
 * {@link parseEventBody} collapses the two, since a create/update posting rubbish for a
 * time is better off defaulting than failing.
 */
export function parseEventTime(raw: unknown): string | undefined {
	if (typeof raw !== 'string') return undefined
	const parsed = Date.parse(raw)
	return Number.isNaN(parsed) ? undefined : eventTime(parsed)
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
 * The window a write would end up storing, resolved the way {@link createEvent} and
 * {@link updateEvent} resolve it: a bound the body carries wins, otherwise the stored one
 * (an edit), otherwise the create defaults — now, and an hour later.
 *
 * Exists so the duration rule below and the writes themselves can't drift apart on what
 * "the event's window" means for a body that moves only one bound.
 */
function resolvedWindow(
	input: EventInput,
	existing?: PlayerEvent,
	now = Date.now()
): { start: number; end: number } {
	const start = Date.parse(input.startTime ?? existing?.StartTime ?? eventTime(now))
	const stored = input.endTime ?? existing?.EndTime
	return { start, end: stored === undefined ? start + DEFAULT_DURATION_MS : Date.parse(stored) }
}

/**
 * Why a parsed event body can't be stored, or `null` when it's fine.
 *
 * Two rules: the stored lengths, and the window.
 *
 * Lengths are a cap, not a charset — an event name is a title, not an identifier
 * ("Building a Better Room Using Trigonometry" is a real one), so the alphanumeric rule
 * the account and room names carry would be wrong here. Absent fields are skipped: an
 * update posts only what it changes, and create defaults a missing name rather than
 * refusing it. The name is measured AFTER trimming, matching what the writes store.
 *
 * The window is checked on what the write RESOLVES to rather than on the fields the body
 * carries, which is why `existing` is passed for an edit: moving the start alone still
 * has to leave a window that ends after it and runs no longer than
 * {@link MAX_EVENT_DURATION_MS}. A create resolves against the same defaults
 * {@link createEvent} applies, so a body naming neither bound — or only a start — can
 * never fail this.
 *
 * A backwards window is refused here too. It isn't a duration rule as such, but it's the
 * hole in one: `end - start` on a window running a month backwards is negative, which
 * would sail past a "no longer than a day" check.
 */
export function eventInputRejection(input: EventInput, existing?: PlayerEvent): string | null {
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

	const { start, end } = resolvedWindow(input, existing)
	// Unparseable can't happen from `parseEventBody` (it drops what it can't read) but can
	// from a stored blob edited by hand; skip the rule rather than refusing an edit that
	// says nothing about the times.
	if (Number.isNaN(start) || Number.isNaN(end)) return null
	if (end < start) return 'An event cannot end before it starts.'
	if (end - start > MAX_EVENT_DURATION_MS) {
		return `An event can run for at most ${MAX_EVENT_DURATION_MS / (60 * 60 * 1000)} hours.`
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
export function parseEventTags(raw: unknown): EventTag[] | undefined {
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
	const time = (key: string): string | undefined => parseEventTime(obj[key])
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
	const id = await nextEventId(db)
	const now = Date.now()
	const startTime = input.startTime ?? eventTime(now)
	const event: PlayerEvent = {
		PlayerEventId: id,
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
 * Returns the updated event and the player's response row as it now stands (the route
 * pushes that row on the `PlayerEventResponseChanged` frame), or null when there's no
 * such event. Anyone who can see an event may respond to it, the creator included
 * (they're already Going from create, and nothing stops them declining their own event).
 */
export async function setEventResponse(
	db: D1Database,
	eventId: number,
	playerId: number,
	status: number
): Promise<{ event: PlayerEvent; response: EventAttendeeRow } | null> {
	const event = await getEventById(db, eventId)
	if (event === null) return null

	const response = await db
		.prepare(
			`INSERT INTO event_attendee (event_id, player_id, status, responded_at)
			 VALUES (?1, ?2, ?3, ?4)
			 ON CONFLICT (event_id, player_id) DO UPDATE SET status = ?3, responded_at = ?4
			 RETURNING rowid AS id, *`
		)
		.bind(eventId, playerId, status, eventTime(Date.now()))
		.first<EventAttendeeRow>()

	const updated: PlayerEvent = { ...event, AttendeeCount: await countGoing(db, eventId) }
	await writeEvent(db, updated)
	// An upsert with RETURNING always yields the row it inserted or updated.
	return { event: updated, response: response! }
}

/**
 * Add invited players to an event as Pending — the bulk invite. Returns the updated
 * event (with its recounted `AttendeeCount`) and the rows actually created, or null
 * when there's no such event.
 *
 * An invite only ever INSERTS: a player who already has a row keeps the answer they
 * gave, so being invited can't reset an answer to Pending, and re-inviting the same
 * player is a no-op. The rows land as Pending (3), not Going: the invitee hasn't
 * accepted anything yet, so they don't count toward `AttendeeCount` until they answer
 * through `respond` — see the route.
 *
 * `added` is what `RETURNING` gave back, so it holds exactly the new rows: a conflict
 * inserts nothing and returns nothing. That's who the route sends the invitation Message
 * to — a player whose existing answer was left alone gets nothing, because nothing
 * changed for them.
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
				.bind(eventId, playerId, EVENT_RESPONSE.pending, at)
		)
	)
	const added = inserts.flatMap((r) => r.results)

	const updated: PlayerEvent = { ...event, AttendeeCount: await countGoing(db, eventId) }
	await writeEvent(db, updated)
	return { event: updated, added }
}

/**
 * The players who said they're GOING to an event — who the `PlayerEventUpdated` and
 * `PlayerEventDeleted` frames go to. Interested, declined and Pending rows are left out:
 * an invitee who hasn't accepted isn't attending, so nothing about the event has changed
 * for them. The creator is included through their own Going row from create.
 */
export async function getGoingPlayerIds(db: D1Database, eventId: number): Promise<number[]> {
	const { results } = await db
		.prepare(
			'SELECT player_id FROM event_attendee WHERE event_id = ?1 AND status = ?2 ORDER BY player_id'
		)
		.bind(eventId, EVENT_RESPONSE.going)
		.all<{ player_id: number }>()
	return results.map((r) => r.player_id)
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

/**
 * Overwrite an event's stored blob in place. `BroadcastingRoomInstanceId` is a read-time
 * value (see {@link EVENT_COLUMNS}) and is dropped here, so an edit never freezes a
 * broadcast's state into the record.
 */
async function writeEvent(db: D1Database, event: PlayerEvent): Promise<void> {
	const { BroadcastingRoomInstanceId: _live, ...stored } = event
	await db
		.prepare('UPDATE event SET data = ?1 WHERE id = ?2')
		.bind(JSON.stringify(stored), event.PlayerEventId)
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
 * Draw the next event id. Sequential and NEVER reused: the id comes from the
 * `event_id_seq` AUTOINCREMENT counter, which only ever goes up, rather than from
 * `MAX(id) + 1` over the events themselves — that handed the newest event's id straight
 * back out once it was deleted, so a replacement event wore the old one's id and
 * inherited whatever was still filed under it (an invitation message's `PlayerEventId`,
 * the client's cache). The drawn row is thrown away in the same batch; only the counter
 * matters, and SQLite keeps that in `sqlite_sequence` regardless of the rows.
 */
async function nextEventId(db: D1Database): Promise<number> {
	const [drawn] = await db.batch<{ id: number }>([
		db.prepare('INSERT INTO event_id_seq DEFAULT VALUES RETURNING id'),
		db.prepare('DELETE FROM event_id_seq'),
	])
	const id = drawn.results[0]?.id
	if (id === undefined) throw new Error('event_id_seq returned no id')
	return id
}

/**
 * Delete an event and everything hanging off it — its RSVPs (`event_attendee`), its tags
 * (`event_tag`) and a running broadcast (`event_broadcast`) — in one batch, so a cancelled event can't leave rows behind that the
 * attendee counts and the `#tag` search would still find. Event ids are drawn from a
 * sequence that never reuses one (see {@link nextEventId}), so a deleted event's id is
 * retired with it — but orphan rows would still be counted against whatever id they name.
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
		db.prepare('DELETE FROM event_broadcast WHERE event_id = ?1').bind(eventId),
		db.prepare('DELETE FROM event WHERE id = ?1').bind(eventId),
	])
	return event
}

/** One event by id, or null when there's no such row. */
export async function getEventById(db: D1Database, eventId: number): Promise<PlayerEvent | null> {
	const row = await db
		.prepare(`SELECT ${EVENT_COLUMNS} WHERE id = ?1`)
		.bind(eventId)
		.first<EventRow>()
	return row ? (JSON.parse(row.data) as PlayerEvent) : null
}

/**
 * Several events by id — the bulk fetch behind `POST /api/playerevents/v1/bulk` (the form
 * body the client sends) and the query-string GET on the same path. Answers in the order
 * the ids were asked for (the client renders them in the order it requested), skipping ids
 * with no row rather than leaving a hole. Duplicated ids resolve to the same event.
 *
 * Returns stored records; both routes project them with `toEventBase` before serving.
 */
export async function getEventsByIds(db: D1Database, ids: number[]): Promise<PlayerEvent[]> {
	if (ids.length === 0) return []
	const { results } = await db
		.prepare(`SELECT ${EVENT_COLUMNS} WHERE id IN (SELECT value FROM json_each(?1))`)
		.bind(JSON.stringify(ids))
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
		.prepare(`SELECT ${EVENT_COLUMNS} WHERE creator_player_id = ?1`)
		.bind(creatorPlayerId)
		.all<EventRow>()
	return results.map((r) => JSON.parse(r.data) as PlayerEvent).sort(bySoonest)
}

/**
 * Every event a player holds an RSVP row for — the `Responses` of their own
 * `GET /api/playerevents/v1/all`, soonest first, each the stored record beside the RSVP.
 *
 * Unlike the profile's {@link getPublicEventsByPlayer}, this is the caller's own view, so
 * nothing is withheld: every answer (Going, Interested, Can't go) and every open
 * invitation (`pending`), private events included — they were invited — and finished ones
 * kept, as `Created` keeps them beside it.
 */
export async function getEventResponsesByPlayer(
	db: D1Database,
	playerId: number
): Promise<Array<{ PlayerEvent: PlayerEvent; PlayerEventResponse: PlayerEventResponse }>> {
	const { results } = await db
		.prepare(
			`SELECT ${eventColumns('e')}, a.rowid AS id, a.event_id, a.player_id, a.status, a.responded_at
			 FROM event_attendee a
			 JOIN event e ON e.id = a.event_id
			 ${withBroadcast('e')}
			 WHERE a.player_id = ?1`
		)
		.bind(playerId)
		.all<EventRow & EventAttendeeRow>()
	return results
		.map((r) => ({ event: JSON.parse(r.data) as PlayerEvent, response: toEventResponse(r) }))
		.sort((a, b) => bySoonest(a.event, b.event))
		.map(({ event, response }) => ({ PlayerEvent: event, PlayerEventResponse: response }))
}

/**
 * One entry of a profile's `Responses` — the event beside the player's RSVP to it. The
 * event is the 17-key BASE shape (the client's v1 PlayerEvent), not the stored record.
 */
export interface PlayerEventWithResponse {
	PlayerEvent: PlayerEventBase
	PlayerEventResponse: PlayerEventResponse
}

/** What anyone may see of a player's events — `GET /api/playerevents/v1/all/{playerId}`. */
export interface PlayerPublicEvents {
	Created: PlayerEventBase[]
	Responses: PlayerEventWithResponse[]
}

/**
 * A player's PUBLIC events, as their profile shows them to anyone: the ones they created,
 * and the ones they are attending — answered Going; a maybe, a decline and an unanswered
 * invitation are nobody else's business — each soonest first. An event's creator holds a
 * Going row for it, so their own events appear under both keys.
 *
 * Only `Accessibility` Public events are served, and FINISHED ones are left out, as the
 * browse feed and the room shelf do: this is what the player is going to, not a history.
 */
export async function getPublicEventsByPlayer(
	db: D1Database,
	playerId: number,
	now = Date.now()
): Promise<PlayerPublicEvents> {
	const at = eventTime(now)
	const [created, responses] = await db.batch<EventRow & Partial<EventAttendeeRow>>([
		db
			.prepare(
				`SELECT ${EVENT_COLUMNS}
				 WHERE creator_player_id = ?1 AND end_time >= ?2
				   AND json_extract(event.data, '$.Accessibility') = ?3`
			)
			.bind(playerId, at, Accessibility.Public),
		db
			.prepare(
				`SELECT ${eventColumns('e')}, a.rowid AS id, a.event_id, a.player_id, a.status, a.responded_at
				 FROM event_attendee a
				 JOIN event e ON e.id = a.event_id
				 ${withBroadcast('e')}
				 WHERE a.player_id = ?1 AND a.status = ?2 AND e.end_time >= ?3
				   AND json_extract(e.data, '$.Accessibility') = ?4`
			)
			.bind(playerId, EVENT_RESPONSE.going, at, Accessibility.Public),
	])
	return {
		Created: created.results
			.map((r) => JSON.parse(r.data) as PlayerEvent)
			.sort(bySoonest)
			.map(toEventBase),
		Responses: responses.results
			.map((r) => ({
				event: JSON.parse(r.data) as PlayerEvent,
				response: toEventResponse(r as EventAttendeeRow),
			}))
			.sort((a, b) => bySoonest(a.event, b.event))
			.map(({ event, response }) => ({
				PlayerEvent: toEventBase(event),
				PlayerEventResponse: response,
			})),
	}
}

/**
 * The events belonging to a set of clubs — the events shelf on a club's page, soonest
 * first. Selected on the indexed club_id column. An empty id list is an empty shelf
 * rather than every event.
 */
export async function getEventsByClubs(db: D1Database, clubIds: number[]): Promise<PlayerEvent[]> {
	if (clubIds.length === 0) return []
	const { results } = await db
		.prepare(`SELECT ${EVENT_COLUMNS} WHERE club_id IN (SELECT value FROM json_each(?1))`)
		.bind(JSON.stringify(clubIds))
		.all<EventRow>()
	return results.map((r) => JSON.parse(r.data) as PlayerEvent).sort(bySoonest)
}

/**
 * A room's events — what is happening in this room and what is coming up, soonest first.
 * Backs the room's event shelf (`GET /api/playerevents/v1/room/{roomId}`), which serves
 * them through `toEventBase` like the browse feed and the bulk read.
 *
 * FINISHED events are left out, like the browse feed's: this answers "what can I still turn
 * up to in this room", and an event that ended last month is not that. Running events count
 * as current — the filter is on the END time, so an event stays listed until it is over
 * rather than disappearing the moment it starts.
 *
 * Selected on the indexed room_id column, with the time bound in SQL too: end_time is a
 * generated column of an ISO-8601 UTC string, so it compares lexicographically.
 */
export async function getEventsByRoom(
	db: D1Database,
	roomId: number,
	now = Date.now()
): Promise<PlayerEvent[]> {
	const { results } = await db
		.prepare(`SELECT ${EVENT_COLUMNS} WHERE room_id = ?1 AND end_time >= ?2`)
		.bind(roomId, eventTime(now))
		.all<EventRow>()
	return results.map((r) => JSON.parse(r.data) as PlayerEvent).sort(bySoonest)
}

/**
 * The events happening right now — started and not yet finished. Backs the "happening
 * now" browse query. Both bounds compare lexicographically on the generated ISO-8601
 * columns, so the whole filter stays in SQL. Public events only, like the browse feed: a
 * private or unlisted event is for whoever was invited.
 */
export async function getLiveEvents(db: D1Database, now = Date.now()): Promise<PlayerEvent[]> {
	const at = eventTime(now)
	const { results } = await db
		.prepare(
			`SELECT ${EVENT_COLUMNS} WHERE start_time <= ?1 AND end_time >= ?1
			   AND json_extract(event.data, '$.Accessibility') = ?2`
		)
		.bind(at, Accessibility.Public)
		.all<EventRow>()
	return results.map((r) => JSON.parse(r.data) as PlayerEvent).sort(bySoonest)
}

/**
 * The most events any event endpoint serves in one answer — all the client shows. A paged
 * read caps `take` at this; a bulk read looks up at most this many ids.
 */
export const MAX_EVENTS_SERVED = 50

/** A page size from a `take` query: 50 by default, and never more than 50. */
export function eventTake(raw: string | undefined): number {
	return Math.min(Number.parseInt(raw ?? '', 10) || MAX_EVENTS_SERVED, MAX_EVENTS_SERVED)
}

/**
 * Cap a soonest-first list of current and upcoming events: the first 50, the ones on
 * soonest.
 */
export function soonestEvents<T>(list: T[]): T[] {
	return list.slice(0, MAX_EVENTS_SERVED)
}

/**
 * Cap a soonest-first list that KEEPS finished events (a creator's own list, a club's
 * shelf): the LAST 50, still soonest first. The first 50 would be the oldest, and a long
 * history would push every upcoming event off the end.
 */
export function latestEvents<T>(list: T[]): T[] {
	return list.slice(-MAX_EVENTS_SERVED)
}

/** Soonest start first; ties broken by id so paging is stable. */
function bySoonest(a: PlayerEvent, b: PlayerEvent): number {
	return a.StartTime.localeCompare(b.StartTime) || a.PlayerEventId - b.PlayerEventId
}

/**
 * Best attended first — the count of players who answered Going (`AttendeeCount`, the
 * number the client shows), which is exactly what the sort is meant to rank. Interested
 * and Can't-go don't count, as they don't toward the displayed count either. Ties fall
 * back to soonest first so the order stays stable across pages.
 */
function byAttendance(a: PlayerEvent, b: PlayerEvent): number {
	return b.AttendeeCount - a.AttendeeCount || bySoonest(a, b)
}

/**
 * The orders the search serves, by the `sort` the client sends: `StartTime` (soonest
 * first, the default) and `Attendance` (most Going replies first).
 */
export type EventSort = 'StartTime' | 'Attendance'

/**
 * Reads the `sort` query into an {@link EventSort}, case-insensitively. Anything
 * unrecognised — or nothing at all — is the default order, soonest first, rather than
 * a 400: the browse screen has always sent this param and been served regardless.
 */
export function parseEventSort(raw: string | undefined): EventSort {
	return raw?.toLowerCase() === 'attendance' ? 'Attendance' : 'StartTime'
}

/**
 * Event search — the browse query on the player-events screen. Term by term, an empty
 * query browsing everything upcoming; paginated via skip/take, in the order `sort`
 * names ({@link EventSort}): soonest first by default, or most Going replies first.
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
 *
 * Only `Accessibility` Public events are served, for the same reason: a private or
 * unlisted event is for whoever was invited, not for anyone browsing.
 */
export async function searchEvents(
	db: D1Database,
	query: string,
	skip: number,
	take: number,
	sort: EventSort = 'StartTime'
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
	const browse = `SELECT ${EVENT_COLUMNS} WHERE end_time >= ?1
		AND json_extract(event.data, '$.Accessibility') = ?2`
	const sql =
		wanted.length === 0
			? browse
			: `${browse} AND (
					SELECT COUNT(DISTINCT tag) FROM event_tag
					WHERE event_tag.event_id = event.id
					  AND tag IN (${wanted.map((_, i) => `?${i + 3}`).join(', ')})
				) = ${wanted.length}`
	const { results } = await db
		.prepare(sql)
		.bind(eventTime(Date.now()), Accessibility.Public, ...wanted)
		.all<EventRow>()
	let events = results.map((r) => JSON.parse(r.data) as PlayerEvent)

	for (const term of textTerms) {
		events = events.filter(
			(e) => e.Name.toLowerCase().includes(term) || e.Description.toLowerCase().includes(term)
		)
	}

	return events.sort(sort === 'Attendance' ? byAttendance : bySoonest).slice(skip, skip + take)
}

/**
 * How long after its `EndTime` an event may still be broadcast. A broadcast is the
 * creator's to start at any time before the event ends: matchmaking lets people in early,
 * and the 2026 client offers Start Broadcasting whenever the creator stands in one of the
 * event's instances, with no way to show a refusal. The grace covers an event that runs a
 * little long.
 */
export const BROADCAST_GRACE_MS = 5 * 60 * 1000

/**
 * Whether `accountId` may broadcast `event` right now: its creator, on a multi-instance
 * event that has not ended (see {@link BROADCAST_GRACE_MS}). There is no broadcast
 * permission beyond that: whoever made the event runs it.
 */
export function canBroadcastEvent(event: PlayerEvent, accountId: number, now = Date.now()): boolean {
	return (
		event.CreatorPlayerId === accountId &&
		event.IsMultiInstance &&
		now <= Date.parse(event.EndTime) + BROADCAST_GRACE_MS
	)
}

/**
 * Record that `broadcasterId` is broadcasting `eventId` from `roomInstanceId`. One broadcast
 * per event, so a new start (from another instance, or after a stop report was lost)
 * replaces the old one.
 */
export async function startEventBroadcast(
	db: D1Database,
	eventId: number,
	roomInstanceId: number,
	broadcasterId: number,
	now = Date.now()
): Promise<void> {
	await db
		.prepare(
			`INSERT INTO event_broadcast (event_id, room_instance_id, broadcaster_id, started_at)
			 VALUES (?1, ?2, ?3, ?4)
			 ON CONFLICT (event_id) DO UPDATE SET
			   room_instance_id = excluded.room_instance_id,
			   broadcaster_id = excluded.broadcaster_id,
			   started_at = excluded.started_at`
		)
		.bind(eventId, roomInstanceId, broadcasterId, eventTime(now))
		.run()
}

/**
 * End the broadcast `broadcasterId` runs for `eventId`. With `roomInstanceId`, only the one
 * from that instance: the stop report of a stale connection (the same player timing out of
 * an older instance) must not end the broadcast a newer connection started. Without it,
 * whichever instance it runs from: that is the room server saying the player just joined
 * an instance and is not broadcasting anywhere, which clears a broadcast a lost report or
 * a room-server restart left behind (a player is only ever in one instance). Answers
 * whether a broadcast was ended.
 */
export async function stopEventBroadcast(
	db: D1Database,
	eventId: number,
	broadcasterId: number,
	roomInstanceId?: number
): Promise<boolean> {
	const { meta } = await db
		.prepare(
			`DELETE FROM event_broadcast
			 WHERE event_id = ?1 AND broadcaster_id = ?2 AND (?3 IS NULL OR room_instance_id = ?3)`
		)
		.bind(eventId, broadcasterId, roomInstanceId ?? null)
		.run()
	return meta.changes > 0
}
