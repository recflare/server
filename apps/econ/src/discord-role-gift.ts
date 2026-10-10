/**
 * The Discord supporter gift, behind the cron in wrangler.jsonc.
 *
 * An operator maps Discord ROLE ids to a token amount — `DISCORD_ROLE_TOKENS`,
 * `<roleId>=<tokens>,<roleId>=<tokens>` — and every time the cron fires, every account
 * holding one of those roles is handed that many RecCenterTokens in a gift box. ONE box per
 * account per run: an account holding several mapped roles — across every Discord link it
 * has — is paid the HIGHEST amount among them, not the sum, so the map reads as tiers
 * however Discord stacks the roles.
 *
 * HOW OFTEN is the cron schedule's business, not this module's: `triggers.crons` in
 * wrangler.jsonc says weekly, and an operator who wants a daily gift changes that line. There
 * is no ledger and no notion of a period here — a run pays everyone it finds, every time, so
 * running it twice pays twice. That is deliberate: the schedule IS the policy, and a hand run
 * is an extra gift on purpose.
 *
 * Which roles an account holds is read from `platform_account.role`, the snapshot the
 * `www` worker's benefits claim writes and its daily role sweep refreshes
 * (apps/www/src/discord-roles.ts). This never asks Discord anything: the roles are as fresh
 * as that sweep, which is why the default schedule fires just after it. A player who has
 * never claimed on the website has no Discord link, and so holds no roles here, however
 * many they hold in the guild.
 *
 * The same box is ALSO handed once, on demand, the first time an account links its Discord
 * (`www`'s benefits claim calls `grantDiscordRoleGift` with the roles it just read), so a
 * supporter who claims the day after a run isn't waiting a whole schedule for their first
 * gift. That is the one grant here with a "first time" to it, and `www` decides it — this
 * module keeps no ledger either way.
 *
 * Each grant is the same three moves econ's other server-handed tokens make (the game
 * reward's tickets, the new-activity bonus): seed the signup grant, credit the balance,
 * then a box that displays the amount — announced with `StorefrontBalanceUpdate` (the
 * RESULTING total; the frame sets the bucket) and `GiftPackageReceivedImmediate`, in that
 * order so the box lands on a balance that already includes it. An offline player meets
 * the box on their next read of `GET /api/avatar/v2/gifts`.
 *
 * Logs via `console`: a cron has no request, so the tagged request logger has nothing to
 * tag (the same reason `www`'s sweep and `match`'s presence sweep do).
 */

import { createGift } from '@repo/domain'
import { PlatformType } from '@repo/domain/src/enums'

import { getLinksForPlatform } from '../../auth/src/platform-db'
import { NotificationType } from '../../notify/src/notification-types'
import {
	ALL_PLATFORMS,
	creditCurrency,
	CurrencyType,
	ensureStartingBalances,
	payTokenGifts,
	TOKEN_GIFT_CHUNK,
} from './balance-db'

import type { GiftContent } from '@repo/domain'
import type {
	BalanceResponsePayload,
	GiftPackagePayload,
} from '../../notify/src/notification-payloads'
import type { PlayerNotification } from '../../notify/src/notifications-hub'
import type { Env } from './context'

/** The system "Coach" account — who a box the server hands over is from. */
const COACH_ACCOUNT_ID = 1

/** The notify worker's hub instance every worker addresses (see econ.app.ts). */
const HUB_INSTANCE = 'global'

/** The message on the box. */
export const DISCORD_ROLE_GIFT_MESSAGE = 'Thanks for supporting the server!'

/**
 * What a grant needs off the bindings: the database, the hub, and the role map. Named as a
 * Pick so `www` — whose `Env` declares the same three — can hand its own bindings to
 * `grantDiscordRoleGift` without pretending to be econ.
 */
export type RoleGiftEnv = Pick<Env, 'DB' | 'RECFLARE_NOTIFICATIONS_HUB' | 'DISCORD_ROLE_TOKENS'>

/** One role's gift, as configured. */
export interface RoleTokens {
	/** The Discord role id — a snowflake, kept as a string (one exceeds 2^53). */
	roleId: string
	/** How many RecCenterTokens the box carries. */
	tokens: number
}

/**
 * Parse `DISCORD_ROLE_TOKENS`: `<roleId>=<tokens>` pairs separated by commas and/or
 * whitespace, e.g. `928457923857943795=2500,2938479238479234=10000`.
 *
 * Tolerant per entry, strict per field: an entry that isn't `digits=positive integer` is
 * reported in `rejected` and skipped rather than failing the whole setting, so one typo
 * costs one role's gift and not everyone's. A role named twice keeps its LAST amount. An
 * empty or unset value parses to no roles, which turns the gift off.
 */
export function parseRoleTokens(raw: string | undefined): {
	roles: RoleTokens[]
	rejected: string[]
} {
	const roles = new Map<string, number>()
	const rejected: string[] = []
	for (const entry of (raw ?? '').split(/[\s,]+/)) {
		if (entry === '') continue
		const match = /^(\d+)=(\d+)$/.exec(entry)
		const tokens = match === null ? NaN : Number(match[2])
		if (match === null || !Number.isSafeInteger(tokens) || tokens <= 0) {
			rejected.push(entry)
			continue
		}
		roles.set(match[1] as string, tokens)
	}
	return {
		roles: [...roles].map(([roleId, tokens]) => ({ roleId, tokens })),
		rejected,
	}
}

/**
 * The role map off the bindings, with every rejected entry logged — once per run for the
 * cron, once per claim for the on-demand grant, which is seldom enough to be a reminder
 * rather than noise. Empty when the gift is off.
 */
function configuredRoles(env: RoleGiftEnv): RoleTokens[] {
	const { roles, rejected } = parseRoleTokens(env.DISCORD_ROLE_TOKENS)
	for (const entry of rejected) {
		console.error(
			`discord role gift: ignoring "${entry}" in DISCORD_ROLE_TOKENS — expected <roleId>=<tokens>`
		)
	}
	return roles
}

/**
 * The gift a set of held roles earns: of the mapped roles among them, the one paying the
 * most — or null when none is mapped. Ties go to whichever is mapped first; they pay the
 * same either way.
 */
export function bestRoleGift(
	held: readonly string[],
	roles: readonly RoleTokens[]
): RoleTokens | null {
	let best: RoleTokens | null = null
	for (const role of roles) {
		if (!held.includes(role.roleId)) continue
		if (best === null || role.tokens > best.tokens) best = role
	}
	return best
}

/** The stored box: tokens from the Coach, nothing else in it. */
function roleGiftContent(tokens: number): GiftContent {
	return {
		FromPlayerId: COACH_ACCOUNT_ID,
		// `Default` (0): a token box renders as it is under this context — the same one the
		// staff token gift uses — and the client shows "cannot display" for contexts it
		// doesn't know how to draw.
		GiftContext: 0,
		ConsumableItemDesc: '',
		ConsumableCount: 0,
		AvatarItemDesc: '',
		// NULL, never 0: the client routes a box on this field before reading the rest, and 0
		// sends it after "avatar item type 0", which fails with "can't find avatar item".
		AvatarItemType: null,
		CurrencyType: CurrencyType.RecCenterTokens,
		Currency: tokens,
		Xp: 0,
		PackageType: 0,
		Message: DISCORD_ROLE_GIFT_MESSAGE,
		EquipmentPrefabName: '',
		EquipmentModificationGuid: '',
		GiftRarity: 0,
		Platform: -1,
		PlatformsToSpawnOn: -1,
		BalanceType: null,
	}
}

/** What a run did, for the log line and the tests. */
export interface RoleGiftSummary {
	/** True when no role is configured and the run did nothing. */
	skipped: boolean
	/** Configured roles the run paid for. */
	roles: number
	/** Discord links whose roles were looked at. */
	links: number
	/** Boxes handed out this run. */
	granted: number
	/** Tokens handed out this run, across every box. */
	tokens: number
	/** Accounts whose grant failed — logged with the account and role to sort out by hand. */
	failed: number
}

/**
 * One run of the gift: every account whose Discord links hold a mapped role is paid its
 * best role's tokens. Batched, as the staff drops are: `payTokenGifts` banks the boxes a
 * few dozen accounts a round, and the frames go out in ONE hub call — grant by grant this
 * was five D1 round trips and two hub calls an account, in series, against a cron
 * invocation's fixed subrequest budget (50 free, 1,000 paid).
 *
 * A round that throws fails every account in it: they are logged, with their roles, and
 * counted in `failed` rather than retried — a retry that ALSO failed partway is how a
 * balance gets credited twice — and the later rounds still run.
 *
 * `startingTokens` is the signup grant to seed before the credit — the credit upserts the
 * balance row, so a never-touched balance would otherwise start from this gift instead of
 * the grant plus this gift.
 *
 * Takes the {@link RoleGiftEnv} pick, not econ's whole `Env`: `www`'s staff panel runs this
 * same function on a button (`POST /api/staff/discord-roles/supporter-gift`) with its own
 * bindings, and the three it reads are declared on both workers.
 */
export async function grantDiscordRoleGifts(
	env: RoleGiftEnv,
	startingTokens: number
): Promise<RoleGiftSummary> {
	const summary: RoleGiftSummary = {
		skipped: false,
		roles: 0,
		links: 0,
		granted: 0,
		tokens: 0,
		failed: 0,
	}

	const roles = configuredRoles(env)
	if (roles.length === 0) {
		console.log('discord role gift: off (no roles in DISCORD_ROLE_TOKENS)')
		return { ...summary, skipped: true }
	}
	summary.roles = roles.length

	const links = await getLinksForPlatform(env.DB, PlatformType.Discord)
	summary.links = links.length

	// One box per ACCOUNT: an account with two Discord links is paid the best role across
	// both, once. Kept in link order (oldest first) so the frames go out in a stable order.
	const best = new Map<number, RoleTokens>()
	for (const link of links) {
		const role = bestRoleGift(link.roles, roles)
		if (role === null) continue
		const held = best.get(link.accountId)
		if (held === undefined || role.tokens > held.tokens) best.set(link.accountId, role)
	}

	const frames: PlayerNotification[] = []
	const due = [...best]
	for (let i = 0; i < due.length; i += TOKEN_GIFT_CHUNK) {
		const round = due.slice(i, i + TOKEN_GIFT_CHUNK)
		try {
			const { paid } = await payTokenGifts(
				env.DB,
				round.map(([accountId, role]) => ({
					accountId,
					amount: role.tokens,
					content: roleGiftContent(role.tokens),
				})),
				startingTokens
			)
			for (const p of paid) {
				summary.granted++
				summary.tokens += p.amount
				frames.push(...giftFrames(p.accountId, p.balance, p.giftId, p.content))
			}
		} catch (err) {
			summary.failed += round.length
			console.error(
				`discord role gift: a round of ${round.length} grant(s) failed (${round
					.map(
						([accountId, role]) => `account ${accountId} role ${role.roleId} ${role.tokens} tokens`
					)
					.join('; ')}): ${err instanceof Error ? err.message : String(err)}`
			)
		}
	}

	if (frames.length > 0) {
		try {
			await env.RECFLARE_NOTIFICATIONS_HUB.getByName(HUB_INSTANCE).notifyPlayers(frames)
		} catch (err) {
			console.error(
				`discord role gift: could not notify ${summary.granted} account(s) of their box: ${err instanceof Error ? err.message : String(err)}`
			)
		}
	}

	console.log(
		`discord role gift: ${summary.roles} role(s) over ${summary.links} discord link(s): ${summary.granted} box(es) for ${summary.tokens} tokens, ${summary.failed} failed`
	)
	return summary
}

/**
 * The on-demand grant: pay ONE account the gift its roles earn right now, exactly as a cron
 * run would — same map, same best-role pick, same box. Returns the role paid, or null when
 * none of `held` is mapped (which includes the map being off), in which case nothing is
 * written. Throws as `grantOne` does, so the caller decides what a half-landed grant means.
 *
 * `www`'s benefits claim calls this with the roles Discord just served, the first time an
 * account links its Discord; whether it IS the first time is the caller's call, since this
 * keeps no ledger. It reads the roles it is handed rather than the stored link so the
 * caller can pay before, after or without writing the row.
 */
export async function grantDiscordRoleGift(
	env: RoleGiftEnv,
	accountId: number,
	held: readonly string[],
	startingTokens: number
): Promise<RoleTokens | null> {
	const role = bestRoleGift(held, configuredRoles(env))
	if (role === null) return null
	await grantOne(env, accountId, role, startingTokens)
	return role
}

/**
 * Pay one account its role's gift: balance, box, then the two frames. The frames are
 * best-effort — the tokens are credited and the box stored before either is sent, and an
 * offline player meets both on their next login.
 */
async function grantOne(
	env: RoleGiftEnv,
	accountId: number,
	role: RoleTokens,
	startingTokens: number
): Promise<void> {
	await ensureStartingBalances(env.DB, accountId, startingTokens)
	const balance = await creditCurrency(
		env.DB,
		accountId,
		CurrencyType.RecCenterTokens,
		role.tokens,
		startingTokens
	)
	const content = roleGiftContent(role.tokens)
	const gift = await createGift(env.DB, accountId, content)

	try {
		await env.RECFLARE_NOTIFICATIONS_HUB.getByName(HUB_INSTANCE).notifyPlayers(
			giftFrames(accountId, balance, gift.id, content)
		)
	} catch (err) {
		console.error(
			`discord role gift: could not notify account ${accountId} of box ${gift.id}: ${err instanceof Error ? err.message : String(err)}`
		)
	}
}

/**
 * The two frames announcing a stored box, in order: the balance first — the RESULTING
 * total, into the one -2 bucket; the frame SETS it — so the box's announcement lands on a
 * total that already includes it.
 */
function giftFrames(
	accountId: number,
	balance: number,
	giftId: number,
	content: GiftContent
): PlayerNotification[] {
	return [
		{
			playerId: accountId,
			notificationType: NotificationType.StorefrontBalanceUpdate,
			data: {
				Balance: balance,
				CurrencyType: CurrencyType.RecCenterTokens,
				Platform: ALL_PLATFORMS,
			} satisfies BalanceResponsePayload,
		},
		{
			playerId: accountId,
			notificationType: NotificationType.GiftPackageReceivedImmediate,
			data: {
				Id: giftId,
				FromPlayerId: COACH_ACCOUNT_ID,
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
			} satisfies GiftPackagePayload,
		},
	]
}
