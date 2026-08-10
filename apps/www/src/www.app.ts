import { Hono } from 'hono'
import { useWorkersLogger } from 'workers-tagged-logger'

import { countOnlinePlayers } from '@repo/domain/src/presence-db'
import { logger, withDefaultCors, withOnError } from '@repo/hono-helpers'

import { authUnreachable } from './auth-messages'
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
 */

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
		const keys = await turnstileKeys(c.env)
		return c.json({
			signupEnabled: keys !== null,
			turnstileSiteKey: keys?.siteKey ?? null,
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
