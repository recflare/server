import {
	AVATAR_STUDIO_ACCESS,
	avatarStudioFlags,
	getAccount,
	getAccountByUsername,
	listStudioAccounts,
	updateAccount,
	writeAuditLog,
} from '@repo/domain'
import { logger } from '@repo/hono-helpers'
import { validateAndGetAccountId } from '@repo/jwt'

import { hasStudioAccess } from '../../auth/src/platform-db'

import type { Context } from 'hono'
import type { Account } from '@repo/domain'
import type { App } from './context'

/**
 * Studio upload access, as the website manages it.
 *
 * RecFlare Studio opens `/settings/recroomstudio` from the dialog that says the
 * account cannot upload. That page reads {@link studioAccessStatusHandler} for
 * the signed-in player. Staff add and remove people through the routes under
 * `/api/staff/studio-access`, behind the same `requireStaff` gate as moderation.
 * The grant is the account's `hasStudio` flag; `auth` stamps `betastudio` from it
 * on the next Studio sign-in or refresh. Who granted what is on `audit_log`. A Discord
 * role in the `STUDIO_ROLLOUT` var grants the same access without the flag
 * (`hasStudioAccess`); the status below reports it, the staff list does not — that list
 * is the accounts staff added by hand.
 */

/** Whether the signed-in player can upload — flag or rollout role. 401 with no session. */
export async function studioAccessStatusHandler(c: Context<App>) {
	const accountId = await validateAndGetAccountId(c.req.raw, await c.env.JWT_SECRET.get())
	if (accountId === null) return c.json({ error: 'Unauthorized' }, 401)
	const account = await getAccount(c.env.DB, accountId)
	const flags = await avatarStudioFlags(c.env.DB, accountId)
	return c.json({
		...Object.fromEntries(
			Object.entries(AVATAR_STUDIO_ACCESS).map(([kind, mask]) => [kind, (flags & mask) === mask])
		),
		granted: await hasStudioAccess(c.env.DB, account, c.env.STUDIO_ROLLOUT),
		avatar: (flags & 7) !== 0,
		screenshare: account?.hasScreenshare === true,
	})
}

type AccessKind = 'studio' | 'avatar' | 'screenshare' | keyof typeof AVATAR_STUDIO_ACCESS
function accessKind(value: unknown): AccessKind | null {
	if (value === undefined) return 'studio'
	if (value === 'studio' || value === 'avatar' || value === 'screenshare') return value
	return typeof value === 'string' && Object.hasOwn(AVATAR_STUDIO_ACCESS, value)
		? (value as AccessKind)
		: null
}
function avatarMask(kind: AccessKind): number {
	return kind === 'avatar'
		? 7
		: Object.hasOwn(AVATAR_STUDIO_ACCESS, kind)
			? AVATAR_STUDIO_ACCESS[kind as keyof typeof AVATAR_STUDIO_ACCESS]
			: 0
}

/** Every account with the flag set. */
export async function listStudioAccessHandler(c: Context<App>) {
	const kind = accessKind(c.req.query('kind'))
	if (!kind) return c.json({ error: 'Unknown access type' }, 400)
	const accounts = await listStudioAccounts(c.env.DB, kind)
	return c.json({
		accounts: accounts.map((account) => ({
			accountId: account.accountId,
			username: account.username,
			displayName: account.displayName,
			enabled: kind !== 'screenshare' || account.hasScreenshare === true,
		})),
	})
}

/**
 * Add a player, by username or account id. Unknown players are a 404 rather than
 * a flag on an account that doesn't exist. A player who already has it keeps it,
 * and the reply says so.
 */
export async function grantStudioAccessHandler(c: Context<App>) {
	const body = await c.req.json().catch(() => null)
	if (body === null || typeof body !== 'object' || Array.isArray(body)) {
		return c.json({ error: 'Expected a JSON body' }, 400)
	}
	const posted = body as { username?: unknown; accountId?: unknown; kind?: unknown }
	const kind = accessKind(posted.kind)
	if (!kind) return c.json({ error: 'Unknown access type' }, 400)
	const username =
		typeof posted.username === 'string' ? posted.username.trim().replace(/^@/, '') : ''
	const accountId = postedAccountId(posted.accountId)

	let account: Account | null = null
	if (username !== '') {
		account = await getAccountByUsername(c.env.DB, username)
		if (!account) return c.json({ error: `No player is called @${username}` }, 404)
		if (accountId !== null && accountId !== account.accountId) {
			return c.json({ error: 'That username and account id are different players' }, 400)
		}
	} else if (accountId !== null) {
		account = await getAccount(c.env.DB, accountId)
		if (!account) return c.json({ error: 'No player has that account id' }, 404)
	} else {
		return c.json({ error: 'Name a player by username or account id' }, 400)
	}

	const alreadyGranted =
		avatarMask(kind) !== 0
			? ((await avatarStudioFlags(c.env.DB, account.accountId)) & avatarMask(kind)) ===
				avatarMask(kind)
			: kind === 'screenshare'
				? account.hasScreenshare === true
				: account.hasStudio === true
	await setAccess(c, account.accountId, kind, true)
	await recordAudit(c, `grant_${kind}_access`, {
		playerId: account.accountId,
		username: account.username,
		alreadyGranted,
	})
	return c.json({
		accountId: account.accountId,
		username: account.username,
		granted: true,
		alreadyGranted,
	})
}

/**
 * Take a player off the list. A player who did not have it answers 200 with
 * `removed: false`, so a double click is not an error. An id that names no
 * account is a 404.
 */
export async function revokeStudioAccessHandler(c: Context<App>) {
	const kind = accessKind(c.req.query('kind'))
	if (!kind) return c.json({ error: 'Unknown access type' }, 400)
	const accountId = Number(c.req.param('id'))
	if (!Number.isInteger(accountId) || accountId <= 0) {
		return c.json({ error: 'A numeric player id is required' }, 400)
	}
	const account = await getAccount(c.env.DB, accountId)
	if (!account) return c.json({ error: 'No player has that account id' }, 404)
	const removed =
		avatarMask(kind) !== 0
			? ((await avatarStudioFlags(c.env.DB, accountId)) & avatarMask(kind)) !== 0
			: kind === 'screenshare'
				? account.hasScreenshare === true
				: account.hasStudio === true
	await setAccess(c, accountId, kind, false)
	await recordAudit(c, `revoke_${kind}_access`, {
		playerId: accountId,
		username: account.username,
		removed,
	})
	return c.json({ accountId, granted: false, removed })
}

async function setAccess(c: Context<App>, accountId: number, kind: AccessKind, enabled: boolean) {
	const mask = avatarMask(kind)
	if (mask !== 0) {
		const now = new Date().toISOString()
		await c.env.DB.prepare(
			`INSERT INTO avatar_studio_access (account_id, flags, created_at, modified_at)
			VALUES (?, ?, ?, ?) ON CONFLICT(account_id) DO UPDATE SET
			flags = ${enabled ? 'flags | ?' : 'flags & ~?'}, modified_at = excluded.modified_at`
		)
			.bind(accountId, enabled ? mask : 0, now, now, mask)
			.run()
	} else {
		await updateAccount(
			c.env.DB,
			accountId,
			kind === 'screenshare' ? { hasScreenshare: enabled } : { hasStudio: enabled }
		)
	}
}

/** A positive integer account id from a JSON field, or null when it isn't one. */
function postedAccountId(value: unknown): number | null {
	if (typeof value === 'number' && Number.isInteger(value) && value > 0) return value
	if (typeof value === 'string' && /^\d+$/.test(value)) {
		const parsed = Number.parseInt(value, 10)
		return parsed > 0 ? parsed : null
	}
	return null
}

/**
 * Record a change on `audit_log`. Written after the change has committed and
 * never throws: the flag has already changed, and a failed insert must not tell
 * the moderator it didn't.
 */
async function recordAudit(
	c: Context<App>,
	action: string,
	data: Record<string, unknown>
): Promise<void> {
	try {
		await writeAuditLog(c.env.DB, { playerId: c.get('staffId'), action, data })
	} catch (err) {
		logger.error('could not write an audit log row', {
			action,
			moderatorId: c.get('staffId'),
			error: err instanceof Error ? err.message : String(err),
		})
	}
}
