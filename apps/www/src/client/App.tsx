import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { renderSVG } from 'uqr'

import { Accessibility } from '@repo/domain/src/enums'
import { GAME_VERSION } from '@repo/domain/src/presence-db'

import { NotificationType } from '../../../notify/src/notification-types'
import { authFailure, authUnreachable } from '../auth-messages'
import {
	DISCORD_INVITE,
	DOWNLOAD_URL,
	LICENSE_URL,
	QUEST_DOWNLOAD_URL,
	SOURCE_REPO,
} from '../links'
import { downgradeRoom, needsDowngrade } from '../room-converter'
// The session token, the worker hostnames and the `call` every request goes through —
// see api.ts for why they're a module of their own rather than defined here.
import {
	accountByUsername,
	accountIdForUsername,
	authHeader,
	call,
	hasToken,
	isAdmin,
	isDeveloper,
	setHosts,
	setToken,
	tokenAccountId,
	useAction,
	usernamesFor,
	where,
} from './api'
import { AvatarUploadPanel } from './AvatarUpload'
import { ChristmasLayer, XmasHome } from './Christmas'
import { CuratedListsPanel } from './CuratedLists'
import { DeviceLinkPage } from './DeviceLink'
import { eventIdFromPath, EventPage, EventsPage } from './Events'
import {
	customAvatarItemIdFromPath,
	inventionIdFromPath,
	InventionPage,
	ItemPage,
	StaffDelete,
} from './Item'
import { ModerationPage, PlayerBanStatus } from './Moderation'
import { PumpleBossFight } from './PumpleBossFight'
import { RoomsPage } from './Rooms'
import { StatsPage } from './Stats'
import { STUDIO_ACCESS_KINDS, StudioAccessPage, StudioAccessPanel } from './StudioAccess'
import { VideoUploadForm } from './VideoUpload'

import type { ReactNode } from 'react'
import type { Hosts, PublicAccount } from './api'

/**
 * Site config from `www`. `signupEnabled` is false when the operator has no Turnstile
 * keypair configured — web signup runs behind that bot check, so without it the endpoint
 * is closed and the UI must not offer the form.
 */
interface SiteConfig {
	signupEnabled: boolean
	turnstileSiteKey: string | null
	/**
	 * Whether the Discord-verified benefits claim is configured. False when the operator
	 * has no Discord app/guild/role set, in which case the claim page and its links stay
	 * hidden — the endpoint would refuse anyway.
	 */
	benefitsEnabled: boolean
	/**
	 * The Discord consent URL to send the player to, assembled by `www` (scopes and the
	 * redirect URI are its business, and must match what the claim will accept). Null when
	 * benefits are off. The `state` nonce is appended here — see `startDiscordAuth`.
	 */
	discordAuthorizeUrl: string | null
	/**
	 * The consent URL for "Sign in with Discord" — same app, `identify` scope only, and its own
	 * return leg (`/login/discord`). On the same switch as the claim, so null whenever
	 * `benefitsEnabled` is false. See `DiscordLoginPage`.
	 */
	discordLoginUrl: string | null
}

/** The private self DTO from `accounts` (`GET /account/me`). */
interface SelfAccount {
	accountId: number
	username: string
	displayName: string
	email: string | null
	/** A key on the `img` worker — `DefaultProfileImage.jpg` until the player sets one. */
	profileImage: string
	/** The profile banner's key on `img` — `""` until the player sets one. */
	bannerImage: string
	/**
	 * Username changes left on the account — each change spends one, and an account
	 * starts with one. Absent on an older self DTO, which reads as "unknown": the form
	 * stays usable and lets the server be the one to refuse.
	 */
	availableUsernameChanges?: number
	/**
	 * Whether the player asked for the account to be deleted (`/api/account/delete`). A
	 * mark, not a deletion: the account still works, and signing in again is meant to
	 * reverse it. Absent on an older self DTO, which reads as "not marked".
	 */
	isDeleted?: boolean
	/** When they asked, present only while `isDeleted`. */
	deletedAt?: string
}

/**
 * One subroom, as `rooms` re-attaches them to every room read. A room is a container;
 * the subrooms are the actual places players load into, each with its own accessibility
 * and its own save history.
 */
interface SubRoom {
	SubRoomId: number
	Name: string
	/** Set INDEPENDENTLY of the room's — a public room can hold a private subroom. */
	Accessibility: number
	IsSandbox: boolean
	MaxPlayers: number
	/** The subroom's scene-data key, served back by `cdn` under `room/`. */
	DataBlob?: string
	/**
	 * A save posted without `AutoPublish` waits here. Cleared when that save is
	 * published, so a non-null value means "edited since players last saw a change".
	 */
	StagedSubRoomDataSaveId: number | null
	/**
	 * What players actually load. Null until the first publish — and a subroom without
	 * one silently loads nothing, which is worth surfacing to an owner who can't tell
	 * that apart from a broken room.
	 */
	CurrentSave: {
		SubRoomDataSaveId: number
		CreatedAt: string
		Description: string
		/**
		 * The scene-data key for the published save — what the client downloads to load
		 * the place, and the file worth keeping a copy of. `subRoomDataBlob()` resolves
		 * this one first, ahead of the subroom's own.
		 */
		DataBlob: string
		/**
		 * The Studio build this save is drawn from, when it has one. The key is ABSENT on a
		 * maker-pen save rather than null — the worker emits it only when the save carried one.
		 */
		UnityAssetId?: string
	} | null
}

/**
 * One room from `rooms` (`GET /rooms/ownedby/me`), narrowed to what these pages draw.
 * The worker serves the stored room blob verbatim — dozens of fields the game needs and
 * the website doesn't — so only the ones read here are declared.
 */
interface OwnedRoom {
	RoomId: number
	Name: string
	Description: string
	/** Who made it — the account the public page links to, and whom the owner view is for. */
	CreatorAccountId: number
	/** A key on the `img` worker; a room with no image of its own gets the fallback. */
	ImageName: string
	/** The `Accessibility` ordinal, NOT the enum name — see ACCESSIBILITY_LABEL. */
	Accessibility: number
	CreatedAt: string
	MaxPlayers: number
	/** False blocks `POST /rooms/{id}/clone` — nobody can take a copy of the room. */
	CloningAllowed: boolean
	/**
	 * The staff listing flags: out of the browse feeds, and out of search. Set together
	 * through the website (`PUT /rooms/{id}/exclude`); absent on a room nobody has touched,
	 * which reads as listed.
	 */
	ExcludeFromLists?: boolean
	ExcludeFromSearch?: boolean
	SupportsScreens: boolean
	SupportsWalkVR: boolean
	SupportsTeleportVR: boolean
	SupportsQuest2: boolean
	SupportsMobile: boolean
	SupportsJuniors: boolean
	/** `Type` 0 is a tag the owner set, 2 one the server derived. */
	Tags: Array<{ Tag: string; Type: number }>
	SubRooms: SubRoom[]
	/** Always present: the worker folds the live counters in on every read. */
	Stats: {
		CheerCount: number
		FavoriteCount: number
		VisitorCount: number
		VisitCount: number
	}
}

/**
 * What an `Accessibility` ordinal is called on screen — rooms and subrooms both carry
 * one. The two dev values are reachable (the game sets them), so they're named rather
 * than left to fall through to the unknown case in `accessibilityLabel`.
 */
const ACCESSIBILITY_LABEL: Record<number, string> = {
	[Accessibility.Private]: 'Private',
	[Accessibility.Public]: 'Public',
	[Accessibility.Unlisted]: 'Unlisted',
	[Accessibility.Dev_only]: 'Dev only',
	[Accessibility.Dev_Unlisted]: 'Dev unlisted',
}

/**
 * RecNet (4) is the web platform, stamped as the token's `platform` claim on sign-in.
 * NOT passed on signup: create_account treats an asserted platform as one to verify
 * against Steam and rejects RecNet — the web signup is the (platform-less) password
 * account path.
 */
const WEB_PLATFORM = '4'

/** The signed-in account, straight from `accounts`. */
const fetchMe = (): Promise<SelfAccount> =>
	call<SelfAccount>(`${where().accounts}/account/me`, { authed: true })

/**
 * The caller's own rooms, from the `rooms` worker — the same list the game's "My Rooms"
 * loads. `ownedby/me` rather than `createdby/me`: the dorm is auto-provisioned, not a
 * room the player made, and it's the one room they can't do anything with from here.
 *
 * The worker deliberately does NOT filter on accessibility for this list, so a room that
 * has never been published shows up — which is the point, since that's the one its owner
 * is most likely to be looking for.
 *
 * Sorted newest-first here rather than upstream: the query has no ORDER BY (D1 hands
 * back insertion order, which is not a promise), and the room someone just made is the
 * one they came to see.
 */
async function fetchMyRooms(): Promise<OwnedRoom[]> {
	const rooms = await call<OwnedRoom[]>(`${where().rooms}/rooms/ownedby/me`, { authed: true })
	// A bare array is the contract; anything else is treated as "no rooms" rather than
	// thrown, since `.sort` on a non-array would surface as an unreadable TypeError.
	if (!Array.isArray(rooms)) return []
	// ISO-8601 timestamps, so lexical order IS chronological order.
	return [...rooms].sort((a, b) => (a.CreatedAt < b.CreatedAt ? 1 : -1))
}

/**
 * The `UploadFileType` a room's scene data is posted under. `storage` maps this to the
 * `room/` subfolder of the CDN bucket — the one prefix `cdn`'s `GET /room/:dataBlob`
 * reads back, and so the only one a `DataBlob` key can point into.
 */
const FILE_TYPE_ROOM_SAVE = '1'

/**
 * The `UploadFileType` a picture is posted under. `storage` files it under `image/`,
 * which is where the `img` worker resolves an extensionless key — so the name it hands
 * back is exactly what a room's `ImageName` holds, and what the hero draws.
 */
const FILE_TYPE_IMAGE = '3'

/**
 * The game build this server targets, as `YYYY-MM-DD` — read from the same `GAME_VERSION`
 * the auth token and presence carry rather than written out again here, so upgrading the
 * client moves this line with it instead of leaving a stale date on the upload form.
 *
 * It's shown because a scene blob is only loadable by the build that wrote it (or older
 * ones that understand it): a save taken out of a room built on a later version can fail
 * outright, and nothing between here and the game says why.
 */
const CLIENT_BUILD_DATE = `${GAME_VERSION.slice(0, 4)}-${GAME_VERSION.slice(4, 6)}-${GAME_VERSION.slice(6, 8)}`

/**
 * Upload a scene blob to `storage` and return the key it was stored under — the
 * `<date>/<uuid>` name every `DataBlob` field holds.
 *
 * This is the same two-step the game does: the bytes go to `storage` first, and only its
 * generated name is handed to `rooms`. Nothing about the file is validated here — the
 * server doesn't parse a room blob either, so the only honest validation available is
 * whether the game can load it afterwards. Hand this the file `prepareRoomBlob` returned.
 */
async function uploadRoomBlob(file: File): Promise<string> {
	return uploadToStorage(file, FILE_TYPE_ROOM_SAVE)
}

/**
 * The scene files the upload form takes, by extension: a `.room` is a save as this server
 * stores it, a `.binpb` a scene taken from a newer build. Only checked in the browser —
 * the blob is opaque to the server, which stores whatever it is given.
 */
const ROOM_BLOB_EXTENSIONS = ['.room', '.binpb']

function isRoomBlobFile(filename: string): boolean {
	const name = filename.toLowerCase()
	return ROOM_BLOB_EXTENSIONS.some((ext) => name.endsWith(ext))
}

/**
 * The file that actually gets stored for a picked scene file. A scene taken from a newer
 * build can't be parsed by the build this server runs as it stands, so when the owner asks
 * for it the file is downgraded first (see `room-converter.ts`); otherwise it passes
 * through untouched.
 *
 * Done here in the browser, before either request, because the upload goes straight to
 * `storage` and the save's `Hash` has to describe the bytes that were stored — so both
 * the upload and `blobHash` must be given this file, not the one that was picked.
 */
async function prepareRoomBlob(file: File, downgrade: boolean): Promise<File> {
	if (!downgrade) return file
	const { data } = downgradeRoom(new Uint8Array(await file.arrayBuffer()))
	return new File([data], file.name, { type: 'application/octet-stream' })
}

/**
 * Post a file to `storage` under one `UploadFileType` and return the generated
 * `<date>/<uuid>` key. The type decides the bucket folder, and so which worker can serve
 * the file back: a scene blob is only reachable through `cdn`, a picture only through
 * `img`, so a caller has to name the right one for the key to mean anything later.
 */
async function uploadToStorage(file: File, fileType: string): Promise<string> {
	const form = new FormData()
	form.set('FileType', fileType)
	form.set('File', file)
	const { filename } = await call<{ filename?: string }>(`${where().storage}/upload`, {
		method: 'POST',
		multipart: form,
		authed: true,
	})
	if (!filename) throw new Error('The storage worker accepted the file but returned no name.')
	return filename
}

/**
 * Point a room at an already-uploaded picture — `PUT /rooms/{id}/image`, the call the
 * game makes after a player picks a photo for the room.
 *
 * Owner-only on the server, which is one rule stricter than the scene-data save (a
 * co-owner may save, but not change the image). The reply is the PascalCase
 * `{ Success, Error }` envelope at HTTP 200 with a null `Value` — it does NOT carry the
 * room, so the page patches `ImageName` onto the room it already has rather than
 * re-fetching. That's the same thing the game does on the `RoomUpdate` this pushes.
 */
async function setRoomImage(roomId: number, imageName: string): Promise<void> {
	const res = await call<{ Success?: boolean; Error?: string | null }>(
		`${where().rooms}/rooms/${roomId}/image`,
		{ method: 'PUT', authed: true, form: { imageName } }
	)
	if (res.Success !== true) {
		throw new Error(res.Error || 'The rooms worker refused the image.')
	}
}

/**
 * The `SavedImageType` a profile picture is uploaded under. `api` files the object under
 * `profile/` and, seeing this type, writes it onto the account row as well — so the
 * upload alone would change the avatar. The game still follows it with the `accounts`
 * PUT (see `setProfileImage`), and so does this page: that call is the one that pushes
 * the `AccountUpdate` frame, without which a running client keeps drawing the old face.
 */
const SAVED_IMAGE_TYPE_PROFILE = 4

/**
 * Upload a profile picture the way the game does — `POST /api/images/v4/uploadsaved` on
 * `api`, NOT `storage`'s `/upload` that the room image uses. The two land in different
 * buckets: a room image is a plain object `img` serves by key, while a saved image also
 * gets a row in the `image` table (typed as a profile thumbnail, so it stays out of the
 * photo feed, which lists share-camera shots only). Returns the key `img` serves it by.
 */
async function uploadProfileImage(file: File): Promise<string> {
	const form = new FormData()
	form.set('imgMeta', JSON.stringify({ savedImageType: SAVED_IMAGE_TYPE_PROFILE }))
	form.set('image', file)
	const { ImageName } = await call<{ ImageName?: string }>(
		`${where().api}/api/images/v4/uploadsaved`,
		{ method: 'POST', multipart: form, authed: true }
	)
	if (!ImageName) throw new Error('The api worker accepted the picture but returned no name.')
	return ImageName
}

/**
 * Point the account at an already-uploaded picture — `PUT /account/me/profileimage` on
 * `accounts`, the call the game makes after the upload. Answers the lowercase
 * `{ success }` envelope, not the room image's PascalCase one, and carries no account:
 * the page patches `profileImage` onto the one it holds, as it does for a room.
 */
async function setProfileImage(imageName: string): Promise<void> {
	const res = await call<{ success?: boolean }>(`${where().accounts}/account/me/profileimage`, {
		method: 'PUT',
		authed: true,
		form: { imageName },
		refusal: 'The accounts worker refused the image.',
	})
	if (res.success !== true) throw new Error('The accounts worker refused the image.')
}

/**
 * Upload a banner picture through the same `api` route as the avatar, but typed
 * `SavedImageType.None` (0): the game has no banner type (its banner is one of the
 * player's camera photos), and anything but ShareCamera stays out of the photo feed and
 * the player's photo list, while ProfileThumbnail would also overwrite the avatar. Filed
 * under `none/` in the bucket. Returns the key `img` serves it by.
 */
async function uploadBannerImage(file: File): Promise<string> {
	const form = new FormData()
	form.set('imgMeta', JSON.stringify({ savedImageType: 0 }))
	form.set('image', file)
	const { ImageName } = await call<{ ImageName?: string }>(
		`${where().api}/api/images/v4/uploadsaved`,
		{ method: 'POST', multipart: form, authed: true }
	)
	if (!ImageName) throw new Error('The api worker accepted the picture but returned no name.')
	return ImageName
}

/**
 * Point the account's banner at an uploaded picture — `PUT /account/me/bannerimage` on
 * `accounts`, the call the game makes when a player picks a banner. Same `{ success }`
 * envelope as the avatar's PUT, and it pushes the same `AccountUpdate` frame, so a
 * running client redraws the banner too.
 */
async function setBannerImage(imageName: string): Promise<void> {
	const res = await call<{ success?: boolean }>(`${where().accounts}/account/me/bannerimage`, {
		method: 'PUT',
		authed: true,
		form: { imageName },
		refusal: 'The accounts worker refused the banner.',
	})
	if (res.success !== true) throw new Error('The accounts worker refused the banner.')
}

/**
 * The blob's SHA-256, base64 — the encoding this API's hash fields use (an invention's
 * `BlobHash` comes back the same way). `rooms` only echoes it back on the save, but a
 * save whose hash doesn't describe its blob is worse than one carrying none.
 */
async function blobHash(file: File): Promise<string> {
	const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', await file.arrayBuffer()))
	let binary = ''
	for (const byte of digest) binary += String.fromCharCode(byte)
	return btoa(binary)
}

/**
 * Record a room save against one subroom, pointing it at an already-uploaded blob.
 *
 * `AutoPublish` decides whether players see it now or whether it waits on the room's
 * publish step, exactly as it does for the game — the site doesn't get its own rule.
 * The envelope answers HTTP 200 either way and puts the refusal in `error`, so success
 * has to be read from the body rather than the status. `value.room` is the updated room,
 * which the page re-renders from rather than re-fetching the whole list.
 *
 * `unityAssetId` goes on the save beside the blob. The worker records it only when it is
 * sent — a save that names none gets none, it is NOT carried over from the last save — so
 * keeping a subroom's Studio build across an upload is the caller's job (see
 * `previousUnityAssetId`).
 */
async function saveSubRoomBlob(
	roomId: number,
	subRoomId: number,
	input: {
		filename: string
		hash: string
		description: string
		autoPublish: boolean
		unityAssetId?: string
	}
): Promise<OwnedRoom> {
	const res = await call<{
		success?: boolean
		error?: string | null
		value?: { room?: OwnedRoom } | null
	}>(`${where().rooms}/rooms/${roomId}/subrooms/${subRoomId}/data`, {
		method: 'POST',
		authed: true,
		json: {
			SubRoomData: { Filename: input.filename, Hash: input.hash },
			...(input.unityAssetId ? { UnityAssetId: input.unityAssetId } : {}),
			Description: input.description,
			AutoPublish: input.autoPublish,
		},
	})
	if (res.success !== true) {
		throw new Error(res.error || 'The rooms worker refused the save.')
	}
	const room = res.value?.room
	if (!room) throw new Error('The save was recorded but the room came back empty.')
	return room
}

/** A `UnityAssetId` is a GUID, in the hyphenated form every save carries it in. */
const UNITY_ASSET_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

/**
 * The `UnityAssetId` of the save a new one builds on, or undefined when that save has none
 * (or the subroom has never been saved).
 *
 * "Builds on" is the worker's own rule for what a save carries forward: the STAGED save
 * when there is one, otherwise the published `CurrentSave`. The published one arrives
 * with the room; a staged one is only an id there, so it is read from the save's detail
 * route — which answers in camelCase, unlike the PascalCase save embedded in the room.
 */
async function previousUnityAssetId(roomId: number, sub: SubRoom): Promise<string | undefined> {
	const stagedId = sub.StagedSubRoomDataSaveId
	if (stagedId !== null && stagedId !== undefined) {
		const staged = await call<{ unityAssetId?: string | null }>(
			`${where().rooms}/rooms/${roomId}/subrooms/${sub.SubRoomId}/saves/${stagedId}`,
			{ authed: true }
		)
		return staged.unityAssetId || undefined
	}
	return sub.CurrentSave?.UnityAssetId || undefined
}

/**
 * Sign in with auth's password grant, posted directly the way the game posts it. The
 * account is resolved by `username` (case-insensitive) — web players sign in with their
 * username, not the numeric account id.
 *
 * A refusal is translated through the table shared with the worker (see
 * `auth-messages.ts`): auth's `error` is always a machine code, and the reason in
 * `error_description` is written for an operator, not a player.
 *
 * An account with two-factor sign-in on answers the password with a CHALLENGE instead of a
 * token — resolved here as the kind of code wanted, with no session set. The form then
 * posts the same username and password again with the code as `second`; auth re-checks the
 * password every time, and `loginContext` (one per attempt at signing in) ties the retries
 * to the same pending sign-in. A wrong code throws like any other refusal.
 */
/** The second factor auth asked a sign-in for: an authenticator app, or an emailed code. */
type SignInChallenge = 'totp' | 'email'

interface SecondFactor {
	kind: SignInChallenge
	code: string
	loginContext: string
}

async function signIn(
	username: string,
	password: string,
	second?: SecondFactor
): Promise<SignInChallenge | null> {
	const res = await fetch(`${where().auth}/connect/token`, {
		method: 'POST',
		headers: { 'content-type': 'application/x-www-form-urlencoded' },
		body: new URLSearchParams({
			grant_type: 'password',
			username,
			platform: WEB_PLATFORM,
			password,
			...(second
				? {
						login_context: second.loginContext,
						[second.kind === 'totp' ? '2fa_code' : 'security_code']: second.code,
					}
				: {}),
		}).toString(),
	}).catch(() => null)
	if (res === null) throw new Error(authUnreachable('login'))

	const data = (await res.json().catch(() => ({}))) as Record<string, unknown>
	if (!res.ok) {
		const code = typeof data.error === 'string' ? data.error : ''
		// The account has two-factor sign-in on: the password was right, and auth now wants
		// the second factor — the form asks for it and posts this again with the code.
		if (code === 'continue_2fa') return 'totp'
		if (code === 'security_code required') return 'email'
		const description = typeof data.error_description === 'string' ? data.error_description : ''
		throw new Error(authFailure('login', res.status, code, description).message)
	}
	if (typeof data.access_token !== 'string') throw new Error(authUnreachable('login'))
	setToken(data.access_token)
	return null
}

/**
 * Create an account — the one flow that goes through `www`, because it's gated by
 * Turnstile and that check needs a secret key a page can't hold. www hands back auth's
 * token response unchanged, so the session is established just as sign-in establishes it.
 */
async function signUp(password: string, turnstileToken: string): Promise<void> {
	const data = await call<{ access_token?: string }>('/api/signup', {
		json: { password, turnstileToken },
	})
	if (typeof data.access_token !== 'string') throw new Error(authUnreachable('signup'))
	setToken(data.access_token)
}

/**
 * Change the username.
 *
 * `accounts` answers this one in its own envelope — `{ success, error, value }` at HTTP
 * 200 even when it refused (taken name, no changes left) — so a 200 is not enough to
 * call it done. The sentences it writes are already player-facing, so they're shown as-is.
 *
 * On success the SELF account is re-read rather than using the envelope's `value`: that
 * is the PUBLIC DTO, and it carries no `availableUsernameChanges` — the very field this
 * form needs to know whether another change is left.
 */
async function changeUsername(username: string): Promise<SelfAccount> {
	const result = await call<{ error?: unknown }>(`${where().accounts}/account/me/username`, {
		method: 'PUT',
		form: { username },
		authed: true,
	})
	const refusal = typeof result.error === 'string' ? result.error : ''
	if (refusal !== '') throw new Error(refusal)
	return fetchMe()
}

/**
 * Set the display name — the name other players read, as opposed to the username the
 * account signs in with. Unrationed, unlike a username change.
 *
 * Not checked here first, for the reason the email below isn't: `accounts` owns the rule
 * (`displayNameRejection` in `@repo/domain`, the game client's own charset), and that
 * module can't come into the browser — it imports `isemail`. The route refuses with an
 * empty 400, so the rule is spelled out in the refusal instead.
 */
const saveDisplayName = (displayName: string): Promise<unknown> =>
	call(`${where().accounts}/account/me/displayname`, {
		method: 'PUT',
		form: { displayName },
		authed: true,
		refusal:
			"That display name can't be used. Use up to 15 letters, numbers, spaces and .,'!?_&()#@:+- — and no profanity.",
	})

/**
 * Set the account's email.
 *
 * The address is NOT checked here first. `accounts` validates it with `isemail`, which
 * can't come along into the browser (it reaches for node's `util`, which vite stubs with
 * a throwing Proxy in dev) — and a second, looser copy of the rule would only disagree
 * with the real one. The server decides; this just names the refusal it answers with.
 */
const saveEmail = (email: string): Promise<unknown> =>
	call(`${where().accounts}/account/me/email`, {
		form: { email },
		authed: true,
		refusal: 'That email address looks wrong.',
	})

/**
 * The email change awaiting a code, if any: `saveEmail` STAGES the address and `accounts`
 * emails six-digit codes — first to the current address when there is one (so a stolen
 * session can't move it), then to the new one (so a typo is never stored). `sentTo` says
 * which step this is. Each code is spent with {@link confirmEmail}. This read is what lets
 * the form show the code step after a reload, or right after signup.
 */
interface PendingEmail {
	pending: string | null
	sentTo: string | null
}
const fetchPendingEmail = (): Promise<PendingEmail> =>
	call<PendingEmail>(`${where().accounts}/account/me/email/pending`, { authed: true })

/**
 * Spend the code from the email. One try per code. `applied` false means the current address
 * has approved and a second code is now out to the new one, which `pending`/`sentTo` name.
 */
const confirmEmail = (code: string): Promise<PendingEmail & { applied: boolean }> =>
	call<PendingEmail & { applied: boolean }>(`${where().accounts}/account/me/email/confirm`, {
		form: { code },
		authed: true,
	})

/**
 * Two-factor sign-in settings, on `auth` (`/account/me/2fa*`). The factor guards the
 * PASSWORD sign-in — the game's and this site's — so turning one on, and off, takes the
 * password; turning an authenticator off takes a current code from it too. One at a time.
 */
interface TwoFactorStatus {
	method: 'none' | 'totp' | 'email'
	totpPending: boolean
	hasEmail: boolean
	hasPassword: boolean
}
const fetchTwoFactor = (): Promise<TwoFactorStatus> =>
	call<TwoFactorStatus>(`${where().auth}/account/me/2fa`, { authed: true })

/** Start setting up an authenticator: the secret to load into it, and its `otpauth://` URI. */
const beginTotp = (): Promise<{ secret: string; uri: string }> =>
	call(`${where().auth}/account/me/2fa/totp`, { method: 'POST', authed: true })

const confirmTotp = (password: string, code: string): Promise<unknown> =>
	call(`${where().auth}/account/me/2fa/totp/confirm`, { form: { password, code }, authed: true })

const enableEmailTwoFactor = (password: string): Promise<unknown> =>
	call(`${where().auth}/account/me/2fa/email`, { form: { password }, authed: true })

const disableTwoFactor = (password: string, code: string): Promise<unknown> =>
	call(`${where().auth}/account/me/2fa/disable`, { form: { password, code }, authed: true })

/** Change the account's password. Lives on `auth`, not `accounts`. */
const changePassword = (oldPassword: string, newPassword: string): Promise<unknown> =>
	call(`${where().auth}/account/me/changepassword`, {
		form: { oldPassword, newPassword },
		authed: true,
	})

/**
 * "Forgot password": ask `auth` to email a recovery code to the address. The same route the
 * game posts, so it answers in the client's PascalCase envelope — and a refusal is a 200
 * with `Success: false`, which `call` doesn't throw on, hence the check here. `Success: true`
 * says nothing about whether the address is on an account; the page's copy allows for that.
 */
const recoverPassword = async (email: string): Promise<void> => {
	const r = await call<{ Success: boolean; Error: string | null }>(
		`${where().auth}/account/recoverpassword`,
		{ form: { email } }
	)
	if (!r.Success) throw new Error(r.Error || 'The recovery email could not be sent.')
}

/** Finish the recovery: the address, the code from the email, and the password to set. */
const resetPassword = (email: string, code: string, newPassword: string): Promise<unknown> =>
	call(`${where().auth}/account/resetpassword`, { form: { email, code, newPassword } })

/** Where this account's benefits stand: `www` reads them off the account row. */
interface BenefitsStatus {
	/** Whether the account already has Rec Room Plus. */
	hasPlus: boolean
	/** Whether a Discord identity is already tied to it. Which one is deliberately not served. */
	linked: boolean
	/**
	 * Whether ANY Discord is on the account — a claim's link or the bare one "Sign in with
	 * Discord" leaves. What the unlink button keys on; `linked` is only the claimed case.
	 */
	discordLinked: boolean
	/**
	 * The unlink's one precondition: the account must have an email address, or taking the
	 * Discord off could leave nothing to recover it by. Served so the panel can say so first.
	 */
	hasEmail: boolean
}

/**
 * The two ends of the benefits claim. Both live on `www` rather than on one of the game
 * workers, because the claim needs the Discord client secret — see www.app.ts.
 */
const fetchBenefitsStatus = (): Promise<BenefitsStatus> =>
	call<BenefitsStatus>('/api/benefits/status', { authed: true })

/** What a successful claim answers. */
interface ClaimResult {
	/**
	 * Where the account stands after this claim. The Discord is linked and its roles saved
	 * either way; this is false when none of them is a qualifying role (and the account had
	 * no Plus from before).
	 */
	hasPlus: boolean
	discordUsername?: string
	/**
	 * The supporter gift paid on this claim — the tokens the server hands a linked role once,
	 * the FIRST time an account links its Discord. Null on a re-claim, when no role is mapped
	 * to a gift, or when the server doesn't run one.
	 */
	tokensAwarded?: number | null
}

/** Redeem the code Discord sent us back with. The access token never reaches this page. */
const claimBenefits = (code: string): Promise<ClaimResult> =>
	call<ClaimResult>('/api/benefits/claim', { json: { code }, authed: true })

/**
 * Take the Discord off the account. `www` refuses (403, with a sentence) unless the account
 * has a password and an email — the panel checks the same two flags first so the button
 * only shows when it can work. Answers the status as it now stands.
 */
const unlinkDiscord = (): Promise<BenefitsStatus> =>
	call<BenefitsStatus>('/api/benefits/unlink', { json: {}, authed: true })

/**
 * Mark the signed-in account for deletion — www's own route, which only sets a flag on
 * the account. Nothing is removed and the session stays valid; the account page just
 * shows the mark from here on. Answers the mark as it now stands.
 */
const deleteAccount = (): Promise<{ isDeleted: true; deletedAt: string }> =>
	call<{ isDeleted: true; deletedAt: string }>('/api/account/delete', { json: {}, authed: true })

/**
 * The per-attempt CSRF nonce for the Discord round-trip, in sessionStorage.
 *
 * OAuth's `state` only means anything if the same page that minted it is the one that
 * checks it, so it can't come from the server. sessionStorage rather than localStorage:
 * it belongs to this tab and this attempt, and it should not outlive the tab that started
 * the flow.
 */
const OAUTH_STATE_KEY = 'rf_discord_state'

/**
 * Where to land after a Discord SIGN-IN — the `?next=` the login page was opened with.
 * Stashed beside the nonce because the round trip through Discord loses the query string,
 * and read back by `DiscordLoginPage` exactly once.
 */
const OAUTH_NEXT_KEY = 'rf_discord_next'

/**
 * Send the browser to Discord's consent screen.
 *
 * A real navigation, not a client-side route — Discord is another origin. The `state` is
 * minted here and stashed for the return leg; `www` built everything else about the URL
 * (see `/api/config`), so this only ever appends the one parameter it owns. `next` is the
 * sign-in's post-login destination; the claim passes none.
 */
function startDiscordAuth(authorizeUrl: string, next?: string) {
	const state = crypto.randomUUID()
	sessionStorage.setItem(OAUTH_STATE_KEY, state)
	if (next) sessionStorage.setItem(OAUTH_NEXT_KEY, next)
	else sessionStorage.removeItem(OAUTH_NEXT_KEY)
	const url = new URL(authorizeUrl)
	url.searchParams.set('state', state)
	window.location.assign(url.toString())
}

/** What `/api/login/discord` answers: auth's token body, plus who signed in and whether it made them. */
interface DiscordSignIn {
	access_token?: string
	/** True when no account was linked to this Discord and `auth` created one just now. */
	created?: boolean
	/** The Discord username, for the confirmation line only. */
	discordUsername?: string
}

/**
 * Redeem the sign-in's authorization code. Goes through `www`, like signup and the claim,
 * because the exchange needs the Discord client secret; `www` then has `auth` issue the
 * session and relays the token body, which is stored exactly as a password sign-in's is.
 */
async function signInWithDiscord(code: string): Promise<DiscordSignIn> {
	const data = await call<DiscordSignIn>('/api/login/discord', { json: { code } })
	if (typeof data.access_token !== 'string') throw new Error(authUnreachable('login'))
	setToken(data.access_token)
	return data
}

/**
 * Admin-only broadcasts. The token goes to `notify`, which enforces the admin-role gate
 * — so a session without the role is rejected there (403) even though the UI shows no
 * button. The maintenance frame carries `Msg: { StartsInMinutes }`, matching the game
 * client's ServerMaintenance handler.
 */
const broadcastMaintenance = (startsInMinutes: number): Promise<{ delivered?: number }> =>
	call<{ delivered?: number }>(`${where().notify}/internal/broadcast`, {
		json: {
			notificationType: NotificationType.ServerMaintenance,
			data: { StartsInMinutes: startsInMinutes },
		},
		authed: true,
	})

const coachMessageAll = (messageContent: string): Promise<{ sent?: number }> =>
	call<{ sent?: number }>(`${where().notify}/internal/coach-message-all`, {
		json: { messageContent },
		authed: true,
	})

/**
 * The same coach message to ONE player. `notify` queues it when they're offline, so
 * `queued` (rather than a 0 delivery) is what "they weren't online" looks like here —
 * it still arrives on their next connect, unlike the broadcast.
 */
const coachMessage = (
	playerId: number,
	messageContent: string
): Promise<{ delivered?: number; queued?: boolean }> =>
	call<{ delivered?: number; queued?: boolean }>(`${where().notify}/internal/coach-message`, {
		json: { playerId, messageContent },
		authed: true,
	})

/** Minimal history-based router: current pathname + a navigate() that pushes state. */
function useRouter() {
	// Pathname and query string are tracked SEPARATELY rather than as one string, because
	// the pages match on the pathname alone and one of them is reached with a query on it:
	// `/claim?code=…` is Discord's redirect, so a `path` that carried the search would stop
	// matching `/claim` the moment it mattered. `search` is here for the pages whose own
	// state belongs in the URL — the moderation panel's filters and paging — so that the
	// back button walks back through them instead of leaving the page.
	const [location, setLocation] = useState(() => ({
		path: window.location.pathname,
		search: window.location.search,
	}))
	useEffect(() => {
		const onPop = () =>
			setLocation({ path: window.location.pathname, search: window.location.search })
		window.addEventListener('popstate', onPop)
		return () => window.removeEventListener('popstate', onPop)
	}, [])
	const navigate = useCallback((to: string) => {
		// `to` may carry a query string, so the "did anything change" test is against the
		// whole of what's on screen — otherwise a filter change (same path, new query) would
		// never push, and the back button would have nothing to walk back through.
		const [path, search = ''] = to.split('?')
		// Read before pushing: afterwards `window.location` IS the destination, and every
		// "did the page change" test would answer no.
		const samePage = path === window.location.pathname
		if (to !== window.location.pathname + window.location.search) {
			window.history.pushState(null, '', to)
			// Staying on the same page with a different query is a re-filtered list, where
			// jumping to the top would throw away the reader's place. A real page change
			// still scrolls up.
			if (!samePage) window.scrollTo(0, 0)
		}
		setLocation({ path: path ?? '/', search: search === '' ? '' : `?${search}` })
	}, [])
	return { ...location, navigate }
}

type Navigate = (to: string) => void

/** An in-app link that routes client-side instead of doing a full page load. */
function Link({
	to,
	navigate,
	className,
	children,
}: {
	to: string
	navigate: Navigate
	className?: string
	children: ReactNode
}) {
	return (
		<a
			href={to}
			className={className}
			onClick={(e) => {
				e.preventDefault()
				navigate(to)
			}}
		>
			{children}
		</a>
	)
}

/**
 * The benefits claim itself: where the player stands, and the button that starts (or
 * re-runs) the Discord round-trip.
 *
 * This is BOTH ends of the OAuth round-trip: it sends the player to Discord, and it is
 * what renders when Discord sends them back. Which half is running is decided by whether
 * the URL carries a `code`.
 *
 * What it never holds is a Discord access token. It forwards the one-time `code` to
 * `www`, which does the exchange with the client secret and answers with a verdict; that
 * is the whole reason this one feature has a server side at all.
 *
 * Rendered in TWO places, which is why it is a component rather than a page. Its home is
 * the "Claim benefits" tab in the account dashboard, where someone would go looking for
 * it. But it also has to render on `/claim`, because that path is Discord's registered
 * redirect URI — the browser comes back to it with a `?code=`, and it is the only URL a
 * cold load can land on mid-flow. One component means the two can't drift.
 *
 * The effect keys off whether the URL carries a code, so the same code covers both: on
 * the dashboard there is none, and it just reports status.
 */
function BenefitsPanel({ account, config }: { account: SelfAccount; config: SiteConfig }) {
	const [status, setStatus] = useState<BenefitsStatus | undefined>(undefined)
	const [error, setError] = useState('')
	const [done, setDone] = useState('')
	const [pending, setPending] = useState(false)
	// Shown after a successful claim only. Plus rides on the game's token as `rn.plus`,
	// stamped at login, so the copy of it the player is holding still says they have none —
	// and tokens last a day and are never refreshed. Without this line the claim looks like
	// it silently did nothing, which is the single most likely support question here.
	const [relogin, setRelogin] = useState(false)
	const [unlinking, setUnlinking] = useState(false)
	// StrictMode runs effects twice in dev, and a Discord code is single-use: the second
	// run would redeem a spent code and report a failure over a claim that just worked.
	const redeemed = useRef(false)

	useEffect(() => {
		const params = new URLSearchParams(window.location.search)
		const code = params.get('code')
		const state = params.get('state')
		const expected = sessionStorage.getItem(OAUTH_STATE_KEY)

		if (code === null) {
			// Nothing came back from Discord — either the dashboard tab, or `/claim` opened
			// directly. Just show where they stand. Discord also returns with
			// `?error=access_denied` when someone cancels: no code, nothing to say, and the
			// button is right there to try again.
			void fetchBenefitsStatus()
				.then(setStatus)
				.catch(() => setStatus(undefined))
			return
		}

		// The return leg. Strip the query first, whatever happens next: the code is spent by
		// the request below, so a reload must not carry it (and a code has no business
		// sitting in the address bar, or in whatever the player pastes it into). replaceState
		// rather than a route change, so Back doesn't walk into a used code either.
		window.history.replaceState(null, '', '/claim')
		if (redeemed.current) return
		redeemed.current = true
		sessionStorage.removeItem(OAUTH_STATE_KEY)

		// The nonce this tab minted must be the one that came back. A mismatch means the
		// round-trip wasn't started here, which is exactly what `state` exists to catch.
		if (state === null || expected === null || state !== expected) {
			setError('That Discord sign-in did not match this browser. Please start again.')
			return
		}

		setPending(true)
		claimBenefits(code)
			.then((result) => {
				setStatus((prev) => ({
					hasPlus: result.hasPlus,
					linked: true,
					discordLinked: true,
					// The claim says nothing about this; keep what the status read said, and assume
					// none until it answers.
					hasEmail: prev?.hasEmail ?? false,
				}))
				const who = result.discordUsername ? ` as ${result.discordUsername}` : ''
				// Linked either way; whether Plus came with it depends on the roles. Without a
				// qualifying role the roles are still saved for the game, and that is said
				// plainly rather than reading as a failure.
				const verified = result.hasPlus
					? `Verified${who} — Rec Room Plus is now on your account.`
					: `Linked${who} — your Discord roles are saved to your account, but none of them currently grants Rec Room Plus.`
				// The first-link gift, when one was paid: it's sitting in a box in the game, and
				// the player would otherwise only find it by opening their gifts.
				const gift = result.tokensAwarded
					? ` A welcome gift of ${result.tokensAwarded.toLocaleString()} tokens is waiting in your gift boxes.`
					: ''
				setDone(verified + gift)
				// The re-login hint is about Plus riding on the game token; without Plus there
				// is nothing a sign-in would pick up.
				setRelogin(result.hasPlus)
			})
			.catch((err: unknown) => setError(err instanceof Error ? err.message : String(err)))
			.finally(() => setPending(false))
	}, [])

	// Read into a local so the narrowing survives into the click handlers below.
	const authorizeUrl = config.discordAuthorizeUrl
	if (!config.benefitsEnabled || authorizeUrl === null) {
		return (
			<section className="card">
				<h2>Claim benefits</h2>
				<p className="muted">Benefit claims aren’t available on this server right now.</p>
			</section>
		)
	}

	const claimed = status?.hasPlus === true
	const linked = status?.linked === true

	return (
		<section className="card">
			<h2>Link your Discord</h2>
			<p className="muted">
				Link your Discord to carry the roles you hold in our server into the game. Members with a
				supporter role also get Rec Room Plus on their account. We only ever read your username and
				which roles you hold in our server.
			</p>
			<p className="muted">
				Claiming as <strong>@{account.username}</strong> (#{account.accountId}). A Discord account
				can claim on one RecFlare account only.
			</p>

			{error && <p className="error">{error}</p>}
			{done && <p className="ok">{done}</p>}
			{relogin && (
				<p className="hint">
					Restart Rec Room and sign in again to pick it up — your game reads Rec Room Plus from the
					session it signed in with, so it won’t show until then.
				</p>
			)}

			{pending ? (
				<p className="muted">Checking your Discord roles…</p>
			) : claimed ? (
				// Already claimed. The button stays, because a player whose roles changed (or who
				// re-linked) can safely run it again — the claim is idempotent on their own
				// account — but it no longer reads as the thing to do.
				<>
					{!done && (
						<>
							<p className="ok">Rec Room Plus is active on this account.</p>
							<p className="hint">
								If the game doesn’t show it, sign out and back in — Rec Room Plus is read from the
								session your game signed in with.
							</p>
						</>
					)}
					<button className="linkish" onClick={() => startDiscordAuth(authorizeUrl)}>
						Re-verify with Discord
					</button>
				</>
			) : linked ? (
				// Linked, no Plus: a member without a qualifying role, or one who lost it. Their
				// roles are on the account; re-verifying refreshes them (and grants Plus if a
				// qualifying role has since been added).
				<>
					{!done && (
						<p className="muted">
							Your Discord is linked and its roles are saved to this account. None of them currently
							grants Rec Room Plus.
						</p>
					)}
					<button className="linkish" onClick={() => startDiscordAuth(authorizeUrl)}>
						Re-verify with Discord
					</button>
				</>
			) : (
				<button
					type="button"
					className="cta discord"
					onClick={() => startDiscordAuth(authorizeUrl)}
				>
					Verify with Discord
				</button>
			)}

			{status?.discordLinked && !pending && (
				// Taking the Discord off again. Offered for ANY link — a claim's, or the bare one a
				// Discord sign-in made — but only once the account can be recovered without it: an
				// account made from Discord has no email until the player sets one, and `www`
				// refuses the unlink until there is one. The panel says so rather than showing a
				// button that would fail.
				<div className="unlink">
					<h3>Unlink Discord</h3>
					{status.hasEmail ? (
						<>
							<p className="muted">
								Removes your Discord from this account. Rec Room Plus and Rec Room Studio access
								granted to this account are removed with it, your roles stop being read, and signing
								in with that Discord afterwards will make a new account rather than open this one.
								You can link again at any time.
							</p>
							<button
								type="button"
								className="linkish danger"
								disabled={unlinking}
								onClick={() => {
									if (
										!confirm(
											'Unlink your Discord from this account? Rec Room Plus and Studio access on this account will be removed.'
										)
									)
										return
									setUnlinking(true)
									setError('')
									setDone('')
									unlinkDiscord()
										.then((next) => {
											setStatus(next)
											setRelogin(false)
											setDone('Your Discord has been unlinked from this account.')
										})
										.catch((err: unknown) =>
											setError(err instanceof Error ? err.message : String(err))
										)
										.finally(() => setUnlinking(false))
								}}
							>
								{unlinking ? 'Unlinking…' : 'Unlink Discord'}
							</button>
						</>
					) : (
						<p className="hint">
							Before you can unlink, add an email address to this account (the{' '}
							<strong>Email</strong> tab), so the account can be recovered without Discord.
						</p>
					)}
				</div>
			)}
		</section>
	)
}

/**
 * `/claim` — the page Discord redirects back to.
 *
 * Not linked from anywhere any more: the claim lives in the account dashboard's "Claim
 * benefits" tab. This route still has to exist and still has to work on a cold load,
 * because it is the app's registered `redirect_uri` — the browser arrives here from
 * Discord carrying the `?code=`, with whatever session it has.
 *
 * Signing in comes FIRST, and not only because the grant needs an account to land on: the
 * bearer token is what tells `www` whose row to write, so a claim without one has no
 * subject. Hence the sign-in card rather than a redirect — someone who arrives here from a
 * link should be told what this is before being bounced to a login form.
 */
function ClaimPage({
	account,
	config,
	navigate,
}: {
	account: SelfAccount | null | undefined
	config: SiteConfig | undefined
	navigate: Navigate
}) {
	if (account === undefined || config === undefined) {
		return (
			<main className="shell">
				<p className="muted">Loading…</p>
			</main>
		)
	}

	if (account === null) {
		return (
			<main className="shell">
				<h1>Claim your benefits</h1>
				<section className="card">
					<h2>Sign in first</h2>
					<p className="muted">
						Benefits are granted to a RecFlare account, so we need to know which one is yours before
						you verify with Discord. If you were part-way through a claim, start it again from your
						account page once you’re signed in.
					</p>
					<Link to="/login" navigate={navigate} className="cta">
						Sign in
					</Link>
				</section>
			</main>
		)
	}

	return (
		<main className="shell">
			<h1>Claim your benefits</h1>
			<BenefitsPanel account={account} config={config} />
		</main>
	)
}

/**
 * The room id in `/rooms/<id>` or `/rooms/<id>/edit`, or null for any other path. Numeric
 * rather than the room's name: a name is renameable (`PUT /rooms/{id}/name`), so a link
 * someone bookmarked would rot the moment they renamed the room.
 */
function roomIdFromPath(path: string): number | null {
	const match = /^\/rooms\/(\d+)(\/edit)?$/.exec(path)
	return match ? Number.parseInt(match[1], 10) : null
}

/** Whether a room path (see roomIdFromPath) asks for the owner's editor rather than the view. */
function isRoomEditPath(path: string): boolean {
	return /^\/rooms\/\d+\/edit$/.test(path)
}

/**
 * A player's photo, from the `ImagesPlayer` projection. Public unless the list was the
 * viewer's own (see fetchPlayerPhotos), which is the one way a private one gets here —
 * `Accessibility` is what tells the grid to mark it.
 */
interface PublicPhoto {
	SavedImageId: number
	ImageName: string
	CreatedAt: string
	CheerCount: number
	Accessibility: number
	/** The room it was taken in; null for a photo taken outside one. */
	RoomId: number | null
}

/** A player's public room — the narrow shape `/rooms/createdby/:id` serves. */
interface PublicRoom {
	RoomId: number
	Name: string
	ImageName: string
	Stats: { VisitCount: number; CheerCount: number; FavoriteCount: number }
}

/** Prefix-search accounts by username — backs the header search. */
async function searchPlayers(query: string, take: number): Promise<PublicAccount[]> {
	if (query.trim() === '') return []
	return call<PublicAccount[]>(
		`${where().accounts}/account/search?name=${encodeURIComponent(query.trim())}&take=${take}`
	)
}

/** The profile page's account: an exact lookup, not the search bar's prefix query. */
const fetchPublicAccount = (username: string): Promise<PublicAccount | null> =>
	accountByUsername(username)

/**
 * A player's photo feed: the photos they took PLUS the ones they're tagged in, newest
 * first — the same feed the game's profile photo tab reads. Sent WITH the session token
 * when there is one: `api` reads it and, only when the list is the caller's own, includes
 * the photos they TOOK and keep private — so a signed-in player sees all of theirs on
 * their own `/user/<name>`, while everyone else's profile is the public list either way.
 * A photo someone else took and tagged them in is public-only for everyone; its privacy
 * is the taker's. Nothing here decides who the viewer is; the worker does, from the token.
 */
const fetchPlayerPhotos = (accountId: number, skip: number, take: number): Promise<PublicPhoto[]> =>
	call<PublicPhoto[]>(
		`${where().api}/api/images/v3/feed/player/${accountId}?skip=${skip}&take=${take}`,
		{
			authed: true,
		}
	)

const fetchPublicRooms = (accountId: number): Promise<PublicRoom[]> =>
	call<PublicRoom[]>(`${where().rooms}/rooms/ownedby/${accountId}`)

/**
 * One room by id, through the public lookup. `{}` (not a 404) when there's no such room —
 * the client reads an empty object as "no room", and so does this: null.
 */
async function fetchPublicRoom(roomId: number): Promise<OwnedRoom | null> {
	const room = await call<OwnedRoom | Record<string, never>>(`${where().rooms}/rooms?id=${roomId}`)
	return 'RoomId' in room ? (room as OwnedRoom) : null
}

/**
 * The public photos taken in a room. Asked for with `filter=1` (camera photos), as the
 * game asks: without it the feed also carries the room's own thumbnail. The feed serves
 * the raw `SavedImage` record (`Id`, not `SavedImageId` — see the api worker's note on
 * why the two lists differ), so it's narrowed here to the shape the photo grid draws.
 */
const fetchRoomPhotos = (roomId: number, skip: number, take: number): Promise<PublicPhoto[]> =>
	call<
		Array<{
			Id: number
			ImageName: string
			CreatedAt: string
			CheerCount: number
			Accessibility: number
			RoomId: number | null
		}>
	>(`${where().api}/api/images/v4/room/${roomId}?filter=1&skip=${skip}&take=${take}`).then(
		(images) =>
			images.map((i) => ({
				SavedImageId: i.Id,
				ImageName: i.ImageName,
				CreatedAt: i.CreatedAt,
				CheerCount: i.CheerCount,
				Accessibility: i.Accessibility,
				RoomId: i.RoomId,
			}))
	)

/**
 * Delete a room outright — the staff takedown. `rooms` lets the owner or a developer
 * through and refuses everyone else, moderators included; it answers a refusal as a 200 carrying
 * `Success: false` (the game's envelope), so the check is on the body, not the status.
 */
async function deleteRoom(roomId: number): Promise<void> {
	const result = await call<{ Success: boolean; Error: string | null }>(
		`${where().rooms}/rooms/${roomId}`,
		{ method: 'DELETE', authed: true }
	)
	if (!result.Success) throw new Error(result.Error || 'The room couldn’t be deleted.')
}

/**
 * Hide a room from the feeds and search, or list it again — the staff toggle. Not a game
 * endpoint (the real service set these flags from an admin tool), so it is recflare's own
 * on `rooms`, staff-only: the owner is refused like anyone else. Both flags move together.
 * Answers the lowercase `{ success, error, value }` envelope with the updated room.
 */
async function setRoomExcluded(roomId: number, excluded: boolean): Promise<OwnedRoom> {
	const result = await call<{ success: boolean; error: string; value: OwnedRoom | null }>(
		`${where().rooms}/rooms/${roomId}/exclude`,
		{ method: 'PUT', authed: true, form: { excluded: String(excluded) } }
	)
	if (!result.success || result.value === null) {
		throw new Error(result.error || 'The room’s listing couldn’t be changed.')
	}
	return result.value
}

/**
 * Set a room's top-level `Accessibility` — the game's own endpoint, which `rooms` also lets
 * staff through (audited) so the website can unpublish a room. Answers the lowercase
 * `{ success, error, value }` envelope with the updated room; a refusal is a 403.
 */
async function setRoomAccessibility(roomId: number, accessibility: number): Promise<OwnedRoom> {
	const result = await call<{ success: boolean; error: string; value: OwnedRoom | null }>(
		`${where().rooms}/rooms/${roomId}/accessibility`,
		{ method: 'PUT', authed: true, form: { accessibility: String(accessibility) } }
	)
	if (!result.success || result.value === null) {
		throw new Error(result.error || 'The room’s visibility couldn’t be changed.')
	}
	return result.value
}

/** The `/user/<username>` path (or the old `/u/<username>`), or null for any other path. */
function usernameFromPath(path: string): string | null {
	const match = /^\/(?:user|u)\/([^/]+)(?:\/edit)?$/.exec(path)
	return match ? decodeURIComponent(match[1]) : null
}

/** Whether a profile path (see usernameFromPath) asks for the staff edit page rather than the profile. */
function isUserEditPath(path: string): boolean {
	return /^\/(?:user|u)\/[^/]+\/edit$/.test(path)
}

// The nav's search. `/user/:name` and `/rooms/:id` stay reachable by URL either way; this
// only decides whether the search button that leads to them is shown.
const SHOW_SEARCH: boolean = true

/** How many of each kind the search panel lists. */
const SEARCH_TAKE = 5

/**
 * Rooms whose name starts with `query`. The prefix endpoint, not the game's `/rooms/search`:
 * that one's substring match reads every public room per call, which a search fired on
 * every pause in typing can't afford; this one is an index seek billed per row returned.
 */
const searchRooms = (query: string, take: number): Promise<PublicRoom[]> =>
	query.trim() === ''
		? Promise.resolve([])
		: call<PublicRoom[]>(
				`${where().rooms}/rooms/search/name?query=${encodeURIComponent(query.trim())}&take=${take}`
			)

function SearchIcon() {
	return (
		<svg viewBox="0 0 24 24" width="20" height="20" aria-hidden="true" focusable="false">
			<circle cx="11" cy="11" r="6.5" fill="none" stroke="currentColor" strokeWidth="2.2" />
			<path
				d="M16 16l4.5 4.5"
				fill="none"
				stroke="currentColor"
				strokeWidth="2.2"
				strokeLinecap="round"
			/>
		</svg>
	)
}

/**
 * The header search: a magnifier button that opens a panel searching players and rooms
 * together as you type. A button rather than an always-on bar so it fits a phone's nav.
 * Debounced so it doesn't fire per keystroke; closes on picking a result, on Escape, or
 * on a tap outside it. Enter takes the first player, else the first room.
 */
function SiteSearch({ navigate }: { navigate: Navigate }) {
	const [open, setOpen] = useState(false)
	const [query, setQuery] = useState('')
	const [players, setPlayers] = useState<PublicAccount[]>([])
	const [rooms, setRooms] = useState<PublicRoom[]>([])
	// The query the results on screen answer, so "nothing found" waits for the answer.
	const [answered, setAnswered] = useState('')
	const containerRef = useRef<HTMLDivElement>(null)
	const inputRef = useRef<HTMLInputElement>(null)
	// Answers by normalized query, for the panel's lifetime on the page: backspacing to a
	// query already asked redraws it without another request (and another D1 read).
	const cache = useRef(new Map<string, [PublicAccount[], PublicRoom[]]>())

	useEffect(() => {
		const key = query.trim().toLowerCase()
		const show = ([p, r]: [PublicAccount[], PublicRoom[]]) => {
			setPlayers(p.slice(0, SEARCH_TAKE))
			setRooms(r.slice(0, SEARCH_TAKE))
			setAnswered(query)
		}
		if (key === '') {
			setPlayers([])
			setRooms([])
			setAnswered('')
			return
		}
		const known = cache.current.get(key)
		if (known) {
			show(known)
			return
		}
		let stale = false
		const timeout = setTimeout(() => {
			void Promise.all([
				searchPlayers(key, SEARCH_TAKE).catch(() => null),
				searchRooms(key, SEARCH_TAKE).catch(() => null),
			]).then(([p, r]) => {
				const found: [PublicAccount[], PublicRoom[]] = [p ?? [], r ?? []]
				// A failed half isn't cached, so the next time this is typed it asks again.
				if (p !== null && r !== null) cache.current.set(key, found)
				if (!stale) show(found)
			})
		}, 250)
		return () => {
			stale = true
			clearTimeout(timeout)
		}
	}, [query])

	useEffect(() => {
		if (!open) return
		inputRef.current?.focus()
		const onPointerDown = (e: PointerEvent) => {
			if (containerRef.current && !containerRef.current.contains(e.target as Node)) {
				setOpen(false)
			}
		}
		document.addEventListener('pointerdown', onPointerDown)
		return () => document.removeEventListener('pointerdown', onPointerDown)
	}, [open])

	const go = (to: string) => {
		setOpen(false)
		setQuery('')
		navigate(to)
	}
	const playerPath = (r: PublicAccount) => `/user/${encodeURIComponent(r.username)}`
	const roomPath = (r: PublicRoom) => `/rooms/${r.RoomId}`
	const nothing = query.trim() !== '' && answered === query && players.length + rooms.length === 0

	return (
		<div className="site-search" ref={containerRef}>
			<button
				type="button"
				className={`site-search-toggle${open ? ' active' : ''}`}
				aria-label="Search players and rooms"
				aria-expanded={open}
				onClick={() => setOpen((o) => !o)}
			>
				<SearchIcon />
			</button>
			{open && (
				<div className="site-search-panel">
					<input
						ref={inputRef}
						type="search"
						placeholder="Search players and rooms…"
						aria-label="Search players and rooms"
						value={query}
						onChange={(e) => setQuery(e.target.value)}
						onKeyDown={(e) => {
							if (e.key === 'Escape') setOpen(false)
							if (e.key === 'Enter') {
								if (players[0]) go(playerPath(players[0]))
								else if (rooms[0]) go(roomPath(rooms[0]))
							}
						}}
					/>
					{players.length > 0 && (
						<div className="site-search-group">
							<p className="site-search-heading">Players</p>
							{players.map((r) => (
								<button
									key={r.accountId}
									type="button"
									className="site-search-result"
									onClick={() => go(playerPath(r))}
								>
									<img
										className="site-search-avatar"
										src={`${where().img}/${r.profileImage}?width=64`}
										alt=""
									/>
									<span>
										<span className="site-search-name">{r.displayName || r.username}</span>
										<span className="site-search-sub">@{r.username}</span>
									</span>
								</button>
							))}
						</div>
					)}
					{rooms.length > 0 && (
						<div className="site-search-group">
							<p className="site-search-heading">Rooms</p>
							{rooms.map((r) => (
								<button
									key={r.RoomId}
									type="button"
									className="site-search-result"
									onClick={() => go(roomPath(r))}
								>
									<img
										className="site-search-thumb"
										src={`${where().img}/${r.ImageName}?width=128`}
										alt=""
									/>
									<span>
										<span className="site-search-name">^{r.Name}</span>
										<span className="site-search-sub">
											{r.Stats.VisitCount.toLocaleString()} visits
										</span>
									</span>
								</button>
							))}
						</div>
					)}
					{nothing && <p className="site-search-empty">No players or rooms match.</p>}
				</div>
			)}
		</div>
	)
}

/**
 * A grid of photo thumbnails; clicking one opens it full size.
 *
 * The thumbnail is the img worker's cached 256px variant; the popup asks for the same key
 * with NO transform, which is the original upload. The popup is a native `<dialog>` opened
 * with `showModal()`, so Escape, the backdrop, and keeping focus inside it are the
 * browser's work rather than ours. Under the photo is the same caption its own page has.
 *
 * Safe to call `where()` in render: a caller only has photos to pass once a fetch that
 * went through it has resolved (see MyRooms).
 */
/**
 * Whether a click on a link should stay on this page: the main button with no modifier.
 * Anything else — middle-click, ctrl/cmd/shift-click — is the browser's own "open in a new
 * tab/window", and is left to go where the href says.
 */
const isPlainClick = (e: React.MouseEvent): boolean =>
	e.button === 0 && !e.metaKey && !e.ctrlKey && !e.shiftKey && !e.altKey

/**
 * One photo over the page: the picture with the same caption its own page has (see
 * PhotoView). Mounted only while open, so the full-size image isn't fetched until asked
 * for. `src` is drawn at once while the record loads. `onClose` covers Escape, which closes
 * the dialog without going through us; a click on the backdrop or the picture closes it
 * too, but not one on the caption, which has links and the owner's privacy toggle in it.
 */
function PhotoLightbox({
	imageId,
	src,
	navigate,
	onAccessibilityChange,
	onCheer,
	onClose,
}: {
	imageId: number
	src: string
	navigate?: Navigate
	onAccessibilityChange?: (accessibility: number) => void
	onCheer?: (cheered: boolean) => void
	onClose: () => void
}) {
	const dialogRef = useRef<HTMLDialogElement>(null)
	useEffect(() => {
		dialogRef.current?.showModal()
	}, [])
	return (
		<dialog
			ref={dialogRef}
			className="photo-modal"
			onClose={onClose}
			onClick={(e) => {
				const target = e.target as HTMLElement
				if (target === dialogRef.current || target.tagName === 'IMG') onClose()
			}}
		>
			<PhotoView
				imageId={imageId}
				src={src}
				navigate={navigate}
				onAccessibilityChange={onAccessibilityChange}
				onCheer={onCheer}
			/>
		</dialog>
	)
}

/**
 * Which of these photos the signed-in player has cheered — `api`'s `cheered/bulk`, the lookup
 * the game fills its own photo grid's cheer buttons from. Posted as a form, as the game
 * posts it; one comma-separated `id` carries the page, which the route splits.
 */
async function fetchCheered(ids: number[]): Promise<Map<number, boolean>> {
	const entries = await call<Array<{ SavedImageId: number; IsCheered: boolean }>>(
		`${where().api}/api/images/v5/cheered/bulk`,
		{ method: 'POST', authed: true, form: { id: ids.join(',') } }
	)
	return new Map(entries.map((e) => [e.SavedImageId, e.IsCheered]))
}

/** Cheer or un-cheer a photo through the game's own `POST /api/images/v1/cheer`. */
async function cheerPhoto(imageId: number, cheer: boolean): Promise<void> {
	await call(`${where().api}/api/images/v1/cheer`, {
		authed: true,
		json: { SavedImageId: imageId, Cheer: cheer },
	})
}

/**
 * The cheer state of a grid's photos for the signed-in player, and the toggle. Looks up
 * only the photos it hasn't asked about yet, so a feed loading another page asks about
 * that page alone. Signed out it asks nothing and the toggle is never offered.
 *
 * The count is kept here as a DELTA on the photo's `CheerCount` rather than refetched: the
 * cheer route answers a bare ack, and the feed's record is the count as of loading.
 */
function usePhotoCheers(photos: PublicPhoto[], enabled: boolean) {
	const [cheered, setCheered] = useState<Map<number, boolean>>(new Map())
	const [delta, setDelta] = useState<Map<number, number>>(new Map())
	const [pending, setPending] = useState<Set<number>>(new Set())
	const asked = useRef(new Set<number>())

	useEffect(() => {
		if (!enabled || !hasToken()) return
		const ids = photos.map((p) => p.SavedImageId).filter((id) => !asked.current.has(id))
		if (ids.length === 0) return
		for (const id of ids) asked.current.add(id)
		void fetchCheered(ids)
			.then((found) => setCheered((current) => new Map([...current, ...found])))
			// Unknown reads as not cheered; let a later render ask again.
			.catch(() => {
				for (const id of ids) asked.current.delete(id)
			})
	}, [photos, enabled])

	const toggle = useCallback(
		async (imageId: number) => {
			if (pending.has(imageId)) return
			const next = !(cheered.get(imageId) ?? false)
			const step = next ? 1 : -1
			const bump = (by: number) =>
				setDelta((current) => new Map(current).set(imageId, (current.get(imageId) ?? 0) + by))
			// Optimistic: the button moves at once, and moves back if the api refuses.
			setPending((current) => new Set(current).add(imageId))
			setCheered((current) => new Map(current).set(imageId, next))
			bump(step)
			try {
				await cheerPhoto(imageId, next)
			} catch {
				setCheered((current) => new Map(current).set(imageId, !next))
				bump(-step)
			} finally {
				setPending((current) => {
					const rest = new Set(current)
					rest.delete(imageId)
					return rest
				})
			}
		},
		[cheered, pending]
	)

	/**
	 * Take on a cheer made somewhere else — the popup's own pill — so the tile behind it
	 * agrees once it closes. Moves the count only when the state actually changed.
	 */
	const adopt = useCallback(
		(imageId: number, next: boolean) => {
			if ((cheered.get(imageId) ?? false) === next) return
			setCheered((current) => new Map(current).set(imageId, next))
			setDelta((current) =>
				new Map(current).set(imageId, (current.get(imageId) ?? 0) + (next ? 1 : -1))
			)
		},
		[cheered]
	)

	return {
		isCheered: (id: number) => cheered.get(id) ?? false,
		count: (p: PublicPhoto) => Math.max(0, p.CheerCount + (delta.get(p.SavedImageId) ?? 0)),
		isPending: (id: number) => pending.has(id),
		toggle,
		adopt,
	}
}

/**
 * A photo's cheer count: a button that cheers or un-cheers it for a signed-in viewer, a
 * plain count for anyone else. Drawn on a grid tile and under the photo on its own page.
 */
function CheerPill({
	photo,
	cheers,
	className = '',
	onToggle,
}: {
	photo: PublicPhoto
	cheers: ReturnType<typeof usePhotoCheers>
	className?: string
	/** Called with the new state once the viewer clicks (optimistically). */
	onToggle?: (cheered: boolean) => void
}) {
	const id = photo.SavedImageId
	const count = cheers.count(photo).toLocaleString()
	if (!hasToken()) {
		return (
			<span
				className={`photo-cheer ${className}`}
				title="Sign in to cheer"
				aria-label={`${count} cheers`}
			>
				<span aria-hidden="true">👍</span> {count}
			</span>
		)
	}
	const cheered = cheers.isCheered(id)
	return (
		<button
			type="button"
			className={`photo-cheer ${className}${cheered ? ' cheered' : ''}`}
			aria-pressed={cheered}
			aria-label={cheered ? 'Remove cheer' : 'Cheer photo'}
			disabled={cheers.isPending(id)}
			onClick={() => {
				onToggle?.(!cheered)
				void cheers.toggle(id)
			}}
		>
			<span aria-hidden="true">👍</span> {count}
		</button>
	)
}

/**
 * The names of the PUBLIC rooms these photos were taken in, for the captions under a
 * player's photos — the image records carry only the `RoomId`. One `rooms/bulk` lookup
 * per batch of rooms not yet asked about, so a feed loading another page asks only about
 * rooms new to it. A private or unpublished room is left out by the lookup
 * (`excludePrivateRooms`) and so gets no caption: its page would turn the visitor away.
 */
function usePhotoRoomNames(photos: PublicPhoto[], enabled: boolean): Map<number, string> {
	const [names, setNames] = useState<Map<number, string>>(new Map())
	const asked = useRef(new Set<number>())

	useEffect(() => {
		if (!enabled) return
		const ids = [
			...new Set(photos.map((p) => p.RoomId).filter((id): id is number => id != null && id > 0)),
		].filter((id) => !asked.current.has(id))
		if (ids.length === 0) return
		for (const id of ids) asked.current.add(id)
		void call<Array<{ RoomId: number; Name: string }>>(
			`${where().rooms}/rooms/bulk?id=${ids.join(',')}&excludePrivateRooms=True`
		)
			.then((rooms) =>
				setNames(
					(current) => new Map([...current, ...rooms.map((r) => [r.RoomId, r.Name] as const)])
				)
			)
			// No caption rather than an error under every photo; a later page may ask again.
			.catch(() => {
				for (const id of ids) asked.current.delete(id)
			})
	}, [photos, enabled])

	return names
}

/**
 * `cheerable` puts a cheer count on each photo, and for a signed-in viewer makes it a
 * button that cheers or un-cheers the photo exactly as the game does.
 *
 * `navigate`, when given, captions each photo with a link to the room it was taken in —
 * for a player's photos, which come from all over. A room's own feed leaves it out: every
 * caption would name the page you're on.
 */
function PhotoGrid({
	photos,
	cheerable = false,
	navigate,
}: {
	photos: PublicPhoto[]
	cheerable?: boolean
	navigate?: Navigate
}) {
	const [open, setOpen] = useState<PublicPhoto | null>(null)
	// Privacy the owner changed from the popup, by image id — so the tile's Private badge
	// follows without refetching the feed.
	const [privacy, setPrivacy] = useState<Map<number, number>>(new Map())
	const accessibility = (p: PublicPhoto) => privacy.get(p.SavedImageId) ?? p.Accessibility
	const cheers = usePhotoCheers(photos, cheerable)
	const roomNames = usePhotoRoomNames(photos, navigate !== undefined)

	return (
		<>
			<div className="photo-grid">
				{/* A real link to the photo's own page (`/image/<id>`, where it can be reported or
				    deleted), so middle-click and "open in new tab" land there. A plain click is
				    kept on this page and opens the lightbox instead; a click with a modifier (or
				    not the main button) is the browser's, and goes where the href says. */}
				{photos.map((p) => (
					<div key={p.SavedImageId} className="photo-tile">
						{/* The photo and its cheer pill, positioned together so the pill sits on the
						    picture even with a caption below it. */}
						<div className="photo-frame">
							<a
								className="photo-button"
								href={`/image/${p.SavedImageId}`}
								onClick={(e) => {
									if (!isPlainClick(e)) return
									e.preventDefault()
									setOpen(p)
								}}
								aria-label={
									accessibility(p) === Accessibility.Public ? 'View photo' : 'View private photo'
								}
							>
								<img
									className="photo-thumb"
									src={`${where().img}/${p.ImageName}?width=256`}
									alt=""
									loading="lazy"
								/>
								{/* Only the owner's own list ever carries a private photo (see
						    fetchPlayerPhotos), so this is the mark on their own profile that tells
						    them which of theirs nobody else can see. */}
								{accessibility(p) !== Accessibility.Public && (
									<span className="badge photo-private">Private</span>
								)}
							</a>
							{/* A sibling of the link, not inside it: a button can't nest in an <a>. */}
							{cheerable && <CheerPill photo={p} cheers={cheers} />}
						</div>
						{/* Always rendered when captions are on, so a photo with no public room keeps
						    its row the same height as the captioned ones beside it. */}
						{navigate && (
							<p className="photo-caption">
								{p.RoomId != null && roomNames.has(p.RoomId) && (
									<Link to={`/rooms/${p.RoomId}`} navigate={navigate}>
										^{roomNames.get(p.RoomId)}
									</Link>
								)}
							</p>
						)}
					</div>
				))}
			</div>
			{open && (
				<PhotoLightbox
					imageId={open.SavedImageId}
					src={`${where().img}/${open.ImageName}`}
					navigate={navigate}
					onAccessibilityChange={(a) =>
						setPrivacy((current) => new Map(current).set(open.SavedImageId, a))
					}
					onCheer={cheerable ? (next) => cheers.adopt(open.SavedImageId, next) : undefined}
					onClose={() => setOpen(null)}
				/>
			)}
		</>
	)
}

/** The `/image/<id>` path's numeric image id, or null for any other path. */
function imageIdFromPath(path: string): number | null {
	const match = /^\/image\/(\d+)\/?$/.exec(path)
	return match ? Number(match[1]) : null
}

/** What the image page shows of a photo — the raw `SavedImage`, the keys it reads. */
interface PageImage {
	ImageName: string
	Accessibility: number
	/** Who took it. */
	PlayerId: number
	/** Who was in it, as the taker tagged them — may include the taker. */
	TaggedPlayerIds: number[]
	/** The room it was taken in; null for a photo taken outside one. */
	RoomId: number | null
	CreatedAt: string
	/** The taker's caption; null (or empty) when they wrote none. */
	Description: string | null
	/** Moderation has fixed its privacy — the owner can't change it. */
	AccessibilityLocked: boolean
	CheerCount: number
}

/** The room a photo was taken in, as far as this page names it. */
interface PhotoRoom {
	RoomId: number
	Name: string
}

/**
 * The room a photo was taken in, through `rooms/bulk`. For a visitor only a PUBLIC room:
 * the lookup answers by id whatever a room's accessibility, so without the filter a photo
 * would name a private room its owner never published. Staff see the room either way —
 * a reported photo's room is part of the report. A failed lookup is no room rather than an
 * error: the photo is the page, the room a caption on it.
 */
async function fetchPhotoRoom(roomId: number, staff: boolean): Promise<PhotoRoom | null> {
	const filter = staff ? '' : '&excludePrivateRooms=True'
	const rooms = await call<PhotoRoom[]>(`${where().rooms}/rooms/bulk?id=${roomId}${filter}`).catch(
		() => []
	)
	return rooms.find((r) => r.RoomId === roomId) ?? null
}

/**
 * One photo by id, for its own page and the popup, through `api`'s `GET /api/images/v6/:id`.
 * Sent with the session token when there is one: the route serves a private image to the
 * player who took it (and to staff), and both may see it here — the owner to make it public
 * again, staff because the moderation panel links a reported photo here so it can be
 * deleted, and it may since have been made private. Anyone else gets a private image as the
 * same 404 as an unknown id.
 */
async function fetchPageImage(imageId: number, staff: boolean): Promise<PageImage | null> {
	const res = await fetch(`${where().api}/api/images/v6/${imageId}`, { headers: authHeader() })
	if (res.status === 404) return null
	if (!res.ok) throw new Error(`Couldn’t load the image (${res.status}).`)
	const image = (await res.json()) as PageImage
	// The route already refuses a private image to anyone else; checked again so this page
	// can't show one to a visitor if that ever changes.
	const mine = image.PlayerId === tokenAccountId()
	return staff || mine || image.Accessibility === Accessibility.Public ? image : null
}

/**
 * Make one of the caller's photos public or private through the game's own
 * `POST /api/images/v2/modifyaccessibility` — owner-only, and refused when moderation has
 * locked the photo's privacy.
 */
async function setImageAccessibility(imageName: string, accessibility: number): Promise<void> {
	await call(`${where().api}/api/images/v2/modifyaccessibility`, {
		json: { ImageName: imageName, Accessibility: accessibility },
		authed: true,
	})
}

/**
 * Delete a photo through `api`'s `POST /api/images/v1/deletesaved` — owner-only, except that
 * staff may take down anyone's (audit-logged there).
 */
async function deleteImage(imageName: string): Promise<void> {
	await call(`${where().api}/api/images/v1/deletesaved`, {
		json: { ImageName: imageName },
		authed: true,
	})
}

/** A padlock, shut or open — the owner's privacy toggle, as the game draws it. */
function LockIcon({ locked }: { locked: boolean }) {
	return (
		<svg viewBox="0 0 24 24" width="16" height="16" aria-hidden="true">
			<rect x="5" y="11" width="14" height="10" rx="2" fill="currentColor" />
			<path
				d={locked ? 'M8 11V7a4 4 0 0 1 8 0v4' : 'M8 11V7a4 4 0 0 1 7.5-1.9'}
				fill="none"
				stroke="currentColor"
				strokeWidth="2"
				strokeLinecap="round"
			/>
		</svg>
	)
}

/**
 * A photo with its caption — the caption the taker wrote, who took it and where, when, and
 * who's in it; and for the player who took it a padlock that makes it private or public, as
 * the game's own photo view has. Shared by the photo's page and the grid's popup, so the two
 * read the same.
 *
 * `src`, when given, is drawn while the record loads (the popup already knows the picture).
 * Links go through `navigate` when there is one; a room's feed has none, so its popup's
 * links are plain page loads. `footer` adds below the caption (the page's staff tools).
 */
function PhotoView({
	imageId,
	src,
	navigate,
	onAccessibilityChange,
	onCheer,
	footer,
}: {
	imageId: number
	src?: string
	navigate?: Navigate
	onAccessibilityChange?: (accessibility: number) => void
	/** A cheer made here, for the grid behind a popup to follow. */
	onCheer?: (cheered: boolean) => void
	footer?: (image: PageImage) => ReactNode
}) {
	// undefined = not fetched yet; null = no image this visitor may see.
	const [image, setImage] = useState<PageImage | null | undefined>(undefined)
	// Who took it and who's in it, by account id; empty until the lookup lands (or if it
	// fails — names are a caption, and the photo shows without them).
	const [players, setPlayers] = useState<Map<number, PublicAccount>>(new Map())
	const [room, setRoom] = useState<PhotoRoom | null>(null)
	const [error, setError] = useState('')
	const [saving, setSaving] = useState(false)
	const [privacyError, setPrivacyError] = useState('')
	const staff = isAdmin()
	// The photo as the cheer hook takes it — one tile's worth, so the pill here behaves
	// exactly as the grid's does.
	const cheerTarget = useMemo<PublicPhoto[]>(
		() =>
			image
				? [
						{
							SavedImageId: imageId,
							ImageName: image.ImageName,
							CreatedAt: image.CreatedAt,
							CheerCount: image.CheerCount,
							Accessibility: image.Accessibility,
							RoomId: image.RoomId,
						},
					]
				: [],
		[image, imageId]
	)
	const cheers = usePhotoCheers(cheerTarget, true)

	useEffect(() => {
		let live = true
		setImage(undefined)
		setPlayers(new Map())
		setRoom(null)
		setError('')
		setPrivacyError('')
		void fetchPageImage(imageId, staff)
			.then((found) => {
				if (!live) return
				setImage(found)
				if (!found) return
				void usernamesFor([found.PlayerId, ...found.TaggedPlayerIds]).then((names) => {
					if (live) setPlayers(names)
				})
				if (found.RoomId != null && found.RoomId > 0) {
					void fetchPhotoRoom(found.RoomId, staff).then((r) => {
						if (live) setRoom(r)
					})
				}
			})
			.catch((e) => {
				if (live) setError(e instanceof Error ? e.message : String(e))
			})
		return () => {
			live = false
		}
	}, [imageId, staff])

	const to = (path: string, children: ReactNode) =>
		navigate ? (
			<Link to={path} navigate={navigate}>
				{children}
			</Link>
		) : (
			<a href={path}>{children}</a>
		)

	/** A player's name as a link to their profile; the bare id while the lookup is out. */
	const player = (id: number): ReactNode => {
		const found = players.get(id)
		if (!found) return <span className="muted">Player #{id}</span>
		return to(`/user/${encodeURIComponent(found.username)}`, `@${found.username}`)
	}

	if (error) return <p className="error">{error}</p>
	if (image === null) {
		return (
			<p className="muted">
				There&apos;s no image here — it&apos;s private, or it doesn&apos;t exist.
			</p>
		)
	}
	if (image === undefined) {
		return src ? (
			<figure className="photo-view">
				<img src={src} alt="" />
			</figure>
		) : (
			<p className="muted">Loading…</p>
		)
	}

	// Tagged once each, in the order the taker tagged them.
	const tagged = [...new Set(image.TaggedPlayerIds)]
	const taken = new Date(image.CreatedAt)
	const isPrivate = image.Accessibility !== Accessibility.Public
	// Cosmetic: `api` checks the token is the taker's on the change.
	const mine = image.PlayerId === tokenAccountId()

	const togglePrivacy = async () => {
		const next = isPrivate ? Accessibility.Public : Accessibility.Private
		const before = image
		// Optimistic, as the cheer is: the padlock moves at once and back if refused.
		setSaving(true)
		setPrivacyError('')
		setImage({ ...image, Accessibility: next })
		try {
			await setImageAccessibility(image.ImageName, next)
			onAccessibilityChange?.(next)
		} catch (e) {
			setImage(before)
			setPrivacyError(e instanceof Error ? e.message : String(e))
		} finally {
			setSaving(false)
		}
	}

	return (
		<>
			<figure className="photo-view">
				<img src={src ?? `${where().img}/${image.ImageName}`} alt={image.Description ?? ''} />
				<figcaption className="image-meta">
					{image.Description && <p className="image-desc">{image.Description}</p>}
					<div className="image-meta-row">
						<p>
							Taken by {player(image.PlayerId)}
							{room && <> in {to(`/rooms/${room.RoomId}`, `^${room.Name}`)}</>}
							{!Number.isNaN(taken.getTime()) && (
								<span className="muted"> · {taken.toLocaleDateString()}</span>
							)}
						</p>
						<div className="image-actions">
							{cheerTarget[0] && (
								<CheerPill
									photo={cheerTarget[0]}
									cheers={cheers}
									className="inline"
									onToggle={onCheer}
								/>
							)}
							{mine && (
								<button
									type="button"
									className={`photo-lock${isPrivate ? ' locked' : ''}`}
									aria-pressed={isPrivate}
									aria-label={isPrivate ? 'Private — make public' : 'Public — make private'}
									title={
										image.AccessibilityLocked
											? 'A moderator has locked this photo’s privacy'
											: isPrivate
												? 'Private — only you can see it. Click to make it public.'
												: 'Public — click to make it private.'
									}
									disabled={saving || image.AccessibilityLocked}
									onClick={() => void togglePrivacy()}
								>
									<LockIcon locked={isPrivate} />
								</button>
							)}
						</div>
					</div>
					{tagged.length > 0 && (
						<p>
							Tagged:{' '}
							{tagged.map((id, i) => (
								<span key={id}>
									{i > 0 && ', '}
									{player(id)}
								</span>
							))}
						</p>
					)}
					{privacyError && <p className="error">{privacyError}</p>}
				</figcaption>
			</figure>
			{footer?.(image)}
		</>
	)
}

/** One photo on its own page (`/image/<id>`) — the photo and caption, and for staff a Delete card. */
function ImagePage({
	imageId,
	config,
	navigate,
}: {
	imageId: number
	config: SiteConfig | undefined
	navigate: Navigate
}) {
	const [deleted, setDeleted] = useState(false)
	const staff = isAdmin()

	useEffect(() => setDeleted(false), [imageId])

	return (
		<main className="shell wide image-page">
			{deleted ? (
				<p className="ok">The photo was deleted.</p>
			) : config === undefined ? (
				// Waits for the config for the hostnames, as PlayerPage does.
				<p className="muted">Loading…</p>
			) : (
				<PhotoView
					imageId={imageId}
					navigate={navigate}
					footer={(image) =>
						// Staff only, and cosmetic: `api` checks the token's role on the delete.
						staff && (
							<>
								{image.Accessibility !== Accessibility.Public && (
									<p className="muted">
										This photo is private — only its owner and staff can see it.
									</p>
								)}
								<StaffDelete
									noun="photo"
									name=""
									consequence="This deletes the photo for everyone, including the player who took it, and can't be undone."
									onDelete={() => deleteImage(image.ImageName)}
									onDeleted={() => setDeleted(true)}
								/>
							</>
						)
					}
				/>
			)}
		</main>
	)
}

/**
 * A player's public profile page (`/user/<username>`) — banner, avatar, bio-adjacent
 * info, their public rooms, and their public photos. Read-only: this is the
 * "rec.net-style profile" other players browse to, not the owner's own dashboard
 * (that stays on `/account`).
 *
 * Staff get a second page, `/user/<username>/edit`: the same hero (so the panel is never
 * about the wrong account) and the staff actions, which used to sit under the photos at
 * the foot of the profile. The two are switched with the View | Edit tabs a room has; for
 * anyone who isn't staff `/edit` is just the profile.
 *
 * On the viewer's OWN profile the same tabs appear with Edit leading to `/account`, the
 * dashboard — the one place their profile is changed — and the dashboard shows the pair
 * the other way round. A staff member on their own profile gets that too; the staff page
 * for their own account is still reachable at its URL.
 */
function PlayerPage({
	username,
	edit,
	viewer,
	config,
	navigate,
}: {
	username: string
	/** The `/edit` path: the staff page rather than the profile. */
	edit: boolean
	/** The signed-in account, to tell the viewer's own profile from anyone else's. */
	viewer: SelfAccount | null | undefined
	config: SiteConfig | undefined
	navigate: Navigate
}) {
	const [account, setAccount] = useState<PublicAccount | null | undefined>(undefined)
	const [rooms, setRooms] = useState<PublicRoom[] | null>(null)
	const [error, setError] = useState('')

	useEffect(() => {
		// Waits for the config, not the session: this page is public, but every fetch on it
		// goes through `where()`, which has no hostnames until `/api/config` lands. On a cold
		// load of `/user/<name>` the effect would otherwise fire first and the page would be
		// stuck on "Still starting up".
		if (config === undefined) return
		setAccount(undefined)
		setRooms(null)
		void fetchPublicAccount(username)
			.then((a) => {
				setAccount(a)
				if (a) {
					void fetchPublicRooms(a.accountId)
						.then(setRooms)
						.catch(() => setRooms([]))
				}
			})
			.catch((e) => setError(e instanceof Error ? e.message : String(e)))
	}, [username, config])

	if (error) {
		return (
			<main className="shell">
				<p className="error">{error}</p>
			</main>
		)
	}
	if (account === undefined) {
		return (
			<main className="shell">
				<p className="muted">Loading…</p>
			</main>
		)
	}
	if (account === null) {
		return (
			<main className="shell">
				<p className="muted">There&apos;s no player called @{username}.</p>
			</main>
		)
	}

	const created = new Date(account.createdAt)
	const staff = isAdmin()
	const editing = staff && edit
	const own = viewer != null && viewer.accountId === account.accountId
	const profilePath = `/user/${encodeURIComponent(account.username)}`

	return (
		<main className="shell wide">
			{own && !editing ? (
				<ViewEditTabs viewTo={profilePath} editTo="/account" edit={false} navigate={navigate} />
			) : (
				staff && (
					<ViewEditTabs
						viewTo={profilePath}
						editTo={`${profilePath}/edit`}
						edit={editing}
						navigate={navigate}
					/>
				)
			)}
			<section className="card player-hero">
				{account.bannerImage && (
					<img
						className="player-banner"
						src={`${where().img}/${account.bannerImage}?width=1024`}
						alt=""
					/>
				)}
				<div className="player-hero-body">
					<img
						className="player-avatar"
						src={`${where().img}/${account.profileImage}?width=256`}
						alt=""
					/>
					<div>
						<h1>{account.displayName || account.username}</h1>
						<p className="handle">
							@{account.username}
							{!Number.isNaN(created.getTime()) && ` · joined ${created.toLocaleDateString()}`}
						</p>
					</div>
				</div>
			</section>

			{editing ? (
				// Every endpoint behind the staff actions is gated by `requireStaff`; `staff` here
				// only decides what to show.
				<StaffPlayerActions account={account} navigate={navigate} />
			) : (
				<>
					<section className="card">
						<h2>Rooms</h2>
						{rooms === null ? (
							<p className="muted">Loading…</p>
						) : rooms.length === 0 ? (
							<p className="muted">No public rooms.</p>
						) : (
							<ul className="rooms rooms-grid">
								{rooms.map((room) => (
									<li className="room" key={room.RoomId}>
										<Link to={`/rooms/${room.RoomId}`} navigate={navigate} className="room-link">
											<img
												className="room-thumb"
												src={`${where().img}/${room.ImageName}?width=256`}
												alt=""
												loading="lazy"
											/>
											<div className="room-body">
												<span className="room-name">^{room.Name}</span>
												<p className="room-stats">
													{room.Stats.VisitCount.toLocaleString()} visits
												</p>
												<p className="room-stats">
													{room.Stats.CheerCount.toLocaleString()} cheers ·{' '}
													{room.Stats.FavoriteCount.toLocaleString()} favorites
												</p>
											</div>
										</Link>
									</li>
								))}
							</ul>
						)}
					</section>

					<section className="card">
						<h2>Photos</h2>
						<PhotoFeed
							feedKey={`player:${account.accountId}`}
							loadPage={(skip, take) => fetchPlayerPhotos(account.accountId, skip, take)}
							empty="No public photos."
							cheerable
							navigate={navigate}
						/>
					</section>
				</>
			)}
		</main>
	)
}

/**
 * The staff card at the foot of a player's profile: account fixes the game gives staff no
 * way to make. Each is a `www` endpoint (see src/staff.ts) that records itself on
 * `audit_log`. Clearing a password asks twice, since it logs the player out of password
 * sign-in until they set a new one; the rest are one click.
 */
/** The optional message on the box a staff gift comes in — one field, shared by every gift below it. */
function GiftMessageField({ value, onChange }: { value: string; onChange: (v: string) => void }) {
	return (
		<label>
			Gift box message
			<input
				type="text"
				value={value}
				maxLength={256}
				placeholder="A gift from the staff!"
				onChange={(e) => onChange(e.target.value)}
			/>
			<span className="hint">
				Goes on every gift box sent below. Optional; blank sends the default.
			</span>
		</label>
	)
}

function StaffPlayerActions({ account, navigate }: { account: PublicAccount; navigate: Navigate }) {
	const [tokens, setTokens] = useState('')
	// One message for every box sent from this card; it stays put between sends.
	const [message, setMessage] = useState('')
	const [confirmingClear, setConfirmingClear] = useState(false)
	const [confirmingDorm, setConfirmingDorm] = useState(false)
	const [itemId, setItemId] = useState('')
	const [xp, setXp] = useState('')
	const gift = useAction()
	const xpGift = useAction()
	const itemGift = useAction()
	const usernameChange = useAction()
	const clearPassword = useAction()
	const clearDorm = useAction()
	const grantPlus = useAction()
	const base = `/api/staff/players/${account.accountId}`

	return (
		<section className="card">
			<h2>Staff</h2>
			<PlayerBanStatus playerId={account.accountId} navigate={navigate} />
			{/* The gifts are developer-only; www refuses them to moderators. */}
			{isDeveloper() && (
				<>
					<GiftMessageField value={message} onChange={setMessage} />

					<form
						onSubmit={(e) => {
							e.preventDefault()
							void gift.run(async () => {
								const amount = Number(tokens)
								const res = await call<{ balance: number }>(`${base}/gift-tokens`, {
									authed: true,
									json: { amount, message: message.trim() },
								})
								setTokens('')
								const what =
									amount < 0
										? `Took ${Math.abs(amount).toLocaleString()} tokens back`
										: amount === 0
											? 'Sent an empty box'
											: `Sent ${amount.toLocaleString()} tokens`
								return `${what}. @${account.username} now has ${res.balance.toLocaleString()}.`
							})
						}}
					>
						<label>
							Gift tokens
							<span className="staff-gift">
								<input
									type="number"
									step={1}
									value={tokens}
									required
									onChange={(e) => setTokens(e.target.value)}
								/>
								<button type="submit" disabled={gift.pending}>
									{gift.pending ? 'Sending…' : 'Send'}
								</button>
							</span>
							<span className="hint">
								Arrives as a gift box, and is added to their balance right away. A negative amount
								takes tokens back instead — it still sends a box, and it can&apos;t take more than
								they have. Zero sends an empty box and moves nothing. Up to{' '}
								{MAX_TOKEN_GIFT.toLocaleString()} either way.
							</span>
						</label>
						{gift.error && <p className="error">{gift.error}</p>}
						{gift.done && <p className="ok">{gift.done}</p>}
					</form>

					<form
						onSubmit={(e) => {
							e.preventDefault()
							void xpGift.run(async () => {
								const amount = Number(xp)
								const res = await call<{ level: number; levelsGained: number }>(`${base}/gift-xp`, {
									authed: true,
									json: { amount, message: message.trim() },
								})
								setXp('')
								const levels =
									res.levelsGained > 0
										? ` They went up ${res.levelsGained} level${res.levelsGained === 1 ? '' : 's'}, to ${res.level}.`
										: ` They're level ${res.level}.`
								return `Sent ${amount.toLocaleString()} XP.${levels}`
							})
						}}
					>
						<label>
							Gift XP
							<span className="staff-gift">
								<input
									type="number"
									min={1}
									step={1}
									inputMode="numeric"
									value={xp}
									required
									onChange={(e) => setXp(e.target.value)}
								/>
								<button type="submit" disabled={xpGift.pending}>
									{xpGift.pending ? 'Sending…' : 'Send'}
								</button>
							</span>
							<span className="hint">
								Arrives as a gift box. Levels it crosses count, but don&apos;t pay their level-up
								rewards.
							</span>
						</label>
						{xpGift.error && <p className="error">{xpGift.error}</p>}
						{xpGift.done && <p className="ok">{xpGift.done}</p>}
					</form>

					<form
						onSubmit={(e) => {
							e.preventDefault()
							void itemGift.run(async () => {
								const res = await call<{
									kind: 'custom_item' | 'badge' | 'skin' | 'consumable'
									name: string
									prefabName?: string
									owned?: number
								}>(`${base}/gift-item`, {
									authed: true,
									json: { itemId: itemId.trim(), message: message.trim() },
								})
								setItemId('')
								switch (res.kind) {
									case 'badge':
										return `Granted the badge “${res.name}” to @${account.username}.`
									case 'skin':
										return `Sent the skin “${res.name}” (${res.prefabName}) to @${account.username}.`
									case 'consumable':
										return `Sent one “${res.name}” to @${account.username}. They now have ${(res.owned ?? 1).toLocaleString()}.`
									default:
										return `Sent the custom item “${res.name}” to @${account.username}.`
								}
							})
						}}
					>
						<label>
							Gift item or badge
							<span className="staff-gift">
								<input
									type="text"
									value={itemId}
									placeholder="Badge, custom item, skin or consumable id"
									spellCheck={false}
									required
									onChange={(e) => setItemId(e.target.value)}
								/>
								<button type="submit" disabled={itemGift.pending}>
									{itemGift.pending ? 'Sending…' : 'Send'}
								</button>
							</span>
							<span className="hint">
								A badge or custom avatar item’s guid, a skin’s modification guid, a consumable’s
								item desc, or a store id — the kind is worked out from the id. Arrives as a gift
								box, as if bought from the store; free to them, and a creator isn’t paid.
								Consumables stack: send again for another. Badges must be published and can be
								granted while the player is offline.
							</span>
						</label>
						{itemGift.error && <p className="error">{itemGift.error}</p>}
						{itemGift.done && <p className="ok">{itemGift.done}</p>}
					</form>
				</>
			)}

			<div className="mod-filter-actions staff-actions">
				<button
					type="submit"
					disabled={usernameChange.pending}
					onClick={() =>
						void usernameChange.run(async () => {
							const res = await call<{ availableUsernameChanges: number }>(
								`${base}/username-changes`,
								{ authed: true, method: 'POST' }
							)
							const n = res.availableUsernameChanges
							return `@${account.username} now has ${n} username change${n === 1 ? '' : 's'}.`
						})
					}
				>
					{usernameChange.pending ? 'Adding…' : 'Add username change'}
				</button>
				{/* Developer-only, like the gifts; www refuses it to moderators. */}
				{isDeveloper() && (
					<button
						type="submit"
						disabled={grantPlus.pending}
						onClick={() =>
							void grantPlus.run(async () => {
								const res = await call<{ hadPlus: boolean }>(`${base}/grant-plus`, {
									authed: true,
									method: 'POST',
								})
								return res.hadPlus
									? `@${account.username} already has Plus.`
									: `@${account.username} now has Plus. It takes effect the next time they sign in.`
							})
						}
					>
						{grantPlus.pending ? 'Granting…' : 'Grant Plus'}
					</button>
				)}
				{confirmingClear ? (
					<>
						<button
							type="submit"
							disabled={clearPassword.pending}
							onClick={() =>
								void clearPassword.run(async () => {
									const res = await call<{ hadPassword: boolean }>(`${base}/clear-password`, {
										authed: true,
										method: 'POST',
									})
									setConfirmingClear(false)
									return res.hadPassword
										? `Password cleared. @${account.username} can set a new one in game.`
										: `@${account.username} had no password set.`
								})
							}
						>
							{clearPassword.pending ? 'Clearing…' : 'Confirm clear password'}
						</button>
						<button
							type="button"
							className="linkish"
							disabled={clearPassword.pending}
							onClick={() => setConfirmingClear(false)}
						>
							Cancel
						</button>
					</>
				) : (
					<button type="submit" onClick={() => setConfirmingClear(true)}>
						Clear password
					</button>
				)}
				{confirmingDorm ? (
					<>
						<button
							type="submit"
							disabled={clearDorm.pending}
							onClick={() =>
								void clearDorm.run(async () => {
									const res = await call<{ previousSaveId: number | null; saveId: number | null }>(
										`${base}/clear-dorm`,
										{ authed: true, method: 'POST' }
									)
									setConfirmingDorm(false)
									if (res.previousSaveId === null)
										return `@${account.username}'s dorm has never been saved.`
									if (res.saveId === null) return `@${account.username}'s dorm is already empty.`
									return `Dorm cleared: @${account.username}'s dorm loads empty now (save ${res.saveId}). Their old dorm is kept as save ${res.previousSaveId}.`
								})
							}
						>
							{clearDorm.pending ? 'Clearing…' : 'Confirm clear dorm'}
						</button>
						<button
							type="button"
							className="linkish"
							disabled={clearDorm.pending}
							onClick={() => setConfirmingDorm(false)}
						>
							Cancel
						</button>
					</>
				) : (
					<button type="submit" onClick={() => setConfirmingDorm(true)}>
						Clear dorm
					</button>
				)}
				<button
					type="submit"
					onClick={() =>
						navigate(`/moderation/new?player=${encodeURIComponent(`@${account.username}`)}`)
					}
				>
					Report
				</button>
			</div>
			<p className="hint">
				<strong>Clear password:</strong> Only use if the player has requested a password clear and
				they can still login via Steam or Meta.
			</p>
			<p className="hint">
				<strong>Clear dorm:</strong> Empties the player&apos;s dorm so it loads in the 2023 client
				again — a dorm saved in a newer client won&apos;t. It publishes a new, empty save; the old
				one stays in the dorm&apos;s save history and can be restored.
			</p>
			{usernameChange.error && <p className="error">{usernameChange.error}</p>}
			{usernameChange.done && <p className="ok">{usernameChange.done}</p>}
			{clearPassword.error && <p className="error">{clearPassword.error}</p>}
			{clearPassword.done && <p className="ok">{clearPassword.done}</p>}
			{clearDorm.error && <p className="error">{clearDorm.error}</p>}
			{clearDorm.done && <p className="ok">{clearDorm.done}</p>}
			{grantPlus.error && <p className="error">{grantPlus.error}</p>}
			{grantPlus.done && <p className="ok">{grantPlus.done}</p>}
		</section>
	)
}

/** Halloween mode: on through October, off after. `?halloween=1` forces it on for testing. */
const HALLOWEEN_KEY = 'rf_halloween_off'
const HALLOWEEN_SPRITES = ['🦇', '👻', '🎃', '🕷️', '🦇', '👻', '🎃', '🦇', '👻', '🎃', '🕷️', '🦇']

const HALLOWEEN_CSS = `
.rf-halloween { position: fixed; inset: 0; pointer-events: none; z-index: 9998; overflow: hidden;
	background: radial-gradient(ellipse at center, transparent 55%, rgba(255, 110, 0, 0.14) 100%); }
.rf-halloween-sprite { position: absolute; top: 0; opacity: 0; animation: rf-drift linear infinite; will-change: transform; }
.rf-halloween-web { position: absolute; top: 0; font-size: 64px; opacity: 0.45; line-height: 1; }
@keyframes rf-drift {
	0% { transform: translate(0, 105vh) rotate(-8deg); opacity: 0; }
	10% { opacity: 0.85; }
	50% { transform: translate(40px, 50vh) rotate(8deg); }
	90% { opacity: 0.85; }
	100% { transform: translate(-30px, -10vh) rotate(-8deg); opacity: 0; }
}
@media (prefers-reduced-motion: reduce) { .rf-halloween-sprite { display: none; } }
.rf-halloween-toggle { position: fixed; left: 12px; bottom: 12px; z-index: 9999; pointer-events: auto;
	font-size: 20px; line-height: 1; padding: 6px 8px; border-radius: 999px; cursor: pointer; }
`

function halloweenActive(): boolean {
	if (new Date().getMonth() === 9) return true
	return new URLSearchParams(window.location.search).get('halloween') === '1'
}

/** The sprite, 23x25 native pixels, drawn at 3x with hard edges. */
const PUMPKIN_FRAMES = [
	new URL('./pumple-frames/frame-00.png', import.meta.url).href,
	new URL('./pumple-frames/frame-01.png', import.meta.url).href,
	new URL('./pumple-frames/frame-02.png', import.meta.url).href,
	new URL('./pumple-frames/frame-03.png', import.meta.url).href,
	new URL('./pumple-frames/frame-04.png', import.meta.url).href,
	new URL('./pumple-frames/frame-05.png', import.meta.url).href,
	new URL('./pumple-frames/frame-06.png', import.meta.url).href,
	new URL('./pumple-frames/frame-07.png', import.meta.url).href,
]
const PUMPKIN_W = 150
const PUMPKIN_H = 150
const PUMPKIN_LINES = ['boo!', 'hehe', 'hey!', 'spooky!', 'happy halloween!', 'ow!', '🎃']

const PUMPKIN_CSS = `
.rf-pumpkin { position: absolute; top: 0; left: 0; width: ${PUMPKIN_W}px; height: ${PUMPKIN_H}px; will-change: transform; }
.rf-pumpkin img {
        display: block;
        width: ${PUMPKIN_W}px;
        height: ${PUMPKIN_H}px;
        image-rendering: pixelated;
        transform-origin: 50% 100%;
}
/* The animated GIF provides its own walking frames. */
.rf-pumpkin-bubble { position: absolute; left: 50%; transform: translateX(-50%); margin: 6px 0; padding: 3px 8px;
	border-radius: 10px; background: #fff3dc; color: #2a1608; font-size: 12px; font-weight: 600;
	white-space: nowrap; opacity: 0; transition: opacity 0.15s; }
`

/**
 * A little pumpkin that strolls around the viewport, wanders off to random spots, walks toward the
 * cursor (stopping short of it), wobbles when the pointer is over it, and hops and talks when clicked.
 * It never captures pointer events, so it can't block anything underneath it.
 */
function LilPumpkin() {
	const rootRef = useRef<HTMLDivElement>(null)
	const flipRef = useRef<HTMLDivElement>(null)
	const spriteRef = useRef<HTMLImageElement>(null)
	const bubbleRef = useRef<HTMLDivElement>(null)

	useEffect(() => {
		const root = rootRef.current
		const flip = flipRef.current
		const sprite = spriteRef.current
		const bubble = bubbleRef.current
		if (!root || !flip || !sprite || !bubble) return
		if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) {
			root.style.display = 'none'
			return
		}

		const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, v))
		const maxX = () => Math.max(0, window.innerWidth - PUMPKIN_W)
		const maxY = () => Math.max(0, window.innerHeight - PUMPKIN_H)

		let x = clamp(window.innerWidth * 0.3, 0, maxX())
		let y = maxY()
		let tx = x
		let ty = y
		let facing = 1
		let pause = 1
		let jy = 0
		let vy = 0
		let walkTime = 0
		let walkDistance = 0
		let walkFrame = 0
		let mouseX = -1
		let mouseY = -1
		let mouseAt = -Infinity
		let speechTimer = 0
		let last = performance.now()
		let raf = 0
		const effectNodes: HTMLElement[] = []

		const spawnBatSwarm = () => {
			const flash = document.createElement('div')
			Object.assign(flash.style, {
				position: 'fixed',
				inset: '0',
				background: 'rgba(210, 0, 28, 0.32)',
				opacity: '1',
				transition: 'opacity 480ms ease-out',
				pointerEvents: 'none',
				zIndex: '100000',
			})
			document.body.appendChild(flash)
			effectNodes.push(flash)
			requestAnimationFrame(() => {
				flash.style.opacity = '0'
			})
			window.setTimeout(() => {
				flash.remove()
				const i = effectNodes.indexOf(flash)
				if (i !== -1) effectNodes.splice(i, 1)
			}, 520)

			const cx = x + PUMPKIN_W / 2
			const cy = y + jy + PUMPKIN_H / 2
			for (let i = 0; i < 22; i++) {
				const bat = document.createElement('span')
				const angle = Math.random() * Math.PI * 2
				const distance = 100 + Math.random() * 260
				const dx = Math.cos(angle) * distance
				const dy = Math.sin(angle) * distance
				Object.assign(bat.style, {
					position: 'fixed',
					left: `${cx}px`,
					top: `${cy}px`,
					fontSize: `${20 + Math.random() * 20}px`,
					lineHeight: '1',
					pointerEvents: 'none',
					zIndex: '100001',
					opacity: '1',
					transform: 'translate(-50%, -50%) scale(0.4)',
					transition: 'transform 850ms ease-out, opacity 850ms ease-out',
					willChange: 'transform, opacity',
				})
				bat.textContent = '🦇'
				document.body.appendChild(bat)
				effectNodes.push(bat)
				requestAnimationFrame(() => {
					bat.style.transform = `translate(calc(-50% + ${dx}px), calc(-50% + ${dy}px)) rotate(${Math.random() * 100 - 50}deg) scale(1.2)`
					bat.style.opacity = '0'
				})
				window.setTimeout(() => {
					bat.remove()
					const i = effectNodes.indexOf(bat)
					if (i !== -1) effectNodes.splice(i, 1)
				}, 900)
			}
		}

		root.style.transform = `translate(${x}px, ${y}px)`

		const say = (line: string) => {
			const nearTop = y + jy < 36
			bubble.style.top = nearTop ? '100%' : 'auto'
			bubble.style.bottom = nearTop ? 'auto' : '100%'
			bubble.textContent = line
			bubble.style.opacity = '1'
			window.clearTimeout(speechTimer)
			speechTimer = window.setTimeout(() => {
				bubble.style.opacity = '0'
			}, 1600)
		}

		const onMove = (e: MouseEvent) => {
			mouseX = e.clientX
			mouseY = e.clientY
			mouseAt = performance.now()
		}
		const onLeave = () => {
			mouseAt = -Infinity
		}
		let rapidClickCount = 0
		let rapidClickStart = 0
		const onClick = (e: MouseEvent) => {
			const top = y + jy
			const bob = 0
			const hit =
				e.clientX >= x - 45 &&
				e.clientX <= x + PUMPKIN_W + 45 &&
				e.clientY >= top - bob - 45 &&
				e.clientY <= top - bob + PUMPKIN_H + 45
			if (!hit) return

			const now = performance.now()
			if (now - rapidClickStart > 5000) {
				rapidClickStart = now
				rapidClickCount = 0
			}
			rapidClickCount++
			if (rapidClickCount >= 10) {
				rapidClickCount = 0
				rapidClickStart = 0
				window.dispatchEvent(new CustomEvent('rf-pumple-boss'))
			}
			spawnBatSwarm()
			if (jy === 0) vy = -430
			say(PUMPKIN_LINES[Math.floor(Math.random() * PUMPKIN_LINES.length)])
		}
		const onResize = () => {
			x = clamp(x, 0, maxX())
			y = clamp(y, 0, maxY())
			tx = clamp(tx, 0, maxX())
			ty = clamp(ty, 0, maxY())
		}
		window.addEventListener('mousemove', onMove)
		document.documentElement.addEventListener('mouseleave', onLeave)
		window.addEventListener('click', onClick)
		window.addEventListener('resize', onResize)

		const frame = (now: number) => {
			const dt = Math.min(0.05, (now - last) / 1000)
			last = now
			const following = now - mouseAt < 3000
			let speed = 0

			if (following) {
				const dx = mouseX - (x + PUMPKIN_W / 2)
				const dy = mouseY - (y + PUMPKIN_H / 2)
				const dist = Math.hypot(dx, dy)
				if (Math.abs(dx) > 4) facing = dx > 0 ? 1 : -1
				if (dist > 85) {
					// Walk toward the cursor but stop short, so it never ends up sitting under the pointer.
					tx = clamp(mouseX - (dx / dist) * 80 - PUMPKIN_W / 2, 0, maxX())
					ty = clamp(mouseY - (dy / dist) * 80 - PUMPKIN_H / 2, 0, maxY())
					speed = 310
				} else {
					tx = x
					ty = y
				}
				pause = 0.5
			} else if (pause > 0) {
				pause -= dt
				if (pause <= 0) {
					tx = Math.random() * maxX()
					ty = Math.random() * maxY()
				}
			} else {
				speed = 145
			}

			const mx = tx - x
			const my = ty - y
			const md = Math.hypot(mx, my)
			let moving = false
			if (speed > 0 && md > 2) {
				const step = Math.min(md, speed * dt)
				x += (mx / md) * step
				y += (my / md) * step
				moving = true

				// Advance the walk cycle according to distance actually traveled.
				walkDistance += step
				const nextFrame = Math.floor(walkDistance / 30) % PUMPKIN_FRAMES.length
				if (nextFrame !== walkFrame) {
					walkFrame = nextFrame
					sprite.src = PUMPKIN_FRAMES[walkFrame]
				}

				if (!following && Math.abs(mx) > 4) facing = mx > 0 ? -1 : 1
			} else if (speed > 0 && !following) {
				pause = 1 + Math.random() * 2.5
			}

			if (jy < 0 || vy < 0) {
				vy += 1500 * dt
				jy += vy * dt
				if (jy >= 0) {
					jy = 0
					vy = 0
				}
			}

			walkTime += moving ? dt : 0
			const bob = moving ? Math.abs(Math.sin(walkTime * 12)) * 7 : 0
			const breath = 1 + Math.sin(now / 400) * 0.03
			const over =
				following &&
				mouseX >= x &&
				mouseX <= x + PUMPKIN_W &&
				mouseY >= y + jy &&
				mouseY <= y + jy + PUMPKIN_H
			const rot = over ? Math.sin(now / 60) * 7 : 0

			root.classList.toggle('is-walking', moving)
			root.style.transform = `translate(${x.toFixed(1)}px, ${(y + jy - bob).toFixed(1)}px)`
			flip.style.transform = `rotate(${rot.toFixed(1)}deg) scale(${facing}, ${breath.toFixed(3)})`
			raf = requestAnimationFrame(frame)
		}
		raf = requestAnimationFrame(frame)

		return () => {
			cancelAnimationFrame(raf)
			window.clearTimeout(speechTimer)
			window.removeEventListener('mousemove', onMove)
			document.documentElement.removeEventListener('mouseleave', onLeave)
			window.removeEventListener('click', onClick)
			window.removeEventListener('resize', onResize)
		}
	}, [])

	return (
		<>
			<style>{PUMPKIN_CSS}</style>
			<div className="rf-pumpkin" ref={rootRef}>
				<div className="rf-pumpkin-bubble" ref={bubbleRef} />
				<div ref={flipRef} style={{ transformOrigin: '50% 100%' }}>
					<img ref={spriteRef} src={PUMPKIN_FRAMES[0]} alt="" draggable={false} />
				</div>
			</div>
		</>
	)
}

const HACKED_KEY = 'rf_halloween_hacked_seen'
const HACKED_TEXT = 'HACKED BY...'

const HACKED_CSS = `
.rf-hacked { position: fixed; inset: 0; z-index: 100005; display: grid; place-items: center; padding: 20px;
	background: #000c; backdrop-filter: blur(3px); animation: rf-hacked-in 0.2s ease-out; }
.rf-hacked-box { position: relative; width: min(440px, 100%); padding: 28px 24px 22px; text-align: center;
	background: #070a07; color: #39ff6a; border: 2px solid #39ff6a; border-radius: 6px;
	box-shadow: 0 0 30px #39ff6a55, inset 0 0 40px #39ff6a14;
	font-family: ui-monospace, 'Courier New', monospace; overflow: hidden; }
.rf-hacked-box:after { content: ""; position: absolute; inset: 0; pointer-events: none;
	background: repeating-linear-gradient(0deg, #0000 0 2px, #0006 2px 3px); }
.rf-hacked-x { position: absolute; top: 6px; right: 10px; z-index: 1; background: none; border: 0; color: #39ff6a;
	font: inherit; font-size: 20px; cursor: pointer; }
.rf-hacked-title { margin: 0; font-size: clamp(28px, 7vw, 42px); font-weight: 900; letter-spacing: 3px;
	text-shadow: 2px 0 #ff2a6d, -2px 0 #2af0ff; animation: rf-hacked-glitch 2.4s steps(1) infinite; }
.rf-hacked-caret { animation: rf-hacked-blink 0.7s steps(1) infinite; }
.rf-hacked-stage { height: 200px; display: grid; place-items: center; }
.rf-hacked-pumple { width: 180px; height: 180px; image-rendering: pixelated;
	animation: rf-hacked-strobe 1.3s steps(1) forwards, rf-hacked-drop 1.3s cubic-bezier(.2, 1.6, .4, 1) forwards; }
.rf-hacked-name { margin: 0; font-size: 26px; font-weight: 900; letter-spacing: 6px; color: #ff8a1f;
	text-shadow: 0 0 12px #ff8a1f; animation: rf-hacked-in 0.3s 1.3s both; }
.rf-hacked-sub { margin: 8px 0 18px; font-size: 13px; opacity: 0.8; animation: rf-hacked-in 0.3s 1.5s both; }
.rf-hacked-ok { padding: 9px 18px; border: 2px solid #39ff6a; border-radius: 4px; background: #0d1f10;
	color: #39ff6a; font: inherit; font-weight: 800; letter-spacing: 1px; cursor: pointer;
	animation: rf-hacked-in 0.3s 1.7s both; }
.rf-hacked-ok:hover { background: #39ff6a; color: #070a07; }
@keyframes rf-hacked-in { from { opacity: 0 } to { opacity: 1 } }
@keyframes rf-hacked-blink { 50% { opacity: 0 } }
@keyframes rf-hacked-glitch { 0%, 88%, 100% { transform: none } 90% { transform: translateX(-4px) skewX(8deg) }
	94% { transform: translateX(3px) skewX(-6deg) } }
@keyframes rf-hacked-strobe {
	0% { opacity: 0 } 8% { opacity: 1; filter: invert(1) } 16% { opacity: 0 }
	24% { opacity: 1; filter: hue-rotate(120deg) saturate(3) } 32% { opacity: 0 }
	42% { opacity: 1; filter: invert(1) hue-rotate(200deg) } 52% { opacity: 0 }
	64% { opacity: 1; filter: brightness(3) } 76% { opacity: 0.2 } 88%, 100% { opacity: 1; filter: none } }
@keyframes rf-hacked-drop { from { transform: scale(2.6) rotate(-14deg) } to { transform: none } }
@media (prefers-reduced-motion: reduce) {
	.rf-hacked-title, .rf-hacked-pumple, .rf-hacked-caret { animation: none }
}
`

/**
 * Once-ever "you've been hacked" joke: types out HACKED BY..., then Pumple strobes in. Dismissing
 * it (button, ✕, backdrop or Escape) records it so it never comes back. `?hacked=1` replays it.
 */
function HackedModal() {
	const forced = new URLSearchParams(window.location.search).get('hacked') === '1'
	const [open, setOpen] = useState(() => {
		if (forced) return true
		try {
			return localStorage.getItem(HACKED_KEY) !== '1'
		} catch {
			return false
		}
	})
	const [typed, setTyped] = useState(0)
	const done = typed >= HACKED_TEXT.length
	// Let HACKED BY... sit on screen for a beat before Pumple strobes in.
	// Reduced motion keeps the pacing; the CSS drops the strobe and glitch.
	const [revealed, setRevealed] = useState(false)

	const dismiss = () => {
		setOpen(false)
		try {
			localStorage.setItem(HACKED_KEY, '1')
		} catch {
			// Storage can be unavailable; it just shows again next visit.
		}
	}

	useEffect(() => {
		if (!open || done) return
		const t = window.setTimeout(() => setTyped((n) => n + 1), typed === 0 ? 500 : 110)
		return () => window.clearTimeout(t)
	}, [open, typed, done])

	useEffect(() => {
		if (!open || !done || revealed) return
		const t = window.setTimeout(() => setRevealed(true), 1400)
		return () => window.clearTimeout(t)
	}, [open, done, revealed])

	useEffect(() => {
		if (!open) return
		const onKey = (e: KeyboardEvent) => {
			if (e.key === 'Escape') dismiss()
		}
		window.addEventListener('keydown', onKey)
		return () => window.removeEventListener('keydown', onKey)
	}, [open])

	if (!open) return null
	return (
		<>
			<style>{HACKED_CSS}</style>
			<div className="rf-hacked" onClick={dismiss}>
				<div
					className="rf-hacked-box"
					role="dialog"
					aria-modal="true"
					aria-label="Hacked by Pumple"
					onClick={(e) => e.stopPropagation()}
				>
					<button type="button" className="rf-hacked-x" onClick={dismiss} aria-label="Close">
						✕
					</button>
					<h2 className="rf-hacked-title">
						{HACKED_TEXT.slice(0, typed)}
						{!revealed && <span className="rf-hacked-caret">█</span>}
					</h2>
					<div className="rf-hacked-stage">
						{revealed && (
							<img
								className="rf-hacked-pumple"
								src={new URL('./Pumple_monster_walk.gif', import.meta.url).href}
								alt="Pumple"
								draggable={false}
							/>
						)}
					</div>
					{revealed && (
						<>
							<p className="rf-hacked-name">PUMPLE</p>
							<p className="rf-hacked-sub">
								all your rooms are belong to pumpkin. happy halloween 🎃
							</p>
							<button type="button" className="rf-hacked-ok" onClick={dismiss}>
								spooky, ok
							</button>
						</>
					)}
				</div>
			</div>
		</>
	)
}

/** Drifting bats, ghosts and pumpkins plus corner cobwebs. Never blocks clicks; the corner button turns it off. */
function HalloweenOverlay() {
	const [off, setOff] = useState(() => {
		try {
			return localStorage.getItem(HALLOWEEN_KEY) === '1'
		} catch {
			return false
		}
	})
	if (!halloweenActive()) return null

	const toggle = () => {
		const next = !off
		setOff(next)
		try {
			if (next) localStorage.setItem(HALLOWEEN_KEY, '1')
			else localStorage.removeItem(HALLOWEEN_KEY)
		} catch {
			// Storage can be unavailable; the toggle still works for this visit.
		}
	}

	return (
		<>
			<style>{HALLOWEEN_CSS}</style>
			{!off && (
				<div className="rf-halloween" aria-hidden="true">
					<span className="rf-halloween-web" style={{ left: 0 }}>
						🕸️
					</span>
					<span className="rf-halloween-web" style={{ right: 0, transform: 'scaleX(-1)' }}>
						🕸️
					</span>
					<LilPumpkin />
					{HALLOWEEN_SPRITES.map((emoji, i) => (
						<span
							key={i}
							className="rf-halloween-sprite"
							style={{
								left: `${(i * 37 + 5) % 96}vw`,
								fontSize: `${22 + (i % 4) * 8}px`,
								animationDuration: `${14 + (i % 5) * 3}s`,
								animationDelay: `-${(i * 2.3).toFixed(1)}s`,
							}}
						>
							{emoji}
						</span>
					))}
				</div>
			)}
			{!off && <HackedModal />}
			<button
				type="button"
				className="rf-halloween-toggle"
				onClick={toggle}
				title={off ? 'Turn Halloween mode on' : 'Turn Halloween mode off'}
				aria-label={off ? 'Turn Halloween mode on' : 'Turn Halloween mode off'}
				style={{ opacity: off ? 0.5 : 1 }}
			>
				🎃
			</button>
		</>
	)
}

export function App() {
	// undefined = still checking the session; null = signed out.
	const [account, setAccount] = useState<SelfAccount | null | undefined>(undefined)
	// undefined until the config lands. Signup is treated as closed until told otherwise,
	// so a slow (or failed) config fetch can't flash a form the server would refuse.
	const [config, setConfig] = useState<SiteConfig | undefined>(undefined)
	const { path, search, navigate } = useRouter()
	const roomId = roomIdFromPath(path)
	const lookupUsername = usernameFromPath(path)
	const customAvatarItemId = customAvatarItemIdFromPath(path)
	const imageId = imageIdFromPath(path)
	const eventId = eventIdFromPath(path)
	const inventionId = inventionIdFromPath(path)

	useEffect(() => {
		// Config first, and everything else after it: it carries the hostnames every other
		// call needs. A config that doesn't land leaves the page signed out with signup
		// closed rather than guessing where the workers are.
		call<SiteConfig & { hosts: Hosts }>('/api/config')
			.then(async ({ hosts: resolved, ...site }) => {
				setHosts(resolved)
				setConfig(site)
				if (!hasToken()) return setAccount(null)
				// A stored token that `accounts` rejects is stale — `call` has already dropped
				// it, so this just falls back to signed-out rather than surfacing an error.
				await fetchMe()
					.then(setAccount)
					.catch(() => setAccount(null))
			})
			.catch(() => {
				setConfig({
					signupEnabled: false,
					turnstileSiteKey: null,
					benefitsEnabled: false,
					discordAuthorizeUrl: null,
					discordLoginUrl: null,
				})
				setAccount(null)
			})
	}, [])

	// Nothing to tell a server: the access token is a stateless JWT, so dropping it here
	// IS the sign-out. (The refresh token auth issues alongside it is never stored, so a
	// closed session leaves nothing behind to redeem.)
	const logout = useCallback(() => {
		setToken(null)
		setAccount(null)
		navigate('/')
	}, [navigate])

	return (
		<>
			<NavBar account={account} path={path} navigate={navigate} onLogout={logout} />
			{path === '/login/discord' ? (
				// Discord's registered redirect for a SIGN-IN (the claim's is `/claim`). Matched
				// before `/login`, which it would otherwise never reach; a cold load falls through
				// to the SPA shell like every other client-side route.
				<DiscordLoginPage config={config} navigate={navigate} onAuthed={setAccount} />
			) : path === '/login' || path === '/signup' ? (
				// One page, two doors. `/signup` exists so the homepage's create-account link
				// lands on that tab instead of dropping people on sign-in to find it — and so
				// the URL is linkable. Unknown paths fall back to index.html (see the assets
				// config in wrangler.jsonc), so a cold load of /signup reaches the SPA.
				<LoginPage
					account={account}
					config={config}
					initialTab={path === '/signup' ? 'signup' : 'login'}
					search={search}
					navigate={navigate}
					onAuthed={setAccount}
				/>
			) : path === '/confirm-email' ? (
				// Where the email-change confirmation's link lands (`?code=…`). Wants the
				// account's own session — the code approves the change, the session says whose —
				// so a signed-out visitor is sent through sign-in and back.
				<ConfirmEmailPage
					account={account}
					search={search}
					navigate={navigate}
					onChange={setAccount}
				/>
			) : path === '/reset-password' ? (
				// Where the recovery email's link lands (`?email=…&code=…`), and where "Forgot
				// your password?" on the sign-in page goes. Needs no session — the emailed code
				// is the credential — and a client-side route like the rest.
				<ResetPasswordPage search={search} navigate={navigate} />
			) : path === '/device' ? (
				// Studio opens this from verification_uri_complete. The code was minted by
				// auth; this page only approves it with the website session.
				<DeviceLinkPage account={account} search={search} navigate={navigate} />
			) : path === '/account' ? (
				<AccountPage account={account} config={config} navigate={navigate} onChange={setAccount} />
			) : path === '/admin' || path === '/admin/' ? (
				// The server-wide staff controls, out of the account dashboard so a staff
				// member's own settings aren't buried under them. Same gating as /moderation:
				// a plain client-side route, the page checks the token's role and so does every
				// endpoint behind it.
				<AdminPage account={account} navigate={navigate} />
			) : path === '/claim' ? (
				// Its own page rather than a dashboard tab: this path is Discord's registered
				// redirect URI, so it has to be one stable URL a cold load can land on.
				<ClaimPage account={account} config={config} navigate={navigate} />
			) : path === '/moderation' || path.startsWith('/moderation/') ? (
				// A whole surface rather than another dashboard tab, and its own URLS: the
				// panel routes UNDER this prefix (`/moderation/players/123`, and its filters in
				// the query string), so the back button walks back through a moderator's
				// session instead of dropping them on the homepage. Matched by prefix here for
				// that reason; the panel picks the view apart itself.
				//
				// None of these paths is in wrangler.jsonc's `run_worker_first`, so a cold load
				// on any of them falls through to the SPA shell; the page then gates itself on
				// the token's role, and every endpoint behind it re-checks.
				<ModerationPage account={account} path={path} search={search} navigate={navigate} />
			) : path === '/settings/recroomstudio' || path === '/settings/recroomstudio/' ? (
				// The URL Studio already opens from the "not authorized to upload" dialog.
				// A client-side route like /moderation: not in run_worker_first, so a cold
				// load falls through to the SPA shell. The page shows one account's own
				// status to whoever is signed in; the whitelist editors are on /admin.
				<StudioAccessPage account={account} navigate={navigate} />
			) : path === '/events' || path === '/events/' ? (
				// Public, and a client-side route like /stats: not in `run_worker_first`, so a
				// cold load falls through to the SPA shell. Waits on the config because its
				// reads go to `api` and `rooms` through `where()`.
				<EventsPage ready={config !== undefined} navigate={navigate} />
			) : path === '/rooms' || path === '/rooms/' ? (
				// The game's hot rooms list as a grid. Public, and a client-side route like
				// /events; `/rooms/<id>` (one room's page) is matched further down.
				<RoomsPage ready={config !== undefined} navigate={navigate} />
			) : eventId !== null ? (
				// One event's page, linked from the /events grid. Public events only; a
				// client-side route like the rest, so a cold load falls through to the SPA shell.
				<EventPage
					eventId={eventId}
					account={account}
					ready={config !== undefined}
					navigate={navigate}
				/>
			) : path === '/stats' ? (
				// Unlinked on purpose — nothing in the nav or footer points here; it's for whoever
				// is handed the URL. Public all the same, and a client-side route like the rest:
				// its data comes from `/api/stats/online`, which the existing `/api/*` allowlist
				// entry already sends to the Worker.
				<StatsPage search={search} navigate={navigate} />
			) : customAvatarItemId !== null ? (
				// The game's share link for a store item (`/d/store/customavataritem/<uuid>`), so
				// the path is the client's, not ours. Not in `run_worker_first` either: a cold
				// load falls through to the SPA shell like every other page here. Gated on the
				// session rather than the config because the lookup behind it needs a token.
				<ItemPage
					itemId={customAvatarItemId}
					signedIn={account === undefined ? undefined : account !== null}
					navigate={navigate}
				/>
			) : inventionId !== null ? (
				// The store share link for an invention. Public, published inventions only (see
				// InventionPage); a client-side route like the item page above.
				<InventionPage inventionId={inventionId} ready={config !== undefined} navigate={navigate} />
			) : imageId !== null ? (
				// A photo's own link. Public images only, read without the session (see
				// ImagePage); a client-side route, so a cold load falls through to the SPA shell.
				<ImagePage imageId={imageId} config={config} navigate={navigate} />
			) : lookupUsername !== null ? (
				<PlayerPage
					username={lookupUsername}
					edit={isUserEditPath(path)}
					viewer={account}
					config={config}
					navigate={navigate}
				/>
			) : roomId !== null ? (
				<RoomPage
					account={account}
					config={config}
					roomId={roomId}
					edit={isRoomEditPath(path)}
					navigate={navigate}
				/>
			) : (
				// Frozen until the countdown to November 1st ends; then it is the homepage again.
				<XmasHome>
					<HomePage account={account} config={config} navigate={navigate} />
				</XmasHome>
			)}
			<SiteFooter />
			<HalloweenOverlay />
			<ChristmasLayer />
			<PumpleBossFight />
		</>
	)
}

/** Footer: where to go next, plus the affiliation disclaimer. */
function SiteFooter() {
	return (
		<footer className="footer">
			<span>
				<a href={LICENSE_URL} target="_blank" rel="noreferrer">
					MIT licensed
				</a>{' '}
				— made by fans, not affiliated with Rec Room Inc.
			</span>
			<nav>
				{/* A real navigation, not a client-side route: /privacy is rendered by the
				    Worker (see src/privacy.ts) so it reads without JavaScript. */}
				<a href="/privacy">Privacy</a>
				<a href={DISCORD_INVITE} target="_blank" rel="noreferrer">
					Discord
				</a>
				<a href={SOURCE_REPO} target="_blank" rel="noreferrer">
					GitHub
				</a>
			</nav>
		</footer>
	)
}

/** Top nav: brand → home, plus a sign-in / my-account link for the session. */
function NavBar({
	account,
	path,
	navigate,
	onLogout,
}: {
	account: SelfAccount | null | undefined
	path: string
	navigate: Navigate
	onLogout: () => void
}) {
	// The signed-in player's own profile, which the avatar at the row's end opens.
	const profilePath = account ? `/user/${encodeURIComponent(account.username)}` : null
	return (
		<header className="nav">
			<div className="nav-backdrop" aria-hidden="true" />
			<Link to="/" navigate={navigate} className="brand">
				RecFlare
			</Link>
			<nav className="nav-links">
				<Link
					to="/rooms"
					navigate={navigate}
					className={path === '/rooms' || path === '/rooms/' ? 'active' : ''}
				>
					Rooms
				</Link>
				<Link
					to="/events"
					navigate={navigate}
					className={path === '/events' || path === '/events/' ? 'active' : ''}
				>
					Events
				</Link>
				{account === undefined ? null : account ? (
					<>
						{/* Staff only, and cosmetic: the link is hidden for everyone else, but
						    `/moderation` is a real URL anyone can type — the page and every
						    endpoint behind it check the token's role themselves. */}
						{isAdmin() && (
							<Link
								to="/moderation"
								navigate={navigate}
								className={
									path === '/moderation' || path.startsWith('/moderation/') ? 'active' : ''
								}
							>
								Moderation
							</Link>
						)}
						{isAdmin() && (
							<Link
								to="/admin"
								navigate={navigate}
								className={path === '/admin' || path === '/admin/' ? 'active' : ''}
							>
								Admin
							</Link>
						)}
						<button className="linkish" onClick={onLogout}>
							Sign out
						</button>
					</>
				) : (
					<Link to="/login" navigate={navigate} className={path === '/login' ? 'active' : ''}>
						Sign in
					</Link>
				)}
				{SHOW_SEARCH && <SiteSearch navigate={navigate} />}
				{/* The signed-in player's face, last in the row: their profile (the View side,
				    with the photo feed; the dashboard is a tab away from there). `where()` is safe
				    here because `account` only exists once `/account/me` answered through it. */}
				{account && profilePath && (
					<Link
						to={profilePath}
						navigate={navigate}
						className={`nav-avatar${path === profilePath || path === '/account' ? ' active' : ''}`}
					>
						<img
							src={`${where().img}/${account.profileImage}?width=96`}
							alt={`@${account.username}`}
							title="Your profile"
						/>
					</Link>
				)}
			</nav>
		</header>
	)
}

/**
 * How many photos the hero asks the feed for. Explicit rather than left to the api's
 * default, since the count is a design decision here: the stage rotates one photo every
 * six seconds, so ten is a minute of it — long enough that a repeat visitor sees fresh
 * photos, short enough that the arrows stay walkable and the payload stays small.
 */
const SLIDESHOW_TAKE = 10

/** One of the last three days' most-cheered public photos plus who took it and where. */
interface Slide {
	/** The `SavedImageId` — the photo's own page is `/image/<id>`. */
	id: number
	url: string
	username: string
	roomName: string | null
	/** The room's page is `/rooms/<id>`; the feed only carries photos taken in a room. */
	roomId: number | null
}

/**
 * Loads the last three days' most-cheered public photos once (topped up with the newest older ones
 * in a quiet stretch). `slides === null` means still in flight.
 *
 * Waits for the config, since the feed is served by the `api` worker — the same public
 * endpoint the game reads it from — and its hostname arrives with the config. Each entry
 * names an image; the browsable URL for it is on the `img` worker.
 */
function useSlideshow(config: SiteConfig | undefined) {
	const [slides, setSlides] = useState<Slide[] | null>(null)
	const [error, setError] = useState('')

	useEffect(() => {
		if (config === undefined) return
		type Feed = {
			Images?: Array<{
				SavedImageId: number
				ImageName: string
				Username: string
				RoomName: string | null
				RoomId: number | null
			}>
		}
		// Wrapped in an async call rather than started directly, because `where()` THROWS
		// when the config didn't land — synchronously, which straight out of an effect
		// would take the page down instead of leaving an empty stage behind the fold.
		void (async () => {
			const h = where()
			const d = await call<Feed>(`${h.api}/api/images/v1/slideshow?take=${SLIDESHOW_TAKE}`)
			setSlides(
				(d.Images ?? []).map((i) => ({
					id: i.SavedImageId,
					url: `${h.img}/${i.ImageName}`,
					username: i.Username,
					roomName: i.RoomName,
					roomId: i.RoomId,
				}))
			)
		})().catch((e) => setError(e instanceof Error ? e.message : String(e)))
	}, [config])

	return { slides, error }
}

/**
 * Public homepage. The stage leads: photos players actually took, with the way in
 * on top of them. Everything about how the thing is built sits below, for whoever
 * scrolls looking for it.
 */
function HomePage({
	account,
	config,
	navigate,
}: {
	account: SelfAccount | null | undefined
	config: SiteConfig | undefined
	navigate: Navigate
}) {
	const feed = useSlideshow(config)

	// The signup offer only makes sense to a signed-out visitor when the server would
	// actually take one. `account === undefined` is still-checking, so it shows nothing
	// rather than offering an account to someone who already has one.
	const offerSignup = account === null && config?.signupEnabled === true

	return (
		<main>
			<Stage slides={feed.slides} offerSignup={offerSignup} navigate={navigate} />
			<div className="shell home">
				<About slides={feed.slides} error={feed.error} />
			</div>
		</main>
	)
}

/**
 * The hero: the headline and the way in on the left, a rotating in-game photo on the
 * right. The photo is proof, never the payload — when the feed is slow or down the
 * frame holds its space and the left half reads the same, so "Play now!" is reachable
 * either way.
 */
function Stage({
	slides,
	offerSignup,
	navigate,
}: {
	slides: Slide[] | null
	offerSignup: boolean
	navigate: Navigate
}) {
	const [idx, setIdx] = useState(0)
	// The photo opened full size, or null. The show holds still while one is open, so the
	// picture behind the lightbox is the one that comes back when it closes.
	const [zoomed, setZoomed] = useState<Slide | null>(null)
	const count = slides?.length ?? 0

	// A timeout keyed on the current slide rather than one long-lived interval: steering
	// by hand re-arms it, so a photo you just picked gets its full six seconds.
	useEffect(() => {
		if (count < 2 || zoomed !== null) return
		const t = setTimeout(() => setIdx((i) => (i + 1) % count), 6000)
		return () => clearTimeout(t)
	}, [count, idx, zoomed])

	const slide = slides && slides.length > 0 ? slides[idx] : null
	const step = (by: number) => setIdx((i) => (i + by + count) % count)

	return (
		<section className="stage">
			<div className="stage-body">
				{/* Deliberately doesn't name the game: this is a fan project, so the
				    trademark stays out of the headline and appears lower down, in
				    plain nominative use next to the disclaimer. */}
				<h1 className="stage-title">
					Play <em>today</em>!
				</h1>
				<p className="stage-lede">
					The servers you remember, rebuilt and running — free, open source, and up right now.
				</p>
				<div className="stage-actions">
					<a className="cta" href={DOWNLOAD_URL} target="_blank" rel="noreferrer">
						Download for PC
					</a>
					<a className="cta" href={QUEST_DOWNLOAD_URL} target="_blank" rel="noreferrer">
						Download for Quest
					</a>
					<a className="cta discord" href={DISCORD_INVITE} target="_blank" rel="noreferrer">
						Join the Discord
					</a>
				</div>
				{/* A line rather than a fourth button: the download is the point of this page,
				    and launching the game makes an account by itself — signing up here is the
				    way in for someone who wants one first. Hidden entirely when signup is
				    closed, matching /login, which hides its create-account tab the same way. */}
				{offerSignup && (
					<p className="stage-alt">
						New here?{' '}
						<Link to="/signup" navigate={navigate}>
							Create an account
						</Link>
					</p>
				)}
			</div>
			<div className="stage-show">
				<div className="stage-frame">
					{/* The same deal as a grid thumbnail (see PhotoGrid): a real link to the photo's
					    page, so "open in new tab" lands where it can be reported, while a plain
					    click zooms it here. */}
					{slide && (
						<a
							className="stage-photo-link"
							href={`/image/${slide.id}`}
							onClick={(e) => {
								if (!isPlainClick(e)) return
								e.preventDefault()
								setZoomed(slide)
							}}
						>
							<img
								className="stage-photo"
								key={slide.url}
								src={slide.url}
								alt={`Photo taken in game by ${slide.username}`}
							/>
						</a>
					)}
				</div>
				{zoomed && (
					<PhotoLightbox
						imageId={zoomed.id}
						src={zoomed.url}
						navigate={navigate}
						onClose={() => setZoomed(null)}
					/>
				)}
				{/* Always mounted, so the frame doesn't shift down when the feed lands. */}
				<div className="stage-foot">
					{slide && (
						<span className="credit">
							Photo by{' '}
							<Link to={`/user/${encodeURIComponent(slide.username)}`} navigate={navigate}>
								@{slide.username}
							</Link>
							{slide.roomName && slide.roomId != null && (
								<>
									{' '}
									in{' '}
									<Link to={`/rooms/${slide.roomId}`} navigate={navigate}>
										^{slide.roomName}
									</Link>
								</>
							)}
						</span>
					)}
					{/* Arrows and a count, not a dot per photo: a dot each is wide enough to
					    shove the headline's half of the split off the page, and it would have
					    to be rebuilt the moment SLIDESHOW_TAKE grows. */}
					{count > 1 && (
						<span className="steer">
							<button onClick={() => step(-1)} aria-label="Previous photo">
								<Chevron />
							</button>
							<span className="count">
								{idx + 1} / {count}
							</span>
							<button onClick={() => step(1)} aria-label="Next photo">
								<Chevron next />
							</button>
						</span>
					)}
				</div>
			</div>
		</section>
	)
}

/** The slideshow's back/forward mark. Decorative — the buttons carry the label. */
function Chevron({ next }: { next?: boolean }) {
	return (
		<svg viewBox="0 0 24 24" width="16" height="16" aria-hidden="true" focusable="false">
			<path
				d={next ? 'M9 5l7 7-7 7' : 'M15 5l-7 7 7 7'}
				fill="none"
				stroke="currentColor"
				strokeWidth="2.2"
				strokeLinecap="round"
				strokeLinejoin="round"
			/>
		</svg>
	)
}

/** What RecFlare is, under the fold, for whoever wants it. */
function About({ slides, error }: { slides: Slide[] | null; error: string }) {
	// The feed answering is proof the server replied, so the indicator can't claim
	// the server is up when it isn't.
	const state = slides !== null ? 'online' : error ? 'down' : 'checking'

	return (
		<section className="about">
			<div>
				<h2 className="about-title">A cloud architected server for the 2023-2026 game clients</h2>
				<p className="about-lede">
					A free fan project, made by players who missed it. Aiming to be{' '}
					<strong>feature-complete</strong> and infinitely scalable —{' '}
					<strong>architected for the cloud</strong>, no gatekeeping, no basement server.
				</p>
			</div>
			<div className="about-side">
				<div className="about-links">
					<a className="cta ghost" href={SOURCE_REPO} target="_blank" rel="noreferrer">
						View the source
					</a>
				</div>
				<div className="status-block">
					<p className={`status ${state}`}>
						<span className="dot" />
						{state === 'online'
							? 'Servers are up'
							: state === 'down'
								? "Can't reach the servers"
								: 'Checking…'}
					</p>
					{/* Only when it's actually up: when it isn't, people want the status, not the joke. */}
					{state === 'online' && <p className="status-quip">The cloud never goes down, right?</p>}
				</div>
			</div>
		</section>
	)
}

/**
 * The sign-in page — sign in, plus create-account when the server says signup is open
 * (it needs a Turnstile keypair; see SiteConfig). Redirects to the account page once a
 * session exists, however it was obtained.
 */
/**
 * A `?next=` worth redirecting to after sign-in, or null. Only an absolute PATH on this
 * site qualifies: it has to start with one slash and not two (`//host` is scheme-relative,
 * i.e. another site), and carry no scheme. Anything else is dropped rather than repaired.
 */
function safeNextPath(raw: string | null): string | null {
	if (!raw || !raw.startsWith('/') || raw.startsWith('//') || raw.startsWith('/\\')) return null
	return raw
}

function LoginPage({
	account,
	config,
	initialTab,
	search,
	navigate,
	onAuthed,
}: {
	account: SelfAccount | null | undefined
	config: SiteConfig | undefined
	initialTab: 'signup' | 'login'
	/** The query string, for the `?next=` a page that needs a session sends people here with. */
	search: string
	navigate: Navigate
	onAuthed: (a: SelfAccount) => void
}) {
	// The tab IS the route (`/login` vs `/signup`) rather than local state, so the two can
	// never disagree — switching tabs pushes history, and back goes back to the other one.
	const tab = initialTab

	// Where to go once signed in: the page that sent the visitor here, when one did (an
	// item's share link needs a session to render), otherwise the account page. Only a
	// same-site path is honoured — one leading slash, so `//evil.example` can't ride in
	// through a link someone was handed — since this is a redirect after a sign-in.
	const next = safeNextPath(new URLSearchParams(search).get('next')) ?? '/account'

	useEffect(() => {
		if (account) navigate(next)
	}, [account, navigate, next])

	const authed = (a: SelfAccount) => {
		onAuthed(a)
		navigate(next)
	}

	const siteKey = config?.signupEnabled ? config.turnstileSiteKey : null
	const discordLoginUrl = config?.discordLoginUrl ?? null

	return (
		<main className="shell">
			<section className="card">
				{siteKey && (
					<div className="tabs">
						{/* The query rides along, so switching doors keeps the `?next=`. */}
						<button
							className={tab === 'login' ? 'active' : ''}
							onClick={() => navigate(`/login${search}`)}
						>
							Sign in
						</button>
						<button
							className={tab === 'signup' ? 'active' : ''}
							onClick={() => navigate(`/signup${search}`)}
						>
							Create account
						</button>
					</div>
				)}
				{siteKey && tab === 'signup' ? (
					<>
						<h2>Create account</h2>
						<p className="muted">
							A username is assigned for you — you&apos;ll see it on your account page. Choose a
							password, and the two together sign you in here and in the game.
						</p>
						<SignupForm siteKey={siteKey} onAuthed={authed} />
					</>
				) : (
					<>
						<h2>Sign in</h2>
						{/* Someone who arrived at /signup while it's closed gets told so, instead of a
						    sign-in form appearing where they expected to create an account. Only once
						    the config has landed: before that, closed is just the not-yet-known state. */}
						{tab === 'signup' && config && !config.signupEnabled && (
							<p className="warn">
								Account creation from the website is disabled. Launch the game to create an account.
							</p>
						)}
						<p className="muted">
							Use your username and password. Launching the game also creates an account, linked to
							your Steam ID — set a password on it and it signs in here too.
						</p>
						<LoginForm onAuthed={authed} />
						<p className="muted swap">
							<Link to="/reset-password" navigate={navigate}>
								Forgot your password?
							</Link>
						</p>
						{/* The other door. Shown on the server's say-so like the signup tab: the URL is
						    null until the Discord app is configured. `next` rides along through Discord in
						    sessionStorage, since the round trip drops the query. */}
						{discordLoginUrl && (
							<div className="alt-signin">
								<p className="muted">or</p>
								<button
									type="button"
									className="cta discord"
									onClick={() => startDiscordAuth(discordLoginUrl, next)}
								>
									Sign in with Discord
								</button>
								<p className="muted">
									Signs you into the account your Discord is linked to. No account yet? This makes
									one — set a password on it afterwards and it signs in to the game too.
								</p>
							</div>
						)}
						{/* The tabs above already offer this; the line under the button is where
						    someone who just found out they have no account is actually looking.
						    Gated on the same key, so it can't point at a door that isn't there. */}
						{siteKey && (
							<p className="muted swap">
								Don&apos;t have an account?{' '}
								<Link to={`/signup${search}`} navigate={navigate}>
									Create one
								</Link>
							</p>
						)}
					</>
				)}
			</section>
		</main>
	)
}

/**
 * `/confirm-email` — where the email-change emails' links land, with the code in the query.
 * The code approves a step and the account's own session says whose, so this wants a
 * sign-in: a signed-out visitor goes through `/login` and comes back here. The account
 * page's email card does the same thing without the link; this page exists so the emails
 * have somewhere to point. Both steps' emails point here: after the current address
 * approves, the page waits for the new address's code.
 */
function ConfirmEmailPage({
	account,
	search,
	navigate,
	onChange,
}: {
	account: SelfAccount | null | undefined
	search: string
	navigate: Navigate
	onChange: (a: SelfAccount) => void
}) {
	const [code, setCode] = useState(new URLSearchParams(search).get('code') ?? '')
	const [pending, setPending] = useState<PendingEmail | null | undefined>(undefined)
	const [approved, setApproved] = useState('')
	const { pending: busy, error, done, run } = useAction()

	useEffect(() => {
		if (account === null) navigate(`/login?next=${encodeURIComponent(`/confirm-email${search}`)}`)
	}, [account, navigate, search])

	useEffect(() => {
		if (!account) return
		fetchPendingEmail()
			.then((p) => setPending(p.pending === null ? null : p))
			.catch(() => setPending(null))
	}, [account])

	if (!account) return null
	return (
		<main className="shell">
			<section className="card">
				<h2>Confirm your email change</h2>
				{done ? (
					<>
						<p className="ok">{done}</p>
						<p className="muted swap">
							<Link to="/account" navigate={navigate}>
								Back to your account
							</Link>
						</p>
					</>
				) : pending === null ? (
					<>
						<p className="muted">
							No email change is waiting on <strong>@{account.username}</strong>. It may already be
							confirmed, or the code may have lapsed or been used — save the address again from your
							account page for a new one.
						</p>
						<p className="muted swap">
							<Link to="/account" navigate={navigate}>
								Go to your account
							</Link>
						</p>
					</>
				) : (
					<form
						onSubmit={(e) => {
							e.preventDefault()
							void run(async () => {
								const next = await confirmEmail(code.trim())
								if (!next.applied) {
									// Step 1 done; the second code's email links back here too. Not
									// `done`: the page stays on the form for that code.
									setPending(next)
									setCode('')
									setApproved(
										`Approved. A second code was emailed to ${next.sentTo} — enter it here, or follow that email's link.`
									)
									return ''
								}
								const applied = pending?.pending ?? ''
								onChange({ ...account, email: applied })
								return `Your account's email is now ${applied}.`
							})
						}}
					>
						{pending && (
							<p className="muted">
								Changing <strong>@{account.username}</strong>&apos;s email to{' '}
								<strong>{pending.pending}</strong>. Enter the code sent to{' '}
								<strong>{pending.sentTo}</strong>. It works once: a wrong code voids the change.
								{pending.sentTo !== pending.pending &&
									' Once approved, a second code goes to the new address.'}
							</p>
						)}
						{approved && <p className="ok">{approved}</p>}
						<label>
							Code
							<input
								type="text"
								inputMode="numeric"
								pattern="[0-9]{6}"
								value={code}
								autoComplete="one-time-code"
								onChange={(e) => setCode(e.target.value)}
								required
							/>
						</label>
						{error && <p className="error">{error}</p>}
						<button type="submit" disabled={busy || pending === undefined}>
							{busy ? 'Confirming…' : 'Confirm'}
						</button>
					</form>
				)}
			</section>
		</main>
	)
}

/**
 * `/reset-password` — password recovery, both halves. With no code in the query it asks for
 * the email address on the account and has `auth` send the code; with one (the email's link
 * carries both the address and the code) it asks for the new password and posts the three
 * together. Whoever typed the code by hand, or asked for the email here and then read it,
 * switches to the second form with the link under the first.
 *
 * The code is spent by ONE attempt, right or wrong — `auth` voids the recovery on a wrong
 * code so it can't be guessed — so a refusal here points back at requesting a new email
 * rather than inviting a retry of the code.
 */
function ResetPasswordPage({ search, navigate }: { search: string; navigate: Navigate }) {
	const params = new URLSearchParams(search)
	const [email, setEmail] = useState(params.get('email') ?? '')
	const [code, setCode] = useState(params.get('code') ?? '')
	const [newPassword, setNewPassword] = useState('')
	// The link arrives with a code; a visitor from the sign-in page doesn't have one yet.
	const [haveCode, setHaveCode] = useState(params.get('code') !== null)
	const request = useAction()
	const finish = useAction()

	return (
		<main className="shell">
			<section className="card">
				{haveCode ? (
					<>
						<h2>Choose a new password</h2>
						<p className="muted">
							Enter the six-digit code from the email and the password you want. The code works
							once, for 30 minutes.
						</p>
						{finish.done ? (
							<>
								<p className="ok">{finish.done}</p>
								<p className="muted swap">
									<Link to="/login" navigate={navigate}>
										Sign in
									</Link>
								</p>
							</>
						) : (
							<form
								onSubmit={(e) => {
									e.preventDefault()
									void finish.run(async () => {
										await resetPassword(email.trim(), code.trim(), newPassword)
										return 'Your password has been changed. Sign in with it here or in the game.'
									})
								}}
							>
								<label>
									Email address
									<input
										type="email"
										value={email}
										autoComplete="email"
										onChange={(e) => setEmail(e.target.value)}
										required
									/>
								</label>
								<label>
									Code
									<input
										type="text"
										inputMode="numeric"
										pattern="[0-9]{6}"
										value={code}
										autoComplete="one-time-code"
										onChange={(e) => setCode(e.target.value)}
										required
									/>
								</label>
								<label>
									New password
									<input
										type="password"
										value={newPassword}
										autoComplete="new-password"
										onChange={(e) => setNewPassword(e.target.value)}
										required
									/>
								</label>
								{finish.error && <p className="error">{finish.error}</p>}
								<button type="submit" disabled={finish.pending}>
									{finish.pending ? 'Saving…' : 'Set password'}
								</button>
							</form>
						)}
						{!finish.done && (
							<p className="muted swap">
								No code, or it stopped working?{' '}
								<a
									href="/reset-password"
									onClick={(e) => {
										e.preventDefault()
										setHaveCode(false)
									}}
								>
									Request a new email
								</a>
							</p>
						)}
					</>
				) : (
					<>
						<h2>Reset your password</h2>
						<p className="muted">
							Enter the email address on your account. If there is an account under it, we&apos;ll
							email you a six-digit code and a link to come back here.
						</p>
						<form
							onSubmit={(e) => {
								e.preventDefault()
								void request.run(async () => {
									await recoverPassword(email.trim())
									return "If that address is on an account, an email is on its way. Check your inbox (and spam folder), then enter the code here or follow the email's link."
								})
							}}
						>
							<label>
								Email address
								<input
									type="email"
									value={email}
									autoComplete="email"
									onChange={(e) => setEmail(e.target.value)}
									required
								/>
							</label>
							{request.error && <p className="error">{request.error}</p>}
							{request.done && <p className="ok">{request.done}</p>}
							<button type="submit" disabled={request.pending}>
								{request.pending ? 'Sending…' : 'Email me a code'}
							</button>
						</form>
						<p className="muted swap">
							Already have a code?{' '}
							<a
								href="/reset-password"
								onClick={(e) => {
									e.preventDefault()
									setHaveCode(true)
								}}
							>
								Enter it
							</a>
						</p>
					</>
				)}
			</section>
		</main>
	)
}

/**
 * `/login/discord` — the page Discord redirects a SIGN-IN back to. Its own route rather than
 * `/claim`, because that page wants a session before it does anything and this is how one
 * gets made; it is the app's second registered `redirect_uri`, so like `/claim` it has to
 * work on a cold load.
 *
 * The return leg mirrors the claim's: check the nonce this tab minted, strip the code off
 * the URL before anything else, redeem it exactly once. What differs is the outcome. A
 * sign-in to an existing account just goes where the login page was headed. A sign-in that
 * CREATED an account (`created`) stops here first: that account has no password, and
 * without one it can't sign in to the game — on a Quest without a Meta account, which is
 * the whole point of making it this way — so the one thing to tell a brand-new player is
 * where to set one.
 */
function DiscordLoginPage({
	config,
	navigate,
	onAuthed,
}: {
	config: SiteConfig | undefined
	navigate: Navigate
	onAuthed: (a: SelfAccount) => void
}) {
	const [error, setError] = useState('')
	const [created, setCreated] = useState<SelfAccount | null>(null)
	// StrictMode runs effects twice in dev, and a Discord code is single-use — see BenefitsPanel.
	const redeemed = useRef(false)

	useEffect(() => {
		const params = new URLSearchParams(window.location.search)
		const code = params.get('code')
		const state = params.get('state')
		const expected = sessionStorage.getItem(OAUTH_STATE_KEY)
		const next = safeNextPath(sessionStorage.getItem(OAUTH_NEXT_KEY)) ?? '/account'

		if (code === null) {
			// Opened directly, or Discord sent the player back with `?error=access_denied`
			// because they cancelled. Nothing to redeem; back to the door.
			navigate('/login')
			return
		}

		window.history.replaceState(null, '', '/login/discord')
		if (redeemed.current) return
		redeemed.current = true
		sessionStorage.removeItem(OAUTH_STATE_KEY)
		sessionStorage.removeItem(OAUTH_NEXT_KEY)

		if (state === null || expected === null || state !== expected) {
			setError('That Discord sign-in did not match this browser. Please start again.')
			return
		}

		signInWithDiscord(code)
			.then(async (result) => {
				const me = await fetchMe()
				onAuthed(me)
				if (result.created) setCreated(me)
				else navigate(next)
			})
			.catch((err: unknown) => setError(err instanceof Error ? err.message : String(err)))
	}, [navigate, onAuthed])

	if (created) {
		return (
			<main className="shell">
				<section className="card">
					<h2>Welcome to RecFlare</h2>
					<p>
						Your account is ready, linked to your Discord. Your username is{' '}
						<strong>@{created.username}</strong> — you can change it on your account page.
					</p>
					<p className="muted">
						It has no password yet. Set one on your account page: your username and that password
						are how you sign in to the game — including on a Quest without a Meta account.
					</p>
					<Link to="/account" navigate={navigate} className="cta">
						Go to my account
					</Link>
				</section>
			</main>
		)
	}

	return (
		<main className="shell">
			<section className="card">
				<h2>Signing in with Discord</h2>
				{error ? (
					<>
						<p className="error">{error}</p>
						<Link to="/login" navigate={navigate} className="cta ghost">
							Back to sign in
						</Link>
					</>
				) : (
					<p className="muted">{config === undefined ? 'Loading…' : 'One moment…'}</p>
				)}
			</section>
		</main>
	)
}

/** The signed-in account page. Redirects to sign-in when there's no session. */
function AccountPage({
	account,
	config,
	navigate,
	onChange,
}: {
	account: SelfAccount | null | undefined
	config: SiteConfig | undefined
	navigate: Navigate
	onChange: (a: SelfAccount) => void
}) {
	useEffect(() => {
		if (account === null) navigate('/login')
	}, [account, navigate])

	if (!account) {
		return (
			<main className="shell">
				<p className="muted">{account === undefined ? 'Loading…' : 'Redirecting…'}</p>
			</main>
		)
	}

	return (
		<main className="shell wide">
			{/* The same View | Edit pair the player's own profile shows, the other way round:
			    this is the Edit side, the profile (with the photo feed) the View. */}
			<ViewEditTabs
				viewTo={`/user/${encodeURIComponent(account.username)}`}
				editTo="/account"
				edit
				navigate={navigate}
			/>
			<h1>My account</h1>
			<Dashboard account={account} config={config} navigate={navigate} onChange={onChange} />
		</main>
	)
}

/**
 * `/admin`: the server-wide staff controls, in the account dashboard's tab rail but on
 * their own page. They used to be the dashboard's last tabs, where a staff member's own
 * settings and the server's switches shared one crowded rail. The split between the roles
 * is: every staff member gets their own sandbox switch and the Studio access whitelists
 * (a tab per kind); the maintenance notice, the coach message and the token drop are
 * developers only — and
 * `isAdmin()`/`isDeveloper()` only decide what's SHOWN, every endpoint behind a tab checks
 * the token's role itself (`requireStaff`, `requireDeveloper`).
 *
 * Gated like /moderation: a session still being checked waits, a signed-out visitor is
 * sent to sign in, and a signed-in player who isn't staff is told so plainly.
 */
function AdminPage({
	account,
	navigate,
}: {
	account: SelfAccount | null | undefined
	navigate: Navigate
}) {
	if (account === undefined) {
		return (
			<main className="shell wide">
				<section className="card">
					<p className="muted">Checking your session…</p>
				</section>
			</main>
		)
	}
	if (account === null) {
		return (
			<main className="shell">
				<section className="card">
					<h1>Admin</h1>
					<p className="muted">You need to be signed in to use the admin tools.</p>
					<button onClick={() => navigate('/login')}>Sign in</button>
				</section>
			</main>
		)
	}
	if (!isAdmin()) {
		return (
			<main className="shell">
				<section className="card">
					<h1>Admin</h1>
					<p className="muted">
						This area is for staff. Your account doesn&apos;t have the moderator or developer role.
					</p>
				</section>
			</main>
		)
	}
	return (
		<main className="shell wide">
			<h1>Admin</h1>
			<AdminTabs account={account} navigate={navigate} />
		</main>
	)
}

/** The admin page's rail and panels; only rendered for staff (see AdminPage). */
function AdminTabs({ account, navigate }: { account: SelfAccount; navigate: Navigate }) {
	const developer = isDeveloper()
	const sections = [
		// Developer-only: the broadcasts speak to every player or as the Coach (notify refuses
		// moderators), and the drop mints tokens (www's route is developer-only).
		...(developer
			? [
					{ id: 'maintenance', label: 'Server maintenance', render: () => <MaintenanceForm /> },
					{ id: 'coach', label: 'Coach message', render: () => <CoachMessageForm /> },
					{
						id: 'tokens',
						label: 'Token drop',
						// Two audiences for one gift: whoever is online now, or whoever holds a Discord role.
						render: () => (
							<>
								<TokenDropForm />
								<RoleTokenDropForm />
								<SupporterBonusCard />
								<DiscordRoleSyncCard />
							</>
						),
					},
					// The upload is signed by a developer-only route; the file then goes to R2 directly.
					{ id: 'video', label: 'Video upload', render: () => <VideoUploadForm /> },
				]
			: []),
		// The hand-curated discovery rows ("Featured This Week", "Rooms We Love", …).
		{ id: 'lists', label: 'Curated lists', render: () => <CuratedListsPanel /> },
		// The two roles a developer hands out, a list each (sandbox players are under Sandbox).
		...(developer
			? [
					{
						id: 'moderators',
						label: 'Moderators',
						render: () => <AccountFlagPanel flag="isModerator" navigate={navigate} />,
					},
					{
						id: 'influencers',
						label: 'Influencers',
						render: () => <AccountFlagPanel flag="isInfluencer" navigate={navigate} />,
					},
				]
			: []),
		// The Studio / Avatar Studio / screen-share whitelists, a tab each. Their public
		// face — one account's own status — stays at /settings/recroomstudio, the URL Studio
		// opens.
		...STUDIO_ACCESS_KINDS.map(({ kind, label }) => ({
			id: `access:${kind}`,
			label,
			render: () => <StudioAccessPanel kind={kind} account={account} navigate={navigate} />,
		})),
		// The staff member's OWN voice-server pool; a developer also gets the list of everyone
		// in it, to add and remove testers.
		{
			id: 'sandbox',
			label: 'Sandbox',
			render: () => (
				<>
					<SandboxForm />
					{developer && <AccountFlagPanel flag="isSandbox" navigate={navigate} />}
				</>
			),
		},
	]
	const [active, setActive] = useState(sections[0].id)
	const current = sections.find((s) => s.id === active) ?? sections[0]

	return (
		<div className="workspace">
			<nav className="vtabs">
				{sections.map((s) => (
					<button
						key={s.id}
						className={s.id === active ? 'active' : ''}
						onClick={() => setActive(s.id)}
					>
						{s.label}
					</button>
				))}
			</nav>
			<div className="panel">{current.render()}</div>
		</div>
	)
}

/**
 * One room's pages: the VIEW at `/rooms/<id>` — what the room is, and the photos taken in
 * it, the same for everyone including its owner — and the EDIT at `/rooms/<id>/edit`:
 * the image upload, the settings and the subrooms with their saves, plus the staff tools
 * for staff. Owners get the pair on their own rooms; staff on every room, since the edit
 * page is where they act on one. The two used to be one page that
 * picked by ownership, which left an owner with no way to see their own room as a visitor
 * does (the photo feed is only on the view) and a staff owner with no staff tools (only on
 * the view, which they never got).
 *
 * Ownership is decided by the caller's OWN list rather than the public `GET /rooms?id=`,
 * which is unfiltered by design (the game looks any room up that way). A room that isn't
 * yours simply isn't in the list, so there's no second ownership rule here to drift out of
 * step with the one the mutating endpoints enforce — and `/edit` on someone else's room is
 * just the view, unless you're staff.
 */
function RoomPage({
	account,
	config,
	roomId,
	edit,
	navigate,
}: {
	account: SelfAccount | null | undefined
	config: SiteConfig | undefined
	roomId: number
	/** The `/edit` path: the owner's editor rather than the view. */
	edit: boolean
	navigate: Navigate
}) {
	// undefined = not fetched yet; null = no such room.
	const [room, setRoom] = useState<OwnedRoom | null | undefined>(undefined)
	// The signed-in player's own rooms, or null while unknown. Decides which view this is:
	// a room in this list gets the owner's editable page, anything else the public one.
	const [mine, setMine] = useState<OwnedRoom[] | null>(null)
	// Set by the staff takedown. The room is gone by then, so the page says so rather than
	// re-fetching and answering with the "private or missing" line, which would be a lie.
	const [takenDown, setTakenDown] = useState<string | null>(null)
	const [error, setError] = useState('')
	const accountId = account?.accountId

	useEffect(() => {
		// Waits for the config (`where()` has no hostnames before it), not the session —
		// the lookup is public, and a signed-out visitor is this page's main reader.
		if (config === undefined) return
		setRoom(undefined)
		void fetchPublicRoom(roomId)
			.then(setRoom)
			.catch((e) => setError(e instanceof Error ? e.message : String(e)))
	}, [roomId, config])

	useEffect(() => {
		// `account === undefined` only means the stored token hasn't been checked yet.
		if (accountId === undefined) return
		void fetchMyRooms()
			.then(setMine)
			// The owner's list failing to load must not hide a public room — it just reads
			// as somebody else's.
			.catch(() => setMine([]))
	}, [accountId])

	// Whose page this is isn't known until both the room and (for a signed-in player) the
	// owner's list are in. Choosing early would flash the public view at an owner.
	const owned = mine?.find((r) => r.RoomId === roomId)
	const settled =
		room !== undefined && (account === null || (account !== undefined && mine !== null))
	// Edits (the owner's and the staff tools') answer with the whole updated room, so
	// swapping it into the list is enough — no re-fetch, and the other rooms keep their place.
	const replaceOwned = (updated: OwnedRoom) =>
		setMine((current) => (current ?? []).map((r) => (r.RoomId === updated.RoomId ? updated : r)))

	if (takenDown !== null) {
		return (
			<main className="shell wide">
				<p className="ok">^{takenDown} was deleted.</p>
				<p className="backlink">
					<Link to="/" navigate={navigate}>
						← Home
					</Link>
				</p>
			</main>
		)
	}
	if (error) {
		return (
			<main className="shell wide">
				<p className="error">{error}</p>
			</main>
		)
	}
	if (!settled) {
		return (
			<main className="shell wide">
				<p className="muted">Loading…</p>
			</main>
		)
	}

	// The rooms with a View | Edit pair: the caller's own, and — for staff, who act on rooms
	// from the edit page — any room at all. `rooms` checks the role itself on every write the
	// edit page makes, and audits a staff edit to a room they don't manage.
	const editable = owned ?? (isAdmin() && room ? room : null)
	const replaceEditable = owned ? replaceOwned : setRoom
	const tabs = (isEdit: boolean) => (
		<ViewEditTabs
			viewTo={`/rooms/${roomId}`}
			editTo={`/rooms/${roomId}/edit`}
			edit={isEdit}
			back={owned ? { to: '/account', label: 'My rooms' } : undefined}
			navigate={navigate}
		/>
	)

	if (editable && edit) {
		return (
			<main className="shell wide">
				{tabs(true)}
				<RoomDetail
					room={editable}
					imgHost={where().img}
					cdnHost={where().cdn}
					onRoomChange={replaceEditable}
				/>
				{/* Every owner may clear their room's instances; `ownedby/me` is the managers'
				    list (creator and co-owners), the same set the endpoint admits. Staff may
				    clear any room's. */}
				<ClearInstances room={editable} />
				{/* The staff tools sit with the rest of the controls on the edit page, so the
				    view stays the one everyone else sees. */}
				{isAdmin() && (
					<StaffRoomTools
						room={editable}
						clearInstances={false}
						onTakenDown={() => setTakenDown(editable.Name)}
						onRoomChange={replaceEditable}
					/>
				)}
			</main>
		)
	}

	if (editable) {
		// The owner's own list is the copy shown, so the view can't be told "private or
		// missing" about a room the owner has unpublished, and an edit is reflected on return.
		return (
			<main className="shell wide">
				{tabs(false)}
				<PublicRoomView
					room={editable}
					staffTools={false}
					navigate={navigate}
					onTakenDown={() => setTakenDown(editable.Name)}
					onRoomChange={replaceEditable}
				/>
			</main>
		)
	}

	// Unlisted rooms are reachable by link, which is what a URL is. Everything else that
	// isn't Public is somebody's private space, and gets the same sentence a missing room
	// does: which of the two it is answers a question a stranger has no business asking.
	// (Staff never get here: every room is `editable` to them, above.)
	const visible =
		room !== null &&
		(room.Accessibility === Accessibility.Public || room.Accessibility === Accessibility.Unlisted)

	return (
		<main className="shell wide">
			{visible ? (
				<PublicRoomView
					room={room}
					navigate={navigate}
					onTakenDown={() => setTakenDown(room.Name)}
					onRoomChange={setRoom}
				/>
			) : (
				<p className="muted">
					There&apos;s no room here — it&apos;s private, or it doesn&apos;t exist.
				</p>
			)}
		</main>
	)
}

/**
 * The way between a thing's two pages — a room's (RoomPage) or a player's (PlayerPage): an
 * optional breadcrumb on the left, and a View | Edit pair on the right with the current page
 * lit. A tab, not a word in the breadcrumb, since switching pages is the thing the reader
 * who sees it comes here to do.
 */
function ViewEditTabs({
	viewTo,
	editTo,
	edit,
	back,
	navigate,
}: {
	viewTo: string
	editTo: string
	/** Which of the two is the current page. */
	edit: boolean
	back?: { to: string; label: string }
	navigate: Navigate
}) {
	return (
		<div className="page-nav">
			{back ? (
				<p className="backlink">
					<Link to={back.to} navigate={navigate}>
						← {back.label}
					</Link>
				</p>
			) : (
				<span />
			)}
			<nav className="page-tabs" aria-label="Pages">
				<Link to={viewTo} navigate={navigate} className={edit ? '' : 'active'}>
					View
				</Link>
				<Link to={editTo} navigate={navigate} className={edit ? 'active' : ''}>
					Edit
				</Link>
			</nav>
		</div>
	)
}

/**
 * A room as anyone sees it: the same hero the owner's page draws, with the creator linked
 * to their profile in place of the upload control, then the room's public facts and the
 * photos players took in it — read-only, since nothing here is the viewer's to change.
 * No subroom list: a visitor has no use for the room's internals, and the owner gets them
 * (with the scene-data tool) on their own page instead.
 *
 * The staff tools are appended for staff unless `staffTools` is false — the owner's view
 * of their own room, where they sit on the edit page instead.
 */
function PublicRoomView({
	room,
	staffTools = true,
	navigate,
	onTakenDown,
	onRoomChange,
}: {
	room: OwnedRoom
	staffTools?: boolean
	navigate: Navigate
	onTakenDown: () => void
	/** A staff edit answers with the updated room; the page re-renders from it. */
	onRoomChange: (room: OwnedRoom) => void
}) {
	const [creator, setCreator] = useState<{ username: string; displayName: string } | null>(null)
	const created = new Date(room.CreatedAt)

	useEffect(() => {
		setCreator(null)
		void usernamesFor([room.CreatorAccountId]).then((names) =>
			setCreator(names.get(room.CreatorAccountId) ?? null)
		)
	}, [room.CreatorAccountId])

	return (
		<>
			<section className="card room-hero">
				<img className="room-hero-img" src={`${where().img}/${room.ImageName}?width=512`} alt="" />
				<div className="room-hero-body">
					<div className="room-head">
						<h1 className="room-hero-name">^{room.Name}</h1>
						<VisibilityBadge accessibility={room.Accessibility} />
					</div>
					{creator && (
						<p className="room-hero-by">
							by{' '}
							<Link to={`/user/${encodeURIComponent(creator.username)}`} navigate={navigate}>
								{creator.displayName || creator.username}
							</Link>
						</p>
					)}
					{room.Description ? (
						<p className="muted room-hero-desc">{room.Description}</p>
					) : (
						<p className="muted room-hero-desc">No description.</p>
					)}
					<p className="room-stats">
						{room.Stats.VisitCount.toLocaleString()} visit
						{room.Stats.VisitCount === 1 ? '' : 's'} · <RoomInteractions room={room} />
					</p>
				</div>
			</section>

			<section className="card">
				<h2>About this room</h2>
				<dl className="facts">
					<dt>Max players</dt>
					<dd>{room.MaxPlayers}</dd>
					<dt>Cloning</dt>
					<dd>{room.CloningAllowed ? 'Anyone may clone this room' : 'Not allowed'}</dd>
					<dt>Tags</dt>
					<dd>{room.Tags?.length ? room.Tags.map((t) => `#${t.Tag}`).join(' ') : 'None'}</dd>
					<dt>Created</dt>
					<dd>{Number.isNaN(created.getTime()) ? room.CreatedAt : created.toLocaleDateString()}</dd>
				</dl>
			</section>

			<section className="card">
				<h2>Photos taken here</h2>
				<PhotoFeed
					feedKey={`room:${room.RoomId}`}
					loadPage={(skip, take) => fetchRoomPhotos(room.RoomId, skip, take)}
					empty="Nobody has taken a photo here yet."
					cheerable
				/>
			</section>

			{staffTools && isAdmin() && (
				<StaffRoomTools room={room} onTakenDown={onTakenDown} onRoomChange={onRoomChange} />
			)}
		</>
	)
}

/** The caller's cheer/favourite on a room — `rooms`' `InteractionDto`. */
interface RoomInteraction {
	Cheered: boolean
	Favorited: boolean
}

type RoomInteractionKind = 'cheer' | 'favorite'

/**
 * Set or clear the caller's cheer or favourite on a room through the game's own endpoints.
 * Setting is the PUT, which TOGGLES, so it's only sent when the flag is known to be clear;
 * clearing is the DELETE, which is idempotent. Both answer the resulting interaction.
 */
const setRoomInteraction = (
	roomId: number,
	kind: RoomInteractionKind,
	on: boolean
): Promise<RoomInteraction> =>
	call<RoomInteraction>(`${where().rooms}/rooms/${roomId}/interactionby/me/${kind}`, {
		method: on ? 'PUT' : 'DELETE',
		authed: true,
	})

/**
 * The room's cheer and favourite counts. For a signed-in viewer each is a button that
 * cheers (👍) or favourites (★) the room as the game does; signed out they're plain counts.
 *
 * The counts are the room's as of loading, moved by one when the server reports the flag
 * changed — the interaction routes answer the flags, not the room's new totals.
 */
function RoomInteractions({ room }: { room: OwnedRoom }) {
	const signedIn = hasToken()
	// null until the viewer's state is known (or forever, signed out).
	const [mine, setMine] = useState<RoomInteraction | null>(null)
	const [delta, setDelta] = useState({ cheer: 0, favorite: 0 })
	const [pending, setPending] = useState<RoomInteractionKind | null>(null)
	const [error, setError] = useState('')

	useEffect(() => {
		setMine(null)
		setDelta({ cheer: 0, favorite: 0 })
		setError('')
		if (!signedIn) return
		let stale = false
		void call<RoomInteraction>(`${where().rooms}/rooms/${room.RoomId}/interactionby/me`, {
			authed: true,
		})
			.then((i) => {
				if (!stale) setMine(i)
			})
			.catch(() => {})
		return () => {
			stale = true
		}
	}, [room.RoomId, signedIn])

	const toggle = async (kind: RoomInteractionKind) => {
		if (mine === null || pending !== null) return
		const field = kind === 'cheer' ? 'Cheered' : 'Favorited'
		const was = mine[field]
		setPending(kind)
		setError('')
		try {
			const next = await setRoomInteraction(room.RoomId, kind, !was)
			setMine(next)
			if (next[field] !== was) {
				setDelta((d) => ({ ...d, [kind]: d[kind] + (next[field] ? 1 : -1) }))
			}
		} catch (err) {
			setError(err instanceof Error ? err.message : String(err))
		} finally {
			setPending(null)
		}
	}

	const favorites = Math.max(0, room.Stats.FavoriteCount + delta.favorite)
	const cheers = Math.max(0, room.Stats.CheerCount + delta.cheer)
	const favoriteLabel = `${favorites.toLocaleString()} favourite${favorites === 1 ? '' : 's'}`
	const cheerLabel = `${cheers.toLocaleString()} cheer${cheers === 1 ? '' : 's'}`

	if (!signedIn || mine === null) {
		return (
			<>
				<span title={signedIn ? undefined : 'Sign in to cheer'}>{cheerLabel}</span> ·{' '}
				<span title={signedIn ? undefined : 'Sign in to favourite'}>{favoriteLabel}</span>
			</>
		)
	}
	return (
		<>
			<button
				type="button"
				className={`room-interact${mine.Cheered ? ' on' : ''}`}
				aria-pressed={mine.Cheered}
				title={mine.Cheered ? 'Remove cheer' : 'Cheer this room'}
				disabled={pending !== null}
				onClick={() => void toggle('cheer')}
			>
				<span aria-hidden="true">👍</span> {cheerLabel}
			</button>{' '}
			·{' '}
			<button
				type="button"
				className={`room-interact${mine.Favorited ? ' on' : ''}`}
				aria-pressed={mine.Favorited}
				title={mine.Favorited ? 'Remove from favourites' : 'Favourite this room'}
				disabled={pending !== null}
				onClick={() => void toggle('favorite')}
			>
				<span aria-hidden="true">{mine.Favorited ? '★' : '☆'}</span> {favoriteLabel}
			</button>
			{error && <span className="error"> {error}</span>}
		</>
	)
}

/**
 * How many photos a feed asks for at once: a full three-by-three grid to open on, then
 * eight rows at a time as the reader scrolls — the first page decides how fast the page
 * appears, the rest how often the feed goes back to the api.
 */
const PHOTO_FIRST_PAGE = 9
const PHOTO_PAGE = 24

/** The `skip`/`take` of a feed's n-th page (from 1), given the smaller first page. */
function photoPage(page: number): { skip: number; take: number } {
	return page === 1
		? { skip: 0, take: PHOTO_FIRST_PAGE }
		: { skip: PHOTO_FIRST_PAGE + (page - 2) * PHOTO_PAGE, take: PHOTO_PAGE }
}

/**
 * A photo feed — a room's, or a player's — newest first, loaded a page at a time as the
 * reader scrolls: a busy room or a keen photographer has thousands, and the feeds used to
 * fetch them all (well, the api's first hundred) up front and lay every thumbnail out at
 * once. A sentinel under the grid asks for the next page when it comes within a screen of
 * view, until a page comes back short.
 *
 * `loadPage` is the api call for one page (`skip`, `take`); `feedKey` names what's being
 * listed, and a change to it starts the feed over. The function itself may be a fresh
 * closure every render — it's read when a page is fetched, not depended on.
 */
function PhotoFeed({
	feedKey,
	loadPage,
	empty,
	cheerable = false,
	navigate,
}: {
	feedKey: string
	loadPage: (skip: number, take: number) => Promise<PublicPhoto[]>
	/** The line shown when the first page is empty. */
	empty: string
	/** Passed to the grid: show cheer counts, and let a signed-in viewer cheer. */
	cheerable?: boolean
	/** Passed to the grid: caption each photo with a link to its room. */
	navigate?: Navigate
}) {
	const load = useRef(loadPage)
	load.current = loadPage
	// null = the first page hasn't landed. Later pages are appended.
	const [photos, setPhotos] = useState<PublicPhoto[] | null>(null)
	// How many pages the reader has scrolled for; each increment fetches one.
	const [pages, setPages] = useState(1)
	// Set by a short page: there's nothing after it, so stop watching the sentinel.
	const [exhausted, setExhausted] = useState(false)
	const [failed, setFailed] = useState(false)
	const sentinel = useRef<HTMLParagraphElement>(null)

	useEffect(() => {
		// A different room or player: start the feed over.
		setPhotos(null)
		setPages(1)
		setExhausted(false)
		setFailed(false)
	}, [feedKey])

	useEffect(() => {
		// A page that lands after the feed changed (or after this page was re-requested)
		// is dropped: appending it would mix two feeds' photos.
		let stale = false
		const { skip, take } = photoPage(pages)
		void load
			.current(skip, take)
			.then((page) => {
				if (stale) return
				setPhotos((current) => {
					// A photo taken between two page loads shifts the feed by one, so the
					// next page's first row repeats the last one's; keep one of each.
					const seen = new Set((current ?? []).map((p) => p.SavedImageId))
					return [...(current ?? []), ...page.filter((p) => !seen.has(p.SavedImageId))]
				})
				if (page.length < take) setExhausted(true)
			})
			.catch(() => {
				if (!stale) setFailed(true)
			})
		return () => {
			stale = true
		}
	}, [feedKey, pages])

	useEffect(() => {
		// Watch the sentinel only between pages: while one is in flight `photos` is
		// unchanged, so this doesn't re-run and can't ask for the same page twice. Once it
		// lands the observer is remade, and a sentinel still in view asks for the next.
		const el = sentinel.current
		if (el === null || photos === null || exhausted || failed) return
		const observer = new IntersectionObserver(
			(entries) => {
				if (entries.some((e) => e.isIntersecting)) setPages((n) => n + 1)
			},
			// Start the fetch a screen early, so the reader rarely meets the sentinel itself.
			{ rootMargin: '100% 0px' }
		)
		observer.observe(el)
		return () => observer.disconnect()
	}, [photos, exhausted, failed])

	if (photos === null) {
		return failed ? (
			<p className="error">The photos couldn&apos;t be loaded.</p>
		) : (
			<p className="muted">Loading…</p>
		)
	}
	if (photos.length === 0) {
		return <p className="muted">{empty}</p>
	}
	return (
		<>
			<PhotoGrid photos={photos} cheerable={cheerable} navigate={navigate} />
			{failed ? (
				<p className="error">The rest of the photos couldn&apos;t be loaded.</p>
			) : (
				!exhausted && (
					<p className="muted" ref={sentinel}>
						Loading more…
					</p>
				)
			)}
		</>
	)
}

/**
 * The staff cards at the foot of a room page — the public view of someone else's room, or
 * the edit page of a staff member's own. Staff only, and cosmetic: hidden for everyone
 * else, but `rooms` checks the token's role itself on the DELETE, the accessibility PUT and
 * the listing PUT.
 */
function StaffRoomTools({
	room,
	clearInstances = true,
	onTakenDown,
	onRoomChange,
}: {
	room: OwnedRoom
	/** False where the page already shows the owner's own Instances card (the edit page). */
	clearInstances?: boolean
	onTakenDown: () => void
	onRoomChange: (room: OwnedRoom) => void
}) {
	return (
		<>
			{isDeveloper() && <StaffRoomTokens room={room} />}
			<StaffListing room={room} onRoomChange={onRoomChange} />
			<StaffUnpublish room={room} onRoomChange={onRoomChange} />
			{clearInstances && <ClearInstances room={room} />}
			{/* Developer-only; `rooms` refuses a moderator's delete. */}
			{isDeveloper() && <StaffTakedown room={room} onTakenDown={onTakenDown} />}
		</>
	)
}

/**
 * The staff takedown, at the foot of a public room's page: the room is already on screen,
 * so there's nothing to look up and nothing to confirm but the deletion itself. Two
 * steps — a plain card, then the same accent-bordered confirm the ban form uses — since
 * this is the one thing on the site that can't be undone.
 */
/**
 * Pay everyone standing in the room, across every instance of it, from the room's own page.
 * The audience is read when the button is pressed, so it is whoever is in there at that
 * moment — there is nothing to pick and nobody to look up.
 */
function StaffRoomTokens({ room }: { room: OwnedRoom }) {
	const [tokens, setTokens] = useState('')
	const [message, setMessage] = useState('')
	const { pending, error, done, run } = useAction()

	return (
		<section className="card">
			<h2>Staff</h2>
			<form
				onSubmit={(e) => {
					e.preventDefault()
					void run(async () => {
						const amount = Number(tokens)
						const res = await call<{ paid: number[]; skipped: number[] }>(
							`/api/staff/rooms/${room.RoomId}/gift-tokens`,
							{ authed: true, json: { amount, message: message.trim() } }
						)
						setTokens('')
						setMessage('')
						const n = res.paid.length
						const missed =
							res.skipped.length > 0
								? ` ${res.skipped.length} couldn't spare it and were skipped.`
								: ''
						return `Sent ${amount.toLocaleString()} tokens to ${n} player${n === 1 ? '' : 's'} in ^${room.Name}.${missed}`
					})
				}}
			>
				<label>
					Gift tokens to everyone here
					<span className="staff-gift">
						<input
							type="number"
							step={1}
							value={tokens}
							required
							onChange={(e) => setTokens(e.target.value)}
						/>
						<button type="submit" disabled={pending}>
							{pending ? 'Sending…' : 'Send'}
						</button>
					</span>
					<span className="hint">
						Everyone in the room right now, across all of its instances. A negative amount takes
						tokens back, skipping anyone who can&apos;t spare it. Up to{' '}
						{MAX_TOKEN_DROP.toLocaleString()} each, either way.
					</span>
				</label>
				<label>
					Gift box message
					<input
						type="text"
						value={message}
						maxLength={256}
						placeholder="A gift from the staff!"
						onChange={(e) => setMessage(e.target.value)}
					/>
					<span className="hint">Optional. Blank sends the default.</span>
				</label>
				{error && <p className="error">{error}</p>}
				{done && <p className="ok">{done}</p>}
			</form>
		</section>
	)
}

/**
 * The staff listing toggle: one checkbox that sets `ExcludeFromLists` and `ExcludeFromSearch`
 * together, so a room moderation pulls is gone from the feeds AND unfindable by name, not one
 * without the other. The lighter hand next to the takedown — the room, its saves and its
 * link all survive, it just stops being advertised. Writes on change; the room on screen is
 * swapped for the one the worker answers with, so the box reflects what was stored.
 */
function StaffListing({
	room,
	onRoomChange,
}: {
	room: OwnedRoom
	onRoomChange: (room: OwnedRoom) => void
}) {
	const { pending, error, done, run } = useAction()
	const hidden = room.ExcludeFromLists === true && room.ExcludeFromSearch === true

	return (
		<section className="card">
			<h2>Listing</h2>
			<label className="check">
				<input
					type="checkbox"
					checked={hidden}
					disabled={pending}
					onChange={(e) => {
						const excluded = e.target.checked
						void run(async () => {
							const updated = await setRoomExcluded(room.RoomId, excluded)
							// Only the flags are taken: the envelope's room is the stored record,
							// without the live counters the public lookup folds in.
							onRoomChange({
								...room,
								ExcludeFromLists: updated.ExcludeFromLists === true,
								ExcludeFromSearch: updated.ExcludeFromSearch === true,
							})
							return excluded
								? `^${room.Name} is hidden from the listings and search.`
								: `^${room.Name} is listed again.`
						})
					}}
				/>
				Hide from listings and search
			</label>
			<p className="hint">
				Keeps the room out of every browse feed, search and autocomplete. It stays reachable by link
				and by invite, and its creator keeps everything. Sets both the lists and search exclusions
				at once.
			</p>
			{error && <p className="error">{error}</p>}
			{done && <p className="ok">{done}</p>}
		</section>
	)
}

/**
 * Unpublish a room: set it Private, so it drops out of every public surface and only its
 * owner and roles can get in. Heavier than the listing toggle (the link stops working for
 * players too) but nothing is deleted — the owner can publish it again from the game. Two
 * steps, since it takes the room away from everyone who plays it.
 */
function StaffUnpublish({
	room,
	onRoomChange,
}: {
	room: OwnedRoom
	onRoomChange: (room: OwnedRoom) => void
}) {
	const [confirming, setConfirming] = useState(false)
	const { pending, error, done, run } = useAction()
	const isPrivate = room.Accessibility === Accessibility.Private

	return (
		<section className="card">
			<h2>Publishing</h2>
			<p className="hint">
				{isPrivate
					? 'This room is private: only its creator and the people they gave a role can see or join it.'
					: 'Unpublishing makes the room private. Only its creator and the people they gave a role can see or join it. Nothing is deleted, and the creator can publish it again in game.'}
			</p>
			{!isPrivate && (
				<div className="mod-filter-actions">
					{confirming ? (
						<>
							<button
								type="submit"
								disabled={pending}
								onClick={() =>
									void run(async () => {
										const updated = await setRoomAccessibility(room.RoomId, Accessibility.Private)
										setConfirming(false)
										// Only the flag is taken: the envelope's room is the stored record,
										// without the live counters the public lookup folds in.
										onRoomChange({ ...room, Accessibility: updated.Accessibility })
										return `^${room.Name} is unpublished.`
									})
								}
							>
								{pending ? 'Unpublishing…' : 'Yes, unpublish'}
							</button>
							<button
								type="button"
								className="linkish"
								onClick={() => setConfirming(false)}
								disabled={pending}
							>
								Cancel
							</button>
						</>
					) : (
						<button type="submit" onClick={() => setConfirming(true)}>
							Unpublish room
						</button>
					)}
				</div>
			)}
			{error && <p className="error">{error}</p>}
			{done && <p className="ok">{done}</p>}
		</section>
	)
}

/**
 * Clear a room's live instances — the one room control shared by staff and the room's own
 * managers (`match` `POST /room/:roomId/instances/clear` checks which the caller is), so an
 * owner can unstick their room from the edit page without asking a moderator. Everyone
 * inside is re-matchmade into a fresh instance. Two steps, like the dorm clear.
 */
function ClearInstances({ room }: { room: OwnedRoom }) {
	const [confirming, setConfirming] = useState(false)
	const { pending, error, done, run } = useAction()

	return (
		<section className="card">
			<h2>Instances</h2>
			<p className="hint">
				Deletes every instance of this room and matchmakes everyone who was inside into a fresh one
				— the fix for a room whose sessions are stuck.
			</p>
			<div className="mod-filter-actions">
				{confirming ? (
					<>
						<button
							type="submit"
							disabled={pending}
							onClick={() =>
								void run(async () => {
									const res = await call<{
										deleted: number[]
										players: Array<{ playerId: number; roomInstanceId?: number }>
									}>(`${where().match}/room/${room.RoomId}/instances/clear`, {
										authed: true,
										method: 'POST',
									})
									setConfirming(false)
									const n = res.deleted.length
									const moved = res.players.filter((p) => p.roomInstanceId !== undefined).length
									const refused = res.players.length - moved
									const cleared =
										n === 0
											? `^${room.Name} had no instances.`
											: `Cleared ${n} instance${n === 1 ? '' : 's'} of ^${room.Name}.`
									const plural = (k: number) => `${k} player${k === 1 ? '' : 's'}`
									return [
										cleared,
										moved > 0 && `Moved ${plural(moved)} into a fresh instance.`,
										refused > 0 && `${plural(refused)} couldn't be re-matchmade.`,
									]
										.filter(Boolean)
										.join(' ')
								})
							}
						>
							{pending ? 'Clearing…' : 'Confirm clear instances'}
						</button>
						<button
							type="button"
							className="linkish"
							disabled={pending}
							onClick={() => setConfirming(false)}
						>
							Cancel
						</button>
					</>
				) : (
					<button type="submit" onClick={() => setConfirming(true)}>
						Clear instances
					</button>
				)}
			</div>
			{error && <p className="error">{error}</p>}
			{done && <p className="ok">{done}</p>}
		</section>
	)
}

function StaffTakedown({ room, onTakenDown }: { room: OwnedRoom; onTakenDown: () => void }) {
	const [confirming, setConfirming] = useState(false)
	const { pending, error, run } = useAction()

	if (!confirming) {
		return (
			<section className="card">
				<h2>Delete room</h2>
				<p className="muted">
					Deleting a room removes it for everyone: the room, its subrooms and their saves, and its
					picture. Photos players took in it stay on their profiles.
				</p>
				<button type="submit" onClick={() => setConfirming(true)}>
					Delete room
				</button>
			</section>
		)
	}

	return (
		<section className="card mod-dialog">
			<h2>Delete ^{room.Name}?</h2>
			<form
				className="takedown-confirm"
				onSubmit={(e) => {
					e.preventDefault()
					void run(async () => {
						await deleteRoom(room.RoomId)
						onTakenDown()
						return ''
					})
				}}
			>
				<p className="muted">
					This deletes the room for everyone, including its creator, and can&apos;t be undone.
				</p>
				{error && <p className="error">{error}</p>}
				<div className="mod-filter-actions">
					<button type="submit" disabled={pending}>
						{pending ? 'Deleting…' : 'Delete room'}
					</button>
					<button
						type="button"
						className="linkish"
						onClick={() => setConfirming(false)}
						disabled={pending}
					>
						Cancel
					</button>
				</div>
			</form>
		</section>
	)
}

/** The platforms a room says it supports, named the way the game names them. */
function platformList(room: OwnedRoom): string[] {
	const on: string[] = []
	if (room.SupportsScreens) on.push('Screens')
	if (room.SupportsWalkVR) on.push('VR (walk)')
	if (room.SupportsTeleportVR) on.push('VR (teleport)')
	if (room.SupportsQuest2) on.push('Quest 2')
	if (room.SupportsMobile) on.push('Mobile')
	if (room.SupportsJuniors) on.push('Juniors')
	return on
}

/**
 * A room's settings and its subrooms. Its own fields are read-only — rooms are edited in
 * game — with two exceptions, both things the game gives an owner no way to do: a
 * subroom's scene data can be replaced from here (the game can only save what it just
 * built, never restore a file they kept), and so can the room's image (the game can only
 * set it to a photo taken inside the room).
 */
function RoomDetail({
	room,
	imgHost,
	cdnHost,
	onRoomChange,
}: {
	room: OwnedRoom
	imgHost: string
	cdnHost: string
	onRoomChange: (room: OwnedRoom) => void
}) {
	const created = new Date(room.CreatedAt)
	const platforms = platformList(room)
	const subRooms = room.SubRooms ?? []

	return (
		<>
			<section className="card room-hero">
				{/* 512 rather than the list's 256: this one is displayed large. Both are sizes
				    the img worker allows, so each is a cached variant. */}
				<RoomImageUpload
					roomId={room.RoomId}
					src={`${imgHost}/${room.ImageName}?width=512`}
					onImageChange={(imageName) => onRoomChange({ ...room, ImageName: imageName })}
				/>
				<div className="room-hero-body">
					<div className="room-head">
						<h1 className="room-hero-name">^{room.Name}</h1>
						<VisibilityBadge accessibility={room.Accessibility} />
					</div>
					{room.Description ? (
						<p className="muted room-hero-desc">{room.Description}</p>
					) : (
						<p className="muted room-hero-desc">No description set.</p>
					)}
					<p className="room-stats">
						{room.Stats.VisitCount.toLocaleString()} visit
						{room.Stats.VisitCount === 1 ? '' : 's'} · {room.Stats.FavoriteCount.toLocaleString()}{' '}
						favourite
						{room.Stats.FavoriteCount === 1 ? '' : 's'} · {room.Stats.CheerCount.toLocaleString()}{' '}
						cheer{room.Stats.CheerCount === 1 ? '' : 's'}
					</p>
				</div>
			</section>

			<section className="card">
				<h2>Settings</h2>
				<dl className="facts">
					<dt>Room id</dt>
					<dd>{room.RoomId}</dd>
					<dt>Visibility</dt>
					<dd>{accessibilityLabel(room.Accessibility)}</dd>
					<dt>Max players</dt>
					<dd>{room.MaxPlayers}</dd>
					<dt>Cloning</dt>
					<dd>
						{room.CloningAllowed ? 'Anyone may clone this room' : 'Nobody may clone this room'}
					</dd>
					<dt>Plays on</dt>
					<dd>
						{platforms.length > 0 ? platforms.join(', ') : 'Nothing — no platform is enabled'}
					</dd>
					<dt>Tags</dt>
					<dd>{room.Tags?.length ? room.Tags.map((t) => t.Tag).join(', ') : 'None'}</dd>
					<dt>Created</dt>
					<dd>{Number.isNaN(created.getTime()) ? room.CreatedAt : created.toLocaleDateString()}</dd>
				</dl>
			</section>

			<section className="card">
				<h2>Subrooms</h2>
				<p className="muted">
					The places inside the room players actually load into. Each keeps its own accessibility
					and its own saves, so a public room can still hold a subroom nobody else can reach.
				</p>
				{subRooms.length === 0 ? (
					<p className="muted">This room has no subrooms.</p>
				) : (
					<ul className="subrooms">
						{subRooms.map((sub) => (
							<SubRoomRow
								key={sub.SubRoomId}
								sub={sub}
								roomId={room.RoomId}
								cdnHost={cdnHost}
								onRoomChange={onRoomChange}
							/>
						))}
					</ul>
				)}
			</section>
		</>
	)
}

/** One subroom: what it is, and — the part an owner can't see anywhere else — its save. */
function SubRoomRow({
	sub,
	roomId,
	cdnHost,
	onRoomChange,
}: {
	sub: SubRoom
	roomId: number
	cdnHost: string
	onRoomChange: (room: OwnedRoom) => void
}) {
	const save = sub.CurrentSave ?? null
	const saved = save ? new Date(save.CreatedAt) : null
	// Cleared when that save is published (see publishSubRoomSave), so a value here always
	// means work the owner saved but players still can't see.
	const staged = sub.StagedSubRoomDataSaveId !== null && sub.StagedSubRoomDataSaveId !== undefined
	const name = sub.Name || `Subroom ${sub.SubRoomId}`

	return (
		<li className="subroom">
			<div className="room-head">
				<span className="subroom-name">{name}</span>
				<VisibilityBadge accessibility={sub.Accessibility} />
				{sub.IsSandbox && <span className="badge">Sandbox</span>}
			</div>
			<p className="subroom-meta">
				#{sub.SubRoomId} · up to {sub.MaxPlayers} players
			</p>
			<p className="subroom-save">
				{save === null ? (
					// A subroom with no published save loads an empty scene without erroring, which
					// from the inside looks exactly like a broken room. Say so plainly.
					<span className="warn">Never published — players load an empty scene.</span>
				) : (
					<>
						Published save #{save.SubRoomDataSaveId}
						{saved && !Number.isNaN(saved.getTime()) && `, saved ${saved.toLocaleString()}`}
						{save.Description && ` — “${save.Description}”`}
					</>
				)}
				{staged && (
					<span className="warn"> · a newer save is staged, waiting to be published.</span>
				)}
			</p>
			{/* The published save's blob first: that's the copy of the room worth keeping,
			    and the one the client resolves ahead of the subroom's own key. */}
			{save?.DataBlob && (
				<BlobDownload
					label="Save DataBlob"
					blobKey={save.DataBlob}
					cdnHost={cdnHost}
				/>
			)}
			{sub.DataBlob && (
				<BlobDownload
					label="Subroom DataBlob"
					blobKey={sub.DataBlob}
					cdnHost={cdnHost}
				/>
			)}
			<BlobUpload roomId={roomId} sub={sub} onRoomChange={onRoomChange} />
		</li>
	)
}

/**
 * Replace one subroom's scene data with a file from disk.
 *
 * The two steps are the game's own: the bytes go to `storage` under the RoomSave type,
 * and the key it hands back is posted to the subroom's `…/data` route as
 * `SubRoomData.Filename`. So this is a room save like any other — it lands in the
 * subroom's history beside the ones the game wrote, and both endpoints are already gated
 * on the room's creator (or a co-owner, or staff — audited), which is why there is no
 * ownership check here: the edit page is only drawn for rooms from `ownedby/me`, and for staff.
 *
 * Publishing is offered rather than assumed. A save normally only STAGES — players keep
 * loading the last published version until the owner publishes — and quietly making an
 * uploaded file live would be a bigger step than the game's own save takes. Left on by
 * default all the same: someone uploading a blob here is restoring a room, and a restore
 * nobody can see isn't one.
 *
 * A save can also name a `UnityAssetId` — the Studio build drawn with the scene. Given
 * one, the new save carries it; left blank, it keeps the one on the save it builds on, so
 * replacing a Studio room's scene data doesn't quietly detach its build.
 */
function BlobUpload({
	roomId,
	sub,
	onRoomChange,
}: {
	roomId: number
	sub: SubRoom
	onRoomChange: (room: OwnedRoom) => void
}) {
	const [file, setFile] = useState<File | null>(null)
	const [description, setDescription] = useState('')
	const [unityAssetId, setUnityAssetId] = useState('')
	const [publish, setPublish] = useState(true)
	// Whether to convert the file for this build before storing it. Picking a file sets it
	// from the extension — on for a `.binpb`, off for a `.room` — and the owner can overrule
	// that either way: a `.binpb` that already loads shouldn't lose its circuits for nothing.
	const [downgrade, setDowngrade] = useState(false)
	const [fileError, setFileError] = useState('')
	// The file input is uncontrolled — React can't set its value — so clearing the picked
	// file after a save takes a handle on the element itself.
	const input = useRef<HTMLInputElement>(null)
	const { pending, error, done, run } = useAction()

	return (
		<form
			className="blob-upload"
			onSubmit={(e) => {
				e.preventDefault()
				if (!file) return
				void run(async () => {
					// Settled before anything is uploaded: a mistyped id is still a string the
					// worker would store, and the save would point at a build that doesn't exist.
					const typedAssetId = unityAssetId.trim()
					if (typedAssetId !== '' && !UNITY_ASSET_ID.test(typedAssetId)) {
						throw new Error(
							'A Unity asset ID looks like 22555d14-2918-43f3-94d4-da0c893d96c4. Fix it, or leave it blank.'
						)
					}
					const assetId = typedAssetId || (await previousUnityAssetId(roomId, sub))
					const blob = await prepareRoomBlob(file, downgrade)
					const [filename, hash] = await Promise.all([uploadRoomBlob(blob), blobHash(blob)])
					onRoomChange(
						await saveSubRoomBlob(roomId, sub.SubRoomId, {
							filename,
							hash,
							description: description.trim(),
							autoPublish: publish,
							unityAssetId: assetId,
						})
					)
					setFile(null)
					setDowngrade(false)
					setDescription('')
					setUnityAssetId('')
					if (input.current) input.current.value = ''
					const uploaded = downgrade ? 'Converted for this build, uploaded' : 'Uploaded'
					return publish
						? `${uploaded} and published — players load this scene now.`
						: `${uploaded} and staged. Publish it in game to make it live.`
				})
			}}
		>
			{/* Said out loud, on the control itself: this is the newest thing on the site and
			    the only one that overwrites what players load. Someone about to hand us a file
			    they can't get back should read that before the file picker, not after. */}
			<p className="blob-upload-head">
				<span className="blob-upload-title">Replace scene data</span>
				<span className="badge beta">Beta</span>
			</p>
			<p className="muted blob-upload-caveat">
				New and lightly tested. Nothing here checks the file — the server stores whatever it is and
				the game finds out on load. This server runs the {CLIENT_BUILD_DATE} build, so scene data
				from a room built on anything newer may not load at all. Converting a file for this build
				before it is stored gets around that, but removes its circuits. Download the save above and
				keep it before replacing it.
			</p>
			<label className="blob-upload-file">
				Scene data file
				<input
					ref={input}
					type="file"
					accept={ROOM_BLOB_EXTENSIONS.join(',')}
					onChange={(e) => {
						// `accept` only filters the picker — a file dropped on the input, or picked
						// under "All files", still arrives here, so the extension is checked again.
						const picked = e.target.files?.[0] ?? null
						if (picked && !isRoomBlobFile(picked.name)) {
							setFileError('Pick a .room or .binpb file.')
							setFile(null)
							setDowngrade(false)
							e.target.value = ''
							return
						}
						setFileError('')
						setFile(picked)
						setDowngrade(picked !== null && needsDowngrade(picked.name))
					}}
					required
				/>
			</label>
			{fileError && <p className="error">{fileError}</p>}
			<label className="blob-upload-note">
				Save comment<span className="optional">optional</span>
				<input
					type="text"
					value={description}
					placeholder="Uploaded from the website"
					maxLength={200}
					onChange={(e) => setDescription(e.target.value)}
				/>
			</label>
			<label className="blob-upload-note">
				Unity asset ID<span className="optional">optional</span>
				<input
					type="text"
					value={unityAssetId}
					placeholder="Same as the previous save"
					spellCheck={false}
					autoComplete="off"
					onChange={(e) => setUnityAssetId(e.target.value)}
				/>
			</label>
			<label className="check">
				<input type="checkbox" checked={publish} onChange={(e) => setPublish(e.target.checked)} />
				Publish it straight away
			</label>
			<label className="check">
				<input
					type="checkbox"
					checked={downgrade}
					disabled={file === null}
					onChange={(e) => setDowngrade(e.target.checked)}
				/>
				Downgrade room for compatibility
			</label>
			{error && <p className="error">{error}</p>}
			{done && <p className="ok">{done}</p>}
			<button type="submit" disabled={pending || file === null}>
				{pending ? 'Uploading…' : 'Upload scene data'}
			</button>
		</form>
	)
}

/**
 * Picture types the room thumbnail accepts. The `img` worker decodes whatever it serves
 * with Photon to resize it, and these two are the ones the game itself produces (a photo
 * is a JPEG; a PNG keeps its alpha through the resize). Checked on the type the browser
 * reports rather than the extension, and the server's own check still stands behind it.
 */
const IMAGE_TYPES = new Set(['image/jpeg', 'image/png'])

/**
 * A picture that is also the control that replaces it: clicking it opens the file
 * picker, and the picked file is handed to `onFile`. The room thumbnail and the profile
 * avatar are both this, with different pictures and different workers behind them.
 *
 * Just the picture and its input — the upload itself, and where its result is shown,
 * belong to the caller: the frame is exactly the picture's size (a circle for the
 * avatar), so a message can't live inside it without stretching it.
 */
function ImageUpload({
	src,
	className,
	imgClassName,
	hint,
	pending,
	onFile,
}: {
	src: string
	/** Goes on the label, which is the clickable frame — the shape (card, circle) is its. */
	className?: string
	imgClassName: string
	/** What the overlay says at rest; while uploading it says so instead. */
	hint: string
	pending: boolean
	onFile: (file: File) => void
}) {
	return (
		// A label, so the whole picture is the file input's click target. The input is
		// hidden visually rather than with `display: none`, which keeps it in the tab
		// order — the focus ring is drawn on the label around it.
		<label className={`image-upload ${className ?? ''}`} aria-busy={pending}>
			<img className={imgClassName} src={src} alt="" />
			<span className="image-upload-hint">{pending ? 'Uploading…' : hint}</span>
			<input
				type="file"
				accept="image/jpeg,image/png"
				disabled={pending}
				onChange={(e) => {
					const input = e.target
					const file = input.files?.[0]
					// Cleared straight away, so picking the same file again still fires a
					// change; the File object stays readable after the input lets go of it.
					input.value = ''
					if (file) onFile(file)
				}}
			/>
		</label>
	)
}

/** Refuse anything but the two image types the server resizes (see IMAGE_TYPES). */
function requireImage(file: File): void {
	if (!IMAGE_TYPES.has(file.type)) throw new Error('Choose a JPEG or PNG image.')
}

/**
 * The room's thumbnail, as an {@link ImageUpload}, with the upload's result under it.
 *
 * Same two steps as the scene-data upload, with a different `FileType`: the bytes go to
 * `storage` under the Image type, and the key it hands back is put to the room's
 * `…/image` route as `imageName`. In game the only way to set this is to take a photo in
 * the room, so this is how an owner gets a picture they made elsewhere onto the room.
 *
 * There is no submit step because there is no publish step: the image is live the moment
 * the route answers, for everyone browsing rooms. The picture redraws from the new
 * `ImageName` straight away — `img` caches by key and the key is new, so nothing stale
 * can be served.
 */
function RoomImageUpload({
	roomId,
	src,
	onImageChange,
}: {
	roomId: number
	src: string
	onImageChange: (imageName: string) => void
}) {
	const { pending, error, done, run } = useAction()

	return (
		<div className="image-upload-media">
			<ImageUpload
				src={src}
				imgClassName="room-hero-img"
				hint="Click to upload image"
				pending={pending}
				onFile={(file) =>
					void run(async () => {
						requireImage(file)
						const imageName = await uploadToStorage(file, FILE_TYPE_IMAGE)
						await setRoomImage(roomId, imageName)
						onImageChange(imageName)
						return 'Image replaced — it shows in game now.'
					})
				}
			/>
			{error && <p className="error">{error}</p>}
			{done && <p className="ok">{done}</p>}
		</div>
	)
}

/**
 * The player's avatar, as an {@link ImageUpload}: the same two calls the game makes when
 * a player changes their profile picture, uploaded as a saved image of the profile type
 * and then set on the account. The game's own picker only offers photos taken in game;
 * this one takes any JPEG or PNG.
 *
 * A fragment, laid out by the identity card it sits in: the avatar takes its place beside
 * the name, and a failure wraps onto a row of its own below both (`identity-status`)
 * rather than under the avatar, where it would widen the circle to the text's width.
 * Success says nothing: the new picture appearing is the confirmation.
 */
function ProfileImageUpload({
	account,
	onChange,
}: {
	account: SelfAccount
	onChange: (a: SelfAccount) => void
}) {
	const { pending, error, run } = useAction()

	return (
		<>
			<ImageUpload
				src={`${where().img}/${account.profileImage}?width=256`}
				className="identity-avatar-upload"
				imgClassName="identity-avatar"
				hint="Change"
				pending={pending}
				onFile={(file) =>
					void run(async () => {
						requireImage(file)
						const imageName = await uploadProfileImage(file)
						await setProfileImage(imageName)
						onChange({ ...account, profileImage: imageName })
						return ''
					})
				}
			/>
			{error && <p className="error identity-status">{error}</p>}
		</>
	)
}

/**
 * One scene-data blob: the key, and a plain link to it on `cdn`.
 *
 * Just a link. It isn't fetched to pick a filename: `cdn` is always another origin, so the
 * browser ignores `download`, and fetching the bytes needs CORS from whatever host serves
 * them. When that host is the bucket's own custom domain, no worker sets that header. The
 * file saves under its key's last segment, and `storage` gives each key an extension
 * (`.room`, `.meta`), so the download still says what it is. The blobs are binary and served
 * as such, so the browser downloads them instead of opening them.
 */
function BlobDownload({
	label,
	blobKey,
	cdnHost,
}: {
	label: string
	blobKey: string
	cdnHost: string
}) {
	// Room build data is served under `room/`, the same prefix the storage worker
	// uploads it to and the one the game downloads it from.
	return (
		<div className="blob">
			<span className="blob-label">{label}</span>
			<a className="blob-key" href={`${cdnHost}/room/${blobKey}`} download>
				{blobKey}
			</a>
		</div>
	)
}

/** How a room or subroom's `Accessibility` reads on screen. */
const accessibilityLabel = (accessibility: number): string =>
	// Unknown ordinals shouldn't happen, but this label is the only thing telling an owner
	// whether a room is visible — so show the raw value rather than nothing at all.
	ACCESSIBILITY_LABEL[accessibility] ?? `Accessibility ${accessibility}`

/**
 * The visibility pill. Public gets the same green "healthy" reading as the server
 * status; every other value stays neutral, since Private is a choice, not a fault.
 */
function VisibilityBadge({ accessibility }: { accessibility: number }) {
	return (
		<span className={`badge ${accessibility === Accessibility.Public ? 'live' : ''}`}>
			{accessibilityLabel(accessibility)}
		</span>
	)
}
/**
 * Turnstile's browser API, as much of it as the signup widget uses. Loaded from
 * Cloudflare at runtime (see loadTurnstile) rather than bundled, so it isn't in
 * node_modules and has no types of its own.
 */
interface TurnstileApi {
	render: (
		el: HTMLElement,
		opts: {
			sitekey: string
			action?: string
			callback?: (token: string) => void
			'expired-callback'?: () => void
		}
	) => string | undefined
	reset: (widgetId?: string) => void
	remove: (widgetId?: string) => void
}

declare global {
	interface Window {
		turnstile?: TurnstileApi
	}
}

/**
 * Load Turnstile's script, once per page, resolving when `window.turnstile` is ready.
 * `render=explicit` stops it scanning the document for widgets: this is a SPA, so the
 * container mounts and unmounts with the form and we render into it ourselves.
 *
 * The promise is cached at module scope, so switching tabs back and forth reuses the
 * loaded script instead of appending another tag. A rejection is cached too — the retry
 * is a page reload, which is what the error message asks for.
 */
let turnstileScript: Promise<void> | null = null
function loadTurnstile(): Promise<void> {
	turnstileScript ??= new Promise<void>((resolve, reject) => {
		const el = document.createElement('script')
		el.src = 'https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit'
		el.async = true
		el.defer = true
		el.onload = () => resolve()
		el.onerror = () => reject(new Error('load failed'))
		document.head.appendChild(el)
	})
	return turnstileScript
}

/**
 * Mount a Turnstile widget and hand back the token it produces. No token means no
 * submit: the BFF refuses a signup without one, so the form gates its button on it
 * rather than letting the request fail.
 *
 * `reset` re-arms the widget for another attempt — a token is single-use, so a rejected
 * signup can't be retried with the same one.
 */
function useTurnstile(siteKey: string) {
	const container = useRef<HTMLDivElement | null>(null)
	const widgetId = useRef<string | undefined>(undefined)
	const [token, setToken] = useState('')
	const [error, setError] = useState('')

	useEffect(() => {
		let live = true
		loadTurnstile()
			.then(() => {
				// StrictMode mounts twice, and the cleanup below removes the first widget; bail
				// if this effect is the stale one so we don't render into a detached container.
				if (!live || !container.current || !window.turnstile) return
				widgetId.current = window.turnstile.render(container.current, {
					sitekey: siteKey,
					// Marker Cloudflare uses to segment Turnstile integrations; carries no user data.
					action: 'turnstile-spin-v1',
					callback: (t) => setToken(t),
					// Tokens expire after a few minutes; drop ours so the button locks again and
					// Turnstile can hand us a fresh one.
					'expired-callback': () => setToken(''),
				})
			})
			.catch(() => {
				if (live) setError("Couldn't load the bot check — reload the page to try again.")
			})

		return () => {
			live = false
			if (widgetId.current) window.turnstile?.remove(widgetId.current)
			widgetId.current = undefined
		}
	}, [siteKey])

	const reset = useCallback(() => {
		setToken('')
		if (widgetId.current) window.turnstile?.reset(widgetId.current)
	}, [])

	return { container, token, error, reset }
}

/**
 * Create an account from the website: a password, plus a Turnstile token proving a human
 * filled the form. The username comes back auto-assigned from `auth` (players don't pick
 * one), and the session is live on success — so this lands on the account page, where the
 * username is shown.
 */
function SignupForm({
	siteKey,
	onAuthed,
}: {
	siteKey: string
	onAuthed: (a: SelfAccount) => void
}) {
	const [password, setPassword] = useState('')
	const [email, setEmail] = useState('')
	const { container, token: widgetToken, error: widgetError, reset } = useTurnstile(siteKey)
	const { pending, error, run } = useAction()

	return (
		<form
			onSubmit={(e) => {
				e.preventDefault()
				void run(async () => {
					const wanted = email.trim()

					try {
						await signUp(password, widgetToken)
					} catch (err) {
						// The widget token is spent either way, so re-arm before they retry. Only
						// a failed signup gets here — past this point the account exists, and a
						// retry would spend another slot against auth's per-IP cap.
						reset()
						throw err
					}

					// Saved with the new session's own token: `create_account` takes no email,
					// `accounts` owns the field. Deliberately not fatal — the account exists and
					// the session is live, and the same field is one call away on the account
					// page. The address is STAGED, not set: `accounts` emails it a code, and the
					// account page (where this lands) picks the pending change up and asks for it.
					if (wanted !== '') await saveEmail(wanted).catch(() => {})

					// The session is already stored, so a failure here isn't one they can act on
					// by retrying: a reload finds them signed in.
					const me = await fetchMe().catch(() => {
						throw new Error(
							'Your account was created, but loading it failed. Reload the page — you are already signed in.'
						)
					})
					onAuthed(me)
					return ''
				})
			}}
		>
			<label>
				Password
				<input
					type="password"
					value={password}
					autoComplete="new-password"
					onChange={(e) => setPassword(e.target.value)}
					required
				/>
			</label>
			{/* Optional, and the button doesn't wait on it — but it's the only contact detail
			    an account has, so the hint says plainly what it's for rather than leaving it
			    to be guessed. `type="email"` gets the right keyboard on mobile and a free
			    format check; the worker re-checks it before the account is created. */}
			<label>
				Email <span className="optional">optional</span>
				<input
					type="email"
					value={email}
					autoComplete="email"
					onChange={(e) => setEmail(e.target.value)}
				/>
				<span className="hint">
					How you get back in if you forget your password — there&apos;s no other way to reach you.
					You can add it later on your account page.
				</span>
			</label>
			<div className="turnstile" ref={container} />
			{widgetError && <p className="error">{widgetError}</p>}
			{error && <p className="error">{error}</p>}
			<button type="submit" disabled={pending || widgetToken === ''}>
				{pending ? 'Creating…' : 'Create account'}
			</button>
		</form>
	)
}

function LoginForm({ onAuthed }: { onAuthed: (a: SelfAccount) => void }) {
	const [username, setUsername] = useState('')
	const [password, setPassword] = useState('')
	// Set once auth has accepted the password and asked for a second factor. The context is
	// minted with it, so every code posted for this sign-in is counted against the same one.
	const [challenge, setChallenge] = useState<{ kind: SignInChallenge; context: string } | null>(
		null
	)
	const [code, setCode] = useState('')
	const { pending, error, done, run } = useAction()

	const reset = () => {
		setChallenge(null)
		setCode('')
	}

	return (
		<form
			onSubmit={(e) => {
				e.preventDefault()
				void run(async () => {
					const second = challenge
						? { kind: challenge.kind, code: code.trim(), loginContext: challenge.context }
						: undefined
					const asked = await signIn(username, password, second)
					if (asked !== null) {
						setChallenge({ kind: asked, context: challenge?.context ?? crypto.randomUUID() })
						setCode('')
						return asked === 'email' ? 'A security code was emailed to you.' : ''
					}
					onAuthed(await fetchMe())
					return ''
				})
			}}
		>
			{challenge === null ? (
				<>
					<label>
						Username
						<input
							type="text"
							value={username}
							autoComplete="username"
							onChange={(e) => setUsername(e.target.value)}
							required
						/>
					</label>
					<label>
						Password
						<input
							type="password"
							value={password}
							autoComplete="current-password"
							onChange={(e) => setPassword(e.target.value)}
							required
						/>
					</label>
				</>
			) : (
				<>
					<p className="muted">
						{challenge.kind === 'totp'
							? 'Enter the six-digit code from your authenticator app.'
							: 'Enter the six-digit security code emailed to you. It works once, for 30 minutes.'}
					</p>
					<label>
						Code
						<input
							type="text"
							inputMode="numeric"
							pattern="[0-9 ]{6,7}"
							value={code}
							autoComplete="one-time-code"
							autoFocus
							onChange={(e) => setCode(e.target.value)}
							required
						/>
					</label>
				</>
			)}
			{error && <p className="error">{error}</p>}
			{done && <p className="ok">{done}</p>}
			<button type="submit" disabled={pending}>
				{pending ? 'Signing in…' : challenge ? 'Verify' : 'Sign in'}
			</button>
			{challenge && (
				<button type="button" className="link" onClick={reset} disabled={pending}>
					Use a different account
				</button>
			)}
		</form>
	)
}

function Dashboard({
	account,
	config,
	navigate,
	onChange,
}: {
	account: SelfAccount
	config: SiteConfig | undefined
	navigate: Navigate
	onChange: (a: SelfAccount) => void
}) {
	// The dashboard sections, shown one at a time via the left tab rail. A staff member's
	// server-wide controls are NOT here — they have their own page, /admin (AdminPage), so
	// that this stays the player's own settings whoever they are.
	const sections = [
		// First, so a player who just signed in lands on what they made rather than on a
		// settings form they opened the page to avoid.
		{ id: 'rooms', label: 'My rooms', render: () => <MyRooms navigate={navigate} /> },
		{
			id: 'banner',
			label: 'Profile banner',
			render: () => <BannerUpload account={account} onChange={onChange} />,
		},
		{
			id: 'username',
			label: 'Username',
			render: () => <UsernameForm account={account} onChange={onChange} />,
		},
		{
			id: 'displayname',
			label: 'Display name',
			render: () => <DisplayNameForm account={account} onChange={onChange} />,
		},
		{
			id: 'email',
			label: 'Email',
			render: () => <EmailForm account={account} onChange={onChange} />,
		},
		{ id: 'password', label: 'Password', render: () => <PasswordForm /> },
		{ id: 'two-factor', label: 'Two-factor sign-in', render: () => <TwoFactorForm /> },
		// Shown to everyone: the panel itself tells an account without Studio access how to
		// get it, and `studio` re-checks on upload.
		{
			id: 'avatar-upload',
			label: 'Upload avatar items',
			render: () => <AvatarUploadPanel account={account} navigate={navigate} />,
		},
		// Only when the operator has Discord configured — otherwise the panel has nothing to
		// offer and the tab is a promise the server can't keep. The claim also still lives at
		// /claim, because that URL is Discord's registered redirect and has to keep working.
		...(config?.benefitsEnabled
			? [
					{
						id: 'benefits',
						label: 'Claim benefits',
						render: () => <BenefitsPanel account={account} config={config} />,
					},
				]
			: []),
		// Last: the way out sits at the bottom of the rail, where nobody reaches it by
		// accident while looking for a setting.
		{
			id: 'delete',
			label: 'Delete account',
			render: () => <DeleteAccountForm account={account} onChange={onChange} />,
		},
	]
	const [active, setActive] = useState(sections[0].id)
	const current = sections.find((s) => s.id === active) ?? sections[0]

	return (
		<>
			<section className="card identity">
				{/* The same picture the public profile draws (see PlayerPage), and here the way
				    to change it. Dashboard only renders once `/account/me` has answered, and
				    that call went through `where()`, so the img host is known. */}
				<ProfileImageUpload account={account} onChange={onChange} />
				<div className="identity-body">
					<div className="muted">Signed in as</div>
					<div className="big">{account.displayName || account.username}</div>
					<div className="handle">
						@{account.username} · #{account.accountId} · {account.email ?? 'no email set'}
					</div>
				</div>
			</section>
			<div className="workspace">
				<nav className="vtabs">
					{sections.map((s) => (
						<button
							key={s.id}
							className={s.id === active ? 'active' : ''}
							onClick={() => setActive(s.id)}
						>
							{s.label}
						</button>
					))}
				</nav>
				<div className="panel">{current.render()}</div>
			</div>
		</>
	)
}

/**
 * The rooms the signed-in player owns.
 *
 * Read-only on purpose: rooms are made and edited in game, and there is nothing here a
 * player could change that the game doesn't already own. What the web is better at is
 * the overview — everything you've made in one place, including the rooms you never
 * published, which are invisible everywhere else.
 */
function MyRooms({ navigate }: { navigate: Navigate }) {
	const [rooms, setRooms] = useState<OwnedRoom[] | null>(null)
	const [error, setError] = useState('')

	useEffect(() => {
		void fetchMyRooms()
			.then(setRooms)
			.catch((e) => setError(e instanceof Error ? e.message : String(e)))
	}, [])

	return (
		<section className="card">
			<h2>My rooms</h2>
			<p className="muted">
				Every room you&apos;ve made, newest first — unpublished ones included. Your dorm isn&apos;t
				here: it was made for you rather than by you.
			</p>
			{error ? (
				<p className="error">{error}</p>
			) : rooms === null ? (
				<p className="muted">Loading…</p>
			) : rooms.length === 0 ? (
				<p className="muted">
					You haven&apos;t made a room yet. Rooms are created in game — clone one you like, or start
					from a blank one in the Rec Center.
				</p>
			) : (
				// `where()` THROWS when the config never landed, and a throw in render takes the
				// page down (see useSlideshow). It can't here: this branch is only reached once
				// the fetch above resolved, and that fetch went through `where()` itself.
				<ul className="rooms">
					{rooms.map((room) => (
						<RoomCard key={room.RoomId} room={room} imgHost={where().img} navigate={navigate} />
					))}
				</ul>
			)}
		</section>
	)
}

/**
 * The profile banner, as an {@link ImageUpload} in the profile banner's own shape: upload
 * the picture (`uploadBannerImage`), then set it on the account (`setBannerImage`). The
 * game only lets a player pick one of their camera photos; this takes any JPEG or PNG.
 * The held account is patched with the new key, so the preview redraws without a refetch.
 */
function BannerUpload({
	account,
	onChange,
}: {
	account: SelfAccount
	onChange: (a: SelfAccount) => void
}) {
	const { pending, error, done, run } = useAction()

	return (
		<section className="card">
			<h2>Profile banner</h2>
			<p className="muted">
				The wide picture across the top of your profile. Click it to upload a JPEG or PNG.
			</p>
			<ImageUpload
				// No banner yet: a transparent pixel, so the frame shows its gradient backdrop
				// (the profile's empty-banner look) rather than a stretched default avatar.
				src={
					account.bannerImage
						? `${where().img}/${account.bannerImage}?width=1024`
						: 'data:image/gif;base64,R0lGODlhAQABAAAAACH5BAEKAAEALAAAAAABAAEAAAICTAEAOw=='
				}
				className="banner-upload"
				imgClassName="banner-preview"
				hint={account.bannerImage ? 'Change banner' : 'Upload a banner'}
				pending={pending}
				onFile={(file) =>
					void run(async () => {
						requireImage(file)
						const imageName = await uploadBannerImage(file)
						await setBannerImage(imageName)
						onChange({ ...account, bannerImage: imageName })
						return 'Banner updated.'
					})
				}
			/>
			{error && <p className="error">{error}</p>}
			{done && <p className="ok">{done}</p>}
		</section>
	)
}

/**
 * One room in the list: its thumbnail, what it's called in game (`^Name`), and how it's
 * doing. The whole row links to the room's own page.
 *
 * The thumbnail is asked for at 256px wide — one of the img worker's four allowed sizes,
 * so it's a cached variant rather than the full-size upload. A room with no image of its
 * own still answers 200 there (the worker serves its fallback), so there's no broken
 * frame to handle.
 */
function RoomCard({
	room,
	imgHost,
	navigate,
}: {
	room: OwnedRoom
	imgHost: string
	navigate: Navigate
}) {
	const created = new Date(room.CreatedAt)

	return (
		<li className="room">
			{/* A real `<a href>` (see Link), not a click handler on the row: it has to be
			    reachable by keyboard, and openable in a new tab like any other link. */}
			<Link to={`/rooms/${room.RoomId}`} navigate={navigate} className="room-link">
				<img
					className="room-thumb"
					src={`${imgHost}/${room.ImageName}?width=256`}
					alt=""
					loading="lazy"
				/>
				<div className="room-body">
					<div className="room-head">
						{/* The caret is how the game writes a room name, so it reads as the thing you
						    type to get there rather than as a title someone wrote. */}
						<span className="room-name">^{room.Name}</span>
						<VisibilityBadge accessibility={room.Accessibility} />
					</div>
					{room.Description && <p className="room-desc">{room.Description}</p>}
					<p className="room-stats">
						{room.Stats.VisitCount.toLocaleString()} visit
						{room.Stats.VisitCount === 1 ? '' : 's'} · {room.Stats.FavoriteCount.toLocaleString()}{' '}
						favourite
						{room.Stats.FavoriteCount === 1 ? '' : 's'} · {room.Stats.CheerCount.toLocaleString()}{' '}
						cheer{room.Stats.CheerCount === 1 ? '' : 's'}
						{!Number.isNaN(created.getTime()) && ` · made ${created.toLocaleDateString()}`}
					</p>
				</div>
			</Link>
		</li>
	)
}

/**
 * Developer-only: send a coach/system message, either to one player by `@username` or to
 * everyone online.
 *
 * The two go to different endpoints because they behave differently, not just in reach:
 * the broadcast is online-only (nothing holds a message with no addressee), while a named
 * recipient's message is queued by the hub and delivered whenever they next connect. The
 * recipient box therefore says which of those the operator is about to do.
 */
function CoachMessageForm() {
	const [recipient, setRecipient] = useState('')
	const [message, setMessage] = useState('')
	const { pending, error, done, run } = useAction()
	// The `@` is how the name is written, not part of it — accepted either way, shown back
	// with it, and sent without it.
	const handle = recipient.trim().replace(/^@/, '')
	const toOne = handle !== ''

	return (
		<section className="card">
			<h2>Coach message</h2>
			<p className="muted">
				Send a message from the Coach to one player, or leave the recipient blank to send it to
				every connected player. A broadcast reaches only who is online right now; a message to one
				player waits for them if they aren&apos;t.
			</p>
			<form
				onSubmit={(e) => {
					e.preventDefault()
					void run(async () => {
						const content = message.trim()
						if (!toOne) {
							const { sent } = await coachMessageAll(content)
							setMessage('')
							return `Sent to ${sent ?? 0} online player${sent === 1 ? '' : 's'}.`
						}
						// Resolved before sending: the workers address players by id, and a name that
						// matches nobody should be a refusal rather than a message into the void.
						const { queued } = await coachMessage(await accountIdForUsername(handle), content)
						setMessage('')
						return queued === true
							? `@${handle} is offline — it will arrive when they next connect.`
							: `Sent to @${handle}.`
					})
				}}
			>
				<label>
					Send to
					<input
						value={recipient}
						placeholder="@username — blank sends to everyone online"
						autoComplete="off"
						onChange={(e) => setRecipient(e.target.value)}
					/>
				</label>
				<label>
					Message
					<textarea
						value={message}
						rows={3}
						onChange={(e) => setMessage(e.target.value)}
						required
					/>
				</label>
				{error && <p className="error">{error}</p>}
				{done && <p className="ok">{done}</p>}
				<button type="submit" disabled={pending}>
					{pending ? 'Sending…' : toOne ? `Send to @${handle}` : 'Send to all online'}
				</button>
			</form>
		</section>
	)
}

/** Developer-only: broadcast a server-maintenance countdown to every connected client. */
function MaintenanceForm() {
	const [minutes, setMinutes] = useState('5')
	const { pending, error, done, run } = useAction()

	return (
		<section className="card">
			<h2>Server maintenance</h2>
			<p className="muted">
				Broadcast a maintenance countdown to every connected client. Enter how many minutes until
				maintenance starts (0 = now).
			</p>
			<form
				onSubmit={(e) => {
					e.preventDefault()
					void run(async () => {
						// Coerced the way the worker used to: a blank or negative box means "now".
						const asked = Number(minutes)
						const startsIn = Number.isFinite(asked) && asked > 0 ? Math.floor(asked) : 0
						const { delivered: connections } = await broadcastMaintenance(startsIn)
						return `Notified ${connections ?? 0} connected client${connections === 1 ? '' : 's'}.`
					})
				}}
			>
				<label>
					Starts in (minutes)
					<input
						type="number"
						min="0"
						step="1"
						value={minutes}
						onChange={(e) => setMinutes(e.target.value)}
						required
					/>
				</label>
				{error && <p className="error">{error}</p>}
				{done && <p className="ok">{done}</p>}
				<button type="submit" disabled={pending}>
					{pending ? 'Broadcasting…' : 'Broadcast maintenance'}
				</button>
			</form>
		</section>
	)
}

/** The flags `/api/staff/account-flags` manages, one admin list each — a mirror of www's `ACCOUNT_FLAGS`. */
const ACCOUNT_FLAG_LISTS = {
	isModerator: {
		title: 'Moderators',
		noun: 'a moderator',
		about:
			'Everyone with the moderator role. Adding or removing someone takes effect the next time they sign in.',
	},
	isInfluencer: {
		title: 'Influencers',
		noun: 'an influencer',
		about:
			'Everyone with the influencer role, which also lists them in the partner program. Adding or removing someone takes effect the next time they sign in.',
	},
	isSandbox: {
		title: 'Sandbox players',
		noun: 'in the sandbox',
		about:
			'Everyone on the sandbox voice servers instead of the live ones. Adding or removing someone takes effect the next time they join a room.',
	},
} as const
type AccountFlag = keyof typeof ACCOUNT_FLAG_LISTS
type FlaggedAccount = { accountId: number; username: string; displayName?: string }

/**
 * Developer only: everyone holding ONE account flag, with an add-by-username form and a
 * Remove per row — the same shape as the Studio access whitelists.
 */
function AccountFlagPanel({ flag, navigate }: { flag: AccountFlag; navigate: Navigate }) {
	const { title, noun, about } = ACCOUNT_FLAG_LISTS[flag]
	const [rows, setRows] = useState<FlaggedAccount[] | undefined>(undefined)
	const [loadError, setLoadError] = useState('')
	const [username, setUsername] = useState('')
	const add = useAction()
	const remove = useAction()

	const load = useCallback(async () => {
		try {
			const res = await call<{ accounts: FlaggedAccount[] }>(
				`/api/staff/account-flags?flag=${flag}`,
				{ authed: true }
			)
			setRows(res.accounts)
			setLoadError('')
		} catch (e) {
			setLoadError(e instanceof Error ? e.message : String(e))
		}
	}, [flag])

	useEffect(() => {
		setRows(undefined)
		void load()
	}, [load])

	return (
		<section className="card">
			<h2>{title}</h2>
			<p className="muted">{about}</p>
			<form
				onSubmit={(e) => {
					e.preventDefault()
					void add.run(async () => {
						const res = await call<{ username: string; changed: string[] }>(
							'/api/staff/account-flags',
							{ authed: true, method: 'PUT', json: { username: username.trim(), [flag]: true } }
						)
						setUsername('')
						await load()
						return res.changed.length === 0
							? `@${res.username} is already ${noun}.`
							: `@${res.username} is now ${noun}.`
					})
				}}
			>
				<label>
					Username
					<span className="staff-gift">
						<input
							type="text"
							value={username}
							autoComplete="off"
							spellCheck={false}
							required
							onChange={(e) => setUsername(e.target.value)}
						/>
						<button type="submit" disabled={add.pending || username.trim() === ''}>
							{add.pending ? 'Adding…' : 'Add'}
						</button>
					</span>
				</label>
				{add.error && <p className="error">{add.error}</p>}
				{add.done && <p className="ok">{add.done}</p>}
			</form>
			{loadError && <p className="error">{loadError}</p>}
			{remove.error && <p className="error">{remove.error}</p>}
			{remove.done && <p className="ok">{remove.done}</p>}
			{rows === undefined ? (
				!loadError && <p className="muted">Loading…</p>
			) : rows.length === 0 ? (
				<p className="muted">Nobody yet.</p>
			) : (
				<ul className="studio-access-list">
					{rows.map((row) => (
						<li key={row.accountId} className="studio-access-row">
							<span>
								<Link to={`/user/${encodeURIComponent(row.username)}`} navigate={navigate}>
									<strong>@{row.username}</strong>
								</Link>
								{row.displayName && row.displayName !== row.username ? (
									<span className="muted"> · {row.displayName}</span>
								) : null}
							</span>
							<button
								type="button"
								disabled={remove.pending}
								onClick={() =>
									void remove.run(async () => {
										await call('/api/staff/account-flags', {
											authed: true,
											method: 'PUT',
											json: { accountId: row.accountId, [flag]: false },
										})
										await load()
										return `@${row.username} is no longer ${noun}.`
									})
								}
							>
								Remove
							</button>
						</li>
					))}
				</ul>
			)}
		</section>
	)
}

/**
 * Staff only: opt the signed-in account in to or out of the SANDBOX — the separate Tachyon
 * (voice) server pool `match` hands a sandbox account on every connection-info read. It is
 * the account's `isSandbox` flag. This is the caller's own; a developer sets someone else's
 * from the list under it on the same tab (`AccountFlagPanel`). The current state is
 * read on mount; one button flips it. `match` reads the flag per room join, so the switch
 * lands the next time they join a room, not in the instance they are standing in.
 */
function SandboxForm() {
	// undefined = not fetched yet.
	const [sandbox, setSandbox] = useState<boolean | undefined>(undefined)
	const [loadError, setLoadError] = useState('')
	const { pending, error, done, run } = useAction()

	useEffect(() => {
		void call<{ sandbox: boolean }>('/api/staff/sandbox', { authed: true })
			.then((res) => setSandbox(res.sandbox))
			.catch((e) => setLoadError(e instanceof Error ? e.message : String(e)))
	}, [])

	return (
		<section className="card">
			<h2>Sandbox</h2>
			<p className="muted">
				A sandbox account is put on the sandbox voice servers instead of the live ones, for testing
				a Tachyon build before players get it. This only changes your own account. It takes effect
				the next time you join a room.
			</p>
			{loadError && <p className="error">{loadError}</p>}
			{sandbox === undefined && !loadError ? (
				<p className="muted">Loading…</p>
			) : sandbox !== undefined ? (
				<>
					<p>
						You are currently {sandbox ? <strong>in</strong> : <strong>out of</strong>} the sandbox.
					</p>
					{error && <p className="error">{error}</p>}
					{done && <p className="ok">{done}</p>}
					<button
						type="button"
						disabled={pending}
						onClick={() =>
							void run(async () => {
								const next = !sandbox
								const res = await call<{ sandbox: boolean; changed: boolean }>(
									'/api/staff/sandbox',
									{ authed: true, method: 'PUT', json: { sandbox: next } }
								)
								setSandbox(res.sandbox)
								return res.sandbox
									? 'You are in the sandbox. Join a room to land on the sandbox servers.'
									: 'You are out of the sandbox. Join a room to land back on the live servers.'
							})
						}
					>
						{pending ? 'Saving…' : sandbox ? 'Leave sandbox' : 'Join sandbox'}
					</button>
				</>
			) : null}
		</section>
	)
}

/**
 * The most a token drop carries per player — a mirror of www's `MAX_TOKEN_DROP`, which is
 * the one that decides. Not imported: the staff module pulls hono and the JWT code into the
 * page bundle for one number.
 */
const MAX_TOKEN_DROP = 1_000

/** The role drop's own, higher cap — a mirror of www's `MAX_ROLE_TOKEN_DROP`. */
const MAX_ROLE_TOKEN_DROP = 10_000

/**
 * The most the one-player gift carries — a mirror of www's `DEVELOPER_MAX_TOKEN_GIFT`, the cap
 * for the developers who are the only ones shown the form. Copy only; the server refuses more.
 */
const MAX_TOKEN_GIFT = 100_000

/**
 * Developer-only: give every player online right now the same number of tokens, in a gift
 * box carrying the operator's message — the server-wide cousin of the room page's staff gift.
 *
 * The audience is read by the server when the button is pressed, so it is whoever is on at
 * that moment, lobby included; the button says as much. The cap is the server's
 * (`MAX_TOKEN_DROP`, 1,000 each) and is repeated on the input so a typo is caught before the
 * round trip — the server is still the one that refuses.
 */
function TokenDropForm() {
	const [message, setMessage] = useState('')
	const [tokens, setTokens] = useState('')
	const { pending, error, done, run } = useAction()

	return (
		<section className="card">
			<h2>Token drop</h2>
			<p className="muted">
				Give everyone online right now the same number of tokens. Each player gets a gift box with
				your message on it; a player who isn&apos;t signed in when you press the button gets
				nothing. Up to {MAX_TOKEN_DROP.toLocaleString()} tokens each.
			</p>
			<form
				onSubmit={(e) => {
					e.preventDefault()
					void run(async () => {
						const amount = Number(tokens)
						const res = await call<{ paid: number[] }>('/api/staff/online/gift-tokens', {
							authed: true,
							json: { amount, message: message.trim() },
						})
						setTokens('')
						setMessage('')
						const n = res.paid.length
						return `Sent ${amount.toLocaleString()} tokens to ${n} online player${n === 1 ? '' : 's'}.`
					})
				}}
			>
				<label>
					Gift box message
					<textarea
						value={message}
						rows={3}
						maxLength={256}
						placeholder="Thanks for playing this weekend!"
						onChange={(e) => setMessage(e.target.value)}
						required
					/>
				</label>
				<label>
					Tokens per player
					<input
						type="number"
						min={1}
						max={MAX_TOKEN_DROP}
						step={1}
						value={tokens}
						required
						onChange={(e) => setTokens(e.target.value)}
					/>
				</label>
				{error && <p className="error">{error}</p>}
				{done && <p className="ok">{done}</p>}
				<button type="submit" disabled={pending}>
					{pending ? 'Sending…' : 'Send to everyone online'}
				</button>
			</form>
		</section>
	)
}

/**
 * Developer-only: give every player whose Discord link holds a role the same number of
 * tokens, in a gift box carrying the operator's message — the token drop's sibling, with a
 * different audience. Offline is the point: the box waits for whoever isn't signed in.
 *
 * The audience is the roles the website recorded at each player's benefits claim and
 * refreshes once a day, so it trails Discord by up to a day and never includes a member who
 * hasn't claimed; the copy says so. Its own cap (`MAX_ROLE_TOKEN_DROP`, 10,000 each), repeated
 * on the input.
 */
function RoleTokenDropForm() {
	const [roleId, setRoleId] = useState('')
	const [message, setMessage] = useState('')
	const [tokens, setTokens] = useState('')
	const { pending, error, done, run } = useAction()

	return (
		<section className="card">
			<h2>Discord role drop</h2>
			<p className="muted">
				Give everyone holding a Discord role the same number of tokens, whether or not they are
				online — a player who is signed out finds the gift box waiting. Only players who have
				claimed benefits on this site are counted, and their roles are refreshed once a day, so a
				role given or taken since then isn&apos;t seen yet. Up to{' '}
				{MAX_ROLE_TOKEN_DROP.toLocaleString()} tokens each.
			</p>
			<form
				onSubmit={(e) => {
					e.preventDefault()
					void run(async () => {
						const amount = Number(tokens)
						const role = roleId.trim()
						const res = await call<{ paid: number[] }>(
							`/api/staff/discord-roles/${encodeURIComponent(role)}/gift-tokens`,
							{ authed: true, json: { amount, message: message.trim() } }
						)
						setTokens('')
						setMessage('')
						const n = res.paid.length
						return `Sent ${amount.toLocaleString()} tokens to ${n} player${n === 1 ? '' : 's'} holding role ${role}.`
					})
				}}
			>
				<label>
					Discord role id
					<input
						type="text"
						inputMode="numeric"
						pattern="[0-9]+"
						value={roleId}
						placeholder="1077000000000000001"
						required
						onChange={(e) => setRoleId(e.target.value)}
					/>
					<span className="hint">
						The role&apos;s numeric id, from Discord&apos;s role settings (Copy Role ID), not its
						name.
					</span>
				</label>
				<label>
					Gift box message
					<textarea
						value={message}
						rows={3}
						maxLength={256}
						placeholder="Thanks for supporting the server!"
						onChange={(e) => setMessage(e.target.value)}
						required
					/>
				</label>
				<label>
					Tokens per player
					<input
						type="number"
						min={1}
						max={MAX_ROLE_TOKEN_DROP}
						step={1}
						value={tokens}
						required
						onChange={(e) => setTokens(e.target.value)}
					/>
				</label>
				{error && <p className="error">{error}</p>}
				{done && <p className="ok">{done}</p>}
				<button type="submit" disabled={pending}>
					{pending ? 'Sending…' : 'Send to everyone with the role'}
				</button>
			</form>
		</section>
	)
}

/** What one run of the supporter gift did — econ's `RoleGiftSummary`, as the route answers. */
interface RoleGiftSummary {
	skipped: boolean
	roles: number
	links: number
	granted: number
	tokens: number
	failed: number
}

/**
 * Developer-only: pay econ's scheduled supporter gift again, right now — a bonus round. Every
 * player whose linked Discord holds a role in the server's role→tokens map is boxed that
 * role's tokens, exactly as the weekly cron does it; the amounts and the box message are the
 * server's, not typed here, which is what tells this apart from the role drop above.
 *
 * The gift keeps no ledger, so pressing this pays everyone again on top of whatever the
 * schedule paid — that is the point, and why the button asks first. A `skipped` run means
 * no role is mapped on the server, shown as the error it is; a run that went through is
 * summed up in a sentence.
 */
function SupporterBonusCard() {
	const [confirming, setConfirming] = useState(false)
	const { pending, error, done, run } = useAction()

	return (
		<section className="card">
			<h2>Bonus reward</h2>
			<p className="muted">
				Run the scheduled supporter reward again now. Everyone whose linked Discord holds a rewarded
				role gets their role&apos;s tokens in a gift box, online or not, using the amounts and
				message the server is configured with. It pays on top of the scheduled run, every time it is
				pressed.
			</p>
			{error && <p className="error">{error}</p>}
			{done && <p className="ok">{done}</p>}
			{confirming ? (
				<>
					<button
						type="button"
						disabled={pending}
						onClick={() =>
							void run(async () => {
								const s = await call<RoleGiftSummary>('/api/staff/discord-roles/supporter-gift', {
									authed: true,
									method: 'POST',
								})
								setConfirming(false)
								if (s.skipped) {
									throw new Error(
										'The supporter reward is off: no Discord role is mapped to tokens on the server.'
									)
								}
								const parts = [
									`Sent ${s.granted} gift box${s.granted === 1 ? '' : 'es'} for ${s.tokens.toLocaleString()} tokens`,
									`${s.roles} rewarded role${s.roles === 1 ? '' : 's'} over ${s.links} linked Discord${s.links === 1 ? '' : 's'}`,
								]
								if (s.failed > 0) parts.push(`${s.failed} failed — see the worker log`)
								return `${parts.join(', ')}.`
							})
						}
					>
						{pending ? 'Sending…' : 'Confirm: pay every supporter again'}
					</button>
					<button
						type="button"
						className="linkish"
						disabled={pending}
						onClick={() => setConfirming(false)}
					>
						Cancel
					</button>
				</>
			) : (
				<button type="button" onClick={() => setConfirming(true)}>
					Bonus reward!
				</button>
			)}
		</section>
	)
}

/** What one run of the Discord role sweep did — www's `SweepSummary`, as the sync answers. */
interface SweepSummary {
	skipped: boolean
	refreshed: number
	changed: number
	gone: number
	failed: number
	halted: string | null
}

/**
 * Developer-only: run the Discord role sweep now, instead of waiting for its nightly cron.
 * Sits under the role drop because the drop reads the snapshot this refreshes — press this
 * first and the drop sees this morning's roles rather than yesterday's.
 *
 * The answer is the point. The cron reports only to a log line, so a sweep that halts on
 * its first call (a token Discord refuses, a bot not yet in the guild) halts silently every
 * night; here the same run comes back with its summary, and a `halted` or `skipped` run is
 * shown as the error it is for the operator, with the reason the server gave. A run that
 * went through is summed up in a sentence.
 */
function DiscordRoleSyncCard() {
	const { pending, error, done, run } = useAction()

	return (
		<section className="card">
			<h2>Refresh Discord roles</h2>
			<p className="muted">
				Re-read every linked Discord member&apos;s roles from the server now. This runs on its own
				once a day; use it after changing the bot or inviting it to the server, or when the role
				drop above needs today&apos;s roles. If the sweep can&apos;t run, the reason is shown here.
			</p>
			{error && <p className="error">{error}</p>}
			{done && <p className="ok">{done}</p>}
			<button
				type="button"
				disabled={pending}
				onClick={() =>
					void run(async () => {
						const s = await call<SweepSummary>('/api/staff/discord-roles/sync', {
							authed: true,
							method: 'POST',
						})
						if (s.skipped) {
							throw new Error(
								'The sweep is off: no Discord guild or bot token is configured on the server.'
							)
						}
						if (s.halted !== null) {
							throw new Error(
								`The sweep stopped before writing anything: ${s.halted}. ${s.refreshed} link${s.refreshed === 1 ? '' : 's'} refreshed first.`
							)
						}
						const parts = [
							`Refreshed ${s.refreshed} link${s.refreshed === 1 ? '' : 's'}`,
							`${s.changed} changed`,
							`${s.gone} left the server`,
						]
						if (s.failed > 0) parts.push(`${s.failed} skipped for a transient error`)
						return `${parts.join(', ')}.`
					})
				}
			>
				{pending ? 'Refreshing…' : 'Refresh roles now'}
			</button>
		</section>
	)
}

/**
 * Change the account's username — the name used to sign in, here and in the game.
 *
 * Changes are rationed (an account starts with one), so the count is stated up front and
 * the form locks itself once none are left rather than letting someone spend the attempt
 * finding out. The server is still the one that decides: an unknown count leaves the form
 * open, and a name taken since the page loaded is refused upstream.
 *
 * The response is the caller's whole self account, re-read after the write, so the
 * remaining count on screen is the stored one and not a guess.
 */
function UsernameForm({
	account,
	onChange,
}: {
	account: SelfAccount
	onChange: (a: SelfAccount) => void
}) {
	const [username, setUsername] = useState(account.username)
	const { pending, error, done, run } = useAction()

	const remaining = account.availableUsernameChanges
	const spent = remaining !== undefined && remaining <= 0
	// Retyping the current name would be refused upstream anyway ("already taken" is
	// waived for your own name, but it would still spend a change).
	const unchanged = username.trim() === account.username

	return (
		<section className="card">
			<h2>Username</h2>
			<p className="muted">
				What you sign in with, here and in the game — and what other players see you by.
			</p>
			<form
				onSubmit={(e) => {
					e.preventDefault()
					void run(async () => {
						const updated = await changeUsername(username.trim())
						onChange(updated)
						setUsername(updated.username)
						return `You are now @${updated.username}.`
					})
				}}
			>
				<label>
					Username
					<input
						type="text"
						value={username}
						autoComplete="username"
						disabled={spent}
						onChange={(e) => setUsername(e.target.value)}
						required
					/>
					<span className="hint">
						{remaining === undefined
							? 'Changing your username uses up one of a limited number of changes.'
							: spent
								? 'You have no username changes remaining, so this can no longer be changed.'
								: `You have ${remaining} username change${remaining === 1 ? '' : 's'} remaining — this one is permanent once used.`}
					</span>
				</label>
				{error && <p className="error">{error}</p>}
				{done && <p className="ok">{done}</p>}
				<button type="submit" disabled={pending || spent || unchanged}>
					{pending ? 'Changing…' : 'Change username'}
				</button>
			</form>
		</section>
	)
}

function DisplayNameForm({
	account,
	onChange,
}: {
	account: SelfAccount
	onChange: (a: SelfAccount) => void
}) {
	const [displayName, setDisplayName] = useState(account.displayName)
	const { pending, error, done, run } = useAction()

	const unchanged = displayName.trim() === account.displayName

	return (
		<section className="card">
			<h2>Display name</h2>
			<p className="muted">
				The name other players see in the game. Changing it doesn&apos;t change what you sign in
				with.
			</p>
			<form
				onSubmit={(e) => {
					e.preventDefault()
					void run(async () => {
						const saved = displayName.trim()
						await saveDisplayName(saved)
						onChange({ ...account, displayName: saved })
						setDisplayName(saved)
						return 'Display name saved.'
					})
				}}
			>
				<label>
					Display name
					<input
						type="text"
						value={displayName}
						autoComplete="nickname"
						maxLength={15}
						onChange={(e) => setDisplayName(e.target.value)}
						required
					/>
					<span className="hint">
						Up to 15 characters: letters, numbers, spaces and .,&apos;!?_&amp;()#@:+-
					</span>
				</label>
				{error && <p className="error">{error}</p>}
				{done && <p className="ok">{done}</p>}
				<button type="submit" disabled={pending || unchanged}>
					{pending ? 'Saving…' : 'Save display name'}
				</button>
			</form>
		</section>
	)
}

function EmailForm({
	account,
	onChange,
}: {
	account: SelfAccount
	onChange: (a: SelfAccount) => void
}) {
	const [email, setEmail] = useState(account.email ?? '')
	// The change a code is out for, once `accounts` says so — asked on mount, so a reload
	// (or arriving here straight from signup, which saved the address) resumes at the code.
	const [pending, setPending] = useState<PendingEmail | null>(null)
	const [code, setCode] = useState('')
	const save = useAction()
	const confirm = useAction()

	useEffect(() => {
		fetchPendingEmail()
			.then((p) => setPending(p.pending === null ? null : p))
			.catch(() => {})
	}, [])

	return (
		<section className="card">
			<h2>Email</h2>
			<p className="muted">
				Used to recover your password, so changing it takes a code at your current address to
				approve it, then one at the new address to confirm it. With no address yet, just the second.
			</p>
			<form
				onSubmit={(e) => {
					e.preventDefault()
					void save.run(async () => {
						const wanted = email.trim()
						await saveEmail(wanted)
						// Re-saving the current address applies at once; anything else is staged
						// and `accounts` knows where the code went.
						const now = await fetchPendingEmail().catch(() => null)
						if (now === null || now.pending === null) {
							onChange({ ...account, email: wanted })
							setPending(null)
							return 'Email saved.'
						}
						setPending(now)
						setCode('')
						return `A six-digit code was emailed to ${now.sentTo}. Enter it below.`
					})
				}}
			>
				<label>
					Email address
					<input
						type="email"
						value={email}
						autoComplete="email"
						onChange={(e) => setEmail(e.target.value)}
						required
					/>
				</label>
				{save.error && <p className="error">{save.error}</p>}
				{save.done && <p className="ok">{save.done}</p>}
				<button type="submit" disabled={save.pending}>
					{save.pending ? 'Saving…' : 'Save email'}
				</button>
			</form>
			{pending && (
				<form
					onSubmit={(e) => {
						e.preventDefault()
						void confirm.run(async () => {
							const next = await confirmEmail(code.trim())
							setCode('')
							if (!next.applied) {
								// Step 1 done: the current address approved. Step 2's code is out.
								setPending(next)
								return `Approved. A second code was emailed to ${next.sentTo} — enter it to finish.`
							}
							const applied = pending.pending ?? ''
							onChange({ ...account, email: applied })
							setEmail(applied)
							setPending(null)
							return 'Email changed.'
						})
					}}
				>
					<p className="muted">
						Changing to <strong>{pending.pending}</strong>. Enter the code sent to{' '}
						<strong>{pending.sentTo}</strong> — it works once, for 30 minutes. Wrong code, or
						mistyped the address? Save the address again for a new one.
					</p>
					<label>
						Code
						<input
							type="text"
							inputMode="numeric"
							pattern="[0-9]{6}"
							value={code}
							autoComplete="one-time-code"
							onChange={(e) => setCode(e.target.value)}
							required
						/>
					</label>
					{confirm.error && <p className="error">{confirm.error}</p>}
					{confirm.done && <p className="ok">{confirm.done}</p>}
					<button type="submit" disabled={confirm.pending}>
						{confirm.pending ? 'Confirming…' : 'Confirm'}
					</button>
				</form>
			)}
			{!pending && confirm.done && <p className="ok">{confirm.done}</p>}
		</section>
	)
}

function PasswordForm() {
	const [oldPassword, setOldPassword] = useState('')
	const [newPassword, setNewPassword] = useState('')
	const { pending, error, done, run } = useAction()

	return (
		<section className="card">
			<h2>Password</h2>
			<form
				onSubmit={(e) => {
					e.preventDefault()
					void run(async () => {
						await changePassword(oldPassword, newPassword)
						setOldPassword('')
						setNewPassword('')
						return 'Password changed.'
					})
				}}
			>
				<label>
					Current password
					<input
						type="password"
						value={oldPassword}
						autoComplete="current-password"
						onChange={(e) => setOldPassword(e.target.value)}
						required
					/>
				</label>
				<label>
					New password
					<input
						type="password"
						value={newPassword}
						autoComplete="new-password"
						onChange={(e) => setNewPassword(e.target.value)}
						required
					/>
				</label>
				{error && <p className="error">{error}</p>}
				{done && <p className="ok">{done}</p>}
				<button type="submit" disabled={pending}>
					{pending ? 'Updating…' : 'Change password'}
				</button>
			</form>
		</section>
	)
}

/**
 * Two-factor sign-in: a second step after the password, in the game and on this site. An
 * authenticator app (scan the QR code, or type the secret, then confirm with a code) or a
 * code emailed at each sign-in. Discord and the game's remembered devices (cached logins)
 * don't ask for it: it guards the PASSWORD, which is why an account needs one first.
 */
function TwoFactorForm() {
	const [status, setStatus] = useState<TwoFactorStatus | null>(null)
	const [setup, setSetup] = useState<{ secret: string; uri: string } | null>(null)
	const [password, setPassword] = useState('')
	const [code, setCode] = useState('')
	const load = useAction()
	const act = useAction()

	const { run: runLoad } = load
	useEffect(() => {
		void runLoad(async () => {
			setStatus(await fetchTwoFactor())
			return ''
		})
	}, [runLoad])
	const clear = () => {
		setPassword('')
		setCode('')
	}

	const passwordField = (
		<label>
			Password
			<input
				type="password"
				value={password}
				autoComplete="current-password"
				onChange={(e) => setPassword(e.target.value)}
				required
			/>
		</label>
	)
	const codeField = (label: string) => (
		<label>
			{label}
			<input
				type="text"
				inputMode="numeric"
				pattern="[0-9 ]{6,7}"
				value={code}
				autoComplete="one-time-code"
				onChange={(e) => setCode(e.target.value)}
				required
			/>
		</label>
	)
	const feedback = (
		<>
			{act.error && <p className="error">{act.error}</p>}
			{act.done && <p className="ok">{act.done}</p>}
		</>
	)

	let body: React.ReactNode
	if (status === null) {
		body = load.error ? <p className="error">{load.error}</p> : <p className="muted">Loading…</p>
	} else if (!status.hasPassword) {
		body = (
			<p className="muted">
				Two-factor sign-in protects your password, and this account has none yet. Set one under
				Password first.
			</p>
		)
	} else if (status.method !== 'none') {
		body = (
			<form
				onSubmit={(e) => {
					e.preventDefault()
					void act.run(async () => {
						await disableTwoFactor(password, code.trim())
						clear()
						setStatus({ ...status, method: 'none', totpPending: false })
						return 'Two-factor sign-in is off.'
					})
				}}
			>
				<p>
					<strong>On</strong> —{' '}
					{status.method === 'totp'
						? 'signing in with your password also asks for a code from your authenticator app.'
						: 'signing in with your password also asks for a code emailed to you.'}
				</p>
				{passwordField}
				{status.method === 'totp' && codeField('Current code from the app')}
				{feedback}
				<button type="submit" disabled={act.pending}>
					{act.pending ? 'Turning off…' : 'Turn off'}
				</button>
			</form>
		)
	} else if (setup !== null) {
		const qr = `data:image/svg+xml;utf8,${encodeURIComponent(renderSVG(setup.uri, { border: 2 }))}`
		body = (
			<form
				onSubmit={(e) => {
					e.preventDefault()
					void act.run(async () => {
						await confirmTotp(password, code.trim())
						clear()
						setSetup(null)
						setStatus({ ...status, method: 'totp', totpPending: false })
						return 'Authenticator sign-in is on.'
					})
				}}
			>
				<p className="muted">
					Scan this with your authenticator app (Google Authenticator, Authy, 1Password…), or
					on this device <a href={setup.uri}>open it in the app</a>.
				</p>
				<img
					src={qr}
					alt="QR code for your authenticator app"
					width={192}
					height={192}
					className="totp-qr"
				/>
				<p className="muted">
					Can't scan? Enter this key: <code>{setup.secret.replace(/(.{4})/g, '$1 ').trim()}</code>
				</p>
				{codeField('Code from the app')}
				{passwordField}
				{feedback}
				<button type="submit" disabled={act.pending}>
					{act.pending ? 'Confirming…' : 'Turn on'}
				</button>
				<button
					type="button"
					className="link"
					onClick={() => {
						setSetup(null)
						clear()
					}}
				>
					Cancel
				</button>
			</form>
		)
	} else {
		body = (
			<>
				<p className="muted">Off. Choose a second step for signing in with your password:</p>
				<form
					onSubmit={(e) => {
						e.preventDefault()
						void act.run(async () => {
							setSetup(await beginTotp())
							clear()
							return ''
						})
					}}
				>
					<button type="submit" disabled={act.pending}>
						Use an authenticator app
					</button>
				</form>
				<form
					onSubmit={(e) => {
						e.preventDefault()
						void act.run(async () => {
							await enableEmailTwoFactor(password)
							clear()
							setStatus({ ...status, method: 'email' })
							return 'Emailed sign-in codes are on.'
						})
					}}
				>
					<p className="muted">
						Or get a code by email each time you sign in
						{status.hasEmail ? '.' : ' — add an email address under Email first.'}
					</p>
					{status.hasEmail && passwordField}
					{feedback}
					<button type="submit" disabled={act.pending || !status.hasEmail}>
						Use emailed codes
					</button>
				</form>
			</>
		)
	}

	return (
		<section className="card">
			<h2>Two-factor sign-in</h2>
			{body}
		</section>
	)
}

/**
 * The way out. The button MARKS the account (`/api/account/delete`) rather than deleting
 * it, and the panel says so plainly: the account keeps working, and signing in again is
 * what reverses the request. The player types their username to confirm — a password
 * would lock out the accounts that sign in through Discord and have none.
 */
function DeleteAccountForm({
	account,
	onChange,
}: {
	account: SelfAccount
	onChange: (a: SelfAccount) => void
}) {
	const [confirmation, setConfirmation] = useState('')
	const { pending, error, run } = useAction()
	const confirmed = confirmation.trim().toLowerCase() === account.username.toLowerCase()

	if (account.isDeleted) {
		return (
			<section className="card">
				<h2>Delete account</h2>
				<p className="error">
					This account is marked for deletion
					{account.deletedAt ? ` as of ${new Date(account.deletedAt).toLocaleString()}` : ''}.
				</p>
				<p className="muted">
					Nothing has been removed yet, and the account still works. Signing in again before it is
					deleted keeps it.
				</p>
			</section>
		)
	}

	return (
		<section className="card">
			<h2>Delete account</h2>
			<p className="muted">
				This marks your account for deletion. Your rooms, photos and inventory are not removed right
				away, and you can change your mind by signing in again before they are.
			</p>
			<p className="error">
				You will be unable to recover this account with Steam, Meta, or Discord. Set an email or a
				password if you think you might have second thoughts!
			</p>
			<form
				onSubmit={(e) => {
					e.preventDefault()
					if (!confirmed) return
					void run(async () => {
						const marked = await deleteAccount()
						onChange({ ...account, isDeleted: true, deletedAt: marked.deletedAt })
						setConfirmation('')
						return 'Your account is marked for deletion.'
					})
				}}
			>
				<label>
					Type your username (@{account.username}) to confirm
					<input
						type="text"
						value={confirmation}
						autoComplete="off"
						onChange={(e) => setConfirmation(e.target.value)}
						required
					/>
				</label>
				{error && <p className="error">{error}</p>}
				<button type="submit" className="danger" disabled={pending || !confirmed}>
					{pending ? 'Marking…' : 'Delete account'}
				</button>
			</form>
		</section>
	)
}
