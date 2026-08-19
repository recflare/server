import { useCallback, useEffect, useRef, useState } from 'react'

import { NotificationType } from '../../../notify/src/notification-types'
import { authFailure, authUnreachable } from '../auth-messages'
import {
	DISCORD_INVITE,
	DOWNLOAD_URL,
	LICENSE_URL,
	QUEST_DOWNLOAD_URL,
	SOURCE_REPO,
} from '../links'

import type { ReactNode } from 'react'

/**
 * The SPA calls the SAME endpoints the game does — `auth` for tokens and the password
 * change, `accounts` for the profile, `api` for the photo feed, `notify` for the admin
 * broadcasts — rather than proxying each one through `www`, exactly as rec.net's own
 * site did. Those workers answer CORS for it (see their `withDefaultCors()`), and the
 * access token lives here in the browser.
 *
 * `www` serves only two things of its own (see www.app.ts): the config below, and
 * signup, which is Turnstile-gated and so cannot leave the server.
 */

/** Where each worker lives. From `/api/config`, never baked into this build. */
interface Hosts {
	auth: string
	accounts: string
	api: string
	img: string
	notify: string
}

/**
 * Site config from `www`. `signupEnabled` is false when the operator has no Turnstile
 * keypair configured — web signup runs behind that bot check, so without it the endpoint
 * is closed and the UI must not offer the form.
 */
interface SiteConfig {
	signupEnabled: boolean
	turnstileSiteKey: string | null
}

/** The private self DTO from `accounts` (`GET /account/me`). */
interface SelfAccount {
	accountId: number
	username: string
	displayName: string
	email: string | null
	/**
	 * Username changes left on the account — each change spends one, and an account
	 * starts with one. Absent on an older self DTO, which reads as "unknown": the form
	 * stays usable and lets the server be the one to refuse.
	 */
	availableUsernameChanges?: number
}

/**
 * RecNet (4) is the web platform, stamped as the token's `platform` claim on sign-in.
 * NOT passed on signup: create_account treats an asserted platform as one to verify
 * against Steam and rejects RecNet — the web signup is the (platform-less) password
 * account path.
 */
const WEB_PLATFORM = '4'

/**
 * The session's access token, in localStorage so a reload stays signed in.
 *
 * Readable by page JS, which the httpOnly cookie this replaced was not — that is the
 * tradeoff that comes with the browser calling the workers itself, and it's the same
 * posture the game client has. Nothing third-party runs on this origin except the
 * Turnstile widget, which is Cloudflare's own.
 */
const TOKEN_KEY = 'rf_token'
let token: string | null = localStorage.getItem(TOKEN_KEY)

function setToken(next: string | null) {
	token = next
	if (next === null) localStorage.removeItem(TOKEN_KEY)
	else localStorage.setItem(TOKEN_KEY, next)
}

/**
 * Filled in once `/api/config` lands, before any worker call is made — a module value
 * rather than a prop threaded through every form, since the components that call a
 * worker only render after the config resolves.
 */
let hosts: Hosts | null = null

/** The hostnames, once known. Throws rather than guessing a domain. */
function where(): Hosts {
	if (hosts === null) throw new Error('Still starting up — please reload the page.')
	return hosts
}

/**
 * Roles that unlock the admin controls. Mirrors the notify worker's `ADMIN_ROLES` gate —
 * this only decides whether to SHOW them; notify verifies the token on every call.
 */
const ADMIN_ROLES = new Set(['developer', 'moderator'])

/**
 * Whether the session token carries an admin role. Decodes the `role` claim WITHOUT
 * verifying it — a page holds no signing key, and faking one here only reveals buttons
 * whose endpoints reject the same token. A malformed token reads as "not admin".
 */
function isAdmin(): boolean {
	const payload = token?.split('.')[1]
	if (!payload) return false
	try {
		const b64 = payload.replace(/-/g, '+').replace(/_/g, '/')
		const padded = b64.padEnd(b64.length + ((4 - (b64.length % 4)) % 4), '=')
		const claims = JSON.parse(atob(padded)) as { role?: unknown }
		return Array.isArray(claims.role) && claims.role.some((r) => ADMIN_ROLES.has(r as string))
	} catch {
		return false
	}
}

/**
 * An OAuth machine code (`invalid_grant`, `server_error`) rather than a sentence — a
 * lower_snake_case word with no spaces. A worker that speaks OAuth puts one of these in
 * `error`, where the readable reason is in `error_description`.
 */
const isErrorCode = (s: string) => /^[a-z][a-z\d]*(_[a-z\d]+)+$/.test(s)

/**
 * The message worth showing for a refusal. `error` wins, since that's where a worker
 * puts a sentence it wrote for the player — but NOT when it's a bare OAuth code, which
 * tells nobody anything. Some refusals carry no body at all (accounts answers a
 * malformed email with an empty 400), hence the last-resort line.
 */
function errorMessage(data: Record<string, unknown>, status: number): string {
	const error = typeof data.error === 'string' ? data.error : ''
	const description = typeof data.error_description === 'string' ? data.error_description : ''
	return (
		(error && !(isErrorCode(error) && description) && error) ||
		description ||
		error ||
		`Request failed (${status})`
	)
}

interface CallOptions {
	method?: 'GET' | 'POST' | 'PUT'
	/** Form fields — auth and accounts read their input with Hono's `parseBody()`. */
	form?: Record<string, string>
	/** A JSON body — what notify's internal endpoints take instead. */
	json?: unknown
	/** Send the session token. */
	authed?: boolean
	/**
	 * What to say when the worker refuses with a 400 and NO body. Several accounts routes
	 * do exactly that (email, display name, bio), so without this the player reads
	 * "Request failed (400)" — the status, not the reason.
	 */
	refusal?: string
}

/** Call a worker. Returns the parsed body, or throws with something worth showing. */
async function call<T = Record<string, unknown>>(url: string, opts: CallOptions = {}): Promise<T> {
	const headers: Record<string, string> = {}
	if (opts.authed && token) headers.authorization = `Bearer ${token}`
	let body: string | undefined
	if (opts.form) {
		headers['content-type'] = 'application/x-www-form-urlencoded'
		body = new URLSearchParams(opts.form).toString()
	} else if (opts.json !== undefined) {
		headers['content-type'] = 'application/json'
		body = JSON.stringify(opts.json)
	}

	const res = await fetch(url, {
		method: opts.method ?? (body === undefined ? 'GET' : 'POST'),
		headers,
		body,
	})
	const data = (await res.json().catch(() => ({}))) as Record<string, unknown>

	if (!res.ok) {
		// Expired or revoked. Cleared here so no caller has to remember to.
		if (res.status === 401 && opts.authed) {
			setToken(null)
			throw new Error('Your session has expired. Please sign in again.')
		}
		// Only when the body really is empty — a worker that did send a reason keeps it.
		if (opts.refusal !== undefined && res.status === 400 && Object.keys(data).length === 0) {
			throw new Error(opts.refusal)
		}
		throw new Error(errorMessage(data, res.status))
	}
	return data as T
}

/** The signed-in account, straight from `accounts`. */
const fetchMe = (): Promise<SelfAccount> =>
	call<SelfAccount>(`${where().accounts}/account/me`, { authed: true })

/**
 * Sign in with auth's password grant, posted directly the way the game posts it. The
 * account is resolved by `username` (case-insensitive) — web players sign in with their
 * username, not the numeric account id.
 *
 * A refusal is translated through the table shared with the worker (see
 * `auth-messages.ts`): auth's `error` is always a machine code, and the reason in
 * `error_description` is written for an operator, not a player.
 */
async function signIn(username: string, password: string): Promise<void> {
	const res = await fetch(`${where().auth}/connect/token`, {
		method: 'POST',
		headers: { 'content-type': 'application/x-www-form-urlencoded' },
		body: new URLSearchParams({
			grant_type: 'password',
			username,
			platform: WEB_PLATFORM,
			password,
		}).toString(),
	}).catch(() => null)
	if (res === null) throw new Error(authUnreachable('login'))

	const data = (await res.json().catch(() => ({}))) as Record<string, unknown>
	if (!res.ok) {
		const code = typeof data.error === 'string' ? data.error : ''
		const description = typeof data.error_description === 'string' ? data.error_description : ''
		throw new Error(authFailure('login', res.status, code, description).message)
	}
	if (typeof data.access_token !== 'string') throw new Error(authUnreachable('login'))
	setToken(data.access_token)
}

/**
 * Create an account — the one flow that goes through `www`, because it's gated by
 * Turnstile and that check needs a secret key a page can't hold. www hands back auth's
 * token response unchanged, so the session is established just as sign-in establishes it.
 */
async function signUp(password: string, turnstileToken: string): Promise<void> {
	const data = await call<{ access_token?: string }>('/api/signup', {
		json: { password, turnstileToken },
	})
	if (typeof data.access_token !== 'string') throw new Error(authUnreachable('signup'))
	setToken(data.access_token)
}

/**
 * Change the username.
 *
 * `accounts` answers this one in its own envelope — `{ success, error, value }` at HTTP
 * 200 even when it refused (taken name, no changes left) — so a 200 is not enough to
 * call it done. The sentences it writes are already player-facing, so they're shown as-is.
 *
 * On success the SELF account is re-read rather than using the envelope's `value`: that
 * is the PUBLIC DTO, and it carries no `availableUsernameChanges` — the very field this
 * form needs to know whether another change is left.
 */
async function changeUsername(username: string): Promise<SelfAccount> {
	const result = await call<{ error?: unknown }>(`${where().accounts}/account/me/username`, {
		method: 'PUT',
		form: { username },
		authed: true,
	})
	const refusal = typeof result.error === 'string' ? result.error : ''
	if (refusal !== '') throw new Error(refusal)
	return fetchMe()
}

/**
 * Set the account's email.
 *
 * The address is NOT checked here first. `accounts` validates it with `isemail`, which
 * can't come along into the browser (it reaches for node's `util`, which vite stubs with
 * a throwing Proxy in dev) — and a second, looser copy of the rule would only disagree
 * with the real one. The server decides; this just names the refusal it answers with.
 */
const saveEmail = (email: string): Promise<unknown> =>
	call(`${where().accounts}/account/me/email`, {
		form: { email },
		authed: true,
		refusal: 'That email address looks wrong.',
	})

/** Change the account's password. Lives on `auth`, not `accounts`. */
const changePassword = (oldPassword: string, newPassword: string): Promise<unknown> =>
	call(`${where().auth}/account/me/changepassword`, {
		form: { oldPassword, newPassword },
		authed: true,
	})

/**
 * Admin-only broadcasts. The token goes to `notify`, which enforces the admin-role gate
 * — so a session without the role is rejected there (403) even though the UI shows no
 * button. The maintenance frame carries `Msg: { StartsInMinutes }`, matching the game
 * client's ServerMaintenance handler.
 */
const broadcastMaintenance = (startsInMinutes: number): Promise<{ delivered?: number }> =>
	call<{ delivered?: number }>(`${where().notify}/internal/broadcast`, {
		json: {
			notificationType: NotificationType.ServerMaintenance,
			data: { StartsInMinutes: startsInMinutes },
		},
		authed: true,
	})

const coachMessageAll = (messageContent: string): Promise<{ sent?: number }> =>
	call<{ sent?: number }>(`${where().notify}/internal/coach-message-all`, {
		json: { messageContent },
		authed: true,
	})

interface OnlinePlayer {
        accountId: number
        username: string
        displayName: string
        roomId: number | null
        roomInstanceId: number | null
        roomName: string
}

const fetchOnlinePlayers = (): Promise<{ players: OnlinePlayer[] }> =>
        call<{ players: OnlinePlayer[] }>('/api/admin/online-players', {
                authed: true,
        })


/** Minimal history-based router: current pathname + a navigate() that pushes state. */
function useRouter() {
	const [path, setPath] = useState(() => window.location.pathname)
	useEffect(() => {
		const onPop = () => setPath(window.location.pathname)
		window.addEventListener('popstate', onPop)
		return () => window.removeEventListener('popstate', onPop)
	}, [])
	const navigate = useCallback((to: string) => {
		if (to !== window.location.pathname) {
			window.history.pushState(null, '', to)
			window.scrollTo(0, 0)
		}
		setPath(to)
	}, [])
	return { path, navigate }
}

type Navigate = (to: string) => void

/** An in-app link that routes client-side instead of doing a full page load. */
function Link({
	to,
	navigate,
	className,
	children,
}: {
	to: string
	navigate: Navigate
	className?: string
	children: ReactNode
}) {
	return (
		<a
			href={to}
			className={className}
			onClick={(e) => {
				e.preventDefault()
				navigate(to)
			}}
		>
			{children}
		</a>
	)
}

export function App() {
	// undefined = still checking the session; null = signed out.
	const [account, setAccount] = useState<SelfAccount | null | undefined>(undefined)
	// undefined until the config lands. Signup is treated as closed until told otherwise,
	// so a slow (or failed) config fetch can't flash a form the server would refuse.
	const [config, setConfig] = useState<SiteConfig | undefined>(undefined)
	const { path, navigate } = useRouter()

	useEffect(() => {
		// Config first, and everything else after it: it carries the hostnames every other
		// call needs. A config that doesn't land leaves the page signed out with signup
		// closed rather than guessing where the workers are.
		call<SiteConfig & { hosts: Hosts }>('/api/config')
			.then(async ({ hosts: resolved, ...site }) => {
				hosts = resolved
				setConfig(site)
				if (token === null) return setAccount(null)
				// A stored token that `accounts` rejects is stale — `call` has already dropped
				// it, so this just falls back to signed-out rather than surfacing an error.
				await fetchMe()
					.then(setAccount)
					.catch(() => setAccount(null))
			})
			.catch(() => {
				setConfig({ signupEnabled: false, turnstileSiteKey: null })
				setAccount(null)
			})
	}, [])

	// Nothing to tell a server: the access token is a stateless JWT, so dropping it here
	// IS the sign-out. (The refresh token auth issues alongside it is never stored, so a
	// closed session leaves nothing behind to redeem.)
	const logout = useCallback(() => {
		setToken(null)
		setAccount(null)
		navigate('/')
	}, [navigate])

	return (
		<>
			<NavBar account={account} path={path} navigate={navigate} onLogout={logout} />
			{path === '/login' || path === '/signup' ? (
				// One page, two doors. `/signup` exists so the homepage's create-account link
				// lands on that tab instead of dropping people on sign-in to find it — and so
				// the URL is linkable. Unknown paths fall back to index.html (see the assets
				// config in wrangler.jsonc), so a cold load of /signup reaches the SPA.
				<LoginPage
					account={account}
					config={config}
					initialTab={path === '/signup' ? 'signup' : 'login'}
					navigate={navigate}
					onAuthed={setAccount}
				/>
			) : path === '/account' ? (
				<AccountPage account={account} navigate={navigate} onChange={setAccount} />
			) : (
				<HomePage account={account} config={config} navigate={navigate} />
			)}
			<SiteFooter />
		</>
	)
}

/** Footer: where to go next, plus the affiliation disclaimer. */
function SiteFooter() {
	return (
		<footer className="footer">
			<span>
				<a href={LICENSE_URL} target="_blank" rel="noreferrer">
					MIT licensed
				</a>{' '}
				— made by fans, not affiliated with Rec Room Inc.
			</span>
			<nav>
				{/* A real navigation, not a client-side route: /privacy is rendered by the
				    Worker (see src/privacy.ts) so it reads without JavaScript. */}
				<a href="/privacy">Privacy</a>
				<a href={DISCORD_INVITE} target="_blank" rel="noreferrer">
					Discord
				</a>
				<a href={SOURCE_REPO} target="_blank" rel="noreferrer">
					GitHub
				</a>
			</nav>
		</footer>
	)
}

/** Top nav: brand → home, plus a sign-in / my-account link for the session. */
function NavBar({
	account,
	path,
	navigate,
	onLogout,
}: {
	account: SelfAccount | null | undefined
	path: string
	navigate: Navigate
	onLogout: () => void
}) {
	return (
		<header className="nav">
			<Link to="/" navigate={navigate} className="brand">
				Rug Room
			</Link>
			<nav className="nav-links">
				<a href={DISCORD_INVITE} target="_blank" rel="noreferrer">
					Discord
				</a>
				{account === undefined ? null : account ? (
					<>
						<Link to="/account" navigate={navigate} className={path === '/account' ? 'active' : ''}>
							My account
						</Link>
						<button className="linkish" onClick={onLogout}>
							Sign out
						</button>
					</>
				) : (
					<Link to="/login" navigate={navigate} className={path === '/login' ? 'active' : ''}>
						Sign in
					</Link>
				)}
			</nav>
		</header>
	)
}

/**
 * How many photos the hero asks the feed for. Explicit rather than left to the api's
 * default, since the count is a design decision here: the stage rotates one photo every
 * six seconds, so ten is a minute of it — long enough that a repeat visitor sees fresh
 * photos, short enough that the arrows stay walkable and the payload stays small.
 */
const SLIDESHOW_TAKE = 10

/** A recent public image plus who took it and where. */
interface Slide {
	url: string
	username: string
	roomName: string | null
}

/**
 * Loads the public photo feed once. `slides === null` means still in flight.
 *
 * Waits for the config, since the feed is served by the `api` worker — the same public
 * endpoint the game reads it from — and its hostname arrives with the config. Each entry
 * names an image; the browsable URL for it is on the `img` worker.
 */
function useSlideshow(config: SiteConfig | undefined) {
	const [slides, setSlides] = useState<Slide[] | null>(null)
	const [error, setError] = useState('')

	useEffect(() => {
		if (config === undefined) return
		type Feed = { Images?: Array<{ ImageName: string; Username: string; RoomName: string | null }> }
		// Wrapped in an async call rather than started directly, because `where()` THROWS
		// when the config didn't land — synchronously, which straight out of an effect
		// would take the page down instead of leaving an empty stage behind the fold.
		void (async () => {
			const h = where()
			const d = await call<Feed>(`${h.api}/api/images/v1/slideshow?take=${SLIDESHOW_TAKE}`)
			setSlides(
				(d.Images ?? []).map((i) => ({
					url: `${h.img}/${i.ImageName}`,
					username: i.Username,
					roomName: i.RoomName,
				}))
			)
		})().catch((e) => setError(e instanceof Error ? e.message : String(e)))
	}, [config])

	return { slides, error }
}

/**
 * Public homepage. The stage leads: photos players actually took, with the way in
 * on top of them. Everything about how the thing is built sits below, for whoever
 * scrolls looking for it.
 */
function HomePage({
	account,
	config,
	navigate,
}: {
	account: SelfAccount | null | undefined
	config: SiteConfig | undefined
	navigate: Navigate
}) {
	const feed = useSlideshow(config)

	// The signup offer only makes sense to a signed-out visitor when the server would
	// actually take one. `account === undefined` is still-checking, so it shows nothing
	// rather than offering an account to someone who already has one.
	const offerSignup = account === null && config?.signupEnabled === true

	return (
		<main>
			<Stage slides={feed.slides} offerSignup={offerSignup} navigate={navigate} />
			<div className="shell home">
				<About slides={feed.slides} error={feed.error} />
			</div>
		</main>
	)
}

/**
 * The hero: the headline and the way in on the left, a rotating in-game photo on the
 * right. The photo is proof, never the payload — when the feed is slow or down the
 * frame holds its space and the left half reads the same, so "Play now!" is reachable
 * either way.
 */
function Stage({
	slides,
	offerSignup,
	navigate,
}: {
	slides: Slide[] | null
	offerSignup: boolean
	navigate: Navigate
}) {
	const [idx, setIdx] = useState(0)
	const count = slides?.length ?? 0

	// A timeout keyed on the current slide rather than one long-lived interval: steering
	// by hand re-arms it, so a photo you just picked gets its full six seconds.
	useEffect(() => {
		if (count < 2) return
		const t = setTimeout(() => setIdx((i) => (i + 1) % count), 6000)
		return () => clearTimeout(t)
	}, [count, idx])

	const slide = slides && slides.length > 0 ? slides[idx] : null
	const step = (by: number) => setIdx((i) => (i + by + count) % count)

	return (
		<section className="stage">
			<div className="stage-body">
				{/* Deliberately doesn't name the game: this is a fan project, so the
				    trademark stays out of the headline and appears lower down, in
				    plain nominative use next to the disclaimer. */}
				<h1 className="stage-title">
					Play like it&apos;s <em>2023</em>.
				</h1>
				<p className="stage-lede">
					The servers you remember, rebuilt and running — free, open source, and up right now.
				</p>
				<div className="stage-actions">
					<a className="cta" href={DOWNLOAD_URL} target="_blank" rel="noreferrer">
						Download for PC
					</a>
					<a className="cta" href={QUEST_DOWNLOAD_URL} target="_blank" rel="noreferrer">
						Download for Quest
					</a>
					<a className="cta discord" href={DISCORD_INVITE} target="_blank" rel="noreferrer">
						Join the Discord
					</a>
				</div>
				{/* A line rather than a fourth button: the download is the point of this page,
				    and launching the game makes an account by itself — signing up here is the
				    way in for someone who wants one first. Hidden entirely when signup is
				    closed, matching /login, which hides its create-account tab the same way. */}
				{offerSignup && (
					<p className="stage-alt">
						New here?{' '}
						<Link to="/signup" navigate={navigate}>
							Create an account
						</Link>
					</p>
				)}
			</div>
			<div className="stage-show">
				<div className="stage-frame">
					{slide && (
						<img
							className="stage-photo"
							key={slide.url}
							src={slide.url}
							alt={`Photo taken in game by ${slide.username}`}
						/>
					)}
				</div>
				{/* Always mounted, so the frame doesn't shift down when the feed lands. */}
				<div className="stage-foot">
					{slide && (
						<span className="credit">
							Photo by @{slide.username}
							{slide.roomName && ` in ${slide.roomName}`}
						</span>
					)}
					{/* Arrows and a count, not a dot per photo: a dot each is wide enough to
					    shove the headline's half of the split off the page, and it would have
					    to be rebuilt the moment SLIDESHOW_TAKE grows. */}
					{count > 1 && (
						<span className="steer">
							<button onClick={() => step(-1)} aria-label="Previous photo">
								<Chevron />
							</button>
							<span className="count">
								{idx + 1} / {count}
							</span>
							<button onClick={() => step(1)} aria-label="Next photo">
								<Chevron next />
							</button>
						</span>
					)}
				</div>
			</div>
		</section>
	)
}

/** The slideshow's back/forward mark. Decorative — the buttons carry the label. */
function Chevron({ next }: { next?: boolean }) {
	return (
		<svg viewBox="0 0 24 24" width="16" height="16" aria-hidden="true" focusable="false">
			<path
				d={next ? 'M9 5l7 7-7 7' : 'M15 5l-7 7 7 7'}
				fill="none"
				stroke="currentColor"
				strokeWidth="2.2"
				strokeLinecap="round"
				strokeLinejoin="round"
			/>
		</svg>
	)
}

/** What Rug Room is, under the fold, for whoever wants it. */
function About({ slides, error }: { slides: Slide[] | null; error: string }) {
	// The feed answering is proof the server replied, so the indicator can't claim
	// the server is up when it isn't.
	const state = slides !== null ? 'online' : error ? 'down' : 'checking'

	return (
		<section className="about">
			<div>
				<h2 className="about-title">Rug Room is a 2023 Rec Room revival bringing back the experiences, creativity, and community that defined an unforgettable era.</h2>
				<p className="about-lede">
					A free fan project, made by players who missed it. Aiming to be{' '}
					<strong>feature-complete</strong> and infinitely scalable —{' '}
					<strong>architected for the cloud</strong>, no gatekeeping, no basement server.
				</p>
			</div>
			<div className="about-side">
				<div className="about-links">
					<a className="cta ghost" href={SOURCE_REPO} target="_blank" rel="noreferrer">
						View the source
					</a>
				</div>
				<div className="status-block">
					<p className={`status ${state}`}>
						<span className="dot" />
						{state === 'online'
							? 'Servers are up'
							: state === 'down'
								? "Can't reach the servers"
								: 'Checking…'}
					</p>
					{/* Only when it's actually up: when it isn't, people want the status, not the joke. */}
					{state === 'online' && <p className="status-quip">The cloud never goes down, right?</p>}
				</div>
			</div>
		</section>
	)
}

/**
 * The sign-in page — sign in, plus create-account when the server says signup is open
 * (it needs a Turnstile keypair; see SiteConfig). Redirects to the account page once a
 * session exists, however it was obtained.
 */
function LoginPage({
	account,
	config,
	initialTab,
	navigate,
	onAuthed,
}: {
	account: SelfAccount | null | undefined
	config: SiteConfig | undefined
	initialTab: 'signup' | 'login'
	navigate: Navigate
	onAuthed: (a: SelfAccount) => void
}) {
	// The tab IS the route (`/login` vs `/signup`) rather than local state, so the two can
	// never disagree — switching tabs pushes history, and back goes back to the other one.
	const tab = initialTab

	useEffect(() => {
		if (account) navigate('/account')
	}, [account, navigate])

	const authed = (a: SelfAccount) => {
		onAuthed(a)
		navigate('/account')
	}

	const siteKey = config?.signupEnabled ? config.turnstileSiteKey : null

	return (
		<main className="shell">
			<section className="card">
				{siteKey && (
					<div className="tabs">
						<button className={tab === 'login' ? 'active' : ''} onClick={() => navigate('/login')}>
							Sign in
						</button>
						<button
							className={tab === 'signup' ? 'active' : ''}
							onClick={() => navigate('/signup')}
						>
							Create account
						</button>
					</div>
				)}
				{siteKey && tab === 'signup' ? (
					<>
						<h2>Create account</h2>
						<p className="muted">
							A username is assigned for you — you&apos;ll see it on your account page. Choose a
							password, and the two together sign you in here and in the game.
						</p>
						<SignupForm siteKey={siteKey} onAuthed={authed} />
					</>
				) : (
					<>
						<h2>Sign in</h2>
						<p className="muted">
							Use your username and password. Launching the game also creates an account, linked to
							your Steam ID — set a password on it and it signs in here too.
						</p>
						<LoginForm onAuthed={authed} />
						{/* The tabs above already offer this; the line under the button is where
						    someone who just found out they have no account is actually looking.
						    Gated on the same key, so it can't point at a door that isn't there. */}
						{siteKey && (
							<p className="muted swap">
								Don&apos;t have an account?{' '}
								<Link to="/signup" navigate={navigate}>
									Create one
								</Link>
							</p>
						)}
					</>
				)}
			</section>
		</main>
	)
}

/** The signed-in account page. Redirects to sign-in when there's no session. */
function AccountPage({
	account,
	navigate,
	onChange,
}: {
	account: SelfAccount | null | undefined
	navigate: Navigate
	onChange: (a: SelfAccount) => void
}) {
	useEffect(() => {
		if (account === null) navigate('/login')
	}, [account, navigate])

	if (!account) {
		return (
			<main className="shell">
				<p className="muted">{account === undefined ? 'Loading…' : 'Redirecting…'}</p>
			</main>
		)
	}

	return (
		<main className="shell wide">
			<h1>My account</h1>
			<Dashboard account={account} onChange={onChange} />
		</main>
	)
}

/** Small hook wrapping a submit handler with pending/error/success state. */
function useAction() {
	const [pending, setPending] = useState(false)
	const [error, setError] = useState('')
	const [done, setDone] = useState('')

	const run = useCallback(async (fn: () => Promise<string>) => {
		setPending(true)
		setError('')
		setDone('')
		try {
			setDone(await fn())
		} catch (err) {
			setError(err instanceof Error ? err.message : String(err))
		} finally {
			setPending(false)
		}
	}, [])

	return { pending, error, done, run }
}

/**
 * Turnstile's browser API, as much of it as the signup widget uses. Loaded from
 * Cloudflare at runtime (see loadTurnstile) rather than bundled, so it isn't in
 * node_modules and has no types of its own.
 */
interface TurnstileApi {
	render: (
		el: HTMLElement,
		opts: {
			sitekey: string
			action?: string
			callback?: (token: string) => void
			'expired-callback'?: () => void
		}
	) => string | undefined
	reset: (widgetId?: string) => void
	remove: (widgetId?: string) => void
}

declare global {
	interface Window {
		turnstile?: TurnstileApi
	}
}

/**
 * Load Turnstile's script, once per page, resolving when `window.turnstile` is ready.
 * `render=explicit` stops it scanning the document for widgets: this is a SPA, so the
 * container mounts and unmounts with the form and we render into it ourselves.
 *
 * The promise is cached at module scope, so switching tabs back and forth reuses the
 * loaded script instead of appending another tag. A rejection is cached too — the retry
 * is a page reload, which is what the error message asks for.
 */
let turnstileScript: Promise<void> | null = null
function loadTurnstile(): Promise<void> {
	turnstileScript ??= new Promise<void>((resolve, reject) => {
		const el = document.createElement('script')
		el.src = 'https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit'
		el.async = true
		el.defer = true
		el.onload = () => resolve()
		el.onerror = () => reject(new Error('load failed'))
		document.head.appendChild(el)
	})
	return turnstileScript
}

/**
 * Mount a Turnstile widget and hand back the token it produces. No token means no
 * submit: the BFF refuses a signup without one, so the form gates its button on it
 * rather than letting the request fail.
 *
 * `reset` re-arms the widget for another attempt — a token is single-use, so a rejected
 * signup can't be retried with the same one.
 */
function useTurnstile(siteKey: string) {
	const container = useRef<HTMLDivElement | null>(null)
	const widgetId = useRef<string | undefined>(undefined)
	const [token, setToken] = useState('')
	const [error, setError] = useState('')

	useEffect(() => {
		let live = true
		loadTurnstile()
			.then(() => {
				// StrictMode mounts twice, and the cleanup below removes the first widget; bail
				// if this effect is the stale one so we don't render into a detached container.
				if (!live || !container.current || !window.turnstile) return
				widgetId.current = window.turnstile.render(container.current, {
					sitekey: siteKey,
					// Marker Cloudflare uses to segment Turnstile integrations; carries no user data.
					action: 'turnstile-spin-v1',
					callback: (t) => setToken(t),
					// Tokens expire after a few minutes; drop ours so the button locks again and
					// Turnstile can hand us a fresh one.
					'expired-callback': () => setToken(''),
				})
			})
			.catch(() => {
				if (live) setError("Couldn't load the bot check — reload the page to try again.")
			})

		return () => {
			live = false
			if (widgetId.current) window.turnstile?.remove(widgetId.current)
			widgetId.current = undefined
		}
	}, [siteKey])

	const reset = useCallback(() => {
		setToken('')
		if (widgetId.current) window.turnstile?.reset(widgetId.current)
	}, [])

	return { container, token, error, reset }
}

/**
 * Create an account from the website: a password, plus a Turnstile token proving a human
 * filled the form. The username comes back auto-assigned from `auth` (players don't pick
 * one), and the session is live on success — so this lands on the account page, where the
 * username is shown.
 */
function SignupForm({
	siteKey,
	onAuthed,
}: {
	siteKey: string
	onAuthed: (a: SelfAccount) => void
}) {
	const [password, setPassword] = useState('')
	const [email, setEmail] = useState('')
	const { container, token: widgetToken, error: widgetError, reset } = useTurnstile(siteKey)
	const { pending, error, run } = useAction()

	return (
		<form
			onSubmit={(e) => {
				e.preventDefault()
				void run(async () => {
					const wanted = email.trim()

					try {
						await signUp(password, widgetToken)
					} catch (err) {
						// The widget token is spent either way, so re-arm before they retry. Only
						// a failed signup gets here — past this point the account exists, and a
						// retry would spend another slot against auth's per-IP cap.
						reset()
						throw err
					}

					// Saved with the new session's own token: `create_account` takes no email,
					// `accounts` owns the field. Deliberately not fatal — the account exists and
					// the session is live, and the same field is one call away on the account
					// page.
					if (wanted !== '') await saveEmail(wanted).catch(() => {})

					// The session is already stored, so a failure here isn't one they can act on
					// by retrying: a reload finds them signed in.
					const me = await fetchMe().catch(() => {
						throw new Error(
							'Your account was created, but loading it failed. Reload the page — you are already signed in.'
						)
					})
					onAuthed(me)
					return ''
				})
			}}
		>
			<label>
				Password
				<input
					type="password"
					value={password}
					autoComplete="new-password"
					onChange={(e) => setPassword(e.target.value)}
					required
				/>
			</label>
			{/* Optional, and the button doesn't wait on it — but it's the only contact detail
			    an account has, so the hint says plainly what it's for rather than leaving it
			    to be guessed. `type="email"` gets the right keyboard on mobile and a free
			    format check; the worker re-checks it before the account is created. */}
			<label>
				Email <span className="optional">optional</span>
				<input
					type="email"
					value={email}
					autoComplete="email"
					onChange={(e) => setEmail(e.target.value)}
				/>
				<span className="hint">
					How you get back in if you forget your password — there&apos;s no other way to reach you.
					You can add it later on your account page.
				</span>
			</label>
			<div className="turnstile" ref={container} />
			{widgetError && <p className="error">{widgetError}</p>}
			{error && <p className="error">{error}</p>}
			<button type="submit" disabled={pending || widgetToken === ''}>
				{pending ? 'Creating…' : 'Create account'}
			</button>
		</form>
	)
}

function LoginForm({ onAuthed }: { onAuthed: (a: SelfAccount) => void }) {
	const [username, setUsername] = useState('')
	const [password, setPassword] = useState('')
	const { pending, error, run } = useAction()

	return (
		<form
			onSubmit={(e) => {
				e.preventDefault()
				void run(async () => {
					await signIn(username, password)
					onAuthed(await fetchMe())
					return ''
				})
			}}
		>
			<label>
				Username
				<input
					type="text"
					value={username}
					autoComplete="username"
					onChange={(e) => setUsername(e.target.value)}
					required
				/>
			</label>
			<label>
				Password
				<input
					type="password"
					value={password}
					autoComplete="current-password"
					onChange={(e) => setPassword(e.target.value)}
					required
				/>
			</label>
			{error && <p className="error">{error}</p>}
			<button type="submit" disabled={pending}>
				{pending ? 'Signing in…' : 'Sign in'}
			</button>
		</form>
	)
}

function Dashboard({
	account,
	onChange,
}: {
	account: SelfAccount
	onChange: (a: SelfAccount) => void
}) {
	// The dashboard sections, shown one at a time via the left tab rail. Admin-only
	// sections are appended when the session carries an admin role.
	const sections = [
		{
			id: 'username',
			label: 'Username',
			render: () => <UsernameForm account={account} onChange={onChange} />,
		},
		{
			id: 'email',
			label: 'Email',
			render: () => <EmailForm account={account} onChange={onChange} />,
		},
		{ id: 'password', label: 'Password', render: () => <PasswordForm /> },
                                        { id: 'online-players', label: 'Online Players', render: () => <OnlinePlayersForm /> },
		...(isAdmin()
			? [
					{ id: 'maintenance', label: 'Server maintenance', render: () => <MaintenanceForm /> },
					{ id: 'coach', label: 'Broadcast message', render: () => <CoachMessageForm /> },
				]
			: []),
	]
	const [active, setActive] = useState(sections[0].id)
	const current = sections.find((s) => s.id === active) ?? sections[0]

	return (
		<>
			<section className="card identity">
				<div className="muted">Signed in as</div>
				<div className="big">{account.displayName || account.username}</div>
				<div className="handle">
					@{account.username} · #{account.accountId} · {account.email ?? 'no email set'}
				</div>
			</section>
			<div className="workspace">
				<nav className="vtabs">
					{sections.map((s) => (
						<button
							key={s.id}
							className={s.id === active ? 'active' : ''}
							onClick={() => setActive(s.id)}
						>
							{s.label}
						</button>
					))}
				</nav>
				<div className="panel">{current.render()}</div>
			</div>
		</>
	)
}

/** Admin-only: send a coach/system message to every online player. */
function OnlinePlayersForm() {
        const [players, setPlayers] = useState<OnlinePlayer[]>([])
        const [loading, setLoading] = useState(true)
        const [error, setError] = useState('')

        const load = useCallback(async () => {
                setLoading(true)
                setError('')

                try {
                        const result = await fetchOnlinePlayers()
                        setPlayers(result.players ?? [])
                } catch (e) {
                        setError(e instanceof Error ? e.message : 'Failed to load online players.')
                } finally {
                        setLoading(false)
                }
        }, [])

        useEffect(() => {
                void load()
        }, [load])

        return (
                <section className="card">
                        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: '1rem' }}>
                                <div>
                                        <h2>Online Players</h2>
                                        <p className="muted">
                                                Players with an active presence right now.
                                        </p>
                                </div>

                                <button type="button" onClick={() => void load()} disabled={loading}>
                                        {loading ? 'Refreshing…' : 'Refresh'}
                                </button>
                        </div>

                        {error && <p className="error">{error}</p>}

                        {!loading && !error && (
                                <>
                                        <p className="big">
                                                {players.length} online player{players.length === 1 ? '' : 's'}
                                        </p>

                                        {players.length === 0 ? (
                                                <p className="muted">Nobody is currently online.</p>
                                        ) : (
                                                <div>
                                                        {players.map((player) => (
                                                                <div
                                                                        key={player.accountId}
                                                                        style={{
                                                                                display: 'flex',
                                                                                justifyContent: 'space-between',
                                                                                alignItems: 'center',
                                                                                padding: '0.75rem 0',
                                                                                borderBottom: '1px solid rgba(255,255,255,0.08)',
                                                                        }}
                                                                >
                                                                        <div>
                                                                                <strong>
                                                                                        {player.displayName || player.username}
                                                                                </strong>
                                                                                <div className="muted">
                                                                                        @{player.username}
                                                                                </div>
                                                                                <div className="muted">
                                                                                        Room: {player.roomName}
                                                                                </div>
                                                                        </div>

                                                                        <div style={{ textAlign: 'right' }}>
                                                                                <strong>{player.roomName}</strong>
                                                                                <div className="muted">
                                                                                        #{player.accountId}
                                                                                </div>
                                                                        </div>
                                                                </div>
                                                        ))}
                                                </div>
                                        )}
                                </>
                        )}
                </section>
        )
}

function CoachMessageForm() {
	const [message, setMessage] = useState('')
	const { pending, error, done, run } = useAction()

	return (
		<section className="card">
			<h2>Broadcast message</h2>
			<p className="muted">
				Send a message from the Coach to every connected player. Players who aren&apos;t online
				won&apos;t receive it.
			</p>
			<form
				onSubmit={(e) => {
					e.preventDefault()
					void run(async () => {
						const { sent } = await coachMessageAll(message.trim())
						setMessage('')
						return `Sent to ${sent ?? 0} online player${sent === 1 ? '' : 's'}.`
					})
				}}
			>
				<label>
					Message
					<textarea
						value={message}
						rows={3}
						onChange={(e) => setMessage(e.target.value)}
						required
					/>
				</label>
				{error && <p className="error">{error}</p>}
				{done && <p className="ok">{done}</p>}
				<button type="submit" disabled={pending}>
					{pending ? 'Sending…' : 'Send to all online'}
				</button>
			</form>
		</section>
	)
}

/** Admin-only: broadcast a server-maintenance countdown to every connected client. */
function MaintenanceForm() {
	const [minutes, setMinutes] = useState('5')
	const { pending, error, done, run } = useAction()

	return (
		<section className="card">
			<h2>Server maintenance</h2>
			<p className="muted">
				Broadcast a maintenance countdown to every connected client. Enter how many minutes until
				maintenance starts (0 = now).
			</p>
			<form
				onSubmit={(e) => {
					e.preventDefault()
					void run(async () => {
						// Coerced the way the worker used to: a blank or negative box means "now".
						const asked = Number(minutes)
						const startsIn = Number.isFinite(asked) && asked > 0 ? Math.floor(asked) : 0
						const { delivered: connections } = await broadcastMaintenance(startsIn)
						return `Notified ${connections ?? 0} connected client${connections === 1 ? '' : 's'}.`
					})
				}}
			>
				<label>
					Starts in (minutes)
					<input
						type="number"
						min="0"
						step="1"
						value={minutes}
						onChange={(e) => setMinutes(e.target.value)}
						required
					/>
				</label>
				{error && <p className="error">{error}</p>}
				{done && <p className="ok">{done}</p>}
				<button type="submit" disabled={pending}>
					{pending ? 'Broadcasting…' : 'Broadcast maintenance'}
				</button>
			</form>
		</section>
	)
}

/**
 * Change the account's username — the name used to sign in, here and in the game.
 *
 * Changes are rationed (an account starts with one), so the count is stated up front and
 * the form locks itself once none are left rather than letting someone spend the attempt
 * finding out. The server is still the one that decides: an unknown count leaves the form
 * open, and a name taken since the page loaded is refused upstream.
 *
 * The response is the caller's whole self account, re-read after the write, so the
 * remaining count on screen is the stored one and not a guess.
 */
function UsernameForm({
	account,
	onChange,
}: {
	account: SelfAccount
	onChange: (a: SelfAccount) => void
}) {
	const [username, setUsername] = useState(account.username)
	const { pending, error, done, run } = useAction()

	const remaining = account.availableUsernameChanges
	const spent = remaining !== undefined && remaining <= 0
	// Retyping the current name would be refused upstream anyway ("already taken" is
	// waived for your own name, but it would still spend a change).
	const unchanged = username.trim() === account.username

	return (
		<section className="card">
			<h2>Username</h2>
			<p className="muted">
				What you sign in with, here and in the game — and what other players see you by.
			</p>
			<form
				onSubmit={(e) => {
					e.preventDefault()
					void run(async () => {
						const updated = await changeUsername(username.trim())
						onChange(updated)
						setUsername(updated.username)
						return `You are now @${updated.username}.`
					})
				}}
			>
				<label>
					Username
					<input
						type="text"
						value={username}
						autoComplete="username"
						disabled={spent}
						onChange={(e) => setUsername(e.target.value)}
						required
					/>
					<span className="hint">
						{remaining === undefined
							? 'Changing your username uses up one of a limited number of changes.'
							: spent
								? 'You have no username changes remaining, so this can no longer be changed.'
								: `You have ${remaining} username change${remaining === 1 ? '' : 's'} remaining — this one is permanent once used.`}
					</span>
				</label>
				{error && <p className="error">{error}</p>}
				{done && <p className="ok">{done}</p>}
				<button type="submit" disabled={pending || spent || unchanged}>
					{pending ? 'Changing…' : 'Change username'}
				</button>
			</form>
		</section>
	)
}

function EmailForm({
	account,
	onChange,
}: {
	account: SelfAccount
	onChange: (a: SelfAccount) => void
}) {
	const [email, setEmail] = useState(account.email ?? '')
	const { pending, error, done, run } = useAction()

	return (
		<section className="card">
			<h2>Email</h2>
			<form
				onSubmit={(e) => {
					e.preventDefault()
					void run(async () => {
						await saveEmail(email.trim())
						onChange({ ...account, email })
						return 'Email saved.'
					})
				}}
			>
				<label>
					Email address
					<input
						type="email"
						value={email}
						autoComplete="email"
						onChange={(e) => setEmail(e.target.value)}
						required
					/>
				</label>
				{error && <p className="error">{error}</p>}
				{done && <p className="ok">{done}</p>}
				<button type="submit" disabled={pending}>
					{pending ? 'Saving…' : 'Save email'}
				</button>
			</form>
		</section>
	)
}

function PasswordForm() {
	const [oldPassword, setOldPassword] = useState('')
	const [newPassword, setNewPassword] = useState('')
	const { pending, error, done, run } = useAction()

	return (
		<section className="card">
			<h2>Password</h2>
			<form
				onSubmit={(e) => {
					e.preventDefault()
					void run(async () => {
						await changePassword(oldPassword, newPassword)
						setOldPassword('')
						setNewPassword('')
						return 'Password changed.'
					})
				}}
			>
				<label>
					Current password
					<input
						type="password"
						value={oldPassword}
						autoComplete="current-password"
						onChange={(e) => setOldPassword(e.target.value)}
						required
					/>
				</label>
				<label>
					New password
					<input
						type="password"
						value={newPassword}
						autoComplete="new-password"
						onChange={(e) => setNewPassword(e.target.value)}
						required
					/>
				</label>
				{error && <p className="error">{error}</p>}
				{done && <p className="ok">{done}</p>}
				<button type="submit" disabled={pending}>
					{pending ? 'Updating…' : 'Change password'}
				</button>
			</form>
		</section>
	)
}
