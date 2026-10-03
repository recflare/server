import { useCallback, useEffect, useState } from 'react'

import { call, isAdmin, useAction } from './api'

/**
 * The page RecFlare Studio opens when an account cannot upload.
 *
 * The editor's dialog links to `/settings/recroomstudio`. Anyone can land here
 * and, once signed in, see whether this account is on the upload list. Staff
 * also get the list itself: adding a player puts `betastudio` on their next
 * Studio sign-in or token refresh. A session already open in the editor keeps
 * its old access until then.
 */

const PAGE = '/settings/recroomstudio'

interface AccessRow {
	accountId: number
	username: string | null
	displayName: string | null
	grantedBy: number
	grantedByUsername: string | null
	grantedAt: string
}

export function StudioAccessPage({
	account,
	navigate,
}: {
	/** undefined while the session is still being checked, null when signed out. */
	account: { accountId: number; username: string } | null | undefined
	navigate: (to: string) => void
}) {
	const staff = account !== undefined && account !== null && isAdmin()
	const [granted, setGranted] = useState(false)
	const [rows, setRows] = useState<AccessRow[]>([])
	const [loading, setLoading] = useState(false)
	const [loadError, setLoadError] = useState('')
	const [username, setUsername] = useState('')
	const [removing, setRemoving] = useState<number | null>(null)
	const [removeError, setRemoveError] = useState('')
	const add = useAction()

	const load = useCallback(async () => {
		const me = await call<{ granted: boolean }>('/api/studio-access', { authed: true })
		setGranted(me.granted === true)
		if (isAdmin()) {
			const page = await call<{ accounts: AccessRow[] }>('/api/staff/studio-access', {
				authed: true,
			})
			setRows(page.accounts ?? [])
		}
	}, [])

	const accountId = account?.accountId
	useEffect(() => {
		if (accountId === undefined) return
		let cancelled = false
		setLoading(true)
		setLoadError('')
		void load()
			.catch((err: unknown) => {
				if (!cancelled) setLoadError(err instanceof Error ? err.message : String(err))
			})
			.finally(() => {
				if (!cancelled) setLoading(false)
			})
		return () => {
			cancelled = true
		}
	}, [accountId, load])

	const reload = async () => {
		try {
			await load()
			setLoadError('')
		} catch (err) {
			setLoadError(err instanceof Error ? err.message : String(err))
		}
	}

	const submitAdd = () => {
		void add.run(async () => {
			const result = await call<{ username: string; alreadyGranted: boolean }>(
				'/api/staff/studio-access',
				{ method: 'POST', authed: true, json: { username: username.trim() } }
			)
			setUsername('')
			await reload()
			return result.alreadyGranted
				? `@${result.username} is already on the list.`
				: `@${result.username} can upload the next time they sign in to Studio.`
		})
	}

	const remove = (row: AccessRow) => {
		setRemoving(row.accountId)
		setRemoveError('')
		void (async () => {
			try {
				await call(`/api/staff/studio-access/${row.accountId}`, { method: 'DELETE', authed: true })
				await reload()
			} catch (err) {
				setRemoveError(err instanceof Error ? err.message : String(err))
			} finally {
				setRemoving(null)
			}
		})()
	}

	const signInHref = `/login?next=${encodeURIComponent(PAGE)}`

	return (
		<main className={staff ? 'shell wide' : 'shell'}>
			<h1>RecFlare Studio access</h1>
			<section className="card">
				<p className="muted">
					RecFlare Studio signs in with any account. Uploading is limited to accounts on this list.
					Access is picked up the next time you sign in to Studio, or when that session refreshes. A
					session you already have keeps its old access until then, and a session lasts a day.
				</p>
				{account === undefined ? (
					<p className="muted">Loading…</p>
				) : account === null ? (
					<p>
						<a
							className="cta"
							href={signInHref}
							onClick={(e) => {
								e.preventDefault()
								navigate(signInHref)
							}}
						>
							Sign in
						</a>{' '}
						<span className="muted">to see whether this account can upload.</span>
					</p>
				) : loading ? (
					<p className="muted">Loading…</p>
				) : loadError ? (
					<p className="error">{loadError}</p>
				) : granted ? (
					<p>
						<strong>{account.username}</strong> can upload in RecFlare Studio. If the editor still
						says otherwise, sign out of it and sign in again.
					</p>
				) : (
					<p>
						<strong>{account.username}</strong> cannot upload in RecFlare Studio yet. A moderator
						can add this account to the list.
					</p>
				)}
			</section>
			{staff && account && (
				<section className="card">
					<h2>Whitelist</h2>
					<p className="muted">
						Adding a player puts the betastudio role on their next Studio sign-in. Developers are
						not on this list unless someone adds them.
					</p>
					<form
						onSubmit={(e) => {
							e.preventDefault()
							submitAdd()
						}}
					>
						<label>
							Username
							<input
								value={username}
								autoComplete="off"
								spellCheck={false}
								onChange={(e) => setUsername(e.target.value)}
								required
							/>
						</label>
						<button type="submit" disabled={add.pending || username.trim() === ''}>
							Add
						</button>
					</form>
					{add.error && <p className="error">{add.error}</p>}
					{add.done && <p className="ok">{add.done}</p>}
					{loading ? (
						<p className="muted">Loading…</p>
					) : loadError ? null : rows.length === 0 ? (
						<p className="muted">Nobody is on the list.</p>
					) : (
						<ul className="studio-access-list">
							{rows.map((row) => (
								<li key={row.accountId} className="studio-access-row">
									<span>
										<strong>
											{row.username ? `@${row.username}` : `Account ${row.accountId}`}
										</strong>
										<span className="muted">
											{' '}
											· added {new Date(row.grantedAt).toLocaleString()}
											{row.grantedByUsername ? ` by @${row.grantedByUsername}` : ''}
										</span>
									</span>
									<button
										type="button"
										disabled={removing === row.accountId}
										onClick={() => remove(row)}
									>
										Remove
									</button>
								</li>
							))}
						</ul>
					)}
					{removeError && <p className="error">{removeError}</p>}
				</section>
			)}
		</main>
	)
}
