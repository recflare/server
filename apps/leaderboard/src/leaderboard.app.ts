import { Hono } from 'hono'
import { describeRoute, openAPIRouteHandler } from 'hono-openapi'
import { useWorkersLogger } from 'workers-tagged-logger'

import { logger, withCleanSpec, withNotFound, withOnError } from '@repo/hono-helpers'

import { GetNearbyScoresBody, GetRanksBody, json, jsonBody, LeaderboardRows } from './openapi'

import type { App } from './context'

/**
 * Leaderboard Worker. Nothing scores anything here yet — the routes answer the shape the
 * client parses, with no rows in them.
 */
const app = new Hono<App>()
	.use(
		'*',
		// middleware
		(c, next) =>
			useWorkersLogger(c.env.NAME, {
				environment: c.env.ENVIRONMENT,
				release: c.env.SENTRY_RELEASE,
			})(c, next)
	)

	.onError(withOnError())
	.notFound(withNotFound())

	.get(
		'/',
		describeRoute({
			tags: ['Service'],
			summary: 'Health check',
			description:
				'Liveness probe for the leaderboard worker. Answers `text/plain`, not JSON, unlike the other workers’ health checks. No auth.',
			responses: {
				200: {
					description: 'Service is up',
					content: { 'text/plain': { schema: { type: 'string' } } },
				},
			},
		}),
		async (c) => {
			return c.text('hello, world!')
		}
	)

	// The scores around a player — what the client shows when it opens a leaderboard on
	// someone rather than at the top. Answers `{ Rows: [...] }`; an EMPTY `Rows` is a
	// complete answer meaning "this leaderboard has no scores", which the client renders as
	// a blank board instead of failing. The key must be present — a bare `{}` trips its
	// parser.
	//
	// Nothing is ranked or stored yet, so the request body is ignored. It IS logged: the
	// body's shape hasn't been recovered from the client, and this route is how it gets
	// watched. Read it as text — the shape is unknown, so parsing it would only invent one —
	// and never fail on it, since an unreadable body must not cost the client its board.
	.post(
		'/leaderboard/GetNearbyScores',
		describeRoute({
			tags: ['Leaderboard'],
			summary: 'The scores around a player',
			description: [
				'What the client shows when it opens a leaderboard ON someone rather than at the top.',
				'',
				'Nothing is scored or stored on this server yet, so `Rows` is always empty — a complete',
				'answer meaning "this leaderboard has no scores", which the client renders as a blank',
				'board rather than failing. The key is always present; a bare `{}` trips its parser.',
				'',
				'The request body is IGNORED, and logged rather than parsed: its shape has not been',
				'recovered from the client, so this route is how it gets watched. An unreadable body is',
				'not an error either — it must not cost the client its board.',
			].join(' '),
			requestBody: jsonBody(GetNearbyScoresBody, 'Ignored and logged; shape not yet recovered'),
			responses: { 200: json(LeaderboardRows, 'The board, always with no rows') },
		}),
		async (c) => {
			const body = await c.req.text().catch(() => '<unreadable>')
			logger.info('GetNearbyScores', { body })

			const rows: unknown[] = []
			return c.json({ Rows: rows })
		}
	)

	// A page of the board itself — what the client shows when it opens a leaderboard at the
	// top rather than on a player. The body names the slice (`RankStart`/`RankEnd`, both
	// inclusive), the board (`RoomId` + `StatChannel`), the viewer (`PlayerId`) and the
	// ordering (`FilterType`, `SortAscending`).
	//
	// Same answer and same rules as GetNearbyScores: `{ Rows: [...] }`, where an EMPTY
	// `Rows` is a complete answer meaning "this leaderboard has no scores" and the key must
	// be present. Nothing is ranked or stored yet, so the body is ignored — only logged, and
	// read as text so an unreadable body can never cost the client its board.
	.post(
		'/leaderboard/GetRanks',
		describeRoute({
			tags: ['Leaderboard'],
			summary: 'A page of the board',
			description: [
				'What the client shows when it opens a leaderboard at the TOP rather than on a player.',
				'The body names the slice (`RankStart`/`RankEnd`, both inclusive), the board (`RoomId`',
				'plus `StatChannel`), the viewer (`PlayerId`) and the ordering (`FilterType`,',
				'`SortAscending`).',
				'',
				'Answers exactly what `GetNearbyScores` answers, under the same rules: `Rows` is always',
				'empty because nothing is scored or stored here yet, and the key is always present.',
				'',
				'The body is IGNORED — it is logged, not parsed — so the fields are documented as the',
				'record of what the client asks for rather than as anything the handler reads.',
			].join(' '),
			requestBody: jsonBody(GetRanksBody, 'The slice and board the client is asking for'),
			responses: { 200: json(LeaderboardRows, 'The board, always with no rows') },
		}),
		async (c) => {
			const body = await c.req.text().catch(() => '<unreadable>')
			logger.info('GetRanks', { body })

			const rows: unknown[] = []
			return c.json({ Rows: rows })
		}
	)

// The generated spec. Documentation only — no request is validated against it (see
// openapi.ts). `hide: true` keeps this route out of its own output.
app.get(
	'/openapi.json',
	describeRoute({ hide: true }),
	withCleanSpec(
		openAPIRouteHandler(app, {
			documentation: {
				info: {
					title: 'recflare leaderboard',
					version: '1.0.0',
					description: [
						'Leaderboards for recflare, a private-server reimplementation of the Rec Room',
						'backend — the boards a room keeps for the stats it tracks.',
						'',
						'NOTHING IS SCORED HERE YET. Both reads answer `{ "Rows": [] }`, which is a complete',
						'answer rather than an error: an empty list means "this leaderboard has no scores"',
						'and the client renders a blank board. The `Rows` key is always present — a bare',
						'`{}` trips the client’s parser.',
						'',
						'Neither route reads its request body. Both log it verbatim instead, which is how',
						'the shapes below get recovered from a live client; `GetNearbyScores`’ body is',
						'still unknown for exactly that reason. No route needs a token today.',
					].join('\n'),
				},
				servers: [{ url: 'https://leaderboard.recflare.net', description: 'Production' }],
			},
		})
	)
)

export default app
