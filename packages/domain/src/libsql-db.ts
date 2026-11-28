/**
 * The shared `recflare` database on a libSQL server (Turso) instead of Cloudflare D1.
 *
 * D1 is the default and stays fully supported: every worker still binds it as `DB`, local
 * dev and vitest run on miniflare's D1, and an operator who never sets `LIBSQL_DB_URL`
 * never loads this. Set the URL (and its auth token) and the SAME workers read and write
 * a libSQL database instead, through an adapter that presents the D1 API — `prepare`,
 * `bind`, `first`, `all`, `run`, `batch` — over `@libsql/client`. Nothing that queries the
 * database knows which backend it is on; the 400-odd `db: D1Database` signatures and the
 * hand-written SQL behind them are untouched, which is the point of doing it this way.
 *
 * Both are SQLite, so the schema, the migrations and the SQL carry across as written
 * (generated columns, JSON1, `RETURNING`, numbered `?1` placeholders). Two differences
 * worth knowing:
 *  - D1 caps a statement at 100 bound parameters and the code chunks for that
 *    (`d1-binds.ts`); libSQL's limit is far higher, so the chunking is merely harmless.
 *  - A D1 `batch` and a libSQL `batch` are both one transaction, all-or-nothing, so the
 *    call sites that rely on that (`rooms-db.ts`) behave the same.
 *
 * The import is `@libsql/client/web`, which the Cloudflare tutorial insists on: the
 * default entry is the Node build and does not run in workerd. In the web build a
 * `libsql://` URL is Hrana over HTTP — stateless, one fetch per statement, no socket held
 * between requests — which is the right transport for a Worker, and why the client is
 * created per request rather than cached on the isolate.
 *
 * Migrations go through `runx libsql migrate` (see packages/tools), which `just migrate`
 * switches to on its own when the URL is configured; operator tooling (`runx admin`,
 * `runx catalog`) follows the same switch in packages/tools/src/d1.ts.
 */

import { createClient } from '@libsql/client/web'

import type { Client, InStatement, InValue, ResultSet } from '@libsql/client/web'

/** The bindings and vars the switch reads. Every D1-backed worker's Env satisfies this. */
export interface DatabaseEnv {
	/** The D1 binding — used as-is when no libSQL URL is configured. */
	DB: D1Database
	/**
	 * A libSQL server to use INSTEAD of `DB`, e.g. `libsql://<db>-<org>.turso.io`. Set from
	 * `RECFLARE_LIBSQL_DB_URL` in .env at deploy time (see .env.example). Unset — the usual
	 * case, and always in local dev and tests — means D1.
	 */
	LIBSQL_DB_URL?: string
	/**
	 * The server's auth token. Arrives as an encrypted worker secret, which `just deploy`
	 * sets from `RECFLARE_LIBSQL_DB_AUTH_TOKEN`; never as a plain var.
	 */
	LIBSQL_DB_AUTH_TOKEN?: string
}

/**
 * The database a request should use: the libSQL adapter when `LIBSQL_DB_URL` is set, the
 * D1 binding otherwise. Cheap either way — creating the libSQL client does no I/O.
 */
export function openDatabase(env: DatabaseEnv): D1Database {
	const url = env.LIBSQL_DB_URL?.trim()
	if (!url) return env.DB
	const authToken = env.LIBSQL_DB_AUTH_TOKEN?.trim()
	return libsqlDatabase(createClient({ url, authToken: authToken || undefined }))
}

/** Envs this module has already produced, so nested handlers (`mono`) don't wrap twice. */
const resolvedEnvs = new WeakSet<object>()

/** `env` with `DB` swapped for whichever database {@link openDatabase} picks. */
export function resolveDatabaseEnv<E extends DatabaseEnv>(env: E): E {
	if (resolvedEnvs.has(env) || !env.LIBSQL_DB_URL?.trim()) return env
	const resolved: E = { ...env, DB: openDatabase(env) }
	resolvedEnvs.add(resolved)
	return resolved
}

/** The handler shapes a worker exports: a Hono app, or the `{ fetch, scheduled }` object. */
export interface DatabaseHandler<E extends DatabaseEnv> {
	fetch(request: Request, env: E, ctx: ExecutionContext): Response | Promise<Response>
	scheduled?(controller: ScheduledController, env: E, ctx: ExecutionContext): void | Promise<void>
	queue?(batch: MessageBatch, env: E, ctx: ExecutionContext): void | Promise<void>
}

/**
 * What {@link withDatabase} returns: an `ExportedHandler` whose `fetch` is known to exist.
 * Declared as a method taking a plain `Request` so a worker that mounts others (`mono`)
 * can call it with the request it has, wrapped and unwrapped apps alike.
 */
export interface DatabaseExportedHandler<E> extends ExportedHandler<E> {
	fetch(request: Request, env: E, ctx: ExecutionContext): Response | Promise<Response>
}

/**
 * Wrap a worker's default export so every handler sees the database
 * {@link openDatabase} picks in `env.DB`. This is the ONE place a worker changes to gain
 * libSQL support: `export default withDatabase(app)`.
 *
 * With no `LIBSQL_DB_URL` the env passes through untouched, so a D1 deployment (and every
 * test) pays nothing for this.
 */
export function withDatabase<E extends DatabaseEnv>(
	handler: DatabaseHandler<E>
): DatabaseExportedHandler<E> {
	const fetch = handler.fetch.bind(handler)
	const wrapped: DatabaseExportedHandler<E> = {
		fetch: (request, env, ctx) => fetch(request, resolveDatabaseEnv(env), ctx),
	}
	if (handler.scheduled) {
		const scheduled = handler.scheduled.bind(handler)
		wrapped.scheduled = (controller, env, ctx) =>
			scheduled(controller, resolveDatabaseEnv(env), ctx)
	}
	if (handler.queue) {
		const queue = handler.queue.bind(handler)
		wrapped.queue = (batch, env, ctx) => queue(batch, resolveDatabaseEnv(env), ctx)
	}
	return wrapped
}

/** A libSQL client behind the D1 API. Exported so a test can hand it a local client. */
export function libsqlDatabase(client: Client): D1Database {
	return new LibsqlDatabase(client)
}

/**
 * D1 accepts null, number, string, boolean and ArrayBuffer; libSQL accepts all of those
 * (plus a few more). `undefined` is a bug at the call site on either backend — D1 refuses
 * it with a type error — so refuse it here with the same clarity instead of letting the
 * client turn it into something.
 */
function toInValue(value: unknown, index: number): InValue {
	if (value === undefined) {
		throw new TypeError(`bound parameter ${index + 1} is undefined (D1 would reject it too)`)
	}
	return value as InValue
}

/**
 * The client's rows carry their columns as named properties already, but they are hrana
 * `Row` objects with a hidden `length` and numeric indices. Build plain objects by column
 * position instead so a row spreads, serialises and compares like the plain object D1
 * hands back — and so a column with no name in the object (a duplicate) is still last-wins
 * rather than dropped.
 */
function rowToObject(columns: string[], row: ResultSet['rows'][number]): Record<string, unknown> {
	const out: Record<string, unknown> = {}
	for (let i = 0; i < columns.length; i++) out[columns[i]!] = row[i]
	return out
}

function toResult<T>(rs: ResultSet): D1Result<T> {
	return {
		success: true,
		results: rs.rows.map((row) => rowToObject(rs.columns, row) as T),
		meta: {
			duration: 0,
			size_after: 0,
			rows_read: 0,
			rows_written: 0,
			last_row_id: Number(rs.lastInsertRowid ?? 0),
			changed_db: rs.rowsAffected > 0,
			changes: rs.rowsAffected,
		},
	}
}

class LibsqlPreparedStatement implements D1PreparedStatement {
	constructor(
		private readonly client: Client,
		private readonly sql: string,
		private readonly args: InValue[] = []
	) {}

	/** What the client runs. `batch` collects these from every statement it is handed. */
	toStatement(): InStatement {
		return { sql: this.sql, args: this.args }
	}

	bind(...values: unknown[]): D1PreparedStatement {
		return new LibsqlPreparedStatement(this.client, this.sql, values.map(toInValue))
	}

	private execute(): Promise<ResultSet> {
		return this.client.execute(this.toStatement())
	}

	first<T = unknown>(colName: string): Promise<T | null>
	first<T = Record<string, unknown>>(): Promise<T | null>
	async first<T>(colName?: string): Promise<T | null> {
		const rs = await this.execute()
		const row = rs.rows[0]
		if (row === undefined) return null
		const object = rowToObject(rs.columns, row)
		if (colName === undefined) return object as T
		if (!rs.columns.includes(colName)) {
			throw new Error(`D1_COLUMN_NOTFOUND: column "${colName}" is not in the result`)
		}
		return object[colName] as T
	}

	async run<T = Record<string, unknown>>(): Promise<D1Result<T>> {
		return toResult<T>(await this.execute())
	}

	async all<T = Record<string, unknown>>(): Promise<D1Result<T>> {
		return toResult<T>(await this.execute())
	}

	raw<T = unknown[]>(options: { columnNames: true }): Promise<[string[], ...T[]]>
	raw<T = unknown[]>(options?: { columnNames?: false }): Promise<T[]>
	async raw<T = unknown[]>(options?: { columnNames?: boolean }): Promise<T[] | [string[], ...T[]]> {
		const rs = await this.execute()
		const rows = rs.rows.map((row) => rs.columns.map((_, i) => row[i]) as T)
		return options?.columnNames ? [rs.columns, ...rows] : rows
	}
}

class LibsqlDatabase implements D1Database {
	constructor(private readonly client: Client) {}

	prepare(query: string): D1PreparedStatement {
		return new LibsqlPreparedStatement(this.client, query)
	}

	/** One write transaction, like D1's: any statement failing rolls back the lot. */
	async batch<T = unknown>(statements: D1PreparedStatement[]): Promise<Array<D1Result<T>>> {
		const results = await this.client.batch(
			statements.map((statement) => {
				if (!(statement instanceof LibsqlPreparedStatement)) {
					throw new TypeError('batch: every statement must come from this database')
				}
				return statement.toStatement()
			}),
			'write'
		)
		return results.map((rs) => toResult<T>(rs))
	}

	/** A script of `;`-separated statements, as D1's `exec` takes. Nothing here uses it. */
	async exec(query: string): Promise<D1ExecResult> {
		const started = Date.now()
		await this.client.executeMultiple(query)
		const count = query.split(';').filter((statement) => statement.trim() !== '').length
		return { count, duration: Date.now() - started }
	}

	/**
	 * D1 sessions pin reads after a write to a replica that has seen it. A libSQL primary
	 * is always read-your-writes, so a "session" is the database itself with no bookmark.
	 */
	withSession(): D1DatabaseSession {
		return {
			prepare: (query) => this.prepare(query),
			batch: (statements) => this.batch(statements),
			getBookmark: () => null,
		}
	}

	dump(): Promise<ArrayBuffer> {
		return Promise.reject(new Error('dump() is not supported on a libSQL database'))
	}
}
