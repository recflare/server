import {
	AVATAR_STUDIO_SLOTS,
	avatarItemAccessBit,
	avatarStudioFlags,
	getAccount,
	publishAvatarSave,
	writeAuditLog,
} from '@repo/domain'
import { logger } from '@repo/hono-helpers'
import { validateAndGetAccountId, validateAndGetRoles } from '@repo/jwt'

import { TOKENS_CURRENCY_TYPE } from '../../api/src/custom-avatar-items-load'
import { hasStudioAccess } from '../../auth/src/platform-db'
import { parseMultipart } from './multipart'

import type { Context } from 'hono'
import type { App } from './context'

/**
 * Web upload of finished avatar asset bundles, turned into a published custom avatar item.
 *
 * It lives on the `studio` worker because it writes Studio's data (`avatar_studio_save`, the
 * `unity_asset` rows, the bundles in `recflare-cdn`) the way a finished build does. The website
 * calls it straight from the browser with the session's token, like it calls `rooms` or
 * `accounts`, so the route answers CORS (see studio.app.ts).
 *
 * Rec Room Studio gets an item onto the shelf in three steps: create the item, upload a
 * Unity project, and let the cloud-build worker compile it to bundles. This route takes the
 * bundles already compiled — a Windows and an Android pair, each a `main` and a `material`
 * bundle — and writes exactly what a finished build writes: the bytes in the shared
 * `recflare-cdn` bucket under `avatar/`, a `unity_asset` row per bundle (target 0 Windows,
 * 2 Android; main at version 5, material at 6), an `avatar_studio_save` pointing at them,
 * and the published `CurrentSaves` entry on the item. The game cannot tell it from a build.
 *
 * Who may use it is the same as who may author in Studio: `hasStudio` (or the rollout
 * role) AND the avatar access bit for the slot — `developer` too for the two slots api's
 * Studio route reserves to developers. Items are PUBLISHED on upload, as the operator chose;
 * nothing here reviews a bundle, so the only gate is the access list.
 */

/** Slot 1000 (badges) is an image, not a bundle, and has its own flow in Studio. */
const BUNDLE_SLOTS = new Set(AVATAR_STUDIO_SLOTS.filter((slot) => slot !== 1000))
/** The slots api's Studio route holds back for developers. */
const DEVELOPER_SLOTS = new Set([104, 203])

const MAX_BUNDLE_BYTES = 25 * 1024 * 1024
const MAX_THUMBNAIL_BYTES = 8 * 1024 * 1024
/** Under the Workers request limit, with room for the multipart framing. */
const MAX_REQUEST_BYTES = 95 * 1024 * 1024
const MAX_PRICE = 1000
/** `Accessibility` 0 is unpublished; 1 is the published state Studio's own publish sets. */
const PUBLISHED = 1

/** Bundle versions the cloud build stamps: a main bundle is 5, an avatar material bundle 6. */
const MAIN_VERSION = 5
const MATERIAL_VERSION = 6

const BUNDLE_FIELDS = [
	{ field: 'windowsMain', target: 0, kind: 'main', version: MAIN_VERSION },
	{ field: 'windowsMaterial', target: 0, kind: 'material', version: MATERIAL_VERSION },
	{ field: 'androidMain', target: 2, kind: 'main', version: MAIN_VERSION },
	{ field: 'androidMaterial', target: 2, kind: 'material', version: MATERIAL_VERSION },
] as const

const fail = (c: Context<App>, status: 400 | 401 | 403 | 413, error: string) =>
	c.json({ success: false, error, value: null }, status)

const text = (value: unknown): string => (typeof value === 'string' ? value : '')

/** Base64 SHA-256 — the encoding every `unity_asset.hash` uses. */
async function sha256Base64(bytes: ArrayBuffer): Promise<string> {
	const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', bytes))
	let binary = ''
	for (const byte of digest) binary += String.fromCharCode(byte)
	return btoa(binary)
}

/** `UnityFS\0` — what every Unity asset bundle starts with. */
async function isUnityFs(file: File): Promise<boolean> {
	return new TextDecoder().decode(await file.slice(0, 8).arrayBuffer()) === 'UnityFS\0'
}

/** The image type by its magic bytes, so a renamed file can't pass as a thumbnail. */
async function imageExtension(file: File): Promise<'png' | 'jpg' | null> {
	const b = new Uint8Array(await file.slice(0, 8).arrayBuffer())
	if (b[0] === 137 && b[1] === 80 && b[2] === 78 && b[3] === 71) return 'png'
	if (b[0] === 255 && b[1] === 216 && b[2] === 255) return 'jpg'
	return null
}

/**
 * Whether the signed-in account may upload avatar items — the same answer the Studio
 * settings page gives, for the slot asked about. Cosmetic on the client; this is the gate.
 */
export async function avatarUploadAllowed(
	c: Context<App>,
	accountId: number,
	slot: number
): Promise<boolean> {
	const secret = await c.env.JWT_SECRET.get()
	const account = await getAccount(c.env.DB, accountId)
	if (!(await hasStudioAccess(c.env.DB, account, c.env.STUDIO_ROLLOUT))) return false
	if (((await avatarStudioFlags(c.env.DB, accountId)) & avatarItemAccessBit(slot)) === 0) {
		return false
	}
	if (!DEVELOPER_SLOTS.has(slot)) return true
	return (await validateAndGetRoles(c.req.raw, secret))?.includes('developer') === true
}

/** BodyType values the client wears an item by; 4 is "body-agnostic". */
const BODY_TYPES = [0, 1, 2, 3, 4]

/**
 * One bundle set per body type: `v<i>_bodyType`, `v<i>_thumbnail` and the four bundle fields
 * prefixed the same way. A built-in item (a jacket, say) ships a save per body type, and the
 * client picks the one matching the wearer, so one upload carries them all under one item.
 */
const MAX_VARIANTS = BODY_TYPES.length

interface Variant {
	bodyType: number
	thumbnail: File
	thumbnailExt: 'png' | 'jpg'
	bundles: Array<{ file: File; target: number; kind: string; version: number }>
}

/** Validate every set before anything is written; the first problem wins. */
async function readVariants(
	form: Record<string, string | File>
): Promise<{ variants: Variant[] } | { status: 400 | 413; error: string }> {
	const variants: Variant[] = []
	for (let i = 0; i < MAX_VARIANTS; i++) {
		const raw = form[`v${i}_bodyType`]
		if (raw === undefined) continue
		const label = `Body type set ${variants.length + 1}`
		const bodyType = Number(text(raw))
		if (!Number.isInteger(bodyType) || !BODY_TYPES.includes(bodyType)) {
			return { status: 400, error: `${label}: unknown body type.` }
		}
		if (variants.some((v) => v.bodyType === bodyType)) {
			return { status: 400, error: `Body type ${bodyType} is listed twice.` }
		}
		const thumbnail = form[`v${i}_thumbnail`]
		if (!(thumbnail instanceof File) || thumbnail.size === 0) {
			return { status: 400, error: `${label}: a thumbnail image is required.` }
		}
		if (thumbnail.size > MAX_THUMBNAIL_BYTES) {
			return { status: 413, error: `${label}: the thumbnail is too large.` }
		}
		const thumbnailExt = await imageExtension(thumbnail)
		if (!thumbnailExt) {
			return { status: 400, error: `${label}: the thumbnail must be a PNG or JPEG image.` }
		}
		const bundles: Variant['bundles'] = []
		for (const { field, target, kind, version } of BUNDLE_FIELDS) {
			const file = form[`v${i}_${field}`]
			if (!(file instanceof File) || file.size === 0) {
				return {
					status: 400,
					error: `${label}: missing ${field}. A Windows and an Android pair are required.`,
				}
			}
			if (file.size > MAX_BUNDLE_BYTES) {
				return { status: 413, error: `${label}: ${field} is too large.` }
			}
			if (!(await isUnityFs(file))) {
				return { status: 400, error: `${label}: ${field} is not a Unity asset bundle.` }
			}
			bundles.push({ file, target, kind, version })
		}
		variants.push({ bodyType, thumbnail, thumbnailExt, bundles })
	}
	if (variants.length === 0) {
		return { status: 400, error: 'Add at least one body type set.' }
	}
	return { variants }
}

export async function uploadAvatarItemHandler(c: Context<App>) {
	const accountId = await validateAndGetAccountId(c.req.raw, await c.env.JWT_SECRET.get())
	if (accountId === null) return fail(c, 401, 'Sign in to upload.')

	const length = Number(c.req.header('content-length') ?? 0)
	if (length > MAX_REQUEST_BYTES) return fail(c, 413, 'That upload is too large.')

	const form = await parseMultipart(c.req.raw).catch(() => null)
	if (!form) return fail(c, 400, 'Expected a multipart form.')

	const slot = Number(text(form.outfitType))
	if (!Number.isInteger(slot) || !BUNDLE_SLOTS.has(slot)) {
		return fail(c, 400, 'Choose a supported avatar item type.')
	}
	if (!(await avatarUploadAllowed(c, accountId, slot))) {
		return fail(c, 403, 'You do not have permission to upload this kind of avatar item.')
	}

	const name = text(form.name).trim()
	const description = text(form.description)
	const price = text(form.price) === '' ? 0 : Number(text(form.price))
	if (!name || name.length > 128) return fail(c, 400, 'Give the item a name (128 characters max).')
	if (description.length > 4000) return fail(c, 400, 'The description is too long.')
	if (!Number.isInteger(price) || price < 0 || price > MAX_PRICE) {
		return fail(c, 400, `The price must be a whole number from 0 to ${MAX_PRICE}.`)
	}

	const read = await readVariants(form)
	if (!('variants' in read)) return fail(c, read.status, read.error)
	const { variants } = read

	const itemId = crypto.randomUUID()
	const now = new Date().toISOString()
	const cdnKeys: string[] = []
	const imageKeys: string[] = []
	const unityAssetIds: string[] = []
	try {
		const item = {
			CustomAvatarItemId: itemId,
			CreatorAccountId: accountId,
			Name: name,
			Description: description,
			Price: price,
			Accessibility: PUBLISHED,
			ForceCannotPublish: false,
			IsFeatured: false,
			IsRecRoomApproved: false,
			BaseAvatarItemId: null,
			BaseAvatarItemColor: null,
			DesignFilename: null,
			ThumbnailImageFilename: null,
			CreatedAt: now,
			ModifiedAt: now,
			PreviewOrientation: 0,
			RankingContext: null,
			OutfitType: slot,
			CurrentSaves: [],
			Tags: [],
			IsStudioAuthored: true,
			CustomBadgeMetadata: null,
			RankedEntityId: itemId,
			PurchaseInfo: null,
			PurchaseCurrencyType: TOKENS_CURRENCY_TYPE,
		}
		await c.env.DB.prepare('INSERT INTO custom_avatar_item(data) VALUES (?)')
			.bind(JSON.stringify(item))
			.run()

		for (const variant of variants) {
			const unityAssetId = crypto.randomUUID()
			const uploadId = crypto.randomUUID()
			unityAssetIds.push(unityAssetId)
			const thumbnailName = `studio-avatar-${itemId}-${variant.bodyType}.${variant.thumbnailExt}`

			const assetStatements: D1PreparedStatement[] = []
			for (const { file, target, kind, version } of variant.bundles) {
				const bytes = await file.arrayBuffer()
				const filename = `${target === 2 ? 'quest/' : ''}studio-avatar/${itemId}/${unityAssetId}/${uploadId}.${kind}.assetbundle`
				const key = `avatar/${filename}`
				await c.env.CDN_ASSETS.put(key, bytes)
				cdnKeys.push(key)
				assetStatements.push(
					c.env.DB.prepare(
						'INSERT INTO unity_asset (unity_asset_id,target,version,kind,filename,hash) VALUES (?,?,?,?,?,?)'
					).bind(unityAssetId, target, version, kind, filename, await sha256Base64(bytes))
				)
			}
			await c.env.IMAGES.put(thumbnailName, await variant.thumbnail.arrayBuffer(), {
				httpMetadata: {
					contentType: variant.thumbnailExt === 'png' ? 'image/png' : 'image/jpeg',
				},
			})
			imageKeys.push(thumbnailName)
			await c.env.DB.batch(assetStatements)

			// There is no Unity project behind a direct upload, so the source columns say so.
			const save = await c.env.DB.prepare(
				'INSERT INTO avatar_studio_save(item_id,body_type,unity_asset_id,source_filename,source_hash,thumbnail,moderation_image,configuration,description,update_current,created_at) VALUES (?,?,?,?,?,?,?,?,?,?,?) RETURNING id'
			)
				.bind(
					itemId,
					variant.bodyType,
					unityAssetId,
					'web-upload',
					'',
					thumbnailName,
					null,
					JSON.stringify({ v: 1, d: { n: name, o: slot } }),
					'Uploaded from the website',
					0,
					now
				)
				.first<{ id: number }>()
			// Publishing replaces only this body type's entry, so the sets build up on the item.
			if (!save || !(await publishAvatarSave(c.env.DB, itemId, save.id))) {
				throw new Error('the uploaded bundles could not be published')
			}
		}
	} catch (err) {
		// Leave nothing half-written: the rows that landed and every blob already stored.
		logger.error('avatar upload failed', {
			accountId,
			itemId,
			error: err instanceof Error ? err.message : String(err),
		})
		await Promise.allSettled([
			c.env.DB.batch([
				c.env.DB.prepare('DELETE FROM avatar_studio_save WHERE item_id = ?').bind(itemId),
				c.env.DB.prepare('DELETE FROM custom_avatar_item WHERE custom_avatar_item_id = ?').bind(
					itemId
				),
				...unityAssetIds.map((id) =>
					c.env.DB.prepare('DELETE FROM unity_asset WHERE unity_asset_id = ?').bind(id)
				),
			]),
			c.env.CDN_ASSETS.delete(cdnKeys),
			...imageKeys.map((key) => c.env.IMAGES.delete(key)),
		])
		return c.json(
			{ success: false, error: 'The upload failed. Nothing was saved.', value: null },
			400
		)
	}

	await writeAuditLog(c.env.DB, {
		playerId: accountId,
		action: 'avatar_item_upload',
		data: { itemId, name, outfitType: slot, price, bodyTypes: variants.map((v) => v.bodyType) },
	}).catch((err: unknown) =>
		logger.error('could not write an audit log row', {
			action: 'avatar_item_upload',
			error: err instanceof Error ? err.message : String(err),
		})
	)
	return c.json({ success: true, error: null, value: { customAvatarItemId: itemId } })
}
