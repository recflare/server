import { Hono } from 'hono'
import { describeRoute, openAPIRouteHandler } from 'hono-openapi'
import { useWorkersLogger } from 'workers-tagged-logger'

import {
	Accessibility,
	areFriends,
	canManageRoom,
	createRoomInstance,
	deleteEmptyRoomInstances,
	deleteExpiredPresence,
	deletePresence,
	GAME_VERSION,
	getAccount,
	getClubSummary,
	getExpiredPresenceInstanceIds,
	getFriendIds,
	getJoinableInstance,
	getOrCreateDormRoom,
	getPresence,
	getPresences,
	getRoomById,
	getRoomByName,
	getRoomInstance,
	getRoomInstancesByRoom,
	getRoomInstanceSummariesByRoom,
	isClubMember,
	isPlayerBannedFromRoom,
	MatchmakingErrorCode,
	MessageType,
	recordRoomVisit,
	refreshInstanceFullness,
	RoomInstanceType,
	setPresence,
	setRoomInstanceInProgress,
	setRoomInstancePrivate,
	subRoomDataBlob,
} from '@repo/domain'
import { logger, withCleanSpec, withNotFound, withOnError } from '@repo/hono-helpers'
import { generatePhotonAuthToken, validateAndGetAccountId, validateAndGetVersion } from '@repo/jwt'

// The account-wide ban lives on a `report` row, whose table the api worker owns; its
// db module is plain D1 queries with no runtime deps, so it imports cleanly here (the
// same way econ reads api's inventions-db).
import { banEvasionMatch, resolveBan } from '../../api/src/bans-db'
// The player-event tables are the api worker's too (same plain-D1 shape as bans-db):
// `/matchmake/event` needs the event's room and the caller's invite row.
import { getEventById, getEventResponse } from '../../api/src/events-db'
// Value import of the notify worker's NotificationType enum (its bundle has no runtime
// deps), so /invite sends a typed MessageReceived frame instead of a magic number.
import { NotificationType } from '../../notify/src/notification-types'
import {
	AUTHED,
	AvoidJuniorsRequest,
	AvoidJuniorsResponse,
	ConnectionInfoResponse,
	CorrelationIdRequest,
	EMPTY_OK,
	ExclusiveLoginResponse,
	form,
	InProgressRequest,
	InviteRequest,
	JoinModeRequest,
	json,
	LoginLockRequest,
	MatchmakeResponse,
	MatchmakeRoomRequest,
	NotifyDisconnectRequest,
	PlayerDto,
	QosRegion,
	RoomInstanceDto,
	RoomInstanceSummaryDto,
	StatusVisibilityRequest,
	UNAUTHORIZED_RESPONSE,
} from './openapi'

import type { Context } from 'hono'
import type { Room, StoredPresence } from '@repo/domain'
import type { App, Env } from './context'

/**
 * The matchmaking surface. Rooms and room instances are D1-backed (matchmaking
 * finds/creates a `room_instance` row per session); player lookups still fall back
 * to default values when nothing is found. Presence is D1-backed too (the
 * `presence` table; see @repo/domain's presence-db).
 *
 * Auth-gated routes still validate the Bearer JWT issued by the `auth` worker.
 */

/**
 * The connection fields the client expects on a player payload but that only ever
 * carry a value in a matchmaking response — the photon/voice credentials for the
 * instance you were just placed into. Reading someone else's presence never hands
 * out credentials, so they're always null here; the client needs the keys present.
 */
const NULL_CONNECTION_INFO = {
	photonAuthToken: null,
	photonRealtimeAppId: null,
	photonVoiceAppId: null,
	photonChatAppId: null,
	photonRegion: null,
	photonRoomId: null,
	voiceConnectionInfo: null,
	voiceServerId: null,
	experiments: null,
} as const

/**
 * The Photon applications the client connects to (`GET /player/connection-info`).
 * Hardcoded temporarily — move them to wrangler vars before they need to differ per
 * environment (they are per-deployment ids, not secrets: the client receives all three
 * in the clear). `photonRegion` matches the value `roomInstanceFromRoom` stamps on every
 * instance, so the two can't disagree ('us' resolves to us-east1 for QoS).
 */
const PHOTON_APPS = {
	photonRealtimeAppId: '8f322bdb-2b1f-4c27-a232-01436f43d14e',
	photonVoiceAppId: '6b4682e1-a1a9-4e04-b44a-6db0049a4df3',
	photonChatAppId: '55fae86e-0459-4f97-bf6c-39c9341da6ef',
	photonRegion: 'us',
} as const

/**
 * Networking feature flags the client reads off its connection info. Verbatim from
 * the reference server — the client changes how it replicates based on these, so they
 * are not free to tune. The load-bearing one is `shouldUseGameServerNetworking`:
 * true makes the client connect to a local game server (127.0.0.1:7777) instead of
 * Photon, which is not what recflare runs.
 */
const PHOTON_EXPERIMENTS = {
	networkTransformSyncInterval: 10.0,
	shouldUseUnreliableOnChange: false,
	shouldAvoidDiscontinuityRPCs: true,
	shouldAvoidRedundantDiscontinuity: false,
	r2RuntimeStaticBaking: true,
	r2AutoEmbodiment: true,
	r2RuntimeStaticBakingMinShapeThreshold: 1,
	r2UseCheapReplicas: true,
	shouldUseGameServerNetworking: false,
} as const

/**
 * The regions the client probes for latency (`GET /player/qos`), reporting the results
 * back through `PUT /player/photonregionpings`. Rec Room's own QoS endpoints, served
 * verbatim: recflare doesn't run probe servers, and the client only uses the timings to
 * rank regions — a ranking it can't act on here, since `PHOTON_APPS.photonRegion` pins
 * every session to one region regardless. `address` is `host:port`, not a URL.
 */
const QOS_REGIONS = [
	{ id: 'us-west1', address: '34.169.254.144:50000' },
	{ id: 'europe-west1', address: '35.205.141.119:50000' },
	{ id: 'asia-northeast1', address: '35.200.67.228:50000' },
	{ id: 'us-east1', address: '34.73.244.122:50000' },
	{ id: 'us-central1', address: '34.69.179.51:50000' },
	{ id: 'northamerica-northeast1', address: '34.152.4.100:50000' },
] as const

/**
 * A player's presence as the client reads it (`/player`, `/player/heartbeat`).
 * `isOnline` means "has a live presence row" — presence rows expire, so a player who
 * stopped heartbeating drops offline — and is deliberately *not* derived from being
 * in a room: you can be online in the lobby with `roomInstance` null. `errorCode` 0
 * is "no error"; it only turns non-zero on a failed matchmake.
 *
 * `callerVersion` (the `rn.ver` off the caller's token) may be passed ONLY when the
 * payload is the caller's own — the batch lookup serves other players, whose build this
 * caller's token knows nothing about.
 */
function playerPayload(
	playerId: number,
	presence?: Presence | null,
	callerVersion?: string | null
) {
	return {
		// The stored row is authoritative — for the caller it was just synced from their
		// token, and for anyone else the caller's token says nothing. `callerVersion` only
		// covers the caller having no presence row at all (they aren't in a room yet), where
		// the alternative is reporting a build nobody is running.
		appVersion: presence?.appVersion || callerVersion || GAME_VERSION,
		deviceClass: presence?.deviceClass ?? 0,
		errorCode: 0,
		// `getPresence` yields null and the batch map yields undefined — neither is online.
		isOnline: presence != null,
		playerId,
		roomInstance: presence?.roomInstance ?? null,
		statusVisibility: presence?.statusVisibility ?? 0,
		vrMovementMode: presence?.vrMovementMode ?? 1,
		platform: presence?.platform ?? 0,
		...NULL_CONNECTION_INFO,
	}
}

/**
 * Resolve the account id from a Bearer token, mirroring the repeated
 * auth-header check. Returns `null` when the header is missing,
 * the token is invalid, or the `sub` claim isn't an integer.
 */
async function authedId(c: Context<App>): Promise<number | null> {
	return validateAndGetAccountId(c.req.raw, await c.env.JWT_SECRET.get())
}

/** Results.Unauthorized() equivalent — 401 with empty body. */
function unauthorized(c: Context<App>) {
	return c.body(null, 401)
}

/**
 * The game build the CALLER is running, from their token's `rn.ver` claim — the `ver`
 * they posted to `auth`'s `/connect/token`. This is what presence records, so a player
 * reports the build they are actually on rather than this server's GAME_VERSION.
 *
 * `null` when the request carries no valid token, or an older one issued before the claim
 * carried the client's own value; callers then keep whatever presence already held, and
 * only fall back to GAME_VERSION when there is nothing at all. Never write an empty
 * version — the client's presence DTO reads `appVersion` as a string and an empty one
 * breaks its version handling.
 *
 * Only ever used for the caller's OWN presence. Another player's version comes off their
 * stored row; this token says nothing about them.
 */
async function callerVersion(c: Context<App>): Promise<string | null> {
	return validateAndGetVersion(c.req.raw, await c.env.JWT_SECRET.get())
}

/**
 * The "avoid juniors" preference, spelled the way the client posts it — the key a NEW
 * setting is written under, and the one every stored spelling is matched against.
 *
 * The player's settings are a free-form `{ key: value }` bag written by the client through
 * the `playersettings` worker, and the exact spelling it writes this key under is
 * reverse-engineered, so the lookup is case- and separator-insensitive (`avoidJuniors`,
 * `AvoidJuniors`, `AVOID_JUNIORS` all resolve to this one preference) rather than betting on
 * one casing and silently reading false forever if it's wrong. The write then overwrites
 * whichever spelling is already there, so a player never ends up with two keys for the one
 * preference — which would make the read depend on their order in the map.
 */
const AVOID_JUNIORS_KEY = 'avoidJuniors'

/** Lowercase and drop separators, so keys compare on their letters alone. */
function normalizeSettingKey(key: string): string {
	return key.toLowerCase().replaceAll(/[^a-z0-9]/g, '')
}

/** The player's existing spelling of the setting key, if their map has one. */
function findAvoidJuniorsKey(stored: Record<string, unknown>): string | undefined {
	const wanted = normalizeSettingKey(AVOID_JUNIORS_KEY)
	return Object.keys(stored).find((key) => normalizeSettingKey(key) === wanted)
}

/**
 * Settings values are strings, so a boolean arrives as `True`/`false`/`1`/`0` (the client
 * isn't consistent about which). `undefined` for anything unrecognized, which the read and
 * the write treat differently: a stored value that won't parse is a false preference, but a
 * posted one that won't parse is a body worth ignoring rather than a write of `false`.
 */
function parseSettingBool(value: unknown): boolean | undefined {
	if (typeof value === 'boolean') return value
	switch (String(value).trim().toLowerCase()) {
		case 'true':
		case '1':
		case 'yes':
			return true
		case 'false':
		case '0':
		case 'no':
			return false
		default:
			return undefined
	}
}

/** The player's settings map from the KV the `playersettings` worker owns. */
async function getPlayerSettings(
	env: Env,
	accountId: number
): Promise<Record<string, string> | null> {
	return env.RECFLARE_PLAYER_SETTINGS.get<Record<string, string>>(
		`player:${accountId}`,
		'json'
	).catch(() => null)
}

/**
 * Read a player's "avoid juniors" preference. Absent settings, an absent key, and an
 * unparseable value are all false: the client asks this before matchmaking, so a read that
 * can't answer must not keep a player out of rooms.
 */
async function readAvoidJuniors(env: Env, accountId: number): Promise<boolean> {
	const stored = await getPlayerSettings(env, accountId)
	if (!stored) return false

	const key = findAvoidJuniorsKey(stored)
	return key === undefined ? false : (parseSettingBool(stored[key]) ?? false)
}

/**
 * Write a player's "avoid juniors" preference back into their settings map.
 *
 * The write MERGES, exactly as the `playersettings` worker's own PUT does: the map holds
 * every setting the player has (OOBE state, tutorial mask, …), so storing this one on its
 * own would wipe the rest. Read-modify-write on KV isn't atomic, but the same is true of
 * the settings worker, and two writers racing over one player's own settings means that
 * player toggling two options in the same instant.
 */
async function writeAvoidJuniors(env: Env, accountId: number, value: boolean): Promise<void> {
	const stored = (await getPlayerSettings(env, accountId)) ?? {}
	const merged: Record<string, string> = { ...stored }
	merged[findAvoidJuniorsKey(merged) ?? AVOID_JUNIORS_KEY] = value ? 'True' : 'False'
	await env.RECFLARE_PLAYER_SETTINGS.put(`player:${accountId}`, JSON.stringify(merged))
}

/**
 * The posted preference, out of a form (`avoidJuniors=True`, what the client sends) or a
 * JSON body. The field name is matched the same loose way the stored key is, so the casing
 * the client picks can't silently miss. `undefined` when the body carries no readable
 * value — the caller leaves the setting alone rather than writing a guess.
 */
async function readAvoidJuniorsBody(c: Context<App>): Promise<boolean | undefined> {
	const contentType = c.req.header('content-type') ?? ''
	const body = contentType.includes('application/json')
		? await c.req.json<unknown>().catch(() => null)
		: await c.req.parseBody().catch(() => null)
	if (body === null || typeof body !== 'object') return undefined

	const key = findAvoidJuniorsKey(body as Record<string, unknown>)
	return key === undefined ? undefined : parseSettingBool((body as Record<string, unknown>)[key])
}

/** A synthesized room instance (same shape for dorm and other rooms). */
type RoomInstance = ReturnType<typeof roomInstanceFromRoom>

/**
 * Stored presence for a player — the room instance they matchmade into plus the
 * status fields the heartbeat echoes back. The generic StoredPresence lives in
 * @repo/domain; here it's specialized to the match worker's RoomInstance shape.
 */
type Presence = StoredPresence<RoomInstance>

/**
 * A heartbeat that changes nothing re-writes presence only once its TTL drops
 * within this window of expiring (s), instead of on every beat. So a player who's
 * sitting still is refreshed at most once per (PRESENCE_TTL_SECONDS − this) rather
 * than on every heartbeat — far fewer D1 writes, while still staying comfortably
 * ahead of expiry (the client heartbeats many times inside this window).
 */
const PRESENCE_REFRESH_THRESHOLD = 300

/**
 * Default `/player` payload, served whenever the `id` is missing/invalid or the
 * account isn't found. Inlined here (Workers have no filesystem). The stub player
 * reads as online — it's a placeholder for a real, present player.
 */
const DEFAULT_GET_PLAYER = [{ ...playerPayload(1), isOnline: true }]

/**
 * The wire subset of a room instance a friend sees in a presence update — the
 * reference's `RoomInstanceDto.Redact` projection. `photonRoomId` and `dataBlob` are
 * BLANKED (empty string): they're safe only for the player themselves. A leaked
 * `photonRoomId` would let anyone who can read your presence `JoinByName` the Photon
 * room directly, bypassing the private-instance invite check — the friend list only
 * needs `roomId`/`name`/`isPrivate` to render the row, and joins go back through
 * matchmaking (`/matchmake/player/:playerId`), which enforces access. `photonRegion` is omitted
 * (not on the presence DTO); `name` is already the `^`-prefixed wire name.
 */
function redactInstanceForPresence(instance: RoomInstance) {
	return {
		roomInstanceId: instance.roomInstanceId,
		roomId: instance.roomId,
		subRoomId: instance.subRoomId,
		roomInstanceType: instance.roomInstanceType,
		location: instance.location,
		// Blanked — see above: never hand another player the join coordinates.
		dataBlob: '',
		eventId: instance.eventId,
		clubId: instance.clubId,
		roomCode: instance.roomCode,
		photonRegionId: instance.photonRegionId,
		photonRoomId: '',
		name: instance.name,
		maxCapacity: instance.maxCapacity,
		isFull: instance.isFull,
		isPrivate: instance.isPrivate,
		isInProgress: instance.isInProgress,
		EncryptVoiceChat: instance.EncryptVoiceChat,
	}
}

/**
 * The SubscriptionUpdatePresence message a friend receives when the player changes rooms:
 * a presence snapshot of who, and the redacted instance they're now in (null when in no
 * room → `isOnline` false). `statusVisibility` is forced to 0 (Everyone) so the player
 * isn't hidden from friends. `appVersion` is the subject's own build (from their presence
 * row) and MUST be a string — the client's presence DTO reads it with a string reader, and
 * a numeric value aborts the whole SignalR frame ("expected String Begin Token"), dropping
 * the room/presence update.
 */
function presenceUpdateMessage(
	playerId: number,
	instance: RoomInstance | null,
	appVersion?: string | null
) {
	return {
		playerId,
		statusVisibility: 0,
		deviceClass: 0,
		vrMovementMode: 0,
		roomInstance: instance ? redactInstanceForPresence(instance) : null,
		isOnline: instance != null,
		// The build the SUBJECT is running, off the presence row their own token wrote —
		// this frame describes them to their friends, so GAME_VERSION would report this
		// server's build as theirs.
		appVersion: appVersion || GAME_VERSION,
	}
}

/**
 * Push a SubscriptionUpdatePresence to every online friend of `playerId` after their
 * presence changes (they entered a room). Mirrors the reference's PlayerPresenceChanged:
 * only currently-connected friends receive it (an offline friend gets nothing, not a
 * queued stale frame), so it's an ephemeral batch send. The room instance the friends
 * see is read from the player's stored presence — the authoritative record just written,
 * the same one the heartbeat replays. Best-effort: a hub or lookup failure is logged and
 * swallowed, so it never fails the matchmake that triggered it.
 */
async function notifyFriendsPresence(c: Context<App>, playerId: number): Promise<void> {
	try {
		const friendIds = await getFriendIds(c.env.DB, playerId)
		if (friendIds.length === 0) return
		const presence = await getPresence<RoomInstance>(c.env.DB, playerId)
		await c.env.RECFLARE_NOTIFICATIONS_HUB.getByName(HUB_INSTANCE).notifyPlayersEphemeral(
			friendIds,
			NotificationType.SubscriptionUpdatePresence,
			presenceUpdateMessage(playerId, presence?.roomInstance ?? null, presence?.appVersion)
		)
	} catch (err) {
		logger.error('failed to push SubscriptionUpdatePresence to friends', {
			playerId,
			error: err instanceof Error ? err.message : String(err),
		})
	}
}

/**
 * Store the room instance the player just matchmade into, preserving status, and count
 * the visit against the room.
 *
 * With no live presence to carry forward (the player's first matchmake after login,
 * or one after their presence lapsed) the device fields would otherwise default —
 * writing a screen player into the instance as deviceClass 0 until their next
 * heartbeat corrects it. Everyone already in the room sees that stale class in the
 * meantime, so fall back to what the account reported at login (auth stores
 * `deviceClass`/`platform` from the token request) instead of to 0. The account read
 * only happens on that no-presence path; a normal matchmake carries `prev` forward.
 */
async function enterRoom(c: Context<App>, id: number, roomInstance: RoomInstance): Promise<void> {
	const prev = await getPresence<RoomInstance>(c.env.DB, id)
	const account = prev ? null : await getAccount(c.env.DB, id)
	await setPresence(c.env.DB, {
		accountId: id,
		roomInstance,
		statusVisibility: prev?.statusVisibility ?? 0,
		deviceClass: prev?.deviceClass ?? account?.deviceClass ?? 0,
		vrMovementMode: prev?.vrMovementMode ?? 1,
		platform: prev?.platform ?? account?.platform ?? 0,
		// The token's build wins over the stored one: the token belongs to the session
		// making this call, while `prev` can be a row left by an earlier session on an
		// older build.
		appVersion: (await callerVersion(c)) ?? prev?.appVersion ?? GAME_VERSION,
		// Carry the session lock recorded at login forward, so matchmake doesn't wipe it
		// and the heartbeat can keep verifying against it.
		loginLock: prev?.loginLock,
	})

	// Count the visit. Every matchmake route funnels through here with the instance the
	// player landed in, and a matchmake is the only way into a room, so this is the one
	// place a visit can be recorded once — whether they got here by room id, by subroom,
	// by following a friend, from a club's clubhouse, or into their own dorm. Bumps the
	// room's `visits` column, which is served as `Stats.VisitCount`. Best-effort: a
	// counter is not worth failing the matchmake over.
	try {
		await recordRoomVisit(c.env.DB, roomInstance.roomId)
	} catch (err) {
		logger.error('failed to record room visit', {
			roomId: roomInstance.roomId,
			error: err instanceof Error ? err.message : String(err),
		})
	}

	// Keep the destination instance's is_full flag in sync with live presence (the
	// player's own presence, just written, is counted). Then re-evaluate the
	// instance they left — its head-count dropped — so a full room frees up when
	// players move on. Both no-op for the synthetic dorm/orientation instances.
	await refreshInstanceFullness(c.env.DB, roomInstance.roomInstanceId)
	const leftId = prev?.roomInstance?.roomInstanceId
	if (leftId != null && leftId !== roomInstance.roomInstanceId) {
		await refreshInstanceFullness(c.env.DB, leftId)
	}

	// The player's presence changed — tell their online friends where they went, reading
	// the instance back from the presence we just stored. Best-effort; never blocks or
	// fails the matchmake.
	await notifyFriendsPresence(c, id)
}

/** Returned when a room isn't in the DB — and for every other opaque refusal. */
const NO_SUCH_ROOM = MatchmakingErrorCode.NoSuchRoom

/**
 * "You are banned from this room". Unlike the opaque NoSuchRoom every other refusal
 * answers, a banned player is told why: they already know the room exists, so there's
 * nothing to hide, and the client can say so instead of showing a room that
 * mysteriously fails to load.
 */
const BANNED_FROM_ROOM = MatchmakingErrorCode.BannedFromRoom

/**
 * "This event isn't open to you" — the refusal on a private event the caller wasn't
 * invited to. Told plainly rather than hidden behind the opaque NoSuchRoom: a player
 * reaching this already holds the event id from somewhere that showed it to them, so
 * the only thing withholding the reason buys is a room that fails to load for no
 * visible reason.
 */
const EVENT_IS_PRIVATE = MatchmakingErrorCode.EventIsPrivate

/** The notifications hub is a single global DO instance (see the `notify` worker). */
const HUB_INSTANCE = 'global'

/**
 * A fresh id for a *live* (non-persisted) message — the reference's
 * `NextLiveMessageID`. A game invite is ephemeral (never stored), so there's no
 * database sequence to draw from; epoch milliseconds give a monotonically increasing,
 * effectively unique id the client can key the invite off. It only has to be distinct
 * among a player's in-flight invites, not globally.
 */
function nextLiveMessageId(): number {
	return Date.now()
}

/**
 * Deliver a game invite from `fromId` to `toId` for a room instance — a `MessageReceived`
 * frame carrying a game-invite `Message` the client renders the join prompt from. `data`
 * is the raw roomInstanceId string the message carries; `roomId` (nullable) tells the
 * client which room it points at. Best-effort: a hub failure is logged and swallowed.
 *
 * Shared by `POST /invite` (a single explicit invite) and the party fan-out on a room
 * matchmake (one per `AdditionalPlayerIds` entry), so the two can't drift.
 */
async function sendGameInvite(
	c: Context<App>,
	fromId: number,
	toId: number,
	data: string,
	roomId: number | null
): Promise<void> {
	const message = {
		Id: nextLiveMessageId(),
		FromPlayerId: fromId,
		ToPlayerId: toId,
		Type: MessageType.GameInvite,
		Data: data,
		SentTime: new Date().toISOString(),
		RoomId: roomId,
	}
	try {
		await c.env.RECFLARE_NOTIFICATIONS_HUB.getByName(HUB_INSTANCE).notifyPlayer(
			toId,
			NotificationType.MessageReceived,
			message
		)
	} catch (err) {
		logger.error('failed to push game-invite MessageReceived notification', {
			fromPlayerId: fromId,
			toPlayerId: toId,
			error: err instanceof Error ? err.message : String(err),
		})
	}
}

/**
 * The sentinel room-instance id the `auth` worker seeds a brand-new player's
 * Orientation presence with (see auth's `placeNewPlayerInOrientation`). The client
 * fires a spurious `player/logout` right after that seed, so logout must NOT clear
 * presence while it still points at Orientation — doing so wipes the seed and
 * bounces the new player to the dorm.
 */
const ORIENTATION_INSTANCE_ID = -2

/**
 * Instance-relevant fields pulled from a stored room (scene, name, capacity, …).
 * The `location` is the SubRoom's real `UnitySceneId` — an empty/unknown location
 * makes the client reject the session with "unknown scene location ID".
 *
 * `subRoomId` picks which of the room's subrooms to enter (the client matchmakes
 * into one with `/matchmake/room/{roomId}/{subRoomId}`); an unknown or unspecified
 * subroom falls back to the room's first, which is its default entrance.
 */
function instanceFieldsFromRoom(room: Room, subRoomId?: number) {
	const subRooms = (Array.isArray(room.SubRooms) ? room.SubRooms : []) as Array<
		Record<string, unknown>
	>
	const sub =
		(subRoomId === undefined ? undefined : subRooms.find((s) => s.SubRoomId === subRoomId)) ??
		subRooms[0]
	const str = (v: unknown, fallback = '') => (typeof v === 'string' ? v : fallback)
	const num = (v: unknown, fallback: number) => (typeof v === 'number' ? v : fallback)
	// Room instance names are prefixed with `^` so the client resolves the instance
	// (without it the new scene won't load). Personal dorms are the exception: they
	// carry the owner prefix `@<user>'s Dorm` and must NOT also get a `^`.
	const rawName = str(room.Name, 'Room')
	const name = rawName.startsWith('^') || rawName.startsWith('@') ? rawName : `^${rawName}`
	return {
		roomId: num(room.RoomId, 1),
		subRoomId: num(sub?.SubRoomId, 1),
		location: str(sub?.UnitySceneId),
		// Always the PUBLISHED save. A creator who wants their unpublished work is offered
		// the choice client-side from the `/subrooms/{id}/saves` list — matchmaking is not
		// involved, and serving a staged blob here would put two people in one instance on
		// different versions.
		dataBlob: subRoomDataBlob(sub),
		name,
		maxCapacity: num(sub?.MaxPlayers, 4),
		roomInstanceType: room.IsDorm === true ? RoomInstanceType.Dormroom : RoomInstanceType.Public,
		isDorm: room.IsDorm === true,
	}
}

/**
 * Build the client instance wire shape from a stored room plus the live instance's
 * id + Photon room id (both come from the `room_instance` table so joiners of the
 * same instance share them).
 */
function roomInstanceFromRoom(
	room: Room,
	isPrivate: boolean,
	instanceId: number,
	photonRoomId: string,
	subRoomId?: number
) {
	const f = instanceFieldsFromRoom(room, subRoomId)
	return {
		roomInstanceId: instanceId,
		roomId: f.roomId,
		subRoomId: f.subRoomId,
		roomInstanceType: f.roomInstanceType,
		location: f.location,
		dataBlob: f.dataBlob,
		eventId: 0,
		clubId: 0,
		roomCode: '',
		photonRegion: 'us',
		photonRegionId: 'us',
		photonRoomId,
		name: f.name,
		maxCapacity: f.maxCapacity,
		isFull: false,
		isPrivate: isPrivate || f.isDorm,
		isInProgress: false,
		EncryptVoiceChat: false,
	}
}

/**
 * The GUID a matchmake answers with when the request named none. The client's response
 * DTO reads `correlationId` as a Guid, not a nullable one, so a null (or a missing key)
 * is a decode failure on a field it checks before anything else — the all-zero
 * `Guid.Empty` is what an unset Guid serializes as, and it reads as "no correlation".
 */
const EMPTY_CORRELATION_ID = '00000000-0000-0000-0000-000000000000'

/**
 * The `CorrelationId` the client tagged this matchmake with. The client generates one
 * per matchmake attempt and refuses the session ("Unable to connect to game session")
 * unless the response carries the same GUID back, so this is echoed on EVERY matchmake
 * response — the refusals included, since a refusal the client can't correlate is a
 * matchmake it goes on waiting for.
 *
 * Read out of the form body (`CorrelationId=<guid>`, what the client posts), falling
 * back to a query param for the matchmakes that carry no body, and matched
 * case-insensitively like the other reverse-engineered fields here. `EMPTY_CORRELATION_ID`
 * when the request named none — an older client that doesn't send one still gets a
 * well-formed GUID rather than a null its decoder would choke on.
 */
async function readCorrelationId(c: Context<App>): Promise<string> {
	const body = await c.req.parseBody().catch(() => ({}) as Record<string, unknown>)
	const key = Object.keys(body).find((k) => k.toLowerCase() === 'correlationid')
	const posted = key === undefined ? undefined : body[key]
	if (typeof posted === 'string' && posted) return posted

	const queried = c.req.query('CorrelationId') ?? c.req.query('correlationId')
	return queried || EMPTY_CORRELATION_ID
}

/**
 * A matchmake response: the join-result code, the instance (null on a refusal), and the
 * request's correlation id echoed back. Every matchmake route answers through here, so
 * none of them can forget the echo.
 *
 * `result` and `errorCode` are the SAME code under two names. The client reads `result`
 * first; `errorCode` is kept because that's what this server has always sent and what
 * every other consumer (and this worker's own tests) reads. They must never disagree —
 * that's why nothing builds this envelope by hand.
 */
async function matchmakeResult(
	c: Context<App>,
	errorCode: MatchmakingErrorCode | number,
	roomInstance: RoomInstance | null
) {
	return c.json({
		errorCode,
		result: errorCode,
		roomInstance,
		correlationId: await readCorrelationId(c),
	})
}

/** Read the session's `LoginLock` GUID from a form body (undefined when absent/empty). */
async function readLoginLock(c: Context<App>): Promise<string | undefined> {
	const body = await c.req.parseBody().catch(() => ({}) as Record<string, unknown>)
	return typeof body.LoginLock === 'string' && body.LoginLock ? body.LoginLock : undefined
}

/** Read the `JoinMode` form field (2 = private instance). */
async function readJoinMode(c: Context<App>): Promise<number> {
	const body = await c.req.parseBody().catch(() => ({}) as Record<string, unknown>)
	return typeof body.JoinMode === 'string' ? Number.parseInt(body.JoinMode, 10) || 0 : 0
}

/**
 * Read the room-matchmake form body once: `JoinMode` (2 = private) plus the party members
 * to pull along (`AdditionalPlayerIds`). The 2023 client posts its party on a room
 * matchmake so they can be invited into the instance the leader lands in;
 * `AdditionalPlayerIds` is a repeated field (one id each, never comma-separated), and
 * ids are parsed defensively, de-duplicated, and non-positive/garbage entries dropped.
 * Parsed with `{ all: true }` in one pass so the repeated fields survive.
 */
async function readMatchmakeBody(
	c: Context<App>
): Promise<{ joinMode: number; additionalPlayerIds: number[] }> {
	const body = await c.req.parseBody({ all: true }).catch(() => ({}) as Record<string, unknown>)
	const firstString = (v: unknown): string | undefined => {
		const first = Array.isArray(v) ? v[0] : v
		return typeof first === 'string' ? first : undefined
	}
	const joinModeRaw = firstString(body.JoinMode)
	const joinMode = joinModeRaw === undefined ? 0 : Number.parseInt(joinModeRaw, 10) || 0

	const key = Object.keys(body).find((k) => k.toLowerCase() === 'additionalplayerids')
	const raw = key === undefined ? [] : body[key]
	const values = Array.isArray(raw) ? raw : [raw]
	const additionalPlayerIds = [
		...new Set(
			values
				.filter((v): v is string => typeof v === 'string')
				.map((s) => Number.parseInt(s.trim(), 10))
				.filter((n) => !Number.isNaN(n) && n > 0)
		),
	]
	return { joinMode, additionalPlayerIds }
}

/**
 * Invite the caller's party members into the instance the caller just matchmade into —
 * the `AdditionalPlayerIds` fan-out. Each member gets the same game invite `POST /invite`
 * sends, pointing at this instance, so a party matchmake pulls the whole party along. The
 * leader is skipped (already in). Best-effort per member (sendGameInvite swallows its own
 * failures), and never blocks the matchmake beyond the sends themselves.
 */
async function inviteParty(
	c: Context<App>,
	leaderId: number,
	playerIds: number[],
	instance: RoomInstance
): Promise<void> {
	const data = String(instance.roomInstanceId)
	await Promise.all(
		playerIds
			.filter((pid) => pid !== leaderId)
			.map((pid) => sendGameInvite(c, leaderId, pid, data, instance.roomId))
	)
}

/**
 * The outcome of resolving a room to join: the instance, or the `errorCode` to answer
 * with. Kept as a pair rather than a bare null so callers can tell a room that isn't
 * there (NoSuchRoom) from one the caller is banned from — those answer different codes.
 */
type ResolvedInstance =
	| { instance: RoomInstance; errorCode: MatchmakingErrorCode.Success }
	| { instance: null; errorCode: MatchmakingErrorCode }

/**
 * The operator's room substitutions, parsed from the `ROOM_REDIRECTS` var: a map of
 * the room id the client asks for to the room it actually enters (id or room name).
 * The var is comma-separated `<fromRoomId>=<to>` pairs, e.g. `2=MyHub,3=100`.
 *
 * Keyed on the source's numeric id rather than the path segment because the client can
 * matchmake by either id or name (`/matchmake/room/2` and `/matchmake/room/RecCenter`
 * are the same room), so the substitution is matched against the room D1 resolved —
 * one entry then covers both spellings. Unparseable pairs are skipped rather than
 * failing the matchmake: a typo in the knob must not take room entry down.
 */
function roomRedirects(env: Env): Map<number, string> {
	const map = new Map<number, string>()
	if (typeof env.ROOM_REDIRECTS !== 'string') return map
	for (const pair of env.ROOM_REDIRECTS.split(',')) {
		const eq = pair.indexOf('=')
		if (eq === -1) continue
		const from = Number(pair.slice(0, eq).trim())
		const to = pair.slice(eq + 1).trim()
		if (!Number.isInteger(from) || to === '') continue
		map.set(from, to)
	}
	return map
}

/**
 * Apply the operator's `ROOM_REDIRECTS` substitution to a room the client asked for.
 * Answers the room to actually enter, plus the subroom to enter it by.
 *
 * A substituted room drops the requested subroom: the id the client sent addresses a
 * subroom of the room it *asked* for, and the same number in the target room is a
 * different place entirely (or nothing at all), so entry falls back to the target's
 * default subroom. Substitution is a single hop — `2=3,3=2` swaps the two rooms rather
 * than looping — and an unresolvable target leaves the original room in place, so a
 * typo'd knob degrades to "no substitution" instead of a dead hub.
 */
async function substituteRoom(
	c: Context<App>,
	room: Room,
	subRoomId?: number
): Promise<{ room: Room; subRoomId?: number }> {
	const fromId = typeof room.RoomId === 'number' ? room.RoomId : NaN
	const to = roomRedirects(c.env).get(fromId)
	if (to === undefined) return { room, subRoomId }

	const toId = Number.parseInt(to, 10)
	const target = Number.isNaN(toId)
		? await getRoomByName(c.env.DB, to)
		: await getRoomById(c.env.DB, toId)
	if (!target) {
		logger.warn('room redirect target not found; entering the requested room', {
			roomId: fromId,
			target: to,
		})
		return { room, subRoomId }
	}

	logger.info('room redirected', { roomId: fromId, target: to })
	return { room: target, subRoomId: undefined }
}

/**
 * Resolve a room by `:room` path segment (numeric id or name) from D1, then find a
 * joinable instance of it (public matchmakes reuse one via the `room_instance`
 * table) or create a new one. A null instance carries the error code to answer:
 * NoSuchRoom when the room isn't in the DB, BannedFromRoom when the caller is banned.
 *
 * Every matchmake that names a room lands here, so this is also where the operator's
 * room substitutions apply (`ROOM_REDIRECTS`) — everything downstream, from the ban
 * check to presence and the visit count, sees only the room actually entered.
 */
async function resolveRoomInstance(
	c: Context<App>,
	roomKey: string,
	isPrivate: boolean,
	ownerId: number,
	requestedSubRoomId?: number
): Promise<ResolvedInstance> {
	const id = Number.parseInt(roomKey, 10)
	const requested = Number.isNaN(id)
		? await getRoomByName(c.env.DB, roomKey)
		: await getRoomById(c.env.DB, id)
	if (!requested) return { instance: null, errorCode: NO_SUCH_ROOM }

	const { room, subRoomId } = await substituteRoom(c, requested, requestedSubRoomId)

	const f = instanceFieldsFromRoom(room, subRoomId)

	// A banned player never gets an instance. This is the whole enforcement of a room
	// ban: the Photon room id only ever reaches a player through a matchmake, so
	// refusing here means they have no coordinates to join or interact with. Handled
	// before any instance is created or reused so a ban can't spawn one.
	if (await isPlayerBannedFromRoom(c.env.DB, f.roomId, ownerId)) {
		logger.info('matchmake refused: player banned from room', { roomId: f.roomId, ownerId })
		return { instance: null, errorCode: BANNED_FROM_ROOM }
	}

	// Never place the player back into the instance they're already in: the client
	// keys the room transition off a changing `roomInstanceId`, so re-matchmaking into
	// your current instance (e.g. the only public instance of a room you're already in)
	// returns the same id and hangs the client mid-join. Exclude it from the join
	// search, which pushes them to another live instance if one exists or forces a
	// fresh one below. (Only the public path reuses instances, so only it needs the
	// read; a private matchmake always gets a fresh instance.)
	const currentInstanceId = isPrivate
		? undefined
		: (await getPresence<RoomInstance>(c.env.DB, ownerId))?.roomInstance?.roomInstanceId
	// Reuse an existing joinable public instance *of the same subroom* — subrooms are
	// separate places, so joining one must never land you in another. Private
	// matchmakes always get a fresh instance. Create one when there's nothing to join.
	let instance = isPrivate
		? null
		: await getJoinableInstance(c.env.DB, f.roomId, f.subRoomId, currentInstanceId)
	if (!instance) {
		instance = await createRoomInstance(c.env.DB, {
			ownerAccountId: ownerId,
			roomId: f.roomId,
			subRoomId: f.subRoomId,
			location: f.location,
			dataBlob: f.dataBlob,
			photonRoomId: crypto.randomUUID(),
			name: f.name,
			maxCapacity: f.maxCapacity,
			isPrivate: isPrivate || f.isDorm,
			roomInstanceType: f.roomInstanceType,
		})
	}
	return {
		instance: roomInstanceFromRoom(
			room,
			isPrivate,
			instance.roomInstanceId,
			instance.photonRoomId,
			f.subRoomId
		),
		errorCode: MatchmakingErrorCode.Success,
	}
}

/**
 * The authed player's personal dorm instance. Gets-or-creates their dorm room,
 * then backs it with a single persistent private `room_instance` so the dorm has
 * a stable, unique Photon room id (dorms are isolated from each other) that
 * survives re-entry. The room's current scene/saved data is re-read each time, so
 * edits show up on the next visit.
 */
async function playerDormInstance(c: Context<App>, accountId: number): Promise<RoomInstance> {
	const room = await getOrCreateDormRoom(c.env.DB, accountId)
	const f = instanceFieldsFromRoom(room)
	// Reuse the dorm's one instance (private, so getJoinableInstance won't find it).
	let instance = (await getRoomInstancesByRoom(c.env.DB, f.roomId))[0]
	if (!instance) {
		instance = await createRoomInstance(c.env.DB, {
			ownerAccountId: accountId,
			roomId: f.roomId,
			subRoomId: f.subRoomId,
			location: f.location,
			dataBlob: f.dataBlob,
			photonRoomId: crypto.randomUUID(),
			name: f.name,
			maxCapacity: f.maxCapacity,
			isPrivate: true,
			roomInstanceType: f.roomInstanceType,
		})
	}
	return roomInstanceFromRoom(room, true, instance.roomInstanceId, instance.photonRoomId)
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

	// A banned player goes nowhere. Room bans are per-room and checked per route (they
	// depend on which room you're entering); a BAN isn't about a room at all, so it's
	// enforced once here, across every matchmake — by room, by subroom, by instance, into
	// a club's clubhouse, following a friend, and into their own dorm. A gate rather than
	// six copies of the same check: a route added later inherits it, and there is no
	// matchmake left that hands a banned player Photon coordinates.
	//
	// `resolveBan` matches the caller's own account AND the accounts they share a proven
	// platform identity or an IP with, so a ban survives the evader making a new account
	// (see bans-db.ts; the operator narrows the linked arms with BAN_EVASION_MATCH). The
	// arm that matched is logged, because "banned" and "shares a network with somebody
	// banned" are very different things to be looking at in a log.
	//
	// It answers the same BannedFromRoom the room bans do. The code is per-room in name
	// only — it's the one refusal the client renders as "you are banned" instead of a room
	// that mysteriously fails to load, and it's what the enum offers.
	//
	// Unauthenticated requests fall through untouched: the route's own `authedId` answers
	// 401, which mustn't turn into "banned" just because the token was missing.
	.use('/matchmake/*', async (c, next) => {
		const id = await authedId(c)
		if (id !== null) {
			const match = await resolveBan(c.env.DB, id, {
				identity: { ip: c.req.header('cf-connecting-ip') },
				arms: banEvasionMatch(c.env.BAN_EVASION_MATCH),
			})
			if (match) {
				logger.info('matchmake refused: player banned', {
					accountId: id,
					via: match.via,
					bannedAccountId: match.bannedAccountId,
					path: c.req.path,
				})
				return matchmakeResult(c, BANNED_FROM_ROOM, null)
			}
		}
		await next()
	})

	.onError(withOnError())
	.notFound(withNotFound())

	// ---- Player presence -----------------------------------------------------
	// login records the session's `LoginLock` in presence so the heartbeat can verify
	// each beat belongs to this login; it must otherwise leave presence intact (clearing
	// the room instance here would bounce the player to the dorm). Presence is overwritten
	// by matchmake — which carries the lock forward — and expires on its own TTL.
	.post(
		'/player/login',
		describeRoute({
			tags: ['Presence'],
			summary: 'Record the session login lock',
			description: [
				'Records the posted `LoginLock` in the player’s presence so later heartbeats can',
				'verify they still own the session. Updates the live presence row if there is one,',
				'otherwise seeds a lobby presence (no room) carrying the lock. Empty ack.',
			].join(' '),
			requestBody: form(LoginLockRequest, 'The session LoginLock GUID'),
			responses: { 200: EMPTY_OK },
		}),
		async (c) => {
			const id = await authedId(c)
			if (id !== null) {
				const loginLock = await readLoginLock(c)
				if (loginLock !== undefined) {
					const presence = await getPresence<RoomInstance>(c.env.DB, id)
					if (presence) {
						presence.loginLock = loginLock
						await setPresence(c.env.DB, presence)
					} else {
						// No live presence yet — seed a lobby row (roomInstance null) holding the
						// lock, so it survives to the first matchmake (enterRoom carries it forward).
						const account = await getAccount(c.env.DB, id)
						await setPresence(c.env.DB, {
							accountId: id,
							roomInstance: null,
							statusVisibility: 0,
							deviceClass: account?.deviceClass ?? 0,
							vrMovementMode: 1,
							platform: account?.platform ?? 0,
							appVersion: (await callerVersion(c)) ?? GAME_VERSION,
							loginLock,
						})
					}
				}
			}
			return c.body(null, 200)
		}
	)
	.post(
		'/player/exclusivelogin',
		describeRoute({
			tags: ['Presence'],
			summary: 'Exclusive-login ack (no-op)',
			description: [
				'Player exclusive login. Carries the session `LoginLock` (as every presence',
				'lifecycle call does) but is currently a no-op ack. @todo implement login locking.',
			].join(' '),
			requestBody: form(LoginLockRequest, 'The session LoginLock GUID'),
			responses: { 200: json(ExclusiveLoginResponse, 'errorCode 0') },
		}),
		(c) => c.json({ errorCode: 0 })
	)

	// Logout clears the player's presence so they read offline immediately and the
	// instance they were in frees up (rather than waiting out the presence TTL).
	//
	// EXCEPTION: the account-creation bootstrap. The client fires a spurious
	// `player/logout` right after a new player is seeded into Orientation (the auth
	// worker writes that presence with instance id -2). Clearing presence there wipes
	// the seed and bounces the new player to the dorm — so a logout that still points
	// at Orientation is left as a no-op ack. An unauthenticated logout is also a no-op
	// (no player to clear). @kludge probably a better solution for this.
	.post(
		'/player/logout',
		describeRoute({
			tags: ['Presence'],
			summary: 'Clear presence on logout',
			description: [
				'Clears the player’s presence so they read offline immediately and the instance',
				'they were in frees up. Carries the session `LoginLock` (as every presence',
				'lifecycle call does). EXCEPTION: a logout whose presence still points at the',
				'Orientation seed (instance -2) is left as a no-op, so the account-creation',
				'bootstrap isn’t wiped. An unauthenticated logout is also a no-op.',
			].join(' '),
			requestBody: form(LoginLockRequest, 'The session LoginLock GUID'),
			responses: { 200: EMPTY_OK },
		}),
		async (c) => {
			const id = await authedId(c)
			if (id !== null) {
				const presence = await getPresence<RoomInstance>(c.env.DB, id)
				const instanceId = presence?.roomInstance?.roomInstanceId
				if (presence && instanceId !== ORIENTATION_INSTANCE_ID) {
					await deletePresence(c.env.DB, id)
					// The instance they were in lost a player — recompute its fullness so a
					// full room frees up. No-op for the synthetic dorm/orientation instances.
					if (instanceId != null) await refreshInstanceFullness(c.env.DB, instanceId)
					// Their presence changed — tell online friends they went offline. Presence
					// is already cleared, so notifyFriendsPresence reads null and sends the
					// offline snapshot (roomInstance null, isOnline false).
					await notifyFriendsPresence(c, id)
				}
			}
			return c.body(null, 200)
		}
	)

	// Photon disconnect notification (form body `PlayerId`/`RoomInstanceId`) — posted when
	// Photon sees a player drop a room instance. We don't act on it yet (presence is cleared
	// by logout and otherwise expires on its TTL), but the fields are parsed and logged so
	// the hook is in place for a future background reconciliation check.
	.post(
		'/player/notifydisconnect',
		describeRoute({
			tags: ['Presence'],
			summary: 'Photon disconnect notification',
			description: [
				'Posted by Photon when it sees a player drop a room instance (form body',
				'`PlayerId`/`RoomInstanceId`). Currently just logged and acked — presence is cleared',
				'by logout and otherwise expires on its TTL — but the hook is here for a future check.',
			].join(' '),
			requestBody: form(
				NotifyDisconnectRequest,
				'The disconnecting player and the instance they left'
			),
			responses: { 200: EMPTY_OK },
		}),
		async (c) => {
			const body = await c.req.parseBody().catch(() => ({}) as Record<string, unknown>)
			const parseId = (v: unknown): number | null => {
				const n = typeof v === 'string' ? Number.parseInt(v, 10) : NaN
				return Number.isNaN(n) ? null : n
			}
			logger.info('player disconnect notification', {
				playerId: parseId(body.PlayerId),
				roomInstanceId: parseId(body.RoomInstanceId),
			})
			return c.body(null, 200)
		}
	)

	.get(
		'/player',
		describeRoute({
			tags: ['Presence'],
			summary: 'Batch player presence lookup',
			description: [
				'Returns each requested player’s presence. `id` is a repeated query param',
				'(`?id=2&id=155&id=153`) — one value each, not comma-separated. With no ids, serves',
				'a single default (online) player.',
			].join(' '),
			parameters: [
				{
					name: 'id',
					in: 'query',
					required: false,
					description: 'Repeated once per player id (`?id=2&id=155`); not comma-separated',
					schema: { type: 'array', items: { type: 'string' } },
				},
			],
			responses: { 200: json(PlayerDto.array(), 'One entry per requested player') },
		}),
		async (c) => {
			// Returns each requested player's presence. Reads the repeated `id` query
			// param(s); with none it serves the static getplayer.json default.
			const ids = c.req
				.queries('id')
				?.map((s) => Number.parseInt(s.trim(), 10))
				.filter((n) => !Number.isNaN(n))
			if (!ids || ids.length === 0) return c.json(DEFAULT_GET_PLAYER)

			// One query for the whole batch (D1 `WHERE account_id IN (…)`), rather than a
			// point read per id as the KV store required.
			const presences = await getPresences<RoomInstance>(c.env.DB, ids)
			return c.json(ids.map((playerId) => playerPayload(playerId, presences.get(playerId))))
		}
	)

	.post(
		'/player/heartbeat',
		describeRoute({
			tags: ['Presence'],
			summary: 'Presence heartbeat',
			description: [
				'Returns the player’s current presence payload without mutating any stored fields —',
				'the only side effect is refreshing the row’s TTL, and even that only when the TTL',
				'is close to lapsing so a still player isn’t written on every beat. The posted',
				'`LoginLock` is verified against the one recorded at login: a heartbeat carrying a',
				'different lock is a superseded session and gets an empty body. With no stored',
				'presence the player isn’t in a room yet (roomInstance null, isOnline false).',
			].join(' '),
			security: AUTHED,
			requestBody: form(LoginLockRequest, 'The session LoginLock GUID (verified, not stored)'),
			responses: {
				200: json(PlayerDto, 'The player’s current presence payload'),
				401: UNAUTHORIZED_RESPONSE,
			},
		}),
		async (c) => {
			const id = await authedId(c)
			if (id === null) return unauthorized(c)

			// The body is either a JSON status blob (no longer read — presence is returned
			// verbatim) or a form carrying the session `LoginLock`. We only read the
			// LoginLock, to verify this beat still owns the session; a JSON body simply
			// yields no lock (parseBody fails and is swallowed).
			const postedLock = await readLoginLock(c)

			// The build this session is on, off its own token (see callerVersion). The
			// heartbeat is where a version change shows up first: a player who quit and
			// relaunched on a new build heartbeats with a new token against the presence row
			// the old session left behind.
			const version = await callerVersion(c)

			// Return the player's stored presence (set at login/matchmake), mirroring the
			// reference server's HeartbeatDB.GetPlayerHeartbeat. No presence → the player
			// isn't in a room yet, so roomInstance=null / isOnline=false.
			const presence = await getPresence<RoomInstance>(c.env.DB, id)
			if (presence) {
				// A heartbeat whose LoginLock disagrees with the one recorded at login belongs
				// to a superseded session — return nothing so that stale client stops acting as
				// the live one. (No posted lock, or none recorded yet, skips the check.)
				if (
					postedLock !== undefined &&
					presence.loginLock !== undefined &&
					presence.loginLock !== postedLock
				) {
					return c.body(null, 200)
				}

				// Adopt the token's build when it differs from what the row holds, so the
				// version friends see follows the player onto their new build rather than
				// waiting for a re-matchmake.
				const versionChanged = version !== null && presence.appVersion !== version
				if (versionChanged) presence.appVersion = version

				// Otherwise the heartbeat's only side effect is refreshing the TTL, and only
				// once it's within PRESENCE_REFRESH_THRESHOLD (s) of lapsing — a still player is
				// refreshed periodically rather than re-written on every beat. `expiresAt` is
				// epoch seconds.
				const nowSeconds = Math.floor(Date.now() / 1000)
				if (versionChanged || presence.expiresAt - nowSeconds <= PRESENCE_REFRESH_THRESHOLD) {
					await setPresence(c.env.DB, presence)
				}
			}

			return c.json(playerPayload(id, presence, version))
		}
	)

	.put(
		'/player/statusvisibility',
		describeRoute({
			tags: ['Presence'],
			summary: 'Set status visibility',
			description: [
				'Updates the stored presence’s status visibility. No-op when the player has no live',
				'presence or an unauthenticated/invalid token — always acks 200.',
			].join(' '),
			requestBody: form(StatusVisibilityRequest, 'The statusVisibility value'),
			responses: { 200: EMPTY_OK },
		}),
		async (c) => {
			const id = await authedId(c)
			if (id !== null) {
				const body = await c.req.parseBody().catch(() => ({}) as Record<string, unknown>)
				const sv =
					typeof body.statusVisibility === 'string'
						? Number.parseInt(body.statusVisibility, 10)
						: NaN
				const presence = await getPresence<RoomInstance>(c.env.DB, id)
				if (presence && !Number.isNaN(sv)) {
					presence.statusVisibility = sv
					await setPresence(c.env.DB, presence)
				}
			}
			return c.body(null, 200)
		}
	)

	// The caller's "avoid juniors" preference. It's asked of this worker because it's a
	// matchmaking question, but it isn't matchmaking state: the setting is written by the
	// client through the `playersettings` worker, so this reads that worker's KV map
	// directly (read-only) rather than keeping a second copy of the same toggle here.
	.get(
		'/player/avoidjuniors',
		describeRoute({
			tags: ['Player settings'],
			summary: 'The player’s “avoid juniors” preference',
			description: [
				'Whether the authenticated player asked to be kept away from junior accounts, read',
				'from their settings map in the `playersettings` KV. The body is a bare JSON boolean',
				'(`true`/`false`), not an envelope. A player who never set it reads `false`.',
			].join(' '),
			security: AUTHED,
			responses: {
				200: json(AvoidJuniorsResponse, 'The preference; `false` when never set'),
				401: UNAUTHORIZED_RESPONSE,
			},
		}),
		async (c) => {
			const id = await authedId(c)
			if (id === null) return unauthorized(c)

			return c.json(await readAvoidJuniors(c.env, id))
		}
	)

	// Set the preference. Answers the RESULTING value rather than an empty ack, the way the
	// GET does — the client has just changed a toggle it renders, and a body it can read
	// back can't disagree with what was stored.
	.put(
		'/player/avoidjuniors',
		describeRoute({
			tags: ['Player settings'],
			summary: 'Set the player’s “avoid juniors” preference',
			description: [
				'Stores the posted preference in the authenticated player’s settings map (the',
				'`playersettings` KV) and answers the resulting value as a bare JSON boolean. The',
				'write merges, so the player’s other settings are left alone. A body with no readable',
				'`avoidJuniors` value leaves the setting as it was and answers the stored value — a',
				'no-op 200, not a 400.',
			].join(' '),
			security: AUTHED,
			requestBody: form(AvoidJuniorsRequest, 'The preference to store'),
			responses: {
				200: json(AvoidJuniorsResponse, 'The preference now stored'),
				401: UNAUTHORIZED_RESPONSE,
			},
		}),
		async (c) => {
			const id = await authedId(c)
			if (id === null) return unauthorized(c)

			const posted = await readAvoidJuniorsBody(c)
			if (posted === undefined) return c.json(await readAvoidJuniors(c.env, id))

			await writeAvoidJuniors(c.env, id, posted)
			return c.json(posted)
		}
	)

	// ---- Room navigation -----------------------------------------------------
	// Each matchmake persists the resulting instance as the player's presence so the
	// heartbeat can replay it (keeping client presence in sync).
	//
	// Every route here answers through `matchmakeResult`, which stamps the response with
	// the `result` code and echoes back the request's `CorrelationId` — the client won't
	// accept a session it can't correlate to the attempt it made.
	//
	// Matchmake into a club's clubhouse (`/matchmake/club/{clubId}`). Registered before
	// the single-segment `/matchmake/:room` route so `club` isn't read as a room name.
	// Members only: the clubhouse is the club's private space, so a non-member (or
	// someone with a pending request, or banned) is refused rather than let in.
	.post(
		'/matchmake/club/:clubId{[0-9]+}',
		describeRoute({
			tags: ['Navigation'],
			summary: 'Matchmake into a club’s clubhouse',
			description: [
				'Looks the club up, checks the caller is a member of it, and places them into an',
				'instance of its clubhouse room. Returns errorCode 20 with a null instance when the',
				'club is unknown, has no clubhouse set, or the caller isn’t a member — and errorCode',
				'55 when they are banned from the clubhouse room.',
			].join(' '),
			security: AUTHED,
			requestBody: form(JoinModeRequest, 'Optional JoinMode'),
			parameters: [
				{
					name: 'clubId',
					in: 'path',
					required: true,
					description: 'Club id (digits only)',
					schema: { type: 'string', pattern: '^[0-9]+$' },
				},
			],
			responses: {
				200: json(
					MatchmakeResponse,
					'The clubhouse instance (or a null instance with errorCode 20 / 55 when it can’t be entered)'
				),
				401: UNAUTHORIZED_RESPONSE,
			},
		}),
		async (c) => {
			const id = await authedId(c)
			if (id === null) return unauthorized(c)

			const clubId = Number.parseInt(c.req.param('clubId'), 10)
			const club = await getClubSummary(c.env.DB, clubId)
			// One response for "no such club", "no clubhouse", and "not a member": the
			// client only needs "you're not going there", and a distinct code for the last
			// case would tell a non-member which clubs exist and have a clubhouse.
			if (!club?.clubhouseRoomId) return matchmakeResult(c, NO_SUCH_ROOM, null)
			if (!(await isClubMember(c.env.DB, clubId, id))) {
				return matchmakeResult(c, NO_SUCH_ROOM, null)
			}

			const joinMode = await readJoinMode(c)
			const { instance, errorCode } = await resolveRoomInstance(
				c,
				String(club.clubhouseRoomId),
				joinMode === 2,
				id
			)
			if (!instance) return matchmakeResult(c, errorCode, null)
			await enterRoom(c, id, instance)
			return matchmakeResult(c, 0, instance)
		}
	)

	// Matchmake into a player event (`/matchmake/event/{playerEventId}`) — the "join" on
	// an event. The event names the room (and optionally the subroom) to enter, so this
	// is a room matchmake behind an access check on the EVENT.
	.post(
		'/matchmake/event/:eventId{[0-9]+}',
		describeRoute({
			tags: ['Navigation'],
			summary: 'Matchmake into a player event',
			description: [
				'Places the caller into an instance of the event’s room — its subroom too, when the',
				'event pins one. Who may join: anyone, if the event is Public (1) or Unlisted (2),',
				'since unlisted only keeps an event out of the listings rather than closing it; and',
				'otherwise only the event’s creator or a player who has been invited to it (any',
				'`event_attendee` row, whatever their answer — being able to decline and change your',
				'mind is the point). Everyone else gets errorCode 35 (EventIsPrivate) with a null',
				'instance; an unknown event is the opaque errorCode 20, and 55 when the caller is',
				'banned from the room the event runs in.',
				'',
				'The event’s start and end times are NOT enforced — the reference has codes for',
				'both (4 EventNotStarted, 5 EventAlreadyFinished) but nothing here has been observed',
				'sending them, and locking a creator out of their own room before the hour would be',
				'worse than letting people in early.',
			].join(' '),
			security: AUTHED,
			requestBody: form(MatchmakeRoomRequest, 'Optional JoinMode and AdditionalPlayerIds'),
			parameters: [
				{
					name: 'eventId',
					in: 'path',
					required: true,
					description: 'Player event id (digits only)',
					schema: { type: 'string', pattern: '^[0-9]+$' },
				},
			],
			responses: {
				200: json(
					MatchmakeResponse,
					'The event’s instance (or a null instance with errorCode 20 / 35 / 55)'
				),
				401: UNAUTHORIZED_RESPONSE,
			},
		}),
		async (c) => {
			const id = await authedId(c)
			if (id === null) return unauthorized(c)

			const eventId = Number.parseInt(c.req.param('eventId'), 10)
			const event = await getEventById(c.env.DB, eventId)
			// Opaque, like the club path: an unknown event and one the caller can't see
			// shouldn't be distinguishable by probing ids.
			if (event === null) return matchmakeResult(c, NO_SUCH_ROOM, null)

			const open =
				event.Accessibility === Accessibility.Public ||
				event.Accessibility === Accessibility.Unlisted
			// An `event_attendee` row is the invite: bulkInvite writes one, and so does
			// responding, so anyone who was invited or answered passes. The creator is checked
			// separately so an event whose creator deleted their own response still lets them in.
			if (
				!open &&
				event.CreatorPlayerId !== id &&
				(await getEventResponse(c.env.DB, eventId, id)) === null
			) {
				logger.info('matchmake refused: not invited to private event', { eventId, id })
				return matchmakeResult(c, EVENT_IS_PRIVATE, null)
			}

			const { joinMode, additionalPlayerIds } = await readMatchmakeBody(c)
			const { instance, errorCode } = await resolveRoomInstance(
				c,
				String(event.RoomId),
				joinMode === 2,
				id,
				event.SubRoomId ?? undefined
			)
			if (!instance) return matchmakeResult(c, errorCode, null)
			await enterRoom(c, id, instance)
			await inviteParty(c, id, additionalPlayerIds, instance)
			return matchmakeResult(c, 0, instance)
		}
	)

	// Follow a friend into the room they're in (`/matchmake/player/{playerId}`). Friends
	// ONLY — the caller must be a mutual friend of the target, or it's refused; otherwise
	// anyone could read a player's presence and warp to them. Reads the friend's current
	// instance from their stored presence and places the caller into that same instance
	// (the real, un-redacted Photon coordinates — the caller is authorized to join).
	// Registered before the single-segment `/matchmake/:room` route so `player` isn't read
	// as a room name. Returns errorCode 20 with a null instance when the target isn't a
	// friend or isn't currently in a room.
	.post(
		'/matchmake/player/:playerId{[0-9]+}',
		describeRoute({
			tags: ['Navigation'],
			summary: 'Follow a friend into their room',
			description: [
				'Places the caller into the room instance the target player is currently in, read',
				'from the target’s stored presence. FRIENDS ONLY: the caller must be a mutual friend',
				'of the target (otherwise anyone could read a player’s presence and warp to them).',
				'Returns errorCode 20 with a null instance when the target isn’t a friend, is the',
				'caller themselves, or isn’t currently in a room, and errorCode 55 when the caller is',
				'banned from the room the friend is in — this path hands out join coordinates without',
				'going through the room resolver, so it carries its own ban check.',
			].join(' '),
			security: AUTHED,
			requestBody: form(CorrelationIdRequest, 'The attempt’s CorrelationId'),
			parameters: [
				{
					name: 'playerId',
					in: 'path',
					required: true,
					description: 'The friend to follow (digits only)',
					schema: { type: 'string', pattern: '^[0-9]+$' },
				},
			],
			responses: {
				200: json(
					MatchmakeResponse,
					'The friend’s instance (or a null instance with errorCode 20 / 55 when it can’t be joined)'
				),
				401: UNAUTHORIZED_RESPONSE,
			},
		}),
		async (c) => {
			const id = await authedId(c)
			if (id === null) return unauthorized(c)

			const targetId = Number.parseInt(c.req.param('playerId'), 10)
			// Friends only, and never yourself — otherwise refuse without leaking whether the
			// target is even online (same opaque NoSuchRoom the club path uses).
			if (targetId === id || !(await areFriends(c.env.DB, id, targetId))) {
				return matchmakeResult(c, NO_SUCH_ROOM, null)
			}

			// The instance the friend is currently in, straight off their presence row.
			const targetPresence = await getPresence<RoomInstance>(c.env.DB, targetId)
			const instance = targetPresence?.roomInstance ?? null
			if (!instance) return matchmakeResult(c, NO_SUCH_ROOM, null)

			// This path hands out a Photon room id without going through
			// resolveRoomInstance, so the room's bans have to be checked here too —
			// otherwise following a friend in is a way around a ban.
			if (await isPlayerBannedFromRoom(c.env.DB, instance.roomId, id)) {
				logger.info('follow refused: player banned from room', { roomId: instance.roomId, id })
				return matchmakeResult(c, BANNED_FROM_ROOM, null)
			}

			// Join that same instance (same id + Photon room) and store it as the caller's
			// presence, so the heartbeat replays it and their own friend fan-out fires.
			await enterRoom(c, id, instance)
			return matchmakeResult(c, 0, instance)
		}
	)

	// Join one SPECIFIC live instance by id (`/matchmake/instance/{roomInstanceId}`) —
	// the action behind the owner's instance listing (`GET /room/{roomId}/instances`),
	// where they pick a session of their room and drop into it. Unlike every other
	// matchmake this targets a fixed instance: nothing is reused, nothing is created,
	// and a full or in-progress instance is still entered (moderating a full instance
	// is the point). OWNER-ONLY, gated with the same creator-or-co-owner check as the
	// listing — the Photon room id is the join coordinate, so an open version of this
	// would let anyone warp into any private session by guessing an id. Registered
	// before the `/matchmake/room/…` routes so `instance` isn't read as a room name.
	.post(
		'/matchmake/instance/:instanceId{[0-9]+}',
		describeRoute({
			tags: ['Navigation'],
			summary: 'Join a specific instance (owner only)',
			description: [
				'Places the caller into one specific live instance of their own room, picked by id',
				'from the owner’s instance listing. Gated to the room’s creator or a co-owner.',
				'Unlike the other matchmakes this never reuses or creates an instance, and enters',
				'even a full or in-progress one. Returns errorCode 20 with a null instance when the',
				'instance or its room is gone, or the caller doesn’t manage that room; errorCode 55',
				'when banned.',
			].join(' '),
			security: AUTHED,
			requestBody: form(CorrelationIdRequest, 'The attempt’s CorrelationId'),
			parameters: [
				{
					name: 'instanceId',
					in: 'path',
					required: true,
					description: 'Room instance id (digits only)',
					schema: { type: 'string', pattern: '^[0-9]+$' },
				},
			],
			responses: {
				200: json(
					MatchmakeResponse,
					'The instance (or a null instance with errorCode 20 / 55 when it can’t be joined)'
				),
				401: UNAUTHORIZED_RESPONSE,
			},
		}),
		async (c) => {
			const id = await authedId(c)
			if (id === null) return unauthorized(c)

			const instanceId = Number.parseInt(c.req.param('instanceId'), 10)
			const stored = await getRoomInstance(c.env.DB, instanceId)
			// One opaque refusal for "no such instance", "no such room" and "not yours":
			// a distinct code for the last would confirm which instance ids are live.
			if (!stored) return matchmakeResult(c, NO_SUCH_ROOM, null)
			const room = await getRoomById(c.env.DB, stored.roomId)
			if (!room) return matchmakeResult(c, NO_SUCH_ROOM, null)
			if (!canManageRoom(room, id)) {
				logger.info('instance matchmake refused: not the room’s owner', {
					roomInstanceId: instanceId,
					roomId: stored.roomId,
					accountId: id,
				})
				return matchmakeResult(c, NO_SUCH_ROOM, null)
			}

			// Like the follow-a-friend path, this hands out a Photon room id without going
			// through resolveRoomInstance, so the room's bans are checked here too. An owner
			// can't ban themselves out of their own room in practice, but a co-owner can be
			// banned, and a ban must beat every route that yields join coordinates.
			if (await isPlayerBannedFromRoom(c.env.DB, stored.roomId, id)) {
				logger.info('instance matchmake refused: player banned from room', {
					roomId: stored.roomId,
					id,
				})
				return matchmakeResult(c, BANNED_FROM_ROOM, null)
			}

			// Rebuild the wire instance from the room (fresh scene + published save) keyed to
			// this instance's own id and Photon room, so the owner lands in exactly the
			// session they picked rather than a new one alongside it.
			const instance = roomInstanceFromRoom(
				room,
				stored.isPrivate,
				stored.roomInstanceId,
				stored.photonRoomId,
				stored.subRoomId
			)
			await enterRoom(c, id, instance)
			return matchmakeResult(c, 0, instance)
		}
	)

	// Matchmake into a specific subroom of a room (`/matchmake/room/{roomId}/{subRoomId}`
	// — the client uses this to enter a room's other scenes). The subroom decides the
	// scene the client loads and which instances are joinable, so it must be carried
	// through; an unknown subroom falls back to the room's first.
	.post(
		'/matchmake/room/:roomId/:subRoomId{[0-9]+}',
		describeRoute({
			tags: ['Navigation'],
			summary: 'Matchmake into a specific subroom',
			description: [
				'Enters a specific subroom (scene) of a room. The subroom decides the scene loaded',
				'and which instances are joinable; an unknown subroom falls back to the room’s first.',
			].join(' '),
			security: AUTHED,
			requestBody: form(MatchmakeRoomRequest, 'Optional JoinMode and AdditionalPlayerIds'),
			parameters: [
				{ name: 'roomId', in: 'path', required: true, schema: { type: 'string' } },
				{
					name: 'subRoomId',
					in: 'path',
					required: true,
					description: 'Subroom id (digits only)',
					schema: { type: 'string', pattern: '^[0-9]+$' },
				},
			],
			responses: {
				200: json(
					MatchmakeResponse,
					'The instance (or a null instance with errorCode 20 on an unknown room, 55 when banned)'
				),
				401: UNAUTHORIZED_RESPONSE,
			},
		}),
		async (c) => {
			const id = await authedId(c)
			if (id === null) return unauthorized(c)
			const { joinMode, additionalPlayerIds } = await readMatchmakeBody(c)
			const subRoomId = Number.parseInt(c.req.param('subRoomId'), 10)
			const { instance, errorCode } = await resolveRoomInstance(
				c,
				c.req.param('roomId'),
				joinMode === 2,
				id,
				subRoomId
			)
			if (!instance) return matchmakeResult(c, errorCode, null)
			await enterRoom(c, id, instance)
			// Pull the caller's party (AdditionalPlayerIds) into the instance they landed in.
			await inviteParty(c, id, additionalPlayerIds, instance)
			return matchmakeResult(c, 0, instance)
		}
	)

	// The 2023 client uses a two-segment matchmake/room/{roomId}. Look the room up
	// in D1 so the instance carries its real scene, and store it as presence.
	.post(
		'/matchmake/room/:roomId',
		describeRoute({
			tags: ['Navigation'],
			summary: 'Matchmake into a room (default subroom)',
			description: [
				'The 2023 client’s two-segment matchmake. Resolves the room from D1 so the instance',
				'carries its real scene, and stores it as presence.',
			].join(' '),
			security: AUTHED,
			requestBody: form(MatchmakeRoomRequest, 'Optional JoinMode and AdditionalPlayerIds'),
			parameters: [{ name: 'roomId', in: 'path', required: true, schema: { type: 'string' } }],
			responses: {
				200: json(
					MatchmakeResponse,
					'The instance (or a null instance with errorCode 20 on an unknown room, 55 when banned)'
				),
				401: UNAUTHORIZED_RESPONSE,
			},
		}),
		async (c) => {
			const id = await authedId(c)
			if (id === null) return unauthorized(c)
			const { joinMode, additionalPlayerIds } = await readMatchmakeBody(c)
			const { instance, errorCode } = await resolveRoomInstance(
				c,
				c.req.param('roomId'),
				joinMode === 2,
				id
			)
			if (!instance) return matchmakeResult(c, errorCode, null)
			await enterRoom(c, id, instance)
			// Pull the caller's party (AdditionalPlayerIds) into the instance they landed in.
			await inviteParty(c, id, additionalPlayerIds, instance)
			return matchmakeResult(c, 0, instance)
		}
	)
	// Matchmake with no target. The client posts this when it needs an instance but isn't
	// going anywhere in particular — at startup, and while sitting in Orientation. It
	// answers the instance the player is ALREADY in, so it never warps anyone out of the
	// room they're standing in; only a player with no live presence falls back to their
	// dorm. Either way presence is re-committed, which refreshes its TTL.
	.post(
		'/matchmake/none',
		describeRoute({
			tags: ['Navigation'],
			summary: 'Matchmake with no target',
			description: [
				'Answers the instance the caller is already in, rather than sending them anywhere —',
				'this is what the client posts at startup and while in Orientation, so forcing a',
				'destination here would warp the player out of the room they are standing in. A',
				'caller with no live presence (their TTL lapsed, or they have never entered a room)',
				'falls back to their personal dorm. Re-commits presence either way, refreshing its',
				'TTL.',
			].join(' '),
			security: AUTHED,
			requestBody: form(CorrelationIdRequest, 'The attempt’s CorrelationId'),
			responses: {
				200: json(MatchmakeResponse, 'The caller’s current instance, or their dorm'),
				401: UNAUTHORIZED_RESPONSE,
			},
		}),
		async (c) => {
			const id = await authedId(c)
			if (id === null) return unauthorized(c)

			const presence = await getPresence<RoomInstance>(c.env.DB, id)
			const current = presence?.roomInstance ?? (await playerDormInstance(c, id))
			await enterRoom(c, id, current)
			return matchmakeResult(c, 0, current)
		}
	)

	.post(
		'/matchmake/dorm',
		describeRoute({
			tags: ['Navigation'],
			summary: 'Matchmake into the player’s dorm',
			description: [
				'Single-segment matchmake into the caller’s personal dorm, stored as presence. The',
				'client only ever calls this with the `dorm` keyword — real rooms go through',
				'`/matchmake/room/:roomId`. Returns errorCode 55 with a null instance when the',
				'account is banned: a ban keeps a player out of their own dorm too.',
			].join(' '),
			security: AUTHED,
			requestBody: form(CorrelationIdRequest, 'The attempt’s CorrelationId'),
			responses: {
				200: json(MatchmakeResponse, 'The dorm instance (or a null instance with errorCode 55)'),
				401: UNAUTHORIZED_RESPONSE,
			},
		}),
		async (c) => {
			const id = await authedId(c)
			if (id === null) return unauthorized(c)

			const instance = await playerDormInstance(c, id)
			await enterRoom(c, id, instance)
			return matchmakeResult(c, 0, instance)
		}
	)

	// The realtime credentials the caller should connect with: a freshly minted Photon
	// auth token, the Photon applications, and the Photon room they belong in. That last
	// one comes from the caller's own presence — the instance matchmaking put them in —
	// so it's the same name every other player in that instance is given. The reference
	// reads presence and nothing else; we fall back to looking the `roomInstanceId` query
	// param up when presence has no room (it expires on a TTL, and the client sometimes
	// asks before matchmaking has landed), and to an empty string when neither resolves.
	.get(
		'/player/connection-info',
		describeRoute({
			tags: ['Presence'],
			summary: 'Photon connection info',
			description: [
				'The realtime (Photon) credentials the caller should connect with, in a',
				'`{ success, value, error }` envelope: a freshly minted `photonAuthToken`, the',
				'Photon application ids, and the `photonRoomId` of the instance the caller is in',
				'(from their presence, falling back to the `roomInstanceId` query param). There is',
				'no separate voice server, so the voice fields are null. `experiments` carries the',
				'client’s networking flags.',
			].join(' '),
			security: AUTHED,
			parameters: [
				{
					name: 'roomInstanceId',
					in: 'query',
					required: false,
					description: 'The instance being connected to; used only when presence has no room',
					schema: { type: 'string' },
				},
			],
			responses: {
				200: json(ConnectionInfoResponse, 'The Photon credentials, room, and experiment flags'),
				401: UNAUTHORIZED_RESPONSE,
			},
		}),
		async (c) => {
			const id = await authedId(c)
			if (id === null) return unauthorized(c)

			const presence = await getPresence<RoomInstance>(c.env.DB, id)
			// Presence first (it's the instance the player is actually in); the query param
			// only stands in when there's no live presence to read.
			let photonRoomId = presence?.roomInstance?.photonRoomId ?? ''
			if (!photonRoomId) {
				const requested = Number.parseInt(c.req.query('roomInstanceId') ?? '', 10)
				if (!Number.isNaN(requested)) {
					photonRoomId = (await getRoomInstance(c.env.DB, requested))?.photonRoomId ?? ''
				}
			}

			// Identifies the player to Photon. Signed with the shared JWT secret; the token's
			// `aud` is the realtime app it's for. Nothing verifies it while Photon is
			// self-hosted, so it's identifying rather than authorizing.
			const photonAuthToken = await generatePhotonAuthToken(
				id,
				{
					platformId: (await getAccount(c.env.DB, id))?.platformId ?? '',
					platform: presence?.platform ?? 0,
					deviceClass: presence?.deviceClass ?? 0,
					audience: PHOTON_APPS.photonRealtimeAppId,
				},
				await c.env.JWT_SECRET.get()
			)

			return c.json({
				success: true,
				value: {
					photonAuthToken,
					...PHOTON_APPS,
					photonRoomId,
					// Empty strings rather than null: there's no separate voice server either
					// way, and the client's decoder is likelier to accept a missing-value string
					// than a null on a string field. The presence payload's
					// NULL_CONNECTION_INFO keeps its nulls — that one never carries credentials.
					voiceConnectionInfo: '',
					voiceServerId: '',
					experiments: PHOTON_EXPERIMENTS,
				},
				error: null,
			})
		}
	)

	// The regions to probe, which the two ping-report routes below are the other half of.
	// Unauthenticated: it's a fixed public list, and the client fetches it early. A bare
	// array — no `{ success, value, error }` envelope.
	.get(
		'/player/qos',
		describeRoute({
			tags: ['Presence'],
			summary: 'QoS probe targets',
			description: [
				'The regions the client pings to measure latency, reporting the results back through',
				'`PUT /player/photonregionpings`. Rec Room’s own probe endpoints, served verbatim —',
				'recflare runs none of its own, and the resulting ranking is unused anyway: every',
				'session is pinned to the one region `/player/connection-info` hands out.',
			].join(' '),
			responses: { 200: json(QosRegion.array(), 'The regions to probe, as `host:port`') },
		}),
		(c) => c.json(QOS_REGIONS)
	)

	// Region ping reports — accept-and-ack (the reference returns Ok()).
	.put(
		'/player/photonregionpings',
		describeRoute({
			tags: ['Presence'],
			summary: 'Photon region pings (no-op ack)',
			description: 'Region latency report; accepted and ignored.',
			responses: { 200: EMPTY_OK },
		}),
		(c) => c.body(null, 200)
	)
	.put(
		'/player/gameserverregionpings',
		describeRoute({
			tags: ['Presence'],
			summary: 'Game-server region pings (no-op ack)',
			description: 'Region latency report; accepted and ignored.',
			responses: { 200: EMPTY_OK },
		}),
		(c) => c.body(null, 200)
	)

	// ---- Social --------------------------------------------------------------
	// Invite a player to join the caller in their room instance. The caller is the
	// inviter (from the Bearer token); the form carries the target `playerId` and the
	// `roomInstanceId` they're being invited into. Delivers a game-invite Message to the
	// target over the notify hub as a MessageReceived frame — the client renders the
	// join prompt from it. When the room instance resolves, its RoomId rides along on the
	// message so the client knows which room the invite points at. Always acks 200 (a bad
	// playerId is a 400, a missing token a 401); hub delivery is best-effort, so a target
	// who's offline simply has the frame queued (or dropped) without failing the invite.
	.post(
		'/invite',
		describeRoute({
			tags: ['Social'],
			summary: 'Invite a player into the caller’s room instance',
			description: [
				'Sends a game invite from the caller (the Bearer token) to `playerId` for',
				'`roomInstanceId`. Delivered to the target over the notify hub as a `MessageReceived`',
				'notification carrying a game-invite `Message`; the resolved instance’s `RoomId` rides',
				'on the message. Acks 200 (bad `playerId` → 400); hub delivery is best-effort.',
			].join(' '),
			security: AUTHED,
			requestBody: form(InviteRequest, 'The target player and the room instance'),
			responses: {
				200: EMPTY_OK,
				400: { description: 'Missing, non-numeric, or zero playerId (empty body)' },
				401: UNAUTHORIZED_RESPONSE,
			},
		}),
		async (c) => {
			const id = await authedId(c)
			if (id === null) return unauthorized(c)

			const body = await c.req.parseBody().catch(() => ({}) as Record<string, unknown>)
			const str = (v: unknown) => (typeof v === 'string' ? v : '')
			const toPlayerId = Number.parseInt(str(body.playerId), 10)
			// A missing or zero target is a bad request (mirrors the reference's guard).
			if (Number.isNaN(toPlayerId) || toPlayerId === 0) return c.body(null, 400)

			const roomInstanceIdStr = str(body.roomInstanceId)
			const roomInstanceId = Number.parseInt(roomInstanceIdStr, 10)

			// Resolve the instance to stamp the invite's RoomId — the client reads it to know
			// which room the invite points at. A missing/unknown instance just leaves RoomId
			// null (buildNotificationPayload drops it from the frame), as the reference does.
			let roomId: number | null = null
			if (!Number.isNaN(roomInstanceId) && roomInstanceId > 0) {
				const instance = await getRoomInstance(c.env.DB, roomInstanceId)
				if (instance) roomId = instance.roomId
			}

			await sendGameInvite(c, id, toPlayerId, roomInstanceIdStr, roomId)
			return c.body(null, 200)
		}
	)

	// ---- Room instance -------------------------------------------------------
	.post(
		'/roominstance/:id/reportjoinresult',
		describeRoute({
			tags: ['Room instance'],
			summary: 'Report join result (no-op ack)',
			description: 'The client reports how a join went; accepted and ignored.',
			parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string' } }],
			responses: { 200: EMPTY_OK },
		}),
		(c) => c.body(null, 200)
	)

	// The instance's in-progress flag, flipped when a session starts (e.g. a game round
	// begins). Deliberately NOT owner-gated, unlike the other room-instance mutations:
	// this is set by whoever in the room starts the game, not by the room's owner — a
	// gate here would break game starts for everyone else. Body is a form post:
	// `inProgress=True|False`.
	.put(
		'/roominstance/:id/inprogress',
		describeRoute({
			tags: ['Room instance'],
			summary: 'Set instance in-progress flag',
			description: [
				'Flips the instance’s in-progress flag when a session starts (e.g. a round begins).',
				'Set by whoever in the room starts the game — any authenticated player, not just the',
				'room’s owner. Body is `inProgress=True|False`.',
			].join(' '),
			security: AUTHED,
			requestBody: form(InProgressRequest, 'The inProgress flag'),
			parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string' } }],
			responses: {
				200: EMPTY_OK,
				401: UNAUTHORIZED_RESPONSE,
				404: { description: 'Non-numeric id or no such instance (empty body)' },
			},
		}),
		async (c) => {
			const id = await authedId(c)
			if (id === null) return unauthorized(c)

			const instanceId = Number.parseInt(c.req.param('id'), 10)
			if (Number.isNaN(instanceId)) return c.body(null, 404)

			const body = await c.req.parseBody().catch(() => ({}) as Record<string, unknown>)
			const inProgress =
				typeof body.inProgress === 'string' && body.inProgress.toLowerCase() === 'true'

			const instance = await setRoomInstanceInProgress(c.env.DB, instanceId, inProgress)
			if (!instance) return c.body(null, 404)
			return c.body(null, 200)
		}
	)

	// Close a live instance to strangers (`/roominstance/{id}/markprivate`) — the owner
	// makes the session they're running private, so public matchmaking stops feeding new
	// players into it (getJoinableInstance only reuses non-private instances). Everyone
	// already inside stays put; this shuts the door rather than clearing the room.
	// OWNER-ONLY (same creator-or-co-owner gate as the instance listing): whether a
	// session is open is the room owner's call, not a passer-by's. Generic empty ack.
	.post(
		'/roominstance/:id/markprivate',
		describeRoute({
			tags: ['Room instance'],
			summary: 'Mark an instance private (owner only)',
			description: [
				'Marks a live instance private, so public matchmaking stops placing new players',
				'into it. Players already inside are unaffected. Auth-gated and gated to the',
				'instance’s room’s creator or a co-owner (403 otherwise). Empty ack.',
			].join(' '),
			security: AUTHED,
			parameters: [
				{
					name: 'id',
					in: 'path',
					required: true,
					description: 'Room instance id',
					schema: { type: 'string' },
				},
			],
			responses: {
				200: EMPTY_OK,
				401: UNAUTHORIZED_RESPONSE,
				403: { description: 'Not the room’s creator or a co-owner (empty body)' },
				404: { description: 'Non-numeric id or no such instance (empty body)' },
			},
		}),
		async (c) => {
			const id = await authedId(c)
			if (id === null) return unauthorized(c)

			const instanceId = Number.parseInt(c.req.param('id'), 10)
			if (Number.isNaN(instanceId)) return c.body(null, 404)

			const stored = await getRoomInstance(c.env.DB, instanceId)
			if (!stored) return c.body(null, 404)
			const room = await getRoomById(c.env.DB, stored.roomId)
			if (!room || !canManageRoom(room, id)) return c.body(null, 403)

			await setRoomInstancePrivate(c.env.DB, instanceId, true)
			return c.body(null, 200)
		}
	)

	// The room's live instances — the owner's view of active sessions of their room.
	// Auth-gated (401) and owner/co-owner-only (403): the caller must be the room's
	// creator or hold a Creator/CoOwner role on it. Unknown room → 404. Returns a
	// summary per instance (empty when the room has no live instances) — id, subroom,
	// fullness, creation time and who's currently in it — not the client's
	// RoomInstance DTO: this is a management listing, so it answers "who's in there"
	// and withholds the connection details of a session the owner isn't joining.
	.get(
		'/room/:roomId{[0-9]+}/instances',
		describeRoute({
			tags: ['Room instance'],
			summary: 'A room’s live instances',
			description: [
				'The owner’s view of active sessions of their room — each instance with the',
				'players currently in it. Auth-gated and gated to the room’s creator or a',
				'co-owner (403 otherwise). Unknown room → 404.',
			].join(' '),
			security: AUTHED,
			parameters: [
				{
					name: 'roomId',
					in: 'path',
					required: true,
					description: 'Room id (digits only)',
					schema: { type: 'string', pattern: '^[0-9]+$' },
				},
			],
			responses: {
				200: json(RoomInstanceSummaryDto.array(), 'Live instances (empty when none)'),
				401: UNAUTHORIZED_RESPONSE,
				403: { description: 'Not the room’s creator or a co-owner (empty body)' },
				404: { description: 'No such room (empty body)' },
			},
		}),
		async (c) => {
			const id = await authedId(c)
			if (id === null) return unauthorized(c)

			const roomId = Number.parseInt(c.req.param('roomId'), 10)
			const room = await getRoomById(c.env.DB, roomId)
			if (!room) return c.body(null, 404)
			// The room's creator *or* a co-owner (Role 30) may see its live instances —
			// same owner-or-co-owner gate the rooms worker uses for room-admin actions.
			if (!canManageRoom(room, id)) return c.body(null, 403)

			return c.json(await getRoomInstanceSummariesByRoom(c.env.DB, roomId))
		}
	)

	// Rooms flagged as needing a developer/moderator to spawn in. No such queue
	// yet → empty list.
	.get(
		'/rooms/requiring/developer',
		describeRoute({
			tags: ['Room instance'],
			summary: 'Rooms requiring a developer',
			description: 'Rooms flagged as needing a developer/moderator to spawn in. No queue yet → [].',
			responses: { 200: json(RoomInstanceDto.array(), 'Always empty for now') },
		}),
		(c) => c.json([])
	)

	// Rooms flagged as requiring an RR+ subscription. No such queue yet → empty list.
	.get(
		'/rooms/requiring/rrplus',
		describeRoute({
			tags: ['Room instance'],
			summary: 'Rooms requiring RR+',
			description: 'Rooms flagged as requiring an RR+ subscription. No queue yet → [].',
			responses: { 200: json(RoomInstanceDto.array(), 'Always empty for now') },
		}),
		(c) => c.json([])
	)

/**
 * Cron: sweep presence that has aged past its TTL, then the instances left empty.
 *
 * The presence purge isn't about correctness of `/player` — reads already ignore
 * expired rows. It's that a player who crashed or hard-quit never matchmakes out of
 * their instance, so nothing recomputes that instance's fullness and it can stay
 * flagged full (and unjoinable) with nobody in it. Note the instances the expiring
 * rows point at *before* deleting: the sweep is the only thing that notices those
 * departures.
 *
 * Emptying an instance is what makes it garbage — nothing ever reuses it, and a
 * joiner handed one would land alone in a Photon room everyone left — so the empty
 * sweep runs next. It reads presence without consulting expiry, so it depends on
 * running after the purge above: this order is what makes a lapsed row count as a
 * departure. Fullness is recomputed last, so it works from the final head-count and
 * skips (returns null for) the instances just deleted.
 */
async function sweepExpiredPresence(env: Env): Promise<void> {
	const staleInstanceIds = await getExpiredPresenceInstanceIds(env.DB)
	const removed = await deleteExpiredPresence(env.DB)
	const emptyInstanceIds = await deleteEmptyRoomInstances(env.DB)
	for (const instanceId of staleInstanceIds) {
		await refreshInstanceFullness(env.DB, instanceId)
	}
	// The tagged logger is request-scoped (its middleware never runs for a cron), so
	// log plainly here — Workers observability picks it up either way.
	console.log(
		`presence sweep: removed ${removed} expired rows, deleted ${emptyInstanceIds.length} empty instances, refreshed ${staleInstanceIds.length} instances`
	)
}

// The generated spec. Documentation only — no request is validated against it (see
// openapi.ts). `hide: true` keeps this route out of its own output. Registered on
// `app` before it's wrapped in the exported handler below.
app.get(
	'/openapi.json',
	describeRoute({ hide: true }),
	withCleanSpec(
		openAPIRouteHandler(app, {
			documentation: {
				info: {
					title: 'recflare match',
					version: '1.0.0',
					description: [
						'Matchmaking and presence for recflare, a private-server reimplementation of the Rec',
						'Room backend. Rooms and room instances are D1-backed (matchmaking finds or creates a',
						'`room_instance` per session); presence — the instance each player is currently in —',
						'lives in the shared `presence` table and expires on a TTL. A cron sweep clears',
						'expired presence, frees up instances a crashed player never left, and deletes',
						'instances nobody is standing in any more.',
					].join('\n'),
				},
				servers: [{ url: 'https://match.recflare.net', description: 'Production' }],
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

// The HTTP surface is a standard Hono app, exported by name so it can be mounted
// uniformly like every other worker (e.g. by a combined/facade worker). The cron
// that sweeps expired presence is exported alongside it.
export { app }

export const scheduled: ExportedHandlerScheduledHandler<Env> = (_controller, env, ctx) => {
	ctx.waitUntil(sweepExpiredPresence(env))
}

// Standalone entry: a Worker only runs `scheduled` when it's on the default export,
// so match keeps the object form the runtime requires to fire its `*/5 * * * *` cron.
export default { fetch: app.fetch, scheduled } satisfies ExportedHandler<Env>
