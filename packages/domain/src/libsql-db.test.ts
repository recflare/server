import { createClient } from '@libsql/client'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { bindPlaceholders, chunkForBinds } from './d1-binds'
import { libsqlDatabase, resolveDatabaseEnv, withDatabase } from './libsql-db'

import type { Client } from '@libsql/client'

/**
 * The adapter against a real (in-memory) libSQL database, asserting the D1 behaviours the
 * workers lean on: `first` is null on no row, `run`/`all` carry `results` and
 * `meta.changes`, `batch` is one transaction, numbered placeholders bind by position.
 */
describe('libsqlDatabase', () => {
	let client: Client
	let db: D1Database

	beforeEach(async () => {
		client = createClient({ url: ':memory:' })
		db = libsqlDatabase(client)
		await db.exec(`
			CREATE TABLE account (
				data TEXT NOT NULL,
				account_id INTEGER GENERATED ALWAYS AS (json_extract(data, '$.accountId')) VIRTUAL,
				username_lower TEXT GENERATED ALWAYS AS (lower(json_extract(data, '$.username'))) VIRTUAL
			);
			CREATE UNIQUE INDEX idx_account_id ON account (account_id);
		`)
	})

	afterEach(() => {
		client.close()
	})

	const insert = (id: number, username: string) =>
		db
			.prepare('INSERT INTO account (data) VALUES (?1)')
			.bind(JSON.stringify({ accountId: id, username }))
			.run()

	it('runs writes and reports changes like D1', async () => {
		const res = await insert(1, 'Alice')
		expect(res.success).toBe(true)
		expect(res.results).toEqual([])
		expect(res.meta.changes).toBe(1)
		expect(res.meta.last_row_id).toBe(1)

		const del = await db.prepare('DELETE FROM account WHERE account_id = ?1').bind(99).run()
		expect(del.meta.changes).toBe(0)
	})

	it('reads rows as plain objects, and null when there is none', async () => {
		await insert(1, 'Alice')
		const row = await db
			.prepare(
				'SELECT account_id AS id, username_lower AS name, data FROM account WHERE account_id = ?1'
			)
			.bind(1)
			.first<{ id: number; name: string; data: string }>()
		expect(row).toEqual({ id: 1, name: 'alice', data: '{"accountId":1,"username":"Alice"}' })
		// A plain object, not the client's row shape: no hidden length, spreads cleanly.
		expect(Object.keys(row!)).toEqual(['id', 'name', 'data'])
		expect({ ...row }).toEqual(row)

		expect(
			await db.prepare('SELECT 1 FROM account WHERE account_id = ?1').bind(2).first()
		).toBeNull()
		expect(await db.prepare('SELECT account_id FROM account').first<number>('account_id')).toBe(1)
	})

	it('binds numbered placeholders by position, as d1-binds builds them', async () => {
		await insert(1, 'a')
		await insert(2, 'b')
		await insert(3, 'c')
		const ids = [3, 1, 42]
		const [chunk] = chunkForBinds(ids, 1)
		const { results } = await db
			.prepare(
				`SELECT account_id AS id FROM account WHERE username_lower != ?1 AND account_id IN (${bindPlaceholders(chunk!, 1)}) ORDER BY id`
			)
			.bind('zzz', ...chunk!)
			.all<{ id: number }>()
		expect(results).toEqual([{ id: 1 }, { id: 3 }])
	})

	it('supports RETURNING through first() the way the auth refresh path uses it', async () => {
		await insert(7, 'Seven')
		const row = await db
			.prepare('DELETE FROM account WHERE account_id = ?1 RETURNING account_id AS accountId')
			.bind(7)
			.first<{ accountId: number }>()
		expect(row).toEqual({ accountId: 7 })
		expect(await db.prepare('SELECT COUNT(*) AS n FROM account').first<number>('n')).toBe(0)
	})

	it('runs a batch as one transaction and returns a result per statement', async () => {
		const [a, b, c] = await db.batch<{ n: number }>([
			db.prepare('INSERT INTO account (data) VALUES (?1)').bind('{"accountId":1,"username":"a"}'),
			db.prepare('INSERT INTO account (data) VALUES (?1)').bind('{"accountId":2,"username":"b"}'),
			db.prepare('SELECT COUNT(*) AS n FROM account'),
		])
		expect(a!.meta.changes).toBe(1)
		expect(b!.meta.changes).toBe(1)
		expect(c!.results).toEqual([{ n: 2 }])

		// The second insert violates the unique index; the first must not survive either.
		await expect(
			db.batch([
				db.prepare('INSERT INTO account (data) VALUES (?1)').bind('{"accountId":3,"username":"c"}'),
				db.prepare('INSERT INTO account (data) VALUES (?1)').bind('{"accountId":3,"username":"d"}'),
			])
		).rejects.toThrow()
		expect(await db.prepare('SELECT COUNT(*) AS n FROM account').first<number>('n')).toBe(2)
	})

	it('round-trips blobs and booleans', async () => {
		await db.exec('CREATE TABLE blob (id INTEGER PRIMARY KEY, body BLOB, flag INTEGER)')
		const bytes = new Uint8Array([1, 2, 3]).buffer
		await db
			.prepare('INSERT INTO blob (id, body, flag) VALUES (?1, ?2, ?3)')
			.bind(1, bytes, true)
			.run()
		const row = await db.prepare('SELECT body, flag FROM blob WHERE id = ?1').bind(1).first<{
			body: ArrayBuffer
			flag: number
		}>()
		expect(new Uint8Array(row!.body)).toEqual(new Uint8Array([1, 2, 3]))
		expect(row!.flag).toBe(1)
	})

	it('refuses an undefined bind, as D1 does', () => {
		expect(() => db.prepare('SELECT ?1').bind(undefined)).toThrow(/undefined/)
	})

	it('serves raw() rows as arrays', async () => {
		await insert(1, 'Alice')
		expect(await db.prepare('SELECT account_id, username_lower FROM account').raw()).toEqual([
			[1, 'alice'],
		])
		expect(
			await db.prepare('SELECT account_id, username_lower FROM account').raw({ columnNames: true })
		).toEqual([
			['account_id', 'username_lower'],
			[1, 'alice'],
		])
	})
})

describe('withDatabase', () => {
	const d1 = { tag: 'd1' } as unknown as D1Database

	it('passes the env through untouched when no libSQL URL is set', async () => {
		const env = { DB: d1, NAME: 'x' }
		let seen: unknown
		const handler = withDatabase({
			fetch(_request, e) {
				seen = e
				return new Response('ok')
			},
		})
		await handler.fetch!(new Request('https://example.com'), env, {} as ExecutionContext)
		expect(seen).toBe(env)
	})

	it('swaps DB for the libSQL adapter when the URL is set, and only once', () => {
		const env = { DB: d1, LIBSQL_DB_URL: 'libsql://db-org.turso.io', LIBSQL_DB_AUTH_TOKEN: 't' }
		const resolved = resolveDatabaseEnv(env)
		expect(resolved).not.toBe(env)
		expect(resolved.DB).not.toBe(d1)
		expect(typeof resolved.DB.prepare).toBe('function')
		expect(resolved.LIBSQL_DB_URL).toBe(env.LIBSQL_DB_URL)
		// A nested handler (mono mounting a worker) sees an env this module already built.
		expect(resolveDatabaseEnv(resolved)).toBe(resolved)
	})
})
