import { Hono } from 'hono'
import { useWorkersLogger } from 'workers-tagged-logger'

import { getAccount, updateAccount } from '@repo/domain/src/accounts-db'
import { PlatformType } from '@repo/domain/src/enums'
import { countOnlinePlayers } from '@repo/domain/src/presence-db'
import { logger, withDefaultCors, withOnError } from '@repo/hono-helpers'
import { validateAndGetAccountId } from '@repo/jwt'

// The `platform_account` link table, owned (and migrated) by the `auth` worker. A claimed
// Discord identity is stored there as a PlatformType.Discord link — it is an account ↔
// external identity exactly like the Steam and Meta ones, and unlike a field on the
// account blob it can answer "is this Discord user already on another account" from an
// index. Nobody logs in with it: `auth` refuses a cached_login for any platform it can't
// verify, and its picker lists only the platforms that can be (CACHED_LOGIN_PLATFORMS).
import {
	countAccountsForPlatformIdentity,
	getLinksForAccount,
	isPlatformIdentityLinked,
	linkPlatformIdentity,
} from '../../auth/src/platform-db'
import { authUnreachable } from './auth-messages'
import {
	AUTHORIZE_URL,
	discordConfig,
	exchangeCode,
	fetchGuildMembership,
	qualifies,
	redirectUri,
	revokeToken,
	SCOPES,
} from './discord'
import { docsPage, fetchSpec } from './docs'
import { privacyPage } from './privacy'
import { turnstileKeys, verifyTurnstile } from './turnstile'
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
} from './upstream'

import type { Context } from 'hono'
import type { App } from './context'

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
	const url = new URL(AUTHORIZE_URL)
	url.search = new URLSearchParams({
		client_id: clientId,
		response_type: 'code',
		scope: SCOPES,
		redirect_uri: redirectUri(request),
		// Skip Discord's "you've already authorized this app, continue?" interstitial on a
		// repeat claim; the player has already pressed a button that says what this does.
		prompt: 'none',
	}).toString()
	return url.toString()
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
	.get('/api/config', async (c) => {
		const [keys, discord] = await Promise.all([turnstileKeys(c.env), discordConfig(c.env)])
		return c.json({
			signupEnabled: keys !== null,
			turnstileSiteKey: keys?.siteKey ?? null,
			// The benefits claim, on the same terms: open only when it's fully configured, and
			// the SPA is handed a ready-made consent URL rather than the parts to build one.
			// Nothing secret is served — the client id inside it is public — and the guild/role
			// ids never leave the worker, since it's the worker that asks Discord the question.
			benefitsEnabled: discord !== null,
			discordAuthorizeUrl: discord ? authorizeUrl(c.req.raw, discord.clientId) : null,
			hosts: {
				auth: authBase(c.env),
				accounts: accountsBase(c.env),
				api: apiBase(c.env),
				img: imgBase(c.env),
				notify: notifyBase(c.env),
				rooms: roomsBase(c.env),
				cdn: cdnBase(c.env),
				storage: storageBase(c.env),
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

	// ---- Signup -------------------------------------------------------------

	// Create an account from the website, behind a Turnstile bot check. The check is what
	// makes this safe to leave open: `auth` binds no platform identity to a web account, so
	// its per-IP cap (3, never decaying) is the only other thing in front of this path —
	// and `auth` has no bot check of its own, which is why this one endpoint can't simply
	// be called from the browser like the rest.
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
		const [account, links] = await Promise.all([
			getAccount(c.env.DB, accountId),
			getLinksForAccount(c.env.DB, accountId),
		])
		return c.json({
			hasPlus: account?.hasPlus ?? false,
			// Whether this account is already tied to a Discord identity — not WHICH one. The
			// player knows their own Discord; the id is of no use to the page and every reason
			// to keep an account's linked identities off the wire.
			linked: links.some((link) => link.platform === PlatformType.Discord),
		})
	})

	/**
	 * Redeem a Discord authorization code and, if the player holds the configured role in
	 * the configured guild, give the account Rec Room Plus.
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
	 * they own. Re-claiming on the same account is allowed and simply re-affirms the flag,
	 * which is what makes the page safe to reload and a lapsed-then-restored role
	 * re-claimable.
	 *
	 * Nothing here ever REVOKES Plus: losing the Discord role later leaves the flag set.
	 * That's deliberate for now — a sweep would need a bot token to enumerate the guild,
	 * which this design specifically avoids — but it does mean the flag records "held the
	 * role once", not "holds it today".
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
		// Any ONE of the configured roles qualifies — see `qualifies`. The message stays
		// singular-ish and names no role: which roles qualify is the operator's business to
		// advertise in their own server, and listing them here would leak the guild's role
		// layout to anyone who pressed the button.
		if (!qualifies(membership.roles, config.roleIds)) {
			return c.json({ error: 'Your Discord account does not have a qualifying role.' }, 403)
		}

		// The once-only guard, asked of the link table: is this Discord identity already on an
		// account, and is that account someone else's? Re-claiming on the caller's OWN account
		// is the idempotent case and must fall through — it's how a player whose role lapsed
		// and came back re-affirms Plus, and it's what makes the page safe to reload.
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

		// Both writes are idempotent: the link is INSERT OR IGNORE (so `linkedAt` keeps the
		// FIRST claim's time), and the flag is already true on a re-claim.
		await linkPlatformIdentity(c.env.DB, accountId, PlatformType.Discord, membership.userId)
		await updateAccount(c.env.DB, accountId, { hasPlus: true })
		logger.info('granted plus from a discord benefits claim', { accountId })

		// The username is echoed for the confirmation line only — it is never stored, and a
		// Discord member who has since renamed themselves is not a problem to solve here.
		return c.json({ hasPlus: true, discordUsername: membership.username })
	})

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

export default app
