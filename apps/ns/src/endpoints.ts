/**
 * Service-discovery map: service label → subdomain. The game client fetches the
 * generated `{ label: "https://<subdomain>.<domain>" }` document from `/`.
 *
 * The base domain is injected at deploy time via the `DOMAIN` var (see
 * `run-wrangler-deploy`), so the real domain never lives in a versioned file.
 */
const SERVICE_SUBDOMAINS = {
	Accounts: 'accounts',
	AI: 'ai',
	API: 'api',
	Auth: 'auth',
	BugReporting: 'bugreporting',
	Cards: 'cards',
	CDN: 'cdn',
	Chat: 'chat',
	Clubs: 'clubs',
	CMS: 'cms',
	Commerce: 'commerce',
	Data: 'data',
	DataCollection: 'datacollection',
	Discovery: 'discovery',
	Econ: 'econ',
	GameLogs: 'gamelogs',
	Geo: 'geo',
	Images: 'img',
	Leaderboard: 'leaderboard',
	Link: 'link',
	Lists: 'lists',
	Matchmaking: 'match',
	Moderation: 'moderation',
	Notifications: 'notify',
	PlatformNotifications: 'platformnotifications',
	PlayerSettings: 'playersettings',
	RoomComments: 'roomcomments',
	RoomieIntegrations: 'roomieintegrations',
	Rooms: 'rooms',
	Storage: 'storage',
	Strings: 'strings',
	StringsCDN: 'strings-cdn',
	Studio: 'studio',
	Thorn: 'thorn',
	Videos: 'videos',
	WWW: 'www',
} as const

/**
 * Where the services live, relative to the base domain:
 *
 *   `subdomain` — one host each, `https://rooms.<domain>`. The split deployment, and the
 *   default, since that's what every worker in `apps/` is deployed as.
 *   `path` — one host, first path segment names the service: `https://<domain>/rooms`.
 *   Only the combined `mono` worker, which is a single Worker routing on that segment.
 */
export type EndpointStyle = 'subdomain' | 'path'

/** Builds the endpoints document for `domain`, e.g. `rec.example.com`. */
export function buildEndpoints(
	domain: string,
	style: EndpointStyle = 'subdomain'
): Record<string, string> {
	return Object.fromEntries(
		Object.entries(SERVICE_SUBDOMAINS).map(([label, sub]) => [
			label,
			style === 'path' ? `https://${domain}/${sub}` : `https://${sub}.${domain}`,
		])
	)
}
