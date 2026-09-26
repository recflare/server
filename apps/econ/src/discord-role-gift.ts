/**
 * The Discord supporter gift, behind the cron in wrangler.jsonc.
 *
 * An operator maps Discord ROLE ids to a token amount — `DISCORD_ROLE_TOKENS`,
 * `<roleId>=<tokens>,<roleId>=<tokens>` — and every time the cron fires, every account
 * holding one of those roles is handed that many RecCenterTokens in a gift box. ONE box per
 * account per run: an account holding several mapped roles is paid the HIGHEST amount among
 * them, not the sum, so the map reads as tiers however Discord stacks the roles.
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
import { ALL_PLATFORMS, creditCurrency, CurrencyType, ensureStartingBalances } from './balance-db'

import type { GiftContent } from '@repo/domain'
import type { PlatformLink } from '../../auth/src/platform-db'
import type {
	BalanceResponsePayload,
	GiftPackagePayload,
} from '../../notify/src/notification-payloads'
import type { Env } from './context'

/** The system "Coach" account — who a box the server hands over is from. */
const COACH_ACCOUNT_ID = 1

/** The notify worker's hub instance every worker addresses (see econ.app.ts). */
const HUB_INSTANCE = 'global'

/** The message on the box. */
export const DISCORD_ROLE_GIFT_MESSAGE = 'Thanks for supporting the server!'

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
 * The gift a link earns: of the mapped roles it holds, the one paying the most — or null
 * when it holds none. Ties go to whichever is mapped first; they pay the same either way.
 */
export function bestRoleGift(link: PlatformLink, roles: readonly RoleTokens[]): RoleTokens | null {
	let best: RoleTokens | null = null
	for (const role of roles) {
		if (!link.roles.includes(role.roleId)) continue
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
	/** Grants that failed partway — logged with the account and role to sort out by hand. */
	failed: number
}

/**
 * One run of the gift: every Discord link holding a mapped role is paid its best role's
 * tokens. Sequential: each grant is a handful of D1 writes and two hub calls, and a cron
 * invocation has a fixed subrequest budget (50 free, 1000 paid) — a community whose
 * supporters outgrow that is the point to batch it, not before.
 *
 * `startingTokens` is the signup grant to seed before the credit — `creditCurrency` upserts
 * the balance row, so a never-touched balance would otherwise start from this gift instead
 * of the grant plus this gift.
 */
export async function grantDiscordRoleGifts(
	env: Env,
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

	const { roles, rejected } = parseRoleTokens(env.DISCORD_ROLE_TOKENS)
	for (const entry of rejected) {
		console.error(
			`discord role gift: ignoring "${entry}" in DISCORD_ROLE_TOKENS — expected <roleId>=<tokens>`
		)
	}
	if (roles.length === 0) {
		console.log('discord role gift: off (no roles in DISCORD_ROLE_TOKENS)')
		return { ...summary, skipped: true }
	}
	summary.roles = roles.length

	const links = await getLinksForPlatform(env.DB, PlatformType.Discord)
	summary.links = links.length

	for (const link of links) {
		const role = bestRoleGift(link, roles)
		if (role === null) continue
		try {
			await grantOne(env, link, role, startingTokens)
			summary.granted++
			summary.tokens += role.tokens
		} catch (err) {
			// Logged with everything needed to check what did land rather than retried: a
			// retry that ALSO failed partway is how a balance gets credited twice.
			summary.failed++
			console.error(
				`discord role gift: account ${link.accountId}'s grant for role ${role.roleId} (${role.tokens} tokens) failed: ${err instanceof Error ? err.message : String(err)}`
			)
		}
	}

	console.log(
		`discord role gift: ${summary.roles} role(s) over ${summary.links} discord link(s): ${summary.granted} box(es) for ${summary.tokens} tokens, ${summary.failed} failed`
	)
	return summary
}

/**
 * Pay one account its role's gift: balance, box, then the two frames. The frames are
 * best-effort — the tokens are credited and the box stored before either is sent, and an
 * offline player meets both on their next login.
 */
async function grantOne(
	env: Env,
	link: PlatformLink,
	role: RoleTokens,
	startingTokens: number
): Promise<void> {
	await ensureStartingBalances(env.DB, link.accountId, startingTokens)
	const balance = await creditCurrency(
		env.DB,
		link.accountId,
		CurrencyType.RecCenterTokens,
		role.tokens,
		startingTokens
	)
	const content = roleGiftContent(role.tokens)
	const gift = await createGift(env.DB, link.accountId, content)

	const hub = env.RECFLARE_NOTIFICATIONS_HUB.getByName(HUB_INSTANCE)
	try {
		// The balance first, so the box's announcement lands on a total that includes it.
		// `Balance` is the RESULTING total, into the one -2 bucket: the frame SETS it.
		await hub.notifyPlayer(link.accountId, NotificationType.StorefrontBalanceUpdate, {
			Balance: balance,
			CurrencyType: CurrencyType.RecCenterTokens,
			Platform: ALL_PLATFORMS,
		} satisfies BalanceResponsePayload)
		await hub.notifyPlayer(link.accountId, NotificationType.GiftPackageReceivedImmediate, {
			Id: gift.id,
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
		} satisfies GiftPackagePayload)
	} catch (err) {
		console.error(
			`discord role gift: could not notify account ${link.accountId} of box ${gift.id}: ${err instanceof Error ? err.message : String(err)}`
		)
	}
}
