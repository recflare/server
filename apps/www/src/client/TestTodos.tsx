import { useCallback, useEffect, useState } from 'react'

import { call, where } from './api'

interface Todo {
	Id: string
	Title: string
	Completed: boolean
}
const ROOT = '/api/testcasemanagement/v1/todos'

export function TestTodos({ onChange }: { onChange: () => Promise<void> }) {
	const [items, setItems] = useState<Todo[]>([])
	const [title, setTitle] = useState('')
	const [error, setError] = useState('')
	const [loading, setLoading] = useState(true)
	const [pending, setPending] = useState(false)
	const [editing, setEditing] = useState<string | null>(null)
	const [editTitle, setEditTitle] = useState('')
	const load = useCallback(async () => {
		try {
			setItems(await call<Todo[]>(`${where().api}${ROOT}`, { authed: true }))
			setError('')
		} catch (e) {
			setError(e instanceof Error ? e.message : 'Unable to load to-dos.')
		} finally {
			setLoading(false)
		}
	}, [])
	useEffect(() => {
		void load()
		const refresh = () => {
			if (!document.hidden) void load()
		}
		const timer = window.setInterval(refresh, 15000)
		window.addEventListener('focus', refresh)
		return () => {
			window.clearInterval(timer)
			window.removeEventListener('focus', refresh)
		}
	}, [load])
	async function save(method: 'POST' | 'PATCH' | 'DELETE', id?: string, json?: unknown) {
		setPending(true)
		try {
			await call(`${where().api}${ROOT}${id ? `/${encodeURIComponent(id)}` : ''}`, {
				method,
				authed: true,
				json,
			})
			if (method === 'POST') setTitle('')
			setEditing(null)
			await load()
			await onChange()
		} catch (e) {
			setError(e instanceof Error ? e.message : 'Unable to save to-do.')
		} finally {
			setPending(false)
		}
	}
	return (
		<section className="card">
			<h2>To-dos</h2>
			<p>
				New tasks are assigned to you in the active run and appear in the game's To-Do category.
				Completing a task records Passed; reopening records Claimed.
			</p>
			{error && (
				<p className="error" role="alert">
					{error}
				</p>
			)}
			<form
				onSubmit={(e) => {
					e.preventDefault()
					void save('POST', undefined, { Title: title })
				}}
			>
				<label>
					New task{' '}
					<input
						value={title}
						required
						maxLength={2000}
						disabled={pending}
						onChange={(e) => setTitle(e.target.value)}
					/>
				</label>
				<button disabled={pending || !title.trim()}>Add to-do</button>
			</form>
			{loading ? (
				<p>Loading to-dos…</p>
			) : !items.length ? (
				<p>No to-dos yet.</p>
			) : (
				items.map((item) => (
					<div key={item.Id}>
						{editing === item.Id ? (
							<form
								onSubmit={(e) => {
									e.preventDefault()
									void save('PATCH', item.Id, { Title: editTitle })
								}}
							>
								<label>
									Edit task{' '}
									<input
										value={editTitle}
										required
										maxLength={2000}
										disabled={pending}
										onChange={(e) => setEditTitle(e.target.value)}
									/>
								</label>
								<button disabled={pending || !editTitle.trim()}>Save task</button>{' '}
								<button type="button" onClick={() => setEditing(null)}>
									Cancel
								</button>
							</form>
						) : (
							<p>
								<label>
									<input
										type="checkbox"
										checked={item.Completed}
										disabled={pending}
										onChange={() => void save('PATCH', item.Id, { Completed: !item.Completed })}
									/>{' '}
									<span style={{ textDecoration: item.Completed ? 'line-through' : undefined }}>
										{item.Title}
									</span>
								</label>{' '}
								<button
									disabled={pending}
									onClick={() => {
										setEditing(item.Id)
										setEditTitle(item.Title)
									}}
								>
									Edit
								</button>{' '}
								<button disabled={pending} onClick={() => void save('DELETE', item.Id)}>
									Delete
								</button>
							</p>
						)}
					</div>
				))
			)}
		</section>
	)
}
