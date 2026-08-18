import { Hono } from 'hono'
import { describeRoute, openAPIRouteHandler } from 'hono-openapi'
import { useWorkersLogger } from 'workers-tagged-logger'

import {
	Accessibility,
	areFriends,
	banPlayerFromRoom,
	canManageRoom,
	cloneRoom,
	cloneSubRoom,
	countRoomsByCreator,
	createSubRoom,
	deleteRoom,
	deleteSubRoom,
	findSubRoom,
	getBaseRooms,
	getFavoritedRooms,
	getFeaturedRooms,
	getHotRooms,
	getInteraction,
	getOrCreateDormRoom,
	getPresence,
	getPublicRoomsByCreator,
	getRecommendedRooms,
	getRoomBans,
	getRoomById,
	getRoomByName,
	getRoomsByCreator,
	getRoomsByIds,
	getSimilarRooms,
	getSubRoomPermissions,
	getSubRoomSaveById,
	getSubRoomSaves,
	getVisitedRooms,
	modifySubRoom,
	publishSubRoomSave,
	removeCheer,
	removeFavorite,
	roomNameRejection,
	saveSubRoomData,
	searchRooms,
	setRoomDescription,
	setRoomImage,
	setRoomName,
	setRoomRole,
	setSubRoomPermissions,
	toggleCheer,
	toggleFavorite,
	toggleRoomTag,
	unbanPlayerFromRoom,
	updateRoomFields,
} from '@repo/domain'
import {
	intVar,
	logger,
	withCleanSpec,
	withDefaultCors,
	withNotFound,
	withOnError,
} from '@repo/hono-helpers'
import { validateAndGetAccountId, validateAndGetRoles } from '@repo/jwt'

// The notification-type ids the hub carries (owned by the `notify` worker). Imported
// as a value — the enum has no runtime dependencies.
import { NotificationType } from '../../notify/src/notification-types'
import {
	AccessibilityRequest,
	AUTHED,
	bannedPlayerIdParam,
	BanRequest,
	CloneRoomRequest,
	CloningRequest,
	CreateSubRoomRequest,
	DescriptionRequest,
	DormRoomId,
	FeaturedRoomGroupDto,
	FORBIDDEN_RESPONSE,
	form,
	ImageRequest,
	InteractionDto,
	json,
	jsonBody,
	LoadScreenRequest,
	MissingLookupParam,
	ModifySubRoomRequest,
	NameRequest,
	NOT_FRIENDS_RESPONSE,
	PagedRooms,
	pageParams,
	PhotonAccessTokenDto,
	PlayerDataDto,
	playerIdParam,
	PublishSaveRequest,
	PublishStateConfigsEnvelope,
	RestrictionsRequest,
	RoleRequest,
	RoomBanEntryDto,
	RoomBanEnvelope,
	RoomDto,
	RoomEnvelope,
	RoomExperiencePlayer,
	roomIdParam,
	RoomLookup,
	RoomResultEnvelope,
	RoomSaveEnvelope,
	saveIdParam,
	SaveSubRoomDataRequest,
	ServiceStatus,
	stringQuery,
	SubRoomAccessibilityRequest,
	SubRoomDataSaveResponseDto,
	subRoomIdParam,
	SubRoomPermissionsRequest,
	SubRoomSavesNoUnityAssetsPage,
	SubRoomSavesPage,
	TagRequest,
	UNAUTHORIZED_EMPTY,
	UNAUTHORIZED_ENVELOPE,
	UNAUTHORIZED_RESPONSE,
	WarningRequest,
} from './openapi'

import type { Context } from 'hono'
import type { RoomBan, RoomPermission } from '@repo/domain'
import type { App } from './context'

/**
 * Room server. Rooms are stored in D1 as JSON blobs with generated columns for
 * querying (see rooms-db.ts); the dorm (RoomId 1) is seeded by the migration.
 * Responses are the stored JSON verbatim (PascalCase, client-facing shape).
 *
 * The `rooms` prefix maps to this worker's subdomain, so method
 * routes are served bare. The 2023 client also hits several of these without the
 * `/roomserver` prefix, so both forms are registered.
 */

/** Parse the first valid integer id from a comma-separated `id` query param. */
function firstId(idParam: string): number | undefined {
	return idParam
		.split(',')
		.map((s) => Number.parseInt(s.trim(), 10))
		.find((n) => !Number.isNaN(n))
}

/** Parse all valid integer ids from a comma-separated `id` query param. */
function allIds(idParam: string): number[] {
	return idParam
		.split(',')
		.map((s) => Number.parseInt(s.trim(), 10))
		.filter((n) => !Number.isNaN(n))
}

/**
 * How many rooms one account may create, when the `MAX_ROOMS_PER_ACCOUNT` var is
 * unset. Cloning is the only way to make a room, so the cap is enforced there; it
 * counts rooms the account created, minus their auto-provisioned dorm. Setting the
 * var to 0 lifts the cap entirely, which a small private server will want. Existing
 * rooms are never touched — lowering the cap just stops new ones.
 */
const DEFAULT_MAX_ROOMS_PER_ACCOUNT = 10

/** Account ids granted the global (Role 0) maker pen — the reference server's
 * hardcoded moderator/dev accounts. */
const MAKER_PEN_ACCOUNT_IDS = new Set([1, 2, 3])

/**
 * The slice of the shared presence row we read — the caller's current room instance.
 * `subRoomId` is what scopes the stored permission overrides: they belong to the subroom
 * the player is standing in, not to the room.
 */
interface PresenceView {
	roomInstanceId?: number
	roomId?: number
	subRoomId?: number
}

/**
 * Room permissions + Photon token the client needs to spawn into a room. The
 * global (Role 0) maker pen is added only for the hardcoded dev accounts, and
 * `RoomInstanceId` is the caller's current instance from presence (null when
 * they aren't in one). `PhotonAccessToken` stays empty — the reference server
 * signs it via `ClientSecurity`, whose secret/algorithm we don't have; our
 * Photon setup accepts an empty token.
 *
 * `overrides` are the permissions the room's creator saved on the subroom the caller is
 * in (see `PUT …/subrooms/{subRoomId}/permissions`). They are matched against the
 * defaults by (`Permission`, `Role`) — the same pair the client addresses an entry by —
 * and win, so a subroom that revokes the Role 0 maker pen revokes it for a dev account
 * standing in it as well.
 */
function photonAccessToken(
	accountId: number,
	roomInstanceId: number | null,
	overrides: RoomPermission[] = []
) {
	const perm = (Permission: string, Role: number, Override: boolean): RoomPermission => ({
		Override,
		Permission,
		Role,
		Type: 0,
		Value: 'True',
	})
	const permissions: RoomPermission[] = [
		perm('CAN_USE_ROOM_RESET_BUTTON', 0, true),
		perm('CAN_USE_DELETE_ALL_BUTTON', 0, true),
		perm('CAN_SAVE_INVENTIONS', 0, true),
		perm('CAN_SPAWN_INVENTIONS', 0, true),
		perm('CAN_USE_PLAY_GIZMOS_TOGGLE', 0, true),
		perm('CAN_USE_MAKER_PEN', 30, false),
		perm('CAN_USE_ROOM_RESET_BUTTON', 30, true),
		perm('CAN_USE_DELETE_ALL_BUTTON', 30, true),
		perm('CAN_SAVE_INVENTIONS', 30, true),
		perm('CAN_SPAWN_INVENTIONS', 30, true),
		perm('CAN_USE_PLAY_GIZMOS_TOGGLE', 30, true),
	]

	if (MAKER_PEN_ACCOUNT_IDS.has(accountId)) {
		permissions.unshift(perm('CAN_USE_MAKER_PEN', 0, true))
	}

	// The subroom's stored table wins, applied LAST and over the dev grant too: a
	// (Permission, Role) the table already carries is replaced in place — so the order
	// doesn't shift under the client, and no pair is ever listed twice with two values —
	// and one it doesn't (e.g. CAN_INVITE) is appended.
	for (const override of overrides) {
		const i = permissions.findIndex(
			(p) => p.Permission === override.Permission && p.Role === override.Role
		)
		if (i === -1) permissions.push(override)
		else permissions[i] = override
	}
	return {
		Permissions: permissions,
		PhotonAccessToken: '',
		RoomInstanceId: roomInstanceId,
	}
}

/**
 * Photon access-token handler. Auth-gated: resolves the caller, reads their current
 * room instance from the shared `presence` table (see @repo/domain), and returns the
 * permissions + token.
 */
async function handlePhotonAccessToken(c: Context<App>) {
	const accountId = await authedAccountId(c)
	if (accountId === null) return unauthorized(c)
	const instance = (await getPresence<PresenceView>(c.env.DB, accountId))?.roomInstance
	// The permission overrides are the ones saved on the subroom the caller is standing in.
	// A player in no instance — sitting in the lobby, or an instance predating subroom
	// tracking — gets the default table untouched.
	const overrides =
		typeof instance?.subRoomId === 'number'
			? await getSubRoomPermissions(c.env.DB, instance.subRoomId)
			: []
	return c.json(photonAccessToken(accountId, instance?.roomInstanceId ?? null, overrides))
}

/**
 * May this caller read the room's saves? The room's creator always may. So may anyone
 * whose live presence puts them IN the room: they are already loading its scene, and the
 * client resolves which version to load — the published one or the creator's latest — from
 * the save list, so refusing everyone but the creator leaves a visitor unable to load what
 * the instance is actually running.
 *
 * Presence is the shared `presence` table the `match` heartbeat maintains, so this grant
 * lasts only as long as the player is actually there (rows carry an absolute expiry and
 * expired ones don't read back). Co-owners get nothing extra from being co-owners — a
 * co-owner standing in the room passes because of where they are, not what they hold.
 *
 * The presence read only happens for a non-creator, so the owner's own path stays one query.
 */
async function canReadSaves(
	c: Context<App>,
	room: Record<string, unknown>,
	roomId: number,
	accountId: number
): Promise<boolean> {
	if (room.CreatorAccountId === accountId) return true
	const instance = (await getPresence<PresenceView>(c.env.DB, accountId))?.roomInstance
	return instance?.roomId === roomId
}

/** The Bearer token's account id (`sub`), or null when there's no valid token. */
async function authedAccountId(c: Context<App>): Promise<number | null> {
	return validateAndGetAccountId(c.req.raw, await c.env.JWT_SECRET.get())
}

/**
 * Operator-granted elevated roles — the ones the auth worker stamps from an account's
 * isDeveloper/isModerator flags (see the admin CLI). Same set the `notify` / `www`
 * workers gate their admin surfaces on.
 */
const STAFF_ROLES: ReadonlySet<string> = new Set(['developer', 'moderator'])

/**
 * Whether the caller's token carries a staff role. Used alongside the per-room owner
 * check for actions staff may take in a room they don't own.
 */
async function isStaff(c: Context<App>): Promise<boolean> {
	const roles = await validateAndGetRoles(c.req.raw, await c.env.JWT_SECRET.get())
	return roles?.some((role) => STAFF_ROLES.has(role)) ?? false
}

/** 401 for the auth-gated `*by/me` endpoints — no stub-account fallback. */
function unauthorized(c: Context<App>) {
	return c.json({ error: 'Unauthorized' }, 401)
}

/**
 * Parse an `accessibility` form field into a `RoomAccessibility` value. The client
 * sends the enum NAME on the subroom route (`accessibility=Private`), not the number
 * the room-level route takes, so both forms are accepted. Returns undefined when the
 * field is missing or names nothing in the enum.
 */
function parseAccessibility(value: unknown): number | undefined {
	if (typeof value !== 'string') return undefined
	const raw = value.trim()
	if (/^-?\d+$/.test(raw)) return Number.parseInt(raw, 10)
	const named = Object.entries(Accessibility).find(
		([name, ordinal]) => typeof ordinal === 'number' && name.toLowerCase() === raw.toLowerCase()
	)
	return named ? (named[1] as number) : undefined
}

/** Parse an integer from the number or numeric string a JSON body may carry. */
function parseInt10(value: unknown): number | undefined {
	if (typeof value === 'number') return Number.isFinite(value) ? Math.trunc(value) : undefined
	if (typeof value !== 'string') return undefined
	const n = Number.parseInt(value.trim(), 10)
	return Number.isNaN(n) ? undefined : n
}

/**
 * The client's `Value`, kept as the STRING it sends. Usually `"True"`/`"False"` — the
 * True/False picker beside the override checkbox — but a permission whose UI is something
 * else carries a different value, so nothing here interprets it. A JSON boolean or number
 * is rendered the way the client would have written it.
 */
function permissionValue(value: unknown): string {
	if (typeof value === 'string') return value
	if (typeof value === 'boolean') return value ? 'True' : 'False'
	if (typeof value === 'number') return String(value)
	return ''
}

/**
 * Parse the subroom-permissions PUT body: a JSON ARRAY of
 * `{ Permission, Role, Override, Type, Value }` entries.
 *
 * `Override` is the client's checkbox, not data — see {@link setSubRoomPermissions}: true
 * stores `Value` for that (`Permission`, `Role`), false clears any stored entry so the
 * pair falls back to the default. It is carried through as sent.
 *
 * Entries without a permission name or a usable role are dropped rather than rejected —
 * the client ignores the response either way, so half a table applied beats none.
 */
function parseRoomPermissions(body: unknown): RoomPermission[] {
	if (!Array.isArray(body)) return []
	const permissions: RoomPermission[] = []
	for (const entry of body) {
		if (typeof entry !== 'object' || entry === null) continue
		const e = entry as Record<string, unknown>
		const permission = typeof e.Permission === 'string' ? e.Permission.trim() : ''
		const role = parseInt10(e.Role)
		if (permission === '' || role === undefined) continue
		permissions.push({
			Permission: permission,
			Role: role,
			// Sent as a JSON boolean, unlike `Value` — accept the string form regardless.
			Override: e.Override === true || String(e.Override).toLowerCase() === 'true',
			Type: parseInt10(e.Type) ?? 0,
			Value: permissionValue(e.Value),
		})
	}
	return permissions
}

/** The notifications hub is a single global DO instance (see the `notify` worker). */
const HUB_INSTANCE = 'global'

/**
 * The room `Supports*` flags the `/restrictions` endpoint can toggle, keyed by the
 * lowercased form field the client posts. Only fields present in the body are changed.
 */
const RESTRICTION_FIELDS: Record<string, string> = {
	supportsscreens: 'SupportsScreens',
	supportswalkvr: 'SupportsWalkVR',
	supportsteleportvr: 'SupportsTeleportVR',
	supportsvrlow: 'SupportsVRLow',
	supportsquest2: 'SupportsQuest2',
	supportsmobile: 'SupportsMobile',
	supportsjuniors: 'SupportsJuniors',
}

/**
 * Push a RoomUpdate notification to a player after their room changes, mirroring
 * the reference server's `HubSendToPlayer(playerId, NotifFrame("RoomUpdate", room))`.
 * Hub failures are logged and swallowed — the room write has already committed,
 * so a hub hiccup must not fail the request.
 */
async function pushRoomUpdate(
	c: Context<App>,
	playerId: number,
	room: Record<string, unknown>
): Promise<void> {
	try {
		await c.env.RECFLARE_NOTIFICATIONS_HUB.getByName(HUB_INSTANCE).notifyPlayer(
			playerId,
			NotificationType.SubscriptionUpdateRoom,
			room
		)
	} catch (err) {
		logger.error('failed to push RoomUpdate notification', {
			playerId,
			error: err instanceof Error ? err.message : String(err),
		})
	}
}

/**
 * `reportCategory` on a moderation frame. -1 is "Moderator" — the category for an
 * action a person took rather than one the system inferred, which is what a room ban
 * is. The rest of the enum, for reference: 2 Harassment, 3 Cheating, 5 AFK, 6 Misc,
 * 7 Underage, 10 VoteKick, 100–104 CoC_*, 200 InappropriateClothing.
 */
const REPORT_CATEGORY_MODERATOR = -1

/**
 * Eject a player from the room they're in — a `ModerationKick` push (id 22), the frame
 * the client acts on to remove someone. Sent on a ban: the row keeps them out of future
 * matchmakes, this gets them out of the instance they're in right now.
 *
 * The payload is the client's moderation shape, camelCase, in wire order:
 * `reportCategory`, `duration`, `gameSessionId`, `isHostKick`, `message`,
 * `playerIdReporter`, `isBan`, `isVoiceModAutoban`. `duration` is 0 (a room ban has no
 * expiry — it's lifted by DELETE, not by time) and `gameSessionId` is 0 (nothing here
 * tracks one).
 *
 * `isHostKick` says the room's HOST ejected the player, as opposed to the room
 * majority vote-kicking them. There is no vote-kick path yet, so the only false case
 * here is a staff moderator acting in a room they don't host. `playerIdReporter` is
 * whoever caused it — the host today, and the player who started the vote once
 * vote-kicks exist (those will carry `reportCategory` 10 and `isHostKick` false).
 *
 * Like {@link pushRoomUpdate}, hub failures are logged and swallowed: the ban row has
 * already committed, so a hub hiccup must not fail the request.
 */
async function pushRoomBan(
	c: Context<App>,
	ban: RoomBan,
	roomName: string,
	isHostKick: boolean
): Promise<void> {
	try {
		await c.env.RECFLARE_NOTIFICATIONS_HUB.getByName(HUB_INSTANCE).notifyPlayer(
			ban.BannedPlayerId,
			NotificationType.ModerationKick,
			{
				reportCategory: REPORT_CATEGORY_MODERATOR,
				duration: 0,
				gameSessionId: 0,
				isHostKick,
				message: `You have been banned from ${roomName}.`,
				playerIdReporter: ban.BannedByAccountId,
				isBan: true,
				isVoiceModAutoban: false,
			}
		)
	} catch (err) {
		logger.error('failed to push ModerationKick notification', {
			playerId: ban.BannedPlayerId,
			error: err instanceof Error ? err.message : String(err),
		})
	}
}

/**
 * Room-mutation result envelope: `{ Success, Value, ErrorId, Error }`, always
 * HTTP 200 (the client reads `Success`). `ErrorId`/`Error` are null on success.
 */
function roomResult(
	c: Context<App>,
	fields: { Success: boolean; Value?: unknown; ErrorId?: string; Error?: string }
) {
	return c.json({
		Success: fields.Success,
		Value: fields.Value ?? null,
		ErrorId: fields.ErrorId ?? null,
		Error: fields.Error ?? null,
	})
}

/**
 * The room save's `value.subRoomDataSave` — a camelCase projection with a DIFFERENT
 * field set from the PascalCase `CurrentSave` embedded in a room (no persistence/OM/UGC
 * versions, no moderation state, no asset arrays; but `unityAsset`/`unityAssetHash`
 * that `CurrentSave` never shows). Don't unify the two without checking the client.
 *
 * `unityAsset`/`unityAssetHash` are always null: we resolve no baked Unity assets.
 */
function toSaveResponse(save: Record<string, unknown>) {
	const str = (v: unknown) => (typeof v === 'string' ? v : null)
	const num = (v: unknown) => (typeof v === 'number' ? v : null)
	return {
		subRoomDataSaveId: num(save.SubRoomDataSaveId),
		subRoomId: num(save.SubRoomId),
		unityAssetId: str(save.UnityAssetId),
		unityAsset: null,
		unityAssetHash: null,
		dataBlob: str(save.DataBlob) ?? '',
		dataBlobHash: str(save.DataBlobHash),
		savedByAccountId: num(save.SavedByAccountId),
		savedOnPlatform: num(save.SavedOnPlatform) ?? 0,
		savedOnDeviceClass: num(save.SavedOnDeviceClass) ?? 0,
		description: str(save.Description),
		createdAt: str(save.CreatedAt) ?? '',
	}
}

/**
 * A save row with its Unity-asset payloads left out — what `…/saves/no_unity_assets`
 * lists. PascalCase like the rows `…/saves` serves, minus the two hydrated asset arrays
 * (`UnitySubAssets`, `ReferencedUnityAssets`) and `Tags`, keeping only the asset
 * IDENTIFIERS. The point of the variant is weight: those arrays are the heavy part of a
 * save row, and a history list doesn't render them.
 *
 * `UnityAssetId` is the one field that differs rather than disappearing — always present
 * and null when the save carried none, where the full row omits the key entirely.
 *
 * Built key by key rather than by deleting from the stored save: a save is stored as an
 * opaque blob, so a future field would otherwise leak into this projection unannounced.
 */
function toSaveWithoutUnityAssets(save: Record<string, unknown>) {
	const str = (v: unknown) => (typeof v === 'string' ? v : null)
	const num = (v: unknown) => (typeof v === 'number' ? v : null)
	return {
		SubRoomDataSaveId: num(save.SubRoomDataSaveId),
		SubRoomId: num(save.SubRoomId),
		UnityAssetId: str(save.UnityAssetId),
		ReferencedUnityAssetIds: Array.isArray(save.ReferencedUnityAssetIds)
			? save.ReferencedUnityAssetIds
			: [],
		DataBlob: str(save.DataBlob) ?? '',
		DataBlobHash: str(save.DataBlobHash),
		PersistenceVersion: num(save.PersistenceVersion) ?? 0,
		OMVersion: num(save.OMVersion) ?? 0,
		SavedByAccountId: num(save.SavedByAccountId),
		SavedOnPlatform: num(save.SavedOnPlatform) ?? 0,
		SavedOnDeviceClass: num(save.SavedOnDeviceClass) ?? 0,
		Description: str(save.Description) ?? '',
		ModerationState: num(save.ModerationState) ?? 0,
		CreatedAt: str(save.CreatedAt) ?? '',
		UgcSubVersion: num(save.UgcSubVersion) ?? 0,
	}
}

/** Client envelope for room mutations: `{ success, error, value }` (lowercase). */
function roomEnvelope(c: Context<App>, value: unknown, error = '') {
	return c.json({ success: error === '', error, value })
}

/**
 * The same envelope for the ban write, whose `value` is the BAN rather than the room —
 * a ban isn't part of the room the client renders, so there is no updated room to send.
 */
const banEnvelope = roomEnvelope

/** Rooms created/owned by the authed caller (shared by the createdby routes). */
async function ownedRooms(c: Context<App>) {
	const accountId = await authedAccountId(c)
	if (accountId === null) return unauthorized(c)
	return c.json(await getRoomsByCreator(c.env.DB, accountId))
}

/**
 * The caller's owned rooms, excluding their dorm. The dorm is auto-provisioned,
 * not a room the player made, so it doesn't belong in the "rooms you own" list.
 */
async function ownedRoomsExcludingDorm(c: Context<App>) {
	const accountId = await authedAccountId(c)
	if (accountId === null) return unauthorized(c)
	const rooms = await getRoomsByCreator(c.env.DB, accountId)
	return c.json(rooms.filter((r) => r.IsDorm !== true))
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
	// rec.net's own site called the game's API — its "My rooms" list is this worker's
	// `GET /rooms/ownedby/me` — so the responses need CORS headers or the browser
	// discards them. `origin: '*'` is deliberate and safe HERE because these endpoints
	// authenticate with a bearer token in the `Authorization` header, never a cookie: a
	// hostile page can't read another origin's stored token, so there is no ambient
	// credential for `*` to expose. Do not add cookie auth without narrowing it.
	.use('*', withDefaultCors())

	.onError(withOnError())
	.notFound(withNotFound())

	.get(
		'/',
		describeRoute({
			tags: ['Service'],
			summary: 'Service liveness',
			description: 'A fixed `{ service, status }` body. No auth — a plain liveness probe.',
			responses: { 200: json(ServiceStatus, 'Always `{ service: "rooms", status: "ok" }`') },
		}),
		(c) => c.json({ service: 'rooms', status: 'ok' })
	)

	// Room lookup by `id` (first match wins) or `name`. 400s when neither is
	// supplied and returns `{}` when nothing matches.
	.get(
		'/rooms',
		describeRoute({
			tags: ['Rooms'],
			summary: 'Look up a room by id or name',
			description: [
				'A single room by `id` or `name`. `id` may be a comma-separated list — the first',
				'valid integer wins. An unknown room is `{}`, not a 404: the client reads an empty',
				'object as “no such room”.',
			].join(' '),
			parameters: [
				stringQuery('id', 'Room id (comma-separated; the first valid one is used)'),
				stringQuery('name', 'Room name (matched case-insensitively). Ignored when `id` is given'),
			],
			responses: {
				200: json(RoomLookup, 'The room, or `{}` when there’s no match'),
				400: json(MissingLookupParam, 'Neither `id` nor `name` was supplied'),
			},
		}),
		async (c) => {
			const idParam = c.req.query('id')
			const nameParam = c.req.query('name')
			if (!idParam && !nameParam) {
				return c.json("Either 'id' or 'name' query parameter is required", 400)
			}
			if (idParam) {
				const id = firstId(idParam)
				const room = id === undefined ? null : await getRoomById(c.env.DB, id)
				return c.json(room ?? {})
			}
			const room = await getRoomByName(c.env.DB, nameParam ?? '')
			return c.json(room ?? {})
		}
	)

	// Room search: `query` is space/`+`-separated terms — `#tag` matches room tags,
	// plain terms match the name. Public, non-dorm rooms only. Paginated via
	// skip/take. Returns `{ Results, TotalResults }`.
	.get(
		'/rooms/search',
		describeRoute({
			tags: ['Discovery'],
			summary: 'Search rooms',
			description: [
				'Full room search. `query` is space- or `+`-separated terms: a `#tag` term matches the',
				'room’s tags, a plain term matches its name. Public, non-dorm rooms only.',
			].join(' '),
			parameters: [
				stringQuery('query', 'Search terms — `#tag` matches tags, plain terms match the name'),
				...pageParams(30),
			],
			responses: { 200: json(PagedRooms, 'The matching rooms') },
		}),
		async (c) => {
			const query = c.req.query('query') ?? ''
			const skip = Number.parseInt(c.req.query('skip') ?? '0', 10) || 0
			const take = Number.parseInt(c.req.query('take') ?? '30', 10) || 30
			return c.json(await searchRooms(c.env.DB, query, skip, take))
		}
	)

	// "Hot" rooms feed — public, non-dorm rooms ordered by live player count (their
	// instances' presence), then stored engagement, optionally filtered to a single
	// `tag` (e.g. `rro`). `tag=new` and `tag=community` are pseudo-tags no room
	// carries: `new` serves the player-made (non-RRO) rooms newest-first, `community`
	// keeps the normal ordering but drops the rooms the Coach account created.
	// Paginated via skip/take (take defaults to 100). Returns
	// `{ Results, TotalResults }` like search.
	.get(
		'/rooms/hot',
		describeRoute({
			tags: ['Discovery'],
			summary: 'The “hot” rooms feed',
			description: [
				'Public, non-dorm rooms ordered by how many players are in them right now — live',
				'presence summed across each room’s instances — falling back to stored engagement',
				'for rooms nobody is in. Optionally narrowed to a single `tag` (the browse screen’s',
				'filter chips post one, e.g. `rro`). The `new` and `community` chips are pseudo-tags —',
				'no room carries either. `new` instead serves the player-made (non-RRO) rooms, newest',
				'first; `community` keeps the ordering above but serves only rooms the Coach account',
				'(the system account owning the seeded first-party rooms) did not create.',
			].join(' '),
			parameters: [
				stringQuery(
					'tag',
					'Restrict to rooms carrying this tag (or `new`/`community`, pseudo-tags)'
				),
				...pageParams(100),
			],
			responses: { 200: json(PagedRooms, 'The feed page') },
		}),
		async (c) => {
			const tag = c.req.query('tag') ?? ''
			const skip = Number.parseInt(c.req.query('skip') ?? '0', 10) || 0
			const take = Number.parseInt(c.req.query('take') ?? '100', 10) || 100
			return c.json(await getHotRooms(c.env.DB, tag, skip, take))
		}
	)

	// "Base" rooms — template rooms (tagged `base`) the client offers when creating
	// a room. Returned regardless of accessibility. Paginated via skip/take (take
	// defaults to 100). Returns a bare array.
	.get(
		'/rooms/base',
		describeRoute({
			tags: ['Discovery'],
			summary: 'Base (template) rooms',
			description: [
				'The template rooms — those tagged `base` — the client offers when a player creates a',
				'room. Served regardless of accessibility, and as a bare array rather than a page.',
			].join(' '),
			parameters: pageParams(100),
			responses: { 200: json(RoomDto.array(), 'The template rooms') },
		}),
		async (c) => {
			const skip = Number.parseInt(c.req.query('skip') ?? '0', 10) || 0
			const take = Number.parseInt(c.req.query('take') ?? '100', 10) || 100
			return c.json(await getBaseRooms(c.env.DB, skip, take))
		}
	)

	// Recommended rooms feed — public, non-dorm rooms ranked by engagement, returned
	// as a bare array (the client's recommendation room-source expects a plain list).
	// The `splitTestId`/`splitTestValue` A/B params are accepted and ignored.
	// Paginated via skip/take (take defaults to 100).
	.get(
		'/rooms/recommendations',
		describeRoute({
			tags: ['Discovery'],
			summary: 'Recommended rooms',
			description: [
				'Public, non-dorm rooms ranked by engagement. Unlike search and hot this is a BARE',
				'array — the client’s recommendation room-source expects a plain list. The',
				'`splitTestId`/`splitTestValue` A/B params are accepted and ignored.',
			].join(' '),
			parameters: [
				stringQuery('splitTestId', 'A/B test id — accepted and ignored'),
				stringQuery('splitTestValue', 'A/B test bucket — accepted and ignored'),
				...pageParams(100),
			],
			responses: { 200: json(RoomDto.array(), 'The recommended rooms') },
		}),
		async (c) => {
			const skip = Number.parseInt(c.req.query('skip') ?? '0', 10) || 0
			const take = Number.parseInt(c.req.query('take') ?? '100', 10) || 100
			return c.json(await getRecommendedRooms(c.env.DB, skip, take))
		}
	)

	// Featured rooms — a single always-active group whose `Rooms` are a randomly
	// ordered set of public, non-dorm rooms. No real curation yet, so `current`
	// just returns a shuffled list of eligible rooms in the featured-group shape.
	// @todo This is not working. It somehow causes the other room listings to fail
	// completely with NREs. I think it is the featured room load that is somehow
	// corrupting the room cache. I tried sending the normal room shape but that
	// did not seem to work.
	.get(
		'/XXXfeaturedrooms/current',
		describeRoute({
			tags: ['Discovery'],
			summary: 'Featured rooms (parked — the path is deliberately broken)',
			description: [
				'A single always-active group of featured rooms: a random shuffle of eligible public',
				'rooms, since there is no editorial curation yet.',
				'',
				'**Parked.** The path the client calls is `/featuredrooms/current`; this is registered',
				'under an `XXX` prefix so the client never reaches it. Serving it made the OTHER room',
				'listings fail with NREs in the client, apparently by corrupting its room cache —',
				'sending the normal room shape instead did not help. It stays registered so the shape',
				'is documented and the route is one rename away once the cause is found.',
			].join('\n'),
			responses: { 200: json(FeaturedRoomGroupDto, 'The featured-room group') },
		}),
		async (c) => {
			return c.json(await getFeaturedRooms(c.env.DB))
		}
	)

	// Bulk room lookup by `id` or `name` — returns an array of matched rooms (the
	// client calls this bare on the rooms host). Rooms not in D1 are simply absent
	// from the result; the client treats an empty result as NoSuchRoom.
	.get(
		'/rooms/bulk',
		describeRoute({
			tags: ['Rooms'],
			summary: 'Look up several rooms at once',
			description: [
				'Rooms by a comma-separated `id` list, or a single `name`. Ids that aren’t in D1 are',
				'simply absent from the result rather than an error — the client reads an empty result',
				'as NoSuchRoom.',
			].join(' '),
			parameters: [
				stringQuery('id', 'Comma-separated room ids'),
				stringQuery('name', 'A single room name. Ignored when `id` is given'),
			],
			responses: {
				200: json(RoomDto.array(), 'The rooms that matched (missing ids are omitted)'),
				400: json(MissingLookupParam, 'Neither `id` nor `name` was supplied'),
			},
		}),
		async (c) => {
			const idParam = c.req.query('id')
			const nameParam = c.req.query('name')
			if (!idParam && !nameParam) {
				return c.json("Either 'id' or 'name' query parameter is required", 400)
			}
			if (idParam) {
				return c.json(await getRoomsByIds(c.env.DB, allIds(idParam)))
			}
			const room = await getRoomByName(c.env.DB, nameParam ?? '')
			return c.json(room ? [room] : [])
		}
	)

	// Rooms created/owned by the caller. Auth-gated — no token is a 401, never
	// account 1. `ownedby/me` drops the dorm (it's not a room the player made);
	// the `createdby` variants return everything the account created. None of them
	// filter on Accessibility: these are the owner's own "My Rooms" lists, so a room
	// they haven't published yet (a fresh clone is Private) has to show up here.
	// Only the public `ownedby/:accountId` profile list is accessibility-filtered.
	.get(
		'/roomserver/rooms/createdby/me',
		describeRoute({
			tags: ['My rooms'],
			summary: 'Rooms the caller created (legacy path)',
			description: [
				'Every room the caller created, dorm included. Identical to',
				'`GET /rooms/createdby/me` — the 2023 client calls this one under the `/roomserver`',
				'prefix, so both forms are registered.',
			].join(' '),
			security: AUTHED,
			responses: { 200: json(RoomDto.array(), 'The caller’s rooms'), 401: UNAUTHORIZED_RESPONSE },
		}),
		ownedRooms
	)
	.get(
		'/rooms/ownedby/me',
		describeRoute({
			tags: ['My rooms'],
			summary: 'Rooms the caller owns (excluding their dorm)',
			description: [
				'The caller’s own rooms with the dorm filtered out: a dorm is auto-provisioned, not a',
				'room the player made, so it doesn’t belong in the “rooms you own” list. Use',
				'`createdby/me` for everything the account created. Accessibility is deliberately NOT',
				'filtered — this is the owner’s own list, so unpublished (Private) rooms appear, unlike',
				'the public `ownedby/{accountId}` profile list.',
			].join(' '),
			security: AUTHED,
			responses: {
				200: json(RoomDto.array(), 'The caller’s rooms, dorm excluded'),
				401: UNAUTHORIZED_RESPONSE,
			},
		}),
		ownedRoomsExcludingDorm
	)
	.get(
		'/rooms/createdby/me',
		describeRoute({
			tags: ['My rooms'],
			summary: 'Rooms the caller created',
			description: 'Every room the caller created, dorm included.',
			security: AUTHED,
			responses: { 200: json(RoomDto.array(), 'The caller’s rooms'), 401: UNAUTHORIZED_RESPONSE },
		}),
		ownedRooms
	)

	// The caller's own dorm, as its ID ALONE — a bare JSON number, not the room. The
	// caller follows up with `GET /rooms/{roomId}` when it wants the room itself.
	//
	// Gets-or-creates, exactly as entering a dorm does (`match`): the provisioning is the
	// point of the call as much as the answer is, so a player who has never been to their
	// dorm gets one minted here rather than a 404, and the id is stable from then on.
	.get(
		'/dormroom/me',
		describeRoute({
			tags: ['My rooms'],
			summary: 'The caller’s dorm id',
			description: [
				'The `RoomId` of the caller’s personal dorm, as a bare JSON number — NOT the room:',
				'fetch that from `GET /rooms/{roomId}` with the id this returns.',
				'',
				'The dorm is provisioned on first access (cloned from the seeded template dorm), so',
				'this answers for any authed caller and never 404s, and calling it again returns the',
				'same id.',
			].join(' '),
			security: AUTHED,
			responses: { 200: json(DormRoomId, 'The caller’s dorm id'), 401: UNAUTHORIZED_RESPONSE },
		}),
		async (c) => {
			const accountId = await authedAccountId(c)
			if (accountId === null) return unauthorized(c)
			const dorm = await getOrCreateDormRoom(c.env.DB, accountId)
			return c.json(Number(dorm.RoomId))
		}
	)

	// Public: the rooms a given account owns that are publicly viewable. No auth —
	// returns a bare array (empty when the account owns no public rooms).
	.get(
		'/rooms/ownedby/:accountId{[0-9]+}',
		describeRoute({
			tags: ['Rooms'],
			summary: 'Another player’s public rooms',
			description: [
				'The rooms an account owns that are publicly viewable — what the client shows on a',
				'player’s profile. No auth; empty when the account owns no public rooms.',
			].join(' '),
			parameters: [
				{
					name: 'accountId',
					in: 'path',
					required: true,
					description: 'The account whose rooms to list',
					schema: { type: 'string', pattern: '^[0-9]+$' },
				},
			],
			responses: { 200: json(RoomDto.array(), 'That account’s public rooms') },
		}),
		async (c) =>
			c.json(await getPublicRoomsByCreator(c.env.DB, Number.parseInt(c.req.param('accountId'), 10)))
	)

	// Rooms the caller has favorited (from the interaction table). Auth-gated.
	// Paginated via skip/take (take defaults to 100). Returns a bare array, like the
	// other room-source `*by/me` lists the client loads.
	.get(
		'/rooms/favoritedby/me',
		describeRoute({
			tags: ['My rooms'],
			summary: 'Rooms the caller favorited',
			description:
				'The rooms the caller has favorited (from the interaction table), as a bare array.',
			security: AUTHED,
			parameters: pageParams(100),
			responses: {
				200: json(RoomDto.array(), 'The favorited rooms'),
				401: UNAUTHORIZED_RESPONSE,
			},
		}),
		async (c) => {
			const accountId = await authedAccountId(c)
			if (accountId === null) return unauthorized(c)
			const skip = Number.parseInt(c.req.query('skip') ?? '0', 10) || 0
			const take = Number.parseInt(c.req.query('take') ?? '100', 10) || 100
			return c.json(await getFavoritedRooms(c.env.DB, accountId, skip, take))
		}
	)

	// Rooms the caller has visited (interaction rows with a last-visited time).
	// Auth-gated. Paginated via skip/take (take defaults to 100). Returns a bare array.
	.get(
		'/rooms/visitedby/me',
		describeRoute({
			tags: ['My rooms'],
			summary: 'Rooms the caller visited',
			description: [
				'The rooms the caller has visited — interaction rows carrying a last-visited time —',
				'as a bare array.',
			].join(' '),
			security: AUTHED,
			parameters: pageParams(100),
			responses: { 200: json(RoomDto.array(), 'The visited rooms'), 401: UNAUTHORIZED_RESPONSE },
		}),
		async (c) => {
			const accountId = await authedAccountId(c)
			if (accountId === null) return unauthorized(c)
			const skip = Number.parseInt(c.req.query('skip') ?? '0', 10) || 0
			const take = Number.parseInt(c.req.query('take') ?? '100', 10) || 100
			return c.json(await getVisitedRooms(c.env.DB, accountId, skip, take))
		}
	)

	// Another player's visited rooms — what the client shows on a friend's profile.
	// Auth-gated (401), and FRIENDS-ONLY: a valid token for someone who isn't that
	// player and isn't a mutual friend of theirs is a 403, since where a player has
	// been is not public. Registered after `visitedby/me` so the literal path wins.
	// Paginated via skip/take (take defaults to 100) and, like `visitedby/me`, a bare
	// array — the client's room-source loaders expect a plain list, not a page.
	.get(
		'/rooms/visitedby/:playerId{[0-9]+}',
		describeRoute({
			tags: ['Rooms'],
			summary: 'A friend’s visited rooms',
			description: [
				'The rooms another player has visited, as a bare array. Friends only: the caller must',
				'be that player or a mutual friend of theirs (403 otherwise) — visit history is not',
				'public.',
			].join(' '),
			security: AUTHED,
			parameters: [playerIdParam, ...pageParams(100)],
			responses: {
				200: json(RoomDto.array(), 'That player’s visited rooms'),
				401: UNAUTHORIZED_RESPONSE,
				403: NOT_FRIENDS_RESPONSE,
			},
		}),
		async (c) => {
			const accountId = await authedAccountId(c)
			if (accountId === null) return unauthorized(c)
			const playerId = Number.parseInt(c.req.param('playerId'), 10)
			// Your own history is always readable (the client sometimes sends the id
			// rather than `me`); anyone else's needs a mutual friendship.
			if (playerId !== accountId && !(await areFriends(c.env.DB, accountId, playerId))) {
				return c.body(null, 403)
			}
			const skip = Number.parseInt(c.req.query('skip') ?? '0', 10) || 0
			const take = Number.parseInt(c.req.query('take') ?? '100', 10) || 100
			return c.json(await getVisitedRooms(c.env.DB, playerId, skip, take))
		}
	)

	// The current player's interaction state with a room (cheered/favorited/last
	// visited), read from the `interaction` table. Auth-gated.
	.get(
		'/rooms/:roomId{[0-9]+}/interactionby/me',
		describeRoute({
			tags: ['Interaction'],
			summary: 'The caller’s state on a room',
			description: [
				'Whether the caller has cheered/favorited the room. An unknown room (or one the caller',
				'has never touched) reads as all-false rather than 404. `LastVisitedAt` is stamped',
				'with “now” on every read, not served from storage.',
			].join(' '),
			security: AUTHED,
			parameters: [roomIdParam],
			responses: { 200: json(InteractionDto, 'The interaction'), 401: UNAUTHORIZED_RESPONSE },
		}),
		async (c) => {
			const accountId = await authedAccountId(c)
			if (accountId === null) return unauthorized(c)
			const interaction = await getInteraction(
				c.env.DB,
				accountId,
				Number.parseInt(c.req.param('roomId'), 10)
			)
			return c.json({ ...interaction, LastVisitedAt: new Date().toISOString() })
		}
	)

	// Toggle the player's cheer/favorite on a room. Both are auth-gated PUTs that
	// flip the stored flag and return the updated interaction.
	.put(
		'/rooms/:roomId{[0-9]+}/interactionby/me/cheer',
		describeRoute({
			tags: ['Interaction'],
			summary: 'Toggle the caller’s cheer on a room',
			description: 'Flips the stored cheer flag and answers the updated interaction.',
			security: AUTHED,
			parameters: [roomIdParam],
			responses: {
				200: json(InteractionDto, 'The interaction after the toggle'),
				401: UNAUTHORIZED_RESPONSE,
			},
		}),
		async (c) => {
			const accountId = await authedAccountId(c)
			if (accountId === null) return unauthorized(c)
			const interaction = await toggleCheer(
				c.env.DB,
				accountId,
				Number.parseInt(c.req.param('roomId'), 10)
			)
			return c.json({ ...interaction, LastVisitedAt: new Date().toISOString() })
		}
	)
	// Explicitly un-cheer a room (DELETE clears the cheer, vs the PUT toggle).
	// Auth-gated; idempotent — un-cheering when there's no cheer is a no-op.
	.delete(
		'/rooms/:roomId{[0-9]+}/interactionby/me/cheer',
		describeRoute({
			tags: ['Interaction'],
			summary: 'Un-cheer a room',
			description: [
				'Clears the cheer outright, where the PUT toggles it. Idempotent — un-cheering a room',
				'that isn’t cheered is a no-op.',
			].join(' '),
			security: AUTHED,
			parameters: [roomIdParam],
			responses: { 200: json(InteractionDto, 'The interaction'), 401: UNAUTHORIZED_RESPONSE },
		}),
		async (c) => {
			const accountId = await authedAccountId(c)
			if (accountId === null) return unauthorized(c)
			const interaction = await removeCheer(
				c.env.DB,
				accountId,
				Number.parseInt(c.req.param('roomId'), 10)
			)
			return c.json({ ...interaction, LastVisitedAt: new Date().toISOString() })
		}
	)
	.put(
		'/rooms/:roomId{[0-9]+}/interactionby/me/favorite',
		describeRoute({
			tags: ['Interaction'],
			summary: 'Toggle the caller’s favorite on a room',
			description: 'Flips the stored favorite flag and answers the updated interaction.',
			security: AUTHED,
			parameters: [roomIdParam],
			responses: {
				200: json(InteractionDto, 'The interaction after the toggle'),
				401: UNAUTHORIZED_RESPONSE,
			},
		}),
		async (c) => {
			const accountId = await authedAccountId(c)
			if (accountId === null) return unauthorized(c)
			const interaction = await toggleFavorite(
				c.env.DB,
				accountId,
				Number.parseInt(c.req.param('roomId'), 10)
			)
			return c.json({ ...interaction, LastVisitedAt: new Date().toISOString() })
		}
	)
	// Explicitly un-favorite a room (DELETE clears the favorite, vs the PUT toggle).
	// Auth-gated; idempotent — un-favoriting when there's no favorite is a no-op.
	.delete(
		'/rooms/:roomId{[0-9]+}/interactionby/me/favorite',
		describeRoute({
			tags: ['Interaction'],
			summary: 'Un-favorite a room',
			description: [
				'Clears the favorite outright, where the PUT toggles it. Idempotent — un-favoriting a',
				'room that isn’t favorited is a no-op.',
			].join(' '),
			security: AUTHED,
			parameters: [roomIdParam],
			responses: { 200: json(InteractionDto, 'The interaction'), 401: UNAUTHORIZED_RESPONSE },
		}),
		async (c) => {
			const accountId = await authedAccountId(c)
			if (accountId === null) return unauthorized(c)
			const interaction = await removeFavorite(
				c.env.DB,
				accountId,
				Number.parseInt(c.req.param('roomId'), 10)
			)
			return c.json({ ...interaction, LastVisitedAt: new Date().toISOString() })
		}
	)

	// Clone a room into a new one owned by the caller, using the `name` form field
	// (also accepted as a query param). Auth is required — no valid token is a 401,
	// with no stub-account fallback. Returns the `{ success, error, value }` envelope
	// the client expects; business failures are 200 with success:false.
	.post(
		'/rooms/:roomId{[0-9]+}/clone',
		describeRoute({
			tags: ['Room settings'],
			summary: 'Clone a room',
			description: [
				'Copies a room’s content (scene, subrooms, settings) into a new room owned by the',
				'caller. Cloning is the only way to make a room, so the per-account room cap is',
				'enforced here — it counts the rooms the account created, minus their auto-provisioned',
				'dorm (`MAX_ROOMS_PER_ACCOUNT`; 0 lifts the cap). The clone starts with no tags,',
				'`IsRRO` cleared, and PRIVATE accessibility — a new room is unpublished until its',
				'owner sets its accessibility, so it never lands in the public feeds on creation.',
				'',
				'Rejections — a blank or taken name, the cap, a source that disallows cloning — are',
				'HTTP 200 with `success: false` and the message the client shows.',
			].join('\n'),
			security: AUTHED,
			parameters: [roomIdParam],
			requestBody: form(CloneRoomRequest, 'The new room’s name (also read from `?name=`)'),
			responses: {
				200: json(RoomEnvelope, 'The new room, or a rejection with `success: false`'),
				401: UNAUTHORIZED_ENVELOPE,
			},
		}),
		async (c) => {
			const accountId = await authedAccountId(c)
			if (accountId === null) {
				return c.json({ success: false, error: 'Unauthorized', value: null }, 401)
			}

			const body = (await c.req.parseBody().catch(() => ({}))) as Record<string, unknown>
			const raw = body.name ?? c.req.query('name') ?? ''
			const name = typeof raw === 'string' ? raw.trim() : ''

			if (name === '') return roomEnvelope(c, null, 'You must enter a name for your room.')
			// Shape before availability, so a rejected name costs no D1 read.
			const badName = roomNameRejection(name, 'room name')
			if (badName !== null) return roomEnvelope(c, null, badName)
			if (await getRoomByName(c.env.DB, name)) {
				return roomEnvelope(c, null, 'A room with that name already exists!')
			}
			// Cloning is how a player makes a room, so the per-account cap belongs here.
			// Checked after the cheap validations so a rejected name costs no extra D1 read.
			const maxRooms = intVar(c.env.MAX_ROOMS_PER_ACCOUNT, DEFAULT_MAX_ROOMS_PER_ACCOUNT)
			if (maxRooms > 0 && (await countRoomsByCreator(c.env.DB, accountId)) >= maxRooms) {
				logger.info('room create rejected: per-account room limit', { accountId })
				return roomEnvelope(c, null, `You can only have ${maxRooms} rooms.`)
			}
			const room = await cloneRoom(
				c.env.DB,
				Number.parseInt(c.req.param('roomId'), 10),
				name,
				accountId
			)
			if (!room) return roomEnvelope(c, null, "You can't clone this room!")
			return roomEnvelope(c, room)
		}
	)

	// Update a room's description. Auth-gated (401) and owner-only. Business results
	// use the `{ Success, Value, ErrorId, Error }` envelope at HTTP 200.
	.put(
		'/rooms/:roomId{[0-9]+}/description',
		describeRoute({
			tags: ['Room settings'],
			summary: 'Set a room’s description',
			description: [
				'Owner-only (the room’s `CreatorAccountId` — co-owners cannot). An unknown room or a',
				'non-owner is HTTP 200 with `Success: false` and an `ErrorId`; only a missing token is',
				'a real 401. An absent `description` field clears the description.',
			].join(' '),
			security: AUTHED,
			parameters: [roomIdParam],
			requestBody: form(DescriptionRequest, 'The new description'),
			responses: {
				200: json(RoomResultEnvelope, 'Success, or a rejection carrying an `ErrorId`'),
				401: UNAUTHORIZED_RESPONSE,
			},
		}),
		async (c) => {
			const accountId = await authedAccountId(c)
			if (accountId === null) return unauthorized(c)

			const roomId = Number.parseInt(c.req.param('roomId'), 10)
			const room = await getRoomById(c.env.DB, roomId)
			if (!room) {
				return roomResult(c, {
					Success: false,
					ErrorId: 'Rooms.DoesntExist',
					Error: 'This room does not exist!',
				})
			}
			if (room.CreatorAccountId !== accountId) {
				return roomResult(c, {
					Success: false,
					ErrorId: 'Rooms.NotOwner',
					Error: 'You are not the owner of this room!',
				})
			}

			const body = (await c.req.parseBody().catch(() => ({}))) as Record<string, unknown>
			const description = typeof body.description === 'string' ? body.description : ''
			await setRoomDescription(c.env.DB, roomId, description)
			return roomResult(c, { Success: true })
		}
	)

	// Rename a room. Auth-gated (401) and owner-only; the new name must be non-empty
	// and not already taken by another room. Business results use the
	// `{ Success, Value, ErrorId, Error }` envelope at HTTP 200.
	// NOTE: the ErrorId strings (besides Rooms.DoesntExist) are best guesses.
	.put(
		'/rooms/:roomId{[0-9]+}/name',
		describeRoute({
			tags: ['Room settings'],
			summary: 'Rename a room',
			description: [
				'Owner-only. The new name must be non-empty and not already taken by another room',
				'(names are compared case-insensitively). Rejections are HTTP 200 with',
				'`Success: false`.',
				'',
				'NOTE: the `ErrorId` strings other than `Rooms.DoesntExist` are best guesses — the',
				'client only renders `Error`, so they have never been confirmed against the real one.',
			].join('\n'),
			security: AUTHED,
			parameters: [roomIdParam],
			requestBody: form(NameRequest, 'The new name'),
			responses: {
				200: json(RoomResultEnvelope, 'Success, or a rejection carrying an `ErrorId`'),
				401: UNAUTHORIZED_RESPONSE,
			},
		}),
		async (c) => {
			const accountId = await authedAccountId(c)
			if (accountId === null) return unauthorized(c)

			const roomId = Number.parseInt(c.req.param('roomId'), 10)
			const room = await getRoomById(c.env.DB, roomId)
			if (!room) {
				return roomResult(c, {
					Success: false,
					ErrorId: 'Rooms.DoesntExist',
					Error: 'This room does not exist!',
				})
			}
			if (room.CreatorAccountId !== accountId) {
				return roomResult(c, {
					Success: false,
					ErrorId: 'Rooms.NotOwner',
					Error: 'You are not the owner of this room!',
				})
			}

			const body = (await c.req.parseBody().catch(() => ({}))) as Record<string, unknown>
			const name = typeof body.name === 'string' ? body.name.trim() : ''
			if (name === '') {
				return roomResult(c, {
					Success: false,
					ErrorId: 'Rooms.InvalidName',
					Error: 'You must enter a name for your room!',
				})
			}
			// Same ErrorId as the empty case — the client keys off it to mark the field, and
			// both are the name being unusable. The sentence is what tells them which.
			const badName = roomNameRejection(name, 'room name')
			if (badName !== null) {
				return roomResult(c, { Success: false, ErrorId: 'Rooms.InvalidName', Error: badName })
			}

			// Reject if a different room already uses this name (case-insensitive).
			const existing = await getRoomByName(c.env.DB, name)
			if (existing && existing.RoomId !== roomId) {
				return roomResult(c, {
					Success: false,
					ErrorId: 'Rooms.AlreadyExists',
					Error: 'A room with that name already exists!',
				})
			}

			await setRoomName(c.env.DB, roomId, name)
			return roomResult(c, { Success: true })
		}
	)

	// Toggle a tag on a room. Auth-gated (401) and owner/co-owner-only (403). Body is
	// the `tag` form field. There's no delete/patch endpoint, so this call toggles: it
	// adds the tag (Type 0) if absent and removes it if present. The "main" tags
	// (#pvp/#quest/#game/#hangout/#art) are radio buttons — setting one clears the
	// others. Returns the `{ success, error, value }` envelope with the updated
	// room as `value`; business failures are 200 with success:false.
	.put(
		'/rooms/:roomId{[0-9]+}/tags',
		describeRoute({
			tags: ['Room settings'],
			summary: 'Toggle a tag on a room',
			description: [
				'Owner or co-owner only (403 otherwise). There is no delete/patch counterpart, so',
				'this call TOGGLES: it adds the tag (Type 0) when absent and removes it when',
				'present. The “main” tags (`pvp`/`quest`/`game`/`hangout`/`art`) behave as radio',
				'buttons — setting one clears the others. Answers the lowercase envelope with the',
				'updated room, which the client re-renders from.',
			].join(' '),
			security: AUTHED,
			parameters: [roomIdParam],
			requestBody: form(TagRequest, 'The tag to toggle'),
			responses: {
				200: json(RoomEnvelope, 'The updated room, or a rejection with `success: false`'),
				401: UNAUTHORIZED_RESPONSE,
				403: FORBIDDEN_RESPONSE,
			},
		}),
		async (c) => {
			const accountId = await authedAccountId(c)
			if (accountId === null) return unauthorized(c)

			const roomId = Number.parseInt(c.req.param('roomId'), 10)
			const room = await getRoomById(c.env.DB, roomId)
			if (!room) return roomEnvelope(c, null, 'This room does not exist!')
			// A valid token but not the room's owner/co-owner → 403 (the auth gate above
			// already returned 401 for a missing/invalid token).
			if (!canManageRoom(room, accountId)) return c.body(null, 403)

			const body = (await c.req.parseBody().catch(() => ({}))) as Record<string, unknown>
			const tag = typeof body.tag === 'string' ? body.tag.trim() : ''
			if (tag === '') return roomEnvelope(c, null, 'You must provide a tag!')

			const updated = await toggleRoomTag(c.env.DB, roomId, room, tag)
			return roomEnvelope(c, updated)
		}
	)

	// Set a room's image. Auth-gated (401) and owner-only. Body is the `imageName`
	// form field (a key from the storage/image upload). Business results use the
	// `{ Success, Value, ErrorId, Error }` envelope at HTTP 200.
	.put(
		'/rooms/:roomId{[0-9]+}/image',
		describeRoute({
			tags: ['Room settings'],
			summary: 'Set a room’s image',
			description: [
				'Owner-only. `imageName` is a key from the storage upload, stored un-prefixed (the',
				'`cdn` worker serves it back under `room/`). Pushes a `RoomUpdate` to the owner so',
				'their client re-renders with the new image.',
			].join(' '),
			security: AUTHED,
			parameters: [roomIdParam],
			requestBody: form(ImageRequest, 'The uploaded image key'),
			responses: {
				200: json(RoomResultEnvelope, 'Success, or a rejection carrying an `ErrorId`'),
				401: UNAUTHORIZED_RESPONSE,
			},
		}),
		async (c) => {
			const accountId = await authedAccountId(c)
			if (accountId === null) return unauthorized(c)

			const roomId = Number.parseInt(c.req.param('roomId'), 10)
			const room = await getRoomById(c.env.DB, roomId)
			if (!room) {
				return roomResult(c, {
					Success: false,
					ErrorId: 'Rooms.DoesntExist',
					Error: 'This room does not exist!',
				})
			}
			if (room.CreatorAccountId !== accountId) {
				return roomResult(c, {
					Success: false,
					ErrorId: 'Rooms.NotOwner',
					Error: 'You are not the owner of this room!',
				})
			}

			const body = (await c.req.parseBody().catch(() => ({}))) as Record<string, unknown>
			const imageName = typeof body.imageName === 'string' ? body.imageName.trim() : ''
			if (imageName === '') {
				return roomResult(c, {
					Success: false,
					ErrorId: 'Rooms.InvalidImage',
					Error: 'You must provide an image!',
				})
			}
			await setRoomImage(c.env.DB, roomId, imageName)
			// Notify the owner so their client refreshes the room (RoomUpdate carries the
			// updated room). The reference sends the post-update room, so merge the change.
			await pushRoomUpdate(c, accountId, { ...room, ImageName: imageName })
			return roomResult(c, { Success: true })
		}
	)

	// Delete a room. Auth-gated (401) and owner-only (the room's CreatorAccountId).
	// Removes the room record (and per-player interactions with it) and the room's
	// image object from the shared CDN bucket. Images players *took* in the room are
	// left alone — they live in the api/img world and outlast the room.
	.delete(
		'/rooms/:roomId{[0-9]+}',
		describeRoute({
			tags: ['Room settings'],
			summary: 'Delete a room',
			description: [
				'Owner-only. Removes the room record, the per-player interactions with it, and the',
				'room’s image object from the shared CDN bucket. Photos players TOOK in the room are',
				'left alone — those live in the api/img world and outlive the room.',
			].join(' '),
			security: AUTHED,
			parameters: [roomIdParam],
			responses: {
				200: json(RoomResultEnvelope, 'Success, or a rejection carrying an `ErrorId`'),
				401: UNAUTHORIZED_RESPONSE,
			},
		}),
		async (c) => {
			const accountId = await authedAccountId(c)
			if (accountId === null) return unauthorized(c)

			const roomId = Number.parseInt(c.req.param('roomId'), 10)
			const room = await getRoomById(c.env.DB, roomId)
			if (!room) {
				return roomResult(c, {
					Success: false,
					ErrorId: 'Rooms.DoesntExist',
					Error: 'This room does not exist!',
				})
			}
			if (room.CreatorAccountId !== accountId) {
				return roomResult(c, {
					Success: false,
					ErrorId: 'Rooms.NotOwner',
					Error: 'You are not the owner of this room!',
				})
			}

			await deleteRoom(c.env.DB, roomId)

			// Remove the room image from the CDN bucket. The stored ImageName is the
			// un-prefixed key the `cdn` worker serves back under `room/` (see storage
			// upload + the `GET /room/:dataBlob` route), so the object key is `room/<name>`.
			// R2 deletes are idempotent, so a canonical/static or already-gone image is fine.
			const imageName = typeof room.ImageName === 'string' ? room.ImageName : ''
			if (imageName !== '') {
				await c.env.CDN_ASSETS.delete(`room/${imageName}`)
			}

			return roomResult(c, { Success: true })
		}
	)

	// Set a member's role in a room (`Roles[].Role`). Auth-gated (401) and gated to
	// the room creator or a co-owner (403 otherwise) — the same owner/co-owner check
	// the other room-admin actions use. Body is the `role` form field (an integer role
	// tier). Updates the target account's existing role entry or adds one, notifies the
	// affected member so their client refreshes permissions, and returns the updated
	// room in the lowercase `{ success, error, value }` envelope.
	.put(
		'/rooms/:roomId{[0-9]+}/roles/:accountId{[0-9]+}',
		describeRoute({
			tags: ['Room settings'],
			summary: 'Set a member’s role in a room',
			description: [
				'Updates the target account’s entry in the room’s `Roles` (or adds one). Gated to the',
				'room’s creator or a co-owner — a valid token from anyone else is a 403. The affected',
				'MEMBER gets the `RoomUpdate` push, not the caller, so their client refreshes the',
				'permissions it just gained or lost.',
			].join(' '),
			security: AUTHED,
			parameters: [
				roomIdParam,
				{
					name: 'accountId',
					in: 'path',
					required: true,
					description: 'The member whose role changes',
					schema: { type: 'string', pattern: '^[0-9]+$' },
				},
			],
			requestBody: form(RoleRequest, 'The role tier to grant'),
			responses: {
				200: json(RoomEnvelope, 'The updated room, or a rejection with `success: false`'),
				401: UNAUTHORIZED_RESPONSE,
				403: FORBIDDEN_RESPONSE,
			},
		}),
		async (c) => {
			const accountId = await authedAccountId(c)
			if (accountId === null) return unauthorized(c)

			const roomId = Number.parseInt(c.req.param('roomId'), 10)
			const targetAccountId = Number.parseInt(c.req.param('accountId'), 10)
			const room = await getRoomById(c.env.DB, roomId)
			if (!room) return roomEnvelope(c, null, 'This room does not exist!')
			// A valid token but not the room's owner/co-owner → 403 (the auth gate above
			// already returned 401 for a missing/invalid token).
			if (!canManageRoom(room, accountId)) return c.body(null, 403)

			const body = (await c.req.parseBody().catch(() => ({}))) as Record<string, unknown>
			const role = typeof body.role === 'string' ? Number.parseInt(body.role, 10) : Number.NaN
			if (Number.isNaN(role)) return roomEnvelope(c, null, 'You must provide a valid role!')

			const updated = await setRoomRole(c.env.DB, roomId, targetAccountId, role, accountId, room)
			// Notify the member whose role changed so their client refreshes the room
			// (and the permissions it grants them).
			await pushRoomUpdate(c, targetAccountId, updated)
			return roomEnvelope(c, updated)
		}
	)

	// A room's ban list — the owner's view of who they've banned. Same gate as issuing a
	// ban: a ban list says who a room's owner has had trouble with, so it isn't public.
	// Answers a BARE array (not the room-write envelope), newest ban first.
	.get(
		'/rooms/:roomId{[0-9]+}/bans',
		describeRoute({
			tags: ['Room settings'],
			summary: 'A room’s ban list',
			description: [
				'Everyone banned from the room, most recently banned first. Auth-gated, then gated',
				'exactly like issuing a ban: the room’s creator or a co-owner, or an account whose',
				'token carries the `developer` / `moderator` role. A ban list says who a room’s',
				'owner has had trouble with, so it is not public.',
				'',
				'A bare array, NOT the `{ success, error, value }` envelope the ban write answers,',
				'and the entries are camelCase with a different field set: no room id (the path',
				'already says which room) and no ban mask. An unknown room is an empty list rather',
				'than an error — it reads the same as a room nobody is banned from.',
			].join('\n'),
			security: AUTHED,
			parameters: [roomIdParam],
			responses: {
				200: json(RoomBanEntryDto.array(), 'The room’s bans, newest first'),
				401: UNAUTHORIZED_RESPONSE,
				403: FORBIDDEN_RESPONSE,
			},
		}),
		async (c) => {
			const accountId = await authedAccountId(c)
			if (accountId === null) return unauthorized(c)

			const roomId = Number.parseInt(c.req.param('roomId'), 10)
			const room = await getRoomById(c.env.DB, roomId)
			// No room → nothing banned. Same answer as a room with an empty ban list, so
			// this doesn't become a way to probe which room ids exist.
			if (!room) return c.json([])
			if (!canManageRoom(room, accountId) && !(await isStaff(c))) return c.body(null, 403)

			const bans = await getRoomBans(c.env.DB, roomId)
			return c.json(
				bans.map((ban) => ({
					accountId: ban.BannedPlayerId,
					bannedByAccountId: ban.BannedByAccountId,
					banStartTime: ban.CreatedAt,
				}))
			)
		}
	)

	// Ban a player from a room (form body `id` + `banMask`). Auth-gated (401), then
	// gated to the room's owner/co-owner OR a staff token (403). One row per
	// (room, player) — re-banning rewrites it, so the call is idempotent.
	.post(
		'/rooms/:roomId{[0-9]+}/bans',
		describeRoute({
			tags: ['Room settings'],
			summary: 'Ban a player from a room',
			description: [
				'Records a ban in the `room_ban` table — one row per (room, player), so re-banning',
				'someone already banned rewrites their row rather than adding a second. The row is',
				'what the `match` worker checks: a banned player’s matchmake into this room is',
				'refused with errorCode 55 and never gets a Photon room id.',
				'',
				'Gated to the room’s creator or a co-owner, OR to any account whose token carries the',
				'`developer` / `moderator` role — a valid token from anyone else is a 403. Banning',
				'yourself, or banning someone who can manage the room, is refused: otherwise a',
				'co-owner could ban the owner out of their own room.',
				'',
				'`banMask` is stored verbatim and nothing interprets it — the client sends `0` and',
				'what it selects is not known yet. It defaults to 0 when absent.',
				'',
				'The BANNED player (not the caller) gets a `ModerationKick` push (id 22) — the frame',
				'the client acts on to eject someone — so a ban takes effect immediately rather than',
				'only at their next matchmake. `isBan` is true, `duration` 0 (a room ban has no',
				'expiry; it is lifted by DELETE, not by time) and `reportCategory` -1 (Moderator).',
				'',
				'`isHostKick` means the room’s HOST ejected them rather than the room majority',
				'vote-kicking them; with no vote-kick path yet the only false case is a staff',
				'moderator acting in a room they do not host. `playerIdReporter` is whoever caused',
				'it — the host today, the player who started the vote once vote-kicks exist. The hub',
				'queues the frame if they are offline.',
				'',
				'Answers the same lowercase `{ success, error, value }` envelope the room writes use,',
				'but `value` is the BAN, not the room — a ban is not part of the room the client',
				'renders. This shape is unverified against the real service.',
			].join('\n'),
			security: AUTHED,
			parameters: [roomIdParam],
			requestBody: form(BanRequest, 'The player to ban'),
			responses: {
				200: json(RoomBanEnvelope, 'The stored ban, or a rejection with `success: false`'),
				401: UNAUTHORIZED_RESPONSE,
				403: FORBIDDEN_RESPONSE,
			},
		}),
		async (c) => {
			const accountId = await authedAccountId(c)
			if (accountId === null) return unauthorized(c)

			const roomId = Number.parseInt(c.req.param('roomId'), 10)
			const room = await getRoomById(c.env.DB, roomId)
			if (!room) return banEnvelope(c, null, 'This room does not exist!')

			// The room's own owners, or a staffer acting across rooms. Roles are only
			// looked up when the cheaper room check fails. The room's own owner IS the
			// host, which is what the kick frame's `isHostKick` reports.
			const isHostKick = canManageRoom(room, accountId)
			if (!isHostKick && !(await isStaff(c))) return c.body(null, 403)

			const body = (await c.req.parseBody().catch(() => ({}))) as Record<string, unknown>
			const str = (v: unknown): string => (typeof v === 'string' ? v : '')
			const bannedPlayerId = Number.parseInt(str(body.id), 10)
			if (Number.isNaN(bannedPlayerId)) {
				return banEnvelope(c, null, 'You must provide a valid player to ban!')
			}
			if (bannedPlayerId === accountId) return banEnvelope(c, null, 'You cannot ban yourself!')
			// Without this a co-owner could ban the room's creator out of their own room.
			if (canManageRoom(room, bannedPlayerId)) {
				return banEnvelope(c, null, 'You cannot ban an owner of this room!')
			}
			// Absent or unparseable → 0, the value the client sends.
			const banMask = Number.parseInt(str(body.banMask), 10) || 0

			const ban = await banPlayerFromRoom(c.env.DB, roomId, bannedPlayerId, banMask, accountId)
			// The banned player is told, not the caller — their client acts on the kick.
			const roomName = typeof room.Name === 'string' ? room.Name : 'this room'
			await pushRoomBan(c, ban, roomName, isHostKick)
			return banEnvelope(c, ban)
		}
	)

	// Lift a player's ban on a room. Same gate as issuing one: auth-gated (401), then the
	// room's owner/co-owner OR a staff token (403).
	.delete(
		'/rooms/:roomId{[0-9]+}/bans/:playerId{[0-9]+}',
		describeRoute({
			tags: ['Room settings'],
			summary: 'Unban a player from a room',
			description: [
				'Removes the player’s `room_ban` row, so they can matchmake into the room again.',
				'Gated exactly like issuing a ban: the room’s creator or a co-owner, or an account',
				'whose token carries the `developer` / `moderator` role.',
				'',
				'Unbanning someone who is not banned is a rejection (`success: false`), not a silent',
				'success — the caller asked to undo something that was not there.',
				'',
				'Answers the same envelope as the ban write, with the REMOVED ban as `value`. No',
				'notification is pushed: nothing tells a player their ban was lifted.',
			].join('\n'),
			security: AUTHED,
			parameters: [roomIdParam, bannedPlayerIdParam],
			responses: {
				200: json(RoomBanEnvelope, 'The removed ban, or a rejection with `success: false`'),
				401: UNAUTHORIZED_RESPONSE,
				403: FORBIDDEN_RESPONSE,
			},
		}),
		async (c) => {
			const accountId = await authedAccountId(c)
			if (accountId === null) return unauthorized(c)

			const roomId = Number.parseInt(c.req.param('roomId'), 10)
			const room = await getRoomById(c.env.DB, roomId)
			if (!room) return banEnvelope(c, null, 'This room does not exist!')
			if (!canManageRoom(room, accountId) && !(await isStaff(c))) return c.body(null, 403)

			const playerId = Number.parseInt(c.req.param('playerId'), 10)
			const removed = await unbanPlayerFromRoom(c.env.DB, roomId, playerId)
			if (!removed) return banEnvelope(c, null, 'This player is not banned from this room!')
			return banEnvelope(c, removed)
		}
	)

	// Set a room's content warning: the `WarningMask` bit flags plus an optional
	// free-text `CustomWarning`. Auth-gated (401) and owner/co-owner-only (403). Body is
	// the `warningMask` form field (an integer) and an optional `customWarning` string
	// (set when present — an empty value clears it). Returns the updated room in the
	// `{ success, error, value }` envelope.
	.put(
		'/rooms/:roomId{[0-9]+}/warning',
		describeRoute({
			tags: ['Room settings'],
			summary: 'Set a room’s content warning',
			description: [
				'The `WarningMask` bit flags plus an optional free-text `CustomWarning`. Owner or',
				'co-owner only (403 otherwise). `CustomWarning` is only touched when the field is',
				'present — sending it empty clears it, omitting it leaves it alone.',
			].join(' '),
			security: AUTHED,
			parameters: [roomIdParam],
			requestBody: form(WarningRequest, 'The warning flags and optional custom text'),
			responses: {
				200: json(RoomEnvelope, 'The updated room, or a rejection with `success: false`'),
				401: UNAUTHORIZED_RESPONSE,
				403: FORBIDDEN_RESPONSE,
			},
		}),
		async (c) => {
			const accountId = await authedAccountId(c)
			if (accountId === null) return unauthorized(c)

			const roomId = Number.parseInt(c.req.param('roomId'), 10)
			const room = await getRoomById(c.env.DB, roomId)
			if (!room) return roomEnvelope(c, null, 'This room does not exist!')
			// A valid token but not the room's owner/co-owner → 403 (the auth gate above
			// already returned 401 for a missing/invalid token).
			if (!canManageRoom(room, accountId)) return c.body(null, 403)

			const body = (await c.req.parseBody().catch(() => ({}))) as Record<string, unknown>
			const warningMask =
				typeof body.warningMask === 'string' ? Number.parseInt(body.warningMask, 10) : Number.NaN
			if (Number.isNaN(warningMask))
				return roomEnvelope(c, null, 'You must provide a valid warning mask!')

			const patch: Record<string, unknown> = { WarningMask: warningMask }
			// Only touch CustomWarning when the field is present (an empty string clears it).
			if (typeof body.customWarning === 'string') patch.CustomWarning = body.customWarning

			const updated = await updateRoomFields(c.env.DB, roomId, room, patch)
			// Notify the owner so their client refreshes the room with the updated warning.
			await pushRoomUpdate(c, accountId, updated)
			return roomEnvelope(c, updated)
		}
	)

	// Toggle whether a room may be cloned (`CloningAllowed`). Auth-gated (401) and
	// owner/co-owner-only (403). Body is the `cloningAllowed` form field (`True`/`False`).
	// Returns the updated room in the `{ success, error, value }` envelope.
	.put(
		'/rooms/:roomId{[0-9]+}/cloning',
		describeRoute({
			tags: ['Room settings'],
			summary: 'Allow or block cloning of a room',
			description: [
				'Sets `CloningAllowed` — false makes `POST /rooms/{roomId}/clone` refuse. Owner or',
				'co-owner only (403 otherwise).',
			].join(' '),
			security: AUTHED,
			parameters: [roomIdParam],
			requestBody: form(CloningRequest, 'Whether cloning is allowed'),
			responses: {
				200: json(RoomEnvelope, 'The updated room, or a rejection with `success: false`'),
				401: UNAUTHORIZED_RESPONSE,
				403: FORBIDDEN_RESPONSE,
			},
		}),
		async (c) => {
			const accountId = await authedAccountId(c)
			if (accountId === null) return unauthorized(c)

			const roomId = Number.parseInt(c.req.param('roomId'), 10)
			const room = await getRoomById(c.env.DB, roomId)
			if (!room) return roomEnvelope(c, null, 'This room does not exist!')
			// A valid token but not the room's owner/co-owner → 403 (the auth gate above
			// already returned 401 for a missing/invalid token).
			if (!canManageRoom(room, accountId)) return c.body(null, 403)

			const body = (await c.req.parseBody().catch(() => ({}))) as Record<string, unknown>
			if (typeof body.cloningAllowed !== 'string') {
				return roomEnvelope(c, null, 'You must provide cloningAllowed.')
			}
			const cloningAllowed = body.cloningAllowed.toLowerCase() === 'true'

			const updated = await updateRoomFields(c.env.DB, roomId, room, {
				CloningAllowed: cloningAllowed,
			})
			await pushRoomUpdate(c, accountId, updated)
			return roomEnvelope(c, updated)
		}
	)

	// Set a room's platform/movement support flags (its `Supports*` restrictions).
	// Auth-gated (401) and owner/co-owner-only (403). Body is a form of
	// `supports*=True|False` fields (see RESTRICTION_FIELDS); only the fields present
	// are changed. Returns the updated room in the `{ success, error, value }` envelope.
	.put(
		'/rooms/:roomId{[0-9]+}/restrictions',
		describeRoute({
			tags: ['Room settings'],
			summary: 'Set a room’s platform/movement support flags',
			description: [
				'The room’s `Supports*` restrictions — which platforms and movement modes may enter.',
				'Owner or co-owner only (403 otherwise). Only the fields actually posted are changed,',
				'and field names are matched case-insensitively.',
			].join(' '),
			security: AUTHED,
			parameters: [roomIdParam],
			requestBody: form(RestrictionsRequest, 'The flags to change'),
			responses: {
				200: json(RoomEnvelope, 'The updated room, or a rejection with `success: false`'),
				401: UNAUTHORIZED_RESPONSE,
				403: FORBIDDEN_RESPONSE,
			},
		}),
		async (c) => {
			const accountId = await authedAccountId(c)
			if (accountId === null) return unauthorized(c)

			const roomId = Number.parseInt(c.req.param('roomId'), 10)
			const room = await getRoomById(c.env.DB, roomId)
			if (!room) return roomEnvelope(c, null, 'This room does not exist!')
			// A valid token but not the room's owner/co-owner → 403 (the auth gate above
			// already returned 401 for a missing/invalid token).
			if (!canManageRoom(room, accountId)) return c.body(null, 403)

			const body = (await c.req.parseBody().catch(() => ({}))) as Record<string, unknown>
			const patch: Record<string, boolean> = {}
			for (const [key, value] of Object.entries(body)) {
				const field = RESTRICTION_FIELDS[key.toLowerCase()]
				if (field !== undefined && typeof value === 'string') {
					patch[field] = value.toLowerCase() === 'true'
				}
			}

			const updated = await updateRoomFields(c.env.DB, roomId, room, patch)
			await pushRoomUpdate(c, accountId, updated)
			return roomEnvelope(c, updated)
		}
	)

	// Set a room's load screen (`LoadScreens[]` — the image shown while the room loads).
	// Auth-gated (401) and owner/co-owner-only (403). Body is the `imageName` form field
	// plus optional `title`/`subtitle`. REPLACES the list with the single posted
	// `{ ImageName, Title, Subtitle }` and returns the updated room in the
	// `{ success, error, value }` envelope.
	//
	// The field is an array because the client's parser wants one, but the client only
	// ever renders (and only ever posts) a single screen — appending left the old screen
	// in slot 0 and the new one unreachable behind it, so setting a load screen appeared
	// to do nothing. Kept as an array so multi-screen support can land without a
	// migration.
	.put(
		'/rooms/:roomId{[0-9]+}/loadscreen',
		describeRoute({
			tags: ['Room settings'],
			summary: 'Set a room’s load screen',
			description: [
				'REPLACES the room’s `LoadScreens` with the single posted `{ ImageName, Title,',
				'Subtitle }` — the image shown while the room loads. The field is an array (the',
				'client’s parser expects one) but the client only supports a single screen, so this',
				'never appends. Owner or co-owner only (403 otherwise).',
			].join(' '),
			security: AUTHED,
			parameters: [roomIdParam],
			requestBody: form(LoadScreenRequest, 'The load screen to set'),
			responses: {
				200: json(RoomEnvelope, 'The updated room, or a rejection with `success: false`'),
				401: UNAUTHORIZED_RESPONSE,
				403: FORBIDDEN_RESPONSE,
			},
		}),
		async (c) => {
			const accountId = await authedAccountId(c)
			if (accountId === null) return unauthorized(c)

			const roomId = Number.parseInt(c.req.param('roomId'), 10)
			const room = await getRoomById(c.env.DB, roomId)
			if (!room) return roomEnvelope(c, null, 'This room does not exist!')
			// A valid token but not the room's owner/co-owner → 403 (the auth gate above
			// already returned 401 for a missing/invalid token).
			if (!canManageRoom(room, accountId)) return c.body(null, 403)

			const body = (await c.req.parseBody().catch(() => ({}))) as Record<string, unknown>
			const imageName = typeof body.imageName === 'string' ? body.imageName.trim() : ''
			if (imageName === '') return roomEnvelope(c, null, 'You must provide an image!')
			const title = typeof body.title === 'string' ? body.title : ''
			const subtitle = typeof body.subtitle === 'string' ? body.subtitle : ''

			// The posted screen becomes the whole list — the client shows one load screen.
			const loadScreens = [{ ImageName: imageName, Title: title, Subtitle: subtitle }]
			const updated = await updateRoomFields(c.env.DB, roomId, room, { LoadScreens: loadScreens })
			await pushRoomUpdate(c, accountId, updated)
			return roomEnvelope(c, updated)
		}
	)

	// Set a room's top-level `Accessibility` (the visibility the public-room/search
	// filters key on — see the RoomAccessibility enum). Auth-gated (401) and
	// owner/co-owner-only (403). Body is the `accessibility` form field (an integer).
	// Returns the updated room in the `{ success, error, value }` envelope.
	.put(
		'/rooms/:roomId{[0-9]+}/accessibility',
		describeRoute({
			tags: ['Room settings'],
			summary: 'Set a room’s accessibility',
			description: [
				'The room’s top-level visibility — the field the public-room and search filters key',
				'on (0 Private, 1 Public, 2 Unlisted). Owner or co-owner only (403 otherwise).',
				'Subrooms carry their own `Accessibility`, set through the subroom `modify` call.',
			].join(' '),
			security: AUTHED,
			parameters: [roomIdParam],
			requestBody: form(AccessibilityRequest, 'The new accessibility'),
			responses: {
				200: json(RoomEnvelope, 'The updated room, or a rejection with `success: false`'),
				401: UNAUTHORIZED_RESPONSE,
				403: FORBIDDEN_RESPONSE,
			},
		}),
		async (c) => {
			const accountId = await authedAccountId(c)
			if (accountId === null) return unauthorized(c)

			const roomId = Number.parseInt(c.req.param('roomId'), 10)
			const room = await getRoomById(c.env.DB, roomId)
			if (!room) return roomEnvelope(c, null, 'This room does not exist!')
			// A valid token but not the room's owner/co-owner → 403 (the auth gate above
			// already returned 401 for a missing/invalid token).
			if (!canManageRoom(room, accountId)) return c.body(null, 403)

			const body = (await c.req.parseBody().catch(() => ({}))) as Record<string, unknown>
			const accessibility =
				typeof body.accessibility === 'string'
					? Number.parseInt(body.accessibility, 10)
					: Number.NaN
			if (Number.isNaN(accessibility)) {
				return roomEnvelope(c, null, 'You must provide a valid accessibility!')
			}

			const updated = await updateRoomFields(c.env.DB, roomId, room, {
				Accessibility: accessibility,
			})
			await pushRoomUpdate(c, accountId, updated)
			return roomEnvelope(c, updated)
		}
	)

	// A subroom's saved-data versions — the room-history / "restore a save" list. Every
	// save is its own `subroom_save` row (nothing is overwritten), so this is real
	// history, newest first, paged by skip/take. Auth-gated (401), and readable by the
	// room's creator or anyone whose presence puts them in the room (see `canReadSaves`).
	.get(
		'/rooms/:roomId{[0-9]+}/subrooms/:subRoomId{[0-9]+}/saves',
		describeRoute({
			tags: ['Subrooms'],
			summary: 'A subroom’s saved-data versions',
			description: [
				'The room-history / “restore a save” list, newest first. Every room save appends a',
				'row rather than overwriting, so this is the subroom’s full history; it is empty',
				'only when the subroom has never been saved.',
				'`unityAssetTarget`/`unityAssetVersion` are accepted and ignored.',
				'',
				'The list includes STAGED saves that were never published, so it is not public:',
				'the room’s creator may read it, and so may anyone standing IN the room (their live',
				'presence says so). Anyone else is a 403. It is what the client reads to resolve',
				'“load the latest or the published version?” on entering a private instance — a',
				'visitor who cannot read it cannot load what the instance is running.',
				'',
				'`TotalResults` and `TotalCount` carry the same number: the client’s paged DTO and',
				'the reference disagree on the name, so both are emitted.',
			].join(' '),
			security: AUTHED,
			parameters: [
				roomIdParam,
				subRoomIdParam,
				stringQuery('unityAssetTarget', 'Accepted and ignored'),
				stringQuery('unityAssetVersion', 'Accepted and ignored'),
				stringQuery('skip', 'How many saves to skip (default 0)'),
				stringQuery('take', 'How many saves to return (default all)'),
			],
			responses: {
				200: json(SubRoomSavesPage, 'The subroom’s saves, newest first'),
				401: UNAUTHORIZED_RESPONSE,
				403: FORBIDDEN_RESPONSE,
			},
		}),
		async (c) => {
			const accountId = await authedAccountId(c)
			if (accountId === null) return unauthorized(c)

			const roomId = Number.parseInt(c.req.param('roomId'), 10)
			const subRoomId = Number.parseInt(c.req.param('subRoomId'), 10)
			// Scoped through the room so a subroom id from another room can't read its saves.
			const room = await getRoomById(c.env.DB, roomId)
			if (!room || !findSubRoom(room, subRoomId)) {
				return c.json({ Results: [], TotalResults: 0, TotalCount: 0 })
			}
			if (!(await canReadSaves(c, room, roomId, accountId))) return c.body(null, 403)
			const saves = await getSubRoomSaves(c.env.DB, subRoomId)

			const skip = Number.parseInt(c.req.query('skip') ?? '', 10)
			const take = Number.parseInt(c.req.query('take') ?? '', 10)
			const from = Number.isNaN(skip) || skip < 0 ? 0 : skip
			const page = saves.slice(from, Number.isNaN(take) || take < 0 ? undefined : from + take)

			return c.json({ Results: page, TotalResults: saves.length, TotalCount: saves.length })
		}
	)

	// The same history list, with the Unity-asset payloads left out. The rows are the
	// `…/saves` rows minus `UnitySubAssets`/`ReferencedUnityAssets`/`Tags` — the heavy part
	// of a save row, which a history list never renders — keeping the asset IDENTIFIERS.
	//
	// It answers a BARE paged wrapper: no `{ success, error, value }` envelope, unlike the
	// room mutations next door. Same gate, same paging and the same empty page for an
	// unknown room/subroom as `…/saves`, so the two can be swapped for one another.
	//
	// The `:saveId` detail route below is digit-constrained, so `no_unity_assets` can never
	// be read as a save id whichever order these are declared in.
	.get(
		'/rooms/:roomId{[0-9]+}/subrooms/:subRoomId{[0-9]+}/saves/no_unity_assets',
		describeRoute({
			tags: ['Subrooms'],
			summary: 'A subroom’s saves, without their Unity-asset payloads',
			description: [
				'The same page as `…/saves`, newest first, carrying the lighter rows: no',
				'`UnitySubAssets`, no `ReferencedUnityAssets`, no `Tags` — only the asset ids. A BARE',
				'paged wrapper, with no `{ success, error, value }` envelope around it.',
				'',
				'Gated exactly like `…/saves`, and for the same reason: the list includes STAGED',
				'saves that were never published, so it is the room’s creator or anyone whose live',
				'presence puts them in the room, and anyone else is a 403.',
				'',
				'`TotalResults` and `TotalCount` carry the same number — the client’s paged DTO and',
				'the reference disagree on the name, so both are emitted.',
			].join(' '),
			security: AUTHED,
			parameters: [
				roomIdParam,
				subRoomIdParam,
				stringQuery('skip', 'How many saves to skip (default 0)'),
				stringQuery('take', 'How many saves to return (default all)'),
			],
			responses: {
				200: json(SubRoomSavesNoUnityAssetsPage, 'The subroom’s saves, newest first'),
				401: UNAUTHORIZED_RESPONSE,
				403: FORBIDDEN_RESPONSE,
			},
		}),
		async (c) => {
			const accountId = await authedAccountId(c)
			if (accountId === null) return unauthorized(c)

			const roomId = Number.parseInt(c.req.param('roomId'), 10)
			const subRoomId = Number.parseInt(c.req.param('subRoomId'), 10)
			// Scoped through the room so a subroom id from another room can't read its saves.
			const room = await getRoomById(c.env.DB, roomId)
			if (!room || !findSubRoom(room, subRoomId)) {
				return c.json({ Results: [], TotalResults: 0, TotalCount: 0 })
			}
			if (!(await canReadSaves(c, room, roomId, accountId))) return c.body(null, 403)
			const saves = await getSubRoomSaves(c.env.DB, subRoomId)

			const skip = Number.parseInt(c.req.query('skip') ?? '', 10)
			const take = Number.parseInt(c.req.query('take') ?? '', 10)
			const from = Number.isNaN(skip) || skip < 0 ? 0 : skip
			const page = saves.slice(from, Number.isNaN(take) || take < 0 ? undefined : from + take)

			// `TotalResults` counts the whole history, not the page — that is what the client
			// pages against.
			return c.json({
				Results: page.map(toSaveWithoutUnityAssets),
				TotalResults: saves.length,
				TotalCount: saves.length,
			})
		}
	)

	// One of a subroom's saves by id — the detail behind a row of the `…/saves` list.
	// Same gate as that list: a save id resolves whether or not it was ever published, so
	// this exposes the same unpublished work, to the same readers.
	.get(
		'/rooms/:roomId{[0-9]+}/subrooms/:subRoomId{[0-9]+}/saves/:saveId{[0-9]+}',
		describeRoute({
			tags: ['Subrooms'],
			summary: 'One of a subroom’s saves by id',
			description: [
				'A single save, in the SAME camelCase projection the room save that created it',
				'returned — not the PascalCase rows `…/saves` lists. Save ids are globally',
				'unique but resolved scoped to the subroom, so one subroom cannot read another’s',
				'save by guessing an id: a save that belongs elsewhere is a 404, same as an unknown',
				'one.',
				'',
				'Gated like the list it details — the room’s creator, or anyone whose presence puts',
				'them in the room. A save id resolves whether or not it was ever published, so this',
				'reads unpublished work.',
			].join(' '),
			security: AUTHED,
			parameters: [roomIdParam, subRoomIdParam, saveIdParam],
			responses: {
				200: json(SubRoomDataSaveResponseDto, 'The save'),
				401: UNAUTHORIZED_RESPONSE,
				403: FORBIDDEN_RESPONSE,
				404: { description: 'No such room, subroom, or save on that subroom' },
			},
		}),
		async (c) => {
			const accountId = await authedAccountId(c)
			if (accountId === null) return unauthorized(c)

			const roomId = Number.parseInt(c.req.param('roomId'), 10)
			const subRoomId = Number.parseInt(c.req.param('subRoomId'), 10)
			const saveId = Number.parseInt(c.req.param('saveId'), 10)

			// Scoped through the room, like the list, so a subroom id from another room can't
			// be used to read its saves.
			const room = await getRoomById(c.env.DB, roomId)
			if (!room || !findSubRoom(room, subRoomId)) return c.notFound()
			if (!(await canReadSaves(c, room, roomId, accountId))) return c.body(null, 403)

			const save = await getSubRoomSaveById(c.env.DB, subRoomId, saveId)
			return save ? c.json(toSaveResponse(save)) : c.notFound()
		}
	)

	// Save a subroom's data (room save). Auth-gated (401 with empty body). Editable
	// by the room creator or a Creator/CoOwner role holder. Points the subroom at
	// the uploaded data blobs and records the revision's fields against that SUBROOM,
	// notifies the owner, and returns the updated ROOM in the lowercase
	// `{ success, error, value }` envelope the reference's SetRoomData uses.
	.post(
		'/rooms/:roomId{[0-9]+}/subrooms/:subRoomId{[0-9]+}/data',
		describeRoute({
			tags: ['Subrooms'],
			summary: 'Save a subroom’s data (room save)',
			description: [
				'Records a save against the subroom from the blobs the client has already uploaded',
				'through the `storage` worker. Everything the body carries describes THAT revision',
				'and lands on the save and its subroom — `Description` is the save comment, NOT the',
				'room’s description (only `PUT /rooms/{roomId}/description` sets that). Nothing here',
				'writes to the room. Editable by the room’s creator or a co-owner (403 otherwise); a',
				'missing token is an EMPTY-body 401, unlike the other room writes.',
				'',
				'`AutoPublish: true` makes the save live immediately. Otherwise it is STAGED: it',
				'lands on `StagedSubRoomDataSaveId` with the live `CurrentSave` untouched, so',
				'players keep loading the last published version until the owner calls',
				'`POST …/subrooms/{subRoomId}/publish_save`. DORMS always publish — they have no',
				'publish step in the client, so staging one would hide the player’s own edits.',
				'',
				'`value` carries BOTH the updated `room` and the `subRoomDataSave` just created,',
				'and `error` is NULL here rather than the empty string the other room envelopes',
				'use. The save is projected in camelCase with a different field set from the',
				'PascalCase `CurrentSave` embedded in the room — the two are not the same shape.',
				'A subroom with no `CreatorAccountId` yet (the seeded rooms start null) gets the',
				'saver’s id here, because the client NREs on a null one.',
			].join('\n'),
			security: AUTHED,
			parameters: [roomIdParam, subRoomIdParam],
			requestBody: jsonBody(SaveSubRoomDataRequest, 'The uploaded blob keys and save fields'),
			responses: {
				200: json(RoomSaveEnvelope, 'The updated room + the new save, or a rejection'),
				401: UNAUTHORIZED_EMPTY,
				403: FORBIDDEN_RESPONSE,
			},
		}),
		async (c) => {
			const accountId = await authedAccountId(c)
			if (accountId === null) return c.body(null, 401)

			const roomId = Number.parseInt(c.req.param('roomId'), 10)
			const subRoomId = Number.parseInt(c.req.param('subRoomId'), 10)

			const room = await getRoomById(c.env.DB, roomId)
			if (!room) {
				return c.json({ success: false, error: 'This room does not exist!', value: null })
			}
			// A valid token but not the room's owner/co-owner → 403 (the auth gate above
			// already returned 401 for a missing/invalid token).
			if (!canManageRoom(room, accountId)) return c.body(null, 403)

			// The client uploads BOTH blobs to `storage` first and sends their keys here:
			// `SubRoomData` is the scene blob (what the loader downloads), `RoomData` the
			// metadata blob. `OwnershipProof` is accepted and ignored.
			const body = (await c.req.json().catch(() => ({}))) as {
				RoomData?: { Filename?: string }
				SubRoomData?: { Filename?: string; Hash?: string | null }
				UnityAssetId?: string | null
				Description?: string
				PersistenceVersion?: number
				InventionUsage?: string
				AutoPublish?: boolean
			}

			const result = await saveSubRoomData(c.env.DB, roomId, subRoomId, accountId, {
				subRoomDataFilename: body.SubRoomData?.Filename,
				subRoomDataHash:
					typeof body.SubRoomData?.Hash === 'string' ? body.SubRoomData.Hash : undefined,
				roomDataFilename: body.RoomData?.Filename,
				unityAssetId: typeof body.UnityAssetId === 'string' ? body.UnityAssetId : undefined,
				autoPublish: body.AutoPublish === true,
				description: typeof body.Description === 'string' ? body.Description : undefined,
				persistenceVersion:
					typeof body.PersistenceVersion === 'number' ? body.PersistenceVersion : undefined,
				inventionUsage: typeof body.InventionUsage === 'string' ? body.InventionUsage : undefined,
			})
			if (!result) {
				return c.json({ success: false, error: 'This subroom does not exist!', value: null })
			}

			// `value` carries BOTH the updated room and the save just created — and `error`
			// is null here, not the empty string the other room envelopes use.
			await pushRoomUpdate(c, accountId, result.room)
			return c.json({
				success: true,
				error: null,
				value: { room: result.room, subRoomDataSave: toSaveResponse(result.save) },
			})
		}
	)

	// Modify a subroom's settings (Name/Accessibility/MaxPlayers) from the form body.
	// Auth-gated (401) and owner-only — only the room creator may change its subrooms.
	// Notifies the owner (RoomUpdate) and returns the `{ Success, Value, ErrorId, Error }`
	// envelope at HTTP 200, matching the other owner-gated room mutations.
	.put(
		'/rooms/:roomId{[0-9]+}/subrooms/:subRoomId{[0-9]+}/modify',
		describeRoute({
			tags: ['Subrooms'],
			summary: 'Modify a subroom’s settings',
			description: [
				'Sets a subroom’s `Name`, `Accessibility` and `MaxPlayers`. Owner-only — only the',
				'room’s creator may change its subrooms, not co-owners. `name` is required;',
				'`accessibility` and `maxPlayers` are applied only when supplied, and a non-positive',
				'`maxPlayers` is ignored rather than rejected.',
			].join(' '),
			security: AUTHED,
			parameters: [roomIdParam, subRoomIdParam],
			requestBody: form(ModifySubRoomRequest, 'The settings to change'),
			responses: {
				200: json(RoomResultEnvelope, 'Success, or a rejection carrying an `ErrorId`'),
				401: UNAUTHORIZED_RESPONSE,
			},
		}),
		async (c) => {
			const accountId = await authedAccountId(c)
			if (accountId === null) return unauthorized(c)

			const roomId = Number.parseInt(c.req.param('roomId'), 10)
			const subRoomId = Number.parseInt(c.req.param('subRoomId'), 10)

			const room = await getRoomById(c.env.DB, roomId)
			if (!room) {
				return roomResult(c, {
					Success: false,
					ErrorId: 'Rooms.DoesntExist',
					Error: 'This room does not exist!',
				})
			}
			if (room.CreatorAccountId !== accountId) {
				return roomResult(c, {
					Success: false,
					ErrorId: 'Rooms.NotOwner',
					Error: 'You are not the owner of this room!',
				})
			}
			if (!findSubRoom(room, subRoomId)) {
				return roomResult(c, {
					Success: false,
					ErrorId: 'Rooms.DoesntExist',
					Error: 'This subroom does not exist!',
				})
			}

			const body = (await c.req.parseBody().catch(() => ({}))) as Record<string, unknown>
			const name = typeof body.name === 'string' ? body.name.trim() : ''
			if (name === '') {
				return roomResult(c, {
					Success: false,
					ErrorId: 'Rooms.InvalidName',
					Error: 'You must enter a name for your room!',
				})
			}
			const badName = roomNameRejection(name, 'subroom name')
			if (badName !== null) {
				return roomResult(c, { Success: false, ErrorId: 'Rooms.InvalidName', Error: badName })
			}
			const maxPlayers =
				typeof body.maxPlayers === 'string' ? Number.parseInt(body.maxPlayers, 10) : Number.NaN

			const updated = await modifySubRoom(c.env.DB, roomId, subRoomId, {
				name,
				// Accepts the enum name as well as the ordinal — the dedicated
				// `/accessibility` route below is sent names, so this may be too.
				accessibility: parseAccessibility(body.accessibility),
				maxPlayers: Number.isNaN(maxPlayers) || maxPlayers <= 0 ? undefined : maxPlayers,
			})
			if (!updated) {
				return roomResult(c, {
					Success: false,
					ErrorId: 'Rooms.DoesntExist',
					Error: 'This subroom does not exist!',
				})
			}

			await pushRoomUpdate(c, accountId, updated)
			return roomResult(c, { Success: true })
		}
	)

	// Publish a subroom's staged save — promote it to the live one players load. Every
	// non-dorm room save only STAGES (see the save route), so this is the manual step that
	// makes edits visible. Auth-gated (401) and creator-only: co-owners may save, but
	// only the room's owner decides what goes live. Answers the updated ROOM in the
	// `{ success, error, value }` envelope, like the other subroom mutations.
	.post(
		'/rooms/:roomId{[0-9]+}/subrooms/:subRoomId{[0-9]+}/publish_save',
		describeRoute({
			tags: ['Subrooms'],
			summary: 'Publish one of a subroom’s saves',
			description: [
				'Makes the save named by the `subRoomDataSaveId` form field the one players load —',
				'it becomes the subroom’s `CurrentSave`. A room save only STAGES (dorms excepted),',
				'so nothing a creator saves reaches players until this is called.',
				'',
				'The id may be any save in the subroom’s history, so this doubles as restore-a-save.',
				'`StagedSubRoomDataSaveId` is cleared only when the published save IS the staged',
				'one — restoring an older version keeps newer unpublished work staged.',
				'',
				'Owner-only: co-owners may save but not decide what goes live. A save id belonging',
				'to another subroom is rejected.',
			].join(' '),
			security: AUTHED,
			parameters: [roomIdParam, subRoomIdParam],
			requestBody: form(PublishSaveRequest, 'The save to publish'),
			responses: {
				200: json(RoomEnvelope, 'The updated room, or a rejection with `success: false`'),
				401: UNAUTHORIZED_ENVELOPE,
			},
		}),
		async (c) => {
			const accountId = await authedAccountId(c)
			if (accountId === null) {
				return c.json({ success: false, error: 'Unauthorized', value: null }, 401)
			}

			const roomId = Number.parseInt(c.req.param('roomId'), 10)
			const subRoomId = Number.parseInt(c.req.param('subRoomId'), 10)

			const room = await getRoomById(c.env.DB, roomId)
			if (!room) return roomEnvelope(c, null, 'This room does not exist!')
			if (room.CreatorAccountId !== accountId) {
				return roomEnvelope(c, null, 'You are not the owner of this room!')
			}

			const body = (await c.req.parseBody().catch(() => ({}))) as Record<string, unknown>
			const saveId =
				typeof body.subRoomDataSaveId === 'string'
					? Number.parseInt(body.subRoomDataSaveId, 10)
					: Number.NaN
			if (Number.isNaN(saveId)) {
				return roomEnvelope(c, null, 'You must provide a valid save!')
			}

			const result = await publishSubRoomSave(c.env.DB, roomId, subRoomId, saveId)
			if (!result.ok) {
				return roomEnvelope(
					c,
					null,
					result.reason === 'unknown_save'
						? 'That save does not exist!'
						: 'This subroom does not exist!'
				)
			}

			await pushRoomUpdate(c, accountId, result.room)
			return roomEnvelope(c, result.room)
		}
	)

	// Set a single subroom's `Accessibility`. Same effect as the `accessibility` field of
	// the subroom `modify` call, but this is what the client actually calls when the
	// player flips one subroom's visibility, and the body carries the enum NAME
	// (`accessibility=Private`), not the number the room-level `/accessibility` takes.
	// Auth-gated (401) and owner-only, like the other subroom mutations. Answers the
	// updated ROOM in the `{ success, error, value }` envelope — the client re-renders
	// the room's subroom list from `value`, the same as subroom create/delete.
	.put(
		'/rooms/:roomId{[0-9]+}/subrooms/:subRoomId{[0-9]+}/accessibility',
		describeRoute({
			tags: ['Subrooms'],
			summary: 'Set a subroom’s accessibility',
			description: [
				'A subroom’s own visibility, independent of the room’s top-level `Accessibility`.',
				'The client sends the `RoomAccessibility` NAME here (`accessibility=Private`) rather',
				'than the ordinal the room-level route takes, so both forms are accepted; an',
				'unrecognised value is rejected. Owner-only — only the room’s creator may change',
				'its subrooms, not co-owners.',
				'',
				'Answers the updated ROOM, not the bare subroom, so the client can re-render the',
				'room’s subroom list from `value`.',
			].join(' '),
			security: AUTHED,
			parameters: [roomIdParam, subRoomIdParam],
			requestBody: form(SubRoomAccessibilityRequest, 'The new accessibility'),
			responses: {
				200: json(RoomEnvelope, 'The updated room, or a rejection with `success: false`'),
				401: UNAUTHORIZED_ENVELOPE,
			},
		}),
		async (c) => {
			const accountId = await authedAccountId(c)
			if (accountId === null) {
				return c.json({ success: false, error: 'Unauthorized', value: null }, 401)
			}

			const roomId = Number.parseInt(c.req.param('roomId'), 10)
			const subRoomId = Number.parseInt(c.req.param('subRoomId'), 10)

			const room = await getRoomById(c.env.DB, roomId)
			if (!room) return roomEnvelope(c, null, 'This room does not exist!')
			if (room.CreatorAccountId !== accountId) {
				return roomEnvelope(c, null, 'You are not the owner of this room!')
			}
			if (!findSubRoom(room, subRoomId)) {
				return roomEnvelope(c, null, 'This subroom does not exist!')
			}

			const body = (await c.req.parseBody().catch(() => ({}))) as Record<string, unknown>
			const accessibility = parseAccessibility(body.accessibility)
			if (accessibility === undefined) {
				return roomEnvelope(c, null, 'You must provide a valid accessibility!')
			}

			const updated = await modifySubRoom(c.env.DB, roomId, subRoomId, { accessibility })
			if (!updated) return roomEnvelope(c, null, 'This subroom does not exist!')

			await pushRoomUpdate(c, accountId, updated)
			return roomEnvelope(c, updated)
		}
	)

	// Set a subroom's permission overrides — what each role may do in that subroom. The
	// body is a JSON ARRAY of the entries to change, keyed by (Permission, Role): `Override`
	// is the client's checkbox, so true stores the entry for that pair and false clears it
	// back to the default. The stored table then overwrites the matching defaults in
	// `GET /photon_access_token`. Auth-gated (401) and creator-only (403), like the other
	// subroom mutations. Answers an EMPTY 200 — the client fires this and re-reads nothing,
	// so there is no envelope to match.
	.put(
		'/rooms/:roomId{[0-9]+}/subrooms/:subRoomId{[0-9]+}/permissions',
		describeRoute({
			tags: ['Subrooms'],
			summary: 'Set a subroom’s permissions',
			description: [
				'Stores the permission entries a room’s creator changed for one subroom — who may',
				'save inventions, invite players, use the delete-all button, and so on. The body is a',
				'JSON ARRAY; each entry is addressed by its (`Permission`, `Role`) pair, so re-sending',
				'a pair overwrites the stored entry rather than adding a second, and pairs that were',
				'never sent are left alone.',
				'',
				'`Override` is the checkbox the client draws beside each permission, not data:',
				'`true` stores `Value` for that pair, and `false` means “fall back to the default”, so',
				'it DELETES any stored entry. Nothing is stored with `Override: false`, and reads',
				'always serve `true`. `Value` is a string — usually `True`/`False`, but it is kept',
				'verbatim, since not every permission’s UI is a True/False picker.',
				'',
				'What this feeds is `GET /photon_access_token`: a stored entry replaces the default',
				'with the same (`Permission`, `Role`) in the table the client applies when it spawns,',
				'and one naming a pair the defaults don’t carry (e.g. `CAN_INVITE`) is added to it.',
				'The overrides apply to the subroom the caller is standing in, resolved from presence.',
				'',
				'Creator-only — co-owners may build in a room but not decide what a role may do.',
				'The response body is EMPTY: the client doesn’t read one.',
			].join('\n'),
			security: AUTHED,
			parameters: [roomIdParam, subRoomIdParam],
			requestBody: jsonBody(SubRoomPermissionsRequest, 'The permission entries to set'),
			responses: {
				200: { description: 'Stored (empty body)' },
				401: UNAUTHORIZED_RESPONSE,
				403: FORBIDDEN_RESPONSE,
				404: { description: 'No such room or subroom' },
			},
		}),
		async (c) => {
			const accountId = await authedAccountId(c)
			if (accountId === null) return unauthorized(c)

			const roomId = Number.parseInt(c.req.param('roomId'), 10)
			const subRoomId = Number.parseInt(c.req.param('subRoomId'), 10)

			// Scoped through the room so a subroom id from another room can't be written.
			const room = await getRoomById(c.env.DB, roomId)
			if (!room || !findSubRoom(room, subRoomId)) return c.notFound()
			if (room.CreatorAccountId !== accountId) return c.body(null, 403)

			const permissions = parseRoomPermissions(await c.req.json().catch(() => null))
			await setSubRoomPermissions(c.env.DB, subRoomId, permissions)
			return c.body(null, 200)
		}
	)

	// Clone a subroom into a new subroom of the same room (fresh SubRoomId, same
	// scene/settings/data). Auth-gated (401) and owner-only. Notifies the owner and
	// returns the updated ROOM in the `{ success, error, value }` envelope — NOT the new
	// subroom, even though the new subroom is what the call produces. The client
	// re-renders the room's subroom list from `value`, the same as subroom
	// create/delete/accessibility.
	.post(
		'/rooms/:roomId{[0-9]+}/subrooms/:subRoomId{[0-9]+}/clone',
		describeRoute({
			tags: ['Subrooms'],
			summary: 'Clone a subroom',
			description: [
				'Copies a subroom into a new subroom of the SAME room — same scene, settings and saved',
				'data blobs, so it loads identical content — with a fresh globally-unique `SubRoomId`.',
				'Owner-only.',
				'',
				'Answers the updated ROOM, not the new subroom — the client re-renders the room’s',
				'subroom list from `value`. Unlike the room-level `/clone`, whose `value` IS the new',
				'room, the thing this call creates is not what comes back.',
			].join('\n'),
			security: AUTHED,
			parameters: [roomIdParam, subRoomIdParam],
			responses: {
				200: json(RoomEnvelope, 'The updated room, or a rejection with `success: false`'),
				401: UNAUTHORIZED_ENVELOPE,
			},
		}),
		async (c) => {
			const accountId = await authedAccountId(c)
			if (accountId === null) {
				return c.json({ success: false, error: 'Unauthorized', value: null }, 401)
			}

			const roomId = Number.parseInt(c.req.param('roomId'), 10)
			const subRoomId = Number.parseInt(c.req.param('subRoomId'), 10)

			const room = await getRoomById(c.env.DB, roomId)
			if (!room) return roomEnvelope(c, null, 'This room does not exist!')
			if (room.CreatorAccountId !== accountId) {
				return roomEnvelope(c, null, 'You are not the owner of this room!')
			}

			const result = await cloneSubRoom(c.env.DB, roomId, subRoomId, accountId)
			if (!result) return roomEnvelope(c, null, 'This subroom does not exist!')

			await pushRoomUpdate(c, accountId, result.room)
			return roomEnvelope(c, result.room)
		}
	)

	// Create a new (empty) subroom in a room (form body `name`). Auth-gated (401) and
	// owner-only. Mints a fresh globally-unique SubRoomId, bases the scene/capacity on the
	// room's first subroom, notifies the owner (RoomUpdate), and returns the updated ROOM
	// in the `{ success, error, value }` envelope (the client re-renders the room's subroom
	// list from `value`, so it's the whole room, not the bare subroom).
	.post(
		'/rooms/:roomId{[0-9]+}/subrooms',
		describeRoute({
			tags: ['Subrooms'],
			summary: 'Create a subroom',
			description: [
				'Adds an empty subroom to a room. Owner-only. It mints a fresh globally-unique',
				'`SubRoomId` (the game numbers subrooms from one sequence, not per room) and inherits',
				'the scene and capacity of the room’s first existing subroom.',
				'',
				'Answers the updated ROOM, not the bare subroom — the client re-renders the room’s',
				'subroom list from `value`. Delete answers the same shape.',
			].join('\n'),
			security: AUTHED,
			parameters: [roomIdParam],
			requestBody: form(CreateSubRoomRequest, 'The new subroom’s name'),
			responses: {
				200: json(RoomEnvelope, 'The updated room, or a rejection with `success: false`'),
				401: UNAUTHORIZED_ENVELOPE,
			},
		}),
		async (c) => {
			const accountId = await authedAccountId(c)
			if (accountId === null) {
				return c.json({ success: false, error: 'Unauthorized', value: null }, 401)
			}

			const roomId = Number.parseInt(c.req.param('roomId'), 10)
			const room = await getRoomById(c.env.DB, roomId)
			if (!room) return roomEnvelope(c, null, 'This room does not exist!')
			if (room.CreatorAccountId !== accountId) {
				return roomEnvelope(c, null, 'You are not the owner of this room!')
			}

			const body = (await c.req.parseBody().catch(() => ({}))) as Record<string, unknown>
			const name = typeof body.name === 'string' ? body.name.trim() : ''
			if (name === '') return roomEnvelope(c, null, 'You must enter a name for your subroom!')
			const badName = roomNameRejection(name, 'subroom name')
			if (badName !== null) return roomEnvelope(c, null, badName)

			const result = await createSubRoom(c.env.DB, roomId, accountId, name)
			if (!result) return roomEnvelope(c, null, 'This room does not exist!')

			await pushRoomUpdate(c, accountId, result.room)
			return roomEnvelope(c, result.room)
		}
	)

	// Delete a subroom from a room. Auth-gated (401) and owner-only. Refuses to remove a
	// room's only subroom. Notifies the owner (RoomUpdate) and returns the updated ROOM in
	// the `{ success, error, value }` envelope (same shape as create, so the client
	// re-renders the subroom list from `value`).
	.delete(
		'/rooms/:roomId{[0-9]+}/subrooms/:subRoomId{[0-9]+}',
		describeRoute({
			tags: ['Subrooms'],
			summary: 'Delete a subroom',
			description: [
				'Removes a subroom from a room. Owner-only, and it refuses to remove a room’s only',
				'subroom — that would leave the room with no scene to load. Any saved-data blob the',
				'subroom pointed at is left in R2, the same way deleting a room leaves the photos',
				'taken in it. Answers the updated ROOM, like create.',
			].join(' '),
			security: AUTHED,
			parameters: [roomIdParam, subRoomIdParam],
			responses: {
				200: json(RoomEnvelope, 'The updated room, or a rejection with `success: false`'),
				401: UNAUTHORIZED_ENVELOPE,
			},
		}),
		async (c) => {
			const accountId = await authedAccountId(c)
			if (accountId === null) {
				return c.json({ success: false, error: 'Unauthorized', value: null }, 401)
			}

			const roomId = Number.parseInt(c.req.param('roomId'), 10)
			const subRoomId = Number.parseInt(c.req.param('subRoomId'), 10)

			const room = await getRoomById(c.env.DB, roomId)
			if (!room) return roomEnvelope(c, null, 'This room does not exist!')
			if (room.CreatorAccountId !== accountId) {
				return roomEnvelope(c, null, 'You are not the owner of this room!')
			}

			const result = await deleteSubRoom(c.env.DB, roomId, subRoomId)
			if (!result.ok) {
				return roomEnvelope(
					c,
					null,
					result.reason === 'last_subroom'
						? "You can't delete a room's only subroom!"
						: 'This subroom does not exist!'
				)
			}

			await pushRoomUpdate(c, accountId, result.room)
			return roomEnvelope(c, result.room)
		}
	)

	// Rooms similar to the given room (sharing tags). Paginated via skip/take (take
	// defaults to 100). Returns `{ Results, TotalResults }`; empty when the room is
	// unknown/untagged.
	.get(
		'/rooms/:roomId{[0-9]+}/similar',
		describeRoute({
			tags: ['Discovery'],
			summary: 'Rooms similar to a room',
			description: [
				'Rooms sharing tags with the given one — the “more like this” rail. Empty when the',
				'room is unknown or carries no tags.',
			].join(' '),
			parameters: [roomIdParam, ...pageParams(100)],
			responses: { 200: json(PagedRooms, 'The similar rooms') },
		}),
		async (c) => {
			const skip = Number.parseInt(c.req.query('skip') ?? '0', 10) || 0
			const take = Number.parseInt(c.req.query('take') ?? '100', 10) || 100
			return c.json(
				await getSimilarRooms(c.env.DB, Number.parseInt(c.req.param('roomId'), 10), skip, take)
			)
		}
	)

	// The caller's per-room player data. Stub → empty blob (client reads `Data`).
	.get(
		'/rooms/:roomId{[0-9]+}/playerdata/me',
		describeRoute({
			tags: ['Rooms'],
			summary: 'The caller’s per-room player data',
			description: [
				'Per-room save data for the calling player. Nothing stores any yet, so this is a stub',
				'serving an empty blob — which the client reads as “no saved data”. No auth: there’s',
				'no caller-specific state to protect until something writes here.',
			].join(' '),
			parameters: [roomIdParam],
			responses: { 200: json(PlayerDataDto, 'An empty data blob') },
		}),
		(c) => c.json({ Data: '' })
	)

	// The caller's per-room experience/progression. Stub → empty list.
	.get(
		'/rooms/:roomId{[0-9]+}/experience/player',
		describeRoute({
			tags: ['Rooms'],
			summary: 'The caller’s per-room experience',
			description: [
				'Per-room experience/progression for the calling player. Nothing tracks any yet, so',
				'this is an empty list — which the client reads as “no progress in this room”, where',
				'a 404 would stall the room load. No auth, matching `playerdata/me`: the answer is',
				'the same for every caller until something writes here.',
			].join(' '),
			parameters: [roomIdParam],
			responses: { 200: json(RoomExperiencePlayer, 'An empty list') },
		}),
		(c) => c.json([])
	)

	// Single room by id. 404 when the room isn't in D1. Ignores the
	// include/unityAsset* query params.
	.get(
		'/rooms/:roomId{[0-9]+}',
		describeRoute({
			tags: ['Rooms'],
			summary: 'A room by id',
			description: [
				'The room as stored, with its `SubRooms` re-attached. Unlike `GET /rooms?id=`, an',
				'unknown room here is a 404, not `{}`. The `include`/`unityAsset*` query params the',
				'client sends are accepted and ignored.',
			].join(' '),
			parameters: [
				roomIdParam,
				stringQuery('include', 'Accepted and ignored'),
				stringQuery('unityAssetTarget', 'Accepted and ignored'),
				stringQuery('unityAssetVersion', 'Accepted and ignored'),
			],
			responses: { 200: json(RoomDto, 'The room'), 404: { description: 'No such room' } },
		}),
		async (c) => {
			const room = await getRoomById(c.env.DB, Number.parseInt(c.req.param('roomId'), 10))
			return room ? c.json(room) : c.notFound()
		}
	)

	// The republish limits, verbatim from the reference server. Fixed values, no auth:
	// the client reads them to render its publish UI, before any room is in play.
	.get(
		'/publishState/configs',
		describeRoute({
			tags: ['Rooms'],
			summary: 'Room republish limits',
			description: [
				'The limits the client enforces around republishing a room — how many updates are',
				'allowed per rolling window, and the cooldown and expiry around them. Fixed values',
				'from the reference server; nothing here enforces them server-side yet, so this is',
				'what the client shows and gates its own UI on.',
				'',
				'Note the envelope differs from the room mutations’: `error` is null (not `""`) and',
				'there is an extra `error_id`.',
			].join(' '),
			responses: { 200: json(PublishStateConfigsEnvelope, 'The republish limits') },
		}),
		(c) =>
			c.json({
				value: {
					UpdateMaxCount: 3,
					UpdateRollingWindowInDays: 365,
					UpdateExpirationInDays: 30,
					UpdateCooldownInDays: 45,
				},
				success: true,
				error_id: null,
				error: null,
			})
	)

	// Photon access token + room permissions the client needs to spawn into a room.
	.get(
		'/photon_access_token',
		describeRoute({
			tags: ['Session'],
			summary: 'Photon token + room permissions',
			description: [
				'The permission table and Photon credentials the client needs to spawn into a room.',
				'`RoomInstanceId` is the caller’s current instance, read from the shared `presence`',
				'table (null when they’re in none).',
				'',
				'`PhotonAccessToken` is always empty: the reference server signs it with a',
				'secret/algorithm we don’t have, and our Photon setup accepts an empty token. The',
				'global (Role 0) maker pen is granted only to the hardcoded dev accounts.',
			].join('\n'),
			security: AUTHED,
			responses: {
				200: json(PhotonAccessTokenDto, 'The permissions and (empty) token'),
				401: UNAUTHORIZED_RESPONSE,
			},
		}),
		handlePhotonAccessToken
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
					title: 'recflare rooms',
					version: '1.0.0',
					description: [
						'The room server for recflare, a private-server reimplementation of the Rec Room',
						'backend: room storage, the browse/search feeds, per-player cheers and favorites,',
						'the owner’s room settings, and subrooms.',
						'',
						'A room is a single JSON blob in the shared `recflare` D1, with generated columns',
						'for the queryable fields; reads serve that blob verbatim, which is why the shapes',
						'here are the client’s PascalCase ones. Subrooms live in their own table (their ids',
						'come from one global sequence, not per room) and are re-attached to each room on',
						'read. The seed rooms — including the dorm — come from `static/ImportRooms.json`.',
						'',
						'Two response envelopes appear side by side: a PascalCase',
						'`{ Success, Value, ErrorId, Error }` and a lowercase `{ success, error, value }`.',
						'Which one a route uses is dictated by the client’s deserializer for that call, so',
						'the inconsistency is deliberate. Both answer HTTP 200 even for a rejection — the',
						'client reads the flag, not the status.',
					].join('\n'),
				},
				servers: [{ url: 'https://rooms.recflare.net', description: 'Production' }],
				components: {
					securitySchemes: {
						bearerAuth: {
							type: 'http',
							scheme: 'bearer',
							bearerFormat: 'JWT',
							description: 'An `access_token` from the auth worker’s `POST /connect/token`.',
						},
					},
				},
			},
		})
	)
)

export default app
