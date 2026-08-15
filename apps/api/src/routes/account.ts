import { Hono } from 'hono'
import { describeRoute } from 'hono-openapi'

import { json, JsonArray, stringParam } from '../openapi'

import type { App } from '../context'

// ---- Account ---------------------------------------------------------------
// The identity service's account-scoped reads. Nothing here is backed by storage — the
// client calls it while loading the account, and an empty list is a complete answer for a
// server that links no external channels to an account.
export const accountRoutes = new Hono<App>({ strict: false }).get(
	'/iam/me/channels/:type',
	describeRoute({
		tags: ['Account'],
		summary: 'The caller’s channels of a type',
		description:
			'The channels of the given `{type}` linked to the caller’s account. This server ' +
			'links none, so the list is always empty — a real answer rather than a placeholder ' +
			'for one, since the client renders "nothing linked" from it. `{type}` is accepted ' +
			'but not inspected, and the route is not auth-gated: the answer is the same for ' +
			'every caller and every type.',
		parameters: [stringParam('type', 'The channel type. Accepted but not inspected.')],
		responses: { 200: json(JsonArray, 'Always an empty list') },
	}),
	(c) => c.json([])
)
