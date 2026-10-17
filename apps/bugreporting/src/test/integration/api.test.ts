import { adminSecretsStore, applyD1Migrations, env, SELF } from 'cloudflare:test'
import { sign } from 'hono/jwt'
import { beforeAll, expect, it } from 'vitest'

import type { D1Migration } from '@cloudflare/vitest-pool-workers'
import type { Env } from '../../context'

declare module 'cloudflare:test' {
	interface ProvidedEnv extends Env {
		TEST_MIGRATIONS: D1Migration[]
	}
}
const ORIGIN = `https://bugreporting.${env.DOMAIN}`
const SECRET = 'test-bugreport-key'
beforeAll(async () => {
	await adminSecretsStore(env.JWT_SECRET).create(SECRET)
	await applyD1Migrations(env.DB, (env as Env & { TEST_MIGRATIONS: D1Migration[] }).TEST_MIGRATIONS)
})
async function auth(sub = '205') {
	return {
		Authorization: `Bearer ${await sign({ sub, exp: Math.floor(Date.now() / 1000) + 3600 }, SECRET, 'HS256')}`,
	}
}

it('regular players can submit game logs, user details and raw attachments through both URL prefixes', async () => {
	const id = crypto.randomUUID()
	const url = `${ORIGIN}/reports/${id}`
	const headers = await auth('207')
	const client = {
		TriggerType: 0,
		Category: 0,
		TriggerId: crypto.randomUUID(),
		TriggeredAt: new Date().toISOString(),
	}
	expect(
		(
			await SELF.fetch(url, {
				method: 'PUT',
				headers: { ...headers, 'content-type': 'application/json' },
				body: JSON.stringify({ ReportId: id, Client: client }),
			})
		).status
	).toBe(200)
	const user = { Title: 'Standard report', Description: 'Regular player, no developer role' }
	const retried = await SELF.fetch(url, {
		method: 'PUT',
		headers,
		body: JSON.stringify({ ReportId: id, Client: client }),
	})
	expect(await retried.json()).toEqual({ Success: true, Error: '', ErrorId: null })
	expect(
		(await SELF.fetch(`${url}/userinfo`, { method: 'PUT', headers, body: JSON.stringify(user) }))
			.status
	).toBe(200)
	const bytes = new Uint8Array(1024 * 1024).fill(17)
	expect(
		(
			await SELF.fetch(`${ORIGIN}/api/reports/${id}/attachments/client.log.gz`, {
				method: 'PUT',
				headers: { ...headers, 'content-type': 'application/gzip' },
				body: bytes,
			})
		).status
	).toBe(200)
	expect(
		(await SELF.fetch(`${ORIGIN}/Reports/${id}/Complete`, { method: 'PUT', headers })).status
	).toBe(200)
	const saved = await (
		await SELF.fetch(url, { headers })
	).json<{
		Client: unknown
		User: unknown
		CompletedAt: string
		Files: Array<{ filename: string; size: number }>
	}>()
	expect(saved.Client).toEqual(client)
	expect(saved.User).toEqual(user)
	expect(saved.CompletedAt).toBeTruthy()
	expect(saved.Files).toEqual([
		{ filename: 'client.log.gz', content_type: 'application/gzip', size: bytes.length },
	])
	const objects = await env.ATTACHMENTS.list({ prefix: `game-reports/${id}/` })
	expect(objects.objects).toHaveLength(1)
	expect(
		new Uint8Array(await (await env.ATTACHMENTS.get(objects.objects[0].key))!.arrayBuffer())
	).toEqual(bytes)
	for (const [method, suffix, body] of [
		['GET', '', undefined],
		['PUT', '', JSON.stringify({ ReportId: id, Client: client })],
		['PUT', '/userinfo', JSON.stringify(user)],
		['PUT', '/attachments/stolen.log', 'stolen'],
		['PUT', '/Complete', undefined],
	] as const)
		expect(
			(await SELF.fetch(`${url}${suffix}`, { method, headers: await auth('208'), body })).status
		).toBe(404)
	expect((await SELF.fetch(url, { method: 'PUT' })).status).toBe(401)
})

it('game log retries are idempotent and invalid reports do not create data', async () => {
	const id = crypto.randomUUID()
	const url = `${ORIGIN}/reports/${id}`
	const headers = await auth('209')
	expect(
		(await SELF.fetch(`${ORIGIN}/Reports/${id}/Complete`, { method: 'PUT', headers })).status
	).toBe(404)
	expect((await SELF.fetch(url, { method: 'PUT', headers, body: '{}' })).status).toBe(400)
	const body = JSON.stringify({ ReportId: id, Client: { Category: 0 } })
	for (let i = 0; i < 2; i++)
		expect((await SELF.fetch(url, { method: 'PUT', headers, body })).status).toBe(200)
	expect(
		(
			await SELF.fetch(`${url}/userinfo`, {
				method: 'PUT',
				headers,
				body: JSON.stringify({ Title: 'Optional description', Description: null }),
			})
		).status
	).toBe(200)
	for (let i = 0; i < 2; i++)
		expect(
			(
				await SELF.fetch(`${url}/attachments/test.log`, {
					method: 'PUT',
					headers,
					body: `attempt ${i}`,
				})
			).status
		).toBe(200)
	expect((await env.ATTACHMENTS.list({ prefix: `game-reports/${id}/` })).objects).toHaveLength(1)
	expect(
		(await SELF.fetch(`${url}/attachments/empty.log`, { method: 'PUT', headers })).status
	).toBe(400)
})

it('stores a form report and returns the client ticket DTO', async () => {
	const fields = {
		title: 'Loading issue',
		description: 'Stops preparing',
		gameVersion: '20260323.14',
		roomId: '52',
	}
	const res = await SELF.fetch(`${ORIGIN}/ado/bug`, {
		method: 'POST',
		headers: await auth(),
		body: new URLSearchParams(fields),
	})
	expect(res.status).toBe(200)
	const ticket = await res.json<{ Id: number; Link: string }>()
	expect(ticket.Id).toBeGreaterThan(0)
	expect(ticket.Link).toBe(`${ORIGIN}/ado/bug/${ticket.Id}`)
	const saved = await SELF.fetch(ticket.Link, { headers: await auth() })
	expect((await saved.json<{ Report: unknown }>()).Report).toEqual(fields)
	const other = await SELF.fetch(ticket.Link, { headers: await auth('206') })
	expect(other.status).toBe(404)
})
it('also accepts structured JSON reports', async () => {
	const res = await SELF.fetch(`${ORIGIN}/ado/bug`, {
		method: 'POST',
		headers: { ...(await auth()), 'content-type': 'application/json' },
		body: JSON.stringify({ Title: 'Bug', Client: { Version: '20260323.14' } }),
	})
	expect(res.status).toBe(200)
})
it('stores client-sized ADO attachments privately and checks report ownership', async () => {
	const report = await SELF.fetch(`${ORIGIN}/ado/bug`, {
		method: 'POST',
		headers: await auth(),
		body: new URLSearchParams({ title: 'Attachment test' }),
	})
	const ticket = await report.json<{ Id: number; Link: string }>()
	const form = new FormData()
	form.set('adoWorkItemId', String(ticket.Id))
	form.set(
		'file',
		new File([new Uint8Array(1024 * 1024).fill(42)], 'client.log', { type: 'text/plain' })
	)
	const denied = await SELF.fetch(`${ORIGIN}/ado/file`, {
		method: 'POST',
		headers: await auth('206'),
		body: form,
	})
	expect(denied.status).toBe(404)
	const uploaded = await SELF.fetch(`${ORIGIN}/ado/file`, {
		method: 'POST',
		headers: await auth(),
		body: form,
	})
	expect(uploaded.status).toBe(200)
	const detail = await SELF.fetch(ticket.Link, { headers: await auth() })
	const saved = await detail.json<{ Attachments: Array<{ Id: string; Size: number }> }>()
	expect(saved.Attachments).toHaveLength(1)
	expect(saved.Attachments[0].Size).toBe(1024 * 1024)
	const url = `${ORIGIN}/ado/file/${saved.Attachments[0].Id}`
	expect((await SELF.fetch(url, { headers: await auth('206') })).status).toBe(404)
	const file = await SELF.fetch(url, { headers: await auth() })
	expect(file.status).toBe(200)
	expect(new Uint8Array(await file.arrayBuffer())).toEqual(new Uint8Array(1024 * 1024).fill(42))
})
it('keeps a multipart screenshot with its report', async () => {
	const form = new FormData()
	form.set('title', 'Screenshot bug')
	form.set('screenshot', new File(['screenshot bytes'], 'test.png', { type: 'image/png' }))
	const res = await SELF.fetch(`${ORIGIN}/ado/bug`, {
		method: 'POST',
		headers: await auth(),
		body: form,
	})
	const ticket = await res.json<{ Link: string }>()
	const saved = await SELF.fetch(ticket.Link, { headers: await auth() })
	const body = await saved.json<{ Report: { screenshot: { base64: string; filename: string } } }>()
	expect(atob(body.Report.screenshot.base64)).toBe('screenshot bytes')
	expect(body.Report.screenshot.filename).toBe('test.png')
})
it('requires valid authentication', async () => {
	type AuthHeaders = Record<string, string>
	const cases: AuthHeaders[] = [{}, { Authorization: 'Bearer invalid' }]
	for (const headers of cases) {
		const res = await SELF.fetch(`${ORIGIN}/ado/bug`, {
			method: 'POST',
			headers,
			body: 'title=test',
		})
		expect(res.status).toBe(401)
	}
})
it('rejects malformed and empty JSON instead of acknowledging discarded reports', async () => {
	for (const body of ['{', 'null', '[]', '{}']) {
		const res = await SELF.fetch(`${ORIGIN}/ado/bug`, {
			method: 'POST',
			headers: { ...(await auth()), 'content-type': 'application/json' },
			body,
		})
		expect(res.status).toBe(400)
	}
})
it('bounds report uploads', async () => {
	const res = await SELF.fetch(`${ORIGIN}/ado/bug`, {
		method: 'POST',
		headers: { ...(await auth()), 'content-type': 'application/json' },
		body: JSON.stringify({ description: 'x'.repeat(512 * 1024) }),
	})
	expect(res.status).toBe(413)
})
