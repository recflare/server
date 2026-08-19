import type { HonoApp } from '@repo/hono-helpers'
import type { SharedHonoEnv, SharedHonoVariables } from '@repo/hono-helpers/src/types'
// Type-only import (erased at build) of the DO class owned by the `notify` worker,
// so this worker can push websocket notifications through its RPC surface.
import type { NotificationsHub } from '../../notify/src/notifications-hub'

export type Env = SharedHonoEnv & {
	// Shared Secrets Store binding for the HS256 JWT signing key. Resolve the value
	// with `await env.JWT_SECRET.get()`; all workers bind the same store so tokens
	// signed by `auth` verify here.
	JWT_SECRET: SecretsStoreSecret
	// Shared `recflare` DB. Resolves room scenes for matchmaking (read), writes a
	// player's personal dorm room on first entry, and holds player presence — the
	// room instance each player is currently in (written by matchmake/heartbeat,
	// read by the heartbeat and the batch `/player` lookup). See @repo/domain's
	// presence-db (table owned/migrated by the `rooms` worker).
	DB: D1Database
	/**
	 * The `notify` worker's NotificationsHub DO — pushes websocket notifications to a
	 * player. Used by `POST /invite` to deliver the game-invite message to the invitee.
	 */
	RECFLARE_NOTIFICATIONS_HUB: DurableObjectNamespace<NotificationsHub>
	/**
	 * The per-player settings map the `playersettings` worker owns (`player:<id>` → JSON
	 * `{ key: value }`). Read-only here, and only by `GET /player/avoidjuniors`: the
	 * "avoid juniors" preference is a matchmaking question the client asks this worker,
	 * but it is stored with the rest of the player's settings, not in presence.
	 */
	RECFLARE_PLAYER_SETTINGS: KVNamespace
	/**
	 * Room substitutions applied at matchmake time, as comma-separated `<fromRoomId>=<to>`
	 * pairs — e.g. `2=100` or `2=MyHub,3=100` — where `from` is the room id the client
	 * asks for and `to` is the room it actually enters (id or room name). Optional; unset
	 * means every matchmake enters the room it asked for.
	 *
	 * The point of it is swapping out a stock RRO room for a custom one: `2=MyHub` sends
	 * everyone who matchmakes into the Rec Center (room 2) to `MyHub` instead, without
	 * touching the client. See `roomRedirects` in match.app.ts.
	 */
	ROOM_REDIRECTS?: string
	/**
	 * Which linked arms a ban is enforced through, as a comma-separated list out of `ip`
	 * and `platform` — or `off` for neither. Unset means BOTH: a ban reaches the accounts
	 * that share a proven platform identity or an IP with the banned one, which is what
	 * stops an evader simply making a new account.
	 *
	 * The `ip` arm is coarse (households, NAT, campus and carrier networks share one
	 * address), so `platform` alone is the setting for a server whose players share
	 * networks. Whatever this says, a ban always applies to the account it was handed to.
	 * Read through `banEvasionMatch`; the `auth` worker reads the same knob.
	 */
	BAN_EVASION_MATCH?: string
}

/** Variables can be extended */
export type Variables = SharedHonoVariables

export interface App extends HonoApp {
	Bindings: Env
	Variables: Variables
}
