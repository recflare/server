/**
 * Platform identity links on the shared `recflare` D1 database (owned by the `auth`
 * worker, migration 0007). One row per (platform, platform id, account): the Steam
 * user 76561…211 is linked to account 42, the Meta user 27061… is linked to account
 * 42 as well, and both let that player into that account without a password.
 *
 * This table replaced the single `platformId`/`platform` pair on the account blob as
 * the thing logins are decided from, because that pair could only hold ONE identity —
 * a player with a PC and a headset had to pick which device got a cached login. The
 * blob fields are kept as the account's *primary* identity (the first one linked) for
 * the account DTO and the refresh grant's claims; nothing authorizes off them.
 *
 * It is deliberately the ONE source of truth for both halves of a cached login: the
 * picker (`/cachedlogin/forplatformid`) lists the accounts this table links to an
 * identity, and the `cached_login` grant asks this table whether the account it was
 * handed is linked to the identity that was proven. When those two disagreed the
 * client was offered an account it could never log into — see the regression test.
 *
 * A link is only ever written from a VERIFIED identity (a Steam-signed ticket or a
 * Meta-validated nonce). It is what turns "this platform user" into "may enter this
 * account with no password", so an unproven `platform_id` must never reach it.
 *
 * Not every link is a LOGIN, though. The table is the account's set of external
 * identities, and some are stored for what they entitle the player to rather than for
 * entry: `PlatformType.Discord` (101) is written by the website's benefits claim, from an
 * OAuth2 code exchange Discord itself vouched for. Nobody signs in with it —
 * `verifyPlatformProof` answers `unsupported` for anything but Steam and Meta, so a
 * `cached_login` naming platform 101 is refused — and the picker must not offer it
 * either. See {@link CACHED_LOGIN_PLATFORMS}, which is what keeps those two in step.
 */

import { PlatformType } from '@repo/domain/src/enums'

/** Schema DDL (mirror of migrations/0007_platform_accounts.sql, sans the backfill). */
export const PLATFORM_SCHEMA_DDL: string[] = [
	`CREATE TABLE IF NOT EXISTS platform_account (
		account_id INTEGER NOT NULL,
		platform INTEGER NOT NULL,
		platform_id TEXT NOT NULL,
		linked_at TEXT NOT NULL,
		PRIMARY KEY (platform, platform_id, account_id)
	)`,
	// The picker's lookup: "which accounts does this identity open?". Covered by the
	// primary key's leading columns, so no separate index is needed for it.
	`CREATE INDEX IF NOT EXISTS idx_platform_account_account ON platform_account (account_id)`,
	// Lookup by bare platform id, across platforms — the bulk (friends) route, which
	// resolves ids it has no platform for.
	`CREATE INDEX IF NOT EXISTS idx_platform_account_platform_id ON platform_account (platform_id)`,
]

/**
 * The one-time backfill 0007 ran after creating the table: every identity already bound
 * to an account became a link, so nobody lost their cached login at deploy. It has run;
 * this exists so a test can still exercise it, which is the only coverage that legacy
 * blob-bound accounts get a link at all.
 *
 * `platform` is COALESCEd to 0 because nothing ever defaulted that field — an account
 * can carry a platformId with no platform recorded, and back when Steam was the only
 * verifiable platform an unset one *was* Steam.
 *
 * NOT byte-identical to the migration any more, deliberately. 0007 selected the
 * `account.platform_id` generated column; 0008 drops it, so that text is unrunnable
 * against the head schema the tests build. This selects the blob directly instead —
 * the same values, since the dropped column was DEFINED as
 * `json_extract(data, '$.platformId')`. 0007 is left exactly as it ran on prod.
 */
export const PLATFORM_BACKFILL_SQL = `INSERT OR IGNORE INTO platform_account (account_id, platform, platform_id, linked_at)
	SELECT
		account_id,
		COALESCE(json_extract(data, '$.platform'), 0),
		json_extract(data, '$.platformId'),
		COALESCE(json_extract(data, '$.createdAt'), '1970-01-01T00:00:00Z')
	FROM account
	WHERE json_extract(data, '$.platformId') IS NOT NULL
		AND json_extract(data, '$.platformId') <> ''`

/**
 * The platforms a cached login can actually be redeemed for — the ones
 * `verifyPlatformProof` can prove, which is Steam (a Steam-signed ticket) and Meta/Oculus
 * (a Meta-validated nonce).
 *
 * This is the picker's filter, and it exists to keep a promise the picker's own API
 * documentation makes: "an entry here is always redeemable by a `cached_login` grant
 * (both read the same table)". Once the table began holding identities that are NOT
 * credentials — Discord, from the website's benefits claim — listing every row would have
 * broken that promise in two ways at once. The client would be offered an account it can
 * never log into (the grant refuses platform 101 outright), and, worse, the picker is
 * PUBLIC and unauthenticated: `GET /cachedlogin/forplatformid/101/<snowflake>` would have
 * told anyone which RecFlare account a given Discord user owns, and the bulk route would
 * have done it for a list of them at once. A Discord id is trivially readable by anyone in
 * a shared server, so that is a deanonymisation of every player who claimed benefits.
 *
 * Adding a platform here means asserting `verifyPlatformProof` can prove it. Filtering
 * happens in the two picker reads only — {@link isPlatformIdentityLinked},
 * {@link countAccountsForPlatformIdentity} and {@link getLinksForAccount} deliberately see
 * every link, because they answer "is this identity taken / whose is it", which is exactly
 * the question the benefits claim's once-only guard asks about a Discord id.
 */
export const CACHED_LOGIN_PLATFORMS: readonly number[] = [PlatformType.Steam, PlatformType.Oculus]

/**
 * `IN (…)` fragment for the allowlist, so the filter is applied by the query rather than
 * in JS. Placeholders are numbered from ?2 because the one caller binds the platform id
 * as ?1 — explicit indices rather than bare `?`, which SQLite would number by position
 * and quietly renumber the moment another parameter is added ahead of it.
 */
const CACHED_LOGIN_FILTER = `platform IN (${CACHED_LOGIN_PLATFORMS.map((_, i) => `?${i + 2}`).join(', ')})`

/** One account ↔ platform identity link. */
export interface PlatformLink {
	accountId: number
	platform: number
	platformId: string
	/** ISO-8601 time the link was made. */
	linkedAt: string
}

interface LinkRow {
	accountId: number
	platform: number
	platformId: string
	linkedAt: string
}

const SELECT_LINK = `SELECT account_id AS accountId, platform, platform_id AS platformId,
	linked_at AS linkedAt FROM platform_account`

/**
 * Link a verified platform identity to an account. Idempotent — re-logging in on the
 * same platform doesn't churn the row, and `linkedAt` keeps the time of the FIRST
 * link. Returns true when this created a new link.
 *
 * Callers must pass an identity the platform itself proved. Nothing in here can tell
 * a verified id from a spoofed one.
 */
export async function linkPlatformIdentity(
	db: D1Database,
	accountId: number,
	platform: number,
	platformId: string
): Promise<boolean> {
	if (platformId === '') return false
	const res = await db
		.prepare(
			`INSERT OR IGNORE INTO platform_account (account_id, platform, platform_id, linked_at)
			 VALUES (?1, ?2, ?3, ?4)`
		)
		.bind(accountId, platform, platformId, new Date().toISOString())
		.run()
	return res.meta.changes > 0
}

/**
 * The accounts a platform identity opens — what the login-screen picker lists.
 * Ordered oldest link first so the list is stable between launches (D1 row order
 * isn't). Empty id yields nothing rather than matching every link.
 */
export async function getLinksForPlatformIdentity(
	db: D1Database,
	platform: number,
	platformId: string
): Promise<PlatformLink[]> {
	if (platformId === '') return []
	// Asking about a platform nobody can log in from yields nothing at all, rather than a
	// list the grant would refuse — see CACHED_LOGIN_PLATFORMS.
	if (!CACHED_LOGIN_PLATFORMS.includes(platform)) return []
	const { results } = await db
		.prepare(
			`${SELECT_LINK} WHERE platform = ?1 AND platform_id = ?2 ORDER BY linked_at, account_id`
		)
		.bind(platform, platformId)
		.all<LinkRow>()
	return results
}

/**
 * Links for a bare platform id, whatever platform it belongs to. For the bulk
 * (friends-resolution) lookup, which posts ids with no platform alongside them, and
 * for the single-id route when the client sends a non-numeric platform.
 */
export async function getLinksForPlatformId(
	db: D1Database,
	platformId: string
): Promise<PlatformLink[]> {
	if (platformId === '') return []
	// Matches on any platform a cached login can be redeemed for — but only those. This is
	// the route a bare id takes, so without the filter a Discord snowflake posted here
	// would resolve its account even though naming platform 101 explicitly would not.
	const { results } = await db
		.prepare(
			`${SELECT_LINK} WHERE platform_id = ?1 AND ${CACHED_LOGIN_FILTER}
			 ORDER BY linked_at, account_id`
		)
		.bind(platformId, ...CACHED_LOGIN_PLATFORMS)
		.all<LinkRow>()
	return results
}

/** Every platform identity linked to an account (a player's PC and headset, say). */
export async function getLinksForAccount(
	db: D1Database,
	accountId: number
): Promise<PlatformLink[]> {
	const { results } = await db
		.prepare(`${SELECT_LINK} WHERE account_id = ?1 ORDER BY linked_at, platform`)
		.bind(accountId)
		.all<LinkRow>()
	return results
}

/**
 * Whether this account is linked to this platform identity — the single check the
 * `cached_login` grant authorizes on. An account with no link for the presented
 * identity cannot be cached-logged-into and must use a password.
 */
export async function isPlatformIdentityLinked(
	db: D1Database,
	accountId: number,
	platform: number,
	platformId: string
): Promise<boolean> {
	if (platformId === '') return false
	const row = await db
		.prepare(
			`SELECT 1 AS ok FROM platform_account
			 WHERE account_id = ?1 AND platform = ?2 AND platform_id = ?3`
		)
		.bind(accountId, platform, platformId)
		.first<{ ok: number }>()
	return row !== null
}

/**
 * How many accounts one platform identity already opens — the count both signup caps
 * and link caps are enforced against, so an identity can't accumulate accounts by
 * creating them under the cap and then linking more in.
 */
export async function countAccountsForPlatformIdentity(
	db: D1Database,
	platform: number,
	platformId: string
): Promise<number> {
	if (platformId === '') return 0
	const row = await db
		.prepare(`SELECT COUNT(*) AS n FROM platform_account WHERE platform = ?1 AND platform_id = ?2`)
		.bind(platform, platformId)
		.first<{ n: number }>()
	return row?.n ?? 0
}
