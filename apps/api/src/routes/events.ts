import { Hono } from 'hono'
import { describeRoute } from 'hono-openapi'

import { logger } from '@repo/hono-helpers'

// The notification-type ids the hub carries (owned by the `notify` worker). Imported
// as a value — the enum has no runtime dependencies.
import { NotificationType } from '../../../notify/src/notification-types'
import {
	createEvent,
	getEventById,
	getEventsByClubs,
	getEventsByCreator,
	getEventsByIds,
	getLiveEvents,
	isEventResponseType,
	eventInputRejection,
	parseEventBody,
	searchEvents,
	setEventResponse,
	toEventNotification,
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
	PlayerEventDto,
	PlayerEventRequest,
	PlayerEventRespondRequest,
	PlayerEventResultDto,
	PlayerEventsAll,
	PlayerEventsPage,
	stringQuery,
	TagFilters,
	UNAUTHORIZED_RESPONSE,
} from '../openapi'

import type { Context } from 'hono'
import type { App } from '../context'
import type { PlayerEvent } from '../events-db'

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
async function notifyEventCreated(c: Context<App>, event: PlayerEvent): Promise<void> {
	try {
		await c.env.RECFLARE_NOTIFICATIONS_HUB.getByName(HUB_INSTANCE).notifyPlayer(
			event.CreatorPlayerId,
			NotificationType.PlayerEventCreated,
			{ ...toEventNotification(event) }
		)
	} catch (err) {
		logger.error('failed to push PlayerEventCreated notification', {
			playerEventId: event.PlayerEventId,
			error: err instanceof Error ? err.message : String(err),
		})
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
				'The browse query on the player-events screen. `query` is matched ' +
				'case-insensitively against the event name and description, term by term; an empty ' +
				'query browses everything upcoming. Events that have already finished are left ' +
				'out — a name match on something that ended last month is noise on a browse ' +
				'screen. Soonest first, paginated via skip/take. A bare array.',
			parameters: [
				stringQuery('query', 'Search text; every term must match the name or description'),
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
			return updated === null ? c.body(null, 404) : c.json(toEventResult(updated))
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
			await notifyEventCreated(c, event)
			return c.json(toEventResult(event))
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
			return c.json(toEventResult(updated!))
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
				'create/update writes. 404 when there is no such event.',
			parameters: [idParam('eventId', 'Event id')],
			responses: {
				200: json(PlayerEventDto, 'The event'),
				404: { description: 'No such event (empty body)' },
			},
		}),
		async (c) => {
			const event = await getEventById(c.env.DB, Number.parseInt(c.req.param('eventId'), 10))
			return event === null ? c.body(null, 404) : c.json(event)
		}
	)
