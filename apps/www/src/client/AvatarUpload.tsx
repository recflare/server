import { useEffect, useState } from 'react'

import { call, useAction, where } from './api'

import type { FormEvent } from 'react'

/**
 * Upload finished avatar asset bundles and publish them as a custom avatar item.
 *
 * Open to accounts with Studio access (the `hasStudio` flag or the rollout role) and the
 * avatar access bit; `/api/studio-access` says which. That is a courtesy that hides the
 * form — `POST <studio>/avatar-items` checks the same things itself. An item goes
 * live on upload, so there is no draft state to show.
 */

const PAGE = '/studio/avatar-upload'

/** The `OutfitType` ordinals the upload accepts. Badges (1000) are images, not bundles. */
const OUTFIT_TYPES = [
	0, 2, 3, 10, 20, 100, 101, 102, 103, 104, 200, 203, 300, 301, 500, 501, 502, 503, 504, 505, 506,
	507, 508, 509, 510, 511, 512,
]

const BODY_TYPES = [
	{ value: 4, label: 'Any body' },
	{ value: 0, label: 'Body type 0' },
	{ value: 1, label: 'Body type 1' },
	{ value: 2, label: 'Body type 2' },
	{ value: 3, label: 'Body type 3' },
]

const BUNDLES = [
	{ field: 'windowsMain', label: 'Windows — main bundle' },
	{ field: 'windowsMaterial', label: 'Windows — material bundle' },
	{ field: 'androidMain', label: 'Android — main bundle' },
	{ field: 'androidMaterial', label: 'Android — material bundle' },
] as const

interface Access {
	granted: boolean
	avatar: boolean
}

export function AvatarUploadPage({
	account,
	navigate,
}: {
	/** undefined while the session is still being checked, null when signed out. */
	account: { accountId: number; username: string } | null | undefined
	navigate: (to: string) => void
}) {
	const [access, setAccess] = useState<Access | null>(null)
	const upload = useAction()
	// One entry per body-type set; the value is the body type it starts on. A built-in item has
	// a save per body type and the game picks by the wearer, so one upload can carry several.
	const [sets, setSets] = useState<Array<{ id: string; bodyType: number }>>([
		{ id: crypto.randomUUID(), bodyType: 4 },
	])

	useEffect(() => {
		if (!account) return
		call<Access & Record<string, unknown>>('/api/studio-access', { authed: true })
			.then(setAccess)
			.catch(() => setAccess({ granted: false, avatar: false }))
	}, [account])

	if (account === undefined) return <main className="shell wide" />
	if (account === null) {
		return (
			<main className="shell wide">
				<h1>Upload avatar items</h1>
				<p>
					<a
						href="/login"
						onClick={(e) => {
							e.preventDefault()
							navigate('/login')
						}}
					>
						Sign in
					</a>{' '}
					to upload.
				</p>
			</main>
		)
	}
	if (access === null) return <main className="shell wide" />
	if (!access.granted || !access.avatar) {
		return (
			<main className="shell wide">
				<h1>Upload avatar items</h1>
				<p>
					This account is not on the avatar upload list. Ask staff to add you — see{' '}
					<a
						href="/settings/recroomstudio"
						onClick={(e) => {
							e.preventDefault()
							navigate('/settings/recroomstudio')
						}}
					>
						Studio access
					</a>
					.
				</p>
			</main>
		)
	}

	const submit = (e: FormEvent<HTMLFormElement>) => {
		e.preventDefault()
		const form = e.currentTarget
		const body = new FormData(form)
		void upload.run(async () => {
			// Straight to the studio worker, which owns this data, with the session's token.
			const res = await call<{ value?: { customAvatarItemId?: string } }>(
				`${where().studio}/avatar-items`,
				{ authed: true, multipart: body }
			)
			form.reset()
			setSets([{ id: crypto.randomUUID(), bodyType: 4 }])
			return `Published. Item id: ${res.value?.customAvatarItemId ?? 'unknown'}`
		})
	}

	return (
		<main className="shell wide">
			<h1>Upload avatar items</h1>
			<p>
				Upload a finished Windows and Android bundle pair for each body type the item has. The item
				is published as soon as the upload completes.
			</p>
			<form onSubmit={submit}>
				<label>
					Name
					<input name="name" required maxLength={128} />
				</label>
				<label>
					Description
					<textarea name="description" maxLength={4000} rows={3} />
				</label>
				<label>
					Item type (OutfitType)
					<select name="outfitType" required defaultValue="">
						<option value="" disabled>
							Choose…
						</option>
						{OUTFIT_TYPES.map((t) => (
							<option key={t} value={t}>
								{t}
								{t === 104 || t === 203 ? ' (developers only)' : ''}
							</option>
						))}
					</select>
				</label>
				<label>
					Price (tokens, 0–1000)
					<input name="price" type="number" min={0} max={1000} step={1} defaultValue={0} />
				</label>
				{sets.map((set, i) => (
					<fieldset key={set.id}>
						<legend>Body type set {i + 1}</legend>
						<label>
							Body type
							<select name={`v${i}_bodyType`} defaultValue={String(set.bodyType)}>
								{BODY_TYPES.map((b) => (
									<option key={b.value} value={b.value}>
										{b.label}
									</option>
								))}
							</select>
						</label>
						<label>
							Thumbnail (PNG or JPEG)
							<input name={`v${i}_thumbnail`} type="file" accept="image/png,image/jpeg" required />
						</label>
						{BUNDLES.map((b) => (
							<label key={b.field}>
								{b.label}
								<input name={`v${i}_${b.field}`} type="file" required />
							</label>
						))}
						{sets.length > 1 && (
							<button type="button" onClick={() => setSets(sets.filter((x) => x.id !== set.id))}>
								Remove this set
							</button>
						)}
					</fieldset>
				))}
				{sets.length < BODY_TYPES.length && (
					<button
						type="button"
						onClick={() => setSets([...sets, { id: crypto.randomUUID(), bodyType: 0 }])}
					>
						Add another body type
					</button>
				)}
				<button type="submit" disabled={upload.pending}>
					{upload.pending ? 'Uploading…' : 'Upload and publish'}
				</button>
				{upload.error && <p className="error">{upload.error}</p>}
				{upload.done && <p className="ok">{upload.done}</p>}
			</form>
		</main>
	)
}

export { PAGE as AVATAR_UPLOAD_PAGE }
