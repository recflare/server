/**
 * Baked Rec Room Studio bundles, stored by the studio worker.
 *
 * The studio migration owns the tables. This module only reads them, and tests
 * apply {@link STUDIO_UNITY_ASSET_SCHEMA_DDL} directly. A room load must keep
 * working before that migration has been applied, so a missing table is
 * reported by {@link isMissingStudioAssetTable} and the caller leaves the save
 * the way a maker-pen room already looks.
 *
 * The filename column is what a client requests. New builds store a name that
 * contains the unity asset id, because the download route looks the file up by
 * filename alone and two rooms can otherwise both upload `win.assetbundle`.
 */

import { bindPlaceholders, chunkForBinds } from './d1-binds'

export const STUDIO_UNITY_ASSET_SCHEMA_DDL: string[] = [
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

/** The version stamped on every baked file this server stores. */
export const STUDIO_ASSET_VERSION = 1

export type StudioBundlePlatform = 'windows' | 'android'
export type StudioBundleKind = 'main' | 'stripped'

export interface StudioUnityAssetFile {
	unityAssetId: string
	platform: StudioBundlePlatform
	kind: StudioBundleKind
	filename: string
	/** Lowercase hex SHA-256, the form the studio upload stores. */
	sha256: string
	byteLength: number
	r2Key: string
}

/**
 * One baked bundle as a room save lists it. PascalCase, like the rest of
 * `CurrentSave`. `Target` uses the numbers the game sends as `unityAssetTarget`
 * on a custom avatar: 0 is Windows, 2 is Android/Quest.
 */
export interface BakedStudioUnityAsset {
	UnityAssetId: string
	Target: number
	Version: number
	Filename: string
	/** Base64 SHA-256. An empty string is not a hash. */
	Hash: string
}

interface StudioUnityAssetFileRow {
	unity_asset_id: string
	platform: string
	kind: string
	filename: string
	sha256: string
	byte_length: number
	r2_key: string
}

/**
 * The name a client downloads. Unique per build, platform, and kind, so a
 * filename lookup cannot return another room's bundle.
 */
export function publicStudioBundleFilename(
	unityAssetId: string,
	platform: string,
	kind: string
): string {
	const id = unityAssetId.replace(/-/g, '').toLowerCase()
	return `${id}.${platform}.${kind}.assetbundle`
}

/**
 * 0 for Windows, 2 for Android/Quest. Anything else is treated as Windows:
 * those are the only two platforms a local build stores.
 */
export function studioAssetTarget(platform: string): number {
	return platform === 'android' ? 2 : 0
}

/** Base64 SHA-256, which is the hash encoding avatar and invention downloads use. */
export function sha256HexToBase64(hex: string): string {
	const clean = hex.trim().toLowerCase()
	if (!/^[0-9a-f]{64}$/.test(clean)) return ''
	const bytes = new Uint8Array(32)
	for (let i = 0; i < 32; i++) bytes[i] = Number.parseInt(clean.slice(i * 2, i * 2 + 2), 16)
	let binary = ''
	for (const byte of bytes) binary += String.fromCharCode(byte)
	return btoa(binary)
}

/** True when D1 failed because the studio asset tables have not been migrated. */
export function isMissingStudioAssetTable(err: unknown): boolean {
	const message = err instanceof Error ? err.message : String(err)
	return message.toLowerCase().includes('no such table')
}

function toStudioUnityAssetFile(row: StudioUnityAssetFileRow): StudioUnityAssetFile | null {
	if (row.platform !== 'windows' && row.platform !== 'android') return null
	if (row.kind !== 'main' && row.kind !== 'stripped') return null
	return {
		unityAssetId: row.unity_asset_id,
		platform: row.platform,
		kind: row.kind,
		filename: row.filename,
		sha256: row.sha256,
		byteLength: row.byte_length,
		r2Key: row.r2_key,
	}
}

/** Every stored file for the given unity asset ids. An empty id list reads nothing. */
export async function listStudioUnityAssetFiles(
	db: D1Database,
	unityAssetIds: string[]
): Promise<StudioUnityAssetFile[]> {
	const ids = [...new Set(unityAssetIds.filter((id) => id !== ''))]
	if (ids.length === 0) return []
	const pages = await Promise.all(
		chunkForBinds(ids).map((chunk) =>
			db
				.prepare(
					`SELECT unity_asset_id, platform, kind, filename, sha256, byte_length, r2_key
					 FROM studio_unity_asset_file
					 WHERE unity_asset_id IN (${bindPlaceholders(chunk)})`
				)
				.bind(...chunk)
				.all<StudioUnityAssetFileRow>()
		)
	)
	return pages
		.flatMap((page) => page.results)
		.map(toStudioUnityAssetFile)
		.filter((file): file is StudioUnityAssetFile => file !== null)
}

/**
 * The one file stored under `filename`. Null when none matches, and also when
 * more than one row shares the name: serving either would hand the client the
 * wrong room's bundle.
 */
export async function findStudioUnityAssetByFilename(
	db: D1Database,
	filename: string
): Promise<StudioUnityAssetFile | null> {
	const { results } = await db
		.prepare(
			`SELECT unity_asset_id, platform, kind, filename, sha256, byte_length, r2_key
			 FROM studio_unity_asset_file WHERE filename = ?1`
		)
		.bind(filename)
		.all<StudioUnityAssetFileRow>()
	if (results.length !== 1) return null
	return toStudioUnityAssetFile(results[0]!)
}

export interface StudioUnityAssetRecord {
	unityAssetId: string
	/** 0 when the cloud-build row is gone. The route can fall back to the save's author. */
	createdByAccountId: number
	files: StudioUnityAssetFile[]
}

/**
 * One unity asset and the account that built it. Null when no files are stored.
 * A missing cloud-build table leaves `createdByAccountId` at 0; a missing file
 * table throws, and {@link isMissingStudioAssetTable} tells the caller apart.
 */
export async function getStudioUnityAsset(
	db: D1Database,
	unityAssetId: string
): Promise<StudioUnityAssetRecord | null> {
	const files = await listStudioUnityAssetFiles(db, [unityAssetId])
	if (files.length === 0) return null
	let createdByAccountId = 0
	try {
		const row = await db
			.prepare(
				`SELECT created_by_account_id FROM studio_cloud_build
				 WHERE unity_asset_id = ?1 ORDER BY started_at DESC LIMIT 1`
			)
			.bind(unityAssetId)
			.first<{ created_by_account_id: number }>()
		if (row) createdByAccountId = row.created_by_account_id
	} catch (err) {
		if (!isMissingStudioAssetTable(err)) throw err
	}
	return { unityAssetId, createdByAccountId, files }
}

/**
 * The main bundles of these files, Windows then Android. Stripped bundles stay
 * in storage and are left off this list: a client that loads every entry would
 * otherwise replace the scene with the stripped one.
 */
export function bakedStudioUnityAssets(files: StudioUnityAssetFile[]): BakedStudioUnityAsset[] {
	return files
		.filter((file) => file.kind === 'main')
		.map((file) => ({
			UnityAssetId: file.unityAssetId,
			Target: studioAssetTarget(file.platform),
			Version: STUDIO_ASSET_VERSION,
			Filename: file.filename,
			Hash: sha256HexToBase64(file.sha256),
		}))
		.sort((a, b) => a.Target - b.Target || a.Filename.localeCompare(b.Filename))
}
