import { adminSecretsStore, env } from 'cloudflare:test'
import { exports } from 'cloudflare:workers'
import { beforeAll, describe, expect, test } from 'vitest'

import '../../clubs.app'

import { CLUB_SCHEMA_DDL } from '@repo/domain'

import type { Env } from '../../context'

declare module 'cloudflare:test' {
	interface ProvidedEnv extends Env {}
}

const ORIGIN = 'https://example.com'

beforeAll(async () => {
	// Seed the shared JWT signing key into the local Secrets Store so .get() resolves.
	await adminSecretsStore(env.JWT_SECRET).create('test-signing-key')
	// Build the club / club_member tables (mirrors the migration).
	for (const stmt of CLUB_SCHEMA_DDL) await env.DB.prepare(stmt).run()

	// Accounts table (owned by the auth worker) — a player's home club is a field on
	// their account row, so /club/home/me reads and writes it here.
	await env.DB.prepare(
		`CREATE TABLE IF NOT EXISTS account (
			data TEXT NOT NULL,
			account_id INTEGER GENERATED ALWAYS AS (json_extract(data, '$.accountId')) VIRTUAL
		)`
	).run()
	// Image metadata (owned by the img worker, written by api on upload) — a club's
	// gallery serves the whole image record behind each stored image name.
	await env.DB.prepare(
		`CREATE TABLE IF NOT EXISTS image (
			data TEXT NOT NULL,
			id INTEGER GENERATED ALWAYS AS (json_extract(data, '$.Id')) VIRTUAL,
			image_name TEXT GENERATED ALWAYS AS (json_extract(data, '$.ImageName')) VIRTUAL
		)`
	).run()

	const insertAccount = env.DB.prepare('INSERT OR IGNORE INTO account (data) VALUES (?1)')
	await env.DB.batch(
		[42, 9100, 9101].map((accountId) =>
			insertAccount.bind(JSON.stringify({ accountId, username: `Player${accountId}` }))
		)
	)
})

// Mint a token the way the `auth` worker does, signing with the shared test key seeded into the JWT_SECRET store.
const TEST_SECRET = 'test-signing-key'

function b64url(input: ArrayBuffer | string): string {
	const bytes = typeof input === 'string' ? new TextEncoder().encode(input) : new Uint8Array(input)
	let binary = ''
	for (const byte of bytes) binary += String.fromCharCode(byte)
	return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

async function bearer(sub = '42'): Promise<Record<string, string>> {
	const now = Math.floor(Date.now() / 1000)
	const signingInput = `${b64url(JSON.stringify({ alg: 'HS256', typ: 'JWT' }))}.${b64url(
		JSON.stringify({ sub, exp: now + 3600 })
	)}`
	const key = await crypto.subtle.importKey(
		'raw',
		new TextEncoder().encode(TEST_SECRET),
		{ name: 'HMAC', hash: 'SHA-256' },
		false,
		['sign']
	)
	const sig = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(signingInput))
	return { Authorization: `Bearer ${signingInput}.${b64url(sig)}` }
}

describe('clubs endpoints', () => {
	test('GET /club/home/me 401s without a token', async () => {
		const res = await exports.default.fetch(`${ORIGIN}/club/home/me`)
		expect(res.status).toBe(401)
	})

	test('GET /club/home/me 404s when the player has no home club', async () => {
		// The client expects a 404 here, and errors on an empty object.
		const res = await exports.default.fetch(`${ORIGIN}/club/home/me`, { headers: await bearer() })
		expect(res.status).toBe(404)
	})

	test('GET /subscription/mine/member returns an empty array without a token', async () => {
		// The client calls this on the clubs host with no /club prefix and no auth.
		const res = await exports.default.fetch(`${ORIGIN}/subscription/mine/member`)
		expect(res.status).toBe(200)
		expect(await res.json()).toEqual([])
	})

	test('GET /subscription/details/:subscription returns an empty object', async () => {
		const res = await exports.default.fetch(`${ORIGIN}/subscription/details/rrplus`)
		expect(res.status).toBe(200)
		expect(await res.json()).toEqual({})
	})

	test('GET /subscription/details/:accountId returns simulated details', async () => {
		const res = await exports.default.fetch(`${ORIGIN}/subscription/details/2`)
		expect(res.status).toBe(200)
		expect(await res.json()).toEqual({ accountId: 2, clubId: 0, subscriberCount: 0 })
	})

	test('GET /subscription/subscriberCount/:id returns 0', async () => {
		const res = await exports.default.fetch(`${ORIGIN}/subscription/subscriberCount/2`)
		expect(res.status).toBe(200)
		expect(await res.json()).toBe(0)
	})

	test('GET /announcements/v2/mine/unread returns []', async () => {
		const res = await exports.default.fetch(`${ORIGIN}/announcements/v2/mine/unread`)
		expect(res.status).toBe(200)
		expect(await res.json()).toEqual([])
	})

	test('GET /announcements/v2/subscription/mine/unread returns []', async () => {
		const res = await exports.default.fetch(
			`${ORIGIN}/announcements/v2/subscription/mine/unread?sendAnnouncements=true`
		)
		expect(res.status).toBe(200)
		expect(await res.json()).toEqual([])
	})

	test('GET /club/mine/member lists the caller’s clubs; signed out is an empty list', async () => {
		// Signed out is "no clubs", not an error — a 401 here breaks the client's shelf.
		const anon = await exports.default.fetch(`${ORIGIN}/club/mine/member`)
		expect(anon.status).toBe(200)
		expect(await anon.json()).toEqual([])

		const res = await exports.default.fetch(`${ORIGIN}/club/mine/member`, {
			headers: await bearer('4242'),
		})
		expect(res.status).toBe(200)
		expect(await res.json()).toEqual([])
	})

	test('GET /club/mine/created returns an empty list when signed out', async () => {
		const res = await exports.default.fetch(`${ORIGIN}/club/mine/created`)
		expect(res.status).toBe(200)
		expect(await res.json()).toEqual([])
	})

	test('the my-clubs lists exclude subscription clubs (ClubType 1)', async () => {
		// A subscription club the player both created and is a member of. It's reached
		// through /subscription/*, so it must not show up among their clubs.
		const club = {
			ClubId: 9001,
			Name: 'Subscribers',
			Description: '',
			Category: '',
			Visibility: 1,
			Joinability: 0,
			AllowJuniors: true,
			MainImageName: '',
			ClubType: 1,
			ClubhouseRoomId: null,
			CreatorAccountId: 4343,
			IsRRO: false,
			MinLevel: 0,
			State: 0,
			MemberCount: 1,
			CreatedAt: '2026-07-01T00:00:00Z',
		}
		await env.DB.prepare('INSERT INTO club (data) VALUES (?1)').bind(JSON.stringify(club)).run()
		await env.DB.prepare(
			'INSERT INTO club_member (club_id, account_id, membership_type, created_at) VALUES (?1, ?2, ?3, ?4)'
		)
			.bind(9001, 4343, 100, '2026-07-01T00:00:00Z')
			.run()

		const created = await exports.default.fetch(`${ORIGIN}/club/mine/created`, {
			headers: await bearer('4343'),
		})
		expect(await created.json()).toEqual([])
		const member = await exports.default.fetch(`${ORIGIN}/club/mine/member`, {
			headers: await bearer('4343'),
		})
		expect(await member.json()).toEqual([])
	})

	test('POST /club/create takes the client’s lowercase form and answers the envelope', async () => {
		// The exact request the client sends: lowercase name/description/category.
		const res = await exports.default.fetch(`${ORIGIN}/club/create`, {
			method: 'POST',
			headers: {
				...(await bearer('5000')),
				'Content-Type': 'application/x-www-form-urlencoded',
			},
			body: 'name=clubz&description=da%20best%20club&category=Creative',
		})
		expect(res.status).toBe(200)
		const body = (await res.json()) as {
			error: string
			success: boolean
			value: {
				Club: { Name: string; Description: string; Category: string; CreatorAccountId: number }
				ClubId: number
				CustomTags: string[]
				AdditionalImages: unknown[]
				MyMembershipType: number
				CoownerPermissions: { Type: number; EditDetails: boolean }
				ModeratorPermissions: { Type: number; BanUnban: boolean; EditDetails: boolean }
				MemberPermissions: { Type: number; BanUnban: boolean }
			}
		}
		expect(body.error).toBe('')
		expect(body.success).toBe(true)
		expect(body.value.Club).toMatchObject({
			Name: 'clubz',
			Description: 'da best club',
			Category: 'Creative',
			CreatorAccountId: 5000,
		})
		expect(body.value.ClubId).toBeGreaterThan(0)
		expect(body.value.MyMembershipType).toBe(100) // creator
		expect(body.value.CustomTags).toEqual([])
		expect(body.value.AdditionalImages).toEqual([])
		// Co-owners get everything, moderators approve/ban only, members nothing.
		expect(body.value.CoownerPermissions).toMatchObject({ Type: 30, EditDetails: true })
		expect(body.value.ModeratorPermissions).toMatchObject({
			Type: 20,
			BanUnban: true,
			EditDetails: false,
		})
		expect(body.value.MemberPermissions).toMatchObject({ Type: 10, BanUnban: false })
	})

	test('POST /club/create defaults the category and rejects bad names', async () => {
		const create = async (fields: Record<string, string>): Promise<Response> =>
			exports.default.fetch(`${ORIGIN}/club/create`, {
				method: 'POST',
				headers: {
					...(await bearer('5001')),
					'Content-Type': 'application/x-www-form-urlencoded',
				},
				body: new URLSearchParams(fields).toString(),
			})

		// No category → Social.
		const defaulted = (await (await create({ name: 'Catless' })).json()) as {
			value: { Club: { Category: string } }
		}
		expect(defaulted.value.Club.Category).toBe('Social')

		// Emoji and other non-Latin scripts are rejected; the error rides the envelope.
		const emoji = await create({ name: 'club 🎉' })
		expect(emoji.status).toBe(400)
		expect(await emoji.json()).toMatchObject({ success: false, value: null })

		// Names cap at 40 characters.
		expect((await create({ name: 'a'.repeat(41) })).status).toBe(400)
		expect((await create({ name: 'a'.repeat(40) })).status).toBe(200)

		// Descriptions cap at 512. Counted in code points, so an emoji-heavy one isn't
		// refused at half the length a player can see (the description has no charset rule
		// — only the name does).
		expect((await create({ name: 'DescTooLong', description: 'd'.repeat(513) })).status).toBe(400)
		expect((await create({ name: 'DescAtLimit', description: 'd'.repeat(512) })).status).toBe(200)
		expect((await create({ name: 'DescEmoji', description: '🎉'.repeat(512) })).status).toBe(200)

		// Basic punctuation is allowed.
		expect((await create({ name: "Bob's Club (2)" })).status).toBe(200)
	})

	test('PUT /club/:id/modifydetails edits the club, co-owner only', async () => {
		type Details = {
			error: string
			success: boolean
			value: {
				Club: {
					Visibility: number
					Joinability: number
					AllowJuniors: boolean
					Name: string
					Description: string
				}
				CustomTags: string[]
			}
		}
		const create = await exports.default.fetch(`${ORIGIN}/club/create`, {
			method: 'POST',
			headers: { ...(await bearer('6000')), 'Content-Type': 'application/x-www-form-urlencoded' },
			body: 'name=Editable&description=before',
		})
		const clubId = ((await create.json()) as { value: { ClubId: number } }).value.ClubId

		const modify = async (body: string, sub = '6000'): Promise<Response> =>
			exports.default.fetch(`${ORIGIN}/club/${clubId}/modifydetails`, {
				method: 'PUT',
				headers: { ...(await bearer(sub)), 'Content-Type': 'application/x-www-form-urlencoded' },
				body,
			})

		// The client's exact request: enums by name, and a custom tag.
		const res = await modify('visibility=Public&joinability=Open&allowJuniors=True&customTags=devi')
		expect(res.status).toBe(200)
		const body = (await res.json()) as Details
		expect(body).toMatchObject({ error: '', success: true })
		expect(body.value.Club).toMatchObject({
			Visibility: 1, // Public
			Joinability: 0, // Open
			AllowJuniors: true,
			// Fields the request didn't mention are untouched.
			Name: 'Editable',
			Description: 'before',
		})
		expect(body.value.CustomTags).toEqual(['devi'])

		// The other enum spellings land on the right numbers.
		const priv = (await (
			await modify('visibility=Private&joinability=AskToJoin&allowJuniors=False')
		).json()) as Details
		expect(priv.value.Club).toMatchObject({
			Visibility: 0,
			Joinability: 2,
			AllowJuniors: false,
		})
		const invite = (await (await modify('joinability=InviteOnly')).json()) as Details
		expect(invite.value.Club.Joinability).toBe(1)

		// customTags replaces the set wholesale, de-duplicated case-insensitively.
		const retagged = (await (
			await modify('customTags=Alpha&customTags=alpha&customTags=Beta')
		).json()) as Details
		expect(retagged.value.CustomTags).toEqual(['Alpha', 'Beta'])
		// Omitting customTags leaves the existing tags alone.
		const untouched = (await (await modify('category=Social')).json()) as Details
		expect(untouched.value.CustomTags).toEqual(['Alpha', 'Beta'])

		// A plain member can't edit; a non-member can't either; signed out is a 401.
		await exports.default.fetch(`${ORIGIN}/club/${clubId}/join`, {
			method: 'POST',
			headers: await bearer('6001'),
		})
		expect((await modify('name=Hijacked', '6001')).status).toBe(403)
		expect((await modify('name=Hijacked', '6002')).status).toBe(403)
		const anon = await exports.default.fetch(`${ORIGIN}/club/${clubId}/modifydetails`, {
			method: 'PUT',
			headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
			body: 'name=Hijacked',
		})
		expect(anon.status).toBe(401)

		// Editing a club that doesn't exist 404s.
		const missing = await exports.default.fetch(`${ORIGIN}/club/99999/modifydetails`, {
			method: 'PUT',
			headers: { ...(await bearer('6000')), 'Content-Type': 'application/x-www-form-urlencoded' },
			body: 'name=Ghost',
		})
		expect(missing.status).toBe(404)

		// /modify is the same endpoint under the client's shorter name.
		const short = async (sub: string) =>
			exports.default.fetch(`${ORIGIN}/club/${clubId}/modify`, {
				method: 'PUT',
				headers: { ...(await bearer(sub)), 'Content-Type': 'application/x-www-form-urlencoded' },
				body: 'name=my%20club&description=rock%20out&category=Casual',
			})
		const renamed = (await (await short('6000')).json()) as Details
		expect(renamed.value.Club).toMatchObject({
			Name: 'my club',
			Description: 'rock out',
			Category: 'Casual',
		})
		// ...and it's gated the same way.
		expect((await short('6001')).status).toBe(403)
		expect(
			(await exports.default.fetch(`${ORIGIN}/club/${clubId}/modify`, { method: 'PUT' })).status
		).toBe(401)
	})

	test('GET/PUT /club/:id/mainimage reads and sets the club image, co-owner only', async () => {
		type Details = { error: string; success: boolean; value: { Club: { MainImageName: string } } }
		const create = await exports.default.fetch(`${ORIGIN}/club/create`, {
			method: 'POST',
			headers: { ...(await bearer('7000')), 'Content-Type': 'application/x-www-form-urlencoded' },
			body: 'name=Picturesque',
		})
		const clubId = ((await create.json()) as { value: { ClubId: number } }).value.ClubId

		// GET reads the current image (the create default) without auth.
		const read = await exports.default.fetch(`${ORIGIN}/club/${clubId}/mainimage`)
		expect(read.status).toBe(200)
		expect(((await read.json()) as Details).value.Club.MainImageName).toBe('DefaultImgPurple')

		// PUT sets it from an uploaded image's name.
		const put = async (body: string, sub = '7000'): Promise<Response> =>
			exports.default.fetch(`${ORIGIN}/club/${clubId}/mainimage`, {
				method: 'PUT',
				headers: { ...(await bearer(sub)), 'Content-Type': 'application/x-www-form-urlencoded' },
				body,
			})
		const set = await put('imageName=2026-07-12%2Fclub.jpg')
		expect(set.status).toBe(200)
		const body = (await set.json()) as Details
		expect(body).toMatchObject({ error: '', success: true })
		expect(body.value.Club.MainImageName).toBe('2026-07-12/club.jpg')

		// It sticks, and the GET reflects it.
		const reread = await exports.default.fetch(`${ORIGIN}/club/${clubId}/mainimage`)
		expect(((await reread.json()) as Details).value.Club.MainImageName).toBe('2026-07-12/club.jpg')

		// imageName is required; non-co-owners can't set it; signed out is a 401.
		expect((await put('')).status).toBe(400)
		expect((await put('imageName=x.jpg', '7001')).status).toBe(403)
		const anon = await exports.default.fetch(`${ORIGIN}/club/${clubId}/mainimage`, {
			method: 'PUT',
			headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
			body: 'imageName=x.jpg',
		})
		expect(anon.status).toBe(401)

		// An unknown club 404s on both verbs.
		expect((await exports.default.fetch(`${ORIGIN}/club/99999/mainimage`)).status).toBe(404)
	})

	test('GET /club/:id/members filters by membershipType and sorts', async () => {
		type Member = {
			ClubMemberId: number
			ClubId: number
			AccountId: number
			MembershipType: number
		}
		type Body = { error: string; success: boolean; value: Member[] }

		const create = await exports.default.fetch(`${ORIGIN}/club/create`, {
			method: 'POST',
			headers: { ...(await bearer('8000')), 'Content-Type': 'application/x-www-form-urlencoded' },
			body: 'name=Crowded',
		})
		const clubId = ((await create.json()) as { value: { ClubId: number } }).value.ClubId

		// 8002 then 8001 join as plain members (Member = 10); 8000 is the Creator (100).
		for (const sub of ['8002', '8001']) {
			await exports.default.fetch(`${ORIGIN}/club/${clubId}/join`, {
				method: 'POST',
				headers: await bearer(sub),
			})
		}
		const members = async (query = ''): Promise<Body> => {
			const res = await exports.default.fetch(`${ORIGIN}/club/${clubId}/members${query}`)
			expect(res.status).toBe(200)
			return (await res.json()) as Body
		}

		// Default order: highest tier first, then oldest membership.
		const all = await members()
		expect(all).toMatchObject({ error: '', success: true })
		expect(all.value.map((m) => m.AccountId)).toEqual([8000, 8002, 8001])
		expect(all.value[0]).toMatchObject({ ClubId: clubId, MembershipType: 100 })

		// sortBy=1 orders by account id; sortBy=2 by join time.
		expect((await members('?sortBy=1')).value.map((m) => m.AccountId)).toEqual([8000, 8001, 8002])
		expect((await members('?sortBy=2')).value.map((m) => m.AccountId)).toEqual([8000, 8002, 8001])

		// membershipType is an exact match, not a threshold.
		expect((await members('?membershipType=10')).value.map((m) => m.AccountId)).toEqual([
			8002, 8001,
		])
		expect((await members('?membershipType=100')).value.map((m) => m.AccountId)).toEqual([8000])
		// The client's request: co-owners only — nobody holds that tier here.
		expect((await members('?membershipType=30&sortBy=0')).value).toEqual([])

		// An unknown club is an empty list, not a 404.
		const ghost = await exports.default.fetch(`${ORIGIN}/club/99999/members`)
		expect(ghost.status).toBe(200)
		expect(((await ghost.json()) as Body).value).toEqual([])
	})

	test('GET /club/:id/hasDisabledClubChat reports chat enabled', async () => {
		// Nothing can disable club chat yet → always false, for any club.
		const res = await exports.default.fetch(`${ORIGIN}/club/1/hasDisabledClubChat`)
		expect(res.status).toBe(200)
		expect(await res.json()).toBe(false)
	})

	test('PUT /club/home/me sets the home club; GET serves it once it has a clubhouse', async () => {
		type Club = { ClubId: number; ClubhouseRoomId: number | null }
		const form = async (path: string, method: string, body: string, sub: string) =>
			exports.default.fetch(`${ORIGIN}${path}`, {
				method,
				headers: { ...(await bearer(sub)), 'Content-Type': 'application/x-www-form-urlencoded' },
				body,
			})

		const create = await exports.default.fetch(`${ORIGIN}/club/create`, {
			method: 'POST',
			headers: { ...(await bearer('9100')), 'Content-Type': 'application/x-www-form-urlencoded' },
			body: 'name=Homely',
		})
		const clubId = ((await create.json()) as { value: { ClubId: number } }).value.ClubId

		// No home club yet → 404.
		const before = await exports.default.fetch(`${ORIGIN}/club/home/me`, {
			headers: await bearer('9100'),
		})
		expect(before.status).toBe(404)

		// You must be a member of the club you're making your home.
		expect((await form('/club/home/me', 'PUT', `clubId=${clubId}`, '9101')).status).toBe(403)
		// A missing/zero clubId is a 400, an unknown club a 404.
		expect((await form('/club/home/me', 'PUT', 'clubId=0', '9100')).status).toBe(400)
		expect((await form('/club/home/me', 'PUT', 'clubId=99999', '9100')).status).toBe(404)

		const set = await form('/club/home/me', 'PUT', `clubId=${clubId}`, '9100')
		expect(set.status).toBe(200)
		expect(await set.json()).toMatchObject({ error: '', success: true })

		// The club has no clubhouse room yet, so there's still nowhere to spawn → 404.
		const noClubhouse = await exports.default.fetch(`${ORIGIN}/club/home/me`, {
			headers: await bearer('9100'),
		})
		expect(noClubhouse.status).toBe(404)

		// Give it a clubhouse → the home club now resolves.
		const clubhouse = await form(`/club/${clubId}/clubhouse`, 'PUT', 'roomId=77', '9100')
		expect(clubhouse.status).toBe(200)
		// The details envelope carries the new room back — the client re-renders from it.
		const setRoom = (await clubhouse.json()) as {
			error: string
			success: boolean
			value: { Club: { ClubhouseRoomId: number | null } }
		}
		expect(setRoom).toMatchObject({ error: '', success: true })
		expect(setRoom.value.Club.ClubhouseRoomId).toBe(77)

		const home = await exports.default.fetch(`${ORIGIN}/club/home/me`, {
			headers: await bearer('9100'),
		})
		expect((await home.json()) as Club).toMatchObject({ ClubId: clubId, ClubhouseRoomId: 77 })

		// Clearing the clubhouse takes the home club away again — and reports the cleared
		// room, so the client doesn't keep showing the old one.
		const clear = (await (await form(`/club/${clubId}/clubhouse`, 'PUT', '', '9100')).json()) as {
			value: { Club: { ClubhouseRoomId: number | null } }
		}
		expect(clear.value.Club.ClubhouseRoomId).toBeNull()
		const cleared = await exports.default.fetch(`${ORIGIN}/club/home/me`, {
			headers: await bearer('9100'),
		})
		expect(cleared.status).toBe(404)

		// DELETE clears it too, ignoring any body it's sent.
		await form(`/club/${clubId}/clubhouse`, 'PUT', 'roomId=88', '9100')
		const deleted = (await (
			await form(`/club/${clubId}/clubhouse`, 'DELETE', 'roomId=99', '9100')
		).json()) as { success: boolean; value: { Club: { ClubhouseRoomId: number | null } } }
		expect(deleted.success).toBe(true)
		expect(deleted.value.Club.ClubhouseRoomId).toBeNull()

		// DELETE /club/home/me drops the home club without touching the membership, and
		// is idempotent when there's none set.
		await form(`/club/${clubId}/clubhouse`, 'PUT', 'roomId=77', '9100')
		await form('/club/home/me', 'PUT', `clubId=${clubId}`, '9100')
		const dropped = await exports.default.fetch(`${ORIGIN}/club/home/me`, {
			method: 'DELETE',
			headers: await bearer('9100'),
		})
		expect(dropped.status).toBe(200)
		expect(await dropped.json()).toEqual({ error: '', success: true, value: null })
		expect(
			(await exports.default.fetch(`${ORIGIN}/club/home/me`, { headers: await bearer('9100') }))
				.status
		).toBe(404)
		// Still a member of the club they'd made their home.
		const mine = (await (
			await exports.default.fetch(`${ORIGIN}/club/mine/member`, { headers: await bearer('9100') })
		).json()) as Club[]
		expect(mine.map((c) => c.ClubId)).toContain(clubId)
		// Clearing again, and clearing when nothing was set, both succeed.
		for (const sub of ['9100', '9101']) {
			const again = await exports.default.fetch(`${ORIGIN}/club/home/me`, {
				method: 'DELETE',
				headers: await bearer(sub),
			})
			expect(again.status).toBe(200)
		}
		expect(
			(await exports.default.fetch(`${ORIGIN}/club/home/me`, { method: 'DELETE' })).status
		).toBe(401)

		// Only co-owners may set or clear the clubhouse; signed out is a 401 on both.
		expect((await form(`/club/${clubId}/clubhouse`, 'PUT', 'roomId=1', '9101')).status).toBe(403)
		expect((await form(`/club/${clubId}/clubhouse`, 'DELETE', '', '9101')).status).toBe(403)
		expect(
			(await exports.default.fetch(`${ORIGIN}/club/${clubId}/clubhouse`, { method: 'DELETE' }))
				.status
		).toBe(401)
		const anon = await exports.default.fetch(`${ORIGIN}/club/home/me`, { method: 'PUT' })
		expect(anon.status).toBe(401)
	})

	test('PUT /club/:id/additionalimage/:index fills the club’s gallery slots', async () => {
		type Image = { Id: number; ImageName: string; PlayerId: number }
		type Details = { error: string; success: boolean; value: { AdditionalImages: Image[] } }
		// The gallery is served as whole image records, joined from the image table the
		// `api` worker writes on upload. Seed the rows those names point at.
		const first = 'sharecamera/2026-07-21/e37fc41f-005e-4216-8f1e-a37dca953981.jpg'
		const insertImage = env.DB.prepare('INSERT OR IGNORE INTO image (data) VALUES (?1)')
		await env.DB.batch(
			[first, 'b.jpg', 'c.jpg'].map((ImageName, i) =>
				insertImage.bind(
					JSON.stringify({
						Id: 500 + i,
						Type: 1,
						Accessibility: 1,
						AccessibilityLocked: false,
						ImageName,
						Description: null,
						PlayerId: 7100,
						TaggedPlayerIds: [],
						RoomId: null,
						PlayerEventId: null,
						CreatedAt: '2026-07-21T00:00:00Z',
						CheerCount: 0,
						CommentCount: 0,
					})
				)
			)
		)
		const create = await exports.default.fetch(`${ORIGIN}/club/create`, {
			method: 'POST',
			headers: { ...(await bearer('7100')), 'Content-Type': 'application/x-www-form-urlencoded' },
			body: 'name=Gallery',
		})
		const clubId = ((await create.json()) as { value: { ClubId: number } }).value.ClubId
		const setImage = async (index: number, imageName: string, sub = '7100') =>
			exports.default.fetch(`${ORIGIN}/club/${clubId}/additionalimage/${index}`, {
				method: 'PUT',
				headers: { ...(await bearer(sub)), 'Content-Type': 'application/x-www-form-urlencoded' },
				body: new URLSearchParams({ imageName }).toString(),
			})

		const names = (images: Image[]) => images.map((i) => i.ImageName)

		// A fresh club has no gallery images.
		const fresh = (await (
			await exports.default.fetch(`${ORIGIN}/club/${clubId}/details`)
		).json()) as { AdditionalImages: Image[] }
		expect(fresh.AdditionalImages).toEqual([])

		// The client's exact request: the storage worker's image name into slot 0. It
		// comes back as the whole image record, not a bare name.
		const set = (await (await setImage(0, first)).json()) as Details
		expect(set).toMatchObject({ error: '', success: true })
		expect(set.value.AdditionalImages).toEqual([
			expect.objectContaining({ Id: 500, ImageName: first, PlayerId: 7100 }),
		])

		// The list stays packed: a PUT past the end appends rather than leaving a gap.
		const third = (await (await setImage(2, 'c.jpg')).json()) as Details
		expect(names(third.value.AdditionalImages)).toEqual([first, 'c.jpg'])
		const second = (await (await setImage(2, 'b.jpg')).json()) as Details
		expect(names(second.value.AdditionalImages)).toEqual([first, 'c.jpg', 'b.jpg'])

		// Re-PUTting a position replaces just that image. A name with no image row still
		// renders, as a placeholder record.
		const replaced = (await (await setImage(0, 'a2.jpg')).json()) as Details
		expect(names(replaced.value.AdditionalImages)).toEqual(['a2.jpg', 'c.jpg', 'b.jpg'])
		expect(replaced.value.AdditionalImages[0]).toMatchObject({ Id: 0, ImageName: 'a2.jpg' })

		// An empty name removes that image and shifts the rest up — no blank left behind.
		const cleared = (await (await setImage(1, '')).json()) as Details
		expect(names(cleared.value.AdditionalImages)).toEqual(['a2.jpg', 'b.jpg'])

		// They're on the club's details payload, for everyone reading the club.
		const details = (await (
			await exports.default.fetch(`${ORIGIN}/club/${clubId}/details`)
		).json()) as { AdditionalImages: Image[] }
		expect(names(details.AdditionalImages)).toEqual(['a2.jpg', 'b.jpg'])

		// DELETE removes that position's image and shifts the rest up, ignoring any body.
		// Deleting a position that holds nothing is a no-op.
		const deleteImage = async (index: number, sub = '7100', body?: string) =>
			exports.default.fetch(`${ORIGIN}/club/${clubId}/additionalimage/${index}`, {
				method: 'DELETE',
				headers: { ...(await bearer(sub)), 'Content-Type': 'application/x-www-form-urlencoded' },
				body,
			})
		const dropped = (await (await deleteImage(0, '7100', 'imageName=sneaky.jpg')).json()) as Details
		expect(dropped).toMatchObject({ error: '', success: true })
		expect(names(dropped.value.AdditionalImages)).toEqual(['b.jpg'])
		// Position 1 holds nothing now, so deleting it changes nothing.
		expect(
			names(((await (await deleteImage(1)).json()) as Details).value.AdditionalImages)
		).toEqual(['b.jpg'])
		// A PUT past the end appends, so the club is back to two images.
		const refilled = (await (await setImage(1, 'a3.jpg')).json()) as Details
		expect(names(refilled.value.AdditionalImages)).toEqual(['b.jpg', 'a3.jpg'])

		// Same gate as the PUT.
		expect((await deleteImage(0, '7101')).status).toBe(403)
		expect(
			(
				await exports.default.fetch(`${ORIGIN}/club/${clubId}/additionalimage/0`, {
					method: 'DELETE',
				})
			).status
		).toBe(401)
		expect((await deleteImage(3)).status).toBe(400)

		// There are only three slots, and only co-owners may set them.
		expect((await setImage(3, 'd.jpg')).status).toBe(400)
		expect((await setImage(0, 'hijack.jpg', '7101')).status).toBe(403)
		expect(
			(
				await exports.default.fetch(`${ORIGIN}/club/${clubId}/additionalimage/0`, {
					method: 'PUT',
				})
			).status
		).toBe(401)
		expect(
			(
				await exports.default.fetch(`${ORIGIN}/club/99999/additionalimage/0`, {
					method: 'PUT',
					headers: await bearer('7100'),
				})
			).status
		).toBe(404)
	})

	test('POST /club/create enforces the per-account club cap', async () => {
		const create = async (name: string) =>
			exports.default.fetch(`${ORIGIN}/club/create`, {
				method: 'POST',
				headers: { ...(await bearer('7200')), 'Content-Type': 'application/x-www-form-urlencoded' },
				body: new URLSearchParams({ name }).toString(),
			})

		// The cap an operator actually runs is the `MAX_CLUBS_PER_ACCOUNT` var; the
		// constant in the worker is only the fallback.
		const original = env.MAX_CLUBS_PER_ACCOUNT
		try {
			env.MAX_CLUBS_PER_ACCOUNT = 2
			expect((await create('CapOne')).status).toBe(200)
			expect((await create('CapTwo')).status).toBe(200)

			const rejected = await create('CapThree')
			expect(rejected.status).toBe(400)
			const body = (await rejected.json()) as { error: string; success: boolean }
			expect(body.success).toBe(false)
			expect(body.error).toMatch(/only have 2 clubs/i)

			// A subscription club doesn't count against the cap — it isn't made by hand.
			await env.DB.prepare('INSERT INTO club (data) VALUES (?1)')
				.bind(
					JSON.stringify({
						ClubId: 9500,
						Name: 'Subs7200',
						ClubType: 1,
						CreatorAccountId: 7200,
						CreatedAt: '2026-07-01T00:00:00Z',
					})
				)
				.run()
			env.MAX_CLUBS_PER_ACCOUNT = 3
			expect((await create('CapThreeReal')).status).toBe(200)

			// 0 lifts the cap entirely.
			env.MAX_CLUBS_PER_ACCOUNT = 0
			expect((await create('Uncapped')).status).toBe(200)
		} finally {
			env.MAX_CLUBS_PER_ACCOUNT = original
		}
	})

	test('GET /club/search filters by category/query and sorts', async () => {
		type Result = {
			Clubs: Array<{ ClubId: number; Name: string; Category: string }>
			ContinuationToken: null
			TotalClubs: number
		}
		const create = async (fields: Record<string, string>, sub: string): Promise<number> => {
			const res = await exports.default.fetch(`${ORIGIN}/club/create`, {
				method: 'POST',
				headers: { ...(await bearer(sub)), 'Content-Type': 'application/x-www-form-urlencoded' },
				body: new URLSearchParams(fields).toString(),
			})
			return ((await res.json()) as { value: { ClubId: number } }).value.ClubId
		}
		const search = async (query: string): Promise<Result> => {
			const res = await exports.default.fetch(`${ORIGIN}/club/search?${query}`)
			expect(res.status).toBe(200)
			return (await res.json()) as Result
		}

		// Own category, so clubs the other tests created (which default to Social) don't
		// wander into these assertions. The second club gains a member, so it outranks
		// the first on the default sort.
		const alpha = await create({ name: 'Chess Fans', category: 'Boardgames' }, '9200')
		const beta = await create(
			{ name: 'Board Gamers', description: 'we love chess', category: 'Boardgames' },
			'9201'
		)
		await create({ name: 'Painters', category: 'Creative' }, '9202')
		await exports.default.fetch(`${ORIGIN}/club/${beta}/join`, {
			method: 'POST',
			headers: await bearer('9203'),
		})

		// Default sort → most members first. Category filters out the Creative club.
		const listed = await search('sort=0&category=Boardgames&count=32')
		expect(listed.ContinuationToken).toBeNull()
		expect(listed.Clubs.map((c) => c.ClubId)).toEqual([beta, alpha])
		expect(listed.TotalClubs).toBe(2)
		expect(listed.Clubs.every((c) => c.Category === 'Boardgames')).toBe(true)

		// sort=2 orders by name.
		expect((await search('sort=2&category=Boardgames')).Clubs.map((c) => c.Name)).toEqual([
			'Board Gamers',
			'Chess Fans',
		])

		// `query` matches the name or the description.
		const chess = await search('query=chess&category=Boardgames')
		expect(chess.Clubs.map((c) => c.ClubId).sort()).toEqual([alpha, beta].sort())
		expect((await search('query=nomatch')).Clubs).toEqual([])

		// `count` caps the page, but TotalClubs reports the full match count.
		const capped = await search('category=Boardgames&count=1')
		expect(capped.Clubs).toHaveLength(1)
		expect(capped.TotalClubs).toBe(2)

		// Private clubs never show up in search.
		await exports.default.fetch(`${ORIGIN}/club/${alpha}/modifydetails`, {
			method: 'PUT',
			headers: { ...(await bearer('9200')), 'Content-Type': 'application/x-www-form-urlencoded' },
			body: 'visibility=Private',
		})
		expect((await search('category=Boardgames')).Clubs.map((c) => c.ClubId)).toEqual([beta])

		// The client's own request shape still answers cleanly.
		const clientRequest = await search('sort=0&category=Social&count=32')
		expect(clientRequest.ContinuationToken).toBeNull()
		expect(clientRequest.TotalClubs).toBeGreaterThanOrEqual(clientRequest.Clubs.length)
		expect(clientRequest.Clubs.every((c) => c.Category === 'Social')).toBe(true)
	})

	test('GET /club/:id/details serves the bare details object', async () => {
		type Details = {
			Club: { ClubId: number; Name: string }
			ClubId: number
			CustomTags: string[]
			AdditionalImages: unknown[]
			MyMembershipType: number
			CoownerPermissions: { Type: number }
			ModeratorPermissions: { Type: number }
			MemberPermissions: { Type: number }
		}
		const create = await exports.default.fetch(`${ORIGIN}/club/create`, {
			method: 'POST',
			headers: { ...(await bearer('9300')), 'Content-Type': 'application/x-www-form-urlencoded' },
			body: 'name=Detailed',
		})
		const clubId = ((await create.json()) as { value: { ClubId: number } }).value.ClubId
		await exports.default.fetch(`${ORIGIN}/club/${clubId}/modifydetails`, {
			method: 'PUT',
			headers: { ...(await bearer('9300')), 'Content-Type': 'application/x-www-form-urlencoded' },
			body: 'customTags=tagged',
		})

		// Not enveloped — the details object is the whole body.
		const res = await exports.default.fetch(`${ORIGIN}/club/${clubId}/details`, {
			headers: await bearer('9300'),
		})
		expect(res.status).toBe(200)
		const body = (await res.json()) as Details & { success?: boolean; value?: unknown }
		expect(body.success).toBeUndefined()
		expect(body.value).toBeUndefined()
		expect(body.Club).toMatchObject({ ClubId: clubId, Name: 'Detailed' })
		expect(body.ClubId).toBe(clubId)
		expect(body.CustomTags).toEqual(['tagged'])
		expect(body.AdditionalImages).toEqual([])
		expect(body.MyMembershipType).toBe(100) // the creator
		expect(body.CoownerPermissions.Type).toBe(30)
		expect(body.ModeratorPermissions.Type).toBe(20)
		expect(body.MemberPermissions.Type).toBe(10)

		// Public: a signed-out viewer sees the club with no membership of their own.
		const anon = await exports.default.fetch(`${ORIGIN}/club/${clubId}/details`)
		expect(((await anon.json()) as Details).MyMembershipType).toBe(0)

		// An unknown club 404s.
		expect((await exports.default.fetch(`${ORIGIN}/club/99999/details`)).status).toBe(404)
	})

	test('GET/POST /announcements/club/:id serves and posts the noticeboard', async () => {
		type Announcement = {
			AnnouncementId: number
			Title: string
			Body: string
			AccountId: number
			ImageName: string
			Meta: string
		}
		type Board = {
			error: string
			success: boolean
			value: {
				Announcements: Announcement[]
				ClubId: number
				LastAnnouncementId: number | null
				LastReadAnnouncementId: number
			}
		}
		const create = await exports.default.fetch(`${ORIGIN}/club/create`, {
			method: 'POST',
			headers: { ...(await bearer('9400')), 'Content-Type': 'application/x-www-form-urlencoded' },
			body: 'name=Newsy',
		})
		const clubId = ((await create.json()) as { value: { ClubId: number } }).value.ClubId
		const board = async (): Promise<Board> => {
			const res = await exports.default.fetch(`${ORIGIN}/announcements/club/${clubId}`)
			expect(res.status).toBe(200)
			return (await res.json()) as Board
		}
		const post = async (body: string, sub = '9400'): Promise<Response> =>
			exports.default.fetch(`${ORIGIN}/announcements/club/${clubId}`, {
				method: 'POST',
				headers: { ...(await bearer(sub)), 'Content-Type': 'application/x-www-form-urlencoded' },
				body,
			})

		// An empty board: no announcements, and no "last" one.
		const empty = await board()
		expect(empty).toMatchObject({ error: '', success: true })
		expect(empty.value).toMatchObject({
			Announcements: [],
			ClubId: clubId,
			LastAnnouncementId: null,
			LastReadAnnouncementId: 0,
		})

		// Posting returns the new announcement's id in the envelope.
		const first = await post('title=Hello&body=First+post')
		expect(first.status).toBe(200)
		const firstId = ((await first.json()) as { value: number }).value
		expect(firstId).toBeGreaterThan(0)
		const secondId = ((await (await post('title=Again&body=Second')).json()) as { value: number })
			.value

		// Newest first, and LastAnnouncementId points at it.
		const posted = await board()
		expect(posted.value.Announcements.map((a) => a.AnnouncementId)).toEqual([secondId, firstId])
		expect(posted.value.LastAnnouncementId).toBe(secondId)
		expect(posted.value.Announcements[0]).toMatchObject({
			Title: 'Again',
			Body: 'Second',
			AccountId: 9400,
		})

		// The client's exact post: an image name plus a `meta` JSON string, which is
		// stored verbatim (it's an opaque blob to us, not something we re-serialize).
		const real = await post(
			'title=wooo&body=test&imageName=DefaultClubImage2k.jpg&meta=%7B%22Type%22%3A0%2C%22JsonData%22%3A%22%22%7D'
		)
		expect(real.status).toBe(200)
		const realId = ((await real.json()) as { value: number }).value
		const withMeta = (await board()).value.Announcements.find((a) => a.AnnouncementId === realId)
		expect(withMeta).toMatchObject({
			Title: 'wooo',
			Body: 'test',
			ImageName: 'DefaultClubImage2k.jpg',
			Meta: '{"Type":0,"JsonData":""}',
		})

		// Only co-owners may post; signed out is a 401; an unknown club 404s.
		expect((await post('title=Nope', '9401')).status).toBe(403)
		const anon = await exports.default.fetch(`${ORIGIN}/announcements/club/${clubId}`, {
			method: 'POST',
			headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
			body: 'title=Nope',
		})
		expect(anon.status).toBe(401)
		const missing = await exports.default.fetch(`${ORIGIN}/announcements/club/99999`, {
			method: 'POST',
			headers: { ...(await bearer('9400')), 'Content-Type': 'application/x-www-form-urlencoded' },
			body: 'title=Ghost',
		})
		expect(missing.status).toBe(404)
	})

	test('PUT /club/:id/minlevel sets the join level, co-owner only', async () => {
		type Details = { error: string; success: boolean; value: { Club: { MinLevel: number } } }
		const create = await exports.default.fetch(`${ORIGIN}/club/create`, {
			method: 'POST',
			headers: { ...(await bearer('9500')), 'Content-Type': 'application/x-www-form-urlencoded' },
			body: 'name=Gated',
		})
		const clubId = ((await create.json()) as { value: { ClubId: number } }).value.ClubId
		const put = async (body: string, sub = '9500'): Promise<Response> =>
			exports.default.fetch(`${ORIGIN}/club/${clubId}/minlevel`, {
				method: 'PUT',
				headers: { ...(await bearer(sub)), 'Content-Type': 'application/x-www-form-urlencoded' },
				body,
			})

		const res = await put('minLevel=5')
		expect(res.status).toBe(200)
		const body = (await res.json()) as Details
		expect(body).toMatchObject({ error: '', success: true })
		expect(body.value.Club.MinLevel).toBe(5)

		// It sticks on the club.
		const details = await exports.default.fetch(`${ORIGIN}/club/${clubId}/details`)
		expect(((await details.json()) as { Club: { MinLevel: number } }).Club.MinLevel).toBe(5)

		// Zero is valid (no level requirement); garbage and negatives are not.
		expect((await put('minLevel=0')).status).toBe(200)
		expect((await put('minLevel=abc')).status).toBe(400)
		expect((await put('minLevel=-1')).status).toBe(400)

		// Non-co-owners can't; signed out is a 401; an unknown club 404s.
		expect((await put('minLevel=5', '9501')).status).toBe(403)
		const anon = await exports.default.fetch(`${ORIGIN}/club/${clubId}/minlevel`, {
			method: 'PUT',
			headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
			body: 'minLevel=5',
		})
		expect(anon.status).toBe(401)
		const missing = await exports.default.fetch(`${ORIGIN}/club/99999/minlevel`, {
			method: 'PUT',
			headers: { ...(await bearer('9500')), 'Content-Type': 'application/x-www-form-urlencoded' },
			body: 'minLevel=5',
		})
		expect(missing.status).toBe(404)
	})

	test('unknown routes 404', async () => {
		const res = await exports.default.fetch(`${ORIGIN}/nope`)
		expect(res.status).toBe(404)
	})

	// Full club lifecycle: create → get → other player joins/leaves, with the
	// creator auto-membership and MemberCount upkeep, plus the mine/* lists.
	test('create → get → join → leave a club, with MemberCount and my-clubs lists', async () => {
		type Club = {
			ClubId: number
			Name: string
			Category: string
			Visibility: number
			AllowJuniors: boolean
			MainImageName: string
			CreatorAccountId: number
			MemberCount: number
		}
		const post = async (path: string, sub: string | null, fields: Record<string, string> = {}) =>
			exports.default.fetch(`${ORIGIN}${path}`, {
				method: 'POST',
				headers: {
					...(sub ? await bearer(sub) : {}),
					'Content-Type': 'application/x-www-form-urlencoded',
				},
				body: new URLSearchParams(fields).toString(),
			})

		// Create requires auth.
		expect((await post('/club/create', null, { name: 'Nope' })).status).toBe(401)
		// Create requires a name.
		expect((await post('/club/create', '800', { name: '  ' })).status).toBe(400)

		// 800 creates a club → defaults applied, creator auto-joined (MemberCount 1).
		const createRes = (await (
			await post('/club/create', '800', { name: 'Speedrunners', category: 'Competitive' })
		).json()) as {
			error: string
			success: boolean
			value: { Club: Club; MyMembershipType: number }
		}
		expect(createRes).toMatchObject({ error: '', success: true })
		const created = createRes.value.Club
		expect(created).toMatchObject({
			Name: 'Speedrunners',
			Category: 'Competitive',
			Visibility: 1, // default
			AllowJuniors: true, // default
			MainImageName: 'DefaultImgPurple', // default
			CreatorAccountId: 800,
			MemberCount: 1,
		})
		// The creator's own membership comes back on the details.
		expect(createRes.value.MyMembershipType).toBe(100)
		const clubId = created.ClubId

		// Public get by id returns it; unknown id 404s.
		const fetched = (await (await exports.default.fetch(`${ORIGIN}/club/${clubId}`)).json()) as Club
		expect(fetched.ClubId).toBe(clubId)
		expect((await exports.default.fetch(`${ORIGIN}/club/99999`)).status).toBe(404)

		// It shows in the creator's created + member lists.
		const created800 = (await (
			await exports.default.fetch(`${ORIGIN}/club/mine/created`, { headers: await bearer('800') })
		).json()) as Club[]
		expect(created800.map((c) => c.ClubId)).toContain(clubId)

		// 801 joins → MemberCount 2, and the club appears in 801's member list (not created).
		const joined = (await (await post(`/club/${clubId}/join`, '801')).json()) as Club
		expect(joined.MemberCount).toBe(2)
		const member801 = (await (
			await exports.default.fetch(`${ORIGIN}/club/mine/member`, { headers: await bearer('801') })
		).json()) as Club[]
		expect(member801.map((c) => c.ClubId)).toContain(clubId)
		const createdBy801 = (await (
			await exports.default.fetch(`${ORIGIN}/club/mine/created`, { headers: await bearer('801') })
		).json()) as Club[]
		expect(createdBy801).toEqual([])

		// Joining again is idempotent (still 2).
		expect(((await (await post(`/club/${clubId}/join`, '801')).json()) as Club).MemberCount).toBe(2)

		// 801 leaves → back to 1, and it drops out of their member list.
		expect(((await (await post(`/club/${clubId}/leave`, '801')).json()) as Club).MemberCount).toBe(
			1
		)
		const afterLeave = (await (
			await exports.default.fetch(`${ORIGIN}/club/mine/member`, { headers: await bearer('801') })
		).json()) as Club[]
		expect(afterLeave.map((c) => c.ClubId)).not.toContain(clubId)

		// Join/leave on a missing club 404s.
		expect((await post('/club/99999/join', '801')).status).toBe(404)
	})

	test('joining a non-open club records a pending request, not a membership', async () => {
		const post = async (path: string, sub: string, fields: Record<string, string> = {}) =>
			exports.default.fetch(`${ORIGIN}${path}`, {
				method: 'POST',
				headers: { ...(await bearer(sub)), 'Content-Type': 'application/x-www-form-urlencoded' },
				body: new URLSearchParams(fields).toString(),
			})
		type Club = { ClubId: number; Joinability: number; MemberCount: number }

		// 810 creates an ask-to-join club (Joinability 2) → only the creator counts.
		const club = (
			(await (
				await post('/club/create', '810', { name: 'Inner Circle', joinability: '2' })
			).json()) as { value: { Club: Club } }
		).value.Club
		expect(club).toMatchObject({ Joinability: 2, MemberCount: 1 })

		// 811 asks to join → pending, so MemberCount is unchanged and it isn't a membership.
		const joined = (await (await post(`/club/${club.ClubId}/join`, '811')).json()) as Club
		expect(joined.MemberCount).toBe(1)
		const member811 = (await (
			await exports.default.fetch(`${ORIGIN}/club/mine/member`, { headers: await bearer('811') })
		).json()) as Club[]
		expect(member811.map((c) => c.ClubId)).not.toContain(club.ClubId)
	})

	test('requesttojoin follows the club joinability', async () => {
		const create = async (sub: string, fields: Record<string, string>) =>
			(
				(await (
					await exports.default.fetch(`${ORIGIN}/club/create`, {
						method: 'POST',
						headers: {
							...(await bearer(sub)),
							'Content-Type': 'application/x-www-form-urlencoded',
						},
						body: new URLSearchParams(fields).toString(),
					})
				).json()) as { value: { Club: { ClubId: number } } }
			).value.Club.ClubId
		const request = async (clubId: number, sub: string) =>
			exports.default.fetch(`${ORIGIN}/club/${clubId}/members/requesttojoin`, {
				method: 'PUT',
				headers: await bearer(sub),
			})
		type Details = { error: string; success: boolean; value: { MyMembershipType: number } | null }

		const open = await create('820', { name: 'Open Doors', joinability: 'Open' })
		const ask = await create('821', { name: 'Ask First', joinability: 'AskToJoin' })
		const invite = await create('822', { name: 'Invite Only', joinability: 'InviteOnly' })

		// Open → straight in as a Member (10).
		const joined = (await (await request(open, '830')).json()) as Details
		expect(joined).toMatchObject({ success: true })
		expect(joined.value?.MyMembershipType).toBe(10)

		// AskToJoin → PendingRequested (1), and a repeat request leaves it there.
		const asked = (await (await request(ask, '830')).json()) as Details
		expect(asked.value?.MyMembershipType).toBe(1)
		expect(
			(((await (await request(ask, '830')).json()) as Details).value ?? {}).MyMembershipType
		).toBe(1)

		// InviteOnly → refused, with no membership row created.
		const refused = await request(invite, '830')
		expect(refused.status).toBe(400)
		expect(((await refused.json()) as Details).success).toBe(false)

		// No token, and an unknown club.
		expect(
			(
				await exports.default.fetch(`${ORIGIN}/club/${open}/members/requesttojoin`, {
					method: 'PUT',
				})
			).status
		).toBe(401)
		expect((await request(99999, '830')).status).toBe(404)
	})

	test('PUT /club/:id/members/invite adds and promotes members, co-owner only', async () => {
		type Member = { AccountId: number; MembershipType: number }
		type Details = {
			error: string
			success: boolean
			value: { Club: { MemberCount: number } } | null
		}
		const create = await exports.default.fetch(`${ORIGIN}/club/create`, {
			method: 'POST',
			headers: { ...(await bearer('870')), 'Content-Type': 'application/x-www-form-urlencoded' },
			body: 'name=Invitational',
		})
		const clubId = ((await create.json()) as { value: { ClubId: number } }).value.ClubId

		const invite = async (fields: Record<string, string>, sub = '870'): Promise<Response> =>
			exports.default.fetch(`${ORIGIN}/club/${clubId}/members/invite`, {
				method: 'PUT',
				headers: { ...(await bearer(sub)), 'Content-Type': 'application/x-www-form-urlencoded' },
				body: new URLSearchParams(fields).toString(),
			})
		const tiers = async (): Promise<Map<number, number>> => {
			const res = await exports.default.fetch(`${ORIGIN}/club/${clubId}/members`)
			const body = (await res.json()) as { value: Member[] }
			return new Map(body.value.map((m) => [m.AccountId, m.MembershipType]))
		}

		// The client's exact request: add account 872 as a Member (10).
		const added = await invite({ accountId: '872', membershipType: '10' })
		expect(added.status).toBe(200)
		const addedBody = (await added.json()) as Details
		expect(addedBody).toMatchObject({ error: '', success: true })
		expect(addedBody.value?.Club.MemberCount).toBe(2) // creator + 872
		expect((await tiers()).get(872)).toBe(10)

		// Inviting an existing member at a higher tier promotes them in place.
		expect((await invite({ accountId: '872', membershipType: '20' })).status).toBe(200)
		expect((await tiers()).get(872)).toBe(20)

		// membershipType defaults to Member when omitted.
		await invite({ accountId: '873' })
		expect((await tiers()).get(873)).toBe(10)

		// Can't mint another creator, can't touch the creator, needs a valid accountId — and
		// a rejected invite writes nothing.
		expect((await invite({ accountId: '874', membershipType: '100' })).status).toBe(400)
		expect((await invite({ accountId: '870', membershipType: '30' })).status).toBe(400)
		expect((await invite({ accountId: 'abc' })).status).toBe(400)
		expect((await tiers()).has(874)).toBe(false)

		// A non-co-owner can't invite (872 is a moderator now, still below co-owner); signed
		// out is a 401; an unknown club 404s.
		expect((await invite({ accountId: '875' }, '872')).status).toBe(403)
		const anon = await exports.default.fetch(`${ORIGIN}/club/${clubId}/members/invite`, {
			method: 'PUT',
			headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
			body: 'accountId=875',
		})
		expect(anon.status).toBe(401)
		const missing = await exports.default.fetch(`${ORIGIN}/club/99999/members/invite`, {
			method: 'PUT',
			headers: { ...(await bearer('870')), 'Content-Type': 'application/x-www-form-urlencoded' },
			body: 'accountId=875',
		})
		expect(missing.status).toBe(404)
	})

	test('members/leave drops a membership and withdraws a pending request', async () => {
		const create = async (sub: string, fields: Record<string, string>) =>
			(
				(await (
					await exports.default.fetch(`${ORIGIN}/club/create`, {
						method: 'POST',
						headers: {
							...(await bearer(sub)),
							'Content-Type': 'application/x-www-form-urlencoded',
						},
						body: new URLSearchParams(fields).toString(),
					})
				).json()) as { value: { Club: { ClubId: number } } }
			).value.Club.ClubId
		const call = async (clubId: number, sub: string, action: 'requesttojoin' | 'leave') =>
			exports.default.fetch(`${ORIGIN}/club/${clubId}/members/${action}`, {
				method: action === 'leave' ? 'POST' : 'PUT',
				headers: await bearer(sub),
			})
		type Details = {
			success: boolean
			value: { Club: { MemberCount: number }; MyMembershipType: number } | null
		}

		const open = await create('840', { name: 'Revolving', joinability: 'Open' })
		const ask = await create('841', { name: 'Waitlist', joinability: 'AskToJoin' })

		// A member leaves → membership 0, and the count drops back to the creator alone.
		await call(open, '850', 'requesttojoin')
		const left = (await (await call(open, '850', 'leave')).json()) as Details
		expect(left.success).toBe(true)
		expect(left.value?.MyMembershipType).toBe(0)
		expect(left.value?.Club.MemberCount).toBe(1)

		// Leaving again is a no-op, not an error.
		expect(
			(((await (await call(open, '850', 'leave')).json()) as Details).value ?? {}).MyMembershipType
		).toBe(0)

		// Leaving withdraws a pending request too.
		expect(
			(((await (await call(ask, '850', 'requesttojoin')).json()) as Details).value ?? {})
				.MyMembershipType
		).toBe(1)
		expect(
			(((await (await call(ask, '850', 'leave')).json()) as Details).value ?? {}).MyMembershipType
		).toBe(0)

		// The creator can't leave their own club — they'd leave it ownerless.
		for (const path of [`/club/${open}/members/leave`, `/club/${open}/leave`]) {
			const res = await exports.default.fetch(`${ORIGIN}${path}`, {
				method: 'POST',
				headers: await bearer('840'),
			})
			expect(res.status).toBe(403)
		}
		// ...and they're still the creator afterwards.
		const stillIn = (await (
			await exports.default.fetch(`${ORIGIN}/club/${open}/details`, {
				headers: await bearer('840'),
			})
		).json()) as { MyMembershipType: number }
		expect(stillIn.MyMembershipType).toBe(100)

		// No token, and an unknown club.
		expect(
			(await exports.default.fetch(`${ORIGIN}/club/${open}/members/leave`, { method: 'POST' }))
				.status
		).toBe(401)
		expect((await call(99999, '850', 'leave')).status).toBe(404)
	})

	test('DELETE /club/:id is the creator’s only, and takes the memberships with it', async () => {
		const create = async (sub: string, fields: Record<string, string>) =>
			(
				(await (
					await exports.default.fetch(`${ORIGIN}/club/create`, {
						method: 'POST',
						headers: {
							...(await bearer(sub)),
							'Content-Type': 'application/x-www-form-urlencoded',
						},
						body: new URLSearchParams(fields).toString(),
					})
				).json()) as { value: { Club: { ClubId: number } } }
			).value.Club.ClubId
		const del = async (clubId: number, sub?: string) =>
			exports.default.fetch(`${ORIGIN}/club/${clubId}`, {
				method: 'DELETE',
				...(sub === undefined ? {} : { headers: await bearer(sub) }),
			})

		const clubId = await create('860', { name: 'Doomed', joinability: 'Open' })
		await exports.default.fetch(`${ORIGIN}/club/${clubId}/members/requesttojoin`, {
			method: 'PUT',
			headers: await bearer('861'),
		})

		// Signed out, a plain member, and an unknown club.
		expect((await del(clubId)).status).toBe(401)
		expect((await del(clubId, '861')).status).toBe(403)
		expect((await del(99999, '860')).status).toBe(404)

		// The creator can. The club, and its members, are gone.
		const res = await del(clubId, '860')
		expect(res.status).toBe(200)
		expect(await res.json()).toEqual({ error: '', success: true, value: null })
		expect((await exports.default.fetch(`${ORIGIN}/club/${clubId}`)).status).toBe(404)
		expect(
			await (await exports.default.fetch(`${ORIGIN}/club/${clubId}/members`)).json()
		).toMatchObject({ value: [] })
		const member861 = (await (
			await exports.default.fetch(`${ORIGIN}/club/mine/member`, { headers: await bearer('861') })
		).json()) as Array<{ ClubId: number }>
		expect(member861.map((c) => c.ClubId)).not.toContain(clubId)

		// Deleting twice 404s rather than reporting success.
		expect((await del(clubId, '860')).status).toBe(404)
	})

	test('GET /openapi.json documents every route', async () => {
		const res = await exports.default.fetch(`${ORIGIN}/openapi.json`)
		expect(res.status).toBe(200)
		const spec = (await res.json()) as {
			openapi: string
			paths: Record<string, Record<string, { summary?: string }>>
		}
		expect(spec.openapi).toMatch(/^3\.1/)

		// The spec route hides itself.
		expect(spec.paths['/openapi.json']).toBeUndefined()

		// Every schema inlines: a `.meta({ id })` on any of them would emit a $ref this
		// setup doesn't always hoist into components.schemas, leaving it dangling.
		expect(JSON.stringify(spec).includes('"$ref"')).toBe(false)

		// Every route the worker serves is described. This is the drift guard: adding a
		// route without a describeRoute() block fails here rather than silently shipping
		// an incomplete spec. Hono's `:param` syntax (regex constraints and all) becomes
		// OpenAPI's `{param}`; the `.on([...])` clubhouse and additionalimage routes
		// contribute both their methods, and modifydetails/modify both their paths.
		const documented = new Set(
			Object.entries(spec.paths).flatMap(([path, ops]) =>
				Object.keys(ops).map((method) => `${method.toUpperCase()} ${path}`)
			)
		)
		expect([...documented].sort()).toEqual([
			'DELETE /club/home/me',
			'DELETE /club/{clubId}',
			'DELETE /club/{clubId}/additionalimage/{index}',
			'DELETE /club/{clubId}/clubhouse',
			'GET /announcements/club/{clubId}',
			'GET /announcements/v2/mine/unread',
			'GET /announcements/v2/subscription/mine/unread',
			'GET /club/categoryTags',
			'GET /club/home/me',
			'GET /club/mine/created',
			'GET /club/mine/member',
			'GET /club/search',
			'GET /club/{clubId}',
			'GET /club/{clubId}/details',
			'GET /club/{clubId}/hasDisabledClubChat',
			'GET /club/{clubId}/mainimage',
			'GET /club/{clubId}/members',
			'GET /subscription/details/{accountId}',
			'GET /subscription/details/{subscription}',
			'GET /subscription/mine/member',
			'GET /subscription/subscriberCount/{accountId}',
			'POST /announcements/club/{clubId}',
			'POST /club/create',
			'POST /club/{clubId}/join',
			'POST /club/{clubId}/leave',
			'POST /club/{clubId}/members/leave',
			'PUT /club/home/me',
			'PUT /club/{clubId}/additionalimage/{index}',
			'PUT /club/{clubId}/clubhouse',
			'PUT /club/{clubId}/mainimage',
			'PUT /club/{clubId}/members/invite',
			'PUT /club/{clubId}/members/requesttojoin',
			'PUT /club/{clubId}/minlevel',
			'PUT /club/{clubId}/modify',
			'PUT /club/{clubId}/modifydetails',
		])

		// Every operation carries a summary — a path present but undescribed is not
		// documentation.
		for (const ops of Object.values(spec.paths)) {
			for (const op of Object.values(ops)) expect(op.summary).toBeTruthy()
		}
	})
})
