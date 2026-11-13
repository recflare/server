/**
 * Every client IP an account has been seen from, on the shared `recflare` D1 database
 * (owned by the `auth` worker, migration 0016_account_ip). One row per (account, address):
 * when it was first and last seen there, and how many times.
 *
 * The account blob keeps two addresses — the immutable `signupIp` and the overwritten
 * `lastLoginIp` — which is enough for the signup caps but not for a ban that has to follow a
 * player: an evader who signed up at home and plays from a phone has used a third address
 * the blob has already forgotten, and so has the clean account they logged into once from
 * the banned one's network. This table is the HISTORY those two fields are the ends of. The
 * ban-evasion IP arm (the api worker's bans-db) matches against it alongside the blob, and
 * the staff panel lists it so a moderator can see what an IP match was made on.
 *
 * Written on every token grant — signup, both login grants, the identity assertion AND a
 * refresh — because an address changes mid-session (a VPN switched on after signing in, a
 * phone moving networks) and a refresh is the only grant that sees it. A refresh does not
 * move the blob's `lastLoginIp`, which stays what its name says; it only lands here. One
 * UPSERT per grant, so the cost is the same as the `lastLoginIp` write it sits beside.
 *
 * Rows are never deleted — not on account deletion either: the point of recording the
 * address is that it outlives the account it was recorded on, which is exactly what a
 * deleted-then-recreated evader relies on it not doing.
 *
 * An IP is personal data and a coarse identity (households and carrier networks share one),
 * so this is a moderation record, read by staff and by the evasion arm, and nothing on the
 * player-facing surface.
 */

import { bindPlaceholders, chunkForBinds } from './d1-binds'

/** Schema DDL (mirror of apps/auth/migrations/0016_account_ip.sql, sans the backfill, + 0019's `country`). */
export const ACCOUNT_IP_SCHEMA_DDL: string[] = [
	`CREATE TABLE IF NOT EXISTS account_ip (
		account_id INTEGER NOT NULL,
		ip TEXT NOT NULL,
		first_seen TEXT NOT NULL,
		last_seen TEXT NOT NULL,
		hits INTEGER NOT NULL DEFAULT 1,
		country TEXT,
		PRIMARY KEY (account_id, ip)
	)`,
	// The evasion arm asks "which accounts have used THIS address" — the reverse of the
	// primary key.
	`CREATE INDEX IF NOT EXISTS idx_account_ip_ip ON account_ip (ip)`,
]

/** One address an account has been seen from. */
export interface AccountIp {
	accountId: number
	ip: string
	/** ISO-8601, the first grant seen from this address. */
	firstSeen: string
	/** ISO-8601, the most recent grant seen from this address. */
	lastSeen: string
	/** How many grants (signups, logins, refreshes) have come from it. */
	hits: number
	/**
	 * The country Cloudflare placed this address in at its most recent grant — ISO 3166-1
	 * alpha-2, `T1` for Tor — or null when unknown (recorded before the column existed, or
	 * the edge couldn't say).
	 */
	country: string | null
}

interface AccountIpRow {
	account_id: number
	ip: string
	first_seen: string
	last_seen: string
	hits: number
	country: string | null
}

function fromRow(row: AccountIpRow): AccountIp {
	return {
		accountId: row.account_id,
		ip: row.ip,
		firstSeen: row.first_seen,
		lastSeen: row.last_seen,
		hits: row.hits,
		country: row.country ?? null,
	}
}

/**
 * Note that `accountId` was just seen from `ip`: a new row the first time, otherwise the
 * row's `last_seen` moves and its `hits` count up. `country` is the
 * grant's (see {@link requestCountry}); a later grant the edge couldn't place keeps the
 * country already on the row rather than blanking it. An empty address — the edge reported
 * none, as in tests — records nothing, for the same reason `countAccountsBySignupIp` counts
 * an empty one as 0: it attributes the grant to nobody, and a row for `''` would link every
 * such account to every other.
 */
export async function recordAccountIp(
	db: D1Database,
	accountId: number,
	ip: string,
	{ country = null, now = new Date() }: { country?: string | null; now?: Date } = {}
): Promise<void> {
	if (ip === '') return
	await db
		.prepare(
			`INSERT INTO account_ip (account_id, ip, first_seen, last_seen, hits, country)
			 VALUES (?1, ?2, ?3, ?3, 1, ?4)
			 ON CONFLICT (account_id, ip) DO UPDATE SET
				last_seen = excluded.last_seen,
				hits = hits + 1,
				country = COALESCE(excluded.country, country)`
		)
		.bind(accountId, ip, now.toISOString(), country)
		.run()
}

/**
 * The country Cloudflare's edge placed a request in (`request.cf.country`), or null when it
 * couldn't — no `cf` object (tests, a service binding) or its own "unknown", `XX`. Tor exits
 * come through as `T1` and are kept: that is worth a moderator seeing.
 */
export function requestCountry(request: Request): string | null {
	const country = (request as { cf?: { country?: unknown } }).cf?.country
	return typeof country === 'string' && country !== '' && country !== 'XX' ? country : null
}

/** Every address `accountId` has been seen from, most recently seen first. */
export async function listAccountIps(db: D1Database, accountId: number): Promise<AccountIp[]> {
	const { results } = await db
		.prepare('SELECT * FROM account_ip WHERE account_id = ?1 ORDER BY last_seen DESC, ip')
		.bind(accountId)
		.all<AccountIpRow>()
	return results.map(fromRow)
}

/**
 * The addresses of several accounts in one read, keyed by account — what the staff panel's
 * linked-accounts table needs for every row at once. An account with no rows is absent from
 * the map rather than present with an empty list.
 */
export async function listAccountIpsFor(
	db: D1Database,
	accountIds: number[]
): Promise<Map<number, AccountIp[]>> {
	const byAccount = new Map<number, AccountIp[]>()
	if (accountIds.length === 0) return byAccount
	for (const chunk of chunkForBinds(accountIds)) {
		const { results } = await db
			.prepare(
				`SELECT * FROM account_ip WHERE account_id IN (${bindPlaceholders(chunk)})
				 ORDER BY account_id, last_seen DESC, ip`
			)
			.bind(...chunk)
			.all<AccountIpRow>()
		for (const row of results) {
			const list = byAccount.get(row.account_id)
			if (list) list.push(fromRow(row))
			else byAccount.set(row.account_id, [fromRow(row)])
		}
	}
	return byAccount
}
