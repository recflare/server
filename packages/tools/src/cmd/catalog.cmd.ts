import { Command } from '@commander-js/extra-typings'
import Table from 'cli-table3'

import {
	buildCatalogLoad,
	CATALOG_ID_BASE,
	CATALOG_INSERT_COLUMNS,
} from '../../../../apps/econ/src/catalog-load'
import { execSql, execSqlFile, resolveRemote, target } from '../d1'
import { getRepoRoot } from '../path'

import type {
	AvatarItemCapture,
	CatalogCollision,
	CatalogLoadRow,
	CatalogValue,
	SkinCapture,
} from '../../../../apps/econ/src/catalog-load'

/**
 * Load the item catalog into the shared `recflare` D1 database.
 *
 * The `catalog` table's STRUCTURE is a migration (apps/econ/migrations/0015_catalog.sql); its
 * CONTENTS are not. The game's item list changes without the schema changing, so shipping the
 * rows as a migration would mean a migration and a deploy per refresh, an ever-growing pile of
 * near-identical data migrations, and no way to reload without writing another one. This
 * command is the reload.
 *
 *   runx catalog load  [--remote] [--replace] [--dry-run]
 *   runx catalog check
 *
 * The mapping from capture to row lives in the econ worker's `catalog-load.ts`, beside the
 * schema it fills, so a column added there and a column added to the loader cannot drift. That
 * module deliberately touches no Workers types, which is what lets this Node CLI import it.
 */

/** The worker that owns the table — whose wrangler.jsonc and node_modules wrangler uses. */
const OWNER = 'econ'

const AVATAR_ITEMS = 'apps/econ/static/db/avatar-items.json'
const SKINS = 'apps/econ/static/db/skins.json'

/**
 * Rows per INSERT. Batched because thousands of single-row statements parse far more slowly
 * than a few dozen multi-row ones, and D1 charges per statement on the remote path.
 */
const CHUNK = 100

/**
 * One SQL literal. Booleans become 1/0 (SQLite has no boolean), `undefined` is treated as the
 * NULL it stands for — a key the capture omitted rather than set — and quotes are doubled.
 * Item names are the only free text here, but escaping is what makes running this against a
 * fresh capture safe rather than lucky.
 */
function lit(v: CatalogValue): string {
	if (v === null || v === undefined) return 'NULL'
	if (typeof v === 'boolean') return v ? '1' : '0'
	if (typeof v === 'number') return String(v)
	return `'${v.replaceAll("'", "''")}'`
}

/** Read one capture, tolerating the BOM the exports carry (`JSON.parse` rejects U+FEFF). */
async function readCapture<T>(relPath: string): Promise<T[]> {
	const full = path.join(getRepoRoot(), relPath)
	if (!(await fs.pathExists(full))) throw new Error(`no capture at ${relPath}`)
	const text = (await fs.readFile(full, 'utf8')).replace(/^﻿/, '')
	const parsed = JSON.parse(text) as unknown
	if (!Array.isArray(parsed)) throw new Error(`${relPath} is not a JSON array`)
	return parsed as T[]
}

/** Both captures, as the loader and the storefront generator read them. */
export async function readCaptures(): Promise<{
	avatarItems: AvatarItemCapture[]
	skins: SkinCapture[]
}> {
	const [avatarItems, skins] = await Promise.all([
		readCapture<AvatarItemCapture>(AVATAR_ITEMS),
		readCapture<SkinCapture>(SKINS),
	])
	return { avatarItems, skins }
}

/** Print the duplicate keys a load dropped. Never silent: that is the whole point of them. */
function reportCollisions(collisions: CatalogCollision[]): void {
	if (collisions.length === 0) return
	console.warn(
		chalk.yellow(
			`\n${collisions.length} duplicate item_key(s) in the captures — first occurrence kept:`
		)
	)
	const table = new Table({ head: ['item_key', 'kept', 'dropped'] })
	for (const c of collisions) table.push([c.key, c.kept, c.dropped])
	console.warn(table.toString())
	console.warn(
		chalk.yellow('A repeat is a defect in the capture — fix the source JSON and load again.\n')
	)
}

/**
 * How many rows the catalog holds, per kind. Read before and after a load: wrangler's meta
 * carries no usable row count, so counting the table is the only honest way to say what a load
 * actually did.
 */
async function countRows(remote: boolean): Promise<Record<string, number>> {
	const res = await execSql('SELECT kind, COUNT(*) AS n FROM catalog GROUP BY kind', remote, OWNER)
	return Object.fromEntries(res.results.map((r) => [String(r.kind), Number(r.n)]))
}

const total = (counts: Record<string, number>): number =>
	Object.values(counts).reduce((a, b) => a + b, 0)

/**
 * The `DO UPDATE` half of the upsert: every column except the conflict target, taken from the
 * row that was being inserted. Derived from {@link CATALOG_INSERT_COLUMNS} rather than written
 * out, so a column added to the table is carried by a merge automatically — a hand-maintained
 * list would quietly stop updating whatever was forgotten.
 */
const CONFLICT_UPDATE = CATALOG_INSERT_COLUMNS.filter((c) => c !== 'item_key')
	.map((c) => `${c} = excluded.${c}`)
	.join(', ')

/**
 * Prove the load actually landed, and refuse to report success otherwise.
 *
 * This exists because a load once reported "✓ catalog loaded" over a database it had written
 * nothing to. Counting rows back is not paranoia: wrangler's meta carries no usable row count,
 * the remote and local paths differ enough that one can break while the other works, and a
 * `--file` that fails partway leaves a partial catalog rather than an error. The command must
 * either see its own rows in the table or say it failed.
 */
async function verifyLoad(
	rows: CatalogLoadRow[],
	after: Record<string, number>,
	replace: boolean,
	remote: boolean
): Promise<void> {
	const got = total(after)

	// A replace empties first, so the count is exact. A merge only adds, so the table must hold at
	// least what was just written — more is fine, that is the rows the captures did not mention.
	if (replace ? got !== rows.length : got < rows.length) {
		throw new Error(
			`load did not land: expected ${replace ? '' : 'at least '}${rows.length} rows, ` +
				`the table holds ${got}. Nothing was verified as written — re-run it.`
		)
	}

	// Counts alone can be satisfied by the rows that were already there, so spot-check actual keys
	// from across the file. The last one matters most: a load cut short by a failed batch loses
	// the tail while the count still looks plausible.
	const probes = [rows[0], rows[Math.floor(rows.length / 2)], rows[rows.length - 1]].filter(
		(r): r is CatalogLoadRow => r !== undefined
	)
	const list = probes.map((r) => `'${r.key.replaceAll("'", "''")}'`).join(', ')
	const res = await execSql(
		`SELECT COUNT(*) AS n FROM catalog WHERE item_key IN (${list})`,
		remote,
		OWNER
	)
	const found = Number(res.results[0]?.n ?? 0)
	if (found !== probes.length) {
		throw new Error(
			`load did not land: ${probes.length - found} of ${probes.length} probe rows are missing ` +
				`from the table. The catalog may be partially written — re-run it.`
		)
	}

	// Every row must have come out with a numeric handle. A NULL here is a load that stopped
	// between writing rows and numbering them, which nothing else would notice until a lookup by
	// number quietly returned nothing.
	const unnumbered = await execSql(
		'SELECT COUNT(*) AS n FROM catalog WHERE catalog_id IS NULL',
		remote,
		OWNER
	)
	const missing = Number(unnumbered.results[0]?.n ?? 0)
	if (missing > 0) {
		throw new Error(`load did not finish: ${missing} row(s) have no catalog_id. Re-run it.`)
	}
}

const load = new Command('load')
	.description('Load the item catalog from the captured JSON (merges by default)')
	.option('--local', 'Target the local dev database (the default).', false)
	.option('--remote', 'Target the deployed database instead of the local dev database.', false)
	.option(
		'--replace',
		'Empty the catalog first, so rows absent from the captures are REMOVED.',
		false
	)
	.option('--dry-run', 'Build and validate the SQL, print what it would do, change nothing.', false)
	.action(async (opts) => {
		const remote = resolveRemote(opts)
		const { avatarItems, skins } = await readCaptures()
		const { rows, collisions } = buildCatalogLoad(avatarItems, skins)

		console.log(
			`${opts.replace ? 'Replacing the catalog with' : 'Merging'} ${rows.length} rows ` +
				`(${avatarItems.length} avatar items, ${skins.length} skins) into ${target(remote)}`
		)
		reportCollisions(collisions)

		// MERGE is the default: insert what is new, refresh what already exists, and leave
		// anything the captures do not mention alone. That is what makes a PARTIAL capture useful
		// — a handful of newly-datamined items can be loaded without having to re-export the whole
		// catalog first, and without a partial file silently wiping the rest.
		//
		// The cost is that a merge can never REMOVE an item: something dropped from the captures
		// stays in the table forever. `--replace` is the authoritative reload for when the
		// captures are meant to be the whole truth, and it is opt-in because it is the destructive
		// one — pointed at a partial capture it would delete everything the file omits.
		//
		// NO `BEGIN TRANSACTION` / `COMMIT`. Remote D1 REFUSES them outright ("To execute a
		// transaction, please use the state.storage.transaction() ... APIs instead of the SQL
		// BEGIN TRANSACTION or SAVEPOINT statements"), so a file carrying them loads nothing at
		// all against production while working fine locally. Atomicity comes from D1 running each
		// batch of statements in its own implicit transaction; across batches there is none, so a
		// load that dies midway can leave the catalog partial. That is what {@link verifyLoad}
		// below is for, and why re-running is always safe: a merge is idempotent, and a replace
		// starts by emptying the table.
		const statements: string[] = []
		if (opts.replace) {
			statements.push('DELETE FROM catalog;')
		} else {
			// Clear every existing number BEFORE assigning any. `catalog_id` is unique, and this
			// load is about to hand out 1..N: without this, a row already holding one of those
			// numbers (because it was in an earlier load and this capture no longer mentions it)
			// collides and the whole merge fails. Nulling first also means a row left un-numbered
			// afterwards is visibly a row the captures did not mention, which the tail statement
			// below then numbers above N.
			statements.push('UPDATE catalog SET catalog_id = NULL;')
		}
		for (let start = 0; start < rows.length; start += CHUNK) {
			const batch = rows.slice(start, start + CHUNK)
			statements.push(
				`INSERT INTO catalog (${CATALOG_INSERT_COLUMNS.join(', ')}) VALUES\n` +
					batch.map((r) => `\t(${r.values.map(lit).join(', ')})`).join(',\n') +
					// Harmless after a DELETE (nothing can conflict), and kept there anyway so both
					// paths run the identical statement rather than two shapes that could diverge.
					`\nON CONFLICT(item_key) DO UPDATE SET ${CONFLICT_UPDATE};`
			)
		}
		if (!opts.replace) {
			// Anything still un-numbered is a row the captures did not mention — a merge keeps those,
			// so they need handles too. They go ABOVE the highest id this load assigned, so they can
			// never collide with it, ordered by rowid for determinism. Usually this matches nothing
			// at all, and it is a single statement either way.
			const highest = CATALOG_ID_BASE + rows.length - 1
			statements.push(
				`UPDATE catalog SET catalog_id = ${highest} +\n` +
					`\t(SELECT COUNT(*) FROM catalog c WHERE c.catalog_id IS NULL AND c.rowid <= catalog.rowid)\n` +
					`WHERE catalog_id IS NULL;`
			)
		}
		const sql = statements.join('\n')

		if (opts.dryRun) {
			console.log(
				chalk.cyan(
					`--dry-run: built ${statements.length} statements (${(sql.length / 1024).toFixed(0)} KB); nothing was written.`
				)
			)
			return
		}

		const before = await countRows(remote)

		// Written to a temp file rather than passed as `--command`: a multi-megabyte argv is not
		// something to rely on, and `--file` is the path wrangler batches for us.
		const file = path.join(os.tmpdir(), `recflare-catalog-${Date.now()}.sql`)
		await fs.writeFile(file, sql)
		try {
			await execSqlFile(file, remote, OWNER)
		} finally {
			await fs.remove(file)
		}

		const after = await countRows(remote)
		const table = new Table({ head: ['kind', 'before', 'after'] })
		for (const kind of new Set([...Object.keys(before), ...Object.keys(after)])) {
			table.push([kind, String(before[kind] ?? 0), String(after[kind] ?? 0)])
		}
		console.log(table.toString())

		await verifyLoad(rows, after, opts.replace, remote)

		// On a merge the table only grows, so the growth IS the number of new items and the rest of
		// what was written updated a row that already existed. Worth saying out loud: "3370 rows
		// loaded" reads like 3370 changes when it may well have been six.
		if (!opts.replace) {
			const added = total(after) - total(before)
			console.log(`${added} new, ${rows.length - added} updated in place, 0 removed`)
		}
		console.log(chalk.green(`✓ catalog loaded into ${target(remote)}`))
	})

const check = new Command('check')
	.description('Validate the captured JSON without touching any database')
	.action(async () => {
		const { avatarItems, skins } = await readCaptures()
		const { rows, collisions } = buildCatalogLoad(avatarItems, skins)

		const table = new Table()
		table.push(
			{ 'avatar items': String(avatarItems.length) },
			{ skins: String(skins.length) },
			{ 'rows to load': String(rows.length) },
			{ 'duplicate keys': String(collisions.length) }
		)
		console.log(table.toString())
		reportCollisions(collisions)

		// An empty capture is far more likely to be a broken export than a real one, and loading it
		// with --replace would swap a good catalog for nothing.
		if (rows.length === 0)
			throw new Error('the captures produced no rows — refusing to call that ok')
		console.log(chalk.green('✓ captures are loadable'))
	})

export const catalogCmd = new Command('catalog')
	.description('Load the item catalog into the shared recflare D1 database')
	// Bare `catalog` (no subcommand) prints help and exits cleanly, rather than commander's
	// default "missing command" error (exit 1).
	.action((_opts, command: Command) => command.outputHelp())
	.addCommand(load)
	.addCommand(check)
	.addHelpText(
		'after',
		`
The catalog's structure is a migration; its contents are not — reload them here whenever
apps/econ/static/db/*.json changes, with no migration and no deploy.

load MERGES by default: new items are inserted, existing ones refreshed, and anything the
captures don't mention is left alone — so a partial capture of a few new items is a valid
thing to load. Pass --replace when the captures are the whole truth and items missing from
them should be REMOVED.

Target --local (default) or --remote (production; needs RECFLARE_D1 in .env).

Examples:
  $ runx catalog check                # validate the JSON, touch nothing
  $ runx catalog load --dry-run       # build the SQL, print what it would do
  $ runx catalog load                 # merge into the local dev database
  $ runx catalog load --remote        # merge into production
  $ runx catalog load --replace       # full reload: drops anything not in the captures`
	)
