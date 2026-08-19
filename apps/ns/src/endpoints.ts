/**
 * Service-discovery map: service label → default subdomain. The game client fetches the
 * generated `{ label: "https://<subdomain>.<domain>" }` document from `/`.
 *
 * The base domain is injected at deploy time via the `DOMAIN` var (see
 * `run-wrangler-deploy`), so the real domain never lives in a versioned file. The
 * subdomains here are defaults — an operator redirects any of them from `.env`, see
 * `applyOverrides` below.
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
 * Parses the `SUBDOMAINS` var — the operator's `RECFLARE_SUBDOMAINS` object, injected at
 * deploy time by `run-wrangler-deploy`.
 *
 * It is keyed by the DEFAULT subdomain above, not by the service label, because the deploy
 * script reads the very same object keyed by a worker's directory name — and every worker's
 * directory name is its default subdomain. So one `.env` entry moves both sides at once:
 * `{"playersettings":"settings"}` both deploys the `playersettings` worker onto
 * `settings.<domain>` and advertises that host to the client. Entries naming a service with
 * no worker of its own are pure client-side redirects — `{"moderation":"api"}` points the
 * client's Moderation calls at the `api` worker, which is where the
 * `/api/PlayerReporting/…` routes actually live.
 *
 * A malformed value is ignored rather than thrown: this document is the first thing the
 * client fetches, so a typo in `.env` should cost one redirect, not every service host.
 */
function parseOverrides(subdomains: string | undefined): Record<string, string> {
	if (!subdomains) return {}
	let parsed: unknown
	try {
		parsed = JSON.parse(subdomains)
	} catch {
		return {}
	}
	if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return {}
	return Object.fromEntries(
		Object.entries(parsed).filter(
			(entry): entry is [string, string] => typeof entry[1] === 'string' && entry[1] !== ''
		)
	)
}

/**
 * Builds the endpoints document for `domain`, e.g. `rec.example.com`, applying any
 * subdomain overrides from `subdomains` (the raw `SUBDOMAINS` var JSON).
 */
export function buildEndpoints(domain: string, subdomains?: string): Record<string, string> {
	const overrides = parseOverrides(subdomains)
	return Object.fromEntries(
		Object.entries(SERVICE_SUBDOMAINS).map(([label, sub]) => [
			label,
			`https://${overrides[sub] ?? sub}.${domain}`,
		])
	)
}
