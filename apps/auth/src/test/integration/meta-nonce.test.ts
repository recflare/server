import { describe, expect, test } from 'vitest'

import { parseMetaPlatformAuth, verifyMetaNonce } from '../../meta-nonce'

// The payload shape a real Meta login posts, captured from a live client. `Source`
// is informational and ignored; the AppId is Rec Room's Meta app.
const NONCE = 'xOUoGXJtC2N31BRDtoWJqBNo81o3DwfbQC57i9ApaiBIqkgmyMOgMYIng7c5jL5I'
const APP_ID = '1232175103309633'
const USER_ID = '27061366730207360'
const PLATFORM_AUTH = JSON.stringify({ Nonce: NONCE, AppId: APP_ID, Source: 'logged in user' })
const APP_SECRET = 'test-app-secret'

/**
 * A fetch stub answering with `bodies` (one body, or one per attempt), recording every
 * request it was handed. Typed to what `verifyMetaNonce` actually passes — a string URL
 * and a string body — rather than the whole of `fetch`, then cast at the boundary.
 */
function stubFetch(bodies: unknown, status = 200) {
	const queue = Array.isArray(bodies) ? [...(bodies as unknown[])] : [bodies]
	const calls: Array<{ url: string; form: URLSearchParams }> = []
	const fetcher = (async (url: string, init?: { body?: string }) => {
		calls.push({ url, form: new URLSearchParams(init?.body ?? '') })
		const body = queue.length > 1 ? queue.shift() : queue[0]
		return new Response(JSON.stringify(body), {
			status,
			headers: { 'Content-Type': 'application/json' },
		})
	}) as unknown as typeof fetch
	return { fetcher, calls }
}

describe('meta-nonce', () => {
	test('parses the platform_auth payload the client posts', () => {
		expect(parseMetaPlatformAuth(PLATFORM_AUTH)).toEqual({ nonce: NONCE, appId: APP_ID })
	})

	test.each([
		['not json', 'nonsense'],
		['no nonce', JSON.stringify({ AppId: APP_ID })],
		['empty nonce', JSON.stringify({ Nonce: '', AppId: APP_ID })],
		['no app id', JSON.stringify({ Nonce: NONCE })],
		// The app id is interpolated into the graph access token, so a non-numeric one
		// is refused rather than sent.
		['non-numeric app id', JSON.stringify({ Nonce: NONCE, AppId: 'OC|evil' })],
	])('rejects a malformed payload (%s)', (_label, payload) => {
		expect(parseMetaPlatformAuth(payload)).toBeNull()
	})

	test('validates the nonce against the posted user id and returns the identity', async () => {
		const { fetcher, calls } = stubFetch({ is_valid: true })
		const result = await verifyMetaNonce(PLATFORM_AUTH, USER_ID, APP_SECRET, fetcher)
		expect(result).toEqual({ ok: true, identity: { userId: USER_ID, appId: APP_ID } })

		// The request Meta actually sees: the nonce is bound to THIS user id, and the
		// app authenticates itself with `OC|<app id>|<secret>`.
		expect(calls).toHaveLength(1)
		expect(calls[0].url).toBe('https://graph.oculus.com/user_nonce_validate')
		expect(calls[0].form.get('nonce')).toBe(NONCE)
		expect(calls[0].form.get('user_id')).toBe(USER_ID)
		expect(calls[0].form.get('access_token')).toBe(`OC|${APP_ID}|${APP_SECRET}`)
	})

	test('rejects a nonce Meta does not vouch for', async () => {
		const { fetcher } = stubFetch({ is_valid: false })
		expect(await verifyMetaNonce(PLATFORM_AUTH, USER_ID, APP_SECRET, fetcher)).toEqual({
			ok: false,
			reason: 'nonce rejected',
		})
	})

	// The whole point of validating against the posted id: a nonce genuinely issued to
	// one user does not authenticate another. Meta answers is_valid:false for the
	// mismatch, so nobody can log in by naming someone else's Meta user id.
	test('a nonce presented for the wrong user id fails', async () => {
		const { fetcher, calls } = stubFetch({ is_valid: false })
		const result = await verifyMetaNonce(PLATFORM_AUTH, '99999999999999999', APP_SECRET, fetcher)
		expect(result.ok).toBe(false)
		expect(calls[0].form.get('user_id')).toBe('99999999999999999')
	})

	test.each([
		['missing', ''],
		['non-numeric', 'not-an-id'],
	])('refuses a %s user id without calling Meta', async (_label, userId) => {
		const { fetcher, calls } = stubFetch({ is_valid: true })
		const result = await verifyMetaNonce(PLATFORM_AUTH, userId, APP_SECRET, fetcher)
		expect(result.ok).toBe(false)
		expect(calls).toHaveLength(0)
	})

	test('refuses to attempt verification with no app secret', async () => {
		const { fetcher, calls } = stubFetch({ is_valid: true })
		expect(await verifyMetaNonce(PLATFORM_AUTH, USER_ID, '', fetcher)).toEqual({
			ok: false,
			reason: 'no app secret configured',
		})
		expect(calls).toHaveLength(0)
	})

	test('surfaces a graph error with its code, for the server log', async () => {
		const { fetcher } = stubFetch({
			error: { code: 100, message: 'Invalid OAuth access token', type: 'OAuthException' },
		})
		const result = await verifyMetaNonce(PLATFORM_AUTH, USER_ID, APP_SECRET, fetcher)
		expect(result).toEqual({
			ok: false,
			reason: 'graph error 100: Invalid OAuth access token',
		})
	})

	test('a non-retryable graph error is not retried', async () => {
		const { fetcher, calls } = stubFetch({ error: { code: 100, message: 'bad token' } })
		await verifyMetaNonce(PLATFORM_AUTH, USER_ID, APP_SECRET, fetcher)
		expect(calls).toHaveLength(1)
	})

	test('retries a transient graph error and succeeds on a later attempt', async () => {
		const { fetcher, calls } = stubFetch([
			{ error: { code: 2, message: 'service temporarily unavailable' } },
			{ is_valid: true },
		])
		const result = await verifyMetaNonce(PLATFORM_AUTH, USER_ID, APP_SECRET, fetcher)
		expect(result.ok).toBe(true)
		expect(calls).toHaveLength(2)
	})

	test('gives up after three attempts when Meta stays unavailable', async () => {
		const { fetcher, calls } = stubFetch({ error: { code: 1, message: 'unknown error' } })
		const result = await verifyMetaNonce(PLATFORM_AUTH, USER_ID, APP_SECRET, fetcher)
		expect(result.ok).toBe(false)
		expect(calls).toHaveLength(3)
	})

	test('treats a network failure as transient', async () => {
		let attempts = 0
		const fetcher = (async () => {
			attempts++
			throw new Error('connection reset')
		}) as unknown as typeof fetch
		const result = await verifyMetaNonce(PLATFORM_AUTH, USER_ID, APP_SECRET, fetcher)
		expect(result.ok).toBe(false)
		expect(attempts).toBe(3)
	})

	test('treats a non-JSON body (an edge error page) as transient', async () => {
		let attempts = 0
		const fetcher = (async () => {
			attempts++
			return new Response('<html>502</html>', { status: 502 })
		}) as unknown as typeof fetch
		const result = await verifyMetaNonce(PLATFORM_AUTH, USER_ID, APP_SECRET, fetcher)
		expect(result).toEqual({ ok: false, reason: 'HTTP 502 with a non-JSON body' })
		expect(attempts).toBe(3)
	})
})
