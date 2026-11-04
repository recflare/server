import { Hono } from 'hono'
import { bodyLimit } from 'hono/body-limit'
import { useWorkersLogger } from 'workers-tagged-logger'

import { withNotFound, withOnError } from '@repo/hono-helpers'
import { validateAndGetAccountId } from '@repo/jwt'

import gameLogReports from './game-log-reports'

import type { App } from './context'

// Store report metadata in D1 and attachments in R2 with account ownership checks.
// The client ticket contract does not require an external work-item backend.
const MAX_REPORT_BYTES = 512 * 1024
const app = new Hono<App>()
	.use('*', (c, next) =>
		useWorkersLogger(c.env.NAME, {
			environment: c.env.ENVIRONMENT,
			release: c.env.SENTRY_RELEASE,
		})(c, next)
	)
	.onError(withOnError())
	.notFound(withNotFound())
	.get('/', (c) => c.json({ service: c.env.NAME, status: 'ok' }))
	.route('/reports', gameLogReports)
	.route('/api/reports', gameLogReports)
	.route('/Reports', gameLogReports)
	.route('/api/Reports', gameLogReports)
	.use('/ado/*', async (c, next) => {
		const accountId = await validateAndGetAccountId(c.req.raw, await c.env.JWT_SECRET.get())
		if (accountId === null) return c.json({ error: 'Unauthorized' }, 401)
		c.set('reportAccountId', accountId)
		await next()
	})
	.use('/ado/bug', bodyLimit({ maxSize: MAX_REPORT_BYTES }))
	.use('/ado/file', bodyLimit({ maxSize: 32 * 1024 * 1024 }))
	.post('/ado/file', async (c) => {
		if (!c.req.header('content-type')?.toLowerCase().startsWith('multipart/form-data'))
			return c.json({ error: 'Expected multipart attachment' }, 415)
		let form: FormData
		try {
			form = await c.req.raw.formData()
		} catch {
			return c.json({ error: 'Malformed attachment' }, 400)
		}
		const reportId = form.get('adoWorkItemId')
		const file = form.get('file')
		if (
			typeof reportId !== 'string' ||
			!/^[1-9]\d*$/.test(reportId) ||
			!Number.isSafeInteger(Number(reportId)) ||
			!(file instanceof File) ||
			!file.size
		)
			return c.json({ error: 'Expected report id and nonempty file' }, 400)
		const report = await c.env.DB.prepare(
			'SELECT id FROM bug_report WHERE id = ? AND account_id = ?'
		)
			.bind(Number(reportId), c.get('reportAccountId'))
			.first()
		if (!report) return c.json({ error: 'Report not found' }, 404)
		const id = crypto.randomUUID()
		const key = `reports/${reportId}/${id}`
		await c.env.ATTACHMENTS.put(key, file.stream(), {
			httpMetadata: { contentType: file.type || 'application/octet-stream' },
		})
		try {
			await c.env.DB.prepare(
				'INSERT INTO bug_attachment (id, report_id, filename, content_type, size, object_key) VALUES (?, ?, ?, ?, ?, ?)'
			)
				.bind(
					id,
					Number(reportId),
					file.name,
					file.type || 'application/octet-stream',
					file.size,
					key
				)
				.run()
		} catch (error) {
			await c.env.ATTACHMENTS.delete(key)
			throw error
		}
		// This build's POQONCQVXEB upload returns a non-generic async result.
		return c.body(null, 200)
	})
	.get('/ado/file/:id', async (c) => {
		const row = await c.env.DB.prepare(
			'SELECT a.object_key FROM bug_attachment a JOIN bug_report r ON r.id = a.report_id WHERE a.id = ? AND r.account_id = ?'
		)
			.bind(c.req.param('id'), c.get('reportAccountId'))
			.first<{ object_key: string }>()
		if (!row) return c.json({ error: 'Attachment not found' }, 404)
		const object = await c.env.ATTACHMENTS.get(row.object_key)
		if (!object) return c.json({ error: 'Attachment not found' }, 404)
		const headers = new Headers({
			'Cache-Control': 'private, no-store',
			'X-Content-Type-Options': 'nosniff',
		})
		object.writeHttpMetadata(headers)
		return new Response(object.body, { headers })
	})
	.post('/ado/bug', async (c) => {
		let payload: Record<string, unknown>
		try {
			const contentType = c.req.header('content-type')?.split(';')[0]?.trim().toLowerCase()
			if (contentType === 'application/json') {
				const value: unknown = await c.req.json()
				if (!value || typeof value !== 'object' || Array.isArray(value))
					return c.json({ error: 'Expected a report object' }, 400)
				payload = value as Record<string, unknown>
			} else if (
				contentType === 'application/x-www-form-urlencoded' ||
				contentType === 'multipart/form-data'
			) {
				const fields = await c.req.raw.formData()
				payload = Object.create(null) as Record<string, unknown>
				for (const [key, value] of fields) {
					if (typeof value === 'string') payload[key] = value
					else {
						const bytes = new Uint8Array(await value.arrayBuffer())
						let binary = ''
						for (const byte of bytes) binary += String.fromCharCode(byte)
						payload[key] = { filename: value.name, contentType: value.type, base64: btoa(binary) }
					}
				}
			} else return c.json({ error: 'Expected JSON or form data' }, 415)
		} catch {
			return c.json({ error: 'Malformed report' }, 400)
		}
		if (!Object.keys(payload).length) return c.json({ error: 'Empty report' }, 400)
		const row = await c.env.DB.prepare(
			'INSERT INTO bug_report (account_id, payload) VALUES (?, ?) RETURNING id'
		)
			.bind(c.get('reportAccountId'), JSON.stringify(payload))
			.first<{ id: number }>()
		if (!row) throw new Error('Bug report was not stored')
		// 20260323.14 ADOBugDTO: Id is Int64 and Link is string. Do not return
		// a generic success envelope, which leaves the client's ticket id unset.
		return c.json({ Id: row.id, Link: `https://bugreporting.${c.env.DOMAIN}/ado/bug/${row.id}` })
	})
	.get('/ado/bug/:id', async (c) => {
		const value = c.req.param('id')
		if (!/^[1-9]\d*$/.test(value) || !Number.isSafeInteger(Number(value)))
			return c.json({ error: 'Invalid report id' }, 400)
		const row = await c.env.DB.prepare(
			'SELECT id, created_at, payload FROM bug_report WHERE id = ? AND account_id = ?'
		)
			.bind(Number(value), c.get('reportAccountId'))
			.first<{ id: number; created_at: string; payload: string }>()
		if (!row) return c.json({ error: 'Report not found' }, 404)
		const attachments = await c.env.DB.prepare(
			'SELECT id AS Id, filename AS Filename, content_type AS ContentType, size AS Size FROM bug_attachment WHERE report_id = ?'
		)
			.bind(row.id)
			.all()
		return c.json({
			Id: row.id,
			CreatedAt: row.created_at,
			Report: JSON.parse(row.payload),
			Attachments: attachments.results,
		})
	})

export default app
