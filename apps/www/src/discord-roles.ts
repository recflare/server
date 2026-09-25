import { PlatformType } from '@repo/domain/src/enums'

import { getLinksForPlatform, setPlatformLinkRoles } from '../../auth/src/platform-db'
import { API_BASE, readSecret } from './discord'

import type { PlatformLink } from '../../auth/src/platform-db'
import type { Env } from './context'

/**
 * The scheduled Discord role refresh, behind the daily cron in wrangler.jsonc.
 *
 * The benefits claim (discord.ts, `/api/benefits/claim`) records the roles a member held
 * on their `platform_account` link, read with the member's OWN OAuth token — which the
 * claim revokes the moment it has read them, so nothing can ask again. That leaves
 * `role` a snapshot from claim time: a supporter whose role lapsed, or who was promoted
 * to staff since, looks in the table exactly as they did the day they claimed.
 *
 * This sweep is the credential the claim deliberately lacks: a BOT TOKEN. A bot that has
 * been invited to the guild can read any member's record through
 * `GET /guilds/{guild}/members/{user}` — no privileged intent, no permission bits; being
 * in the guild is enough — so each run walks every Discord link, asks Discord about each,
 * and writes the answer back. With a bot configured the snapshot trails the guild by at
 * most a day; without one the sweep logs that it's off and the table stays as the claim
 * left it.
 *
 * What it does NOT do is touch `hasPlus`. That flag is "held a qualifying role once", set
 * by the claim or by an operator, and accounts-db.ts is explicit that a Discord link's
 * state never revokes it. A member who left the guild gets an EMPTY role list and keeps
 * their Plus; the roles say what they hold, the flag says what they were granted, and an
 * operator reading both can decide what to do about the difference.
 *
 * Every link, every run, deliberately simple: no stamp column, no batching. Each link
 * costs one Discord call and one D1 write, and a cron invocation has a fixed budget of
 * both (50 subrequests on the free plan, 1000 paid) — a community whose claimed members
 * outgrow that is the point to split the run up, not before.
 *
 * Logs via `console` rather than the tagged logger: that logger is request-scoped, and a
 * cron has no request (the same reason `match`'s presence sweep does).
 */

/**
 * The longest one run will wait out a rate limit before moving on. Discord's per-route
 * buckets reset in well under this; a `retry_after` beyond it means something global is
 * going on, and the next run is a day away anyway.
 */
const MAX_PAUSE_MS = 10_000

/**
 * What one member read came to. Four answers, because the sweep does four different things
 * with them:
 *
 *  - `member`: in the guild, with these roles. Written back.
 *  - `gone`: Discord says there is no such member (404 `Unknown Member`, or `Unknown User`
 *    for a deleted account). Written back as NO roles — leaving the guild is a real change
 *    in what they hold.
 *  - `halt`: the token or the guild is the problem (401, 403 `Missing Access`, 404 `Unknown
 *    Guild`), so every further call this run would fail the same way. The run stops, and
 *    nothing is written: a bot that isn't in the guild yet must not blank every snapshot.
 *  - `error`: something transient (5xx, network, an unexpected body). That one link is
 *    skipped and keeps its old snapshot until the next run.
 *
 * `pauseMs` rides along on any of them when Discord's rate-limit headers say the bucket is
 * spent (`X-RateLimit-Remaining: 0`) or the call was refused for it (429): the sweep sleeps
 * that long before its next call.
 */
export type MemberRead = (
	| { kind: 'member'; roles: string[] }
	| { kind: 'gone' }
	| { kind: 'halt'; reason: string }
	| { kind: 'error'; status: number | null }
) & { pauseMs?: number }

/**
 * Discord's JSON error codes on the 404s this endpoint answers with. A 404 here is NOT one
 * thing: `Unknown Member` is the ordinary "they left", while `Unknown Guild` means the BOT
 * isn't in the guild (Discord hides guilds a caller can't see), and reading that as "every
 * member left" would empty every snapshot in the table on a misconfigured deploy.
 */
const UNKNOWN_GUILD = 10004
const UNKNOWN_MEMBER = 10007
const UNKNOWN_USER = 10013

/** Fetch's signature, so a test can stand in for discord.com. */
export type FetchLike = (input: string, init?: RequestInit) => Promise<Response>

/**
 * One member's roles in the guild, read as the bot. See {@link MemberRead} for the answers.
 *
 * The rate-limit headers are read on every response, not just a 429, so the sweep backs
 * off BEFORE it's refused: a run of dozens against a 5-per-5-seconds bucket would
 * otherwise spend most of its time being told no. `X-RateLimit-Reset-After` is seconds, fractional.
 */
export async function fetchMemberRoles(
	botToken: string,
	guildId: string,
	userId: string,
	fetchImpl: FetchLike = fetch
): Promise<MemberRead> {
	let res: Response
	try {
		res = await fetchImpl(`${API_BASE}/guilds/${guildId}/members/${userId}`, {
			headers: { authorization: `Bot ${botToken}` },
		})
	} catch (err) {
		console.error(`discord role sweep: could not reach discord: ${String(err)}`)
		return { kind: 'error', status: null }
	}

	const pauseMs = rateLimitPause(res)
	const body = (await res.json().catch(() => null)) as {
		roles?: unknown
		code?: unknown
		retry_after?: unknown
		message?: unknown
	} | null

	if (res.ok) {
		const roles = Array.isArray(body?.roles)
			? body.roles.filter((r): r is string => typeof r === 'string')
			: null
		if (roles === null) {
			console.error('discord role sweep: member record had no roles array')
			return { kind: 'error', status: res.status, pauseMs }
		}
		return { kind: 'member', roles, pauseMs }
	}

	const code = typeof body?.code === 'number' ? body.code : null
	switch (res.status) {
		case 404:
			if (code === UNKNOWN_MEMBER || code === UNKNOWN_USER) return { kind: 'gone', pauseMs }
			if (code === UNKNOWN_GUILD) {
				return { kind: 'halt', reason: 'the bot is not in the guild (Unknown Guild)', pauseMs }
			}
			return { kind: 'error', status: 404, pauseMs }
		case 401:
			return { kind: 'halt', reason: 'discord refused the bot token (401)', pauseMs }
		case 403:
			return { kind: 'halt', reason: 'the bot may not read guild members (403)', pauseMs }
		case 429: {
			// The body's `retry_after` (seconds) is the authoritative wait on a 429; the header
			// may describe a different bucket.
			const retryAfter = typeof body?.retry_after === 'number' ? body.retry_after : null
			return {
				kind: 'error',
				status: 429,
				pauseMs: retryAfter === null ? pauseMs : Math.ceil(retryAfter * 1000),
			}
		}
		default:
			return { kind: 'error', status: res.status, pauseMs }
	}
}

/** Milliseconds to wait before the next call, from the bucket headers; 0 when it has room. */
function rateLimitPause(res: Response): number {
	if (res.headers.get('x-ratelimit-remaining') !== '0') return 0
	const resetAfter = Number(res.headers.get('x-ratelimit-reset-after'))
	return Number.isFinite(resetAfter) && resetAfter > 0 ? Math.ceil(resetAfter * 1000) : 0
}

/** What a run did, for the log line and the tests. */
export interface SweepSummary {
	/** True when the sweep is not configured (no bot token or no guild) and did nothing. */
	skipped: boolean
	/** Links a member read came back for and was written. */
	refreshed: number
	/** Of those, how many had roles that differ from the stored snapshot. */
	changed: number
	/** Of those, how many are no longer in the guild. */
	gone: number
	/** Links skipped for a transient error, left as they were for the next run. */
	failed: number
	/** Why the run stopped early, or null when it worked through its batch. */
	halted: string | null
}

/** The seams a test replaces: the Discord read and the rate-limit sleep. */
export interface SweepDeps {
	fetchMember?: (botToken: string, guildId: string, userId: string) => Promise<MemberRead>
	sleep?: (ms: number) => Promise<void>
}

const realSleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms))

/**
 * One run of the sweep. Sequential on purpose — Discord's per-route bucket is small, and
 * one call at a time with the header-driven pause is what stays inside it.
 *
 * Order of checks: configuration, then whether there is anything to refresh, then Discord.
 * An operator with no Discord links (or none configured) never sends a request, so a
 * placeholder bot token on a server that doesn't use the claim costs nothing but the
 * one D1 read.
 */
export async function refreshDiscordRoles(env: Env, deps: SweepDeps = {}): Promise<SweepSummary> {
	const summary: SweepSummary = {
		skipped: false,
		refreshed: 0,
		changed: 0,
		gone: 0,
		failed: 0,
		halted: null,
	}
	const fetchMember = deps.fetchMember ?? fetchMemberRoles
	const sleep = deps.sleep ?? realSleep

	// Guild before token: a server with no Discord configured at all shouldn't log a failed
	// secret read every hour on top of being off.
	const guildId = env.DISCORD_GUILD_ID ?? ''
	if (guildId === '') {
		console.log('discord role sweep: off (no DISCORD_GUILD_ID)')
		return { ...summary, skipped: true }
	}
	const botToken = await readSecret(env.DISCORD_BOT_TOKEN, 'DISCORD_BOT_TOKEN')
	if (botToken === '') {
		console.log('discord role sweep: off (no DISCORD_BOT_TOKEN)')
		return { ...summary, skipped: true }
	}

	const links = await getLinksForPlatform(env.DB, PlatformType.Discord)
	if (links.length === 0) {
		console.log('discord role sweep: no discord links to refresh')
		return summary
	}

	for (const link of links) {
		const read = await fetchMember(botToken, guildId, link.platformId)
		if (read.kind === 'halt') {
			summary.halted = read.reason
			console.error(`discord role sweep: stopping, ${read.reason}`)
			break
		}
		if (read.kind === 'error') {
			summary.failed++
			console.error(
				`discord role sweep: could not read account ${link.accountId}'s member (status ${read.status ?? 'none'}), skipping`
			)
		} else {
			await recordRead(env.DB, link, read.kind === 'gone' ? [] : read.roles, summary)
			if (read.kind === 'gone') summary.gone++
		}
		if (read.pauseMs !== undefined && read.pauseMs > 0) {
			await sleep(Math.min(read.pauseMs, MAX_PAUSE_MS))
		}
	}

	console.log(
		`discord role sweep: refreshed ${summary.refreshed} of ${links.length} links, ${summary.changed} changed, ${summary.gone} left the guild, ${summary.failed} failed${summary.halted ? `, halted: ${summary.halted}` : ''}`
	)
	return summary
}

/** Write one reading back and count it. */
async function recordRead(
	db: D1Database,
	link: PlatformLink,
	roles: string[],
	summary: SweepSummary
): Promise<void> {
	const wrote = await setPlatformLinkRoles(
		db,
		link.accountId,
		link.platform,
		link.platformId,
		roles
	)
	if (!wrote) {
		// Read a moment ago and gone now: the link was removed in between. Nothing to do.
		console.log(`discord role sweep: account ${link.accountId}'s discord link vanished mid-run`)
		return
	}
	summary.refreshed++
	if (!sameRoles(link.roles, roles)) {
		summary.changed++
		console.log(
			`discord role sweep: account ${link.accountId} now holds ${roles.length} role(s) (was ${link.roles.length})`
		)
	}
}

/** Same set of role ids, in any order — Discord doesn't promise an order and neither does the row. */
const sameRoles = (a: readonly string[], b: readonly string[]): boolean =>
	a.length === b.length && [...a].sort().every((role, i) => role === [...b].sort()[i])
