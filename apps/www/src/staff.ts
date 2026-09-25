import {
	addUsernameChange,
	addXp,
	clearPasswordHash,
	createGift,
	getAccount,
	getOnlinePlayerIds,
	getPlayerIdsInRoom,
	getPresences,
	movePlayerToDorm,
	writeAuditLog,
} from '@repo/domain'
import { intVar, logger } from '@repo/hono-helpers'
import { validateAndGetAccountId, validateAndGetRoles } from '@repo/jwt'

// The report table and the ban policy over it, owned (and migrated) by the `api` worker.
// Imported rather than reimplemented: the SQL belongs with the table, and `banFromReport`
// is the same write `api` would do. www owns the ENDPOINTS, not the storage — see the
// module comment below.
import { banEvasionMatch, linkedAccounts } from '../../api/src/bans-db'
import { getCustomAvatarItem } from '../../api/src/custom-avatar-items-db'
import {
	banBlockDetails,
	banFromReport,
	createReport,
	getActiveBan,
	getBansInForce,
	getReportById,
	getReportsAgainst,
	getTopReported,
	searchReports,
} from '../../api/src/reports-db'
import { getWarningsAgainst } from '../../api/src/warnings-db'
// Balances, owned by `econ`. A staff token gift is the same credit econ's own faucets make.
import {
	ALL_PLATFORMS,
	creditCurrency,
	CurrencyType,
	DEFAULT_STARTING_TOKENS,
	ensureStartingBalances,
	getBalance,
	spendCurrency,
} from '../../econ/src/balance-db'
// The item catalog and the two inventories a skin or a consumable gift writes, all `econ`'s.
import {
	CatalogKind,
	getCatalogItem,
	getCatalogItemById,
	toCatalogSkin,
} from '../../econ/src/catalog-db'
import { countConsumable, grantConsumable } from '../../econ/src/consumables-db'
import { getEquipment, grantEquipment } from '../../econ/src/equipment-db'
import { grantCustomAvatarItem, ownedCustomAvatarItemIds } from '../../econ/src/inventory-custom-db'
// The notification ids and the kick frame's recovered shape, owned by `notify`. Both are
// imported as values/types with no runtime dependencies.
import { NotificationType } from '../../notify/src/notification-types'

import type { Context, MiddlewareHandler } from 'hono'
import type { GiftContent } from '@repo/domain'
import type { CustomAvatarItem } from '../../api/src/custom-avatar-items-db'
import type { ReportRow, ReportSearch } from '../../api/src/reports-db'
import type { CatalogRow } from '../../econ/src/catalog-db'
import type {
	BalanceResponsePayload,
	GiftPackagePayload,
	ModerationKickPayload,
	PlayerProgressionLevelPayload,
} from '../../notify/src/notification-payloads'
import type { App, Env } from './context'

/**
 * The staff moderation surface — the endpoints behind the `/moderation` panel in the SPA.
 *
 * These live on `www` rather than on `api` (which owns the `report` table) on purpose:
 * every other worker reimplements an endpoint the Rec Room client actually calls, and a
 * staff panel has no counterpart in the real service. Keeping recflare's own additions
 * here leaves the game-facing workers a faithful surface, with nothing in them the client
 * never asked for. So the SQL stays in `api`'s reports-db/bans-db beside the table, and
 * only the HTTP lives here.
 *
 * Where a real game service already answers the question, the SPA asks IT rather than
 * having www proxy: usernames for the ids in a report come from `accounts`'
 * `POST /account/bulk`, the same lookup the game does. This module serves only what no
 * existing endpoint does.
 *
 * Every route is gated by {@link requireStaff} — a valid token carrying `moderator` or
 * `developer`, the operator-granted roles `auth` stamps from an account's
 * isModerator/isDeveloper flags (see the admin CLI's `grant-moderator` /
 * `grant-developer`). The SPA's `isAdmin()` gate only decides what to SHOW; this is the
 * one that decides anything. The gifts are narrower still — developers only, via
 * {@link requireDeveloper}.
 */

/**
 * Roles allowed through. The same set `api`'s warning write and `notify`'s internal
 * endpoints gate on — staff hold both roles, and moderation is not developer-only.
 */
const STAFF_ROLES = new Set(['moderator', 'developer'])

/** The notifications hub is a single global DO instance (see the `notify` worker). */
const HUB_INSTANCE = 'global'

/** Hard cap on a page of search results, whatever the query string asks for. */
const MAX_TAKE = 200

/**
 * Gates a route on a staff token: 401 for a missing or invalid one, 403 for a valid token
 * without a staff role. The acting moderator is stashed on the context so a handler reads
 * it without validating the token a second time.
 *
 * Two answers, not one, because they mean different things to the page: a 401 is a session
 * that has expired (the SPA's `call` drops the token and sends them to sign in), while a
 * 403 is a signed-in player who is not staff — and the panel says so rather than looping
 * them through a sign-in that would change nothing.
 */
export const requireStaff: MiddlewareHandler<App> = async (c, next) => {
	const secret = await c.env.JWT_SECRET.get()
	const roles = await validateAndGetRoles(c.req.raw, secret)
	if (roles === null) return c.json({ error: 'Unauthorized' }, 401)
	if (!roles.some((role) => STAFF_ROLES.has(role))) return c.json({ error: 'Forbidden' }, 403)

	const accountId = await validateAndGetAccountId(c.req.raw, secret)
	// A token that carries a staff role but no integer `sub` can't be attributed to a
	// moderator, and every action here is recorded against one.
	if (accountId === null) return c.json({ error: 'Unauthorized' }, 401)
	c.set('staffId', accountId)
	c.set('staffRoles', roles)
	await next()
}

/**
 * Narrows a staff route to developers — the ones that mint currency, items or XP out of
 * nothing, which moderation has no need for. Runs AFTER {@link requireStaff} (it reads the
 * roles that gate stashed), so a missing or invalid token is still that gate's 401 and a
 * moderator without `developer` gets a 403.
 */
export const requireDeveloper: MiddlewareHandler<App> = async (c, next) => {
	if (!c.get('staffRoles').includes('developer')) return c.json({ error: 'Forbidden' }, 403)
	await next()
}

/** The acting moderator, set by {@link requireStaff}. Only valid behind that middleware. */
const staffId = (c: Context<App>): number => c.get('staffId')

/** Read an integer query param, or null when absent or unparseable. */
function intQuery(c: Context<App>, name: string): number | null {
	const raw = c.req.query(name)
	if (raw === undefined || raw === '') return null
	const n = Number.parseInt(raw, 10)
	return Number.isNaN(n) ? null : n
}

/**
 * Read a tri-state boolean query param: `true`/`false` narrow, absent means "don't
 * filter". Distinct from a plain `=== 'true'`, which would read an absent param as an
 * explicit `false` and hide every banned row from an unfiltered search.
 */
function boolQuery(c: Context<App>, name: string): boolean | null {
	const raw = c.req.query(name)
	if (raw === undefined || raw === '') return null
	return raw === 'true' || raw === '1'
}

/** Read an ISO-8601 query param, or null when absent or not a date we can parse. */
function dateQuery(c: Context<App>, name: string): string | null {
	const raw = c.req.query(name)
	if (raw === undefined || raw === '') return null
	const parsed = Date.parse(raw)
	return Number.isNaN(parsed) ? null : new Date(parsed).toISOString()
}

/**
 * When a ban handed down now should lift, from what the panel posted.
 *
 * Accepts a DURATION (`days` and/or `hours`) or an explicit ISO `expires`, because
 * moderators think in "7 days" and audit trails are in timestamps. `permanent` (or a
 * body with neither) means null — a ban that never lifts, which is what `ban_expires`
 * NULL records.
 *
 * Returns `undefined` for an expiry that was asked for but can't be honoured (an
 * unparseable date, or a duration that lands in the past), so the caller refuses the
 * request rather than quietly making the ban permanent — the one mistake here that
 * cannot be walked back by waiting.
 */
function banExpiry(
	body: { permanent?: unknown; expires?: unknown; days?: unknown; hours?: unknown },
	now: Date
): string | null | undefined {
	if (body.permanent === true) return null

	if (typeof body.expires === 'string' && body.expires !== '') {
		const parsed = Date.parse(body.expires)
		if (Number.isNaN(parsed) || parsed <= now.getTime()) return undefined
		return new Date(parsed).toISOString()
	}

	const days = Number(body.days ?? 0)
	const hours = Number(body.hours ?? 0)
	if (!Number.isFinite(days) || !Number.isFinite(hours)) return undefined
	const ms = days * 86_400_000 + hours * 3_600_000
	// No duration at all is a permanent ban; a negative one is a mistake, not a lift.
	if (ms === 0) return null
	if (ms < 0) return undefined
	return new Date(now.getTime() + ms).toISOString()
}

/**
 * Tell a player they have been banned from the GAME, and throw them out of wherever they are.
 *
 * Without this a ban only takes effect on the player's NEXT sign-in or matchmake: `match`
 * refuses a banned player and `moderationBlockDetails` blocks them at login, but nothing
 * revisits a session already in progress, so someone banned mid-session keeps playing.
 *
 * The frame is a `ModerationKick` (id 22) with `IsBan: true` — the frame the client's
 * moderation screen shows as a ban from the game. This is the ONE place that frame belongs: a
 * ROOM ban must never send it (`rooms` sends `IsBan: false` and is enforced by refusing the
 * room), because the client cannot tell the two apart and shows a game-wide ban screen.
 *
 * Its contents are {@link banBlockDetails} — the same `ReportCategory`, `Message` and the
 * `Duration`/`TimeoutStartedAt` pair `moderationBlockDetails` answers for this ban — so the
 * screen a player sees mid-session is the screen they see when they next sign in, not a
 * generic "banned" with no length.
 *
 * Sent to anyone ONLINE, not only to a player standing in an instance: someone in a menu is
 * as banned as someone in a room. `GameSessionId` is their instance, or 0 when they are in
 * none. EPHEMERAL, because an offline player needs no frame — they meet the same screen at
 * `moderationBlockDetails` when they next sign in — and a queued one would fire again then.
 *
 * They are moved into their own DORM rather than having their presence deleted — the same move
 * every kick makes, and the one place a banned player is still allowed to be: `match` lets them
 * matchmake there and nowhere else, which is how they reach this screen at all. Deleting the row
 * instead left the client arriving at the dorm not knowing where it was, loading it a second
 * time. The instance they were in, if any, frees a slot.
 *
 * Entirely best-effort. The ban row is already committed by the time this runs; a hub hiccup
 * or a missing presence must not fail a ban that has been handed down.
 */
async function kickBannedPlayer(c: Context<App>, report: ReportRow, moderatorId: number) {
	const playerId = report.reported_player_id
	try {
		const presence = (await getPresences<{ roomInstanceId?: number }>(c.env.DB, [playerId])).get(
			playerId
		)
		// Offline: nothing to eject and nobody to tell. The sign-in check has them.
		if (!presence) return

		// Read before the move, so the frame names the session they were thrown out of rather
		// than the dorm they landed in. `movePlayerToDorm` recomputes that instance's fullness.
		const gameSessionId = presence.roomInstance?.roomInstanceId
		await movePlayerToDorm(c.env.DB, playerId)

		const block = banBlockDetails(report)
		const frame: ModerationKickPayload = {
			ReportCategory: block.ReportCategory,
			Duration: block.Duration,
			GameSessionId: gameSessionId ?? 0,
			IsHostKick: false,
			Message: block.Message,
			PlayerIdReporter: null,
			IsBan: true,
			IsVoiceModAutoban: false,
			IsWarning: false,
			VoteKickReason: '',
			TimeoutStartedAt: block.TimeoutStartedAt,
		}
		await c.env.RECFLARE_NOTIFICATIONS_HUB.getByName(HUB_INSTANCE).notifyPlayersEphemeral(
			[playerId],
			NotificationType.ModerationKick,
			{ ...frame }
		)
	} catch (err) {
		logger.error('failed to tell a banned player they are banned', {
			playerId,
			moderatorId,
			error: err instanceof Error ? err.message : String(err),
		})
	}
}

/**
 * Record a ban or a lift on the `audit_log` table, against the moderator who made it.
 *
 * The report row only ever holds the ban's CURRENT state: a lift clears `banned_by` and
 * `banned_at`, and a re-ban overwrites them, so without this row nothing says who lifted a
 * ban, or that one was ever handed down on a report that is clean today. `ban` and `unban`
 * are separate actions because they are the two questions asked of this log ("who banned
 * X", "who let X back in"); the target and the report go in `data`, per the table's rule
 * that `player_id` is the actor. `previous` is the row's ban state before this call, which
 * is the only place a lifted ban's original moderator and expiry survive.
 *
 * Written after the row is committed and never throws — the ban has already happened, and a
 * failed audit insert must not turn it into a 500 the panel would read as refused.
 */
async function recordBanAudit(
	c: Context<App>,
	moderatorId: number,
	before: ReportRow,
	after: ReportRow
) {
	const action = after.banned ? 'ban' : 'unban'
	try {
		await writeAuditLog(c.env.DB, {
			playerId: moderatorId,
			action,
			data: {
				reportId: after.id,
				playerId: after.reported_player_id,
				reportCategory: after.report_category,
				banExpires: after.ban_expires,
				previous: {
					banned: before.banned === 1,
					banExpires: before.ban_expires,
					bannedBy: before.banned_by_player_id,
					bannedAt: before.banned_at,
				},
			},
		})
	} catch (err) {
		logger.error('could not write an audit log row', {
			action,
			moderatorId,
			reportId: after.id,
			error: err instanceof Error ? err.message : String(err),
		})
	}
}

/** The evasion arms in force, read from the same knob `api` and `match` read. */
const armsFor = (env: Env) => banEvasionMatch(env.BAN_EVASION_MATCH)

// ---- Handlers ---------------------------------------------------------------

/**
 * A page of reports matching the panel's filters, newest first.
 *
 * Returns ids only — no usernames. The page resolves those itself through `accounts`'
 * bulk lookup, the same endpoint the game uses, so this stays one query against one table.
 */
export async function searchReportsHandler(c: Context<App>) {
	const filters: ReportSearch = {
		reportedPlayerId: intQuery(c, 'reportedPlayerId'),
		reporterPlayerId: intQuery(c, 'reporterPlayerId'),
		reportCategory: intQuery(c, 'reportCategory'),
		banned: boolQuery(c, 'banned'),
		from: dateQuery(c, 'from'),
		to: dateQuery(c, 'to'),
	}
	const page = await searchReports(c.env.DB, filters, {
		skip: intQuery(c, 'skip') ?? 0,
		take: Math.min(intQuery(c, 'take') ?? 50, MAX_TAKE),
	})
	return c.json(page)
}

/** One report by id — the detail behind a search row. */
export async function getReportHandler(c: Context<App>) {
	const id = Number.parseInt(c.req.param('id') ?? '', 10)
	if (Number.isNaN(id)) return c.json({ error: 'A numeric report id is required' }, 400)
	const report = await getReportById(c.env.DB, id)
	if (report === null) return c.json({ error: 'No such report' }, 404)
	return c.json(report)
}

/**
 * File a minimal report as the acting moderator — the row a ban needs something to hang
 * on when there is no player report to act on.
 *
 * A ban lives ON a report (see reports-db), so moderating something nobody happened to
 * report — found in a log, seen first-hand, escalated from elsewhere — needs a row first.
 * The reporter is the moderator, from the token, never the body: that IS the record of who
 * raised it, and it is why nothing marks these rows as staff-created.
 *
 * WHO, WHAT KIND and WHY, and nothing else. Everything else on a report describes a
 * client-side moment that did not happen here: the heights the game measured, the instance
 * type, the event/invention/item ids — and `room_id`, which a player's report gets from
 * the client that filed it. A moderator does not know a room's numeric id and would have
 * to go and look it up, so the room goes in `details` along with the rest of the account
 * of what happened. A `roomId` in the body is therefore not read; player reports still
 * carry the column, and it is theirs alone.
 */
export async function createReportHandler(c: Context<App>) {
	const moderatorId = staffId(c)
	const body = (await c.req.json().catch(() => null)) as {
		reportedPlayerId?: unknown
		reportCategory?: unknown
		details?: unknown
	} | null
	if (body === null) return c.json({ error: 'Invalid request body' }, 400)

	const reportedPlayerId = Number(body.reportedPlayerId)
	if (!Number.isInteger(reportedPlayerId) || reportedPlayerId <= 0) {
		return c.json({ error: 'reportedPlayerId is required' }, 400)
	}
	// A moderator filing a report against themselves is a mistake every time, and the ban
	// it would justify locks the panel's own operator out of the game.
	if (reportedPlayerId === moderatorId) {
		return c.json({ error: 'You cannot file a report against yourself' }, 400)
	}

	const report = await createReport(c.env.DB, {
		reporterPlayerId: moderatorId,
		reportedPlayerId,
		reportCategory: Number.isInteger(Number(body.reportCategory)) ? Number(body.reportCategory) : 0,
		details: typeof body.details === 'string' && body.details !== '' ? body.details : null,
	})
	logger.info('a moderator filed a report by hand', {
		reportId: report.id,
		moderatorId,
		reportedPlayerId,
	})
	return c.json(report)
}

/**
 * Apply or lift a ban on the report with this id.
 *
 * `banned: false` lifts it, clearing the expiry and the audit columns and leaving the
 * report itself intact — the panel needs to be able to undo a ban, and a lifted ban has to
 * be distinguishable from an expired one (`banned = 0` versus a past `ban_expires`). The
 * lift is signed onto the row (`unbanned_by_player_id`/`unbanned_at`, by `banFromReport`)
 * so the tables can say a colleague let the player back in, rather than offering "Ban…"
 * on a row that looks untouched — which is how a lifted ban got re-applied by the next
 * moderator to see it.
 *
 * Applying one also EJECTS the player from any instance they are in (see
 * {@link kickBannedPlayer}), best-effort and after the row is committed. The response
 * reports whether the frame went out, so the panel can say "banned, but they were offline"
 * rather than implying a kick that never happened.
 */
export async function banReportHandler(c: Context<App>) {
	const moderatorId = staffId(c)
	const id = Number.parseInt(c.req.param('id') ?? '', 10)
	if (Number.isNaN(id)) return c.json({ error: 'A numeric report id is required' }, 400)

	const body = (await c.req.json().catch(() => ({}))) as {
		banned?: unknown
		permanent?: unknown
		expires?: unknown
		days?: unknown
		hours?: unknown
	}
	// Absent means ban: the endpoint's purpose is to hand one down, and a lift is the
	// explicit case.
	const banned = body.banned !== false

	const now = new Date()
	const expires = banned ? banExpiry(body, now) : null
	if (expires === undefined) {
		return c.json({ error: 'That ban duration is not a time in the future' }, 400)
	}

	// Read first so a ban on a report that doesn't exist is a 404 rather than a silent
	// no-op, and so the response can name who it reached.
	const existing = await getReportById(c.env.DB, id)
	if (existing === null) return c.json({ error: 'No such report' }, 404)

	const report = await banFromReport(c.env.DB, id, {
		banned,
		banExpires: expires,
		bannedBy: moderatorId,
	})
	if (report === null) return c.json({ error: 'No such report' }, 404)

	logger.info(banned ? 'a moderator banned a player' : 'a moderator lifted a ban', {
		reportId: id,
		moderatorId,
		bannedPlayerId: report.reported_player_id,
		banExpires: report.ban_expires,
	})

	await recordBanAudit(c, moderatorId, existing, report)

	if (banned) await kickBannedPlayer(c, report, moderatorId)
	return c.json(report)
}

/**
 * The players with the most reports against them — the panel's triage list.
 *
 * Windowed to the last 30 days by default, so the list is who is a problem NOW rather
 * than whoever has ever accumulated the most reports. `sinceDays=0` reads as all time.
 */
export async function topReportedHandler(c: Context<App>) {
	const sinceDays = intQuery(c, 'sinceDays')
	const players = await getTopReported(c.env.DB, {
		// 0 is the panel's "all time", which the query expresses as null.
		sinceDays: sinceDays === 0 ? null : (sinceDays ?? 30),
		minReports: intQuery(c, 'minReports') ?? 3,
		take: Math.min(intQuery(c, 'take') ?? 50, MAX_TAKE),
	})
	return c.json(players)
}

/** Every ban in force right now — the standing-bans list. */
export async function bansInForceHandler(c: Context<App>) {
	return c.json(await getBansInForce(c.env.DB))
}

/**
 * Everything on file about one player: every report against them, every warning handed
 * down, and the ban in force if there is one.
 *
 * One call because it is one screen — a moderator deciding what to do about an account
 * reads all three together, and three round trips would let the page render a decision
 * out of a partially-loaded history.
 */
export async function playerHistoryHandler(c: Context<App>) {
	const playerId = Number.parseInt(c.req.param('id') ?? '', 10)
	if (Number.isNaN(playerId)) return c.json({ error: 'A numeric player id is required' }, 400)

	const [reports, warnings, activeBan] = await Promise.all([
		getReportsAgainst(c.env.DB, playerId),
		getWarningsAgainst(c.env.DB, playerId),
		getActiveBan(c.env.DB, playerId),
	])
	return c.json({ playerId, reports, warnings, activeBan })
}

/**
 * Which other accounts a ban on this player would ALSO block — shown before a moderator
 * confirms one.
 *
 * The IP arm is coarse by design (see bans-db): households, NAT and campus networks put
 * unrelated players behind one address, so a ban can reach people who did nothing. That is
 * the operator's trade to make, but it should be made with the list in front of them rather
 * than discovered from a support ticket, which is the whole reason this endpoint exists.
 *
 * `arms` echoes the operator's `BAN_EVASION_MATCH` so the page can say which arms are live
 * — an empty list under `off` means the ban reaches exactly the one account.
 */
export async function linkedAccountsHandler(c: Context<App>) {
	const playerId = Number.parseInt(c.req.param('id') ?? '', 10)
	if (Number.isNaN(playerId)) return c.json({ error: 'A numeric player id is required' }, 400)

	const arms = armsFor(c.env)
	return c.json({ playerId, arms, linked: await linkedAccounts(c.env.DB, playerId, arms) })
}

// ---- Player actions ---------------------------------------------------------
//
// The staff card on a player's profile page. None of these has a game endpoint to call —
// the client can't grant tokens, hand back a username change or wipe a password — so, like
// the moderation panel, they live here. Each one is recorded on `audit_log` against the
// acting staffer, with the target in `data` (the table's `player_id` is the actor).

/** The system "Coach" account — who a box the server hands over is from. */
const COACH_ACCOUNT_ID = 1

/**
 * The most one gift can carry when the operator's `MAX_TOKEN_GIFT` is unset. Not a policy —
 * staff can send as many gifts as they like — but a guard against a stray keypress turning
 * 1,000 into 10,000,000, which nothing can take back: there is no debit endpoint to undo a
 * credit with.
 */
export const DEFAULT_MAX_TOKEN_GIFT = 10_000

/**
 * The most XP one gift can carry when the operator's `MAX_XP_GIFT` is unset — a typo guard,
 * as {@link DEFAULT_MAX_TOKEN_GIFT} is. Kept small for now: enough to cross the first few
 * levels, where every level to the top costs 15,090 in all (level 1 to 50).
 */
export const DEFAULT_MAX_XP_GIFT = 100

/**
 * The most a token DROP — the gift to everyone online at once — can carry per player. Fixed
 * rather than an operator knob like `MAX_TOKEN_GIFT`, and far under it: this one is multiplied
 * by however many players are on, and the drop is meant for a small thank-you to the whole
 * server, not a payout.
 */
export const MAX_TOKEN_DROP = 1_000

/** The longest message a staff box may carry — the same cap a client message has. */
const MAX_GIFT_MESSAGE = 256

/**
 * `GiftContext.Purchased_Gift_A` — what a staff box says it came from.
 *
 * The client classifies a box by its context and only tests a small set (500–503
 * `Purchased_Gift_A`–`D`, 1300 `Friendotron_Gift`); `Default` (0) falls outside it, and a box
 * whose contents it won't render shows "cannot display". The TOKEN box is left on 0 because
 * it renders as it is — this is the thing being changed, so it is not changed everywhere at
 * once.
 */
const GIFT_CONTEXT_PURCHASED_GIFT_A = 500

/** The message on the box a staff gift comes in. */
const STAFF_GIFT_MESSAGE = 'A gift from the staff!'

/** A path's `:id` as a player id, or null when it isn't a positive integer. */
function playerIdParam(c: Context<App>): number | null {
	const id = Number(c.req.param('id'))
	return Number.isInteger(id) && id > 0 ? id : null
}

/**
 * Record a player action on `audit_log`. Written after the change has committed and never
 * throws, for the reason {@link recordBanAudit} gives: the change has already happened.
 */
async function recordPlayerAudit(
	c: Context<App>,
	action: string,
	data: Record<string, unknown>
): Promise<void> {
	try {
		await writeAuditLog(c.env.DB, { playerId: staffId(c), action, data })
	} catch (err) {
		logger.error('could not write an audit log row', {
			action,
			moderatorId: staffId(c),
			error: err instanceof Error ? err.message : String(err),
		})
	}
}

/**
 * The stored content of a box staff hand over: from the Coach, as every box the server hands
 * over on nobody's behalf is (who really sent it is on the audit row), carrying nothing but
 * what `fields` puts in it.
 *
 * `AvatarItemType` is NULL: no staff box holds an avatar item, and the client routes a box on
 * that field before reading the rest — a 0 sends it after "avatar item type 0", which fails
 * with "can't find avatar item". Same rule as econ's `boxAvatarItemType`.
 */
function staffGiftContent(fields: Partial<GiftContent>): GiftContent {
	return {
		FromPlayerId: COACH_ACCOUNT_ID,
		GiftContext: 0,
		ConsumableItemDesc: '',
		ConsumableCount: 0,
		AvatarItemDesc: '',
		AvatarItemType: null,
		CurrencyType: 0,
		Currency: 0,
		Xp: 0,
		PackageType: 0,
		Message: STAFF_GIFT_MESSAGE,
		EquipmentPrefabName: '',
		EquipmentModificationGuid: '',
		GiftRarity: 0,
		Platform: -1,
		PlatformsToSpawnOn: -1,
		BalanceType: null,
		...fields,
	}
}

/**
 * Show a player the box they were just handed: `GiftPackageReceivedImmediate`, the frame
 * econ sends for a box the player never clicked for, read off the stored content so the
 * frame and `GET /api/avatar/v2/gifts` describe one box. A custom item's box also carries
 * `CustomAvatarItemId`, as econ's does — the recovered decoder names no such member and
 * drops unknown ones, so it costs nothing if unread. Best-effort: the box is already stored,
 * and an offline player meets it on their next read of their gifts.
 */
async function announceGift(
	c: Context<App>,
	playerId: number,
	giftId: number,
	content: GiftContent
): Promise<void> {
	const frame: GiftPackagePayload = {
		Id: giftId,
		FromPlayerId: content.FromPlayerId ?? COACH_ACCOUNT_ID,
		ConsumableItemDesc: content.ConsumableItemDesc,
		AvatarItemType: content.AvatarItemType,
		AvatarItemDesc: content.AvatarItemDesc,
		EquipmentPrefabName: content.EquipmentPrefabName,
		EquipmentModificationGuid: content.EquipmentModificationGuid,
		CurrencyType: content.CurrencyType,
		Currency: content.Currency,
		Xp: content.Xp,
		GiftContext: content.GiftContext ?? 0,
		GiftRarity: content.GiftRarity,
		Message: content.Message,
		Platform: -1,
		PlatformsToSpawnOn: -1,
		BalanceType: ALL_PLATFORMS,
	}
	try {
		await c.env.RECFLARE_NOTIFICATIONS_HUB.getByName(HUB_INSTANCE).notifyPlayer(
			playerId,
			NotificationType.GiftPackageReceivedImmediate,
			content.CustomAvatarItemId
				? { ...frame, CustomAvatarItemId: content.CustomAvatarItemId }
				: { ...frame }
		)
	} catch (err) {
		logger.error('failed to announce a staff gift', {
			playerId,
			giftId,
			error: err instanceof Error ? err.message : String(err),
		})
	}
}

/**
 * Send a player RecCenterTokens in a gift box — or, with a NEGATIVE amount, take some back.
 *
 *
 * The same shape as econ's own server-handed currency (a game reward's Laser Tag tickets):
 * the balance is CREDITED here — opening a box only deletes it, it grants nothing — then a
 * `StorefrontBalanceUpdate` carrying the resulting total sets the client's bucket, and the box
 * is stored and announced with `GiftPackageReceivedImmediate` so the player sees what arrived.
 * The box is from the Coach, as every box the server hands over on nobody's behalf is; who
 * really sent it is on the audit row. It says what the body's optional `message` says, or
 * the staff default when there is none.
 *
 * Both frames are best-effort: the tokens are banked by the time they go out, and an offline
 * player meets the box in `GET /api/avatar/v2/gifts` and the balance on their next read.
 *
 * A negative amount debits through the same guarded spend a purchase uses, so it cannot
 * overdraw: a player who can't afford it is refused and keeps what they have. Zero moves
 * nothing at all. Both still mint a box, carrying that `Currency` — nobody has seen what the
 * client makes of an empty or a negative one, and finding out is the point.
 */
export async function giftTokensHandler(c: Context<App>) {
	const playerId = playerIdParam(c)
	if (playerId === null) return c.json({ error: 'A numeric player id is required' }, 400)

	const body = (await c.req.json().catch(() => ({}))) as { amount?: unknown; message?: unknown }
	const amount = Number(body.amount)
	const refusal = tokenAmountRefusal(c, amount)
	if (refusal !== null) return c.json({ error: refusal }, 400)
	const message = giftMessage(body)
	if (message === undefined) return c.json({ error: GIFT_MESSAGE_TOO_LONG }, 400)
	if ((await getAccount(c.env.DB, playerId)) === null) {
		return c.json({ error: 'No such player' }, 404)
	}

	const startingTokens = intVar(c.env.STARTING_TOKENS, DEFAULT_STARTING_TOKENS)
	const sent = await sendTokens(c, playerId, amount, startingTokens, message)
	if (sent === null) {
		const held = await getBalance(c.env.DB, playerId, CurrencyType.RecCenterTokens, startingTokens)
		return c.json({ error: `They only have ${held.toLocaleString()} tokens to take` }, 400)
	}

	await recordPlayerAudit(c, 'gift_tokens', { playerId, amount, message, ...sent })
	logger.info(amount < 0 ? 'staff took tokens back' : 'staff gifted tokens', {
		moderatorId: staffId(c),
		playerId,
		amount,
	})
	return c.json({ playerId, amount, ...sent })
}

/**
 * Why this token amount can't be sent, or null when it can. Shared by the one-player gift
 * and the room-wide one so they agree on what an amount is: any whole number within the
 * operator's cap, in either direction (see {@link sendTokens} for what each sign does).
 */
function tokenAmountRefusal(c: Context<App>, amount: number): string | null {
	if (!Number.isInteger(amount)) return 'Enter a whole number of tokens, positive or negative'
	const maxGift = intVar(c.env.MAX_TOKEN_GIFT, DEFAULT_MAX_TOKEN_GIFT)
	if (Math.abs(amount) > maxGift) {
		return `A gift can carry at most ${maxGift.toLocaleString()} tokens`
	}
	return null
}

/**
 * The message a staff box should carry, from the body's optional `message`: the staffer's
 * own words, trimmed, or {@link STAFF_GIFT_MESSAGE} when they wrote none. `undefined` means
 * a message was written but is too long to send — the caller refuses rather than truncating
 * what the player is going to read.
 */
function giftMessage(body: { message?: unknown }): string | undefined {
	const message = typeof body.message === 'string' ? body.message.trim() : ''
	if (message === '') return STAFF_GIFT_MESSAGE
	if (message.length > MAX_GIFT_MESSAGE) return undefined
	return message
}

/** The refusal {@link giftMessage} stands for when it answers `undefined`. */
const GIFT_MESSAGE_TOO_LONG = `Keep the message under ${MAX_GIFT_MESSAGE} characters`

/**
 * Move one player's token balance by `amount`, box it and tell them — the whole of a token
 * gift, for one player. Returns their resulting balance and the box's id, or null when a
 * negative amount is more than they hold (nothing is changed, and no box is minted).
 *
 * A POSITIVE amount credits, as econ's own faucets do. A NEGATIVE one debits through the
 * same guarded spend a purchase uses, so it cannot overdraw. ZERO moves nothing. All three
 * mint a box — an empty or negative one has never been seen in the client, and finding out
 * is the point.
 *
 * The signup grant is seeded first, as econ does before every credit: `creditCurrency`
 * upserts the row, so a never-touched balance would otherwise start from this gift.
 *
 * `message` is what the box says; the staff default unless the caller wrote one (the drop
 * to everyone online does).
 */
async function sendTokens(
	c: Context<App>,
	playerId: number,
	amount: number,
	startingTokens: number,
	message: string = STAFF_GIFT_MESSAGE
): Promise<{ balance: number; giftId: number } | null> {
	await ensureStartingBalances(c.env.DB, playerId, startingTokens)
	if (amount < 0) {
		const spent = await spendCurrency(
			c.env.DB,
			playerId,
			CurrencyType.RecCenterTokens,
			-amount,
			startingTokens
		)
		if (!spent) return null
	}
	const balance =
		amount > 0
			? await creditCurrency(
					c.env.DB,
					playerId,
					CurrencyType.RecCenterTokens,
					amount,
					startingTokens
				)
			: await getBalance(c.env.DB, playerId, CurrencyType.RecCenterTokens, startingTokens)

	const content = staffGiftContent({
		CurrencyType: CurrencyType.RecCenterTokens,
		Currency: amount,
		Message: message,
	})
	const gift = await createGift(c.env.DB, playerId, content)

	// The balance first, so the box's announcement lands on a total that already includes it.
	try {
		await c.env.RECFLARE_NOTIFICATIONS_HUB.getByName(HUB_INSTANCE).notifyPlayer(
			playerId,
			NotificationType.StorefrontBalanceUpdate,
			{
				Balance: balance,
				CurrencyType: CurrencyType.RecCenterTokens,
				Platform: ALL_PLATFORMS,
			} satisfies BalanceResponsePayload
		)
	} catch (err) {
		logger.error('failed to push a staff token gift balance', {
			playerId,
			error: err instanceof Error ? err.message : String(err),
		})
	}
	await announceGift(c, playerId, gift.id, content)
	return { balance, giftId: gift.id }
}

/**
 * Send tokens to EVERYONE standing in a room right now — every instance of it at once.
 *
 * The room is the audience, not one session: `getPlayerIdsInRoom` is the live, unexpired
 * presence for that room across its instances, deduplicated, and it is read at the moment the
 * button is pressed. Someone who arrives a second later gets nothing; someone whose presence
 * has lapsed is already gone from it.
 *
 * Each player is paid exactly as the one-player gift pays them — the same box, with the same
 * optional `message` on it — one after another rather than at once: this is a handful of writes per player, and a busy room would otherwise open a
 * hundred at a time. A player a negative amount can't be taken from is SKIPPED rather than
 * failing the room — the ones who could afford it have already been debited by then — and the
 * response says who was missed.
 */
export async function giftRoomTokensHandler(c: Context<App>) {
	const roomId = Number(c.req.param('roomId'))
	if (!Number.isInteger(roomId) || roomId <= 0) {
		return c.json({ error: 'A numeric room id is required' }, 400)
	}

	const body = (await c.req.json().catch(() => ({}))) as { amount?: unknown; message?: unknown }
	const amount = Number(body.amount)
	const refusal = tokenAmountRefusal(c, amount)
	if (refusal !== null) return c.json({ error: refusal }, 400)
	const message = giftMessage(body)
	if (message === undefined) return c.json({ error: GIFT_MESSAGE_TOO_LONG }, 400)

	const playerIds = await getPlayerIdsInRoom(c.env.DB, roomId)
	if (playerIds.length === 0) {
		return c.json({ error: 'Nobody is in that room right now' }, 404)
	}

	const startingTokens = intVar(c.env.STARTING_TOKENS, DEFAULT_STARTING_TOKENS)
	const paid: number[] = []
	const skipped: number[] = []
	for (const playerId of playerIds) {
		const sent = await sendTokens(c, playerId, amount, startingTokens, message)
		if (sent === null) skipped.push(playerId)
		else paid.push(playerId)
	}

	await recordPlayerAudit(c, 'gift_tokens_room', { roomId, amount, message, paid, skipped })
	logger.info('staff gifted tokens to a room', {
		moderatorId: staffId(c),
		roomId,
		amount,
		paidCount: paid.length,
		skippedCount: skipped.length,
	})
	return c.json({ roomId, amount, paid, skipped })
}

/**
 * Send tokens to EVERYONE ONLINE right now — the server-wide drop behind the account page's
 * "Token drop" tab, beside the coach broadcast and the maintenance notice.
 *
 * The audience is every unexpired `presence` row, lobby included (see `getOnlinePlayerIds`),
 * read when the button is pressed: the same population the coach broadcast reaches and the
 * status page counts. Each player is paid exactly as the one-player and room gifts pay them
 * (banked, then a balance frame and an announced box), one after another for the same reason
 * the room gift is — a full server is a lot of writes, and they should not all open at once.
 *
 * Narrower than the other gifts on purpose: the amount is POSITIVE and capped at
 * {@link MAX_TOKEN_DROP} per player, whatever `MAX_TOKEN_GIFT` says — a stray zero here is
 * multiplied by everyone online, and there is no way to take a drop back. The message on the
 * box is the operator's, required, since the box is what the players actually see of it.
 */
export async function giftOnlineTokensHandler(c: Context<App>) {
	const body = (await c.req.json().catch(() => ({}))) as { amount?: unknown; message?: unknown }
	const amount = Number(body.amount)
	if (!Number.isInteger(amount) || amount <= 0) {
		return c.json({ error: 'Enter a whole number of tokens greater than 0' }, 400)
	}
	if (amount > MAX_TOKEN_DROP) {
		return c.json(
			{ error: `A token drop can carry at most ${MAX_TOKEN_DROP.toLocaleString()} tokens each` },
			400
		)
	}
	// Required here, where the other gifts fall back to the staff default: a server-wide drop
	// with nothing to say about itself is a mistake more often than not.
	if (typeof body.message !== 'string' || body.message.trim() === '') {
		return c.json({ error: 'Enter the message for the gift box' }, 400)
	}
	const message = giftMessage(body)
	if (message === undefined) return c.json({ error: GIFT_MESSAGE_TOO_LONG }, 400)

	const playerIds = await getOnlinePlayerIds(c.env.DB)
	if (playerIds.length === 0) return c.json({ error: 'Nobody is online right now' }, 404)

	const startingTokens = intVar(c.env.STARTING_TOKENS, DEFAULT_STARTING_TOKENS)
	const paid: number[] = []
	for (const playerId of playerIds) {
		// A positive amount never comes back null: nothing to skip.
		if ((await sendTokens(c, playerId, amount, startingTokens, message)) !== null) {
			paid.push(playerId)
		}
	}

	await recordPlayerAudit(c, 'gift_tokens_online', { amount, message, paid })
	logger.info('staff dropped tokens on everyone online', {
		moderatorId: staffId(c),
		amount,
		paidCount: paid.length,
	})
	return c.json({ amount, message, paid })
}

/**
 * Give a player XP, in a gift box — the way a game reward pays its XP. The XP is banked
 * here (the box, like every box, grants nothing when opened) and spent on any levels it now
 * pays for; a `PlayerProgressionLevelUpdate` moves the level bar, and the box is announced
 * so the player sees what arrived.
 *
 * Levels crossed do NOT pay their level-up prize boxes: those are rolled from econ's catalog
 * (`grantLevelUpGifts`), which lives inside the econ app. The levels themselves are stored.
 */
export async function giftXpHandler(c: Context<App>) {
	const playerId = playerIdParam(c)
	if (playerId === null) return c.json({ error: 'A numeric player id is required' }, 400)

	const body = (await c.req.json().catch(() => ({}))) as { amount?: unknown; message?: unknown }
	const amount = Number(body.amount)
	if (!Number.isInteger(amount) || amount <= 0) {
		return c.json({ error: 'Enter a whole number of XP greater than 0' }, 400)
	}
	const maxGift = intVar(c.env.MAX_XP_GIFT, DEFAULT_MAX_XP_GIFT)
	if (amount > maxGift) {
		return c.json({ error: `A gift can carry at most ${maxGift.toLocaleString()} XP` }, 400)
	}
	const message = giftMessage(body)
	if (message === undefined) return c.json({ error: GIFT_MESSAGE_TOO_LONG }, 400)
	if ((await getAccount(c.env.DB, playerId)) === null) {
		return c.json({ error: 'No such player' }, 404)
	}

	const { progression, levelsGained } = await addXp(c.env.DB, playerId, amount)
	const content = staffGiftContent({
		GiftContext: GIFT_CONTEXT_PURCHASED_GIFT_A,
		Xp: amount,
		Message: message,
	})
	const gift = await createGift(c.env.DB, playerId, content)

	await recordPlayerAudit(c, 'gift_xp', {
		playerId,
		amount,
		message,
		level: progression.Level,
		levelsGained,
		giftId: gift.id,
	})
	logger.info('staff gifted xp', { moderatorId: staffId(c), playerId, amount, levelsGained })

	try {
		await c.env.RECFLARE_NOTIFICATIONS_HUB.getByName(HUB_INSTANCE).notifyPlayer(
			playerId,
			NotificationType.PlayerProgressionLevelUpdate,
			{
				PlayerId: progression.PlayerId,
				Level: progression.Level,
				XP: progression.XP,
			} satisfies PlayerProgressionLevelPayload
		)
	} catch (err) {
		logger.error('failed to push a staff xp gift progression', {
			playerId,
			error: err instanceof Error ? err.message : String(err),
		})
	}
	await announceGift(c, playerId, gift.id, content)

	return c.json({
		playerId,
		amount,
		level: progression.Level,
		xp: progression.XP,
		levelsGained,
		giftId: gift.id,
	})
}

/**
 * How many of a consumable one staff gift carries — one, as a store purchase grants one
 * (econ's `CONSUMABLE_GRANT_COUNT`). Consumables stack, so more is more gifts.
 */
const CONSUMABLE_GIFT_COUNT = 1

/**
 * What an item gift's id resolved to. `avatar_item` is a catalog row nothing here can grant;
 * `ambiguous` is an id found in BOTH tables, which nothing here can pick between.
 */
type GiftableItem =
	| { kind: 'custom_item'; item: CustomAvatarItem }
	| { kind: 'skin'; row: CatalogRow }
	| { kind: 'consumable'; row: CatalogRow }
	| { kind: 'avatar_item'; row: CatalogRow }
	| { kind: 'ambiguous' }

/**
 * Resolve the one id the staff card takes to whatever it names, looking in BOTH tables an
 * item can live in: `custom_avatar_item` by guid, in either case (a GUID's case is not its
 * identity; ids are stored as the export spelled them), and `catalog` by KEY — a skin's
 * `ModificationGuid` or a consumable's `ConsumableItemDesc`, spelled as the export spells it
 * (the short pre-GUID ids are case-sensitive, so nothing is folded there) — or, for a bare
 * number, by `catalog_id`, the store's `PurchasableItemId`.
 *
 * A UUID could be anything, so neither lookup is skipped on the strength of the other: an id
 * that answers in both tables is `ambiguous` rather than whichever was asked first. In
 * practice they don't collide — no catalog key is a bare number, and a skin and a consumable
 * never share a key — but the check is what makes that a fact rather than an assumption.
 *
 * A DRAFT custom item (`Accessibility` 0, visible to its creator alone — handing it out would
 * publish it for them) is treated as unknown, exactly as the store would refuse to sell it.
 */
async function findGiftableItem(db: D1Database, requested: string): Promise<GiftableItem | null> {
	const [custom, byKey] = await Promise.all([
		getCustomAvatarItem(db, requested).then(
			(item) => item ?? getCustomAvatarItem(db, requested.toLowerCase())
		),
		getCatalogItem(db, requested),
	])
	const item = custom !== null && custom.Accessibility !== 0 ? custom : null
	const row =
		byKey ?? (/^\d{1,9}$/.test(requested) ? await getCatalogItemById(db, Number(requested)) : null)

	if (item !== null && row !== null) return { kind: 'ambiguous' }
	if (item !== null) return { kind: 'custom_item', item }
	if (row === null) return null
	switch (row.kind) {
		case CatalogKind.Skin:
			return { kind: 'skin', row }
		case CatalogKind.Consumable:
			return { kind: 'consumable', row }
		case CatalogKind.AvatarItem:
			return { kind: 'avatar_item', row }
		default:
			return null
	}
}

/**
 * Give a player an item — a custom avatar item, an equipment skin or a consumable — by any
 * one of their ids, delivered the way a store purchase delivers it: ownership in the inventory
 * `econ` reads that kind from, and a gift box that names it, without which the player is
 * shown nothing. Nobody pays, and a custom item's creator is not paid: a grant, not a sale.
 * Which kind the id turned out to be is on the reply as `kind`, and the audit row is filed
 * per kind (`gift_custom_item`, `gift_skin`, `gift_consumable`).
 *
 * A baked avatar item's id is refused outright: nothing here grants one yet, and a 404 would
 * send the staffer checking an id that is right.
 */
export async function giftItemHandler(c: Context<App>) {
	const playerId = playerIdParam(c)
	if (playerId === null) return c.json({ error: 'A numeric player id is required' }, 400)

	const body = (await c.req.json().catch(() => ({}))) as { itemId?: unknown; message?: unknown }
	const requested = typeof body.itemId === 'string' ? body.itemId.trim() : ''
	if (requested === '') return c.json({ error: 'Enter an item id' }, 400)
	const message = giftMessage(body)
	if (message === undefined) return c.json({ error: GIFT_MESSAGE_TOO_LONG }, 400)
	if ((await getAccount(c.env.DB, playerId)) === null) {
		return c.json({ error: 'No such player' }, 404)
	}

	const found = await findGiftableItem(c.env.DB, requested)
	if (found === null) return c.json({ error: 'No such item' }, 404)
	switch (found.kind) {
		case 'custom_item':
			return await giftCustomItem(c, playerId, found.item, message)
		case 'skin':
			return await giftSkin(c, playerId, found.row, message)
		case 'consumable':
			return await giftConsumable(c, playerId, found.row, message)
		case 'avatar_item':
			return c.json(
				{
					error:
						'That is a baked avatar item; only custom items, skins and consumables can be gifted',
				},
				400
			)
		case 'ambiguous':
			return c.json({ error: 'That id names both a custom item and a catalog item' }, 409)
	}
}

/**
 * A custom avatar item: ownership is a row in `inventory_custom` (what `econ`'s owned read
 * serves the item from), and the box names it by `CustomAvatarItemId`.
 *
 * Refused as the store refuses a sale to this player: the item's own creator (who owns it
 * already), or a player who already has it.
 */
async function giftCustomItem(
	c: Context<App>,
	playerId: number,
	item: CustomAvatarItem,
	message: string
) {
	if (item.CreatorAccountId === playerId) {
		return c.json({ error: 'This player created that item, so they already have it' }, 409)
	}
	const owned = await ownedCustomAvatarItemIds(c.env.DB, playerId, [item.CustomAvatarItemId])
	if (owned.has(item.CustomAvatarItemId.toLowerCase())) {
		return c.json({ error: 'This player already owns that item' }, 409)
	}

	await grantCustomAvatarItem(c.env.DB, playerId, item.CustomAvatarItemId)
	const content = staffGiftContent({
		GiftContext: GIFT_CONTEXT_PURCHASED_GIFT_A,
		CustomAvatarItemId: item.CustomAvatarItemId,
		// 0, not the null the other staff boxes carry: a custom item IS an avatar item, and this
		// matches the box econ mints for a bought one, which is the shape seen to open.
		AvatarItemType: 0,
		Message: message,
	})
	const gift = await createGift(c.env.DB, playerId, content)

	await recordPlayerAudit(c, 'gift_custom_item', {
		playerId,
		customAvatarItemId: item.CustomAvatarItemId,
		name: item.Name,
		message,
		giftId: gift.id,
	})
	logger.info('staff gifted a custom item', {
		moderatorId: staffId(c),
		playerId,
		customAvatarItemId: item.CustomAvatarItemId,
	})
	await announceGift(c, playerId, gift.id, content)

	return c.json({
		kind: 'custom_item',
		playerId,
		customAvatarItemId: item.CustomAvatarItemId,
		name: item.Name,
		giftId: gift.id,
	})
}

/**
 * An equipment skin: ownership is a row in `equipment` (what `GET /api/equipment/v2/getUnlocked`
 * serves), and the box names it by `EquipmentPrefabName`/`EquipmentModificationGuid` with
 * `AvatarItemType` NULL — a 0 there sends the client looking for an avatar item that does not
 * exist, and the box fails to open.
 *
 * Refused for a player who already owns it: owning a skin is boolean, so a second grant would
 * hand them a box with nothing new in it.
 */
async function giftSkin(c: Context<App>, playerId: number, row: CatalogRow, message: string) {
	const skin = toCatalogSkin(row)
	const owned = await getEquipment(c.env.DB, playerId)
	if (owned.some((eq) => eq.ModificationGuid === skin.ModificationGuid)) {
		return c.json({ error: 'This player already owns that skin' }, 409)
	}

	// The same DTO a purchase grants (econ's `toEquipment`), built from the catalog's view.
	await grantEquipment(c.env.DB, playerId, {
		ModificationGuid: skin.ModificationGuid,
		PrefabName: skin.PrefabName,
		FriendlyName: skin.FriendlyName,
		Tooltip: skin.Tooltip ?? '',
		Rarity: skin.Rarity,
		PlatformMask: -1,
		Favorited: false,
	})
	const content = staffGiftContent({
		GiftContext: GIFT_CONTEXT_PURCHASED_GIFT_A,
		EquipmentPrefabName: skin.PrefabName,
		EquipmentModificationGuid: skin.ModificationGuid,
		GiftRarity: skin.Rarity,
		Message: message,
	})
	const gift = await createGift(c.env.DB, playerId, content)

	await recordPlayerAudit(c, 'gift_skin', {
		playerId,
		modificationGuid: skin.ModificationGuid,
		prefabName: skin.PrefabName,
		name: skin.FriendlyName,
		message,
		giftId: gift.id,
	})
	logger.info('staff gifted a skin', {
		moderatorId: staffId(c),
		playerId,
		modificationGuid: skin.ModificationGuid,
	})
	await announceGift(c, playerId, gift.id, content)

	return c.json({
		kind: 'skin',
		playerId,
		modificationGuid: skin.ModificationGuid,
		prefabName: skin.PrefabName,
		name: skin.FriendlyName,
		giftId: gift.id,
	})
}

/**
 * One of a consumable: a fresh `consumable` row (they stack, so there is no "already owns"
 * refusal — a second gift is a second one), and a box naming it by `ConsumableItemDesc` with
 * `AvatarItemType` NULL, as a skin's is. The box also carries the granted row's id and the
 * player's count BEFORE this one, which is what lets opening it fire an accurate
 * `ConsumableMappingAdded`.
 */
async function giftConsumable(c: Context<App>, playerId: number, row: CatalogRow, message: string) {
	const preExisting = await countConsumable(c.env.DB, playerId, row.item_key)
	const mappingId = await grantConsumable(c.env.DB, playerId, row.item_key, CONSUMABLE_GIFT_COUNT)
	const content = staffGiftContent({
		GiftContext: GIFT_CONTEXT_PURCHASED_GIFT_A,
		ConsumableItemDesc: row.item_key,
		ConsumableCount: CONSUMABLE_GIFT_COUNT,
		ConsumableMappingId: mappingId,
		ConsumablePreExistingCount: preExisting,
		GiftRarity: row.rarity,
		Message: message,
	})
	const gift = await createGift(c.env.DB, playerId, content)

	await recordPlayerAudit(c, 'gift_consumable', {
		playerId,
		consumableItemDesc: row.item_key,
		name: row.friendly_name,
		count: CONSUMABLE_GIFT_COUNT,
		message,
		giftId: gift.id,
	})
	logger.info('staff gifted a consumable', {
		moderatorId: staffId(c),
		playerId,
		consumableItemDesc: row.item_key,
	})
	await announceGift(c, playerId, gift.id, content)

	return c.json({
		kind: 'consumable',
		playerId,
		consumableItemDesc: row.item_key,
		name: row.friendly_name,
		count: CONSUMABLE_GIFT_COUNT,
		owned: preExisting + CONSUMABLE_GIFT_COUNT,
		giftId: gift.id,
	})
}

/**
 * Give a player one more username change. The client reads the count off `/account/me`,
 * so it shows the next time the player opens the name screen.
 */
export async function addUsernameChangeHandler(c: Context<App>) {
	const playerId = playerIdParam(c)
	if (playerId === null) return c.json({ error: 'A numeric player id is required' }, 400)

	const remaining = await addUsernameChange(c.env.DB, playerId)
	if (remaining === null) return c.json({ error: 'No such player' }, 404)

	await recordPlayerAudit(c, 'add_username_change', {
		playerId,
		availableUsernameChanges: remaining,
	})
	return c.json({ playerId, availableUsernameChanges: remaining })
}

/**
 * Remove a player's password so they can set a new one in game — the recovery for someone
 * who has forgotten it, since nothing here can send a reset email. `hadPassword` says whether
 * there was one to remove; clearing an already-clear password succeeds, and is still logged.
 */
export async function clearPasswordHandler(c: Context<App>) {
	const playerId = playerIdParam(c)
	if (playerId === null) return c.json({ error: 'A numeric player id is required' }, 400)

	const hadPassword = await clearPasswordHash(c.env.DB, playerId)
	if (hadPassword === null) return c.json({ error: 'No such player' }, 404)

	await recordPlayerAudit(c, 'clear_password', { playerId, hadPassword })
	logger.info('staff cleared a password', { moderatorId: staffId(c), playerId, hadPassword })
	return c.json({ playerId, hadPassword })
}
