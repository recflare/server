import { Hono } from 'hono'
import { describeRoute } from 'hono-openapi'

import { Accessibility, GAME_VERSION } from '@repo/domain'
import { logger } from '@repo/hono-helpers'
import { validateAndGetVersion } from '@repo/jwt'

// The notification-type ids the hub carries (owned by the `notify` worker). Imported
// as a value — the enum has no runtime dependencies.
import { NotificationType } from '../../../notify/src/notification-types'
import {
	createEvent,
	deleteEvent,
	EVENT_DELETED_RESULT,
	eventInputRejection,
	getEventAttendees,
	getEventById,
	getEventResponse,
	getEventsByClubs,
	getEventsByCreator,
	getEventsByIds,
	getEventsByRoom,
	getEventTags,
	getLiveEvents,
	inviteToEvent,
	isEventResponseType,
	parseEventBody,
	parseEventTags,
	parseEventTime,
	searchEvents,
	setEventResponse,
	toEventBase,
	toEventNotification,
	toEventResponse,
	toEventResult,
	updateEvent,
} from '../events-db'
import { authedId, queryIds, unauthorized } from '../http'
import {
	AUTHED,
	form,
	idParam,
	intQuery,
	json,
	jsonBody,
	pageParams,
	PlayerEventAccessibilityRequest,
	PlayerEventBaseDto,
	PlayerEventBulkInviteRequest,
	PlayerEventDeletedDto,
	PlayerEventDescriptionRequest,
	PlayerEventDetailsDto,
	PlayerEventDto,
	PlayerEventNameRequest,
	PlayerEventReportRequest,
	PlayerEventRequest,
	PlayerEventRespondRequest,
	PlayerEventResponseDto,
	PlayerEventResultDto,
	PlayerEventsAll,
	PlayerEventsPage,
	PlayerEventTagsRequest,
	PlayerEventTimeRequest,
	stringQuery,
	SuccessErrorEnvelope,
	TagFilters,
	UNAUTHORIZED_RESPONSE,
} from '../openapi'
import { createReport } from '../reports-db'

import type { Context } from 'hono'
import type { PlayerEventResponsePayload } from '../../../notify/src/notification-payloads'
import type { App } from '../context'
import type { EventAttendeeRow, EventInput, EventTag, PlayerEvent } from '../events-db'

/** The notifications hub is a single global DO instance (see the `notify` worker). */
const HUB_INSTANCE = 'global'

/**
 * Push a `PlayerEventCreated` notification for a freshly scheduled event to its
 * creator — what makes the event appear on their own screen without a refetch.
 *
 * Hub failures are logged and swallowed: the event is already stored, so a hub hiccup
 * must not fail the create. Note the frame carries the camelCase
 * {@link toEventNotification} projection, not the PascalCase record the response does.
 */
async function notifyEventCreated(
	c: Context<App>,
	event: PlayerEvent,
	tags: EventTag[]
): Promise<void> {
	try {
		await c.env.RECFLARE_NOTIFICATIONS_HUB.getByName(HUB_INSTANCE).notifyPlayer(
			event.CreatorPlayerId,
			NotificationType.PlayerEventCreated,
			{ ...toEventNotification(event, tags) }
		)
	} catch (err) {
		logger.error('failed to push PlayerEventCreated notification', {
			playerEventId: event.PlayerEventId,
			error: err instanceof Error ? err.message : String(err),
		})
	}
}

/**
 * Push a `PlayerEventResponseChanged` (83) to each player a bulk invite just added —
 * what puts the event on their screen without a refetch, since an invite writes their
 * response row for them.
 *
 * Only the players who actually gained a row are notified: an invite that hit an
 * existing answer changed nothing, so there is nothing to tell them about.
 *
 * The frame carries BOTH nested objects the client's decoder expects. That is not
 * optional — several of its handlers dereference one level down with no null guard, so
 * omitting one surfaces as a NullReferenceException in the client rather than a missing
 * field (see notification-payloads.ts). The event goes in the same camelCase
 * {@link toEventNotification} projection the `PlayerEventCreated` frame uses, and the
 * response in the PascalCase {@link toEventResponse} one the RSVP list serves; the
 * decoder accepts either casing, so the two need not agree.
 *
 * Hub failures are logged and swallowed, and one player's failure doesn't stop the
 * rest: the invites are already stored by the time this runs.
 */
async function notifyInvited(
	c: Context<App>,
	event: PlayerEvent,
	added: EventAttendeeRow[]
): Promise<void> {
	const hub = c.env.RECFLARE_NOTIFICATIONS_HUB.getByName(HUB_INSTANCE)
	const PlayerEvent = { ...toEventNotification(event) }
	for (const row of added) {
		const payload = {
			PlayerEvent,
			PlayerEventResponse: { ...toEventResponse(row) },
		} satisfies PlayerEventResponsePayload
		try {
			await hub.notifyPlayer(row.player_id, NotificationType.PlayerEventResponseChanged, payload)
		} catch (err) {
			logger.error('failed to push PlayerEventResponseChanged notification', {
				playerEventId: event.PlayerEventId,
				playerId: row.player_id,
				error: err instanceof Error ? err.message : String(err),
			})
		}
	}
}

/**
 * Wrap an event in the v2 envelope for THIS caller's build.
 *
 * Rec Room reshaped `PlayerEvent.Tags` without minting a new path, so the same endpoint
 * owes the 2023 build `[{ Tag, Type }]` and the 2025 build `["celebration"]`. The build
 * comes off the token's `rn.ver` claim — the request carries no version of its own — and
 * the split is the one `/api/gameconfigs/v1/all` already makes: anything NEWER than
 * `GAME_VERSION` (20230414) is the 2025 client; that build, anything older, and a request
 * with no readable token version all get the 2023 shape. Builds are date-stamped, so they
 * order as strings.
 *
 * Like the other version gates here the claim is unverified — a client that lies about its
 * build only empties its own tag chips.
 */
async function eventResult(c: Context<App>, event: PlayerEvent, tags: EventTag[]) {
	const version = await validateAndGetVersion(c.req.raw, await c.env.JWT_SECRET.get())
	const isModernBuild = version !== null && version > GAME_VERSION
	return toEventResult(event, tags, !isModernBuild)
}

/**
 * The shared front half of the single-field event edits (`PUT …/v2/{id}/{field}`):
 * authenticate, load the event, check the caller created it, then apply whatever patch
 * `parse` reads out of the body and answer the same `{ Result, TagModifyResult,
 * PlayerEvent }` envelope the other v2 writes do — the client re-renders the event from
 * the response rather than refetching it.
 *
 * `parse` answers `null` to refuse the body, which becomes the empty-bodied 400 the rest
 * of this file uses. It gets the stored event so a rule can depend on it (the time edit
 * checks the new window against the bound it isn't changing).
 *
 * These edits are creator-only like the whole-event update, and they go through the same
 * {@link updateEvent}, so a patch touching one field leaves the rest of the event alone.
 */
function editEventField(
	parse: (c: Context<App>, event: PlayerEvent) => Promise<EventInput | null>
) {
	return async (c: Context<App>) => {
		const id = await authedId(c)
		if (id === null) return unauthorized(c)

		// `?? ''` only to satisfy the untyped-path signature — the route pattern already
		// constrains the segment to digits, so it is always there.
		const eventId = Number.parseInt(c.req.param('eventId') ?? '', 10)
		const existing = await getEventById(c.env.DB, eventId)
		if (existing === null) return c.body(null, 404)
		if (existing.CreatorPlayerId !== id) return c.body(null, 403)

		const input = await parse(c, existing)
		if (input === null) return c.body(null, 400)
		const updated = await updateEvent(c.env.DB, eventId, input)
		// updateEvent only returns null when the row vanished, which the read above rules out.
		return c.json(await eventResult(c, updated!, await getEventTags(c.env.DB, eventId)))
	}
}

/** The form body of a single-field edit; an unparseable one reads as empty. */
async function formBody(c: Context<App>): Promise<Record<string, unknown>> {
	return (await c.req.parseBody().catch(() => ({}))) as Record<string, unknown>
}

/**
 * Parse an `accessibility` field into an {@link Accessibility} value. The client sends
 * the enum NAME here (`accessibility=Unlisted`), as it does on the subroom route in
 * `rooms`; the ordinal is accepted alongside it. Undefined when the field names nothing
 * in the enum — which the route refuses rather than defaulting, since guessing a
 * visibility wrong is the kind of mistake that shows a private event to everyone.
 */
function parseEventAccessibility(value: unknown): number | undefined {
	if (typeof value !== 'string') return undefined
	const raw = value.trim()
	const named = Object.entries(Accessibility).find(
		([name, ordinal]) => typeof ordinal === 'number' && name.toLowerCase() === raw.toLowerCase()
	)
	if (named) return named[1] as number
	if (!/^\d+$/.test(raw)) return undefined
	const ordinal = Number.parseInt(raw, 10)
	return ordinal in Accessibility ? ordinal : undefined
}

/**
 * Player events — scheduled events players and clubs host in a room.
 *
 * D1-backed (the `event` table, owned by this worker; see events-db.ts). The stored
 * blob IS the DTO, so every read here serves it verbatim; only the create/update
 * writes wrap it, in the `{ Result, TagModifyResult, PlayerEvent }` envelope.
 *
 * Watch the response shapes: the two club feeds deliberately differ (bare array for
 * the multi-club form, paged envelope for the single-club one) and the client chokes
 * if they're unified.
 */
export const eventRoutes = new Hono<App>({ strict: false })
	// The player-events browse feed — everything upcoming or running, soonest first. Same
	// query `/search` runs with no text, but its own projection: the feed serves the client's
	// BASE event (17 keys — no `State`, a string `ImageName`, plus `BroadcastingRoomInstanceId`),
	// which is the v2 envelope's event minus `Tags`. Hence `toEventBase`.
	.get(
		'/api/playerevents/v1',
		describeRoute({
			tags: ['Events'],
			summary: 'The player-events browse feed',
			description:
				'The default feed on the player-events screen: every event that has not finished ' +
				'yet — upcoming and running — soonest first, paginated via skip/take. A bare ' +
				'array.\n\n' +
				'Each entry is the client’s BASE event — the v2 envelope’s event minus `Tags`, 17 ' +
				'keys — not the stored record the by-id, bulk and search reads serve: it drops ' +
				'`State`, serves `ImageName` as `""` rather than null, and carries ' +
				'`BroadcastingRoomInstanceId` (always null — nothing broadcasts an event yet). ' +
				'That is the shape observed on this endpoint; keep the two projections apart.',
			parameters: pageParams(50),
			responses: { 200: json(PlayerEventBaseDto.array(), 'The events that have not ended') },
		}),
		async (c) => {
			const skip = Number.parseInt(c.req.query('skip') ?? '', 10) || 0
			const take = Number.parseInt(c.req.query('take') ?? '', 10) || 50
			const events = await searchEvents(c.env.DB, '', skip, take)
			return c.json(events.map(toEventBase))
		}
	)

	.get(
		'/api/playerevents/v1/all',
		describeRoute({
			tags: ['Events'],
			summary: 'The caller’s player events',
			description:
				'Events the player created and events they have RSVP’d to. `Created` is served ' +
				'from the event table, soonest first.\n\n' +
				'`Responses` is still always empty. RSVPs ARE stored now (see ' +
				'`/api/playerevents/v1/respond` and the `event_attendee` table) — what isn’t known ' +
				'is the shape this field wants: whether an entry is a bare event like `Created`, ' +
				'or the event plus the answer, which is the useful thing to render. Serving the ' +
				'wrong one renders nothing rather than erroring, so it stays empty until a real ' +
				'response is observed.',
			security: AUTHED,
			responses: {
				200: json(PlayerEventsAll, 'The caller’s created events, and an empty RSVP list'),
				401: UNAUTHORIZED_RESPONSE,
			},
		}),
		async (c) => {
			const id = await authedId(c)
			if (id === null) return unauthorized(c)
			return c.json({ Created: await getEventsByCreator(c.env.DB, id), Responses: [] })
		}
	)

	// The tag filter chips on the player-events browse screen. Static: these are the
	// categories the client offers when creating an event, so the list doesn't depend on
	// what's stored. `TrendingFilters` is null even in the reference — it needs
	// recent-activity data we don't keep, and the client renders no trending row for null.
	.get(
		'/api/playerevents/v1/tagfilters',
		describeRoute({
			tags: ['Events'],
			summary: 'Player-event filter chips',
			description:
				'The filter chips on the player-events browse screen — the event categories the ' +
				'client offers. Static: the same set regardless of what is stored. ' +
				'`TrendingFilters` is null even in the reference (it needs recent-activity data), ' +
				'and the client renders no trending row for null.',
			security: AUTHED,
			responses: { 200: json(TagFilters, 'The filter chips'), 401: UNAUTHORIZED_RESPONSE },
		}),
		async (c) => {
			const id = await authedId(c)
			if (id === null) return unauthorized(c)
			return c.json({
				PinnedFilters: [
					'workshops',
					'celebration',
					'game',
					'meetup',
					'performance',
					'coop',
					'grandopening',
					'class',
					'competition',
				],
				PopularFilters: [
					'workshops',
					'celebration',
					'class',
					'coop',
					'competition',
					'game',
					'grandopening',
					'meetup',
					'performance',
				],
				TrendingFilters: null,
			})
		}
	)

	// Player events for a set of clubs (`?id=1&id=2`) — the events shelf on a club's
	// page. A bare array: the client deserializes this one as a list, and chokes on the
	// `{ ContinuationToken, Events }` envelope the single-club form uses.
	.get(
		'/api/playerevents/v1/clubs',
		describeRoute({
			tags: ['Events'],
			summary: 'Player events across several clubs',
			description:
				'The events shelf for a set of clubs (`?id=1&id=2`), soonest first. This form ' +
				'returns a BARE ARRAY — the client deserializes it as a list and chokes on the ' +
				'paged envelope the single-club form below uses. Do not unify the two. No ids ' +
				'means an empty shelf, not every event.',
			parameters: [intQuery('id', 'Repeatable club id')],
			responses: { 200: json(PlayerEventDto.array(), 'The clubs’ events') },
		}),
		async (c) => c.json(await getEventsByClubs(c.env.DB, queryIds(c)))
	)

	// The same feed for a single club (`/club/1`) — the form the reference serves,
	// which *does* wrap the events with a paging cursor (empty = no next page).
	.get(
		'/api/playerevents/v1/club/:clubId{[0-9]+}',
		describeRoute({
			tags: ['Events'],
			summary: 'Player events for one club',
			description:
				'The same feed for a single club — and this form DOES wrap the events with a ' +
				'paging cursor, matching the reference. The cursor is always empty: a club’s event ' +
				'list is small enough to serve in one page.',
			parameters: [idParam('clubId', 'Club id')],
			responses: { 200: json(PlayerEventsPage, 'The club’s events, in a single page') },
		}),
		async (c) => {
			const clubId = Number.parseInt(c.req.param('clubId'), 10)
			const events = await getEventsByClubs(c.env.DB, [clubId])
			return c.json({ ContinuationToken: '', Events: events })
		}
	)

	// A room's event shelf (`/room/12`) — what is on in this room, current and upcoming.
	// A bare array of the stored record, like the multi-club shelf and `/searchlive`: the
	// single-club form's `{ ContinuationToken, Events }` envelope is the odd one out, and a
	// room's shelf is small enough that there is nothing to page.
	.get(
		'/api/playerevents/v1/room/:roomId{[0-9]+}',
		describeRoute({
			tags: ['Events'],
			summary: 'Player events in one room',
			description:
				'The events scheduled in a room — the shelf on the room’s page — soonest first. A ' +
				'bare array of the stored record, the same projection `/searchlive` and the ' +
				'multi-club shelf serve.\n\n' +
				'CURRENT and UPCOMING only: the filter is on the END time, so a running event stays ' +
				'listed until it is over rather than vanishing the moment it starts, and an event ' +
				'that has finished is dropped — this answers what someone can still turn up to. A ' +
				'room with nothing scheduled, and a room id that does not exist, both answer an ' +
				'empty array; the shelf is about events, not about whether the room is real.',
			parameters: [idParam('roomId', 'Room id')],
			responses: { 200: json(PlayerEventDto.array(), 'The room’s current and upcoming events') },
		}),
		async (c) => c.json(await getEventsByRoom(c.env.DB, Number.parseInt(c.req.param('roomId'), 10)))
	)

	// Live player-event search (the "happening now" browse query) — events that have
	// started and not yet finished. A bare array, like the multi-club feed.
	.get(
		'/api/playerevents/v1/searchlive',
		describeRoute({
			tags: ['Events'],
			summary: 'Live player events',
			description:
				'The "happening now" row on the player-events browse screen: events that have ' +
				'started and not yet ended, soonest first. A bare array.',
			responses: { 200: json(PlayerEventDto.array(), 'The events running right now') },
		}),
		async (c) => c.json(await getLiveEvents(c.env.DB))
	)

	// Event search — the browse query. Text is matched term by term against name and
	// description; finished events are left out (this backs a browse screen).
	.get(
		'/api/playerevents/v1/search',
		describeRoute({
			tags: ['Events'],
			summary: 'Search player events',
			description:
				'The browse query on the player-events screen, term by term; an empty query ' +
				'browses everything upcoming. A `#` decides how a term is matched: `#workshops` is ' +
				'a TAG term, matching only events tagged `workshops` and never the word in a name ' +
				'or description, which is what the filter chips send; a bare `workshops` is TEXT, ' +
				'matched case-insensitively against the name and description. Every term must ' +
				'match and the two kinds combine, so `#workshops trigonometry` is the ' +
				'workshops-tagged events whose text also mentions trigonometry.\n\n' +
				'Events that have already finished are left out — a name match on something that ' +
				'ended last month is noise on a browse screen. Soonest first, paginated via ' +
				'skip/take. A bare array.',
			parameters: [
				stringQuery('query', 'Search terms; `#tag` matches a tag, anything else the text'),
				stringQuery(
					'sort',
					'Accepted and echoed by the client as `StartTime`, which is the only order ' +
						'served (soonest first); any other value sorts the same way'
				),
				...pageParams(50),
			],
			responses: { 200: json(PlayerEventDto.array(), 'The matching events') },
		}),
		async (c) => {
			const skip = Number.parseInt(c.req.query('skip') ?? '', 10) || 0
			const take = Number.parseInt(c.req.query('take') ?? '', 10) || 50
			return c.json(await searchEvents(c.env.DB, c.req.query('query') ?? '', skip, take))
		}
	)

	// Bulk fetch (`?id=1&id=2`) — the events behind a list of ids the client already
	// holds. Answers in the order asked for; ids with no event are skipped.
	.get(
		'/api/playerevents/v1/bulk',
		describeRoute({
			tags: ['Events'],
			summary: 'Several player events by id',
			description:
				'The events behind a list of ids the client already holds (`?id=1&id=2`). Answers ' +
				'in the order the ids were asked for — the client renders them in request order — ' +
				'and skips ids with no event rather than leaving a hole, so the result may be ' +
				'shorter than the request. A bare array.',
			parameters: [intQuery('id', 'Repeatable event id')],
			responses: { 200: json(PlayerEventDto.array(), 'The events that exist, in request order') },
		}),
		async (c) => c.json(await getEventsByIds(c.env.DB, queryIds(c)))
	)

	// RSVP. One row per player per event, so responding again replaces the previous
	// answer rather than stacking up. Note this is the v1 path while create/update are
	// v2 — that's how the client calls them.
	.post(
		'/api/playerevents/v1/respond',
		describeRoute({
			tags: ['Events'],
			summary: 'Answer a player event',
			description:
				'Records how the caller is answering an event — `Type` is 0 Going, 1 Interested, ' +
				'2 Can’t go. Responding again replaces the previous answer; there is one row per ' +
				'player per event, and a decline is recorded rather than deleted so the client can ' +
				'show a player what they said.\n\n' +
				'Only Going counts toward the event’s `AttendeeCount`, which is recomputed from ' +
				'the RSVP table on every response. Anyone may respond, the creator included — ' +
				'they are already Going from create, and nothing stops them declining their own ' +
				'event. Answers the same `{ Result, TagModifyResult, PlayerEvent }` envelope the ' +
				'v2 writes do, carrying the event with its updated count, so the client can ' +
				're-render from the response.\n\n' +
				'A body with no usable `PlayerEventId`, or a `Type` outside 0–2, is a 400; an ' +
				'unknown event is a 404.',
			security: AUTHED,
			requestBody: jsonBody(PlayerEventRespondRequest, 'The event and the answer'),
			responses: {
				200: json(PlayerEventResultDto, 'The event, with its updated attendee count'),
				400: { description: 'Missing `PlayerEventId` or an unknown `Type` (empty body)' },
				401: UNAUTHORIZED_RESPONSE,
				404: { description: 'No such event (empty body)' },
			},
		}),
		async (c) => {
			const id = await authedId(c)
			if (id === null) return unauthorized(c)

			const body = await c.req
				.json<{ PlayerEventId?: unknown; Type?: unknown }>()
				.catch(() => ({}) as { PlayerEventId?: unknown; Type?: unknown })
			const eventId = Number(body.PlayerEventId)
			const type = Number(body.Type)
			// Both are rejected rather than defaulted: an unrecognized answer stored as
			// Going would silently inflate the count.
			if (!Number.isInteger(eventId) || !isEventResponseType(type)) return c.body(null, 400)

			const updated = await setEventResponse(c.env.DB, eventId, id, type)
			if (updated === null) return c.body(null, 404)
			return c.json(await eventResult(c, updated, await getEventTags(c.env.DB, eventId)))
		}
	)

	// Report an event. Stored in the `report` table the player reports use — same fields,
	// same moderation life — with `event_id` set. See migrations/0011_report_event.sql.
	.post(
		'/api/playerevents/v1/report',
		describeRoute({
			tags: ['Events', 'Moderation'],
			summary: 'Report a player event',
			description:
				'Files a report against an event. Stored as a row in the same `report` table a ' +
				'player report goes to (`POST /api/PlayerReporting/v3/create`) — it is the same ' +
				'submission with the same moderation life, and a moderator converts either into a ' +
				'ban the same way. What marks it as an event report is `event_id`; the row’s ' +
				'`reported_player_id` is the event’s CREATOR (who a moderator would act against) ' +
				'and its `room_id` the room the event runs in, both read from the event rather ' +
				'than sent by the client.\n\n' +
				'The reporter is the caller (from the bearer token), never a body field. Note this ' +
				'body is JSON, where the player report’s is form-encoded. `ReportCategory` is ' +
				'stored verbatim — the enum is not mapped here. Nothing dedupes the rows: ' +
				'reporting the same event twice files two reports.\n\n' +
				'Answers the same `{ success, error }` envelope as the player report, `error` ' +
				'being an empty string rather than null, on the rejected branches too so there is ' +
				'only one shape to parse.',
			security: AUTHED,
			requestBody: jsonBody(PlayerEventReportRequest, 'The report'),
			responses: {
				200: json(SuccessErrorEnvelope, '`{ success: true, error: "" }`'),
				400: json(SuccessErrorEnvelope, 'No usable `PlayerEventId` in the body'),
				401: UNAUTHORIZED_RESPONSE,
				404: json(SuccessErrorEnvelope, 'No such event'),
			},
		}),
		async (c) => {
			const reporterId = await authedId(c)
			if (reporterId === null) return unauthorized(c)

			const body = await c.req
				.json<{ PlayerEventId?: unknown; ReportCategory?: unknown; Details?: unknown }>()
				.catch(() => ({}) as Record<string, unknown>)
			const eventId = Number(body.PlayerEventId)
			if (!Number.isInteger(eventId)) {
				return c.json({ success: false, error: 'PlayerEventId is required' }, 400)
			}

			// The event supplies the two columns the client doesn't send. An unknown event is
			// refused rather than filed against nobody: the row's reported player has to be
			// someone, and a report naming an event that never existed isn't actionable.
			const event = await getEventById(c.env.DB, eventId)
			if (event === null) return c.json({ success: false, error: 'No such event' }, 404)

			const category = Number(body.ReportCategory)
			await createReport(c.env.DB, {
				reporterPlayerId: reporterId,
				reportedPlayerId: event.CreatorPlayerId,
				reportCategory: Number.isInteger(category) ? category : 0,
				details: typeof body.Details === 'string' ? body.Details : null,
				roomId: event.RoomId > 0 ? event.RoomId : null,
				eventId,
			})

			return c.json({ success: true, error: '' })
		}
	)

	// Bulk invite — the "invite friends" button on an event. Adds the invited players to
	// the same `event_attendee` table an RSVP writes to, as Going.
	.post(
		'/api/playerevents/v1/bulkInvite',
		describeRoute({
			tags: ['Events'],
			summary: 'Invite players to an event',
			description:
				'Adds the invited players to the event as Going — the same `event_attendee` rows ' +
				'an RSVP writes, so an invited player shows up in `…/responses` and counts toward ' +
				'`AttendeeCount` immediately, without having answered.\n\n' +
				'An invite never overwrites an answer: a player who already responded keeps what ' +
				'they said, so inviting someone who declined does not flip them back to Going, and ' +
				're-inviting is a no-op. The caller is skipped (they are already on the list), as ' +
				'are duplicate ids.\n\n' +
				'The caller must be on the event themselves — its creator, or a player with a ' +
				'response row of any kind. Anyone else gets 403: an invite adds attendees, so it ' +
				'is not something a passer-by can do. Answers the same ' +
				'`{ Result, TagModifyResult, PlayerEvent }` envelope the other event writes do, ' +
				'carrying the updated attendee count.',
			security: AUTHED,
			requestBody: jsonBody(PlayerEventBulkInviteRequest, 'The event and who to invite'),
			responses: {
				200: json(PlayerEventResultDto, 'The event, with its updated attendee count'),
				400: { description: 'Missing `PlayerEventId` or `InvitedPlayerIds` (empty body)' },
				401: UNAUTHORIZED_RESPONSE,
				403: { description: 'The caller is not on the event (empty body)' },
				404: { description: 'No such event (empty body)' },
			},
		}),
		async (c) => {
			const id = await authedId(c)
			if (id === null) return unauthorized(c)

			const body = await c.req
				.json<{ PlayerEventId?: unknown; InvitedPlayerIds?: unknown }>()
				.catch(() => ({}) as { PlayerEventId?: unknown; InvitedPlayerIds?: unknown })
			const eventId = Number(body.PlayerEventId)
			if (!Number.isInteger(eventId) || !Array.isArray(body.InvitedPlayerIds)) {
				return c.body(null, 400)
			}

			const event = await getEventById(c.env.DB, eventId)
			if (event === null) return c.body(null, 404)
			// On the event themselves, one way or the other. The creator has a Going row from
			// create, so the response lookup would usually cover them — but it's checked
			// explicitly so a creator who deleted their own answer can still invite.
			if (
				event.CreatorPlayerId !== id &&
				(await getEventResponse(c.env.DB, eventId, id)) === null
			) {
				return c.body(null, 403)
			}

			// Unusable entries are dropped rather than failing the invite: a client sending one
			// bad id shouldn't lose the other nine invites.
			const invited = [
				...new Set(
					body.InvitedPlayerIds.map((v) => Number(v)).filter((v) => Number.isInteger(v) && v !== id)
				),
			]
			const result = await inviteToEvent(c.env.DB, eventId, invited)
			// inviteToEvent only returns null when the row vanished, which the read above rules out.
			await notifyInvited(c, result!.event, result!.added)
			return c.json(await eventResult(c, result!.event, await getEventTags(c.env.DB, eventId)))
		}
	)

	// Create. The creator comes from the bearer token, never the body — posting someone
	// else's `CreatorPlayerId` doesn't make it theirs.
	.post(
		'/api/playerevents/v2',
		describeRoute({
			tags: ['Events'],
			summary: 'Create a player event',
			description:
				'Schedules a new event. The creator is taken from the bearer token, never the ' +
				'body; the id is assigned here. Lenient about the rest, like the other writes ' +
				'here — a missing name becomes “Untitled Event” and a missing time window becomes ' +
				'an hour from now, rather than an error the client can’t render.\n\n' +
				'`State` starts at 0, and the creator is recorded as Going in the RSVP table — ' +
				'which is what makes `AttendeeCount` start at 1, since that count is derived from ' +
				'the table. Answers the `{ Result, TagModifyResult, PlayerEvent }` envelope — NOT ' +
				'the bare event the read endpoints serve.\n\n' +
				'The window is capped at 24 hours and must end after it starts — an event is a ' +
				'scheduled get-together, not a season. Since a missing end defaults to an hour ' +
				'after the start, only a body naming both bounds (or an end alone, which is ' +
				'measured from now) can fail this.\n\n' +
				'Also pushes a `PlayerEventCreated` (80) hub notification to the creator, carrying ' +
				'the event in its camelCase notification projection. A hub failure is logged and ' +
				'swallowed — the event is already stored by then.',
			security: AUTHED,
			requestBody: jsonBody(PlayerEventRequest, 'The event to schedule'),
			responses: {
				200: json(PlayerEventResultDto, 'The created event'),
				400: {
					description:
						'Name over 64 or description over 512 characters, or a window that is ' +
						'backwards or longer than 24 hours (empty body)',
				},
				401: UNAUTHORIZED_RESPONSE,
			},
		}),
		async (c) => {
			const id = await authedId(c)
			if (id === null) return unauthorized(c)
			const body = await c.req.json<unknown>().catch(() => ({}))
			const input = parseEventBody(body)
			// The one thing this route isn't lenient about. Everything else here defaults a
			// missing or unusable field, but a name or description past the stored length
			// can't be defaulted into something sensible — and truncating a player's event
			// description silently is worse than refusing it.
			if (eventInputRejection(input) !== null) return c.body(null, 400)
			const event = await createEvent(c.env.DB, id, input)
			await notifyEventCreated(c, event, input.tags ?? [])
			// Read the tags back rather than echoing what was posted: the envelope reports what
			// the event now carries, which is what the client redraws its chips from.
			return c.json(await eventResult(c, event, await getEventTags(c.env.DB, event.PlayerEventId)))
		}
	)

	// Delete an event. Creator-only, and it takes the RSVPs and tags with it — a cancelled
	// event that left its `event_attendee` rows behind would keep being counted, and its
	// `event_tag` rows would keep answering `#tag` searches for an event nobody can open.
	//
	// Registered for POST and DELETE both: the path spells the verb itself (`/delete/{id}`),
	// which is how the reference exposes it, and a client that reaches for the HTTP verb
	// instead should not get a 404 for being right.
	//
	// Answers the v2 envelope with both payload fields nulled —
	// `{ PlayerEvent: null, Result: 0, TagModifyResult: null }`, which is what the reference
	// sends: there is nothing left to redraw. An unknown event is 404, and someone else's 403.
	.on(
		['POST', 'DELETE'],
		'/api/playerevents/v2/delete/:eventId{[0-9]+}',
		describeRoute({
			tags: ['Events'],
			summary: 'Delete a player event',
			description:
				'Deletes an event the caller created, along with its RSVPs and its tags — an event ' +
				'whose attendee rows outlived it would still be counted, and its tags would still ' +
				'answer `#tag` searches.\n\n' +
				'Creator only: anyone else gets 403, and an unknown event 404. Answers the v2 ' +
				'envelope with `PlayerEvent` and `TagModifyResult` both null — the event is gone, ' +
				'so there is nothing for the client to redraw from, and it reads only `Result`. ' +
				'Both POST and DELETE reach it — the path names the verb, which is the form the ' +
				'client uses.',
			security: AUTHED,
			parameters: [idParam('eventId', 'Event id')],
			responses: {
				200: json(PlayerEventDeletedDto, 'The nulled envelope a delete answers with'),
				401: UNAUTHORIZED_RESPONSE,
				403: { description: 'Not the event’s creator (empty body)' },
				404: { description: 'No such event (empty body)' },
			},
		}),
		async (c) => {
			const id = await authedId(c)
			if (id === null) return unauthorized(c)

			const eventId = Number.parseInt(c.req.param('eventId'), 10)
			const existing = await getEventById(c.env.DB, eventId)
			if (existing === null) return c.body(null, 404)
			if (existing.CreatorPlayerId !== id) return c.body(null, 403)

			await deleteEvent(c.env.DB, eventId)
			// Both payload fields are null here — the delete envelope is not the one the other
			// v2 routes answer with. Nothing is left to redraw, and the client reads `Result`.
			return c.json(EVENT_DELETED_RESULT)
		}
	)

	// Read one event in the v2 envelope — the same `{ PlayerEvent, Result, TagModifyResult }`
	// the writes answer, so a client that just created or edited an event and one that is
	// opening it cold parse the same thing.
	//
	// The v1 read next to it stays the BARE record on purpose: it is a different shape for a
	// different caller (no envelope, `State` present, tags only behind `includeDetails`).
	// Two shapes of one event; don't unify them.
	.get(
		'/api/playerevents/v2/:eventId{[0-9]+}',
		describeRoute({
			tags: ['Events'],
			summary: 'One player event (v2 envelope)',
			description:
				'A single event wrapped in the same `{ PlayerEvent, Result, TagModifyResult }` ' +
				'envelope the v2 writes answer with — `Tags` inline, `BroadcastingRoomInstanceId` ' +
				'present, no `State`. 404 when there is no such event.\n\n' +
				'`TagModifyResult` carries the event’s tags here too, even though a read edits ' +
				'nothing: the client reads its chips out of that field either way.',
			parameters: [idParam('eventId', 'Event id')],
			responses: {
				200: json(PlayerEventResultDto, 'The event in the v2 envelope'),
				404: { description: 'No such event (empty body)' },
			},
		}),
		async (c) => {
			const eventId = Number.parseInt(c.req.param('eventId'), 10)
			const event = await getEventById(c.env.DB, eventId)
			if (event === null) return c.body(null, 404)
			return c.json(await eventResult(c, event, await getEventTags(c.env.DB, eventId)))
		}
	)

	// Update. Creator-only, and a partial body only changes what it carries.
	.post(
		'/api/playerevents/v2/:eventId{[0-9]+}',
		describeRoute({
			tags: ['Events'],
			summary: 'Update a player event',
			description:
				'Edits an event the caller created. Only the fields the body carries change; ' +
				'everything else keeps its stored value, so a partial post can’t blank out the ' +
				'rest of the event. A posted `null` on `ImageName` / `SubRoomId` / `ClubId` does ' +
				'clear it.\n\n' +
				'The id, the creator and the attendee count are not editable: ownership doesn’t ' +
				'transfer and RSVPs aren’t set by hand. Creator only — anyone else gets 403, and ' +
				'an unknown event is 404. Answers the same envelope as create.\n\n' +
				'The 24-hour window cap applies to what the post RESOLVES to, not to what it ' +
				'carries: moving the start alone still has to leave a window that ends after it ' +
				'and runs no longer than a day against the STORED end.',
			security: AUTHED,
			parameters: [idParam('eventId', 'Event id')],
			requestBody: jsonBody(PlayerEventRequest, 'The fields to change'),
			responses: {
				200: json(PlayerEventResultDto, 'The updated event'),
				400: {
					description:
						'Name over 64 or description over 512 characters, or a resolved window that ' +
						'is backwards or longer than 24 hours (empty body)',
				},
				401: UNAUTHORIZED_RESPONSE,
				403: { description: 'Not the event’s creator (empty body)' },
				404: { description: 'No such event (empty body)' },
			},
		}),
		async (c) => {
			const id = await authedId(c)
			if (id === null) return unauthorized(c)
			const eventId = Number.parseInt(c.req.param('eventId'), 10)
			const existing = await getEventById(c.env.DB, eventId)
			if (existing === null) return c.body(null, 404)
			if (existing.CreatorPlayerId !== id) return c.body(null, 403)

			const body = await c.req.json<unknown>().catch(() => ({}))
			const input = parseEventBody(body)
			// The stored event is passed so the window rule resolves against the bound this
			// post isn't moving: an edit that only shifts the start still has to land inside
			// a day of the end already stored.
			if (eventInputRejection(input, existing) !== null) return c.body(null, 400)
			const updated = await updateEvent(c.env.DB, eventId, input)
			// updateEvent only returns null when the row vanished, which the read above rules out.
			return c.json(await eventResult(c, updated!, await getEventTags(c.env.DB, eventId)))
		}
	)

	// ---- Single-field edits -------------------------------------------------
	// The event-settings screen edits one field at a time rather than posting the whole
	// event back, so each of these is a PUT alongside the whole-event update above. They
	// share its rules — creator-only, 404/403/401 the same way — and answer the same v2
	// envelope, which is what the client re-renders the event from.
	//
	// Note the bodies are FORM-encoded (the tags one excepted), where the whole-event
	// writes next to them are JSON. That is what the client sends; don't unify them.

	// Move an event's window. Either bound alone is enough — an absent one keeps its
	// stored value, so the start can be nudged without restating the end.
	.put(
		'/api/playerevents/v2/:eventId{[0-9]+}/time',
		describeRoute({
			tags: ['Events'],
			summary: 'Reschedule a player event',
			description:
				'Moves an event’s window. `startTime` and `endTime` are both optional and both ' +
				'independent: an absent bound keeps the stored one, so the start can be nudged ' +
				'without restating the end. Any parseable ISO 8601 is accepted — the client sends ' +
				'.NET tick precision (`2026-08-31T17:30:00.0000000Z`) — and stored trimmed to ' +
				'seconds, the form every read serves.\n\n' +
				'A bound that is present but unparseable is a 400 rather than being dropped: a ' +
				'reschedule that silently did nothing is worse than a refusal. So is a window that ' +
				'ends before it starts, or one running longer than 24 HOURS — an event lasts at ' +
				'most a day. Both are checked against the RESOLVED window, so sending one bound ' +
				'is measured against the stored other one.\n\n' +
				'Creator only, like the whole-event update; answers the same v2 envelope.',
			security: AUTHED,
			parameters: [idParam('eventId', 'Event id')],
			requestBody: form(PlayerEventTimeRequest, 'The new window'),
			responses: {
				200: json(PlayerEventResultDto, 'The rescheduled event'),
				400: {
					description:
						'An unparseable time, an end before the start, or a window over 24 hours ' +
						'(empty body)',
				},
				401: UNAUTHORIZED_RESPONSE,
				403: { description: 'Not the event’s creator (empty body)' },
				404: { description: 'No such event (empty body)' },
			},
		}),
		editEventField(async (c, event) => {
			const body = await formBody(c)
			// Absent leaves the stored bound alone; present-but-unusable is refused, which is
			// the distinction `parseEventBody` deliberately collapses for the JSON writes.
			const startTime = parseEventTime(body.startTime)
			const endTime = parseEventTime(body.endTime)
			if (body.startTime !== undefined && startTime === undefined) return null
			if (body.endTime !== undefined && endTime === undefined) return null
			// The window rules — ends after it starts, runs no longer than a day — live with
			// the other write validation, resolved against the bound this edit isn't moving.
			const input = { startTime, endTime }
			return eventInputRejection(input, event) === null ? input : null
		})
	)

	// Change an event's visibility. The NAME of the enum, as the subroom route in `rooms`
	// takes it — not the ordinal the event's JSON writes carry.
	.put(
		'/api/playerevents/v2/:eventId{[0-9]+}/accessibility',
		describeRoute({
			tags: ['Events'],
			summary: 'Set a player event’s accessibility',
			description:
				'Sets an event’s visibility. The client sends the `RoomAccessibility` NAME here ' +
				'(`accessibility=Unlisted`), the way it does on the subroom route in `rooms` — not ' +
				'the ordinal the event’s JSON writes carry, though the ordinal is accepted too.\n\n' +
				'A value naming nothing in the enum is a 400 rather than being defaulted or stored ' +
				'verbatim: guessing a visibility wrong is what shows a private event to everyone. ' +
				'Creator only; answers the same v2 envelope.',
			security: AUTHED,
			parameters: [idParam('eventId', 'Event id')],
			requestBody: form(PlayerEventAccessibilityRequest, 'The new visibility'),
			responses: {
				200: json(PlayerEventResultDto, 'The updated event'),
				400: { description: 'Missing or unrecognized `accessibility` (empty body)' },
				401: UNAUTHORIZED_RESPONSE,
				403: { description: 'Not the event’s creator (empty body)' },
				404: { description: 'No such event (empty body)' },
			},
		}),
		editEventField(async (c) => {
			const accessibility = parseEventAccessibility((await formBody(c)).accessibility)
			return accessibility === undefined ? null : { accessibility }
		})
	)

	// Replace an event's tags. A BARE JSON ARRAY of names, unlike the other edits here.
	.put(
		'/api/playerevents/v2/:eventId{[0-9]+}/tags',
		describeRoute({
			tags: ['Events'],
			summary: 'Set a player event’s tags',
			description:
				'Replaces an event’s whole tag set. The body is a BARE JSON ARRAY of names — ' +
				'`["tag1","class"]` — not the form encoding the other single-field edits use, and ' +
				'not an object; the `{ tag, type }` pairs the create/update bodies accept work too. ' +
				'A replace, not a merge: untagging is a PUT with the tag left out, and `[]` clears ' +
				'them all.\n\n' +
				'Names are lowercased and a leading `#` stripped, matching what the `#tag` search ' +
				'looks for. A body that is not an array is a 400. Creator only; answers the same v2 ' +
				'envelope, whose `TagModifyResult` carries the set the event now has.',
			security: AUTHED,
			parameters: [idParam('eventId', 'Event id')],
			requestBody: jsonBody(PlayerEventTagsRequest, 'The whole tag set'),
			responses: {
				200: json(PlayerEventResultDto, 'The updated event, with its new tags'),
				400: { description: 'The body is not a JSON array (empty body)' },
				401: UNAUTHORIZED_RESPONSE,
				403: { description: 'Not the event’s creator (empty body)' },
				404: { description: 'No such event (empty body)' },
			},
		}),
		editEventField(async (c) => {
			const body = await c.req.json<unknown>().catch(() => undefined)
			const tags = parseEventTags(body)
			return tags === undefined ? null : { tags }
		})
	)

	// Rewrite an event's blurb. An absent field clears it — the client sends no field for
	// an emptied box, like the room description route in `rooms`.
	.put(
		'/api/playerevents/v2/:eventId{[0-9]+}/description',
		describeRoute({
			tags: ['Events'],
			summary: 'Set a player event’s description',
			description:
				'Rewrites an event’s blurb. An absent `description` CLEARS it — an emptied text box ' +
				'sends no field, the same way the room description route in `rooms` behaves — so ' +
				'this is the one edit here that can’t be a no-op.\n\n' +
				'Capped at 512 characters, the stored length, and refused rather than truncated: ' +
				'silently cutting a player’s text off is worse than telling them. Creator only; ' +
				'answers the same v2 envelope.',
			security: AUTHED,
			parameters: [idParam('eventId', 'Event id')],
			requestBody: form(PlayerEventDescriptionRequest, 'The new description'),
			responses: {
				200: json(PlayerEventResultDto, 'The updated event'),
				400: { description: 'Description over 512 characters (empty body)' },
				401: UNAUTHORIZED_RESPONSE,
				403: { description: 'Not the event’s creator (empty body)' },
				404: { description: 'No such event (empty body)' },
			},
		}),
		editEventField(async (c) => {
			const raw = (await formBody(c)).description
			const description = typeof raw === 'string' ? raw : ''
			return eventInputRejection({ description }) === null ? { description } : null
		})
	)

	// Rename an event. Unlike the description, a blank one is refused: `updateEvent` reads
	// an empty name as "leave it alone", so storing one is impossible anyway — and an event
	// with no title renders as a blank row.
	.put(
		'/api/playerevents/v2/:eventId{[0-9]+}/name',
		describeRoute({
			tags: ['Events'],
			summary: 'Rename a player event',
			description:
				'Retitles an event. Capped at 64 characters, the stored length, and refused rather ' +
				'than truncated. A blank name is refused too — an event with no title renders as a ' +
				'blank row, and the whole-event update reads an empty name as “leave it alone”, so ' +
				'there is no way to store one regardless. The name is stored trimmed.\n\n' +
				'No uniqueness rule: two events may share a title, unlike a room name. Creator ' +
				'only; answers the same v2 envelope.',
			security: AUTHED,
			parameters: [idParam('eventId', 'Event id')],
			requestBody: form(PlayerEventNameRequest, 'The new title'),
			responses: {
				200: json(PlayerEventResultDto, 'The renamed event'),
				400: { description: 'A blank name, or one over 64 characters (empty body)' },
				401: UNAUTHORIZED_RESPONSE,
				403: { description: 'Not the event’s creator (empty body)' },
				404: { description: 'No such event (empty body)' },
			},
		}),
		editEventField(async (c) => {
			const raw = (await formBody(c)).name
			const name = typeof raw === 'string' ? raw.trim() : ''
			if (name === '' || eventInputRejection({ name }) !== null) return null
			return { name }
		})
	)

	// An event's guest list — every RSVP row, whatever the answer.
	.get(
		'/api/playerevents/v1/:eventId{[0-9]+}/responses',
		describeRoute({
			tags: ['Events'],
			summary: 'An event’s RSVPs',
			description:
				'Every answer given to an event, in the order they were given — declines and ' +
				'maybes included, not just the Going rows `AttendeeCount` counts. One entry per ' +
				'player: a player who changed their mind has one row carrying the answer that ' +
				'stands, and `CreatedAt` moves with it.\n\n' +
				'A bare array, and an unknown event is an empty one rather than a 404 — like the ' +
				'other list reads here. An event always has at least its creator’s Going row.',
			parameters: [idParam('eventId', 'Event id')],
			responses: { 200: json(PlayerEventResponseDto.array(), 'The event’s RSVPs') },
		}),
		async (c) => {
			const eventId = Number.parseInt(c.req.param('eventId'), 10)
			const attendees = await getEventAttendees(c.env.DB, eventId)
			return c.json(attendees.map(toEventResponse))
		}
	)

	// A single event. Registered last so the literal `/bulk` and `/search` paths above
	// are matched first; the `[0-9]+` constraint keeps them apart regardless.
	.get(
		'/api/playerevents/v1/:eventId{[0-9]+}',
		describeRoute({
			tags: ['Events'],
			summary: 'One player event',
			description:
				'A single event by id, served as the bare record — no envelope, unlike the ' +
				'create/update writes. 404 when there is no such event.\n\n' +
				'`includeDetails=True` adds exactly one field, the lowercase `tags` — that is the ' +
				'whole of what the flag does. It is always an empty array here: no event tags are ' +
				'stored (see the tag-filter chips, which are static, and `TagModifyResult`, which ' +
				'is always null). Without the flag the key is ABSENT rather than empty, since a ' +
				'caller that didn’t ask for details shouldn’t be told the event has no tags.',
			parameters: [
				idParam('eventId', 'Event id'),
				stringQuery('includeDetails', 'Pass `True` to add the `tags` array'),
			],
			responses: {
				200: json(PlayerEventDetailsDto, 'The event, with `tags` when details were asked for'),
				404: { description: 'No such event (empty body)' },
			},
		}),
		async (c) => {
			const eventId = Number.parseInt(c.req.param('eventId'), 10)
			const event = await getEventById(c.env.DB, eventId)
			if (event === null) return c.body(null, 404)
			// The client sends `True`; accepted case-insensitively, and `1` alongside it.
			const details = /^(true|1)$/i.test(c.req.query('includeDetails') ?? '')
			if (!details) return c.json(event)
			return c.json({ ...event, tags: await getEventTags(c.env.DB, eventId) })
		}
	)
