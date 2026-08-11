/**
 * Who a ban reaches — the ban itself, plus the accounts that share an identity with a
 * banned one. This is the ban-EVASION half of moderation: a ban lives on a `report` row
 * (see reports-db) and applies to one account, but a player whose account is banned can
 * make another in seconds, so the block has to follow the things that are harder to
 * change than an account: the platform identity they log in with, and the network they
 * play from.
 *
 * Three arms, in descending order of how much they prove:
 *  - ACCOUNT — the caller's own account is banned. Certain.
 *  - PLATFORM — the caller shares a `platform_account` link (a Steam or Meta identity
 *    they PROVED to us; see the auth worker's platform-db) with a banned account. Sharp:
 *    linking only ever happens off a verified proof, so this really is the same person,
 *    modulo somebody handing over their Steam account.
 *  - IP — the caller shares a `signupIp`/`lastLoginIp` with a banned account. COARSE,
 *    and the one that will produce false positives: households, NAT, campus and mobile
 *    carrier networks put many unrelated players behind one address, so this arm bans a
 *    banned player's whole household along with them. It is the operator's call whether
 *    that trade is worth it — hence `BAN_EVASION_MATCH` (see `banEvasionMatch`), which
 *    narrows or disables the linked arms without touching the direct one.
 *
 * The direct arm can never be turned off. That is the point of the split: an operator
 * dialling back evasion matching still enforces every ban they handed down.
 *
 * Reads three tables owned by three workers — `report` (api), `account` (auth, via the
 * blob) and `platform_account` (auth) — which is why this is its own module rather than
 * part of reports-db: it is the POLICY over those tables, not any one table's storage.
 * It only ever reads them.
 *
 * The whole resolution is ONE statement. The alternative — fetch my ips, fetch my links,
 * then query bans — is three round trips on a path that runs on every matchmake and every
 * token grant. Driving from the (few) banned reports and looking each one's account up by
 * its indexed id keeps the work proportional to the number of BANS, not to the number of
 * accounts.
 */

import type { ReportRow } from './reports-db'

/** Which arm matched — what the block is actually resting on. */
export type BanVia = 'account' | 'platform' | 'ip'

/** A ban that reaches the caller, and how it reached them. */
export interface BanMatch {
	/** The report row carrying the ban (its `reported_player_id` is who was banned). */
	ban: ReportRow
	via: BanVia
	/**
	 * The banned account. Equal to the caller on a direct ban; on a linked arm it's the
	 * OTHER account they were matched to — the one worth naming in the operator's log.
	 */
	bannedAccountId: number
}

/** Which linked arms are enabled. The direct (account) arm is not optional. */
export interface BanMatchArms {
	ip: boolean
	platform: boolean
}

/** Both linked arms on — what an operator who sets nothing gets. */
export const DEFAULT_BAN_MATCH_ARMS: BanMatchArms = { ip: true, platform: true }

/**
 * Read the `BAN_EVASION_MATCH` operator knob: a comma-separated list of the linked arms
 * to enforce, out of `ip` and `platform`. Unset (the default) means BOTH — a ban follows
 * the player. `off` (or `none`, or an empty list) leaves only the direct arm, so a ban
 * applies to exactly the account it was handed to.
 *
 * Set it to `platform` on a server whose players share networks — student halls, one
 * household, a country behind CGNAT — where the IP arm would lock out bystanders. The
 * platform arm has no such failure mode: it matches a proven identity.
 *
 * Unrecognised names are ignored rather than fatal: this is read on a request path, and a
 * typo must not take matchmaking or login down with it. `off` wins over anything else in
 * the list, so `off,ip` is off.
 */
export function banEvasionMatch(value: string | undefined): BanMatchArms {
	if (value === undefined) return DEFAULT_BAN_MATCH_ARMS
	const names = value
		.split(',')
		.map((n) => n.trim().toLowerCase())
		.filter((n) => n !== '')
	if (names.length === 0 || names.includes('off') || names.includes('none')) {
		return { ip: false, platform: false }
	}
	return { ip: names.includes('ip'), platform: names.includes('platform') }
}

/**
 * The identity a request carries, for a caller who has no account yet — a `create_account`
 * grant, which must be refused BEFORE it mints anything, or a banned player's next account
 * exists (and has burned a signup) before the ban catches up with it.
 */
export interface BanIdentity {
	/** The client IP the request came from, if the edge reported one. */
	ip?: string | null
	/** A VERIFIED platform identity. An unproven one must never be passed here. */
	platform?: number | null
	platformId?: string | null
}

/** Row shape of the resolution query — a report plus which arm matched it. */
type BanMatchRow = ReportRow & {
	via_account: number
	via_ip: number
	via_platform: number
}

/**
 * Every ban in force, tested against the caller's account and against the identity they
 * present. `ips` and `ids` gather what the caller is known by: the account's stored IPs
 * and platform links (when there is an account) plus the IP/identity this request itself
 * carries (when there isn't one yet, or when it differs from what's stored).
 *
 * A NULL `?1` means "no account yet" — the `me` CTE is then empty and the account arm
 * cannot match, leaving the two linked arms to answer for a signup.
 */
const RESOLVE_BAN_SQL = `
WITH me AS (
	SELECT
		NULLIF(json_extract(data, '$.signupIp'), '') AS signup_ip,
		NULLIF(json_extract(data, '$.lastLoginIp'), '') AS last_login_ip
	FROM account WHERE account_id = ?1
),
ips AS (
	SELECT signup_ip AS ip FROM me WHERE signup_ip IS NOT NULL
	UNION SELECT last_login_ip FROM me WHERE last_login_ip IS NOT NULL
	UNION SELECT ?3 WHERE ?3 IS NOT NULL
),
ids AS (
	SELECT platform, platform_id FROM platform_account WHERE account_id = ?1
	UNION SELECT ?4, ?5 WHERE ?5 IS NOT NULL
)
SELECT * FROM (
	SELECT r.*,
		(r.reported_player_id = ?1) AS via_account,
		(?6 = 1 AND EXISTS (
			SELECT 1 FROM account a, ips
			WHERE a.account_id = r.reported_player_id
				AND a.account_id <> COALESCE(?1, -1)
				AND ips.ip IN (
					json_extract(a.data, '$.signupIp'),
					json_extract(a.data, '$.lastLoginIp')
				)
		)) AS via_ip,
		(?7 = 1 AND EXISTS (
			SELECT 1 FROM platform_account p, ids
			WHERE p.account_id = r.reported_player_id
				AND p.account_id <> COALESCE(?1, -1)
				AND p.platform = ids.platform
				AND p.platform_id = ids.platform_id
		)) AS via_platform
	FROM report r
	WHERE r.banned = 1 AND (r.ban_expires IS NULL OR r.ban_expires > ?2)
)
WHERE via_account = 1 OR via_ip = 1 OR via_platform = 1
ORDER BY via_account DESC, via_platform DESC, ban_expires IS NOT NULL, ban_expires DESC
LIMIT 1`

/**
 * The ban blocking this caller, or null when nothing does.
 *
 * Pass the `accountId` when there is one (every login after the first, and every
 * matchmake) and the request's own `identity` when it adds something the account doesn't
 * already carry — on a `create_account` grant there is no account at all, and that is
 * exactly the request a ban evader makes.
 *
 * The strongest match is the one returned: a direct ban ahead of a platform match ahead
 * of an IP one, then the longest-lasting ban of those. So the log line names the evidence
 * an operator would want to see first, and a player whose own account is banned is never
 * told it was their network.
 */
export async function resolveBan(
	db: D1Database,
	accountId: number | null,
	options: { identity?: BanIdentity; arms?: BanMatchArms; now?: Date } = {}
): Promise<BanMatch | null> {
	const arms = options.arms ?? DEFAULT_BAN_MATCH_ARMS
	const identity = options.identity ?? {}
	const row = await db
		.prepare(RESOLVE_BAN_SQL)
		.bind(
			accountId,
			(options.now ?? new Date()).toISOString(),
			identity.ip || null,
			identity.platform ?? 0,
			identity.platformId || null,
			arms.ip ? 1 : 0,
			arms.platform ? 1 : 0
		)
		.first<BanMatchRow>()
	if (!row) return null

	// `via_ip` is only stripped off the row here — it's the arm left when neither of the
	// other two matched, so nothing reads it.
	const { via_account, via_ip: _via_ip, via_platform, ...ban } = row
	const via: BanVia = via_account === 1 ? 'account' : via_platform === 1 ? 'platform' : 'ip'
	return { ban: ban as ReportRow, via, bannedAccountId: ban.reported_player_id }
}

/** Whether anything blocks this caller — the boolean form of `resolveBan`. */
export async function isPlayerBlocked(
	db: D1Database,
	accountId: number | null,
	options: { identity?: BanIdentity; arms?: BanMatchArms; now?: Date } = {}
): Promise<boolean> {
	return (await resolveBan(db, accountId, options)) !== null
}
