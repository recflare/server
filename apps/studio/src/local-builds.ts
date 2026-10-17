import {
	deleteUnityAssetBuilds,
	getSubRoom,
	markRoomAsRecRoomStudio,
	publicStudioBundleFilename,
	setSubRoomSaveUnityAssetId,
	STUDIO_ASSET_VERSION,
	studioAssetTarget,
	studioBundleR2Key,
	unityAssetUpsert,
} from '@repo/domain'

import type { StudioBundlePlatform, UnityAssetKind } from '@repo/domain'

export interface CloudBuildRow {
	cloudBuildId: string
	startedAt: string
	completedAt: string | null
	error: string | null
	unityAssetId: string
	createdByAccountId: number
	serverDataFileName?: string | null
}

export type BundlePlatform = StudioBundlePlatform
export type BundleKind = UnityAssetKind

export interface LocalBundleFile {
	platform: BundlePlatform
	kind: BundleKind
	filename: string
	bytes: ArrayBuffer
}

export interface StoredLocalBuild extends CloudBuildRow {
	subRoomDataSaveId: number
}

export interface UserBuildCount {
	accountId: number
	startTime: string
	endTime: string
	subRoomTotalBuildCount: number
	subRoomFailedBuildCount: number
	avatarItemTotalBuildCount: number
	avatarItemFailedBuildCount: number
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
		completedAt: row.completed_at || null,
		error: row.error,
		unityAssetId: row.unity_asset_id,
		createdByAccountId: row.created_by_account_id,
		serverDataFileName:
			row.completed_at && !row.error && /^\d+$/.test(row.cloud_build_id)
				? `studio-builds/${row.cloud_build_id}/server-data.json`
				: null,
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

/** Build totals for the current UTC hour, matching Studio's rate-limit window DTO. */
export async function getUserBuildCount(
	db: D1Database,
	accountId: number,
	now = new Date()
): Promise<UserBuildCount> {
	const start = new Date(now)
	start.setUTCMinutes(0, 0, 0)
	const end = new Date(start.getTime() + 60 * 60 * 1000)
	const row = await db
		.prepare(
			`SELECT COUNT(*) AS total,
			        SUM(CASE WHEN error IS NOT NULL THEN 1 ELSE 0 END) AS failed
			 FROM studio_cloud_build
			 WHERE created_by_account_id = ?1
			   AND started_at >= ?2 AND started_at < ?3`
		)
		.bind(accountId, start.toISOString(), end.toISOString())
		.first<{ total: number | string; failed: number | string | null }>()
	return {
		accountId,
		startTime: start.toISOString(),
		endTime: end.toISOString(),
		subRoomTotalBuildCount: Number(row?.total ?? 0),
		subRoomFailedBuildCount: Number(row?.failed ?? 0),
		avatarItemTotalBuildCount: 0,
		avatarItemFailedBuildCount: 0,
	}
}

/** Base64 SHA-256 — the encoding `unity_asset.hash` (and every other bundle hash) uses. */
async function sha256Base64(bytes: ArrayBuffer): Promise<string> {
	const digest = await crypto.subtle.digest('SHA-256', bytes)
	let binary = ''
	for (const byte of new Uint8Array(digest)) binary += String.fromCharCode(byte)
	return btoa(binary)
}

/**
 * Store a PC-built Windows + Android pair as a cloud build that is already finished.
 * The bytes go to R2 under `room/` and each bundle becomes a `unity_asset` row — target
 * 0 Windows / 2 Android, its kind, the `filename` the client prefixes with `/room/` to
 * download it (so the R2 key is `room/<filename>`), the base64 SHA-256 as `hash`. The
 * build row points at the subroom's current save, that save's `UnityAssetId` is set
 * to the new asset, and the room is marked as a Studio room the first time
 * (`BecameRRStudioRoomAt`).
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
			// The client downloads `/room/<filename>` from the bucket, so the stored name is
			// this build's, not the uploaded basename two rooms can share.
			const filename = publicStudioBundleFilename(roomId, unityAssetId, file.platform, file.kind)
			const hash = await sha256Base64(file.bytes)
			await bucket.put(studioBundleR2Key(filename), file.bytes)
			return { ...file, filename, hash }
		})
	)

	const discardObjects = () =>
		Promise.all(stored.map((file) => bucket.delete(studioBundleR2Key(file.filename))))
	try {
		await db.batch([
			...stored.map((file) =>
				unityAssetUpsert(
					db,
					{
						UnityAssetId: unityAssetId,
						Target: studioAssetTarget(file.platform),
						Version: STUDIO_ASSET_VERSION,
						Filename: file.filename,
						Hash: file.hash,
					},
					file.kind
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
		await deleteUnityAssetBuilds(db, unityAssetId)
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
