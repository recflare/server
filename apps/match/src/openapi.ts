import { resolver } from 'hono-openapi'
import { z } from 'zod'

import type { OpenAPIV3_1 } from 'openapi-types'

/**
 * OpenAPI schemas for the match worker.
 *
 * IMPORTANT: these are DESCRIPTIVE ONLY. They are passed to `describeRoute` to
 * generate the spec and are never wired into `hono-openapi`'s `validator()`.
 *
 * As with the auth/accounts workers, this is deliberate: the Rec Room client is the
 * only real consumer, the handlers are lenient (bodies are parsed defensively and
 * missing fields fall through to sensible defaults), and the exact request/response
 * shapes are reverse-engineered. These schemas record observed behaviour; to enforce
 * one, do it per-route and land a test with it.
 */

/** Emit a zod schema as an `application/json` response body. */
export function json(schema: z.ZodType, description: string) {
	return { description, content: { 'application/json': { schema: resolver(schema) } } }
}

/**
 * Convert a zod schema to a plain OpenAPI schema for a request body. `describeRoute`'s
 * `requestBody` takes an OpenAPI schema (not a `resolver()`). zod's `$schema` key and
 * `additionalProperties: false` are dropped — the handlers read the fields they know
 * and ignore the rest, so a closed object would misreport them as stricter than they
 * are.
 */
function toOpenApiSchema(schema: z.ZodType): OpenAPIV3_1.SchemaObject {
	const { $schema: _$schema, additionalProperties: _extra, ...jsonSchema } = z.toJSONSchema(schema)
	return jsonSchema as OpenAPIV3_1.SchemaObject
}

/** A form-urlencoded / multipart request body (the client posts both). */
export function form(schema: z.ZodType, description: string): OpenAPIV3_1.RequestBodyObject {
	const s = toOpenApiSchema(schema)
	return {
		description,
		content: {
			'application/x-www-form-urlencoded': { schema: s },
			'multipart/form-data': { schema: s },
		},
	}
}

/** An `application/json` request body (the heartbeat posts one). */
export function jsonBody(schema: z.ZodType, description: string): OpenAPIV3_1.RequestBodyObject {
	return { description, content: { 'application/json': { schema: toOpenApiSchema(schema) } } }
}

/** An empty-body `200 OK` ack — the response many match routes return. */
export const EMPTY_OK = { description: 'Acknowledged (empty body)' }

/** The empty-body 401 the auth-gated routes return. */
export const UNAUTHORIZED_RESPONSE = { description: 'Missing or invalid bearer token (empty body)' }

/** Bearer-JWT security requirement, for the auth-gated routes. */
export const AUTHED = [{ bearerAuth: [] }]

/**
 * RoomInstanceType enum, by value. `Dormroom` instances are private; `Public` are the
 * shared, joinable ones matchmaking reuses.
 */
export const RoomInstanceType = z
	.int()
	.describe('RoomInstanceType: 0 Public, 1 Dormroom, … (see @repo/domain)')

/**
 * A room instance — the session the client connects to (scene + Photon coordinates).
 * Joiners of the same public instance share `roomInstanceId` and `photonRoomId`. Names
 * are `^`-prefixed so the client resolves the scene (personal dorms use `@owner's Dorm`
 * instead). `location` is the SubRoom's Unity scene id; an empty one makes the client
 * reject the session.
 */
export const RoomInstanceDto = z.object({
	roomInstanceId: z.int(),
	roomId: z.int(),
	subRoomId: z.int().describe('Which subroom (scene) of the room this instance is'),
	roomInstanceType: RoomInstanceType,
	location: z.string().describe('SubRoom Unity scene id; empty is rejected by the client'),
	dataBlob: z.string(),
	eventId: z.int(),
	clubId: z.int(),
	roomCode: z.string(),
	photonRegion: z.string(),
	photonRegionId: z.string(),
	photonRoomId: z.string().describe('Shared by joiners of the same instance'),
	name: z.string().describe('`^`-prefixed (or `@owner’s Dorm` for personal dorms)'),
	maxCapacity: z.int(),
	isFull: z.boolean(),
	isPrivate: z.boolean(),
	isInProgress: z.boolean().describe('Set by the owner via PUT /roominstance/:id/inprogress'),
	EncryptVoiceChat: z.boolean(),
})

/**
 * One live instance in the owner's management listing (`GET /room/:roomId/instances`).
 * Not the client `RoomInstanceDto`: it carries who's in there and drops the connection
 * details (photon ids, data blob, room code) of a session the owner isn't in.
 */
export const RoomInstanceSummaryDto = z.object({
	roomInstanceId: z.int(),
	roomId: z.int(),
	subRoomId: z.int().describe('Which subroom (scene) of the room this instance is'),
	isFull: z.boolean(),
	createdAt: z.string().describe('ISO 8601 UTC, stamped when the instance was created'),
	playerIds: z
		.array(z.int())
		.describe('Accounts currently in the instance (live presence); empty when nobody is'),
})

/**
 * A player's presence as the client reads it (`GET /player`, `POST /player/heartbeat`).
 * `isOnline` means "has a live (unexpired) presence row", NOT "is in a room" — a player
 * can be online in the lobby with `roomInstance` null. The `photon*`/`voice*`
 * connection fields are only populated in a matchmaking response, never here, but the
 * client needs the keys present, so they're always null.
 */
export const PlayerDto = z.object({
	playerId: z.int(),
	isOnline: z.boolean().describe('Has a live presence row (presence expires on a TTL)'),
	errorCode: z.int().describe('0 = no error; non-zero only on a failed matchmake'),
	roomInstance: RoomInstanceDto.nullable().describe('null when not in a room'),
	appVersion: z.string(),
	deviceClass: z.int(),
	statusVisibility: z.int(),
	vrMovementMode: z.int(),
	platform: z.int(),
	photonAuthToken: z.null(),
	photonRealtimeAppId: z.null(),
	photonVoiceAppId: z.null(),
	photonChatAppId: z.null(),
	photonRegion: z.null(),
	photonRoomId: z.null(),
	voiceConnectionInfo: z.null(),
	voiceServerId: z.null(),
	experiments: z.null(),
})

/**
 * The matchmake result envelope. `errorCode` 0 with a `roomInstance` is success;
 * a non-zero code (e.g. 20 NoSuchRoom) comes with `roomInstance: null`.
 */
export const MatchmakeResponse = z.object({
	errorCode: z
		.int()
		.describe('0 = success; 20 = NoSuchRoom; 55 = banned from the room (the one non-opaque code)'),
	roomInstance: RoomInstanceDto.nullable(),
})

/**
 * `GET /player/avoidjuniors` — a BARE JSON boolean (`true`/`false`), not an envelope and
 * not a `{ value }` wrapper. The whole body is the preference.
 */
export const AvoidJuniorsResponse = z
	.boolean()
	.describe('Whether the player asked to be kept away from junior accounts')

/**
 * `PUT /player/avoidjuniors` form body. The client posts `avoidJuniors=True`; the field is
 * matched case-insensitively and `True`/`false`/`1`/`0`/`yes`/`no` all parse, since neither
 * the casing nor the spelling of the boolean is guaranteed across the client's surfaces.
 */
export const AvoidJuniorsRequest = z.object({
	avoidJuniors: z.string().describe('`True`/`False` (also `1`/`0`, `yes`/`no`)'),
})

/** `POST /player/exclusivelogin` — a bare error code. */
export const ExclusiveLoginResponse = z.object({ errorCode: z.int().describe('Always 0') })

/**
 * The networking feature flags the client reads off its connection info — verbatim
 * from the reference server. The client changes how it replicates based on these, so
 * they are not free to tune. `shouldUseGameServerNetworking` is the load-bearing one:
 * true points the client at a local game server (127.0.0.1:7777) instead of Photon.
 */
export const ConnectionExperiments = z.object({
	networkTransformSyncInterval: z.number(),
	shouldUseUnreliableOnChange: z.boolean(),
	shouldAvoidDiscontinuityRPCs: z.boolean(),
	shouldAvoidRedundantDiscontinuity: z.boolean(),
	r2RuntimeStaticBaking: z.boolean(),
	r2AutoEmbodiment: z.boolean(),
	r2RuntimeStaticBakingMinShapeThreshold: z.int(),
	r2UseCheapReplicas: z.boolean(),
	shouldUseGameServerNetworking: z
		.boolean()
		.describe('true connects to a local game server instead of Photon'),
})

/**
 * `GET /player/connection-info` — the realtime (Photon) credentials, in a
 * `{ success, value, error }` envelope. The applications and region are fixed for
 * recflare; what varies per caller is `photonAuthToken` (minted for them on the spot)
 * and `photonRoomId`, the Photon room of the instance their presence says they're in
 * — the same name every other player in that instance is handed. There's no separate
 * voice server, so both voice fields are null. `photonRegion` matches the one stamped
 * on every room instance, so the two can't disagree.
 */
export const ConnectionInfo = z.object({
	photonAuthToken: z.string().describe('Short-lived HS256 token identifying the caller to Photon'),
	photonRealtimeAppId: z.string().describe('Photon Realtime application id'),
	photonVoiceAppId: z.string().describe('Photon Voice application id'),
	photonChatAppId: z.string().describe('Photon Chat application id'),
	photonRegion: z.string().describe('Region id, matching a room instance’s `photonRegion`'),
	photonRoomId: z.string().describe('The caller’s current instance; empty when they’re in none'),
	voiceConnectionInfo: z.null().describe('Null — no separate voice server'),
	voiceServerId: z.null().describe('Null — no separate voice server'),
	experiments: ConnectionExperiments,
})

/** `GET /player/connection-info` — the connection info in the client's standard envelope. */
export const ConnectionInfoResponse = z.object({
	success: z.literal(true),
	value: ConnectionInfo,
	error: z.null(),
})

/**
 * One QoS probe target (`GET /player/qos`) — a region the client pings to measure
 * latency, then reports back through `PUT /player/photonregionpings`. A bare array,
 * not the `{ success, value, error }` envelope. `id` is the region id the pings are
 * keyed by; `address` is `host:port`, not a URL.
 */
export const QosRegion = z.object({
	id: z.string().describe('Region id, e.g. `us-east1`'),
	address: z.string().describe('`host:port` of the probe endpoint'),
})

/**
 * The session `LoginLock` GUID form field. The client posts it on every presence
 * lifecycle call — `POST /player/login`, `/player/exclusivelogin`, `/player/logout`,
 * and `/player/heartbeat` — so it's always present, not optional. Recorded in presence
 * at login and verified on each heartbeat (a mismatched lock is a superseded session).
 */
export const LoginLockRequest = z.object({
	LoginLock: z.string().describe('The session login-lock GUID (always sent)'),
})

/** `PUT /roominstance/:id/inprogress` form body. */
export const InProgressRequest = z.object({
	inProgress: z.string().describe('"True" | "False" (case-insensitive)'),
})

/** `PUT /player/statusvisibility` form body. */
export const StatusVisibilityRequest = z.object({
	statusVisibility: z.string().describe('Integer string; non-numeric is ignored'),
})

/**
 * `POST /player/notifydisconnect` form body — posted by Photon when it sees a player
 * drop a room instance. Both fields are integer strings.
 */
export const NotifyDisconnectRequest = z.object({
	PlayerId: z.string().describe('The account that disconnected'),
	RoomInstanceId: z.string().describe('The room instance they dropped'),
})

/**
 * The `JoinMode` form field the matchmake routes read (`2` = a private instance;
 * anything else = public). Posted as a urlencoded/multipart body.
 */
export const JoinModeRequest = z.object({
	JoinMode: z.string().optional().describe('"2" requests a private instance'),
})

/**
 * The room-matchmake form body (`/matchmake/room/:roomId[/:subRoomId]`). Beyond
 * `JoinMode` the 2023 client posts `AdditionalPlayerIds` — the caller's party — so each
 * of them is invited (a game invite) into the instance the leader lands in. It's a
 * repeated field (one id each, not comma-separated). Other fields the client sends
 * (`LoginLock`, `MaxPersistenceVersion`, `BypassMovementModeRestriction`) are accepted
 * and ignored.
 */
export const MatchmakeRoomRequest = z.object({
	JoinMode: z.string().optional().describe('"2" requests a private instance'),
	AdditionalPlayerIds: z
		.string()
		.optional()
		.describe('Party members to invite into the room; repeated once per id'),
})

/** `POST /invite` form body — invite a player into the caller's room instance. */
export const InviteRequest = z.object({
	playerId: z.string().describe('The account to invite; a non-zero integer (else 400)'),
	roomInstanceId: z
		.string()
		.optional()
		.describe('The caller’s room instance to invite them into; resolves the invite’s RoomId'),
})
