import { Hono } from 'hono'
import { describeRoute } from 'hono-openapi'

import { logger } from '@repo/hono-helpers'

// The notification-type ids the hub carries (owned by the `notify` worker). Imported
// as a value — the enum has no runtime dependencies.
import { NotificationType } from '../../../notify/src/notification-types'
import {
	createEvent,
	deleteEvent,
	eventInputRejection,
	getEventAttendees,
	getEventById,
	getEventResponse,
	getEventsByClubs,
	getEventsByCreator,
	getEventsByIds,
	getEventTags,
	getLiveEvents,
	inviteToEvent,
	isEventResponseType,
	parseEventBody,
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
	idParam,
	intQuery,
	json,
	jsonBody,
	pageParams,
	PlayerEventBaseDto,
	PlayerEventBulkInviteRequest,
	PlayerEventDetailsDto,
	PlayerEventDto,
	PlayerEventReportRequest,
	PlayerEventRequest,
	PlayerEventRespondRequest,
	PlayerEventResponseDto,
	PlayerEventResultDto,
	PlayerEventsAll,
	PlayerEventsPage,
	stringQuery,
	SuccessErrorEnvelope,
	TagFilters,
	UNAUTHORIZED_RESPONSE,
} from '../openapi'
import { createReport } from '../reports-db'

import type { Context } from 'hono'
import type { PlayerEventResponsePayload } from '../../../notify/src/notification-payloads'
import type { App } from '../context'
import type { EventAttendeeRow, EventTag, PlayerEvent } from '../events-db'

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
			return c.json(toEventResult(updated, await getEventTags(c.env.DB, eventId)))
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
			return c.json(toEventResult(result!.event, await getEventTags(c.env.DB, eventId)))
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
				'Also pushes a `PlayerEventCreated` (80) hub notification to the creator, carrying ' +
				'the event in its camelCase notification projection. A hub failure is logged and ' +
				'swallowed — the event is already stored by then.',
			security: AUTHED,
			requestBody: jsonBody(PlayerEventRequest, 'The event to schedule'),
			responses: {
				200: json(PlayerEventResultDto, 'The created event'),
				400: { description: 'Name over 64 or description over 512 characters (empty body)' },
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
			return c.json(toEventResult(event, await getEventTags(c.env.DB, event.PlayerEventId)))
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
	// Answers the v2 envelope carrying the event as it WAS, so the caller can report what it
	// removed; an unknown event is 404, and someone else's is 403.
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
				'envelope carrying the event as it was just before it went. Both POST and DELETE ' +
				'reach it — the path names the verb, which is the form the client uses.',
			security: AUTHED,
			parameters: [idParam('eventId', 'Event id')],
			responses: {
				200: json(PlayerEventResultDto, 'The event that was deleted'),
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

			// Read the tags before the delete takes them, so the envelope can still report what
			// the event carried.
			const tags = await getEventTags(c.env.DB, eventId)
			const deleted = await deleteEvent(c.env.DB, eventId)
			// deleteEvent only answers null when the row vanished, which the read above rules out.
			return c.json(toEventResult(deleted!, tags))
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
			return c.json(toEventResult(event, await getEventTags(c.env.DB, eventId)))
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
				'an unknown event is 404. Answers the same envelope as create.',
			security: AUTHED,
			parameters: [idParam('eventId', 'Event id')],
			requestBody: jsonBody(PlayerEventRequest, 'The fields to change'),
			responses: {
				200: json(PlayerEventResultDto, 'The updated event'),
				400: { description: 'Name over 64 or description over 512 characters (empty body)' },
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
			if (eventInputRejection(input) !== null) return c.body(null, 400)
			const updated = await updateEvent(c.env.DB, eventId, input)
			// updateEvent only returns null when the row vanished, which the read above rules out.
			return c.json(toEventResult(updated!, await getEventTags(c.env.DB, eventId)))
		}
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
