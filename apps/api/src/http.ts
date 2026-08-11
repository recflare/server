import { validateAndGetAccountId, validateAndGetRoles } from '@repo/jwt'

import type { Context } from 'hono'
import type { App } from './context'

/**
 * Resolve the account id from a Bearer token, mirroring the repeated
 * auth-header check. Returns `null` when the header is missing,
 * the token is invalid, or the `sub` claim isn't an integer.
 */
export async function authedId(c: Context<App>): Promise<number | null> {
	return validateAndGetAccountId(c.req.raw, await c.env.JWT_SECRET.get())
}

/**
 * The `role` claim from a Bearer token — the operator-granted roles the auth worker
 * stamps from the account's flags (a plain player's token is just `['gameClient']`).
 * `null` when the request carries no valid token, which callers treat as a 401; an
 * empty array means a valid token with no roles. Shaped to mirror {@link authedId}.
 */
export async function authedRoles(c: Context<App>): Promise<string[] | null> {
	return validateAndGetRoles(c.req.raw, await c.env.JWT_SECRET.get())
}

/** Results.Unauthorized() equivalent — 401 with empty body. */
export function unauthorized(c: Context<App>) {
	return c.body(null, 401)
}

/** Reads the `Ids` form field into a list of integer ids. */
export async function parseFormIds(c: Context<App>): Promise<number[]> {
	const body = await c.req.parseBody().catch(() => ({}) as Record<string, unknown>)
	const ids = body.Ids
	if (typeof ids !== 'string') return []
	return ids
		.split(',')
		.map((s) => Number.parseInt(s.trim(), 10))
		.filter((n) => !Number.isNaN(n))
}

/** Read integer ids from repeated `id` query params. The 2023 client passes these to
 * the bulk GET endpoints as one value per id (`?id=1&id=2`), never comma-separated. */
export function queryIds(c: Context<App>): number[] {
	return (
		c.req
			.queries('id')
			?.map((s) => Number.parseInt(s.trim(), 10))
			.filter((n) => !Number.isNaN(n)) ?? []
	)
}
