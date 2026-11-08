/**
 * The VPN / proxy gate on `/connect/token`, backed by proxycheck.io.
 *
 * OPTIONAL, and off unless the operator says otherwise: `VPN_BLOCK` (see context.ts) picks
 * what is gated — `signup` (every `create_account`, the game's and the website's) or `login`
 * (that plus every fresh sign-in) — and `PROXYCHECK_API_KEY` in the Secrets Store carries
 * the key. BOTH are needed: with the knob off, or with no key, nothing here is ever called,
 * so a server that never configures it pays nothing, not even a cache read.
 *
 * Why an IP-reputation lookup rather than Cloudflare's own request metadata: the request
 * carries an ASN but no "is a VPN" bit (Cloudflare's managed anonymizer lists are an
 * Enterprise WAF feature), and the website's sign-ins reach this worker over a service
 * binding, where the request carries no `cf` object at all — only the `CF-Connecting-IP`
 * www forwards. Keying on the IP is what lets the game client and the website be judged
 * the same way.
 *
 * Verdicts are CACHED per IP in the Cache API for ANONYMIZER_CACHE_SECONDS: a client that
 * retries a login, or a household that signs in several times an evening, costs one query
 * against the daily quota (1,000 on a free key). Only verdicts are cached — a lookup that
 * failed or was refused is retried next time.
 *
 * The gate FAILS OPEN. A lookup that times out, errors, or is `denied` (quota exhausted,
 * bad key) lets the grant through and leaves an error in the log: a reputation service
 * being down or a quota running out must never be the reason nobody can sign in.
 */
import { logger } from '@repo/hono-helpers'

/** proxycheck.io v3 — the current stable API; v2 is legacy. */
const PROXYCHECK_URL = 'https://proxycheck.io/v3'
/** How long one address's verdict is trusted before it is looked up again. */
export const ANONYMIZER_CACHE_SECONDS = 6 * 60 * 60
/** How long a lookup may take before the grant proceeds without it. */
const LOOKUP_TIMEOUT_MS = 3000
/** A synthetic origin the cached verdicts are keyed under; never fetched. */
const CACHE_ORIGIN = 'https://proxycheck.recflare.internal'

/** What `VPN_BLOCK` can say. Anything else reads as `off`. */
export type VpnBlockMode = 'off' | 'signup' | 'login'

/**
 * Read the `VPN_BLOCK` knob. `signup` gates `create_account` only; `login` gates every
 * fresh sign-in as well. Unset, blank, `off`, or a typo all mean OFF — a gate that refuses
 * players must not switch on from a misspelling.
 */
export function vpnBlockMode(value: unknown): VpnBlockMode {
	if (typeof value !== 'string') return 'off'
	const mode = value.trim().toLowerCase()
	return mode === 'signup' || mode === 'login' ? mode : 'off'
}

/**
 * The outcome of one lookup.
 *  - `clean`: a residential/business/mobile address with nothing detected.
 *  - `anonymizer`: proxycheck's `anonymous` flag — a VPN, proxy or Tor exit — with the
 *    breakdown for the log line. `hosting` alone (a datacenter address) is NOT refused: it
 *    catches a self-hosted VPN, but also cloud gaming and a player's own remote desktop.
 *  - `unknown`: the lookup could not say (timeout, error, quota). The caller fails open.
 */
export type AnonymizerVerdict =
	| { kind: 'clean' }
	| {
			kind: 'anonymizer'
			vpn: boolean
			proxy: boolean
			tor: boolean
			provider: string | null
			operator: string | null
			risk: number | null
	  }
	| { kind: 'unknown'; reason: string }

/** The slice of proxycheck's v3 per-address object this reads. Unknown keys are ignored. */
interface ProxycheckAddress {
	network?: { provider?: unknown }
	detections?: {
		proxy?: unknown
		vpn?: unknown
		tor?: unknown
		anonymous?: unknown
		risk?: unknown
	}
	operator?: { name?: unknown }
}

/**
 * Whether an address is one proxycheck could never say anything about — loopback, RFC 1918,
 * link-local, the IPv6 equivalents. `wrangler dev` and a LAN client arrive as these; looking
 * them up only spends quota on a guaranteed error. The empty string (no `CF-Connecting-IP`,
 * i.e. tests and anything not behind the edge) is covered by the caller, not here.
 */
export function isPrivateIp(ip: string): boolean {
	if (ip.startsWith('127.') || ip.startsWith('10.') || ip.startsWith('192.168.')) return true
	if (ip.startsWith('169.254.')) return true
	const m172 = /^172\.(\d{1,3})\./.exec(ip)
	if (m172 && Number(m172[1]) >= 16 && Number(m172[1]) <= 31) return true
	const lower = ip.toLowerCase()
	if (lower === '::1' || lower === '::') return true
	// fc00::/7 (unique local) and fe80::/10 (link-local).
	if (/^f[cd][0-9a-f]{2}:/.test(lower) || /^fe[89ab][0-9a-f]:/.test(lower)) return true
	return false
}

/**
 * Look an address up, through the per-IP cache. `key` is the operator's proxycheck key —
 * the caller has already decided not to be here without one. `fetcher` is injectable so
 * tests can stand in for proxycheck, exactly as `verifyMetaNonce` lets them stand in for
 * Meta; it is resolved per call so a stubbed `globalThis.fetch` is seen.
 */
export async function lookupAnonymizer(
	ip: string,
	key: string,
	fetcher?: typeof fetch
): Promise<AnonymizerVerdict> {
	const cached = await readCachedVerdict(ip)
	if (cached) return cached

	const verdict = await queryProxycheck(ip, key, fetcher ?? globalThis.fetch)
	if (verdict.kind !== 'unknown') await writeCachedVerdict(ip, verdict)
	return verdict
}

async function queryProxycheck(
	ip: string,
	key: string,
	doFetch: typeof fetch
): Promise<AnonymizerVerdict> {
	// `vpn=1` folds VPN detection into the answer, `asn=1` names the network (for the log),
	// `risk=1` scores it. The key goes in the query string: that is the only place
	// proxycheck reads it from.
	const params = new URLSearchParams({ vpn: '1', asn: '1', risk: '1', key })
	const url = `${PROXYCHECK_URL}/${encodeURIComponent(ip)}?${params.toString()}`

	let body: Record<string, unknown>
	try {
		const res = await doFetch(url, {
			method: 'GET',
			headers: { accept: 'application/json' },
			signal: AbortSignal.timeout(LOOKUP_TIMEOUT_MS),
		})
		// proxycheck answers 4xx for `denied`/`error` with a JSON body saying why, so the body
		// is read regardless of status and the status itself decides nothing.
		body = (await res.json()) as Record<string, unknown>
	} catch (err) {
		return { kind: 'unknown', reason: err instanceof Error ? err.message : String(err) }
	}

	// `ok` and `warning` both carry an answer (a warning is a note alongside it — a quota
	// nearly spent, a flag it didn't understand); `denied` and `error` carry none.
	const status = typeof body.status === 'string' ? body.status : 'missing'
	const message = typeof body.message === 'string' ? body.message : ''
	if (status !== 'ok' && status !== 'warning') {
		return { kind: 'unknown', reason: message ? `${status}: ${message}` : status }
	}
	const entry = body[ip]
	if (!entry || typeof entry !== 'object') {
		return { kind: 'unknown', reason: 'no entry for the address in the response' }
	}
	const address = entry as ProxycheckAddress
	const d = address.detections ?? {}
	const proxy = d.proxy === true
	const vpn = d.vpn === true
	const tor = d.tor === true
	// `anonymous` is proxycheck's own roll-up of the three; the flags are OR'd in beside it
	// so a response carrying only the specific bits still counts.
	if (d.anonymous !== true && !proxy && !vpn && !tor) return { kind: 'clean' }
	return {
		kind: 'anonymizer',
		vpn,
		proxy,
		tor,
		provider: typeof address.network?.provider === 'string' ? address.network.provider : null,
		operator: typeof address.operator?.name === 'string' ? address.operator.name : null,
		risk: typeof d.risk === 'number' ? d.risk : null,
	}
}

/**
 * The cache is best-effort in both directions: a Cache API that is unavailable or throws
 * (neither has been seen in workerd or miniflare, but the gate must not depend on it)
 * just means a lookup per request.
 */
function cacheKey(ip: string): Request {
	return new Request(`${CACHE_ORIGIN}/${encodeURIComponent(ip)}`, { method: 'GET' })
}

async function readCachedVerdict(ip: string): Promise<AnonymizerVerdict | null> {
	try {
		const hit = await caches.default.match(cacheKey(ip))
		if (!hit) return null
		const verdict = (await hit.json()) as AnonymizerVerdict
		return verdict.kind === 'clean' || verdict.kind === 'anonymizer' ? verdict : null
	} catch (err) {
		logger.warn('could not read the proxycheck verdict cache', { error: String(err) })
		return null
	}
}

async function writeCachedVerdict(ip: string, verdict: AnonymizerVerdict): Promise<void> {
	try {
		await caches.default.put(
			cacheKey(ip),
			new Response(JSON.stringify(verdict), {
				headers: {
					'content-type': 'application/json',
					'cache-control': `max-age=${ANONYMIZER_CACHE_SECONDS}`,
				},
			})
		)
	} catch (err) {
		logger.warn('could not write the proxycheck verdict cache', { error: String(err) })
	}
}
