import { useCallback, useEffect, useState } from 'react'

import { DISCORD_INVITE, DOWNLOAD_URL, LICENSE_URL } from '../links'

import type { ReactNode } from 'react'

/** The self-account shape returned by the www BFF (`/api/me`, `/api/login`, …). */
interface SelfAccount {
	accountId: number
	username: string
	displayName: string
	email: string | null
	/** Whether this session may use admin controls (from the token's role claim). */
	isAdmin?: boolean
}

/**
 * Call a www BFF endpoint. GET when no body is given, else POST JSON. Throws with
 * the upstream error message (auth uses `error`/`error_description`, the account
 * mutations use `error`) so callers can surface it.
 */
async function api<T = unknown>(path: string, body?: unknown): Promise<T> {
	const res = await fetch(path, {
		method: body === undefined ? 'GET' : 'POST',
		headers: body === undefined ? undefined : { 'content-type': 'application/json' },
		body: body === undefined ? undefined : JSON.stringify(body),
	})
	const data = (await res.json().catch(() => ({}))) as Record<string, unknown>
	if (!res.ok) {
		const message =
			(typeof data.error === 'string' && data.error) ||
			(typeof data.error_description === 'string' && data.error_description) ||
			`Request failed (${res.status})`
		throw new Error(message)
	}
	return data as T
}

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
	const { path, navigate } = useRouter()

	useEffect(() => {
		api<SelfAccount>('/api/me')
			.then((me) => setAccount(me))
			.catch(() => setAccount(null))
	}, [])

	const logout = useCallback(async () => {
		await api('/api/logout', {})
		setAccount(null)
		navigate('/')
	}, [navigate])

	return (
		<>
			<NavBar account={account} path={path} navigate={navigate} onLogout={logout} />
			{path === '/login' ? (
				<LoginPage account={account} navigate={navigate} onAuthed={setAccount} />
			) : path === '/signup' ? (
                                <SignupPage navigate={navigate} onAuthed={setAccount} />
                        ) : path === '/account' ? (
				<AccountPage account={account} navigate={navigate} onChange={setAccount} />
			) : (
				<HomePage />
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

/** A recent public image plus who took it and where. */
interface Slide {
	url: string
	username: string
	roomName: string | null
}

/** Loads the public photo feed once. `slides === null` means still in flight. */
function useSlideshow() {
	const [slides, setSlides] = useState<Slide[] | null>(null)
	const [error, setError] = useState('')

	useEffect(() => {
		api<{ images: Slide[] }>('/api/slideshow')
			.then((d) => setSlides(d.images))
			.catch((e) => setError(e instanceof Error ? e.message : String(e)))
	}, [])

	return { slides, error }
}

/**
 * Public homepage. The stage leads: photos players actually took, with the way in
 * on top of them. Everything about how the thing is built sits below, for whoever
 * scrolls looking for it.
 */
function HomePage() {
	const feed = useSlideshow()

	return (
		<main>
			<Stage slides={feed.slides} />
			<div className="shell home">
				<About slides={feed.slides} error={feed.error} />
			</div>
		</main>
	)
}

/**
 * The hero: a rotating in-game photo with the headline and the way in over it. The
 * photo is the backdrop, never the payload — when the feed is slow or down the stage
 * still renders, so "Play now!" is reachable either way.
 */
function Stage({ slides }: { slides: Slide[] | null }) {
	const [idx, setIdx] = useState(0)

	useEffect(() => {
		if (!slides || slides.length < 2) return
		const t = setInterval(() => setIdx((i) => (i + 1) % slides.length), 6000)
		return () => clearInterval(t)
	}, [slides])

	const slide = slides && slides.length > 0 ? slides[idx] : null

	return (
		<section className="stage">
			{slide && (
				<img
					className="stage-photo"
					key={slide.url}
					src={slide.url}
					alt={`Photo taken in game by ${slide.username}`}
				/>
			)}
			<div className="stage-body">
				{/* Deliberately doesn't name the game: this is a fan project, so the
				    trademark stays out of the headline and appears lower down, in
				    plain nominative use next to the disclaimer. */}
				<h1 className="stage-title">
					Play like it&apos;s <em>2024</em>.
				</h1>
				<div className="stage-actions">
					<a className="cta" href={DOWNLOAD_URL} target="_blank" rel="noreferrer">
						Download for PC
					</a>
					<a className="cta discord" href={DISCORD_INVITE} target="_blank" rel="noreferrer">
						Join the Discord
					</a>
				</div>
			</div>
			{slide && (
				<div className="stage-foot">
					<span className="credit">
						Photo by @{slide.username}
						{slide.roomName && ` in ${slide.roomName}`}
					</span>
					{slides && slides.length > 1 && (
						<span className="dots">
							{slides.map((s, i) => (
								<button
									key={s.url}
									className={i === idx ? 'on' : ''}
									onClick={() => setIdx(i)}
									aria-label={`Show photo ${i + 1} of ${slides.length}`}
									aria-current={i === idx}
								/>
							))}
						</span>
					)}
				</div>
			)}
		</section>
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
				<h2 className="about-title">An Community Made Rec Room Revival, Made For the Community.</h2>
				<p className="about-lede">
					Rug Room is a 2024 build of Rec Room. It is completely free, and will always be free. No microtransactions ever.
				</p>
			</div>
			<div className="about-side">
				<div className="about-links">
					<a className="cta ghost" href="#" target="_blank" rel="noreferrer">
						View the source
					</a>
				</div>
				<div className="status-block">
					<p className={`status ${state}`}>
						<span className="dot" />
						{state === 'offline'
							? 'Servers are down'
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

/** The sign-in page. Redirects to the account page once a session exists. */
function LoginPage({
	account,
	navigate,
	onAuthed,
}: {
	account: SelfAccount | null | undefined
	navigate: Navigate
	onAuthed: (a: SelfAccount) => void
}) {
	useEffect(() => {
		if (account) navigate('/account')
	}, [account, navigate])

	return (
		<main className="shell">
			<section className="card">
				<h2>Sign in</h2>
				<p className="muted">
					Launch the game first — that creates an account linked to your Steam ID. Once you set a
					password, use your username and that password to sign in here.
				</p>
				<LoginForm
					onAuthed={(a) => {
						onAuthed(a)
						navigate('/account')
					}}
				/>
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

// Manual web signups are disabled for now, so only sign-in is exposed (accounts are
// created via the game/platform, not the website). To bring signups back, restore a
// SignupForm calling POST /api/signup and re-enable that endpoint in www.app.ts.
function LoginForm({ onAuthed }: { onAuthed: (a: SelfAccount) => void }) {
	const [username, setUsername] = useState('')
	const [password, setPassword] = useState('')
	const { pending, error, run } = useAction()

	return (
		<form
			onSubmit={(e) => {
				e.preventDefault()
				void run(async () => {
					const { account } = await api<{ account: SelfAccount }>('/api/login', {
						username,
						password,
					})
					onAuthed(account)
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
			id: 'email',
			label: 'Email',
			render: () => <EmailForm account={account} onChange={onChange} />,
		},
		{ id: 'password', label: 'Password', render: () => <PasswordForm /> },
		...(account.isAdmin
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
						const { sent } = await api<{ sent?: number }>('/api/coach-message', {
							messageContent: message,
						})
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
						const { connections } = await api<{ connections?: number }>('/api/maintenance', {
							startsInMinutes: Number(minutes),
						})
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
						await api('/api/email', { email })
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


function SignupPage({
        navigate,
        onAuthed,
}: {
        navigate: Navigate
        onAuthed: (a: SelfAccount) => void
}) {
        const [password, setPassword] = useState('')
        const { pending, error, run } = useAction()

        return (
                <main className="card">
                        <h1>Create account</h1>

                        <form
                                onSubmit={(e) => {
                                        e.preventDefault()

                                        void run(async () => {
                                                await api('/api/signup', {
                                                        password,
                                                })

                                                const me = await api<SelfAccount>('/api/me')
                                                onAuthed(me)
                                                navigate('/account')

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

                                {error && <p className="error">{error}</p>}

                                <button type="submit" disabled={pending}>
                                        {pending ? 'Creating…' : 'Create account'}
                                </button>
                        </form>
                </main>
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
						await api('/api/password', { oldPassword, newPassword })
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
