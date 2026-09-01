import { logger } from '@repo/hono-helpers'

import type { Env } from './context'

/**
 * Discord OAuth2, the identity check behind the website's benefits claim.
 *
 * A player proves they hold one of the qualifying roles in the community Discord, and
 * the claim grants them Rec Room Plus (`account.hasPlus`). The proof is a real OAuth2
 * AUTHORIZATION CODE exchange, not a token the browser hands us: the SPA sends only the
 * short-lived `code` Discord redirected it back with, and this worker swaps that for an
 * access token using the client SECRET, which — like the Turnstile secret next door —
 * can never ship to a page. The access token therefore never exists in the browser at
 * all, and it is revoked here the moment the roles have been read.
 *
 * Roles come from `GET /users/@me/guilds/{guild}/member`, which needs no bot: the
 * `guilds.members.read` scope lets the TOKEN'S OWNER read their own membership. That is
 * the whole reason this shape was chosen over a bot token — nothing here has to be in
 * the guild, and the worker holds no credential that could read anybody else's roles.
 *
 * The four settings (client id, client secret, guild, one or more roles) are the switch,
 * exactly as the Turnstile keypair is for signup: with any of them missing the claim is CLOSED
 * (`/api/config` says so and `/api/benefits/claim` refuses) rather than open and
 * unverified. Nothing is ever inferred from the environment.
 */

/** Discord's API, pinned to v10 — the version the endpoints below are documented at. */
const API_BASE = 'https://discord.com/api/v10'

/**
 * Where the browser is sent to consent. Deliberately NOT under `/api/v10`: the authorize
 * page is a human-facing page on the main site, and the versioned path serves a redirect
 * to it at best.
 */
export const AUTHORIZE_URL = 'https://discord.com/oauth2/authorize'

/**
 * The scopes the claim asks for, in the order Discord shows them on the consent screen.
 *
 *  - `identify` — the user's own id, which the claim stores as a `PlatformType.Discord`
 *    link on the account to keep itself once-only.
 *  - `guilds.members.read` — their member record (and so their ROLES) in one guild they
 *    are in. Narrower than `guilds`, which lists every server they belong to and is not
 *    needed: the claim asks about exactly one guild.
 *
 * A space-joined string because that is how the authorize URL takes them.
 */
export const SCOPES = 'identify guilds.members.read'

/** Everything the claim needs configured. Resolved per request; see `discordConfig`. */
export interface DiscordConfig {
	/** The application's client id. PUBLIC — it ships to the browser in the authorize URL. */
	clientId: string
	/** The application's client secret. Never leaves this worker. */
	clientSecret: string
	/** The guild (server) whose membership is checked. */
	guildId: string
	/**
	 * The role ids within that guild that entitle a player to the benefits — Discord
	 * snowflakes, all digits. ANY one of them qualifies: they're alternatives (a supporter
	 * role, a booster role, staff…), not requirements, so this is a set to test membership
	 * against and never an ordered list. Always at least one entry — an empty list closes
	 * the claim (see `discordConfig`).
	 */
	roleIds: string[]
}

/**
 * Parse the configured role ids — Discord snowflakes, so each one is ALL DIGITS (a role's
 * display name is not an id and will never match anything). They stay strings rather than
 * becoming numbers: a snowflake exceeds 2^53, and they are only ever compared, never done
 * arithmetic on.
 *
 * Separated by commas and/or whitespace, so a value pasted out of Discord one id per line
 * works as well as `1077000000000000001,1077000000000000002` does; blank entries are
 * dropped, which is what makes a trailing comma harmless rather than a role id of `''`
 * that nothing can ever match.
 *
 * The digits are not ENFORCED here, deliberately. A typo'd snowflake is indistinguishable
 * from a real role nobody holds, and both correctly result in a claim being refused, so a
 * format rule would buy nothing but a way to reject a valid id if Discord ever widens the
 * format. Misconfiguration shows up as "nobody can claim", which is the safe direction.
 */
export const parseRoleIds = (raw: string): string[] =>
	raw
		.split(/[\s,]+/)
		.map((id) => id.trim())
		.filter((id) => id !== '')

/**
 * The Discord settings, or null when the claim isn't configured — which is what CLOSES
 * it. All four must be present, and the role list must parse to at least ONE id: a client
 * id with no roles would authenticate a player and then have no question to ask about
 * them, and treating that as "configured" would hand Plus to anyone with a Discord
 * account.
 *
 * Which of the four is missing is logged (never their values) because a half-configured
 * app is otherwise indistinguishable from an operator deliberately leaving benefits off.
 *
 * The id and secret come from the account-level Secrets Store the whole monorepo shares,
 * so they're read per request rather than off `env` as strings; `.get()` caches per
 * isolate, so changing either needs a `www` redeploy to take effect on a warm worker —
 * the same caveat TURNSTILE_* and JWT_SECRET carry. The guild and roles are plain vars:
 * they're server ids visible to every member, not credentials.
 */
export async function discordConfig(env: Env): Promise<DiscordConfig | null> {
	const [clientId, clientSecret] = await Promise.all([
		readSecret(env.DISCORD_CLIENT_ID, 'DISCORD_CLIENT_ID'),
		readSecret(env.DISCORD_CLIENT_SECRET, 'DISCORD_CLIENT_SECRET'),
	])
	const guildId = env.DISCORD_GUILD_ID ?? ''
	const roleIds = parseRoleIds(env.DISCORD_BENEFITS_ROLE_IDS ?? '')

	if (clientId !== '' && clientSecret !== '' && guildId !== '' && roleIds.length > 0) {
		return { clientId, clientSecret, guildId, roleIds }
	}
	if (clientId !== '' || clientSecret !== '' || guildId !== '' || roleIds.length > 0) {
		logger.error('discord is half-configured, so benefit claims are closed', {
			hasClientId: clientId !== '',
			hasClientSecret: clientSecret !== '',
			hasGuildId: guildId !== '',
			// The COUNT, not the ids: a value that parsed to nothing (say, a stray comma) is
			// indistinguishable from an unset one without it.
			roleIdCount: roleIds.length,
		})
	}
	return null
}

/**
 * One Secrets Store value as a string, or '' when it can't be read. The binding is
 * declared in wrangler.jsonc so it's always on `env`; what varies is whether the store
 * holds the secret — a missing one throws rather than resolving empty. Mirrors
 * `turnstile.ts`'s reader, and for the same reason: a store this worker can't read must
 * close the feature, not 500 the homepage.
 */
async function readSecret(secret: SecretsStoreSecret, name: string): Promise<string> {
	try {
		return (await secret.get()) ?? ''
	} catch (err) {
		logger.error('failed to read a discord credential from the secrets store', {
			secret: name,
			error: String(err),
		})
		return ''
	}
}

/**
 * The URI Discord redirects back to after consent, derived from the request rather than
 * configured.
 *
 * It must be byte-identical in three places — the authorize URL the browser opens, the
 * token exchange below, and the app's registered redirect list — or Discord refuses the
 * exchange. Deriving it from the incoming request's own origin is what keeps the first
 * two in step across every environment (localhost in dev, the real domain in
 * production) with nothing to configure, and it is also why the SPA does NOT get to
 * supply it in the request body: an attacker-supplied redirect would turn this worker's
 * client secret into a redemption oracle for codes issued to somebody else's app page.
 *
 * `/claim` is the SPA route that handles the return; see App.tsx.
 */
export const redirectUri = (request: Request): string => new URL('/claim', request.url).toString()

/**
 * Swap an authorization code for an access token. Returns null on any refusal — a code
 * that was already spent, expired (they live ~1 minute), issued to another app, or paired
 * with a different redirect URI all land here, and none of them is worth telling the
 * browser apart: the answer is the same, start the flow again.
 *
 * The credentials go in the BODY rather than a Basic auth header. Both are legal and
 * Discord documents the body form.
 */
export async function exchangeCode(
	config: DiscordConfig,
	code: string,
	redirect: string
): Promise<string | null> {
	try {
		const res = await fetch(`${API_BASE}/oauth2/token`, {
			method: 'POST',
			headers: { 'content-type': 'application/x-www-form-urlencoded' },
			body: new URLSearchParams({
				client_id: config.clientId,
				client_secret: config.clientSecret,
				grant_type: 'authorization_code',
				code,
				redirect_uri: redirect,
			}).toString(),
		})
		if (!res.ok) {
			// The body carries an OAuth error code (`invalid_grant`, `invalid_client`) — the
			// last of which is a misconfiguration, not a player mistake, and this line is the
			// only place it surfaces. Logged, never relayed: it tells a caller nothing.
			logger.info('discord refused a code exchange', {
				status: res.status,
				body: await res.text().catch(() => ''),
			})
			return null
		}
		const token = (await res.json()) as { access_token?: unknown }
		return typeof token.access_token === 'string' ? token.access_token : null
	} catch (err) {
		logger.error('could not reach discord to exchange a code', { error: String(err) })
		return null
	}
}

/**
 * Whether a member holds ANY of the qualifying roles. Both sides are snowflake id
 * strings, compared exactly — Discord reports a member's roles as ids, never as names.
 *
 * The roles are alternatives (a supporter, a booster and a staff member all qualify), so
 * this is an intersection test and not a subset one: requiring all of them would mean
 * nobody ever claimed.
 */
export const qualifies = (memberRoles: string[], roleIds: string[]): boolean =>
	memberRoles.some((role) => roleIds.includes(role))

/** Who claimed, and what they hold in the guild. */
export interface GuildMembership {
	/** The Discord user's id (a snowflake, kept as a string — it exceeds 2^53). */
	userId: string
	/** Their Discord username, for the confirmation line. Display only, never stored. */
	username: string
	/** Their role ids in the guild. */
	roles: string[]
}

/**
 * The token owner's membership in the configured guild, or null when they aren't in it
 * (Discord answers 404) or the call fails.
 *
 * `null` deliberately conflates "not a member" with "we couldn't ask". Both mean the same
 * thing to the claim — no proof was obtained — and a claim that granted benefits when
 * Discord was unreachable would be worse than one that asks the player to retry.
 */
export async function fetchGuildMembership(
	accessToken: string,
	guildId: string
): Promise<GuildMembership | null> {
	try {
		const res = await fetch(`${API_BASE}/users/@me/guilds/${guildId}/member`, {
			headers: { authorization: `Bearer ${accessToken}` },
		})
		if (!res.ok) {
			// 404 is the ordinary "they aren't in the server" answer, so it's info, not error.
			logger.info('discord did not return a guild membership', { status: res.status })
			return null
		}
		const member = (await res.json()) as {
			user?: { id?: unknown; username?: unknown }
			roles?: unknown
		}
		const userId = typeof member.user?.id === 'string' ? member.user.id : ''
		if (userId === '') {
			logger.error('discord returned a guild member with no user id')
			return null
		}
		return {
			userId,
			username: typeof member.user?.username === 'string' ? member.user.username : '',
			roles: Array.isArray(member.roles)
				? member.roles.filter((r): r is string => typeof r === 'string')
				: [],
		}
	} catch (err) {
		logger.error('could not reach discord to read a guild membership', { error: String(err) })
		return null
	}
}

/**
 * Hand the access token back to Discord once the roles have been read.
 *
 * Best-effort and deliberately un-awaited-on by the caller's success path: the claim has
 * already been decided by this point, so a failed revoke must not fail it. It's here
 * because the token is useless to us after one read and a live token is a liability for
 * however long it would otherwise last (a week) — this keeps the credential's lifetime
 * about as long as the request that needed it.
 */
export async function revokeToken(config: DiscordConfig, accessToken: string): Promise<void> {
	try {
		await fetch(`${API_BASE}/oauth2/token/revoke`, {
			method: 'POST',
			headers: { 'content-type': 'application/x-www-form-urlencoded' },
			body: new URLSearchParams({
				client_id: config.clientId,
				client_secret: config.clientSecret,
				token: accessToken,
				token_type_hint: 'access_token',
			}).toString(),
		})
	} catch (err) {
		logger.info('could not revoke a discord access token', { error: String(err) })
	}
}
