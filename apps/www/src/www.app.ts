import { Hono } from 'hono'
import { useWorkersLogger } from 'workers-tagged-logger'

import { getAccount, updateAccount } from '@repo/domain/src/accounts-db'
import { PlatformType } from '@repo/domain/src/enums'
import { countOnlinePlayers } from '@repo/domain/src/presence-db'
import { getStatSeries } from '@repo/domain/src/stats-db'
import { intVar, logger, withDefaultCors, withOnError } from '@repo/hono-helpers'
import { generateIdentityAssertion, validateAndGetAccountId } from '@repo/jwt'

// The `platform_account` link table, owned (and migrated) by the `auth` worker. A claimed
// Discord identity is stored there as a PlatformType.Discord link — it is an account ↔
// external identity exactly like the Steam and Meta ones, and unlike a field on the
// account blob it can answer "is this Discord user already on another account" from an
// index. Nobody logs in with it: `auth` refuses a cached_login for any platform it can't
// verify, and its picker lists only the platforms that can be (CACHED_LOGIN_PLATFORMS).
import {
	countAccountsForPlatformIdentity,
	getLinksForAccount,
	hasRecordedRoles,
	isPlatformIdentityLinked,
	linkPlatformIdentity,
	recordFirstRoles,
	unlinkPlatform,
} from '../../auth/src/platform-db'
// The signup grant's default and the Discord supporter gift, both `econ`'s. The gift is
// econ's cron paid on demand: the first time an account links its Discord, the claim hands
// it the box one cron run would, so the amount and the box are econ's and not a copy.
import { DEFAULT_STARTING_TOKENS } from '../../econ/src/balance-db'
import { grantDiscordRoleGift } from '../../econ/src/discord-role-gift'
import { authUnreachable, PASSWORD_SIGNUP_DISABLED } from './auth-messages'
import {
	AUTHORIZE_URL,
	discordConfig,
	exchangeCode,
	fetchGuildMembership,
	fetchUser,
	LOGIN_SCOPES,
	loginRedirectUri,
	qualifies,
	redirectUri,
	revokeToken,
	SCOPES,
} from './discord'
import { refreshDiscordRoles } from './discord-roles'
import { docsPage, fetchSpec } from './docs'
import { privacyPage } from './privacy'
import {
	addUsernameChangeHandler,
	banReportHandler,
	bansInForceHandler,
	clearDormHandler,
	clearPasswordHandler,
	clearRoomInstancesHandler,
	createReportHandler,
	getReportHandler,
	giftItemHandler,
	giftOnlineTokensHandler,
	giftRoleTokensHandler,
	giftRoomTokensHandler,
	giftTokensHandler,
	giftXpHandler,
	grantPlusHandler,
	linkedAccountsHandler,
	playerHistoryHandler,
	requireDeveloper,
	requireStaff,
	runDiscordRoleGiftHandler,
	sandboxStatusHandler,
	searchReportsHandler,
	setSandboxHandler,
	syncDiscordRolesHandler,
	topReportedHandler,
} from './staff'
import {
	grantStudioAccessHandler,
	listStudioAccessHandler,
	revokeStudioAccessHandler,
	studioAccessStatusHandler,
} from './studio-access'
import { passwordSignupOpen, turnstileKeys, verifyTurnstile } from './turnstile'
import {
	accountsBase,
	apiBase,
	authBase,
	cdnBase,
	imgBase,
	notifyBase,
	postAuthForm,
	readAuthError,
	roomsBase,
	storageBase,
	studioBase,
} from './upstream'

import type { Context } from 'hono'
import type { App, Env } from './context'

/**
 * www — the website worker. It serves the React SPA (create account, sign in, change
 * username/email/password) and almost nothing else: the SPA calls the SAME endpoints
 * the game does, on `auth`/`accounts`/`api`/`notify` directly, exactly as rec.net's own
 * site did. Those workers answer CORS for it, and the browser holds the access token.
 *
 * Two things stay server-side here, both because they can't work any other way:
 *
 *  - `/api/signup`, because it's gated by Turnstile and the secret key that turns a
 *    widget token into a verdict cannot ship to a browser. It's also the one account
 *    endpoint with no game equivalent — the game never creates password accounts — so
 *    there's no client contract being duplicated.
 *  - `/api/config`, which tells the SPA the Turnstile site key and where the other
 *    workers live, so one client build works for any operator's domain.
 *  - `/api/benefits/*`, the Discord-verified benefits claim, for the same reason as
 *    signup: the OAuth2 client secret that turns Discord's authorization code into an
 *    access token can't ship to a browser. It is also the only route here that writes to
 *    the database, and so the only one that verifies a token itself (see the section).
 */

/**
 * The account behind a request's bearer token, or null.
 *
 * www verifies a token itself for exactly one feature. Everywhere else the browser
 * carries its token to the worker that owns the data (`accounts`, `rooms`, …) and that
 * worker does the checking; but the benefits claim WRITES `hasPlus` onto an account row,
 * and "which account" is the whole question — asking the SPA would let anyone grant Plus
 * to any id. Same key, same `@repo/jwt` validation (signature, exp) every other worker
 * runs.
 */
const claimant = async (c: Context<App>): Promise<number | null> =>
	validateAndGetAccountId(c.req.raw, await c.env.JWT_SECRET.get())

/**
 * The Discord consent URL the SPA sends the player to, fully assembled here rather than
 * in the browser — everything in it (the scopes the claim needs, and the redirect URI,
 * which must match the token exchange byte for byte) is this worker's business, and a
 * page that built its own could drift from what `/api/benefits/claim` will accept.
 *
 * It carries no `state`. That is the SPA's to add and to check on the way back: it's a
 * per-attempt CSRF nonce, so it has to be minted by the thing that will later verify it
 * (see App.tsx). Everything else about the request is fixed by the server.
 */
function authorizeUrl(request: Request, clientId: string): string {
	return consentUrl(clientId, SCOPES, redirectUri(request))
}

/**
 * The consent URL for "Sign in with Discord": the same app, the narrower `identify` scope,
 * and the sign-in's own return leg (`/login/discord`). Served beside the claim's URL so the
 * SPA never assembles either.
 */
function loginAuthorizeUrl(request: Request, clientId: string): string {
	return consentUrl(clientId, LOGIN_SCOPES, loginRedirectUri(request))
}

function consentUrl(clientId: string, scope: string, redirect: string): string {
	const url = new URL(AUTHORIZE_URL)
	url.search = new URLSearchParams({
		client_id: clientId,
		response_type: 'code',
		scope,
		redirect_uri: redirect,
		// Skip Discord's "you've already authorized this app, continue?" interstitial on a
		// repeat visit; the player has already pressed a button that says what this does.
		prompt: 'none',
	}).toString()
	return url.toString()
}

/**
 * The windows `/api/stats/online` serves, each with the bucket its samples are folded
 * into. The `match` cron samples every five minutes, so `24h` is the raw series and the
 * rest are sized to land between ~90 and ~290 points — what a chart the width of the page
 * can actually draw. A closed list rather than a free `since`: every request scans the
 * window it names, and this is a public route.
 */
const STAT_RANGES: Record<string, { seconds: number; bucketSeconds: number }> = {
	'24h': { seconds: 86_400, bucketSeconds: 300 },
	'7d': { seconds: 7 * 86_400, bucketSeconds: 3_600 },
	'30d': { seconds: 30 * 86_400, bucketSeconds: 4 * 3_600 },
	'90d': { seconds: 90 * 86_400, bucketSeconds: 86_400 },
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

	// ---- Site config --------------------------------------------------------

	// What the SPA has to know before it can do anything: whether web signup is open,
	// the Turnstile site key to mount its widget with, and the hostnames of the workers
	// it calls directly. All three are served rather than baked into the client build so
	// one build works for any operator. The site key is public (it ships in the widget
	// markup either way); the secret never leaves the worker.
	//
	// Signup is open only when BOTH hold: the operator has switched password signup on
	// (`PASSWORD_SIGNUP`, the knob auth enforces) and a Turnstile keypair is configured to
	// guard it. Either missing and the SPA offers no form.
	.get('/api/config', async (c) => {
		const [keys, discord] = await Promise.all([turnstileKeys(c.env), discordConfig(c.env)])
		const signupEnabled = passwordSignupOpen(c.env) && keys !== null
		return c.json({
			signupEnabled,
			turnstileSiteKey: signupEnabled ? keys.siteKey : null,
			// The benefits claim, on the same terms: open only when it's fully configured, and
			// the SPA is handed a ready-made consent URL rather than the parts to build one.
			// Nothing secret is served — the client id inside it is public — and the guild/role
			// ids never leave the worker, since it's the worker that asks Discord the question.
			benefitsEnabled: discord !== null,
			discordAuthorizeUrl: discord ? authorizeUrl(c.req.raw, discord.clientId) : null,
			// "Sign in with Discord", on the SAME switch: the sign-in resolves (or makes) the
			// account through the Discord link, and only the claim ever writes one with roles, so
			// an operator who hasn't set the claim up has no reason to offer the door either.
			discordLoginUrl: discord ? loginAuthorizeUrl(c.req.raw, discord.clientId) : null,
			hosts: {
				auth: authBase(c.env),
				accounts: accountsBase(c.env),
				api: apiBase(c.env),
				img: imgBase(c.env),
				notify: notifyBase(c.env),
				rooms: roomsBase(c.env),
				cdn: cdnBase(c.env),
				storage: storageBase(c.env),
				studio: studioBase(c.env),
			},
		})
	})

	// ---- Server status ------------------------------------------------------

	// A public, unauthenticated snapshot of the server — what a status page, a Discord
	// bot or the homepage can poll without a token. CORS is open on this one route (the
	// rest of www is same-origin) so a page hosted anywhere can read it.
	//
	// `status` is a stub: this handler only runs when the worker is up, so there is no
	// state in which it answers anything but "online". It's here so callers can key off
	// a field rather than off HTTP 200, and so a real health signal can replace the
	// constant without changing the payload's shape.
	.get('/server-status', withDefaultCors(), async (c) => {
		return c.json({
			status: 'online',
			// One presence row per account, expired rows excluded — see countOnlinePlayers.
			// Players sitting in the lobby count as online, same as anywhere else we read
			// presence.
			players: await countOnlinePlayers(c.env.DB),
		})
	})

	// The history behind that head-count: the `online` series the `match` presence cron
	// samples into `stat`, for the chart at `/stats`. Public and CORS-open on the same
	// terms as `/server-status`.
	//
	// Each point is the PEAK of its bucket, not the mean — "how many were on" is a question
	// about the busiest moment, and a mean over a four-hour bucket flattens an evening's
	// spike into nothing. `average` is over the raw samples, not over the buckets, so a
	// short bucket at the window's edge doesn't weigh the same as a full one. `online` is
	// the live count rather than the last sample, which can be five minutes old.
	.get('/api/stats/online', withDefaultCors(), async (c) => {
		const range = c.req.query('range') ?? '24h'
		const window = STAT_RANGES[range]
		if (!window) return c.json({ error: 'Unknown range.' }, 400)

		const now = Date.now()
		const since = new Date(now - window.seconds * 1000)
		const [online, buckets] = await Promise.all([
			countOnlinePlayers(c.env.DB),
			getStatSeries(c.env.DB, 'online', since, window.bucketSeconds),
		])
		const samples = buckets.reduce((n, b) => n + b.samples, 0)
		// A new sample lands every five minutes, so a minute of browser cache costs nothing
		// anyone can see and spares the scan when someone flips between ranges.
		c.header('cache-control', 'public, max-age=60')
		return c.json({
			range,
			bucketSeconds: window.bucketSeconds,
			// The window itself, so the chart's x-axis spans what was ASKED for rather than
			// what came back — a server with three days of history shows three days of line.
			from: Math.floor(since.getTime() / 1000),
			to: Math.floor(now / 1000),
			online,
			peak: buckets.reduce((max, b) => Math.max(max, b.peak), 0),
			average: samples === 0 ? 0 : buckets.reduce((sum, b) => sum + b.sum, 0) / samples,
			points: buckets.map((b) => ({ t: b.t, players: b.peak })),
		})
	})

	// ---- Signup -------------------------------------------------------------

	// Create an account from the website, behind a Turnstile bot check. `auth` binds no
	// platform identity to a web account, so its signup caps are the only other thing in
	// front of this path — and `auth` has no bot check of its own, which is why this one
	// endpoint can't simply be called from the browser like the rest.
	//
	// The whole path is behind the `PASSWORD_SIGNUP` switch, OFF by default: a web account
	// has no identity but its address, and the per-IP cap is reset by every VPN or Tor exit
	// (one player made 150 accounts that way in a weekend). `auth` is what enforces the
	// switch — it refuses the grant whatever this worker does — so the check here only
	// spares a visitor the Turnstile round trip and answers in the sentence the form shows.
	//
	// Deliberately passes NO `platform`: create_account treats an asserted platform as one
	// to verify against Steam and would reject RecNet, so this is the platform-less
	// password-account path. The username is auto-assigned by auth — players don't pick one.
	//
	// On success auth's token response is returned VERBATIM, so the SPA stores it the same
	// way it stores the one it gets from calling `/connect/token` itself to sign in. The
	// account's email, when the player gave one, is saved by the client afterwards with
	// that token — `create_account` takes no email, and `accounts` owns the field.
	.post('/api/signup', async (c) => {
		if (!passwordSignupOpen(c.env)) return c.json({ error: PASSWORD_SIGNUP_DISABLED }, 403)
		// No usable keypair means signup is closed rather than unprotected (see turnstile.ts).
		const keys = await turnstileKeys(c.env)
		if (!keys) return c.json({ error: 'Account creation is currently disabled.' }, 403)

		type SignupBody = { password?: string; turnstileToken?: string }
		const { password, turnstileToken } = await c.req
			.json<SignupBody>()
			.catch(() => ({}) as SignupBody)
		if (!password) return c.json({ error: 'A password is required.' }, 400)
		if (!turnstileToken) return c.json({ error: 'Please complete the bot check.' }, 400)

		// The IP Turnstile cross-checks the token against — set by the edge, so the client
		// can't spoof it (unlike X-Forwarded-For). `auth` records the same header as the
		// account's signup IP, which is why it's forwarded to the grant below rather than
		// left to the edge: see `postAuthForm`.
		const clientIp = c.req.header('cf-connecting-ip')
		const verified = await verifyTurnstile(keys.secretKey, turnstileToken, clientIp)
		// A token is single-use, so the client resets its widget before letting them retry.
		if (!verified) return c.json({ error: 'Bot check failed. Please try again.' }, 403)

		// A throw here is auth being unreachable, not a rejected signup — answered as such
		// rather than falling through to the generic 500 handler, whose "internal server
		// error" tells the player nothing about whether they now have an account (they don't:
		// nothing was created).
		const res = await postAuthForm(
			c.env,
			'/connect/token',
			{ grant_type: 'create_account', password },
			{ clientIp }
		).catch(() => null)
		if (res === null) {
			logger.error('could not reach auth to create an account')
			return c.json({ error: authUnreachable('signup') }, 502)
		}

		// A refused grant is translated (see `readAuthError`) rather than relayed: auth
		// answers the OAuth shape, whose `error` is always a code like `invalid_grant`, and
		// that code is what the form used to show for every failure — including the
		// per-network cap, which the player could otherwise understand. Sign-in doesn't need
		// this (the browser calls `/connect/token` itself and reads `error_description`), but
		// the cap is reachable only from signup, so the sentences live on this path.
		if (!res.ok) {
			const failure = await readAuthError(res, 'signup')
			logger.info('auth refused a signup', { status: res.status, upstream: failure.upstream })
			return c.json({ error: failure.message }, failure.status)
		}

		const token = (await res.json().catch(() => null)) as { access_token?: string } | null
		if (!token?.access_token) {
			logger.error('auth answered a signup with no access_token')
			return c.json({ error: authUnreachable('signup') }, 502)
		}
		return c.json(token)
	})

	// ---- Sign in with Discord -----------------------------------------------

	/**
	 * Redeem a Discord authorization code from the SIGN-IN consent (`/login/discord`), prove
	 * who the Discord user is, and ask `auth` for a session on the account linked to them —
	 * or, when there is none, for a brand-new account linked to them.
	 *
	 * The browser sends ONLY the code, as it does for the claim, and for the same reason: the
	 * exchange needs the client secret. What is different is what comes after. The claim acts
	 * on a session the caller already has; this is how one GETS a session, so there is no
	 * bearer token and nothing here writes to the account. Instead the proven identity is
	 * signed into an ASSERTION with the shared JWT_SECRET and posted to `auth`'s
	 * `identity_assertion` grant, which resolves it through the link table exactly as
	 * `cached_login` resolves a Steam ticket, and answers the ordinary token body. Resolving
	 * the account — and minting one — stays `auth`'s: www never picks an account id.
	 *
	 * Posted over the service binding with the browser's real IP forwarded, like signup, so
	 * the per-IP cap on the sign-up path counts the browser and not Cloudflare. The token
	 * response is relayed verbatim; `created: true` on it is the SPA's cue to say an account
	 * was just made and that setting a password is what makes it usable in the game.
	 */
	.post('/api/login/discord', async (c) => {
		const config = await discordConfig(c.env)
		if (!config) return c.json({ error: 'Signing in with Discord is not available here.' }, 403)

		type LoginBody = { code?: string }
		const { code } = await c.req.json<LoginBody>().catch(() => ({}) as LoginBody)
		if (!code) return c.json({ error: 'No Discord authorization code was provided.' }, 400)

		const accessToken = await exchangeCode(config, code, loginRedirectUri(c.req.raw))
		if (accessToken === null) {
			return c.json(
				{ error: 'That Discord sign-in could not be completed. Please try again.' },
				400
			)
		}
		const user = await fetchUser(accessToken)
		await revokeToken(config, accessToken)
		if (user === null) {
			return c.json(
				{ error: 'That Discord sign-in could not be completed. Please try again.' },
				400
			)
		}

		const jwtSecret = await c.env.JWT_SECRET.get().catch(() => '')
		if (jwtSecret === '') {
			logger.error('cannot sign an identity assertion: JWT_SECRET is unreadable')
			return c.json({ error: authUnreachable('login') }, 502)
		}
		const assertion = await generateIdentityAssertion(
			{ platform: PlatformType.Discord, platformId: user.id },
			jwtSecret
		)
		const res = await postAuthForm(
			c.env,
			'/connect/token',
			{ grant_type: 'identity_assertion', assertion },
			{ clientIp: c.req.header('cf-connecting-ip') }
		).catch(() => null)
		if (res === null) {
			logger.error('could not reach auth to redeem an identity assertion')
			return c.json({ error: authUnreachable('login') }, 502)
		}
		if (!res.ok) {
			const failure = await readAuthError(res, 'login')
			logger.info('auth refused a discord sign-in', {
				status: res.status,
				upstream: failure.upstream,
			})
			return c.json({ error: failure.message }, failure.status)
		}
		const token = (await res.json().catch(() => null)) as {
			access_token?: string
			created?: boolean
		} | null
		if (!token?.access_token) {
			logger.error('auth answered a discord sign-in with no access_token')
			return c.json({ error: authUnreachable('login') }, 502)
		}
		logger.info(token.created ? 'created an account from a discord sign-in' : 'discord sign-in')
		return c.json({ ...token, discordUsername: user.username })
	})

	// ---- Discord benefits claim ---------------------------------------------

	/**
	 * Where the player's Discord already stands with this account — what the claim page
	 * renders before anyone presses anything, so a player who has already claimed sees
	 * that rather than being walked through the flow again to find out.
	 *
	 * `hasPlus` is read from the account row rather than from a token claim: it is set
	 * here, after the token in the browser was issued, so a freshly-claimed player's token
	 * says nothing about it until they sign in again.
	 */
	.get('/api/benefits/status', async (c) => {
		const accountId = await claimant(c)
		if (accountId === null) return c.body(null, 401)
		const [account, claimed, links] = await Promise.all([
			getAccount(c.env.DB, accountId),
			hasRecordedRoles(c.env.DB, accountId, PlatformType.Discord),
			getLinksForAccount(c.env.DB, accountId),
		])
		return c.json({
			hasPlus: account?.hasPlus ?? false,
			// Whether this account has CLAIMED through a Discord identity — a link with roles
			// recorded — not WHICH one. The player knows their own Discord; the id is of no use to
			// the page and every reason to keep an account's linked identities off the wire. A
			// bare link, which "Sign in with Discord" leaves on a new account, reads as not yet
			// claimed: the page then offers the claim, which is what that player still has to do.
			linked: claimed,
			// Whether ANY Discord identity is on the account, claimed or bare — what the unlink
			// button keys on, since a sign-in's bare link is as much a link to take off as a
			// claim's. Still never WHICH one.
			discordLinked: links.some((link) => link.platform === PlatformType.Discord),
			// The unlink's one precondition (see `/api/benefits/unlink`), served beside the link
			// so the page can say so before the button fails. The self DTO carries the address
			// too; this is the server's own reading of the same row the unlink will decide from.
			hasEmail: !!account?.email,
		})
	})

	/**
	 * Take the account's Discord off it: every `PlatformType.Discord` link goes, whether a
	 * claim wrote it or "Sign in with Discord" did. Afterwards that Discord opens no account —
	 * signing in with it makes a NEW one — and the benefits claim's once-only guard lets it
	 * claim on another account.
	 *
	 * Refused unless the account has an EMAIL ADDRESS. The link may be the only way into the
	 * account: an account made by "Sign in with Discord" has no password and no email until
	 * the player sets them, and removing its link would leave nothing to recover the account
	 * by. An address is enough — it is what the account can be recovered through — so a
	 * password is NOT required: a player with an email and no password sets one in game, as
	 * any passwordless account does. Checked here, on the row, and not trusted from the page
	 * (which shows the same flag from `/api/benefits/status` so it can say so before anyone
	 * presses anything).
	 *
	 * The grants the link carried go with it. `hasPlus` and `hasStudio` are both cleared:
	 * the Discord roles are what the claim granted Plus for and what the Studio rollout reads,
	 * and a player taking the link off is giving that proof back — unlike a role that merely
	 * lapses, which the claim deliberately never revokes for. This clears an operator's
	 * grant too (`runx admin grant-plus`/`grant-studio` write the same flags, and nothing on
	 * the row says which wrote them); the page warns, and staff can re-grant. Both reach the
	 * game on the NEXT token, like every account flag.
	 *
	 * What it does NOT do is forget that the account has claimed. A link with roles recorded
	 * was a claim, and the first-link supporter gift keys on "never claimed before", read from
	 * the link table — which would read as never-linked once the row is gone. So a claimed
	 * link's removal stamps `hasClaimedDiscord` on the account, and the claim consults both;
	 * otherwise link → unlink → link would pay the one-time box on every cycle.
	 *
	 * Not gated on the Discord configuration: the link is in the table whether or not the
	 * operator still runs the claim, and a player can always take it off. Answers the same
	 * shape `/api/benefits/status` does, as the account now stands.
	 */
	.post('/api/benefits/unlink', async (c) => {
		const accountId = await claimant(c)
		if (accountId === null) return c.body(null, 401)

		const account = await getAccount(c.env.DB, accountId)
		if (!account?.email) {
			return c.json(
				{
					error:
						'Add an email address to your account before unlinking Discord, so the account can be recovered without it.',
				},
				403
			)
		}

		// Whether what's being removed includes a CLAIM — a link with `role` recorded, even as
		// `[]`. Asked of the raw column BEFORE the delete: the parsed `PlatformLink` reads a
		// NULL role and an empty list both as `[]`, and only the column tells a sign-in's bare
		// link from a claim that found no roles.
		const claimed = await hasRecordedRoles(c.env.DB, accountId, PlatformType.Discord)
		const removed = await unlinkPlatform(c.env.DB, accountId, PlatformType.Discord)
		if (removed.length === 0) {
			return c.json({ error: 'No Discord account is linked to this account.' }, 404)
		}
		// One write: remember the claim (when there was one), and take back what the link
		// carried. `undefined` drops the key from the blob, which is how "no Plus" is spelled.
		await updateAccount(c.env.DB, accountId, {
			hasClaimedDiscord: claimed || account.hasClaimedDiscord === true ? true : undefined,
			hasPlus: undefined,
			hasStudio: undefined,
		})
		logger.info('unlinked a discord from an account', {
			accountId,
			links: removed.length,
			claimed,
			hadPlus: account.hasPlus === true,
			hadStudio: account.hasStudio === true,
		})
		return c.json({
			hasPlus: false,
			linked: false,
			discordLinked: false,
			hasEmail: true,
		})
	})

	/**
	 * Redeem a Discord authorization code, link the Discord identity to the account with the
	 * roles the player holds in the configured guild, and — if any of those is a configured
	 * qualifying role — give the account Rec Room Plus.
	 *
	 * The LINK is not gated on the roles: any member of the guild is linked, and the whole
	 * role list is recorded on the link whether or not a qualifying one is among them. The
	 * roles are read in-game (`auth`'s rollout gate reads them, and the daily sweep keeps
	 * them fresh), so a member with no supporter role still has a reason to link. Only the
	 * `hasPlus` grant asks the qualifying question; a claim without a qualifying role
	 * answers 200 with `hasPlus: false` rather than refusing.
	 *
	 * The browser sends ONLY the code. It never sees an access token: the exchange happens
	 * here with the client secret, the roles are read with the resulting token, and the
	 * token is handed straight back to Discord (see discord.ts). The redirect URI is
	 * derived from this request's own origin rather than accepted from the body, so the
	 * secret can't be used to redeem codes issued for somebody else's page.
	 *
	 * The claim is once-only PER DISCORD USER, not per account: the Discord id is stored
	 * beside the flag, and a code from a Discord member who has already claimed elsewhere
	 * is refused. Otherwise one person with the role could walk it around every account
	 * they own. Re-claiming on the same account is allowed: it refreshes the roles and, if
	 * a qualifying one is held, re-affirms the flag, which is what makes the page safe to
	 * reload and a lapsed-then-restored role re-claimable.
	 *
	 * Nothing here ever REVOKES Plus: losing the Discord role later leaves the flag set.
	 * That's deliberate for now — a sweep would need a bot token to enumerate the guild,
	 * which this design specifically avoids — but it does mean the flag records "held the
	 * role once", not "holds it today". The player's own unlink (`/api/benefits/unlink`) is
	 * the one thing that takes it back.
	 *
	 * The FIRST time an account links a Discord, the claim also pays the supporter gift
	 * econ's cron would (`DISCORD_ROLE_TOKENS`, the amount for the best of the roles just
	 * read) — once, so a new supporter isn't waiting a whole schedule for their first box.
	 * "First" means the account had no Discord link at all before this claim: a re-claim,
	 * and a claim that swaps in a second Discord identity, both pay nothing. The response's
	 * `tokensAwarded` says what was paid (null when nothing was).
	 */
	.post('/api/benefits/claim', async (c) => {
		const config = await discordConfig(c.env)
		if (!config) return c.json({ error: 'Benefit claims are currently disabled.' }, 403)

		const accountId = await claimant(c)
		if (accountId === null) {
			return c.json({ error: 'Please sign in before claiming your benefits.' }, 401)
		}

		type ClaimBody = { code?: string }
		const { code } = await c.req.json<ClaimBody>().catch(() => ({}) as ClaimBody)
		if (!code) return c.json({ error: 'No Discord authorization code was provided.' }, 400)

		const accessToken = await exchangeCode(config, code, redirectUri(c.req.raw))
		// A code lives about a minute and is single-use, so this is far and away the most
		// likely failure a real player hits — hence a sentence about starting over rather
		// than a relayed OAuth code, which would tell them nothing.
		if (accessToken === null) {
			return c.json(
				{ error: 'That Discord sign-in could not be completed. Please try again.' },
				400
			)
		}

		const membership = await fetchGuildMembership(accessToken, config.guildId)
		// The token has told us everything it can; hand it back before answering, whatever
		// the answer turns out to be. Awaited rather than fired into the void so a Worker
		// that finishes the response can't cancel it.
		await revokeToken(config, accessToken)

		if (membership === null) {
			return c.json({ error: 'You are not a member of our Discord server.' }, 403)
		}

		// The once-only guard, asked of the link table: is this Discord identity already on an
		// account, and is that account someone else's? Re-claiming on the caller's OWN account
		// is the idempotent case and must fall through — it's how a player whose roles changed
		// refreshes them and re-affirms Plus, and it's what makes the page safe to reload.
		//
		// `countAccountsForPlatformIdentity` counts EVERY link for the identity, unfiltered by
		// platform, which is why the claim can use the same helper `auth`'s per-identity
		// signup cap does.
		const alreadyMine = await isPlatformIdentityLinked(
			c.env.DB,
			accountId,
			PlatformType.Discord,
			membership.userId
		)
		if (!alreadyMine) {
			const claimedElsewhere = await countAccountsForPlatformIdentity(
				c.env.DB,
				PlatformType.Discord,
				membership.userId
			)
			if (claimedElsewhere > 0) {
				logger.info('a discord account tried to claim benefits on a second account', {
					accountId,
				})
				return c.json(
					{ error: 'That Discord account has already claimed benefits on another account.' },
					409
				)
			}
		}
		// Whether this is the account's FIRST CLAIM — what the one-time gift below keys on.
		// Decided before the write, from the table: a claim is recorded as roles on a Discord
		// link, so an account with any Discord link carrying roles (this identity's, or a
		// DIFFERENT one the once-only guard doesn't stop) has claimed before. A link with NO
		// roles has not: that is what "Sign in with Discord" leaves on an account it just made,
		// and that player's first claim is still their first.
		//
		// AND from the account: an unlink removes a claimed link's row, and stamps
		// `hasClaimedDiscord` on the account so the table reading as never-linked afterwards
		// doesn't make the next link a "first" one. Both are asked; either says not-first.
		const firstClaim =
			(await getAccount(c.env.DB, accountId))?.hasClaimedDiscord !== true &&
			!(await hasRecordedRoles(c.env.DB, accountId, PlatformType.Discord))
		// On a link that already exists without roles, writing them is the claim's one-shot
		// write — the single-winner guard a fresh link gets from its INSERT below. Asked only
		// when the link is the caller's: on anyone else's it would be refused above.
		const recordedFirst =
			alreadyMine &&
			(await recordFirstRoles(
				c.env.DB,
				accountId,
				PlatformType.Discord,
				membership.userId,
				membership.roles
			))

		// The link is written for EVERY guild member, qualifying role or not, and it is
		// idempotent: INSERT OR IGNORE (so `linkedAt` keeps the FIRST claim's time), with the
		// roles refreshed on a re-claim.
		//
		// The member's roles ride along onto the link's `role` column — the WHOLE list Discord
		// served, not just the ones that qualified. `hasPlus` records only that a qualifying
		// role was held; this records which, so the game can act on any role an operator cares
		// about (`auth`'s rollout gate reads this list) and an operator can tell a supporter
		// from a booster from staff without going and asking Discord. Roles are the one part of
		// the row a re-claim REFRESHES, because they're a snapshot of a membership that moves
		// and this reading is the fresher one.
		const created = await linkPlatformIdentity(
			c.env.DB,
			accountId,
			PlatformType.Discord,
			membership.userId,
			membership.roles
		)

		// Any ONE of the configured roles qualifies — see `qualifies`. Without one, the link
		// stands and the flag is left exactly as it was: never set, and never REVOKED either —
		// a player whose role lapsed keeps the Plus they were granted (see the note above).
		// Which roles qualify is the operator's business to advertise in their own server, so
		// nothing here names them.
		let hasPlus: boolean
		if (qualifies(membership.roles, config.roleIds)) {
			await updateAccount(c.env.DB, accountId, { hasPlus: true })
			logger.info('granted plus from a discord benefits claim', { accountId })
			hasPlus = true
		} else {
			hasPlus = (await getAccount(c.env.DB, accountId))?.hasPlus ?? false
			logger.info('linked a discord without a qualifying role', {
				accountId,
				roleCount: membership.roles.length,
			})
		}

		// The one-time supporter gift: the box econ's cron would hand this member, paid now,
		// once. Gated on a single-winner write having happened too — the insert (`created`), or
		// the first roles onto a sign-in's bare link (`recordedFirst`) — so two claims racing on
		// one fresh account can't both pay. Best-effort AFTER Plus is granted and the link is
		// written: a grant that fails partway is logged with what to check, as econ's cron
		// logs its own, and the claim still answers — the player got what they came for, and
		// a retry that also failed partway is how a balance gets credited twice.
		let tokensAwarded: number | null = null
		if ((created || recordedFirst) && firstClaim) {
			try {
				const role = await grantDiscordRoleGift(
					c.env,
					accountId,
					membership.roles,
					intVar(c.env.STARTING_TOKENS, DEFAULT_STARTING_TOKENS)
				)
				if (role !== null) {
					tokensAwarded = role.tokens
					logger.info('awarded the discord role gift on a first link', {
						accountId,
						roleId: role.roleId,
						tokens: role.tokens,
					})
				}
			} catch (err) {
				logger.error('the discord role gift on a first link failed partway', {
					accountId,
					error: err instanceof Error ? err.message : String(err),
				})
			}
		}

		// `hasPlus` is where the account stands AFTER this claim, so the page can tell "linked
		// and granted" from "linked, no qualifying role" without a second read. The username
		// is echoed for the confirmation line only — it is never stored, and a Discord member
		// who has since renamed themselves is not a problem to solve here.
		return c.json({
			hasPlus,
			linked: true,
			discordUsername: membership.username,
			tokensAwarded,
		})
	})

	// Whether the signed-in account has studio upload access (`hasStudio`). The page
	// Studio opens (`/settings/recroomstudio`) asks this; it does not list anyone
	// else. Staff manage the flag on the routes below.
	/**
	 * Mark the caller's account for deletion. A MARK only: `isDeleted` and `deletedAt` go on
	 * the account blob and nothing else changes — no row is removed, the session stays
	 * valid, and the game keeps serving the account. Reversal is meant to be the player
	 * signing in again (a `lastLoginTime` later than `deletedAt`), which is why there is no
	 * "undo" here and why this never touches `auth`. Idempotent: re-posting keeps the
	 * ORIGINAL `deletedAt`, so a second click can't push the mark past a login that already
	 * reversed it.
	 */
	.post('/api/account/delete', async (c) => {
		const accountId = await claimant(c)
		if (accountId === null) return c.body(null, 401)

		const account = await getAccount(c.env.DB, accountId)
		if (!account) return c.json({ error: 'No such account.' }, 404)

		const deletedAt =
			account.isDeleted === true && account.deletedAt ? account.deletedAt : new Date().toISOString()
		if (!(account.isDeleted === true && account.deletedAt)) {
			await updateAccount(c.env.DB, accountId, { isDeleted: true, deletedAt })
			logger.info('a player marked their account for deletion', { accountId })
		}
		return c.json({ isDeleted: true, deletedAt })
	})

	.get('/api/studio-access', studioAccessStatusHandler)

	// ---- Staff moderation panel ---------------------------------------------
	// The endpoints behind `/moderation` in the SPA. They live here rather than on `api`
	// (which owns the `report` table) because they are a recflare addition with no
	// counterpart in the real service, and the game-facing workers only reimplement what
	// the client actually calls — see src/staff.ts. The SQL stays with the table.
	//
	// Ordered before the ASSETS catch-all like everything else, and covered by the
	// existing `/api/*` entry in wrangler.jsonc's `run_worker_first`, so no routing change
	// was needed. `/moderation` itself is deliberately NOT in that allowlist: it is a
	// client-side route, so it must fall through to the SPA shell.
	.use('/api/staff/*', requireStaff)

	// Registered before `/api/staff/reports/:id` so the literal path isn't captured as an
	// id — `top-reported` is not a number, but the param route would still match it and
	// answer a 400 instead of the list.
	.get('/api/staff/reports/top-reported', topReportedHandler)
	.get('/api/staff/reports', searchReportsHandler)
	.post('/api/staff/reports', createReportHandler)
	.get('/api/staff/reports/:id', getReportHandler)
	.post('/api/staff/reports/:id/ban', banReportHandler)
	.get('/api/staff/bans', bansInForceHandler)
	.get('/api/staff/players/:id', playerHistoryHandler)
	.get('/api/staff/players/:id/linked', linkedAccountsHandler)
	// The staff card on a player's profile page — account fixes the game has no endpoint for.
	// The gifts create value from nothing, so they are developer-only, not all staff.
	.post('/api/staff/players/:id/gift-tokens', requireDeveloper, giftTokensHandler)
	// One id field for a custom avatar item, a skin or a consumable; the kind is resolved here.
	.post('/api/staff/players/:id/gift-item', requireDeveloper, giftItemHandler)
	.post('/api/staff/players/:id/gift-xp', requireDeveloper, giftXpHandler)
	// Everyone standing in a room, across all of its instances.
	.post('/api/staff/rooms/:roomId/gift-tokens', requireDeveloper, giftRoomTokensHandler)
	// Delete every live instance of a room — for one whose sessions are stuck. All staff.
	.post('/api/staff/rooms/:roomId/clear-instances', clearRoomInstancesHandler)
	// The account page's token drop: the same gift to everyone online at once.
	.post('/api/staff/online/gift-tokens', requireDeveloper, giftOnlineTokensHandler)
	// Its sibling: the same gift to every account whose Discord link holds a role, offline
	// included — the supporter cron's audience, with an operator's amount and message.
	.post('/api/staff/discord-roles/:roleId/gift-tokens', requireDeveloper, giftRoleTokensHandler)
	// The daily role sweep, run now and answered with its summary (halt reason included) —
	// the cron reports only to a log line, and this is the way to see why it wrote nothing.
	.post('/api/staff/discord-roles/sync', requireDeveloper, syncDiscordRolesHandler)
	// Econ's weekly supporter gift, paid now: a bonus round for everyone holding a mapped role.
	.post('/api/staff/discord-roles/supporter-gift', requireDeveloper, runDiscordRoleGiftHandler)
	// Rec Room Plus is worth tokens and a discount, so granting it is developer-only too.
	.post('/api/staff/players/:id/grant-plus', requireDeveloper, grantPlusHandler)
	.post('/api/staff/players/:id/username-changes', addUsernameChangeHandler)
	.post('/api/staff/players/:id/clear-password', clearPasswordHandler)
	// Blanks the dorm's newest save so a player can go back to the 2023 client.
	.post('/api/staff/players/:id/clear-dorm', clearDormHandler)
	// The signed-in staff member's OWN sandbox flag: read it, and opt in or out. Self-only,
	// so plain staff (not developer-only) — it moves nobody but the caller, and `match`
	// honours it on their next room join.
	.get('/api/staff/sandbox', sandboxStatusHandler)
	.put('/api/staff/sandbox', setSandboxHandler)
	// RecFlare Studio upload access. The same staff gate as moderation: a moderator
	// decides who can upload, and the role lands on the player's next token.
	.get('/api/staff/studio-access', listStudioAccessHandler)
	.post('/api/staff/studio-access', grantStudioAccessHandler)
	.delete('/api/staff/studio-access/:id', revokeStudioAccessHandler)

	// ---- Privacy policy -----------------------------------------------------
	// Server-rendered rather than a SPA route so the page has real text without
	// JavaScript: the Meta Horizon Store re-fetches this URL to check the policy is
	// still live, and an empty SPA shell can read as a broken link (see privacy.ts).
	.get('/privacy', (c) => c.html(privacyPage()))

	// ---- Aggregated API docs ------------------------------------------------
	// `/docs` serves the self-hosted Scalar UI; `/docs/openapi/:service.json` proxies
	// each worker's spec same-origin (see docs.ts). The Scalar bundle itself
	// (`/docs/scalar.standalone.js`) is a static asset emitted by the vite build, so it
	// falls through to the ASSETS catch-all below.
	.get('/docs', (c) => c.html(docsPage()))
	.get('/docs/openapi/:service', async (c) => {
		// Scalar requests `auth.json`; strip the suffix to get the service slug. The
		// param is a single path segment, and fetchSpec allowlists it (so this can't be
		// coerced into an open proxy).
		const slug = c.req.param('service').replace(/\.json$/, '')
		const spec = await fetchSpec(c.env, slug)
		if (spec === null) return c.notFound()
		return spec
	})

	// ---- Static SPA ---------------------------------------------------------
	// Everything else is served from the built client assets. With
	// `not_found_handling: single-page-application`, unknown routes return
	// index.html so the React app can handle client-side routing.
	.all('*', (c) => {
		if (!c.env.ASSETS) return c.notFound()
		return c.env.ASSETS.fetch(c.req.raw)
	})

export { app }

// The daily cron (wrangler.jsonc `triggers`): refresh every Discord link's role snapshot
// through the bot token. A no-op, logged once, until the operator configures one — see
// discord-roles.ts.
export const scheduled: ExportedHandlerScheduledHandler<Env> = (_controller, env, ctx) => {
	ctx.waitUntil(refreshDiscordRoles(env))
}

// A Worker only runs `scheduled` when it's on the default export, so www takes the object
// form the runtime requires (as `match` does for its presence sweep).
export default { fetch: app.fetch, scheduled } satisfies ExportedHandler<Env>
