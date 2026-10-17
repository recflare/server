import { adminSecretsStore, env, SELF } from 'cloudflare:test'
import { beforeAll, expect, it } from 'vitest'

import type { Env } from '../../context'

declare module 'cloudflare:test' {
	interface ProvidedEnv extends Env {}
}

const ORIGIN = 'https://example.com'

beforeAll(async () => {
	// Seed the shared JWT signing key into the local Secrets Store so .get() resolves.
	await adminSecretsStore(env.JWT_SECRET).create('test-signing-key')
})

// Mint a token the way the `auth` worker does, signing with the shared test key seeded into the JWT_SECRET store, so the
// storage worker's validation accepts it.
const TEST_SECRET = 'test-signing-key'

function b64url(input: ArrayBuffer | string): string {
	const bytes = typeof input === 'string' ? new TextEncoder().encode(input) : new Uint8Array(input)
	let binary = ''
	for (const byte of bytes) binary += String.fromCharCode(byte)
	return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

async function bearer(sub = '42', role: string[] = []): Promise<Record<string, string>> {
	const now = Math.floor(Date.now() / 1000)
	const signingInput = `${b64url(JSON.stringify({ alg: 'HS256', typ: 'JWT' }))}.${b64url(
		JSON.stringify({ sub, role, exp: now + 3600 })
	)}`
	const key = await crypto.subtle.importKey(
		'raw',
		new TextEncoder().encode(TEST_SECRET),
		{ name: 'HMAC', hash: 'SHA-256' },
		false,
		['sign']
	)
	const sig = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(signingInput))
	return { Authorization: `Bearer ${signingInput}.${b64url(sig)}` }
}

/** Build the client's multipart upload body: FileType + File. */
function uploadForm(fileType: string, bytes: Uint8Array): FormData {
	const form = new FormData()
	form.set('FileType', fileType)
	form.set('File', new File([bytes], 'file.bin', { type: 'application/octet-stream' }))
	return form
}

it('response with hello world', async () => {
	const res = await SELF.fetch(ORIGIN)
	expect(res.status).toBe(200)
	expect(await res.text()).toMatchInlineSnapshot(`"hello, world!"`)
})

it('POST /upload 401s without a token', async () => {
	const res = await SELF.fetch(`${ORIGIN}/upload`, {
		method: 'POST',
		body: uploadForm('6', new Uint8Array([1])),
	})
	expect(res.status).toBe(401)
})

it('POST /upload stores a RoomMetadata (FileType 6) file under room/ and returns its name', async () => {
	// Mirrors the client's multipart upload: FileType=6, File=<binary>.
	const bytes = new Uint8Array([0x10, 0x02, 0x1a, 0x00])
	const res = await SELF.fetch(`${ORIGIN}/upload`, {
		method: 'POST',
		headers: await bearer(),
		body: uploadForm('6', bytes),
	})
	expect(res.status).toBe(200)
	const { filename } = (await res.json()) as { filename: string }
	expect(filename).toMatch(
		/^\d{4}-\d{2}-\d{2}\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/
	)

	// The bytes are persisted in the shared CDN bucket under `room/`, the same folder as a
	// scene blob: the client downloads the room's `DataBlob` from the cdn's `/room/<name>`.
	const stored = await env.CDN_ASSETS.get(`room/${filename}`)
	expect(stored).not.toBeNull()
	expect(new Uint8Array(await stored!.arrayBuffer())).toEqual(bytes)
})

it('POST /upload folders each FileType under its own subfolder', async () => {
	const headers = await bearer()
	const cases: Array<[string, string]> = [
		// RoomSave lands under `room/` so the cdn worker's /room/:dataBlob serves it.
		['1', 'room'],
		['3', 'image'],
		['5', 'invention'],
	]
	for (const [fileType, subfolder] of cases) {
		const res = await SELF.fetch(`${ORIGIN}/upload`, {
			method: 'POST',
			headers,
			body: uploadForm(fileType, new Uint8Array([1, 2, 3])),
		})
		expect(res.status).toBe(200)
		const { filename } = (await res.json()) as { filename: string }
		expect(await env.CDN_ASSETS.get(`${subfolder}/${filename}`)).not.toBeNull()
	}
})

it('POST /upload names an Invention (FileType 5) upload with the .inv extension', async () => {
	// The client expects the `.inv` extension on the BlobName it later reads back from
	// the api worker, so the extension has to be on the stored key too — otherwise the
	// cdn worker would have nothing to serve at that name.
	const bytes = new Uint8Array([0x49, 0x4e, 0x56])
	const res = await SELF.fetch(`${ORIGIN}/upload`, {
		method: 'POST',
		headers: await bearer(),
		body: uploadForm('5', bytes),
	})
	expect(res.status).toBe(200)
	const { filename } = (await res.json()) as { filename: string }
	expect(filename).toMatch(/^\d{4}-\d{2}-\d{2}\/[0-9a-f-]{36}\.inv$/)

	const stored = await env.CDN_ASSETS.get(`invention/${filename}`)
	expect(stored).not.toBeNull()
	expect(new Uint8Array(await stored!.arrayBuffer())).toEqual(bytes)
})

it('POST /upload 400s for a binary with an unknown/missing FileType', async () => {
	// Unknown type (999) and the Unknown enum value (0) have no destination → 400.
	for (const fileType of ['999', '0']) {
		const res = await SELF.fetch(`${ORIGIN}/upload`, {
			method: 'POST',
			headers: await bearer(),
			body: uploadForm(fileType, new Uint8Array([9])),
		})
		expect(res.status).toBe(400)
	}
})

it('POST /upload rejects a binary above the configured size limit without storing it', async () => {
	const original = env.MAX_UPLOAD_BYTES
	env.MAX_UPLOAD_BYTES = '3'
	try {
		const res = await SELF.fetch(`${ORIGIN}/upload`, {
			method: 'POST',
			headers: await bearer(),
			body: uploadForm('3', new Uint8Array([1, 2, 3, 4])),
		})
		expect(res.status).toBe(413)
		expect((await res.json()) as { error: string }).toEqual({
			error: 'file exceeds the 3-byte upload limit',
		})
	} finally {
		env.MAX_UPLOAD_BYTES = original
	}
})

it('POST /upload lets staff upload past the size limit', async () => {
	const original = env.MAX_UPLOAD_BYTES
	env.MAX_UPLOAD_BYTES = '3'
	try {
		for (const role of ['developer', 'moderator']) {
			const res = await SELF.fetch(`${ORIGIN}/upload`, {
				method: 'POST',
				headers: await bearer('42', ['gameClient', role]),
				body: uploadForm('3', new Uint8Array([1, 2, 3, 4])),
			})
			expect(res.status).toBe(200)
			const { filename } = (await res.json()) as { filename: string }
			expect((await env.CDN_ASSETS.get(`image/${filename}`))?.size).toBe(4)
		}
	} finally {
		env.MAX_UPLOAD_BYTES = original
	}
})

it('POST /upload echoes an explicit name when no binary is posted', async () => {
	const form = new FormData()
	form.set('FileType', '3')
	form.set('imageName', 'existing-image-key.png')
	const res = await SELF.fetch(`${ORIGIN}/upload`, {
		method: 'POST',
		headers: await bearer(),
		body: form,
	})
	expect(res.status).toBe(200)
	expect((await res.json()) as { filename: string }).toEqual({
		filename: 'existing-image-key.png',
	})
})

it('POST /upload 400s when there is neither a file nor a name', async () => {
	const form = new FormData()
	form.set('FileType', '6')
	const res = await SELF.fetch(`${ORIGIN}/upload`, {
		method: 'POST',
		headers: await bearer(),
		body: form,
	})
	expect(res.status).toBe(400)
})

it('answers the CORS preflight the website’s upload needs', async () => {
	// The room management page uploads a subroom's scene blob straight from the browser.
	// The bearer token makes that a preflighted request, so a missing OPTIONS handler
	// stops the upload before any of the tests above are even reached.
	const res = await SELF.fetch(`${ORIGIN}/upload`, {
		method: 'OPTIONS',
		headers: {
			Origin: 'https://www.example.com',
			'Access-Control-Request-Method': 'POST',
			'Access-Control-Request-Headers': 'authorization',
		},
	})
	expect(res.status).toBe(204)
	expect(res.headers.get('access-control-allow-origin')).toBe('*')
	expect(res.headers.get('access-control-allow-headers')?.toLowerCase()).toContain('authorization')
})

it('GET /openapi.json documents every route', async () => {
	const res = await SELF.fetch(`${ORIGIN}/openapi.json`)
	expect(res.status).toBe(200)
	const spec = (await res.json()) as {
		openapi: string
		paths: Record<string, Record<string, { summary?: string }>>
	}
	expect(spec.openapi).toMatch(/^3\.1/)

	// The spec route hides itself.
	expect(spec.paths['/openapi.json']).toBeUndefined()

	// Every route the worker serves is described. This is the drift guard: adding a
	// route without a describeRoute() block fails here rather than silently shipping
	// an incomplete spec.
	const documented = new Set(
		Object.entries(spec.paths).flatMap(([path, ops]) =>
			Object.keys(ops).map((method) => `${method.toUpperCase()} ${path}`)
		)
	)
	expect([...documented].sort()).toEqual(['GET /', 'POST /upload', 'POST /upload/unityassets'])

	// Every operation carries a summary — a path present but undescribed is not
	// documentation.
	for (const ops of Object.values(spec.paths)) {
		for (const op of Object.values(ops)) expect(op.summary).toBeTruthy()
	}

	// Every schema inlines: a `$ref` here would be a dangling reference (see openapi.ts).
	expect(JSON.stringify(spec).includes('"$ref"')).toBe(false)
})

it('uploads Studio source files in order with verified hashes and a manifest under its own prefix', async () => {
	const headers = { ...(await bearer()), 'User-Agent': 'RRStudio' }
	const body = new FormData()
	body.append('file', new File(['first'], 'a.txt'))
	body.append('file', new File(['second'], 'b.txt'))
	const res = await SELF.fetch(`${ORIGIN}/upload/unityassets`, { method: 'POST', headers, body })
	expect(res.status).toBe(200)
	const files = (await res.json()) as Array<{ Filename: string; Hash: string }>
	expect(files).toHaveLength(2)
	for (const [i, file] of files.entries()) {
		expect(file.Filename).toMatch(/^[0-9a-z]{40}$/)
		const stored = await env.CDN_ASSETS.get(`unityasset/${file.Filename}`)
		expect(await stored!.text()).toBe(i === 0 ? 'first' : 'second')
		const hash = await crypto.subtle.digest(
			'SHA-256',
			new TextEncoder().encode(i === 0 ? 'first' : 'second')
		)
		expect(file.Hash).toBe(btoa(String.fromCharCode(...new Uint8Array(hash))))
	}
	const manifest = new FormData()
	manifest.append('fileType', '9')
	manifest.append(
		'file',
		new File(['{"Version":3,"Files":[]}'], 'manifest.json', { type: 'application/json' })
	)
	const uploaded = await SELF.fetch(`${ORIGIN}/upload`, { method: 'POST', headers, body: manifest })
	expect(uploaded.status).toBe(200)
	const source = (await uploaded.json()) as { Filename: string; Hash: string }
	expect(source.Hash).toBeTruthy()
	expect(await (await env.CDN_ASSETS.get(`roomunityasset/${source.Filename}`))!.text()).toBe(
		'{"Version":3,"Files":[]}'
	)
	const unauthenticated = new FormData()
	unauthenticated.append('file', new File(['x'], 'x.txt'))
	expect(
		(await SELF.fetch(`${ORIGIN}/upload/unityassets`, { method: 'POST', body: unauthenticated }))
			.status
	).toBe(401)
})

it('accepts the Mono multipart wire format without changing binary file bytes', async () => {
	const boundary = 'mono-studio-boundary'
	const payload = new Uint8Array([0, 255, 128, 13, 10, 0, 200])
	const parts: Array<string | Uint8Array> = []
	for (let i = 0; i < 2; i++)
		parts.push(
			`--${boundary}\r\nContent-Type: application/octet-stream\r\nContent-Disposition: form-data; name=file; filename=file.bin; filename*=utf-8''file.bin\r\n\r\n`,
			payload,
			'\r\n'
		)
	parts.push(`--${boundary}--\r\n`)
	const body = await new Response(
		new Blob(parts).stream().pipeThrough(new CompressionStream('gzip'))
	).arrayBuffer()
	const result = await SELF.fetch(`${ORIGIN}/upload/unityassets`, {
		method: 'POST',
		headers: {
			...(await bearer()),
			'Content-Type': `multipart/form-data; boundary="${boundary}"`,
			'Content-Encoding': 'gzip',
		},
		body,
	})
	expect(result.status).toBe(200)
	const files = await result.json<Array<{ Filename: string }>>()
	expect(files).toHaveLength(2)
	expect(files[0].Filename).toBe(files[1].Filename)
	const saved = await env.CDN_ASSETS.get(`unityasset/${files[0].Filename}`)
	expect(new Uint8Array(await saved!.arrayBuffer())).toEqual(payload)
})

it('accepts Studio gzip multipart batches with stable content-addressed filenames', async () => {
	const body = new FormData()
	body.append('file', new File(['first'], 'file.bin'))
	body.append('file', new File(['second'], 'file.bin'))
	body.append('file', new File(['first'], 'file.bin'))
	const request = new Request(`${ORIGIN}/upload/unityassets`, { method: 'POST', body })
	const compressed = request.body!.pipeThrough(new CompressionStream('gzip'))
	const bytes = await new Response(compressed).arrayBuffer()
	const headers = {
		...(await bearer()),
		'User-Agent': 'RRStudio',
		'Content-Type': request.headers.get('content-type')!,
		'Content-Encoding': 'gzip',
	}
	const upload = async () => SELF.fetch(request.url, { method: 'POST', headers, body: bytes })
	const result = await upload()
	expect(result.status).toBe(200)
	const files = await result.json<Array<{ Filename: string; Hash: string }>>()
	expect(files).toHaveLength(3)
	expect(files.map((file) => file.Filename)).toEqual([
		'3jz19z865iu7adldcdxv6stlddxq0yp5qjvnon77',
		'4wk7uj0ueguhyik1bkmvgcl60upxvkg9wwjbdlrk',
		'3jz19z865iu7adldcdxv6stlddxq0yp5qjvnon77',
	])
	expect(files[0]).toEqual(files[2])
	expect(files[0]!.Filename).not.toBe(files[1]!.Filename)
	for (const [i, file] of files.entries()) {
		expect(await (await env.CDN_ASSETS.get(`unityasset/${file.Filename}`))!.text()).toBe(
			i === 1 ? 'second' : 'first'
		)
	}
	expect(await (await upload()).json()).toEqual(files)
	// The next SDK request compresses the source manifest through /upload too.
	const manifest = JSON.stringify({
		Version: 3,
		Files: files.map((file, i) => ({ n: file.Filename, p: `Assets/${i}.txt` })),
	})
	const manifestForm = new FormData()
	manifestForm.append('fileType', '9')
	manifestForm.append('file', new File([manifest], 'file.bin', { type: 'application/json' }))
	const manifestRequest = new Request(`${ORIGIN}/upload`, { method: 'POST', body: manifestForm })
	const manifestBytes = await new Response(
		manifestRequest.body!.pipeThrough(new CompressionStream('gzip'))
	).arrayBuffer()
	const saved = await SELF.fetch(manifestRequest.url, {
		method: 'POST',
		headers: { ...headers, 'Content-Type': manifestRequest.headers.get('content-type')! },
		body: manifestBytes,
	})
	expect(saved.status).toBe(200)
	const metadata = await saved.json<{ Filename: string }>()
	expect(await (await env.CDN_ASSETS.get(`roomunityasset/${metadata.Filename}`))!.text()).toBe(
		manifest
	)
})

it('rejects malformed and oversized compressed source uploads without an internal error', async () => {
	const headers = {
		...(await bearer()),
		'Content-Encoding': 'gzip',
		'Content-Type': 'multipart/form-data; boundary=test',
	}
	expect(
		(
			await SELF.fetch(`${ORIGIN}/upload/unityassets`, {
				method: 'POST',
				headers,
				body: 'invalid gzip',
			})
		).status
	).toBe(400)
	const original = env.MAX_UPLOAD_BYTES
	env.MAX_UPLOAD_BYTES = '16'
	try {
		const form = new FormData()
		form.append('file', new File([new Uint8Array(100_000)], 'large.bin'))
		const request = new Request(`${ORIGIN}/upload/unityassets`, { method: 'POST', body: form })
		const compressed = await new Response(
			request.body!.pipeThrough(new CompressionStream('gzip'))
		).arrayBuffer()
		expect(compressed.byteLength).toBeLessThan(1000)
		const response = await SELF.fetch(request.url, {
			method: 'POST',
			headers: { ...headers, 'Content-Type': request.headers.get('content-type')! },
			body: compressed,
		})
		expect(response.status).toBe(413)
	} finally {
		if (original === undefined) delete env.MAX_UPLOAD_BYTES
		else env.MAX_UPLOAD_BYTES = original
	}
})
