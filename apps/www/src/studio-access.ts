import {
	getAccount,
	getAccountByUsername,
	getAccountsByIds,
	grantStudioBetaAccess,
	hasStudioBetaAccess,
	listStudioBetaAccess,
	revokeStudioBetaAccess,
	writeAuditLog,
} from '@repo/domain'
import { logger } from '@repo/hono-helpers'
import { validateAndGetAccountId } from '@repo/jwt'

import type { Context } from 'hono'
import type { Account } from '@repo/domain'
import type { App } from './context'

/**
 * The studio upload whitelist, as the website manages it.
 *
 * RecFlare Studio opens `/settings/recroomstudio` from the dialog that says the
 * account cannot upload. That page reads {@link studioAccessStatusHandler} for
 * the signed-in player. Staff add and remove people through the routes under
 * `/api/staff/studio-access`, behind the same `requireStaff` gate as moderation.
 * The table itself belongs to auth (`studio_beta_access`); a token picks the
 * role up on the next Studio sign-in or refresh.
 */

/** The signed-in player's own row, and nothing else. 401 with no session. */
export async function studioAccessStatusHandler(c: Context<App>) {
	const accountId = await validateAndGetAccountId(c.req.raw, await c.env.JWT_SECRET.get())
	if (accountId === null) return c.json({ error: 'Unauthorized' }, 401)
	return c.json({ granted: await hasStudioBetaAccess(c.env.DB, accountId) })
}

/** Everyone on the whitelist, with the names the account table still has for them. */
export async function listStudioAccessHandler(c: Context<App>) {
	const rows = await listStudioBetaAccess(c.env.DB)
	const ids = [...new Set(rows.flatMap((row) => [row.accountId, row.grantedBy]))]
	const accounts = await getAccountsByIds(c.env.DB, ids)
	const byId = new Map(accounts.map((account) => [account.accountId, account]))
	return c.json({
		accounts: rows.map((row) => ({
			accountId: row.accountId,
			username: byId.get(row.accountId)?.username ?? null,
			displayName: byId.get(row.accountId)?.displayName ?? null,
			grantedBy: row.grantedBy,
			grantedByUsername: byId.get(row.grantedBy)?.username ?? null,
			grantedAt: row.grantedAt,
		})),
	})
}

/**
 * Add a player, by username or account id. Unknown players are a 404 rather than
 * a row pointing at nobody. A player already on the list stays there, with the
 * original grant left as it was.
 */
export async function grantStudioAccessHandler(c: Context<App>) {
	const body = await c.req.json().catch(() => null)
	if (body === null || typeof body !== 'object' || Array.isArray(body)) {
		return c.json({ error: 'Expected a JSON body' }, 400)
	}
	const posted = body as { username?: unknown; accountId?: unknown }
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

	const inserted = await grantStudioBetaAccess(c.env.DB, account.accountId, c.get('staffId'))
	await recordAudit(c, 'grant_studio_access', {
		playerId: account.accountId,
		username: account.username,
		alreadyGranted: !inserted,
	})
	return c.json({
		accountId: account.accountId,
		username: account.username,
		granted: true,
		alreadyGranted: !inserted,
	})
}

/**
 * Take a player off the list. An account that has since been deleted can still
 * be removed — the row is what the token reads, not the account blob. A player
 * who was not on the list answers 200 with `removed: false`, so a double click
 * is not an error. An id that matches neither a row nor an account is a 404.
 */
export async function revokeStudioAccessHandler(c: Context<App>) {
	const accountId = Number(c.req.param('id'))
	if (!Number.isInteger(accountId) || accountId <= 0) {
		return c.json({ error: 'A numeric player id is required' }, 400)
	}
	const account = await getAccount(c.env.DB, accountId)
	const removed = await revokeStudioBetaAccess(c.env.DB, accountId)
	if (!removed && !account) return c.json({ error: 'No player has that account id' }, 404)
	await recordAudit(c, 'revoke_studio_access', {
		playerId: accountId,
		username: account?.username ?? null,
		removed,
	})
	return c.json({ accountId, granted: false, removed })
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
 * Record a whitelist change on `audit_log`. Written after the change has
 * committed and never throws: the row has already changed, and a failed insert
 * must not tell the moderator it didn't.
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
