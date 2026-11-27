import { Hono } from 'hono'
import { describeRoute, openAPIRouteHandler } from 'hono-openapi'
import { useWorkersLogger } from 'workers-tagged-logger'
import { z } from 'zod'

import {
	deleteRoomieKey,
	getRoomieKeyRow,
	hasRoomieKey,
	putRoomieKeyRow,
	resealRoomieKeyRow,
	roomieKeyUpdatedAt,
	takeRateLimit,
} from '@repo/domain'
import { withCleanSpec, withDefaultCors, withNotFound, withOnError } from '@repo/hono-helpers'
import { validateAndGetAccountId, validateAndGetBuild } from '@repo/jwt'

import {
	AUTHED,
	boolQuery,
	GameAiAccessDenied,
	GameAiSpendSummaryDenied,
	HealthResponse,
	idParam,
	intQuery,
	json,
	jsonBody,
	MakerAiAccessResponse,
	MakerAiBalances,
	RealtimeLogsAccepted,
	RealtimeSessionCreateBody,
	RealtimeSessionDenied,
	RealtimeSessionGranted,
	RoomieAiAccess,
	RoomieKeyError,
	RoomieKeyPutBody,
	RoomieKeyStatus,
	RoomieUserFacts,
	UNAUTHORIZED_RESPONSE,
} from './openapi'
import {
	DEFAULT_REALTIME_MODEL,
	isOpenAiKeyShape,
	mintClientSecret,
	openKey,
	parseKeyring,
	sealKey,
} from './roomie-key'

import type { Context } from 'hono'
import type { App } from './context'
import type { Keyring, MintResult } from './roomie-key'

/**
 * AI Worker. Serves the access checks and budget reads the client makes before offering
 * its AI features. Nothing here runs a model, so every answer is static — but not
 * uniformly a refusal, because the features fail differently:
 *
 * - Game AI is a SERVER-side feature. This server cannot provide it, so both its reads are
 *   refused and the client hides the feature.
 * - Roomie's native 2026 companion gets zero energy and no generated output audio;
 *   older clients keep the full budget. The session that would actually reach a model
 *   (`/realtime-session/create`) is where it stops — UNLESS the player has saved their own
 *   OpenAI key, in which case Roomie gets its full budget and the session runs on that key
 *   (see src/roomie-key.ts; the key itself never leaves this worker).
 * - Maker AI meters model usage in dollars. Nothing here bills, so every figure is zero.
 */

/**
 * `int.MaxValue` — the client's energy fields are signed 32-bit ints, so this is the
 * largest budget it can hold. Anything larger (an int64 max, say) overflows on the way in
 * and lands as a negative number, i.e. no energy at all.
 */
const INT32_MAX = 2_147_483_647

/**
 * The reason both Game AI reads refuse with. `AI.RoomDoesNotSupportGameAI` is the id the
 * client renders a message for; the room it names makes no difference, there being no Game
 * AI backend behind any of them.
 */
const GAME_AI_UNSUPPORTED = {
	success: false,
	error_id: 'AI.RoomDoesNotSupportGameAI',
	error: 'This room does not support Rec Room Game AI',
} as const

/**
 * Resolve the account id from a Bearer token (the route is auth-gated).
 * Returns `null` when the header is missing, the token is invalid, or the `sub` claim
 * isn't an integer.
 */
async function authedId(c: Context<App>): Promise<number | null> {
	return validateAndGetAccountId(c.req.raw, await c.env.JWT_SECRET.get())
}

/** Results.Unauthorized() equivalent — 401 with empty body. */
function unauthorized(c: Context<App>) {
	return c.body(null, 401)
}

// ---- Roomie conversation on the player's own OpenAI key -------------------------------
//
// A player who saves an OpenAI API key (website → `PUT /roomieai/key`) gets Roomie's full
// voice conversation: the access check grants it, `realtime-session/create` mints an
// ephemeral OpenAI client secret with the key, and the companion falls back to its no-AI
// mode for everyone else exactly as before. The key itself never leaves this worker — see
// src/roomie-key.ts for how it is sealed and why nothing returns it.

/**
 * The keyring, or null when `ROOMIE_KEY_ENCRYPTION_KEY` is unset or malformed — which turns
 * keyed Roomie off (keys can't be saved, saved ones aren't used) instead of failing requests.
 */
async function keyring(c: Context<App>): Promise<Keyring | null> {
	try {
		return await parseKeyring(await c.env.ROOMIE_KEY_ENCRYPTION_KEY.get())
	} catch {
		return null
	}
}

/** Whether the caller's Roomie runs on their own key: one is on file and can be opened. */
async function hasUsableKey(c: Context<App>, accountId: number): Promise<boolean> {
	return (await keyring(c)) !== null && (await hasRoomieKey(c.env.DB, accountId))
}

/**
 * The caller's OpenAI key, opened, or null when none is on file or it can't be opened (the
 * keyring lost its version, or the row was tampered with). A row sealed under an older
 * keyring version is re-sealed under the current one on the way through, so a rotation
 * completes itself as players use Roomie.
 */
async function openStoredKey(c: Context<App>, accountId: number): Promise<string | null> {
	const ring = await keyring(c)
	if (ring === null) return null
	const row = await getRoomieKeyRow(c.env.DB, accountId)
	if (row === null) return null
	const apiKey = await openKey(ring, accountId, row)
	if (apiKey !== null && row.keyVersion !== ring.current.version) {
		await resealRoomieKeyRow(c.env.DB, accountId, await sealKey(ring, accountId, apiKey))
	}
	return apiKey
}

/** The realtime model session tokens are minted for. */
const realtimeModel = (c: Context<App>) => c.env.ROOMIE_REALTIME_MODEL || DEFAULT_REALTIME_MODEL

/** Sessions one account may open per {@link SESSION_WINDOW_SECONDS}: generous for play, a cap on a loop. */
const SESSION_LIMIT = 60
const SESSION_WINDOW_SECONDS = 60 * 60

/** Key saves one account may attempt per {@link KEY_SAVE_WINDOW_SECONDS}; each one calls OpenAI. */
const KEY_SAVE_LIMIT = 10
const KEY_SAVE_WINDOW_SECONDS = 60 * 60

/** The full Roomie energy budget, in the access envelope. */
const ROOMIE_GRANTED = {
	success: true,
	error_id: null,
	error: null,
	value: {
		MaxEnergyFromSubscriptions: INT32_MAX,
		EnergyLeft: INT32_MAX,
		NextSubscriptionEnergyRechargeAt: null,
		OutputAudioEnabled: true,
	},
} as const

/**
 * The caller's Roomie access envelope. With their own key: the full budget, whatever the
 * build. Without one, the 20260323 build (every point release of it) gets the recognized
 * no-credit result and zero energy for its native companion mode, and older builds keep the
 * full budget they have always been sent.
 */
async function roomieAccess(c: Context<App>, accountId: number) {
	if (await hasUsableKey(c, accountId)) return ROOMIE_GRANTED
	const build = await validateAndGetBuild(c.req.raw, await c.env.JWT_SECRET.get())
	if (build === '20260323') {
		return {
			success: false,
			error_id: 'AI.InsufficientRoomieAICreditNoSub',
			error: 'AI conversation is disabled. Roomie companion mode is available.',
			value: {
				MaxEnergyFromSubscriptions: 0,
				EnergyLeft: 0,
				OutputAudioEnabled: false,
			},
		}
	}
	return ROOMIE_GRANTED
}

/** The realtime-session refusal: a 200 with `success: false`, an empty `error_id`, no value. */
const sessionRefusal = (error: string) => ({ success: false, error, error_id: '', value: null })

/** What the player is told when OpenAI turned a key down, by why. */
const MINT_REFUSALS: Record<Exclude<MintResult, { ok: true }>['reason'], string> = {
	rejected: 'OpenAI rejected your API key. Update it on your RecFlare account page.',
	forbidden: 'Your OpenAI API key is not allowed to use the Realtime API. Check its permissions.',
	unavailable: 'OpenAI could not be reached. Please try again later.',
}

const app = new Hono<App>()
	.use(
		'*',
		// middleware
		(c, next) =>
			useWorkersLogger(c.env.NAME, {
				environment: c.env.ENVIRONMENT,
				release: c.env.SENTRY_RELEASE,
			})(c, next)
	)

	.onError(withOnError())
	.notFound(withNotFound())

	// Root health check.
	.get(
		'/',
		describeRoute({
			tags: ['Service'],
			summary: 'Health check',
			description: 'Liveness probe for the ai worker. No auth.',
			responses: { 200: json(HealthResponse, 'Service is up') },
		}),
		(c) => c.json({ service: 'ai', status: 'ok' })
	)

	// Whether the caller may use Game AI in a room. Always refused: no Game AI backend
	// exists here, so the honest answer for every room is that it doesn't support it.
	.get(
		'/gameai/user/access',
		describeRoute({
			tags: ['Game AI', '2025'],
			summary: 'May the caller use Game AI here?',
			description: [
				'Asked before the client offers any Game AI feature in a room. This server hosts no',
				'Game AI, so it always refuses — with a 200 carrying `success: false`, NOT an HTTP',
				'error: the client branches on the body, and an error status would read as a failed',
				'request rather than the “not available here” state this is. `AI.RoomDoesNotSupportGameAI`',
				'is the reason the client renders.',
				'',
				'`roomId` is accepted and ignored — the answer is the same for every room, and the',
				'refusal is per-room by nature, so the client asks again for the next one. The token',
				'is still validated first, as the reference does.',
			].join(' '),
			security: AUTHED,
			parameters: [intQuery('roomId', 'The room the client is asking about. Ignored.')],
			responses: {
				200: json(GameAiAccessDenied, 'Always a refusal'),
				401: UNAUTHORIZED_RESPONSE,
			},
		}),
		async (c) => {
			const id = await authedId(c)
			if (id === null) return unauthorized(c)

			return c.json(GAME_AI_UNSUPPORTED)
		}
	)

	// What a room has spent on Game AI. Refused for the same reason as the access check
	// above, but note the body differs: this one carries an explicit `value: null`.
	.get(
		'/gameai/room/:roomId{[0-9]+}/spendsummary',
		describeRoute({
			tags: ['Game AI', '2025'],
			summary: 'A room’s Game AI spend summary',
			description: [
				'What a room has spent of its Game AI budget. Refused with the same 200-plus-',
				'`success: false` body as the access check, since a room that cannot use Game AI has',
				'no spend to summarise.',
				'',
				'The body is NOT identical to the access check’s: it carries `value: null` where that',
				'one omits the key entirely. The access check answers a yes/no and has nothing to',
				'carry; this endpoint’s payload slot exists and is empty. Reproduced as the reference',
				'server sends it — don’t unify the two.',
			].join(' '),
			security: AUTHED,
			parameters: [idParam('roomId', 'The room being asked about. Ignored.')],
			responses: {
				200: json(GameAiSpendSummaryDenied, 'Always a refusal'),
				401: UNAUTHORIZED_RESPONSE,
			},
		}),
		async (c) => {
			const id = await authedId(c)
			if (id === null) return unauthorized(c)

			return c.json({ ...GAME_AI_UNSUPPORTED, value: null })
		}
	)

	// The 20260323 build (20260323.14) has native low-energy and no-energy companion support. Advertising
	// full energy selects a conversation backend — so it is advertised only to a player who
	// has saved their own OpenAI key, whose sessions run on it. Everyone else on that build
	// gets zero energy and the client's recognized no-credit result, which keeps the
	// companion working without AI. Preserve the older client's budget and recharge-field
	// contract. This one answer is what every Roomie gate in the client reads (the access
	// cache, the Roomie menu, the backpack entry, the tool's "no Roomie access in this room").
	.get(
		'/roomieai/user/access',
		describeRoute({
			tags: ['Roomie AI', '2025'],
			summary: 'The caller’s Roomie AI energy budget',
			description: [
				'With an OpenAI key saved on the caller’s account, the full int32-max budget with',
				'output audio on, whatever the build: Roomie conversation runs on that key. Without',
				'one, the 20260323 build receives the recognized no-credit result and zero energy for',
				'its native companion mode, and older clients retain the full budget and null',
				'recharge time.',
				'',
				'The envelope is `{ success, error_id, error, value }`, NOT the flat body the Game AI',
				'check answers with. The two are different shapes on purpose — don’t unify them.',
			].join(' '),
			security: AUTHED,
			responses: {
				200: json(RoomieAiAccess, 'Conversation access, or the build-specific companion fallback'),
				401: UNAUTHORIZED_RESPONSE,
			},
		}),
		async (c) => {
			const id = await authedId(c)
			if (id === null) return unauthorized(c)

			return c.json(await roomieAccess(c, id))
		}
	)

	// What a conversation has spent, posted while one runs; the client reads the energy
	// budget back from the answer. Nothing here meters energy, so the answer is the access
	// check's — and a 404 here would end the conversation as out of energy.
	.post(
		'/roomieai/session/spend',
		describeRoute({
			tags: ['Roomie AI', '2026'],
			summary: 'Report a Roomie conversation’s spend',
			description: [
				'Posted during a Roomie conversation with what it has used; the client reads the',
				'remaining budget from the reply. Nothing on this server meters energy, so the body',
				'is ignored and the answer is the same envelope `GET /roomieai/user/access` serves.',
			].join(' '),
			security: AUTHED,
			responses: {
				200: json(RoomieAiAccess, 'The caller’s (unchanged) budget'),
				401: UNAUTHORIZED_RESPONSE,
			},
		}),
		async (c) => {
			const id = await authedId(c)
			if (id === null) return unauthorized(c)

			return c.json(await roomieAccess(c, id))
		}
	)

	// What Roomie has been told about the caller. Nothing observes players here, so it has
	// been told nothing.
	.get(
		'/roomieai/user/facts',
		describeRoute({
			tags: ['Roomie AI', '2025'],
			summary: 'What Roomie knows about the caller',
			description: [
				'The memory Roomie is primed with: `UserContext`, a prose profile written from past',
				'conversations, and `UserFacts`, the discrete `(Predicate, Object)` claims behind it —',
				'live, these are things the player told Roomie about themselves.',
				'',
				'Both are empty here. Nothing on this server observes a conversation, so there is',
				'nothing to remember, and Roomie starts every session knowing nothing about who it is',
				'talking to. A flat body, like the Maker AI balances and unlike the access check',
				'above.',
			].join(' '),
			security: AUTHED,
			responses: {
				200: json(RoomieUserFacts, 'An empty profile — always'),
				401: UNAUTHORIZED_RESPONSE,
			},
		}),
		async (c) => {
			const id = await authedId(c)
			if (id === null) return unauthorized(c)

			return c.json({ UserContext: '', UserFacts: [] })
		}
	)

	// Whether the caller may use Maker AI at all. Granted, like the Roomie budget reads and
	// unlike the Game AI checks: this is a gate, not a model call, and refusing it hides the
	// feature outright. (The balances below are still zeroed: the client reads its usage
	// meter separately, and a server that bills nothing has spent nothing.)
	//
	// The envelope is its own shape again — PascalCase `Success`/`Error` beside a snake_case
	// `error_id`, which is neither the Game AI refusal's all-lowercase body nor the Roomie
	// check's `{ success, error_id, error, value }`. Reproduced as the reference sends it;
	// the mixed casing is not a typo to tidy up.
	.get(
		'/makerai/user/access',
		describeRoute({
			tags: ['Maker AI', '2025'],
			summary: 'May the caller use Maker AI?',
			description: [
				'Asked before the client offers Maker AI. Always granted — the gate is about',
				'entitlement, not capacity, and nothing here meters what Maker AI would cost.',
				'',
				'The envelope carries PascalCase `Success`/`Error` next to a snake_case `error_id`,',
				'which matches neither neighbour on this worker. That mix is what the reference sends;',
				'it is not an inconsistency to clean up.',
				'',
				'`roomInstanceSpecificCheck` (the client sends .NET’s `True`/`False`) is accepted and',
				'ignored: it asks whether the check is about the instance the player is standing in',
				'rather than the account, and the answer is the same either way. The token is still',
				'validated first.',
			].join(' '),
			security: AUTHED,
			parameters: [
				boolQuery(
					'roomInstanceSpecificCheck',
					'Whether to check the current room instance rather than the account. Ignored.'
				),
			],
			responses: {
				200: json(MakerAiAccessResponse, 'Always granted'),
				401: UNAUTHORIZED_RESPONSE,
			},
		}),
		async (c) => {
			const id = await authedId(c)
			if (id === null) return unauthorized(c)

			return c.json({ Success: true, Error: null, error_id: null })
		}
	)

	// Maker AI's dollar balances. Zeroed rather than refused: the client reads these to
	// render a usage meter, and a server that bills nothing has spent nothing.
	.get(
		'/makerai/user/balances',
		describeRoute({
			tags: ['Maker AI', '2025'],
			summary: 'The caller’s Maker AI usage balances',
			description: [
				'What Maker AI has cost the caller. Live, these meter model usage in DOLLARS against',
				'a per-user ceiling and a separate RR+ allowance, and the client renders them as a',
				'usage bar with a status word.',
				'',
				'Nothing here bills for model usage, so every figure is zero and both usage buckets',
				'report `Good` — an untouched allowance, not an exhausted one. The time bucket is',
				'`Empty` with `TimeExpiresAt` at `DateTime.MinValue`, this server selling no timed',
				'access for it to hold.',
				'',
				'A flat body — no `{ success, error, value }` envelope, unlike the Roomie access check.',
			].join(' '),
			security: AUTHED,
			responses: {
				200: json(MakerAiBalances, 'All zero — nothing is metered here'),
				401: UNAUTHORIZED_RESPONSE,
			},
		}),
		async (c) => {
			const id = await authedId(c)
			if (id === null) return unauthorized(c)

			return c.json({
				UsageDollars: 0,
				UsersMaxUsageDollars: 0,
				RRPlusUsageDollars: 0,
				UsersMaxRRPlusUsageDollars: 0,
				TimeBalanceStatus: 'Empty',
				TimeExpiresAt: '0001-01-01T00:00:00',
				UsageBalanceStatus: 'Good',
				UsagePercent: 0,
				RRPlusUsageBalanceStatus: 'Good',
				RRPlusUsagePercent: 0,
			})
		}
	)

	// Opening a live voice session with an assistant — the one call here that reaches a real
	// model. Served only on the caller's own OpenAI key, and even then the key is not what is
	// handed out: an ephemeral client secret minted with it is.
	.post(
		'/realtime-session/create',
		describeRoute({
			tags: ['Roomie AI', '2025'],
			summary: 'Open a realtime AI session',
			description: [
				'Posted when the player actually pulls out an assistant. The CLIENT talks to OpenAI',
				'Realtime directly, with the `ClientSecret` this answers in `value` alongside a',
				'`SessionId`.',
				'',
				'Granted only when the caller has saved their own OpenAI API key (`PUT',
				'/roomieai/key`): the secret is an EPHEMERAL one minted with that key, good for',
				'opening a session for a few minutes — never the key itself, which nothing returns.',
				'Sessions are capped per account per hour.',
				'',
				'Otherwise refused, as a 200 with `success: false`, an `error_id` that is an EMPTY',
				'STRING rather than a code (the reference server sends no id for this one), and a',
				'null `value`. The same shape carries the reason when OpenAI turns the key down.',
			].join(' '),
			security: AUTHED,
			requestBody: jsonBody(
				RealtimeSessionCreateBody,
				'Which assistant is being opened. Not read — the answer is the same either way.'
			),
			responses: {
				200: json(
					z.union([RealtimeSessionGranted, RealtimeSessionDenied]),
					'A session secret minted with the caller’s key, or a refusal'
				),
				401: UNAUTHORIZED_RESPONSE,
			},
		}),
		async (c) => {
			const id = await authedId(c)
			if (id === null) return unauthorized(c)

			if (!(await hasUsableKey(c, id))) {
				return c.json(sessionRefusal('Realtime AI sessions are not available on this server'))
			}
			const { allowed } = await takeRateLimit(
				c.env.DB,
				`roomie_session:${id}`,
				SESSION_LIMIT,
				SESSION_WINDOW_SECONDS
			)
			if (!allowed) {
				return c.json(sessionRefusal('Roomie has been started too often. Please try again later.'))
			}
			const apiKey = await openStoredKey(c, id)
			if (apiKey === null) {
				return c.json(
					sessionRefusal(
						'Your saved OpenAI API key could not be read. Save it again on your account page.'
					)
				)
			}
			const minted = await mintClientSecret(c.env.OPENAI, apiKey, realtimeModel(c))
			if (!minted.ok) return c.json(sessionRefusal(MINT_REFUSALS[minted.reason]))

			return c.json({
				success: true,
				error_id: null,
				error: null,
				value: {
					SessionId: minted.sessionId ?? crypto.randomUUID(),
					ClientSecret: minted.clientSecret,
				},
			})
		}
	)

	// The client's diagnostics for a session it opened, posted once it is running. Nothing
	// here collects them; accepted so the client doesn't read a 404 as the session failing
	// ("RoomieAI is currently unavailable").
	.post(
		'/realtime-session/logs',
		describeRoute({
			tags: ['Roomie AI', '2026'],
			summary: 'Accept a realtime session’s client logs',
			description: [
				'Posted by the client about a realtime session it has opened. Nothing on this server',
				'collects them, so the body is neither read nor stored; the success envelope is what',
				'keeps the client from treating the session as failed.',
			].join(' '),
			security: AUTHED,
			responses: {
				200: json(RealtimeLogsAccepted, 'Accepted (and discarded)'),
				401: UNAUTHORIZED_RESPONSE,
			},
		}),
		async (c) => {
			const id = await authedId(c)
			if (id === null) return unauthorized(c)

			return c.json({ success: true, error_id: null, error: null })
		}
	)

	// The player's own OpenAI key, from the website (which calls this worker directly, as it
	// does the others). WRITE-ONLY: these routes set, remove and say whether a key is on file —
	// none returns the key, or any part of it.
	.use('/roomieai/key', withDefaultCors())
	.get(
		'/roomieai/key',
		describeRoute({
			tags: ['Roomie AI', 'Website'],
			summary: 'Whether the caller has an OpenAI key saved for Roomie',
			description: [
				'Whether a key is on file and when it was saved — never the key, or any part of it:',
				'a saved key cannot be read back by anyone. `available` is false when this server',
				'has keyed Roomie switched off (no ROOMIE_KEY_ENCRYPTION_KEY), in which case a key',
				'can be neither saved nor used.',
			].join(' '),
			security: AUTHED,
			responses: {
				200: json(RoomieKeyStatus, 'The key’s status'),
				401: UNAUTHORIZED_RESPONSE,
			},
		}),
		async (c) => {
			const id = await authedId(c)
			if (id === null) return unauthorized(c)

			const updatedAt = await roomieKeyUpdatedAt(c.env.DB, id)
			return c.json({
				available: (await keyring(c)) !== null,
				configured: updatedAt !== null,
				updatedAt: updatedAt === null ? null : new Date(updatedAt * 1000).toISOString(),
			})
		}
	)
	.put(
		'/roomieai/key',
		describeRoute({
			tags: ['Roomie AI', 'Website'],
			summary: 'Save (or replace) the caller’s OpenAI key for Roomie',
			description: [
				'Body `{ apiKey }`: an OpenAI API key (`sk-…`). It is first CHECKED with OpenAI — one',
				'free call that mints a Realtime session token, exactly the permission Roomie needs —',
				'and refused if OpenAI turns it down, so a mistyped or revoked key fails here rather',
				'than in game. Then it is sealed (AES-256-GCM, bound to the account) and stored. The',
				'key is never echoed, logged or returned; the reply is the same status `GET` serves.',
				'Attempts are capped per account per hour, each one calling OpenAI.',
			].join(' '),
			security: AUTHED,
			requestBody: jsonBody(RoomieKeyPutBody, 'The key to save'),
			responses: {
				200: json(RoomieKeyStatus, 'Saved'),
				400: json(RoomieKeyError, 'Not an OpenAI key, or OpenAI refused it'),
				401: UNAUTHORIZED_RESPONSE,
				429: json(RoomieKeyError, 'Too many attempts; try again later'),
				502: json(RoomieKeyError, 'OpenAI could not be reached to check the key'),
				503: json(RoomieKeyError, 'Keyed Roomie is switched off on this server'),
			},
		}),
		async (c) => {
			const id = await authedId(c)
			if (id === null) return unauthorized(c)

			const ring = await keyring(c)
			if (ring === null) {
				return c.json({ error: 'Roomie API keys are not enabled on this server.' }, 503)
			}
			const body = (await c.req.json().catch(() => null)) as { apiKey?: unknown } | null
			const apiKey = typeof body?.apiKey === 'string' ? body.apiKey.trim() : null
			if (!isOpenAiKeyShape(apiKey)) {
				return c.json(
					{ error: 'That doesn’t look like an OpenAI API key (they start with “sk-”).' },
					400
				)
			}
			const { allowed } = await takeRateLimit(
				c.env.DB,
				`roomie_key_save:${id}`,
				KEY_SAVE_LIMIT,
				KEY_SAVE_WINDOW_SECONDS
			)
			if (!allowed) return c.json({ error: 'Too many attempts. Please try again in an hour.' }, 429)

			const check = await mintClientSecret(c.env.OPENAI, apiKey, realtimeModel(c))
			if (!check.ok) {
				if (check.reason === 'unavailable') {
					return c.json(
						{ error: 'OpenAI could not be reached to check the key. Please try again.' },
						502
					)
				}
				return c.json(
					{
						error:
							check.reason === 'rejected'
								? 'OpenAI rejected this key. Check that it was copied whole and is still active.'
								: 'This key is not allowed to use the Realtime API. Give it that permission, or use another key.',
					},
					400
				)
			}

			const now = Math.floor(Date.now() / 1000)
			await putRoomieKeyRow(c.env.DB, id, await sealKey(ring, id, apiKey), now)
			return c.json({
				available: true,
				configured: true,
				updatedAt: new Date(now * 1000).toISOString(),
			})
		}
	)
	.delete(
		'/roomieai/key',
		describeRoute({
			tags: ['Roomie AI', 'Website'],
			summary: 'Remove the caller’s OpenAI key',
			description: [
				'Forgets the caller’s saved key; Roomie returns to its companion mode on their next',
				'session. Idempotent: removing a key that isn’t there answers the same. To stop a key',
				'that may have leaked from working anywhere, also revoke it on OpenAI’s dashboard.',
			].join(' '),
			security: AUTHED,
			responses: {
				200: json(RoomieKeyStatus, 'Removed'),
				401: UNAUTHORIZED_RESPONSE,
			},
		}),
		async (c) => {
			const id = await authedId(c)
			if (id === null) return unauthorized(c)

			await deleteRoomieKey(c.env.DB, id)
			return c.json({ available: (await keyring(c)) !== null, configured: false, updatedAt: null })
		}
	)

// The generated spec. Documentation only — no request is validated against it (see
// openapi.ts). `hide: true` keeps this route out of its own output.
app.get(
	'/openapi.json',
	describeRoute({ hide: true }),
	withCleanSpec(
		openAPIRouteHandler(app, {
			documentation: {
				info: {
					title: 'recflare ai',
					version: '1.0.0',
					description: [
						'The AI service for recflare, a private-server reimplementation of the Rec Room',
						'backend. The client checks here before offering any of its AI features: Game AI in a',
						'room, the Roomie assistant, and Maker AI’s usage meter.',
						'',
						'No model runs behind this worker, so every answer is static — but they are not all',
						'refusals, because the features fail at different points. Game AI is a server-side',
						'feature this server cannot provide, so both its reads refuse. Roomie and Maker AI',
						'only ask what the caller may SPEND, which nothing here meters, so those reads are',
						'granted with a build-specific budget; conversation refuses on `POST /realtime-session/create`, the',
						'one call whose real answer is a working credential rather than a description of one.',
						'',
						'The exception is a player who has saved their own OpenAI API key (`PUT /roomieai/key`,',
						'from the website). Their Roomie gets its full budget, and the realtime session runs',
						'on an ephemeral secret minted with that key. Keys are write-only: sealed at rest, and',
						'returned by nothing.',
						'',
						'The refusals are 200s carrying `success: false`, which is the shape the client',
						'branches on — the worker exists so the client gets a definite answer on the host its',
						'endpoints document names, instead of a failed request.',
					].join('\n'),
				},
				servers: [{ url: 'https://ai.recflare.net', description: 'Production' }],
				components: {
					securitySchemes: {
						bearerAuth: {
							type: 'http',
							scheme: 'bearer',
							bearerFormat: 'JWT',
							description: 'An `access_token` from the auth worker’s `POST /connect/token`.',
						},
					},
				},
			},
		})
	)
)

export default app
