/** Shared persisted Studio authoring state. Existing storefront items remain unchanged. */
export const AVATAR_STUDIO_SCHEMA = [
	`CREATE TABLE IF NOT EXISTS avatar_studio_access (account_id INTEGER PRIMARY KEY, flags INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL, modified_at TEXT NOT NULL)`,
	`CREATE TABLE IF NOT EXISTS avatar_studio_save (id INTEGER PRIMARY KEY AUTOINCREMENT, item_id TEXT NOT NULL, body_type INTEGER NOT NULL, unity_asset_id TEXT NOT NULL, source_filename TEXT NOT NULL, source_hash TEXT NOT NULL, thumbnail TEXT NOT NULL, moderation_image TEXT, configuration TEXT NOT NULL, description TEXT, update_current INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL)`,
	`CREATE INDEX IF NOT EXISTS idx_avatar_studio_save_item ON avatar_studio_save(item_id,id)`,
	`CREATE TABLE IF NOT EXISTS studio_avatar_build (cloud_build_id TEXT PRIMARY KEY, item_id TEXT NOT NULL, save_id INTEGER NOT NULL)`,
]

export interface AvatarStudioItem {
	CustomAvatarItemId: string
	CreatorAccountId: number
	OutfitType: number
	Accessibility: number
	CurrentSaves: Array<Record<string, unknown>>
	[key: string]: unknown
}
export interface AvatarStudioSave {
	id: number
	item_id: string
	body_type: number
	unity_asset_id: string
	source_filename: string
	source_hash: string
	thumbnail: string
	moderation_image: string | null
	configuration: string
	description: string | null
	update_current: number
	created_at: string
}
/** Independent authoring permissions reported by Studio's access override. */
export const AVATAR_STUDIO_ACCESS = {
	'avatar-items': 1,
	'avatar-costumes': 2,
	'avatar-badges': 4,
	'avatar-consumables': 8,
} as const

export async function avatarStudioFlags(db: D1Database, accountId: number): Promise<number> {
	const row = await db
		.prepare('SELECT flags FROM avatar_studio_access WHERE account_id=?')
		.bind(accountId)
		.first<{ flags: number }>()
	return row?.flags ?? 0
}
export const AVATAR_STUDIO_SLOTS = [
	0, 2, 3, 10, 20, 100, 101, 102, 103, 104, 200, 203, 300, 301, 500, 501, 502, 503, 504, 505, 506,
	507, 508, 509, 510, 511, 512, 1000,
]
export function avatarItemAccessBit(outfitType: number): number {
	return outfitType === 1000 ? 4 : outfitType >= 500 && outfitType <= 512 ? 2 : 1
}
export async function avatarStudioItem(
	db: D1Database,
	id: string
): Promise<AvatarStudioItem | null> {
	const row = await db
		.prepare('SELECT data FROM custom_avatar_item WHERE custom_avatar_item_id=?')
		.bind(id)
		.first<{ data: string }>()
	return row ? (JSON.parse(row.data) as AvatarStudioItem) : null
}
export async function avatarStudioSave(
	db: D1Database,
	itemId: string,
	id: number
): Promise<AvatarStudioSave | null> {
	return db
		.prepare('SELECT * FROM avatar_studio_save WHERE item_id=? AND id=?')
		.bind(itemId, id)
		.first<AvatarStudioSave>()
}
export async function avatarSaveDto(db: D1Database, row: AvatarStudioSave, target = 0) {
	const { results } = await db
		.prepare(
			'SELECT unity_asset_id AS UnityAssetId,target AS Target,version AS Version,filename AS Filename,hash AS Hash,kind FROM unity_asset WHERE unity_asset_id=?'
		)
		.bind(row.unity_asset_id)
		.all<{
			UnityAssetId: string
			Target: number
			Version: number
			Filename: string
			Hash: string
			kind: string
		}>()
	const main = results.find((a) => a.Target === target && a.kind === 'main')
	const material = results.find((a) => a.Target === target && a.kind === 'material')
	return {
		CustomAvatarItemSaveId: row.id,
		CustomAvatarItemId: row.item_id,
		UnityAssetId: row.unity_asset_id,
		BodyType: row.body_type,
		CreatedAt: row.created_at,
		ModifiedAt: row.created_at,
		Description: row.description,
		ThumbnailFileName: row.thumbnail,
		AdditionalConfiguration: row.configuration,
		SourceUnityAssetFilename: row.source_filename,
		SourceUnityAssetHash: row.source_hash,
		ModerationImageFileName: row.moderation_image,
		UnityAsset: main?.Filename ?? null,
		UnityAssetHash: main?.Hash ?? null,
		UnityAsset2: material?.Filename ?? null,
		UnityAsset2Hash: material?.Hash ?? null,
		BakedAssets: results.filter((a) => a.kind !== 'stripped').map(({ kind: _kind, ...a }) => a),
	}
}
/** Publish exactly this built revision for its body type, preserving other body types. */
export async function publishAvatarSave(
	db: D1Database,
	itemId: string,
	saveId: number,
	automatic = false,
	attempt = 0
): Promise<boolean> {
	const item = await avatarStudioItem(db, itemId)
	const save = await avatarStudioSave(db, itemId, saveId)
	if (!item || !save) return false
	const dto = await avatarSaveDto(db, save)
	// Badge images are uploaded and published directly by the SDK, without a Unity build.
	if (!dto.UnityAsset && item.OutfitType !== 1000) return false
	const quest = await avatarSaveDto(db, save, 2)
	const {
		SourceUnityAssetFilename: _source,
		SourceUnityAssetHash: _hash,
		BakedAssets: _baked,
		...published
	} = dto
	// JSON mutation is conditional on the complete prior snapshot: concurrent body-type
	// publications cannot overwrite each other or resurrect a deleted item.
	const prior = JSON.stringify(item)
	item.CurrentSaves = [
		...(item.CurrentSaves ?? []).filter((s) => s.BodyType !== save.body_type),
		{
			...published,
			OutfitType: item.OutfitType,
			QuestUnityAssetHash: quest.UnityAssetHash,
			QuestUnityAsset2Hash: quest.UnityAsset2Hash,
		},
	]
	item.ModifiedAt = new Date().toISOString()
	item.ThumbnailImageFilename = save.thumbnail
	if (item.OutfitType === 1000)
		item.CustomBadgeMetadata = { RoomId: JSON.parse(save.configuration)?.d?.d?.r ?? 0 }
	const result = await db
		.prepare(
			`UPDATE custom_avatar_item SET data=? WHERE custom_avatar_item_id=? AND json(data)=json(?)
			 AND (?=0 OR ?=(SELECT MAX(id) FROM avatar_studio_save WHERE item_id=? AND body_type=?))`
		)
		.bind(JSON.stringify(item), itemId, prior, automatic ? 1 : 0, saveId, itemId, save.body_type)
		.run()
	if (!result.meta.changes && attempt < 5 && (await avatarStudioItem(db, itemId)))
		return publishAvatarSave(db, itemId, saveId, automatic, attempt + 1)
	return result.meta.changes > 0
}
