/**
 * Account storage on the shared `recflare` D1 database. Each account is a single
 * JSON blob in the `data` column; queryable fields (AccountId, Username) are
 * SQLite generated (virtual) columns extracted from that JSON and indexed —
 * the same JSON-blob pattern the `rooms` worker uses.
 *
 * The `auth` worker owns this schema/migration (see apps/auth/migrations/
 * 0001_accounts.sql, applied with its own `migrations_table` so it doesn't clash
 * with the rooms migrations that share the database). This module is the single
 * source of truth for the helpers; the `auth` and `accounts` workers both import
 * it from `@repo/domain` (each uses the subset it needs).
 */

import { AVATAR_STUDIO_ACCESS } from './avatar-studio'
import { bindPlaceholders, chunkForBinds } from './d1-binds'

/**
 * Schema DDL — the head schema, i.e. what the table looks like after every migration
 * (0001_accounts + 0002_avatar + 0009_account_has_plus + 0012_account_is_influencer, sans
 * seed INSERTs; 0004 added a `platform_id` generated column and 0008 dropped it again, so it
 * appears here in neither form).
 *
 * `has_plus` mirrors the blob's `hasPlus` so the operator's Plus token reload can find every
 * subscriber through its partial index instead of scanning every account's JSON. It is 1 for
 * JSON true, 0 for false and NULL when the key is absent; the index holds only the 1s.
 * `is_influencer` does the same for `isInfluencer`, for econ's influencer list.
 */
export const SCHEMA_DDL: string[] = [
	`CREATE TABLE IF NOT EXISTS account (
		data TEXT NOT NULL,
		avatar TEXT,
		account_id INTEGER GENERATED ALWAYS AS (json_extract(data, '$.accountId')) VIRTUAL,
		username_lower TEXT GENERATED ALWAYS AS (lower(json_extract(data, '$.username'))) VIRTUAL,
		has_plus INTEGER GENERATED ALWAYS AS (json_extract(data, '$.hasPlus')) VIRTUAL,
		is_influencer INTEGER GENERATED ALWAYS AS (json_extract(data, '$.isInfluencer')) VIRTUAL
	)`,
	`CREATE UNIQUE INDEX IF NOT EXISTS idx_accounts_account_id ON account (account_id)`,
	`CREATE INDEX IF NOT EXISTS idx_accounts_username_lower ON account (username_lower)`,
	`CREATE INDEX IF NOT EXISTS idx_account_has_plus ON account (has_plus) WHERE has_plus = 1`,
	`CREATE INDEX IF NOT EXISTS idx_account_is_influencer ON account (is_influencer) WHERE is_influencer = 1`,
]

/** Client-facing account shape (camelCase, exactly as the client's AccountDTO). */
export interface Account {
	accountId: number
	username: string
	displayName: string
	profileImage: string
	/** Profile banner image key, set by `accounts` `PUT /account/me/bannerimage`. `""` until then. */
	bannerImage: string
	/** The emoji beside the display name, set by `accounts` `PUT /account/me/emoji`. `""` until then. */
	displayEmoji: string
	isJunior: boolean
	platforms: number
	personalPronouns: number
	identityFlags: number
	createdAt: string
	/**
	 * The account's PRIMARY platform identity — the first one linked (e.g. a SteamID64
	 * for platform 0). Stored as a STRING on purpose: a SteamID64 exceeds 2^53 and
	 * would lose precision as a JS number.
	 *
	 * An account can be reachable from SEVERAL platform identities (a PC and a headset),
	 * and those live in the `auth` worker's `platform_account` table — NOT here. Logins
	 * are authorized against that table alone; this pair is what the account DTO and a
	 * refreshed token's claims report, and it never gains a second value.
	 */
	platformId?: string
	/** PlatformType int (0 = Steam) that `platformId` belongs to. */
	platform?: number
	/** ISO-8601 time of the account's most recent successful login. */
	lastLoginTime?: string
	/**
	 * The client's `device_id` from its most recent login — a stable per-install hash the
	 * client sends on every /connect/token, on the account-creating grant and on both
	 * login grants (but NOT on a refresh, which re-attests nothing).
	 *
	 * Not a credential. The client picks it and nothing verifies it, so never authorize on
	 * it alone; it is a SIGNAL, recorded and read later.
	 *
	 * Kept for ban EVASION: an account logging in from the same install as a banned one is
	 * the sharpest of the linked arms after a proven platform identity, and much narrower
	 * than the IP arm (a household shares an address, not an install). The per-device
	 * signup cap counts it (`countAccountsByDeviceId`); the ban-evasion arms in the api
	 * worker's bans-db do not yet.
	 *
	 * ONE value, overwritten each login: this is the account's LAST-SEEN device, not a
	 * history of every device it has used. So evasion matching on it will catch a player
	 * who evades from the install they were last banned on, and miss one who has since
	 * logged the banned account in somewhere else — and the signup cap can be walked back
	 * the same way, by logging old accounts in from another install. That costs the
	 * abuser a login per freed slot, which is the point; and since the id is client-chosen,
	 * a scripted signup can fabricate one anyway, so an immutable signup-time copy (as the
	 * IP arm keeps in `signupIp`) would buy nothing here.
	 */
	deviceId?: string
	/** DeviceClass int (2 = PC/standalone) that `deviceId` was last seen on. */
	deviceClass?: number
	/**
	 * The client IP the account was CREATED from (Cloudflare's CF-Connecting-IP).
	 * Immutable once set — it's what a "how many accounts came from this IP" signup
	 * cap counts, so refreshing it on login would let an abuser hop IPs to reset
	 * their own count. Empty when the header is absent (e.g. in tests).
	 */
	signupIp?: string
	/** The client IP of the most recent successful login; refreshed on every login. */
	lastLoginIp?: string
	/** Set via POST /account/me/email; absent until the player provides one. */
	email?: string
	/** Set via POST /account/me/phone; absent until the player provides one. */
	phone?: string
	/** Set via PUT /account/me/bio; read back via GET /account/:id/bio. */
	bio?: string
	/** Remaining username changes; decremented by PUT /account/me/username. */
	availableUsernameChanges?: number
	/**
	 * PBKDF2 `salt:hash` for credential login; set via /account/me/changepassword
	 * or create_account. Kept in the JSON blob but never projected into a public
	 * DTO (the DTO builders pick only known fields), so it doesn't leak.
	 */
	passwordHash?: string
	/**
	 * Whether this account holds the developer role (backs GET /role/developer/:id
	 * and the token's `role` claim). Not set by any player-facing flow — only an
	 * operator grants it, via `runx admin grant-developer`. Absent/false means no role.
	 */
	isDeveloper?: boolean
	/**
	 * Whether this account holds the moderator role (backs GET /role/moderator/:id
	 * and the token's `role` claim). Operator-granted only, via
	 * `runx admin grant-moderator`. Absent/false means no role.
	 */
	isModerator?: boolean
	/**
	 * Whether this account holds the influencer role. It rides in the token's `role` claim
	 * (as `influencer`) and puts the account in econ's influencer partner program list
	 * (`GET /api/influencerpartnerprogram/influencers`, via {@link listInfluencerIds}) —
	 * there is no `/role/influencer/:id` lookup. Operator-granted only, via
	 * `runx admin grant-influencer`. Absent/false means no role.
	 */
	isInfluencer?: boolean
	/**
	 * The ONE influencer this account supports in the partner program — the `accountId` of
	 * an account flagged `isInfluencer`, chosen by the player via econ's
	 * `POST /api/influencerpartnerprogram/support` and read back by `…/myinfluencer` (their
	 * own) and `…/influencer?accountId=` (anyone's). Absent means nobody, which those routes
	 * serve as 0. Re-posting replaces the pick; nothing here records the history. Not in any
	 * account DTO: the two econ reads are the only surface.
	 */
	supportedInfluencerId?: number
	/**
	 * Whether this account is a SANDBOX account — served out of the sandbox Tachyon pool
	 * rather than the live one (`match` `GET /player/connection-info`). Operator-set only;
	 * absent/false means the live pool.
	 */
	isSandbox?: boolean
	/**
	 * Whether this account has Rec Room Plus — the paid tier the client's API calls a
	 * `CampusCard`. Nothing SELLS one here. Absent/false means no Plus.
	 *
	 * This flag ALONE is what confers it, and it stands on its own: two things set it, and
	 * neither is a precondition of the other.
	 *
	 *  - the website's benefits claim (`www` `POST /api/benefits/claim`), where a player
	 *    proves a qualifying role in the community Discord. That path also links their
	 *    Discord identity into `platform_account` as a `PlatformType.Discord` row — but the
	 *    link exists to keep the CLAIM once-only per Discord user, not to justify the flag.
	 *  - an operator, via `runx admin grant-plus`, with no Discord anywhere in sight.
	 *
	 * So never read a Discord link as a precondition for Plus, and never revoke one because
	 * the other is missing: a manually granted account has `hasPlus` and no link at all, and
	 * that is a normal, supported state. The one thing that clears it besides an operator is
	 * the player UNLINKING their Discord (`www` `POST /api/benefits/unlink`), which clears
	 * this and `hasStudio` together — the player is handing back the proof — and does so
	 * whoever set them, since nothing on the row says which.
	 *
	 * Nothing reads this per request. `auth` stamps it into every token it mints as the
	 * `rn.plus` claim, and `econ` decides the CampusCard and the subscriber discount from
	 * that claim alone — so setting it takes effect on the account's NEXT login, not
	 * immediately. Tokens last a day and the client never refreshes them, so that lag is
	 * real: the website's claim page warns about it, and so does `grant-plus`.
	 */
	hasPlus?: boolean
	/**
	 * Whether this account has EVER claimed its Discord benefits — had roles recorded on a
	 * `PlatformType.Discord` link by `www`'s `POST /api/benefits/claim` — even if that link is
	 * gone. Set only by the website's Discord UNLINK, when the link it removes carries roles:
	 * while the link exists the link table itself says so (`hasRecordedRoles`), and a link
	 * that never claimed has nothing to remember.
	 *
	 * What it protects is the first-link supporter gift. The claim pays that box the FIRST
	 * time an account links a Discord, deciding "first" from the link table — which, after an
	 * unlink, reads as if the account had never linked. Without this flag, link → unlink →
	 * link would pay the one-time gift on every cycle. Nothing else reads it: `hasPlus` stands
	 * on its own (above), and the once-only-per-Discord-user guard is the link table's.
	 * Absent/false means no claim remembered.
	 */
	hasClaimedDiscord?: boolean
	/**
	 * Whether this account may upload from Rec Room Studio. The editor decides Full access
	 * by reading the token for a `role` claim of exactly `betastudio`, which `auth` stamps
	 * from this flag alone — `developer` does not imply it. Staff set and clear it from the
	 * website (`www` `/settings/recroomstudio`); an operator can too, via
	 * `runx admin grant-studio`. Absent/false means Limited.
	 *
	 * Like the other flags it reaches the editor on the NEXT token: a Studio session already
	 * open keeps its old access until it signs in again or refreshes.
	 */
	hasStudio?: boolean
	/** Staff override for screen sharing. Absent means screen sharing is disabled. */
	hasScreenshare?: boolean
}

interface AccountRow {
	data: string
}

const parseOne = (row: AccountRow | null): Account | null =>
	row ? (JSON.parse(row.data) as Account) : null
const parseAll = (rows: AccountRow[]): Account[] => rows.map((r) => JSON.parse(r.data) as Account)

/** Word lists for auto-assigned usernames (players don't pick one on signup). */
const ADJECTIVES = [
	'Swift',
	'Brave',
	'Clever',
	'Happy',
	'Mighty',
	'Lucky',
	'Sunny',
	'Cosmic',
	'Witty',
	'Nimble',
	'Jolly',
	'Bold',
	'Gentle',
	'Fuzzy',
	'Speedy',
	'Shiny',
]
const NOUNS = [
	'Fox',
	'Otter',
	'Falcon',
	'Panda',
	'Tiger',
	'Comet',
	'Maple',
	'Pixel',
	'Robin',
	'Wolf',
	'Koala',
	'Dragon',
	'Penguin',
	'Badger',
	'Heron',
	'Lynx',
]

/** A random, readable username (e.g. "SwiftFox4821"). */
export function randomUsername(): string {
	const adj = ADJECTIVES[Math.floor(Math.random() * ADJECTIVES.length)]
	const noun = NOUNS[Math.floor(Math.random() * NOUNS.length)]
	const n = Math.floor(Math.random() * 10000)
	return `${adj}${noun}${n}`
}

/**
 * Build a full account object from an id, applying default fallbacks for any
 * column the caller doesn't override. Used both to synthesize accounts that
 * aren't in the DB and as the base for a freshly created account.
 */
export function defaultAccount(id: number, overrides: Partial<Account> = {}): Account {
	return {
		accountId: id,
		username: `Player${id}`,
		displayName: `Player${id}`,
		profileImage: 'DefaultProfileImage.jpg',
		bannerImage: '',
		displayEmoji: '',
		isJunior: false,
		platforms: 0,
		personalPronouns: 0,
		identityFlags: 0,
		createdAt: new Date().toISOString(),
		...overrides,
	}
}

/** Look up a single account by AccountId. */
export async function getAccount(db: D1Database, id: number): Promise<Account | null> {
	return parseOne(
		await db.prepare('SELECT data FROM account WHERE account_id = ?1').bind(id).first<AccountRow>()
	)
}

/** Look up a single account by username (case-insensitive), or null if none. */
export async function getAccountByUsername(
	db: D1Database,
	username: string
): Promise<Account | null> {
	return parseOne(
		await db
			.prepare('SELECT data FROM account WHERE username_lower = ?1')
			.bind(username.toLowerCase())
			.first<AccountRow>()
	)
}

/** Default cap on how many matches `searchAccounts` returns. */
export const SEARCH_LIMIT = 20

/** Escape LIKE wildcards so user input is matched literally (using `\` as the escape char). */
export const escapeLike = (s: string): string => s.replace(/[\\%_]/g, '\\$&')

/**
 * The smallest string that sorts after every string beginning with `prefix` under
 * SQLite's default BINARY (byte-wise) collation: the prefix followed by U+10FFFF, whose
 * UTF-8 encoding (F4 8F BF BF) is the highest valid sequence. The pair
 * `>= prefix AND < prefixUpperBound(prefix)` is the prefix match as a range.
 */
export const prefixUpperBound = (prefix: string): string => `${prefix}\u{10FFFF}`

/**
 * Prefix-search accounts by username (case-insensitive, "begins with"), ordered
 * alphabetically. Returns up to `limit` matches.
 *
 * The prefix is applied as a RANGE on the indexed `username_lower` generated column
 * (`>= name AND < name+U+10FFFF`), not as `LIKE 'name%'`. SQLite only turns a LIKE into
 * an index seek when the LIKE is case-sensitive or the index is NOCASE, and never when
 * it carries an ESCAPE clause, so the LIKE form was a full index scan on every call —
 * 48k rows read per keystroke in the site's search bar, tens of millions a day on D1's
 * meter. The range is a seek (`SEARCH … (username_lower>? AND username_lower<?)`) and
 * walks the index in `ORDER BY` order, so the LIMIT stops it after `limit` rows. The
 * LIKE stays as a residual filter on those rows so the match is exactly "begins with",
 * with the user's `%`/`_` taken literally.
 */
export async function searchAccounts(
	db: D1Database,
	name: string,
	limit = SEARCH_LIMIT
): Promise<Account[]> {
	const q = name.trim().toLowerCase()
	if (q === '') return []
	const { results } = await db
		.prepare(
			`SELECT data FROM account
			 WHERE username_lower >= ?1 AND username_lower < ?2 AND username_lower LIKE ?3 ESCAPE '\\'
			 ORDER BY username_lower LIMIT ?4`
		)
		.bind(q, prefixUpperBound(q), `${escapeLike(q)}%`, limit)
		.all<AccountRow>()
	return parseAll(results)
}

/**
 * Accounts last seen on a given device (the client-supplied `device_id` auth records
 * at login). An empty id yields no matches (avoids matching every account with no
 * device recorded).
 *
 * Reads `deviceId` straight out of the JSON blob, so this is a table scan — no
 * generated column, no migration. Fine at our account count and for the occasional
 * linkup lookup this exists for; if it ever gets hot, promote `deviceId` to an indexed
 * generated column (migration 0004 did that for `platformId`, and 0008 undid it once
 * nothing queried it — that pair is the recipe both ways).
 *
 * The device id is unverified client input, so treat a match as a *hint* (these
 * accounts share a device) and never as proof of identity.
 */
export async function getAccountsByDeviceId(db: D1Database, deviceId: string): Promise<Account[]> {
	if (deviceId === '') return []
	const { results } = await db
		.prepare("SELECT data FROM account WHERE json_extract(data, '$.deviceId') = ?1")
		.bind(deviceId)
		.all<AccountRow>()
	return parseAll(results)
}

/**
 * How many accounts were last seen on a given client device — the count the per-device
 * signup cap ("no more than N accounts per install") is enforced against. Counts the
 * last-seen `deviceId`, the only device the account records (see the field's notes for
 * why that is enough here).
 *
 * An empty id counts 0, as `countAccountsBySignupIp` does for an empty ip: a signup that
 * posts no `device_id` (the website's, for one) can't be attributed to an install, and
 * lumping every such account together would lock out real players.
 *
 * Narrower than an IP — a household shares an address, not an install — but still an
 * unverified client value, so a cap here catches the stock client making accounts, not
 * a script that fabricates ids.
 */
export async function countAccountsByDeviceId(db: D1Database, deviceId: string): Promise<number> {
	if (deviceId === '') return 0
	const row = await db
		.prepare("SELECT COUNT(*) AS n FROM account WHERE json_extract(data, '$.deviceId') = ?1")
		.bind(deviceId)
		.first<{ n: number }>()
	return row?.n ?? 0
}

/** Record the account's most recent successful login time (ISO-8601). */
export async function setLastLoginTime(db: D1Database, id: number, time: string): Promise<void> {
	await db
		.prepare(
			"UPDATE account SET data = json_set(data, '$.lastLoginTime', ?2) WHERE account_id = ?1"
		)
		.bind(id, time)
		.run()
}

/**
 * Record where the account most recently logged in from — its device and client IP.
 * Called on every successful login (not just account creation) so both track the
 * player as they move between devices and networks. Each field is written only when
 * present, so a login that reports no device id doesn't blank the stored one.
 *
 * `signupIp` is deliberately NOT touched here: it records the account's origin and
 * must stay immutable for signup caps to mean anything.
 */
export async function setLoginContext(
	db: D1Database,
	id: number,
	ctx: { deviceId?: string; deviceClass?: number; ip?: string }
): Promise<void> {
	const sets: string[] = []
	const binds: Array<string | number> = []
	if (ctx.deviceId) {
		sets.push(`'$.deviceId', ?${binds.length + 2}`)
		binds.push(ctx.deviceId)
		if (ctx.deviceClass !== undefined) {
			// CAST to INTEGER: D1 binds a JS number as a SQLite REAL, and json_set would then
			// write `"deviceClass":2.0` into the blob rather than `2`.
			sets.push(`'$.deviceClass', CAST(?${binds.length + 2} AS INTEGER)`)
			binds.push(ctx.deviceClass)
		}
	}
	if (ctx.ip) {
		sets.push(`'$.lastLoginIp', ?${binds.length + 2}`)
		binds.push(ctx.ip)
	}
	if (sets.length === 0) return
	await db
		.prepare(`UPDATE account SET data = json_set(data, ${sets.join(', ')}) WHERE account_id = ?1`)
		.bind(id, ...binds)
		.run()
}

/**
 * How many accounts were created from a given client IP — the count a signup cap
 * ("no more than N accounts per IP") is enforced against. Counts `signupIp`, which
 * never changes after creation, NOT `lastLoginIp`.
 *
 * An empty ip counts 0: when Cloudflare gives us no client IP we can't attribute the
 * signup to anyone, and a cap that lumped every unattributed account together would
 * lock out real players.
 *
 * NB: an IP is a coarse identity. Households, NAT, and shared campus/mobile networks
 * put many legitimate players behind one address, so any cap here should be generous
 * and pair with the (much sharper) per-platform-id cap.
 */
export async function countAccountsBySignupIp(db: D1Database, ip: string): Promise<number> {
	if (ip === '') return 0
	const row = await db
		.prepare("SELECT COUNT(*) AS n FROM account WHERE json_extract(data, '$.signupIp') = ?1")
		.bind(ip)
		.first<{ n: number }>()
	return row?.n ?? 0
}

/**
 * Look up multiple accounts by AccountId (order not guaranteed). A list longer than
 * {@link MAX_BOUND_PARAMS} is split across statements and the rows concatenated.
 */
export async function getAccountsByIds(db: D1Database, ids: number[]): Promise<Account[]> {
	if (ids.length === 0) return []
	const pages = await Promise.all(
		chunkForBinds(ids).map((chunk) =>
			db
				.prepare(`SELECT data FROM account WHERE account_id IN (${bindPlaceholders(chunk)})`)
				.bind(...chunk)
				.all<AccountRow>()
		)
	)
	return parseAll(pages.flatMap((page) => page.results))
}

/**
 * The id of every account flagged `isInfluencer`, lowest id first — the whole influencer
 * partner program, which econ serves to every client on launch. Through the `is_influencer`
 * generated column and its partial index (auth migration 0012): the predicate must stay
 * exactly `is_influencer = 1` for the index to apply, and the index holds only those rows,
 * so this never scans the account table. Only the ids are read; the blob is not parsed.
 */
export async function listInfluencerIds(db: D1Database): Promise<number[]> {
	const { results } = await db
		.prepare(`SELECT account_id FROM account WHERE is_influencer = 1 ORDER BY account_id`)
		.all<{ account_id: number }>()
	return results.map((r) => r.account_id)
}

/**
 * Every account flagged `hasStudio`, lowest id first — the website's staff list. A JSON
 * scan rather than a generated column: the list is short and only staff read it.
 */
export async function listStudioAccounts(
	db: D1Database,
	kind: 'studio' | 'avatar' | 'screenshare' | keyof typeof AVATAR_STUDIO_ACCESS = 'studio'
): Promise<Account[]> {
	const mask =
		kind === 'avatar'
			? 7
			: Object.hasOwn(AVATAR_STUDIO_ACCESS, kind)
				? AVATAR_STUDIO_ACCESS[kind as keyof typeof AVATAR_STUDIO_ACCESS]
				: 0
	const { results } = await db
		.prepare(
			mask !== 0
				? `SELECT data FROM account WHERE account_id IN (SELECT account_id FROM avatar_studio_access WHERE (flags & ${mask}) != 0) ORDER BY account_id`
				: kind === 'screenshare'
					? `SELECT data FROM account WHERE json_extract(data, '$.hasScreenshare') = 1 ORDER BY account_id`
					: `SELECT data FROM account WHERE json_extract(data, '$.hasStudio') = 1 ORDER BY account_id`
		)
		.all<AccountRow>()
	return parseAll(results)
}

/**
 * Merge `overrides` into the account row for `id` and persist it. Reads the
 * current account (falling back to a synthesized default), applies the
 * overrides, and writes the whole JSON blob back — inserting the row when the
 * account isn't in the table yet. Returns the updated account.
 */
export async function updateAccount(
	db: D1Database,
	id: number,
	overrides: Partial<Account>
): Promise<Account> {
	const current = (await getAccount(db, id)) ?? defaultAccount(id)
	const updated: Account = { ...current, ...overrides, accountId: id }
	const data = JSON.stringify(updated)
	const res = await db
		.prepare('UPDATE account SET data = ?2 WHERE account_id = ?1')
		.bind(id, data)
		.run()
	if (!res.meta.changes) {
		await db.prepare('INSERT INTO account (data) VALUES (?1)').bind(data).run()
	}
	return updated
}

/**
 * Create and persist a new account. The id is the next free integer (above the
 * seeded system accounts); the username is auto-assigned (players don't choose
 * one initially) and the display name defaults to it.
 */
export async function createAccount(
	db: D1Database,
	overrides: Partial<Account> = {}
): Promise<Account> {
	const row = await db
		.prepare('SELECT COALESCE(MAX(account_id), 1) + 1 AS next FROM account')
		.first<{ next: number }>()
	const id = row?.next ?? 2
	const username = overrides.username ?? randomUsername()
	const account = defaultAccount(id, { username, displayName: username, ...overrides })
	await db.prepare('INSERT INTO account (data) VALUES (?1)').bind(JSON.stringify(account)).run()
	return account
}

/**
 * Read the account's stored password hash (`salt:hash`), or null when the account
 * has none / doesn't exist. Kept in the account JSON blob but out of the public
 * account DTO (which projects only known fields), so it never leaks.
 */
export async function getPasswordHash(db: D1Database, id: number): Promise<string | null> {
	const row = await db
		.prepare(
			"SELECT json_extract(data, '$.passwordHash') AS hash FROM account WHERE account_id = ?1"
		)
		.bind(id)
		.first<{ hash: string | null }>()
	return row?.hash ?? null
}

/**
 * Remove the account's password hash, leaving it with no credential login — which the game
 * reads as "set one", so a player locked out of their password can choose a new one in game.
 * Returns null when no such account exists, else whether it HAD a password to remove.
 */
export async function clearPasswordHash(db: D1Database, id: number): Promise<boolean | null> {
	const row = await db
		.prepare(
			"SELECT json_extract(data, '$.passwordHash') IS NOT NULL AS had FROM account WHERE account_id = ?1"
		)
		.bind(id)
		.first<{ had: number }>()
	if (row === null) return null
	if (row.had) {
		await db
			.prepare(
				"UPDATE account SET data = json_remove(data, '$.passwordHash') WHERE account_id = ?1"
			)
			.bind(id)
			.run()
	}
	return row.had === 1
}

/** Username changes a fresh account starts with (until one has been consumed). */
export const DEFAULT_USERNAME_CHANGES = 3

/**
 * Grant the account one more username change, returning how many it now has — or null when
 * no such account exists. An account that has never changed its name has no stored count and
 * is read as {@link DEFAULT_USERNAME_CHANGES}, so the grant lands on top of that. One UPDATE,
 * so two grants racing each other both count.
 */
export async function addUsernameChange(db: D1Database, id: number): Promise<number | null> {
	const row = await db
		.prepare(
			`UPDATE account SET data = json_set(data, '$.availableUsernameChanges',
				COALESCE(json_extract(data, '$.availableUsernameChanges'), ?2) + 1)
			 WHERE account_id = ?1
			 RETURNING json_extract(data, '$.availableUsernameChanges') AS remaining`
		)
		.bind(id, DEFAULT_USERNAME_CHANGES)
		.first<{ remaining: number }>()
	return row?.remaining ?? null
}

/** Persist the account's password hash. Returns false when no such account exists. */
export async function setPasswordHash(db: D1Database, id: number, hash: string): Promise<boolean> {
	const { meta } = await db
		.prepare("UPDATE account SET data = json_set(data, '$.passwordHash', ?2) WHERE account_id = ?1")
		.bind(id, hash)
		.run()
	return meta.changes > 0
}
