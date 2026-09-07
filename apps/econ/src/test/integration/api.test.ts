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
import {
	createCustomAvatarItem,
	SCHEMA_DDL as CUSTOM_AVATAR_ITEM_SCHEMA_DDL,
} from '../../../../api/src/custom-avatar-items-db'
import { SCHEMA_DDL as INVENTION_SCHEMA_DDL } from '../../../../api/src/inventions-db'
// The notification-type ids the hub carries, from the worker that owns them — asserting
// against the enum rather than a copied number is what keeps these frames honest.
import { NotificationType } from '../../../../notify/src/notification-types'
// The catalog's two migrations and the captures the loader reads, imported so the tests at the
// bottom can check the schema they build against `CATALOG_SCHEMA_DDL`. `?raw` because they are
// SQL, not modules: they are never executed here, only read.
import catalogStructureSql from '../../../migrations/0015_catalog.sql?raw'
import catalogIdSql from '../../../migrations/0016_catalog_id.sql?raw'
import avatarItemsJson from '../../../static/db/avatar-items.json'
// The merged 2025 general store, read as a FILE: which file the route serves depends on the
// caller's build, and these assertions are about the file's CONTENTS.
import carriedItems from '../../../static/db/consumables.json'
import skinsJson from '../../../static/db/skins.json'
import questRewards from '../../../static/quest-rewards.json'
import sf32025 from '../../../static/storefronts/sf3-2025.json'
import sf3 from '../../../static/storefronts/sf3.json'
import { SCHEMA_DDL } from '../../avatar-db'
import {
	BALANCE_SCHEMA_DDL,
	CurrencyType,
	DEFAULT_STARTING_TOKENS,
	getBalance,
	spendCurrency,
} from '../../balance-db'
import {
	baseAsset,
	buildCatalogLoad,
	CATALOG_INSERT_COLUMNS,
	CATALOG_SCHEMA_DDL,
	CatalogKind,
	countCatalog,
	getAvatarItem,
	getAvatarItemsByTag,
	getCatalogItem,
	getCatalogItemById,
	getCatalogItems,
	getSkin,
	getSkinsForPrefab,
	searchCatalog,
	toCatalogSkin,
} from '../../catalog-db'
import { CATALOG_ID_BASE } from '../../catalog-load'
import { CHALLENGE_GIFT_SCHEMA_DDL, CHALLENGE_STATUS_SCHEMA_DDL } from '../../challenge-db'
// The live weekly rotation, generated the same way the worker generates it, so the challenge
// tests exercise whatever this week actually holds instead of ids from a rotation that has
// since rolled over.
import { buildRotation, rotationIndex, withWeeklyGift } from '../../challenge-rotation'
import { CONSUMABLE_SCHEMA_DDL, grantConsumable } from '../../consumables-db'
import { EQUIPMENT_SCHEMA_DDL, grantEquipment } from '../../equipment-db'
import { INVENTORY_SCHEMA_DDL } from '../../inventory-db'
import { REWARD_STATUS_SCHEMA_DDL } from '../../reward-db'

import type { CatalogLoadRow, CatalogRow, CatalogValue } from '../../catalog-db'
import type { Env } from '../../context'

/**
 * The GENERATED half of a store file — the items built from the item catalog, as opposed to the
 * equipment, consumables and boxes carried across from the 2023 capture.
 *
 * Split on membership in the CARRIED ids rather than on `CATALOG_ID_BASE`. The two happen to
 * agree now that the equipment skins are gone — the carried ids run 2168-2458, well below the
 * base — but they did not while a skin carried id 20756767, and asking the real question costs
 * nothing.
 */
const capturedIds = new Set(carriedItems.map((i) => i.PurchasableItemId))
const catalogItems = () => sf32025.StoreItems.filter((i) => !capturedIds.has(i.PurchasableItemId))

/**
 * An item ONLY the newer store sells — created after the cutoff, so it is in sf3-2025 and not in
 * sf3. The build gate is only observable through such an item: everything else is in both files
 * and buys identically either way.
 */
const sf3Ids = new Set(sf3.StoreItems.map((i) => i.PurchasableItemId))
const NEWER_ONLY = (() => {
	const item = sf32025.StoreItems.find((i) => !sf3Ids.has(i.PurchasableItemId))
	if (item === undefined) throw new Error('sf3-2025 sells nothing sf3 does not')
	return {
		id: item.PurchasableItemId,
		price: item.Prices[0]!.Price,
		name: item.GiftDrop.FriendlyName,
	}
})()

/**
 * Items the generated `sf3.json` sells, resolved FROM the file rather than hardcoded.
 *
 * sf3 used to be a capture with its own ids (73 = "Bowtie (White)" at 450); it is now generated
 * from the item catalog, so those ids are gone and the prices come from the rarity table. Looking
 * them up here means a regenerate — or a repriced tier — cannot leave these tests asserting
 * against items the store no longer sells.
 *
 * `atPrice` picks an AVATAR item at a given tier; the carried equipment/consumables/boxes keep
 * their captured ids and are still referenced by number where a test is about one of those.
 */
const sf3AvatarAtPrice = (price: number) => {
	const item = sf3.StoreItems.find(
		(i) => (i.GiftDrop.AvatarItemDesc ?? '') !== '' && i.Prices[0]?.Price === price
	)
	if (item === undefined) throw new Error(`sf3 sells no avatar item at ${price}`)
	return { id: item.PurchasableItemId, price, name: item.GiftDrop.FriendlyName }
}
/** A mid-priced item — the general "buy something" fixture. */
const SF3_ITEM = sf3AvatarAtPrice(600)
/** The cheapest tier, for the line-level price-mismatch assertions. */
const SF3_CHEAP = sf3AvatarAtPrice(150)

declare module 'cloudflare:test' {
	interface ProvidedEnv extends Env {}
}

const ORIGIN = 'https://example.com'

/** This week's rotation — the same one the worker builds for these requests. */
const weekly = buildRotation(new Date())

/** The first challenge of the live rotation — the progress tests report against it. */
const CURRENT_CHALLENGE = weekly.Challenges[0]

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
	for (const stmt of CUSTOM_AVATAR_ITEM_SCHEMA_DDL) await env.DB.prepare(stmt).run()
	for (const stmt of CATALOG_SCHEMA_DDL) await env.DB.prepare(stmt).run()
	// A few equipment skins, which is where the WEEKLY CHALLENGE gift pool comes from now that
	// skins are awarded rather than sold and no storefront lists one. Without these the pool is
	// empty and the week has nothing to be themed on.
	// Skipping the two the `catalog` block seeds by hand further down — `item_key` is the primary
	// key, so a second insert of either would fail rather than merge.
	const catalogBlockSeeds = new Set([
		'19ef59c7-f74b-4c63-935a-1d4b1abd8518',
		'bfrFOdnHzEaIwHqem2dXkg',
	])
	for (const [i, skin] of skinsJson
		.filter((sk) => !catalogBlockSeeds.has(sk.ModificationGuid))
		.slice(0, 8)
		.entries()) {
		await env.DB.prepare(
			`INSERT OR IGNORE INTO catalog
				(item_key, catalog_id, kind, friendly_name, tooltip, rarity, platform_mask, prefab_name)
			 VALUES (?1, ?2, 'skin', ?3, '', ?4, -1, ?5)`
		)
			.bind(skin.ModificationGuid, 70_001 + i, skin.FriendlyName, skin.Rarity, skin.PrefabName)
			.run()
	}
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
async function bearer(
	sub = '42',
	roles?: string[],
	/** The client build to stamp as `rn.ver` — omitted, like a token minted before the claim. */
	version?: string,
	/**
	 * Stamp `rn.plus`, as auth does for an account with `hasPlus`. This is the ONLY thing
	 * that makes a caller a Rec Room Plus subscriber — the `developer` role does not — so
	 * every subscriber-priced test passes it.
	 */
	plus = false
): Promise<Record<string, string>> {
	const now = Math.floor(Date.now() / 1000)
	const claims: Record<string, unknown> = { sub, exp: now + 3600 }
	if (roles !== undefined) claims.role = roles
	if (version !== undefined) claims['rn.ver'] = version
	// Omitted when false, exactly as generateToken omits it — so these tokens match the
	// shape of a real non-subscriber's.
	if (plus) claims['rn.plus'] = true
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

	test('GET /api/itemWishlists/v1/wishlist/:accountId 401s without a token, returns []', async () => {
		const anon = await exports.default.fetch(`${ORIGIN}/api/itemWishlists/v1/wishlist/207`)
		expect(anon.status).toBe(401)

		const res = await exports.default.fetch(`${ORIGIN}/api/itemWishlists/v1/wishlist/207`, {
			headers: await bearer(),
		})
		expect(res.status).toBe(200)
		expect(await res.json()).toEqual([])

		// `me` is still its own route, not read as an account id.
		const mine = await exports.default.fetch(`${ORIGIN}/api/itemWishlists/v1/wishlist/me`, {
			headers: await bearer(),
		})
		expect(mine.status).toBe(200)
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
			'/api/ugcPurchasables/v1/items/room/92',
		]) {
			const res = await exports.default.fetch(`${ORIGIN}${path}`)
			expect(res.status, path).toBe(200)
			expect(await res.json(), path).toEqual([])
		}
	})

	test('POST /api/ugcPurchasables/v1/items/bulk resolves custom avatar items, echoing RoomId', async () => {
		const item = await createCustomAvatarItem(env.DB, {
			customAvatarItemId: crypto.randomUUID(),
			creatorAccountId: 205,
			name: 'Neon Visor',
			description: '',
			price: 250,
			baseAvatarItemId: 1,
			baseAvatarItemColor: '#fff',
			accessibility: 0,
			designFilename: 'design_x.bin',
			thumbnailImageFilename: 'thumb_x.png',
		})
		const res = await exports.default.fetch(`${ORIGIN}/api/ugcPurchasables/v1/items/bulk`, {
			method: 'POST',
			headers: { ...(await bearer()), 'content-type': 'application/json' },
			body: JSON.stringify({
				RoomId: 92,
				Ids: [
					{ itemType: 3, itemId: item.CustomAvatarItemId },
					{ itemType: 3, itemId: 'does-not-exist' },
					{ itemType: 1, itemId: item.CustomAvatarItemId },
				],
			}),
		})
		expect(res.status).toBe(200)
		expect(await res.json()).toEqual([
			{
				ItemType: 3,
				ItemId: item.CustomAvatarItemId,
				Name: 'Neon Visor',
				Description: '',
				ImageName: 'thumb_x.png',
				RoomId: 92,
				Price: 250,
				PurchaseCurrencyId: null,
				CreatedAt: item.CreatedAt,
				ModifiedAt: item.ModifiedAt,
			},
		])
	})

	test('POST /api/ugcPurchasables/v1/items/bulk 400s without Ids and 401s without a token', async () => {
		const bad = await exports.default.fetch(`${ORIGIN}/api/ugcPurchasables/v1/items/bulk`, {
			method: 'POST',
			headers: { ...(await bearer()), 'content-type': 'application/json' },
			body: JSON.stringify({ RoomId: 92 }),
		})
		expect(bad.status).toBe(400)
		const anon = await exports.default.fetch(`${ORIGIN}/api/ugcPurchasables/v1/items/bulk`, {
			method: 'POST',
			headers: { 'content-type': 'application/json' },
			body: JSON.stringify({ RoomId: 92, Ids: [] }),
		})
		expect(anon.status).toBe(401)
	})

	test('bulkpurchase buys a merged-store catalog item from storefront 3', async () => {
		// The exact request the client sends, verbatim: a catalog id under storefront 3, which is
		// what the merged sf3-2025 lists it as. It resolves because `loadStorefront` picks the file
		// by the caller's build, so what the store page offered is what the purchase is checked
		// against.
		const res = await exports.default.fetch(`${ORIGIN}/api/items/bulkpurchase`, {
			method: 'POST',
			headers: {
				...((await bearer('4801', undefined, '20250718.01')) as Record<string, string>),
				'Content-Type': 'application/json',
			},
			body: JSON.stringify({
				PurchaseItemRequests: [
					{
						ItemPurchaseMethodId: { Type: 0, NumberId: NEWER_ONLY.id, Guid: null },
						RequestedPrice: NEWER_ONLY.price,
						Gift: null,
						CouponConsumablePlayerMappingId: null,
						DuplicateItemCount: 1,
					},
				],
				StorefrontType: 3,
				CurrencyType: 2,
				BypassGiftPackages: false,
				AllowPartialSuccess: true,
				ShoppingBagId: null,
			}),
		})
		expect(res.status).toBe(200)
		const body = (await res.json()) as {
			Success: boolean
			Error: string
			Value: { Balance: number } | null
		}
		// It used to answer `{ Success: false, Error: "Item not found" }` — storefront 3 resolved
		// to the captured sf3, which has no id in the catalog range.
		expect(body.Error).not.toBe('Item not found')
		expect(body.Success).toBe(true)

		// The price the client posts is the one the file lists, because the file it browsed and the
		// purchase it made are priced from the same shared rarity table. A second pricing anywhere
		// would 409 every purchase as "Price has changed".
		const item = sf32025.StoreItems.find((i) => i.PurchasableItemId === NEWER_ONLY.id)
		expect(item?.Prices[0]?.Price).toBe(NEWER_ONLY.price)

		// The SAME request from an old build still fails: its storefront 3 is generated to the
		// cutoff, and this item postdates it.
		const legacy = await exports.default.fetch(`${ORIGIN}/api/items/bulkpurchase`, {
			method: 'POST',
			headers: {
				...((await bearer('4802', undefined, '20230414')) as Record<string, string>),
				'Content-Type': 'application/json',
			},
			body: JSON.stringify({
				PurchaseItemRequests: [
					{
						ItemPurchaseMethodId: { Type: 0, NumberId: NEWER_ONLY.id, Guid: null },
						RequestedPrice: NEWER_ONLY.price,
						DuplicateItemCount: 1,
					},
				],
				StorefrontType: 3,
				CurrencyType: 2,
				AllowPartialSuccess: true,
			}),
		})
		expect(((await legacy.json()) as { Success: boolean }).Success).toBe(false)
	})

	test('bulkpurchase resolves catalog ids for newer builds, at the storefront’s price', async () => {
		// A catalog row the generated storefront would list at 600 (rarity 10), bought straight off
		// the `catalog` table; plus a skin and a developer-tier row, neither of which may be.
		const AVATAR_ID = 20_001
		const SKIN_ID = 20_002
		const DEV_ID = 20_003
		await env.DB.prepare(
			`INSERT INTO catalog (item_key, catalog_id, kind, friendly_name, tooltip, rarity, platform_mask, avatar_item_type)
			 VALUES ('bulk-buy-desc,,,', ?1, 'avatar_item', 'Bulk Buy Hat', '', 10, -1, 0)`
		)
			.bind(AVATAR_ID)
			.run()
		await env.DB.prepare(
			`INSERT INTO catalog (item_key, catalog_id, kind, friendly_name, tooltip, rarity, platform_mask, prefab_name)
			 VALUES ('bulk-buy-guid', ?1, 'skin', 'Bulk Buy Skin', '', 0, -1, '[MakerPen]')`
		)
			.bind(SKIN_ID)
			.run()
		// Rarity -1 is the developer tier: in the catalog, absent from the storefront, and so not
		// for sale here either — resolving straight off the table must not sell what the store
		// never offered.
		await env.DB.prepare(
			`INSERT INTO catalog (item_key, catalog_id, kind, friendly_name, tooltip, rarity, platform_mask, avatar_item_type)
			 VALUES ('bulk-buy-dev,,,', ?1, 'avatar_item', 'Bulk Buy Dev Item', '', -1, -1, 0)`
		)
			.bind(DEV_ID)
			.run()

		const buy = async (
			version: string | undefined,
			lines: Array<{ id: number; price: number }>,
			sub = '46'
		) =>
			exports.default.fetch(`${ORIGIN}/api/items/bulkpurchase`, {
				method: 'POST',
				headers: {
					...((await bearer(sub, undefined, version)) as Record<string, string>),
					'Content-Type': 'application/json',
				},
				body: JSON.stringify({
					StorefrontType: 3,
					CurrencyType: 2,
					AllowPartialSuccess: false,
					PurchaseItemRequests: lines.map((l) => ({
						ItemPurchaseMethodId: { Type: 0, NumberId: l.id, Guid: null },
						RequestedPrice: l.price,
					})),
				}),
			})

		// 600 (rarity 10) is the generated storefront's own price. It MUST match: `priceCheck`
		// refuses a line whose posted price differs, so a server pricing a buy differently from the
		// file it listed would 409 every purchase.
		const res = await buy('20250718.01', [{ id: AVATAR_ID, price: 600 }])
		expect(res.status).toBe(200)
		const body = (await res.json()) as { Success: boolean; Value: { Balance: number } | null }
		expect(body.Success).toBe(true)

		// A SKIN is refused even though the catalog holds it: skins are awarded from weekly
		// challenges rather than sold, so no storefront lists one and the bag will not resolve one
		// off the table either.
		const skin = await buy('20250718.01', [{ id: SKIN_ID, price: 150 }])
		expect(((await skin.json()) as { Success: boolean }).Success).toBe(false)

		// A price the storefront does not list is refused, not quietly charged.
		const wrongPrice = await buy('20250718.01', [{ id: AVATAR_ID, price: 1 }])
		expect(((await wrongPrice.json()) as { Success: boolean }).Success).toBe(false)

		// The developer-tier row is not for sale.
		const dev = await buy('20250718.01', [{ id: DEV_ID, price: 150 }])
		expect(((await dev.json()) as { Success: boolean }).Success).toBe(false)

		// An OLD build is left resolving exactly what it always did — the storefront file — so a
		// catalog id means nothing to it. Nothing offers those ids to that build anyway.
		const legacy = await buy('20230414', [{ id: AVATAR_ID, price: 600 }])
		expect(((await legacy.json()) as { Success: boolean }).Success).toBe(false)
		const unversioned = await buy(undefined, [{ id: AVATAR_ID, price: 600 }])
		expect(((await unversioned.json()) as { Success: boolean }).Success).toBe(false)

		// A bag may MIX an item the STOREFRONT FILE lists with one resolved straight off the
		// `catalog` table.
		const mixed = await buy('20250718.01', [
			{ id: SF3_ITEM.id, price: SF3_ITEM.price },
			{ id: AVATAR_ID, price: 600 },
		])
		expect(((await mixed.json()) as { Success: boolean }).Success).toBe(true)

		// Cleaned up: the `catalog` block below counts every row in the table, so rows left behind
		// here would change what it sees.
		await env.DB.prepare('DELETE FROM catalog WHERE catalog_id BETWEEN ?1 AND ?2')
			.bind(AVATAR_ID, DEV_ID)
			.run()
	})

	test('lockeditems/bulk filters by exact AvatarItemDesc, in catalogue order', async () => {
		const ask = async (
			descs: unknown
		): Promise<Array<{ AvatarItemDesc: string; FriendlyName: string }>> => {
			const res = await exports.default.fetch(`${ORIGIN}/api/avatar/v1/lockeditems/bulk`, {
				method: 'POST',
				headers: { 'content-type': 'application/json' },
				body: JSON.stringify(descs === undefined ? {} : { AvatarItemDescriptions: descs }),
			})
			expect(res.status).toBe(200)
			return (await res.json()) as Array<{ AvatarItemDesc: string; FriendlyName: string }>
		}

		// Three real catalogue entries, deliberately asked for OUT of catalogue order.
		const [first, second, third] = [
			avatarItemsJson[0]!,
			avatarItemsJson[40]!,
			avatarItemsJson[900]!,
		]

		const got = await ask([third.AvatarItemDesc, first.AvatarItemDesc, second.AvatarItemDesc])
		expect(got).toHaveLength(3)
		// In CATALOGUE order, not request order: the reference's filter walks the catalogue, so
		// the response must never be read positionally against what was asked for.
		expect(got.map((i) => i.AvatarItemDesc)).toEqual([
			first.AvatarItemDesc,
			second.AvatarItemDesc,
			third.AvatarItemDesc,
		])

		// The match is the WHOLE desc, not the base asset: asking for a plain base does not drag
		// in every colourway built on it.
		const one = await ask([first.AvatarItemDesc])
		expect(one).toHaveLength(1)
		expect(one[0]?.AvatarItemDesc).toBe(first.AvatarItemDesc)

		// A miss is not an error: unknown descs are absent and do not cost the caller the batch.
		expect(
			(await ask(['no-such-desc,,,', first.AvatarItemDesc])).map((i) => i.AvatarItemDesc)
		).toEqual([first.AvatarItemDesc])
		expect(await ask(['no-such-desc,,,'])).toEqual([])

		// EMPTY or absent means the WHOLE catalogue — the reference's "give me everything" case,
		// not a degenerate match-nothing.
		expect(await ask([])).toHaveLength(avatarItemsJson.length)
		expect(await ask(undefined)).toHaveLength(avatarItemsJson.length)

		// No auth needed, and a body that will not parse falls back to the catalogue rather than
		// erroring.
		const junk = await exports.default.fetch(`${ORIGIN}/api/avatar/v1/lockeditems/bulk`, {
			method: 'POST',
			headers: { 'content-type': 'application/json' },
			body: 'not json',
		})
		expect(junk.status).toBe(200)
		expect(((await junk.json()) as unknown[]).length).toBe(avatarItemsJson.length)
	})

	test('POST /api/items/purchaseInfos prices custom avatar items in tokens', async () => {
		const item = await createCustomAvatarItem(env.DB, {
			customAvatarItemId: crypto.randomUUID(),
			creatorAccountId: 206,
			name: 'Chrome Jacket',
			description: '',
			price: 425,
			baseAvatarItemId: 1,
			baseAvatarItemColor: '#000',
			designFilename: 'design_pi.bin',
			thumbnailImageFilename: 'thumb_pi.png',
			accessibility: 1,
		})
		const res = await exports.default.fetch(`${ORIGIN}/api/items/purchaseInfos`, {
			method: 'POST',
			headers: { ...(await bearer()), 'content-type': 'application/json' },
			body: JSON.stringify({
				Ids: [
					{ itemType: 3, itemId: item.CustomAvatarItemId },
					// Dropped, both of them: an id nothing owns, and a type this doesn't serve. The
					// response is one entry per RESOLVED id, so it is SHORTER than `Ids` rather than
					// carrying a null in their places — the client must not read it positionally.
					{ itemType: 3, itemId: crypto.randomUUID() },
					{ itemType: 1, itemId: item.CustomAvatarItemId },
				],
			}),
		})
		expect(res.status).toBe(200)
		expect(await res.json()).toEqual([
			{
				// The reference echoed back verbatim: camelCase members under a PascalCase key. The
				// client names them that way on both legs and PascalCasing them here loses the id.
				ItemId: { itemType: 3, itemId: item.CustomAvatarItemId },
				// A UGC listing is keyed by guid, so `Type` 1 and `NumberId` null. A storefront's
				// numbered `PurchasableItemId` would be the other side of the union.
				PurchaseMethodId: { Type: 1, NumberId: null, Guid: item.CustomAvatarItemId },
				// RecCenterTokens (2) — the currency the creation UI's price floor is denominated
				// in, and the one the client actually holds a balance in. A room currency (300)
				// would draw a price nothing can pay.
				Prices: [
					{
						CurrencyType: 2,
						Price: 425,
						StorefrontSaleData: { SalePercent: 0, SaleStartDate: null, SaleEndDate: null },
					},
				],
				NewUntil: null,
				AvailableAt: item.CreatedAt,
				AvailableUntil: null,
				CanBeGifted: true,
				CanApplySubscriberDiscount: false,
				SubscribersOnly: false,
				IsFeatured: false,
			},
		])
	})

	test('POST /api/items/purchaseInfos 400s without Ids and 401s without a token', async () => {
		const bad = await exports.default.fetch(`${ORIGIN}/api/items/purchaseInfos`, {
			method: 'POST',
			headers: { ...(await bearer()), 'content-type': 'application/json' },
			body: JSON.stringify({}),
		})
		expect(bad.status).toBe(400)
		const anon = await exports.default.fetch(`${ORIGIN}/api/items/purchaseInfos`, {
			method: 'POST',
			headers: { 'content-type': 'application/json' },
			body: JSON.stringify({ Ids: [] }),
		})
		expect(anon.status).toBe(401)
	})

	test('GET /econ/roomEconConfig/:roomId echoes the room and disables sorting tabs', async () => {
		const anon = await exports.default.fetch(`${ORIGIN}/econ/roomEconConfig/92`)
		expect(anon.status).toBe(401)

		const res = await exports.default.fetch(`${ORIGIN}/econ/roomEconConfig/92`, {
			headers: await bearer(),
		})
		expect(res.status).toBe(200)
		expect(await res.json()).toEqual({ RoomId: 92, EnableSortingTabs: false })

		const bad = await exports.default.fetch(`${ORIGIN}/econ/roomEconConfig/nope`, {
			headers: await bearer(),
		})
		expect(bad.status).toBe(400)
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

	// TEMPORARY, alongside the probe in `econ.app.ts`: the storefront ids are swapped so it can
	// be seen from the client which one the 2025 store actually reads. Delete this with the
	// probe.
	test('storefront 3 serves sf3 to old builds and the merged sf3-2025 to newer ones', async () => {
		const store = async (headers: Record<string, string>) => {
			const res = await exports.default.fetch(`${ORIGIN}/api/storefronts/v3/giftdropstore/3`, {
				headers,
			})
			expect(res.status).toBe(200)
			return (await res.json()) as { StorefrontType: number; StoreItems: unknown[] }
		}
		const at = async (version: string) =>
			(await bearer('42', undefined, version)) as Record<string, string>

		// 20230414 is GAME_VERSION — what the rest of the stack targets — so the cutoff is
		// INCLUSIVE and that build keeps the captured sf3 exactly as it has always had it.
		const legacy = await store(await at('20230414'))
		expect(legacy.StoreItems).toHaveLength(sf3.StoreItems.length)
		// A same-day rebuild sorts by its DATE, not the `.NN` suffix.
		expect((await store(await at('20230414.02'))).StoreItems).toHaveLength(sf3.StoreItems.length)

		// A caller with no readable build gets the captured file too: an unversioned token is the
		// OLD client, so treating "can't prove its version" as "newer" would swap the store out
		// from under the build that needs it.
		expect((await store({})).StoreItems).toHaveLength(sf3.StoreItems.length)
		expect((await store(await bearer())).StoreItems).toHaveLength(sf3.StoreItems.length)
		expect((await store(await at('not-a-build'))).StoreItems).toHaveLength(sf3.StoreItems.length)

		// Later builds get the merged store — bigger than either half, and still storefront 3.
		for (const version of ['20230616', '20250424.01', '20250718.01']) {
			const merged = await store(await at(version))
			expect(merged.StorefrontType, version).toBe(3)
			expect(merged.StoreItems.length, version).toBe(sf32025.StoreItems.length)
			expect(merged.StoreItems.length, version).toBeGreaterThan(sf3.StoreItems.length)
		}

		// The id does not change and nothing is renumbered: sf3's own items are in the merged file
		// unchanged, so a newer client buying one is charged the same as an older client would be.
		const bowtie = await exports.default.fetch(`${ORIGIN}/api/storefronts/v2/buyItem`, {
			method: 'POST',
			headers: { ...(await at('20250718.01')), 'Content-Type': 'application/json' },
			body: JSON.stringify({
				StorefrontType: 3,
				PurchasableItemId: SF3_ITEM.id, // an avatar item the generated sf3 sells
				CurrencyType: 2,
				RequestedPrice: SF3_ITEM.price,
			}),
		})
		expect(bowtie.status).toBe(200)

		// And a CATALOG item can be bought from storefront 3 by a newer build — the half a
		// listing-only swap breaks. `findStoreItem` resolves the purchase through the same
		// build-aware path the listing does, so an item on the page is an item that can be bought.
		// From the catalog half — see `catalogItems`, which is why this is not an id comparison.
		const catalogItem = sf32025.StoreItems.find((i) => i.PurchasableItemId === NEWER_ONLY.id)
		expect(catalogItem).toBeDefined()
		const bought = await exports.default.fetch(`${ORIGIN}/api/storefronts/v2/buyItem`, {
			method: 'POST',
			headers: { ...(await at('20250718.01')), 'Content-Type': 'application/json' },
			body: JSON.stringify({
				StorefrontType: 3,
				PurchasableItemId: catalogItem!.PurchasableItemId,
				CurrencyType: 2,
				RequestedPrice: catalogItem!.Prices[0]!.Price,
			}),
		})
		expect(bought.status).toBe(200)

		// The SAME item is not for sale to an old build: it postdates the cutoff, so sf3 — which
		// is generated to that date — does not list it.
		const refused = await exports.default.fetch(`${ORIGIN}/api/storefronts/v2/buyItem`, {
			method: 'POST',
			headers: { ...(await at('20230414')), 'Content-Type': 'application/json' },
			body: JSON.stringify({
				StorefrontType: 3,
				PurchasableItemId: catalogItem!.PurchasableItemId,
				CurrencyType: 2,
				RequestedPrice: catalogItem!.Prices[0]!.Price,
			}),
		})
		expect(refused.status).toBe(404)
	})

	test('sf3 and sf3-2025 are the same store at two points in time', async () => {
		// BOTH are generated from the item catalog now — sf3 is no longer a capture. They report
		// the same storefront id, because they are two versions of ONE store and the client asks
		// for 3 either way.
		expect(sf3.StorefrontType).toBe(3)
		expect(sf32025.StorefrontType).toBe(3)

		// sf3 is a strict SUBSET of sf3-2025: same items, same ids, same prices — it just stops at
		// the cutoff. Anything else would mean a player's store changed under them on upgrade.
		const newer = new Map(sf32025.StoreItems.map((i) => [i.PurchasableItemId, i]))
		for (const item of sf3.StoreItems) {
			expect(newer.get(item.PurchasableItemId), String(item.PurchasableItemId)).toEqual(item)
		}
		expect(sf3.StoreItems.length).toBeLessThan(sf32025.StoreItems.length)

		// Ids are unique within each file. The merge of carried and generated halves is only safe
		// because their id spaces don't overlap, so a collision must fail rather than be resolved
		// by array order.
		for (const [label, file] of [
			['sf3', sf3],
			['sf3-2025', sf32025],
		] as const) {
			const ids = file.StoreItems.map((i) => i.PurchasableItemId)
			expect(new Set(ids).size, label).toBe(ids.length)
		}

		// The discount is expressed ONLY in `SubscriberPrices`; announcing it again at the top
		// level risks a client taking 10% off an already-discounted price and posting through the
		// server's own subscriber floor, refused as "Price has changed".
		expect(sf3.SubscriberDiscountPercent).toBe(0)
		expect(sf32025.SubscriberDiscountPercent).toBe(0)

		// Every GENERATED item is priced from its rarity, and rarity -1 (the developer tier) is
		// excluded rather than priced — an item listed here can be bought.
		const priceByRarity = new Map([
			[0, 150],
			[10, 600],
			[20, 700],
			[30, 800],
			[50, 3000],
		])
		for (const item of catalogItems()) {
			const expected = priceByRarity.get(item.GiftDrop.Rarity)
			expect(expected, `rarity ${item.GiftDrop.Rarity}`).toBeDefined()
			expect(item.Prices[0]).toMatchObject({ CurrencyType: 2, Price: expected })
			// Floored, matching the server's own `subscriberFloor`.
			expect(item.SubscriberPrices[0]).toMatchObject({
				CurrencyType: 2,
				Price: Math.floor((expected! * 90) / 100),
			})
			// `GiftDropId` echoes the id, as the capture did on all 1161 of its items.
			expect(item.GiftDrop.GiftDropId).toBe(item.PurchasableItemId)
			expect(item.PurchasableItemId).toBeGreaterThanOrEqual(CATALOG_ID_BASE)
		}
		expect(catalogItems().filter((i) => i.GiftDrop.Rarity === -1)).toEqual([])

		// The CARRIED half — 30 consumables and 5 random boxes — comes from
		// `static/db/consumables.json`, what survives of the 2023 capture. The item catalog does
		// not model these, so they keep their own ids and prices.
		const carried = sf3.StoreItems.filter((i) => capturedIds.has(i.PurchasableItemId))
		expect(carried.length).toBeGreaterThan(0)
		expect(carried.every((i) => (i.GiftDrop.AvatarItemDesc ?? '') === '')).toBe(true)

		// And NO equipment skins anywhere in either file: they are awarded from weekly challenges,
		// so a store listing one would sell something the game gives away.
		for (const [label, file] of [
			['sf3', sf3],
			['sf3-2025', sf32025],
		] as const) {
			expect(
				file.StoreItems.filter((i) => (i.GiftDrop.EquipmentModificationGuid ?? '') !== ''),
				label
			).toEqual([])
		}

		// An id with no storefront still 404s, and 1704 is gone — it was a stand-in for a store
		// that turned out to belong inside sf3.
		for (const id of [1705, 1704]) {
			const res = await exports.default.fetch(`${ORIGIN}/api/storefronts/v3/giftdropstore/${id}`)
			expect(res.status, String(id)).toBe(404)
		}
	})

	// Item 73 in sf3.json — "Bowtie (White)", 450 RecCenterTokens (CurrencyType 2).
	test('POST /api/storefronts/v2/buyItem 401s without a token', async () => {
		const res = await exports.default.fetch(`${ORIGIN}/api/storefronts/v2/buyItem`, {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({
				StorefrontType: 3,
				PurchasableItemId: SF3_ITEM.id,
				CurrencyType: 2,
				RequestedPrice: SF3_ITEM.price,
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
				PurchasableItemId: SF3_ITEM.id,
				CurrencyType: 2,
				RequestedPrice: SF3_ITEM.price,
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
		expect(body.Balance).toBe(-SF3_ITEM.price)
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
					Delta: -SF3_ITEM.price,
					Balance: DEFAULT_STARTING_TOKENS - SF3_ITEM.price,
					Platform: -2,
					CurrencyType: 2,
				},
			},
		])

		// The balance endpoint reflects the debit (this is the resulting total, 10000 - 450).
		const bal = await exports.default.fetch(`${ORIGIN}/api/storefronts/v4/balance/2`, {
			headers: await bearer('20'),
		})
		expect(await bal.json()).toEqual([
			{ CurrencyType: 2, Platform: -2, Balance: DEFAULT_STARTING_TOKENS - SF3_ITEM.price },
		])

		// The item is now owned — it leads the v4/items list (owned items prepend the catalog).
		const items = await exports.default.fetch(`${ORIGIN}/api/avatar/v4/items`, {
			headers: await bearer('20'),
		})
		const list = (await items.json()) as Array<{ avatarItemDesc: string; friendlyName: string }>
		expect(list[0].friendlyName).toBe(SF3_ITEM.name)
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

	// The equipment-purchase test that lived here is gone: skins are awarded from weekly
	// challenges rather than sold, so no storefront lists one and the bulk bag will not resolve
	// one off the catalog either. Equipment GRANTING is still covered — the weekly challenge
	// reward path grants a skin and reads it back through `getUnlocked`.

	test('POST /api/equipment/v1/update favourites from the client’s own body', async () => {
		// The body verbatim as the client sends it — a full echo of the entry it was served,
		// of which only `Favorited` is read.
		const post = async (favorited: boolean, sub = '33') =>
			exports.default.fetch(`${ORIGIN}/api/equipment/v1/update`, {
				method: 'POST',
				headers: { ...(await bearer(sub)), 'Content-Type': 'application/json' },
				body: JSON.stringify([
					{
						PrefabName: '[ShareCamera]',
						ModificationGuid: 'g5u0weNLmkCLeUXFUVn74Q',
						FriendlyName: 'Camera Skin (Comic)',
						Tooltip: 'ShareCamera Comic Debug: 2121',
						Rarity: 5,
						Favorited: favorited,
					},
				]),
			})

		// Nothing owned yet: the guid matches no row, so this is a silent no-op, not an error.
		expect((await post(true)).status).toBe(200)

		await grantEquipment(env.DB, 33, {
			PrefabName: '[ShareCamera]',
			ModificationGuid: 'g5u0weNLmkCLeUXFUVn74Q',
			FriendlyName: 'Camera Skin (Comic)',
			Tooltip: 'ShareCamera Comic Debug: 2121',
			Rarity: 5,
			PlatformMask: -1,
			Favorited: false,
		})
		const owned = async () => {
			const res = await exports.default.fetch(`${ORIGIN}/api/equipment/v2/getUnlocked`, {
				headers: await bearer('33'),
			})
			return (await res.json()) as Array<{ ModificationGuid: string; Favorited: boolean }>
		}
		expect((await owned())[0]?.Favorited).toBe(false)

		expect((await post(true)).status).toBe(200)
		expect((await owned())[0]?.Favorited).toBe(true)
		expect((await post(false)).status).toBe(200)
		expect((await owned())[0]?.Favorited).toBe(false)
	})

	test('equipment/v1/update 401s without a token, 400s on a non-array body (PUT and POST)', async () => {
		for (const method of ['PUT', 'POST'] as const) {
			const anon = await exports.default.fetch(`${ORIGIN}/api/equipment/v1/update`, {
				method,
				headers: { 'Content-Type': 'application/json' },
				body: '[]',
			})
			expect(anon.status).toBe(401)

			const bad = await exports.default.fetch(`${ORIGIN}/api/equipment/v1/update`, {
				method,
				headers: { ...(await bearer('32')), 'Content-Type': 'application/json' },
				body: '{}',
			})
			expect(bad.status).toBe(400)
		}
	})

	test('POST /api/storefronts/v2/buyItem 409s when the sent price no longer matches', async () => {
		const res = await exports.default.fetch(`${ORIGIN}/api/storefronts/v2/buyItem`, {
			method: 'POST',
			headers: { ...(await bearer('21')), 'Content-Type': 'application/json' },
			body: JSON.stringify({
				StorefrontType: 3,
				PurchasableItemId: SF3_ITEM.id,
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

	// sf300's item 2263 is 95 tokens in `Prices` and 85 in `SubscriberPrices`. A subscriber's
	// client applies the Plus discount itself, but not to every item, so the server takes any
	// price in the band [85, 95] from a subscriber and charges what they asked to pay.
	const buy2263 = async (headers: Record<string, string>, RequestedPrice: number) =>
		exports.default.fetch(`${ORIGIN}/api/storefronts/v2/buyItem`, {
			method: 'POST',
			headers: { ...headers, 'Content-Type': 'application/json' },
			body: JSON.stringify({
				StorefrontType: 300,
				PurchasableItemId: 2263,
				CurrencyType: 2,
				RequestedPrice,
				CouponConsumablePlayerMappingId: null,
				Gift: null,
			}),
		})

	test('POST /api/storefronts/v2/buyItem charges a subscriber the SubscriberPrices entry', async () => {
		await drainFrames()
		const res = await buy2263(await bearer('322', ['gameClient'], undefined, true), 85)
		expect(res.status).toBe(200)
		expect(((await res.json()) as { Balance: number }).Balance).toBe(-85)
		const bal = await exports.default.fetch(`${ORIGIN}/api/storefronts/v4/balance/2`, {
			headers: await bearer('322'),
		})
		expect(await bal.json()).toEqual([{ CurrencyType: 2, Platform: -2, Balance: 10000 - 85 }])
	})

	test('POST /api/storefronts/v2/buyItem takes 10% off from a subscriber when the catalog lists no discount', async () => {
		// sf3's item 2184 is 95 in BOTH lists, but a subscriber's client may still post
		// floor(95 * 0.9) = 85.
		const res = await exports.default.fetch(`${ORIGIN}/api/storefronts/v2/buyItem`, {
			method: 'POST',
			headers: {
				...(await bearer('325', ['gameClient'], undefined, true)),
				'Content-Type': 'application/json',
			},
			body: JSON.stringify({
				StorefrontType: 3,
				PurchasableItemId: 2184,
				CurrencyType: 2,
				RequestedPrice: 85,
				CouponConsumablePlayerMappingId: null,
				Gift: null,
			}),
		})
		expect(res.status).toBe(200)
		expect(((await res.json()) as { Balance: number }).Balance).toBe(-85)
	})

	test('POST /api/storefronts/v2/buyItem charges a subscriber the full price when their client sends it', async () => {
		// sf3's item 2208 is 150 in both lists and the live client posts 150 for a subscriber:
		// not every item is discounted, so the full price has to stay buyable by a subscriber.
		const res = await exports.default.fetch(`${ORIGIN}/api/storefronts/v2/buyItem`, {
			method: 'POST',
			headers: {
				...(await bearer('326', ['gameClient'], undefined, true)),
				'Content-Type': 'application/json',
			},
			body: JSON.stringify({
				StorefrontType: 3,
				PurchasableItemId: 2208,
				CurrencyType: 2,
				RequestedPrice: 150,
				CouponConsumablePlayerMappingId: null,
				Gift: null,
			}),
		})
		expect(res.status).toBe(200)
		expect(((await res.json()) as { Balance: number }).Balance).toBe(-150)
		const bal = await exports.default.fetch(`${ORIGIN}/api/storefronts/v4/balance/2`, {
			headers: await bearer('326'),
		})
		expect(await bal.json()).toEqual([{ CurrencyType: 2, Platform: -2, Balance: 10000 - 150 }])
	})

	test('POST /api/storefronts/v2/buyItem 409s a subscriber below the discount band', async () => {
		const res = await buy2263(await bearer('323', ['gameClient'], undefined, true), 84)
		expect(res.status).toBe(409)
		// …and above it: a made-up price is a mismatch in either direction.
		const over = await buy2263(await bearer('323', ['gameClient'], undefined, true), 96)
		expect(over.status).toBe(409)
	})

	test('POST /api/storefronts/v2/buyItem 409s a non-subscriber posting the subscriber price', async () => {
		const res = await buy2263(await bearer('324'), 85)
		expect(res.status).toBe(409)
		const ok = await buy2263(await bearer('324'), 95)
		expect(ok.status).toBe(200)
	})

	/** Seed a real account row, so a gift naming this player has somewhere to land. */
	const seedAccount = async (accountId: number, username: string) => {
		await env.DB.prepare('INSERT OR IGNORE INTO account (data) VALUES (?1)')
			.bind(JSON.stringify({ accountId, username, displayName: username }))
			.run()
	}

	/**
	 * Buy one sf3 item with a `Gift` block, as the client posts it. This used to buy an equipment
	 * skin; skins are awarded from weekly challenges rather than sold, so the store no longer
	 * lists one and these tests use an ordinary avatar item — they are about GIFTING either way.
	 */
	const giftBackpack = async (sub: string, gift: Record<string, unknown> | null) =>
		exports.default.fetch(`${ORIGIN}/api/storefronts/v2/buyItem`, {
			method: 'POST',
			headers: { ...(await bearer(sub)), 'Content-Type': 'application/json' },
			body: JSON.stringify({
				StorefrontType: 3,
				PurchasableItemId: SF3_ITEM.id,
				CurrencyType: 2,
				RequestedPrice: SF3_ITEM.price,
				CouponConsumablePlayerMappingId: null,
				Gift: gift,
			}),
		})

	const pendingGifts = async (sub: string) => {
		const res = await exports.default.fetch(`${ORIGIN}/api/avatar/v2/gifts`, {
			headers: await bearer(sub),
		})
		expect(res.status).toBe(200)
		return (await res.json()) as Array<Record<string, unknown>>
	}

	test('POST /api/storefronts/v2/buyItem charges the buyer and hands the item to the gift’s receiver', async () => {
		await seedAccount(205, 'GiftReceiver')
		await drainFrames()
		const res = await giftBackpack('330', {
			ToPlayerId: 205,
			Message: 'hello this is a message',
			Anonymous: false,
			GiftContext: 500,
		})
		expect(res.status).toBe(200)
		// The buyer pays — `Balance` is their change — even though nothing lands on them.
		expect(((await res.json()) as { Balance: number }).Balance).toBe(-SF3_ITEM.price)
		const bal = await exports.default.fetch(`${ORIGIN}/api/storefronts/v4/balance/2`, {
			headers: await bearer('330'),
		})
		expect(await bal.json()).toEqual([
			{ CurrencyType: 2, Platform: -2, Balance: DEFAULT_STARTING_TOKENS - SF3_ITEM.price },
		])

		// The item and its box are the RECEIVER's; the buyer keeps neither. An avatar item lands
		// in the inventory rather than the equipment list — `v4/items` leads with what is owned.
		expect(await pendingGifts('330')).toEqual([])
		const ownedBy = async (sub: string) => {
			const res = await exports.default.fetch(`${ORIGIN}/api/avatar/v4/items`, {
				headers: await bearer(sub),
			})
			return (await res.json()) as Array<{ avatarItemDesc: string; friendlyName: string }>
		}
		expect((await ownedBy('330'))[0]?.friendlyName).not.toBe(SF3_ITEM.name)
		expect((await ownedBy('205'))[0]?.friendlyName).toBe(SF3_ITEM.name)
		const [gift, ...others] = await pendingGifts('205')
		expect(others).toEqual([])
		// The box outlives the request, so it carries who sent it and why — the receiver may
		// only ever meet it in this list.
		expect(gift?.FromPlayerId).toBe(330)
		expect(gift?.GiftContext).toBe(500)
		expect(gift?.Message).toBe('hello this is a message')

		// The receiver has no response to read, so the box is pushed to them.
		const frames = await drainFrames()
		const received = frames.find(
			(f) => f.notificationType === NotificationType.GiftPackageReceivedImmediate
		)
		expect(received?.accountId).toBe(205)
		expect(received?.payload).toMatchObject({
			Id: gift?.Id,
			FromPlayerId: 330,
			GiftContext: 500,
			Message: 'hello this is a message',
			// An avatar item, so the equipment half of the drop is empty and the desc carries it.
			EquipmentModificationGuid: '',
		})
		// …and the spend frame still goes to the BUYER, who is the one who paid.
		const spend = frames.find(
			(f) => f.notificationType === NotificationType.StorefrontBalancePurchase
		)
		expect(spend?.accountId).toBe(330)
	})

	test('POST /api/storefronts/v2/buyItem attributes an anonymous gift to Coach', async () => {
		await seedAccount(206, 'AnonReceiver')
		await drainFrames()
		const res = await giftBackpack('331', {
			ToPlayerId: 206,
			Message: 'guess who',
			Anonymous: true,
		})
		expect(res.status).toBe(200)
		// Anonymous hides the sender from the box, it does not withhold the gift: id 1 is Coach.
		const [gift] = await pendingGifts('206')
		expect(gift?.FromPlayerId).toBe(1)
		expect(gift?.Message).toBe('guess who')
		const received = (await drainFrames()).find(
			(f) => f.notificationType === NotificationType.GiftPackageReceivedImmediate
		)
		expect(received?.payload).toMatchObject({ FromPlayerId: 1 })
	})

	test('POST /api/storefronts/v2/buyItem masks swears in the gift message', async () => {
		await seedAccount(208, 'MaskedReceiver')
		await drainFrames()
		const res = await giftBackpack('334', {
			ToPlayerId: 208,
			Message: 'happy birthday you shit',
			Anonymous: false,
			GiftContext: 500,
		})
		expect(res.status).toBe(200)
		// The buyer writes it and someone else reads it, so it is filtered like any other
		// player-typed string — masked per character, never refused.
		const masked = 'happy birthday you ****'
		expect(
			((await res.json()) as { BalanceUpdates: Array<{ Data: Array<{ Message: string }> }> })
				.BalanceUpdates[0]?.Data[0]?.Message
		).toBe(masked)
		const [gift] = await pendingGifts('208')
		expect(gift?.Message).toBe(masked)
		const received = (await drainFrames()).find(
			(f) => f.notificationType === NotificationType.GiftPackageReceivedImmediate
		)
		expect(received?.payload).toMatchObject({ Message: masked })
	})

	test('POST /api/storefronts/v2/buyItem caps the gift message at the client’s 150 characters', async () => {
		await seedAccount(209, 'LongNoteReceiver')
		await drainFrames()
		// The client's input field stops at 150, so a 200-character note is a client that
		// ignored its own limit — the overrun is dropped, the purchase still goes through.
		const long = 'a'.repeat(140) + 'b'.repeat(60)
		const res = await giftBackpack('335', { ToPlayerId: 209, Message: long, Anonymous: false })
		expect(res.status).toBe(200)
		const [gift] = await pendingGifts('209')
		expect(gift?.Message).toBe(long.slice(0, 150))
		expect((gift?.Message as string).length).toBe(150)
		// An emoji straddling the cut is dropped whole rather than stored as half a character.
		const emoji = `${'x'.repeat(149)}😀tail`
		const second = await giftBackpack('336', { ToPlayerId: 209, Message: emoji, Anonymous: false })
		expect(second.status).toBe(200)
		const notes = (await pendingGifts('209')).map((box) => box.Message)
		expect(notes).toContain('x'.repeat(149))
	})

	test('POST /api/storefronts/v2/buyItem 404s a gift to a player that does not exist', async () => {
		await drainFrames()
		const res = await giftBackpack('332', { ToPlayerId: 999999, Message: 'hi', Anonymous: false })
		expect(res.status).toBe(404)
		expect(await res.json()).toEqual({ error: 'No such player to gift to' })
		// Refused before the debit: the buyer still has every token, and nothing was pushed.
		expect(
			await getBalance(env.DB, 332, CurrencyType.RecCenterTokens, DEFAULT_STARTING_TOKENS)
		).toBe(10000)
		expect(await drainFrames()).toEqual([])
	})

	test('POST /api/storefronts/v2/buyItem gifting to yourself is just a purchase', async () => {
		await seedAccount(333, 'SelfGifter')
		await drainFrames()
		const res = await giftBackpack('333', { ToPlayerId: 333, Message: 'treat', Anonymous: false })
		expect(res.status).toBe(200)
		const [gift] = await pendingGifts('333')
		expect(gift?.FromPlayerId).toBe(333)
		// No hub gift frame: the buyer read the box out of the response.
		expect(
			(await drainFrames()).filter(
				(f) => f.notificationType === NotificationType.GiftPackageReceivedImmediate
			)
		).toEqual([])
	})

	test('POST /api/storefronts/v2/buyItem 404s for an unknown item', async () => {
		const res = await exports.default.fetch(`${ORIGIN}/api/storefronts/v2/buyItem`, {
			method: 'POST',
			headers: { ...(await bearer('22')), 'Content-Type': 'application/json' },
			body: JSON.stringify({
				StorefrontType: 3,
				PurchasableItemId: 9999999,
				CurrencyType: 2,
				RequestedPrice: SF3_ITEM.price,
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
				PurchasableItemId: SF3_ITEM.id,
				CurrencyType: 2,
				RequestedPrice: SF3_ITEM.price,
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

	// ---- POST /api/items/bulkpurchase ------------------------------------------------
	// The shopping bag: many lines, one storefront, one currency, one debit. Its response is
	// NOT buyItem's — it is the `{ Success, Error, error_id, Value }` envelope, `Value.Balance`
	// is the RESULTING total rather than the change, and each `BalanceUpdates` entry carries
	// its own `UpdateResponse` (0 OK, 2 NotEnoughCredit, 4 NoItemAvailable, 5
	// CouponNotApplicable, 6 RequestedPriceDoesNotMatch, 7 RequestedAmountNotAllowed).

	/** The shape every bulk-purchase response answers with. */
	type BulkBody = {
		Success: boolean
		Error: string | null
		error_id: string | null
		Value: {
			Balance: number
			CurrencyType: number
			Platform: number
			BalanceUpdates: Array<{
				UpdateResponse: number
				Data: {
					GiftPackage: Record<string, unknown> | null
					PurchasableItemId: number | null
					CustomAvatarItem: null
				}
			}>
		} | null
	}

	/** A bag line, in the shape the client posts one. */
	const line = (numberId: number, requestedPrice: number, extra: Record<string, unknown> = {}) => ({
		ItemPurchaseMethodId: { Type: 0, NumberId: numberId, Guid: null },
		RequestedPrice: requestedPrice,
		Gift: null,
		CouponConsumablePlayerMappingId: null,
		DuplicateItemCount: 1,
		...extra,
	})

	const bulkPurchase = async (sub: string, body: Record<string, unknown>) =>
		exports.default.fetch(`${ORIGIN}/api/items/bulkpurchase`, {
			method: 'POST',
			headers: { ...(await bearer(sub)), 'Content-Type': 'application/json' },
			body: JSON.stringify({
				StorefrontType: 3,
				CurrencyType: 2,
				BypassGiftPackages: false,
				AllowPartialSuccess: true,
				ShoppingBagId: null,
				...body,
			}),
		})

	/** The `UpdateResponse` of every entry, in request order. */
	const codes = (body: BulkBody) => body.Value!.BalanceUpdates.map((u) => u.UpdateResponse)

	test('POST /api/items/bulkpurchase 401s without a token', async () => {
		const res = await exports.default.fetch(`${ORIGIN}/api/items/bulkpurchase`, {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({
				PurchaseItemRequests: [line(SF3_ITEM.id, SF3_ITEM.price)],
				StorefrontType: 3,
				CurrencyType: 2,
			}),
		})
		expect(res.status).toBe(401)
	})

	test('POST /api/items/bulkpurchase debits the bag once and grants every line', async () => {
		// Account 90: fresh, so its first balance touch grants the 10000 default. Three donuts
		// (a consumable, 100 each — consumables are the only thing that stacks) and one avatar
		// item. The prices come from the fixtures rather than being written out: sf3 is generated
		// now, so a repriced rarity tier must not silently invalidate the arithmetic.
		await drainFrames()
		const res = await bulkPurchase('90', {
			PurchaseItemRequests: [
				line(2182, 100, { DuplicateItemCount: 3 }),
				line(SF3_ITEM.id, SF3_ITEM.price),
			],
			ShoppingBagId: 'bag-1',
		})
		expect(res.status).toBe(200)
		const body = (await res.json()) as BulkBody
		expect(body.Success).toBe(true)
		expect(body.Error).toBe(null)
		expect(body.error_id).toBe(null)
		const value = body.Value!
		// `Balance` here is the RESULTING total, unlike buyItem's change. The
		// bucket is -2, the one `GET /balance` reports — the reference server's 4
		// (RecNetPurchased) would read as a second balance the client adds to the real one.
		expect(value.Balance).toBe(DEFAULT_STARTING_TOKENS - 300 - SF3_ITEM.price)
		expect(value.CurrencyType).toBe(2)
		expect(value.Platform).toBe(-2)

		// ONE entry per REQUESTED item — three donuts are one line, so one entry — in order.
		expect(value.BalanceUpdates).toHaveLength(2)
		expect(codes(body)).toEqual([0, 0])
		expect(value.BalanceUpdates.map((u) => u.Data.PurchasableItemId)).toEqual([2182, SF3_ITEM.id])
		expect(value.BalanceUpdates.every((u) => u.Data.CustomAvatarItem === null)).toBe(true)
		// The box each line produced, as `GiftPackage` carries it: 20 keys, the receiver in
		// `PlayerId`, a self-buy attributed to the "Coach" account (1), and the platform MASK in
		// `Platform` — the balance bucket is the `BalanceType` beside it.
		const box = value.BalanceUpdates[0].Data.GiftPackage!
		expect(Object.keys(box)).toEqual([
			'Id',
			'PlayerId',
			'FromPlayerId',
			'ConsumableItemDesc',
			'AvatarItemType',
			'AvatarItemDesc',
			'CustomAvatarItemId',
			'EquipmentPrefabName',
			'EquipmentModificationGuid',
			'CurrencyType',
			'Currency',
			'Xp',
			'GiftContext',
			'GiftRarity',
			'Message',
			'Signature',
			'IsSignatureValid',
			'Platform',
			'PlatformsToSpawnOn',
			'BalanceType',
		])
		expect(box.Id).toBeGreaterThan(0)
		expect(box.PlayerId).toBe(90)
		expect(box.FromPlayerId).toBe(1)
		expect(box.ConsumableItemDesc).not.toBe('')
		expect(box.Platform).toBe(-1)
		expect(box.BalanceType).toBe(-2)
		expect(value.BalanceUpdates[1].Data.GiftPackage!.AvatarItemDesc).not.toBe('')

		// ONE frame for the whole bag, setting the account-wide bucket to the resulting total —
		// the same total the body reports, so the two agree instead of compounding.
		expect(await drainFrames()).toEqual([
			{
				accountId: 90,
				notificationType: NotificationType.StorefrontBalancePurchase,
				payload: {
					BalanceAddType: 1400,
					Delta: -(300 + SF3_ITEM.price),
					Balance: DEFAULT_STARTING_TOKENS - 300 - SF3_ITEM.price,
					Platform: -2,
					CurrencyType: 2,
				},
			},
		])
		expect(
			await getBalance(env.DB, 90, CurrencyType.RecCenterTokens, DEFAULT_STARTING_TOKENS)
		).toBe(DEFAULT_STARTING_TOKENS - 300 - SF3_ITEM.price)

		// Everything landed: the dress is owned, all three donuts stacked into the one box's
		// grant, and each LINE left one gift box.
		const items = await exports.default.fetch(`${ORIGIN}/api/avatar/v4/items`, {
			headers: await bearer('90'),
		})
		const list = (await items.json()) as Array<{ friendlyName: string }>
		expect(list[0].friendlyName).toBe(SF3_ITEM.name)
		const unlocked = await exports.default.fetch(`${ORIGIN}/api/consumables/v2/getUnlocked`, {
			headers: await bearer('90'),
		})
		const consumables = (await unlocked.json()) as Array<{ Count: number }>
		expect(consumables[0].Count).toBe(3)
		const gifts = await exports.default.fetch(`${ORIGIN}/api/avatar/v2/gifts`, {
			headers: await bearer('90'),
		})
		const pending = (await gifts.json()) as Array<{ Id: number }>
		expect(pending.map((g) => g.Id)).toEqual(
			value.BalanceUpdates.map((u) => u.Data.GiftPackage!.Id)
		)
	})

	test('POST /api/items/bulkpurchase buys the good lines when partial success is allowed', async () => {
		// The second line's price no longer matches the catalog (200, not 1). The bag still
		// succeeds — that entry just comes back non-OK, which is what AllowPartialSuccess means.
		const res = await bulkPurchase('91', {
			PurchaseItemRequests: [line(SF3_ITEM.id, SF3_ITEM.price), line(SF3_CHEAP.id, 1)],
		})
		expect(res.status).toBe(200)
		const body = (await res.json()) as BulkBody
		expect(body.Success).toBe(true)
		expect(body.Error).toBe(null)
		expect(body.Value!.Balance).toBe(DEFAULT_STARTING_TOKENS - SF3_ITEM.price)
		// 6 = RequestedPriceDoesNotMatch. The failed line still names the item it asked for.
		expect(codes(body)).toEqual([0, 6])
		expect(body.Value!.BalanceUpdates[1].Data).toEqual({
			GiftPackage: null,
			PurchasableItemId: SF3_CHEAP.id,
			CustomAvatarItem: null,
		})
		expect(
			await getBalance(env.DB, 91, CurrencyType.RecCenterTokens, DEFAULT_STARTING_TOKENS)
		).toBe(DEFAULT_STARTING_TOKENS - SF3_ITEM.price)
	})

	test('POST /api/items/bulkpurchase charges nothing when a line fails and partial success is off', async () => {
		await drainFrames()
		const res = await bulkPurchase('92', {
			AllowPartialSuccess: false,
			PurchaseItemRequests: [line(SF3_ITEM.id, SF3_ITEM.price), line(SF3_CHEAP.id, 1)],
		})
		expect(res.status).toBe(200)
		const body = (await res.json()) as BulkBody
		expect(body.Success).toBe(false)
		expect(body.Error).toBe('Price has changed')
		expect(body.Value).toBe(null)
		// Untouched: no debit, no item, and no frame for a purchase that did not happen.
		expect(
			await getBalance(env.DB, 92, CurrencyType.RecCenterTokens, DEFAULT_STARTING_TOKENS)
		).toBe(10000)
		const items = await exports.default.fetch(`${ORIGIN}/api/avatar/v4/items`, {
			headers: await bearer('92'),
		})
		const list = (await items.json()) as Array<{ friendlyName: string }>
		expect(list.every((i) => i.friendlyName !== SF3_ITEM.name)).toBe(true)
		expect(await drainFrames()).toEqual([])
	})

	test('POST /api/items/bulkpurchase takes the lines that fit, in request order', async () => {
		// Leave account 93 with enough for the FIRST line and not both, whatever the tiers cost.
		const fitsOne = SF3_ITEM.price + SF3_CHEAP.price - 1
		await getBalance(env.DB, 93, CurrencyType.RecCenterTokens, DEFAULT_STARTING_TOKENS)
		expect(
			await spendCurrency(
				env.DB,
				93,
				CurrencyType.RecCenterTokens,
				DEFAULT_STARTING_TOKENS - fitsOne,
				DEFAULT_STARTING_TOKENS
			)
		).toBe(true)
		const res = await bulkPurchase('93', {
			PurchaseItemRequests: [
				line(SF3_ITEM.id, SF3_ITEM.price),
				line(SF3_CHEAP.id, SF3_CHEAP.price),
			],
		})
		const body = (await res.json()) as BulkBody
		expect(body.Success).toBe(true)
		expect(body.Value!.Balance).toBe(fitsOne - SF3_ITEM.price)
		// 2 = NotEnoughCredit for the line the balance no longer covered.
		expect(codes(body)).toEqual([0, 2])
		expect(body.Value!.BalanceUpdates[1].Data.GiftPackage).toBe(null)
		expect(
			await getBalance(env.DB, 93, CurrencyType.RecCenterTokens, DEFAULT_STARTING_TOKENS)
		).toBe(fitsOne - SF3_ITEM.price)
	})

	test('POST /api/items/bulkpurchase fails the whole bag it cannot afford when partial success is off', async () => {
		// Same shaping as above: enough for one line, not both.
		const affordsOne = SF3_ITEM.price + SF3_CHEAP.price - 1
		await getBalance(env.DB, 94, CurrencyType.RecCenterTokens, DEFAULT_STARTING_TOKENS)
		expect(
			await spendCurrency(
				env.DB,
				94,
				CurrencyType.RecCenterTokens,
				DEFAULT_STARTING_TOKENS - affordsOne,
				DEFAULT_STARTING_TOKENS
			)
		).toBe(true)
		const res = await bulkPurchase('94', {
			AllowPartialSuccess: false,
			PurchaseItemRequests: [
				line(SF3_ITEM.id, SF3_ITEM.price),
				line(SF3_CHEAP.id, SF3_CHEAP.price),
			],
		})
		const body = (await res.json()) as BulkBody
		// Even the line that would have fitted is refused: all of it or none.
		expect(body.Success).toBe(false)
		expect(body.Error).toBe('Insufficient balance')
		expect(body.Value).toBe(null)
		expect(
			await getBalance(env.DB, 94, CurrencyType.RecCenterTokens, DEFAULT_STARTING_TOKENS)
		).toBe(affordsOne)
	})

	test('POST /api/items/bulkpurchase grants without gift boxes when BypassGiftPackages is set', async () => {
		const res = await bulkPurchase('95', {
			BypassGiftPackages: true,
			PurchaseItemRequests: [line(SF3_ITEM.id, SF3_ITEM.price)],
		})
		const body = (await res.json()) as BulkBody
		expect(body.Success).toBe(true)
		expect(body.Value!.Balance).toBe(DEFAULT_STARTING_TOKENS - SF3_ITEM.price)
		// No box was created, so there is none to hand back — the capture's null GiftPackage.
		expect(body.Value!.BalanceUpdates[0]).toEqual({
			UpdateResponse: 0,
			Data: { GiftPackage: null, PurchasableItemId: SF3_ITEM.id, CustomAvatarItem: null },
		})
		const gifts = await exports.default.fetch(`${ORIGIN}/api/avatar/v2/gifts`, {
			headers: await bearer('95'),
		})
		expect((await gifts.json()) as unknown[]).toEqual([])
		// Ownership never depended on the box: the item is owned all the same.
		const items = await exports.default.fetch(`${ORIGIN}/api/avatar/v4/items`, {
			headers: await bearer('95'),
		})
		const list = (await items.json()) as Array<{ friendlyName: string }>
		expect(list[0].friendlyName).toBe(SF3_ITEM.name)
	})

	test('POST /api/items/bulkpurchase routes a gifted line to its receiver', async () => {
		await seedAccount(207, 'BagReceiver')
		await drainFrames()
		const res = await bulkPurchase('960', {
			PurchaseItemRequests: [
				line(SF3_ITEM.id, SF3_ITEM.price),
				line(2182, 100, {
					Gift: { ToPlayerId: 207, Message: 'from the bag', Anonymous: false, GiftContext: 500 },
				}),
			],
		})
		const body = (await res.json()) as BulkBody
		expect(body.Success).toBe(true)
		// The buyer pays for both lines; only the first one lands on them.
		expect(body.Value!.Balance).toBe(DEFAULT_STARTING_TOKENS - SF3_ITEM.price - 100)
		const [own, gifted] = body.Value!.BalanceUpdates
		expect(own?.Data.GiftPackage).toMatchObject({ PlayerId: 960, FromPlayerId: 1 })
		expect(gifted?.Data.GiftPackage).toMatchObject({
			PlayerId: 207,
			FromPlayerId: 960,
			GiftContext: 500,
		})
		expect(await pendingGifts('960')).toHaveLength(1)
		const [box] = await pendingGifts('207')
		expect(box?.FromPlayerId).toBe(960)
		expect(box?.GiftContext).toBe(500)
		expect(box?.Message).toBe('from the bag')
		// The bag's response is the buyer's; the receiver is told over the hub instead.
		const received = (await drainFrames()).find(
			(f) => f.notificationType === NotificationType.GiftPackageReceivedImmediate
		)
		expect(received?.accountId).toBe(207)
		expect(received?.payload).toMatchObject({ Id: box?.Id, FromPlayerId: 960, GiftContext: 500 })
	})

	test('POST /api/items/bulkpurchase 404s a bag gifting to a player that does not exist', async () => {
		const res = await bulkPurchase('970', {
			PurchaseItemRequests: [
				line(SF3_ITEM.id, SF3_ITEM.price),
				line(2182, 100, { Gift: { ToPlayerId: 999998, Message: 'hi', Anonymous: false } }),
			],
		})
		expect(res.status).toBe(404)
		const body = (await res.json()) as BulkBody
		expect(body.Success).toBe(false)
		expect(body.Error).toBe('No such player to gift to')
		// The whole bag is refused before the debit, the good line included.
		expect(
			await getBalance(env.DB, 970, CurrencyType.RecCenterTokens, DEFAULT_STARTING_TOKENS)
		).toBe(10000)
	})

	test('POST /api/items/bulkpurchase reports per line what it cannot sell', async () => {
		await drainFrames()
		const res = await bulkPurchase('96', {
			PurchaseItemRequests: [
				// A guid-keyed (UGC) item — nothing here sells one, and it has no NumberId to echo.
				line(0, SF3_ITEM.price, {
					ItemPurchaseMethodId: { Type: 1, NumberId: null, Guid: 'a3f1-not-a-catalog-item' },
				}),
				// Nothing issues coupons, so a line claiming one is refused rather than charged full
				// price for a discount it thinks it applied.
				line(SF3_ITEM.id, SF3_ITEM.price, { CouponConsumablePlayerMappingId: 4242 }),
				line(999999, SF3_ITEM.price),
				line(SF3_ITEM.id, SF3_ITEM.price, { DuplicateItemCount: 0 }),
				// An avatar item is owned once — a second copy would grant nothing and charge for it.
				line(SF3_CHEAP.id, SF3_CHEAP.price, { DuplicateItemCount: 2 }),
				// The catalog prices this item in RecCenterTokens only.
				line(2182, 100),
				// …and one that works, so the bag is a partial success rather than a refusal.
				line(SF3_ITEM.id, SF3_ITEM.price),
			],
			CurrencyType: 2,
		})
		expect(res.status).toBe(200)
		const body = (await res.json()) as BulkBody
		expect(body.Success).toBe(true)
		// 4 NoItemAvailable, 5 CouponNotApplicable, 4 NoItemAvailable, 7/7
		// RequestedAmountNotAllowed, 0 OK (the donuts do price in tokens), 0 OK.
		expect(codes(body)).toEqual([4, 5, 4, 7, 7, 0, 0])
		expect(body.Value!.BalanceUpdates[0].Data.PurchasableItemId).toBe(null)
		// Only the two OK lines were charged: the donuts and one avatar item.
		expect(body.Value!.Balance).toBe(DEFAULT_STARTING_TOKENS - 100 - SF3_ITEM.price)
		expect(await drainFrames()).toHaveLength(1)
	})

	test('POST /api/items/bulkpurchase refuses a bag where nothing sells', async () => {
		const res = await bulkPurchase('97', {
			CurrencyType: CurrencyType.LaserTagTickets,
			PurchaseItemRequests: [line(SF3_ITEM.id, SF3_ITEM.price)],
		})
		expect(res.status).toBe(200)
		const body = (await res.json()) as BulkBody
		// Nothing was bought, so this is a refusal rather than a bag of non-OK entries.
		expect(body.Success).toBe(false)
		expect(body.Error).toBe('Currency type not available for this item')
		expect(body.Value).toBe(null)
	})

	test('POST /api/items/bulkpurchase 400s on a request it cannot evaluate', async () => {
		// Same envelope on a 400, so a client that only parses this shape still reads the error.
		const empty = await bulkPurchase('98', { PurchaseItemRequests: [] })
		expect(empty.status).toBe(400)
		const emptyBody = (await empty.json()) as BulkBody
		expect(emptyBody).toMatchObject({ Success: false, error_id: null, Value: null })
		expect(emptyBody.Error).toBe('PurchaseItemRequests must be a non-empty array')
		// A room-scoped currency is not an account balance we can debit.
		const roomCurrency = await bulkPurchase('98', {
			CurrencyType: CurrencyType.RoomCurrency,
			PurchaseItemRequests: [line(SF3_ITEM.id, SF3_ITEM.price)],
		})
		expect(roomCurrency.status).toBe(400)
		expect(((await roomCurrency.json()) as BulkBody).Error).toBe('Currency type is not spendable')
		// Over `Econ.BulkPurchaseCap` (200 copies) — the same cap the client reads from its
		// game config. Consumables are what can be asked for in that quantity.
		const over = await bulkPurchase('98', {
			PurchaseItemRequests: [line(2182, 100, { DuplicateItemCount: 201 })],
		})
		expect(over.status).toBe(400)
		expect(((await over.json()) as BulkBody).Error).toBe('A bulk purchase is capped at 200 items')
		expect(
			await getBalance(env.DB, 98, CurrencyType.RecCenterTokens, DEFAULT_STARTING_TOKENS)
		).toBe(10000)
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

	// The 2025 client posts the same purchase as a JSON body — and wants a DIFFERENT response
	// back: the v9 save envelope, and a balance bucket keyed `Platform`. The settlement is
	// shared with v2, so these pin the envelope and the money moving, not the rules v2 covers.
	const buyInventionV3 = async (sub: string, body: unknown) =>
		exports.default.fetch(`${ORIGIN}/api/storefronts/v3/buyInvention`, {
			method: 'POST',
			headers: { ...(await bearer(sub)), 'Content-Type': 'application/json' },
			body: JSON.stringify(body),
		})

	test('POST /api/storefronts/v3/buyInvention 401s without a token', async () => {
		const res = await exports.default.fetch(`${ORIGIN}/api/storefronts/v3/buyInvention`, {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({ InventionId: 8, RequestedPrice: 0 }),
		})
		expect(res.status).toBe(401)
	})

	test('POST /api/storefronts/v3/buyInvention answers the v9 envelope, not v2’s', async () => {
		const res = await buyInventionV3('55', { InventionId: 8, RequestedPrice: 0 })
		expect(res.status).toBe(200)
		const body = (await res.json()) as {
			InventionResponse: {
				Value: {
					Status: number
					Invention: Record<string, unknown>
					InventionVersion: unknown
					TagsResponse: unknown
				} | null
				Success: boolean
				Error: string | null
				error_id: string | null
			}
			BalanceUpdateResponse: {
				Balance: number
				CurrencyType: number
				Platform: number
				BalanceType?: number
				BalanceUpdates: Array<{ UpdateResponse: number; Data: { InventionId: number } }>
			}
		}

		// The v9 SAVE envelope: `Value` under `{ Success, Error, error_id }`. `Value` is never
		// null under `Success: true` — the client dereferences `Value.Invention` unguarded.
		expect(body.InventionResponse).toMatchObject({ Success: true, Error: null, error_id: null })
		expect(body.InventionResponse.Value?.Status).toBe(0)
		expect(body.InventionResponse.Value?.Invention.InventionId).toBe(8)
		expect(body.InventionResponse.Value?.Invention.Name).toBe('Invention 8')
		// The 28-key `RRInvention`, not the stored record: the version rides nowhere here, and
		// `IsPublished` is a stored field this projection drops.
		expect(body.InventionResponse.Value?.Invention.CurrentVersion).toBeUndefined()
		expect(body.InventionResponse.Value?.Invention.IsPublished).toBeUndefined()
		expect(body.InventionResponse.Value?.Invention.LatestVersionNumber).toBe(1)
		// A buy mints no version and takes no tags — present and null, not absent.
		expect(body.InventionResponse.Value).toHaveProperty('InventionVersion', null)
		expect(body.InventionResponse.Value).toHaveProperty('TagsResponse', null)

		// `BalanceResponseDTO`: the bucket key is `Platform`. Spelling it `BalanceType` (which is
		// what v2 sends) would be dropped by the client's decoder and default this balance into
		// bucket 0, beside the -2 the socket frames set — a phantom second balance.
		expect(body.BalanceUpdateResponse.Platform).toBe(-2)
		expect(body.BalanceUpdateResponse.BalanceType).toBeUndefined()
		// Nothing was debited, so `Balance` is the resulting total, not a change.
		expect(body.BalanceUpdateResponse.Balance).toBe(DEFAULT_STARTING_TOKENS)
		expect(body.BalanceUpdateResponse.CurrencyType).toBe(CurrencyType.RecCenterTokens)
		expect(body.BalanceUpdateResponse.BalanceUpdates[0].Data.InventionId).toBe(8)

		expect(await getOwnedInventionIds(env.DB, 55)).toEqual([8])
		// Owning it is boolean here too — the route shares v2's settlement.
		expect((await buyInventionV3('55', { InventionId: 8, RequestedPrice: 0 })).status).toBe(409)
	})

	test('GET v2 and POST v3 buyInvention answer the SAME buy in different envelopes', async () => {
		// The one thing that must not drift: two builds buying the same invention get the same
		// invention back, shaped for each. v2 serves the stored record under a bare status
		// envelope; v3 serves the 28-key projection under the v9 one. Don't unify them.
		const v2 = (await (await buyInvention('58', 8)).json()) as {
			InventionResponse: { Status: number; Invention: Record<string, unknown> }
			BalanceUpdateResponse: { BalanceType: number; Platform?: number }
		}
		const v3 = (await (
			await buyInventionV3('59', { InventionId: 8, RequestedPrice: 0 })
		).json()) as {
			InventionResponse: { Value: { Invention: Record<string, unknown> } | null }
			BalanceUpdateResponse: { Platform: number; BalanceType?: number }
		}
		expect(v2.InventionResponse.Invention.InventionId).toBe(8)
		expect(v3.InventionResponse.Value?.Invention.InventionId).toBe(8)
		// v2 keeps the nested version; v3's projection lifts it away entirely.
		expect(v2.InventionResponse.Invention.CurrentVersion).toBeDefined()
		expect(v3.InventionResponse.Value?.Invention.CurrentVersion).toBeUndefined()
		// The bucket is spelled differently on each, and each spells exactly one.
		expect(v2.BalanceUpdateResponse).toMatchObject({ BalanceType: -2 })
		expect(v2.BalanceUpdateResponse.Platform).toBeUndefined()
		expect(v3.BalanceUpdateResponse).toMatchObject({ Platform: -2 })
		expect(v3.BalanceUpdateResponse.BalanceType).toBeUndefined()
	})

	test('POST /api/storefronts/v3/buyInvention pays the creator and pushes both sides', async () => {
		await drainFrames()
		// Creator 999 has already been paid by the v2 tests above, so their resulting total is
		// read rather than assumed — it is the payout ADDED to whatever they had.
		const creatorBefore = await getBalance(
			env.DB,
			999,
			CurrencyType.RecCenterTokens,
			DEFAULT_STARTING_TOKENS
		)
		const res = await buyInventionV3('56', { InventionId: 9, RequestedPrice: 250 })
		expect(res.status).toBe(200)
		const body = (await res.json()) as { BalanceUpdateResponse: { Balance: number } }
		expect(body.BalanceUpdateResponse.Balance).toBe(DEFAULT_STARTING_TOKENS - 250)
		expect(
			await getBalance(env.DB, 56, CurrencyType.RecCenterTokens, DEFAULT_STARTING_TOKENS)
		).toBe(DEFAULT_STARTING_TOKENS - 250)
		expect(
			await getBalance(env.DB, 999, CurrencyType.RecCenterTokens, DEFAULT_STARTING_TOKENS)
		).toBe(creatorBefore + 250)
		expect(await getOwnedInventionIds(env.DB, 56)).toEqual([9])

		// Same two frames as the v2 buy, each carrying its player's RESULTING total into the -2
		// bucket: the creator sold (a plain update), the buyer bought (a purchase frame).
		expect(await drainFrames()).toEqual([
			{
				accountId: 999,
				notificationType: NotificationType.StorefrontBalanceUpdate,
				payload: {
					Balance: creatorBefore + 250,
					CurrencyType: CurrencyType.RecCenterTokens,
					Platform: -2,
				},
			},
			{
				accountId: 56,
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

	test('POST /api/storefronts/v3/buyInvention rejects a stale price and a bad body', async () => {
		// A body is the only difference from v2, so the price check reads it the same way: an
		// absent RequestedPrice is 0, which does not match the 250-token invention 9.
		expect((await buyInventionV3('57', { InventionId: 9 })).status).toBe(409)
		expect((await buyInventionV3('57', { InventionId: 9, RequestedPrice: 0 })).status).toBe(409)
		// No InventionId, and no body at all.
		expect((await buyInventionV3('57', { RequestedPrice: 0 })).status).toBe(400)
		const res = await exports.default.fetch(`${ORIGIN}/api/storefronts/v3/buyInvention`, {
			method: 'POST',
			headers: { ...(await bearer('57')), 'Content-Type': 'application/json' },
		})
		expect(res.status).toBe(400)
		expect(await getOwnedInventionIds(env.DB, 57)).toEqual([])
	})

	test('POST /api/avatar/v2/gifts/consume opens the box the way the client sends it', async () => {
		// Buy an item for account 24, then consume the box the way the client does: on the
		// econ host, with a form body (`Id=..&UnlockedLevel=..`).
		const buy = await exports.default.fetch(`${ORIGIN}/api/storefronts/v2/buyItem`, {
			method: 'POST',
			headers: { ...(await bearer('24')), 'Content-Type': 'application/json' },
			body: JSON.stringify({
				StorefrontType: 3,
				PurchasableItemId: SF3_ITEM.id,
				CurrencyType: 2,
				RequestedPrice: SF3_ITEM.price,
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
		expect(list.some((i) => i.friendlyName === SF3_ITEM.name)).toBe(true)

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
				PurchasableItemId: SF3_ITEM.id,
				CurrencyType: 2,
				RequestedPrice: SF3_ITEM.price,
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
		expect(body.ChallengeMapId).toBe(weekly.ChallengeMapId)
		expect(body.Challenges).toHaveLength(weekly.Challenges.length)
	})

	test('the rotation is a pure function of the week', async () => {
		const at = new Date('2026-08-25T12:00:00Z')
		// Same instant, same rotation — and any instant in the same week, too. Two players
		// served different challenges for one `ChallengeMapId` would disagree about who has
		// finished the week.
		expect(buildRotation(at)).toEqual(buildRotation(at))
		const laterSameWeek = new Date('2026-08-26T20:59:59Z')
		expect(rotationIndex(laterSameWeek)).toBe(rotationIndex(at))
		expect(buildRotation(laterSameWeek).Challenges).toEqual(buildRotation(at).Challenges)

		// …and the week rolls at Wednesday 21:00 UTC, one map id at a time.
		const nextWeek = new Date('2026-08-26T21:00:00Z')
		expect(rotationIndex(nextWeek)).toBe(rotationIndex(at) + 1)
		expect(buildRotation(nextWeek).ChallengeMapId).toBe(buildRotation(at).ChallengeMapId + 1)
		expect(buildRotation(nextWeek).StartAt).toBe(buildRotation(at).EndAt)
	})

	test('the weekly gift pool leaves out the sandbox dice', async () => {
		// The pool is the catalog's skins, and a sixth of them are `[Sandbox_D4]`…`[Sandbox_D20]`
		// recolours. A week themed on "Sandbox D8 (Pewter)" spends its headline reward on a die, so
		// those prefabs are excluded — everything else is fair game.
		const res = await exports.default.fetch(`${ORIGIN}/api/challenge/v2/getCurrent`)
		expect(res.status).toBe(200)
		const week = (await res.json()) as {
			ChallengeThemeString: string
			Gift: { EquipmentPrefabName: string }
		}
		expect(week.Gift.EquipmentPrefabName.startsWith('[Sandbox_')).toBe(false)
		expect(week.ChallengeThemeString).not.toMatch(/^Sandbox D/)

		// It still rolls something: excluding the dice must not empty the pool, which would leave
		// the week themed on nothing.
		expect(week.ChallengeThemeString).not.toBe('')
	})

	test('the week is themed on the name of the item it rolls', async () => {
		// `ChallengeThemeString` is the reward's catalog FriendlyName. The static file ships it
		// empty on purpose — a generated week's gift isn't known until it is rolled — so the
		// theming happens where the pick does.
		const pool = [
			{
				GiftDropId: 11,
				EquipmentPrefabName: '[ShareCamera]',
				EquipmentModificationGuid: 'guid-a',
				Rarity: 30,
				FriendlyName: 'Camera Skin (Comic)',
			},
			{
				GiftDropId: 12,
				EquipmentPrefabName: '[Boombox]',
				EquipmentModificationGuid: 'guid-b',
				Rarity: 20,
				FriendlyName: 'Boombox (Neon)',
			},
		]
		const at = new Date('2026-08-25T12:00:00Z')
		const themed = withWeeklyGift(buildRotation(at), pool)
		const rolled = pool.find((p) => p.GiftDropId === themed.Gift.GiftDropId)
		expect(rolled).toBeDefined()
		expect(themed.ChallengeThemeString).toBe(rolled!.FriendlyName)

		// An empty pool (the catalog didn't load) leaves the rotation as it was rather than
		// theming the week on nothing.
		expect(withWeeklyGift(buildRotation(at), []).ChallengeThemeString).toBe(
			buildRotation(at).ChallengeThemeString
		)

		// And over the live catalog the route serves a real name, not the placeholder.
		const served = (await (
			await exports.default.fetch(`${ORIGIN}/api/challenge/v2/getCurrent`)
		).json()) as { ChallengeThemeString: string }
		expect(served.ChallengeThemeString).not.toBe('')
	})

	test('every generated week is five valid, distinct challenges', async () => {
		// Walk two years of rotations: the pool, the constraints and the tree builders all have
		// to hold for every week, not just this one.
		for (let week = 0; week < 104; week++) {
			const at = new Date(Date.UTC(2026, 0, 7, 21, 0, 0) + week * 7 * 24 * 60 * 60 * 1000)
			const rotation = buildRotation(at)
			const where = `week ${week}`
			expect(rotation.Challenges, where).toHaveLength(5)
			// Ids have to be unique within a rotation — `challenge_status` is keyed by them.
			const ids = rotation.Challenges.map((ch) => ch.ChallengeId)
			expect(new Set(ids).size, where).toBe(ids.length)
			// One room per week: five ways to say "play Paintball" is not a rotation.
			const scenes = rotation.Challenges.flatMap((ch) => sceneIdsOf(ch.Config))
			expect(new Set(scenes).size, where).toBe(scenes.length)
			for (const challenge of rotation.Challenges) {
				// A malformed tree fails SILENTLY in the client — the challenge just never
				// completes — so the shape is asserted here rather than discovered in game.
				const tree = JSON.parse(challenge.Config) as { ct: number; t?: number }
				expect([0, 1], `${where} ${challenge.Name}`).toContain(tree.ct)
				if (tree.ct === 1) expect(tree.t, `${where} ${challenge.Name}`).toBeGreaterThan(0)
				expect(sceneIdsOf(challenge.Config).length, `${where} ${challenge.Name}`).toBeGreaterThan(0)
				// The copy is generated from the same inputs as the tree, so it can't drift — but a
				// counter still has to say out loud how far it counts.
				if (tree.ct === 1) expect(challenge.Description, where).toContain(String(tree.t))
				expect(challenge.Tooltip.length, `${where} ${challenge.Name}`).toBeGreaterThan(0)
				expect(challenge.Complete, `${where} ${challenge.Name}`).toBe(false)
			}
		}
	})

	/** Every `ct:7` scene id in a rule tree, however deep the tree nests them. */
	function sceneIdsOf(config: string): string[] {
		const scenes: string[] = []
		const walk = (node: unknown): void => {
			if (Array.isArray(node)) return node.forEach(walk)
			if (node === null || typeof node !== 'object') return
			const record = node as { ct?: number; vs?: Array<{ l?: string }> }
			if (record.ct === 7)
				for (const value of record.vs ?? []) if (value.l !== undefined) scenes.push(value.l)
			for (const value of Object.values(record)) walk(value)
		}
		walk(JSON.parse(config))
		return scenes
	}

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
				ChallengeMapId: String(weekly.ChallengeMapId),
				ChallengeId: String(challenge.ChallengeId),
				Config: challenge.Config,
				// .NET's bool.ToString() — the capitalized string, which `Boolean("False")`
				// would read as complete.
				Complete: 'False',
			}),
		})
		expect(res.status).toBe(200)
		expect(await res.json()).toEqual({
			ChallengeMapId: weekly.ChallengeMapId,
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
				ChallengeMapId: String(weekly.ChallengeMapId),
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

	test('the reported Config is stored and served back over the static rule tree', async () => {
		const challenge = CURRENT_CHALLENGE
		const bearerHeaders = await bearer('78')
		const headers = { ...bearerHeaders, 'Content-Type': 'application/json' }
		// The client posts the catalog's tree with its own running count written into it —
		// `cc` on the counter — which is the progress that has to survive the session.
		const inProgress = challenge.Config.replace(/}$/, ',"cc":1}')
		expect(inProgress).not.toBe(challenge.Config)
		const post = (body: Record<string, string>) =>
			exports.default.fetch(`${ORIGIN}/api/challenge/v2/updateProgress`, {
				method: 'POST',
				headers,
				body: JSON.stringify({
					ChallengeMapId: String(weekly.ChallengeMapId),
					ChallengeId: String(challenge.ChallengeId),
					...body,
				}),
			})
		const reported = await post({ Config: inProgress, Complete: 'False' })
		expect(await reported.json()).toEqual({
			ChallengeMapId: weekly.ChallengeMapId,
			ChallengeId: challenge.ChallengeId,
			Config: inProgress,
			Complete: false,
		})

		const configOf = async () => {
			const res = await exports.default.fetch(`${ORIGIN}/api/challenge/v2/getCurrent`, {
				headers: bearerHeaders,
			})
			const body = (await res.json()) as {
				Challenges: Array<{ ChallengeId: number; Config: string }>
			}
			return body.Challenges.find((ch) => ch.ChallengeId === challenge.ChallengeId)?.Config
		}
		expect(await configOf()).toBe(inProgress)

		// A report carrying no tree is not a reset — the stored progress stays, and is echoed.
		const noConfig = await post({ Complete: 'False' })
		expect(((await noConfig.json()) as { Config: string }).Config).toBe(inProgress)
		expect(await configOf()).toBe(inProgress)

		// Challenges this player never reported keep the authored tree, and so does everyone else.
		const anon = await exports.default.fetch(`${ORIGIN}/api/challenge/v2/getCurrent`)
		const anonBody = (await anon.json()) as { Challenges: Array<{ Config: string }> }
		expect(anonBody.Challenges.map((ch) => ch.Config)).toEqual(
			weekly.Challenges.map((ch) => ch.Config)
		)
	})

	/**
	 * How many of the rotation's challenges earn the gift — three, unless the rotation
	 * publishes fewer or declares itself all-or-nothing (`CHALLENGES_REQUIRED_FOR_GIFT`).
	 */
	const REQUIRED_FOR_GIFT = weekly.CompletedRequired
		? weekly.Challenges.length
		: Math.min(3, weekly.Challenges.length)

	/** Report the live rotation's challenges complete, for one player. */
	async function finishTheRotation(sub: string) {
		const headers = { ...(await bearer(sub)), 'Content-Type': 'application/json' }
		const ids = weekly.Challenges.map((challenge) => challenge.ChallengeId)
		const report = (challengeId: number) =>
			exports.default.fetch(`${ORIGIN}/api/challenge/v2/updateProgress`, {
				method: 'POST',
				headers,
				body: JSON.stringify({
					ChallengeMapId: String(weekly.ChallengeMapId),
					ChallengeId: String(challengeId),
					Complete: 'True',
				}),
			})
		return { ids, report }
	}

	/**
	 * The reward this week advertises, read back from the route that shows it to the client.
	 * The gift is rolled from the storefront catalog rather than authored, so the assertion
	 * that matters is that the box a player receives carries what the rotation promised.
	 */
	async function advertisedGift() {
		const res = await exports.default.fetch(`${ORIGIN}/api/challenge/v2/getCurrent`)
		return ((await res.json()) as { Gift: Record<string, string & number> }).Gift
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
			GiftContext: number
		}>
	}

	test('completing enough of the rotation grants its gift, once', async () => {
		// The live rotation, so this follows whatever this week generated.
		const gift = await advertisedGift()
		const { ids, report } = await finishTheRotation('74')
		// The threshold can't ask for more than the week publishes: a five-challenge week asks
		// for three, and a rotation of three or fewer asks for all of them.
		expect(REQUIRED_FOR_GIFT).toBeLessThanOrEqual(ids.length)
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
		expect(won[0]?.EquipmentModificationGuid).toBe(gift.EquipmentModificationGuid)

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
			AvatarItemDesc: gift.AvatarItemDesc,
			AvatarItemType: gift.AvatarItemType,
			EquipmentPrefabName: gift.EquipmentPrefabName,
			EquipmentModificationGuid: gift.EquipmentModificationGuid,
			CurrencyType: 0,
			Currency: 0,
			Xp: 0,
			Level: 0,
			Platform: -1,
			PlatformsToSpawnOn: -1,
			BalanceType: -2,
			GiftContext: gift.GiftContext,
			// The catalog's rarity for the item — which is also what the generated block carries,
			// since the week's gift is drawn from the catalog itself.
			GiftRarity: gift.GiftRarity,
			Message: 'Weekly challenge complete!',
		})

		// The reward is the item, not the box: it lands in the inventory unopened.
		const unlocked = await exports.default.fetch(`${ORIGIN}/api/equipment/v2/getUnlocked`, {
			headers: await bearer('74'),
		})
		const owned = (await unlocked.json()) as Array<{ ModificationGuid: string }>
		expect(owned.map((e) => e.ModificationGuid)).toContain(gift.EquipmentModificationGuid)

		// Finishing the REST of the set, and re-reporting what's already done (which the client
		// keeps doing), must not mint a second reward.
		for (const id of ids) expect((await report(id)).status).toBe(200)
		expect(await giftBoxes('74')).toHaveLength(1)
	})

	test('a player who already owns the rotation’s gift rolls the fallback box instead', async () => {
		// Own the reward up front — the case the rotation's `FallbackGiftName` exists for.
		const gift = await advertisedGift()
		await grantEquipment(env.DB, 75, {
			ModificationGuid: gift.EquipmentModificationGuid,
			PrefabName: gift.EquipmentPrefabName,
			FriendlyName: 'The week’s reward, already owned',
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
		expect(rolled?.EquipmentModificationGuid).not.toBe(gift.EquipmentModificationGuid)
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

	test('a giftContext naming a quest-rewards.json key pays one of that activity’s rewards', async () => {
		const request = async (body: string) =>
			exports.default.fetch(`${ORIGIN}/api/gamerewards/v1/request`, {
				method: 'POST',
				headers: {
					...(await bearer('83')),
					'Content-Type': 'application/x-www-form-urlencoded',
				},
				body,
			})
		await drainFrames()

		// Quest_Goblin_S: forty avatar-item rewards, all at the goblin quest's S-rank context.
		const goblin = await request(
			'rewardType=PostGameActivity&Message=Quest%20complete&giftContext=Quest_Goblin_S'
		)
		expect(goblin.status).toBe(200)
		expect(await goblin.json()).toEqual([])
		const boxes = await giftBoxes('83')
		expect(boxes).toHaveLength(1)
		const box = boxes[0]
		expect(box).toMatchObject({ Xp: 5, Message: 'Quest complete', GiftContext: 4003 })
		expect(box?.AvatarItemDesc).not.toBe('')
		const row = questRewards.Quest_Goblin_S.find((r) => r.AvatarItemDesc === box?.AvatarItemDesc)
		expect(row).toBeDefined()
		expect(box?.GiftRarity).toBe(row?.GiftRarity)
		// …and the item is in the inventory, not just on the box.
		const items = await exports.default.fetch(`${ORIGIN}/api/avatar/v4/items`, {
			headers: await bearer('83'),
		})
		const owned = (await items.json()) as Array<{ avatarItemDesc: string }>
		expect(owned.map((i) => i.avatarItemDesc)).toContain(box?.AvatarItemDesc)
		// The box announces the activity's context, not the generic GameRewards one.
		const frames = await drainFrames()
		expect(frames[0]?.notificationType).toBe(NotificationType.GiftPackageReceivedImmediate)
		expect(frames[0]?.payload).toMatchObject({
			GiftContext: 4003,
			AvatarItemDesc: box?.AvatarItemDesc,
		})

		// Lasertag's single reward is 50 Laser Tag tickets: credited to the balance, no item.
		const before = await getBalance(
			env.DB,
			83,
			CurrencyType.LaserTagTickets,
			DEFAULT_STARTING_TOKENS
		)
		expect((await request('rewardType=PostGameActivity&giftContext=Lasertag')).status).toBe(200)
		expect(
			await getBalance(env.DB, 83, CurrencyType.LaserTagTickets, DEFAULT_STARTING_TOKENS)
		).toBe(before + 50)
		const ticketBox = (await giftBoxes('83'))[1]
		expect(ticketBox).toMatchObject({
			Currency: 50,
			CurrencyType: CurrencyType.LaserTagTickets,
			AvatarItemDesc: '',
			GiftContext: 9000,
		})
		const ticketFrames = await drainFrames()
		expect(ticketFrames.map((f) => f.notificationType)).toContain(
			NotificationType.StorefrontBalanceUpdate
		)

		// An activity the table doesn't know pays the plain XP box, as before. (The LAST box:
		// the two claims above also crossed level 1, and that level-up box sits in between.)
		expect((await request('rewardType=PostGameActivity&giftContext=Bowling')).status).toBe(200)
		const plain = (await giftBoxes('83')).at(-1)
		expect(plain).toMatchObject({ Xp: 5, AvatarItemDesc: '', Currency: 0, GiftContext: 50 })

		// A reward the player already owns is never drawn again: Dodgeball has three rows, so
		// three claims hand over all three, and a fourth — nothing left to give — pays the
		// plain XP box rather than a duplicate.
		const dodgeball = questRewards.Dodgeball.map((r) => r.AvatarItemDesc)
		const handed: string[] = []
		for (let i = 0; i < 4; i++) {
			await env.DB.prepare(
				"DELETE FROM reward_status WHERE account_id = 83 AND gift_context = 'Dodgeball'"
			).run()
			expect((await request('rewardType=PostGameActivity&giftContext=Dodgeball')).status).toBe(200)
			const latest = (await giftBoxes('83')).findLast(
				(b) => b.GiftContext === 8000 || b.GiftContext === 50
			)
			if (i < 3) handed.push(latest?.AvatarItemDesc as string)
			else expect(latest).toMatchObject({ AvatarItemDesc: '', GiftContext: 50 })
		}
		expect(handed.toSorted()).toEqual(dodgeball.toSorted())
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

	test('GET /api/subscriptionseasons/v1/seasons/current returns []', async () => {
		const res = await exports.default.fetch(`${ORIGIN}/api/subscriptionseasons/v1/seasons/current`)
		expect(res.status).toBe(200)
		expect(await res.json()).toEqual([])
	})

	const getSubscription = async (headers: Record<string, string> = {}) =>
		exports.default.fetch(`${ORIGIN}/api/CampusCard/v1/UpdateAndGetSubscription`, {
			method: 'POST',
			headers,
		})

	// Fixed values, and no auth: the client reads this while assembling the RR+ page, so a
	// 401 would only be a way for that load to stall.
	test('GET /api/incentivizedreferrals/progress reports an untouched referral track', async () => {
		const res = await exports.default.fetch(`${ORIGIN}/api/incentivizedreferrals/progress`, {
			headers: await bearer('207'),
		})
		expect(res.status).toBe(200)
		// The payload is nested under `value`, unlike econ's flat balance bodies.
		expect(await res.json()).toEqual({
			success: true,
			value: { ReferralsVerifiedCount: 0, PlayerReferralRewards: [] },
		})
	})

	test('GET /api/incentivizedreferrals/progress 401s without a bearer token', async () => {
		const res = await exports.default.fetch(`${ORIGIN}/api/incentivizedreferrals/progress`)
		expect(res.status).toBe(401)
		expect(await res.text()).toBe('')
	})

	test('GET /api/influencerpartnerprogram/influencers lists nobody', async () => {
		const res = await exports.default.fetch(
			`${ORIGIN}/api/influencerpartnerprogram/influencers?take=1000`,
			{ headers: await bearer('207') }
		)
		expect(res.status).toBe(200)
		// An object around the list, not a bare array — unlike its single-account siblings
		// below, whose whole body is a bare tier number.
		expect(await res.json()).toEqual({ InfluencerIds: [] })
	})

	test('GET /api/influencerpartnerprogram/influencers 401s without a bearer token', async () => {
		const res = await exports.default.fetch(`${ORIGIN}/api/influencerpartnerprogram/influencers`)
		expect(res.status).toBe(401)
	})

	test('GET /api/influencerpartnerprogram/influencer answers a bare 0', async () => {
		const res = await exports.default.fetch(
			`${ORIGIN}/api/influencerpartnerprogram/influencer?accountId=220`,
			{ headers: await bearer('206') }
		)
		expect(res.status).toBe(200)
		// The tier is the WHOLE body — a bare number, not `{ Tier: 0 }` or a string. 0 is
		// "not an influencer", which every account is here.
		expect(res.headers.get('content-type')).toContain('application/json')
		expect(await res.text()).toBe('0')

		// Any account, the caller's own included, gets the same answer.
		const self = await exports.default.fetch(
			`${ORIGIN}/api/influencerpartnerprogram/influencer?accountId=206`,
			{ headers: await bearer('206') }
		)
		expect(await self.json()).toBe(0)
	})

	test('GET /api/influencerpartnerprogram/myinfluencer answers a bare 0', async () => {
		// The `my` form takes the account from the token instead of a query parameter, and
		// answers the same tier in the same shape.
		const res = await exports.default.fetch(`${ORIGIN}/api/influencerpartnerprogram/myinfluencer`, {
			headers: await bearer('206'),
		})
		expect(res.status).toBe(200)
		expect(await res.text()).toBe('0')
	})

	test('the influencer tier routes 401 without a bearer token', async () => {
		// Auth is checked before anything is answered, so an unauthenticated caller is told
		// that rather than handed a tier.
		for (const path of ['influencer', 'myinfluencer']) {
			const res = await exports.default.fetch(`${ORIGIN}/api/influencerpartnerprogram/${path}`)
			expect(res.status, path).toBe(401)
			expect(await res.text()).toBe('')
		}
	})

	test('GET /api/makerai/checkfreetrialeligibility answers a bare false', async () => {
		const res = await exports.default.fetch(`${ORIGIN}/api/makerai/checkfreetrialeligibility`, {
			headers: await bearer('206'),
		})
		expect(res.status).toBe(200)
		expect(res.headers.get('content-type')).toContain('application/json')
		// The whole body is the boolean — not `{ value: false }`, not an envelope.
		expect(await res.text()).toBe('false')
	})

	test('GET /api/makerai/checkfreetrialeligibility 401s without a bearer token', async () => {
		const res = await exports.default.fetch(`${ORIGIN}/api/makerai/checkfreetrialeligibility`)
		expect(res.status).toBe(401)
		expect(await res.text()).toBe('')
	})

	test('GET /api/CampusCard/v1/SignUpBonus returns the running bonus, unauthenticated', async () => {
		const res = await exports.default.fetch(`${ORIGIN}/api/CampusCard/v1/SignUpBonus`)
		expect(res.status).toBe(200)
		expect(await res.json()).toEqual({
			RRPlusSignUpBonusId: 3,
			MinFreeItemsPrice: 6000,
			MaxFreeItemsPrice: 10000,
		})
	})

	test('POST /api/CampusCard/v1/UpdateAndGetSubscription gives a developer a Gold year', async () => {
		const res = await getSubscription(await bearer('205', ['gameClient'], undefined, true))
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
		// A plain player's token: valid, no elevated role, and no `hasPlus` on the account.
		expect(await (await getSubscription(await bearer('206', ['gameClient']))).json()).toEqual({})
		// A token with no `role` claim at all.
		expect(await (await getSubscription(await bearer('206'))).json()).toEqual({})
		// No token: "not subscribed" rather than 401, so a loading client isn't stalled.
		const anon = await getSubscription()
		expect(anon.status).toBe(200)
		expect(await anon.json()).toEqual({})
	})

	// Plus reaches this worker as the token's `rn.plus` claim, which `auth` stamps from
	// `account.hasPlus` at login. Nothing here reads the account, so this is the whole
	// mechanism — and the reason a player who claims on the website has to sign in again.
	//
	// The token carries only `gameClient`, exactly as a game client's does.
	test('POST /api/CampusCard/v1/UpdateAndGetSubscription honours the rn.plus claim', async () => {
		const res = await getSubscription(await bearer('9208', ['gameClient'], undefined, true))
		expect(res.status).toBe(200)
		const body = (await res.json()) as { Subscription: Record<string, unknown> }
		expect(body.Subscription).toMatchObject({
			SubscriptionId: 1,
			RecNetPlayerId: 9208,
			PlatformType: -1,
			Level: 0,
			Period: 1,
			IsAutoRenewing: true,
		})
	})

	// The `developer` role used to BE the subscription, as a stand-in while nothing else
	// could confer one. Now that Plus has a real source it is one thing with one source, and
	// an elevated account is not a subscriber unless it also holds `rn.plus`. Pinned because
	// nothing else would fail if the old shortcut came back: it would silently hand Plus (and
	// the 10% discount) to every operator account.
	test('the developer role alone is not a Rec Room Plus subscription', async () => {
		const dev = await getSubscription(await bearer('9210', ['gameClient', 'developer']))
		expect(dev.status).toBe(200)
		expect(await dev.json()).toEqual({})

		// …and it buys nothing at the subscriber price either, so the report and the buy path
		// agree. 85 is the SubscriberPrices entry for sf300's 2263; 95 is the list price.
		const discounted = await buy2263(await bearer('9211', ['gameClient', 'developer']), 85)
		expect(discounted.status).toBe(409)
	})

	// Plus is priced, not just displayed: the same claim gates the subscriber discount band
	// on a buy. A subscriber whose client applied the discount itself and then had the
	// purchase refused as a price mismatch is exactly what one definition prevents, so the
	// CampusCard report and the buy must never disagree.
	test('an rn.plus token is charged the subscriber price', async () => {
		const res = await buy2263(await bearer('9326', ['gameClient'], undefined, true), 85)
		expect(res.status).toBe(200)
		expect(((await res.json()) as { Balance: number }).Balance).toBe(-85)

		// The same request without the claim is refused, so the discount really comes from
		// `rn.plus` and not from the band being open to everyone.
		const plain = await buy2263(await bearer('9327', ['gameClient']), 85)
		expect(plain.status).toBe(409)
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
			'GET /api/CampusCard/v1/SignUpBonus',
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
			'GET /api/incentivizedreferrals/progress',
			'GET /api/influencerpartnerprogram/influencer',
			'GET /api/influencerpartnerprogram/influencers',
			'GET /api/influencerpartnerprogram/myinfluencer',
			'GET /api/itemWishlists/v1/wishlist/me',
			'GET /api/itemWishlists/v1/wishlist/{accountId}',
			'GET /api/makerai/checkfreetrialeligibility',
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
			'GET /api/subscriptionseasons/v1/seasons/current',
			'GET /api/ugcPurchasables/v1/items/room/{roomId}',
			'GET /econ/customAvatarItems/v1/owned',
			'GET /econ/roomEconConfig/{roomId}',
			'GET /econ/roomGiftDropShops/room/{roomId}',
			'GET /econ/roomInventory/room/{roomId}',
			'GET /econ/roomInventory/room/{roomId}/player',
			'GET /econ/roomInventoryItemTags/room/{roomId}',
			'GET /econ/roomOffer/room/{roomId}',
			'GET /econ/roomOffer/room/{roomId}/purchaseCounts',
			'POST /api/CampusCard/v1/UpdateAndGetSubscription',
			'POST /api/avatar/v1/lockeditems/bulk',
			'POST /api/avatar/v2/gifts/consume',
			'POST /api/avatar/v2/set',
			'POST /api/avatar/v3/saved/set',
			'POST /api/avatar/v4/saved/set',
			'POST /api/challenge/v2/updateProgress',
			'POST /api/checklist/v1/complete',
			'POST /api/checklist/v2/complete',
			'POST /api/consumables/v1/consume',
			'POST /api/equipment/v1/update',
			'POST /api/gamerewards/v1/request',
			'POST /api/items/bulkpurchase',
			'POST /api/items/purchaseInfos',
			'POST /api/objectives/v1/cleargroup',
			'POST /api/objectives/v1/updateobjective',
			'POST /api/storefronts/v2/buyItem',
			'POST /api/storefronts/v3/buyInvention',
			'POST /api/ugcPurchasables/v1/items/bulk',
			'PUT /api/equipment/v1/update',
		])

		// Every operation carries a summary — a path present but undescribed is not
		// documentation.
		for (const ops of Object.values(spec.paths)) {
			for (const op of Object.values(ops)) expect(op.summary).toBeTruthy()
		}
	})
})

// The item catalog. Loaded by migration, not written at runtime, so these exercise the SHAPE of
// the table and its query helpers against a handful of hand-seeded rows; the drift test at the
// end is what pins the thousands of real ones.
describe('catalog', () => {
	// One row of each kind, plus the cases that decided the schema: an avatar_item_id shared by
	// two rows and absent from a third, and keys that are alpha strings rather than GUIDs.
	//
	// Starts from an EMPTY table: the suite-wide setup seeds skins for the weekly-challenge gift
	// pool, and the exact counts and lists below are about these rows alone. This block is the
	// last in the file, so clearing is safe.
	beforeAll(async () => {
		await env.DB.prepare('DELETE FROM catalog').run()
		const insert = (row: unknown[]) =>
			env.DB.prepare(
				`INSERT INTO catalog (
					item_key, catalog_id, kind, friendly_name, tooltip, rarity, platform_mask,
					thumbnail_image, avatar_item_type, avatar_item_id, is_base_avatar_item, tag_list,
					created_at, prefab_name, unlocked_level
				) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15)`
			)
				.bind(...row)
				.run()

		// `catalog_id` is handed out by the loader as 1..N over the captures. These seeds number
		// themselves the same way but from a base far above N, so a test that inserts a REAL
		// capture row (which carries its own low id) cannot collide with a seed — the constraint
		// under test should only ever fire on something the test meant to collide.
		let nextId = 900_001

		/** An avatar item: `item_key` is its `AvatarItemDesc`, the skin columns stay null. */
		const avatarItem = (
			desc: string,
			name: string,
			tooltip: string | null,
			rarity: number,
			type: number,
			id: number | null,
			tag: string | null,
			createdAt: string | null,
			thumb: string | null
		) =>
			insert([
				desc,
				nextId++,
				'avatar_item',
				name,
				tooltip,
				rarity,
				-1,
				thumb,
				type,
				id,
				0,
				tag,
				createdAt,
				null,
				null,
			])

		/** A skin: `item_key` is its `ModificationGuid`, the avatar columns stay null. */
		const skin = (guid: string, name: string, tooltip: string | null, prefab: string) =>
			insert([
				guid,
				nextId++,
				'skin',
				name,
				tooltip,
				0,
				-1,
				'',
				null,
				null,
				null,
				null,
				null,
				prefab,
				0,
			])

		await avatarItem(
			'_OWVy3z6iU-M3-zbQgSLig,,,',
			'Vampire Hunter Gloves (Blue)',
			// NULL, not '' — the two are different values in the capture and the client's DTO serves
			// the difference through.
			null,
			10,
			0,
			835,
			null,
			'2018-11-01T17:51:50.733Z',
			'cimomkml6k4toyowd1voh7hqm.png'
		)
		await avatarItem(
			'002a0f2f-1a24-4439-b578-470818ef8325,,,',
			'Turkey Sweater',
			'',
			50,
			0,
			1570,
			'thanksgiving',
			'2020-10-28T00:37:27.263Z',
			'4g2r02n1g5w09re7hl1ba2yyi.png'
		)
		// These two share avatar_item_id 9503 — the reason that column keys nothing.
		await avatarItem(
			'c5010738-41fa-4eca-aeac-e24adaa29789,',
			'Helmet Hair',
			'',
			-1,
			0,
			9503,
			null,
			null,
			null
		)
		await avatarItem(
			'60067e91-18b8-43ab-ae20-a8ea74c757bf,KUAMuM41hk-YLZoqTiKncA',
			'Green Cheer Sash',
			'',
			-1,
			0,
			9503,
			null,
			null,
			null
		)
		// A hair dye: AvatarItemType 1, NO avatar_item_id at all, and a desc that is a bare alpha
		// string with no commas. Still perfectly keyed.
		await avatarItem(
			'pQNfh-3DsEGWfiIls6Qf6g',
			'Permanent Hair Dye (Pirate Gold)',
			'',
			0,
			1,
			null,
			null,
			null,
			null
		)

		await skin('19ef59c7-f74b-4c63-935a-1d4b1abd8518', 'Disc (Coop)', '', '[DiscGolfDisc]')
		// An alpha-string key, from before the game moved to GUIDs.
		await skin('bfrFOdnHzEaIwHqem2dXkg', 'Confetti Gun (Gold)', null, '[PaintballGun] Confetti')
	})

	test('an avatar item reads back by its desc, nullable fields intact', async () => {
		const item = await getAvatarItem(env.DB, '_OWVy3z6iU-M3-zbQgSLig,,,')
		expect(item).toEqual({
			AvatarItemDesc: '_OWVy3z6iU-M3-zbQgSLig,,,',
			AvatarItemType: 0,
			PlatformMask: -1,
			FriendlyName: 'Vampire Hunter Gloves (Blue)',
			// The one the column may never be defaulted to '' for.
			Tooltip: null,
			Rarity: 10,
			TagList: null,
			AvatarItemId: 835,
			IsBaseAvatarItem: false,
			CreatedAt: '2018-11-01T17:51:50.733Z',
			ThumbnailImage: 'cimomkml6k4toyowd1voh7hqm.png',
		})
		expect(await getAvatarItem(env.DB, 'nothing-has-this-desc')).toBeNull()
	})

	test('a skin reads back by its guid, and an alpha-string key is just as good', async () => {
		expect(await getSkin(env.DB, '19ef59c7-f74b-4c63-935a-1d4b1abd8518')).toEqual({
			PrefabName: '[DiscGolfDisc]',
			ModificationGuid: '19ef59c7-f74b-4c63-935a-1d4b1abd8518',
			UnlockedLevel: 0,
			// The catalog does not store this: it is a PLAYER's flag, and the capture recorded one
			// account's. It is overwritten from the player's own `equipment` row.
			Favorited: false,
			PlatformMask: -1,
			FriendlyName: 'Disc (Coop)',
			Tooltip: '',
			Rarity: 0,
			ThumbnailImage: '',
		})

		// 191 of the skins are keyed by the short alpha-string ids the game used before GUIDs. The
		// column is TEXT and compared as text, so these need no special handling — which is exactly
		// why nothing here parses or validates a key's shape.
		const gold = await getSkin(env.DB, 'bfrFOdnHzEaIwHqem2dXkg')
		expect(gold?.FriendlyName).toBe('Confetti Gun (Gold)')
		// Skins carry NULL tooltips too, so the projection must not flatten them to ''.
		expect(gold?.Tooltip).toBeNull()

		expect((await getSkinsForPrefab(env.DB, '[DiscGolfDisc]')).map((s) => s.FriendlyName)).toEqual([
			'Disc (Coop)',
		])
		expect(await getSkin(env.DB, 'no-such-guid')).toBeNull()
	})

	test('one key spans both kinds, and asking for the wrong kind gets null, not a mangled row', async () => {
		// The lookup the inventory wants: a player's owned things are ids of exactly this shape and
		// the row says which kind each turned out to be. No join, no guessing.
		const owned = await getCatalogItems(env.DB, [
			'19ef59c7-f74b-4c63-935a-1d4b1abd8518',
			'_OWVy3z6iU-M3-zbQgSLig,,,',
			// Unknown keys are SKIPPED rather than left as holes, so the result is shorter than the
			// input and must never be read positionally.
			'nothing-owns-this',
		])
		expect(owned.map((r) => [r.kind, r.friendly_name])).toEqual([
			['skin', 'Disc (Coop)'],
			['avatar_item', 'Vampire Hunter Gloves (Blue)'],
		])
		expect(await getCatalogItems(env.DB, [])).toEqual([])

		// A key is unique across BOTH kinds, so a typed accessor handed the other kind's key answers
		// null rather than projecting a skin into an avatar item's shape.
		expect(await getAvatarItem(env.DB, '19ef59c7-f74b-4c63-935a-1d4b1abd8518')).toBeNull()
		expect(await getSkin(env.DB, '_OWVy3z6iU-M3-zbQgSLig,,,')).toBeNull()
		expect(() => toCatalogSkin({ ...(owned[1] as CatalogRow) })).toThrow(/not a skin/)
	})

	test('avatar_item_id is carried as data and keys nothing', async () => {
		// Two seeded rows share 9503 (five real ones do), and the hair dye has no id at all. Keying
		// the table on it would have silently dropped four of those five at load time, which is why
		// it is stored, not indexed, and never looked up by.
		const shared = await searchCatalog(env.DB, CatalogKind.AvatarItem, 'a')
		expect(shared.filter((r) => r.avatar_item_id === 9503)).toHaveLength(2)
		const dye = await getAvatarItem(env.DB, 'pQNfh-3DsEGWfiIls6Qf6g')
		expect(dye?.AvatarItemId).toBeNull()
		expect(dye?.AvatarItemType).toBe(1)
	})

	test('search is case-insensitive, scoped to one kind, and takes wildcards literally', async () => {
		const hits = await searchCatalog(env.DB, CatalogKind.AvatarItem, 'HAIR')
		expect(hits.map((r) => r.friendly_name)).toEqual([
			'Helmet Hair',
			'Permanent Hair Dye (Pirate Gold)',
		])

		// `kind` scopes it: the same needle against skins finds nothing, so a skin search can never
		// surface a wearable.
		expect(await searchCatalog(env.DB, CatalogKind.Skin, 'hair')).toEqual([])
		expect(
			(await searchCatalog(env.DB, CatalogKind.Skin, 'disc')).map((r) => r.prefab_name)
		).toEqual(['[DiscGolfDisc]'])

		// A needle of LIKE metacharacters matches them literally rather than everything — the escape
		// is what stops a player typing `%` from pulling the whole catalog back.
		expect(await searchCatalog(env.DB, CatalogKind.AvatarItem, '%')).toEqual([])
		expect(await searchCatalog(env.DB, CatalogKind.AvatarItem, '_')).toEqual([])
		// A hit that really does contain the character still matches, so escaping didn't break it.
		expect((await searchCatalog(env.DB, CatalogKind.AvatarItem, 'cheer')).length).toBe(1)
	})

	test('seasonal rows come back by tag, and counts are per kind', async () => {
		expect((await getAvatarItemsByTag(env.DB, 'thanksgiving')).map((i) => i.FriendlyName)).toEqual([
			'Turkey Sweater',
		])
		expect(await getAvatarItemsByTag(env.DB, 'halloween')).toEqual([])
		expect(await countCatalog(env.DB)).toEqual({ avatar_item: 5, skin: 2 })
	})

	test('the key is unique across both kinds, so a collision is refused', async () => {
		// A second avatar item with the same desc...
		await expect(
			env.DB.prepare(
				`INSERT INTO catalog (item_key, kind, friendly_name, rarity, platform_mask)
				 VALUES ('_OWVy3z6iU-M3-zbQgSLig,,,', 'avatar_item', 'Impostor', 0, -1)`
			).run()
		).rejects.toThrow()

		// ...a second skin with the same guid...
		await expect(
			env.DB.prepare(
				`INSERT INTO catalog (item_key, kind, friendly_name, rarity, platform_mask, prefab_name)
				 VALUES ('bfrFOdnHzEaIwHqem2dXkg', 'skin', 'Impostor', 0, -1, '[PaintballGun]')`
			).run()
		).rejects.toThrow()

		// ...and a skin claiming an avatar item's key. The kinds share ONE key space, which is what
		// lets an owned id be resolved without first knowing what kind of thing it is.
		await expect(
			env.DB.prepare(
				`INSERT INTO catalog (item_key, kind, friendly_name, rarity, platform_mask, prefab_name)
				 VALUES ('_OWVy3z6iU-M3-zbQgSLig,,,', 'skin', 'Impostor', 0, -1, '[MakerPen]')`
			).run()
		).rejects.toThrow()

		expect(await countCatalog(env.DB)).toEqual({ avatar_item: 5, skin: 2 })
	})

	test('baseAsset takes the first field of an AvatarItemDesc', async () => {
		// `<baseAsset>,<color>,<texture>,` — the base asset is what decides whether the client can
		// draw an item at all, so it is read off the key rather than stored twice.
		expect(baseAsset('_OWVy3z6iU-M3-zbQgSLig,,,')).toBe('_OWVy3z6iU-M3-zbQgSLig')
		expect(baseAsset('60067e91-18b8-43ab-ae20-a8ea74c757bf,KUAMuM41hk-YLZoqTiKncA')).toBe(
			'60067e91-18b8-43ab-ae20-a8ea74c757bf'
		)
		// A dye's desc is a bare alpha string with no commas at all; it is still the base asset.
		expect(baseAsset('pQNfh-3DsEGWfiIls6Qf6g')).toBe('pQNfh-3DsEGWfiIls6Qf6g')
	})

	// The migration builds the TABLE; `runx catalog load` fills it. These two are the seam
	// between them: the schema the tests build must be the schema the migration builds, and the
	// loader must produce rows that schema accepts.
	test('the migrations and CATALOG_SCHEMA_DDL build the same table', async () => {
		// Both migrations together: 0015 builds the table, 0016 adds `catalog_id`. They are
		// separate because 0015 was already applied, and an edit there would never re-run — which
		// is exactly the drift this test exists to catch. `CATALOG_SCHEMA_DDL` declares the end
		// state in one CREATE, so it is compared against the pair.
		const migrations = `${catalogStructureSql}\n${catalogIdSql}`

		// Compared on identifiers rather than text, since the two are formatted differently, and
		// `catalog_id` arrives via ALTER rather than inside the CREATE.
		for (const column of CATALOG_INSERT_COLUMNS) {
			expect(migrations, column).toContain(column)
			expect(CATALOG_SCHEMA_DDL[0], column).toContain(`\t\t${column} `)
		}
		expect(catalogStructureSql).toContain('item_key TEXT PRIMARY KEY')
		expect(CATALOG_SCHEMA_DDL[0]).toContain('item_key TEXT PRIMARY KEY')
		expect(catalogIdSql).toContain('ALTER TABLE catalog ADD COLUMN catalog_id INTEGER')
		for (const index of [
			'idx_catalog_name',
			'idx_catalog_prefab',
			'idx_catalog_tag',
			'idx_catalog_id',
		]) {
			expect(migrations, index).toContain(index)
			expect(CATALOG_SCHEMA_DDL.join('\n'), index).toContain(index)
		}

		// STRUCTURE ONLY. The catalog's contents change as the game's item list does, which is not
		// a schema change — rows here would mean a migration and a deploy per refresh. If this
		// fails, someone put data back into a migration instead of reloading it.
		expect(migrations).not.toContain('INSERT INTO catalog')
		expect(migrations).not.toContain('DELETE FROM catalog')
	})

	test('the loader maps both captures onto the columns it declares', async () => {
		const { rows, collisions } = buildCatalogLoad(avatarItemsJson, skinsJson)

		// Every row carries exactly one value per declared column, in that order — the loader
		// renders them positionally, so a column added to one side and not the other is a silent
		// mis-load rather than an error.
		expect(rows.every((r) => r.values.length === CATALOG_INSERT_COLUMNS.length)).toBe(true)
		const keyAt = CATALOG_INSERT_COLUMNS.indexOf('item_key')
		const kindAt = CATALOG_INSERT_COLUMNS.indexOf('kind')
		expect(rows.every((r) => r.values[keyAt] === r.key)).toBe(true)

		// One key space, both kinds, no collisions between them.
		expect(new Set(rows.map((r) => r.key)).size).toBe(rows.length)
		const kinds = rows.map((r) => r.values[kindAt])
		expect(kinds.filter((k) => k === 'avatar_item')).toHaveLength(avatarItemsJson.length)

		// Skins are the one place the counts may legitimately differ: the capture holds five guids
		// twice. A repeat is a defect rather than something the table models, so the loader keeps
		// the first and RETURNS the rest for the caller to report — dropping them silently is the
		// exact failure the single key exists to prevent.
		const distinctSkinKeys = new Set(skinsJson.map((s) => s.ModificationGuid)).size
		expect(kinds.filter((k) => k === 'skin')).toHaveLength(distinctSkinKeys)
		expect(collisions).toHaveLength(skinsJson.length - distinctSkinKeys)
		expect(collisions.every((c) => c.kept !== c.dropped)).toBe(true)

		// And the rows really do go in: the same table these tests built accepts a sample of the
		// real load unchanged, so a capture that would be rejected in production fails here. Rows
		// this file already seeded are skipped — they are real capture rows too, and re-inserting
		// one would trip the key constraint on the seed rather than on anything under test.
		const sample: CatalogLoadRow[] = []
		for (const row of [rows[0], rows[1], rows[rows.length - 2], rows[rows.length - 1]]) {
			if (row && (await getCatalogItem(env.DB, row.key)) === null) sample.push(row)
		}
		expect(sample.length).toBeGreaterThan(0)
		for (const row of sample) {
			await env.DB.prepare(
				`INSERT INTO catalog (${CATALOG_INSERT_COLUMNS.join(', ')})
				 VALUES (${CATALOG_INSERT_COLUMNS.map((_, i) => `?${i + 1}`).join(', ')})`
			)
				.bind(...row.values.map((v) => v ?? null))
				.run()
			expect((await getCatalogItem(env.DB, row.key))?.friendly_name).toBe(
				row.values[CATALOG_INSERT_COLUMNS.indexOf('friendly_name')]
			)
			await env.DB.prepare('DELETE FROM catalog WHERE item_key = ?1').bind(row.key).run()
		}

		// The row the capture had a skin pasted over. It is an avatar item, and the skin that
		// overwrote its name lives in skins.json where it belongs.
		expect(avatarItemsJson.filter((i) => i.FriendlyName === 'Disc (Coop)')).toEqual([])
		expect(skinsJson.filter((s) => s.FriendlyName === 'Disc (Coop)')).toHaveLength(1)
	})

	test('catalog_id is a contiguous, unique, load-order handle from 10000', async () => {
		const { rows } = buildCatalogLoad(avatarItemsJson, skinsJson)

		// BASE..BASE+N-1 with no gaps, in capture order — avatar items first, then skins. Numbered
		// AFTER de-duplication, so a dropped duplicate must not burn a number and leave a hole.
		//
		// From 10000 rather than 1 because a generated storefront lists a row under this very
		// number as its `PurchasableItemId`, and every captured storefront's ids are 2764 or below
		// — numbering from 1 would have made one id mean two different items.
		expect(rows.map((r) => r.id)).toEqual(rows.map((_, i) => CATALOG_ID_BASE + i))
		expect(Math.min(...rows.map((r) => r.id))).toBe(CATALOG_ID_BASE)
		expect(new Set(rows.map((r) => r.id)).size).toBe(rows.length)

		// The id in the row object and the id in the values it renders are the same number — the
		// loader binds `values` positionally, so a mismatch would write one and report the other.
		const idAt = CATALOG_INSERT_COLUMNS.indexOf('catalog_id')
		expect(rows.every((r) => r.values[idAt] === r.id)).toBe(true)

		// It reads back by number, and the number is NOT the item's identity: `item_key` is. A
		// caller that stored an id across a load would resolve to a different item or to nothing,
		// which is why nothing may persist it.
		const seeded = await getCatalogItemById(env.DB, 900_001)
		expect(seeded?.item_key).toBe('_OWVy3z6iU-M3-zbQgSLig,,,')
		expect(await getCatalogItemById(env.DB, 12_345_678)).toBeNull()

		// Unique where set. Two rows may not share a handle — a number that names two items is
		// useless as a handle.
		await expect(
			env.DB.prepare(
				`INSERT INTO catalog (item_key, catalog_id, kind, friendly_name, rarity, platform_mask)
				 VALUES ('id-collision-probe', 900001, 'skin', 'Impostor', 0, -1)`
			).run()
		).rejects.toThrow()

		// But NULL is allowed any number of times: the index is partial, because a row is
		// un-numbered in the window between existing and a load numbering it, and the loader
		// clears every id before handing out new ones so a merge cannot collide with stale ones.
		for (const key of ['unnumbered-a', 'unnumbered-b']) {
			await env.DB.prepare(
				`INSERT INTO catalog (item_key, kind, friendly_name, rarity, platform_mask)
				 VALUES (?1, 'skin', 'Not Yet Numbered', 0, -1)`
			)
				.bind(key)
				.run()
		}
		expect((await getCatalogItem(env.DB, 'unnumbered-a'))?.catalog_id).toBeNull()
		expect((await getCatalogItem(env.DB, 'unnumbered-b'))?.catalog_id).toBeNull()
		await env.DB.prepare("DELETE FROM catalog WHERE item_key LIKE 'unnumbered-%'").run()
	})

	// `runx catalog load` MERGES by default so a partial capture can add a few items without
	// wiping the rest, and REPLACES only when told to. Both halves of that live in the CLI's SQL,
	// so this exercises the upsert itself — the CLI's own statement, built from the same column
	// list, against the same schema.
	//
	// MUST STAY LAST in this block: the replace half empties the table, including the rows the
	// other catalog tests are seeded with.
	test('a merge inserts, refreshes and preserves; a replace removes', async () => {
		const columns = CATALOG_INSERT_COLUMNS.join(', ')
		const binds = CATALOG_INSERT_COLUMNS.map((_, i) => `?${i + 1}`).join(', ')
		// Every column but the conflict target, derived from the column list exactly as the CLI
		// derives it.
		const conflictUpdate = CATALOG_INSERT_COLUMNS.filter((c) => c !== 'item_key')
			.map((c) => `${c} = excluded.${c}`)
			.join(', ')

		/** The CLI's statement: a full-width insert that upserts on the key. */
		const upsert = (values: CatalogValue[]) =>
			env.DB.prepare(
				`INSERT INTO catalog (${columns}) VALUES (${binds})
				 ON CONFLICT(item_key) DO UPDATE SET ${conflictUpdate}`
			)
				.bind(...values.map((v) => v ?? null))
				.run()

		/** A skin row in column order, so a column added to the table lands here too. */
		const skinValues = (key: string, name: string, rarity: number): CatalogValue[] =>
			CATALOG_INSERT_COLUMNS.map((c) =>
				c === 'item_key'
					? key
					: c === 'kind'
						? CatalogKind.Skin
						: c === 'friendly_name'
							? name
							: c === 'rarity'
								? rarity
								: c === 'platform_mask'
									? -1
									: c === 'prefab_name'
										? '[MakerPen]'
										: null
			)

		// A row nothing in a later load will mention — the one that proves a merge is not a wipe.
		await upsert(skinValues('untouched-by-any-load', 'Hand-Added Sentinel', 0))

		// Insert: a key the table has never seen.
		await upsert(skinValues('merge-test-new', 'Freshly Datamined', 7))
		expect((await getCatalogItem(env.DB, 'merge-test-new'))?.friendly_name).toBe(
			'Freshly Datamined'
		)

		// Refresh: the SAME key again with different values updates in place rather than either
		// erroring on the key or piling up a second row.
		const before = await countCatalog(env.DB)
		await upsert(skinValues('merge-test-new', 'Renamed By Refresh', 42))
		const refreshed = await getCatalogItem(env.DB, 'merge-test-new')
		expect(refreshed?.friendly_name).toBe('Renamed By Refresh')
		expect(refreshed?.rarity).toBe(42)
		expect(await countCatalog(env.DB)).toEqual(before)

		// Preserve: neither of those touched the sentinel. This is the whole point of the default
		// — a capture holding two items must not delete the other three thousand.
		expect((await getCatalogItem(env.DB, 'untouched-by-any-load'))?.friendly_name).toBe(
			'Hand-Added Sentinel'
		)

		// Every column but the key is carried by the refresh. Derived rather than written out, so
		// a column added to the table and forgotten would silently stop being merged.
		for (const column of CATALOG_INSERT_COLUMNS) {
			expect(conflictUpdate.includes(`${column} = excluded.${column}`), column).toBe(
				column !== 'item_key'
			)
		}

		// Replace: `DELETE FROM catalog` first, and the sentinel goes with everything else. That is
		// why it is opt-in — pointed at a partial capture it removes whatever the file omits.
		const { rows } = buildCatalogLoad(avatarItemsJson, skinsJson)
		await env.DB.prepare('DELETE FROM catalog').run()
		await upsert((rows[0] as CatalogLoadRow).values)
		expect(await getCatalogItem(env.DB, 'untouched-by-any-load')).toBeNull()
		expect(await getCatalogItem(env.DB, 'merge-test-new')).toBeNull()
		expect(await countCatalog(env.DB)).toEqual({ avatar_item: 1 })
	})
})
