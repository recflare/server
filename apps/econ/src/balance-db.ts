import { BalancePlatform } from '../../notify/src/notification-payloads'

/**
 * Currency balances on the shared `recflare` D1 database.
 *
 * One row per (account, currency) pair rather than a JSON blob on the account: a
 * balance is a number we increment, decrement and compare, and the spend path has to
 * be atomic. `UPDATE ... WHERE amount >= ?` on a real column gives us that in one
 * statement; a read-modify-write of a JSON blob would race and let a player spend the
 * same tokens twice from two concurrent requests.
 *
 * This worker (`econ`) owns the table and its migration — see apps/econ/migrations/
 * 0001_balance.sql, applied with its own `migrations_table` (d1_migrations_econ) so
 * it doesn't clash with the auth/rooms migration histories on the same database.
 */

/**
 * The currencies the client knows about (its `CurrencyType` enum, obfuscated
 * `GKPEKOLBBJL` — which lists every member below except `RoomInventoryItem`). The client sends
 * these ints in the balance/storefront paths — `/api/storefronts/v4/balance/2` is
 * RecCenterTokens — so the values are fixed by the client, not by us.
 *
 * What each one is:
 *  - `Invalid` (0): the enum's zero value. Never a real balance; a request for it is
 *    a client bug or a probe, and `isSpendable` rejects it.
 *  - `LaserTagTickets` (1): earned in the Laser Tag activity, spent in its own store.
 *  - `RecCenterTokens` (2): THE general-purpose currency — what players mean by
 *    "tokens", earned everywhere and spent in the avatar/gift-drop storefronts. This
 *    is the only one the client fetches on load, and the only one we grant at signup.
 *  - `LostSkullsGold` (100) / `DraculaSilver` (101): per-activity currencies for the
 *    Isle of Lost Skulls and Rise of Jumbo quests. Earned and spent inside those
 *    activities only.
 *  - `RecRoyaleSeason1` (200): a season currency for Rec Royale; legacy, no live faucet.
 *  - `RoomCurrency` (300) / `RoomInventoryItem` (301): NOT global balances. These are
 *    scoped to a specific room and served by the `/api/roomcurrencies/*` and
 *    `/api/roomconsumables/*` endpoints, whose rows are keyed by room as well as by
 *    account. They must never be stored in this (account, currency) table — a single
 *    row here couldn't say WHICH room's currency it is, so a player's coins in one
 *    room would spend in every other. `isSpendable` rejects them for that reason.
 *  - `ProgressionEvent` (400): an XP/progression counter the client models as a
 *    currency. Not spendable.
 */
export const CurrencyType = {
	Invalid: 0,
	LaserTagTickets: 1,
	RecCenterTokens: 2,
	LostSkullsGold: 100,
	DraculaSilver: 101,
	RecRoyaleSeason1: 200,
	RoomCurrency: 300,
	RoomInventoryItem: 301,
	ProgressionEvent: 400,
} as const

export type CurrencyTypeValue = (typeof CurrencyType)[keyof typeof CurrencyType]

/**
 * The account-scoped currencies this table stores. Everything else in `CurrencyType`
 * is either not a balance (Invalid, ProgressionEvent) or is room-scoped and belongs to
 * the room-currency endpoints (RoomCurrency, RoomInventoryItem) — see the enum doc.
 */
const SPENDABLE: readonly number[] = [
	CurrencyType.LaserTagTickets,
	CurrencyType.RecCenterTokens,
	CurrencyType.LostSkullsGold,
	CurrencyType.DraculaSilver,
	CurrencyType.RecRoyaleSeason1,
]

/** Whether a currency is an account-scoped balance this table may hold. */
export const isSpendable = (currencyType: number): boolean => SPENDABLE.includes(currencyType)

/**
 * The signup grant, in RecCenterTokens, when the `STARTING_TOKENS` var is unset.
 * An operator overrides it in wrangler.jsonc `vars`; 0 is a valid setting and means
 * players start broke.
 */
export const DEFAULT_STARTING_TOKENS = 10_000

/**
 * What a player starts with, granted lazily the first time their balances are touched
 * (see `ensureStartingBalances`). Currencies absent here start at 0.
 *
 * This is the whole signup grant. It is NOT re-granted: a player who spends down to 0
 * keeps a 0 row, and the grant is skipped because the row exists. That also means
 * raising `STARTING_TOKENS` later only affects players who haven't been granted yet —
 * existing players keep the amount they were granted under the old setting.
 */
export function startingBalances(
	startingTokens: number
): ReadonlyArray<{ currencyType: number; amount: number }> {
	return [{ currencyType: CurrencyType.RecCenterTokens, amount: startingTokens }]
}

/**
 * The ONE balance bucket this server uses: `NonPurchasedNotUsableInP2P` (-2).
 *
 * The client keys a balance by `(CurrencyType, Platform)` and shows the SUM of the buckets,
 * so which Platform a balance is reported under is not cosmetic — it is the bucket's
 * identity. Everything we hand out is minted rather than bought, and we track no
 * per-platform wallets (real RecNet did, for tokens paid for on each store), so one
 * account-wide bucket per currency answers for all of them.
 *
 * Every surface that names the bucket must name THIS one: the balance DTO's `Platform`, the
 * `BalanceType` the storefront HTTP bodies echo, and the `Platform` on every
 * `StorefrontBalance*` socket frame. Naming a second one there invents a balance the client
 * adds to the real total — see the frame rule in econ.app.ts.
 *
 * The enum itself lives in the notify worker's `notification-payloads.ts`, recovered from
 * the client's decoder, rather than being duplicated here.
 */
export const ALL_PLATFORMS: BalancePlatform = BalancePlatform.NonPurchasedNotUsableInP2P

/** Schema DDL (mirror of migrations 0001_balance.sql) — also used to build the table in tests. */
export const BALANCE_SCHEMA_DDL: string[] = [
	`CREATE TABLE IF NOT EXISTS balance (
		account_id INTEGER NOT NULL,
		currency_type INTEGER NOT NULL,
		amount INTEGER NOT NULL DEFAULT 0,
		PRIMARY KEY (account_id, currency_type)
	)`,
]

export interface Balance {
	currencyType: number
	amount: number
}

/**
 * Grant the signup balances to an account that hasn't been granted yet. INSERT OR
 * IGNORE against the (account_id, currency_type) primary key, so an account that
 * already has a row for a currency keeps its amount — including a 0 it spent down to.
 * That's what stops this from re-granting tokens on every read.
 *
 * Called on read rather than at account creation so accounts that predate this table
 * (every existing player) get their grant too.
 *
 * `startingTokens` is passed in rather than read from a module constant because it's
 * operator configuration (`STARTING_TOKENS`), and every path that can trigger the grant
 * has to agree on it — a caller that skipped it would quietly grant the built-in default
 * to whichever player happened to touch that path first.
 */
export async function ensureStartingBalances(
	db: D1Database,
	accountId: number,
	startingTokens: number
): Promise<void> {
	const stmt = db.prepare(
		'INSERT OR IGNORE INTO balance (account_id, currency_type, amount) VALUES (?1, ?2, ?3)'
	)
	await db.batch(
		startingBalances(startingTokens).map((b) => stmt.bind(accountId, b.currencyType, b.amount))
	)
}

/** Every balance an account holds (after its starting grant is applied). */
export async function getBalances(
	db: D1Database,
	accountId: number,
	startingTokens: number
): Promise<Balance[]> {
	await ensureStartingBalances(db, accountId, startingTokens)
	const { results } = await db
		.prepare(
			'SELECT currency_type, amount FROM balance WHERE account_id = ?1 ORDER BY currency_type'
		)
		.bind(accountId)
		.all<{ currency_type: number; amount: number }>()
	return results.map((r) => ({ currencyType: r.currency_type, amount: r.amount }))
}

/** An account's balance in one currency; 0 when they hold none. */
export async function getBalance(
	db: D1Database,
	accountId: number,
	currencyType: number,
	startingTokens: number
): Promise<number> {
	await ensureStartingBalances(db, accountId, startingTokens)
	const row = await db
		.prepare('SELECT amount FROM balance WHERE account_id = ?1 AND currency_type = ?2')
		.bind(accountId, currencyType)
		.first<{ amount: number }>()
	return row?.amount ?? 0
}

/**
 * Add `amount` to a balance (a faucet: rewards, gifts, refunds), creating the row when
 * the account has none. Returns the new balance.
 *
 * `amount` must be positive — spending goes through `spendCurrency`, which is the only
 * path that checks funds. A negative amount here would silently overdraw.
 */
export async function creditCurrency(
	db: D1Database,
	accountId: number,
	currencyType: number,
	amount: number,
	startingTokens: number
): Promise<number> {
	if (!Number.isInteger(amount) || amount <= 0) {
		throw new Error(`creditCurrency: amount must be a positive integer, got ${amount}`)
	}
	await db
		.prepare(
			`INSERT INTO balance (account_id, currency_type, amount) VALUES (?1, ?2, ?3)
			 ON CONFLICT (account_id, currency_type) DO UPDATE SET amount = amount + ?3`
		)
		.bind(accountId, currencyType, amount)
		.run()
	return getBalance(db, accountId, currencyType, startingTokens)
}

/**
 * Spend `amount` of a currency. Returns false — changing nothing — when the account
 * can't afford it.
 *
 * The `amount >= ?3` guard lives in the UPDATE itself, so the check and the debit are
 * one atomic statement: two concurrent spends of the same tokens can't both see a
 * sufficient balance and both succeed. Never split this into a read-then-write.
 */
export async function spendCurrency(
	db: D1Database,
	accountId: number,
	currencyType: number,
	amount: number,
	startingTokens: number
): Promise<boolean> {
	if (!Number.isInteger(amount) || amount <= 0) {
		throw new Error(`spendCurrency: amount must be a positive integer, got ${amount}`)
	}
	await ensureStartingBalances(db, accountId, startingTokens)
	const { meta } = await db
		.prepare(
			`UPDATE balance SET amount = amount - ?3
			 WHERE account_id = ?1 AND currency_type = ?2 AND amount >= ?3`
		)
		.bind(accountId, currencyType, amount)
		.run()
	return meta.changes > 0
}
