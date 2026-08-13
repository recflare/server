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

/**
 * Schema DDL — the head schema, i.e. what the table looks like after every migration
 * (0001_accounts + 0002_avatar, sans seed INSERTs; 0004 added a `platform_id` generated
 * column and 0008 dropped it again, so it appears here in neither form).
 */
export const SCHEMA_DDL: string[] = [
	`CREATE TABLE IF NOT EXISTS account (
		data TEXT NOT NULL,
		avatar TEXT,
		account_id INTEGER GENERATED ALWAYS AS (json_extract(data, '$.accountId')) VIRTUAL,
		username_lower TEXT GENERATED ALWAYS AS (lower(json_extract(data, '$.username'))) VIRTUAL
	)`,
	`CREATE UNIQUE INDEX IF NOT EXISTS idx_accounts_account_id ON account (account_id)`,
	`CREATE INDEX IF NOT EXISTS idx_accounts_username_lower ON account (username_lower)`,
]

/** Client-facing account shape (camelCase, exactly as the client's AccountDTO). */
export interface Account {
	accountId: number
	username: string
	displayName: string
	profileImage: string
	/** Profile banner image key. No route sets it yet, so it's `""` on every account. */
	bannerImage: string
	/** The emoji shown beside the display name. No route sets it yet — always `""`. */
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
	 * The client's `device_id` from its most recent login (a stable per-install hash
	 * the client sends on every /connect/token). Not a credential — the client picks
	 * it and nothing verifies it — so never authorize on it alone. Kept so accounts
	 * sharing a device can be found later, e.g. for account linkup.
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
const escapeLike = (s: string): string => s.replace(/[\\%_]/g, '\\$&')

/**
 * Prefix-search accounts by username (case-insensitive, "begins with"), ordered
 * alphabetically. Backed by the indexed `username_lower` generated column, so the
 * `name%` LIKE stays index-friendly. Returns up to `limit` matches.
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
			`SELECT data FROM account WHERE username_lower LIKE ?1 ESCAPE '\\' ORDER BY username_lower LIMIT ?2`
		)
		.bind(`${escapeLike(q)}%`, limit)
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

/** Look up multiple accounts by AccountId (order not guaranteed). */
export async function getAccountsByIds(db: D1Database, ids: number[]): Promise<Account[]> {
	if (ids.length === 0) return []
	const placeholders = ids.map((_, i) => `?${i + 1}`).join(',')
	const { results } = await db
		.prepare(`SELECT data FROM account WHERE account_id IN (${placeholders})`)
		.bind(...ids)
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

/** Persist the account's password hash. Returns false when no such account exists. */
export async function setPasswordHash(db: D1Database, id: number, hash: string): Promise<boolean> {
	const { meta } = await db
		.prepare("UPDATE account SET data = json_set(data, '$.passwordHash', ?2) WHERE account_id = ?1")
		.bind(id, hash)
		.run()
	return meta.changes > 0
}
