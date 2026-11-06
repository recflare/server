import { useEffect, useState } from 'react'

import { call, useAction, where } from './api'

/**
 * The `/admin` "Curated lists" tab: the hand-curated discovery rows (`CURATED_ROWS` in
 * `@repo/domain` — "Featured This Week" is `staffpicks`, "Rooms We Love" is `inkshowcase`)
 * that `lists` serves for `/algorithmiclists/:slug`, in the order each row shows them. Pick a
 * row, edit it locally, and Save replaces the whole list (`PUT /api/staff/lists/:slug`), so
 * add, remove and reorder are one write. Staff only — the admin page is hidden otherwise,
 * and www's route checks the role itself.
 */

interface CuratedRow {
	slug: string
	title: string
}

interface Pick {
	roomId: number
	name: string | null
	imageName: string | null
	accessibility: number | null
	/** The room was deleted since it was picked. Saving drops nothing on its own — remove it. */
	missing: boolean
}

interface SearchRoom {
	RoomId: number
	Name: string
	ImageName: string
}

/** `RoomAccessibility` 1 is Public; anything else won't show in the row for most players. */
const PUBLIC = 1

const MAX_PICKS = 50

export function CuratedListsPanel() {
	const [rows, setRows] = useState<CuratedRow[] | null>(null)
	const [slug, setSlug] = useState('')
	const [error, setError] = useState('')

	useEffect(() => {
		void call<{ rows: CuratedRow[] }>('/api/staff/lists', { authed: true })
			.then(({ rows }) => {
				setRows(rows)
				setSlug(rows[0]?.slug ?? '')
			})
			.catch((e: unknown) => setError(e instanceof Error ? e.message : String(e)))
	}, [])

	const row = rows?.find((r) => r.slug === slug)
	return (
		<section>
			<h2>Curated lists</h2>
			{error ? (
				<p className="error">{error}</p>
			) : rows === null ? (
				<p className="muted">Loading…</p>
			) : (
				<>
					<label>
						Row
						<select value={slug} onChange={(e) => setSlug(e.target.value)}>
							{rows.map((r) => (
								<option key={r.slug} value={r.slug}>
									{r.title} ({r.slug})
								</option>
							))}
						</select>
					</label>
					{/* Keyed so switching rows starts a fresh editor rather than carrying edits over. */}
					{row && <RowEditor key={row.slug} row={row} />}
				</>
			)}
		</section>
	)
}

function RowEditor({ row }: { row: CuratedRow }) {
	const url = `/api/staff/lists/${encodeURIComponent(row.slug)}`
	const [saved, setSaved] = useState<Pick[] | null>(null)
	const [picks, setPicks] = useState<Pick[]>([])
	const [loadError, setLoadError] = useState('')
	const [query, setQuery] = useState('')
	const [results, setResults] = useState<SearchRoom[]>([])
	const save = useAction()

	useEffect(() => {
		void call<{ rooms: Pick[] }>(url, { authed: true })
			.then(({ rooms }) => {
				setSaved(rooms)
				setPicks(rooms)
			})
			.catch((e: unknown) => setLoadError(e instanceof Error ? e.message : String(e)))
	}, [url])

	// Search as the name is typed, after a short pause. A bare number also offers that id.
	useEffect(() => {
		const q = query.trim()
		if (q === '') {
			setResults([])
			return
		}
		let cancelled = false
		const timer = setTimeout(() => {
			void (async () => {
				const byName = await call<SearchRoom[]>(
					`${where().rooms}/rooms/search/name?query=${encodeURIComponent(q)}&take=8`
				).catch(() => [])
				const byId = /^\d+$/.test(q)
					? await call<SearchRoom | Record<string, never>>(`${where().rooms}/rooms?id=${q}`)
							.then((r) => ('RoomId' in r ? [r as SearchRoom] : []))
							.catch(() => [])
					: []
				if (!cancelled) {
					const seen = new Set<number>()
					setResults(
						[...byId, ...(Array.isArray(byName) ? byName : [])].filter(
							(r) => !seen.has(r.RoomId) && seen.add(r.RoomId)
						)
					)
				}
			})()
		}, 250)
		return () => {
			cancelled = true
			clearTimeout(timer)
		}
	}, [query])

	const dirty =
		saved !== null &&
		(saved.length !== picks.length || saved.some((p, i) => p.roomId !== picks[i].roomId))

	const move = (index: number, by: number) => {
		const to = index + by
		if (to < 0 || to >= picks.length) return
		const next = [...picks]
		;[next[index], next[to]] = [next[to], next[index]]
		setPicks(next)
	}

	const add = (room: SearchRoom) => {
		if (picks.some((p) => p.roomId === room.RoomId)) return
		setPicks([
			...picks,
			{
				roomId: room.RoomId,
				name: room.Name,
				imageName: room.ImageName,
				accessibility: null,
				missing: false,
			},
		])
		setQuery('')
	}

	const submit = () => {
		void save.run(async () => {
			const { rooms } = await call<{ rooms: Pick[] }>(url, {
				method: 'PUT',
				authed: true,
				json: { roomIds: picks.map((p) => p.roomId) },
			})
			setSaved(rooms)
			setPicks(rooms)
			return `Saved ${rooms.length} room${rooms.length === 1 ? '' : 's'} to “${row.title}”.`
		})
	}

	return (
		<section className="card">
			<p className="muted">
				The rooms in the &ldquo;{row.title}&rdquo; row, in the order shown. Changes go live when you
				save.
			</p>
			{loadError ? (
				<p className="error">{loadError}</p>
			) : saved === null ? (
				<p className="muted">Loading…</p>
			) : (
				<>
					<form onSubmit={(e) => e.preventDefault()}>
						<label>
							Add a room (name or id)
							<input
								value={query}
								autoComplete="off"
								spellCheck={false}
								onChange={(e) => setQuery(e.target.value)}
								disabled={picks.length >= MAX_PICKS}
							/>
						</label>
					</form>
					{results.length > 0 && (
						<ul className="studio-access-list">
							{results.map((room) => (
								<li key={room.RoomId} className="studio-access-row">
									<span>
										<strong>^{room.Name}</strong>
										<span className="muted"> · #{room.RoomId}</span>
									</span>
									<button
										type="button"
										disabled={picks.some((p) => p.roomId === room.RoomId)}
										onClick={() => add(room)}
									>
										{picks.some((p) => p.roomId === room.RoomId) ? 'Added' : 'Add'}
									</button>
								</li>
							))}
						</ul>
					)}

					{picks.length === 0 ? (
						<p className="muted">No rooms. The row is hidden until there are some.</p>
					) : (
						<ol className="studio-access-list">
							{picks.map((pick, i) => (
								<li key={pick.roomId} className="studio-access-row">
									<span style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
										<span className="muted">{i + 1}.</span>
										{pick.imageName && (
											<img
												src={`${where().img}/${pick.imageName}?width=128`}
												alt=""
												width={64}
												height={36}
												style={{ objectFit: 'cover', borderRadius: 4 }}
											/>
										)}
										<span>
											<strong>{pick.name ? `^${pick.name}` : `Room #${pick.roomId}`}</strong>
											<span className="muted"> · #{pick.roomId}</span>
											{pick.missing && <span className="error"> · deleted</span>}
											{pick.accessibility !== null && pick.accessibility !== PUBLIC && (
												<span className="muted"> · not public</span>
											)}
										</span>
									</span>
									<span style={{ display: 'flex', gap: 6 }}>
										<button type="button" disabled={i === 0} onClick={() => move(i, -1)}>
											↑
										</button>
										<button
											type="button"
											disabled={i === picks.length - 1}
											onClick={() => move(i, 1)}
										>
											↓
										</button>
										<button
											type="button"
											onClick={() => setPicks(picks.filter((p) => p.roomId !== pick.roomId))}
										>
											Remove
										</button>
									</span>
								</li>
							))}
						</ol>
					)}

					<p style={{ display: 'flex', gap: 8, marginTop: 16 }}>
						<button type="button" disabled={!dirty || save.pending} onClick={submit}>
							{save.pending ? 'Saving…' : 'Save'}
						</button>
						<button type="button" disabled={!dirty || save.pending} onClick={() => setPicks(saved)}>
							Discard changes
						</button>
					</p>
					{save.error && <p className="error">{save.error}</p>}
					{save.done && !dirty && <p className="ok">{save.done}</p>}
				</>
			)}
		</section>
	)
}
