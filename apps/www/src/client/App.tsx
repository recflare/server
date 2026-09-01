import { useCallback, useEffect, useRef, useState } from 'react'

import { Accessibility } from '@repo/domain/src/enums'
import { GAME_VERSION } from '@repo/domain/src/presence-db'

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
	rooms: string
	cdn: string
	storage: string
}

/**
 * Site config from `www`. `signupEnabled` is false when the operator has no Turnstile
 * keypair configured — web signup runs behind that bot check, so without it the endpoint
 * is closed and the UI must not offer the form.
 */
interface SiteConfig {
	signupEnabled: boolean
	turnstileSiteKey: string | null
	/**
	 * Whether the Discord-verified benefits claim is configured. False when the operator
	 * has no Discord app/guild/role set, in which case the claim page and its links stay
	 * hidden — the endpoint would refuse anyway.
	 */
	benefitsEnabled: boolean
	/**
	 * The Discord consent URL to send the player to, assembled by `www` (scopes and the
	 * redirect URI are its business, and must match what the claim will accept). Null when
	 * benefits are off. The `state` nonce is appended here — see `startDiscordAuth`.
	 */
	discordAuthorizeUrl: string | null
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
 * One subroom, as `rooms` re-attaches them to every room read. A room is a container;
 * the subrooms are the actual places players load into, each with its own accessibility
 * and its own save history.
 */
interface SubRoom {
	SubRoomId: number
	Name: string
	/** Set INDEPENDENTLY of the room's — a public room can hold a private subroom. */
	Accessibility: number
	IsSandbox: boolean
	MaxPlayers: number
	/** The subroom's scene-data key, served back by `cdn` under `room/`. */
	DataBlob?: string
	/**
	 * A save posted without `AutoPublish` waits here. Cleared when that save is
	 * published, so a non-null value means "edited since players last saw a change".
	 */
	StagedSubRoomDataSaveId: number | null
	/**
	 * What players actually load. Null until the first publish — and a subroom without
	 * one silently loads nothing, which is worth surfacing to an owner who can't tell
	 * that apart from a broken room.
	 */
	CurrentSave: {
		SubRoomDataSaveId: number
		CreatedAt: string
		Description: string
		/**
		 * The scene-data key for the published save — what the client downloads to load
		 * the place, and the file worth keeping a copy of. `subRoomDataBlob()` resolves
		 * this one first, ahead of the subroom's own.
		 */
		DataBlob: string
	} | null
}

/**
 * One room from `rooms` (`GET /rooms/ownedby/me`), narrowed to what these pages draw.
 * The worker serves the stored room blob verbatim — dozens of fields the game needs and
 * the website doesn't — so only the ones read here are declared.
 */
interface OwnedRoom {
	RoomId: number
	Name: string
	Description: string
	/** A key on the `img` worker; a room with no image of its own gets the fallback. */
	ImageName: string
	/** The `Accessibility` ordinal, NOT the enum name — see ACCESSIBILITY_LABEL. */
	Accessibility: number
	CreatedAt: string
	MaxPlayers: number
	/** False blocks `POST /rooms/{id}/clone` — nobody can take a copy of the room. */
	CloningAllowed: boolean
	SupportsScreens: boolean
	SupportsWalkVR: boolean
	SupportsTeleportVR: boolean
	SupportsQuest2: boolean
	SupportsMobile: boolean
	SupportsJuniors: boolean
	/** `Type` 0 is a tag the owner set, 2 one the server derived. */
	Tags: Array<{ Tag: string; Type: number }>
	SubRooms: SubRoom[]
	/** Always present: the worker folds the live counters in on every read. */
	Stats: {
		CheerCount: number
		FavoriteCount: number
		VisitorCount: number
		VisitCount: number
	}
}

/**
 * What an `Accessibility` ordinal is called on screen — rooms and subrooms both carry
 * one. The two dev values are reachable (the game sets them), so they're named rather
 * than left to fall through to the unknown case in `accessibilityLabel`.
 */
const ACCESSIBILITY_LABEL: Record<number, string> = {
	[Accessibility.Private]: 'Private',
	[Accessibility.Public]: 'Public',
	[Accessibility.Unlisted]: 'Unlisted',
	[Accessibility.Dev_only]: 'Dev only',
	[Accessibility.Dev_Unlisted]: 'Dev unlisted',
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
	/**
	 * A multipart body — what `storage`'s `/upload` takes, since it carries a file. Passed
	 * to `fetch` as-is: the browser writes the `content-type` itself, because only it
	 * knows the boundary it generated.
	 */
	multipart?: FormData
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
	let body: string | FormData | undefined
	if (opts.form) {
		headers['content-type'] = 'application/x-www-form-urlencoded'
		body = new URLSearchParams(opts.form).toString()
	} else if (opts.json !== undefined) {
		headers['content-type'] = 'application/json'
		body = JSON.stringify(opts.json)
	} else if (opts.multipart) {
		// Deliberately no content-type: setting one would omit the boundary.
		body = opts.multipart
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
 * The caller's own rooms, from the `rooms` worker — the same list the game's "My Rooms"
 * loads. `ownedby/me` rather than `createdby/me`: the dorm is auto-provisioned, not a
 * room the player made, and it's the one room they can't do anything with from here.
 *
 * The worker deliberately does NOT filter on accessibility for this list, so a room that
 * has never been published shows up — which is the point, since that's the one its owner
 * is most likely to be looking for.
 *
 * Sorted newest-first here rather than upstream: the query has no ORDER BY (D1 hands
 * back insertion order, which is not a promise), and the room someone just made is the
 * one they came to see.
 */
async function fetchMyRooms(): Promise<OwnedRoom[]> {
	const rooms = await call<OwnedRoom[]>(`${where().rooms}/rooms/ownedby/me`, { authed: true })
	// A bare array is the contract; anything else is treated as "no rooms" rather than
	// thrown, since `.sort` on a non-array would surface as an unreadable TypeError.
	if (!Array.isArray(rooms)) return []
	// ISO-8601 timestamps, so lexical order IS chronological order.
	return [...rooms].sort((a, b) => (a.CreatedAt < b.CreatedAt ? 1 : -1))
}

/**
 * The `UploadFileType` a room's scene data is posted under. `storage` maps this to the
 * `room/` subfolder of the CDN bucket — the one prefix `cdn`'s `GET /room/:dataBlob`
 * reads back, and so the only one a `DataBlob` key can point into.
 */
const FILE_TYPE_ROOM_SAVE = '1'

/**
 * The game build this server targets, as `YYYY-MM-DD` — read from the same `GAME_VERSION`
 * the auth token and presence carry rather than written out again here, so upgrading the
 * client moves this line with it instead of leaving a stale date on the upload form.
 *
 * It's shown because a scene blob is only loadable by the build that wrote it (or older
 * ones that understand it): a save taken out of a room built on a later version can fail
 * outright, and nothing between here and the game says why.
 */
const CLIENT_BUILD_DATE = `${GAME_VERSION.slice(0, 4)}-${GAME_VERSION.slice(4, 6)}-${GAME_VERSION.slice(6, 8)}`

/**
 * Upload a scene blob to `storage` and return the key it was stored under — the
 * `<date>/<uuid>` name every `DataBlob` field holds.
 *
 * This is the same two-step the game does: the bytes go to `storage` first, and only its
 * generated name is handed to `rooms`. Nothing about the file is inspected here — a room
 * blob is an opaque Unity payload, and the server doesn't parse it either, so the only
 * honest validation available is whether the game can load it afterwards.
 */
async function uploadRoomBlob(file: File): Promise<string> {
	const form = new FormData()
	form.set('FileType', FILE_TYPE_ROOM_SAVE)
	form.set('File', file)
	const { filename } = await call<{ filename?: string }>(`${where().storage}/upload`, {
		method: 'POST',
		multipart: form,
		authed: true,
	})
	if (!filename) throw new Error('The storage worker accepted the file but returned no name.')
	return filename
}

/**
 * The blob's SHA-256, base64 — the encoding this API's hash fields use (an invention's
 * `BlobHash` comes back the same way). `rooms` only echoes it back on the save, but a
 * save whose hash doesn't describe its blob is worse than one carrying none.
 */
async function blobHash(file: File): Promise<string> {
	const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', await file.arrayBuffer()))
	let binary = ''
	for (const byte of digest) binary += String.fromCharCode(byte)
	return btoa(binary)
}

/**
 * Record a room save against one subroom, pointing it at an already-uploaded blob.
 *
 * `AutoPublish` decides whether players see it now or whether it waits on the room's
 * publish step, exactly as it does for the game — the site doesn't get its own rule.
 * The envelope answers HTTP 200 either way and puts the refusal in `error`, so success
 * has to be read from the body rather than the status. `value.room` is the updated room,
 * which the page re-renders from rather than re-fetching the whole list.
 */
async function saveSubRoomBlob(
	roomId: number,
	subRoomId: number,
	input: { filename: string; hash: string; description: string; autoPublish: boolean }
): Promise<OwnedRoom> {
	const res = await call<{
		success?: boolean
		error?: string | null
		value?: { room?: OwnedRoom } | null
	}>(`${where().rooms}/rooms/${roomId}/subrooms/${subRoomId}/data`, {
		method: 'POST',
		authed: true,
		json: {
			SubRoomData: { Filename: input.filename, Hash: input.hash },
			Description: input.description,
			AutoPublish: input.autoPublish,
		},
	})
	if (res.success !== true) {
		throw new Error(res.error || 'The rooms worker refused the save.')
	}
	const room = res.value?.room
	if (!room) throw new Error('The save was recorded but the room came back empty.')
	return room
}

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

/** Where this account's benefits stand: `www` reads them off the account row. */
interface BenefitsStatus {
	/** Whether the account already has Rec Room Plus. */
	hasPlus: boolean
	/** Whether a Discord identity is already tied to it. Which one is deliberately not served. */
	linked: boolean
}

/**
 * The two ends of the benefits claim. Both live on `www` rather than on one of the game
 * workers, because the claim needs the Discord client secret — see www.app.ts.
 */
const fetchBenefitsStatus = (): Promise<BenefitsStatus> =>
	call<BenefitsStatus>('/api/benefits/status', { authed: true })

/** Redeem the code Discord sent us back with. The access token never reaches this page. */
const claimBenefits = (code: string): Promise<{ discordUsername?: string }> =>
	call<{ discordUsername?: string }>('/api/benefits/claim', { json: { code }, authed: true })

/**
 * The per-attempt CSRF nonce for the Discord round-trip, in sessionStorage.
 *
 * OAuth's `state` only means anything if the same page that minted it is the one that
 * checks it, so it can't come from the server. sessionStorage rather than localStorage:
 * it belongs to this tab and this attempt, and it should not outlive the tab that started
 * the flow.
 */
const OAUTH_STATE_KEY = 'rf_discord_state'

/**
 * Send the browser to Discord's consent screen.
 *
 * A real navigation, not a client-side route — Discord is another origin. The `state` is
 * minted here and stashed for the return leg; `www` built everything else about the URL
 * (see `/api/config`), so this only ever appends the one parameter it owns.
 */
function startDiscordAuth(authorizeUrl: string) {
	const state = crypto.randomUUID()
	sessionStorage.setItem(OAUTH_STATE_KEY, state)
	const url = new URL(authorizeUrl)
	url.searchParams.set('state', state)
	window.location.assign(url.toString())
}

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

/**
 * The same coach message to ONE player. `notify` queues it when they're offline, so
 * `queued` (rather than a 0 delivery) is what "they weren't online" looks like here —
 * it still arrives on their next connect, unlike the broadcast.
 */
const coachMessage = (
	playerId: number,
	messageContent: string
): Promise<{ delivered?: number; queued?: boolean }> =>
	call<{ delivered?: number; queued?: boolean }>(`${where().notify}/internal/coach-message`, {
		json: { playerId, messageContent },
		authed: true,
	})

/**
 * Resolve an `@username` to the account id the workers address a player by.
 *
 * `accounts` serves no exact-name lookup, so this goes through the PREFIX search and
 * keeps only an exact (case-insensitive) hit: a prefix match is a different player, and
 * sending a message to whoever happened to sort first would be worse than refusing. The
 * exact name always sorts first among its own prefixes, so it's inside the search limit
 * whenever it exists.
 */
async function accountIdForUsername(input: string): Promise<number> {
	const name = input.trim().replace(/^@/, '')
	if (name === '') throw new Error('Enter a username to send to.')
	const matches = await call<Array<{ accountId?: number; username?: string }>>(
		`${where().accounts}/account/search?name=${encodeURIComponent(name)}`
	)
	const found = Array.isArray(matches)
		? matches.find((m) => m.username?.toLowerCase() === name.toLowerCase())
		: undefined
	if (typeof found?.accountId !== 'number') throw new Error(`There's no player called @${name}.`)
	return found.accountId
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

/**
 * The benefits claim itself: where the player stands, and the button that starts (or
 * re-runs) the Discord round-trip.
 *
 * This is BOTH ends of the OAuth round-trip: it sends the player to Discord, and it is
 * what renders when Discord sends them back. Which half is running is decided by whether
 * the URL carries a `code`.
 *
 * What it never holds is a Discord access token. It forwards the one-time `code` to
 * `www`, which does the exchange with the client secret and answers with a verdict; that
 * is the whole reason this one feature has a server side at all.
 *
 * Rendered in TWO places, which is why it is a component rather than a page. Its home is
 * the "Claim benefits" tab in the account dashboard, where someone would go looking for
 * it. But it also has to render on `/claim`, because that path is Discord's registered
 * redirect URI — the browser comes back to it with a `?code=`, and it is the only URL a
 * cold load can land on mid-flow. One component means the two can't drift.
 *
 * The effect keys off whether the URL carries a code, so the same code covers both: on
 * the dashboard there is none, and it just reports status.
 */
function BenefitsPanel({ account, config }: { account: SelfAccount; config: SiteConfig }) {
	const [status, setStatus] = useState<BenefitsStatus | undefined>(undefined)
	const [error, setError] = useState('')
	const [done, setDone] = useState('')
	const [pending, setPending] = useState(false)
	// Shown after a successful claim only. Plus rides on the game's token as `rn.plus`,
	// stamped at login, so the copy of it the player is holding still says they have none —
	// and tokens last a day and are never refreshed. Without this line the claim looks like
	// it silently did nothing, which is the single most likely support question here.
	const [relogin, setRelogin] = useState(false)
	// StrictMode runs effects twice in dev, and a Discord code is single-use: the second
	// run would redeem a spent code and report a failure over a claim that just worked.
	const redeemed = useRef(false)

	useEffect(() => {
		const params = new URLSearchParams(window.location.search)
		const code = params.get('code')
		const state = params.get('state')
		const expected = sessionStorage.getItem(OAUTH_STATE_KEY)

		if (code === null) {
			// Nothing came back from Discord — either the dashboard tab, or `/claim` opened
			// directly. Just show where they stand. Discord also returns with
			// `?error=access_denied` when someone cancels: no code, nothing to say, and the
			// button is right there to try again.
			void fetchBenefitsStatus()
				.then(setStatus)
				.catch(() => setStatus(undefined))
			return
		}

		// The return leg. Strip the query first, whatever happens next: the code is spent by
		// the request below, so a reload must not carry it (and a code has no business
		// sitting in the address bar, or in whatever the player pastes it into). replaceState
		// rather than a route change, so Back doesn't walk into a used code either.
		window.history.replaceState(null, '', '/claim')
		if (redeemed.current) return
		redeemed.current = true
		sessionStorage.removeItem(OAUTH_STATE_KEY)

		// The nonce this tab minted must be the one that came back. A mismatch means the
		// round-trip wasn't started here, which is exactly what `state` exists to catch.
		if (state === null || expected === null || state !== expected) {
			setError('That Discord sign-in did not match this browser. Please start again.')
			return
		}

		setPending(true)
		claimBenefits(code)
			.then((result) => {
				setStatus({ hasPlus: true, linked: true })
				setDone(
					result.discordUsername
						? `Verified as ${result.discordUsername} — Rec Room Plus is now on your account.`
						: 'Verified — Rec Room Plus is now on your account.'
				)
				setRelogin(true)
			})
			.catch((err: unknown) => setError(err instanceof Error ? err.message : String(err)))
			.finally(() => setPending(false))
	}, [])

	// Read into a local so the narrowing survives into the click handlers below.
	const authorizeUrl = config.discordAuthorizeUrl
	if (!config.benefitsEnabled || authorizeUrl === null) {
		return (
			<section className="card">
				<h2>Claim benefits</h2>
				<p className="muted">Benefit claims aren’t available on this server right now.</p>
			</section>
		)
	}

	const claimed = status?.hasPlus === true

	return (
		<section className="card">
			<h2>Rec Room Plus</h2>
			<p className="muted">
				Members of our Discord with a supporter role get Rec Room Plus on their account. Verify with
				Discord and we’ll check your roles — we only ever read your username and which roles you
				hold in our server.
			</p>
			<p className="muted">
				Claiming as <strong>@{account.username}</strong> (#{account.accountId}). A Discord account
				can claim on one RecFlare account only.
			</p>

			{error && <p className="error">{error}</p>}
			{done && <p className="ok">{done}</p>}
			{relogin && (
				<p className="hint">
					Restart Rec Room and sign in again to pick it up — your game reads Rec Room Plus from the
					session it signed in with, so it won’t show until then.
				</p>
			)}

			{pending ? (
				<p className="muted">Checking your Discord roles…</p>
			) : claimed ? (
				// Already claimed. The button stays, because a player whose roles changed (or who
				// re-linked) can safely run it again — the claim is idempotent on their own
				// account — but it no longer reads as the thing to do.
				<>
					{!done && (
						<>
							<p className="ok">Rec Room Plus is active on this account.</p>
							<p className="hint">
								If the game doesn’t show it, sign out and back in — Rec Room Plus is read from the
								session your game signed in with.
							</p>
						</>
					)}
					<button className="linkish" onClick={() => startDiscordAuth(authorizeUrl)}>
						Re-verify with Discord
					</button>
				</>
			) : (
				<button
					type="button"
					className="cta discord"
					onClick={() => startDiscordAuth(authorizeUrl)}
				>
					Verify with Discord
				</button>
			)}
		</section>
	)
}

/**
 * `/claim` — the page Discord redirects back to.
 *
 * Not linked from anywhere any more: the claim lives in the account dashboard's "Claim
 * benefits" tab. This route still has to exist and still has to work on a cold load,
 * because it is the app's registered `redirect_uri` — the browser arrives here from
 * Discord carrying the `?code=`, with whatever session it has.
 *
 * Signing in comes FIRST, and not only because the grant needs an account to land on: the
 * bearer token is what tells `www` whose row to write, so a claim without one has no
 * subject. Hence the sign-in card rather than a redirect — someone who arrives here from a
 * link should be told what this is before being bounced to a login form.
 */
function ClaimPage({
	account,
	config,
	navigate,
}: {
	account: SelfAccount | null | undefined
	config: SiteConfig | undefined
	navigate: Navigate
}) {
	if (account === undefined || config === undefined) {
		return (
			<main className="shell">
				<p className="muted">Loading…</p>
			</main>
		)
	}

	if (account === null) {
		return (
			<main className="shell">
				<h1>Claim your benefits</h1>
				<section className="card">
					<h2>Sign in first</h2>
					<p className="muted">
						Benefits are granted to a RecFlare account, so we need to know which one is yours before
						you verify with Discord. If you were part-way through a claim, start it again from your
						account page once you’re signed in.
					</p>
					<Link to="/login" navigate={navigate} className="cta">
						Sign in
					</Link>
				</section>
			</main>
		)
	}

	return (
		<main className="shell">
			<h1>Claim your benefits</h1>
			<BenefitsPanel account={account} config={config} />
		</main>
	)
}

/**
 * The room id in `/rooms/<id>`, or null for any other path. Numeric rather than the
 * room's name: a name is renameable (`PUT /rooms/{id}/name`), so a link someone
 * bookmarked would rot the moment they renamed the room.
 */
function roomIdFromPath(path: string): number | null {
	const match = /^\/rooms\/(\d+)$/.exec(path)
	return match ? Number.parseInt(match[1], 10) : null
}

export function App() {
	// undefined = still checking the session; null = signed out.
	const [account, setAccount] = useState<SelfAccount | null | undefined>(undefined)
	// undefined until the config lands. Signup is treated as closed until told otherwise,
	// so a slow (or failed) config fetch can't flash a form the server would refuse.
	const [config, setConfig] = useState<SiteConfig | undefined>(undefined)
	const { path, navigate } = useRouter()
	const roomId = roomIdFromPath(path)

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
				setConfig({
					signupEnabled: false,
					turnstileSiteKey: null,
					benefitsEnabled: false,
					discordAuthorizeUrl: null,
				})
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
				<AccountPage account={account} config={config} navigate={navigate} onChange={setAccount} />
			) : path === '/claim' ? (
				// Its own page rather than a dashboard tab: this path is Discord's registered
				// redirect URI, so it has to be one stable URL a cold load can land on.
				<ClaimPage account={account} config={config} navigate={navigate} />
			) : roomId !== null ? (
				<RoomPage account={account} roomId={roomId} navigate={navigate} />
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
				RecFlare
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
					Play <em>today</em>!
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

/** What RecFlare is, under the fold, for whoever wants it. */
function About({ slides, error }: { slides: Slide[] | null; error: string }) {
	// The feed answering is proof the server replied, so the indicator can't claim
	// the server is up when it isn't.
	const state = slides !== null ? 'online' : error ? 'down' : 'checking'

	return (
		<section className="about">
			<div>
				<h2 className="about-title">A cloud architected server for the 2023/2025 game clients</h2>
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
	config,
	navigate,
	onChange,
}: {
	account: SelfAccount | null | undefined
	config: SiteConfig | undefined
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
			<Dashboard account={account} config={config} navigate={navigate} onChange={onChange} />
		</main>
	)
}

/**
 * One room's own page — what it is, how it's set up, and the subrooms inside it.
 *
 * The room is found in the caller's OWN list rather than read from the public
 * `GET /rooms?id=`, which is unfiltered by design (the game looks any room up that way).
 * Going through `ownedby/me` is what makes this the owner's page: a room that isn't
 * yours simply isn't in the list, so there's no second ownership rule here to drift out
 * of step with the one the mutating endpoints enforce.
 */
function RoomPage({
	account,
	roomId,
	navigate,
}: {
	account: SelfAccount | null | undefined
	roomId: number
	navigate: Navigate
}) {
	const [rooms, setRooms] = useState<OwnedRoom[] | null>(null)
	const [error, setError] = useState('')
	const accountId = account?.accountId

	useEffect(() => {
		if (account === null) navigate('/login')
	}, [account, navigate])

	useEffect(() => {
		// Waits for the session: the list is auth-gated, and `account === undefined` only
		// means the stored token hasn't been checked yet.
		if (accountId === undefined) return
		void fetchMyRooms()
			.then(setRooms)
			.catch((e) => setError(e instanceof Error ? e.message : String(e)))
	}, [accountId])

	if (!account) {
		return (
			<main className="shell">
				<p className="muted">{account === undefined ? 'Loading…' : 'Redirecting…'}</p>
			</main>
		)
	}

	const room = rooms?.find((r) => r.RoomId === roomId)

	return (
		<main className="shell wide">
			<p className="backlink">
				<Link to="/account" navigate={navigate}>
					← My rooms
				</Link>
			</p>
			{error ? (
				<p className="error">{error}</p>
			) : rooms === null ? (
				<p className="muted">Loading…</p>
			) : room === undefined ? (
				// Covers both "no such room" and "someone else's" — deliberately the same
				// sentence, since telling a stranger which of the two it is answers a question
				// they have no business asking.
				<p className="muted">That isn&apos;t one of your rooms.</p>
			) : (
				<RoomDetail
					room={room}
					imgHost={where().img}
					cdnHost={where().cdn}
					// A save answers with the whole updated room, so swapping it into the list
					// is enough — no re-fetch, and the other rooms keep their place.
					onRoomChange={(updated) =>
						setRooms((current) =>
							(current ?? []).map((r) => (r.RoomId === updated.RoomId ? updated : r))
						)
					}
				/>
			)}
		</main>
	)
}

/** The platforms a room says it supports, named the way the game names them. */
function platformList(room: OwnedRoom): string[] {
	const on: string[] = []
	if (room.SupportsScreens) on.push('Screens')
	if (room.SupportsWalkVR) on.push('VR (walk)')
	if (room.SupportsTeleportVR) on.push('VR (teleport)')
	if (room.SupportsQuest2) on.push('Quest 2')
	if (room.SupportsMobile) on.push('Mobile')
	if (room.SupportsJuniors) on.push('Juniors')
	return on
}

/**
 * A room's settings and its subrooms. Its own fields are read-only — rooms are edited in
 * game — with one exception: a subroom's scene data can be replaced from here, which is
 * the one thing the game gives an owner no way to do (it can only save what it just
 * built, never restore a file they kept).
 */
function RoomDetail({
	room,
	imgHost,
	cdnHost,
	onRoomChange,
}: {
	room: OwnedRoom
	imgHost: string
	cdnHost: string
	onRoomChange: (room: OwnedRoom) => void
}) {
	const created = new Date(room.CreatedAt)
	const platforms = platformList(room)
	const subRooms = room.SubRooms ?? []

	return (
		<>
			<section className="card room-hero">
				{/* 512 rather than the list's 256: this one is displayed large. Both are sizes
				    the img worker allows, so each is a cached variant. */}
				<img className="room-hero-img" src={`${imgHost}/${room.ImageName}?width=512`} alt="" />
				<div className="room-hero-body">
					<div className="room-head">
						<h1 className="room-hero-name">^{room.Name}</h1>
						<VisibilityBadge accessibility={room.Accessibility} />
					</div>
					{room.Description ? (
						<p className="muted room-hero-desc">{room.Description}</p>
					) : (
						<p className="muted room-hero-desc">No description set.</p>
					)}
					<p className="room-stats">
						{room.Stats.VisitCount.toLocaleString()} visit
						{room.Stats.VisitCount === 1 ? '' : 's'} · {room.Stats.FavoriteCount.toLocaleString()}{' '}
						favourite
						{room.Stats.FavoriteCount === 1 ? '' : 's'} · {room.Stats.CheerCount.toLocaleString()}{' '}
						cheer{room.Stats.CheerCount === 1 ? '' : 's'}
					</p>
				</div>
			</section>

			<section className="card">
				<h2>Settings</h2>
				<dl className="facts">
					<dt>Room id</dt>
					<dd>{room.RoomId}</dd>
					<dt>Visibility</dt>
					<dd>{accessibilityLabel(room.Accessibility)}</dd>
					<dt>Max players</dt>
					<dd>{room.MaxPlayers}</dd>
					<dt>Cloning</dt>
					<dd>
						{room.CloningAllowed ? 'Anyone may clone this room' : 'Nobody may clone this room'}
					</dd>
					<dt>Plays on</dt>
					<dd>
						{platforms.length > 0 ? platforms.join(', ') : 'Nothing — no platform is enabled'}
					</dd>
					<dt>Tags</dt>
					<dd>{room.Tags?.length ? room.Tags.map((t) => t.Tag).join(', ') : 'None'}</dd>
					<dt>Created</dt>
					<dd>{Number.isNaN(created.getTime()) ? room.CreatedAt : created.toLocaleDateString()}</dd>
				</dl>
			</section>

			<section className="card">
				<h2>Subrooms</h2>
				<p className="muted">
					The places inside the room players actually load into. Each keeps its own accessibility
					and its own saves, so a public room can still hold a subroom nobody else can reach.
				</p>
				{subRooms.length === 0 ? (
					<p className="muted">This room has no subrooms.</p>
				) : (
					<ul className="subrooms">
						{subRooms.map((sub) => (
							<SubRoomRow
								key={sub.SubRoomId}
								sub={sub}
								roomId={room.RoomId}
								roomName={room.Name}
								cdnHost={cdnHost}
								onRoomChange={onRoomChange}
							/>
						))}
					</ul>
				)}
			</section>
		</>
	)
}

/** One subroom: what it is, and — the part an owner can't see anywhere else — its save. */
function SubRoomRow({
	sub,
	roomId,
	roomName,
	cdnHost,
	onRoomChange,
}: {
	sub: SubRoom
	roomId: number
	roomName: string
	cdnHost: string
	onRoomChange: (room: OwnedRoom) => void
}) {
	const save = sub.CurrentSave ?? null
	const saved = save ? new Date(save.CreatedAt) : null
	// Cleared when that save is published (see publishSubRoomSave), so a value here always
	// means work the owner saved but players still can't see.
	const staged = sub.StagedSubRoomDataSaveId !== null && sub.StagedSubRoomDataSaveId !== undefined
	const name = sub.Name || `Subroom ${sub.SubRoomId}`

	return (
		<li className="subroom">
			<div className="room-head">
				<span className="subroom-name">{name}</span>
				<VisibilityBadge accessibility={sub.Accessibility} />
				{sub.IsSandbox && <span className="badge">Sandbox</span>}
			</div>
			<p className="subroom-meta">
				#{sub.SubRoomId} · up to {sub.MaxPlayers} players
			</p>
			<p className="subroom-save">
				{save === null ? (
					// A subroom with no published save loads an empty scene without erroring, which
					// from the inside looks exactly like a broken room. Say so plainly.
					<span className="warn">Never published — players load an empty scene.</span>
				) : (
					<>
						Published save #{save.SubRoomDataSaveId}
						{saved && !Number.isNaN(saved.getTime()) && `, saved ${saved.toLocaleString()}`}
						{save.Description && ` — “${save.Description}”`}
					</>
				)}
				{staged && (
					<span className="warn"> · a newer save is staged, waiting to be published.</span>
				)}
			</p>
			{/* The published save's blob first: that's the copy of the room worth keeping,
			    and the one the client resolves ahead of the subroom's own key. */}
			{save?.DataBlob && (
				<BlobDownload
					label="Save DataBlob"
					blobKey={save.DataBlob}
					filename={safeFilename(roomName, name, `save-${save.SubRoomDataSaveId}`)}
					cdnHost={cdnHost}
				/>
			)}
			{sub.DataBlob && (
				<BlobDownload
					label="Subroom DataBlob"
					blobKey={sub.DataBlob}
					filename={safeFilename(roomName, name, 'datablob')}
					cdnHost={cdnHost}
				/>
			)}
			<BlobUpload roomId={roomId} subRoomId={sub.SubRoomId} onRoomChange={onRoomChange} />
		</li>
	)
}

/**
 * Replace one subroom's scene data with a file from disk.
 *
 * The two steps are the game's own: the bytes go to `storage` under the RoomSave type,
 * and the key it hands back is posted to the subroom's `…/data` route as
 * `SubRoomData.Filename`. So this is a room save like any other — it lands in the
 * subroom's history beside the ones the game wrote, and both endpoints are already gated
 * on the room's creator (or a co-owner), which is why there is no ownership check here:
 * the page only lists rooms that came back from `ownedby/me` in the first place.
 *
 * Publishing is offered rather than assumed. A save normally only STAGES — players keep
 * loading the last published version until the owner publishes — and quietly making an
 * uploaded file live would be a bigger step than the game's own save takes. Left on by
 * default all the same: someone uploading a blob here is restoring a room, and a restore
 * nobody can see isn't one.
 */
function BlobUpload({
	roomId,
	subRoomId,
	onRoomChange,
}: {
	roomId: number
	subRoomId: number
	onRoomChange: (room: OwnedRoom) => void
}) {
	const [file, setFile] = useState<File | null>(null)
	const [description, setDescription] = useState('')
	const [publish, setPublish] = useState(true)
	// The file input is uncontrolled — React can't set its value — so clearing the picked
	// file after a save takes a handle on the element itself.
	const input = useRef<HTMLInputElement>(null)
	const { pending, error, done, run } = useAction()

	return (
		<form
			className="blob-upload"
			onSubmit={(e) => {
				e.preventDefault()
				if (!file) return
				void run(async () => {
					const [filename, hash] = await Promise.all([uploadRoomBlob(file), blobHash(file)])
					onRoomChange(
						await saveSubRoomBlob(roomId, subRoomId, {
							filename,
							hash,
							description: description.trim(),
							autoPublish: publish,
						})
					)
					setFile(null)
					setDescription('')
					if (input.current) input.current.value = ''
					return publish
						? 'Uploaded and published — players load this scene now.'
						: 'Uploaded and staged. Publish it in game to make it live.'
				})
			}}
		>
			{/* Said out loud, on the control itself: this is the newest thing on the site and
			    the only one that overwrites what players load. Someone about to hand us a file
			    they can't get back should read that before the file picker, not after. */}
			<p className="blob-upload-head">
				<span className="blob-upload-title">Replace scene data</span>
				<span className="badge beta">Beta</span>
			</p>
			<p className="muted blob-upload-caveat">
				New and lightly tested. Nothing here checks the file — the server stores whatever it is and
				the game finds out on load. This server runs the {CLIENT_BUILD_DATE} build, so scene data
				from a room built on anything newer may not load at all. Download the save above and keep it
				before replacing it.
			</p>
			<label className="blob-upload-file">
				Scene data file
				<input
					ref={input}
					type="file"
					onChange={(e) => setFile(e.target.files?.[0] ?? null)}
					required
				/>
			</label>
			<label className="blob-upload-note">
				Save comment<span className="optional">optional</span>
				<input
					type="text"
					value={description}
					placeholder="Uploaded from the website"
					maxLength={200}
					onChange={(e) => setDescription(e.target.value)}
				/>
			</label>
			<label className="check">
				<input type="checkbox" checked={publish} onChange={(e) => setPublish(e.target.checked)} />
				Publish it straight away
			</label>
			{error && <p className="error">{error}</p>}
			{done && <p className="ok">{done}</p>}
			<button type="submit" disabled={pending || file === null}>
				{pending ? 'Uploading…' : 'Upload scene data'}
			</button>
		</form>
	)
}

/**
 * A download filename built from player-supplied names, with everything that isn't a
 * word character, dot or dash flattened to a dash — a subroom can be called anything,
 * and that string is about to become a path on someone's disk.
 */
const safeFilename = (...parts: string[]): string =>
	`${parts.join('-').replace(/[^\w.-]+/g, '-')}.bin`

/**
 * One scene-data blob: the key, and a link that downloads it from `cdn`.
 *
 * `href` is the real CDN URL, so open-in-new-tab and right-click → Save As work like any
 * other link. The click is intercepted only to give the file a NAME: blobs are stored
 * under a date-foldered UUID, so three downloads otherwise land as three
 * indistinguishable extensionless files. The `download` attribute can't do that on its
 * own — browsers ignore it cross-origin, and `cdn` is always a different origin from the
 * website — hence fetching the bytes and saving them through an object URL.
 */
function BlobDownload({
	label,
	blobKey,
	filename,
	cdnHost,
}: {
	label: string
	blobKey: string
	filename: string
	cdnHost: string
}) {
	// Room build data is served under `room/` — the same prefix the storage worker
	// uploads it to, and the one the game downloads it from.
	const url = `${cdnHost}/room/${blobKey}`
	const [pending, setPending] = useState(false)
	const [error, setError] = useState('')

	const download = async () => {
		setPending(true)
		setError('')
		try {
			const res = await fetch(url)
			// The blob key is stored on the subroom, so a miss here means the object is gone
			// from the bucket — worth saying, rather than saving a file of the 404 body.
			if (!res.ok) throw new Error(`the CDN answered ${res.status}`)
			const href = URL.createObjectURL(await res.blob())
			const link = document.createElement('a')
			link.href = href
			link.download = filename
			link.click()
			// The click is dispatched synchronously but the save reads the URL after this
			// frame, so the revoke waits a tick rather than pulling it out from under.
			setTimeout(() => URL.revokeObjectURL(href), 0)
		} catch (e) {
			setError(e instanceof Error ? e.message : String(e))
		} finally {
			setPending(false)
		}
	}

	return (
		<div className="blob">
			<span className="blob-label">{label}</span>
			<a
				className="blob-key"
				href={url}
				download={filename}
				onClick={(e) => {
					e.preventDefault()
					void download()
				}}
			>
				{blobKey}
			</a>
			{/* Only rendered when it has something to say — an empty span would still take a
			    gap from the flex row, leaving the key trailed by a stray space. */}
			{pending ? (
				<span className="blob-note">Downloading…</span>
			) : error ? (
				<span className="blob-note error">Couldn’t download — {error}.</span>
			) : null}
		</div>
	)
}

/** How a room or subroom's `Accessibility` reads on screen. */
const accessibilityLabel = (accessibility: number): string =>
	// Unknown ordinals shouldn't happen, but this label is the only thing telling an owner
	// whether a room is visible — so show the raw value rather than nothing at all.
	ACCESSIBILITY_LABEL[accessibility] ?? `Accessibility ${accessibility}`

/**
 * The visibility pill. Public gets the same green "healthy" reading as the server
 * status; every other value stays neutral, since Private is a choice, not a fault.
 */
function VisibilityBadge({ accessibility }: { accessibility: number }) {
	return (
		<span className={`badge ${accessibility === Accessibility.Public ? 'live' : ''}`}>
			{accessibilityLabel(accessibility)}
		</span>
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
	config,
	navigate,
	onChange,
}: {
	account: SelfAccount
	config: SiteConfig | undefined
	navigate: Navigate
	onChange: (a: SelfAccount) => void
}) {
	// The dashboard sections, shown one at a time via the left tab rail. Admin-only
	// sections are appended when the session carries an admin role.
	const sections = [
		// First, so a player who just signed in lands on what they made rather than on a
		// settings form they opened the page to avoid.
		{ id: 'rooms', label: 'My rooms', render: () => <MyRooms navigate={navigate} /> },
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
		// Only when the operator has Discord configured — otherwise the panel has nothing to
		// offer and the tab is a promise the server can't keep. The claim also still lives at
		// /claim, because that URL is Discord's registered redirect and has to keep working.
		...(config?.benefitsEnabled
			? [
					{
						id: 'benefits',
						label: 'Claim benefits',
						render: () => <BenefitsPanel account={account} config={config} />,
					},
				]
			: []),
		...(isAdmin()
			? [
					{ id: 'maintenance', label: 'Server maintenance', render: () => <MaintenanceForm /> },
					{ id: 'coach', label: 'Coach message', render: () => <CoachMessageForm /> },
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

/**
 * The rooms the signed-in player owns.
 *
 * Read-only on purpose: rooms are made and edited in game, and there is nothing here a
 * player could change that the game doesn't already own. What the web is better at is
 * the overview — everything you've made in one place, including the rooms you never
 * published, which are invisible everywhere else.
 */
function MyRooms({ navigate }: { navigate: Navigate }) {
	const [rooms, setRooms] = useState<OwnedRoom[] | null>(null)
	const [error, setError] = useState('')

	useEffect(() => {
		void fetchMyRooms()
			.then(setRooms)
			.catch((e) => setError(e instanceof Error ? e.message : String(e)))
	}, [])

	return (
		<section className="card">
			<h2>My rooms</h2>
			<p className="muted">
				Every room you&apos;ve made, newest first — unpublished ones included. Your dorm isn&apos;t
				here: it was made for you rather than by you.
			</p>
			{error ? (
				<p className="error">{error}</p>
			) : rooms === null ? (
				<p className="muted">Loading…</p>
			) : rooms.length === 0 ? (
				<p className="muted">
					You haven&apos;t made a room yet. Rooms are created in game — clone one you like, or start
					from a blank one in the Rec Center.
				</p>
			) : (
				// `where()` THROWS when the config never landed, and a throw in render takes the
				// page down (see useSlideshow). It can't here: this branch is only reached once
				// the fetch above resolved, and that fetch went through `where()` itself.
				<ul className="rooms">
					{rooms.map((room) => (
						<RoomCard key={room.RoomId} room={room} imgHost={where().img} navigate={navigate} />
					))}
				</ul>
			)}
		</section>
	)
}

/**
 * One room in the list: its thumbnail, what it's called in game (`^Name`), and how it's
 * doing. The whole row links to the room's own page.
 *
 * The thumbnail is asked for at 256px wide — one of the img worker's four allowed sizes,
 * so it's a cached variant rather than the full-size upload. A room with no image of its
 * own still answers 200 there (the worker serves its fallback), so there's no broken
 * frame to handle.
 */
function RoomCard({
	room,
	imgHost,
	navigate,
}: {
	room: OwnedRoom
	imgHost: string
	navigate: Navigate
}) {
	const created = new Date(room.CreatedAt)

	return (
		<li className="room">
			{/* A real `<a href>` (see Link), not a click handler on the row: it has to be
			    reachable by keyboard, and openable in a new tab like any other link. */}
			<Link to={`/rooms/${room.RoomId}`} navigate={navigate} className="room-link">
				<img
					className="room-thumb"
					src={`${imgHost}/${room.ImageName}?width=256`}
					alt=""
					loading="lazy"
				/>
				<div className="room-body">
					<div className="room-head">
						{/* The caret is how the game writes a room name, so it reads as the thing you
						    type to get there rather than as a title someone wrote. */}
						<span className="room-name">^{room.Name}</span>
						<VisibilityBadge accessibility={room.Accessibility} />
					</div>
					{room.Description && <p className="room-desc">{room.Description}</p>}
					<p className="room-stats">
						{room.Stats.VisitCount.toLocaleString()} visit
						{room.Stats.VisitCount === 1 ? '' : 's'} · {room.Stats.FavoriteCount.toLocaleString()}{' '}
						favourite
						{room.Stats.FavoriteCount === 1 ? '' : 's'} · {room.Stats.CheerCount.toLocaleString()}{' '}
						cheer{room.Stats.CheerCount === 1 ? '' : 's'}
						{!Number.isNaN(created.getTime()) && ` · made ${created.toLocaleDateString()}`}
					</p>
				</div>
			</Link>
		</li>
	)
}

/**
 * Admin-only: send a coach/system message, either to one player by `@username` or to
 * everyone online.
 *
 * The two go to different endpoints because they behave differently, not just in reach:
 * the broadcast is online-only (nothing holds a message with no addressee), while a named
 * recipient's message is queued by the hub and delivered whenever they next connect. The
 * recipient box therefore says which of those the operator is about to do.
 */
function CoachMessageForm() {
	const [recipient, setRecipient] = useState('')
	const [message, setMessage] = useState('')
	const { pending, error, done, run } = useAction()
	// The `@` is how the name is written, not part of it — accepted either way, shown back
	// with it, and sent without it.
	const handle = recipient.trim().replace(/^@/, '')
	const toOne = handle !== ''

	return (
		<section className="card">
			<h2>Coach message</h2>
			<p className="muted">
				Send a message from the Coach to one player, or leave the recipient blank to send it to
				every connected player. A broadcast reaches only who is online right now; a message to one
				player waits for them if they aren&apos;t.
			</p>
			<form
				onSubmit={(e) => {
					e.preventDefault()
					void run(async () => {
						const content = message.trim()
						if (!toOne) {
							const { sent } = await coachMessageAll(content)
							setMessage('')
							return `Sent to ${sent ?? 0} online player${sent === 1 ? '' : 's'}.`
						}
						// Resolved before sending: the workers address players by id, and a name that
						// matches nobody should be a refusal rather than a message into the void.
						const { queued } = await coachMessage(await accountIdForUsername(handle), content)
						setMessage('')
						return queued === true
							? `@${handle} is offline — it will arrive when they next connect.`
							: `Sent to @${handle}.`
					})
				}}
			>
				<label>
					Send to
					<input
						value={recipient}
						placeholder="@username — blank sends to everyone online"
						autoComplete="off"
						onChange={(e) => setRecipient(e.target.value)}
					/>
				</label>
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
					{pending ? 'Sending…' : toOne ? `Send to @${handle}` : 'Send to all online'}
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
