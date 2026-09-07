import { DurableObject } from 'cloudflare:workers'

import { NotificationType } from './notification-types'

import type { Env } from './context'

/**
 * Durable Object hosting the SignalR notifications hub. A single global instance
 * holds the shared hub state (one process, shared across connections).
 *
 * It speaks the SignalR JSON Hub Protocol over a hibernatable WebSocket:
 *   1. negotiate happens in the worker; the client then opens a WS to `/hub/v1`.
 *   2. handshake: client sends `{"protocol":"json","version":1}␞`, we reply `{}␞`.
 *   3. framed messages are `␞` (0x1e) delimited JSON; type 1 = invocation,
 *      3 = completion, 6 = ping, 7 = close.
 *
 * Connection/subscription state lives in SQLite so it survives hibernation:
 *   - `connection_owner(connectionId, playerId)` — who each socket belongs to,
 *     from the token the worker validated at connect. This is how a player's own
 *     notifications reach them; the client never subscribes to itself.
 *   - `subscriptions(connectionId, playerId)` — *other* players a connection asked
 *     for updates about, both the connection→players and (queried the other way)
 *     the player→connections maps.
 *   - `pending(id, playerId, payload)` — the per-player queue delivered once a
 *     player is reachable again.
 */

/** SignalR record separator (0x1e) that terminates every protocol message. */
const RS = '\u001e'

interface SocketState {
	connectionId: string
	handshakeDone: boolean
	/** The player this socket belongs to, from the token validated at connect. */
	playerId?: number
}

interface HubMessage {
	type: number
	target?: string
	invocationId?: string
	arguments?: unknown[]
}

/**
 * How the worker tells the DO which player a connecting socket belongs to, having
 * validated the connect request's token. The worker sets it on every connect it lets
 * through and refuses the rest, so a client can't present its own and be believed.
 */
export const OWNER_HEADER = 'x-recflare-connection-owner'

/**
 * Read the player ids off a `SubscribeToPlayers` invocation. SignalR gives no schema, so
 * all three plausible spellings are accepted — an options object
 * (`[{playerIds:[1,2]}]`), a single array argument (`[[1,2]]`), and varargs
 * (`[1,2]`) — rather than guessing which one the client uses.
 *
 * `null` means the argument didn't resolve to a list of ids at all, which the caller
 * must not treat as an empty subscription; `[]` is a real "subscribe to nobody".
 */
function parsePlayerIds(args: unknown[] | undefined): number[] | null {
	if (args === undefined || args.length === 0) return []

	const first = args[0]
	const candidate =
		typeof first === 'object' && first !== null && !Array.isArray(first)
			? (first as { playerIds?: unknown }).playerIds
			: Array.isArray(first)
				? first
				: args

	if (!Array.isArray(candidate)) return null
	// Ids arriving as strings ("153") still count — the wire format is the client's
	// choice, and the subscriptions table is what has to be numeric.
	const ids = candidate
		.map((value) =>
			typeof value === 'number' ? value : typeof value === 'string' ? Number(value) : Number.NaN
		)
		.filter((value) => Number.isInteger(value))
	return ids.length === 0 && candidate.length > 0 ? null : ids
}

/** What {@link NotificationsHub.inspect} reports — see it for what each field is for. */
export interface HubState {
	connections: Array<{
		connectionId: string
		/** Whether a socket for this connectionId is still held by the DO. */
		live: boolean
		handshakeDone: boolean
		/**
		 * The player this connection belongs to. Null only for a connection that predates
		 * authenticated connects and hasn't closed yet — a new one always has an owner.
		 */
		playerId: number | null
		/** Other players this connection subscribed to updates for. */
		playerIds: number[]
	}>
	/** Queued-while-offline notifications, newest payload per player for identification. */
	pending: Array<{ playerId: number; count: number; latest: string }>
}

/** The Coach system account — the `FromPlayerId` on a coach message (see coachMessageAll). */
const COACH_PLAYER_ID = 1

/** The Message `Type` a coach/system message carries (a Message-model enum, not a NotificationType). */
const COACH_MESSAGE_TYPE = 100

export class NotificationsHub extends DurableObject<Env> {
	constructor(ctx: DurableObjectState, env: Env) {
		super(ctx, env)
		void ctx.blockConcurrencyWhile(async () => {
			this.ctx.storage.sql.exec(`
				CREATE TABLE IF NOT EXISTS subscriptions (
					connectionId TEXT NOT NULL,
					playerId INTEGER NOT NULL
				);
				CREATE INDEX IF NOT EXISTS idx_sub_conn ON subscriptions(connectionId);
				CREATE INDEX IF NOT EXISTS idx_sub_player ON subscriptions(playerId);
				CREATE TABLE IF NOT EXISTS pending (
					id INTEGER PRIMARY KEY AUTOINCREMENT,
					playerId INTEGER NOT NULL,
					payload TEXT NOT NULL
				);
				CREATE INDEX IF NOT EXISTS idx_pending_player ON pending(playerId);
				CREATE TABLE IF NOT EXISTS connection_owner (
					connectionId TEXT PRIMARY KEY,
					playerId INTEGER NOT NULL
				);
				CREATE INDEX IF NOT EXISTS idx_owner_player ON connection_owner(playerId);
			`)
		})
	}

	/** WebSocket upgrade entrypoint — the worker forwards `/hub/v1` here. */
	override async fetch(request: Request): Promise<Response> {
		if ((request.headers.get('Upgrade') ?? '').toLowerCase() !== 'websocket') {
			return new Response('Expected a WebSocket upgrade request', { status: 426 })
		}

		const url = new URL(request.url)
		// negotiate handed the client this id as `connectionToken`/`connectionId`.
		const connectionId = url.searchParams.get('id') || crypto.randomUUID()

		// Who this socket belongs to, established by the worker from the connect
		// request's token (see OWNER_HEADER). The worker rejects a connect it can't
		// identify and always sets the header itself, so an absent one means the DO was
		// reached by some other path — not something to serve a socket to.
		const playerId = Number.parseInt(request.headers.get(OWNER_HEADER) ?? '', 10)
		if (!Number.isInteger(playerId)) {
			return new Response('Unidentified connection', { status: 401 })
		}

		const pair = new WebSocketPair()
		const server = pair[1]
		// Tag by connectionId so we can find this socket via getWebSockets(id).
		this.ctx.acceptWebSocket(server, [connectionId])
		server.serializeAttachment({
			connectionId,
			handshakeDone: false,
			playerId,
		} satisfies SocketState)

		this.ctx.storage.sql.exec(
			'INSERT OR REPLACE INTO connection_owner (connectionId, playerId) VALUES (?, ?)',
			connectionId,
			playerId
		)

		return new Response(null, { status: 101, webSocket: pair[0] })
	}

	override async webSocketMessage(ws: WebSocket, message: string | ArrayBuffer): Promise<void> {
		const text = typeof message === 'string' ? message : new TextDecoder().decode(message)
		const state = ws.deserializeAttachment() as SocketState | null
		if (!state) return

		for (const record of text.split(RS)) {
			if (record.length === 0) continue

			if (!state.handshakeDone) {
				// First frame is the SignalR handshake request.
				this.completeHandshake(ws, record, state)
				continue
			}

			let msg: HubMessage
			try {
				msg = JSON.parse(record) as HubMessage
			} catch {
				continue
			}
			this.handleMessage(ws, state.connectionId, msg)
		}
	}

	override async webSocketClose(ws: WebSocket): Promise<void> {
		const state = ws.deserializeAttachment() as SocketState | null
		if (state) {
			// Mirrors OnDisconnected: drop this connection's subscriptions, which
			// also removes it from every player's connection set.
			this.ctx.storage.sql.exec(
				'DELETE FROM subscriptions WHERE connectionId = ?',
				state.connectionId
			)
			this.ctx.storage.sql.exec(
				'DELETE FROM connection_owner WHERE connectionId = ?',
				state.connectionId
			)
		}
		try {
			ws.close()
		} catch {
			// already closed
		}
	}

	// ---- SignalR protocol ----------------------------------------------------

	private completeHandshake(ws: WebSocket, record: string, state: SocketState): void {
		let protocol = 'json'
		try {
			protocol = (JSON.parse(record) as { protocol?: string }).protocol ?? 'json'
		} catch {
			// fall through to the json default
		}
		if (protocol !== 'json') {
			ws.send(JSON.stringify({ error: `Unsupported protocol '${protocol}'` }) + RS)
			ws.close(1002, 'unsupported protocol')
			return
		}

		// Empty object = handshake success.
		ws.send('{}' + RS)
		state.handshakeDone = true
		ws.serializeAttachment(state)

		// Send "OnConnect" to the caller after connecting.
		ws.send(this.invocation('OnConnect', []))

		// Deliver whatever piled up while this player was away. Done here rather than at
		// accept because SignalR won't read invocation frames sent before the handshake
		// reply, and only here because the client never calls SubscribeToPlayers — with
		// the flush living solely in there, a queued notification was stranded forever.
		if (state.playerId !== undefined) this.flushPending(ws, state.playerId)
	}

	/** Send and clear a player's queued notifications on `ws`. */
	private flushPending(ws: WebSocket, playerId: number): void {
		const pending = this.ctx.storage.sql
			.exec<{
				payload: string
			}>('SELECT payload FROM pending WHERE playerId = ? ORDER BY id', playerId)
			.toArray()
		if (pending.length === 0) return

		for (const row of pending) ws.send(this.invocation('Notification', [row.payload]))
		this.ctx.storage.sql.exec('DELETE FROM pending WHERE playerId = ?', playerId)
	}

	private handleMessage(ws: WebSocket, connectionId: string, msg: HubMessage): void {
		switch (msg.type) {
			case 1: // Invocation
				this.handleInvocation(ws, connectionId, msg)
				break
			case 6: // Ping — echo to keep the connection alive.
				ws.send(JSON.stringify({ type: 6 }) + RS)
				break
			case 7: // Close
				ws.close()
				break
			default:
				break
		}
	}

	private handleInvocation(ws: WebSocket, connectionId: string, msg: HubMessage): void {
		switch (msg.target) {
			case 'SubscribeToPlayers': {
				const playerIds = parsePlayerIds(msg.arguments)
				// An argument we can't read is not "subscribe to nobody": subscribing
				// replaces the connection's whole set, so acting on a misread would wipe
				// a working connection to zero and silently strand every push.
				if (playerIds === null) {
					console.warn('hub: unreadable SubscribeToPlayers argument', {
						connectionId,
						arguments: JSON.stringify(msg.arguments),
					})
				} else {
					this.subscribeToPlayers(ws, connectionId, playerIds)
				}
				if (msg.invocationId) ws.send(this.completion(msg.invocationId, null))
				break
			}
			case 'GetSubscriptions': {
				const players = this.getSubscribedPlayers(connectionId)
				if (msg.invocationId) ws.send(this.completion(msg.invocationId, players))
				break
			}
			default:
				// Logged, not just answered with an error completion: a hub method we
				// don't implement is a client expectation we've missed, and the client
				// gives no sign of it.
				console.warn('hub: unknown invocation target', {
					connectionId,
					target: msg.target,
					arguments: JSON.stringify(msg.arguments),
				})
				if (msg.invocationId) {
					ws.send(this.completionError(msg.invocationId, `Unknown method '${msg.target}'`))
				}
				break
		}
	}

	private subscribeToPlayers(ws: WebSocket, connectionId: string, playerIds: number[]): void {
		const unique = [...new Set(playerIds)]

		// Replace this connection's subscription set.
		this.ctx.storage.sql.exec('DELETE FROM subscriptions WHERE connectionId = ?', connectionId)
		for (const playerId of unique) {
			this.ctx.storage.sql.exec(
				'INSERT INTO subscriptions (connectionId, playerId) VALUES (?, ?)',
				connectionId,
				playerId
			)
		}

		// Flush any notifications queued while these players were offline.
		for (const playerId of unique) this.flushPending(ws, playerId)
	}

	/**
	 * Every connection that receives notifications for a player. Two ways to qualify: the
	 * connection *is* that player (established from the token at connect), or it
	 * subscribed to them. The client only ever uses the first — it never calls
	 * SubscribeToPlayers — so a player's own notifications reach them through
	 * connection_owner, and subscriptions carry other players' updates.
	 */
	private connectionIdsFor(playerId: number): string[] {
		return this.ctx.storage.sql
			.exec<{ connectionId: string }>(
				`SELECT connectionId FROM connection_owner WHERE playerId = ?1
				UNION
				SELECT connectionId FROM subscriptions WHERE playerId = ?1`,
				playerId
			)
			.toArray()
			.map((r) => r.connectionId)
	}

	private getSubscribedPlayers(connectionId: string): number[] {
		return this.ctx.storage.sql
			.exec<{ playerId: number }>(
				'SELECT DISTINCT playerId FROM subscriptions WHERE connectionId = ?',
				connectionId
			)
			.toArray()
			.map((r) => r.playerId)
	}

	// ---- Server → client RPC (callable from other workers) -------------------

	/**
	 * Send a notification to a player's connections, queueing it if the player
	 * isn't currently connected (mirrors `SendNotificationToPlayer`).
	 */
	async notifyPlayer(
		playerId: number,
		notificationType: string | number,
		data?: Record<string, unknown>
	): Promise<{ delivered: number; queued: boolean }> {
		const payload = this.buildNotificationPayload(notificationType, data)
		const delivered = this.deliverToPlayer(playerId, payload)

		if (delivered === 0) {
			// Distinguishes the two ways this fails: no connection is registered for the
			// player at all, versus one is registered but has no live socket behind it.
			console.warn('hub: notification queued, nobody to deliver to', {
				playerId,
				notificationType,
				connectionIds: this.connectionIdsFor(playerId),
				liveSockets: this.ctx.getWebSockets().length,
			})
		}

		if (delivered === 0) {
			this.ctx.storage.sql.exec(
				'INSERT INTO pending (playerId, payload) VALUES (?, ?)',
				playerId,
				payload
			)
			return { delivered: 0, queued: true }
		}
		return { delivered, queued: false }
	}

	/**
	 * Send a notification to a player's live sockets and, unlike {@link notifyPlayer},
	 * NEVER queue it when they're offline — the ephemeral "SendWebsocket" send. For
	 * high-frequency, transient frames whose value is gone by the next reconnect (the
	 * presence heartbeat response, sent on every beat): queueing those would pile up
	 * unbounded in `pending` and then deliver a burst of stale frames when the player
	 * next connects. Returns how many live sockets received it (0 = nobody was
	 * connected, and it was dropped rather than stored).
	 */
	async notifyPlayerEphemeral(
		playerId: number,
		notificationType: string | number,
		data?: Record<string, unknown>
	): Promise<{ delivered: number }> {
		const payload = this.buildNotificationPayload(notificationType, data)
		return { delivered: this.deliverToPlayer(playerId, payload) }
	}

	/**
	 * Ephemeral send (see {@link notifyPlayerEphemeral}) to many players at once — the
	 * batch the presence fan-out needs. When a player changes rooms, every online friend
	 * gets one SubscriptionUpdatePresence and an offline friend gets nothing (a SignalR
	 * group send reaches only connected clients), so the same identical payload is built
	 * once and delivered to each in a single RPC round-trip rather than one call per
	 * friend. Returns the total live sockets reached across all of them.
	 */
	async notifyPlayersEphemeral(
		playerIds: number[],
		notificationType: string | number,
		data?: Record<string, unknown>
	): Promise<{ delivered: number }> {
		const payload = this.buildNotificationPayload(notificationType, data)
		let delivered = 0
		for (const playerId of playerIds) delivered += this.deliverToPlayer(playerId, payload)
		return { delivered }
	}

	/**
	 * Send a "coach" message to every connected client (mirrors the reference
	 * `SendCoachMessageAll`, using the hub's live connections as the online set): each
	 * handshaken socket gets a `MessageReceived` notification carrying a Message from
	 * the Coach account (player 1). Online-only — nothing is queued or persisted, and
	 * it's a broadcast, so the Message has no per-recipient `ToPlayerId`. Returns how
	 * many connected clients were messaged.
	 */
	async coachMessageAll(content: string): Promise<{ sent: number }> {
		const payload = this.buildNotificationPayload(NotificationType.MessageReceived, {
			FromPlayerId: COACH_PLAYER_ID,
			Type: COACH_MESSAGE_TYPE,
			Data: content,
		})
		return { sent: this.broadcastToConnected(payload) }
	}

	/**
	 * The targeted form of {@link coachMessageAll}: the same `MessageReceived` frame from
	 * the Coach account (player 1), addressed to one player with a `ToPlayerId` — the shape
	 * `api`'s player-to-player send uses.
	 *
	 * Unlike the broadcast this one QUEUES when the recipient is offline (see
	 * {@link notifyPlayer}). The broadcast is online-only because it has no recipient to
	 * hold anything for; a message written to a named player is worth keeping until they
	 * next connect.
	 */
	async coachMessage(
		playerId: number,
		content: string
	): Promise<{ delivered: number; queued: boolean }> {
		return this.notifyPlayer(playerId, NotificationType.MessageReceived, {
			FromPlayerId: COACH_PLAYER_ID,
			ToPlayerId: playerId,
			Type: COACH_MESSAGE_TYPE,
			Data: content,
		})
	}

	/** Broadcast a notification to every connected (handshaken) client. */
	async broadcast(
		notificationType: string | number,
		data?: Record<string, unknown>
	): Promise<{ delivered: number }> {
		return {
			delivered: this.broadcastToConnected(this.buildNotificationPayload(notificationType, data)),
		}
	}

	/**
	 * Dump the hub's routing state for debugging delivery. A notification only reaches a
	 * player through a `subscriptions` row (see {@link deliverToPlayer}), so when a push
	 * doesn't arrive this answers the two questions that matter: is the player subscribed
	 * on a live connection, and is the frame sitting in `pending` instead?
	 *
	 * Connections are listed even when one side is missing — a socket that has yet to
	 * subscribe (`playerIds: []`) and a subscription set whose socket is gone
	 * (`live: false`, a close we never saw) are both delivery failures worth seeing.
	 */
	async inspect(): Promise<HubState> {
		const live = new Map<string, boolean>()
		for (const ws of this.ctx.getWebSockets()) {
			const state = ws.deserializeAttachment() as SocketState | null
			if (state) live.set(state.connectionId, state.handshakeDone)
		}

		const subscribed = new Map<string, number[]>()
		const rows = this.ctx.storage.sql
			.exec<{
				connectionId: string
				playerId: number
			}>('SELECT connectionId, playerId FROM subscriptions ORDER BY connectionId, playerId')
			.toArray()
		for (const row of rows) {
			const players = subscribed.get(row.connectionId) ?? []
			players.push(row.playerId)
			subscribed.set(row.connectionId, players)
		}

		const owners = new Map(
			this.ctx.storage.sql
				.exec<{
					connectionId: string
					playerId: number
				}>('SELECT connectionId, playerId FROM connection_owner')
				.toArray()
				.map((row) => [row.connectionId, row.playerId] as const)
		)

		const connections = [...new Set([...live.keys(), ...subscribed.keys(), ...owners.keys()])].map(
			(connectionId) => ({
				connectionId,
				live: live.has(connectionId),
				handshakeDone: live.get(connectionId) ?? false,
				playerId: owners.get(connectionId) ?? null,
				playerIds: subscribed.get(connectionId) ?? [],
			})
		)

		const pending = this.ctx.storage.sql
			.exec<{ playerId: number; count: number; latest: string }>(
				`SELECT playerId, COUNT(*) AS count,
					(SELECT payload FROM pending AS newest WHERE newest.playerId = pending.playerId
						ORDER BY id DESC LIMIT 1) AS latest
				FROM pending GROUP BY playerId ORDER BY playerId`
			)
			.toArray()

		return { connections, pending }
	}

	/**
	 * Drop queued notifications — for one player, or (`playerId` omitted) the whole
	 * queue. Anything pending is delivered the moment that player next subscribes, so a
	 * frame queued by a bug that has since been fixed would otherwise arrive, out of
	 * context, at the next reconnect. Returns how many were discarded.
	 */
	async clearPending(playerId?: number): Promise<{ cleared: number }> {
		// Counted first rather than read off the cursor: the delete's own row count isn't
		// reported, and this is an admin-facing number we want to be exact.
		const [counted] =
			playerId === undefined
				? this.ctx.storage.sql
						.exec<{ count: number }>('SELECT COUNT(*) AS count FROM pending')
						.toArray()
				: this.ctx.storage.sql
						.exec<{
							count: number
						}>('SELECT COUNT(*) AS count FROM pending WHERE playerId = ?', playerId)
						.toArray()

		if (playerId === undefined) this.ctx.storage.sql.exec('DELETE FROM pending')
		else this.ctx.storage.sql.exec('DELETE FROM pending WHERE playerId = ?', playerId)

		return { cleared: counted?.count ?? 0 }
	}

	// ---- Helpers -------------------------------------------------------------

	/**
	 * Send an already-built `Notification` payload to every live socket of a player's
	 * subscribed connections; returns how many sockets received it (0 = offline). The
	 * shared send path for {@link notifyPlayer} and {@link coachMessageAll}.
	 */
	private deliverToPlayer(playerId: number, payload: string): number {
		const connectionIds = this.connectionIdsFor(playerId)

		let delivered = 0
		for (const connectionId of connectionIds) {
			for (const ws of this.ctx.getWebSockets(connectionId)) {
				ws.send(this.invocation('Notification', [payload]))
				delivered++
			}
		}
		return delivered
	}

	/**
	 * Send an already-built `Notification` payload to every connected (handshaken)
	 * socket; returns how many received it. Shared by {@link broadcast} and
	 * {@link coachMessageAll}.
	 */
	private broadcastToConnected(payload: string): number {
		let delivered = 0
		for (const ws of this.ctx.getWebSockets()) {
			const state = ws.deserializeAttachment() as SocketState | null
			if (!state?.handshakeDone) continue
			ws.send(this.invocation('Notification', [payload]))
			delivered++
		}
		return delivered
	}

	/**
	 * Build the `Notification` argument: a JSON string `{ Id, Msg }`
	 * (null values are dropped from `Msg`). `Id` is a client-defined tag — a
	 * string name (e.g. "AccountUpdate") or a numeric code. It is always emitted
	 * as a string: the client dispatches on a string `Id`, so a numeric frame
	 * (e.g. the `NotificationType` enum values sent by `econ`) would otherwise be
	 * silently dropped.
	 */
	private buildNotificationPayload(
		notificationType: string | number,
		data?: Record<string, unknown>
	): string {
		const msg: Record<string, unknown> = {}
		if (data) {
			for (const [key, value] of Object.entries(data)) {
				if (value === null || value === undefined) continue
				msg[key] = value
			}
		}
		return JSON.stringify({ Id: String(notificationType), Msg: msg })
	}

	private invocation(target: string, args: unknown[]): string {
		return JSON.stringify({ type: 1, target, arguments: args }) + RS
	}

	private completion(invocationId: string, result: unknown): string {
		return JSON.stringify({ type: 3, invocationId, result }) + RS
	}

	private completionError(invocationId: string, error: string): string {
		return JSON.stringify({ type: 3, invocationId, error }) + RS
	}
}
