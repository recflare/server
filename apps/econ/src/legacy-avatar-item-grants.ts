/**
 * Granting the custom avatar item that REPLACED an avatar item a player already owns — the
 * statements behind `runx admin cai-grant-legacy`. Pure data mapping with no imports, so the
 * Node CLI and the worker tests share it (the same split as `catalog-load.ts`).
 *
 * The storefront dumps (`static/storefronts/sf*.json`) pair each baked item with the custom
 * avatar item that replaced it: a listing's `GiftDrop.AvatarItemInfo` names the old
 * `LegacyAvatarItemDesc` beside its `DownloadableAvatarItemId`, which is a
 * `CustomAvatarItemId`. A player whose `inventory` holds the legacy descriptor is granted that
 * custom item in `inventory_custom`, if `custom_avatar_item` holds it.
 *
 * Re-runnable at any time: a grant is an INSERT that skips what the player already owns, so a
 * second run only picks up what changed since — new inventory, a newly loaded catalog item, a
 * newly added dump. Nothing is ever removed.
 */

/**
 * Most of a statement's budget for its mapping literal. D1 refuses a statement over 100 KB,
 * and the whole mapping (~2,500 pairs) is several times that, so it is split across statements.
 */
const MAX_MAPPING_BYTES = 80_000

/**
 * A descriptor as matching compares it. The inventory keeps `AvatarItemDesc` verbatim,
 * trailing commas and all (`a,b,c,`), while `LegacyAvatarItemDesc` has none (`a,b,c`); the
 * guids themselves are base64 and case-sensitive, so nothing else is normalized.
 */
export function normalizeLegacyDesc(desc: string): string {
	return desc.replace(/,+$/, '')
}

/**
 * Every `LegacyAvatarItemDesc` → `DownloadableAvatarItemId` pair the storefronts list, keyed by
 * the normalized descriptor, the id lowercased. Refuses a descriptor two listings map to
 * different items: which one the player "really" owns is not a choice to make silently.
 */
export function legacyAvatarItemMap(storefronts: unknown[]): Map<string, string> {
	const map = new Map<string, string>()
	for (const storefront of storefronts) {
		const items = (storefront as { StoreItems?: unknown } | null)?.StoreItems
		if (!Array.isArray(items)) continue
		for (const item of items as Array<{
			GiftDrop?: {
				AvatarItemInfo?: {
					LegacyAvatarItemDesc?: unknown
					DownloadableAvatarItemId?: unknown
				} | null
			} | null
		}>) {
			const info = item?.GiftDrop?.AvatarItemInfo
			const legacy = info?.LegacyAvatarItemDesc
			const id = info?.DownloadableAvatarItemId
			if (typeof legacy !== 'string' || typeof id !== 'string') continue
			const key = normalizeLegacyDesc(legacy)
			if (key === '' || id === '') continue
			const value = id.toLowerCase()
			const existing = map.get(key)
			if (existing !== undefined && existing !== value) {
				throw new Error(`legacy item ${key} maps to both ${existing} and ${value}`)
			}
			map.set(key, value)
		}
	}
	return map
}

const sqlStr = (s: string): string => `'${s.replace(/'/g, "''")}'`

/**
 * One grant over a slice of the mapping. Joins the player's inventory (descriptor normalized)
 * to the catalog through the mapping. The catalog join is exact, on its unique index: the
 * first-party exports spell every id lowercase, as the mapping does. `NOT EXISTS` (case-insensitive, like `ownedCustomAvatarItemIds`)
 * rather than `OR IGNORE` alone, so an id granted earlier in another case is not doubled; the
 * `OR IGNORE` covers two inventory rows that resolve to the same item.
 */
function grantStatement(
	pairs: Array<[string, string]>,
	preview: { accountId?: number } | null
): string {
	const values = pairs.map(([legacy, id]) => `(${sqlStr(legacy)}, ${sqlStr(id)})`).join(',\n')
	const from = `FROM inventory inv
JOIN legacy_map m ON m.legacy_desc = rtrim(inv.avatar_item_desc, ',')
JOIN custom_avatar_item cai ON cai.custom_avatar_item_id = m.cai_id
WHERE NOT EXISTS (
	SELECT 1 FROM inventory_custom owned
	WHERE owned.account_id = inv.account_id
	AND lower(owned.custom_avatar_item_id) = lower(cai.custom_avatar_item_id)
)`
	const body =
		preview === null
			? `INSERT OR IGNORE INTO inventory_custom (account_id, custom_avatar_item_id, acquired_at)
SELECT DISTINCT inv.account_id, cai.custom_avatar_item_id, strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
${from}`
			: `SELECT DISTINCT inv.account_id, cai.custom_avatar_item_id, json_extract(cai.data, '$.Name') AS name,
	inv.avatar_item_desc
${from}${preview.accountId === undefined ? '' : `\nAND inv.account_id = ${Math.trunc(preview.accountId)}`}
ORDER BY inv.account_id, name`
	return `WITH legacy_map (legacy_desc, cai_id) AS (VALUES
${values}
)
${body};`
}

/** The mapping in slices small enough for D1's statement limit. */
function mappingChunks(map: Map<string, string>): Array<Array<[string, string]>> {
	const chunks: Array<Array<[string, string]>> = []
	let chunk: Array<[string, string]> = []
	let bytes = 0
	for (const pair of [...map].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))) {
		const size = pair[0].length + pair[1].length + 10
		if (chunk.length > 0 && bytes + size > MAX_MAPPING_BYTES) {
			chunks.push(chunk)
			chunk = []
			bytes = 0
		}
		chunk.push(pair)
		bytes += size
	}
	if (chunk.length > 0) chunks.push(chunk)
	return chunks
}

/** The grant for the whole mapping, as as many statements as D1's size limit needs. */
export function legacyGrantStatements(map: Map<string, string>): string[] {
	return mappingChunks(map).map((chunk) => grantStatement(chunk, null))
}

/** One row of {@link legacyGrantPreviewStatements}: an item a run would grant, and why. */
export interface LegacyGrantPreviewRow {
	account_id: number
	custom_avatar_item_id: string
	/** The catalog item's `Name`. */
	name: string | null
	/** The inventory row that earns it, verbatim. */
	avatar_item_desc: string
}

/**
 * The grant as read-only queries, one per statement of {@link legacyGrantStatements}: together
 * their rows are every item a run would grant right now, optionally for one account. Two
 * inventory rows that resolve to the same item give two rows here and one grant, so dedupe on
 * (account, item) before counting.
 */
export function legacyGrantPreviewStatements(
	map: Map<string, string>,
	accountId?: number
): string[] {
	return mappingChunks(map).map((chunk) => grantStatement(chunk, { accountId }))
}
