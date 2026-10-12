import { adminSecretsStore, env, SELF } from 'cloudflare:test'
import { sign } from 'hono/jwt'
import { beforeAll, expect, it } from 'vitest'

import { SCHEMA_DDL as ACCOUNT_SCHEMA_DDL } from '@repo/domain/src/accounts-db'

import migration from '../../../migrations/0035_test_case_management.sql?raw'
import todoMigration from '../../../migrations/0036_test_case_todos.sql?raw'

const ROOT = 'https://api.recflare.net/api/testcasemanagement/v1'
beforeAll(async () => {
	await adminSecretsStore(env.JWT_SECRET).create('tcm-test-key')
	for (const sql of ACCOUNT_SCHEMA_DDL) await env.DB.prepare(sql).run()
	await env.DB.prepare('INSERT INTO account (data) VALUES (?)')
		.bind(JSON.stringify({ accountId: 42, username: 'Tester', displayName: 'Test Developer' }))
		.run()
	for (const sql of (migration + todoMigration)
		.split(';')
		.map((s) => s.trim())
		.filter(Boolean))
		await env.DB.prepare(sql).run()
	await env.DB.prepare(
		"INSERT INTO tcm_plan (id,name,description) VALUES (1,'Test plan','Synthetic test plan')"
	).run()
	await env.DB.prepare(
		"INSERT INTO tcm_pass (id,plan_id,name,description) VALUES (1,1,'Test run','Synthetic test run')"
	).run()
	for (let id = 1; id <= 6; id++)
		await env.DB.prepare('INSERT INTO tcm_case (id,pass_id,title,description) VALUES (?,1,?,?)')
			.bind(`TEST-${id}`, `Case ${id}`, 'Synthetic test case')
			.run()
})
it('persists a separate checklist through create, edit, complete, reopen and delete', async () => {
	const request = async (path: string, method = 'GET', body?: unknown, developer = true) =>
		SELF.fetch(`${ROOT}/todos${path}`, {
			method,
			headers: await headers(developer),
			body: body === undefined ? undefined : JSON.stringify(body),
		})
	expect((await SELF.fetch(`${ROOT}/todos`)).status).toBe(401)
	expect((await request('', 'POST', { Title: 'Denied' }, false)).status).toBe(403)
	expect((await request('', 'POST', { Title: ' ' })).status).toBe(400)
	const created = await request('', 'POST', { Title: ' Verify two-client voice ' })
	expect(created.status).toBe(201)
	const todo = await created.json<{
		Id: string
		Title: string
		Completed: boolean
		CaseId: string
	}>()
	expect(todo).toEqual(
		expect.objectContaining({ Title: 'Verify two-client voice', Completed: false, CreatedBy: 42 })
	)
	expect(await (await request('')).json()).toEqual([todo])
	const nativeCase = await SELF.fetch(`${ROOT}/testcase/${todo.CaseId}`, {
		headers: await headers(),
	})
	expect(await nativeCase.json()).toEqual(
		expect.objectContaining({ Status: 1, AssignedPlayerNames: ['_Tester'] })
	)
	expect((await request(`/${todo.Id}`, 'PATCH', { Completed: 'true' })).status).toBe(400)
	const completed = await request(`/${todo.Id}`, 'PATCH', {
		Title: 'Verify remote voice',
		Completed: true,
	})
	expect(await completed.json()).toEqual(
		expect.objectContaining({ Title: 'Verify remote voice', Completed: true })
	)
	const reopened = await request(`/${todo.Id}`, 'PATCH', { Completed: false })
	expect(await reopened.json()).toEqual(
		expect.objectContaining({ Title: 'Verify remote voice', Completed: false })
	)
	const inGameResult = await SELF.fetch(`${ROOT}/testcase/${todo.CaseId}/status`, {
		method: 'POST',
		headers: await headers(),
		body: '3',
	})
	expect(inGameResult.status).toBe(200)
	expect(await (await request('')).json()).toEqual([
		expect.objectContaining({ Id: todo.Id, Completed: true }),
	])
	expect((await request(`/${todo.Id}`, 'PATCH', { Completed: false }, false)).status).toBe(403)
	expect((await request(`/${todo.Id}`, 'DELETE', undefined, false)).status).toBe(403)
	const plan = await SELF.fetch(`${ROOT}/testplans`, { headers: await headers() })
	expect(await plan.json()).toEqual([expect.objectContaining({ NumUntestedTestCases: 6 })])
	expect((await request(`/${todo.Id}`, 'DELETE')).status).toBe(204)
	expect(await (await request('')).json()).toEqual([])
	expect((await request(`/${todo.Id}`, 'PATCH', { Completed: true })).status).toBe(404)
})
async function headers(developer = true, sub = '42') {
	return {
		Authorization: `Bearer ${await sign({ sub, role: developer ? ['developer'] : ['gameClient'], exp: Math.floor(Date.now() / 1000) + 3600 }, 'tcm-test-key', 'HS256')}`,
		'content-type': 'application/json',
	}
}
it('requires developer authentication for lists and mutations', async () => {
	expect((await SELF.fetch(`${ROOT}/testplans`)).status).toBe(401)
	expect((await SELF.fetch(`${ROOT}/testplans`, { headers: await headers(false) })).status).toBe(
		403
	)
	expect(
		(
			await SELF.fetch(`${ROOT}/testcase/TEST-1/status`, {
				method: 'POST',
				headers: await headers(false),
				body: '3',
			})
		).status
	).toBe(403)
})
it('loads seeded plans, runs and untested cases in client DTO shapes', async () => {
	const current = await SELF.fetch(`${ROOT}/testpass/0`, { headers: await headers() })
	expect(await current.json()).toEqual(expect.objectContaining({ Id: 1, NumTestCases: 6 }))
	const plans = await SELF.fetch(`${ROOT}/testplans`, { headers: await headers() })
	expect(await plans.json()).toEqual([
		expect.objectContaining({ Id: 1, NumUntestedTestCases: 6, NumPassedTestCases: 0 }),
	])
	const runs = await SELF.fetch(`${ROOT}/testpasssummary`, { headers: await headers() })
	expect(await runs.json()).toEqual([
		expect.objectContaining({
			Id: 1,
			TestPlanId: 1,
			NumTestCases: 6,
			TestCases: expect.arrayContaining([
				expect.objectContaining({
					Id: 'TEST-1',
					Status: 0,
					Comments: [],
					AssignedPlayerNames: [],
				}),
			]),
		}),
	])
})
it('persists claims, statuses and comments and recomputes counts', async () => {
	const call = async (action: string, body?: unknown, sub = '42') =>
		SELF.fetch(`${ROOT}/testcase/TEST-1/${action}`, {
			method: 'POST',
			headers: await headers(true, sub),
			body: body === undefined ? undefined : JSON.stringify(body),
		})
	expect((await call('claim')).status).toBe(200)
	expect((await call('claim', undefined, '43')).status).toBe(409)
	expect((await call('unclaim', undefined, '43')).status).toBe(409)
	expect((await call('status', 3)).status).toBe(200)
	expect((await call('comment', 'Verified login')).status).toBe(200)
	expect((await call('status', 99)).status).toBe(400)
	const detail = await SELF.fetch(`${ROOT}/testcase/TEST-1`, { headers: await headers() })
	expect(await detail.json()).toEqual(
		expect.objectContaining({
			Status: 3,
			AssignedPlayerNames: ['_Tester'],
			Comments: [expect.objectContaining({ Comment: 'Verified login' })],
		})
	)
	const plans = await SELF.fetch(`${ROOT}/testplans`, { headers: await headers() })
	expect(await plans.json()).toEqual([
		expect.objectContaining({ NumPassedTestCases: 1, NumUntestedTestCases: 5 }),
	])
})
