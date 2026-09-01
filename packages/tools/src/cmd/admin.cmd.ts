import * as readline from 'node:readline'
import { Command } from '@commander-js/extra-typings'
import Table from 'cli-table3'

import { execSql, resolveRemote, sqlStr, target } from '../d1'
import { hashPassword } from '../password'

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
 *   runx admin grant-plus      --username alice [--revoke] [--remote]
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
			(json_extract(data, '$.isModerator') = 1) AS isModerator
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
		const boolKeys = new Set(['hasPassword', 'isDeveloper', 'isModerator'])
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
	.addCommand(grantPlus)
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
  $ runx admin lookup --username alice --remote`
	)
