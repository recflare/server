import 'zx/globals'

import { createClient } from '@libsql/client/web'

import { getRepoRoot } from './path'

import type { Client, ResultSet } from '@libsql/client/web'

/**
 * Shared plumbing for talking to the one `recflare` D1 database from a CLI.
 *
 * Everything here shells out to `wrangler d1 execute` rather than calling a running worker,
 * so no deploy, no auth token and no Secrets Store read is involved — the last of which is
 * not even possible, since a Secrets Store value is write-only outside a bound Worker.
 *
 * `--local` (the default) hits the local dev database; `--remote` hits the deployed one and
 * needs the real D1 id, because the committed `wrangler.jsonc` files all carry the literal
 * placeholder `"local"` as their `database_id`. Splicing the real id into a gitignored
 * generated config is the same thing `run-wrangler-migrate` does at deploy time.
 *
 * With a libSQL server (Turso) configured — RECFLARE_LIBSQL_DB_URL in .env, see .env.example —
 * `--remote` means THAT database, reached directly through `@libsql/client` rather than through
 * wrangler, so an operator's `runx admin --remote` acts on the database the deployed workers
 * are actually using. `--local` is the local D1 either way.
 */

/** The one shared database every D1-backed worker binds. */
export const DB_NAME = 'recflare'

export interface D1ExecResult<Row = Record<string, unknown>> {
	results: Row[]
	success: boolean
	meta: { changes?: number; rows_read?: number }
}

/** Escape a value for embedding inside a single-quoted SQL string literal. */
export const sqlStr = (s: string): string => s.replace(/'/g, "''")

/** A short, loud label for which database a command is about to touch. */
export const target = (remote: boolean): string =>
	remote ? chalk.red(`${DB_NAME} (remote)`) : chalk.cyan(`${DB_NAME} (local)`)

/** `--local` is the default; passing both is a mistake worth refusing rather than guessing. */
export function resolveRemote(opts: { local?: boolean; remote?: boolean }): boolean {
	if (opts.local && opts.remote) throw new Error('pass at most one of --local / --remote')
	return opts.remote === true
}

/**
 * One `RECFLARE_*` setting, from the process environment first and the gitignored root
 * `.env` second — the same precedence `recflare_load_env` in src/sh/env.sh gives the deploy
 * and dev scripts, so a CLI reads the value a deploy would ship. Undefined when set in
 * neither place (a commented-out line in .env is "not set").
 */
export async function readRootEnv(key: string): Promise<string | undefined> {
	if (process.env[key]) return process.env[key]
	const envPath = path.join(getRepoRoot(), '.env')
	if (await fs.pathExists(envPath)) {
		const content = await fs.readFile(envPath, 'utf8')
		const m = content.match(new RegExp(`^\\s*${key}\\s*=\\s*(.+?)\\s*$`, 'm'))
		if (m) return m[1].replace(/^["']|["']$/g, '')
	}
	return undefined
}

/** The deployed D1's real id, from the environment or the gitignored root .env. */
export async function getRemoteD1Id(): Promise<string> {
	const id = await readRootEnv('RECFLARE_D1')
	if (id) return id
	throw new Error('RECFLARE_D1 is not set — add the recflare D1 id to .env (see .env.example)')
}

/**
 * Run wrangler `d1 execute` from one worker's directory, with the extra args a caller
 * supplies (`--command …` or `--file …`).
 *
 * The worker only decides which `wrangler.jsonc` is read and whose `node_modules` wrangler
 * resolves from — the database is the same one either way. Pick the worker that OWNS the
 * table being touched, so the config that gets spliced is the one whose migrations built it.
 */
async function runD1(worker: string, extraArgs: string[], remote: boolean): Promise<string> {
	const workerDir = path.join(getRepoRoot(), 'apps', worker)
	cd(workerDir)

	const args = ['d1', 'execute', DB_NAME, ...extraArgs]
	let cleanup: (() => Promise<void>) | undefined

	if (remote) {
		const id = await getRemoteD1Id()
		const src = await fs.readFile(path.join(workerDir, 'wrangler.jsonc'), 'utf8')
		const generated = src.replace(/("database_id"\s*:\s*")[^"]*(")/, `$1${id}$2`)
		const genPath = path.join(workerDir, 'wrangler.generated.jsonc')
		await fs.writeFile(genPath, generated)
		cleanup = () => fs.remove(genPath)
		// `--yes` because wrangler asks for confirmation before touching the deployed database
		// and a swallowed prompt looks exactly like a hang.
		args.push('--config', 'wrangler.generated.jsonc', '--remote', '--yes')
	} else {
		args.push('--local')
	}

	try {
		// Via `pnpm exec` so wrangler resolves from the worker's node_modules (it isn't a
		// dependency of @repo/tools, so it's not on this process's PATH).
		const out = await $`pnpm exec wrangler ${args}`.quiet()
		return out.stdout
	} finally {
		if (cleanup) await cleanup()
	}
}

/**
 * Run one SQL statement and parse the result.
 *
 * Read the RESULTS to find out what happened, not the meta: wrangler's `--json` meta carries
 * only a duration, with no reliable `changes` count, so a statement that needs to know what it
 * matched has to say `RETURNING`.
 */
export async function execSql<Row = Record<string, unknown>>(
	sql: string,
	remote: boolean,
	worker = 'auth'
): Promise<D1ExecResult<Row>> {
	if (remote) {
		const target = await readLibsqlTarget()
		if (target) return libsqlResult<Row>(await libsqlClient(target).execute(sql))
	}
	const stdout = await runD1(worker, ['--command', sql, '--json'], remote)
	// wrangler --json prints a one-element array of results to stdout.
	const start = stdout.indexOf('[')
	if (start === -1) throw new Error(`unexpected d1 execute output:\n${stdout}`)
	const parsed = JSON.parse(stdout.slice(start)) as Array<D1ExecResult<Row>>
	const first = parsed[0]
	if (!first) throw new Error(`empty d1 execute result:\n${stdout}`)
	return first
}

/**
 * Ingest a whole `.sql` file. Used for bulk loads far too large for `--command`, where
 * wrangler splits the file into statements and batches them itself.
 *
 * Not `--json`: a multi-thousand-statement file answers with a result object per statement,
 * which is megabytes of nothing. The human-readable output is returned for the caller.
 */
export async function execSqlFile(file: string, remote: boolean, worker = 'auth'): Promise<string> {
	if (remote) {
		const target = await readLibsqlTarget()
		if (target) {
			// One script in one request. Fine for the loads this is used for; a file too large for
			// the server's request limit would have to be split by statement first.
			await libsqlClient(target).executeMultiple(await fs.readFile(file, 'utf8'))
			return `applied ${path.basename(file)} to ${new URL(target.url).host}`
		}
	}
	return await runD1(worker, ['--file', file], remote)
}

/** Where `--remote` goes when the deployment runs on libSQL instead of D1. */
export interface LibsqlTarget {
	url: string
	authToken?: string
}

/**
 * The libSQL target from RECFLARE_LIBSQL_DB_URL / RECFLARE_LIBSQL_DB_AUTH_TOKEN, or undefined
 * when the deployment is on D1 (the URL unset). Same precedence as every other setting:
 * process environment first, then the root .env.
 */
export async function readLibsqlTarget(): Promise<LibsqlTarget | undefined> {
	const url = await readRootEnv('RECFLARE_LIBSQL_DB_URL')
	if (!url) return undefined
	return { url, authToken: await readRootEnv('RECFLARE_LIBSQL_DB_AUTH_TOKEN') }
}

let libsql: { url: string; client: Client } | undefined

/**
 * A client for the target, made once per process. The web build of the client is used on
 * purpose: it speaks Hrana over HTTP with nothing native to install, and a CLI only ever
 * talks to a remote server.
 */
export function libsqlClient(target: LibsqlTarget): Client {
	if (libsql?.url !== target.url) {
		console.error(chalk.magenta(`→ libSQL ${new URL(target.url).host}`))
		libsql = {
			url: target.url,
			client: createClient({ url: target.url, authToken: target.authToken }),
		}
	}
	return libsql.client
}

/** The client's rows as the plain objects wrangler's `--json` output gives. */
function libsqlResult<Row>(rs: ResultSet): D1ExecResult<Row> {
	const results = rs.rows.map((row) => {
		const out: Record<string, unknown> = {}
		rs.columns.forEach((column, i) => (out[column] = row[i]))
		return out as Row
	})
	return { results, success: true, meta: { changes: rs.rowsAffected } }
}
