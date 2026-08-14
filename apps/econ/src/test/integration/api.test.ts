import { adminSecretsStore, env } from 'cloudflare:test'
import { exports } from 'cloudflare:workers'
import { beforeAll, describe, expect, test } from 'vitest'

import '../../econ.app'

import {
	getOwnedInventionIds,
	getProgression,
	INVENTORY_INVENTION_SCHEMA_DDL,
	OUTFIT_SCHEMA_DDL,
	PROGRESSION_SCHEMA_DDL,
	RECEIVED_GIFT_SCHEMA_DDL,
} from '@repo/domain'

// The `invention` table belongs to the `api` worker; buyInvention reads it, so its DDL
// is built here too (see the same cross-worker import in econ.app.ts).
import { SCHEMA_DDL as INVENTION_SCHEMA_DDL } from '../../../../api/src/inventions-db'
// The notification-type ids the hub carries, from the worker that owns them — asserting
// against the enum rather than a copied number is what keeps these frames honest.
import { NotificationType } from '../../../../notify/src/notification-types'
// The live weekly rotation, so the challenge tests exercise whatever it currently holds
// instead of hard-coded ids from a rotation that has since been replaced.
import weeklyChallenge from '../../../static/weekly-challenge.json'
import { SCHEMA_DDL } from '../../avatar-db'
import {
	BALANCE_SCHEMA_DDL,
	CurrencyType,
	DEFAULT_STARTING_TOKENS,
	getBalance,
	spendCurrency,
} from '../../balance-db'
import { CHALLENGE_GIFT_SCHEMA_DDL, CHALLENGE_STATUS_SCHEMA_DDL } from '../../challenge-db'
import { CONSUMABLE_SCHEMA_DDL, grantConsumable } from '../../consumables-db'
import { EQUIPMENT_SCHEMA_DDL, grantEquipment } from '../../equipment-db'
import { INVENTORY_SCHEMA_DDL } from '../../inventory-db'
import { REWARD_STATUS_SCHEMA_DDL } from '../../reward-db'

import type { Env } from '../../context'

declare module 'cloudflare:test' {
	interface ProvidedEnv extends Env {}
}

const ORIGIN = 'https://example.com'

/** The first challenge of the live rotation — the progress tests report against it. */
const CURRENT_CHALLENGE = weeklyChallenge.Challenges[0]

// Build the accounts table and seed the test player (the default token's sub, 42)
// so avatar reads/writes have a row to attach to.
beforeAll(async () => {
	// Seed the shared JWT signing key into the local Secrets Store so .get() resolves.
	await adminSecretsStore(env.JWT_SECRET).create('test-signing-key')
	for (const stmt of SCHEMA_DDL) await env.DB.prepare(stmt).run()
	for (const stmt of BALANCE_SCHEMA_DDL) await env.DB.prepare(stmt).run()
	for (const stmt of OUTFIT_SCHEMA_DDL) await env.DB.prepare(stmt).run()
	for (const stmt of CHALLENGE_STATUS_SCHEMA_DDL) await env.DB.prepare(stmt).run()
	for (const stmt of CHALLENGE_GIFT_SCHEMA_DDL) await env.DB.prepare(stmt).run()
	for (const stmt of PROGRESSION_SCHEMA_DDL) await env.DB.prepare(stmt).run()
	for (const stmt of REWARD_STATUS_SCHEMA_DDL) await env.DB.prepare(stmt).run()
	for (const stmt of INVENTORY_SCHEMA_DDL) await env.DB.prepare(stmt).run()
	for (const stmt of CONSUMABLE_SCHEMA_DDL) await env.DB.prepare(stmt).run()
	for (const stmt of EQUIPMENT_SCHEMA_DDL) await env.DB.prepare(stmt).run()
	for (const stmt of RECEIVED_GIFT_SCHEMA_DDL) await env.DB.prepare(stmt).run()
	for (const stmt of INVENTORY_INVENTION_SCHEMA_DDL) await env.DB.prepare(stmt).run()
	for (const stmt of INVENTION_SCHEMA_DDL) await env.DB.prepare(stmt).run()
	await env.DB.prepare('INSERT OR IGNORE INTO account (data) VALUES (?1)')
		.bind(JSON.stringify({ accountId: 42, username: 'Tester', displayName: 'Tester' }))
		.run()
	for (const invention of SEEDED_INVENTIONS) {
		await env.DB.prepare('INSERT INTO invention (data) VALUES (?1)')
			.bind(JSON.stringify(invention))
			.run()
	}
})

/**
 * Inventions the buyInvention tests buy (or fail to buy). Only the fields that path
 * reads are meaningful — id, creator, published flag and price — but the record is
 * shaped like a real stored `RRInvention` so the response envelope is realistic.
 */
function invention(
	inventionId: number,
	overrides: { CreatorPlayerId?: number; IsPublished?: boolean; Price?: number } = {}
) {
	return {
		InventionId: inventionId,
		ReplicationId: `replication-${inventionId}`,
		CreatorPlayerId: 999,
		Name: `Invention ${inventionId}`,
		Description: 'A test invention',
		ImageName: '',
		CurrentVersionNumber: 1,
		CurrentVersion: {
			InventionId: inventionId,
			ReplicationId: `version-${inventionId}`,
			VersionNumber: 1,
			BlobName: `invention-${inventionId}.inv`,
			BlobHash: null,
			InstantiationCost: 0,
			LightsCost: 0,
			ChipsCost: 0,
			CloudVariablesCost: 0,
			AICost: 0,
		},
		Accessibility: 0,
		IsPublished: true,
		IsFeatured: false,
		ModifiedAt: '2026-01-01T00:00:00.000Z',
		CreatedAt: '2026-01-01T00:00:00.000Z',
		FirstPublishedAt: '2026-01-01T00:00:00.000Z',
		CreationRoomId: 0,
		NumPlayersHaveUsedInRoom: 0,
		NumDownloads: 0,
		CheerCount: 0,
		CreatorPermission: 100,
		GeneralPermission: 20,
		IsAGInvention: false,
		IsCertifiedInvention: false,
		Price: 0,
		AllowTrial: true,
		HideFromPlayer: false,
		ReferencedInventions: [],
		...overrides,
	}
}

const SEEDED_INVENTIONS = [
	invention(8), // free, published, someone else's — the sellable one
	invention(9, { Price: 250 }), // priced: buying it pays creator 999 250 tokens
	invention(10, { IsPublished: false }), // a draft, not on sale even at 0
	invention(11, { CreatorPlayerId: 60 }), // account 60's own invention
]

/**
 * A real outfit as the client posts it to /api/avatar/v3/saved/set — kept verbatim
 * (including the JSON-in-a-string OutfitSelectionsV2/FaceFeatures fields) so the
 * round-trip is tested against the actual payload shape, not a tidied-up version.
 */
const SAVED_OUTFIT = {
	Slot: 4,
	PreviewImageName: 'outfit/2026-07-14/38e84678-1ccf-4cfd-bf3f-5b21eec88b0f.jpg',
	OutfitSelections:
		'5cd08cfb-c729-4c30-96d9-6a99bb934d91,,1;77d3c585-4928-4471-a425-89036efe7299,,0;40528de7-38a3-4a7c-8f93-6d3bfa5573f2,51ef8d39-2b94-4f9e-9620-07b6b0a913a5,0b2395e1-ebcc-47e9-aaf1-faf9e9cec4cd,,0;d0a9262f-5504-46a7-bb10-7507503db58e,95e4cc30-cb68-473d-a395-feadf5b51512,0440f08f-ef1d-49d8-942b-523056e8bb45,,1',
	OutfitSelectionsV2:
		'{"selections":[{"PrefabGuid":"5cd08cfb-c729-4c30-96d9-6a99bb934d91","CombinationGuid":"","BodyPart":1,"UgcOutfitData":{"BaseAvatarItemColor":{"r":0.0,"g":0.0,"b":0.0,"a":0.0},"CustomAvatarItemId":""}}]}',
	FaceFeatures:
		'{"ver":6,"eyeId":"pY0dY6IxOEaNv8uNL8qUgQ","eyeScl":-0.007145103067159653,"useHelmetHair":1,"hideEars":false}',
	SkinColor: 'Xac-W_R330KfOz-pQla9qg',
	HairColor: 'UAT0OaWEkUG-mWDIyiX1Kg',
	CustomAvatarItems: [],
}

// Mint a token the way the `auth` worker does, signing with the shared test key seeded into the JWT_SECRET store.
const TEST_SECRET = 'test-signing-key'

function b64url(input: ArrayBuffer | string): string {
	const bytes = typeof input === 'string' ? new TextEncoder().encode(input) : new Uint8Array(input)
	let binary = ''
	for (const byte of bytes) binary += String.fromCharCode(byte)
	return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

/**
 * A bearer token for `sub`. `roles` becomes the `role` claim the auth worker stamps from an
 * account's flags — pass `['gameClient', 'developer']` for an elevated account; the default
 * is no claim at all, which reads as no roles.
 */
async function bearer(sub = '42', roles?: string[]): Promise<Record<string, string>> {
	const now = Math.floor(Date.now() / 1000)
	const claims =
		roles === undefined ? { sub, exp: now + 3600 } : { sub, exp: now + 3600, role: roles }
	const signingInput = `${b64url(JSON.stringify({ alg: 'HS256', typ: 'JWT' }))}.${b64url(
		JSON.stringify(claims)
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

describe('econ endpoints', () => {
	test('GET /api/avatar/v1/defaultunlocked returns the default avatar items', async () => {
		const res = await exports.default.fetch(`${ORIGIN}/api/avatar/v1/defaultunlocked`)
		expect(res.status).toBe(200)
		const body = (await res.json()) as unknown[]
		expect(Array.isArray(body)).toBe(true)
		expect(body.length).toBeGreaterThan(0)
		expect(body[0]).toHaveProperty('AvatarItemDesc')
	})

	test('GET /api/avatar/v1/defaultbaseavataritems returns the base items (no auth)', async () => {
		const res = await exports.default.fetch(`${ORIGIN}/api/avatar/v1/defaultbaseavataritems`)
		expect(res.status).toBe(200)
		const body = (await res.json()) as Array<Record<string, unknown>>
		expect(body.map((i) => i.AvatarItemId)).toEqual([2184, 2918])
		// The client keys these off IsBaseAvatarItem, and the trailing comma in the desc
		// is part of the item descriptor — both are served verbatim.
		expect(body.every((i) => i.IsBaseAvatarItem === true)).toBe(true)
		expect(body[0]?.AvatarItemDesc).toBe('c5d70cb4-71dd-4fe4-b719-34fe2073c611,')
	})

	test('GET /api/avatar/v4/items 401s without a token', async () => {
		const res = await exports.default.fetch(`${ORIGIN}/api/avatar/v4/items`)
		expect(res.status).toBe(401)
	})

	test('GET /api/avatar/v4/items serves the catalog in the camelCase v4 shape', async () => {
		const res = await exports.default.fetch(`${ORIGIN}/api/avatar/v4/items`, {
			headers: await bearer(),
		})
		expect(res.status).toBe(200)
		const body = (await res.json()) as Array<Record<string, unknown>>
		expect(body.length).toBeGreaterThan(0)
		// Every key of the DTO is present on every item, and nothing PascalCase leaks
		// through from the stored/bundled records.
		for (const item of body) {
			expect(Object.keys(item).sort()).toEqual([
				'avatarItemDesc',
				'avatarItemId',
				'avatarItemType',
				'friendlyName',
				'isBaseAvatarItem',
				'rarity',
				'tagList',
				'tooltip',
			])
		}
		expect(typeof body[0]?.avatarItemDesc).toBe('string')
		expect(typeof body[0]?.friendlyName).toBe('string')
		// The catalog carries no ids, tags or base flag — those default rather than
		// being invented.
		expect(body[0]?.avatarItemId).toBe(0)
		expect(body[0]?.tagList).toBe('')
		expect(body[0]?.isBaseAvatarItem).toBe(false)
	})

	test('GET /api/avatar/v2 401s without a token', async () => {
		const res = await exports.default.fetch(`${ORIGIN}/api/avatar/v2`)
		expect(res.status).toBe(401)
	})

	test('GET /api/avatar/v2 returns a populated default avatar when none is saved', async () => {
		// Account 7 has no saved avatar → falls back to the default outfit.
		const res = await exports.default.fetch(`${ORIGIN}/api/avatar/v2`, {
			headers: await bearer('7'),
		})
		expect(res.status).toBe(200)
		const body = (await res.json()) as { OutfitSelections: string; FaceFeatures: string }
		// Must be non-empty — the client's outfit parser NREs on an empty string.
		expect(body.OutfitSelections.length).toBeGreaterThan(0)
		expect(body.OutfitSelections).toContain(';')
		expect(body.FaceFeatures).toContain('eyeId')
	})

	test('POST /api/avatar/v2/set 401s without a token', async () => {
		const res = await exports.default.fetch(`${ORIGIN}/api/avatar/v2/set`, {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({ OutfitSelections: 'a,,0' }),
		})
		expect(res.status).toBe(401)
	})

	test('POST /api/avatar/v2/set saves the avatar, and GET reads it back', async () => {
		const headers = { ...(await bearer()), 'Content-Type': 'application/json' }
		const avatar = {
			OutfitSelections:
				'1fd69ef8-0b74-4962-af5a-67f0bf0358f2,,0;d0a9262f-5504-46a7-bb10-7507503db58e,,1',
			OutfitSelectionsV2: '{"selections":[]}',
			FaceFeatures: '{"eyeId":"AjGMoJhEcEehacRZjUMuDg"}',
			SkinColor: '3529b670-a66d-448e-9573-1905eae5b9bf',
			HairColor: '0e_jaaObREWTf1AorAZ95g',
			CustomAvatarItems: [],
		}

		// Save echoes the payload back.
		const setRes = await exports.default.fetch(`${ORIGIN}/api/avatar/v2/set`, {
			method: 'POST',
			headers,
			body: JSON.stringify(avatar),
		})
		expect(setRes.status).toBe(200)
		expect(await setRes.json()).toEqual(avatar)

		// And it persists — GET now returns the saved avatar, not the default.
		const getRes = await exports.default.fetch(`${ORIGIN}/api/avatar/v2`, {
			headers: await bearer(),
		})
		expect(await getRes.json()).toEqual(avatar)
	})

	test('GET /api/avatar/v2/:id 400s on a non-numeric id', async () => {
		const res = await exports.default.fetch(`${ORIGIN}/api/avatar/v2/notanumber`)
		expect(res.status).toBe(400)
	})

	test('GET /api/avatar/v2/:id returns the default projection when none is saved (no auth)', async () => {
		// Account 8 has no saved avatar → falls back to the default outfit. No token needed.
		const res = await exports.default.fetch(`${ORIGIN}/api/avatar/v2/8`)
		expect(res.status).toBe(200)
		const body = (await res.json()) as Record<string, unknown>
		// Projected to exactly the render subset — no OutfitSelectionsV2/CustomAvatarItems.
		expect(Object.keys(body).sort()).toEqual([
			'FaceFeatures',
			'HairColor',
			'OutfitSelections',
			'SkinColor',
		])
		expect((body.OutfitSelections as string).length).toBeGreaterThan(0)
	})

	test('GET /api/avatar/v2/:id returns another player’s saved avatar, projected', async () => {
		// Seed account 314 with a full avatar blob (superset of the projection).
		await env.DB.prepare('INSERT OR IGNORE INTO account (data) VALUES (?1)')
			.bind(JSON.stringify({ accountId: 314, username: 'Pi', displayName: 'Pi' }))
			.run()
		await env.DB.prepare('UPDATE account SET avatar = ?2 WHERE account_id = ?1')
			.bind(
				314,
				JSON.stringify({
					OutfitSelections: 'guid,,0;guid2,,1',
					OutfitSelectionsV2: '{"selections":[]}',
					FaceFeatures: '{"eyeId":"abc"}',
					SkinColor: 'skin-guid',
					HairColor: 'hair-guid',
					CustomAvatarItems: [],
				})
			)
			.run()

		const res = await exports.default.fetch(`${ORIGIN}/api/avatar/v2/314`)
		expect(res.status).toBe(200)
		// Only the four projected fields, carrying the saved values.
		expect(await res.json()).toEqual({
			OutfitSelections: 'guid,,0;guid2,,1',
			FaceFeatures: '{"eyeId":"abc"}',
			SkinColor: 'skin-guid',
			HairColor: 'hair-guid',
		})
	})

	test('GET /api/avatar/v2/gifts is not shadowed by the :id route', async () => {
		const res = await exports.default.fetch(`${ORIGIN}/api/avatar/v2/gifts`, {
			headers: await bearer(),
		})
		expect(res.status).toBe(200)
		expect(await res.json()).toEqual([])
	})

	test('POST /api/avatar/v2/set 404s when the caller has no account row', async () => {
		const res = await exports.default.fetch(`${ORIGIN}/api/avatar/v2/set`, {
			method: 'POST',
			headers: { ...(await bearer('99999')), 'Content-Type': 'application/json' },
			body: JSON.stringify({ OutfitSelections: 'a,,0' }),
		})
		expect(res.status).toBe(404)
	})

	test('GET /econ/customAvatarItems/v1/owned 401s without a token, returns an empty paginated stub', async () => {
		const anon = await exports.default.fetch(`${ORIGIN}/econ/customAvatarItems/v1/owned`)
		expect(anon.status).toBe(401)
		const res = await exports.default.fetch(`${ORIGIN}/econ/customAvatarItems/v1/owned`, {
			headers: await bearer(),
		})
		expect(res.status).toBe(200)
		expect(await res.json()).toEqual({ Results: [], TotalResults: 0 })
	})

	test('GET /api/objectives/v1/myprogress returns the default progress (no auth)', async () => {
		const res = await exports.default.fetch(`${ORIGIN}/api/objectives/v1/myprogress`)
		expect(res.status).toBe(200)
		const body = (await res.json()) as { Objectives: unknown[]; ObjectiveGroups: unknown[] }
		expect(Array.isArray(body.Objectives)).toBe(true)
		expect(Array.isArray(body.ObjectiveGroups)).toBe(true)
	})

	test('objectives/v1/cleargroup returns [] for GET and POST (no auth)', async () => {
		for (const method of ['GET', 'POST'] as const) {
			const res = await exports.default.fetch(`${ORIGIN}/api/objectives/v1/cleargroup`, { method })
			expect(res.status).toBe(200)
			expect(await res.json()).toEqual([])
		}
	})

	test('POST /api/objectives/v1/updateobjective echoes the group, never completed', async () => {
		const res = await exports.default.fetch(`${ORIGIN}/api/objectives/v1/updateobjective`, {
			method: 'POST',
			headers: { 'content-type': 'application/json' },
			body: JSON.stringify({
				Index: 2,
				Group: 3,
				Progress: 1,
				VisualProgress: 0,
				IsCompleted: true,
				HasClaimedReward: false,
			}),
		})
		expect(res.status).toBe(200)
		const body = (await res.json()) as { group: number; isCompleted: boolean; clearedAt: string }
		expect(body.group).toBe(3)
		expect(body.isCompleted).toBe(false)
		expect(Number.isNaN(Date.parse(body.clearedAt))).toBe(false)
	})

	test('POST /api/objectives/v1/updateobjective tolerates a non-JSON body', async () => {
		const res = await exports.default.fetch(`${ORIGIN}/api/objectives/v1/updateobjective`, {
			method: 'POST',
			body: 'not json',
		})
		expect(res.status).toBe(200)
		const body = (await res.json()) as { group: number; isCompleted: boolean }
		expect(body.group).toBe(0)
		expect(body.isCompleted).toBe(false)
	})

	test('GET /api/checklist/v1|v2/current 401s without a token, serves the NUX list with one', async () => {
		const expected = [
			{ Order: 0, Objective: 38, Count: 1, CreditAmount: 25 },
			{ Order: 1, Objective: 32, Count: 1, CreditAmount: 25 },
			{ Order: 2, Objective: 2, Count: 1, CreditAmount: 25 },
			{ Order: 3, Objective: 30, Count: 1, CreditAmount: 25 },
			{ Order: 4, Objective: 6, Count: 1, CreditAmount: 25 },
		]
		// Both version paths are live and serve the same list.
		for (const path of ['/api/checklist/v1/current', '/api/checklist/v2/current']) {
			const anon = await exports.default.fetch(`${ORIGIN}${path}`)
			expect(anon.status).toBe(401)
			const res = await exports.default.fetch(`${ORIGIN}${path}`, { headers: await bearer() })
			expect(res.status).toBe(200)
			expect(await res.json()).toEqual(expected)
		}
	})

	test('POST /api/checklist/v1|v2/complete 401s without a token, grants nothing with one', async () => {
		for (const path of ['/api/checklist/v1/complete', '/api/checklist/v2/complete']) {
			const anon = await exports.default.fetch(`${ORIGIN}${path}`, {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({ ItemIndex: 1 }),
			})
			expect(anon.status).toBe(401)

			const res = await exports.default.fetch(`${ORIGIN}${path}`, {
				method: 'POST',
				headers: { ...(await bearer('33')), 'Content-Type': 'application/json' },
				body: JSON.stringify({ ItemIndex: 1 }),
			})
			expect(res.status).toBe(200)
			expect(await res.json()).toEqual({
				BalanceUpdates: [{ UpdateResponse: 303, Data: [] }],
				Balance: 0,
				CurrencyType: 2,
				BalanceType: -2,
			})
		}

		// Stubbed, so completing rows does not move the balance — re-posting cannot farm
		// tokens, and the checklist still lists every row.
		const bal = await exports.default.fetch(`${ORIGIN}/api/storefronts/v4/balance/2`, {
			headers: await bearer('33'),
		})
		expect(await bal.json()).toEqual([{ CurrencyType: 2, Platform: -2, Balance: 10000 }])
	})

	test('GET /api/itemWishlists/v1/wishlist/me 401s without a token, returns [] with one', async () => {
		const anon = await exports.default.fetch(`${ORIGIN}/api/itemWishlists/v1/wishlist/me`)
		expect(anon.status).toBe(401)
		const res = await exports.default.fetch(`${ORIGIN}/api/itemWishlists/v1/wishlist/me`, {
			headers: await bearer(),
		})
		expect(res.status).toBe(200)
		expect(await res.json()).toEqual([])
	})

	test('GET /api/avatar/v3/saved 401s without a token, returns [] with one', async () => {
		const anon = await exports.default.fetch(`${ORIGIN}/api/avatar/v3/saved`)
		expect(anon.status).toBe(401)
		// Account 21 has saved nothing.
		const res = await exports.default.fetch(`${ORIGIN}/api/avatar/v3/saved`, {
			headers: await bearer('21'),
		})
		expect(res.status).toBe(200)
		expect(await res.json()).toEqual([])
	})

	test('POST /api/avatar/v3/saved/set saves an outfit, read back by /saved', async () => {
		const anon = await exports.default.fetch(`${ORIGIN}/api/avatar/v3/saved/set`, {
			method: 'POST',
			body: JSON.stringify(SAVED_OUTFIT),
		})
		expect(anon.status).toBe(401)

		const res = await exports.default.fetch(`${ORIGIN}/api/avatar/v3/saved/set`, {
			method: 'POST',
			headers: { ...(await bearer('22')), 'Content-Type': 'application/json' },
			body: JSON.stringify(SAVED_OUTFIT),
		})
		expect(res.status).toBe(200)
		expect(await res.json()).toEqual(SAVED_OUTFIT)

		// Round-trips verbatim — including the JSON-in-a-string fields the client parses
		// back itself (OutfitSelectionsV2, FaceFeatures).
		const saved = await exports.default.fetch(`${ORIGIN}/api/avatar/v3/saved`, {
			headers: await bearer('22'),
		})
		expect(await saved.json()).toEqual([SAVED_OUTFIT])
	})

	test('POST /api/avatar/v3/saved/set overwrites the same slot, and keeps others', async () => {
		const headers = await bearer('23')
		const post = (outfit: unknown) =>
			exports.default.fetch(`${ORIGIN}/api/avatar/v3/saved/set`, {
				method: 'POST',
				headers: { ...headers, 'Content-Type': 'application/json' },
				body: JSON.stringify(outfit),
			})

		await post({ ...SAVED_OUTFIT, Slot: 4, SkinColor: 'first' })
		await post({ ...SAVED_OUTFIT, Slot: 7, SkinColor: 'other-slot' })
		// Re-saving slot 4 replaces it rather than adding a second row for it.
		await post({ ...SAVED_OUTFIT, Slot: 4, SkinColor: 'second' })

		const res = await exports.default.fetch(`${ORIGIN}/api/avatar/v3/saved`, { headers })
		const outfits = (await res.json()) as Array<{ Slot: number; SkinColor: string }>
		expect(outfits.map((o) => [o.Slot, o.SkinColor])).toEqual([
			[4, 'second'],
			[7, 'other-slot'],
		])
	})

	test('POST /api/avatar/v3/saved/set 400s without an integer Slot', async () => {
		const { Slot: _Slot, ...noSlot } = SAVED_OUTFIT
		const res = await exports.default.fetch(`${ORIGIN}/api/avatar/v3/saved/set`, {
			method: 'POST',
			headers: { ...(await bearer('24')), 'Content-Type': 'application/json' },
			body: JSON.stringify(noSlot),
		})
		expect(res.status).toBe(400)
	})

	test('POST /api/avatar/v4/saved/set stores like v3 but acks with { Success, Slot }', async () => {
		const anon = await exports.default.fetch(`${ORIGIN}/api/avatar/v4/saved/set`, {
			method: 'POST',
			body: JSON.stringify(SAVED_OUTFIT),
		})
		expect(anon.status).toBe(401)

		const res = await exports.default.fetch(`${ORIGIN}/api/avatar/v4/saved/set`, {
			method: 'POST',
			headers: { ...(await bearer('25')), 'Content-Type': 'application/json' },
			body: JSON.stringify(SAVED_OUTFIT),
		})
		expect(res.status).toBe(200)
		// v4 answers a lean ack, not the echoed outfit.
		expect(await res.json()).toEqual({ Success: true, Slot: SAVED_OUTFIT.Slot })

		// Shares the v3 outfit table, so the v3 read serves the outfit back verbatim.
		const saved = await exports.default.fetch(`${ORIGIN}/api/avatar/v3/saved`, {
			headers: await bearer('25'),
		})
		expect(await saved.json()).toEqual([SAVED_OUTFIT])
	})

	test('POST /api/avatar/v4/saved/set 400s without an integer Slot', async () => {
		const { Slot: _Slot, ...noSlot } = SAVED_OUTFIT
		const res = await exports.default.fetch(`${ORIGIN}/api/avatar/v4/saved/set`, {
			method: 'POST',
			headers: { ...(await bearer('26')), 'Content-Type': 'application/json' },
			body: JSON.stringify(noSlot),
		})
		expect(res.status).toBe(400)
	})

	test('GET /api/avatar/v2/gifts 401s without a token, returns [] with one', async () => {
		const anon = await exports.default.fetch(`${ORIGIN}/api/avatar/v2/gifts`)
		expect(anon.status).toBe(401)
		const res = await exports.default.fetch(`${ORIGIN}/api/avatar/v2/gifts`, {
			headers: await bearer(),
		})
		expect(res.status).toBe(200)
		expect(await res.json()).toEqual([])
	})

	test('GET /api/equipment/v2/getUnlocked 401s without a token, returns [] when none owned', async () => {
		const anon = await exports.default.fetch(`${ORIGIN}/api/equipment/v2/getUnlocked`)
		expect(anon.status).toBe(401)
		// Account 30 has bought no equipment → empty list.
		const res = await exports.default.fetch(`${ORIGIN}/api/equipment/v2/getUnlocked`, {
			headers: await bearer('30'),
		})
		expect(res.status).toBe(200)
		expect(await res.json()).toEqual([])
	})

	test('GET /api/roomconsumables/v1/roomConsumable/room/:id returns []', async () => {
		const res = await exports.default.fetch(
			`${ORIGIN}/api/roomconsumables/v1/roomConsumable/room/1`
		)
		expect(res.status).toBe(200)
		expect(await res.json()).toEqual([])
	})

	test('GET /api/roomcurrencies/v1/currencies returns []', async () => {
		const res = await exports.default.fetch(`${ORIGIN}/api/roomcurrencies/v1/currencies?roomId=1`)
		expect(res.status).toBe(200)
		expect(await res.json()).toEqual([])
	})

	test('GET /api/roomkeys/v1/room returns []', async () => {
		const res = await exports.default.fetch(`${ORIGIN}/api/roomkeys/v1/room?roomId=1`)
		expect(res.status).toBe(200)
		expect(await res.json()).toEqual([])
	})

	test('GET /api/roomconsumables/v1/roomConsumable/room/:id/me returns []', async () => {
		const res = await exports.default.fetch(
			`${ORIGIN}/api/roomconsumables/v1/roomConsumable/room/1/me`
		)
		expect(res.status).toBe(200)
		expect(await res.json()).toEqual([])
	})

	test('GET /api/roomcurrencies/v1/getAllBalances returns []', async () => {
		const res = await exports.default.fetch(
			`${ORIGIN}/api/roomcurrencies/v1/getAllBalances?roomId=1`
		)
		expect(res.status).toBe(200)
		expect(await res.json()).toEqual([])
	})

	// The room-economy stubs. One table-driven test: they're the same empty-list answer,
	// and what's worth pinning is that every path the client asks for on room entry is
	// registered — an unregistered one 404s and stalls the room load.
	test('the room-economy endpoints all return []', async () => {
		for (const path of [
			'/econ/roomInventory/room/92',
			'/econ/roomInventory/room/92/player',
			'/econ/roomInventoryItemTags/room/92',
			'/econ/roomOffer/room/92',
			'/econ/roomOffer/room/92/purchaseCounts',
			'/econ/roomGiftDropShops/room/92',
		]) {
			const res = await exports.default.fetch(`${ORIGIN}${path}`)
			expect(res.status, path).toBe(200)
			expect(await res.json(), path).toEqual([])
		}
	})

	test('GET /api/consumables/v2/getUnlocked 401s without a token, returns []', async () => {
		const anon = await exports.default.fetch(`${ORIGIN}/api/consumables/v2/getUnlocked`)
		expect(anon.status).toBe(401)
		const res = await exports.default.fetch(`${ORIGIN}/api/consumables/v2/getUnlocked`, {
			headers: await bearer(),
		})
		expect(res.status).toBe(200)
		expect(await res.json()).toEqual([])
	})

	test('POST /api/consumables/v1/consume reduces the count and deletes the row at zero', async () => {
		// Seed account 313 with two Supreme Pizza instances (counts 3 and 1).
		await grantConsumable(env.DB, 313, 'Supreme Pizza', 3)
		await grantConsumable(env.DB, 313, 'Supreme Pizza', 1)

		type Group = { ConsumableItemDesc: string; Ids: number[]; Count: number }
		const pizza = async (sub = '313'): Promise<Group | undefined> => {
			const groups = (await (
				await exports.default.fetch(`${ORIGIN}/api/consumables/v2/getUnlocked`, {
					headers: await bearer(sub),
				})
			).json()) as Group[]
			return groups.find((g) => g.ConsumableItemDesc === 'Supreme Pizza')
		}
		const consume = async (Id: number, DeltaCount: number, sub = '313') =>
			exports.default.fetch(`${ORIGIN}/api/consumables/v1/consume`, {
				method: 'POST',
				headers: { ...(await bearer(sub)), 'Content-Type': 'application/json' },
				body: JSON.stringify({ Id, DeltaCount }),
			})

		const before = (await pizza())!
		expect(before.Count).toBe(4)
		const [firstId, secondId] = before.Ids // firstId: count 3, secondId: count 1

		// No token → 401.
		expect(
			(
				await exports.default.fetch(`${ORIGIN}/api/consumables/v1/consume`, {
					method: 'POST',
					headers: { 'Content-Type': 'application/json' },
					body: JSON.stringify({ Id: firstId, DeltaCount: 1 }),
				})
			).status
		).toBe(401)

		// Consume 1 from the count-3 instance → it drops to 2, still present.
		expect((await consume(firstId, 1)).status).toBe(200)
		expect((await pizza())!.Count).toBe(3)

		// Consume the whole count-1 instance → its row is deleted.
		await consume(secondId, 1)
		const afterSecond = (await pizza())!
		expect(afterSecond.Ids).not.toContain(secondId)
		expect(afterSecond.Count).toBe(2)

		// Over-consume the remaining instance (delta > count) → row deleted, group gone.
		await consume(firstId, 5)
		expect(await pizza()).toBeUndefined()

		// Consuming a row you don't own is a no-op (scoped to the owner).
		await grantConsumable(env.DB, 314, 'Soda', 2)
		const sodaId = (
			(await (
				await exports.default.fetch(`${ORIGIN}/api/consumables/v2/getUnlocked`, {
					headers: await bearer('314'),
				})
			).json()) as Array<{ Ids: number[] }>
		)[0].Ids[0]
		await consume(sodaId, 2, '313') // account 313 tries to consume 314's row
		const soda = (
			(await (
				await exports.default.fetch(`${ORIGIN}/api/consumables/v2/getUnlocked`, {
					headers: await bearer('314'),
				})
			).json()) as Array<{ Count: number }>
		)[0]
		expect(soda.Count).toBe(2)
	})

	test('GET /api/storefronts/v4/balance/2 401s without a token, returns the token balance', async () => {
		const anon = await exports.default.fetch(`${ORIGIN}/api/storefronts/v4/balance/2`)
		expect(anon.status).toBe(401)
		const res = await exports.default.fetch(`${ORIGIN}/api/storefronts/v4/balance/2`, {
			headers: await bearer(),
		})
		expect(res.status).toBe(200)
		// The starting grant, applied on this first read.
		expect(await res.json()).toEqual([{ CurrencyType: 2, Platform: -2, Balance: 10000 }])
	})

	test('GET /api/storefronts/v4/balance/2 reflects what the player has spent', async () => {
		// Spend from account 7 (a fresh account: the read below grants it first).
		expect(
			await spendCurrency(env.DB, 7, CurrencyType.RecCenterTokens, 2500, DEFAULT_STARTING_TOKENS)
		).toBe(true)
		const res = await exports.default.fetch(`${ORIGIN}/api/storefronts/v4/balance/2`, {
			headers: await bearer('7'),
		})
		expect(await res.json()).toEqual([{ CurrencyType: 2, Platform: -2, Balance: 7500 }])
	})

	test('a spend the player cannot afford changes nothing', async () => {
		const before = await getBalance(
			env.DB,
			8,
			CurrencyType.RecCenterTokens,
			DEFAULT_STARTING_TOKENS
		)
		expect(
			await spendCurrency(
				env.DB,
				8,
				CurrencyType.RecCenterTokens,
				before + 1,
				DEFAULT_STARTING_TOKENS
			)
		).toBe(false)
		expect(await getBalance(env.DB, 8, CurrencyType.RecCenterTokens, DEFAULT_STARTING_TOKENS)).toBe(
			before
		)
	})

	test('the starting grant comes from the STARTING_TOKENS var', async () => {
		// The grant an operator actually runs is the var; DEFAULT_STARTING_TOKENS is only the
		// fallback. `env` is shared by every test in this file, so restore it in `finally`.
		const original = env.STARTING_TOKENS
		try {
			env.STARTING_TOKENS = 250
			const res = await exports.default.fetch(`${ORIGIN}/api/storefronts/v4/balance/2`, {
				headers: await bearer('11'),
			})
			expect(await res.json()).toEqual([{ CurrencyType: 2, Platform: -2, Balance: 250 }])
		} finally {
			env.STARTING_TOKENS = original
		}
	})

	test('the starting grant is not re-granted after spending down to zero', async () => {
		// The grant is INSERT OR IGNORE against the row, not a top-up: a player who spends
		// everything stays at 0 rather than being refilled by their next balance read.
		expect(
			await spendCurrency(env.DB, 9, CurrencyType.RecCenterTokens, 10_000, DEFAULT_STARTING_TOKENS)
		).toBe(true)
		const res = await exports.default.fetch(`${ORIGIN}/api/storefronts/v4/balance/2`, {
			headers: await bearer('9'),
		})
		expect(await res.json()).toEqual([{ CurrencyType: 2, Platform: -2, Balance: 0 }])
	})

	test('GET /api/storefronts/v4/balance for a room-scoped currency returns 0, not a balance', async () => {
		// RoomCurrency (300) is scoped to a room and served elsewhere; this table must not
		// hand out an account-wide balance for it.
		const res = await exports.default.fetch(`${ORIGIN}/api/storefronts/v4/balance/300`, {
			headers: await bearer(),
		})
		expect(res.status).toBe(200)
		expect(await res.json()).toEqual([{ CurrencyType: 300, Platform: -2, Balance: 0 }])
	})

	test('GET /api/storefronts/v3/giftdropstore/3 returns the storefront catalog', async () => {
		const res = await exports.default.fetch(`${ORIGIN}/api/storefronts/v3/giftdropstore/3`)
		expect(res.status).toBe(200)
		expect(await res.json()).toBeTruthy()
	})

	// Item 73 in sf3.json — "Bowtie (White)", 450 RecCenterTokens (CurrencyType 2).
	test('POST /api/storefronts/v2/buyItem 401s without a token', async () => {
		const res = await exports.default.fetch(`${ORIGIN}/api/storefronts/v2/buyItem`, {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({
				StorefrontType: 3,
				PurchasableItemId: 73,
				CurrencyType: 2,
				RequestedPrice: 450,
			}),
		})
		expect(res.status).toBe(401)
	})

	test('POST /api/storefronts/v2/buyItem debits, grants the item, and hands back a gift box', async () => {
		// Account 20: fresh, so its first balance touch grants the 10000 default.
		await drainFrames()
		const res = await exports.default.fetch(`${ORIGIN}/api/storefronts/v2/buyItem`, {
			method: 'POST',
			headers: { ...(await bearer('20')), 'Content-Type': 'application/json' },
			body: JSON.stringify({
				StorefrontType: 3,
				PurchasableItemId: 73,
				CurrencyType: 2,
				RequestedPrice: 450,
			}),
		})
		expect(res.status).toBe(200)
		const body = (await res.json()) as {
			Balance: number
			CurrencyType: number
			BalanceType: number
			BalanceUpdates: Array<{
				Data: Array<{ Id: number; AvatarItemDesc: string }>
			}>
		}
		// `Balance` is the change applied (the negated price), not the resulting total.
		expect(body.Balance).toBe(-450)
		expect(body.CurrencyType).toBe(2)
		expect(body.BalanceType).toBe(-2)
		const gift = body.BalanceUpdates[0].Data[0]
		expect(gift.AvatarItemDesc).not.toBe('')
		expect(gift.Id).toBeGreaterThan(0)

		// A purchase pushes StorefrontBalancePurchase, which SETS one (CurrencyType, Platform)
		// bucket to an absolute value: `Balance` is the resulting total (10000 - 450) and `Delta`
		// is display-only. The bucket key is `Platform`, and it MUST be the -2 the balance
		// endpoint reports below — the client sums its buckets, so a frame naming any other
		// platform (or spelling the key `BalanceType`, which the client's decoder drops) invents
		// a second balance beside the real one. That is what showed a live player 34,100 tokens
		// after spending 900 of 17,500, then 33,200 once the body's -900 landed.
		expect(await drainFrames()).toEqual([
			{
				accountId: 20,
				notificationType: NotificationType.StorefrontBalancePurchase,
				payload: {
					// 1400 = CommercePurchase; -2 = NonPurchasedNotUsableInP2P, the only bucket we use.
					BalanceAddType: 1400,
					Delta: -450,
					Balance: 9550,
					Platform: -2,
					CurrencyType: 2,
				},
			},
		])

		// The balance endpoint reflects the debit (this is the resulting total, 10000 - 450).
		const bal = await exports.default.fetch(`${ORIGIN}/api/storefronts/v4/balance/2`, {
			headers: await bearer('20'),
		})
		expect(await bal.json()).toEqual([{ CurrencyType: 2, Platform: -2, Balance: 9550 }])

		// The item is now owned — it leads the v4/items list (owned items prepend the catalog).
		const items = await exports.default.fetch(`${ORIGIN}/api/avatar/v4/items`, {
			headers: await bearer('20'),
		})
		const list = (await items.json()) as Array<{ avatarItemDesc: string; friendlyName: string }>
		expect(list[0].friendlyName).toBe('Bowtie (White)')
		expect(list[0].avatarItemDesc).toBe(gift.AvatarItemDesc)

		// And a pending gift box is waiting to be opened.
		const gifts = await exports.default.fetch(`${ORIGIN}/api/avatar/v2/gifts`, {
			headers: await bearer('20'),
		})
		const pending = (await gifts.json()) as Array<{ Id: number; AvatarItemDesc: string }>
		expect(pending).toHaveLength(1)
		expect(pending[0].Id).toBe(gift.Id)
		expect(pending[0].AvatarItemDesc).toBe(gift.AvatarItemDesc)
	})

	test('POST /api/storefronts/v2/buyItem grants a consumable and stacks on re-buy', async () => {
		// Item 2266 (Supreme Pizza) in storefront 300 is a consumable — its gift-drop
		// carries a ConsumableItemDesc, not an AvatarItemDesc.
		const consumableDesc = 'wUCIKdJSvEmiQHYMyx4X4w'
		const buy = async () =>
			exports.default.fetch(`${ORIGIN}/api/storefronts/v2/buyItem`, {
				method: 'POST',
				headers: { ...(await bearer('25')), 'Content-Type': 'application/json' },
				body: JSON.stringify({
					StorefrontType: 300,
					PurchasableItemId: 2266,
					CurrencyType: 2,
					RequestedPrice: 95,
				}),
			})

		const res = await buy()
		expect(res.status).toBe(200)
		const body = (await res.json()) as {
			Balance: number
			BalanceUpdates: Array<{
				Data: Array<{
					ConsumableItemDesc: string
					AvatarItemDesc: string
					AvatarItemType: number
					FromPlayerId: number
				}>
			}>
		}
		// `Balance` is the change applied (the negated price), not the resulting total.
		expect(body.Balance).toBe(-95)
		const drop = body.BalanceUpdates[0].Data[0]
		expect(drop.ConsumableItemDesc).toBe(consumableDesc)
		expect(drop.AvatarItemDesc).toBe('')
		// A consumable's AvatarItemType is null in the catalog; the response coalesces it to 0.
		expect(drop.AvatarItemType).toBe(0)
		// A self-buy is attributed to the "Coach" system account (id 1).
		expect(drop.FromPlayerId).toBe(1)

		// It's owned as an unlocked consumable — one instance, count 1.
		const unlocked = async () => {
			const r = await exports.default.fetch(`${ORIGIN}/api/consumables/v2/getUnlocked`, {
				headers: await bearer('25'),
			})
			expect(r.status).toBe(200)
			return (await r.json()) as Array<{
				Ids: number[]
				CreatedAts: string[]
				ConsumableItemDesc: string
				Count: number
				InitialCount: number
				IsActive: boolean
				IsTransferable: boolean
			}>
		}
		const first = await unlocked()
		expect(first).toHaveLength(1)
		expect(first[0].ConsumableItemDesc).toBe(consumableDesc)
		expect(first[0].Count).toBe(1)
		expect(first[0].InitialCount).toBe(1)
		expect(first[0].Ids).toHaveLength(1)
		expect(first[0].CreatedAts).toHaveLength(1)
		expect(first[0].IsActive).toBe(false)
		expect(first[0].IsTransferable).toBe(false)

		// A consumable is not an avatar item — it does not show up in v4/items.
		const items = await exports.default.fetch(`${ORIGIN}/api/avatar/v4/items`, {
			headers: await bearer('25'),
		})
		const list = (await items.json()) as Array<{ friendlyName: string }>
		expect(list.every((i) => i.friendlyName !== 'Supreme Pizza')).toBe(true)

		// Buying it again stacks: a second instance, count summed to 2.
		expect((await buy()).status).toBe(200)
		const second = await unlocked()
		expect(second).toHaveLength(1)
		expect(second[0].Count).toBe(2)
		expect(second[0].InitialCount).toBe(2)
		expect(second[0].Ids).toHaveLength(2)
		expect(second[0].CreatedAts).toHaveLength(2)
	})

	test('POST /api/storefronts/v2/buyItem grants equipment, read back by getUnlocked, no re-buy dupe', async () => {
		// Item 1950 (Disc Skin (Coop)) in storefront 3 is a pure equipment drop — its
		// gift-drop carries an EquipmentModificationGuid but no avatar/consumable desc.
		const guid = '19ef59c7-f74b-4c63-935a-1d4b1abd8518'
		const buy = async () =>
			exports.default.fetch(`${ORIGIN}/api/storefronts/v2/buyItem`, {
				method: 'POST',
				headers: { ...(await bearer('31')), 'Content-Type': 'application/json' },
				body: JSON.stringify({
					StorefrontType: 3,
					PurchasableItemId: 1950,
					CurrencyType: 2,
					RequestedPrice: 3500,
				}),
			})

		const res = await buy()
		expect(res.status).toBe(200)
		const body = (await res.json()) as {
			Balance: number
			BalanceUpdates: Array<{
				Data: Array<{ Id: number; EquipmentModificationGuid: string; EquipmentPrefabName: string }>
			}>
		}
		expect(body.Balance).toBe(-3500)
		const gift = body.BalanceUpdates[0].Data[0]
		expect(gift.EquipmentModificationGuid).toBe(guid)
		expect(gift.EquipmentPrefabName).toBe('[DiscGolfDisc]')

		const unlocked = async () => {
			const r = await exports.default.fetch(`${ORIGIN}/api/equipment/v2/getUnlocked`, {
				headers: await bearer('31'),
			})
			expect(r.status).toBe(200)
			return (await r.json()) as Array<{
				ModificationGuid: string
				PrefabName: string
				FriendlyName: string
				PlatformMask: number
				Favorited: boolean
			}>
		}
		const first = await unlocked()
		expect(first).toHaveLength(1)
		// The unlocked DTO is unprefixed, unlike the gift-drop the grant came from.
		expect(first[0].ModificationGuid).toBe(guid)
		expect(first[0].PrefabName).toBe('[DiscGolfDisc]')
		expect(first[0].FriendlyName).toBe('Disc Skin (Coop)')
		expect(first[0].PlatformMask).toBe(-1)

		// Equipment is not an avatar item — it does not show up in v4/items.
		const items = await exports.default.fetch(`${ORIGIN}/api/avatar/v4/items`, {
			headers: await bearer('31'),
		})
		const list = (await items.json()) as Array<{ friendlyName: string }>
		expect(list.every((i) => i.friendlyName !== 'Disc Skin (Coop)')).toBe(true)

		expect(first[0].Favorited).toBe(false)

		// Owning equipment is boolean: re-buying upserts, it does not add a second row.
		expect((await buy()).status).toBe(200)
		expect(await unlocked()).toHaveLength(1)

		// Favouriting sticks.
		const update = async (favorited: boolean) =>
			exports.default.fetch(`${ORIGIN}/api/equipment/v1/update`, {
				method: 'PUT',
				headers: { ...(await bearer('31')), 'Content-Type': 'application/json' },
				body: JSON.stringify([
					{ PrefabName: '[DiscGolfDisc]', ModificationGuid: guid, Favorited: favorited },
					// A guid the caller doesn't own is silently skipped, not inserted.
					{ PrefabName: '[Basketball]', ModificationGuid: 'not-owned', Favorited: true },
				]),
			})
		expect((await update(true)).status).toBe(200)
		let after = await unlocked()
		expect(after).toHaveLength(1)
		expect(after[0].Favorited).toBe(true)

		// …and un-favouriting flips it back.
		expect((await update(false)).status).toBe(200)
		after = await unlocked()
		expect(after[0].Favorited).toBe(false)
	})

	test('PUT /api/equipment/v1/update 401s without a token, 400s on a non-array body', async () => {
		const anon = await exports.default.fetch(`${ORIGIN}/api/equipment/v1/update`, {
			method: 'PUT',
			headers: { 'Content-Type': 'application/json' },
			body: '[]',
		})
		expect(anon.status).toBe(401)

		const bad = await exports.default.fetch(`${ORIGIN}/api/equipment/v1/update`, {
			method: 'PUT',
			headers: { ...(await bearer('32')), 'Content-Type': 'application/json' },
			body: '{}',
		})
		expect(bad.status).toBe(400)
	})

	test('POST /api/storefronts/v2/buyItem 409s when the sent price no longer matches', async () => {
		const res = await exports.default.fetch(`${ORIGIN}/api/storefronts/v2/buyItem`, {
			method: 'POST',
			headers: { ...(await bearer('21')), 'Content-Type': 'application/json' },
			body: JSON.stringify({
				StorefrontType: 3,
				PurchasableItemId: 73,
				CurrencyType: 2,
				RequestedPrice: 1,
			}),
		})
		expect(res.status).toBe(409)
		// Nothing was charged.
		const bal = await exports.default.fetch(`${ORIGIN}/api/storefronts/v4/balance/2`, {
			headers: await bearer('21'),
		})
		expect(await bal.json()).toEqual([{ CurrencyType: 2, Platform: -2, Balance: 10000 }])
	})

	test('POST /api/storefronts/v2/buyItem 404s for an unknown item', async () => {
		const res = await exports.default.fetch(`${ORIGIN}/api/storefronts/v2/buyItem`, {
			method: 'POST',
			headers: { ...(await bearer('22')), 'Content-Type': 'application/json' },
			body: JSON.stringify({
				StorefrontType: 3,
				PurchasableItemId: 9999999,
				CurrencyType: 2,
				RequestedPrice: 450,
			}),
		})
		expect(res.status).toBe(404)
	})

	test('POST /api/storefronts/v2/buyItem 400s when the player cannot afford it', async () => {
		// Drain account 23 to 0 first, then try to buy.
		expect(
			await spendCurrency(env.DB, 23, CurrencyType.RecCenterTokens, 10_000, DEFAULT_STARTING_TOKENS)
		).toBe(true)
		const res = await exports.default.fetch(`${ORIGIN}/api/storefronts/v2/buyItem`, {
			method: 'POST',
			headers: { ...(await bearer('23')), 'Content-Type': 'application/json' },
			body: JSON.stringify({
				StorefrontType: 3,
				PurchasableItemId: 73,
				CurrencyType: 2,
				RequestedPrice: 450,
			}),
		})
		expect(res.status).toBe(400)
		// Still owns nothing (only the default catalog in v4/items).
		const items = await exports.default.fetch(`${ORIGIN}/api/avatar/v4/items`, {
			headers: await bearer('23'),
		})
		const list = (await items.json()) as Array<{ friendlyName: string }>
		expect(list.every((i) => i.friendlyName !== 'Bowtie (White)')).toBe(true)
	})

	/**
	 * The StorefrontBalanceUpdate (and other) frames the worker has pushed since the last
	 * drain, read back off the stub hub in vitest.config.ts. Notification sends are
	 * best-effort — the worker logs and swallows a hub failure — so this is the only way a
	 * test sees what was actually pushed.
	 */
	const drainFrames = async (): Promise<
		Array<{ accountId: number; notificationType: number; payload: Record<string, unknown> }>
	> =>
		(
			env.RECFLARE_NOTIFICATIONS_HUB.getByName('global') as unknown as {
				drainFrames(): Promise<
					Array<{ accountId: number; notificationType: number; payload: Record<string, unknown> }>
				>
			}
		).drainFrames()

	// buyInvention is a GET with query params — that is how the client sends it.
	const buyInvention = async (sub: string, inventionId: number, requestedPrice = 0) =>
		exports.default.fetch(
			`${ORIGIN}/api/storefronts/v2/buyInvention?inventionId=${inventionId}&requestedPrice=${requestedPrice}`,
			{ headers: await bearer(sub) }
		)

	test('GET /api/storefronts/v2/buyInvention 401s without a token', async () => {
		const res = await exports.default.fetch(
			`${ORIGIN}/api/storefronts/v2/buyInvention?inventionId=8&requestedPrice=0`
		)
		expect(res.status).toBe(401)
	})

	test('GET /api/storefronts/v2/buyInvention records ownership of a free invention', async () => {
		const res = await buyInvention('50', 8)
		expect(res.status).toBe(200)
		const body = (await res.json()) as {
			BalanceUpdateResponse: {
				Balance: number
				BalanceType: number
				CurrencyType: number
				BalanceUpdates: Array<{ UpdateResponse: number; Data: { InventionId: number } }>
			}
			InventionResponse: {
				Status: number
				Invention: { InventionId: number; Name: string }
				InventionVersion: { InventionId: number; VersionNumber: number }
			}
		}
		// Nothing was debited, so `Balance` is the resulting total — the untouched starting
		// grant — not a change, unlike buyItem's.
		expect(body.BalanceUpdateResponse.Balance).toBe(DEFAULT_STARTING_TOKENS)
		expect(body.BalanceUpdateResponse.CurrencyType).toBe(CurrencyType.RecCenterTokens)
		expect(body.BalanceUpdateResponse.BalanceType).toBe(-2)
		expect(body.BalanceUpdateResponse.BalanceUpdates[0].Data.InventionId).toBe(8)
		expect(body.InventionResponse.Status).toBe(0)
		expect(body.InventionResponse.Invention.Name).toBe('Invention 8')
		expect(body.InventionResponse.InventionVersion.VersionNumber).toBe(1)

		expect(await getOwnedInventionIds(env.DB, 50)).toEqual([8])

		// Owning an invention is boolean: buying it again is a conflict, not a second row.
		expect((await buyInvention('50', 8)).status).toBe(409)
		expect(await getOwnedInventionIds(env.DB, 50)).toEqual([8])
	})

	test('GET /api/storefronts/v2/buyInvention pays the creator the buyer’s tokens', async () => {
		// Invention 9 costs 250 and was made by account 999. Buying it moves 250 tokens from
		// the buyer to that creator — no house cut, so the two sides are equal and opposite.
		await drainFrames()
		const res = await buyInvention('51', 9, 250)
		expect(res.status).toBe(200)
		const body = (await res.json()) as { BalanceUpdateResponse: { Balance: number } }
		// `Balance` is the buyer's RESULTING total, so it already has the debit in it.
		expect(body.BalanceUpdateResponse.Balance).toBe(DEFAULT_STARTING_TOKENS - 250)
		expect(
			await getBalance(env.DB, 51, CurrencyType.RecCenterTokens, DEFAULT_STARTING_TOKENS)
		).toBe(DEFAULT_STARTING_TOKENS - 250)
		// The creator had never touched their balance: they keep their starting grant AND get
		// paid, rather than the payout standing in for the grant.
		expect(
			await getBalance(env.DB, 999, CurrencyType.RecCenterTokens, DEFAULT_STARTING_TOKENS)
		).toBe(DEFAULT_STARTING_TOKENS + 250)
		expect(await getOwnedInventionIds(env.DB, 51)).toEqual([9])

		// Both sides get a frame carrying their RESULTING TOTAL, into the same -2 bucket the
		// balance endpoint reports — a StorefrontBalance* push SETS that bucket, so sending the
		// change (250 / -250) would set their whole balance to it. The creator sold, so theirs is
		// a plain update; the buyer bought, so theirs is a purchase frame with a display-only
		// `Delta`. Note the key is `Platform`: the client renames `BalanceType` away and drops it.
		expect(await drainFrames()).toEqual([
			{
				accountId: 999,
				notificationType: NotificationType.StorefrontBalanceUpdate,
				payload: {
					Balance: DEFAULT_STARTING_TOKENS + 250,
					CurrencyType: CurrencyType.RecCenterTokens,
					Platform: -2,
				},
			},
			{
				accountId: 51,
				notificationType: NotificationType.StorefrontBalancePurchase,
				payload: {
					BalanceAddType: 1400,
					Delta: -250,
					Balance: DEFAULT_STARTING_TOKENS - 250,
					Platform: -2,
					CurrencyType: CurrencyType.RecCenterTokens,
				},
			},
		])
	})

	test('GET /api/storefronts/v2/buyInvention rejects a stale price and an unaffordable one', async () => {
		// Sending 0 for the 250-token invention 9 is a stale (or tampered) price.
		expect((await buyInvention('53', 9, 0)).status).toBe(409)

		// Account 54 can't afford it: nothing is debited, nobody is paid, nothing is owned.
		await spendCurrency(
			env.DB,
			54,
			CurrencyType.RecCenterTokens,
			DEFAULT_STARTING_TOKENS,
			DEFAULT_STARTING_TOKENS
		)
		const creatorBefore = await getBalance(
			env.DB,
			999,
			CurrencyType.RecCenterTokens,
			DEFAULT_STARTING_TOKENS
		)
		expect((await buyInvention('54', 9, 250)).status).toBe(400)
		expect(
			await getBalance(env.DB, 54, CurrencyType.RecCenterTokens, DEFAULT_STARTING_TOKENS)
		).toBe(0)
		expect(
			await getBalance(env.DB, 999, CurrencyType.RecCenterTokens, DEFAULT_STARTING_TOKENS)
		).toBe(creatorBefore)
		expect(await getOwnedInventionIds(env.DB, 53)).toEqual([])
		expect(await getOwnedInventionIds(env.DB, 54)).toEqual([])
	})

	test('GET /api/storefronts/v2/buyInvention rejects drafts, self-buys and unknown ids', async () => {
		// Unpublished — a draft is not on sale, free or not.
		expect((await buyInvention('52', 10)).status).toBe(403)
		// Account 60 created invention 11; a creator already owns it.
		expect((await buyInvention('60', 11)).status).toBe(400)
		expect((await buyInvention('52', 9999)).status).toBe(404)
		// Missing/non-numeric inventionId.
		const res = await exports.default.fetch(`${ORIGIN}/api/storefronts/v2/buyInvention`, {
			headers: await bearer('52'),
		})
		expect(res.status).toBe(400)
		expect(await getOwnedInventionIds(env.DB, 52)).toEqual([])
		expect(await getOwnedInventionIds(env.DB, 60)).toEqual([])
	})

	test('POST /api/avatar/v2/gifts/consume opens the box the way the client sends it', async () => {
		// Buy an item for account 24, then consume the box the way the client does: on the
		// econ host, with a form body (`Id=..&UnlockedLevel=..`).
		const buy = await exports.default.fetch(`${ORIGIN}/api/storefronts/v2/buyItem`, {
			method: 'POST',
			headers: { ...(await bearer('24')), 'Content-Type': 'application/json' },
			body: JSON.stringify({
				StorefrontType: 3,
				PurchasableItemId: 73,
				CurrencyType: 2,
				RequestedPrice: 450,
			}),
		})
		const bought = (await buy.json()) as {
			BalanceUpdates: Array<{ Data: Array<{ Id: number }> }>
		}
		const giftId = bought.BalanceUpdates[0].Data[0].Id

		const res = await exports.default.fetch(`${ORIGIN}/api/avatar/v2/gifts/consume/`, {
			method: 'POST',
			headers: {
				...(await bearer('24')),
				'Content-Type': 'application/x-www-form-urlencoded',
			},
			body: new URLSearchParams({ Id: String(giftId), UnlockedLevel: '0' }),
		})
		expect(res.status).toBe(200)
		expect(await res.json()).toEqual({ error: '', success: true, value: null })

		// The box is gone; the item stays owned (it was granted at purchase, not on open).
		const gifts = await exports.default.fetch(`${ORIGIN}/api/avatar/v2/gifts`, {
			headers: await bearer('24'),
		})
		expect(await gifts.json()).toEqual([])
		const items = await exports.default.fetch(`${ORIGIN}/api/avatar/v4/items`, {
			headers: await bearer('24'),
		})
		const list = (await items.json()) as Array<{ friendlyName: string }>
		expect(list.some((i) => i.friendlyName === 'Bowtie (White)')).toBe(true)

		// Opening it again is a harmless no-op — still 200.
		const again = await exports.default.fetch(`${ORIGIN}/api/avatar/v2/gifts/consume/`, {
			method: 'POST',
			headers: {
				...(await bearer('24')),
				'Content-Type': 'application/x-www-form-urlencoded',
			},
			body: new URLSearchParams({ Id: String(giftId) }),
		})
		expect(again.status).toBe(200)
	})

	test('POST /api/avatar/v2/gifts/consume opens a consumable box (fires ConsumableMappingAdded)', async () => {
		// Buy a consumable (Supreme Pizza, item 2266 in storefront 300) for account 26 —
		// its gift box carries a ConsumableItemDesc, so opening it notifies the client.
		const buy = await exports.default.fetch(`${ORIGIN}/api/storefronts/v2/buyItem`, {
			method: 'POST',
			headers: { ...(await bearer('26')), 'Content-Type': 'application/json' },
			body: JSON.stringify({
				StorefrontType: 300,
				PurchasableItemId: 2266,
				CurrencyType: 2,
				RequestedPrice: 95,
			}),
		})
		expect(buy.status).toBe(200)
		const giftId = (
			(await buy.json()) as { BalanceUpdates: Array<{ Data: Array<{ Id: number }> }> }
		).BalanceUpdates[0].Data[0].Id

		// Opening the box succeeds and fires the ConsumableMappingAdded push (which no-ops
		// against the test hub stub — this asserts the notify path doesn't throw).
		const res = await exports.default.fetch(`${ORIGIN}/api/avatar/v2/gifts/consume`, {
			method: 'POST',
			headers: { ...(await bearer('26')), 'Content-Type': 'application/x-www-form-urlencoded' },
			body: new URLSearchParams({ Id: String(giftId) }),
		})
		expect(res.status).toBe(200)
		expect(await res.json()).toEqual({ error: '', success: true, value: null })

		// The box is gone; the consumable stays owned (granted at purchase).
		expect(
			await (
				await exports.default.fetch(`${ORIGIN}/api/avatar/v2/gifts`, {
					headers: await bearer('26'),
				})
			).json()
		).toEqual([])
		const unlocked = (await (
			await exports.default.fetch(`${ORIGIN}/api/consumables/v2/getUnlocked`, {
				headers: await bearer('26'),
			})
		).json()) as Array<{ ConsumableItemDesc: string }>
		expect(unlocked.length).toBeGreaterThan(0)
	})

	test('POST /api/avatar/v2/gifts/consume 403s when the box belongs to another player', async () => {
		// Account 27 buys an item, producing a gift box owned by 27.
		const buy = await exports.default.fetch(`${ORIGIN}/api/storefronts/v2/buyItem`, {
			method: 'POST',
			headers: { ...(await bearer('27')), 'Content-Type': 'application/json' },
			body: JSON.stringify({
				StorefrontType: 3,
				PurchasableItemId: 73,
				CurrencyType: 2,
				RequestedPrice: 450,
			}),
		})
		const giftId = (
			(await buy.json()) as { BalanceUpdates: Array<{ Data: Array<{ Id: number }> }> }
		).BalanceUpdates[0].Data[0].Id

		// Account 28 trying to open 27's box is forbidden — and 27 keeps it.
		const forbidden = await exports.default.fetch(`${ORIGIN}/api/avatar/v2/gifts/consume`, {
			method: 'POST',
			headers: { ...(await bearer('28')), 'Content-Type': 'application/x-www-form-urlencoded' },
			body: new URLSearchParams({ Id: String(giftId) }),
		})
		expect(forbidden.status).toBe(403)
		const stillThere = (await (
			await exports.default.fetch(`${ORIGIN}/api/avatar/v2/gifts`, { headers: await bearer('27') })
		).json()) as Array<{ Id: number }>
		expect(stillThere.some((g) => g.Id === giftId)).toBe(true)

		// The owner (27) opens it fine, and re-opening the now-gone box is a harmless 200.
		const ok = await exports.default.fetch(`${ORIGIN}/api/avatar/v2/gifts/consume`, {
			method: 'POST',
			headers: { ...(await bearer('27')), 'Content-Type': 'application/x-www-form-urlencoded' },
			body: new URLSearchParams({ Id: String(giftId) }),
		})
		expect(ok.status).toBe(200)
		const again = await exports.default.fetch(`${ORIGIN}/api/avatar/v2/gifts/consume`, {
			method: 'POST',
			headers: { ...(await bearer('27')), 'Content-Type': 'application/x-www-form-urlencoded' },
			body: new URLSearchParams({ Id: String(giftId) }),
		})
		expect(again.status).toBe(200)
	})

	test('GET /api/challenge/v2/getCurrent returns the weekly challenge', async () => {
		const res = await exports.default.fetch(`${ORIGIN}/api/challenge/v2/getCurrent`)
		expect(res.status).toBe(200)
		const body = (await res.json()) as { ChallengeMapId: number; Challenges: unknown[] }
		expect(body).toHaveProperty('ChallengeMapId')
		expect(Array.isArray(body.Challenges)).toBe(true)
	})

	test('GET /api/storefronts/v1/adcarouselitems returns the carousel items', async () => {
		const res = await exports.default.fetch(`${ORIGIN}/api/storefronts/v1/adcarouselitems`)
		expect(res.status).toBe(200)
		const body = (await res.json()) as Array<{ AdCarouselItemId: number }>
		expect(Array.isArray(body)).toBe(true)
		expect(body[0]).toHaveProperty('AdCarouselItemId')
	})

	test('GET /api/gamerewards/v1/pending returns []', async () => {
		const res = await exports.default.fetch(`${ORIGIN}/api/gamerewards/v1/pending`)
		expect(res.status).toBe(200)
		expect(await res.json()).toEqual([])
	})

	test('POST /api/challenge/v2/updateProgress echoes the challenge and its stored completion', async () => {
		// Post the live rotation's own challenge and rule tree — what the client actually
		// sends — so editing static/weekly-challenge.json can't quietly stale this test.
		const challenge = CURRENT_CHALLENGE
		const res = await exports.default.fetch(`${ORIGIN}/api/challenge/v2/updateProgress`, {
			method: 'POST',
			headers: { ...(await bearer('70')), 'Content-Type': 'application/json' },
			body: JSON.stringify({
				ChallengeMapId: String(weeklyChallenge.ChallengeMapId),
				ChallengeId: String(challenge.ChallengeId),
				Config: challenge.Config,
				// .NET's bool.ToString() — the capitalized string, which `Boolean("False")`
				// would read as complete.
				Complete: 'False',
			}),
		})
		expect(res.status).toBe(200)
		expect(await res.json()).toEqual({
			ChallengeMapId: weeklyChallenge.ChallengeMapId,
			ChallengeId: challenge.ChallengeId,
			Config: challenge.Config,
			Complete: false,
		})
	})

	test('POST /api/challenge/v2/updateProgress is 401 without a token', async () => {
		const res = await exports.default.fetch(`${ORIGIN}/api/challenge/v2/updateProgress`, {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({ ChallengeMapId: '17', ChallengeId: '49', Complete: 'True' }),
		})
		expect(res.status).toBe(401)
	})

	test('a completed challenge persists and getCurrent stamps it for that player only', async () => {
		const completedId = CURRENT_CHALLENGE.ChallengeId
		const bearerHeaders = await bearer('71')
		const posted = await exports.default.fetch(`${ORIGIN}/api/challenge/v2/updateProgress`, {
			method: 'POST',
			headers: { ...bearerHeaders, 'Content-Type': 'application/json' },
			body: JSON.stringify({
				ChallengeMapId: String(weeklyChallenge.ChallengeMapId),
				ChallengeId: completedId,
				Complete: 'True',
			}),
		})
		expect(posted.status).toBe(200)

		const mine = await exports.default.fetch(`${ORIGIN}/api/challenge/v2/getCurrent`, {
			headers: bearerHeaders,
		})
		const body = (await mine.json()) as {
			Challenges: Array<{ ChallengeId: number; Complete: boolean }>
		}
		// Only the reported one is stamped; the rest of the rotation is untouched.
		expect(body.Challenges.filter((ch) => ch.Complete).map((ch) => ch.ChallengeId)).toEqual([
			completedId,
		])

		// A different player, and an anonymous caller, still see the static catalog.
		const other = await exports.default.fetch(`${ORIGIN}/api/challenge/v2/getCurrent`, {
			headers: await bearer('72'),
		})
		const otherBody = (await other.json()) as { Challenges: Array<{ Complete: boolean }> }
		expect(otherBody.Challenges.some((ch) => ch.Complete)).toBe(false)
		const anon = await exports.default.fetch(`${ORIGIN}/api/challenge/v2/getCurrent`)
		const anonBody = (await anon.json()) as { Challenges: Array<{ Complete: boolean }> }
		expect(anonBody.Challenges.some((ch) => ch.Complete)).toBe(false)
	})

	test('completion latches within a rotation but resets on a new one', async () => {
		const headers = { ...(await bearer('73')), 'Content-Type': 'application/json' }
		// A challenge id of its own, so this says nothing about the live rotation.
		const post = (ChallengeMapId: string, Complete: string) =>
			exports.default.fetch(`${ORIGIN}/api/challenge/v2/updateProgress`, {
				method: 'POST',
				headers,
				body: JSON.stringify({ ChallengeMapId, ChallengeId: '9001', Complete }),
			})
		const completeOf = async (res: Response) =>
			((await res.json()) as { Complete: boolean }).Complete

		expect(await completeOf(await post('17', 'True'))).toBe(true)
		// A later report that says "not complete" must not un-finish it.
		expect(await completeOf(await post('17', 'False'))).toBe(true)
		// …but the same challenge id in the NEXT rotation starts over.
		expect(await completeOf(await post('18', 'False'))).toBe(false)
		expect(await completeOf(await post('18', 'True'))).toBe(true)
	})

	/**
	 * How many of the rotation's challenges earn the gift — three, unless the rotation
	 * publishes fewer or declares itself all-or-nothing (`CHALLENGES_REQUIRED_FOR_GIFT`).
	 */
	const REQUIRED_FOR_GIFT = weeklyChallenge.CompletedRequired
		? weeklyChallenge.Challenges.length
		: Math.min(3, weeklyChallenge.Challenges.length)

	/** Report the live rotation's challenges complete, for one player. */
	async function finishTheRotation(sub: string) {
		const headers = { ...(await bearer(sub)), 'Content-Type': 'application/json' }
		const ids = weeklyChallenge.Challenges.map((challenge) => challenge.ChallengeId)
		const report = (challengeId: number) =>
			exports.default.fetch(`${ORIGIN}/api/challenge/v2/updateProgress`, {
				method: 'POST',
				headers,
				body: JSON.stringify({
					ChallengeMapId: String(weeklyChallenge.ChallengeMapId),
					ChallengeId: String(challengeId),
					Complete: 'True',
				}),
			})
		return { ids, report }
	}

	/** A player's unopened gift boxes, as the client reads them back. */
	async function giftBoxes(sub: string) {
		const res = await exports.default.fetch(`${ORIGIN}/api/avatar/v2/gifts`, {
			headers: await bearer(sub),
		})
		return (await res.json()) as Array<{
			Id: number
			Message: string
			EquipmentModificationGuid: string
			AvatarItemDesc: string
			ConsumableItemDesc: string
			GiftRarity: number
		}>
	}

	test('completing enough of the rotation grants its gift, once', async () => {
		// The live rotation, so this follows whatever static/weekly-challenge.json holds.
		const { ids, report } = await finishTheRotation('74')
		// The whole point of the threshold: the gift lands before the set is finished (the
		// published week is five challenges for three).
		expect(REQUIRED_FOR_GIFT).toBeLessThan(ids.length)
		for (const id of ids.slice(0, REQUIRED_FOR_GIFT - 1)) {
			expect((await report(id)).status).toBe(200)
		}
		// One short of the threshold — the gift isn't due yet, even though challenges remain
		// unfinished either way.
		expect(await giftBoxes('74')).toEqual([])
		await drainFrames()

		expect((await report(ids[REQUIRED_FOR_GIFT - 1] ?? 0)).status).toBe(200)
		const won = await giftBoxes('74')
		expect(won).toHaveLength(1)
		expect(won[0]?.Message).toBe('Weekly challenge complete!')
		expect(won[0]?.EquipmentModificationGuid).toBe(weeklyChallenge.Gift.EquipmentModificationGuid)

		// The client is told the moment the set is finished, rather than finding the box the
		// next time it reads the gifts list. `Immediate` (31), from Coach (1).
		const frames = await drainFrames()
		expect(frames).toHaveLength(1)
		expect(frames[0]?.accountId).toBe(74)
		expect(frames[0]?.notificationType).toBe(NotificationType.GiftPackageReceivedImmediate)
		expect(frames[0]?.payload).toEqual({
			Id: won[0]?.Id,
			FromGiftDropId: 0,
			FromPlayerId: 1,
			ConsumableItemDesc: '',
			AvatarItemDesc: weeklyChallenge.Gift.AvatarItemDesc,
			AvatarItemType: weeklyChallenge.Gift.AvatarItemType,
			EquipmentPrefabName: weeklyChallenge.Gift.EquipmentPrefabName,
			EquipmentModificationGuid: weeklyChallenge.Gift.EquipmentModificationGuid,
			CurrencyType: 0,
			Currency: 0,
			Xp: 0,
			Level: 0,
			Platform: -1,
			PlatformsToSpawnOn: -1,
			BalanceType: -2,
			GiftContext: weeklyChallenge.Gift.GiftContext,
			// The catalog's rarity for the item, not the block's `GiftRarity` of 0.
			GiftRarity: 5,
			Message: 'Weekly challenge complete!',
		})

		// The reward is the item, not the box: it lands in the inventory unopened.
		const unlocked = await exports.default.fetch(`${ORIGIN}/api/equipment/v2/getUnlocked`, {
			headers: await bearer('74'),
		})
		const owned = (await unlocked.json()) as Array<{ ModificationGuid: string }>
		expect(owned.map((e) => e.ModificationGuid)).toContain(
			weeklyChallenge.Gift.EquipmentModificationGuid
		)

		// Finishing the REST of the set, and re-reporting what's already done (which the client
		// keeps doing), must not mint a second reward.
		for (const id of ids) expect((await report(id)).status).toBe(200)
		expect(await giftBoxes('74')).toHaveLength(1)
	})

	test('a player who already owns the rotation’s gift rolls the fallback box instead', async () => {
		// Own the reward up front — the case the rotation's `FallbackGiftName` exists for.
		await grantEquipment(env.DB, 75, {
			ModificationGuid: weeklyChallenge.Gift.EquipmentModificationGuid,
			PrefabName: weeklyChallenge.Gift.EquipmentPrefabName,
			FriendlyName: 'Camera Skin (Comic)',
			Tooltip: '',
			Rarity: 5,
			PlatformMask: -1,
			Favorited: false,
		})

		const { ids, report } = await finishTheRotation('75')
		for (const id of ids.slice(0, REQUIRED_FOR_GIFT - 1)) {
			expect((await report(id)).status).toBe(200)
		}
		await drainFrames()
		expect((await report(ids[REQUIRED_FOR_GIFT - 1] ?? 0)).status).toBe(200)

		const won = await giftBoxes('75')
		expect(won).toHaveLength(1)
		// Something they don't have, at the tier `FallbackGiftName` names ("4-Star Box" → 30),
		// rather than a second copy of the gift.
		const rolled = won[0]
		expect(rolled?.EquipmentModificationGuid).not.toBe(
			weeklyChallenge.Gift.EquipmentModificationGuid
		)
		expect(rolled?.GiftRarity).toBe(30)
		expect(
			(rolled?.AvatarItemDesc ?? '') !== '' || (rolled?.EquipmentModificationGuid ?? '') !== ''
		).toBe(true)

		// The frame announces what was ROLLED, not the box that promised it — so the client
		// pops the item they actually won.
		const frames = await drainFrames()
		expect(frames).toHaveLength(1)
		expect(frames[0]?.notificationType).toBe(NotificationType.GiftPackageReceivedImmediate)
		expect(frames[0]?.payload).toMatchObject({
			Id: rolled?.Id,
			FromPlayerId: 1,
			GiftRarity: 30,
			AvatarItemDesc: rolled?.AvatarItemDesc,
			EquipmentModificationGuid: rolled?.EquipmentModificationGuid,
			Message: 'Weekly challenge complete!',
		})
	})

	test('buying a query drop rolls a real item into the buyer’s inventory', async () => {
		// sf2's "4-Star Unique Box" (539) — an `IsQuery` drop with no item fields of its own,
		// which before the roll existed debited the buyer and granted nothing.
		const res = await exports.default.fetch(`${ORIGIN}/api/storefronts/v2/buyItem`, {
			method: 'POST',
			headers: { ...(await bearer('76')), 'Content-Type': 'application/json' },
			body: JSON.stringify({
				StorefrontType: 2,
				PurchasableItemId: 539,
				CurrencyType: CurrencyType.RecCenterTokens,
				RequestedPrice: 800,
			}),
		})
		expect(res.status).toBe(200)

		// The RESPONSE describes what the roll landed on, not the box that was bought: the
		// client draws the purchase from this entry, and the box's own fields are all empty.
		const bought = (await res.json()) as {
			BalanceUpdates: Array<{
				Data: Array<{
					AvatarItemDesc: string
					EquipmentModificationGuid: string
					GiftRarity: number
				}>
			}>
		}
		const entry = bought.BalanceUpdates[0]?.Data[0]
		expect(entry?.GiftRarity).toBe(30)
		expect(`${entry?.AvatarItemDesc ?? ''}${entry?.EquipmentModificationGuid ?? ''}`).not.toBe('')

		const boxes = await giftBoxes('76')
		expect(boxes).toHaveLength(1)
		// The box shows what was rolled — a real 4-star item, not the empty box drop.
		expect(boxes[0]?.GiftRarity).toBe(30)
		expect(entry?.AvatarItemDesc).toBe(boxes[0]?.AvatarItemDesc)
		const key = (box?: { AvatarItemDesc: string; EquipmentModificationGuid: string }) =>
			`${box?.AvatarItemDesc ?? ''}|${box?.EquipmentModificationGuid ?? ''}`
		expect(key(boxes[0])).not.toBe('|')

		// …and it is already in their inventory, unopened box or not.
		const items = await exports.default.fetch(`${ORIGIN}/api/avatar/v4/items`, {
			headers: await bearer('76'),
		})
		// v4 serves the camelCase DTO, unlike the PascalCase records on the gift box.
		const owned = (await items.json()) as Array<{ avatarItemDesc: string }>
		if ((boxes[0]?.AvatarItemDesc ?? '') !== '') {
			expect(owned.map((i) => i.avatarItemDesc)).toContain(boxes[0]?.AvatarItemDesc)
		}

		// A second box can't roll the same prize: "an item that you don't have" excludes what
		// the first roll just granted. Two draws from a 244-item pool could collide by chance,
		// so this only holds because the pool is filtered by ownership.
		const second = await exports.default.fetch(`${ORIGIN}/api/storefronts/v2/buyItem`, {
			method: 'POST',
			headers: { ...(await bearer('76')), 'Content-Type': 'application/json' },
			body: JSON.stringify({
				StorefrontType: 2,
				PurchasableItemId: 539,
				CurrencyType: CurrencyType.RecCenterTokens,
				RequestedPrice: 800,
			}),
		})
		expect(second.status).toBe(200)
		const after = await giftBoxes('76')
		expect(after).toHaveLength(2)
		expect(key(after[0])).not.toBe(key(after[1]))
	})

	test('buying sf3’s Uncommon Random box answers with the rolled item', async () => {
		// The purchase that came back as an empty box: an sf3 query drop, rolled out of the very
		// catalog it sells in.
		const res = await exports.default.fetch(`${ORIGIN}/api/storefronts/v2/buyItem`, {
			method: 'POST',
			headers: { ...(await bearer('77')), 'Content-Type': 'application/json' },
			body: JSON.stringify({
				StorefrontType: 3,
				PurchasableItemId: 2455,
				CurrencyType: CurrencyType.RecCenterTokens,
				RequestedPrice: 200,
				CouponConsumablePlayerMappingId: null,
				Gift: null,
			}),
		})
		expect(res.status).toBe(200)
		const body = (await res.json()) as {
			BalanceUpdates: Array<{
				Data: Array<{ Id: number; AvatarItemDesc: string; GiftRarity: number }>
			}>
		}
		const entry = body.BalanceUpdates[0]?.Data[0]
		// Uncommon: rarity 10, and a real item rather than the box's empty fields.
		expect(entry?.GiftRarity).toBe(10)
		expect(entry?.AvatarItemDesc).not.toBe('')

		const boxes = await giftBoxes('77')
		expect(boxes).toHaveLength(1)
		expect(boxes[0]?.Id).toBe(entry?.Id)
		expect(boxes[0]?.AvatarItemDesc).toBe(entry?.AvatarItemDesc)
	})

	test('POST /api/gamerewards/v1/request claims once an hour per reward type and activity', async () => {
		const headers = {
			...(await bearer('80')),
			'Content-Type': 'application/x-www-form-urlencoded',
		}
		const request = (body: string) =>
			exports.default.fetch(`${ORIGIN}/api/gamerewards/v1/request`, {
				method: 'POST',
				headers,
				body,
			})
		const statusOf = (rewardType: string, giftContext = '') =>
			env.DB.prepare(
				`SELECT granted_at, grant_count FROM reward_status
				 WHERE account_id = 80 AND reward_type = ?1 AND gift_context = ?2`
			)
				.bind(rewardType, giftContext)
				.first<{ granted_at: string; grant_count: number }>()

		// A claim answers the empty list the client accepts — the reward rides in a gift box.
		const first = await request(
			'rewardType=FirstActivityOfDay&Message=First%20Game%20of%20the%20Day'
		)
		expect(first.status).toBe(200)
		expect(await first.json()).toEqual([])
		const claimed = await statusOf('FirstActivityOfDay')
		expect(claimed?.grant_count).toBe(1)

		// Asking again inside the hour claims nothing — and must not push the cooldown out,
		// or a client that retries in a loop would never become eligible.
		expect((await request('rewardType=FirstActivityOfDay&Message=again')).status).toBe(200)
		expect(await statusOf('FirstActivityOfDay')).toEqual(claimed)

		// A different type has its own cooldown — and so does each `giftContext` within a type:
		// Soccer and Paintball are separate rows that each claim once.
		expect(
			(
				await request(
					'rewardType=PostGameActivity&Message=Activity%20completed%21&giftContext=Soccer'
				)
			).status
		).toBe(200)
		expect((await statusOf('PostGameActivity', 'Soccer'))?.grant_count).toBe(1)
		expect(
			(
				await request(
					'rewardType=PostGameActivity&Message=Activity%20completed%21&giftContext=Paintball'
				)
			).status
		).toBe(200)
		expect((await statusOf('PostGameActivity', 'Paintball'))?.grant_count).toBe(1)

		// …but the same activity again inside the hour claims nothing.
		const soccer = await statusOf('PostGameActivity', 'Soccer')
		expect((await request('rewardType=PostGameActivity&giftContext=Soccer')).status).toBe(200)
		expect(await statusOf('PostGameActivity', 'Soccer')).toEqual(soccer)

		// A contextless ask is its own bucket (`''`), not a wildcard over the two above.
		expect((await request('rewardType=PostGameActivity&Message=no%20context')).status).toBe(200)
		expect((await statusOf('PostGameActivity'))?.grant_count).toBe(1)
		expect((await request('rewardType=PostGameActivity&Message=again')).status).toBe(200)
		expect((await statusOf('PostGameActivity'))?.grant_count).toBe(1)

		// Once the hour has passed, the same type claims again.
		await env.DB.prepare(
			"UPDATE reward_status SET granted_at = ?1 WHERE account_id = 80 AND reward_type = 'FirstActivityOfDay'"
		)
			.bind(new Date(Date.now() - 61 * 60 * 1000).toISOString())
			.run()
		expect((await request('rewardType=FirstActivityOfDay&Message=tomorrow')).status).toBe(200)
		expect((await statusOf('FirstActivityOfDay'))?.grant_count).toBe(2)
	})

	test('a claimed game reward pays XP into a gift box, and announces it', async () => {
		const request = async (body: string) =>
			exports.default.fetch(`${ORIGIN}/api/gamerewards/v1/request`, {
				method: 'POST',
				headers: {
					...(await bearer('82')),
					'Content-Type': 'application/x-www-form-urlencoded',
				},
				body,
			})
		/** Age the cooldown so the next ask is eligible again. */
		const passAnHour = () =>
			env.DB.prepare(
				"UPDATE reward_status SET granted_at = ?1 WHERE account_id = 82 AND reward_type = 'FirstActivityOfDay'"
			)
				.bind(new Date(Date.now() - 61 * 60 * 1000).toISOString())
				.run()

		await drainFrames()
		expect((await getProgression(env.DB, 82)).XP).toBe(0)
		const res = await request('rewardType=FirstActivityOfDay&Message=First%20Game%20of%20the%20Day')
		expect(res.status).toBe(200)
		expect(await res.json()).toEqual([])

		// 5 XP is deliberately less than the 10 the first level costs, so one action moves the
		// bar without levelling anyone up.
		expect(await getProgression(env.DB, 82)).toEqual({ PlayerId: 82, Level: 1, XP: 5 })

		// One box: the XP reward itself, carrying the message the client asked to show and no
		// item — a game reward is not an item.
		const first = await giftBoxes('82')
		expect(first).toHaveLength(1)
		expect(first[0]).toMatchObject({
			Xp: 5,
			Message: 'First Game of the Day',
			AvatarItemDesc: '',
			EquipmentModificationGuid: '',
			ConsumableItemDesc: '',
		})

		// The box, then the bar — no level-up box, since no level was crossed.
		const frames = await drainFrames()
		expect(frames.map((f) => f.notificationType)).toEqual([
			NotificationType.GiftPackageReceivedImmediate,
			NotificationType.PlayerProgressionLevelUpdate,
		])
		expect(frames[0]?.accountId).toBe(82)
		expect(frames[0]?.payload).toMatchObject({
			Id: first[0]?.Id,
			FromPlayerId: 1,
			Xp: 5,
			// GiftContext.GameRewards — the box came from gameplay, not a purchase.
			GiftContext: 50,
			Message: 'First Game of the Day',
		})
		expect(frames[1]?.payload).toEqual({ PlayerId: 82, Level: 1, XP: 5 })

		// An on-cooldown ask pays nothing: no more boxes, no frames, no more XP.
		expect((await request('rewardType=FirstActivityOfDay&Message=again')).status).toBe(200)
		expect(await getProgression(env.DB, 82)).toEqual({ PlayerId: 82, Level: 1, XP: 5 })
		expect(await giftBoxes('82')).toHaveLength(1)
		expect(await drainFrames()).toEqual([])

		// A SECOND reward completes the 10 XP level 1 costs — two actions per early level, which
		// is the pacing the smaller grant buys.
		await passAnHour()
		expect((await request('rewardType=FirstActivityOfDay&Message=Second')).status).toBe(200)
		expect(await getProgression(env.DB, 82)).toEqual({ PlayerId: 82, Level: 2, XP: 0 })

		// …and level 2 pays 2-Star Clothing per the published table: an AVATAR ITEM, never an
		// equipment skin, which is what the avatar-only roll is for.
		const afterLevel2 = await giftBoxes('82')
		expect(afterLevel2).toHaveLength(3)
		const clothingBox = afterLevel2[2]
		expect(clothingBox?.Message).toBe('Level 2!')
		expect(clothingBox?.AvatarItemDesc).not.toBe('')
		expect(clothingBox?.EquipmentModificationGuid).toBe('')
		expect(clothingBox?.ConsumableItemDesc).toBe('')
		expect(clothingBox?.GiftRarity).toBe(10)

		const items = await exports.default.fetch(`${ORIGIN}/api/avatar/v4/items`, {
			headers: await bearer('82'),
		})
		// v4 serves the camelCase DTO, unlike the PascalCase records on the gift box.
		const owned = (await items.json()) as Array<{ avatarItemDesc: string }>
		expect(owned.map((i) => i.avatarItemDesc)).toContain(clothingBox?.AvatarItemDesc)
		expect((await drainFrames()).map((f) => f.notificationType)).toEqual([
			NotificationType.GiftPackageReceivedImmediate,
			NotificationType.PlayerProgressionLevelUpdate,
			NotificationType.GiftPackageReceivedImmediate,
		])

		// Two more rewards reach level 3, which the table pays as a CONSUMABLE rather than
		// clothing — rolled without a rarity, since the table names none for them.
		for (const message of ['Third', 'Fourth']) {
			await passAnHour()
			expect((await request(`rewardType=FirstActivityOfDay&Message=${message}`)).status).toBe(200)
		}
		expect(await getProgression(env.DB, 82)).toEqual({ PlayerId: 82, Level: 3, XP: 0 })

		const afterLevel3 = await giftBoxes('82')
		const consumableBox = afterLevel3[afterLevel3.length - 1]
		expect(consumableBox?.Message).toBe('Level 3!')
		expect(consumableBox?.ConsumableItemDesc).not.toBe('')
		expect(consumableBox?.AvatarItemDesc).toBe('')
		expect(consumableBox?.EquipmentModificationGuid).toBe('')

		const consumables = await exports.default.fetch(`${ORIGIN}/api/consumables/v2/getUnlocked`, {
			headers: await bearer('82'),
		})
		const held = (await consumables.json()) as Array<{ ConsumableItemDesc: string }>
		expect(held.map((cons) => cons.ConsumableItemDesc)).toContain(consumableBox?.ConsumableItemDesc)
	})

	test('POST /api/gamerewards/v1/request is 401 without a token, and ignores a typeless ask', async () => {
		const anon = await exports.default.fetch(`${ORIGIN}/api/gamerewards/v1/request`, {
			method: 'POST',
			headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
			body: 'rewardType=FirstActivityOfDay&Message=First%20Game%20of%20the%20Day',
		})
		expect(anon.status).toBe(401)

		// No reward type: nothing to gate, so no row keyed on an empty string.
		const typeless = await exports.default.fetch(`${ORIGIN}/api/gamerewards/v1/request`, {
			method: 'POST',
			headers: {
				...(await bearer('81')),
				'Content-Type': 'application/x-www-form-urlencoded',
			},
			body: 'Message=First%20Game%20of%20the%20Day',
		})
		expect(typeless.status).toBe(200)
		expect(await typeless.json()).toEqual([])
		const rows = await env.DB.prepare(
			'SELECT COUNT(*) AS count FROM reward_status WHERE account_id = 81'
		).first<{ count: number }>()
		expect(rows?.count).toBe(0)
	})

	test('GET /api/roomkeys/v1/mine returns []', async () => {
		const res = await exports.default.fetch(`${ORIGIN}/api/roomkeys/v1/mine`)
		expect(res.status).toBe(200)
		expect(await res.json()).toEqual([])
	})

	const getSubscription = async (headers: Record<string, string> = {}) =>
		exports.default.fetch(`${ORIGIN}/api/CampusCard/v1/UpdateAndGetSubscription`, {
			method: 'POST',
			headers,
		})

	test('POST /api/CampusCard/v1/UpdateAndGetSubscription gives a developer a Gold year', async () => {
		const res = await getSubscription(await bearer('205', ['gameClient', 'developer']))
		expect(res.status).toBe(200)
		const body = (await res.json()) as {
			Subscription: Record<string, unknown>
			PlatformAccountSubscribedPlayerId: null
		}
		expect(body.PlatformAccountSubscribedPlayerId).toBeNull()
		expect(body.Subscription).toMatchObject({
			SubscriptionId: 1,
			// The subscribed player is the caller, not a fixed id.
			RecNetPlayerId: 205,
			// -1 All: no store sold this. 0 = Gold (1 is Platinum), 1 = Year.
			PlatformType: -1,
			PlatformId: '',
			PlatformPurchaseId: '',
			Level: 0,
			Period: 1,
			IsAutoRenewing: true,
		})

		// The subscription runs a year from the call rather than to a hard-coded date, so it
		// cannot lapse on a day nobody is expecting.
		const created = new Date(body.Subscription.CreatedAt as string)
		const expires = new Date(body.Subscription.ExpirationDate as string)
		expect(body.Subscription.ModifiedAt).toBe(body.Subscription.CreatedAt)
		expect(expires.getTime()).toBeGreaterThan(Date.now())
		expect(expires.getUTCFullYear()).toBe(created.getUTCFullYear() + 1)
		expect(expires.getUTCMonth()).toBe(created.getUTCMonth())
		expect(expires.getUTCDate()).toBe(created.getUTCDate())
	})

	test('POST /api/CampusCard/v1/UpdateAndGetSubscription is {} without the developer role', async () => {
		// A plain player's token: valid, but no elevated role.
		expect(await (await getSubscription(await bearer('206', ['gameClient']))).json()).toEqual({})
		// A token with no `role` claim at all.
		expect(await (await getSubscription(await bearer('206'))).json()).toEqual({})
		// No token: "not subscribed" rather than 401, so a loading client isn't stalled.
		const anon = await getSubscription()
		expect(anon.status).toBe(200)
		expect(await anon.json()).toEqual({})
	})

	test('unknown path returns 404', async () => {
		const res = await exports.default.fetch(`${ORIGIN}/nope`)
		expect(res.status).toBe(404)
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

		// Every route the worker serves is described. This is the drift guard: adding a
		// route without a describeRoute() block fails here rather than silently shipping
		// an incomplete spec. Hono's `:param` syntax becomes OpenAPI's `{param}`; the
		// `.on(['GET','POST'], …)` cleargroup route contributes both methods.
		const documented = new Set(
			Object.entries(spec.paths).flatMap(([path, ops]) =>
				Object.keys(ops).map((method) => `${method.toUpperCase()} ${path}`)
			)
		)
		expect([...documented].sort()).toEqual([
			'GET /api/avatar/v1/defaultbaseavataritems',
			'GET /api/avatar/v1/defaultunlocked',
			'GET /api/avatar/v2',
			'GET /api/avatar/v2/gifts',
			'GET /api/avatar/v2/{id}',
			'GET /api/avatar/v3/saved',
			'GET /api/avatar/v4/items',
			'GET /api/challenge/v2/getCurrent',
			'GET /api/checklist/v1/current',
			'GET /api/checklist/v2/current',
			'GET /api/consumables/v2/getUnlocked',
			'GET /api/equipment/v2/getUnlocked',
			'GET /api/gamerewards/v1/pending',
			'GET /api/itemWishlists/v1/wishlist/me',
			'GET /api/objectives/v1/cleargroup',
			'GET /api/objectives/v1/myprogress',
			'GET /api/roomconsumables/v1/roomConsumable/room/{roomId}',
			'GET /api/roomconsumables/v1/roomConsumable/room/{roomId}/me',
			'GET /api/roomcurrencies/v1/currencies',
			'GET /api/roomcurrencies/v1/getAllBalances',
			'GET /api/roomkeys/v1/mine',
			'GET /api/roomkeys/v1/room',
			'GET /api/storefronts/v1/adcarouselitems',
			'GET /api/storefronts/v2/buyInvention',
			'GET /api/storefronts/v3/giftdropstore/{id}',
			'GET /api/storefronts/v4/balance/{currencyType}',
			'GET /econ/customAvatarItems/v1/owned',
			'GET /econ/roomGiftDropShops/room/{roomId}',
			'GET /econ/roomInventory/room/{roomId}',
			'GET /econ/roomInventory/room/{roomId}/player',
			'GET /econ/roomInventoryItemTags/room/{roomId}',
			'GET /econ/roomOffer/room/{roomId}',
			'GET /econ/roomOffer/room/{roomId}/purchaseCounts',
			'POST /api/CampusCard/v1/UpdateAndGetSubscription',
			'POST /api/avatar/v2/gifts/consume',
			'POST /api/avatar/v2/set',
			'POST /api/avatar/v3/saved/set',
			'POST /api/avatar/v4/saved/set',
			'POST /api/challenge/v2/updateProgress',
			'POST /api/checklist/v1/complete',
			'POST /api/checklist/v2/complete',
			'POST /api/consumables/v1/consume',
			'POST /api/gamerewards/v1/request',
			'POST /api/objectives/v1/cleargroup',
			'POST /api/objectives/v1/updateobjective',
			'POST /api/storefronts/v2/buyItem',
			'PUT /api/equipment/v1/update',
		])

		// Every operation carries a summary — a path present but undescribed is not
		// documentation.
		for (const ops of Object.values(spec.paths)) {
			for (const op of Object.values(ops)) expect(op.summary).toBeTruthy()
		}
	})
})
