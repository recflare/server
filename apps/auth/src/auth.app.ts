import { Hono } from 'hono'
import { describeRoute, openAPIRouteHandler } from 'hono-openapi'
import { useWorkersLogger } from 'workers-tagged-logger'
import { z } from 'zod'

import {
	countAccountsBySignupIp,
	createAccount,
	GAME_VERSION,
	getAccount,
	getAccountByUsername,
	getAccountsByIds,
	getPasswordHash,
	getRoomById,
	hashPassword,
	RoomInstanceType,
	setLastLoginTime,
	setLoginContext,
	setPasswordHash,
	setPresence,
	subRoomDataBlob,
	updateAccount,
	verifyPassword,
} from '@repo/domain'
import {
	intVar,
	logger,
	withCleanSpec,
	withDefaultCors,
	withNotFound,
	withOnError,
} from '@repo/hono-helpers'
import { generateToken, TOKEN_TTL_SECONDS, validateAndGetAccountId } from '@repo/jwt'

// The account-wide ban lives on a `report` row, whose table the api worker owns; its db
// module is plain D1 queries with no runtime deps, so it imports cleanly here.
import { banEvasionMatch, resolveBan } from '../../api/src/bans-db'
import { verifyMetaNonce } from './meta-nonce'
import {
	CachedLogin,
	ChangePasswordRequest,
	ChangePasswordResponse,
	FakeCachedLogin,
	form,
	json,
	OAuthError,
	PlatformIdsRequest,
	PlatformType,
	RestrictionDto,
	roleLookup,
	TokenRequest,
	TokenResponse,
} from './openapi'
import {
	countAccountsForPlatformIdentity,
	getLinksForPlatformId,
	getLinksForPlatformIdentity,
	isPlatformIdentityLinked,
	linkPlatformIdentity,
} from './platform-db'
import { consumeRefreshToken, issueRefreshToken } from './refresh-db'
import { verifySteamTicket } from './steam-ticket'

import type { Context } from 'hono'
import type { Account } from '@repo/domain'
import type { App } from './context'
import type { PlatformLink } from './platform-db'

/** OAuth scopes granted by `/connect/token`. */
const TOKEN_SCOPE =
	'offline_access profile rn rn.accounts rn.accounts.gc rn.api rn.chat rn.clubs rn.commerce rn.match.read rn.match.write rn.notify rn.rooms rn.storage'

/**
 * The `error_description` a banned account's grant is refused with. A fixed sentence,
 * never interpolated with the expiry, because `www`'s shared auth-messages table keys on
 * this exact string to put a real sentence in front of a player — anything varying would
 * fall through to the generic "you could not be signed in". Keep the two in sync.
 */
const BANNED_DESCRIPTION = 'this account is banned'

/**
 * The refusal when it is not THIS account that is banned but one it shares an identity
 * with (see bans-db's linked arms). Deliberately a different, vaguer sentence: the
 * account being refused may be an innocent housemate of a banned player, so telling them
 * "this account is banned" would be a lie, and naming the account we matched them to
 * would hand out somebody else's moderation record.
 */
const BLOCKED_DESCRIPTION = 'this device or network is blocked'

/**
 * The platform id a SIDELOADED Oculus APK reports. It is not an identity: a sideloaded
 * build has no Meta SDK to ask, so it has nothing real to report — and every sideloaded
 * headset reports this same value. Two things follow, and both are enforced below:
 *  - it is never verifiable (`verifyPlatformProof` refuses it outright), and
 *  - it is therefore never LINKED to an account. A link is a password-free way in, so
 *    one link on a shared id would open that account to every sideloaded build.
 * It exists only to get such a client onto the username/password login screen.
 */
const SIDELOAD_PLATFORM_ID = '1'

/**
 * The canned entry served for the one Oculus cached-login lookup below — the sideloaded
 * APK's way onto the password login screen. Not backed by a link, an account or a
 * platform proof, hence `requirePassword: true`.
 */
const FAKE_OCULUS_CACHED_LOGIN = {
	platform: PlatformType.Oculus,
	platformId: SIDELOAD_PLATFORM_ID,
	accountId: 1,
	lastLoginTime: '2026-07-19T17:13:29.225Z',
	requirePassword: true,
} as const

/**
 * Signup caps, enforced on create_account only (never on login — an existing account
 * always stays reachable, however many accounts its owner has since accumulated).
 *
 * Two independent arms, because they fail in opposite ways:
 *  - Per verified platform id (a Steam-proven SteamID64). The sharp one: it can't be
 *    spoofed and can't be reset by changing networks. Only binds on a platform
 *    create_account — the password/anonymous path has no platform identity to count,
 *    so the IP arm is the only thing standing between it and bulk signup.
 *  - Per signup IP. Coarse: households, NAT and shared campus/mobile networks put many
 *    legitimate players behind one address, so this WILL be the arm that produces false
 *    positives. It counts `signupIp` (immutable), so an abuser can't reset their own
 *    count by hopping networks.
 *
 * These are the defaults. An operator overrides either arm with the matching worker var
 * (`MAX_ACCOUNTS_PER_PLATFORM_ID` / `MAX_ACCOUNTS_PER_IP` in wrangler.jsonc `vars`), and
 * setting one to 0 disables that arm entirely — which a small private server that trusts
 * everyone it invites will want, and which the IP arm in particular is worth reaching for
 * if a shared network is being locked out.
 */
const DEFAULT_MAX_ACCOUNTS_PER_PLATFORM_ID = 3
const DEFAULT_MAX_ACCOUNTS_PER_IP = 3

/** New players start in the Orientation room (RoomId 13) — the new-user flow. */
const ORIENTATION_ROOM_ID = 13
/**
 * The client loads Orientation locally (no matchmake) and tags its instance with
 * the sentinel id -2. The heartbeat must echo that exact `roomInstanceId` or the
 * client treats presence as out-of-sync and bounces the player to the dorm.
 */
const ORIENTATION_INSTANCE_ID = -2

/**
 * Seed a freshly created account's match presence to the Orientation room. The
 * client is placed into Orientation by its new-user flow without a matchmake
 * call, so the match heartbeat would otherwise report no/stale (dorm) presence
 * and bounce the player out. We write the Orientation instance (built from the
 * shared rooms D1, matching the match worker's `roomInstanceFromRoom` shape) into
 * the shared `presence` table (see @repo/domain) so the heartbeat keeps them there.
 */
async function placeNewPlayerInOrientation(
	env: App['Bindings'],
	accountId: number,
	deviceClass: number
): Promise<void> {
	// getRoomById hydrates the room's SubRooms from the subroom table (they no longer
	// live in the room blob), so the Orientation scene resolves the same way match does.
	const room = await getRoomById(env.DB, ORIENTATION_ROOM_ID)
	if (!room) return

	const subRooms = room.SubRooms
	const sub = (Array.isArray(subRooms) ? subRooms[0] : undefined) as
		Record<string, unknown> | undefined
	const str = (v: unknown, fallback = '') => (typeof v === 'string' ? v : fallback)
	const num = (v: unknown, fallback: number) => (typeof v === 'number' ? v : fallback)

	const roomInstance = {
		roomInstanceId: ORIENTATION_INSTANCE_ID,
		roomId: ORIENTATION_ROOM_ID,
		subRoomId: num(sub?.SubRoomId, 1),
		roomInstanceType: RoomInstanceType.Public,
		location: str(sub?.UnitySceneId),
		dataBlob: subRoomDataBlob(sub),
		eventId: 0,
		clubId: 0,
		roomCode: '',
		photonRegion: 'us',
		photonRegionId: 'us',
		photonRoomId: `rec.${ORIENTATION_ROOM_ID}`,
		name: `^${str(room.Name, 'Orientation')}`,
		maxCapacity: num(sub?.MaxPlayers, 4),
		isFull: false,
		isPrivate: false,
		isInProgress: false,
		EncryptVoiceChat: false,
	}
	await setPresence(env.DB, {
		accountId,
		roomInstance,
		statusVisibility: 0,
		deviceClass,
		vrMovementMode: 1,
		platform: 0,
		appVersion: GAME_VERSION,
	})
}

/** The Bearer token's account id (`sub`), or null when there's no valid token. */
async function authedId(c: Context<App>): Promise<number | null> {
	return validateAndGetAccountId(c.req.raw, await c.env.JWT_SECRET.get())
}

/**
 * The role names beyond `gameClient` for an account's token `role` claim. Base roles
 * (gameClient) are added by generateToken. `screenshare` rides on EVERY token — the
 * client gates the screen-share feature on it and nothing grants it per-account, so it
 * is unconditional (even with no account resolved). The rest are the operator-granted
 * extras, plus `junior` off the account's own `isJunior` flag. Order is stable so
 * tokens are deterministic.
 */
function accountRoles(
	account: Pick<Account, 'isDeveloper' | 'isModerator' | 'isJunior'> | null
): string[] {
	const roles = ['screenshare']
	if (!account) return roles
	if (account.isDeveloper) roles.push('developer')
	if (account.isModerator) roles.push('moderator')
	if (account.isJunior) roles.push('junior')
	return roles
}

/**
 * The account's token `rn.privilege` claim. Despite the scope-shaped name it is a CLAIM,
 * read out of the same claims dictionary as `role` — it never belongs in `scope`. The
 * client knows exactly two values, both chat restrictions, and both ride on a junior
 * account: `BanVChat` (voice) and `BanRmChat` (room chat). Empty for everyone else, which
 * drops the claim rather than sending a blank one.
 */
function accountPrivileges(account: Pick<Account, 'isJunior'> | null): string[] {
	return account?.isJunior ? ['BanVChat', 'BanRmChat'] : []
}

/**
 * The platform an account's `platformId` belongs to. Nothing defaults the `platform`
 * field (see defaultAccount), so an account can carry a platform identity with no
 * platform recorded — and until Meta verification landed Steam was the only identity
 * we could prove, so an unset one *is* Steam. Every account bound since records its
 * platform explicitly; this default only covers those older rows.
 */
function accountPlatform(account: Pick<Account, 'platform'>): number {
	return account.platform ?? 0
}

/**
 * Project a linked account into the client's CachedLogin DTO — the account-picker
 * entry on the login screen. The client posts the chosen `accountId` back as a
 * `grant_type=cached_login`. `requirePassword` is false because platform ownership
 * (the verified `platform_auth`) is the credential for a cached login — no prompt.
 *
 * The platform and id come from the LINK, not from the account: an account linked to
 * both a Steam and a Meta identity appears in both pickers, and each has to report the
 * identity that picker was asked about — that's what the client posts back, and what
 * the grant then checks the link against.
 */
function toCachedLogin(account: Account, link: PlatformLink) {
	return {
		platform: link.platform,
		platformId: link.platformId,
		accountId: account.accountId,
		lastLoginTime: account.lastLoginTime ?? account.createdAt,
		requirePassword: false,
	}
}

/**
 * Project a set of links into picker entries, dropping any whose account no longer
 * exists. One batched account read rather than one per link.
 *
 * Order follows the links (oldest first), so the picker is stable between launches.
 */
async function toCachedLogins(db: D1Database, links: PlatformLink[]) {
	if (links.length === 0) return []
	const accounts = await getAccountsByIds(db, [...new Set(links.map((l) => l.accountId))])
	const byId = new Map(accounts.map((a) => [a.accountId, a]))
	return links.flatMap((link) => {
		const account = byId.get(link.accountId)
		return account ? [toCachedLogin(account, link)] : []
	})
}

/**
 * Link the platform identity a password login proved to the account it logged into,
 * so the next launch on that device is a cached login. Called only with a VERIFIED
 * identity — a link is a password-free way into the account.
 *
 * Already linked is the common case (every subsequent login on that device) and costs
 * one read and nothing else.
 *
 * The per-identity cap applies here as well as at signup, or it wouldn't be a cap:
 * an identity could otherwise sit at the limit, have accounts created for it with a
 * password, and link its way into all of them. Reaching it does NOT fail the login —
 * the password was valid — it just leaves the account without a cached login, so the
 * player types their password each time rather than being locked out.
 *
 * The first identity linked also becomes the account's primary (the blob's
 * `platform`/`platformId`), which is what the account DTO and the refresh grant's
 * claims report. Later platforms link without disturbing it.
 */
async function linkLoginIdentity(
	db: D1Database,
	accountId: number,
	platform: number,
	platformId: string,
	maxAccountsPerIdentity: number
): Promise<void> {
	if (await isPlatformIdentityLinked(db, accountId, platform, platformId)) return

	if (
		maxAccountsPerIdentity > 0 &&
		(await countAccountsForPlatformIdentity(db, platform, platformId)) >= maxAccountsPerIdentity
	) {
		logger.info('platform link refused: account limit reached for this platform identity', {
			accountId,
			platform,
			platformId,
		})
		return
	}

	if (!(await linkPlatformIdentity(db, accountId, platform, platformId))) return
	logger.info('linked platform identity to account', { accountId, platform, platformId })

	const account = await getAccount(db, accountId)
	if (account && !account.platformId) {
		await updateAccount(db, accountId, { platform, platformId })
	}
}

/**
 * What a login's `platform_auth` proved, if anything. Failures are split because the
 * callers act on them differently: a grant that authenticates BY platform identity has
 * to refuse, while a password grant — which has already proven who it is — carries on
 * and just doesn't link.
 *
 * `unconfigured` is an operator problem (no META_APP_SECRET), not a bad credential,
 * and is the one case that warrants a 5xx.
 */
type PlatformProof =
	/** Nothing was checked — the login offered no proof, so there is nothing to report. */
	| { status: 'none' }
	| { status: 'verified'; platform: number; platformId: string }
	| { status: 'unsupported' }
	| { status: 'unconfigured' }
	| { status: 'rejected'; reason: string }

/**
 * Verify a login's `platform_auth` and return the identity it proves.
 *
 * The two verifiable platforms prove the id in opposite directions, which is why they
 * can't share a code path: Steam's ticket *carries* a SteamID64 we read out and trust,
 * so the posted `platform_id` is discarded. Meta's nonce carries nothing — it is
 * validated *against* the posted `platform_id`, so that field is an input, and a
 * spoofed one fails validation rather than being ignored. Either way the id that comes
 * back is proven, never the raw client-supplied field, and only a proven id is ever
 * written to an account or linked to one.
 */
async function verifyPlatformProof(
	env: App['Bindings'],
	platform: number,
	platformAuth: string,
	postedPlatformId: string
): Promise<PlatformProof> {
	// A sideloaded APK reports the placeholder id (see SIDELOAD_PLATFORM_ID) because it
	// has no Meta SDK behind it. Refuse it here, before anything is asked of Meta, so no
	// caller downstream can treat it as an identity — above all `linkLoginIdentity` on the
	// password grant, which is the path such a client actually takes. Linking it would
	// hand every sideloaded headset a password-free login into that account, since they
	// all report this same id.
	//
	// Refusing costs a sideloaded player nothing: their password login still succeeds (a
	// password grant carries its own credential and only *links* on a verified proof), it
	// just never gets a cached login, so they type their password each launch. That is
	// the intended shape of the sideload flow.
	if (platform === PlatformType.Oculus && postedPlatformId === SIDELOAD_PLATFORM_ID) {
		return { status: 'rejected', reason: 'sideload placeholder platform id is never an identity' }
	}
	if (platform === PlatformType.Steam) {
		const verified = platformAuth ? await verifySteamTicket(platformAuth) : null
		if (!verified) return { status: 'rejected', reason: 'invalid or missing Steam ticket' }
		return { status: 'verified', platform: PlatformType.Steam, platformId: verified.steamId }
	}
	if (platform === PlatformType.Oculus) {
		// `.get()` throws when the secret doesn't exist in the store at all (as opposed to
		// holding an empty/placeholder value) — the same misconfiguration from the player's
		// side, so it takes the same branch.
		const appSecret = await env.META_APP_SECRET.get().catch(() => '')
		if (appSecret === '') return { status: 'unconfigured' }
		const verified = await verifyMetaNonce(platformAuth, postedPlatformId, appSecret)
		if (!verified.ok) return { status: 'rejected', reason: verified.reason }
		return {
			status: 'verified',
			platform: PlatformType.Oculus,
			platformId: verified.identity.userId,
		}
	}
	return { status: 'unsupported' }
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

	// The website (`www`) is a browser origin calling these endpoints directly, the way
	// rec.net's own site called the game's API — so the responses need CORS headers or
	// the browser discards them. `origin: '*'` is deliberate and safe HERE because these
	// endpoints authenticate with a bearer token in the `Authorization` header, never a
	// cookie: a hostile page can't read another origin's stored token, so there is no
	// ambient credential for `*` to expose. Do not add cookie auth without narrowing it.
	.use('*', withDefaultCors())

	.onError(withOnError())
	.notFound(withNotFound())

	// EAC challenge — a fresh GUID, JSON-quoted, served as plain text.
	.get(
		'/eac/challenge',
		describeRoute({
			tags: ['EAC'],
			summary: 'Easy Anti-Cheat challenge',
			description:
				'Returns a constant JSON-quoted string (`"AA=="`) as `text/plain`. Anti-cheat is not implemented; this exists so the client\'s EAC handshake succeeds.',
			responses: {
				200: {
					description: 'The challenge, JSON-quoted, as text/plain',
					content: { 'text/plain': { schema: { type: 'string', example: '"AA=="' } } },
				},
			},
		}),
		(c) => c.text(`"AA=="`)
	)

	// Cached logins for a platform id — the accounts linked to this platform-native
	// id, so the client can offer them on the login screen (and post one back as a
	// cached_login grant). No linked account → [], and the client falls back to a
	// fresh login / create_account.
	//
	// GET or POST: the 2023 build asks with a GET, the 2025 build (20250424.01) POSTs
	// the same path with a form body — `deviceId`, `platformAuth` (a JSON blob holding
	// the platform's session ticket and app id) and `time`. The body is READ BY NOTHING
	// here; both methods answer the same list off the path params, so a newer client
	// gets its picker. Verifying that ticket is the eventual point of the POST.
	.on(
		['GET', 'POST'],
		'/cachedlogin/forplatformid/:platform/:id',
		describeRoute({
			tags: ['Cached login'],
			summary: 'Accounts linked to a platform id',
			description: [
				'Accounts the client may offer on its login screen for this platform identity —',
				'the links this identity has, so an entry here is always redeemable by a',
				'`cached_login` grant (both read the same table). An account linked to several',
				'platforms appears in each of their pickers. An unknown id yields `[]` (not a 404)',
				'and the client falls back to a fresh login or create_account.',
				'EXCEPT the exact identity `1/1` (Oculus, id `1`), which is stubbed for SIDELOADED',
				'APKs: with no Meta SDK they have no real identity to ask about and stall on an',
				'empty picker. It consults nothing and returns one canned, non-redeemable entry',
				'with `requirePassword: true`, sending the build to username/password login.',
				'Older clients GET this; the 20250424.01 build POSTs it with a',
				'`deviceId` / `platformAuth` / `time` form body attesting the platform session.',
				'That body is accepted and ignored — both methods answer identically from the',
				'path params.',
			].join(' '),
			parameters: [
				{
					name: 'platform',
					in: 'path',
					required: true,
					description: 'PlatformType integer. A non-numeric value matches the id on any platform.',
					schema: { type: 'string' },
				},
				{
					name: 'id',
					in: 'path',
					required: true,
					description: 'Platform-native id — a SteamID64 for Steam, a user id for Meta.',
					schema: { type: 'string' },
				},
			],
			responses: {
				200: json(
					CachedLogin.or(FakeCachedLogin).array(),
					'Matching accounts; `[]` if none. The canned entry for `1/1`.'
				),
			},
		}),
		async (c) => {
			const { platform, id } = c.req.param()
			logger.info('cached login lookup', { platform, id })
			const platformInt = Number.parseInt(platform, 10)
			// SIDELOADED APKs ONLY. A sideloaded build has no Meta SDK behind it, so it can't
			// produce a real Meta identity or a nonce to prove one with — it asks about the
			// placeholder identity `1/1`, and an empty picker leaves it stuck on the platform
			// login screen with nothing to do. Hand back one canned entry to push it onto the
			// username/password login instead, which is the only flow such a build can finish.
			// `requirePassword` is true for exactly that reason: there's no platform proof here,
			// and the `cached_login` grant would (correctly) refuse this entry.
			//
			// Scoped to that ONE identity rather than to all of platform 1 — store builds do
			// real Meta logins, and shadowing the whole platform would hide genuine links from
			// their pickers.
			if (platformInt === PlatformType.Oculus && id === SIDELOAD_PLATFORM_ID) {
				return c.json([FAKE_OCULUS_CACHED_LOGIN])
			}
			// Listed straight from the link table, which is also what the `cached_login`
			// grant authorizes against — so the picker can't offer an account the grant
			// then refuses.
			const links = Number.isNaN(platformInt)
				? await getLinksForPlatformId(c.env.DB, id)
				: await getLinksForPlatformIdentity(c.env.DB, platformInt, id)
			return c.json(await toCachedLogins(c.env.DB, links))
		}
	)

	// Bulk cached-login lookup by platform id (friends resolution). The client POSTs
	// repeated `id=` params on the auth host; resolve each to its linked accounts.
	.post(
		'/cachedlogin/forplatformids',
		describeRoute({
			tags: ['Cached login'],
			summary: 'Bulk cached-login lookup (friends resolution)',
			description: [
				'Resolves many platform ids at once. Results are flattened across all ids, so the',
				'response cannot be mapped back to a specific input id — the client uses each',
				'entry’s own `platformId`. No platform accompanies these ids, so each matches on',
				'any platform. Unknown ids contribute nothing; a body with no `id` yields `[]`.',
			].join(' '),
			requestBody: form(PlatformIdsRequest, 'Repeated `id=` form fields'),
			responses: { 200: json(CachedLogin.array(), 'Flattened accounts across every id') },
		}),
		async (c) => {
			const body = await c.req.parseBody({ all: true }).catch(() => ({}) as Record<string, unknown>)
			const raw = body.id
			const ids = (Array.isArray(raw) ? raw : raw != null ? [raw] : []).map(String)
			const out: Array<ReturnType<typeof toCachedLogin>> = []
			for (const pid of ids) {
				// No platform accompanies these ids, so they match on any platform.
				out.push(...(await toCachedLogins(c.env.DB, await getLinksForPlatformId(c.env.DB, pid))))
			}
			return c.json(out)
		}
	)

	// OAuth token endpoint — accepts a form-urlencoded body and issues a JWT.
	.post(
		'/connect/token',
		describeRoute({
			tags: ['Token'],
			summary: 'OAuth token endpoint — issues a JWT',
			description: [
				'Issues an access token (plus a single-use refresh token) for one of four grants,',
				'selected by `grant_type`. Every grant returns the same body on success.',
				'',
				'**`create_account`** — mints a new account with an auto-assigned random username',
				'(players do not pick one initially) and places it in the Orientation room. A posted',
				'`password` becomes the login credential. Subject to two independent signup caps,',
				'per verified platform id and per signup IP (`MAX_ACCOUNTS_PER_PLATFORM_ID` /',
				'`MAX_ACCOUNTS_PER_IP`; either disabled by setting it to 0). If it asserts a',
				'`platform`, that platform must be verifiable (Steam or Meta) and its `platform_auth`',
				'must verify.',
				'',
				'**`cached_login`** — logs into an already-linked account using platform ownership as',
				'the credential; no password. Requires a verifying `platform_auth`, and the posted',
				'`account_id` must be LINKED to exactly the identity it proves. An account with no',
				'link for that identity cannot be cached-logged-into.',
				'',
				'**`refresh_token`** — redeems a stored single-use refresh token, rotating it. The',
				'platform and platform id come from what was stored at issue time, not the body.',
				'',
				'**`password`** (the fallback for any unrecognised or absent `grant_type`) —',
				'identifies the account by `username` or numeric `account_id` and requires the',
				'matching `password`. An account with no stored hash cannot be logged into at all,',
				'which is what closes id/username-only takeover. When it also posts a `platform_auth`',
				'that verifies, that identity is LINKED to the account — this is how a player who',
				'signed up on one platform gets a cached login on a second device. The login is',
				'never failed over the link: an unverifiable proof (or one over the per-identity',
				'cap) just leaves the account without a cached login there.',
				'',
				'**Platform identity.** An account can be reached from several platform identities;',
				'the links are the one thing both the picker and `cached_login` consult, and only a',
				'VERIFIED identity is ever linked. Two platforms can be verified. Steam (`0`) posts a',
				'Steam-signed `platform_auth` ticket, checked offline; the SteamID64 it carries',
				'replaces the client-supplied `platform_id`. Meta/Oculus (`1`) posts `platform_auth`',
				'as `{"Nonce":…,"AppId":…}`, which recflare sends to Meta together with the posted',
				'`platform_id` — validation is what binds the nonce to that user id, so a spoofed id',
				'fails. Meta logins therefore need the app secret (`META_APP_SECRET`) and answer 500',
				'when it is unset. The first identity linked also becomes the account’s primary',
				'(what the account DTO and a refreshed token report); later ones only link.',
				'',
				'The one platform id that is never verified and never linked is `1` on platform `1`',
				'— what a SIDELOADED Oculus APK reports, having no Meta SDK to ask. Every such',
				'build reports it, so it identifies nobody. A password login that carries it still',
				'succeeds; it simply links nothing, and the player types their password each launch.',
				'',
				'**Roles.** The token embeds a `role` claim from the account, so developer/moderator',
				'powers refresh on every login and every refresh grant. `junior` rides along for an',
				'account flagged `isJunior`, and `screenshare` is on every token — it is a feature',
				'gate the client reads, not a privilege anyone is granted. A junior also carries',
				'the `rn.privilege` CLAIM (`BanVChat`, `BanRmChat`) — scope-shaped name, but the',
				'client reads it as a claim beside `role`, and it is absent for everyone else.',
				'',
				'**Bans.** Once the grant has resolved an account, a BANNED account is refused a',
				'token at all (`invalid_grant`) — every grant, including a refresh. A ban is a',
				'`report` row with `banned` set (the `api` worker owns that table); it lifts on its',
				'own when `ban_expires` passes, and never if that is null.',
				'',
				'The refusal follows the player, not just the account: it also catches an account',
				'that shares a PROVEN platform identity (a `platform_account` link) or an IP',
				'(`signupIp`/`lastLoginIp`, or the address this request came from) with a banned',
				'one, and a `create_account` carrying either is refused BEFORE it mints anything.',
				'Those two arms are the operator’s `BAN_EVASION_MATCH` knob (`ip`, `platform`, or',
				'`off`); the ban on the account itself is always enforced. A linked match answers a',
				'deliberately vaguer description than a direct one — the account refused may belong',
				'to a housemate of the banned player rather than to them.',
			].join('\n'),
			requestBody: form(
				TokenRequest,
				'Union of all grants; see the description for per-grant requirements'
			),
			responses: {
				200: json(TokenResponse, 'Access token, refresh token and granted scopes'),
				400: json(
					OAuthError,
					[
						'Unusable grant: bad credentials, an unverifiable platform or platform_auth, an',
						'invalid/expired refresh token, a missing account identifier, a signup cap reached,',
						'or a banned account',
					].join(' ')
				),
				500: json(
					OAuthError,
					[
						'The server is missing a secret it cannot proceed without: JWT_SECRET (a token is',
						'refused rather than signed with an empty key) or, on a Meta login, META_APP_SECRET',
						'(no nonce can be validated without it).',
					].join(' ')
				),
			},
		}),
		async (c) => {
			// Reads `grant_type`, `account_id`, `platform_id` and `platform` from the
			// form body.
			const body = await c.req.parseBody().catch(() => ({}) as Record<string, unknown>)
			const grantType = typeof body.grant_type === 'string' ? body.grant_type : ''
			// `platform`/`platform_id` come from the body for a fresh login; a refresh
			// grant overrides them below with what was stored when the token was issued.
			let platformId = typeof body.platform_id === 'string' ? body.platform_id : ''
			const platformInt =
				typeof body.platform === 'string' ? Number.parseInt(body.platform, 10) : NaN
			// The token's `platform` claim is the PlatformType int. A grant that asserts no
			// platform (a password login) falls back to Steam/0, the same default the account
			// itself carries — see `accountPlatform`.
			let platform = Number.isNaN(platformInt) ? PlatformType.Steam : platformInt

			// The device this login came from. The client posts both on every grant; they're
			// unverified (client-picked) so they're recorded on the account, never trusted as
			// a credential. Stored on account creation AND refreshed on each successful login,
			// so the account's device tracks the player across devices — the raw material for
			// linking accounts that share a device later.
			const deviceId = typeof body.device_id === 'string' ? body.device_id : ''
			const deviceClassInt =
				typeof body.device_class === 'string' ? Number.parseInt(body.device_class, 10) : NaN
			const deviceClass = Number.isNaN(deviceClassInt) ? 0 : deviceClassInt

			// The client's own build (`ver`, e.g. `20250718.01`), stamped into the token's
			// `rn.ver` claim so everything downstream reports the build the player is ACTUALLY
			// running rather than this server's GAME_VERSION — `match` reads it back off the
			// token when it writes presence. Unverified like the device fields, and only ever
			// echoed, never trusted for a decision (the version CHECK is `api`'s
			// `/api/versioncheck/v4`, against its own list).
			//
			// A grant that posts none — a refresh, or a caller that isn't the game — leaves it
			// undefined and generateToken falls back to GAME_VERSION. An empty string is
			// treated as absent for the same reason: presence must never carry an empty
			// version, which breaks the client's handling of it.
			const version = typeof body.ver === 'string' && body.ver !== '' ? body.ver : undefined

			// The client's real IP, per Cloudflare (the client can't spoof CF-Connecting-IP —
			// the edge sets it — unlike X-Forwarded-For, which is why we don't read that).
			// Recorded as the immutable `signupIp` at creation and as `lastLoginIp` on every
			// login; both feed the per-IP signup cap. Absent (empty) outside the CF edge.
			const clientIp = c.req.header('cf-connecting-ip') ?? ''

			// A platform-authenticated login proves who you are with the platform itself, and
			// we can verify exactly two: Steam (0), from its Steam-signed platform_auth ticket,
			// and Meta/Oculus (1), by asking Meta to validate the nonce in platform_auth (see
			// verifyPlatformProof). Only a verified identity is ever bound or linked.
			//
			// Two grants are GATED on it — they have no other credential, so an unverifiable
			// platform is fatal:
			//   - cached_login authenticates purely by platform identity.
			//   - create_account that asserts a platform: we won't bind an identity we can't
			//     prove. (create_account with NO platform is the password-account path —
			//     allowed, but binds no platformId.)
			//
			// A password grant is NOT gated: the password already proved who it is. It posts
			// its platform proof too, and if that verifies we LINK the identity to the account
			// (see below), which is how a player who created an account on Steam gets a cached
			// login on their headset. If it doesn't verify, the login still succeeds — it just
			// links nothing, because a link is a password-free way into the account and must
			// never rest on an unproven id.
			const platformAuth = typeof body.platform_auth === 'string' ? body.platform_auth : ''
			const platformAsserted = !Number.isNaN(platformInt)
			const gatedOnPlatform =
				grantType === 'cached_login' || (grantType === 'create_account' && platformAsserted)
			// The password grant only spends a verification when the client actually offered
			// one; the rest of the time there is nothing to link.
			const proof: PlatformProof =
				gatedOnPlatform || (platformAsserted && platformAuth !== '')
					? await verifyPlatformProof(c.env, platformInt, platformAuth, platformId)
					: { status: 'none' }

			let verifiedPlatformId: string | null = null
			let verifiedPlatform: number | null = null
			if (proof.status === 'verified') {
				verifiedPlatform = proof.platform
				verifiedPlatformId = proof.platformId
			} else if (proof.status !== 'none') {
				// Log every failure, including the ones a password grant shrugs off: a player
				// who silently never gets a cached login on their headset has no other symptom,
				// and this line is where "Meta rejected the nonce" becomes visible.
				logger.info('platform_auth not verified', {
					platform: platformInt,
					platformId,
					grantType,
					status: proof.status,
					reason: proof.status === 'rejected' ? proof.reason : undefined,
				})
			}

			if (gatedOnPlatform && proof.status !== 'verified') {
				if (proof.status === 'unsupported') {
					return c.json(
						{
							error: 'invalid_grant',
							error_description: 'unsupported platform; only Steam and Meta can be verified',
						},
						400
					)
				}
				if (proof.status === 'unconfigured') {
					// An operator misconfiguration, not the client's fault: without the app secret
					// every Meta player is locked out, so it answers 500 the way an unset
					// JWT_SECRET does below rather than blaming the credential. (We never fall
					// back to trusting the posted id — that would let anyone log into any
					// Meta-linked account by naming its user id.)
					logger.error('refusing a Meta login: META_APP_SECRET is empty')
					return c.json(
						{
							error: 'server_error',
							error_description: 'Meta platform verification is not configured',
						},
						500
					)
				}
				// The reason is for the operator; the client is told only that it was rejected.
				// A wrong app secret and a stale nonce look identical from the client side.
				return c.json(
					{ error: 'invalid_grant', error_description: 'invalid or missing platform_auth' },
					400
				)
			}

			// From here on `platformId` is the PROVEN identity wherever there is one — the
			// SteamID64 out of the ticket or the Meta user id the nonce validated against,
			// never the raw client-supplied field.
			if (verifiedPlatformId !== null) platformId = verifiedPlatformId

			// Resolve the account this token is for:
			//  - create_account: mint + persist a brand-new account (auto-assigned random
			//    username — players don't pick one initially); the token's `sub` is its id.
			//    A `password` may be posted to establish the account's login credential.
			//  - refresh_token: redeem a stored (single-use) refresh token for its account +
			//    platform, so an expiring session renews without re-login.
			//  - otherwise: a credential login. The request identifies the account by
			//    `username` (RecRoom's password grant posts the username, not the id) or a
			//    numeric `account_id`, and MUST post the account's correct `password`. An
			//    account with no password set can't be logged into (no credential to verify)
			//    — closing the id/username-only takeover. New accounts establish a password
			//    via create_account or /account/me/changepassword.
			let accountId: string
			if (grantType === 'create_account') {
				// A banned player's next move is a new account, so the ban is checked BEFORE
				// one is minted — against the only identity a signup has, the IP it came from
				// and the platform identity it just proved. Refusing after the fact (as the
				// shared check below would) still refuses the token, but leaves the account
				// row behind and burns a slot off both signup caps, so the evader gets to keep
				// making them.
				//
				// Nothing here can match the account arm (there is no account yet), so this is
				// purely the linked matching, and BAN_EVASION_MATCH=off leaves signup open —
				// which is the honest default position: a server that won't accept the IP arm's
				// false positives is choosing to let evaders re-register.
				const blocked = await resolveBan(c.env.DB, null, {
					identity: {
						ip: clientIp,
						platform: verifiedPlatform,
						platformId: verifiedPlatformId,
					},
					arms: banEvasionMatch(c.env.BAN_EVASION_MATCH),
				})
				if (blocked) {
					logger.info('signup refused: player banned', {
						via: blocked.via,
						bannedAccountId: blocked.bannedAccountId,
						ip: clientIp,
						platformId: verifiedPlatformId,
					})
					return c.json({ error: 'invalid_grant', error_description: BLOCKED_DESCRIPTION }, 400)
				}

				// Signup caps. Checked before minting anything, so a rejected signup leaves no
				// account behind. Each arm is skipped when it's disabled (var <= 0) or when its
				// identity is unknown (no verified platform id / no client IP) — an unattributable
				// signup can't be counted against anyone, and lumping them together would lock out
				// real players. The disabled check comes first so a disabled arm costs no D1 read.
				const maxPerPlatformId = intVar(
					c.env.MAX_ACCOUNTS_PER_PLATFORM_ID,
					DEFAULT_MAX_ACCOUNTS_PER_PLATFORM_ID
				)
				const maxPerIp = intVar(c.env.MAX_ACCOUNTS_PER_IP, DEFAULT_MAX_ACCOUNTS_PER_IP)
				if (
					maxPerPlatformId > 0 &&
					verifiedPlatformId !== null &&
					(await countAccountsForPlatformIdentity(
						c.env.DB,
						verifiedPlatform ?? 0,
						verifiedPlatformId
					)) >= maxPerPlatformId
				) {
					logger.info('signup rejected: platform account limit', {
						platformId: verifiedPlatformId,
					})
					return c.json(
						{
							error: 'invalid_grant',
							error_description: 'account limit reached for this platform account',
						},
						400
					)
				}
				if (
					maxPerIp > 0 &&
					clientIp !== '' &&
					(await countAccountsBySignupIp(c.env.DB, clientIp)) >= maxPerIp
				) {
					logger.info('signup rejected: per-IP account limit', { ip: clientIp })
					return c.json(
						{
							error: 'invalid_grant',
							error_description: 'too many accounts created from this network',
						},
						400
					)
				}

				// Bind the platform identity ONLY when the platform proved it (a Steam ticket or
				// a Meta-validated nonce). A password/anonymous create_account (no platform)
				// binds nothing. The account blob keeps this first identity as its PRIMARY one
				// (for the account DTO and the refresh grant's claims); the link written just
				// below is what a later cached login is actually authorized against.
				const account = await createAccount(c.env.DB, {
					platforms: platformInt || 0,
					platform: verifiedPlatform ?? undefined,
					platformId: verifiedPlatformId ?? undefined,
					lastLoginTime: new Date().toISOString(),
					deviceId: deviceId || undefined,
					deviceClass: deviceId ? deviceClass : undefined,
					signupIp: clientIp || undefined,
					lastLoginIp: clientIp || undefined,
				})
				accountId = String(account.accountId)
				if (verifiedPlatformId !== null) {
					await linkPlatformIdentity(
						c.env.DB,
						account.accountId,
						verifiedPlatform ?? 0,
						verifiedPlatformId
					)
				}
				// Establish the login password when one is posted (raw password never stored).
				const password = typeof body.password === 'string' ? body.password : ''
				if (password !== '') {
					await setPasswordHash(c.env.DB, account.accountId, await hashPassword(password))
				}
				// Place the new player in Orientation (they don't explicitly matchmake into it).
				await placeNewPlayerInOrientation(c.env, account.accountId, deviceClass)
			} else if (grantType === 'refresh_token') {
				const presented = typeof body.refresh_token === 'string' ? body.refresh_token : ''
				const refreshed = presented ? await consumeRefreshToken(c.env.DB, presented) : null
				if (!refreshed) {
					return c.json(
						{ error: 'invalid_grant', error_description: 'refresh_token is invalid or expired' },
						400
					)
				}
				// `platform`/`platform_id` aren't stored with the token — they're taken from
				// the account below, so a refreshed token always reflects the identity the
				// account is bound to now.
				accountId = String(refreshed)
			} else if (grantType === 'cached_login') {
				// Platform-authenticated login into an already-linked account. The client posts
				// the `account_id` it got from /cachedlogin/forplatformid together with the
				// `platform_id` its platform_auth vouches for. Authorize ONLY when the link
				// table says that account is linked to exactly this platform identity — this is
				// the check that keeps anyone but that platform user out of the account
				// (platform ownership is the credential; no password needed). An account with no
				// link for the presented identity must use a password.
				//
				// The picker lists straight from the same table, so it can only offer accounts
				// this check accepts.
				//
				// NB: `platform_id` here is the verified identity set above — the SteamID64 from
				// the ticket, or the Meta user id the nonce validated against — never the raw
				// client-supplied field. See steam-ticket.ts and meta-nonce.ts.
				//
				const postedId = typeof body.account_id === 'string' ? body.account_id.trim() : ''
				const account = /^\d+$/.test(postedId) ? await getAccount(c.env.DB, Number(postedId)) : null
				const linked =
					account !== null &&
					(await isPlatformIdentityLinked(c.env.DB, account.accountId, platformInt, platformId))
				if (!account || !linked) {
					return c.json(
						{
							error: 'invalid_grant',
							error_description: 'no linked account for this platform identity',
						},
						400
					)
				}
				accountId = String(account.accountId)
				await setLastLoginTime(c.env.DB, account.accountId, new Date().toISOString())
				await setLoginContext(c.env.DB, account.accountId, { deviceId, deviceClass, ip: clientIp })
			} else {
				// Resolve the account from a posted numeric `account_id` or, as RecRoom's
				// password grant sends, a `username` (case-insensitive; trailing whitespace
				// is trimmed off the posted value).
				const postedId = typeof body.account_id === 'string' ? body.account_id.trim() : ''
				const postedUsername = typeof body.username === 'string' ? body.username.trim() : ''
				let resolvedId: number | null = null
				if (/^\d+$/.test(postedId)) {
					resolvedId = Number(postedId)
				} else if (postedUsername !== '') {
					resolvedId = (await getAccountByUsername(c.env.DB, postedUsername))?.accountId ?? null
				}
				if (resolvedId === null) {
					return c.json(
						{ error: 'invalid_request', error_description: 'account_id or username is required' },
						400
					)
				}
				// The account's password MUST be presented and match. An account with no
				// stored hash has no credential to authenticate against, so login is refused
				// — this closes the id/username-only takeover.
				const storedHash = await getPasswordHash(c.env.DB, resolvedId)
				const password = typeof body.password === 'string' ? body.password : ''
				if (!storedHash || !(await verifyPassword(password, storedHash))) {
					return c.json(
						{ error: 'invalid_grant', error_description: 'invalid account_id or password' },
						400
					)
				}
				accountId = String(resolvedId)
				// The password proved the account; the platform proof (when the client sent one
				// and it verified) proves the device's platform identity. Linking the two is
				// what gives a player who signed up on Steam a cached login on their headset —
				// they type their password once there, and never again.
				if (verifiedPlatformId !== null) {
					await linkLoginIdentity(
						c.env.DB,
						resolvedId,
						verifiedPlatform ?? 0,
						verifiedPlatformId,
						intVar(c.env.MAX_ACCOUNTS_PER_PLATFORM_ID, DEFAULT_MAX_ACCOUNTS_PER_PLATFORM_ID)
					)
				}
				await setLastLoginTime(c.env.DB, resolvedId, new Date().toISOString())
				await setLoginContext(c.env.DB, resolvedId, { deviceId, deviceClass, ip: clientIp })
			}

			// A banned player gets no token — and with no token every other worker is shut to
			// them, so this is the outer wall of a ban; matchmaking's refusal is the inner
			// one, which still has to exist because a token issued before the ban stays valid
			// until it expires.
			//
			// Checked once here, after the grant has resolved an account, so it covers every
			// grant: password, cached_login and a refresh_token redeemed by a client that has
			// been running since before the ban. Deliberately AFTER the credential checks —
			// a wrong password is still "invalid account_id or password", so this can't be
			// used to probe whether an account exists or is banned without knowing it.
			//
			// The request's own IP and proven identity are passed alongside the account, so a
			// ban also reaches an old, clean account logged into from the banned player's
			// device or network — the stored ips alone would only catch that on the SECOND
			// login. create_account was already refused before it minted anything (above);
			// this still runs for it, so a signup that raced one is refused too.
			const ban = await resolveBan(c.env.DB, Number(accountId), {
				identity: { ip: clientIp, platform: verifiedPlatform, platformId: verifiedPlatformId },
				arms: banEvasionMatch(c.env.BAN_EVASION_MATCH),
			})
			if (ban) {
				logger.info('token refused: player banned', {
					accountId,
					grantType,
					via: ban.via,
					bannedAccountId: ban.bannedAccountId,
					reportId: ban.ban.id,
					banExpires: ban.ban.ban_expires,
				})
				return c.json(
					{
						error: 'invalid_grant',
						error_description: ban.via === 'account' ? BANNED_DESCRIPTION : BLOCKED_DESCRIPTION,
					},
					400
				)
			}

			// Never sign with an empty key. An empty JWT_SECRET (misconfigured/missing
			// binding) would still yield a well-formed token — but one signed with an empty
			// key, which every worker validates against, so anyone could forge it. Refuse to
			// issue a token at all rather than complete the login with a forgeable credential.
			const jwtSecret = await c.env.JWT_SECRET.get()
			if (jwtSecret === '') {
				logger.error('refusing to issue token: JWT_SECRET is empty')
				return c.json(
					{ error: 'server_error', error_description: 'token signing is not configured' },
					500
				)
			}

			// Stamp the account's elevated roles into the token's `role` claim so the client
			// authorizes developer/moderator powers from the token itself (not just the
			// /role/* lookups), and its Plus flag into `rn.plus`. One read of the just-resolved
			// account serves both; they thus refresh on every login and every refresh_token
			// grant.
			const roleAccount = await getAccount(c.env.DB, Number(accountId))
			// A refresh grant posts no platform of its own, so the identity comes off the
			// account — the same read, and the only place the bound identity is authoritative.
			if (grantType === 'refresh_token' && roleAccount) {
				platform = accountPlatform(roleAccount)
				platformId = roleAccount.platformId ?? ''
			}
			const accessToken = await generateToken(
				accountId,
				platformId,
				platform,
				jwtSecret,
				accountRoles(roleAccount),
				accountPrivileges(roleAccount),
				version,
				// Rec Room Plus, off the same account read as the roles above — `econ` decides the
				// CampusCard and the subscriber discount from this claim alone, so it never has to
				// load the account. It therefore refreshes on every login and every refresh_token
				// grant, and only then: a player who claims Plus on the website keeps a token that
				// says otherwise until they sign in again.
				roleAccount?.hasPlus === true
			)
			// Issue a fresh, persisted refresh token (single-use; the client redeems it via
			// grant_type=refresh_token). A refresh grant thus rotates its token.
			const refreshToken = await issueRefreshToken(c.env.DB, Number(accountId))

			return c.json({
				access_token: accessToken,
				expires_in: TOKEN_TTL_SECONDS,
				token_type: 'Bearer',
				refresh_token: refreshToken,
				scope: TOKEN_SCOPE,
				// @kludge Why is this necessary? Who knows.
				key: '8oQ+e+WQaOBPbEcakhqs3dwZZdOmmyDUmJSD9u4AHMY=',
			})
		}
	)

	// Change the caller's password. Auth-gated. Stores a PBKDF2 hash on the account
	// row (the raw password is never persisted). When the account already has a
	// password, `oldPassword` must match; the first time it's set, `oldPassword` is
	// empty (as the client sends).
	.post(
		'/account/me/changepassword',
		describeRoute({
			tags: ['Account'],
			summary: "Change the caller's password",
			description: [
				'Stores a PBKDF2 hash on the account row; the raw password is never persisted.',
				'When the account already has a password, `oldPassword` must match. The first time',
				'a password is set, `oldPassword` is empty — which is what the client sends.',
			].join(' '),
			security: [{ bearerAuth: [] }],
			requestBody: form(ChangePasswordRequest, 'New password, plus the old one when one is set'),
			responses: {
				200: json(ChangePasswordResponse, 'Password changed'),
				400: json(ChangePasswordResponse, '`newPassword` was empty, or `oldPassword` was wrong'),
				401: { description: 'Missing or invalid bearer token (empty body)' },
				404: { description: 'The account no longer exists (empty body)' },
			},
		}),
		async (c) => {
			const id = await authedId(c)
			if (id === null) return c.body(null, 401)

			const body = await c.req.parseBody().catch(() => ({}) as Record<string, unknown>)
			const oldPassword = typeof body.oldPassword === 'string' ? body.oldPassword : ''
			const newPassword = typeof body.newPassword === 'string' ? body.newPassword : ''
			if (newPassword === '') {
				return c.json({ success: false, error: 'You must enter a new password.' }, 400)
			}

			const currentHash = await getPasswordHash(c.env.DB, id)
			if (currentHash && !(await verifyPassword(oldPassword, currentHash))) {
				return c.json({ success: false, error: 'Your old password is incorrect.' }, 400)
			}

			const ok = await setPasswordHash(c.env.DB, id, await hashPassword(newPassword))
			if (!ok) return c.body(null, 404)
			return c.json({ success: true })
		}
	)

	// The moderation restrictions on the caller's account — chat mutes and the like. STUB:
	// nothing here issues restrictions, so every caller is unrestricted and the list is
	// empty. An EMPTY ARRAY is the normal unrestricted answer, not null and not a 404: the
	// client clears and refills its list from this, and acts on a record simply being
	// present (plus its `EndDate`), so `[]` is a complete answer rather than a placeholder.
	//
	// When this is wired up, the display strings are free text — the client matches none of
	// them — so only `EndDate` and the record's presence need to be right. See
	// `RestrictionDto`.
	.get(
		'/privileges/me/restrictions',
		describeRoute({
			tags: ['Account'],
			summary: 'The caller’s moderation restrictions',
			description: [
				'The restrictions in force on the caller’s account (a chat mute, say), as a bare array.',
				'Always EMPTY here — nothing on this server issues restrictions — and an empty array is',
				'the normal unrestricted answer, not null. The client refills its list from this and',
				'acts on a record being present and its `EndDate`; the `Name`/`Description`/',
				'`DisplayReason` strings are display text it matches nothing against.',
			].join(' '),
			security: [{ bearerAuth: [] }],
			responses: {
				200: json(RestrictionDto.array(), 'The caller’s restrictions — always empty'),
				401: { description: 'Missing or invalid bearer token (empty body)' },
			},
		}),
		async (c) => {
			const id = await authedId(c)
			if (id === null) return c.body(null, 401)
			return c.json([])
		}
	)

	// Developer role lookup. Returns a bare JSON boolean (the client reads the body as
	// a bool), and 404s for an unknown player — mirroring the reference API. The role
	// is off by default and only an operator grants it (via `runx admin grant-developer`,
	// which sets the account's isDeveloper flag); it also rides in the token's `role`
	// claim (see accountRoles).
	.get('/role/developer/:id', describeRoute(roleLookup('developer')), async (c) => {
		const { id } = c.req.param()
		logger.info('developer role lookup', { id })
		const accountId = Number.parseInt(id, 10)
		const account = Number.isNaN(accountId) ? null : await getAccount(c.env.DB, accountId)
		if (!account) return c.body(null, 404)
		return c.json(account.isDeveloper === true)
	})

	// Moderator role lookup, mirroring developer (bare boolean, 404 for unknown player).
	// Operator-granted only (via `runx admin grant-moderator`); the flag also rides in
	// the token's `role` claim.
	.get('/role/moderator/:id', describeRoute(roleLookup('moderator')), async (c) => {
		const { id } = c.req.param()
		logger.info('moderator role lookup', { id })
		const accountId = Number.parseInt(id, 10)
		const account = Number.isNaN(accountId) ? null : await getAccount(c.env.DB, accountId)
		if (!account) return c.body(null, 404)
		return c.json(account.isModerator === true)
	})

	// @guess Oculus nonce. The client asks for this before a Meta login; the exact shape
	// it expects hasn't been observed, so this mints a fresh 64-char hex nonce (the length
	// Meta's own `GetUserProof` nonces have) and answers it as a bare JSON string. Nothing
	// is stored — Meta's nonce validation (meta-nonce.ts) is what actually proves a login,
	// so this value is not security-relevant to the server. Revisit once the client's use
	// of it is seen.
	.get(
		'/oculus/nonce',
		describeRoute({
			tags: ['Account'],
			summary: 'A fresh nonce for the Oculus login flow',
			description: [
				'Mints a random 64-char hex nonce and returns it as a bare JSON string. Not stored',
				'and not verified later — a best guess at the shape the client wants.',
			].join(' '),
			responses: { 200: json(z.string(), 'The nonce') },
		}),
		(c) => {
			const bytes = crypto.getRandomValues(new Uint8Array(32))
			const nonce = Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('')
			logger.info('oculus nonce issued')
			return c.json(nonce)
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
					title: 'recflare auth',
					version: '1.0.0',
					description: [
						'Authentication and token issuance for recflare, a private-server reimplementation',
						'of the Rec Room backend.',
					].join('\n'),
				},
				servers: [{ url: 'https://auth.recflare.net', description: 'Production' }],
				components: {
					securitySchemes: {
						bearerAuth: {
							type: 'http',
							scheme: 'bearer',
							bearerFormat: 'JWT',
							description: 'An `access_token` from `POST /connect/token`.',
						},
					},
				},
			},
		})
	)
)

export default app
