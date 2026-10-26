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

type AccessKind = keyof typeof accessLabels
const accessLabels = {
	studio: 'Studio uploads',
	'avatar-items': 'Avatar Studio items',
	'avatar-costumes': 'Avatar Studio costumes',
	'avatar-badges': 'Avatar Studio badges',
	'avatar-consumables': 'Avatar Studio consumables',
	screenshare: 'Screen sharing',
}

interface AccessRow {
	accountId: number
	username: string | null
	displayName: string | null
	enabled: boolean
}

function AccessPage({
	kind,
	account,
	navigate,
}: {
	kind: AccessKind
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
		const me = await call<Record<AccessKind | 'granted', boolean>>('/api/studio-access', {
			authed: true,
		})
		setGranted((kind === 'studio' ? me.granted : me[kind]) === true)
		if (isAdmin()) {
			const page = await call<{ accounts: AccessRow[] }>(`/api/staff/studio-access?kind=${kind}`, {
				authed: true,
			})
			setRows(page.accounts ?? [])
		}
	}, [kind])

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
				{ method: 'POST', authed: true, json: { username: username.trim(), kind } }
			)
			setUsername('')
			await reload()
			return result.alreadyGranted
				? `@${result.username} already has ${accessLabels[kind]} access.`
				: `@${result.username} now has ${accessLabels[kind]} access.`
		})
	}

	const remove = (row: AccessRow) => {
		setRemoving(row.accountId)
		setRemoveError('')
		void (async () => {
			try {
				await call(
					row.enabled
						? `/api/staff/studio-access/${row.accountId}?kind=${kind}`
						: '/api/staff/studio-access',
					row.enabled
						? { method: 'DELETE', authed: true }
						: { method: 'POST', authed: true, json: { accountId: row.accountId, kind } }
				)
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
		<section>
			<h2>{accessLabels[kind]}</h2>
			<section className="card">
				<p className="muted">
					{kind === 'studio'
						? 'Manage permission to upload from RecFlare Studio.'
						: kind.startsWith('avatar-')
							? 'Grant this Avatar Studio feature independently. Studio upload access is also required. Roomie equipment still requires developer access.'
							: 'Screen sharing is disabled by default. Staff can enable it for individual users.'}{' '}
					Sign in again or refresh the session to pick up permission changes.
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
						<span className="muted">to see the access for this account.</span>
					</p>
				) : loading ? (
					<p className="muted">Loading…</p>
				) : loadError ? (
					<p className="error">{loadError}</p>
				) : granted ? (
					<p>
						<strong>{account.username}</strong> has {accessLabels[kind]} access. If the editor still
						says otherwise, sign out of it and sign in again.
					</p>
				) : (
					<p>
						<strong>{account.username}</strong> does not have {accessLabels[kind]} access. A
						moderator can add this account to the list.
					</p>
				)}
			</section>
			{staff && account && (
				<section className="card">
					<h3>Whitelist</h3>
					<p className="muted">
						{kind === 'screenshare'
							? 'Only users on this list can share their screen.'
							: 'Add a username to grant access, or remove a player to revoke it.'}
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
							{kind === 'screenshare' ? 'Enable' : 'Add'}
						</button>
					</form>
					{add.error && <p className="error">{add.error}</p>}
					{add.done && <p className="ok">{add.done}</p>}
					{loading ? (
						<p className="muted">Loading…</p>
					) : loadError ? null : rows.length === 0 ? (
						<p className="muted">No users on this list.</p>
					) : (
						<ul className="studio-access-list">
							{rows.map((row) => (
								<li key={row.accountId} className="studio-access-row">
									<span>
										<strong>
											{row.username ? `@${row.username}` : `Account ${row.accountId}`}
										</strong>
										{row.displayName && row.displayName !== row.username ? (
											<span className="muted"> · {row.displayName}</span>
										) : null}
										{kind === 'screenshare' && (
											<span className="muted"> - {row.enabled ? 'Enabled' : 'Disabled'}</span>
										)}
									</span>
									<button type="button" disabled={removing !== null} onClick={() => remove(row)}>
										{kind === 'screenshare' ? (row.enabled ? 'Disable' : 'Enable') : 'Remove'}
									</button>
								</li>
							))}
						</ul>
					)}
					{removeError && <p className="error">{removeError}</p>}
				</section>
			)}
		</section>
	)
}

export function StudioAccessPage(props: {
	account: { accountId: number; username: string } | null | undefined
	navigate: (to: string) => void
}) {
	return (
		<main className="shell wide">
			<h1>RecFlare Studio access</h1>
			{(Object.keys(accessLabels) as AccessKind[]).map((kind) => (
				<AccessPage key={kind} kind={kind} {...props} />
			))}
		</main>
	)
}
