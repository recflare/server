import { adminSecretsStore, env, SELF } from 'cloudflare:test'
import { beforeAll, describe, expect, it } from 'vitest'

import linkSql from '../../../migrations/0001_link.sql?raw'
import { getLink, randomCode } from '../../link-db'

import type { Env } from '../../context'

declare module 'cloudflare:test' {
	interface ProvidedEnv extends Env {}
}

const ORIGIN = 'https://example.com'

// Mint a token the way the `auth` worker does, signing with the shared test key seeded
// into the JWT_SECRET store.
const TEST_SECRET = 'test-signing-key'

function b64url(input: ArrayBuffer | string): string {
	const bytes = typeof input === 'string' ? new TextEncoder().encode(input) : new Uint8Array(input)
	let binary = ''
	for (const byte of bytes) binary += String.fromCharCode(byte)
	return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

async function bearer(sub: number): Promise<Record<string, string>> {
	const now = Math.floor(Date.now() / 1000)
	const signingInput = `${b64url(JSON.stringify({ alg: 'HS256', typ: 'JWT' }))}.${b64url(
		JSON.stringify({ sub: String(sub), exp: now + 3600 })
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

beforeAll(async () => {
	await adminSecretsStore(env.JWT_SECRET).create(TEST_SECRET)
	// Apply the migration itself, statement by statement, comments stripped.
	const statements = linkSql
		.replace(/--.*$/gm, '')
		.split(';')
		.map((s) => s.trim())
		.filter(Boolean)
	for (const stmt of statements) await env.DB.prepare(stmt).run()
})

async function actionlink(caller: number | null, fields: Record<string, string>) {
	return SELF.fetch(`${ORIGIN}/actionlink`, {
		method: 'POST',
		headers: {
			...(caller === null ? {} : await bearer(caller)),
			'Content-Type': 'application/x-www-form-urlencoded',
		},
		body: new URLSearchParams(fields).toString(),
	})
}

it('response with hello world', async () => {
	const res = await SELF.fetch('https://example.com')
	expect(res.status).toBe(200)
	expect(await res.text()).toMatchInlineSnapshot(`"hello, world!"`)
})

describe('POST /actionlink', () => {
	// The three bodies the client sends, verbatim.
	const ROOM = {
		data: '{"ExtraJson":"{\\u0022RoomId\\u0022:1162}","Platform":0,"Type":5}',
		validHours: '8760',
		codeType: '5',
		extraDataId: '1162',
	}
	const CLUB = {
		data: '{"ExtraJson":"{\\u0022ClubId\\u0022:4,\\u0022Joinability\\u0022:0,\\u0022Visibility\\u0022:1}","Platform":0,"Type":3}',
		validHours: '2160',
		codeType: '3',
		extraDataId: '4',
	}
	const EVENT = {
		data: '{"ExtraJson":"{\\u0022PlayerEventId\\u0022:174}","Platform":0,"Type":4}',
		validHours: '8640',
		codeType: '4',
		extraDataId: '174',
	}

	it('answers a full share URL as a JSON string and stores what the client sent', async () => {
		for (const body of [ROOM, CLUB, EVENT]) {
			const before = Date.now()
			const res = await actionlink(950001, body)
			expect(res.status).toBe(200)
			expect(res.headers.get('content-type')).toContain('application/json')
			const text = await res.text()
			const url = JSON.parse(text) as string
			const parsed = new URL(url)
			expect(parsed.origin).toBe('https://rec.example.com')
			expect(parsed.pathname).toBe('/')
			const code = parsed.searchParams.get('a')
			expect(typeof code).toBe('string')
			expect(text).toBe(JSON.stringify(url))
			expect(code).toMatch(/^[A-Z2-9]{6}$/)

			const row = await getLink(env.DB, code as string)
			expect(row).toMatchObject({
				creator_account_id: 950001,
				code_type: Number(body.codeType),
				extra_data_id: Number(body.extraDataId),
				data: body.data,
				valid_hours: Number(body.validHours),
			})
			const lived = Date.parse(row!.expires_at) - Date.parse(row!.created_at)
			expect(lived).toBe(Number(body.validHours) * 3_600_000)
			expect(Date.parse(row!.created_at)).toBeGreaterThanOrEqual(before - 1000)
		}
	})

	it('mints a new code each time', async () => {
		const a = (await (await actionlink(950002, ROOM)).json()) as string
		const b = (await (await actionlink(950002, ROOM)).json()) as string
		expect(a).not.toBe(b)
	})

	it('401s without a token', async () => {
		expect((await actionlink(null, ROOM)).status).toBe(401)
	})

	it('400s without a codeType or a usable validHours', async () => {
		const { codeType: _codeType, ...noType } = ROOM
		expect((await actionlink(950003, noType)).status).toBe(400)
		expect((await actionlink(950003, { ...ROOM, validHours: '0' })).status).toBe(400)
		expect((await actionlink(950003, { ...ROOM, validHours: 'soon' })).status).toBe(400)
	})
})

describe('GET /actionlink/:code', () => {
	const EVENT_DATA = '{"ExtraJson":"{\\u0022PlayerEventId\\u0022:385}","Platform":0,"Type":4}'

	it('answers the bare { CreatorPlayerId, Data, IsValid } object for a minted code', async () => {
		const url = (await (
			await actionlink(205, {
				data: EVENT_DATA,
				validHours: '8640',
				codeType: '4',
				extraDataId: '385',
			})
		).json()) as string
		const code = new URL(url).searchParams.get('a')!
		const res = await SELF.fetch(`${ORIGIN}/actionlink/${code}`)
		expect(res.status).toBe(200)
		expect(await res.json()).toStrictEqual({
			CreatorPlayerId: 205,
			Data: EVENT_DATA,
			IsValid: true,
		})
	})

	it('marks an expired code invalid', async () => {
		await env.DB.prepare(
			`INSERT INTO link (code, creator_account_id, code_type, extra_data_id, data, valid_hours, created_at, expires_at)
			 VALUES ('OLD234', 205, 4, 385, ?1, 1, '2020-01-01T00:00:00.000Z', '2020-01-01T01:00:00.000Z')`
		)
			.bind(EVENT_DATA)
			.run()
		const res = await SELF.fetch(`${ORIGIN}/actionlink/OLD234`)
		expect(await res.json()).toMatchObject({ IsValid: false })
	})

	it('404s an unknown code', async () => {
		expect((await SELF.fetch(`${ORIGIN}/actionlink/ZZZZZZ`)).status).toBe(404)
	})
})

describe('randomCode', () => {
	it('draws six symbols with no look-alikes', () => {
		for (let i = 0; i < 200; i++) expect(randomCode()).toMatch(/^[A-HJKMNP-Z2-9]{6}$/)
	})
})
