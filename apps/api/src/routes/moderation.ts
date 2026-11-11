import { Hono } from 'hono'
import { describeRoute } from 'hono-openapi'

import {
	canManageRoom,
	canModerateRoom,
	countPlayersInInstance,
	getPlayerIdsInInstance,
	getPresence,
	getPresences,
	getRoomById,
	getStoredRoomInstance,
	MessageType,
	movePlayerToDorm,
} from '@repo/domain'
import { logger } from '@repo/hono-helpers'

// The message being reported, and whether the reporter can see it — `chat` owns both tables
// on the shared database, so its reads are used rather than restated here.
import { getMessage } from '../../../chat/src/message-db'
import { isThreadMember } from '../../../chat/src/thread-db'
// The notification-type ids the hub carries (owned by the `notify` worker). Imported as a
// value — the enum has no runtime dependencies.
import { KickReportCategory } from '../../../notify/src/notification-payloads'
import { NotificationType } from '../../../notify/src/notification-types'
import { authedId, authedStaff, unauthorized } from '../http'
import {
	AUTHED,
	BareBoolean,
	CreateChatReportRequest,
	CreateReportRequest,
	CreateReportResponse,
	CreateWarningRequest,
	DeviceIdRequest,
	form,
	InstantKickRequest,
	json,
	JsonArray,
	jsonBody,
	ModerationBlockDetails,
	RoomModKickRequest,
	SuccessErrorEnvelope,
	UNAUTHORIZED_RESPONSE,
	VoteToKickReason,
	VoteToKickRequest,
} from '../openapi'
import { banBlockDetails, createReport, getActiveBan, NOT_BLOCKED } from '../reports-db'
import {
	countKickVotes,
	getOpenVote,
	isKickMajority,
	isOnVoteCooldown,
	recordRoomVote,
} from '../votes-db'
import { createWarning } from '../warnings-db'

import type { Context } from 'hono'
import type { ModerationKickPayload } from '../../../notify/src/notification-payloads'
import type { App } from '../context'

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

/**
 * Whether a posted `Response` is a YES. The client sends `True`/`False`; `1`/`0` are accepted
 * beside them because the same field is an int elsewhere in this controller. Anything else —
 * absent included — is a no, which is the safe way round: an unreadable answer must not count
 * toward removing somebody.
 */
const isYesVote = (value: string | undefined): boolean =>
	value !== undefined && ['true', '1', 'yes'].includes(value.trim().toLowerCase())

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
 * Chat-report category names that are not a `KickReportCategory` member's own name. Only
 * `Discriminatory` has been seen on the wire; add the others as the client is seen to send
 * them, rather than guessing at an enum nobody here has a copy of.
 */
const CHAT_REPORT_CATEGORY_ALIASES: Record<string, KickReportCategory> = {
	discriminatory: KickReportCategory.CoCDiscrimination,
}

/**
 * The numeric category a chat report is filed under. The chat report sends its category as
 * an enum NAME (`ReportCategory=Discriminatory`) where every other report sends a number,
 * and `report.report_category` is numeric — it is what the staff panel labels rows from and
 * what a ban's block screen names as the reason — so the name is mapped onto the same
 * `KickReportCategory` codes the other reports carry. A number is taken as it comes.
 *
 * Null for a name that maps to nothing, which the caller files as `Unknown` with the name
 * kept in the details: losing which box the reporter ticked would be worse than an odd-looking
 * description.
 */
function chatReportCategory(raw: string | undefined): number | null {
	if (raw === undefined) return KickReportCategory.Unknown
	const name = raw.trim()
	if (/^-?\d+$/.test(name)) return Number.parseInt(name, 10)
	const key = name.toLowerCase()
	const alias = CHAT_REPORT_CATEGORY_ALIASES[key]
	if (alias !== undefined) return alias
	for (const [member, value] of Object.entries(KickReportCategory)) {
		if (typeof value === 'number' && member.toLowerCase() === key) return value
	}
	return null
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
	moderatorId: number,
	{ reason = '', isHostKick = true }: { reason?: string; isHostKick?: boolean } = {}
): Promise<void> {
	const frame: ModerationKickPayload = {
		ReportCategory: KickReportCategory.Moderator,
		Duration: 0,
		GameSessionId: gameSessionId,
		IsHostKick: isHostKick,
		Message: reason
			? `You have been kicked from ${roomName}. Reason: ${reason}`
			: `You have been kicked from ${roomName}.`,
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
 * What a vote-to-kick Message carries, and it is not what this once sent.
 *
 * `FromPlayerId` is the player being VOTED ON, not the one who called the vote. The client
 * raises its prompt about whoever that names, so sending the caller put the voter's own name
 * on the prompt — "kick 153?" when 153 was the one asking to kick 187. Nothing on the frame
 * identifies the caller, and nothing needs to: the prompt is about the accused.
 *
 * `Data` is the REASON, as plain text (`Inactive in games (AFK)`) — the label the client
 * offered in `voteToKickReasons` and posted back. It used to be an escaped JSON object of
 * `{ PlayerId, Response, GameSessionId }`, which reached players as that JSON printed on the
 * prompt where the reason belongs.
 *
 * It is still a STRING on the wire, which is the part that has not changed: a Message's `Data`
 * is a string like every other Message's, and an object there fails the client's decoder
 * outright (`expected:'String Begin Token', actual:'{'`), aborting the whole notification
 * rather than dropping the field. A reason is text, so it needs no escaping to satisfy that.
 */

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
 * Carry out a vote-to-kick that has passed: the player is moved into their own dorm and gets a
 * `ModerationKick` frame (id 22), exactly as the staff kicks in this controller do.
 *
 * It differs from those in who it says did it. `ReportCategory` is `VoteKick` (10) and
 * `IsHostKick` is false — the ROOM removed them, not its host — and `PlayerIdReporter` is the
 * player whose vote carried it rather than a moderator. `IsBan` is false: a vote-kick ends the
 * session they are in and nothing more, so they may walk straight back in, and a room that
 * wants them gone for good bans them.
 *
 * `VoteKickReason` carries the reason the vote was called on, which is the field the client
 * has for it — unlike the staff kicks, which leave it empty and put their text in `Message`.
 *
 * Best-effort, and deliberately after the ballot is recorded: the vote happened and was
 * counted whatever the hub does next.
 */
async function applyVoteKick(
	c: Context<App>,
	playerId: number,
	gameSessionId: number,
	reason: string,
	carriedByAccountId: number
): Promise<void> {
	try {
		// Into their own dorm, not out of existence — see the note in `instantKick`.
		await movePlayerToDorm(c.env.DB, playerId)

		const instance = await getStoredRoomInstance(c.env.DB, gameSessionId)
		const room = instance && (await getRoomById(c.env.DB, instance.roomId))
		const roomName = typeof room?.Name === 'string' ? room.Name : 'this room'

		const frame: ModerationKickPayload = {
			ReportCategory: KickReportCategory.VoteKick,
			Duration: 0,
			GameSessionId: gameSessionId,
			IsHostKick: false,
			Message: `You have been kicked from ${roomName}.`,
			PlayerIdReporter: carriedByAccountId,
			IsBan: false,
			IsVoiceModAutoban: false,
			IsWarning: false,
			VoteKickReason: reason,
			TimeoutStartedAt: null,
		}
		await c.env.RECFLARE_NOTIFICATIONS_HUB.getByName(HUB_INSTANCE).notifyPlayersEphemeral(
			[playerId],
			NotificationType.ModerationKick,
			{ ...frame }
		)
	} catch (err) {
		logger.error('failed to carry out a vote kick', {
			playerId,
			gameSessionId,
			error: err instanceof Error ? err.message : String(err),
		})
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
				'`IsBan: true`, the `ReportCategory` the report was filed under, the fixed ' +
				'`Message` “Rule violation”, and `Duration` as the seconds LEFT on the ban as of ' +
				'this request — the client counts it down from when it receives it, so it is ' +
				'`ban_expires` minus now, rounded up, never the ban’s full span (2147483647, the ' +
				'int32 max, for a permanent ban). `TimeoutStartedAt` stays null: the client does ' +
				'not pair it with `Duration` for a ban, and no reference server sends it. ' +
				'`PlayerIdReporter` stays null: it names a kicking host, and the reporter is not ' +
				'shown to the player they reported. Only the caller’s own account is consulted, ' +
				'not the ban-evasion arms.\n\n' +
				'Everyone else gets the reference server’s stub “not blocked” answer: ' +
				'`ReportCategory` is `Unknown` (-1) rather than 0, which is a real category, and ' +
				'`Message` is null rather than the empty string that stub sends — the client ' +
				'distinguishes “no message” from a blank one. `IsVoiceModAutoban` and ' +
				'`TimeoutStartedAt` are on the DTO but unset by that stub, so they carry their ' +
				'defaults, as do the seven keys past the stub’s nine that the 2025 client’s decoder ' +
				'names (`IsDeviceBan`, `IsWarning`, `VoteKickReason`, `AssociatedAccountUsername`, ' +
				'`ShowCreatorCodeOfConduct`, `TopMessageOverride`, `BottomMessageOverride`) — ' +
				'block kinds and screen dressings this server never uses. Answers GET or POST: ' +
				'the newer client POSTs it with no body.',
			security: AUTHED,
			responses: {
				200: json(ModerationBlockDetails, 'The caller’s block, or “not blocked”'),
				401: UNAUTHORIZED_RESPONSE,
			},
		}),
		async (c) => {
			const id = await authedId(c)
			if (id === null) return unauthorized(c)
			// One instant for both: the ban resolved as in force at `now` is described as of
			// `now`, so it can't come out with 0 left.
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
				'the client only ever parses one shape. A success also carries `value`, the ' +
				'stored report row: the client ignores it, and the website’s moderation panel ' +
				'files reports here and opens the ban dialog on the row it gets back.',
			security: AUTHED,
			requestBody: form(CreateReportRequest, 'The report'),
			responses: {
				200: json(CreateReportResponse, '`{ success: true, error: "", value: <report> }`'),
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

			const report = await createReport(c.env.DB, {
				reporterPlayerId: reporterId,
				reportedPlayerId,
				reportCategory: asInt(formField(body, c, 'ReportCategory')) ?? 0,
				details: formField(body, c, 'Details') ?? null,
				heightReporter: asFloat(formField(body, c, 'HeightReporter')),
				heightReported: asFloat(formField(body, c, 'HeightReported')),
				roomId: roomId !== null && roomId > 0 ? roomId : null,
				roomInstanceType: formField(body, c, 'RoomInstanceType') ?? null,
			})

			return c.json({ success: true, error: '', value: report })
		}
	)

	// Report one chat message. Stored in the `report` table every other report uses — same
	// fields, same moderation life — with `chat_message_id` set. See
	// migrations/0025_report_chat_message.sql.
	.post(
		'/api/chatreport/createChatReport',
		describeRoute({
			tags: ['Moderation'],
			summary: 'Report a chat message',
			description:
				'Files a report against one chat message. Stored as a row in the same `report` table ' +
				'a player report goes to (`POST /api/PlayerReporting/v3/create`), beside the event, ' +
				'invention and custom-avatar-item reports — the same submission with the same ' +
				'moderation life, and a moderator converts any of them into a ban the same way. What ' +
				'marks it as a chat report is `chat_message_id`; the row’s `reported_player_id` is ' +
				'the message’s SENDER, read from the `message` table, since the body names no ' +
				'player. `ChatThreadId` is accepted and unused: a message id is unique across ' +
				'threads, so the message names its own thread and nothing stores a second copy.\n\n' +
				'The reporter is the caller (from the bearer token) and must be a MEMBER of the ' +
				'thread the message is in — the same gate reading the message sits behind. A ' +
				'message the caller cannot see answers exactly as one that does not exist, so the ' +
				'route cannot be used to probe message ids or to file reports citing conversations ' +
				'the reporter was never in. A system notice (a join/leave line) has no sender to ' +
				'report and is refused.\n\n' +
				'`ReportCategory` arrives as an enum NAME (`Discriminatory`), unlike the numeric ' +
				'one a player report sends, and is mapped onto the numeric category the table ' +
				'stores (`Discriminatory` → 102). A number is stored as sent; a name that maps to ' +
				'nothing is filed as 0 with the name kept at the front of the details. ' +
				'`ReportDescription` is the details. Nothing dedupes the rows.\n\n' +
				'Answers the `{ success, error }` envelope the other reports use, `error` an empty ' +
				'string rather than null, on the rejected branches too.',
			security: AUTHED,
			requestBody: form(CreateChatReportRequest, 'The report'),
			responses: {
				200: json(SuccessErrorEnvelope, '`{ success: true, error: "" }`'),
				400: json(SuccessErrorEnvelope, 'No usable `ChatMessageId`, or a system message'),
				401: UNAUTHORIZED_RESPONSE,
				404: json(SuccessErrorEnvelope, 'No such message, or not one the caller can see'),
			},
		}),
		async (c) => {
			const reporterId = await authedId(c)
			if (reporterId === null) return unauthorized(c)

			const body = await c.req.parseBody().catch(() => ({}) as Record<string, unknown>)
			const chatMessageId = asInt(formField(body, c, 'ChatMessageId'))
			if (chatMessageId === null) {
				return c.json({ success: false, error: 'ChatMessageId is required' }, 400)
			}

			// The message supplies the reported player, and its OWN thread is the one the
			// membership check runs against — not the body's `ChatThreadId`, which would let a
			// caller vouch for a message by naming a thread they happen to be in.
			const message = await getMessage(c.env.DB, chatMessageId)
			if (message === null || !(await isThreadMember(c.env.DB, message.chatThreadId, reporterId))) {
				return c.json({ success: false, error: 'No such message' }, 404)
			}
			// System notices are sent as a pseudo-player with a negative id (see `chat`'s
			// SYSTEM_SENDER_ID); a report against one would be a report against nobody.
			if (message.senderPlayerId <= 0) {
				return c.json({ success: false, error: 'That message has no sender to report' }, 400)
			}

			const rawCategory = formField(body, c, 'ReportCategory')
			const category = chatReportCategory(rawCategory)
			const description = formField(body, c, 'ReportDescription') ?? null
			await createReport(c.env.DB, {
				reporterPlayerId: reporterId,
				reportedPlayerId: message.senderPlayerId,
				reportCategory: category ?? KickReportCategory.Unknown,
				details:
					category === null
						? [`[${rawCategory?.trim()}]`, description].filter(Boolean).join(' ')
						: description,
				chatMessageId,
			})

			return c.json({ success: true, error: '' })
		}
	)

	// A player calling a vote to kick another. Ungated by role — anyone may start one —
	// but both players have to be standing in the session the vote is called in, which is
	// what stops a client putting a vote to a room it isn't in, about someone who isn't
	// there. The call and every answer arrive here alike; the first ballot while no vote on
	// that player is open CALLS one (`init`), and only a call is put to the room.
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
				'`FromPlayerId` on that Message is the player being VOTED ON, not the caller — the ' +
				'client raises its prompt about whoever it names, so the caller there asks the room ' +
				'to kick the wrong player. `Data` is the `Reason` as PLAIN TEXT (`Inactive in games ' +
				'(AFK)`), which is what the prompt shows; it is still a string on the wire, because ' +
				"an object there fails the client’s decoder (`expected:'String Begin Token', " +
				"actual:'{'`) and aborts the whole notification.\n\n" +
				'The frames are EPHEMERAL: a vote belongs to the moment it was called, so an ' +
				'offline player gets nothing rather than a prompt about a dead session on their ' +
				'next connect.\n\n' +
				'Every call RECORDS a ballot in `room_vote` — the session, the player voted on, the ' +
				'voter and their answer — and then tallies. A vote CARRIES when the yes votes are ' +
				'strictly more than half the players standing in the session right now (a tie is not ' +
				'a majority, and the count is of the room as it is, since players leave mid-vote). ' +
				'The tally counts DISTINCT voters and reads only each one’s latest ballot, so ' +
				're-posting a vote cannot carry one and a voter may change their mind.\n\n' +
				'When it carries, the player is kicked exactly as a staff kick does it — moved into ' +
				'their own dorm, the instance they left freed, an ephemeral `ModerationKick` (id 22) — ' +
				'but with `ReportCategory` `VoteKick` (10), `IsHostKick` false (the ROOM removed ' +
				'them), `PlayerIdReporter` the voter whose ballot carried it, and the reason in ' +
				'`VoteKickReason`. `IsBan` is false: nothing stops them rejoining. No prompt goes ' +
				'out in that case — the room is not asked a question that is already answered.\n\n' +
				'The call and the answers arrive on this same endpoint with the same body. A ballot ' +
				'posted while no vote on `PlayerId` is open in that session CALLS one: it is stored ' +
				'with `init` 1 and is the only kind that puts the prompt to the room. A vote stays ' +
				'open for 60 seconds; every ballot inside that window answers it — recorded and ' +
				'tallied, but relayed to nobody — and only ballots from its call on are counted, so ' +
				'an expired vote’s yes ballots cannot carry the next.\n\n' +
				'Calling is THROTTLED: a player who called a vote in the last 5 minutes, in any ' +
				'session, is refused with a 429. Answering is never throttled. A `No` cannot call a ' +
				'vote — with none open it is refused with a 409.\n\n' +
				'`Response` is the caller’s own vote, recorded but never relayed. Answers the same lowercase `{ success, error }` envelope as the ' +
				'write; a hub failure for any recipient is reported honestly as a 500, since ' +
				'with nothing behind it the frame is the whole delivery.',
			security: AUTHED,
			requestBody: form(VoteToKickRequest, 'The vote'),
			responses: {
				200: json(SuccessErrorEnvelope, '`{ success: true, error: "" }`'),
				400: json(SuccessErrorEnvelope, 'No `PlayerId` or no `GameSessionId`'),
				401: UNAUTHORIZED_RESPONSE,
				403: json(SuccessErrorEnvelope, 'Either player is not in that game session'),
				409: json(SuccessErrorEnvelope, 'A `No` with no vote open to answer'),
				429: json(SuccessErrorEnvelope, 'The caller called a vote too recently'),
				500: json(SuccessErrorEnvelope, 'The notifications hub could not be reached'),
			},
		}),
		async (c) => {
			const voterId = await authedId(c)
			if (voterId === null) return unauthorized(c)

			const body = await c.req.parseBody().catch(() => ({}) as Record<string, unknown>)
			const playerIdField = formField(body, c, 'PlayerId')
			const playerId = asInt(playerIdField)
			if (playerIdField === undefined || playerId === null) {
				return c.json({ success: false, error: 'PlayerId is required' }, 400)
			}
			const gameSessionId = asInt(formField(body, c, 'GameSessionId'))
			if (gameSessionId === null) {
				return c.json({ success: false, error: 'GameSessionId is required' }, 400)
			}

			// The prompt's own text. Absent is an empty string rather than a refusal: a vote with
			// no reason given is still a vote, and the client picks from a fixed list anyway.
			const reason = formField(body, c, 'Reason') ?? ''

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

			// Call or answer? Nothing in the body says, so it is whether a vote on this player is
			// already open here: with none, this ballot calls one.
			const response = isYesVote(formField(body, c, 'Response'))
			const openVote = await getOpenVote(c.env.DB, gameSessionId, playerId)
			const init = openVote === null
			if (init) {
				// A late "no" to a vote that has expired would otherwise call a new one.
				if (!response) {
					return c.json({ success: false, error: 'There is no vote in progress!' }, 409)
				}
				// Only calling is throttled — this is what stops one player putting vote after
				// vote to the room. Answering someone else's vote never is.
				if (await isOnVoteCooldown(c.env.DB, voterId)) {
					return c.json({ success: false, error: 'You are calling votes too quickly!' }, 429)
				}
			}

			// The caller's own ballot, recorded before the room is asked: they have voted, and a
			// vote in a session holding only them and the player they called it on should carry on
			// its own rather than waiting for an answer that can never come.
			const ballot = await recordRoomVote(c.env.DB, {
				gameSessionId,
				playerId,
				voterId,
				response,
				init,
			})

			// Counted against who is standing there RIGHT NOW: a majority is of the room as it is,
			// not of the room as it was when the vote was called, and players leave mid-vote. Only
			// THIS vote's ballots count — from its call on.
			const yesVotes = await countKickVotes(
				c.env.DB,
				gameSessionId,
				playerId,
				openVote?.id ?? ballot.id
			)
			const playerCount = await countPlayersInInstance(c.env.DB, gameSessionId)
			if (isKickMajority(yesVotes, playerCount)) {
				logger.info('vote to kick carried', {
					playerId,
					gameSessionId,
					yesVotes,
					playerCount,
					carriedBy: voterId,
				})
				await applyVoteKick(c, playerId, gameSessionId, reason, voterId)
				// The room is not asked a question that has already been answered.
				return c.json({ success: true, error: '' })
			}

			// An answer is recorded and no more: the room was asked when the vote was called, and
			// re-sending the prompt on every answer would raise it again for everyone.
			if (!init) return c.json({ success: true, error: '' })

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
						// The player being VOTED ON — the client raises its prompt about this id, so
						// the caller's own id here asks the room to kick the wrong player.
						FromPlayerId: playerId,
						ToPlayerId: toPlayerId,
						Type: MessageType.VoteToKick,
						// The reason as plain text; see the note above the Message type.
						Data: reason,
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
				'Each kicked player is moved into their own DORM — presence rewritten, not deleted, ' +
				'so their client lands where it already is instead of loading the dorm a second ' +
				'time — and the instance they left frees a slot. They also get a `ModerationKick` ' +
				'frame (id 22) — the frame the ' +
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
				// Moved to their own dorm rather than having their presence deleted: the client
				// goes to the dorm either way, and with no presence to read it arrives not knowing
				// where it is and loads the dorm a second time. `movePlayerToDorm` recomputes the
				// fullness of the instance they left, so this one no longer has to.
				await movePlayerToDorm(c.env.DB, playerId)
				kicked.push(playerId)
			}

			if (kicked.length > 0) {
				const roomName = typeof room.Name === 'string' ? room.Name : 'this room'
				await pushInstantKick(c, kicked, gameSessionId, roomName, moderatorId)
			}

			return c.json({ success: true, error: '' })
		}
	)

	// ONE player kicked out of ONE live instance, from the in-room moderation menu, with a
	// reason. The single-player sibling of `instantKick`, but form-encoded and gated more
	// narrowly: the room's owner or a co-owner, or an account holding the staff role — not
	// the room's Moderator (20) tier, which `instantKick` lets through.
	//
	// The cross-room guard is the same and it is the point: the instance names the room, the
	// room is what the caller's authority is checked against, and the target's LIVE presence
	// must put them in that very instance. Naming a player standing in some other room — even
	// another instance of this one — kicks nobody, so authority over one room can never reach
	// a session in another.
	.post(
		'/api/PlayerReporting/v1/roomModKick',
		describeRoute({
			tags: ['Moderation'],
			summary: 'Kick one player out of a room instance, with a reason',
			description:
				'Ejects `PlayerId` from the live room instance `GameSessionId` (a `roomInstanceId`). ' +
				'Form-encoded, unlike `instantKick`’s JSON; `Reason` is optional free text shown to ' +
				'the kicked player in the kick message.\n\n' +
				'Gated to the instance’s room: its creator or a co-owner, or any account whose token ' +
				'carries the `moderator` / `developer` role. A room Moderator (20) or Host is NOT ' +
				'enough here. Anyone else with a valid token gets a 403.\n\n' +
				'The player must be standing in **that** instance — their live `presence` row must ' +
				'name it. Otherwise nothing happens and the call answers `success: false`, so an ' +
				'account id cannot reach into a session in another room, or another instance of this ' +
				'one. The caller need not be in the instance themselves. The caller cannot kick ' +
				'themselves, and nobody can kick the room’s owner or a co-owner.\n\n' +
				'A kick moves the player into their own DORM — presence rewritten rather than deleted, ' +
				'so their client does not load the dorm twice — frees the slot they held, and sends ' +
				'them an EPHEMERAL `ModerationKick` ' +
				'frame (id 22) with `IsBan: false` — nothing stops them rejoining. `IsHostKick` is ' +
				'true when the caller runs the room, false for a staff account acting in a room it ' +
				'does not.\n\n' +
				'Answers the lowercase `{ success, error }` envelope; the shape is unverified against ' +
				'the real service.',
			security: AUTHED,
			requestBody: form(RoomModKickRequest, 'The session, the player and a reason'),
			responses: {
				200: json(
					SuccessErrorEnvelope,
					'`{ success: true, error: "" }`, or `success: false` when the player cannot be kicked'
				),
				400: json(SuccessErrorEnvelope, 'No `GameSessionId` or `PlayerId`'),
				401: UNAUTHORIZED_RESPONSE,
				403: json(SuccessErrorEnvelope, 'The caller neither runs the room nor holds a staff role'),
				404: json(SuccessErrorEnvelope, 'No such game session'),
			},
		}),
		async (c) => {
			const moderatorId = await authedId(c)
			if (moderatorId === null) return unauthorized(c)

			const body = await c.req.parseBody().catch(() => ({}) as Record<string, unknown>)
			const gameSessionId = asInt(formField(body, c, 'GameSessionId'))
			if (gameSessionId === null) {
				return c.json({ success: false, error: 'GameSessionId is required' }, 400)
			}
			const playerId = asInt(formField(body, c, 'PlayerId'))
			if (playerId === null) return c.json({ success: false, error: 'PlayerId is required' }, 400)
			const reason = formField(body, c, 'Reason')?.trim() ?? ''

			// The instance names the room, and the room carries the roles this is gated on.
			const instance = await getStoredRoomInstance(c.env.DB, gameSessionId)
			const room = instance && (await getRoomById(c.env.DB, instance.roomId))
			if (!room) return c.json({ success: false, error: 'This game session does not exist!' }, 404)

			// The room's own owners first; the token's roles are only read when that fails.
			const runsRoom = canManageRoom(room, moderatorId)
			if (!runsRoom) {
				if (!(await authedStaff(c))) {
					return c.json({ success: false, error: 'Forbidden' }, 403)
				}
			}

			if (playerId === moderatorId) {
				return c.json({ success: false, error: 'You cannot kick yourself!' })
			}
			// Otherwise a co-owner, or a staffer, could throw the room's owner out of it.
			if (canManageRoom(room, playerId)) {
				return c.json({ success: false, error: 'You cannot kick an owner of this room!' })
			}

			// The cross-room guard: their LIVE presence must name this exact instance. Offline,
			// expired, in another room, or in another instance of this room are all "not here".
			const presence = await getPresence<{ roomInstanceId?: number }>(c.env.DB, playerId)
			if (presence?.roomInstance?.roomInstanceId !== gameSessionId) {
				return c.json({ success: false, error: 'That player is not in this game session!' })
			}

			// Into their own dorm, not out of existence — see the note in `instantKick`.
			await movePlayerToDorm(c.env.DB, playerId)
			const roomName = typeof room.Name === 'string' ? room.Name : 'this room'
			await pushInstantKick(c, [playerId], gameSessionId, roomName, moderatorId, {
				reason,
				isHostKick: runsRoom,
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

			if (!(await authedStaff(c))) {
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
