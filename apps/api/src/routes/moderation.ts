import { Hono } from 'hono'
import { describeRoute } from 'hono-openapi'

import {
	canModerateRoom,
	deletePresence,
	getPlayerIdsInInstance,
	getPresences,
	getRoomById,
	getStoredRoomInstance,
	MessageType,
	refreshInstanceFullness,
} from '@repo/domain'
import { logger } from '@repo/hono-helpers'

// The notification-type ids the hub carries (owned by the `notify` worker). Imported as a
// value — the enum has no runtime dependencies.
import { KickReportCategory } from '../../../notify/src/notification-payloads'
import { NotificationType } from '../../../notify/src/notification-types'
import { authedId, authedRoles, unauthorized } from '../http'
import {
	AUTHED,
	BareBoolean,
	CreateReportRequest,
	CreateWarningRequest,
	DeviceIdRequest,
	form,
	InstantKickRequest,
	json,
	JsonArray,
	jsonBody,
	ModerationBlockDetails,
	SuccessErrorEnvelope,
	UNAUTHORIZED_RESPONSE,
	VoteToKickReason,
	VoteToKickRequest,
} from '../openapi'
import { createReport, getActiveBan } from '../reports-db'
import { createWarning } from '../warnings-db'

import type { Context } from 'hono'
import type { ModerationKickPayload } from '../../../notify/src/notification-payloads'
import type { App } from '../context'
import type { ReportRow } from '../reports-db'

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

/**
 * The vote-to-kick reasons, in the order the client renders them. `ReportCategory` is the
 * category the report a carried vote files: 102 hate, 101 sexual content, 103 griefing,
 * and 6 for the game-conduct reasons, which are kick-worthy without being a policy
 * violation of their own.
 */
const VOTE_TO_KICK_REASONS = [
	{ Reason: 'Discriminatory language', ReportCategory: 102 },
	{ Reason: 'Discriminatory behavior', ReportCategory: 102 },
	{ Reason: 'Threats or encouraging suicide', ReportCategory: 102 },
	{ Reason: 'Toxic behavior', ReportCategory: 102 },
	{ Reason: 'Sexual behavior in public', ReportCategory: 101 },
	{ Reason: 'Sexual language in public', ReportCategory: 101 },
	{ Reason: 'Non-consensual sexual behavior', ReportCategory: 101 },
	{ Reason: 'Player in walls or floor', ReportCategory: 103 },
	{ Reason: 'Friendly fire', ReportCategory: 103 },
	{ Reason: 'Microphone spam', ReportCategory: 103 },
	{ Reason: 'Abusing bugs or exploits', ReportCategory: 103 },
	{ Reason: 'Spawn camping', ReportCategory: 103 },
	{ Reason: 'Inactive in games (AFK)', ReportCategory: 6 },
	{ Reason: 'Prefab swapping', ReportCategory: 6 },
	{ Reason: 'Not following game rules', ReportCategory: 6 },
] as const

/** The notifications hub is a single global DO instance (see the `notify` worker). */
const HUB_INSTANCE = 'global'

/**
 * Eject players from the instance they're standing in — the `ModerationKick` frame (id 22)
 * the client acts on to leave a room, the same one a room ban sends (`rooms`:
 * `pushRoomBan`). This one only kicks: `IsBan` is false, so nothing keeps them from walking
 * straight back in, and no ban row exists to lift.
 *
 * Sent EPHEMERALLY, unlike the ban's frame, and to the whole batch in one round-trip. A
 * kick is only true of the moment it happened: queued and delivered on the player's next
 * connect it would throw them out of some unrelated session hours later. A recipient who
 * has already gone offline needs no kick anyway.
 *
 * `GameSessionId` is the instance they're being removed from — every recipient is in it,
 * which is what the caller checked before this runs. `IsHostKick` is always true: this
 * endpoint is the room's own staff acting, never the room majority vote-kicking (that path
 * would carry `VoteKick` and false). Built against the client's recovered payload interface
 * so a renamed key fails the build rather than vanishing on the wire.
 *
 * Best-effort — presence is already deleted by the time this runs, so a hub hiccup must
 * not fail the request.
 */
async function pushInstantKick(
	c: Context<App>,
	playerIds: number[],
	gameSessionId: number,
	roomName: string,
	moderatorId: number
): Promise<void> {
	const frame: ModerationKickPayload = {
		ReportCategory: KickReportCategory.Moderator,
		Duration: 0,
		GameSessionId: gameSessionId,
		IsHostKick: true,
		Message: `You have been kicked from ${roomName}.`,
		PlayerIdReporter: moderatorId,
		IsBan: false,
		IsVoiceModAutoban: false,
		IsWarning: false,
		VoteKickReason: '',
		TimeoutStartedAt: null,
	}
	try {
		await c.env.RECFLARE_NOTIFICATIONS_HUB.getByName(HUB_INSTANCE).notifyPlayersEphemeral(
			playerIds,
			NotificationType.ModerationKick,
			{ ...frame }
		)
	} catch (err) {
		logger.error('failed to push ModerationKick notification', {
			playerIds,
			gameSessionId,
			error: err instanceof Error ? err.message : String(err),
		})
	}
}

/**
 * What a vote-to-kick Message's `Data` says, BEFORE it is serialized. It reaches the
 * client as an escaped JSON string, never as a nested object — a Message's `Data` is a
 * string on the wire like every other Message's, and the client's decoder rejects an
 * object outright: `expected:'String Begin Token', actual:'{'`, which aborts the whole
 * notification rather than dropping the field. Serialize it with {@link voteToKickData}.
 *
 * `PlayerId` is the account id as a STRING — the reference passes the posted form field
 * straight through, and this mirrors it verbatim.
 *
 * `Response` is the empty string even though the caller posted their own vote: the frame
 * is the PROMPT put to everyone else, so it carries no answer yet. The caller's `Response`
 * is theirs alone and is not relayed.
 */
interface VoteToKickData {
	PlayerId: string
	Response: string
	GameSessionId: number
}

/** Serialize a {@link VoteToKickData} into the escaped JSON string `Data` carries. */
const voteToKickData = (data: VoteToKickData): string => JSON.stringify(data)

/**
 * The Message a vote-to-kick frame carries — the same four fields as every other Message
 * this server sends (see the `social` routes' `Message`), `Data` string included. A type
 * alias rather than an interface: the hub's send takes an index-signature record, which
 * only aliases satisfy implicitly.
 */
type VoteToKickMessage = {
	FromPlayerId: number
	ToPlayerId: number
	Type: number
	Data: string
}

/**
 * Put a vote-to-kick to one player — a `MessageReceived` frame carrying a Message of type
 * 5 (`VoteToKick`), the frame their client raises the vote prompt from. Resolves false when
 * the hub could not be reached, which the caller reports honestly: nothing stores a vote,
 * so the notification is the whole delivery.
 *
 * EPHEMERAL, unlike the messages the social routes send. A vote belongs to the moment it
 * was called: queued for an offline player, it would raise a prompt on their next connect
 * about a session that ended hours ago, and there would be nothing left to vote on.
 */
async function pushVoteToKick(c: Context<App>, message: VoteToKickMessage): Promise<boolean> {
	try {
		await c.env.RECFLARE_NOTIFICATIONS_HUB.getByName(HUB_INSTANCE).notifyPlayerEphemeral(
			message.ToPlayerId,
			NotificationType.MessageReceived,
			message
		)
		return true
	} catch (err) {
		logger.error('failed to push VoteToKick MessageReceived notification', {
			toPlayerId: message.ToPlayerId,
			error: err instanceof Error ? err.message : String(err),
		})
		return false
	}
}

/**
 * `Duration` on a permanent ban: 0, "no end". `IsBan` is what says the player is blocked;
 * `Duration` only says for how long, and a ban with no expiry has no length to give. Not
 * the int32-max sentinel E12354 uses — that reads as a 68-year countdown.
 */
const PERMANENT_BAN_DURATION = 0

/** The "not blocked" answer — the reference server's stub `ReturnModerationBlockDetails()`. */
const NOT_BLOCKED = {
	ReportCategory: -1,
	Duration: 0,
	GameSessionId: 0,
	IsBan: false,
	IsHostKick: false,
	IsVoiceModAutoban: false,
	Message: null,
	PlayerIdReporter: null,
	TimeoutStartedAt: null,
}

/**
 * The block details for a ban in force — the `report` row a moderator set `banned` on.
 *
 * `Duration` is the seconds left on the ban (rounded up, so a ban with a second to run
 * doesn't read as over), or `PERMANENT_BAN_DURATION` (0, no end) when `ban_expires` is
 * NULL — `IsBan` alone marks the block, so the "not blocked" answer and a permanent ban
 * share a `Duration` of 0 without being confused. The
 * category is the one the report was filed under, so the client's ban screen names the
 * reason. `Message` is a fixed "Rule violation" rather than the report's `details` —
 * those are the REPORTER's words, and the banned player isn't shown them, for the same
 * reason `PlayerIdReporter` stays null: the reporter is not a host who kicked them, and
 * naming them would tell the banned player who reported them. `IsHostKick`,
 * `IsVoiceModAutoban` and `TimeoutStartedAt` describe the OTHER kinds of block, none of
 * which this server hands out.
 */
function banBlockDetails(ban: ReportRow, now: Date) {
	const duration =
		ban.ban_expires === null
			? PERMANENT_BAN_DURATION
			: Math.max(1, Math.ceil((Date.parse(ban.ban_expires) - now.getTime()) / 1000))
	return {
		ReportCategory: ban.report_category,
		Duration: duration,
		GameSessionId: 0,
		IsBan: true,
		IsHostKick: false,
		IsVoiceModAutoban: false,
		Message: 'Rule violation',
		PlayerIdReporter: null,
		TimeoutStartedAt: null,
	}
}

// ---- Player reporting ------------------------------------------------------
export const moderationRoutes = new Hono<App>({ strict: false })
	// Whether the caller is currently blocked (banned / timed out / host-kicked). The one
	// kind of block this server has is the account-wide ban — a `report` row with `banned`
	// set (see `getActiveBan`), the same row matchmake refuses on — so a caller with one in
	// force gets it described here, and everyone else gets the "not blocked" answer of the
	// reference server's stub `ReturnModerationBlockDetails()`. This is the screen a banned
	// player is shown, which is why `auth` still issues them a token: without one the client
	// never gets here, and the ban reads as a failed sign-in.
	// Only the caller's OWN account is consulted, not the evasion arms `resolveBan` adds
	// at matchmake and login: this screen explains a ban handed to this account, and a
	// player blocked for sharing a network with a banned one has no report row to show.
	// In the "not blocked" answer `ReportCategory` is `Unknown` (-1) rather than 0, which
	// is a real category, and `Message` is null, not the empty string that stub sends —
	// the client distinguishes "no message" from a blank one. `IsVoiceModAutoban` /
	// `TimeoutStartedAt` are on the DTO but unset there, so they go out with their C#
	// defaults.
	// The newer client POSTs this with no body despite it being a pure read; it answers
	// GET too, so the path is reachable from either build.
	.on(
		['GET', 'POST'],
		'/api/PlayerReporting/v1/moderationBlockDetails',
		describeRoute({
			tags: ['Moderation'],
			summary: 'Whether the caller is blocked',
			description:
				'Ban / timeout / host-kick state for the caller. The one block this server hands ' +
				'out is the account-wide ban — a `report` row with `banned` set, the same row ' +
				'matchmake refuses on (login still issues a token, so the client can reach this ' +
				'screen) — so a caller with one in force gets ' +
				'`IsBan: true`, the `ReportCategory` the report was filed under, `Duration` as the ' +
				'seconds left (0 for a permanent ban, which has no end) and the fixed ' +
				'`Message` “Rule violation”. `PlayerIdReporter` stays null: it names a kicking ' +
				'host, and the reporter is not shown to the player they reported. Only the ' +
				'caller’s own account is consulted, not the ban-evasion arms.\n\n' +
				'Everyone else gets the reference server’s stub “not blocked” answer: ' +
				'`ReportCategory` is `Unknown` (-1) rather than 0, which is a real category, and ' +
				'`Message` is null rather than the empty string that stub sends — the client ' +
				'distinguishes “no message” from a blank one. `IsVoiceModAutoban` and ' +
				'`TimeoutStartedAt` are on the DTO but unset by that stub, so they carry their ' +
				'defaults. Answers GET or POST: the newer client POSTs it with no body.',
			security: AUTHED,
			responses: {
				200: json(ModerationBlockDetails, 'The caller’s block, or “not blocked”'),
				401: UNAUTHORIZED_RESPONSE,
			},
		}),
		async (c) => {
			const id = await authedId(c)
			if (id === null) return unauthorized(c)
			const now = new Date()
			const ban = await getActiveBan(c.env.DB, id, now)
			return c.json(ban ? banBlockDetails(ban, now) : NOT_BLOCKED)
		}
	)
	// The reasons the client offers when a player starts a vote-to-kick. Order matters —
	// the client renders them in the order they arrive — and the list is grouped by the
	// `ReportCategory` the resulting report is filed under, hate first, then sexual
	// content, then griefing, then the game-conduct reasons. Fixed and the same for
	// everyone, but auth-gated all the same, as the reference is.
	.get(
		'/api/PlayerReporting/v1/voteToKickReasons',
		describeRoute({
			tags: ['Moderation'],
			summary: 'Vote-to-kick reasons',
			description:
				'The reasons offered when starting a vote-to-kick, each with the `ReportCategory` ' +
				'the report is filed under if the vote carries: 102 hate, 101 sexual content, 103 ' +
				'griefing, 6 game conduct. A fixed list, in the order the client renders it.',
			security: AUTHED,
			responses: {
				200: json(VoteToKickReason.array(), 'The reasons, in render order'),
				401: UNAUTHORIZED_RESPONSE,
			},
		}),
		async (c) => {
			const id = await authedId(c)
			if (id === null) return unauthorized(c)
			return c.json(VOTE_TO_KICK_REASONS)
		}
	)
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
				'Records a player report in the `report` table; nothing dedupes the rows. A report ' +
				'is filed unbanned — a moderator converts one into an account-wide ban by setting ' +
				'`banned` on the row, which is what matchmaking refuses on and what ' +
				'`moderationBlockDetails` describes to the banned player.\n\n' +
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

	// A player calling a vote to kick another. Ungated by role — anyone may start one —
	// but both players have to be standing in the session the vote is called in, which is
	// what stops a client putting a vote to a room it isn't in, about someone who isn't
	// there. Nothing tallies the votes yet: this relays the prompt and no more.
	.post(
		'/api/PlayerReporting/v3/voteToKick',
		describeRoute({
			tags: ['Moderation'],
			summary: 'Call a vote to kick a player',
			description:
				'Puts a vote-to-kick to the room instance. Open to any player — no role is ' +
				'required — but BOTH the caller and `PlayerId` must have a live `presence` row in ' +
				'the instance `GameSessionId` names, or the call is refused with a 403. That is ' +
				'the whole gate: without it a client could raise a vote in a session it is not ' +
				'in, or against a player who is not there.\n\n' +
				'Everyone else in that instance — the player being voted on included, since a ' +
				'vote is called in front of them — gets a `MessageReceived` frame carrying a ' +
				'Message of type 5 (`VoteToKick`). The caller is left out: they have voted ' +
				'already, and their own `Response` is what they posted.\n\n' +
				'`Data` is an ESCAPED JSON STRING — `"{\\"PlayerId\\":\\"205\\",…}"`, not a nested ' +
				'object. A Message’s `Data` is a string on the wire, and an object there fails the ' +
				"client’s decoder outright (`expected:'String Begin Token', actual:'{'`), " +
				'aborting the notification rather than dropping the field. Inside it, `PlayerId` ' +
				'is the account id as a STRING, as the reference relays it, and `Response` is ' +
				'empty — the frame is the question, not an answer.\n\n' +
				'The frames are EPHEMERAL: a vote belongs to the moment it was called, so an ' +
				'offline player gets nothing rather than a prompt about a dead session on their ' +
				'next connect.\n\n' +
				'Nothing is stored — no tally, no report row, and `Reason` is accepted and ' +
				'unused. Answers the same lowercase `{ success, error }` envelope as the report ' +
				'write; a hub failure for any recipient is reported honestly as a 500, since ' +
				'with nothing behind it the frame is the whole delivery.',
			security: AUTHED,
			requestBody: form(VoteToKickRequest, 'The vote'),
			responses: {
				200: json(SuccessErrorEnvelope, '`{ success: true, error: "" }`'),
				400: json(SuccessErrorEnvelope, 'No `PlayerId` or no `GameSessionId`'),
				401: UNAUTHORIZED_RESPONSE,
				403: json(SuccessErrorEnvelope, 'Either player is not in that game session'),
				500: json(SuccessErrorEnvelope, 'The notifications hub could not be reached'),
			},
		}),
		async (c) => {
			const voterId = await authedId(c)
			if (voterId === null) return unauthorized(c)

			const body = await c.req.parseBody().catch(() => ({}) as Record<string, unknown>)
			// Kept as posted for the frame — `Data.PlayerId` goes out as the string the
			// reference relays — but parsed here to check it against presence.
			const playerIdField = formField(body, c, 'PlayerId')
			const playerId = asInt(playerIdField)
			if (playerIdField === undefined || playerId === null) {
				return c.json({ success: false, error: 'PlayerId is required' }, 400)
			}
			const gameSessionId = asInt(formField(body, c, 'GameSessionId'))
			if (gameSessionId === null) {
				return c.json({ success: false, error: 'GameSessionId is required' }, 400)
			}

			// One read for both players. A vote may only be called by someone standing in the
			// session, about someone standing in the same one — the session is read from live
			// presence, never from the body, so neither side can be asserted by the client.
			const presences = await getPresences<{ roomInstanceId?: number }>(c.env.DB, [
				voterId,
				playerId,
			])
			const isHere = (id: number) =>
				presences.get(id)?.roomInstance?.roomInstanceId === gameSessionId
			if (!isHere(voterId)) {
				return c.json({ success: false, error: 'You are not in that game session!' }, 403)
			}
			if (!isHere(playerId)) {
				return c.json({ success: false, error: 'That player is not in that game session!' }, 403)
			}

			// The room votes, so the audience is everyone standing there — the player being
			// voted on included; a vote is called in front of them. The caller is dropped:
			// their vote is the one they just posted.
			const audience = (await getPlayerIdsInInstance(c.env.DB, gameSessionId)).filter(
				(id) => id !== voterId
			)

			// Every recipient is attempted even if an earlier one fails, so the reachable
			// players still get the vote.
			const results = await Promise.all(
				audience.map((toPlayerId) =>
					pushVoteToKick(c, {
						FromPlayerId: voterId,
						ToPlayerId: toPlayerId,
						Type: MessageType.VoteToKick,
						// An escaped JSON STRING, not a nested object — see VoteToKickData.
						Data: voteToKickData({
							PlayerId: playerIdField,
							Response: '',
							GameSessionId: gameSessionId,
						}),
					})
				)
			)
			if (results.includes(false)) {
				return c.json({ success: false, error: 'Failed to deliver vote' }, 500)
			}

			return c.json({ success: true, error: '' })
		}
	)

	// The kick a room's own staff hand out from the moderation menu: eject named players
	// from ONE live instance. Two gates, and both matter — the caller must be able to
	// moderate the room the instance belongs to, and each named player must actually be
	// standing in that instance. Without the second, a creator could name any account id
	// and kick a stranger out of somebody else's room.
	.post(
		'/api/PlayerReporting/v1/instantKick',
		describeRoute({
			tags: ['Moderation'],
			summary: 'Kick players out of a room instance',
			description:
				'Ejects the named players from one live room instance. `GameSessionId` is that ' +
				'instance (`roomInstanceId`); the body is JSON, unlike the form posts elsewhere in ' +
				'this controller.\n\n' +
				'Gated to the instance’s room: the caller must be its creator or hold a role of ' +
				'Moderator (20) or above on it — anyone else with a valid token gets a 403. ' +
				'Nobody who can moderate the room can be kicked out of it, and a caller cannot ' +
				'kick themselves.\n\n' +
				'A player is only kicked if their live `presence` row puts them in **that** ' +
				'instance. Anyone else named — offline, or standing in another room — is skipped ' +
				'in silence, so naming an account id cannot reach into a session the caller has ' +
				'no authority over.\n\n' +
				'Each kicked player loses their presence row (they read offline at once and the ' +
				'instance frees a slot) and gets a `ModerationKick` frame (id 22) — the frame the ' +
				'client acts on to leave. It is the same frame a room ban sends, but `IsBan` is ' +
				'false: this only removes them from the session they are in, and nothing stops ' +
				'them rejoining. The frame is EPHEMERAL — a kick is true of the moment it ' +
				'happened, and queueing one would eject the player from an unrelated session on ' +
				'their next connect.\n\n' +
				'Answers the same lowercase `{ success, error }` envelope the report write uses, ' +
				'and says nothing about who was actually kicked — the response shape is ' +
				'unverified against the real service.',
			security: AUTHED,
			requestBody: jsonBody(InstantKickRequest, 'The instance and the players to eject'),
			responses: {
				200: json(SuccessErrorEnvelope, '`{ success: true, error: "" }`'),
				400: json(SuccessErrorEnvelope, 'Unparseable body, no `GameSessionId` or no `PlayerIds`'),
				401: UNAUTHORIZED_RESPONSE,
				403: json(SuccessErrorEnvelope, 'The caller cannot moderate the instance’s room'),
				404: json(SuccessErrorEnvelope, 'No such game session'),
			},
		}),
		async (c) => {
			const moderatorId = await authedId(c)
			if (moderatorId === null) return unauthorized(c)

			const body = (await c.req.json().catch(() => null)) as {
				GameSessionId?: unknown
				PlayerIds?: unknown
			} | null
			if (body === null) return c.json({ success: false, error: 'Invalid request body' }, 400)

			const gameSessionId = typeof body.GameSessionId === 'number' ? body.GameSessionId : Number.NaN
			if (!Number.isInteger(gameSessionId)) {
				return c.json({ success: false, error: 'GameSessionId is required' }, 400)
			}
			const playerIds = Array.isArray(body.PlayerIds)
				? body.PlayerIds.filter((id): id is number => Number.isInteger(id))
				: []
			if (playerIds.length === 0) {
				return c.json({ success: false, error: 'PlayerIds is required' }, 400)
			}

			// The instance names the room, and the room carries the roles this is gated on —
			// a game session with no room behind it can't authorise anything.
			const instance = await getStoredRoomInstance(c.env.DB, gameSessionId)
			const room = instance && (await getRoomById(c.env.DB, instance.roomId))
			if (!room) return c.json({ success: false, error: 'This game session does not exist!' }, 404)
			if (!canModerateRoom(room, moderatorId)) {
				return c.json({ success: false, error: 'Forbidden' }, 403)
			}

			// One read for the batch. A player is kicked only when their LIVE presence puts
			// them in this very instance: offline, expired or standing elsewhere are all the
			// same "not here", and are skipped rather than refused — the client sends a list
			// and one stale id in it must not sink the rest.
			const presences = await getPresences<{ roomInstanceId?: number }>(c.env.DB, playerIds)
			const kicked: number[] = []
			for (const playerId of playerIds) {
				// The room's own staff are not kickable out of their room — otherwise a
				// moderator could throw the creator out of it. Nor is the caller themselves.
				if (playerId === moderatorId || canModerateRoom(room, playerId)) continue
				if (presences.get(playerId)?.roomInstance?.roomInstanceId !== gameSessionId) continue
				await deletePresence(c.env.DB, playerId)
				kicked.push(playerId)
			}

			if (kicked.length > 0) {
				// The instance just lost players — recompute its fullness so a full room opens
				// back up, exactly as the `match` worker does when someone logs out.
				await refreshInstanceFullness(c.env.DB, gameSessionId)
				const roomName = typeof room.Name === 'string' ? room.Name : 'this room'
				await pushInstantKick(c, kicked, gameSessionId, roomName, moderatorId)
			}

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
