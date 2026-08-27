/**
 * Club storage on the shared `recflare` D1 database. A club is a single JSON blob
 * in the `data` column (the client-facing Club DTO); queryable fields (ClubId,
 * Name, Category, Visibility, State, CreatorAccountId) are SQLite generated
 * (virtual) columns extracted from that JSON and indexed — the same JSON-blob
 * pattern the rooms/accounts tables use. Mirrors the Go/GORM `Club` model.
 *
 * Membership lives in a separate `club_member` table (one row per club/account);
 * the club's `MemberCount` is a denormalized field kept in sync from those rows.
 *
 * The `clubs` worker owns this schema/migration (migrations/0001_club.sql, applied
 * under its own `migrations_table` so it doesn't clash with the other workers'
 * migrations that share the database) and reaches every write here through its
 * routes. `CLUB_SCHEMA_DDL` mirrors that migration so tests can build the tables
 * directly. Other workers read: `match` resolves a club's clubhouse room via
 * {@link getClubSummary} and gates entry on {@link isClubMember}.
 */

import { getSavedImagesByNames, placeholderSavedImage } from './images-db'

import type { SavedImage } from './images-db'

/** Schema DDL (mirror of migrations/0001_club.sql, sans seed rows). */
export const CLUB_SCHEMA_DDL: string[] = [
	`CREATE TABLE IF NOT EXISTS club (
		data TEXT NOT NULL,
		club_id INTEGER GENERATED ALWAYS AS (json_extract(data, '$.ClubId')) VIRTUAL,
		name_lower TEXT GENERATED ALWAYS AS (lower(json_extract(data, '$.Name'))) VIRTUAL,
		category TEXT GENERATED ALWAYS AS (json_extract(data, '$.Category')) VIRTUAL,
		visibility INTEGER GENERATED ALWAYS AS (json_extract(data, '$.Visibility')) VIRTUAL,
		state INTEGER GENERATED ALWAYS AS (json_extract(data, '$.State')) VIRTUAL,
		creator_account_id INTEGER GENERATED ALWAYS AS (json_extract(data, '$.CreatorAccountId')) VIRTUAL
	)`,
	`CREATE UNIQUE INDEX IF NOT EXISTS idx_club_club_id ON club (club_id)`,
	`CREATE INDEX IF NOT EXISTS idx_club_name_lower ON club (name_lower)`,
	`CREATE INDEX IF NOT EXISTS idx_club_category ON club (category)`,
	`CREATE INDEX IF NOT EXISTS idx_club_creator ON club (creator_account_id)`,
	// Club membership — one row per (club, account); `membership_type` (see
	// ClubMembershipType) encodes bans, pending requests/invites, and roles in a
	// single field. Surrogate PK mirrors the Go model; the UNIQUE (club_id,
	// account_id) index enforces one membership per pair (and backs the upsert). The
	// club's MemberCount is kept in sync from the rows that count as real members.
	`CREATE TABLE IF NOT EXISTS club_member (
		club_member_id INTEGER PRIMARY KEY AUTOINCREMENT,
		club_id INTEGER NOT NULL,
		account_id INTEGER NOT NULL,
		membership_type INTEGER NOT NULL DEFAULT 0,
		created_at TEXT
	)`,
	`CREATE UNIQUE INDEX IF NOT EXISTS idx_club_member_pair ON club_member (club_id, account_id)`,
	`CREATE INDEX IF NOT EXISTS idx_club_member_account ON club_member (account_id)`,
	// Club announcements — the club's noticeboard, newest first. Columns rather than a
	// JSON blob (mirroring the Go model), since nothing here is client-shaped beyond
	// the fields themselves.
	`CREATE TABLE IF NOT EXISTS club_announcement (
		announcement_id INTEGER PRIMARY KEY AUTOINCREMENT,
		club_id INTEGER NOT NULL,
		account_id INTEGER NOT NULL,
		title TEXT NOT NULL DEFAULT '',
		body TEXT NOT NULL DEFAULT '',
		image_name TEXT NOT NULL DEFAULT '',
		meta TEXT NOT NULL DEFAULT '',
		created_at TEXT
	)`,
	`CREATE INDEX IF NOT EXISTS idx_club_announcement_club ON club_announcement (club_id)`,
]

/**
 * A player's membership state in a club (mirror of the Go `ClubMembershipType`).
 * The single field spans bans, the pending request/invite states, and the member
 * role tiers; `Member` (10) is the threshold at/above which someone is an actual
 * member (below it is pending/none/banned).
 */
export enum ClubMembershipType {
	Banned = -1,
	None = 0,
	PendingRequested = 1,
	PendingInvited = 2,
	PendingDenied = 3,
	Member = 10,
	Moderator = 20,
	Coowner = 30,
	Creator = 100,
}

/** A club's visibility (mirror of the Go `ClubVisibility`). */
export enum ClubVisibility {
	Private = 0,
	Public = 1,
}

/** How a player may join a club (mirror of the Go `ClubJoinability`). */
export enum ClubJoinability {
	Open = 0,
	InviteOnly = 1,
	AskToJoin = 2,
}

/** Membership types at/above which a row counts as an actual member (not pending/banned). */
const MEMBER_THRESHOLD = ClubMembershipType.Member

/**
 * Client-facing club shape (PascalCase, mirror of the Go `Club` JSON tags). The
 * Go model's `CreatedAt` is `json:"-"` — stored but never serialized — so it lives
 * in the blob (see StoredClub) but is dropped from this DTO.
 */
export interface Club {
	ClubId: number
	Name: string
	Description: string
	Category: string
	Visibility: number
	Joinability: number
	AllowJuniors: boolean
	MainImageName: string
	ClubType: number
	ClubhouseRoomId: number | null
	CreatorAccountId: number
	IsRRO: boolean
	MinLevel: number
	State: number
	MemberCount: number
}

/**
 * The stored club — the DTO plus fields the client never sees on the Club object
 * itself: `CreatedAt` (`json:"-"` in Go) and the club's custom tags, which the Go
 * server keeps in a `club_custom_tags` table but which we keep on the blob, since
 * they're only ever read and written with the club.
 */
interface StoredClub extends Club {
	CreatedAt: string
	CustomTags?: string[]
	/**
	 * The club's gallery image names, in order (the client PUTs to
	 * `/additionalimage/{index}`). Packed, never sparse: removing one shifts the rest
	 * up, so the list is always the images the club actually has.
	 */
	AdditionalImages?: string[]
}

/** How many gallery images a club has room for (slots 0..2). */
export const MAX_ADDITIONAL_IMAGES = 3

interface ClubRow {
	data: string
}

/** Project a stored club to the client DTO (drops the non-serialized CreatedAt). */
function toDto(s: StoredClub): Club {
	return {
		ClubId: s.ClubId,
		Name: s.Name,
		Description: s.Description,
		Category: s.Category,
		Visibility: s.Visibility,
		Joinability: s.Joinability,
		AllowJuniors: s.AllowJuniors,
		MainImageName: s.MainImageName,
		ClubType: s.ClubType,
		ClubhouseRoomId: s.ClubhouseRoomId,
		CreatorAccountId: s.CreatorAccountId,
		IsRRO: s.IsRRO,
		MinLevel: s.MinLevel,
		State: s.State,
		MemberCount: s.MemberCount,
	}
}

const parseOne = (row: ClubRow | null): Club | null =>
	row ? toDto(JSON.parse(row.data) as StoredClub) : null
const parseAll = (rows: ClubRow[]): Club[] =>
	rows.map((r) => toDto(JSON.parse(r.data) as StoredClub))

/**
 * Recompute a club's `MemberCount` from the `club_member` rows and write it back
 * into the blob (the generated column follows). Returns the fresh count. Keeping
 * the count derived avoids drift from concurrent joins/leaves.
 */
async function syncMemberCount(db: D1Database, clubId: number): Promise<number> {
	const row = await db
		.prepare('SELECT COUNT(*) AS n FROM club_member WHERE club_id = ?1 AND membership_type >= ?2')
		.bind(clubId, MEMBER_THRESHOLD)
		.first<{ n: number }>()
	const count = row?.n ?? 0
	await db
		// CAST to INTEGER: D1 binds a JS number as a SQLite REAL, which json_set would write
		// into the blob as `"MemberCount":3.0` — and this blob is served to the client.
		.prepare(
			"UPDATE club SET data = json_set(data, '$.MemberCount', CAST(?2 AS INTEGER)) WHERE club_id = ?1"
		)
		.bind(clubId, count)
		.run()
	return count
}

/** Read a player's membership type in a club (None when there's no row). */
export async function getMembership(
	db: D1Database,
	clubId: number,
	accountId: number
): Promise<ClubMembershipType> {
	const row = await db
		.prepare('SELECT membership_type AS t FROM club_member WHERE club_id = ?1 AND account_id = ?2')
		.bind(clubId, accountId)
		.first<{ t: number }>()
	return (row?.t ?? ClubMembershipType.None) as ClubMembershipType
}

/**
 * Upsert a player's membership type for a club (one row per pair). `created_at` is
 * stamped on first insert and preserved on later type changes.
 */
async function setMembership(
	db: D1Database,
	clubId: number,
	accountId: number,
	type: ClubMembershipType
): Promise<void> {
	await db
		.prepare(
			`INSERT INTO club_member (club_id, account_id, membership_type, created_at)
			 VALUES (?1, ?2, ?3, ?4)
			 ON CONFLICT(club_id, account_id) DO UPDATE SET membership_type = ?3`
		)
		.bind(clubId, accountId, type, new Date().toISOString())
		.run()
}

/** Fields a caller may supply when creating a club; everything else takes the Go defaults. */
export interface NewClub {
	name: string
	description?: string
	category?: string
	visibility?: number
	joinability?: number
	allowJuniors?: boolean
	mainImageName?: string
	clubType?: number
	clubhouseRoomId?: number | null
	isRRO?: boolean
	minLevel?: number
}

/**
 * Create a club owned by `creatorAccountId`. The id is the next free integer (the
 * Go model uses `autoIncrement:false`, i.e. an app-assigned id). Unset fields fall
 * back to the Go model's column defaults. The creator is added as the club's first
 * member (Owner), so the returned club has MemberCount 1.
 */
export async function createClub(
	db: D1Database,
	creatorAccountId: number,
	input: NewClub
): Promise<Club> {
	const idRow = await db
		.prepare('SELECT COALESCE(MAX(club_id), 0) + 1 AS next FROM club')
		.first<{ next: number }>()
	const clubId = idRow?.next ?? 1
	const now = new Date().toISOString()

	const stored: StoredClub = {
		ClubId: clubId,
		Name: input.name,
		Description: input.description ?? '',
		Category: input.category ?? '',
		Visibility: input.visibility ?? ClubVisibility.Public,
		Joinability: input.joinability ?? ClubJoinability.Open,
		AllowJuniors: input.allowJuniors ?? true,
		MainImageName: input.mainImageName ?? 'DefaultImgPurple',
		ClubType: input.clubType ?? 0,
		ClubhouseRoomId: input.clubhouseRoomId ?? null,
		CreatorAccountId: creatorAccountId,
		IsRRO: input.isRRO ?? false,
		MinLevel: input.minLevel ?? 0,
		State: 0,
		MemberCount: 0,
		CreatedAt: now,
	}
	await db.prepare('INSERT INTO club (data) VALUES (?1)').bind(JSON.stringify(stored)).run()

	// The creator is the club's first member, joining as its Creator.
	await setMembership(db, clubId, creatorAccountId, ClubMembershipType.Creator)
	const count = await syncMemberCount(db, clubId)
	return { ...toDto(stored), MemberCount: count }
}

/**
 * What each membership tier is allowed to do in a club. These are the defaults every
 * new club gets (co-owners can do everything, moderators can approve/ban, plain
 * members can do none of it); nothing edits them yet, so they're derived per club
 * rather than stored.
 */
export interface ClubPermission {
	ClubId: number
	Type: number
	ApproveMember: boolean
	BanUnban: boolean
	CreateEvent: boolean
	EditDetails: boolean
	EditPermissionSettings: boolean
	PostAnnouncement: boolean
}

function clubPermission(
	clubId: number,
	type: ClubMembershipType,
	granted: Partial<Omit<ClubPermission, 'ClubId' | 'Type'>> = {}
): ClubPermission {
	return {
		ClubId: clubId,
		Type: type,
		ApproveMember: false,
		BanUnban: false,
		CreateEvent: false,
		EditDetails: false,
		EditPermissionSettings: false,
		PostAnnouncement: false,
		...granted,
	}
}

/** The club-details payload the client reads from create/details. */
export interface ClubDetails {
	/**
	 * The club's gallery images as whole image records — the same `SavedImage` shape
	 * every other image on the site is served as. The client deserializes these into
	 * objects, so a bare array of names fails its parser ("expected '{'").
	 */
	AdditionalImages: SavedImage[]
	Club: Club
	ClubId: number
	CoownerPermissions: ClubPermission
	CustomTags: string[]
	MemberPermissions: ClubPermission
	ModeratorPermissions: ClubPermission
	MyMembershipType: number
}

/**
 * Build the club-details view for a caller. `MyMembershipType` is the caller's own
 * membership (0 = none, e.g. a signed-out viewer). Additional images (set via
 * `/additionalimage/{index}`) and custom tags (set via `modifydetails`) both come off
 * the club's blob.
 */
export async function getClubDetails(
	db: D1Database,
	club: Club,
	accountId: number | null
): Promise<ClubDetails> {
	return {
		AdditionalImages: await getClubGallery(db, club.ClubId),
		Club: club,
		ClubId: club.ClubId,
		CoownerPermissions: clubPermission(club.ClubId, ClubMembershipType.Coowner, {
			ApproveMember: true,
			BanUnban: true,
			CreateEvent: true,
			EditDetails: true,
			EditPermissionSettings: true,
			PostAnnouncement: true,
		}),
		CustomTags: await getClubCustomTags(db, club.ClubId),
		MemberPermissions: clubPermission(club.ClubId, ClubMembershipType.Member),
		ModeratorPermissions: clubPermission(club.ClubId, ClubMembershipType.Moderator, {
			ApproveMember: true,
			BanUnban: true,
		}),
		MyMembershipType: accountId === null ? 0 : await getMembership(db, club.ClubId, accountId),
	}
}

/** A club announcement (mirror of the Go `ClubAnnouncement`). */
export interface ClubAnnouncement {
	AnnouncementId: number
	ClubId: number
	AccountId: number
	Title: string
	Body: string
	ImageName: string
	Meta: string
	CreatedAt: string | null
}

/** A club's announcements, newest first. An unknown club simply has none. */
export async function getClubAnnouncements(
	db: D1Database,
	clubId: number
): Promise<ClubAnnouncement[]> {
	const { results } = await db
		.prepare(
			`SELECT announcement_id, club_id, account_id, title, body, image_name, meta, created_at
			 FROM club_announcement
			 WHERE club_id = ?1
			 ORDER BY created_at DESC, announcement_id DESC`
		)
		.bind(clubId)
		.all<{
			announcement_id: number
			club_id: number
			account_id: number
			title: string
			body: string
			image_name: string
			meta: string
			created_at: string | null
		}>()

	return results.map((r) => ({
		AnnouncementId: r.announcement_id,
		ClubId: r.club_id,
		AccountId: r.account_id,
		Title: r.title,
		Body: r.body,
		ImageName: r.image_name,
		Meta: r.meta,
		CreatedAt: r.created_at,
	}))
}

/** Post an announcement to a club, returning its new id. */
export async function createClubAnnouncement(
	db: D1Database,
	clubId: number,
	accountId: number,
	fields: { title?: string; body?: string; imageName?: string; meta?: string }
): Promise<number> {
	const row = await db
		.prepare(
			`INSERT INTO club_announcement (club_id, account_id, title, body, image_name, meta, created_at)
			 VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)
			 RETURNING announcement_id`
		)
		.bind(
			clubId,
			accountId,
			fields.title ?? '',
			fields.body ?? '',
			fields.imageName ?? '',
			fields.meta ?? '',
			new Date().toISOString()
		)
		.first<{ announcement_id: number }>()
	return row?.announcement_id ?? 0
}

/** What club search answers: the page of clubs plus the total that matched. */
export interface ClubSearchResult {
	Clubs: Club[]
	ContinuationToken: null
	TotalClubs: number
}

/**
 * Club search (`/club/search`). Public, non-subscription clubs only. `category` is an
 * exact (case-insensitive) match, `query` a substring of the name or description.
 * `sort`: 1 = newest first, 2 = by name, anything else (including the client's 0) =
 * biggest first, then newest. `count` caps the page — out-of-range values fall back to
 * 30, as the reference does. `TotalClubs` is the full match count, not the page size.
 */
export async function searchClubs(
	db: D1Database,
	category: string,
	query: string,
	sort: string | undefined,
	count: number
): Promise<ClubSearchResult> {
	const { results } = await db
		.prepare(
			`SELECT data FROM club
			 WHERE visibility = ?1
			   AND json_extract(data, '$.ClubType') != ?2`
		)
		.bind(ClubVisibility.Public, SUBSCRIPTION_CLUB_TYPE)
		.all<ClubRow>()

	const stored = results.map((r) => JSON.parse(r.data) as StoredClub)
	const term = query.trim().toLowerCase()
	const wanted = category.trim().toLowerCase()

	const matched = stored.filter((club) => {
		if (wanted !== '' && club.Category.toLowerCase() !== wanted) return false
		if (term === '') return true
		return club.Name.toLowerCase().includes(term) || club.Description.toLowerCase().includes(term)
	})

	const byNewest = (a: StoredClub, b: StoredClub) => b.CreatedAt.localeCompare(a.CreatedAt)
	matched.sort((a, b) => {
		if (sort === '1') return byNewest(a, b)
		if (sort === '2') return a.Name.localeCompare(b.Name)
		return b.MemberCount - a.MemberCount || byNewest(a, b)
	})

	return {
		Clubs: matched.slice(0, count).map(toDto),
		ContinuationToken: null,
		TotalClubs: matched.length,
	}
}

/**
 * The player's "home club" — the one whose clubhouse they spawn into. It's a field
 * on the *account* row (owned by the `auth` worker, on the same shared database, the
 * way the `api` worker writes the account's profile image), not on the club: one
 * home club per player.
 *
 * Returns null when they haven't set one, when the club is gone, or when it has no
 * clubhouse room — a home club with nowhere to go isn't usable, and the reference
 * 404s all three cases identically.
 */
export async function getHomeClub(db: D1Database, accountId: number): Promise<Club | null> {
	const row = await db
		.prepare(
			"SELECT json_extract(data, '$.homeClubId') AS clubId FROM account WHERE account_id = ?1"
		)
		.bind(accountId)
		.first<{ clubId: number | null }>()
	if (row?.clubId == null) return null

	const club = await getClub(db, row.clubId)
	// `== null` catches a club row that predates the field (undefined), not just an
	// explicit null — either way it has no clubhouse to spawn into.
	if (club === null || club.ClubhouseRoomId == null) return null
	return club
}

/** Point the player's home club at `clubId` (stored on their account row). */
export async function setHomeClub(
	db: D1Database,
	accountId: number,
	clubId: number
): Promise<void> {
	await db
		// CAST to INTEGER — see syncMemberCount: a bound JS number lands as a REAL, so this
		// would otherwise store `"homeClubId":7.0`.
		.prepare(
			"UPDATE account SET data = json_set(data, '$.homeClubId', CAST(?2 AS INTEGER)) WHERE account_id = ?1"
		)
		.bind(accountId, clubId)
		.run()
}

/**
 * Drop the player's home club (the field is removed from their account row, not set
 * to 0 — `getHomeClub` reads a missing field as "no home club"). Idempotent.
 */
export async function clearHomeClub(db: D1Database, accountId: number): Promise<void> {
	await db
		.prepare("UPDATE account SET data = json_remove(data, '$.homeClubId') WHERE account_id = ?1")
		.bind(accountId)
		.run()
}

/** A club membership row, as the members list serves it (mirror of the Go `ClubMember`). */
export interface ClubMember {
	ClubMemberId: number
	ClubId: number
	AccountId: number
	MembershipType: number
	CreatedAt: string | null
}

/**
 * A club's members (`/club/:id/members`). `membershipType` filters to exactly that
 * tier when given — note it's an exact match, not a threshold, so `30` lists only
 * co-owners (not the creator above them). `sortBy` picks the order: 1 = by account
 * id, 2 = oldest membership first, anything else = the default, highest tier first
 * then oldest. An unknown club has no members, so it's an empty list, not a 404.
 */
export async function getClubMembers(
	db: D1Database,
	clubId: number,
	membershipType: number | undefined,
	sortBy: string | undefined
): Promise<ClubMember[]> {
	const order =
		sortBy === '1'
			? 'account_id ASC'
			: sortBy === '2'
				? 'created_at ASC'
				: 'membership_type DESC, created_at ASC'
	const filter = membershipType === undefined ? '' : 'AND membership_type = ?2'

	const { results } = await db
		.prepare(
			`SELECT club_member_id, club_id, account_id, membership_type, created_at
			 FROM club_member
			 WHERE club_id = ?1 ${filter}
			 ORDER BY ${order}`
		)
		.bind(...(membershipType === undefined ? [clubId] : [clubId, membershipType]))
		.all<{
			club_member_id: number
			club_id: number
			account_id: number
			membership_type: number
			created_at: string | null
		}>()

	return results.map((r) => ({
		ClubMemberId: r.club_member_id,
		ClubId: r.club_id,
		AccountId: r.account_id,
		MembershipType: r.membership_type,
		CreatedAt: r.created_at,
	}))
}

/** Fields `modifydetails` can change. Anything left undefined keeps its stored value. */
export interface ClubPatch {
	name?: string
	description?: string
	category?: string
	visibility?: number
	joinability?: number
	allowJuniors?: boolean
	mainImageName?: string
	minLevel?: number
	/** Replaces the club's tags wholesale when present; absent leaves them alone. */
	customTags?: string[]
	/** The club's clubhouse room; `null` clears it (undefined leaves it alone). */
	clubhouseRoomId?: number | null
}

/**
 * Apply an edit to a club's details (`modifydetails`). Only the keys present on the
 * patch change. Custom tags are replaced as a set — trimmed, de-duplicated
 * case-insensitively, first spelling wins. Returns the updated club, or null when
 * there's no such club.
 */
export async function updateClub(
	db: D1Database,
	clubId: number,
	patch: ClubPatch
): Promise<Club | null> {
	const row = await db
		.prepare('SELECT data FROM club WHERE club_id = ?1')
		.bind(clubId)
		.first<ClubRow>()
	if (row === null) return null
	const stored = JSON.parse(row.data) as StoredClub

	const updated: StoredClub = {
		...stored,
		Name: patch.name ?? stored.Name,
		Description: patch.description ?? stored.Description,
		Category: patch.category ?? stored.Category,
		Visibility: patch.visibility ?? stored.Visibility,
		Joinability: patch.joinability ?? stored.Joinability,
		AllowJuniors: patch.allowJuniors ?? stored.AllowJuniors,
		MainImageName: patch.mainImageName ?? stored.MainImageName,
		MinLevel: patch.minLevel ?? stored.MinLevel,
		CustomTags: patch.customTags === undefined ? stored.CustomTags : dedupeTags(patch.customTags),
		// `null` clears the clubhouse, so this can't collapse to `??`.
		ClubhouseRoomId:
			patch.clubhouseRoomId === undefined ? stored.ClubhouseRoomId : patch.clubhouseRoomId,
	}
	await db
		.prepare('UPDATE club SET data = ?1 WHERE club_id = ?2')
		.bind(JSON.stringify(updated), clubId)
		.run()
	return toDto(updated)
}

/** Trim, drop blanks, and de-duplicate tags case-insensitively (first spelling wins). */
function dedupeTags(tags: string[]): string[] {
	const seen = new Set<string>()
	const out: string[] = []
	for (const raw of tags) {
		const tag = raw.trim()
		if (tag === '' || seen.has(tag.toLowerCase())) continue
		seen.add(tag.toLowerCase())
		out.push(tag)
	}
	return out
}

/** A club's gallery image names, in order (stored on the blob; `[]` when it has none). */
export async function getClubAdditionalImages(db: D1Database, clubId: number): Promise<string[]> {
	const row = await db
		.prepare('SELECT data FROM club WHERE club_id = ?1')
		.bind(clubId)
		.first<ClubRow>()
	return row === null ? [] : ((JSON.parse(row.data) as StoredClub).AdditionalImages ?? [])
}

/**
 * A club's gallery as the client reads it: the image record behind each name, in
 * order. A name whose metadata row is missing falls back to a placeholder record so
 * the picture still renders.
 */
export async function getClubGallery(db: D1Database, clubId: number): Promise<SavedImage[]> {
	const names = await getClubAdditionalImages(db, clubId)
	if (names.length === 0) return []
	const records = await getSavedImagesByNames(db, names)
	return names.map((name) => records.get(name) ?? placeholderSavedImage(name))
}

/**
 * Set (or remove, with an empty `imageName`) one of a club's gallery images. The list
 * stays packed: removing an image shifts the ones after it up, and setting an index
 * past the end appends rather than leaving a gap. Returns null when the club doesn't
 * exist; the caller validates the index is in range.
 */
export async function setClubAdditionalImage(
	db: D1Database,
	clubId: number,
	index: number,
	imageName: string
): Promise<Club | null> {
	const row = await db
		.prepare('SELECT data FROM club WHERE club_id = ?1')
		.bind(clubId)
		.first<ClubRow>()
	if (row === null) return null
	const stored = JSON.parse(row.data) as StoredClub

	const images = [...(stored.AdditionalImages ?? [])]
	if (imageName === '') {
		// Removing past the end is a no-op, not an error: the image is already gone.
		if (index < images.length) images.splice(index, 1)
	} else if (index < images.length) {
		images[index] = imageName
	} else if (images.length < MAX_ADDITIONAL_IMAGES) {
		images.push(imageName)
	}

	const updated: StoredClub = { ...stored, AdditionalImages: images }
	await db
		.prepare('UPDATE club SET data = ?1 WHERE club_id = ?2')
		.bind(JSON.stringify(updated), clubId)
		.run()
	return toDto(updated)
}

/** A club's custom tags (stored on the blob; empty when it has none). */
export async function getClubCustomTags(db: D1Database, clubId: number): Promise<string[]> {
	const row = await db
		.prepare('SELECT data FROM club WHERE club_id = ?1')
		.bind(clubId)
		.first<ClubRow>()
	return row === null ? [] : ((JSON.parse(row.data) as StoredClub).CustomTags ?? [])
}

/** Look up a single club by its ClubId. */
export async function getClub(db: D1Database, clubId: number): Promise<Club | null> {
	return parseOne(
		await db.prepare('SELECT data FROM club WHERE club_id = ?1').bind(clubId).first<ClubRow>()
	)
}

/** The two club fields other workers read without wanting the whole DTO. */
export interface ClubSummary {
	clubId: number
	name: string
	/** The room players spawn into for this club; null when it has no clubhouse. */
	clubhouseRoomId: number | null
}

/**
 * Look up just a club's name and clubhouse room. Null when there's no such club.
 * A narrow projection rather than {@link getClub} — `match` only needs the room to
 * send a player to, and shouldn't parse (or depend on) the whole blob to get it.
 */
export async function getClubSummary(db: D1Database, clubId: number): Promise<ClubSummary | null> {
	const row = await db
		.prepare(
			`SELECT json_extract(data, '$.Name') AS name,
			        json_extract(data, '$.ClubhouseRoomId') AS clubhouseRoomId
			 FROM club WHERE club_id = ?1`
		)
		.bind(clubId)
		.first<{ name: string | null; clubhouseRoomId: number | null }>()
	if (row === null) return null
	return { clubId, name: row.name ?? '', clubhouseRoomId: row.clubhouseRoomId }
}

/**
 * Delete a club and everything hanging off it — its memberships and announcements —
 * and clear it from the home club of anyone who'd set it. Returns false when there
 * was no such club. Batched so a half-deleted club can't be left behind.
 */
export async function deleteClub(db: D1Database, clubId: number): Promise<boolean> {
	if ((await getClub(db, clubId)) === null) return false
	await db.batch([
		db.prepare('DELETE FROM club_member WHERE club_id = ?1').bind(clubId),
		db.prepare('DELETE FROM club_announcement WHERE club_id = ?1').bind(clubId),
		// The account table belongs to the auth worker; a dangling homeClubId already
		// reads as "no home club" (getHomeClub), but leaving it would point at whatever
		// club later reuses the id.
		db
			.prepare(
				`UPDATE account SET data = json_remove(data, '$.homeClubId')
				 WHERE json_extract(data, '$.homeClubId') = ?1`
			)
			.bind(clubId),
		db.prepare('DELETE FROM club WHERE club_id = ?1').bind(clubId),
	])
	return true
}

/**
 * One row of the "most active clubhouses right now" search: a club, the room its
 * clubhouse is, and how many players are standing in that room this second.
 */
export interface ActiveClubhouse {
	RoomId: number
	ClubId: number
	PlayerCount: number
}

/**
 * The most a single "most active now" answer carries. It fills a carousel, not a
 * directory — nobody scrolls past the busiest few clubhouses — and the query behind it
 * scans live presence, so it stays bounded rather than growing with the club table.
 */
export const MOST_ACTIVE_CLUBHOUSE_LIMIT = 50

/**
 * Clubhouses with players in them right now, busiest first — what
 * `match`'s `/clubhousesearch/mostactivenow` serves.
 *
 * Active means someone is THERE: a club whose clubhouse is empty is absent from the
 * result rather than listed with a `PlayerCount` of 0, and a club with no clubhouse at
 * all can never appear (nothing joins to a null room). So a quiet server answers `[]`.
 *
 * Same eligibility as {@link searchClubs}, since this is a search too: public,
 * non-subscription clubs only. Ties break on ClubId so equally busy clubhouses hold a
 * stable order between calls. Counts unexpired presence only, and ignores lobby presence
 * (no instance) the way every other head-count here does.
 */
export async function getMostActiveClubhouses(
	db: D1Database,
	limit = MOST_ACTIVE_CLUBHOUSE_LIMIT,
	now = Math.floor(Date.now() / 1000)
): Promise<ActiveClubhouse[]> {
	// One grouped join rather than a count per club: the club blobs never cross the wire,
	// only the clubhouse id `json_extract` pulls out of each.
	const { results } = await db
		.prepare(
			`SELECT c.club_id AS ClubId,
			        json_extract(c.data, '$.ClubhouseRoomId') AS RoomId,
			        COUNT(*) AS PlayerCount
			 FROM club c
			 JOIN presence p ON p.room_id = json_extract(c.data, '$.ClubhouseRoomId')
			 WHERE c.visibility = ?1
			   AND json_extract(c.data, '$.ClubType') != ?2
			   AND p.expires_at > ?3
			   AND p.room_instance_id IS NOT NULL
			 GROUP BY c.club_id
			 ORDER BY PlayerCount DESC, c.club_id
			 LIMIT ?4`
		)
		.bind(ClubVisibility.Public, SUBSCRIPTION_CLUB_TYPE, now, limit)
		.all<ActiveClubhouse>()
	return results
}

/**
 * Subscription clubs (`ClubType` 1) are a creator's paid-subscriber club, not a
 * club you browse or list among your own — they're excluded from the "my clubs"
 * lists (the client reaches them through the `/subscription/*` endpoints instead).
 */
const SUBSCRIPTION_CLUB_TYPE = 1

/**
 * How many clubs an account has made, for the per-account club cap. Subscription
 * clubs don't count — they're provisioned for a creator's subscribers rather than
 * made by hand, so they shouldn't eat a slot.
 */
export async function countClubsByCreator(db: D1Database, accountId: number): Promise<number> {
	const row = await db
		.prepare(
			`SELECT COUNT(*) AS n FROM club
			 WHERE creator_account_id = ?1
			   AND json_extract(data, '$.ClubType') != ?2`
		)
		.bind(accountId, SUBSCRIPTION_CLUB_TYPE)
		.first<{ n: number }>()
	return row?.n ?? 0
}

/** All clubs created by an account (GetMyCreatedClubs), oldest first. */
export async function getClubsByCreator(db: D1Database, accountId: number): Promise<Club[]> {
	const { results } = await db
		.prepare(
			`SELECT data FROM club
			 WHERE creator_account_id = ?1
			   AND json_extract(data, '$.ClubType') != ?2
			 ORDER BY json_extract(data, '$.CreatedAt') ASC`
		)
		.bind(accountId, SUBSCRIPTION_CLUB_TYPE)
		.all<ClubRow>()
	return parseAll(results)
}

/**
 * All clubs an account is an actual member of (GetMyMembershipClubs), oldest club
 * first. Only memberships at/above `Member` count — pending requests, denied
 * requests, and bans are excluded. Joins `club_member` to `club`, so a membership
 * whose club is gone is simply absent.
 */
export async function getClubsByMember(db: D1Database, accountId: number): Promise<Club[]> {
	const { results } = await db
		.prepare(
			`SELECT c.data AS data
			 FROM club_member m
			 JOIN club c ON c.club_id = m.club_id
			 WHERE m.account_id = ?1 AND m.membership_type >= ?2
			   AND json_extract(c.data, '$.ClubType') != ?3
			 ORDER BY json_extract(c.data, '$.CreatedAt') ASC`
		)
		.bind(accountId, MEMBER_THRESHOLD, SUBSCRIPTION_CLUB_TYPE)
		.all<ClubRow>()
	return parseAll(results)
}

/** Whether an account is an actual member of a club (Member tier or above). */
export async function isClubMember(
	db: D1Database,
	clubId: number,
	accountId: number
): Promise<boolean> {
	return (await getMembership(db, clubId, accountId)) >= MEMBER_THRESHOLD
}

/**
 * Have `accountId` join a club. On an Open club they become a `Member` immediately;
 * on an InviteOnly/AskToJoin club the join is recorded as `PendingRequested` (an
 * approval flow, not yet a member). Idempotent for anyone already a member, and a
 * no-op for a banned account. Returns the club with its refreshed MemberCount, or
 * null when the club doesn't exist.
 */
export async function joinClub(
	db: D1Database,
	clubId: number,
	accountId: number
): Promise<Club | null> {
	const club = await getClub(db, clubId)
	if (!club) return null

	const current = await getMembership(db, clubId, accountId)
	// A ban can't be shed by re-joining, and an existing member/pending stays as-is.
	if (current === ClubMembershipType.Banned || current >= MEMBER_THRESHOLD) {
		return club
	}
	const next =
		club.Joinability === ClubJoinability.Open
			? ClubMembershipType.Member
			: ClubMembershipType.PendingRequested
	await setMembership(db, clubId, accountId, next)

	const count = await syncMemberCount(db, clubId)
	return { ...club, MemberCount: count }
}

/**
 * How a request to join resolved. `joined` is an Open club (no approval needed),
 * `requested` an AskToJoin club (now PendingRequested), `alreadyPending` a repeat
 * request, `alreadyMember` someone who's already in. `inviteOnly` and `banned` are
 * refusals — the caller can't get in this way.
 */
export type JoinRequestResult =
	'joined' | 'requested' | 'alreadyPending' | 'alreadyMember' | 'inviteOnly' | 'banned'

/**
 * Ask to join a club. Unlike `joinClub` this honours the club's Joinability strictly:
 * an InviteOnly club can only be entered through an invite, so a request is refused
 * rather than parked as pending. Returns the outcome plus the club with its refreshed
 * MemberCount, or null when the club doesn't exist.
 */
export async function requestToJoinClub(
	db: D1Database,
	clubId: number,
	accountId: number
): Promise<{ result: JoinRequestResult; club: Club } | null> {
	const club = await getClub(db, clubId)
	if (!club) return null

	const current = await getMembership(db, clubId, accountId)
	// A ban can't be shed by asking again, and existing members/requests stay as-is.
	if (current === ClubMembershipType.Banned) return { result: 'banned', club }
	if (current >= MEMBER_THRESHOLD) return { result: 'alreadyMember', club }
	if (current === ClubMembershipType.PendingRequested) return { result: 'alreadyPending', club }

	if (club.Joinability === ClubJoinability.InviteOnly) return { result: 'inviteOnly', club }

	const open = club.Joinability === ClubJoinability.Open
	await setMembership(
		db,
		clubId,
		accountId,
		open ? ClubMembershipType.Member : ClubMembershipType.PendingRequested
	)

	const count = await syncMemberCount(db, clubId)
	return { result: open ? 'joined' : 'requested', club: { ...club, MemberCount: count } }
}

/**
 * Remove `accountId`'s membership of a club (idempotent). A ban is preserved — you
 * can't clear it by leaving — but any member/pending row is dropped. Returns the
 * outcome plus the club with its refreshed MemberCount, or null when the club doesn't
 * exist. The club itself is left in place even when the last member leaves.
 *
 * The creator can't leave: a club with no owner has no one who can administer it, and
 * there's no ownership transfer, so they have to delete the club instead. `creator`
 * reports that refusal, with the club unchanged.
 */
export async function leaveClub(
	db: D1Database,
	clubId: number,
	accountId: number
): Promise<{ result: 'left' | 'creator'; club: Club } | null> {
	const club = await getClub(db, clubId)
	if (!club) return null

	const current = await getMembership(db, clubId, accountId)
	if (current === ClubMembershipType.Creator) return { result: 'creator', club }

	await db
		.prepare(
			'DELETE FROM club_member WHERE club_id = ?1 AND account_id = ?2 AND membership_type <> ?3'
		)
		.bind(clubId, accountId, ClubMembershipType.Banned)
		.run()
	const count = await syncMemberCount(db, clubId)
	return { result: 'left', club: { ...club, MemberCount: count } }
}

/**
 * Set an account's membership tier in a club — the invite / role-assignment write
 * behind `PUT /club/:id/members/invite`. Upserts the `club_member` row to
 * `membershipType` (adding the account when it wasn't a member, and overriding a prior
 * tier or ban), then refreshes the club's MemberCount. Returns the club with its fresh
 * count, or null when the club is gone. The caller is responsible for checking that the
 * tier is one it may grant and that the target isn't the club's Creator.
 */
export async function setMemberType(
	db: D1Database,
	clubId: number,
	accountId: number,
	membershipType: ClubMembershipType
): Promise<Club | null> {
	const club = await getClub(db, clubId)
	if (!club) return null
	await setMembership(db, clubId, accountId, membershipType)
	const count = await syncMemberCount(db, clubId)
	return { ...club, MemberCount: count }
}
