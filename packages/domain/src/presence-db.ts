/**
 * Player presence — the room instance a player is currently in, plus the status
 * fields the match heartbeat echoes back. Stored on the shared `recflare` D1 with
 * the same JSON-blob pattern as the rooms/room_instance tables: the full presence
 * is a JSON blob in `data`, and the fields we query on (account_id,
 * room_instance_id, room_id, expires_at) are SQLite generated (virtual) columns
 * extracted from it. One row per account (unique `account_id`); writes upsert via
 * `INSERT OR REPLACE`.
 *
 * The `match` worker owns presence — written on matchmake/heartbeat, read by the
 * heartbeat and the batch `/player` lookup. The `auth` worker seeds it for new
 * players (Orientation) and the `rooms` worker reads it (Photon access token). All
 * three import these helpers from `@repo/domain`; the `rooms` worker owns the
 * schema (migrations/0006_presence.sql).
 *
 * This replaces the old match-presence KV. D1 gives strong reads (no cross-PoP
 * staleness that would read presence as out-of-sync and bounce the player), a
 * single-query batch lookup for `/player`, and lets matchmaking count players per
 * instance (see {@link countPlayersInInstance}). Rows carry an absolute
 * `expiresAt` (epoch seconds); reads filter expired rows out and
 * {@link deleteExpiredPresence} purges them.
 */

/** Presence is kept this long (s) after the last matchmake/heartbeat refresh. */
export const PRESENCE_TTL_SECONDS = 900

/**
 * Game build version reported in presence (and echoed in the auth token's `rn.ver`
 * claim). This is a server-side constant — the client doesn't supply it, and an
 * empty value breaks the client's presence/version handling. Matches our target
 * 2023 client build.
 */
export const GAME_VERSION = '20230414'

/**
 * Client builds `/api/versioncheck/v4` answers "current" for. `GAME_VERSION` is the one
 * the rest of the stack targets and reports for itself; the others are later clients
 * that talk close enough to the same protocol to get past the update prompt.
 *
 * DEBUGGING ONLY beyond `GAME_VERSION`: this is not a supported-version list. Nothing
 * else in the stack targets those builds, so a client waved through here can still hit
 * protocol differences the version check would otherwise have caught. Trim it back to
 * `GAME_VERSION` alone before anyone but us is playing.
 */
export const SUPPORTED_GAME_VERSIONS: string[] = [
	GAME_VERSION,
	'20230616',
	'20231207',
	'20250424.01',
	'20250718.01',
]

/** Whether a client-supplied build (the version check's `?v=`) is one we serve. */
export function isSupportedGameVersion(version: string | null | undefined): boolean {
	return version != null && SUPPORTED_GAME_VERSIONS.includes(version)
}

/** Schema DDL (mirror of migrations/0006_presence.sql). */
export const PRESENCE_SCHEMA_DDL: string[] = [
	`CREATE TABLE IF NOT EXISTS presence (
		data TEXT NOT NULL,
		account_id INTEGER GENERATED ALWAYS AS (json_extract(data, '$.accountId')) VIRTUAL,
		room_instance_id INTEGER GENERATED ALWAYS AS (json_extract(data, '$.roomInstance.roomInstanceId')) VIRTUAL,
		room_id INTEGER GENERATED ALWAYS AS (json_extract(data, '$.roomInstance.roomId')) VIRTUAL,
		expires_at INTEGER GENERATED ALWAYS AS (json_extract(data, '$.expiresAt')) VIRTUAL
	)`,
	`CREATE UNIQUE INDEX IF NOT EXISTS idx_presence_account ON presence (account_id)`,
	`CREATE INDEX IF NOT EXISTS idx_presence_room_instance ON presence (room_instance_id)`,
	`CREATE INDEX IF NOT EXISTS idx_presence_expires ON presence (expires_at)`,
]

/**
 * How coarse a stored player location is, in degrees — about 55km at the equator.
 *
 * Coordinates are snapped to this grid BEFORE they are written, so nothing finer than a
 * grid cell ever reaches the database. The only thing that reads them is the globe on
 * the website, where the whole earth renders a few hundred pixels across and a cell is
 * comfortably under one pixel — so the blur costs the picture nothing, and a leak of the
 * presence table still can't put anybody in a particular town.
 */
export const GEO_GRID_DEGREES = 0.5

/**
 * A live player's approximate location, derived from the IP their request arrived on and
 * stored INSTEAD of it — presence never holds an address, and nothing downstream can
 * recover one from this.
 *
 * Cloudflare resolves the address at the edge and hands us the result on `request.cf`, so
 * there's no third-party lookup and no IP for our own code to handle. What arrives is
 * already city-grade at best; {@link presenceGeoFromCf} snaps it to GEO_GRID_DEGREES on
 * top of that.
 */
export interface PresenceGeo {
	/** Latitude, snapped to the grid. */
	lat: number
	/** Longitude, snapped to the grid. */
	lon: number
	/** ISO 3166-1 alpha-2, uppercased — `XX` when the edge didn't name a real country. */
	country: string
}

/**
 * The part of `request.cf` a location is read from — the whole of the contract with the
 * edge, in one place. Cloudflare sends all three as strings.
 */
export interface GeoProperties {
	latitude?: string | null
	longitude?: string | null
	country?: string | null
}

/**
 * The location to stamp on a presence row, or null when the request carries none.
 *
 * Null is the ordinary case in local dev (miniflare sets no `cf`) and for any address the
 * edge can't place, so callers carry the row's previous location forward rather than
 * blanking it — a player who keeps heartbeating shouldn't drop off the globe because one
 * request arrived without geolocation.
 */
export function presenceGeoFromCf(properties: unknown): PresenceGeo | null {
	// `unknown` rather than {@link GeoProperties}, because callers pass `c.req.raw.cf`,
	// which Hono types as the union of the incoming and OUTGOING `cf` shapes — and the
	// outgoing one has no geolocation on it at all, so nothing narrower accepts the
	// argument every caller actually has. Every read below already tolerates a miss.
	const cf = properties as GeoProperties | undefined | null
	const lat = Number.parseFloat(String(cf?.latitude ?? ''))
	const lon = Number.parseFloat(String(cf?.longitude ?? ''))
	if (!Number.isFinite(lat) || !Number.isFinite(lon)) return null
	// `country` is alpha-2 for a real country and something else for the pseudo-countries
	// (`T1` is Tor); the shape test is what sorts them, so a new one can't leak through.
	const country = typeof cf?.country === 'string' ? cf.country.toUpperCase() : ''
	return {
		lat: snapToGeoGrid(lat),
		lon: snapToGeoGrid(lon),
		country: /^[A-Z]{2}$/.test(country) ? country : 'XX',
	}
}

/** Round a coordinate onto the GEO_GRID_DEGREES grid. */
function snapToGeoGrid(value: number): number {
	// Re-rounded through toFixed because binary floats don't land on clean multiples
	// (34.9 / 0.5 * 0.5 is 34.900000000000006), and two spellings of one cell would GROUP
	// BY into two pins sitting on top of each other. Adding 0 normalises -0 to 0, which
	// would otherwise be a third.
	return Number((Math.round(value / GEO_GRID_DEGREES) * GEO_GRID_DEGREES + 0).toFixed(4))
}

/**
 * The presence a caller writes — the room instance the player is in plus the
 * status fields the heartbeat echoes. Generic over the room-instance shape so each
 * worker keeps its own typing (`match` its full instance, `rooms` just the id).
 */
export interface PresenceInput<TRoomInstance = unknown> {
	accountId: number
	roomInstance: TRoomInstance | null
	statusVisibility: number
	deviceClass: number
	vrMovementMode: number
	platform: number
	appVersion: string
	/**
	 * The session's `LoginLock` GUID, bound from the form body at matchmake time. The
	 * heartbeat posts it back purely to verify it still owns the session — a heartbeat
	 * carrying a different lock is a superseded session and is rejected. Absent until a
	 * matchmake supplies one.
	 */
	loginLock?: string
	/**
	 * Roughly where the player is, from the IP the write arrived on (see
	 * {@link PresenceGeo}). Absent when the request carried no geolocation, and only ever
	 * read in aggregate — the website's globe counts players per grid cell.
	 */
	geo?: PresenceGeo
}

/** A stored presence row — the input plus its absolute expiry (epoch seconds). */
export interface StoredPresence<TRoomInstance = unknown> extends PresenceInput<TRoomInstance> {
	expiresAt: number
}

const nowSeconds = () => Math.floor(Date.now() / 1000)

/**
 * Upsert a player's presence, stamping a fresh absolute expiry (now +
 * PRESENCE_TTL_SECONDS). One row per account: `INSERT OR REPLACE` resolves on the
 * unique `account_id` index. Returns the stored row (with its new expiry).
 */
export async function setPresence<TRoomInstance>(
	db: D1Database,
	input: PresenceInput<TRoomInstance>
): Promise<StoredPresence<TRoomInstance>> {
	const stored: StoredPresence<TRoomInstance> = {
		...input,
		expiresAt: nowSeconds() + PRESENCE_TTL_SECONDS,
	}
	await db
		.prepare('INSERT OR REPLACE INTO presence (data) VALUES (?1)')
		.bind(JSON.stringify(stored))
		.run()
	return stored
}

/** Read a player's live presence, or null when they're absent or expired. */
export async function getPresence<TRoomInstance>(
	db: D1Database,
	accountId: number,
	now = nowSeconds()
): Promise<StoredPresence<TRoomInstance> | null> {
	const row = await db
		.prepare('SELECT data FROM presence WHERE account_id = ?1 AND expires_at > ?2')
		.bind(accountId, now)
		.first<{ data: string }>()
	return row ? (JSON.parse(row.data) as StoredPresence<TRoomInstance>) : null
}

/**
 * Read many players' live presence in one query, keyed by account id (absent or
 * expired players are simply missing from the map). Replaces the N point reads the
 * batch `/player?id=…` lookup did against KV.
 */
export async function getPresences<TRoomInstance>(
	db: D1Database,
	accountIds: number[],
	now = nowSeconds()
): Promise<Map<number, StoredPresence<TRoomInstance>>> {
	const out = new Map<number, StoredPresence<TRoomInstance>>()
	if (accountIds.length === 0) return out
	const placeholders = accountIds.map((_, i) => `?${i + 1}`).join(', ')
	const { results } = await db
		.prepare(
			`SELECT data FROM presence
			 WHERE account_id IN (${placeholders}) AND expires_at > ?${accountIds.length + 1}`
		)
		.bind(...accountIds, now)
		.all<{ data: string }>()
	for (const r of results) {
		const p = JSON.parse(r.data) as StoredPresence<TRoomInstance>
		out.set(p.accountId, p)
	}
	return out
}

/**
 * How many players are currently in a room instance — the live head-count
 * matchmaking can use to spread players and avoid full instances (something KV
 * couldn't answer without scanning every key). Counts only unexpired presence.
 */
export async function countPlayersInInstance(
	db: D1Database,
	roomInstanceId: number,
	now = nowSeconds()
): Promise<number> {
	const row = await db
		.prepare('SELECT COUNT(*) AS n FROM presence WHERE room_instance_id = ?1 AND expires_at > ?2')
		.bind(roomInstanceId, now)
		.first<{ n: number }>()
	return row?.n ?? 0
}

/**
 * How many players are online right now, anywhere — one row per account, so this is
 * the player count a status page means. Counts unexpired presence only: rows outlive
 * the player by up to the TTL until the sweep purges them, and reads elsewhere ignore
 * them the same way. Lobby (null-instance) presence IS counted — those players are
 * signed in and playing, they're just not in a room.
 */
export async function countOnlinePlayers(db: D1Database, now = nowSeconds()): Promise<number> {
	const row = await db
		.prepare('SELECT COUNT(*) AS n FROM presence WHERE expires_at > ?1')
		.bind(now)
		.first<{ n: number }>()
	return row?.n ?? 0
}

/**
 * Where the players who are online right now are, one entry per populated
 * GEO_GRID_DEGREES cell — the pins behind the website's globe.
 *
 * Aggregated in SQL rather than by reading the rows out, so what leaves the database is
 * already a count per cell: no caller ever holds a list of individual players and their
 * locations, which is the point (see {@link PresenceGeo}). Rows written before geo
 * existed, and players the edge couldn't place, have no `$.geo` and are simply left out —
 * so the totals here can be lower than {@link countOnlinePlayers}, and callers should
 * report both rather than passing this sum off as the player count.
 *
 * Grouped on the JSON path rather than a generated column: `presence` is bounded by
 * account count and this is a once-per-poll read, so the scan is cheaper than a schema
 * change on a table another worker owns.
 */
export async function countOnlinePlayersByLocation(
	db: D1Database,
	now = nowSeconds()
): Promise<PresenceLocation[]> {
	const { results } = await db
		.prepare(
			`SELECT json_extract(data, '$.geo.lat') AS lat,
			        json_extract(data, '$.geo.lon') AS lon,
			        json_extract(data, '$.geo.country') AS country,
			        COUNT(*) AS players
			 FROM presence
			 WHERE expires_at > ?1 AND json_extract(data, '$.geo.lat') IS NOT NULL
			 GROUP BY lat, lon, country
			 ORDER BY players DESC, country, lat, lon`
		)
		.bind(now)
		.all<PresenceLocation>()
	return results
}

/** One populated grid cell — a pin on the globe, and how many players are in it. */
export interface PresenceLocation extends PresenceGeo {
	players: number
}

/**
 * Live head-count per ROOM, keyed by room id — the players standing in any of a
 * room's instances right now. One grouped query rather than a count per room, so
 * feeds that rank by "who's playing" (the hot feed) stay a single read. Counts
 * only unexpired presence; rooms nobody is in are simply absent from the map, and
 * lobby (null-instance) presence is excluded.
 */
export async function countPlayersByRoom(
	db: D1Database,
	now = nowSeconds()
): Promise<Map<number, number>> {
	const { results } = await db
		.prepare(
			`SELECT room_id AS roomId, COUNT(*) AS n FROM presence
			 WHERE expires_at > ?1 AND room_instance_id IS NOT NULL AND room_id IS NOT NULL
			 GROUP BY room_id`
		)
		.bind(now)
		.all<{ roomId: number; n: number }>()
	return new Map(results.map((r) => [r.roomId, r.n]))
}

/**
 * Who is standing in each of a room's instances right now, keyed by instance id —
 * one grouped query rather than a lookup per instance, so the owner's instance list
 * stays a single read. Reads only unexpired presence; instances nobody is in are
 * simply absent from the map (callers default to an empty list), and lobby
 * (null-instance) presence is excluded.
 */
export async function getPlayerIdsByRoomInstance(
	db: D1Database,
	roomId: number,
	now = nowSeconds()
): Promise<Map<number, number[]>> {
	const { results } = await db
		.prepare(
			`SELECT room_instance_id AS instanceId, account_id AS accountId FROM presence
			 WHERE room_id = ?1 AND expires_at > ?2 AND room_instance_id IS NOT NULL
			 ORDER BY account_id`
		)
		.bind(roomId, now)
		.all<{ instanceId: number; accountId: number }>()
	const out = new Map<number, number[]>()
	for (const r of results) {
		const players = out.get(r.instanceId)
		if (players) players.push(r.accountId)
		else out.set(r.instanceId, [r.accountId])
	}
	return out
}

/**
 * The room instances that expired presence rows still point at — the instances a
 * player was in when they stopped heartbeating (a crash or a hard quit, where no
 * matchmake ever moved them out). Their head-count has really dropped, so callers
 * purging presence use this to recompute those instances' fullness. Distinct ids,
 * lobby (null-instance) presence excluded.
 */
export async function getExpiredPresenceInstanceIds(
	db: D1Database,
	now = nowSeconds()
): Promise<number[]> {
	const { results } = await db
		.prepare(
			`SELECT DISTINCT room_instance_id AS id FROM presence
			 WHERE expires_at <= ?1 AND room_instance_id IS NOT NULL`
		)
		.bind(now)
		.all<{ id: number }>()
	return results.map((r) => r.id)
}

/**
 * Purge expired presence rows — housekeeping only, since reads already ignore them
 * (and `INSERT OR REPLACE` keeps a single row per account, so the table is bounded
 * by account count). Returns the number of rows removed.
 */
export async function deleteExpiredPresence(db: D1Database, now = nowSeconds()): Promise<number> {
	const res = await db.prepare('DELETE FROM presence WHERE expires_at <= ?1').bind(now).run()
	return res.meta.changes ?? 0
}

/**
 * Delete a single player's presence row — the player goes offline immediately
 * (rather than waiting out the TTL). Used on logout. Returns rows removed (0 when
 * they had no live presence). The caller is responsible for recomputing the
 * fullness of the instance they were in.
 */
export async function deletePresence(db: D1Database, accountId: number): Promise<number> {
	const res = await db.prepare('DELETE FROM presence WHERE account_id = ?1').bind(accountId).run()
	return res.meta.changes ?? 0
}
