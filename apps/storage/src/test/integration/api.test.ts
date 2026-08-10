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

async function bearer(sub = '42'): Promise<Record<string, string>> {
	const now = Math.floor(Date.now() / 1000)
	const signingInput = `${b64url(JSON.stringify({ alg: 'HS256', typ: 'JWT' }))}.${b64url(
		JSON.stringify({ sub, exp: now + 3600 })
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

it('POST /upload stores a RoomMetadata (FileType 6) file under roommetadata/ and returns its name', async () => {
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

	// The bytes are persisted in the shared CDN bucket under the type subfolder.
	const stored = await env.CDN_ASSETS.get(`roommetadata/${filename}`)
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
	expect([...documented].sort()).toEqual(['GET /', 'POST /upload'])

	// Every operation carries a summary — a path present but undescribed is not
	// documentation.
	for (const ops of Object.values(spec.paths)) {
		for (const op of Object.values(ops)) expect(op.summary).toBeTruthy()
	}

	// Every schema inlines: a `$ref` here would be a dangling reference (see openapi.ts).
	expect(JSON.stringify(spec).includes('"$ref"')).toBe(false)
})
