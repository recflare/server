import { useCallback, useEffect, useState } from 'react'

import { KickReportCategory } from '../../../notify/src/notification-payloads'
import { accountIdForUsername, call, isAdmin, useAction, usernamesFor } from './api'

import type { PublicAccount } from './api'

/**
 * The staff moderation panel, at `/moderation`.
 *
 * Its own file rather than another section of App.tsx: App renders this, so the shared
 * plumbing both need lives in api.ts (see the note there), and this is a whole surface
 * rather than one more form on the account dashboard.
 *
 * Everything here talks to `www`'s own `/api/staff/*` endpoints (see src/staff.ts) —
 * except the names, which come from `accounts`' bulk lookup, the same endpoint the game
 * uses. The staff reads return account IDS; a moderation table whose rows are numbers is
 * unreadable, and joining names on the server would tie those reads to a table another
 * worker owns.
 *
 * The `isAdmin()` gate below is cosmetic. It decodes the token's `role` claim without
 * verifying it, because a page holds no signing key — faking it reveals a table that
 * every endpoint behind it answers 403 to. `requireStaff` is the real gate.
 */

/** What the panel is showing. The player history is a drill-down from any of them. */
type Tab = 'queue' | 'search' | 'bans' | 'new'

const TABS: Array<{ id: Tab; label: string }> = [
	// Queue first: "who is a problem right now" is the question someone opens this page
	// with, where the search is what you use once you know who you're looking at.
	{ id: 'queue', label: 'Report queue' },
	{ id: 'search', label: 'Search reports' },
	{ id: 'bans', label: 'Standing bans' },
	{ id: 'new', label: 'File a report' },
]

const TAB_IDS = new Set<string>(TABS.map((t) => t.id))

/**
 * Which view a `/moderation/…` path names.
 *
 * Every one of these is a REAL URL rather than a piece of component state, so the back
 * button walks back out of a drill-down instead of leaving the panel — which is what it
 * did when the tab and the open player were held in `useState`: a moderator two clicks
 * deep pressed Back and landed on the homepage, losing the whole session. Along the way it
 * makes each view linkable, which is how one moderator hands another a player to look at.
 *
 * `/moderation` alone is the queue, so the nav link needs no tab in it and a bookmark of
 * the bare path still opens on something.
 */
type View =
	| { kind: 'tab'; tab: Tab }
	| { kind: 'player'; playerId: number }
	| { kind: 'ban'; reportId: number }

function viewForPath(path: string): View {
	const rest = path.replace(/^\/moderation\/?/, '').replace(/\/$/, '')
	if (rest === '') return { kind: 'tab', tab: 'queue' }

	const player = /^players\/(\d+)$/.exec(rest)
	if (player) return { kind: 'player', playerId: Number.parseInt(player[1]!, 10) }

	const ban = /^reports\/(\d+)\/ban$/.exec(rest)
	if (ban) return { kind: 'ban', reportId: Number.parseInt(ban[1]!, 10) }

	// An unknown segment falls back to the queue rather than rendering nothing: these paths
	// are typed and pasted, and a typo should land somewhere usable.
	return { kind: 'tab', tab: TAB_IDS.has(rest) ? (rest as Tab) : 'queue' }
}

/** Where a tab lives. The queue is the bare path, not `/moderation/queue`. */
const tabPath = (tab: Tab): string => (tab === 'queue' ? '/moderation' : `/moderation/${tab}`)

/**
 * A stored report, as `www` serves the row — snake_case, because it IS the row. Not every
 * column is rendered; the ones that are not (the measured heights, the instance type) are
 * kept in the type so a row can be passed around whole.
 */
interface ReportRow {
	id: number
	reporter_player_id: number
	reported_player_id: number
	report_category: number
	details: string | null
	room_id: number | null
	room_instance_type: string | null
	created_at: string
	banned: number
	ban_expires: string | null
	event_id: number | null
	invention_id: number | null
	custom_avatar_item_id: string | null
	banned_by_player_id: number | null
	banned_at: string | null
	chat_message_id: number | null
	/**
	 * Who lifted the ban that once stood on this row, and when — null until one is lifted,
	 * and cleared again by a re-ban. A lift wipes the four ban columns, so this pair is the
	 * only thing on the row that says a colleague decided this player belongs back in the
	 * game; without it the row reads as untouched and the next moderator bans them again.
	 */
	unbanned_by_player_id: number | null
	unbanned_at: string | null
}

/** A moderator-issued warning, as the `warning` table stores it. */
interface WarningRow {
	id: number
	moderator_player_id: number
	warned_player_id: number
	report_category: number
	display_reason: string | null
	moderator_note: string | null
	created_at: string
}

/** A row of the report queue — see `getTopReported`. */
interface ReportedPlayerTally {
	playerId: number
	reports: number
	distinctReporters: number
	lastReportAt: string
	bannedNow: boolean
}

/** An account a ban would also reach, and what links it — see `linkedAccounts`. */
interface LinkedAccount {
	accountId: number
	username: string | null
	via: 'platform' | 'ip'
	value: string
}

/**
 * What a report's category means, keyed off the client's own enum so a renumbering moves
 * these labels with it rather than leaving them quietly wrong.
 *
 * The names are the client's, made readable: `CoCSexual` is the code of conduct's sexual
 * content rule, and a moderator reading a table should not have to know that. An id with
 * no entry is shown as the bare number — the column is stored verbatim and unmapped (see
 * the report write), so a build that reports something new must not render a blank.
 */
const CATEGORY_LABEL: Record<number, string> = {
	[KickReportCategory.Moderator]: 'Moderator action',
	[KickReportCategory.Unknown]: 'Unspecified',
	[KickReportCategory.Harassment]: 'Harassment',
	[KickReportCategory.Cheating]: 'Cheating',
	[KickReportCategory.AFK]: 'Inactive (AFK)',
	[KickReportCategory.Misc]: 'Game conduct',
	[KickReportCategory.Underage]: 'Underage',
	[KickReportCategory.VoteKick]: 'Vote to kick',
	[KickReportCategory.MisleadingPurchases]: 'Misleading purchases',
	[KickReportCategory.CoCUnderage]: 'Underage (CoC)',
	[KickReportCategory.CoCSexual]: 'Sexual content',
	[KickReportCategory.CoCDiscrimination]: 'Discrimination',
	[KickReportCategory.CoCTrolling]: 'Griefing / trolling',
	[KickReportCategory.CoCNameOrProfile]: 'Name or profile',
	[KickReportCategory.InappropriateClothing]: 'Inappropriate clothing',
	[KickReportCategory.IssuingInaccurateReports]: 'Inaccurate reports',
}

/** The categories the file-a-report form offers, in the order it lists them. */
const FILEABLE_CATEGORIES = [
	KickReportCategory.CoCDiscrimination,
	KickReportCategory.CoCSexual,
	KickReportCategory.CoCTrolling,
	KickReportCategory.Harassment,
	KickReportCategory.CoCNameOrProfile,
	KickReportCategory.CoCUnderage,
	KickReportCategory.Cheating,
	KickReportCategory.InappropriateClothing,
	KickReportCategory.IssuingInaccurateReports,
	KickReportCategory.Misc,
]

const categoryLabel = (id: number): string => CATEGORY_LABEL[id] ?? `Category ${id}`

/** How many reports one page of search results holds. */
const PAGE_SIZE = 25

/**
 * A date as a moderator reads it — ISO 8601 in UTC, to the minute (`2026-09-25T13:04Z`).
 * Not local time: the moderators are in different countries, and a ban that expires
 * "01:04 PM" means a different instant to each of them and a different date on either
 * side of midnight. One unambiguous spelling, the same on every screen.
 */
function when(iso: string | null): string {
	if (iso === null) return '—'
	const parsed = Date.parse(iso)
	if (Number.isNaN(parsed)) return iso
	return new Date(parsed).toISOString().slice(0, 16) + 'Z'
}

/**
 * What a ban's expiry says on screen. A null expiry is permanent, not missing — the two
 * read identically as an empty cell, and confusing them is the difference between a
 * week's ban and a life one.
 */
const expiryLabel = (report: ReportRow): string =>
	report.banned !== 1 ? '—' : report.ban_expires === null ? 'Permanent' : when(report.ban_expires)

/**
 * A report whose ban a moderator LIFTED — as opposed to one nobody acted on, which the row
 * otherwise looks identical to. A standing ban is never "lifted": a re-ban clears the pair.
 */
const banLifted = (report: ReportRow): boolean => report.banned !== 1 && report.unbanned_at !== null

/**
 * "(lifted) by X" — shown wherever a lifted ban would otherwise pass for a clean report.
 * It is what stops a second moderator undoing the first one's decision without knowing
 * there was one: the row says who let the player back in, so the question goes to them
 * rather than straight back to the ban button. Just the who — when it was lifted is on
 * the row (`unbanned_at`) but not worth the width in a table cell.
 */
function LiftedBan({ report, names }: { report: ReportRow; names: Map<number, PublicAccount> }) {
	return (
		<>
			<span className="badge mod-lifted">lifted</span>{' '}
			<span className="muted">
				by{' '}
				{report.unbanned_by_player_id === null ? (
					'staff'
				) : (
					<PlayerName id={report.unbanned_by_player_id} names={names} />
				)}
			</span>
		</>
	)
}

/**
 * What kind of thing a report is against. The four id columns are mutually exclusive and
 * a row with none of them is an ordinary player report (see reports-db) — which is the
 * only way to tell the kinds apart, so it is worth a column of its own.
 */
function reportKind(report: ReportRow): string {
	if (report.event_id !== null) return 'Event'
	if (report.invention_id !== null) return 'Invention'
	if (report.custom_avatar_item_id !== null) return 'Avatar item'
	if (report.chat_message_id !== null) return 'Chat message'
	return 'Player'
}

/**
 * A player as `@name`. The id is in the title, not on screen: it costs width in every
 * cell of every table and staff can look it up when they need it. It IS shown while the
 * name is still loading or for an account with none, so a row is never nameless.
 */
function PlayerName({ id, names }: { id: number; names: Map<number, PublicAccount> }) {
	const account = names.get(id)
	return (
		<span className="mod-player" title={`#${id}`}>
			{account?.username ? `@${account.username}` : <span className="muted">#{id}</span>}
		</span>
	)
}

/**
 * The read of a staff endpoint, with the loading and failure states the panel renders.
 * `data === null` with no error means still in flight.
 *
 * A `null` path means "nothing to read yet" and holds whatever was last loaded — the
 * search uses it so the table doesn't clear itself between submissions. Re-reads when the
 * path changes (it carries the query string, so that covers every filter change) or when
 * a caller's dep does: the panel passes a revision counter it bumps after any write, so
 * banning someone refreshes whichever tables are on screen.
 */
function useStaffData<T>(path: string | null, deps: unknown[] = []) {
	const [data, setData] = useState<T | null>(null)
	const [error, setError] = useState('')

	useEffect(() => {
		if (path === null) return
		// Guards against the response of a superseded read landing after a newer one — two
		// filter changes in quick succession would otherwise render whichever finished last.
		let live = true
		setError('')
		call<T>(path, { authed: true })
			.then((result) => live && setData(result))
			.catch((err: unknown) => live && setError(err instanceof Error ? err.message : String(err)))
		return () => {
			live = false
		}
		// The caller's deps are spread in deliberately — the lint rule can't see through a
		// variable-length array, and `path` plus those deps is the whole trigger set.
		// oxlint-disable-next-line react-hooks/exhaustive-deps
	}, [path, ...deps])

	return { data, error }
}

/**
 * Names for every id a page of rows mentions, in one bulk lookup.
 *
 * Re-runs when the rows change, and holds the previous names while the next lookup is in
 * flight, so a table doesn't flash back to bare ids between pages.
 */
function useNames(ids: number[]) {
	const [names, setNames] = useState<Map<number, PublicAccount>>(new Map())
	const key = ids.join(',')

	useEffect(() => {
		if (key === '') return
		let live = true
		void usernamesFor(key.split(',').map(Number)).then((found) => {
			// Merged rather than replaced: the panel holds several tables, and a lookup for
			// one must not blank the names in another.
			if (live) setNames((prev) => new Map([...prev, ...found]))
		})
		return () => {
			live = false
		}
	}, [key])

	return names
}

export function ModerationPage({
	account,
	path,
	search,
	navigate,
}: {
	account: { accountId: number; username: string } | null | undefined
	/** The full pathname — the panel routes under `/moderation`; see {@link viewForPath}. */
	path: string
	/** The query string, where the search tab keeps its filters and its page. */
	search: string
	navigate: (to: string) => void
}) {
	const view = viewForPath(path)
	// Bumped after a write that leaves you where you are — lifting a ban from a table. A
	// write that NAVIGATES (banning, filing a report) needs no bump: the view it lands on
	// mounts fresh and reads for itself.
	const [revision, setRevision] = useState(0)
	const changed = useCallback(() => setRevision((n) => n + 1), [])
	const openPlayer = useCallback(
		(playerId: number) => navigate(`/moderation/players/${playerId}`),
		[navigate]
	)
	const openBan = useCallback(
		(report: ReportRow) => navigate(`/moderation/reports/${report.id}/ban`),
		[navigate]
	)

	if (account === undefined) {
		return (
			<main className="shell wide">
				<section className="card">
					<p className="muted">Checking your session…</p>
				</section>
			</main>
		)
	}

	if (account === null) {
		return (
			<main className="shell">
				<section className="card">
					<h1>Moderation</h1>
					<p className="muted">You need to be signed in to use the moderation tools.</p>
					<button onClick={() => navigate('/login')}>Sign in</button>
				</section>
			</main>
		)
	}

	// A signed-in player who isn't staff. Told plainly rather than shown a sign-in form:
	// signing in again would change nothing, and a 404 would just make them wonder.
	if (!isAdmin()) {
		return (
			<main className="shell">
				<section className="card">
					<h1>Moderation</h1>
					<p className="muted">
						This area is for moderators. Your account doesn&apos;t have the moderator or developer
						role.
					</p>
					<button onClick={() => navigate('/')}>Back to the homepage</button>
				</section>
			</main>
		)
	}

	return (
		<main className="shell mod">
			<section className="card identity">
				<div className="muted">Moderating as</div>
				<div className="big">@{account.username}</div>
				<div className="handle">
					#{account.accountId} · actions you take here are recorded against this account
				</div>
			</section>

			{view.kind === 'player' ? (
				<PlayerHistory
					playerId={view.playerId}
					revision={revision}
					navigate={navigate}
					onBan={openBan}
				/>
			) : view.kind === 'ban' ? (
				<BanDialog reportId={view.reportId} navigate={navigate} />
			) : (
				<div className="workspace">
					<nav className="vtabs">
						{TABS.map((t) => (
							<button
								key={t.id}
								className={t.id === view.tab ? 'active' : ''}
								onClick={() => navigate(tabPath(t.id))}
							>
								{t.label}
							</button>
						))}
					</nav>
					<div className="panel">
						{view.tab === 'queue' ? (
							<ReportQueue
								search={search}
								revision={revision}
								navigate={navigate}
								onOpenPlayer={openPlayer}
							/>
						) : view.tab === 'search' ? (
							<ReportSearch
								search={search}
								revision={revision}
								navigate={navigate}
								onOpenPlayer={openPlayer}
								onBan={openBan}
								onChanged={changed}
							/>
						) : view.tab === 'bans' ? (
							<StandingBans revision={revision} onOpenPlayer={openPlayer} onChanged={changed} />
						) : (
							// Filing a report navigates straight to the ban dialog for it — filing one
							// is almost always the first half of banning somebody, and the new report's
							// id is then in the URL, so the ban is a real page rather than a modal that
							// a reload would lose.
							// `?player=` pre-fills who it's against — the Report link on a player's
							// profile page lands here with it.
							<FileReport
								initialPlayer={new URLSearchParams(search).get('player') ?? ''}
								onFiled={openBan}
							/>
						)}
					</div>
				</div>
			)}
		</main>
	)
}

/**
 * Back out of a drill-down — the in-page counterpart of the browser's own back button,
 * and deliberately the SAME action, so the two can't disagree about where "back" is.
 *
 * Falls forward to the panel's front page when there is no history to pop: a moderator who
 * arrived on a pasted link has nothing behind them, and a button that did nothing would
 * read as broken.
 */
function BackLink({ navigate, label }: { navigate: (to: string) => void; label: string }) {
	return (
		<button
			className="linkish"
			onClick={() => {
				if (window.history.length > 1) window.history.back()
				else navigate('/moderation')
			}}
		>
			← {label}
		</button>
	)
}

/**
 * The report queue: who has collected the most reports lately.
 *
 * Ranked by DISTINCT reporters ahead of raw count (see `getTopReported`), because one
 * player filing twenty reports against someone they're feuding with is a different thing
 * from twenty players each filing one. The window defaults to 30 days so the list is who
 * is a problem now rather than whoever has ever accumulated the most.
 */
function ReportQueue({
	search,
	revision,
	navigate,
	onOpenPlayer,
}: {
	search: string
	revision: number
	navigate: (to: string) => void
	onOpenPlayer: (id: number) => void
}) {
	// In the URL for the same reason the search's filters are: a moderator who widens the
	// window to 90 days, opens a player and presses Back must come back to the 90 days
	// they were reading, not to a list quietly reset to the default.
	const params = new URLSearchParams(search)
	const sinceDays = params.get('sinceDays') ?? '30'
	const minReports = params.get('minReports') ?? '3'
	const queueUrl = (next: { sinceDays?: string; minReports?: string }) => {
		const updated = new URLSearchParams({ sinceDays, minReports, ...next })
		return `/moderation?${updated.toString()}`
	}

	const { data, error } = useStaffData<ReportedPlayerTally[]>(
		`/api/staff/reports/top-reported?sinceDays=${encodeURIComponent(sinceDays)}&minReports=${encodeURIComponent(minReports)}`,
		[revision]
	)
	const names = useNames((data ?? []).map((row) => row.playerId))

	return (
		<section className="card">
			<h2>Report queue</h2>
			<p className="muted">
				Players with the most reports against them, ranked by how many different people reported
				them. Already-banned players are marked but still listed — a ban that is about to expire is
				worth seeing.
			</p>
			<div className="mod-filters">
				<label>
					Window
					<select
						value={sinceDays}
						onChange={(e) => navigate(queueUrl({ sinceDays: e.target.value }))}
					>
						<option value="7">Last 7 days</option>
						<option value="30">Last 30 days</option>
						<option value="90">Last 90 days</option>
						{/* The server reads 0 as "no window" — see the handler. */}
						<option value="0">All time</option>
					</select>
				</label>
				<label>
					Minimum reports
					{/* A select rather than a number box: each change is now a navigation, and a
					    free-text field would push a history entry per digit typed — which would
					    make the back button useless again, the thing this page is fixing. A
					    threshold is coarse anyway; nobody needs to ask for seven. */}
					<select
						value={minReports}
						onChange={(e) => navigate(queueUrl({ minReports: e.target.value }))}
					>
						<option value="1">1 or more</option>
						<option value="2">2 or more</option>
						<option value="3">3 or more</option>
						<option value="5">5 or more</option>
						<option value="10">10 or more</option>
					</select>
				</label>
			</div>

			{error && <p className="error">{error}</p>}
			{data === null ? (
				!error && <p className="muted">Loading…</p>
			) : data.length === 0 ? (
				<p className="muted">Nobody has been reported that many times in this window.</p>
			) : (
				<div className="mod-scroll">
					<table className="mod-table">
						<thead>
							<tr>
								<th>Player</th>
								<th>Reports</th>
								<th>Reporters</th>
								<th>Last reported</th>
								<th />
							</tr>
						</thead>
						<tbody>
							{data.map((row) => (
								<tr key={row.playerId}>
									<td>
										<PlayerName id={row.playerId} names={names} />
										{row.bannedNow && <span className="badge mod-banned">Banned</span>}
									</td>
									<td>{row.reports}</td>
									<td>{row.distinctReporters}</td>
									<td>{when(row.lastReportAt)}</td>
									<td>
										<button className="linkish" onClick={() => onOpenPlayer(row.playerId)}>
											History
										</button>
									</td>
								</tr>
							))}
						</tbody>
					</table>
				</div>
			)}
		</section>
	)
}

/**
 * The search form's state. These are the SAME names the staff endpoint reads as query
 * params (`searchReportsHandler`) and the same ones the panel's own URL carries, so the
 * form, the address bar and the request can't drift apart — one spelling throughout.
 *
 * `from`/`to` are the `YYYY-MM-DD` a date input gives, converted to instants only when the
 * request goes out; keeping the URL in the input's own format is what lets a bookmarked
 * search repopulate the boxes exactly as they were typed.
 */
interface SearchFilters {
	reportedPlayerId: string
	reporterPlayerId: string
	reportCategory: string
	banned: string
	from: string
	to: string
}

const EMPTY_FILTERS: SearchFilters = {
	reportedPlayerId: '',
	reporterPlayerId: '',
	reportCategory: '',
	banned: '',
	from: '',
	to: '',
}

/** Read the filters back out of the panel's URL. Absent keys read as empty. */
function filtersFromSearch(search: string): SearchFilters {
	const params = new URLSearchParams(search)
	const read = (key: keyof SearchFilters) => params.get(key) ?? ''
	return {
		reportedPlayerId: read('reportedPlayerId'),
		reporterPlayerId: read('reporterPlayerId'),
		reportCategory: read('reportCategory'),
		banned: read('banned'),
		from: read('from'),
		to: read('to'),
	}
}

/**
 * The panel URL for a set of filters and a page. Empty values are left OUT rather than
 * written as blanks, so an unfiltered search is the bare `/moderation/search` and the
 * address bar says only what was actually asked for.
 */
function searchUrl(filters: SearchFilters, skip: number): string {
	const params = new URLSearchParams()
	for (const [key, value] of Object.entries(filters)) {
		if (value !== '') params.set(key, value)
	}
	if (skip > 0) params.set('skip', String(skip))
	const query = params.toString()
	return query === '' ? '/moderation/search' : `/moderation/search?${query}`
}

/**
 * Search the report log.
 *
 * The filters and the page live in the URL, not in component state: a moderator searches,
 * opens a player, and presses Back — and has to land on the results they were reading,
 * not on an empty form. It also makes a search linkable, which is how one moderator hands
 * another a slice of the log to look at.
 *
 * The two player boxes take either an id or an `@username`, resolved through `accounts`'
 * search before the query goes out — a moderator following up a Discord report has a name,
 * not a number, and making them look it up elsewhere first is the kind of friction that
 * ends in nobody using the panel. The URL holds the resolved ID, since that is what was
 * searched and what makes the link reproducible.
 */
function ReportSearch({
	search,
	revision,
	navigate,
	onOpenPlayer,
	onBan,
	onChanged,
}: {
	search: string
	revision: number
	navigate: (to: string) => void
	onOpenPlayer: (id: number) => void
	onBan: (report: ReportRow) => void
	onChanged: () => void
}) {
	const applied = filtersFromSearch(search)
	const skip = Number.parseInt(new URLSearchParams(search).get('skip') ?? '0', 10) || 0
	// What is TYPED, which runs ahead of what is applied — a search happens on submit, not
	// on every keystroke. Keyed on the URL so that arriving at a different search (a link,
	// or the back button) resets the boxes to it instead of stranding the last thing typed.
	const [form, setForm] = useState<SearchFilters>(applied)
	const [formKey, setFormKey] = useState(search)
	if (formKey !== search) {
		setFormKey(search)
		setForm(applied)
	}
	const { pending, error: formError, run } = useAction()

	const params = new URLSearchParams({ take: String(PAGE_SIZE), skip: String(skip) })
	if (applied.reportedPlayerId !== '') params.set('reportedPlayerId', applied.reportedPlayerId)
	if (applied.reporterPlayerId !== '') params.set('reporterPlayerId', applied.reporterPlayerId)
	if (applied.reportCategory !== '') params.set('reportCategory', applied.reportCategory)
	if (applied.banned !== '') params.set('banned', applied.banned)
	// A date input gives a bare `YYYY-MM-DD`, so the window is sent as local midnights,
	// which is what the moderator meant by it. `to` is EXCLUSIVE on the server, so the day
	// typed there is included only by pushing the bound to the next midnight.
	if (applied.from !== '') params.set('from', new Date(applied.from).toISOString())
	if (applied.to !== '') {
		const to = new Date(applied.to)
		to.setDate(to.getDate() + 1)
		params.set('to', to.toISOString())
	}

	const { data, error } = useStaffData<{ reports: ReportRow[]; total: number }>(
		`/api/staff/reports?${params.toString()}`,
		[revision]
	)
	const reports = data?.reports ?? []
	const names = useNames(
		reports.flatMap((r) => [
			r.reported_player_id,
			r.reporter_player_id,
			r.unbanned_by_player_id ?? 0,
		])
	)

	const submit = (e: React.FormEvent) => {
		e.preventDefault()
		void run(async () => {
			// Either box may hold a name; resolve before navigating so the URL carries the id,
			// as the report rows do.
			const resolved: SearchFilters = {
				...form,
				reportedPlayerId:
					form.reportedPlayerId.trim() === ''
						? ''
						: String(await playerIdFrom(form.reportedPlayerId)),
				reporterPlayerId:
					form.reporterPlayerId.trim() === ''
						? ''
						: String(await playerIdFrom(form.reporterPlayerId)),
			}
			// Back to page one: the new filters have their own result set, and staying on
			// page three of it would usually show nothing.
			navigate(searchUrl(resolved, 0))
			return ''
		})
	}

	const total = data?.total ?? 0

	return (
		<section className="card">
			<h2>Search reports</h2>
			<p className="muted">
				Every report ever filed, newest first. The player boxes take an id or an @username.
			</p>
			<form className="mod-filters" onSubmit={submit}>
				<label>
					Reported player
					<input
						value={form.reportedPlayerId}
						placeholder="@name or id"
						onChange={(e) => setForm({ ...form, reportedPlayerId: e.target.value })}
					/>
				</label>
				<label>
					Reported by
					<input
						value={form.reporterPlayerId}
						placeholder="@name or id"
						onChange={(e) => setForm({ ...form, reporterPlayerId: e.target.value })}
					/>
				</label>
				<label>
					Category
					<select
						value={form.reportCategory}
						onChange={(e) => setForm({ ...form, reportCategory: e.target.value })}
					>
						<option value="">Any</option>
						{Object.entries(CATEGORY_LABEL).map(([id, label]) => (
							<option key={id} value={id}>
								{label}
							</option>
						))}
					</select>
				</label>
				<label>
					Ban state
					<select
						value={form.banned}
						onChange={(e) => setForm({ ...form, banned: e.target.value })}
					>
						<option value="">Any</option>
						<option value="true">Actioned (banned)</option>
						<option value="false">Not actioned</option>
					</select>
				</label>
				<label>
					From
					<input
						type="date"
						value={form.from}
						onChange={(e) => setForm({ ...form, from: e.target.value })}
					/>
				</label>
				<label>
					To
					<input
						type="date"
						value={form.to}
						onChange={(e) => setForm({ ...form, to: e.target.value })}
					/>
				</label>
				<div className="mod-filter-actions">
					<button type="submit" disabled={pending}>
						{pending ? 'Searching…' : 'Search'}
					</button>
					{/* Clearing is a navigation like any other search, so it goes in the history
					    too — Back after a mis-click returns to what was being read. */}
					<button
						type="button"
						className="linkish"
						onClick={() => navigate(searchUrl(EMPTY_FILTERS, 0))}
					>
						Clear
					</button>
				</div>
			</form>

			{formError && <p className="error">{formError}</p>}
			{error && <p className="error">{error}</p>}

			{data === null ? (
				!error && <p className="muted">Loading…</p>
			) : reports.length === 0 ? (
				<p className="muted">No reports match those filters.</p>
			) : (
				<>
					<ReportTable
						reports={reports}
						names={names}
						onOpenPlayer={onOpenPlayer}
						onBan={onBan}
						onChanged={onChanged}
					/>
					{/* Paging is navigation, so each page is its own history entry: Back walks
					    back through the pages a moderator read rather than out of the panel. */}
					<div className="mod-pager">
						<button
							disabled={skip === 0}
							onClick={() => navigate(searchUrl(applied, Math.max(skip - PAGE_SIZE, 0)))}
						>
							Previous
						</button>
						<span className="muted">
							{skip + 1}–{Math.min(skip + PAGE_SIZE, total)} of {total}
						</span>
						<button
							disabled={skip + PAGE_SIZE >= total}
							onClick={() => navigate(searchUrl(applied, skip + PAGE_SIZE))}
						>
							Next
						</button>
					</div>
				</>
			)}
		</section>
	)
}

/** An id typed as a number, or an `@username` resolved through `accounts`. */
async function playerIdFrom(input: string): Promise<number> {
	const trimmed = input.trim()
	if (/^\d+$/.test(trimmed)) return Number.parseInt(trimmed, 10)
	return accountIdForUsername(trimmed)
}

/** The report rows themselves — shared by the search and the player history. */
function ReportTable({
	reports,
	names,
	onOpenPlayer,
	onBan,
	onChanged,
}: {
	reports: ReportRow[]
	names: Map<number, PublicAccount>
	onOpenPlayer?: (id: number) => void
	onBan: (report: ReportRow) => void
	onChanged: () => void
}) {
	return (
		<div className="mod-scroll">
			<table className="mod-table">
				<thead>
					<tr>
						<th>#</th>
						<th>Filed</th>
						<th>Against</th>
						<th>By</th>
						<th>Kind</th>
						<th>Category</th>
						<th>Details</th>
						<th>Ban</th>
						<th />
					</tr>
				</thead>
				<tbody>
					{reports.map((report) => (
						<tr key={report.id}>
							<td>{report.id}</td>
							<td>{when(report.created_at)}</td>
							<td>
								{onOpenPlayer ? (
									<button
										className="linkish"
										onClick={() => onOpenPlayer(report.reported_player_id)}
									>
										<PlayerName id={report.reported_player_id} names={names} />
									</button>
								) : (
									<PlayerName id={report.reported_player_id} names={names} />
								)}
							</td>
							<td>
								<PlayerName id={report.reporter_player_id} names={names} />
							</td>
							<td>{reportKind(report)}</td>
							<td>{categoryLabel(report.report_category)}</td>
							{/* The reporter's own words, untruncated in the title so a long
							    description is readable without leaving the table. */}
							<td className="mod-details" title={report.details ?? ''}>
								{report.details ?? <span className="muted">none given</span>}
							</td>
							<td>
								{report.banned === 1 ? (
									<span className="badge mod-banned">{expiryLabel(report)}</span>
								) : banLifted(report) ? (
									<LiftedBan report={report} names={names} />
								) : (
									<span className="muted">—</span>
								)}
							</td>
							<td>
								{report.banned === 1 ? (
									<LiftBanButton report={report} onDone={onChanged} />
								) : (
									<button className="linkish" onClick={() => onBan(report)}>
										{banLifted(report) ? 'Ban again…' : 'Ban…'}
									</button>
								)}
							</td>
						</tr>
					))}
				</tbody>
			</table>
		</div>
	)
}

/**
 * Lift the ban on a report. Confirmed first — it is one click next to a row of them, and
 * the mistake puts a banned player straight back in the game.
 */
function LiftBanButton({ report, onDone }: { report: ReportRow; onDone: () => void }) {
	const { pending, error, run } = useAction()
	return (
		<>
			<button
				className="linkish"
				disabled={pending}
				onClick={() =>
					void run(async () => {
						if (!confirm(`Lift the ban on player #${report.reported_player_id}?`)) return ''
						await call(`/api/staff/reports/${report.id}/ban`, {
							authed: true,
							json: { banned: false },
						})
						onDone()
						return ''
					})
				}
			>
				{pending ? 'Lifting…' : 'Lift ban'}
			</button>
			{error && <p className="error">{error}</p>}
		</>
	)
}

/** Every ban in force right now. */
function StandingBans({
	revision,
	onOpenPlayer,
	onChanged,
}: {
	revision: number
	onOpenPlayer: (id: number) => void
	onChanged: () => void
}) {
	const { data, error } = useStaffData<ReportRow[]>('/api/staff/bans', [revision])
	const bans = data ?? []
	const names = useNames(bans.flatMap((b) => [b.reported_player_id, b.banned_by_player_id ?? 0]))

	return (
		<section className="card">
			<h2>Standing bans</h2>
			<p className="muted">
				Bans in force right now, most recent first — so a ban handed down by mistake is at the top,
				where you would go looking for it. An expired ban isn&apos;t here: it has served its time,
				and the report stays as the record that it happened.
			</p>
			{error && <p className="error">{error}</p>}
			{data === null ? (
				!error && <p className="muted">Loading…</p>
			) : bans.length === 0 ? (
				<p className="muted">Nobody is banned.</p>
			) : (
				<div className="mod-scroll">
					<table className="mod-table">
						<thead>
							<tr>
								<th>Player</th>
								<th>Report</th>
								<th>Reason</th>
								<th>Banned</th>
								<th>By</th>
								<th>Lifts</th>
								<th />
							</tr>
						</thead>
						<tbody>
							{bans.map((ban) => (
								<tr key={ban.id}>
									<td>
										<button
											className="linkish"
											onClick={() => onOpenPlayer(ban.reported_player_id)}
										>
											<PlayerName id={ban.reported_player_id} names={names} />
										</button>
									</td>
									<td>#{ban.id}</td>
									<td>{categoryLabel(ban.report_category)}</td>
									{/* `banned_at` where there is one; a ban handed down before that
									    column existed has only the report's own date to show. */}
									<td>
										{ban.banned_at === null ? (
											<span className="muted" title="Recorded before ban timestamps were kept">
												{when(ban.created_at)}?
											</span>
										) : (
											when(ban.banned_at)
										)}
									</td>
									<td>
										{ban.banned_by_player_id === null ? (
											<span className="muted">unknown</span>
										) : (
											<PlayerName id={ban.banned_by_player_id} names={names} />
										)}
									</td>
									<td>{ban.ban_expires === null ? 'Never' : when(ban.ban_expires)}</td>
									<td>
										<LiftBanButton report={ban} onDone={onChanged} />
									</td>
								</tr>
							))}
						</tbody>
					</table>
				</div>
			)}
		</section>
	)
}

/**
 * Everything on file about one player: the reports against them, the warnings handed
 * down, the ban in force, and who else a ban would reach.
 *
 * One screen because it is one decision. A moderator about to ban someone wants the
 * history and the blast radius in front of them, not in three places.
 */
function PlayerHistory({
	playerId,
	revision,
	navigate,
	onBan,
}: {
	playerId: number
	revision: number
	navigate: (to: string) => void
	onBan: (report: ReportRow) => void
}) {
	// Bumped by a write that leaves you on this page — lifting a ban from the table below.
	const [ownRevision, setOwnRevision] = useState(0)
	const { data, error } = useStaffData<{
		playerId: number
		reports: ReportRow[]
		warnings: WarningRow[]
		activeBan: ReportRow | null
	}>(`/api/staff/players/${playerId}`, [revision, ownRevision])
	const reports = data?.reports ?? []
	const warnings = data?.warnings ?? []
	const names = useNames([
		playerId,
		...reports.map((r) => r.reporter_player_id),
		...reports.map((r) => r.unbanned_by_player_id ?? 0),
		...warnings.map((w) => w.moderator_player_id),
	])
	// The most recent lift, if any — it is the thing a moderator about to ban needs to know
	// first, since the report rows below say "Ban again…" and the reason is up here.
	const lastLifted = reports
		.filter(banLifted)
		.sort((a, b) => (a.unbanned_at! < b.unbanned_at! ? 1 : -1))[0]

	return (
		<>
			<section className="card">
				<BackLink navigate={navigate} label="Back to the tables" />
				<h2>
					<PlayerName id={playerId} names={names} />
				</h2>
				{error && <p className="error">{error}</p>}
				{data === null ? (
					!error && <p className="muted">Loading…</p>
				) : data.activeBan === null ? (
					<>
						<p className="muted">
							Not banned. {reports.length} report{reports.length === 1 ? '' : 's'} on file,{' '}
							{warnings.length} warning{warnings.length === 1 ? '' : 's'} handed down.
						</p>
						{lastLifted !== undefined && (
							<p className="mod-lifted-note">
								<LiftedBan report={lastLifted} names={names} /> — on report #{lastLifted.id} for{' '}
								{categoryLabel(lastLifted.report_category)}. Check with them before banning again.
							</p>
						)}
					</>
				) : (
					<p className="ok">
						Banned on report #{data.activeBan.id} for{' '}
						{categoryLabel(data.activeBan.report_category)} —{' '}
						{data.activeBan.ban_expires === null
							? 'permanently'
							: `until ${when(data.activeBan.ban_expires)}`}
						.
					</p>
				)}
			</section>

			<LinkedAccountsPanel playerId={playerId} />

			<section className="card">
				<h2>Reports</h2>
				{reports.length === 0 ? (
					<p className="muted">Nobody has reported this player.</p>
				) : (
					<ReportTable
						reports={reports}
						names={names}
						onBan={onBan}
						onChanged={() => setOwnRevision((n) => n + 1)}
					/>
				)}
			</section>

			<section className="card">
				<h2>Warnings</h2>
				<p className="muted">
					Warnings a moderator handed down, from the game&apos;s own warning endpoint. Nothing here
					dispatches them; the rows are the record.
				</p>
				{warnings.length === 0 ? (
					<p className="muted">No warnings on file.</p>
				) : (
					<div className="mod-scroll">
						<table className="mod-table">
							<thead>
								<tr>
									<th>When</th>
									<th>By</th>
									<th>Category</th>
									<th>Shown to the player</th>
									<th>Internal note</th>
								</tr>
							</thead>
							<tbody>
								{warnings.map((warning) => (
									<tr key={warning.id}>
										<td>{when(warning.created_at)}</td>
										<td>
											<PlayerName id={warning.moderator_player_id} names={names} />
										</td>
										<td>{categoryLabel(warning.report_category)}</td>
										<td>{warning.display_reason ?? <span className="muted">—</span>}</td>
										<td>{warning.moderator_note ?? <span className="muted">—</span>}</td>
									</tr>
								))}
							</tbody>
						</table>
					</div>
				)}
			</section>
		</>
	)
}

/**
 * Who ELSE a ban on this player would block.
 *
 * The IP arm is coarse by design — households, NAT, campus and carrier networks put
 * unrelated players behind one address — so a ban can reach people who did nothing. That
 * trade is the operator's to make, but it should be made with this list in front of them
 * rather than discovered from a support ticket.
 */
function LinkedAccountsPanel({ playerId }: { playerId: number }) {
	const { data, error } = useStaffData<{
		arms: { ip: boolean; platform: boolean }
		linked: LinkedAccount[]
	}>(`/api/staff/players/${playerId}/linked`)

	if (error !== '')
		return (
			<section className="card">
				<p className="error">{error}</p>
			</section>
		)
	if (data === null) return null

	const arms = [data.arms.platform && 'shared platform identity', data.arms.ip && 'shared IP']
		.filter(Boolean)
		.join(' and ')

	return (
		<section className="card">
			<h2>Who a ban would also reach</h2>
			{arms === '' ? (
				<p className="muted">
					Ban-evasion matching is switched off on this server, so a ban reaches exactly the one
					account.
				</p>
			) : data.linked.length === 0 ? (
				<p className="muted">
					No other account shares a {arms} with this one — a ban reaches only them.
				</p>
			) : (
				<>
					<p className="muted">
						Evasion matching is on for {arms}. These accounts would be blocked too:
					</p>
					<ul className="mod-linked">
						{data.linked.map((linked) => (
							<li key={`${linked.via}-${linked.accountId}-${linked.value}`}>
								<span className={`badge ${linked.via === 'platform' ? 'live' : ''}`}>
									{linked.via === 'platform' ? 'Same platform login' : 'Same IP'}
								</span>{' '}
								{linked.username ? `@${linked.username}` : 'unknown'}
								<span className="muted">
									{' '}
									#{linked.accountId} · {linked.value}
								</span>
							</li>
						))}
					</ul>
					{data.arms.ip && (
						<p className="muted">
							An IP match is not proof of the same person. Households and shared networks look
							identical to it.
						</p>
					)}
				</>
			)}
		</section>
	)
}

/**
 * File a report by hand.
 *
 * A ban lives ON a report (see reports-db), so acting on something nobody happened to
 * report — found in a log, seen first-hand, escalated from Discord — needs a row to hang
 * it off. The reporter is the acting moderator, taken from the token; that is the record
 * of who raised it, which is why nothing marks these rows as staff-created.
 *
 * Hands the new report straight to the ban dialog, since filing one is almost always the
 * first half of banning somebody.
 */
function FileReport({
	initialPlayer,
	onFiled,
}: {
	initialPlayer: string
	onFiled: (report: ReportRow) => void
}) {
	const [player, setPlayer] = useState(initialPlayer)
	const [category, setCategory] = useState(String(KickReportCategory.Misc))
	const [details, setDetails] = useState('')
	const { pending, error, run } = useAction()

	return (
		<section className="card">
			<h2>File a report</h2>
			<p className="muted">
				For something no player reported. It is filed under your account, and opens the ban dialog
				once saved — you don&apos;t have to ban, and the row stands on its own either way.
			</p>
			<form
				onSubmit={(e) => {
					e.preventDefault()
					void run(async () => {
						const report = await call<ReportRow>('/api/staff/reports', {
							authed: true,
							json: {
								reportedPlayerId: await playerIdFrom(player),
								reportCategory: Number(category),
								details: details.trim(),
							},
						})
						// Straight to the ban page for the new report, which names it — so no
						// success line is returned here: this form is gone by the time one could
						// be read, and the fields don't need clearing for the same reason.
						onFiled(report)
						return ''
					})
				}}
			>
				<label>
					Player
					<input
						value={player}
						placeholder="@name or id"
						required
						onChange={(e) => setPlayer(e.target.value)}
					/>
				</label>
				<label>
					Category
					<select value={category} onChange={(e) => setCategory(e.target.value)}>
						{FILEABLE_CATEGORIES.map((id) => (
							<option key={id} value={id}>
								{categoryLabel(id)}
							</option>
						))}
					</select>
				</label>
				<label>
					What happened
					<textarea
						value={details}
						rows={4}
						placeholder="What you saw, where you saw it, and anything a second moderator would need. Kept internally."
						onChange={(e) => setDetails(e.target.value)}
					/>
				</label>
				{error && <p className="error">{error}</p>}
				<button type="submit" disabled={pending}>
					{pending ? 'Filing…' : 'File report'}
				</button>
			</form>
		</section>
	)
}

/** The ban lengths offered, in the order the dialog lists them. `null` is permanent. */
const BAN_LENGTHS: Array<{ label: string; days: number | null }> = [
	{ label: '1 day', days: 1 },
	{ label: '3 days', days: 3 },
	{ label: '7 days', days: 7 },
	{ label: '30 days', days: 30 },
	{ label: '90 days', days: 90 },
	{ label: 'Permanent', days: null },
]

/**
 * Hand down a ban on one report.
 *
 * Takes a LENGTH rather than a date: a moderator decides "7 days", and the server turns
 * that into the expiry it stores, so nobody is doing calendar arithmetic over a ban. The
 * evasion preview is shown here too — this is the moment the blast radius matters.
 *
 * Says out loud what applying it does beyond the row: the player is thrown out of the
 * instance they are standing in, which is the part that is not obvious from "ban".
 */
function BanDialog({ reportId, navigate }: { reportId: number; navigate: (to: string) => void }) {
	const [choice, setChoice] = useState('7')
	const { pending, error, run } = useAction()
	// The report is READ here rather than handed down as a prop, which is what makes the
	// URL self-sufficient: a reload, or a pasted `/moderation/reports/12/ban`, opens the
	// same form instead of a blank page. It is also the report as it stands NOW — if
	// somebody else banned it while this was being opened, that shows.
	const { data: report, error: loadError } = useStaffData<ReportRow>(
		`/api/staff/reports/${reportId}`
	)
	const names = useNames(
		report ? [report.reported_player_id, report.unbanned_by_player_id ?? 0] : []
	)

	if (loadError !== '') {
		return (
			<section className="card">
				<BackLink navigate={navigate} label="Back to the tables" />
				<p className="error">{loadError}</p>
			</section>
		)
	}
	if (report === null) {
		return (
			<section className="card">
				<p className="muted">Loading report #{reportId}…</p>
			</section>
		)
	}

	// Already actioned — reached by a stale link or the back button after banning. Shown
	// as the standing ban it is rather than as a form that would silently re-ban and
	// restart the clock.
	if (report.banned === 1) {
		return (
			<section className="card">
				<BackLink navigate={navigate} label="Back to the tables" />
				<h2>
					<PlayerName id={report.reported_player_id} names={names} /> is already banned
				</h2>
				<p className="muted">
					Report #{report.id} — {expiryLabel(report)}. Lift it from the tables if this was a
					mistake.
				</p>
				<button onClick={() => navigate(`/moderation/players/${report.reported_player_id}`)}>
					See their history
				</button>
			</section>
		)
	}

	return (
		<section className="card mod-dialog">
			<BackLink navigate={navigate} label="Back to the tables" />
			<h2>
				Ban <PlayerName id={report.reported_player_id} names={names} />
			</h2>
			<p className="muted">
				On report #{report.id} — {categoryLabel(report.report_category)}
				{report.details ? `: “${report.details}”` : ''}
			</p>
			{/* The one thing this form must not do quietly: a ban on this very report was
			    lifted on purpose, and applying another undoes a colleague's decision. The
			    form still works — sometimes a re-ban IS the decision — but not by accident. */}
			{banLifted(report) && (
				<p className="mod-lifted-note">
					<LiftedBan report={report} names={names} />. Banning again overrides that — check with
					them first unless something new has happened.
				</p>
			)}

			<LinkedAccountsPanel playerId={report.reported_player_id} />

			<form
				onSubmit={(e) => {
					e.preventDefault()
					void run(async () => {
						const length = BAN_LENGTHS.find((l) => String(l.days) === choice)
						await call(`/api/staff/reports/${report.id}/ban`, {
							authed: true,
							// `permanent` rather than an absent duration: the server reads "no
							// duration" as permanent too, but saying it explicitly means a bug in
							// this form can't quietly hand out a life ban.
							json:
								length?.days === null || length === undefined
									? { banned: true, permanent: true }
									: { banned: true, days: length.days },
						})
						// Onto the player's record rather than back where they came from: it is
						// the confirmation that the ban landed and the place to lift it from if it
						// was wrong, and it means Back doesn't return to a spent form.
						navigate(`/moderation/players/${report.reported_player_id}`)
						return ''
					})
				}}
			>
				<label>
					Length
					<select value={choice} onChange={(e) => setChoice(e.target.value)}>
						{BAN_LENGTHS.map((length) => (
							<option key={length.label} value={String(length.days)}>
								{length.label}
							</option>
						))}
					</select>
				</label>
				<p className="muted">
					They are thrown out of the room they&apos;re in right now, and refused at matchmaking
					until the ban lifts. The report stays as the record either way, and a ban can be lifted
					from the tables.
				</p>
				{error && <p className="error">{error}</p>}
				<div className="mod-filter-actions">
					<button type="submit" disabled={pending}>
						{pending ? 'Banning…' : banLifted(report) ? 'Ban again' : 'Apply ban'}
					</button>
					<button
						type="button"
						className="linkish"
						onClick={() => {
							if (window.history.length > 1) window.history.back()
							else navigate('/moderation')
						}}
					>
						Cancel
					</button>
				</div>
			</form>
		</section>
	)
}
