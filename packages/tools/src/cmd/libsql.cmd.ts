import { Command } from '@commander-js/extra-typings'

import { libsqlClient, readLibsqlTarget } from '../d1'

/**
 * `runx libsql migrate` — apply a worker's D1 migrations to the libSQL server (Turso)
 * configured in .env, which is what `just migrate` runs when RECFLARE_LIBSQL_DB_URL is set
 * (see run-wrangler-migrate). `wrangler d1 migrations apply` only knows D1, so this does the
 * same job by hand, the same way:
 *
 *   - the files are the worker's `migrations_dir` (from its wrangler.jsonc), `.sql`, applied
 *     in name order;
 *   - what has been applied is recorded in the worker's `migrations_table`, created with
 *     wrangler's exact schema. A D1 database exported and loaded into libSQL therefore
 *     brings its history along, and this picks up where D1 left off — and a libSQL database
 *     loaded back into D1 hands wrangler a table it recognises;
 *   - each file runs in one transaction with its history row, so a failed migration leaves
 *     nothing half-applied and is simply re-run once fixed.
 *
 * Run from the worker's directory (turbo does; `--dir` says otherwise).
 */
export const libsqlCmd = new Command('libsql').description(
	'Operate on the libSQL (Turso) database configured in .env, in place of D1'
)

libsqlCmd
	.command('migrate')
	.description("Apply this worker's pending migrations to the configured libSQL server")
	.option('--dir <path>', 'the worker directory (defaults to the current one)')
	.action(async (opts) => {
		const target = await readLibsqlTarget()
		if (!target) {
			throw new Error('RECFLARE_LIBSQL_DB_URL is not set — nothing to migrate (see .env.example)')
		}
		const dir = path.resolve(opts.dir ?? process.cwd())
		const config = await fs.readFile(path.join(dir, 'wrangler.jsonc'), 'utf8')
		const migrationsDir = config.match(/"migrations_dir"\s*:\s*"([^"]+)"/)?.[1] ?? 'migrations'
		const table = config.match(/"migrations_table"\s*:\s*"([^"]+)"/)?.[1] ?? 'd1_migrations'
		if (!/^\w+$/.test(table)) throw new Error(`unusable migrations_table name: ${table}`)

		const files = (await fs.readdir(path.join(dir, migrationsDir)))
			.filter((name) => name.endsWith('.sql'))
			.sort()

		const client = libsqlClient(target)
		await client.execute(
			`CREATE TABLE IF NOT EXISTS "${table}" (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT UNIQUE, applied_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP)`
		)
		const applied = new Set(
			(await client.execute(`SELECT name FROM "${table}"`)).rows
				.map((row) => row.name)
				.filter((name): name is string => typeof name === 'string')
		)
		const pending = files.filter((name) => !applied.has(name))
		const worker = path.basename(dir)
		if (pending.length === 0) {
			console.log(chalk.dim(`${worker}: no pending migrations (${table})`))
			return
		}

		for (const name of pending) {
			const sql = await fs.readFile(path.join(dir, migrationsDir, name), 'utf8')
			const tx = await client.transaction('write')
			try {
				await tx.executeMultiple(sql)
				await tx.execute({ sql: `INSERT INTO "${table}" (name) VALUES (?)`, args: [name] })
				await tx.commit()
			} catch (err) {
				await tx.rollback().catch(() => {})
				throw new Error(`${worker}: migration ${name} failed: ${String(err)}`)
			}
			console.log(`${worker}: applied ${chalk.green(name)}`)
		}
	})
