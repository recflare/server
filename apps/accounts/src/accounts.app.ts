import { Hono } from 'hono'
import { describeRoute, openAPIRouteHandler, validator } from 'hono-openapi'
import { useWorkersLogger } from 'workers-tagged-logger'

import {
	beginEmailCode,
	cancelEmailCode,
	completeEmailCode,
	createAccount,
	DEFAULT_USERNAME_CHANGES,
	defaultAccount,
	EMAIL_CODE_TTL_SECONDS,
	emailSender,
	getAccount,
	getAccountByEmail,
	getAccountByUsername,
	getAccountsByIds,
	pendingEmailCode,
	SEARCH_LIMIT,
	searchAccounts,
	updateAccount,
} from '@repo/domain'
import {
	logger,
	withCleanSpec,
	withDefaultCors,
	withNotFound,
	withOnError,
} from '@repo/hono-helpers'
import { validateAndGetAccountId } from '@repo/jwt'

// The notification-type ids the hub carries (owned by the `notify` worker). Imported as a
// value — the enum has no runtime dependencies.
import { NotificationType } from '../../notify/src/notification-types'
import { buildEndpoints } from '../../ns/src/endpoints'
import { emailChangeEmail } from './email-change-email'
import {
	AccountDto,
	BannerImageRequest,
	BioRequest,
	BioResponse,
	BulkIdsRequest,
	CreateAccountRequest,
	CreateAccountResult,
	DisplayNameRequest,
	EmailConfirmRequest,
	EmailConfirmResponse,
	EmailRefusal,
	EmailRequest,
	EmojiRequest,
	form,
	HealthResponse,
	IdentityFlagsRequest,
	json,
	ParentalControl,
	PendingEmailResponse,
	PhoneRequest,
	PrivacySettings,
	ProfileImageRequest,
	PronounsRequest,
	SelfAccountDto,
	SuccessResponse,
	UsernameRequest,
	UsernameResult,
	WhitelistedEmojis,
} from './openapi'
import { resolveWhitelistedEmoji, WHITELISTED_EMOJIS } from './whitelisted-emojis'

import type { Context } from 'hono'
import type { DescribeRouteOptions } from 'hono-openapi'
import type { Account, EmailCodeIssue } from '@repo/domain'
import type { App } from './context'

/**
 * Account reads/writes are backed by the shared `accounts` table in D1 (schema
 * owned by the `auth` worker). Accounts not in the table fall back to a
 * synthesized default (every column has a fallback anyway). Profile mutations
 * persist to the account row and push an AccountUpdate through the notifications
 * hub (see `pushAccountUpdate`).
 *
 * Auth-gated routes validate the Bearer JWT issued by the `auth` worker.
 */

/**
 * Resolve the account id from a Bearer token, mirroring the repeated
 * auth-header check. Returns `null` when the header is missing,
 * the token is invalid, or the `sub` claim isn't an integer.
 */
async function authedId(c: Context<App>): Promise<number | null> {
	return validateAndGetAccountId(c.req.raw, await c.env.JWT_SECRET.get())
}

/** Results.Unauthorized() equivalent — 401 with empty body. */
function unauthorized(c: Context<App>) {
	return c.body(null, 401)
}

/**
 * Username-change result envelope: `{ success, error, value }`, always HTTP 200.
 * On success `value` is the updated account; on error `error` carries the message
 * and `value` is an empty string.
 *
 * The envelope-at-200 is the reference's (`RecNet`) convention — a refusal is a
 * successful call that answers "no", and the player-facing sentence rides in `error`.
 * `POST /account/create` does the same. This was briefly a 400 so a caller could branch
 * on the status; it isn't, because that's not what the real service does.
 */
function usernameResult(c: Context<App>, error = '', value: unknown = '') {
	return c.json({ success: error === '', error, value })
}

/** Read a single string field from a form-urlencoded / multipart body. */
async function formField(c: Context<App>, name: string): Promise<string> {
	const body = await c.req.parseBody().catch(() => ({}) as Record<string, unknown>)
	const value = body[name]
	return typeof value === 'string' ? value : ''
}

/**
 * Read a REPEATED string field from a form-urlencoded / multipart body (`id=1&id=2`).
 * `parseBody` keeps only the last value for a duplicated key unless it's told to collect
 * them all, which is the whole point here.
 */
async function formFields(c: Context<App>, name: string): Promise<string[]> {
	const body = await c.req.parseBody({ all: true }).catch(() => ({}) as Record<string, unknown>)
	const value = body[name]
	const values = Array.isArray(value) ? value : [value]
	return values.filter((v): v is string => typeof v === 'string')
}

/**
 * OpenAPI spec for the two `/account/bulk` registrations, which differ only in where the
 * ids ride.
 */
function bulkRouteSpec(source: 'query' | 'body'): DescribeRouteOptions {
	return {
		tags: ['Lookup'],
		summary: 'Look up many accounts by id',
		description: [
			'Accepts repeated `id` values (query params and/or a form-urlencoded body) and',
			'comma-separated lists. Every requested id appears in the response — ids with no',
			'stored row get a synthesized default.',
		].join(' '),
		...(source === 'query'
			? {
					parameters: [
						{
							name: 'id',
							in: 'query',
							required: false,
							description: 'Repeatable; each value may be a comma-separated list of ids',
							schema: { type: 'array', items: { type: 'string' } },
						},
					],
				}
			: { requestBody: form(BulkIdsRequest, 'Repeated `id` fields') }),
		responses: { 200: json(AccountDto.array(), 'One public account per requested id') },
	}
}

/**
 * Look up many accounts at once. Ids come from repeated `id` query params AND, on the
 * POST form, repeated `id` body fields; either may carry a comma-separated list. Deduped
 * (first occurrence wins) so a repeated id can't double a row or waste a bound parameter.
 */
async function bulkAccounts(c: Context<App>) {
	const raw = [...(c.req.queries('id') ?? []), ...(await formFields(c, 'id'))]
	const ids = [
		...new Set(
			raw
				.flatMap((v) => v.split(','))
				.map((v) => Number.parseInt(v.trim(), 10))
				.filter((n) => !Number.isNaN(n))
		),
	]
	// Resolve stored accounts, synthesizing a default for any id not in the DB
	// so every requested id is present in the response.
	const stored = new Map((await getAccountsByIds(c.env.DB, ids)).map((a) => [a.accountId, a]))
	return c.json(ids.map((id) => toAccountDto(stored.get(id) ?? defaultAccount(id))))
}

/**
 * Project a stored account into the public account DTO — the client's camelCase
 * shape, excluding private fields like `email` (surfaced only by /account/me).
 */
function toAccountDto(account: Account) {
	return {
		accountId: account.accountId,
		username: account.username,
		displayName: account.displayName,
		profileImage: account.profileImage,
		// Rows stored before these fields existed have neither key — always emit them as
		// "" rather than letting them go missing.
		bannerImage: account.bannerImage ?? '',
		displayEmoji: account.displayEmoji ?? '',
		isJunior: account.isJunior,
		platforms: account.platforms,
		personalPronouns: account.personalPronouns,
		identityFlags: account.identityFlags,
		createdAt: account.createdAt,
	}
}

/**
 * Project a stored account into the private self DTO (the /account/me shape) —
 * the public DTO plus owner-only fields. `juniorState`/`parentAccountId` are
 * OMITTED when null (emitting `null` makes the client's enum parser throw).
 *
 * An unset `email` is `""`, never null — same as `bio`. Two reasons: the client reads
 * it as a string, and this DTO also rides the `SelfAccountUpdate` hub frame, where the
 * hub DROPS null values from `Msg` — so a null email doesn't arrive as null, it
 * vanishes from the frame entirely.
 */
function toSelfAccountDto(account: Account) {
	return {
		...toAccountDto(account),
		email: account.email ?? '',
		// @todo he game client needs this to be set. I forget how birthdays were set, so for now
		// everyone can be old.
		birthday: '1904-01-01T00:00:00.000Z',
		availableUsernameChanges: account.availableUsernameChanges ?? DEFAULT_USERNAME_CHANGES,
	}
}

/** The notifications hub is a single global DO instance (see the `notify` worker). */
const HUB_INSTANCE = 'global'

/**
 * Push the notifications that follow an account mutation, mirroring the reference
 * hub behavior: the owner receives `SelfAccountUpdate` and `AccountUpdate`, and
 * every connected client receives an `AccountUpdate` broadcast. Hub failures are
 * logged and swallowed — the account write has already committed, so a hub
 * hiccup must not fail the request.
 */
async function pushAccountUpdate(c: Context<App>, account: Account): Promise<void> {
	try {
		const hub = c.env.RECFLARE_NOTIFICATIONS_HUB.getByName(HUB_INSTANCE)
		const publicDto = toAccountDto(account)
		await hub.notifyPlayer(
			account.accountId,
			NotificationType.SubscriptionUpdateSelfProfile,
			toSelfAccountDto(account)
		)
		await hub.notifyPlayer(account.accountId, NotificationType.SubscriptionUpdateProfile, publicDto)
		await hub.broadcast(NotificationType.SubscriptionUpdateProfile, publicDto)
	} catch (err) {
		logger.error('failed to push account update notifications', {
			accountId: account.accountId,
			error: err instanceof Error ? err.message : String(err),
		})
	}
}

/** The empty-body 401 every auth-gated route returns; reused across their specs. */
const UNAUTHORIZED_RESPONSE = { description: 'Missing or invalid bearer token (empty body)' }

/** What the email routes say when the address is already on another account. */
const EMAIL_TAKEN = 'That email address is already on another account.'

/** What `POST /account/me/email/confirm` says to any code that doesn't take. */
const EMAIL_CODE_WRONG =
	'That code is wrong or has expired. Save the address again to be sent a new one.'

/** What the email routes say to a repeat within the cooldown. */
const EMAIL_TOO_SOON =
	'A code was emailed less than two minutes ago. Enter that one, or try again in a minute.'

/** What the email routes say once the account's codes for the day are spent. */
const EMAIL_QUOTA =
	'Too many codes have been emailed for this account today. Please try again tomorrow.'

/** The refusal for a code that was not issued, by why. */
const emailCodeRefusal = (refused: 'cooldown' | 'quota') => ({
	success: false,
	error: refused === 'cooldown' ? EMAIL_TOO_SOON : EMAIL_QUOTA,
})

/** What the email routes say when the mail service refused the send. */
const EMAIL_NOT_SENT = 'The confirmation email could not be sent. Please try again later.'

/** The account's current address, or null when it has none (absent or empty). */
const currentEmail = (account: Account | null): string | null => account?.email?.trim() || null

/**
 * Send one of the email-change codes. False when the mail service refused it, in which case
 * the code is dropped (cooldown included) — nothing went out, so nothing to wait on, and the
 * player can try again at once. The usual cause is the sender's domain not being enabled for
 * Email Sending (DEPLOYING.md): an operator's problem, hence the log.
 */
async function sendEmailCode(
	c: Context<App>,
	input: {
		purpose: 'email_change' | 'email_verify'
		to: string
		code: string
		newEmail: string
		currentEmail: string | null
	}
): Promise<boolean> {
	const id = (await authedId(c))!
	const message = emailChangeEmail({
		to: input.to,
		from: emailSender(c.env),
		domain: c.env.DOMAIN,
		www: buildEndpoints(c.env.DOMAIN, c.env.SUBDOMAINS).WWW,
		code: input.code,
		newEmail: input.newEmail,
		// Step 2's letter reads as "confirm this address" whether or not there is a current
		// one: by then the current address has had its say.
		currentEmail: input.purpose === 'email_change' ? input.currentEmail : null,
		validMinutes: Math.round(EMAIL_CODE_TTL_SECONDS / 60),
	})
	try {
		await c.env.EMAIL.send(message)
	} catch (err) {
		await cancelEmailCode(c.env.DB, input.purpose, id)
		logger.error('could not send the email-change code', {
			accountId: id,
			purpose: input.purpose,
			error: err instanceof Error ? err.message : String(err),
		})
		return false
	}
	logger.info('email-change code sent', { accountId: id, purpose: input.purpose })
	return true
}

/** What `GET /account/me/email/pending` serves: the live step, if any. */
async function pendingEmailChange(
	c: Context<App>,
	id: number
): Promise<{ pending: string | null; sentTo: string | null }> {
	const verify = await pendingEmailCode(c.env.DB, 'email_verify', id)
	if (verify?.payload) return { pending: verify.payload, sentTo: verify.payload }
	const change = await pendingEmailCode(c.env.DB, 'email_change', id)
	if (change?.payload) {
		const current = currentEmail(await getAccount(c.env.DB, id))
		return { pending: change.payload, sentTo: current ?? change.payload }
	}
	return { pending: null, sentTo: null }
}

/**
 * Whether a D1 error is the `idx_account_email_lower` UNIQUE index refusing a second holder
 * of an address — two saves racing past the lookup. D1 surfaces SQLite's message verbatim.
 */
function isUniqueEmailViolation(err: unknown): boolean {
	const message = err instanceof Error ? err.message : String(err)
	return message.includes('UNIQUE constraint failed') && message.includes('email_lower')
}

/** Bearer-JWT security requirement, for the auth-gated routes. */
const AUTHED = [{ bearerAuth: [] }]

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

	// The website (`www`) is a browser origin calling these endpoints directly, the way
	// rec.net's own site called the game's API — so the responses need CORS headers or
	// the browser discards them. `origin: '*'` is deliberate and safe HERE because these
	// endpoints authenticate with a bearer token in the `Authorization` header, never a
	// cookie: a hostile page can't read another origin's stored token, so there is no
	// ambient credential for `*` to expose. Do not add cookie auth without narrowing it.
	.use('*', withDefaultCors())

	.onError(withOnError())
	.notFound(withNotFound())

	// Root health check.
	.get(
		'/',
		describeRoute({
			tags: ['Meta'],
			summary: 'Health check',
			responses: { 200: json(HealthResponse, 'Service is up') },
		}),
		(c) => c.json({ service: 'accounts', status: 'ok' })
	)

	// ---- Emoji config --------------------------------------------------------
	// The picker the client fills its displayEmoji grid from. A BARE array — no
	// `{ success, error, value }` envelope and no wrapper object; the client parses the
	// response body itself as the list.
	.get(
		'/emojiConfig/whitelistedEmojis',
		describeRoute({
			tags: ['Config'],
			summary: 'Emoji a player may use as their displayEmoji',
			description: [
				'A bare JSON array of emoji, in the order the client draws them. Static — not',
				'auth-gated, and identical for every player.',
			].join(' '),
			responses: { 200: json(WhitelistedEmojis, 'The whitelisted emoji, in picker order') },
		}),
		(c) => c.json(WHITELISTED_EMOJIS)
	)

	// ---- Self account --------------------------------------------------------
	.get(
		'/account/me',
		describeRoute({
			tags: ['Self'],
			summary: 'The caller’s own account',
			description: [
				'The private self DTO, including owner-only fields (email, remaining username',
				'changes). An account with no stored row falls back to a synthesized default.',
			].join(' '),
			security: AUTHED,
			responses: {
				200: json(SelfAccountDto, 'The caller’s account'),
				401: UNAUTHORIZED_RESPONSE,
			},
		}),
		async (c) => {
			const id = await authedId(c)
			if (id === null) return unauthorized(c)
			// Load the stored account, falling back to a synthesized default.
			const account = (await getAccount(c.env.DB, id)) ?? defaultAccount(id)
			return c.json(toSelfAccountDto(account))
		}
	)

	// ---- Search --------------------------------------------------------------
	// Prefix-search accounts by username (`?name=`). Returns a bare array of public
	// account DTOs, ordered alphabetically. Registered before `/account/:id` so the
	// static `search` path wins over the param route.
	.get(
		'/account/search',
		describeRoute({
			tags: ['Lookup'],
			summary: 'Prefix-search accounts by username',
			description: 'Case-insensitive prefix match on username, ordered alphabetically.',
			parameters: [
				{
					name: 'name',
					in: 'query',
					required: false,
					description: 'Username prefix; empty matches nothing meaningful',
					schema: { type: 'string' },
				},
				{
					name: 'take',
					in: 'query',
					required: false,
					description: `How many to return (default and max ${SEARCH_LIMIT}); fewer reads fewer rows`,
					schema: { type: 'integer' },
				},
			],
			responses: { 200: json(AccountDto.array(), 'Matching public accounts') },
		}),
		async (c) => {
			const name = c.req.query('name') ?? ''
			// The seek stops at the LIMIT, so a caller that draws five (the site's header
			// search) is billed five rows rather than the default twenty.
			const take = Number.parseInt(c.req.query('take') ?? '', 10)
			const limit = Number.isNaN(take) ? SEARCH_LIMIT : Math.max(1, Math.min(take, SEARCH_LIMIT))
			const accounts = await searchAccounts(c.env.DB, name, limit)
			return c.json(accounts.map(toAccountDto))
		}
	)

	// Exact lookup by username — what the site's `/user/<name>` profile pages and the staff
	// `@username` fields resolve a player through. An indexed equality on `username_lower`;
	// before this existed they went through the prefix search above and filtered the
	// exact hit client-side, which cost a 20-row index walk per profile view. Same path
	// as the official API's `GET /account/username/{username}`.
	.get(
		'/account/username/:name',
		describeRoute({
			tags: ['Lookup'],
			summary: 'A single public account, by exact username',
			description:
				'Case-insensitive exact match; a leading `@` is ignored. 404 when no account has the name.',
			parameters: [
				{
					name: 'name',
					in: 'path',
					required: true,
					description: 'The username, exactly (case-insensitive)',
					schema: { type: 'string' },
				},
			],
			responses: {
				200: json(AccountDto, 'The public account'),
				404: { description: 'No account has that username' },
			},
		}),
		async (c) => {
			const name = c.req.param('name').trim().replace(/^@/, '')
			const account = name === '' ? null : await getAccountByUsername(c.env.DB, name)
			if (!account) return c.json({ error: `There's no player called @${name}.` }, 404)
			return c.json(toAccountDto(account))
		}
	)

	// ---- Bulk / single lookup ------------------------------------------------
	// Register the static `bulk` path before the `/account/:id` param route.
	.get('/account/bulk', describeRoute(bulkRouteSpec('query')), bulkAccounts)
	// The 2023 client asks for its friends list as a POST with the ids in a
	// form-urlencoded body — the same `id=1&id=2&…` it would put in a query string,
	// moved off the URL because a few hundred friends overflow it. GET is the same
	// lookup and stays for callers (and docs) that prefer it.
	.post('/account/bulk', describeRoute(bulkRouteSpec('body')), bulkAccounts)

	.get(
		'/account/:id/bio',
		describeRoute({
			tags: ['Lookup'],
			summary: 'A player’s bio',
			parameters: [
				{
					name: 'id',
					in: 'path',
					required: true,
					description: 'Account id; non-numeric is 400',
					schema: { type: 'string' },
				},
			],
			responses: {
				200: json(BioResponse, 'The bio (empty string when unset)'),
				400: { description: 'Non-numeric id (empty body)' },
			},
		}),
		async (c) => {
			const accountId = Number.parseInt(c.req.param('id'), 10)
			if (Number.isNaN(accountId)) return c.body(null, 400)
			// Bio is stored on the account JSON (set via PUT /account/me/bio).
			const account = await getAccount(c.env.DB, accountId)
			return c.json({ accountId, bio: account?.bio ?? '' })
		}
	)

	.get(
		'/account/:id',
		describeRoute({
			tags: ['Lookup'],
			summary: 'A single public account',
			description: 'An id with no stored row falls back to a synthesized default account.',
			parameters: [
				{
					name: 'id',
					in: 'path',
					required: true,
					description: 'Account id; non-numeric is 400',
					schema: { type: 'string' },
				},
			],
			responses: {
				200: json(AccountDto, 'The public account'),
				400: { description: 'Non-numeric id (empty body)' },
			},
		}),
		async (c) => {
			const accountId = Number.parseInt(c.req.param('id'), 10)
			if (Number.isNaN(accountId)) return c.body(null, 400)
			// Load the stored account, falling back to a synthesized default.
			return c.json(
				toAccountDto((await getAccount(c.env.DB, accountId)) ?? defaultAccount(accountId))
			)
		}
	)

	// ---- Create --------------------------------------------------------------
	.post(
		'/account/create',
		describeRoute({
			tags: ['Self'],
			summary: 'Create an account',
			description: [
				'Mints a new account with an auto-assigned random username (players don’t choose',
				'one initially). Not auth-gated. `platformId` is parsed but not yet persisted.',
			].join(' '),
			requestBody: form(CreateAccountRequest, 'Platform fields'),
			responses: { 200: json(CreateAccountResult, 'The created account, in a result envelope') },
		}),
		async (c) => {
			// Parsed for fidelity; unused until there's a DB to persist CachedLogins.
			const platform = await formField(c, 'platform')
			await formField(c, 'platformId')

			// Persist a new account with an auto-assigned random username (players
			// don't choose one initially).
			const platforms = Number.parseInt(platform, 10)
			const account = await createAccount(c.env.DB, {
				platforms: Number.isNaN(platforms) ? 0 : platforms,
			})
			// TODO: also create a dorm Room/SubRoom for the new account.
			return c.json({ success: true, value: toAccountDto(account) })
		}
	)

	// ---- Parental control ----------------------------------------------------
	.get(
		'/parentalcontrol/me',
		describeRoute({
			tags: ['Self'],
			summary: 'The caller’s parental-control flags',
			description: 'Nothing stores parental controls yet; purchases are always allowed.',
			security: AUTHED,
			responses: {
				200: json(ParentalControl, 'Parental-control flags'),
				401: UNAUTHORIZED_RESPONSE,
			},
		}),
		async (c) => {
			const id = await authedId(c)
			if (id === null) return unauthorized(c)
			return c.json({ accountId: id, disallowInAppPurchases: true })
		}
	)

	// Privacy settings for an account. A bare `{}` fails the client's deserializer
	// ("Deserialization returned null") — it needs the fields, so echo the id back and
	// report recent history as visible. Nothing stores per-player privacy yet.
	.get(
		'/accountprivacysettings/:id{[0-9]+}',
		describeRoute({
			tags: ['Lookup'],
			summary: 'An account’s privacy settings',
			description: [
				'Nothing stores per-player privacy yet; the id is echoed and recent history is',
				'reported visible (a bare `{}` fails the client’s deserializer).',
			].join(' '),
			parameters: [
				{
					name: 'id',
					in: 'path',
					required: true,
					description: 'Account id (digits only)',
					schema: { type: 'string', pattern: '^[0-9]+$' },
				},
			],
			responses: { 200: json(PrivacySettings, 'Privacy settings') },
		}),
		(c) =>
			c.json({
				accountId: Number.parseInt(c.req.param('id'), 10),
				isRecentHistoryVisible: true,
			})
	)

	// ---- Profile mutations ---------------------------------------------------
	// Set the player's display name (persisted on the account row).
	.put(
		'/account/me/displayname',
		describeRoute({
			tags: ['Profile'],
			summary: 'Set display name',
			description: 'Persisted and broadcast via an AccountUpdate notification.',
			security: AUTHED,
			responses: {
				200: json(SuccessResponse, 'Updated'),
				400: {
					description:
						'Empty, over 15 characters, outside the display name charset, or profane (empty body)',
				},
				401: UNAUTHORIZED_RESPONSE,
			},
		}),
		// An EMPTY 400, which is what this route already answered for an empty name: it
		// acks with a bare SuccessResponse and has never sent the client a body on
		// failure, so enforcing the schema doesn't change what a refusal looks like.
		validator('form', DisplayNameRequest, (r, c) => (r.success ? undefined : c.body(null, 400))),
		async (c) => {
			const id = await authedId(c)
			if (id === null) return unauthorized(c)
			const { displayName } = c.req.valid('form')
			const account = await updateAccount(c.env.DB, id, { displayName })
			await pushAccountUpdate(c, account)
			return c.json({ success: true })
		}
	)

	// Change the caller's username. Rejects a name already taken by another account,
	// and requires the account to have username changes remaining. On success the
	// new name is persisted and the remaining-changes counter is decremented.
	.put(
		'/account/me/username',
		describeRoute({
			tags: ['Profile'],
			summary: 'Change username',
			description: [
				'Letters and digits only, at most 50 characters, and free of profanity (the same',
				'word list as `api`’s `POST /api/sanitize/v1/isPure`). Rejects a name taken by another',
				'account and requires a remaining change; on success the name is persisted and',
				'the counter decremented. Always HTTP 200 — failures carry a message in `error`',
				'(see the UsernameResult envelope).',
			].join(' '),
			security: AUTHED,
			responses: {
				200: json(UsernameResult, 'Result envelope (success or a validation error)'),
				401: UNAUTHORIZED_RESPONSE,
			},
		}),
		// Shape is checked before the handler runs, so a rejected name costs no D1 read and
		// — the part that matters — can never spend one of the account's rationed changes.
		// The message is relayed rather than zod's issue array: `nameRejection` writes the
		// sentence the player reads, and nothing can render an array of issues.
		// `c` is annotated so the hook's context matches this app's bindings, and `error` is
		// Standard Schema's flat issue list rather than a zod error object.
		validator('form', UsernameRequest, (r, c: Context<App>) =>
			r.success
				? undefined
				: usernameResult(c, r.error[0]?.message ?? 'That username cannot be used.')
		),
		async (c) => {
			const id = await authedId(c)
			if (id === null) return unauthorized(c)

			const { username } = c.req.valid('form')

			// Duplicate check first (case-insensitive); keeping your own name is allowed.
			const existing = await getAccountByUsername(c.env.DB, username)
			if (existing && existing.accountId !== id) {
				return usernameResult(c, 'That username is already taken.')
			}

			// Then require a remaining change.
			const account = (await getAccount(c.env.DB, id)) ?? defaultAccount(id)
			const remaining = account.availableUsernameChanges ?? DEFAULT_USERNAME_CHANGES
			if (remaining <= 0) {
				return usernameResult(c, 'You have no username changes remaining.')
			}

			const updated = await updateAccount(c.env.DB, id, {
				username,
				availableUsernameChanges: remaining - 1,
			})
			await pushAccountUpdate(c, updated)
			return usernameResult(c, '', toAccountDto(updated))
		}
	)

	// Change the player's email — STAGED, not applied. An address belongs to one account and is
	// what password recovery goes to, so moving it is the one profile change a stolen session
	// must not be able to make alone. Two steps, each a six-digit code (@repo/domain's
	// email-code-db.ts: one attempt, half an hour, and a cooldown on resends):
	//
	//  1. `email_change` — to the CURRENT address, when the account has one: its owner approves
	//     giving it up. A stolen session can't pass this. Skipped for an account with no
	//     confirmed address, which has nobody to ask.
	//  2. `email_verify` — to the NEW address: proves it is reachable before it becomes the
	//     recovery address, so a typo can never be stored. This is the step that applies the
	//     change. Issued as step 1 is spent, or at once when there was no step 1.
	//
	// `/account/me` keeps serving the old address until step 2 lands. A player with NO address
	// who mistypes one just enters another: a different address always gets a fresh code (the
	// cooldown only refuses a repeat to the SAME address), since nothing confirmed is at stake.
	// With a confirmed address, every new attempt starts again at step 1, and step 1's cooldown
	// applies whatever the new address is — it is the current inbox being written to.
	//
	// The game posts this and reads `{ success: true }`, as it always did; it has no screen for
	// the code, so the emails' links finish the change on the website. A same-address save (a
	// case change, or re-saving what is there) applies at once — nothing to approve.
	//
	// An address another account holds (case-insensitively) is refused with a sentence in the
	// body, which the website shows, where the malformed-address refusal is an empty 400. Same
	// status for both: a 400 is what the game client is known to cope with on this route. The
	// lookup is what the player reads; the UNIQUE index on `email_lower` is the backstop for a
	// race, re-checked when the change is applied.
	.post(
		'/account/me/email',
		describeRoute({
			tags: ['Profile'],
			summary: 'Change email (sends a confirmation code)',
			description: [
				'STAGES the change. An account with a confirmed address is sent a six-digit code',
				'THERE first (its owner approves the change); once that code is posted to',
				'`POST /account/me/email/confirm`, a second code goes to the NEW address, and',
				'posting that one applies the change. An account with no address gets only the',
				'second step. Each email links to the website’s `/confirm-email` page.',
				'`{ success: true }` means a code was sent. Re-saving the current address applies',
				'at once. An address on another account (case-insensitive) is refused with',
				'`{ success: false, error }`; so is a repeat within two minutes of the last code,',
				'except that an account with no address may enter a DIFFERENT address at any time.',
				'The malformed-address refusal has no body.',
			].join(' '),
			security: AUTHED,
			responses: {
				200: json(SuccessResponse, 'Code sent (or the same address re-saved)'),
				400: json(
					EmailRefusal,
					'Not a syntactically valid address (empty body), or already on another account / asked again too soon'
				),
				401: UNAUTHORIZED_RESPONSE,
				502: json(EmailRefusal, 'The confirmation email could not be sent'),
			},
		}),
		validator('form', EmailRequest, (r, c) => (r.success ? undefined : c.body(null, 400))),
		async (c) => {
			const id = await authedId(c)
			if (id === null) return unauthorized(c)
			const { email } = c.req.valid('form')
			const taken = { success: false, error: EMAIL_TAKEN }
			const holder = await getAccountByEmail(c.env.DB, email)
			if (holder !== null && holder.accountId !== id) return c.json(taken, 400)

			const current = currentEmail(await getAccount(c.env.DB, id))
			if (current !== null && current.toLowerCase() === email.toLowerCase()) {
				await updateAccount(c.env.DB, id, { email })
				return c.json({ success: true })
			}

			let issue: EmailCodeIssue
			if (current === null) {
				// Step 2 straight away. A different address than the one last staged is never
				// a repeat, so it skips the cooldown — the typo case. (Not the daily cap.)
				const staged = await pendingEmailCode(c.env.DB, 'email_verify', id)
				issue = await beginEmailCode(c.env.DB, 'email_verify', id, email, {
					force: staged?.payload !== email,
				})
			} else {
				// Step 1; a step 2 left over from an earlier attempt is voided, since the current
				// address has not approved THIS one.
				await cancelEmailCode(c.env.DB, 'email_verify', id)
				issue = await beginEmailCode(c.env.DB, 'email_change', id, email)
			}
			if (issue.refused) return c.json(emailCodeRefusal(issue.refused), 400)
			const code = issue.code

			const sent = await sendEmailCode(c, {
				purpose: current === null ? 'email_verify' : 'email_change',
				to: current ?? email,
				code,
				newEmail: email,
				currentEmail: current,
			})
			if (!sent) return c.json({ success: false, error: EMAIL_NOT_SENT }, 502)
			return c.json({ success: true })
		}
	)

	// The change awaiting a code, for the website to pick up where it left off after a reload
	// (and right after signup, which saves the address and lands on the account page).
	.get(
		'/account/me/email/pending',
		describeRoute({
			tags: ['Profile'],
			summary: 'The email change awaiting confirmation',
			description: [
				'The address a code is out for, and where the code went — the current address while',
				'it is approving the change, the new one while it is confirming itself — or nulls when',
				'no change is in flight (none staged, or the code lapsed or was spent by a wrong guess).',
			].join(' '),
			security: AUTHED,
			responses: {
				200: json(PendingEmailResponse, 'The pending change, or nulls'),
				401: UNAUTHORIZED_RESPONSE,
			},
		}),
		async (c) => {
			const id = await authedId(c)
			if (id === null) return unauthorized(c)
			return c.json(await pendingEmailChange(c, id))
		}
	)

	// Spend the pending code. The code is what approves the step; the session says whose. One
	// guess: a wrong code voids the step (and the change), and the address has to be saved again.
	// The refusal reads the same whether the code was wrong, lapsed or never issued. Which step
	// is being confirmed follows from what is pending — only one ever is.
	.post(
		'/account/me/email/confirm',
		describeRoute({
			tags: ['Profile'],
			summary: 'Confirm an email change step with the emailed code',
			description: [
				'Spends the code staged by `POST /account/me/email`. When it was the CURRENT address',
				'approving the change, a second code is sent to the new address and `applied` is',
				'false, with `pending`/`sentTo` saying so; when it was the new address confirming',
				'itself, the change is applied and `applied` is true. The code works ONCE: a wrong one',
				'voids the change. The refusal is the same sentence whether the code was wrong, has',
				'lapsed (30 minutes) or was never issued. The address is re-checked against other',
				'accounts as it lands.',
			].join(' '),
			security: AUTHED,
			responses: {
				200: json(EmailConfirmResponse, 'Step confirmed; `applied` says whether the change landed'),
				400: json(
					EmailRefusal,
					'No code, a code that is wrong / lapsed / not issued, or an address another account took meanwhile'
				),
				401: UNAUTHORIZED_RESPONSE,
				502: json(EmailRefusal, 'The second code’s email could not be sent'),
			},
		}),
		validator('form', EmailConfirmRequest, (r, c) =>
			r.success
				? undefined
				: c.json({ success: false, error: 'Enter the code from the email.' }, 400)
		),
		async (c) => {
			const id = await authedId(c)
			if (id === null) return unauthorized(c)
			const { code } = c.req.valid('form')

			// Step 2, if it is the one out; else step 1.
			const verifying = (await pendingEmailCode(c.env.DB, 'email_verify', id)) !== null
			const purpose = verifying ? 'email_verify' : 'email_change'
			const result = await completeEmailCode(c.env.DB, purpose, id, code)
			if (result.outcome !== 'ok' || !result.payload) {
				logger.info('email change refused', { accountId: id, purpose, outcome: result.outcome })
				return c.json({ success: false, error: EMAIL_CODE_WRONG }, 400)
			}
			const email = result.payload
			const taken = { success: false, error: EMAIL_TAKEN }
			const holder = await getAccountByEmail(c.env.DB, email)
			if (holder !== null && holder.accountId !== id) return c.json(taken, 400)

			if (!verifying) {
				// The current address has approved; now the new one proves itself. Forced past the
				// cooldown: step 1 just gated this, and the previous verify code (if any) went out
				// at least a step-1 cooldown ago.
				const next = await beginEmailCode(c.env.DB, 'email_verify', id, email, { force: true })
				// The day's cap can bite here too; the approval is spent, so say so plainly.
				if (next.refused) return c.json(emailCodeRefusal(next.refused), 400)
				const sent = await sendEmailCode(c, {
					purpose: 'email_verify',
					to: email,
					code: next.code,
					newEmail: email,
					currentEmail: currentEmail(await getAccount(c.env.DB, id)),
				})
				if (!sent) return c.json({ success: false, error: EMAIL_NOT_SENT }, 502)
				logger.info('email change approved by the current address', { accountId: id })
				return c.json({ success: true, applied: false, pending: email, sentTo: email })
			}

			try {
				await updateAccount(c.env.DB, id, { email })
			} catch (err) {
				if (isUniqueEmailViolation(err)) return c.json(taken, 400)
				throw err
			}
			logger.info('email changed', { accountId: id })
			return c.json({ success: true, applied: true, pending: null, sentTo: null })
		}
	)

	// Set the player's phone (persisted on the account row).
	.post(
		'/account/me/phone',
		describeRoute({
			tags: ['Profile'],
			summary: 'Set phone number',
			description: 'Persisted on the account row. Not broadcast.',
			security: AUTHED,
			responses: {
				200: json(SuccessResponse, 'Updated'),
				400: { description: 'Empty phone (empty body)' },
				401: UNAUTHORIZED_RESPONSE,
			},
		}),
		validator('form', PhoneRequest, (r, c) => (r.success ? undefined : c.body(null, 400))),
		async (c) => {
			const id = await authedId(c)
			if (id === null) return unauthorized(c)
			const { phone } = c.req.valid('form')
			await updateAccount(c.env.DB, id, { phone })
			return c.json({ success: true })
		}
	)

	// Set the player's identityFlags bitmask (persisted; surfaced by /account/me).
	// `identityFlags` is part of the public account DTO, so the update has to be pushed
	// — see the note on personalpronouns below.
	.put(
		'/account/me/identityflags',
		describeRoute({
			tags: ['Profile'],
			summary: 'Set identity flags',
			description: [
				'`identityFlags` bitmask. In the public DTO, so the update is broadcast via',
				'AccountUpdate.',
			].join(' '),
			security: AUTHED,
			requestBody: form(IdentityFlagsRequest, 'The identityFlags bitmask'),
			responses: {
				200: json(SuccessResponse, 'Updated'),
				400: { description: 'Non-numeric identityFlags (empty body)' },
				401: UNAUTHORIZED_RESPONSE,
			},
		}),
		async (c) => {
			const id = await authedId(c)
			if (id === null) return unauthorized(c)
			const identityFlags = Number.parseInt((await formField(c, 'identityFlags')).trim(), 10)
			if (Number.isNaN(identityFlags)) return c.body(null, 400)
			const account = await updateAccount(c.env.DB, id, { identityFlags })
			await pushAccountUpdate(c, account)
			return c.json({ success: true })
		}
	)

	// Set the player's personalPronouns (posted as `pronounFlags`; persisted).
	// The response body carries no account, so the client only learns the new value from
	// the `SelfAccountUpdate`/`AccountUpdate` the hub pushes — without it the player's own
	// UI (and every other client, since personalPronouns is in the public DTO) keeps
	// showing the old pronouns until something else refetches the account.
	.put(
		'/account/me/personalpronouns',
		describeRoute({
			tags: ['Profile'],
			summary: 'Set personal pronouns',
			description: [
				'Posted as `pronounFlags`. The response carries no account, so the client learns',
				'the new value only from the broadcast AccountUpdate.',
			].join(' '),
			security: AUTHED,
			requestBody: form(PronounsRequest, 'The pronounFlags bitmask'),
			responses: {
				200: json(SuccessResponse, 'Updated'),
				400: { description: 'Non-numeric pronounFlags (empty body)' },
				401: UNAUTHORIZED_RESPONSE,
			},
		}),
		async (c) => {
			const id = await authedId(c)
			if (id === null) return unauthorized(c)
			const personalPronouns = Number.parseInt((await formField(c, 'pronounFlags')).trim(), 10)
			if (Number.isNaN(personalPronouns)) return c.body(null, 400)
			const account = await updateAccount(c.env.DB, id, { personalPronouns })
			await pushAccountUpdate(c, account)
			return c.json({ success: true })
		}
	)

	.put(
		'/account/me/bio',
		describeRoute({
			tags: ['Profile'],
			summary: 'Set bio',
			description: 'Free text up to 255 characters; empty is allowed. Persisted and broadcast.',
			security: AUTHED,
			responses: {
				200: json(SuccessResponse, 'Updated'),
				400: { description: 'Bio over 255 characters (empty body)' },
				401: UNAUTHORIZED_RESPONSE,
			},
		}),
		// Refused rather than truncated: silently storing half a sentence reads as data loss.
		validator('form', BioRequest, (r, c) => (r.success ? undefined : c.body(null, 400))),
		async (c) => {
			const id = await authedId(c)
			if (id === null) return unauthorized(c)
			const { bio } = c.req.valid('form')
			const account = await updateAccount(c.env.DB, id, { bio })
			await pushAccountUpdate(c, account)
			return c.json({ success: true })
		}
	)

	// The emoji shown beside the player's display name. The body is a single field —
	// `displayEmoji=%F0%9F%A4%AA` — and the value is checked against the same list
	// `GET /emojiConfig/whitelistedEmojis` serves, then stored in that list's CANONICAL
	// form: `displayEmoji` is compared as a plain string, and the client highlights the
	// current pick by matching it against the picker list it fetched, so a stored value
	// that differs only by a variation selector highlights nothing.
	//
	// Broadcast like every other public-DTO mutation here — the emoji rides along in the
	// AccountUpdate payload, so it redraws beside the name without a refetch.
	.put(
		'/account/me/emoji',
		describeRoute({
			tags: ['Profile'],
			summary: 'Set display emoji',
			description: [
				'Persists the emoji shown beside the display name and broadcasts it in the',
				'AccountUpdate payload. The value must be one the whitelist serves; an empty value',
				'clears the pick.',
			].join(' '),
			security: AUTHED,
			requestBody: form(EmojiRequest, 'A whitelisted emoji, or "" to clear'),
			responses: {
				200: json(SuccessResponse, 'Updated'),
				400: { description: 'Not a whitelisted emoji (empty body)' },
				401: UNAUTHORIZED_RESPONSE,
			},
		}),
		async (c) => {
			const id = await authedId(c)
			if (id === null) return unauthorized(c)
			const submitted = (await formField(c, 'displayEmoji')).trim()
			// An empty value clears the pick; anything else has to be on the list.
			const displayEmoji = submitted === '' ? '' : resolveWhitelistedEmoji(submitted)
			if (displayEmoji === null) return c.body(null, 400)
			const account = await updateAccount(c.env.DB, id, { displayEmoji })
			await pushAccountUpdate(c, account)
			return c.json({ success: true })
		}
	)

	// The profile banner — the wide image behind the header on a player's profile. Same
	// shape as the avatar below: the body names an image the player has already uploaded
	// (the client posts one of their own photos, `sharecamera/<date>/<uuid>.jpg`), so this
	// stores a key and never bytes.
	//
	// Broadcasts the AccountUpdate like every other profile mutation here — the banner rides
	// along in the DTO payload, so anyone looking at the profile redraws it without a refetch.
	.put(
		'/account/me/bannerimage',
		describeRoute({
			tags: ['Profile'],
			summary: 'Set profile banner image',
			description:
				'Persists the banner object key and broadcasts it in the AccountUpdate payload. The ' +
				'key names an image the player already uploaded — typically one of their own photos ' +
				'(`sharecamera/…`) — so nothing is uploaded here.',
			security: AUTHED,
			requestBody: form(BannerImageRequest, 'The banner object key'),
			responses: {
				200: json(SuccessResponse, 'Updated'),
				400: { description: 'Empty imageName (empty body)' },
				401: UNAUTHORIZED_RESPONSE,
			},
		}),
		async (c) => {
			const id = await authedId(c)
			if (id === null) return unauthorized(c)
			const imageName = await formField(c, 'imageName')
			if (!imageName) return c.body(null, 400)
			const account = await updateAccount(c.env.DB, id, { bannerImage: imageName })
			await pushAccountUpdate(c, account)
			return c.json({ success: true })
		}
	)

	.put(
		'/account/me/profileimage',
		describeRoute({
			tags: ['Profile'],
			summary: 'Set profile image',
			description: 'Persists the avatar object key and broadcasts it in the AccountUpdate payload.',
			security: AUTHED,
			requestBody: form(ProfileImageRequest, 'The avatar object key'),
			responses: {
				200: json(SuccessResponse, 'Updated'),
				400: { description: 'Empty imageName (empty body)' },
				401: UNAUTHORIZED_RESPONSE,
			},
		}),
		async (c) => {
			const id = await authedId(c)
			if (id === null) return unauthorized(c)
			const imageName = await formField(c, 'imageName')
			if (!imageName) return c.body(null, 400)
			// Persist the new avatar key on the account row and fire the AccountUpdate
			// websocket (the new profileImage rides along in the DTO payload).
			const account = await updateAccount(c.env.DB, id, { profileImage: imageName })
			await pushAccountUpdate(c, account)
			return c.json({ success: true })
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
					title: 'recflare accounts',
					version: '1.0.0',
					description: [
						'Account reads, profile mutations and lookups for recflare, a private-server',
						'reimplementation of the Rec Room backend. Accounts live in the shared `recflare`',
						'D1 database, whose `account` schema is owned by the `auth` worker.',
					].join('\n'),
				},
				servers: [{ url: 'https://accounts.recflare.net', description: 'Production' }],
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
