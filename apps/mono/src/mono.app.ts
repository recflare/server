/**
 * Combined ("facade") worker.
 *
 * Mounts each RecFlare worker inside a single deployable Worker WITHOUT modifying the
 * originals: every app is imported by relative path and bundled by esbuild at build
 * time. A request selects its service two ways, and the sub-app paths (and therefore the
 * client contract) are untouched either way.
 *
 * By PATH — how this worker is meant to be deployed, at the apex of `DOMAIN`, and the
 * only way that works in local dev, which has no subdomain. The first path segment names
 * the service and is stripped before the request is forwarded, e.g.
 *   https://<domain>/accounts/           -> accounts app sees /
 *   https://<domain>/match/player/login  -> match app sees /player/login
 *   https://<domain>/api/api/config/v2   -> api app sees /api/config/v2
 *
 * By SUBDOMAIN — `accounts.<domain>` -> the `accounts` app, with the path forwarded
 * unchanged. That mirrors the split deployment, so a client (or a stray DNS record) still
 * pointed at the per-service hosts keeps working if they're routed here.
 *
 * A request with no path (just `/`) that selects no service serves the `ns` discovery
 * document, so a bare hit to the facade root returns the service map to bootstrap from.
 * The document is built in the PATH style (`https://<domain>/rooms`, every service on
 * this one host) — see ENDPOINT_STYLE below — so deploy this worker at the apex of
 * `DOMAIN` and point the client at nothing else.
 *
 * NOT mounted here: `www`, `img`, `econ`. Each binds a static `assets` directory and
 * Cloudflare allows only one static-assets binding per Worker. Resolve that (serve
 * their static trees from R2, or keep those three as their own Workers) before adding.
 * The discovery document still puts them on this host, since a single-service run is the
 * whole point of this worker — so until they're mounted, their paths 404 here.
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
import rooms from '../../rooms/src/rooms.app'
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

/**
 * This worker is one host, so its discovery document has to name one host: every service
 * is advertised as `https://<domain>/<name>`, never `https://<name>.<domain>`. Handed to
 * the mounted `ns` app, which defaults to the per-host document the split deployment wants.
 */
const ENDPOINT_STYLE = 'path'

function resolve(request: Request): { name: ServiceName; request: Request } | undefined {
	const url = new URL(request.url)

	// Dispatch on the leftmost DNS label — accounts.<domain> -> accounts. The path is
	// forwarded unchanged so the client contract is identical to the split deployment.
	const sub = url.hostname.split('.')[0]
	if (sub in services) return { name: sub as ServiceName, request }

	// Apex (and local dev): the first path segment selects the service and is stripped
	// before forwarding — /match/player/login -> match app sees /player/login. This is
	// what the discovery document advertises; see ENDPOINT_STYLE.
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
		// `ns` is the one mounted app whose answer depends on this worker's own shape: the
		// addresses it hands out have to be paths on this host. Passed as a var — the same
		// way a deploy would — so the app itself stays free of any knowledge of mono.
		if (resolved.name === 'ns') return ns.fetch(resolved.request, { ...env, ENDPOINT_STYLE }, ctx)

		return services[resolved.name].fetch(resolved.request, env, ctx)
	},

	// Only `match` runs a cron in the split deployment; this worker owns its presence sweep.
	scheduled(
		controller: ScheduledController,
		env: Env,
		ctx: ExecutionContext
	): Promise<void> | void {
		return matchScheduled(controller, env, ctx)
	},
} satisfies ExportedHandler<Env>
