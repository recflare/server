import { useCallback, useEffect, useState } from 'react'

import { call, isDeveloper, where } from './api'
import { TestTodos } from './TestTodos'

interface TestCase {
	Id: string
	Title: string
	Description: string
	Status: number
	AssignedPlayerNames: string[]
	Comments: Array<{ CreatedAt: string; Comment: string }>
}
interface TestRun {
	Id: number
	Name: string
	TestCases: TestCase[]
	NumPassedTestCases: number
	NumFailedTestCases: number
}
const STATUS = ['Untested', 'Claimed', 'Failed', 'Passed', 'Blocked']
const ROOT = '/api/testcasemanagement/v1'

export function TestCasesPage({
	path,
	signedIn,
	navigate,
}: {
	path: string
	signedIn: boolean | undefined
	navigate: (to: string) => void
}) {
	const [runs, setRuns] = useState<TestRun[]>([])
	const [detail, setDetail] = useState<TestCase | null>(null)
	const [error, setError] = useState('')
	const [loading, setLoading] = useState(true)
	const [pending, setPending] = useState(false)
	const [comment, setComment] = useState('')
	const [status, setStatus] = useState(0)
	const id = path.split('/')[2] ? decodeURIComponent(path.split('/')[2]!) : null
	const load = useCallback(
		async (quiet = false) => {
			if (!signedIn || !isDeveloper()) {
				setLoading(false)
				return
			}
			if (!quiet) setLoading(true)
			setError('')
			try {
				if (id) {
					const result = await call<TestCase>(
						`${where().api}${ROOT}/testcase/${encodeURIComponent(id)}`,
						{ authed: true }
					)
					setDetail(result)
					if (!quiet) setStatus(result.Status)
				} else
					setRuns(await call<TestRun[]>(`${where().api}${ROOT}/testpasssummary`, { authed: true }))
			} catch (e) {
				setError(e instanceof Error ? e.message : 'Unable to load test cases.')
			} finally {
				setLoading(false)
			}
		},
		[signedIn, id]
	)
	useEffect(() => {
		setDetail(null)
		setComment('')
		void load()
	}, [load])
	useEffect(() => {
		if (!signedIn || !isDeveloper() || pending) return
		const refresh = () => {
			if (!document.hidden) void load(true)
		}
		const timer = window.setInterval(refresh, 15000)
		window.addEventListener('focus', refresh)
		return () => {
			window.clearInterval(timer)
			window.removeEventListener('focus', refresh)
		}
	}, [load, signedIn, pending])
	async function action(name: string, value?: unknown) {
		if (!id) return
		setPending(true)
		setError('')
		try {
			await call(`${where().api}${ROOT}/testcase/${encodeURIComponent(id)}/${name}`, {
				method: 'POST',
				authed: true,
				json: value,
			})
			if (name === 'comment') setComment('')
			await load()
		} catch (e) {
			setError(e instanceof Error ? e.message : 'Unable to save result.')
		} finally {
			setPending(false)
		}
	}
	return (
		<main className="shell home">
			<h1>Test Case Management</h1>
			{signedIn === undefined ? (
				<p>Checking your session…</p>
			) : !signedIn ? (
				<>
					<p>Sign in with a developer account to view and update test cases.</p>
					<button onClick={() => navigate(`/login?next=${encodeURIComponent(path)}`)}>
						Sign in
					</button>
				</>
			) : !isDeveloper() ? (
				<p className="error">Developer access is required.</p>
			) : (
				<>
					<TestTodos onChange={() => load(true)} />
					<p>
						<button onClick={() => navigate('/testcases')}>All test runs</button>{' '}
						<button disabled={pending} onClick={() => void load()}>
							Refresh
						</button>
					</p>
					{error && (
						<p className="error" role="alert">
							{error}
						</p>
					)}
					{loading ? (
						<p>Loading test cases…</p>
					) : id && detail ? (
						<section className="card">
							<h2>
								{detail.Id}: {detail.Title}
							</h2>
							<p>{detail.Description}</p>
							<p>
								Status: <strong>{STATUS[detail.Status] ?? 'Unknown'}</strong>
							</p>
							<p>Assignees: {detail.AssignedPlayerNames.join(', ') || 'Unassigned'}</p>
							<p>
								<button disabled={pending} onClick={() => void action('claim')}>
									Claim
								</button>{' '}
								<button disabled={pending} onClick={() => void action('unclaim')}>
									Release my claim
								</button>
							</p>
							<form
								onSubmit={(e) => {
									e.preventDefault()
									void action('status', status)
								}}
							>
								<label>
									Result{' '}
									<select
										value={status}
										disabled={pending}
										onChange={(e) => setStatus(Number(e.target.value))}
									>
										{STATUS.map((name, value) => (
											<option key={name} value={value}>
												{name}
											</option>
										))}
									</select>
								</label>
								<button disabled={pending}>Save result</button>
							</form>
							<h3>Comments</h3>
							{detail.Comments.length ? (
								detail.Comments.map((entry, i) => (
									<div key={i}>
										<p className="muted">{new Date(entry.CreatedAt).toLocaleString()}</p>
										<p style={{ whiteSpace: 'pre-wrap' }}>{entry.Comment}</p>
									</div>
								))
							) : (
								<p>No comments yet.</p>
							)}
							<form
								onSubmit={(e) => {
									e.preventDefault()
									void action('comment', comment)
								}}
							>
								<label>
									Comment{' '}
									<textarea
										value={comment}
										maxLength={16000}
										required
										disabled={pending}
										onChange={(e) => setComment(e.target.value)}
									/>
								</label>
								<button disabled={pending || !comment.trim()}>Add comment</button>
							</form>
						</section>
					) : !id ? (
						runs.map((run) => (
							<section className="card" key={run.Id}>
								<h2>{run.Name}</h2>
								<p>
									{run.NumPassedTestCases} passed · {run.NumFailedTestCases} failed ·{' '}
									{run.TestCases.length} total
								</p>
								{run.TestCases.map((test) => (
									<p key={test.Id}>
										<a
											href={`/testcases/${encodeURIComponent(test.Id)}`}
											onClick={(e) => {
												e.preventDefault()
												navigate(`/testcases/${encodeURIComponent(test.Id)}`)
											}}
										>
											{test.Id}: {test.Title}
										</a>{' '}
										— {STATUS[test.Status]}
									</p>
								))}
							</section>
						))
					) : null}
				</>
			)}
		</main>
	)
}
