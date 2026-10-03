import { useEffect, useState } from 'react'

import { call, useAction, where } from './api'

/**
 * The page RecFlare Studio opens after `POST /connect/deviceauthorization`.
 *
 * Studio shows `verification_uri` (`/device`) and opens `verification_uri_complete`
 * (`/device?user_code=…`) in the browser. The API that created the code stays on
 * `auth`; this page only approves or denies it, with the website session's token.
 */
export function DeviceLinkPage({
	account,
	search,
	navigate,
}: {
	/** undefined while the session is still being checked, null when signed out. */
	account: { username: string } | null | undefined
	search: string
	navigate: (to: string) => void
}) {
	const fromQuery = new URLSearchParams(search).get('user_code') ?? ''
	const [code, setCode] = useState(fromQuery)
	const { pending, error, done, run } = useAction()

	useEffect(() => {
		if (account !== null) return
		const next = `/device${search}`
		navigate(`/login?next=${encodeURIComponent(next)}`)
	}, [account, navigate, search])

	if (!account) {
		return (
			<main className="shell">
				<p className="muted">{account === undefined ? 'Loading…' : 'Redirecting to sign in…'}</p>
			</main>
		)
	}

	const submit = (path: 'approve' | 'deny') => {
		void run(async () => {
			await call(`${where().auth}/connect/device/${path}`, {
				authed: true,
				form: { user_code: code.trim() },
			})
			return path === 'approve'
				? 'Studio is signed in. You can close this tab and go back to the editor.'
				: 'Studio was not signed in. You can close this tab.'
		})
	}

	return (
		<main className="shell">
			<section className="card">
				<h2>Sign in to RecFlare Studio</h2>
				<p className="muted">
					The editor asked to use <strong>{account.username}</strong>. The code below is the one
					Studio is showing. Allowing it signs the editor into this account.
				</p>
				<form
					onSubmit={(e) => {
						e.preventDefault()
						submit('approve')
					}}
				>
					<label>
						Code
						<input
							value={code}
							autoComplete="off"
							spellCheck={false}
							onChange={(e) => setCode(e.target.value)}
							required
						/>
					</label>
					<button type="submit" disabled={pending || done !== ''}>
						Allow
					</button>
				</form>
				<button
					type="button"
					disabled={pending || done !== '' || code.trim() === ''}
					onClick={() => submit('deny')}
				>
					Don’t allow
				</button>
				{error && <p className="error">{error}</p>}
				{done && <p className="ok">{done}</p>}
			</section>
		</main>
	)
}
