import { useState } from 'react'

import { call, useAction, where } from './api'

/**
 * Developer-only: upload a video for the developer remote-video screen.
 *
 * `storage` only SIGNS the upload (`POST /upload/video`, developer tokens only); the file goes
 * from this page straight to R2 with the presigned `PUT` it hands back, so a large video never
 * crosses a Worker. The `cdn` worker then serves it at `/video/<name>`, the URL shown here.
 * `XMLHttpRequest` rather than `fetch` because only it reports upload progress.
 */

interface Issued {
	uploadUrl: string
	key: string
	contentType: string
}

/** PUT `file` to the presigned URL, reporting 0..1 as bytes go out. */
function putFile(
	url: string,
	file: File,
	contentType: string,
	onProgress: (fraction: number) => void
): Promise<void> {
	return new Promise((resolve, reject) => {
		const xhr = new XMLHttpRequest()
		xhr.open('PUT', url)
		// Must be exactly what www signed — the signature binds it.
		xhr.setRequestHeader('content-type', contentType)
		xhr.upload.onprogress = (e) => {
			if (e.lengthComputable) onProgress(e.loaded / e.total)
		}
		xhr.onload = () =>
			xhr.status >= 200 && xhr.status < 300
				? resolve()
				: reject(new Error(`The upload was refused (${xhr.status}). The link may have expired.`))
		// A blocked cross-origin PUT has no status to report, and the usual cause is the bucket's
		// CORS rule not allowing this origin — say so rather than "network error".
		xhr.onerror = () =>
			reject(
				new Error(
					'The upload could not reach the bucket. Check your connection, and that the bucket allows PUT from this site (CORS).'
				)
			)
		xhr.send(file)
	})
}

export function VideoUploadForm() {
	const [file, setFile] = useState<File | null>(null)
	const [progress, setProgress] = useState<number | null>(null)
	const [url, setUrl] = useState('')
	const { pending, error, done, run } = useAction()

	return (
		<section className="card">
			<h2>Video upload</h2>
			<p className="muted">
				Upload a video for the developer remote-video screen. .mp4, .m4v, .webm and .mov are
				accepted. Anyone with the link can watch it once it is up, so only upload what you mean to
				share.
			</p>
			<form
				onSubmit={(e) => {
					e.preventDefault()
					if (!file) return
					setUrl('')
					void run(async () => {
						try {
							setProgress(0)
							const issued = await call<Issued>(`${where().storage}/upload/video`, {
								authed: true,
								json: { filename: file.name },
							})
							await putFile(issued.uploadUrl, file, issued.contentType, setProgress)
							const link = `${where().cdn}/${issued.key}`
							setUrl(link)
							setFile(null)
							return 'Uploaded.'
						} finally {
							setProgress(null)
						}
					})
				}}
			>
				<label>
					Video file
					<input
						key={done}
						type="file"
						accept=".mp4,.m4v,.webm,.mov,video/mp4,video/webm,video/quicktime"
						required
						onChange={(e) => setFile(e.target.files?.[0] ?? null)}
					/>
				</label>
				{progress !== null && (
					<progress value={progress} max={1}>
						{Math.round(progress * 100)}%
					</progress>
				)}
				{error && <p className="error">{error}</p>}
				{done && <p className="ok">{done}</p>}
				{url && (
					<p>
						<input type="text" readOnly value={url} onFocus={(e) => e.currentTarget.select()} />
						<button type="button" onClick={() => void navigator.clipboard.writeText(url)}>
							Copy link
						</button>
					</p>
				)}
				<button type="submit" disabled={pending || !file}>
					{pending ? 'Uploading…' : 'Upload'}
				</button>
			</form>
		</section>
	)
}
