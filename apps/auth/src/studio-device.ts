/**
 * Rec Room Studio's device-login handshake.
 *
 * The editor (RecRoom.Studio.Editor.Core, `MKLLKHBNNLP`) POSTs
 * `connect/deviceauthorization` to the **Auth** service — service enum value 0,
 * the host `ns` advertises as `Auth` — with `client_id=recroom.studio` and the
 * client secret embedded in that assembly. It then opens `verification_uri_complete`
 * in the browser and polls `POST connect/token` on the same Auth host with
 * `grant_type=urn:ietf:params:oauth:grant-type:device_code` until the code is
 * approved or `expires_in` seconds pass.
 *
 * `GET account/me` after a successful poll is a different service: enum 11,
 * **Accounts**. This module does not serve that.
 *
 * The page the editor opens is **WWW** `/device`. Auth only mints the codes and,
 * once that page has approved one, the token.
 */

/** What Studio posts as `client_id` on the device grant. */
export const STUDIO_CLIENT_ID = 'recroom.studio'

/**
 * The matching `client_secret` compiled into the Studio editor. It is not a
 * server secret — anyone with the editor binary has it — but checking it keeps
 * a random POST from minting codes.
 */
export const STUDIO_CLIENT_SECRET = '54oc5C4BH7jpqp42KhChkNZOLP0U3yTx'

/** `grant_type` Studio polls with. RFC 8628. */
export const DEVICE_CODE_GRANT = 'urn:ietf:params:oauth:grant-type:device_code'

/** How long the player has to approve, in seconds. Studio reads this as seconds. */
export const DEVICE_TTL_SECONDS = 10 * 60

/** Minimum poll spacing Studio is told to use, in seconds. */
export const DEVICE_POLL_INTERVAL_SECONDS = 5

/** Unambiguous alphabet. Studio pretty-prints a code only when it is exactly 6 chars. */
const USER_CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'
const USER_CODE_LENGTH = 8

export const STUDIO_DEVICE_SCHEMA_DDL: string[] = [
	`CREATE TABLE IF NOT EXISTS studio_device_grant (
		device_code_hash TEXT PRIMARY KEY,
		user_code TEXT NOT NULL UNIQUE,
		account_id INTEGER,
		status TEXT NOT NULL,
		created_at INTEGER NOT NULL,
		expires_at INTEGER NOT NULL
	)`,
]

type GrantStatus = 'pending' | 'approved' | 'denied' | 'consumed'

export interface DeviceGrant {
	userCode: string
	deviceCode: string
	expiresIn: number
	interval: number
}

export type DevicePoll =
	| { kind: 'pending' }
	| { kind: 'denied' }
	| { kind: 'expired' }
	| { kind: 'invalid' }
	| { kind: 'approved'; accountId: number }

interface GrantRow {
	account_id: number | null
	status: GrantStatus
	expires_at: number
}

function nowSeconds(): number {
	return Math.floor(Date.now() / 1000)
}

async function sha256(value: string): Promise<string> {
	const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value))
	return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('')
}

function randomUserCode(): string {
	const bytes = crypto.getRandomValues(new Uint8Array(USER_CODE_LENGTH))
	let code = ''
	for (const byte of bytes) code += USER_CODE_ALPHABET[byte % USER_CODE_ALPHABET.length]
	return code
}

function randomDeviceCode(): string {
	const bytes = crypto.getRandomValues(new Uint8Array(32))
	return [...bytes].map((b) => b.toString(16).padStart(2, '0')).join('')
}

/** Strip spaces and hyphens and uppercase, so a code typed as Studio displays it still matches. */
export function normalizeUserCode(raw: string): string {
	return raw.replace(/[\s-]/g, '').toUpperCase()
}

export function studioClientMatches(body: Record<string, unknown>): boolean {
	return body.client_id === STUDIO_CLIENT_ID && body.client_secret === STUDIO_CLIENT_SECRET
}

export async function beginDeviceGrant(db: D1Database): Promise<DeviceGrant> {
	const now = nowSeconds()
	const deviceCode = randomDeviceCode()
	const deviceCodeHash = await sha256(deviceCode)
	for (let attempt = 0; attempt < 5; attempt++) {
		const userCode = randomUserCode()
		try {
			await db
				.prepare(
					`INSERT INTO studio_device_grant
					 (device_code_hash, user_code, account_id, status, created_at, expires_at)
					 VALUES (?1, ?2, NULL, 'pending', ?3, ?4)`
				)
				.bind(deviceCodeHash, userCode, now, now + DEVICE_TTL_SECONDS)
				.run()
			return {
				userCode,
				deviceCode,
				expiresIn: DEVICE_TTL_SECONDS,
				interval: DEVICE_POLL_INTERVAL_SECONDS,
			}
		} catch (err) {
			const message = err instanceof Error ? err.message : String(err)
			if (!message.includes('UNIQUE')) throw err
		}
	}
	throw new Error('could not allocate a studio device code')
}

async function readByHash(db: D1Database, deviceCode: string): Promise<GrantRow | null> {
	return db
		.prepare(
			`SELECT account_id, status, expires_at FROM studio_device_grant WHERE device_code_hash = ?1`
		)
		.bind(await sha256(deviceCode))
		.first<GrantRow>()
}

/**
 * One poll from Studio. An approved code is consumed exactly once: two polls
 * racing each other cannot both walk away with a session.
 */
export async function pollDeviceGrant(db: D1Database, deviceCode: string): Promise<DevicePoll> {
	const row = await readByHash(db, deviceCode)
	if (!row) return { kind: 'invalid' }
	if (row.expires_at <= nowSeconds()) return { kind: 'expired' }
	if (row.status === 'pending') return { kind: 'pending' }
	if (row.status === 'denied') return { kind: 'denied' }
	if (row.status !== 'approved' || row.account_id == null) return { kind: 'invalid' }

	const consumed = await db
		.prepare(
			`UPDATE studio_device_grant SET status = 'consumed'
			 WHERE device_code_hash = ?1 AND status = 'approved' AND expires_at > ?2`
		)
		.bind(await sha256(deviceCode), nowSeconds())
		.run()
	if ((consumed.meta.changes ?? 0) < 1) return { kind: 'invalid' }
	return { kind: 'approved', accountId: row.account_id }
}

export type DeviceDecision =
	| { kind: 'ok' }
	| { kind: 'missing' }
	| { kind: 'expired' }
	| { kind: 'used' }

async function decide(
	db: D1Database,
	userCode: string,
	accountId: number,
	status: 'approved' | 'denied'
): Promise<DeviceDecision> {
	const code = normalizeUserCode(userCode)
	if (code === '') return { kind: 'missing' }
	const updated = await db
		.prepare(
			`UPDATE studio_device_grant
			 SET status = ?2, account_id = ?3
			 WHERE user_code = ?1 AND status = 'pending' AND expires_at > ?4`
		)
		.bind(code, status, accountId, nowSeconds())
		.run()
	if ((updated.meta.changes ?? 0) > 0) return { kind: 'ok' }

	const row = await db
		.prepare(`SELECT status, expires_at, account_id FROM studio_device_grant WHERE user_code = ?1`)
		.bind(code)
		.first<{ status: GrantStatus; expires_at: number; account_id: number | null }>()
	if (!row) return { kind: 'missing' }
	if (row.expires_at <= nowSeconds()) return { kind: 'expired' }
	// Approving again from the same account is the player double-clicking Allow.
	if (status === 'approved' && row.status === 'approved' && row.account_id === accountId)
		return { kind: 'ok' }
	return { kind: 'used' }
}

export function approveDeviceGrant(
	db: D1Database,
	userCode: string,
	accountId: number
): Promise<DeviceDecision> {
	return decide(db, userCode, accountId, 'approved')
}

export function denyDeviceGrant(
	db: D1Database,
	userCode: string,
	accountId: number
): Promise<DeviceDecision> {
	return decide(db, userCode, accountId, 'denied')
}
