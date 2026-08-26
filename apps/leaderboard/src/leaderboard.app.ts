import { Hono } from 'hono'
import { describeRoute, openAPIRouteHandler } from 'hono-openapi'
import { useWorkersLogger } from 'workers-tagged-logger'

import { logger, withCleanSpec, withNotFound, withOnError } from '@repo/hono-helpers'
import { validateAndGetAccountId } from '@repo/jwt'

import {
	checkAndSetStat,
	getNearbyScores,
	getPlayerRank,
	getRanks,
	MAX_WINDOW,
	NO_SCORE,
	UNRANKED,
} from './leaderboard-db'

import {
	CheckAndSetStatBody,
	CheckAndSetStatResponse,
	GetNearbyScoresBody,
	GetPlayerRankBody,
	GetRanksBody,
	json,
	jsonBody,
	LeaderboardRows,
	PlayerRank,
} from './openapi'

import type { App } from './context'
import type { Board } from './leaderboard-db'

/**
 * Leaderboard Worker. One board per (room, stat channel), stored in the `leaderboard` table
 * (see leaderboard-db.ts): `CheckAndSetStat` writes the caller's value on one, and the three
 * reads rank them.
 */

/** A board selector as the client posts it. Every field is optional on the wire — a body
 * that names nothing still gets an answer, it's just an empty one. */
interface BoardBody {
	PlayerId?: number
	RoomId?: number
	StatChannel?: number
	FilterType?: number
	SortAscending?: boolean
	RankStart?: number
	RankEnd?: number
	WindowSize?: number
}

/** Read a JSON body leniently: an unreadable one is `{}`, never an error — a board that
 * fails to draw is worse than one that draws empty. */
async function readBody<T extends object>(c: { req: { json<U>(): Promise<U> } }): Promise<T> {
	return c.req.json<T>().catch(() => ({}) as T)
}

const int = (v: unknown, fallback: number) => (Number.isInteger(v) ? (v as number) : fallback)

/** The client's `FilterType`: who a board counts. */
const enum FilterType {
	Global = 0,
	Friends = 1,
}

/**
 * The board a body names: `RoomId` + `StatChannel`, each 0 when absent, seen through
 * `PlayerId`'s friends when `FilterType` is Friends. A friends board with no `PlayerId`
 * has nobody to be friends of, so it falls back to the global one rather than to nothing.
 */
function board(body: BoardBody): Board {
	const playerId = int(body.PlayerId, 0)
	return {
		roomId: int(body.RoomId, 0),
		statChannel: int(body.StatChannel, 0),
		...(int(body.FilterType, 0) === FilterType.Friends && playerId !== 0 && { friendsOf: playerId }),
	}
}

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
	// The body is GetPlayerRank's plus `WindowSize`: the rows `WindowSize` either side of
	// the player's rank (capped at MAX_WINDOW whatever the client asks — the client asks for
	// 10), or the top of the board when they aren't on it. `FilterType` 1 restricts the
	// board to the player and their friends, ranked among themselves. An unreadable body is
	// answered with an empty board, never an error.
	.post(
		'/leaderboard/GetNearbyScores',
		describeRoute({
			tags: ['Leaderboard'],
			summary: 'The scores around a player',
			description: [
				'What the client shows when it opens a leaderboard ON someone rather than at the top:',
				`the rows \`WindowSize\` (at most ${MAX_WINDOW}, the default) either side of \`PlayerId\`’s`,
				'rank on the board `RoomId` + `StatChannel` names, or the top of the board when the',
				'player isn’t on it. `FilterType` 1 (Friends) restricts the board to `PlayerId` and',
				'their friends, ranked among themselves.',
				'',
				'An empty `Rows` is a complete answer meaning "this leaderboard has no scores", which',
				'the client renders as a blank board rather than failing. The key is always present; a',
				'bare `{}` trips its parser. An unreadable body is answered with an empty board.',
			].join(' '),
			requestBody: jsonBody(GetNearbyScoresBody, 'The player and the board to centre on'),
			responses: { 200: json(LeaderboardRows, 'The rows around the player') },
		}),
		async (c) => {
			const body = await readBody<BoardBody>(c)
			logger.info('GetNearbyScores', { body })

			const rows = await getNearbyScores(
				c.env.DB,
				board(body),
				int(body.PlayerId, 0),
				int(body.WindowSize, MAX_WINDOW),
				body.SortAscending === true
			)
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
	// be present. Ranks are 1-based; a `RankStart` of 0 is read as the top. `FilterType` 1
	// ranks the viewer and their friends among themselves. An unreadable body is answered
	// with an empty board, never an error.
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
				'Answers the rows ranked `RankStart`..`RankEnd` on the board `RoomId` + `StatChannel`',
				'names (1-based; 0 is read as the top), highest value first unless `SortAscending`. An',
				'empty `Rows` means "this leaderboard has no scores"; the key is always present.',
				'`FilterType` 1 (Friends) restricts the board to `PlayerId` and their friends, ranked',
				'among themselves.',
			].join(' '),
			requestBody: jsonBody(GetRanksBody, 'The slice and board the client is asking for'),
			responses: { 200: json(LeaderboardRows, 'The requested slice of the board') },
		}),
		async (c) => {
			const body = await readBody<BoardBody>(c)
			logger.info('GetRanks', { body })

			const rows = await getRanks(
				c.env.DB,
				board(body),
				int(body.RankStart, 1),
				int(body.RankEnd, 10),
				body.SortAscending === true
			)
			return c.json({ Rows: rows })
		}
	)

	// One player's standing, rather than a page of the board — what the client asks when it
	// needs to show "you: #17" next to a leaderboard. The body names the player and the board
	// (`RoomId` + `StatChannel` + `FilterType`, where FilterType is Global 0 / Friends 1).
	//
	// The answer is three fields — `{ PlayerId, Score, Rank }` — and notably does NOT echo the
	// board back, so the client pairs the answer with its question itself. `PlayerId` is
	// therefore the one field read out of the body: answering with a different player's id
	// would be answering a question nobody asked.
	//
	// A player with no row in the room gets {@link UNRANKED} with a zero score. A body that
	// can't be read still gets an answer — a board that fails to draw is worse than one that
	// draws the player as unranked — so `PlayerId` falls back to 0.
	.post(
		'/leaderboard/GetPlayerRank',
		describeRoute({
			tags: ['Leaderboard'],
			summary: 'One player’s rank',
			description: [
				'What the client asks when it needs a single player’s standing rather than a page of',
				'the board — the body names the player and the board (`RoomId` + `StatChannel` +',
				'`FilterType`: Global 0, Friends 1).',
				'',
				'`Score` is the player’s value on the board `RoomId` + `StatChannel` names and `Rank`',
				`their 1-based position on it. A player with no row there answers \`Rank\` ${UNRANKED}, a sentinel meaning`,
				'unranked (ranks are 1-based, so a 0 would render as first place), and `Score` 0.',
				'',
				'`FilterType` 1 (Friends) ranks the player among their friends only.',
				'',
				'`PlayerId` is echoed from the request — the response carries no board selectors, so',
				'the client matches the answer to its own question. An unreadable body is answered',
				'rather than rejected, with a `PlayerId` of 0.',
			].join(' '),
			requestBody: jsonBody(GetPlayerRankBody, 'The player and the board being asked about'),
			responses: { 200: json(PlayerRank, 'The player’s standing') },
		}),
		async (c) => {
			const body = await readBody<BoardBody>(c)
			logger.info('GetPlayerRank', { body })

			const playerId = int(body.PlayerId, 0)
			if (playerId === 0) return c.json({ PlayerId: 0, Score: NO_SCORE, Rank: UNRANKED })
			return c.json(
				await getPlayerRank(c.env.DB, board(body), playerId, body.SortAscending === true)
			)
		}
	)

	// A stat write: the client posts the value it wants stored for a room's stat channel,
	// along with `CurrentStatValue` — what it believes is stored now, null when it believes
	// nothing is. That pairing makes it a compare-and-set rather than a plain write, which is
	// how a room's high-score board avoids being walked backwards by a stale client. There is
	// no `PlayerId`: the stat belongs to whoever is calling.
	//
	// The caller comes from the bearer token — no token, 401, since a stat with no owner has
	// nowhere to go. The write lands in `leaderboard` as the caller's value on the board
	// `RoomId` + `StatChannel` names. The answer is a BARE `0` — not an
	// envelope, not `{ value: 0 }` — which is what the live service returns and so what the
	// client's parser expects; it is 0 even when the compare failed and nothing was written.
	.post(
		'/leaderboard/CheckAndSetStat',
		describeRoute({
			tags: ['Leaderboard'],
			summary: 'Write a player’s stat',
			description: [
				'A compare-and-set on one of a room’s tracked stats: `StatValue` is what the client',
				'wants stored, `CurrentStatValue` what it believes is stored now (null when it believes',
				'nothing is). No `PlayerId` — the stat belongs to the caller.',
				'',
				'Stores `StatValue` as the caller’s value on the board `RoomId` + `StatChannel` names',
				'(the caller is the Bearer token; 401 without one). With a numeric `CurrentStatValue`',
				'the row is written only if it still holds that value; with null it is written',
				'regardless.',
				'',
				'The response is the BARE number `0`, not an envelope and not a `{ value }` wrapper —',
				'what the live service answers, and what the client’s parser expects — whether or not',
				'the compare passed.',
			].join(' '),
			requestBody: jsonBody(CheckAndSetStatBody, 'The stat, the room and the value to store'),
			responses: {
				200: json(CheckAndSetStatResponse, 'Always the bare number 0'),
				401: { description: 'No valid bearer token' },
			},
		}),
		async (c) => {
			const accountId = await validateAndGetAccountId(c.req.raw, await c.env.JWT_SECRET.get())
			if (accountId === null) return c.body(null, 401)

			const body = await readBody<{
				RoomId?: number
				StatChannel?: number
				StatValue?: number
				CurrentStatValue?: number | null
			}>(c)
			logger.info('CheckAndSetStat', { accountId, body })

			const target = board(body)
			if (target.roomId !== 0 && typeof body.StatValue === 'number') {
				const expected = typeof body.CurrentStatValue === 'number' ? body.CurrentStatValue : null
				const written = await checkAndSetStat(
					c.env.DB,
					target,
					accountId,
					Math.trunc(body.StatValue),
					expected
				)
				if (!written) logger.info('CheckAndSetStat: stale, not written', { accountId, ...target })
			}

			return c.json(0)
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
						'One board per (room, stat channel): `CheckAndSetStat` stores the caller’s value on',
						'one, and the reads rank them — highest first unless `SortAscending`, ties broken on',
						'the lower player id, ranks 1-based. `FilterType` 1 reads a board as the viewer and',
						'their friends only (the `api` worker’s `relationship` table), ranked among',
						'themselves.',
						'',
						'The two board reads answer `{ "Rows": [ { PlayerId, Score, Rank } ] }`, an empty',
						'list being a complete answer meaning "this leaderboard has no scores" (the `Rows`',
						'key is always present — a bare `{}` trips the client’s parser); `GetPlayerRank`',
						'answers a player with no row a rank of 99999, the sentinel for unranked, with a',
						'score of 0; and `CheckAndSetStat` answers the bare number `0`.',
						'',
						'Only `CheckAndSetStat` needs a token — the stat belongs to whoever is calling.',
						'Unreadable bodies are answered (empty board / unranked), never rejected.',
					].join('\n'),
				},
				servers: [{ url: 'https://leaderboard.recflare.net', description: 'Production' }],
			},
		})
	)
)

export default app
