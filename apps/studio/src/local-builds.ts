import {
	getSubRoom,
	markRoomAsRecRoomStudio,
	publicStudioBundleFilename,
	setSubRoomSaveUnityAssetId,
} from '@repo/domain'

/** Mirrors migrations/0001_studio_cloud_build.sql. Tests apply this; deploy uses the file. */
export const STUDIO_CLOUD_BUILD_SCHEMA_DDL: string[] = [
	`CREATE TABLE IF NOT EXISTS studio_cloud_build (
		cloud_build_id TEXT PRIMARY KEY,
		room_id INTEGER NOT NULL,
		sub_room_id INTEGER NOT NULL,
		sub_room_data_save_id INTEGER NOT NULL,
		unity_asset_id TEXT NOT NULL,
		created_by_account_id INTEGER NOT NULL,
		started_at TEXT NOT NULL,
		completed_at TEXT NOT NULL,
		error TEXT
	)`,
	`CREATE INDEX IF NOT EXISTS idx_studio_cloud_build_room
		ON studio_cloud_build (room_id, sub_room_id, started_at)`,
	`CREATE TABLE IF NOT EXISTS studio_unity_asset_file (
		unity_asset_id TEXT NOT NULL,
		platform TEXT NOT NULL,
		kind TEXT NOT NULL,
		filename TEXT NOT NULL,
		sha256 TEXT NOT NULL,
		byte_length INTEGER NOT NULL,
		r2_key TEXT NOT NULL,
		PRIMARY KEY (unity_asset_id, platform, kind)
	)`,
]

export interface CloudBuildRow {
	cloudBuildId: string
	startedAt: string
	completedAt: string | null
	error: string | null
	unityAssetId: string
	createdByAccountId: number
}

export type BundlePlatform = 'windows' | 'android'
export type BundleKind = 'main' | 'stripped'

export interface LocalBundleFile {
	platform: BundlePlatform
	kind: BundleKind
	filename: string
	bytes: ArrayBuffer
}

export interface StoredLocalBuild extends CloudBuildRow {
	subRoomDataSaveId: number
}

interface BuildListRow {
	cloud_build_id: string
	started_at: string
	completed_at: string | null
	error: string | null
	unity_asset_id: string
	created_by_account_id: number
}

function toCloudBuild(row: BuildListRow): CloudBuildRow {
	return {
		cloudBuildId: row.cloud_build_id,
		startedAt: row.started_at,
		completedAt: row.completed_at,
		error: row.error,
		unityAssetId: row.unity_asset_id,
		createdByAccountId: row.created_by_account_id,
	}
}

/** Page of cloud builds for one subroom, newest first. `total` counts the whole subroom. */
export async function listCloudBuilds(
	db: D1Database,
	roomId: number,
	subRoomId: number,
	skip: number,
	take: number
): Promise<{ results: CloudBuildRow[]; totalResults: number }> {
	const total = await db
		.prepare(
			`SELECT COUNT(*) AS n FROM studio_cloud_build
			 WHERE room_id = ?1 AND sub_room_id = ?2`
		)
		.bind(roomId, subRoomId)
		.first<{ n: number | string }>()
	const { results } = await db
		.prepare(
			`SELECT cloud_build_id, started_at, completed_at, error, unity_asset_id, created_by_account_id
			 FROM studio_cloud_build
			 WHERE room_id = ?1 AND sub_room_id = ?2
			 ORDER BY started_at DESC, cloud_build_id DESC
			 LIMIT ?3 OFFSET ?4`
		)
		.bind(roomId, subRoomId, take, skip)
		.all<BuildListRow>()
	return { results: results.map(toCloudBuild), totalResults: Number(total?.n ?? 0) }
}

async function sha256Hex(bytes: ArrayBuffer): Promise<string> {
	const digest = await crypto.subtle.digest('SHA-256', bytes)
	return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('')
}

/**
 * Store a PC-built Windows + Android pair as a cloud build that is already finished.
 * The bytes go to R2. The build row points at the subroom's current save, that save's
 * `UnityAssetId` is set to the new asset, and the room is marked as a Studio room the
 * first time (`BecameRRStudioRoomAt`).
 *
 * Returns null when the subroom has no current save — the caller uploaded bundles
 * before Upload created one.
 */
export async function storeLocalCloudBuild(
	db: D1Database,
	bucket: R2Bucket,
	roomId: number,
	subRoomId: number,
	accountId: number,
	files: LocalBundleFile[]
): Promise<StoredLocalBuild | null> {
	const sub = await getSubRoom(db, roomId, subRoomId)
	if (!sub) return null
	const save = sub.CurrentSave
	const saveId =
		save && typeof save === 'object'
			? Number((save as { SubRoomDataSaveId?: unknown }).SubRoomDataSaveId)
			: NaN
	if (!Number.isInteger(saveId) || saveId <= 0) return null

	const now = new Date().toISOString()
	const cloudBuildId = crypto.randomUUID()
	const unityAssetId = crypto.randomUUID()

	const stored = await Promise.all(
		files.map(async (file) => {
			const sha256 = await sha256Hex(file.bytes)
			// The download route looks a bundle up by filename alone, so the stored
			// name is this build's, not the uploaded basename two rooms can share.
			const filename = publicStudioBundleFilename(unityAssetId, file.platform, file.kind)
			const r2Key = `studio-room-bundles/${unityAssetId}/${file.platform}/${file.kind}/${filename}`
			await bucket.put(r2Key, file.bytes)
			return { ...file, filename, sha256, r2Key }
		})
	)

	const discardObjects = () => Promise.all(stored.map((file) => bucket.delete(file.r2Key)))
	try {
		await db.batch([
			...stored.map((file) =>
				db
					.prepare(
						`INSERT INTO studio_unity_asset_file
						 (unity_asset_id, platform, kind, filename, sha256, byte_length, r2_key)
						 VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)`
					)
					.bind(
						unityAssetId,
						file.platform,
						file.kind,
						file.filename,
						file.sha256,
						file.bytes.byteLength,
						file.r2Key
					)
			),
			db
				.prepare(
					`INSERT INTO studio_cloud_build
					 (cloud_build_id, room_id, sub_room_id, sub_room_data_save_id, unity_asset_id,
					  created_by_account_id, started_at, completed_at, error)
					 VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?7, NULL)`
				)
				.bind(cloudBuildId, roomId, subRoomId, saveId, unityAssetId, accountId, now),
		])
	} catch (err) {
		await discardObjects()
		throw err
	}

	const linked = await setSubRoomSaveUnityAssetId(db, subRoomId, saveId, unityAssetId)
	if (!linked) {
		await db
			.prepare('DELETE FROM studio_cloud_build WHERE cloud_build_id = ?1')
			.bind(cloudBuildId)
			.run()
		await db
			.prepare('DELETE FROM studio_unity_asset_file WHERE unity_asset_id = ?1')
			.bind(unityAssetId)
			.run()
		await discardObjects()
		return null
	}
	await markRoomAsRecRoomStudio(db, roomId, now)

	return {
		cloudBuildId,
		startedAt: now,
		completedAt: now,
		error: null,
		unityAssetId,
		createdByAccountId: accountId,
		subRoomDataSaveId: saveId,
	}
}
