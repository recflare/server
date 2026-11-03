/**
 * Fills in `Price` and `Name` on an export of first-party custom avatar items from a storefront
 * dump, rewriting the export in place so `import-custom-avatar-items.ts` / `just admin cai-load`
 * carry the price into the table.
 *
 *   bun apps/api/scripts/price-custom-avatar-items.ts <export.json> <storefront.json>
 *
 * The export (e.g. `apps/econ/static/db/2025-1-cai.json`) mostly carries `Price: 0`. The
 * storefront (e.g. `Watch_EnumValue_3.json`, a `{ StoreItems: [...] }` page) prices the same
 * items, joined on `GiftDrop.AvatarItemInfo.DownloadableAvatarItemId` = `CustomAvatarItemId`.
 * The price taken is the base token price (`CurrencyType` 2), ignoring any sale. The storefront
 * only prices what the export already holds: nothing is added from it.
 *
 * The export's `Name` is often the asset's machine name (`AnimeFiendHunter_Shirt`), which is what
 * the client shows; the storefront's `GiftDrop.FriendlyName` ("Fiend Hunter Trench Coat (Gothic)")
 * replaces it. An item the storefront doesn't list keeps its name.
 *
 * An item the storefront doesn't list keeps the price it had, unless that price is 0, which
 * would make it free to buy. Those are the Cryptid Creek event items and the Evergrown Hip Pack,
 * all rarity-50 rewards that were never sold, so they get the catalog's rarity-50 price.
 */

import { readFileSync, writeFileSync } from 'node:fs'

import { priceForRarity } from '../../econ/src/catalog-load'

const TOKENS = 2

/** The rarity an item missing from the storefront is priced as, when it has no price. */
const UNLISTED_RARITY = 50

interface StoreItem {
	GiftDrop?: {
		FriendlyName?: string | null
		AvatarItemInfo?: { DownloadableAvatarItemId?: string | null } | null
	}
	Prices?: Array<{ CurrencyType: number; Price: number }>
}

const [exportPath, storefrontPath] = process.argv.slice(2)
if (!exportPath || !storefrontPath) {
	console.error(
		'usage: bun apps/api/scripts/price-custom-avatar-items.ts <export.json> <storefront.json>'
	)
	process.exit(2)
}

// Tolerate the BOM a .NET export carries (`JSON.parse` rejects U+FEFF).
const readJson = (path: string) => JSON.parse(readFileSync(path, 'utf8').replace(/^﻿/, ''))

const items: Array<{ CustomAvatarItemId: string; Name: string; Price: number }> =
	readJson(exportPath)
const storefront: { StoreItems: StoreItem[] } = readJson(storefrontPath)

const prices = new Map<string, number>()
const names = new Map<string, string>()
for (const storeItem of storefront.StoreItems) {
	const id = storeItem.GiftDrop?.AvatarItemInfo?.DownloadableAvatarItemId?.toLowerCase()
	if (!id) continue
	const price = storeItem.Prices?.find((p) => p.CurrencyType === TOKENS)?.Price
	if (price !== undefined && !prices.has(id)) {
		prices.set(id, price)
	}
	const name = storeItem.GiftDrop?.FriendlyName?.trim()
	if (name && !names.has(id)) {
		names.set(id, name)
	}
}

let priced = 0
let changed = 0
let renamed = 0
const unmatched: string[] = []
for (const item of items) {
	const name = names.get(item.CustomAvatarItemId.toLowerCase())
	if (name && item.Name !== name) {
		item.Name = name
		renamed++
	}
	let price = prices.get(item.CustomAvatarItemId.toLowerCase())
	if (price === undefined) {
		unmatched.push(item.Name)
		if (item.Price) continue
		price = priceForRarity(UNLISTED_RARITY)
	}
	priced++
	if (item.Price !== price) {
		if (item.Price) {
			console.warn(`${item.Name}: ${item.Price} -> ${price}`)
		}
		item.Price = price
		changed++
	}
}

writeFileSync(exportPath, JSON.stringify(items, null, 2) + '\n')
console.log(
	`priced ${priced}/${items.length} items (${changed} changed), renamed ${renamed}, in ${exportPath}`
)
if (unmatched.length) {
	console.log(
		`not in the storefront (kept their price, or rarity ${UNLISTED_RARITY} if free): ${unmatched.join(', ')}`
	)
}
