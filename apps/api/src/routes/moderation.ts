import { Hono } from 'hono'
import { describeRoute } from 'hono-openapi'

import { authedId, authedRoles, unauthorized } from '../http'
import {
	AUTHED,
	BareBoolean,
	CreateReportRequest,
	CreateWarningRequest,
	DeviceIdRequest,
	form,
	json,
	JsonArray,
	ModerationBlockDetails,
	SuccessErrorEnvelope,
	UNAUTHORIZED_RESPONSE,
} from '../openapi'
import { createReport } from '../reports-db'
import { createWarning } from '../warnings-db'

import type { Context } from 'hono'
import type { App } from '../context'

/**
 * Roles allowed to hand down a warning — the operator-granted elevated roles the auth
 * worker stamps from an account's isModerator/isDeveloper flags (see the admin CLI's
 * `grant-moderator` / `grant-developer`). Same set the `notify` / `www` workers gate
 * their admin surfaces on: a warning is a moderation action, but staff hold both.
 */
const MODERATOR_ROLES = new Set(['moderator', 'developer'])

/**
 * Read one field of a submitted form. The client posts these form-encoded, but the
 * same names also arrive as a query string on some builds, so both are accepted.
 */
function formField(
	body: Record<string, unknown>,
	c: Context<App>,
	name: string
): string | undefined {
	const raw = body[name]
	if (typeof raw === 'string' && raw !== '') return raw
	return c.req.query(name) || undefined
}

/** Parse a field as an integer, or null when absent / not a number. */
const asInt = (v: string | undefined): number | null => {
	if (v === undefined) return null
	const n = Number.parseInt(v, 10)
	return Number.isNaN(n) ? null : n
}

/** Parse a field as a float (the reported heights), or null when absent / not a number. */
const asFloat = (v: string | undefined): number | null => {
	if (v === undefined) return null
	const n = Number.parseFloat(v)
	return Number.isNaN(n) ? null : n
}

// ---- Player reporting ------------------------------------------------------
export const moderationRoutes = new Hono<App>({ strict: false })
	// Whether the caller is currently blocked (banned / timed out / host-kicked). Bans
	// are stored (a report row with `banned` set) and enforced at matchmake and at login,
	// but this endpoint is not wired to them, so it's always the "not blocked" answer —
	// the reference server's stub `ReturnModerationBlockDetails()`.
	// `ReportCategory` is `Unknown` (-1) rather than 0, which is a real category;
	// `Message` is null, not the empty string that stub sends — the client distinguishes
	// "no message" from a blank one. `IsVoiceModAutoban`/`TimeoutStartedAt` are on the
	// DTO but left unset there, so they go out with their C# defaults.
	// The newer client POSTs this with no body despite it being a pure read; it answers
	// GET too, so the path is reachable from either build.
	.on(
		['GET', 'POST'],
		'/api/PlayerReporting/v1/moderationBlockDetails',
		describeRoute({
			tags: ['Moderation'],
			summary: 'Whether the caller is blocked',
			description:
				'Ban / timeout / host-kick state for the caller. Bans are stored (a `report` row ' +
				'with `banned` set) and enforced at matchmake and at login, but this endpoint is ' +
				'not wired to them, so it is always the “not blocked” answer, following the ' +
				'reference server’s stub: `ReportCategory` is `Unknown` (-1) rather than 0, which ' +
				'is a real category, and `Message` is null rather than the empty string that stub ' +
				'sends — the client distinguishes “no message” from a blank one. ' +
				'`IsVoiceModAutoban` and `TimeoutStartedAt` are on the DTO but unset by that ' +
				'stub, so they carry their defaults. Answers GET or POST: the newer client POSTs ' +
				'it with no body.',
			responses: { 200: json(ModerationBlockDetails, 'Always “not blocked”') },
		}),
		(c) =>
			c.json({
				ReportCategory: -1,
				Duration: 0,
				GameSessionId: 0,
				IsBan: false,
				IsHostKick: false,
				IsVoiceModAutoban: false,
				Message: null,
				PlayerIdReporter: null,
				TimeoutStartedAt: null,
			})
	)
	.get(
		'/api/PlayerReporting/v1/voteToKickReasons',
		describeRoute({
			tags: ['Moderation'],
			summary: 'Vote-to-kick reasons',
			description:
				'The reasons offered when starting a vote-to-kick. Not hydrated yet, so the list ' +
				'is empty.',
			responses: { 200: json(JsonArray, 'An empty list') },
		}),
		(c) => c.json([])
	) // TODO: hydrate from JSON/vtkreasons.json
	// The client asking whether IT should run its referee moderation — the in-client
	// review flow a player with referee standing gets shown. Deliberately `false` for
	// everyone: this is an archival server, and the referee program is one of the live
	// moderation systems it does not run. Answering true would put the client into a flow
	// with no cases behind it. A POST despite being a pure read, which is how the client
	// asks.
	.post(
		'/api/PlayerReporting/v1/referee',
		describeRoute({
			tags: ['Moderation'],
			summary: 'Whether the caller is a referee',
			description:
				'A bare JSON `false` — no envelope. The game client asks this to decide whether to ' +
				'run its referee moderation flow. Always false: the referee program is switched ' +
				'off here rather than unimplemented, since this server is archival.',
			responses: { 200: json(BareBoolean, 'Always `false` — the program is off') },
		}),
		(c) => c.json(false)
	)
	// The referee's own case files — the reviews assigned to them. Empty for the same
	// reason the flag above is false: the program is off, so no case is ever assigned. A
	// caller reaching this at all has gone past that flag, so the empty list is a second
	// line of defence rather than the normal path. A GET, unlike its POSTing neighbours
	// in this flow.
	.get(
		'/api/referee/files',
		describeRoute({
			tags: ['Moderation'],
			summary: 'Referee case files',
			description:
				'The moderation cases assigned to the caller as a referee. Always empty — the ' +
				'referee program is switched off here (see `/api/PlayerReporting/v1/referee`), so ' +
				'nothing is ever assigned.',
			responses: { 200: json(JsonArray, 'An empty list — no cases are ever assigned') },
		}),
		(c) => c.json([])
	)
	.post(
		'/api/PlayerReporting/v1/hile',
		describeRoute({
			tags: ['Moderation'],
			summary: 'Report submission sink',
			description:
				'A player report. Nothing stores reports, so this accepts whatever it is sent and ' +
				'answers a bare `false`.',
			responses: { 200: json(BareBoolean, 'A bare JSON `false`') },
		}),
		(c) => c.json(false)
	)

	// The report the client actually submits. Auth-gated: the reporter is taken from
	// the bearer token rather than the body, so a report can't be filed as someone else.
	.post(
		'/api/PlayerReporting/v3/create',
		describeRoute({
			tags: ['Moderation'],
			summary: 'Submit a player report',
			description:
				'Records a player report in the `report` table; nothing dedupes the rows, and ' +
				'`moderationBlockDetails` still answers “not blocked” unconditionally. A report ' +
				'is filed unbanned — a moderator converts one into an account-wide ban by setting ' +
				'`banned` on the row, which is what matchmaking and `/connect/token` refuse on.\n\n' +
				'The reporter is the caller (from the bearer token), NOT a body field. Only ' +
				'`PlayerIdReported` is required; the client omits whatever it has no value for ' +
				'(a report raised outside a room carries no `RoomId`), and those are stored as ' +
				'NULL. `ReportCategory` and `RoomInstanceType` are stored verbatim — neither ' +
				'enum is mapped here. A `RoomId` of 0 or below means “no room”.\n\n' +
				'Answers the real service’s `{ success, error }` envelope, where `error` is an ' +
				'empty string rather than null. The rejected branch uses the same envelope so ' +
				'the client only ever parses one shape.',
			security: AUTHED,
			requestBody: form(CreateReportRequest, 'The report'),
			responses: {
				200: json(SuccessErrorEnvelope, '`{ success: true, error: "" }`'),
				400: json(SuccessErrorEnvelope, 'No `PlayerIdReported` in the request'),
				401: UNAUTHORIZED_RESPONSE,
			},
		}),
		async (c) => {
			const reporterId = await authedId(c)
			if (reporterId === null) return unauthorized(c)

			const body = await c.req.parseBody().catch(() => ({}) as Record<string, unknown>)
			const reportedPlayerId = asInt(formField(body, c, 'PlayerIdReported'))
			if (reportedPlayerId === null) {
				return c.json({ success: false, error: 'PlayerIdReported is required' }, 400)
			}

			// 0 / -1 are the client's "no room" values — store null rather than a bogus id.
			const roomId = asInt(formField(body, c, 'RoomId'))

			await createReport(c.env.DB, {
				reporterPlayerId: reporterId,
				reportedPlayerId,
				reportCategory: asInt(formField(body, c, 'ReportCategory')) ?? 0,
				details: formField(body, c, 'Details') ?? null,
				heightReporter: asFloat(formField(body, c, 'HeightReporter')),
				heightReported: asFloat(formField(body, c, 'HeightReported')),
				roomId: roomId !== null && roomId > 0 ? roomId : null,
				roomInstanceType: formField(body, c, 'RoomInstanceType') ?? null,
			})

			return c.json({ success: true, error: '' })
		}
	)

	// A warning handed down by a moderator — the staff-side counterpart to a report.
	// Gated on the `moderator` role in the token, not just a valid one.
	.post(
		'/api/playerwarnings',
		describeRoute({
			tags: ['Moderation'],
			summary: 'Issue a player warning',
			description:
				'Records a moderator-issued warning in the `warning` table — an append-only log ' +
				'like `report`; nothing dispatches the warning to the player or acts on the rows ' +
				'yet.\n\n' +
				'**Staff only.** The token must carry the `moderator` or `developer` role (granted ' +
				'per account by the operator, see the admin CLI’s `grant-moderator` / ' +
				'`grant-developer`); a valid token with neither gets a 403. The acting moderator ' +
				'is the caller, NOT a body field.\n\n' +
				'Only `WarnedPlayerId` is required; the rest are stored as NULL when absent. ' +
				'`ReportCategory` is stored verbatim — the enum is not mapped here. ' +
				'`DisplayReason` is what the warned player would be shown; `ModeratorNote` is ' +
				'internal and never surfaced to them.\n\n' +
				'Answers the same `{ success, error }` envelope as the report write, with `error` ' +
				'an empty string rather than null — including on the rejected branches, so there ' +
				'is only one shape to parse.',
			security: AUTHED,
			requestBody: form(CreateWarningRequest, 'The warning'),
			responses: {
				200: json(SuccessErrorEnvelope, '`{ success: true, error: "" }`'),
				400: json(SuccessErrorEnvelope, 'No `WarnedPlayerId` in the request'),
				401: UNAUTHORIZED_RESPONSE,
				403: json(SuccessErrorEnvelope, 'A valid token with neither staff role'),
			},
		}),
		async (c) => {
			const moderatorId = await authedId(c)
			if (moderatorId === null) return unauthorized(c)

			const roles = await authedRoles(c)
			if (!roles?.some((role) => MODERATOR_ROLES.has(role))) {
				return c.json({ success: false, error: 'Forbidden' }, 403)
			}

			const body = await c.req.parseBody().catch(() => ({}) as Record<string, unknown>)
			const warnedPlayerId = asInt(formField(body, c, 'WarnedPlayerId'))
			if (warnedPlayerId === null) {
				return c.json({ success: false, error: 'WarnedPlayerId is required' }, 400)
			}

			await createWarning(c.env.DB, {
				moderatorPlayerId: moderatorId,
				warnedPlayerId,
				reportCategory: asInt(formField(body, c, 'ReportCategory')) ?? 0,
				displayReason: formField(body, c, 'DisplayReason') ?? null,
				moderatorNote: formField(body, c, 'ModeratorNote') ?? null,
			})

			return c.json({ success: true, error: '' })
		}
	)

	// The client reporting its device id (form-encoded `oldDeviceId`, `newDeviceId`,
	// `platform`), rotating from the id it thinks we hold to the current one. Carries no
	// bearer token and fires before account creation, so there is no caller to attribute
	// the id to and nothing to store it against — we accept it and drop it. The real
	// service answers with a `{ success, error }` envelope.
	// @todo This doesn't do anything, in fact it breaks the client during account creation.
	// I have not been able to find a response shape that doesn't break, so in
	// https://github.com/djdevin/recnet-plugin we disable the device ID check to enable
	// account creation. Nothing in the logs, client just hangs, who knows what it is
	// waiting for.
	.post(
		'/api/PlayerReporting/v1/deviceId',
		describeRoute({
			tags: ['Moderation'],
			summary: 'Device id rotation (known broken)',
			description:
				'The client reporting its device id, rotating from the one it thinks we hold to ' +
				'the current one. It carries no bearer token and fires *before* account creation, ' +
				'so there is no caller to attribute the id to and nothing to store it against — ' +
				'we accept it and drop it.\n\n' +
				'**Known broken.** No response shape found so far keeps the client happy: it ' +
				'hangs during account creation with nothing in the logs. The real service answers ' +
				'a `{ success, error }` envelope; we currently answer an empty array, which does ' +
				'not help either. The workaround is to disable the device-id check client-side ' +
				'(see [recnet-plugin](https://github.com/djdevin/recnet-plugin)).',
			requestBody: form(DeviceIdRequest, 'The id rotation'),
			responses: {
				200: json(JsonArray, 'An empty array — see the note above; this is not the real shape'),
			},
		}),
		(c) => c.json([])
	)
