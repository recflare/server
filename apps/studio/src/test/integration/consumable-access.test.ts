import { adminSecretsStore, env, SELF } from 'cloudflare:test'
import { beforeAll, beforeEach, expect, it } from 'vitest'

import {
	SCHEMA_DDL as ACCOUNT_SCHEMA,
	AVATAR_STUDIO_SCHEMA,
	ROOM_SCHEMA_DDL,
	roomRoleWrites,
} from '@repo/domain'
import { generateStudioBuildValidationToken, generateToken } from '@repo/jwt'

import { CLOUD_JOB_SCHEMA } from '../../cloud-builds'

import type { Env } from '../../context'

declare module 'cloudflare:test' {
	interface ProvidedEnv extends Env {}
}
const base = 'https://example.com/access/override/'
beforeAll(async () => {
	await adminSecretsStore(env.JWT_SECRET).create('test-key')
	for (const sql of [
		...ACCOUNT_SCHEMA,
		...ROOM_SCHEMA_DDL,
		...AVATAR_STUDIO_SCHEMA,
		CLOUD_JOB_SCHEMA,
	])
		await env.DB.prepare(sql).run()
	await env.DB.prepare('INSERT INTO account(data) VALUES (?)')
		.bind(JSON.stringify({ accountId: 42, username: 'Fixture', hasStudio: true }))
		.run()
	await env.DB.prepare('INSERT INTO room(data) VALUES (?)')
		.bind(
			JSON.stringify({ RoomId: 3000, CreatorAccountId: 42, Roles: [{ AccountId: 42, Role: 255 }] })
		)
		.run()
	await env.DB.prepare("INSERT INTO avatar_studio_access VALUES (42,8,'now','now')").run()
})
beforeEach(async () => {
	await env.DB.prepare('DELETE FROM studio_cloud_build_job').run()
	await env.DB.prepare(
		'INSERT INTO studio_cloud_build_job(cloud_build_id,payload,status,lease_until,created_at) VALUES (?,?,?,?,?)'
	)
		.bind(
			'123',
			JSON.stringify({ roomId: 3000, room: { Roles: [{ AccountId: 42, Role: 255 }] } }),
			'building',
			new Date(Date.now() + 60000).toISOString(),
			'now'
		)
		.run()
})
async function request(id: number, build = '123') {
	return SELF.fetch(base + id, {
		headers: {
			Authorization: 'Bearer ' + (await generateStudioBuildValidationToken(build, 'test-key')),
		},
	})
}
it('allows read-only consumable validation only for an active job’s room owners', async () => {
	expect(await (await request(42)).json()).toMatchObject({
		AccountId: 42,
		StudioAccess: 1,
		AvatarStudioAccess: 8,
	})
	expect((await request(43)).status).toBe(403)
	expect((await request(42, '124')).status).toBe(403)
	expect((await SELF.fetch(base + '42')).status).toBe(401)
})
it('rejects cancelled and expired jobs', async () => {
	await env.DB.prepare("UPDATE studio_cloud_build_job SET status='cancelled'").run()
	expect((await request(42)).status).toBe(403)
	await env.DB.prepare(
		"UPDATE studio_cloud_build_job SET status='building',lease_until='2000-01-01'"
	).run()
	expect((await request(42)).status).toBe(403)
})
it('lets co-owners validate each other’s grants without exposing unrelated accounts', async () => {
	const Roles = [
		{ AccountId: 42, Role: 255 },
		{ AccountId: 43, Role: 30 },
	]
	// The peer check reads `room_role`, so write the index with the blob as rooms-db does.
	await env.DB.batch([
		env.DB.prepare("UPDATE room SET data=json_set(data,'$.Roles',json(?)) WHERE room_id=3000").bind(
			JSON.stringify(Roles)
		),
		...roomRoleWrites(env.DB, 3000, { Roles } as Parameters<typeof roomRoleWrites>[2]),
	])
	const headers = {
		Authorization:
			'Bearer ' + (await generateToken('43', 'fixture', 0, 'test-key', ['betastudio'])),
	}
	expect(await (await SELF.fetch(base + '42', { headers })).json()).toMatchObject({
		AvatarStudioAccess: 8,
	})
	expect((await SELF.fetch(base + '44', { headers })).status).toBe(403)
})

it('uses target entitlement for staff inspections in both directions', async () => {
	await env.DB.prepare('INSERT INTO account(data) VALUES (?)')
		.bind(JSON.stringify({ accountId: 44, username: 'Disabled', hasStudio: false }))
		.run()
	await env.DB.prepare("INSERT INTO avatar_studio_access VALUES (44,15,'now','now')").run()
	const staff = async (roles: string[]) => ({
		Authorization: 'Bearer ' + (await generateToken('99', 'staff', 0, 'test-key', roles)),
	})
	expect(
		await (
			await SELF.fetch(base + '44', { headers: await staff(['developer', 'betastudio']) })
		).json()
	).toMatchObject({ AccountId: 44, StudioAccess: 2, AvatarStudioAccess: 0 })
	expect(
		await (await SELF.fetch(base + '42', { headers: await staff(['moderator']) })).json()
	).toMatchObject({ AccountId: 42, StudioAccess: 1, AvatarStudioAccess: 8 })
})
