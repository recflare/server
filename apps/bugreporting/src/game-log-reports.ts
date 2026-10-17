import { Hono } from 'hono'
import { bodyLimit } from 'hono/body-limit'

import { validateAndGetAccountId } from '@repo/jwt'

import type { App } from './context'

const routes = new Hono<App>()

// 20260323.14 uses PUT for every stage: client metadata, user information,
// raw log/screenshot uploads, then an empty PUT to complete the report.
routes.use('*', bodyLimit({ maxSize: 32 * 1024 * 1024 }))
routes.use('*', async (c, next) => {
	const accountId = await validateAndGetAccountId(c.req.raw, await c.env.JWT_SECRET.get())
	if (accountId === null) return c.json({ error: 'Unauthorized' }, 401)
	c.set('reportAccountId', accountId)
	const id = c.req.path.match(/^\/(?:api\/)?reports\/([^/]+)(?:\/|$)/i)?.[1]
	if (!id || !/^[\da-f]{8}-[\da-f]{4}-[\da-f]{4}-[\da-f]{4}-[\da-f]{12}$/i.test(id))
		return c.json({ error: 'Invalid report id' }, 400)
	await next()
})
routes.put('/:id', async (c) => {
	const id = c.req.param('id').toLowerCase()
	const bytes = await c.req.text()
	if (bytes.length > 512 * 1024) return c.json({ error: 'Report metadata too large' }, 413)
	let payload: Record<string, unknown> | null = null
	if (bytes.trim()) {
		try {
			const value: unknown = JSON.parse(bytes)
			if (!value || typeof value !== 'object' || Array.isArray(value))
				throw new Error('Invalid report')
			payload = value as Record<string, unknown>
		} catch {
			return c.json({ error: 'Malformed report' }, 400)
		}
		if (
			typeof payload.ReportId !== 'string' ||
			payload.ReportId.toLowerCase() !== id ||
			!payload.Client ||
			typeof payload.Client !== 'object' ||
			Array.isArray(payload.Client)
		)
			return c.json({ error: 'Expected matching ReportId and Client' }, 400)
	}
	const owner = await c.env.DB.prepare('SELECT account_id FROM game_report WHERE id = ?')
		.bind(id)
		.first<{ account_id: number }>()
	if (owner && owner.account_id !== c.get('reportAccountId'))
		return c.json({ error: 'Report not found' }, 404)
	if (!payload) return c.json({ error: 'Expected report metadata' }, 400)
	const saved = await c.env.DB.prepare(
		'INSERT INTO game_report (id, account_id, client) VALUES (?, ?, ?) ON CONFLICT(id) DO UPDATE SET client = excluded.client WHERE game_report.account_id = excluded.account_id RETURNING id'
	)
		.bind(id, c.get('reportAccountId'), JSON.stringify(payload.Client))
		.first()
	if (!saved) return c.json({ error: 'Report not found' }, 404)
	// Creation deserializes RecNetResult; later stages return non-generic tasks.
	return c.json({ Success: true, Error: '', ErrorId: null })
})
routes.use('/:id/*', async (c, next) => {
	const row = await c.env.DB.prepare('SELECT id FROM game_report WHERE id = ? AND account_id = ?')
		.bind(c.req.param('id').toLowerCase(), c.get('reportAccountId'))
		.first()
	if (!row) return c.json({ error: 'Report not found' }, 404)
	await next()
})
routes.put('/:id/userinfo', async (c) => {
	const raw = await c.req.text()
	if (raw.length > 512 * 1024) return c.json({ error: 'Report metadata too large' }, 413)
	let info: Record<string, unknown>
	try {
		info = JSON.parse(raw)
		if (
			!info ||
			typeof info !== 'object' ||
			Array.isArray(info) ||
			typeof info.Title !== 'string' ||
			(info.Description != null && typeof info.Description !== 'string')
		)
			throw new Error('Invalid user information')
	} catch {
		return c.json({ error: 'Malformed user information' }, 400)
	}
	await c.env.DB.prepare('UPDATE game_report SET user_info = ? WHERE id = ? AND account_id = ?')
		.bind(JSON.stringify(info), c.req.param('id').toLowerCase(), c.get('reportAccountId'))
		.run()
	return c.body(null, 200)
})
routes.put('/:id/attachments/:filename', async (c) => {
	const filename = c.req.param('filename')
	if (
		!filename ||
		filename.length > 255 ||
		filename.includes('/') ||
		filename.includes('\\') ||
		filename.split('').some((char) => char.charCodeAt(0) < 32)
	)
		return c.json({ error: 'Invalid filename' }, 400)
	const bytes = await c.req.arrayBuffer()
	if (!bytes.byteLength) return c.json({ error: 'Empty attachment' }, 400)
	const id = c.req.param('id').toLowerCase()
	const old = await c.env.DB.prepare(
		'SELECT object_key FROM game_report_file WHERE report_id = ? AND filename = ?'
	)
		.bind(id, filename)
		.first<{ object_key: string }>()
	const key = `game-reports/${id}/${crypto.randomUUID()}`
	const type = c.req.header('content-type') || 'application/octet-stream'
	await c.env.ATTACHMENTS.put(key, bytes, { httpMetadata: { contentType: type } })
	try {
		await c.env.DB.prepare(
			'INSERT INTO game_report_file (report_id, filename, content_type, size, object_key) VALUES (?, ?, ?, ?, ?) ON CONFLICT(report_id, filename) DO UPDATE SET content_type = excluded.content_type, size = excluded.size, object_key = excluded.object_key'
		)
			.bind(id, filename, type, bytes.byteLength, key)
			.run()
	} catch (error) {
		await c.env.ATTACHMENTS.delete(key)
		throw error
	}
	if (old) await c.env.ATTACHMENTS.delete(old.object_key)
	return c.body(null, 200)
})
routes.get('/:id', async (c) => {
	const row = await c.env.DB.prepare(
		'SELECT client, user_info, completed_at FROM game_report WHERE id = ? AND account_id = ?'
	)
		.bind(c.req.param('id').toLowerCase(), c.get('reportAccountId'))
		.first<{ client: string; user_info: string | null; completed_at: string | null }>()
	if (!row) return c.json({ error: 'Report not found' }, 404)
	const files = await c.env.DB.prepare(
		'SELECT filename, content_type, size FROM game_report_file WHERE report_id = ?'
	)
		.bind(c.req.param('id').toLowerCase())
		.all()
	c.header('Cache-Control', 'private, no-store')
	return c.json({
		Client: JSON.parse(row.client),
		User: row.user_info ? JSON.parse(row.user_info) : null,
		CompletedAt: row.completed_at,
		Files: files.results,
	})
})

// The native finalization path is capitalized: /Reports/{id}/Complete.
routes.put('/:id/Complete', async (c) => {
	if ((await c.req.text()).trim())
		return c.json({ error: 'Expected empty completion request' }, 400)
	await c.env.DB.prepare(
		"UPDATE game_report SET completed_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now') WHERE id = ? AND account_id = ?"
	)
		.bind(c.req.param('id').toLowerCase(), c.get('reportAccountId'))
		.run()
	return c.body(null, 200)
})

export default routes
