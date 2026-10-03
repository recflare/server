/**
 * Combined ("facade") worker.
 *
 * Mounts each RecFlare worker inside a single deployable Worker WITHOUT modifying the
 * originals: every app is imported by relative path and bundled by esbuild at build
 * time. Production routing mirrors the split deployment — requests are dispatched on
 * the request's subdomain (`accounts.<domain>` -> the `accounts` app), so the sub-app
 * paths (and therefore the client contract) are untouched.
 *
 * Local dev has no subdomain, so the first path segment selects the service and is
 * stripped before the request is forwarded, e.g.
 *   http://localhost:8787/accounts/           -> accounts app sees /
 *   http://localhost:8787/match/player/login  -> match app sees /player/login
 *   http://localhost:8787/api/api/config/v2   -> api app sees /api/config/v2
 *
 * A request with no path (just `/`) that selects no service serves the `ns` discovery
 * document, so a bare hit to the facade root returns the service map to bootstrap from.
 *
 * NOT mounted here: `www`, `img`, `econ`. Each binds a static `assets` directory and
 * Cloudflare allows only one static-assets binding per Worker. Resolve that (serve
 * their static trees from R2, or keep those three as their own Workers) before adding.
 */
import accounts from '../../accounts/src/accounts.app'
import api from '../../api/src/api.app'
import auth from '../../auth/src/auth.app'
import cdn from '../../cdn/src/cdn.app'
import chat from '../../chat/src/chat.app'
import clubs from '../../clubs/src/clubs.app'
import commerce from '../../commerce/src/commerce.app'
import { app as match, scheduled as matchScheduled } from '../../match/src/match.app'
import notify from '../../notify/src/notify.app'
import ns from '../../ns/src/ns.app'
import playersettings from '../../playersettings/src/playersettings.app'
import { app as rooms, scheduled as roomsScheduled } from '../../rooms/src/rooms.app'
import storage from '../../storage/src/storage.app'

import type { Env } from './context'

// The Notifications Durable Object is defined in `notify`; re-export it so this worker
// owns the class its wrangler.jsonc binds and migrates (bound in-process, no script_name).
export { NotificationsHub } from '../../notify/src/notifications-hub'

/** Anything that can handle a fetch with this worker's (superset) Env. */
type Mounted = {
	fetch(request: Request, env: Env, ctx: ExecutionContext): Response | Promise<Response>
}

/**
 * Subdomain -> mounted app. Keys must match the `<sub>` in `<sub>.<domain>` from the
 * `ns` service-discovery document so production host-based routing lines up.
 */
const services = {
	accounts,
	api,
	auth,
	cdn,
	// The Studio editor downloads bundle bytes from a hardcoded studiocdn host.
	// Those bytes are this CDN app; the game reaches the same routes on `cdn`.
	studiocdn: cdn,
	chat,
	clubs,
	commerce,
	match,
	notify,
	ns,
	playersettings,
	rooms,
	storage,
} satisfies Record<string, Mounted>

type ServiceName = keyof typeof services

function resolve(request: Request): { name: ServiceName; request: Request } | undefined {
	const url = new URL(request.url)

	// Production: dispatch on the leftmost DNS label — accounts.<domain> -> accounts.
	// The path is forwarded unchanged so the client contract is identical.
	const sub = url.hostname.split('.')[0]
	if (sub in services) return { name: sub as ServiceName, request }

	// Local dev (no service subdomain): the first path segment selects the service and
	// is stripped before forwarding — /match/player/login -> match app sees /player/login.
	const [, first, ...rest] = url.pathname.split('/')
	if (first !== undefined && first in services) {
		url.pathname = `/${rest.join('/')}`
		return { name: first as ServiceName, request: new Request(url, request) }
	}

	// No service selected and no path (just `/`): serve the `ns` discovery document so a
	// bare hit to the facade returns the service map, like the apex/ns host.
	if (url.pathname === '/') return { name: 'ns', request }

	return undefined
}

export default {
	fetch(request: Request, env: Env, ctx: ExecutionContext): Response | Promise<Response> {
		const resolved = resolve(request)
		if (resolved === undefined) {
			return Response.json(
				{
					error: 'unknown_service',
					hint: 'Route by subdomain (<service>.<domain>), or in local dev prefix the path with the service name (/<service>/...).',
					services: Object.keys(services),
				},
				{ status: 404 }
			)
		}
		return services[resolved.name].fetch(resolved.request, env, ctx)
	},

	// `match` (presence sweep) and `rooms` (stale ballots, expired invites) each run a
	// `*/5 * * * *` cron in the split deployment; this worker's one trigger fires both.
	// Each schedules its work on `ctx.waitUntil`, so the runtime waits for both.
	scheduled(
		controller: ScheduledController,
		env: Env,
		ctx: ExecutionContext
	): Promise<void> | void {
		matchScheduled(controller, env, ctx)
		roomsScheduled(controller, env, ctx)
	},
} satisfies ExportedHandler<Env>
