import * as readline from 'node:readline'
import { Command } from '@commander-js/extra-typings'
import Table from 'cli-table3'

import {
	customAvatarItemUpsertStatements,
	readCustomAvatarItemExport,
} from '../../../../apps/api/src/custom-avatar-items-load'
import {
	DEFAULT_STARTING_TOKENS,
	PLUS_MEMBERS_SQL,
	plusReloadSql,
} from '../../../../apps/econ/src/currency'
import { execSql, execSqlFile, readRootEnv, resolveRemote, sqlStr, target } from '../d1'
import { hashPassword } from '../password'
import { getRepoRoot } from '../path'

import type { D1ExecResult } from '../d1'

/**
 * Operator-facing admin tools for the shared `recflare` D1 database. Each command
 * shells out to `wrangler d1 execute recflare` — no running worker or auth token
 * needed — defaulting to the local dev database and targeting the deployed one only
 * with `--remote`. Password hashing comes from @repo/domain, the same code the auth
 * worker uses, so a hash set here always verifies at login.
 *
 *   runx admin set-password    --account 1 [--remote]
 *   runx admin clear-password  --username alice [--remote]
 *   runx admin lookup          --username alice [--remote]
 *   runx admin grant-developer --account 1 [--revoke] [--remote]
 *   runx admin grant-influencer --account 1 [--revoke] [--remote]
 *   runx admin grant-plus      --username alice [--revoke] [--remote]
 *   runx admin reload-plus     <amount> [--dry-run] [--remote]
 *   runx admin cai-load        [--file <export.json>] [--dry-run] [--remote]
 *   runx admin settings-import-kv [--namespace-id <id>] [--overwrite] [--dry-run] [--remote]
 */

/**
 * Resolve the account selector into a SQL WHERE fragment. Exactly one of
 * `--account` / `--username` must be given. Account ids are validated numeric;
 * usernames match the indexed, case-insensitive `username_lower` generated column.
 */
function whereClause(account?: string, username?: string): { where: string; label: string } {
	if ((account == null) === (username == null)) {
		throw new Error('provide exactly one of --account or --username')
	}
	if (account != null) {
		if (!/^\d+$/.test(account)) throw new Error('--account must be a numeric account id')
		return { where: `account_id = ${account}`, label: `account ${account}` }
	}
	return {
		where: `username_lower = '${sqlStr(username!.toLowerCase())}'`,
		label: `username "${username}"`,
	}
}

/** Prompt for a line of input without echoing what's typed (for passwords). */
function promptHidden(query: string): Promise<string> {
	return new Promise((resolve) => {
		const rl = readline.createInterface({
			input: process.stdin,
			output: process.stdout,
			terminal: true,
		})
		// Mute the echo of typed characters; write the prompt ourselves.
		;(rl as unknown as { _writeToOutput: (s: string) => void })._writeToOutput = () => {}
		process.stdout.write(query)
		rl.question('', (answer) => {
			process.stdout.write('\n')
			rl.close()
			resolve(answer)
		})
	})
}

/**
 * Get the new password: from `--password`, else from piped stdin (for scripting),
 * else prompted interactively (hidden, entered twice and compared).
 */
async function resolvePassword(flag?: string): Promise<string> {
	if (flag != null && flag !== '') return flag
	if (!process.stdin.isTTY) {
		const chunks: Buffer[] = []
		for await (const chunk of process.stdin) chunks.push(chunk as Buffer)
		const piped = Buffer.concat(chunks)
			.toString('utf8')
			.replace(/\r?\n$/, '')
		if (piped === '') throw new Error('no password provided on stdin')
		return piped
	}
	const first = await promptHidden('New password: ')
	if (first === '') throw new Error('password must not be empty')
	const second = await promptHidden('Confirm password: ')
	if (first !== second) throw new Error('passwords did not match')
	return first
}

/**
 * Fail when a WHERE-scoped UPDATE matched no row (i.e. no such account). Relies on
 * the statement's `RETURNING account_id` — wrangler's `--json` meta doesn't reliably
 * carry a `changes` count, but the returned rows always reflect what actually matched.
 */
function assertMatched(res: D1ExecResult, label: string): void {
	if (res.results.length < 1) throw new Error(`no account found for ${label}`)
}

const setPassword = new Command('set-password')
	.description("Set (or replace) an account's login password")
	.option('--account <id>', 'Account id to target')
	.option('--username <name>', 'Username to target (case-insensitive)')
	.option('--password <password>', 'The new password (omit to be prompted, or pipe via stdin)')
	.option('--local', 'Target the local dev database (the default).', false)
	.option('--remote', 'Target the deployed database instead of the local dev database.', false)
	.action(async (opts) => {
		const { where, label } = whereClause(opts.account, opts.username)
		const remote = resolveRemote(opts)
		const password = await resolvePassword(opts.password)
		const hash = await hashPassword(password)
		const sql = `UPDATE account SET data = json_set(data, '$.passwordHash', '${sqlStr(hash)}') WHERE ${where} RETURNING account_id`
		console.log(`Setting password for ${label} on ${target(remote)}`)
		assertMatched(await execSql(sql, remote), label)
		console.log(chalk.green(`✓ password set for ${label}`))
	})

const clearPassword = new Command('clear-password')
	.description("Remove an account's password so it has no login credential")
	.option('--account <id>', 'Account id to target')
	.option('--username <name>', 'Username to target (case-insensitive)')
	.option('--local', 'Target the local dev database (the default).', false)
	.option('--remote', 'Target the deployed database instead of the local dev database.', false)
	.action(async (opts) => {
		const { where, label } = whereClause(opts.account, opts.username)
		const remote = resolveRemote(opts)
		const sql = `UPDATE account SET data = json_remove(data, '$.passwordHash') WHERE ${where} RETURNING account_id`
		console.log(`Clearing password for ${label} on ${target(remote)}`)
		assertMatched(await execSql(sql, remote), label)
		console.log(chalk.green(`✓ password cleared for ${label}`))
	})

/**
 * Build a `grant-<thing>` command that toggles a boolean flag on the account blob.
 * `jsonKey` is the account field (e.g. `isDeveloper`) — a fixed literal, not user input.
 *
 * `noun` is what the flag IS, and it is not always "role": the role flags feed the
 * /role/:role lookup and the token's `role` claim, while `hasPlus` is an entitlement that
 * rides on its own `rn.plus` claim and confers no role at all. Getting that word right in
 * the output is the difference between an operator believing they granted a staff power
 * and knowing they granted a subscription.
 */
function grantRoleCommand(name: string, jsonKey: string, roleLabel: string, noun = 'role') {
	return new Command(name)
		.description(`Grant (or, with --revoke, remove) ${roleLabel} on an account`)
		.option('--account <id>', 'Account id to target')
		.option('--username <name>', 'Username to target (case-insensitive)')
		.option('--revoke', `Remove ${roleLabel} instead of granting it`, false)
		.option('--local', 'Target the local dev database (the default).', false)
		.option('--remote', 'Target the deployed database instead of the local dev database.', false)
		.action(async (opts) => {
			const { where, label } = whereClause(opts.account, opts.username)
			const remote = resolveRemote(opts)
			const value = opts.revoke ? 'false' : 'true'
			const sql = `UPDATE account SET data = json_set(data, '$.${jsonKey}', json('${value}')) WHERE ${where} RETURNING account_id`
			const verb = opts.revoke ? 'Revoking' : 'Granting'
			console.log(`${verb} ${roleLabel} ${noun} for ${label} on ${target(remote)}`)
			assertMatched(await execSql(sql, remote), label)
			console.log(
				chalk.green(`✓ ${roleLabel} ${noun} ${opts.revoke ? 'revoked' : 'granted'} for ${label}`)
			)
		})
}

const grantDeveloper = grantRoleCommand('grant-developer', 'isDeveloper', 'developer')
const grantModerator = grantRoleCommand('grant-moderator', 'isModerator', 'moderator')
/**
 * The influencer role, the account's `isInfluencer` flag. `auth` stamps it into the token's
 * `role` claim as `influencer` on the next login; nothing else reads the flag.
 */
const grantInfluencer = grantRoleCommand('grant-influencer', 'isInfluencer', 'influencer')

/**
 * Rec Room Plus, the account's `hasPlus` flag. Players normally get it themselves by
 * claiming a Discord role on the website; this is the operator's way in — and the ONLY
 * one, since the `developer` role deliberately no longer confers Plus.
 *
 * Granting does not take effect until the account's NEXT login: `auth` stamps `hasPlus`
 * into the token as `rn.plus` when it mints one, and `econ` reads nothing else. Tokens
 * last a day and the client never refreshes them, so tell the player to restart the game
 * and sign in again.
 *
 * Revoking has the same lag in reverse — a player keeps Plus until their current token
 * expires. It is not a way to cut someone off immediately.
 */
const grantPlus = grantRoleCommand('grant-plus', 'hasPlus', 'Rec Room Plus', 'subscription')

/**
 * Rec Room Studio upload access, the account's `hasStudio` flag. Staff normally set it
 * from the website (`/settings/recroomstudio`); this is the operator's way in. `auth`
 * stamps it into the token as the `betastudio` role, so like Plus it lands on the
 * player's next Studio sign-in or refresh.
 */
const grantStudio = grantRoleCommand('grant-studio', 'hasStudio', 'Rec Room Studio', 'access')

/**
 * The Rec Room Plus token reload: credit every subscriber's RecCenterTokens balance by
 * `amount`, in one statement. Nothing schedules this — an operator runs it when the
 * subscription's tokens are due (`just reload-plus 1000 --remote`), so running it twice
 * credits twice; `--dry-run` shows who would be credited and what they hold, and changes
 * nothing.
 *
 * Who is a subscriber is `account.hasPlus`, found through the `has_plus` generated column
 * (auth migration 0009) — the same flag `grant-plus` and the website's Discord claim set,
 * read straight off the row, so it does not lag a login the way the token's `rn.plus`
 * claim does. A subscriber who has never touched econ has no balance row yet; they get one
 * holding their signup grant plus the reload, so the grant isn't lost — see
 * `plusReloadSql`. The grant amount is `RECFLARE_STARTING_TOKENS` from the environment
 * or .env, the value a deploy ships to econ, falling back to econ's built-in default.
 *
 * Runs under econ's wrangler config because `balance` is econ's table; locally that
 * means econ's dev D1 state, which has to hold both `balance` AND a migrated `account`.
 */
/** A row of `PLUS_MEMBERS_SQL` (and, sans `username`, of the reload's `RETURNING`). */
interface PlusMemberRow {
	account_id: number
	username?: string | null
	/** NULL when the account has no balance row yet, i.e. its signup grant is still pending. */
	amount: number | null
}

const reloadPlus = new Command('reload-plus')
	.description('Credit every Rec Room Plus subscriber with <amount> RecCenterTokens')
	.argument('<amount>', 'Tokens to add to each subscriber (a positive integer)')
	.option('--dry-run', 'List the subscribers and their balances without crediting', false)
	.option('--local', 'Target the local dev database (the default).', false)
	.option('--remote', 'Target the deployed database instead of the local dev database.', false)
	.action(async (amountArg, opts) => {
		if (!/^\d+$/.test(amountArg) || Number(amountArg) < 1) {
			throw new Error('<amount> must be a positive integer')
		}
		const amount = Number(amountArg)
		const remote = resolveRemote(opts)
		const startingRaw = await readRootEnv('RECFLARE_STARTING_TOKENS')
		const startingTokens = startingRaw == null ? DEFAULT_STARTING_TOKENS : Number(startingRaw)
		if (!Number.isInteger(startingTokens) || startingTokens < 0) {
			throw new Error(`RECFLARE_STARTING_TOKENS is not a non-negative integer: ${startingRaw}`)
		}

		console.log(`Plus subscribers on ${target(remote)}`)
		const before = (await execSql<PlusMemberRow>(PLUS_MEMBERS_SQL, remote, 'econ')).results
		if (before.length === 0) {
			console.log(chalk.yellow('no accounts have hasPlus set — nothing to reload'))
			return
		}
		const table = new Table({ head: ['account', 'username', 'tokens'] })
		for (const r of before) {
			table.push([
				String(r.account_id),
				r.username ?? '',
				r.amount == null ? chalk.dim(`(none: grant ${startingTokens} pending)`) : String(r.amount),
			])
		}
		console.log(table.toString())

		if (opts.dryRun) {
			console.log(
				chalk.yellow(`dry run: would add ${amount} tokens to ${before.length} account(s)`)
			)
			return
		}

		console.log(`Adding ${amount} tokens to ${before.length} account(s)`)
		const credited = (
			await execSql<PlusMemberRow>(plusReloadSql(amount, startingTokens), remote, 'econ')
		).results
		const after = new Table({ head: ['account', 'tokens'] })
		for (const r of credited) after.push([String(r.account_id), String(r.amount)])
		console.log(after.toString())
		console.log(chalk.green(`✓ ${amount} tokens added to ${credited.length} account(s)`))
	})

/**
 * The exports `cai-load` reads when no `--file` is given, in PRECEDENCE order: each only adds
 * ids the ones before it lack, so the studio87 extras never overwrite a 2025 item.
 */
const CUSTOM_AVATAR_ITEM_EXPORTS = [
	'apps/econ/static/db/2025-1-cai.json',
	'apps/econ/static/db/studio87-extras.json',
]

/**
 * Load the first-party custom avatar items into `custom_avatar_item` (owned by the `api`
 * worker). Like `runx catalog load`: the table's STRUCTURE is a migration, its first-party
 * CONTENTS are not, and this is the reload. Each record lands as the row's JSON with its
 * `CreatorAccountId` forced to the Coach account (1) — what makes it stock content here — and
 * each save's `ThumbnailFileName` put under `avatar/` and its assetbundle hashes blanked — they
 * are the PC builds' hashes, and the same save serves the Quest builds too. (The statements
 * come from api's `custom-avatar-items-load.ts`, the same ones the migration generator writes.)
 * An id already present is REPLACED, and nothing is deleted — the players' own shirts share the
 * table and an export never mentions them. Re-running is always safe.
 */
const caiLoad = new Command('cai-load')
	.description('Load first-party custom avatar items from an export JSON (merges; never deletes)')
	.option(
		'--file <paths...>',
		'The export(s) to load, relative to the repo root (default: every committed export)',
		CUSTOM_AVATAR_ITEM_EXPORTS
	)
	.option(
		'--dry-run',
		'Read and validate the export, print what would be written, change nothing',
		false
	)
	.option('--local', 'Target the local dev database (the default).', false)
	.option('--remote', 'Target the deployed database instead of the local dev database.', false)
	.action(async (opts) => {
		const remote = resolveRemote(opts)
		// A later export only ADDS: an id an earlier one already holds is skipped, never replaced.
		// (A duplicate within one export is still refused.)
		const records: ReturnType<typeof readCustomAvatarItemExport> = []
		const seen = new Set<string>()
		for (const file of opts.file) {
			const full = path.isAbsolute(file) ? file : path.join(getRepoRoot(), file)
			if (!(await fs.pathExists(full))) throw new Error(`no export at ${file}`)
			// Tolerate the BOM a .NET export carries (`JSON.parse` rejects U+FEFF).
			const text = (await fs.readFile(full, 'utf8')).replace(/^\uFEFF/, '')
			let skipped = 0
			for (const record of readCustomAvatarItemExport(JSON.parse(text) as unknown)) {
				if (seen.has(record.CustomAvatarItemId)) {
					skipped++
					continue
				}
				seen.add(record.CustomAvatarItemId)
				records.push(record)
			}
			if (skipped > 0) {
				console.log(chalk.yellow(`${file}: skipped ${skipped} id(s) an earlier export holds`))
			}
		}
		if (records.length === 0)
			throw new Error('the export holds no records — refusing to call that a load')
		const statements = customAvatarItemUpsertStatements(records)
		const sql = statements.join('\n')

		console.log(
			`Merging ${records.length} custom avatar items from ${opts.file.join(', ')} into ${target(remote)}`
		)
		if (opts.dryRun) {
			console.log(
				chalk.cyan(
					`--dry-run: built ${statements.length} statements (${(sql.length / 1024).toFixed(0)} KB); nothing was written.`
				)
			)
			return
		}

		const count = async (): Promise<number> =>
			Number(
				(await execSql('SELECT COUNT(*) AS n FROM custom_avatar_item', remote, 'api')).results[0]
					?.n ?? 0
			)
		const before = await count()

		// Written to a temp file rather than passed as `--command`: a multi-megabyte argv is not
		// something to rely on, and `--file` is the path wrangler batches (or, remotely, imports).
		const file = path.join(os.tmpdir(), `recflare-cai-${Date.now()}.sql`)
		await fs.writeFile(file, sql)
		try {
			await execSqlFile(file, remote, 'api')
		} finally {
			await fs.remove(file)
		}

		// Prove the load landed rather than trusting the exit: wrangler's meta carries no usable
		// row count, and a file that fails partway leaves a partial load rather than an error.
		// A merge only adds, so the table must hold at least what was written; then spot-check
		// ids from across the export, the last one mattering most.
		const after = await count()
		if (after < records.length) {
			throw new Error(
				`load did not land: expected at least ${records.length} rows, the table holds ${after}. Re-run it.`
			)
		}
		const probes = [
			records[0],
			records[Math.floor(records.length / 2)],
			records[records.length - 1],
		].map((r) => `'${sqlStr(r.CustomAvatarItemId)}'`)
		const found = Number(
			(
				await execSql(
					`SELECT COUNT(*) AS n FROM custom_avatar_item WHERE custom_avatar_item_id IN (${probes.join(', ')})`,
					remote,
					'api'
				)
			).results[0]?.n ?? 0
		)
		if (found !== probes.length) {
			throw new Error(
				`load did not land: ${probes.length - found} of ${probes.length} probe rows are missing. Re-run it.`
			)
		}
		const added = after - before
		console.log(
			`${added} new, ${records.length - added} replaced in place, 0 removed (${after} rows now)`
		)
		console.log(chalk.green(`✓ custom avatar items loaded into ${target(remote)}`))
	})

/** The KV binding the player settings used to live under — the key `RECFLARE_KV` files its id by. */
const SETTINGS_KV_BINDING = 'RECFLARE_PLAYER_SETTINGS'
/** Every settings key in that namespace was `player:<accountId>`. */
const SETTINGS_KV_PREFIX = 'player:'
/** The KV bulk-get API takes at most this many keys per request. */
const KV_BULK_GET_LIMIT = 100

/**
 * Run `wrangler kv …` from the `playersettings` directory — the namespace was that worker's
 * binding, so with `--local` the dev-store state wrangler kept for it is under its .wrangler/.
 */
async function runKv(args: string[], remote: boolean): Promise<string> {
	cd(path.join(getRepoRoot(), 'apps', 'playersettings'))
	const out = await $`pnpm exec wrangler kv ${args} ${remote ? '--remote' : '--local'}`.quiet()
	return out.stdout
}

/** The JSON wrangler prints after its banner (which can carry ANSI `[` sequences of its own). */
function parseWranglerJson<T>(stdout: string): T {
	const m = /^[[{]/m.exec(stdout)
	if (!m) throw new Error(`unexpected wrangler output:\n${stdout}`)
	return JSON.parse(stdout.slice(m.index)) as T
}

/** The old namespace's id, from the `RECFLARE_KV` entry the deploys used to splice it from. */
async function settingsNamespaceIdFromEnv(): Promise<string> {
	const raw = await readRootEnv('RECFLARE_KV')
	const id = raw ? (JSON.parse(raw) as Record<string, string>)[SETTINGS_KV_BINDING] : undefined
	if (id) return id
	throw new Error(
		`no ${SETTINGS_KV_BINDING} id in RECFLARE_KV — pass --namespace-id, or add the old namespace's id to .env`
	)
}

/**
 * Copy the old `RECFLARE_PLAYER_SETTINGS` KV namespace into the `player_settings` table (owned
 * by the `playersettings` worker). A KV value was the player's whole map as a JSON object of
 * strings, which is exactly what the row's `data` holds, so each key becomes one row.
 *
 * Rows that already exist are MERGED: KV fills in what D1 lacks, and D1 wins any key it has
 * moved off the seeded default. A key D1 still holds AT its default (`SEEDED_DEFAULTS`) does
 * not count as the player's — `GET /playersettings` seeds those for any player with no row, so
 * a player who signed in after the cut-over but before the import has a fresh row of
 * defaults, and their KV progress (OOBE, tutorial mask) has to beat it. That makes the import
 * safe to run after the cut-over and to re-run. `--overwrite` makes KV win outright instead.
 * Nothing is deleted on either side.
 *
 * What it cannot recover is a KV write made after the import read the namespace, to a key the
 * imported row already holds off-default: D1 keeps the imported value. So run it once before
 * `just deploy` (the bulk) and once after (to catch anyone who changed something in between).
 */
/**
 * What `GET /playersettings` seeds for a player with no row — mirror of `DEFAULT_SETTINGS` in
 * apps/playersettings/src/default-settings.ts. A D1 value equal to one of these may be the
 * seed rather than the player's, so the import lets KV replace it.
 */
const SEEDED_DEFAULTS: Record<string, string> = {
	'Recroom.OOBE': '77',
	TUTORIAL_COMPLETE_MASK: '11',
	FIRST_TIME_IN_FLAGS: '0',
}

/**
 * A KV value as a settings map, or null when it isn't one. Numbers and booleans are kept as
 * their string form (what a PUT would have stored); a null, object or array value drops just
 * that key rather than the player's whole map.
 */
function kvSettingsMap(value: string | null | undefined): Record<string, string> | null {
	let parsed: unknown
	try {
		parsed = value == null ? null : JSON.parse(value)
	} catch {
		return null
	}
	if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return null
	const map: Record<string, string> = {}
	for (const [k, v] of Object.entries(parsed)) {
		if (typeof v === 'string') map[k] = v
		else if (typeof v === 'number' || typeof v === 'boolean') map[k] = String(v)
	}
	return map
}

const settingsImportKv = new Command('settings-import-kv')
	.description('Copy the old RECFLARE_PLAYER_SETTINGS KV namespace into player_settings (merges)')
	.option(
		'--namespace-id <id>',
		`The KV namespace to read (default: ${SETTINGS_KV_BINDING} in RECFLARE_KV from .env; "local" with --local)`
	)
	.option(
		'--overwrite',
		'Let the KV value replace a row that already exists (the default merges, keeping what D1 has)',
		false
	)
	.option('--dry-run', 'Read the namespace, report what would be written, change nothing', false)
	.option('--local', 'Target the local dev database and KV store (the default).', false)
	.option('--remote', 'Target the deployed database and namespace instead.', false)
	.action(async (opts) => {
		const remote = resolveRemote(opts)
		const namespaceId = opts.namespaceId ?? (remote ? await settingsNamespaceIdFromEnv() : 'local')
		console.log(
			`Reading KV namespace ${namespaceId} (${remote ? 'remote' : 'local'}) into ${target(remote)}`
		)

		const keys = parseWranglerJson<Array<{ name: string }>>(
			await runKv(
				['key', 'list', '--namespace-id', namespaceId, '--prefix', SETTINGS_KV_PREFIX],
				remote
			)
		).map((k) => k.name)
		console.log(`${keys.length} ${SETTINGS_KV_PREFIX}* key(s) in the namespace`)

		const rows: Array<{ accountId: number; data: string }> = []
		const skipped: string[] = []
		let empty = 0
		for (let i = 0; i < keys.length; i += KV_BULK_GET_LIMIT) {
			const chunk = keys.slice(i, i + KV_BULK_GET_LIMIT)
			const file = path.join(os.tmpdir(), `recflare-kv-keys-${Date.now()}-${i}.json`)
			await fs.writeFile(file, JSON.stringify(chunk))
			// `bulk get` answers `{ key: value }`, or `{ key: { value, metadata } }` with
			// `--with-metadata`; read either.
			let got: Record<string, string | { value: string | null } | null>
			try {
				got = parseWranglerJson(
					await runKv(['bulk', 'get', file, '--namespace-id', namespaceId], remote)
				)
			} finally {
				await fs.remove(file)
			}
			for (const key of chunk) {
				const accountId = Number(key.slice(SETTINGS_KV_PREFIX.length))
				const raw = got[key]
				const map = kvSettingsMap(typeof raw === 'string' ? raw : raw?.value)
				if (!Number.isSafeInteger(accountId) || accountId <= 0 || map === null) {
					skipped.push(key)
					continue
				}
				// An empty map is what a player with no row reads as; nothing to import.
				if (Object.keys(map).length === 0) {
					empty++
					continue
				}
				rows.push({ accountId, data: JSON.stringify(map) })
			}
			console.log(`  fetched ${Math.min(i + chunk.length, keys.length)}/${keys.length}`)
		}
		for (const key of skipped) console.log(chalk.yellow(`  skipping ${key}: not a settings map`))

		// Merge: start from D1, lay KV over it, then lay back every D1 key that isn't sitting at
		// its seeded default. (`json_group_object` of no rows is `{}`, which patches nothing.)
		const d1OwnKeys = `(SELECT json_group_object(s.key, s.value) FROM json_each(player_settings.data) AS s WHERE NOT EXISTS (SELECT 1 FROM json_each('${sqlStr(JSON.stringify(SEEDED_DEFAULTS))}') AS d WHERE d.key = s.key AND d.value = s.value))`
		const onConflict = opts.overwrite
			? 'excluded.data'
			: `json_patch(json_patch(player_settings.data, excluded.data), ${d1OwnKeys})`
		const statements = rows.map(
			(r) =>
				`INSERT INTO player_settings (account_id, data) VALUES (${r.accountId}, '${sqlStr(r.data)}') ON CONFLICT (account_id) DO UPDATE SET data = ${onConflict};`
		)
		console.log(
			`${rows.length} player(s) to import, ${empty} empty, ${skipped.length} skipped` +
				(opts.overwrite
					? ' (KV overwrites existing rows)'
					: ' (existing rows merge; D1 wins unless still at a seeded default)')
		)
		if (opts.dryRun) {
			console.log(
				chalk.cyan(`--dry-run: built ${statements.length} statements; nothing was written.`)
			)
			return
		}
		if (rows.length === 0) {
			console.log(chalk.green('✓ nothing to import'))
			return
		}

		const count = async (): Promise<number> =>
			Number(
				(await execSql('SELECT COUNT(*) AS n FROM player_settings', remote, 'playersettings'))
					.results[0]?.n ?? 0
			)
		const before = await count()

		const sqlFile = path.join(os.tmpdir(), `recflare-settings-${Date.now()}.sql`)
		await fs.writeFile(sqlFile, statements.join('\n'))
		try {
			await execSqlFile(sqlFile, remote, 'playersettings')
		} catch (err) {
			// A large remote `--file` goes through D1's import API, and wrangler can fail its
			// final status poll with this after the import has already completed (it did, for
			// all 15,137 rows, the first time this ran). Fall through to the check below, which
			// decides whether the rows actually landed.
			if (!(err instanceof Error && err.message.includes('Not currently importing anything'))) {
				throw err
			}
			console.log(chalk.yellow('  wrangler lost track of the import; checking what landed'))
		} finally {
			await fs.remove(sqlFile)
		}

		// Prove it landed: a merge never deletes, so the table holds at least every imported id.
		const after = await count()
		// Chunked: one IN list of every id outgrows D1's statement limit (and argv) at ~15k players.
		const ids = rows.map((r) => r.accountId)
		let found = 0
		for (let i = 0; i < ids.length; i += 1000) {
			found += Number(
				(
					await execSql(
						`SELECT COUNT(*) AS n FROM player_settings WHERE account_id IN (${ids.slice(i, i + 1000).join(', ')})`,
						remote,
						'playersettings'
					)
				).results[0]?.n ?? 0
			)
		}
		if (found !== ids.length) {
			throw new Error(
				`import did not land: ${ids.length - found} of ${ids.length} rows are missing. Re-run it.`
			)
		}
		const added = after - before
		console.log(
			`${added} new row(s), ${rows.length - added} merged into existing rows (${after} rows now)`
		)
		console.log(chalk.green(`✓ player settings imported into ${target(remote)}`))
	})

const lookup = new Command('lookup')
	.description('Print an account by id or username')
	.option('--account <id>', 'Account id to look up')
	.option('--username <name>', 'Username to look up (case-insensitive)')
	.option('--local', 'Target the local dev database (the default).', false)
	.option('--remote', 'Target the deployed database instead of the local dev database.', false)
	.action(async (opts) => {
		const { where, label } = whereClause(opts.account, opts.username)
		const remote = resolveRemote(opts)
		const sql = `SELECT
			json_extract(data, '$.accountId') AS accountId,
			json_extract(data, '$.username') AS username,
			json_extract(data, '$.platform') AS platform,
			json_extract(data, '$.platformId') AS platformId,
			json_extract(data, '$.createdAt') AS createdAt,
			json_extract(data, '$.lastLoginTime') AS lastLoginTime,
			(json_extract(data, '$.passwordHash') IS NOT NULL) AS hasPassword,
			(json_extract(data, '$.isDeveloper') = 1) AS isDeveloper,
			(json_extract(data, '$.isModerator') = 1) AS isModerator,
			(json_extract(data, '$.isInfluencer') = 1) AS isInfluencer,
			(json_extract(data, '$.hasStudio') = 1) AS hasStudio
			FROM account WHERE ${where}`
		const res = await execSql(sql, remote)
		const row = res.results[0]
		if (!row) {
			console.log(chalk.yellow(`no account found for ${label} on ${target(remote)}`))
			return
		}
		const asText = (v: unknown): string =>
			v == null
				? ''
				: typeof v === 'object'
					? JSON.stringify(v)
					: String(v as number | string | boolean)
		const boolKeys = new Set([
			'hasPassword',
			'isDeveloper',
			'isModerator',
			'isInfluencer',
			'hasStudio',
		])
		const table = new Table()
		for (const [key, value] of Object.entries(row)) {
			const shown = boolKeys.has(key) ? (value === 1 ? 'yes' : 'no') : asText(value)
			table.push({ [key]: shown })
		}
		console.log(table.toString())
	})

export const adminCmd = new Command('admin')
	.description('Operator tools for accounts on the shared recflare D1 database')
	// Bare `admin` (no subcommand) prints help and exits cleanly, rather than
	// commander's default "missing command" error (exit 1).
	.action((_opts, command: Command) => command.outputHelp())
	.addCommand(setPassword)
	.addCommand(clearPassword)
	.addCommand(grantDeveloper)
	.addCommand(grantModerator)
	.addCommand(grantInfluencer)
	.addCommand(grantPlus)
	.addCommand(grantStudio)
	.addCommand(reloadPlus)
	.addCommand(caiLoad)
	.addCommand(settingsImportKv)
	.addCommand(lookup)
	.addHelpText(
		'after',
		`
Select an account with --account <id> or --username <name>.
Target --local (default) or --remote (production; needs RECFLARE_D1 in .env).
Add --help to any subcommand for its options, e.g. \`runx admin set-password --help\`.

Examples:
  $ runx admin set-password --account 1               # prompts, hidden
  $ echo "s3cret" | runx admin set-password --account 1
  $ runx admin clear-password --username alice
  $ runx admin grant-developer --account 1 [--revoke]
  $ runx admin grant-moderator --username alice --remote
  $ runx admin grant-plus --username alice          # Rec Room Plus; takes effect next login
  $ runx admin reload-plus 1000 --remote            # +1000 tokens to every Plus subscriber
  $ runx admin reload-plus 1000 --dry-run           # just list them
  $ runx admin cai-load                             # merge every committed first-party export (local)
  $ runx admin cai-load --remote --file path/to/export.json
  $ runx admin lookup --username alice --remote`
	)
