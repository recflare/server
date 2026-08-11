import { resolver } from 'hono-openapi'
import { z } from 'zod'

import type { OpenAPIV3_1 } from 'openapi-types'

/**
 * OpenAPI schemas for the clubs worker.
 *
 * IMPORTANT: these are DESCRIPTIVE ONLY. They are passed to `describeRoute` to
 * generate the spec and are never wired into `hono-openapi`'s `validator()`. Same
 * rationale as the auth/accounts/econ/match workers: a reverse-engineered protocol,
 * lenient handlers, no runtime validation.
 *
 * Do NOT add `.meta({ id })` to these schemas — with this hono-openapi + zod v4 setup a
 * meta'd schema used in a response emits a `$ref` the framework doesn't always hoist
 * into `components.schemas`, leaving a dangling reference. Leaving meta off makes every
 * schema inline, which renders correctly in any tool.
 */

/** Emit a zod schema as an `application/json` response body. */
export function json(schema: z.ZodType, description: string) {
	return { description, content: { 'application/json': { schema: resolver(schema) } } }
}

function toOpenApiSchema(schema: z.ZodType): OpenAPIV3_1.SchemaObject {
	const { $schema: _$schema, additionalProperties: _extra, ...jsonSchema } = z.toJSONSchema(schema)
	return jsonSchema as OpenAPIV3_1.SchemaObject
}

/** A form-urlencoded / multipart request body (the client posts both). */
export function form(schema: z.ZodType, description: string): OpenAPIV3_1.RequestBodyObject {
	const s = toOpenApiSchema(schema)
	return {
		description,
		content: {
			'application/x-www-form-urlencoded': { schema: s },
			'multipart/form-data': { schema: s },
		},
	}
}

/** An `application/json` request body. */
export function jsonBody(schema: z.ZodType, description: string): OpenAPIV3_1.RequestBodyObject {
	return { description, content: { 'application/json': { schema: toOpenApiSchema(schema) } } }
}

/** The empty-body 401 the auth-gated routes return. */
export const UNAUTHORIZED_RESPONSE = { description: 'Missing or invalid bearer token (empty body)' }

/** Bearer-JWT security requirement, for the auth-gated routes. */
export const AUTHED = [{ bearerAuth: [] }]

/** An opaque JSON array — the empty-list stubs (`[]`) the client still expects. */
export const JsonArray = z.array(z.unknown())

/** An empty JSON object — the stub shape the client deserializes into an object. */
export const EmptyObject = z.object({})

// ---- Core entities ---------------------------------------------------------

/**
 * The client-facing club DTO (mirror of the Go `Club` JSON tags). The stored blob also
 * carries `CreatedAt`, `CustomTags` and `AdditionalImages`, none of which are on this
 * object — the tags and gallery are served on the details view instead.
 */
export const ClubDto = z.object({
	ClubId: z.int(),
	Name: z.string().describe('At most 40 characters; letters, digits and basic punctuation'),
	Description: z.string(),
	Category: z.string().describe('One of the /club/categoryTags values; defaults to Social'),
	Visibility: z.int().describe('ClubVisibility: 0 = Private, 1 = Public'),
	Joinability: z.int().describe('ClubJoinability: 0 = Open, 1 = InviteOnly, 2 = AskToJoin'),
	AllowJuniors: z.boolean(),
	MainImageName: z.string().describe('An image name from the storage worker; DefaultImgPurple'),
	ClubType: z.int().describe('0 = a regular club; 1 = a subscription club (never listed)'),
	ClubhouseRoomId: z.int().nullable().describe('The room a home-club member spawns into'),
	CreatorAccountId: z.int(),
	IsRRO: z.boolean(),
	MinLevel: z.int(),
	State: z.int(),
	MemberCount: z.int().describe('Derived from the club_member rows at/above Member (10)'),
})

/**
 * An image record as every image on the site is served (`SavedImage`). A club's gallery
 * serves these whole — see AdditionalImages on the details view.
 */
export const SavedImageDto = z.object({
	Id: z.int(),
	Type: z.int().describe('SavedImageType: 1 = share camera, 3 = room, 4 = profile, …'),
	Accessibility: z.int(),
	AccessibilityLocked: z.boolean(),
	ImageName: z.string().describe('The bucket key the img worker serves it back by'),
	Description: z.string().nullable(),
	PlayerId: z.int(),
	TaggedPlayerIds: z.array(z.int()),
	RoomId: z.int().nullable(),
	PlayerEventId: z.int().nullable(),
	CreatedAt: z.string(),
	CheerCount: z.int(),
	CommentCount: z.int(),
})

/**
 * What a membership tier may do in a club. These are the defaults every club gets
 * (co-owners everything, moderators approve/ban, members none); nothing edits them yet,
 * so they're derived per club rather than stored.
 */
export const ClubPermissionDto = z.object({
	ClubId: z.int(),
	Type: z.int().describe('The ClubMembershipType tier these permissions describe'),
	ApproveMember: z.boolean(),
	BanUnban: z.boolean(),
	CreateEvent: z.boolean(),
	EditDetails: z.boolean(),
	EditPermissionSettings: z.boolean(),
	PostAnnouncement: z.boolean(),
})

/**
 * The club-details payload the client renders a club screen from: the club, its tags,
 * the per-tier permissions, its gallery, and the caller's own membership.
 */
export const ClubDetailsDto = z.object({
	AdditionalImages: z
		.array(SavedImageDto)
		.describe(
			[
				'The club’s gallery as WHOLE image records, not image names — the client',
				'deserializes each entry into an object, so a bare array of names fails its parser',
				'("expected \'{\'"). The list is packed and in order: removing an image shifts the',
				'rest up, never leaving a blank slot.',
			].join(' ')
		),
	Club: ClubDto,
	ClubId: z.int(),
	CoownerPermissions: ClubPermissionDto,
	CustomTags: z.array(z.string()).describe('Set wholesale by modifydetails’ repeated customTags'),
	MemberPermissions: ClubPermissionDto,
	ModeratorPermissions: ClubPermissionDto,
	MyMembershipType: z
		.int()
		.describe(
			[
				'The caller’s own ClubMembershipType: -1 banned, 0 none (also a signed-out viewer),',
				'1 pending request, 2 pending invite, 3 denied, 10 member, 20 moderator, 30 co-owner,',
				'100 creator',
			].join(' ')
		),
})

/** A club membership row, as the members list serves it (mirror of the Go `ClubMember`). */
export const ClubMemberDto = z.object({
	ClubMemberId: z.int(),
	ClubId: z.int(),
	AccountId: z.int(),
	MembershipType: z.int().describe('See MyMembershipType for the tiers'),
	CreatedAt: z.string().nullable().describe('When the membership row was first written'),
})

/** One entry on a club's noticeboard (mirror of the Go `ClubAnnouncement`). */
export const ClubAnnouncementDto = z.object({
	AnnouncementId: z.int(),
	ClubId: z.int(),
	AccountId: z.int().describe('Who posted it'),
	Title: z.string(),
	Body: z.string(),
	ImageName: z.string(),
	Meta: z.string(),
	CreatedAt: z.string().nullable(),
})

// ---- Envelopes -------------------------------------------------------------
//
// Most club writes answer the `{ error, success, value }` envelope with HTTP 200 (or
// 400/403 carrying the same shape with `success: false`). The envelope's `value` is the
// entity the client re-renders from, so routes that change a club return the FULL
// details view rather than a null value — `PUT /club/:id/clubhouse` left the old
// clubhouse on screen until it answered the details envelope.

/** The success envelope carrying a club's full details. */
export const ClubDetailsEnvelope = z.object({
	error: z.string(),
	success: z.boolean(),
	value: ClubDetailsDto,
})

/** The success envelope carrying a bare club (`PUT /club/home/me`). */
export const ClubEnvelope = z.object({
	error: z.string(),
	success: z.boolean(),
	value: ClubDto,
})

/**
 * The envelope with nothing left to describe — clearing the home club, deleting a club.
 * Only used where the entity is genuinely gone; anything the client re-renders from
 * returns the details envelope instead.
 */
export const NullEnvelope = z.object({
	error: z.string(),
	success: z.boolean(),
	value: z.null(),
})

/** A rejected action: the same envelope, carrying the message the client shows. */
export const ErrorEnvelope = z.object({
	error: z.string().describe('The message shown to the player'),
	success: z.boolean().describe('Always false'),
	value: z.null(),
})

/** The envelope carrying a club's members (`GET /club/:clubId/members`). */
export const ClubMembersEnvelope = z.object({
	error: z.string(),
	success: z.boolean(),
	value: z.array(ClubMemberDto),
})

/** The envelope carrying a club's noticeboard (`GET /announcements/club/:clubId`). */
export const ClubAnnouncementsEnvelope = z.object({
	error: z.string(),
	success: z.boolean(),
	value: z.object({
		Announcements: z.array(ClubAnnouncementDto).describe('Newest first'),
		ClubId: z.int(),
		LastAnnouncementId: z.int().nullable().describe('The newest one; null when there are none'),
		LastReadAnnouncementId: z.int().describe('Always 0 — nothing tracks read state yet'),
	}),
})

/** The envelope carrying a new announcement's id (`POST /announcements/club/:clubId`). */
export const AnnouncementIdEnvelope = z.object({
	error: z.string(),
	success: z.boolean(),
	value: z.int().describe('The new announcement’s id'),
})

// ---- Other response shapes -------------------------------------------------

/** `GET /club/search` — a page of clubs plus the full match count. */
export const ClubSearchResponse = z.object({
	Clubs: z.array(ClubDto),
	ContinuationToken: z.null().describe('Always null — the whole page is served at once'),
	TotalClubs: z.int().describe('How many clubs matched, not the page size'),
})

/** `GET /subscription/details/:accountId` — simulated: no club, no subscribers. */
export const SubscriptionDetailsResponse = z.object({
	accountId: z.int(),
	clubId: z.int().describe('Always 0 — no subscription clubs yet'),
	subscriberCount: z.int().describe('Always 0'),
})

/** The set of category tags a club can be filed under — a fixed list. */
export const CategoryTags = z.array(z.string())

/** `GET /subscription/subscriberCount/:accountId` — a bare JSON integer. */
export const SubscriberCountResponse = z
	.int()
	.describe('Always 0 — there are no club subscriptions yet')

/**
 * `GET /club/:clubId/hasDisabledClubChat` — a bare JSON boolean, like the other
 * `is…`/`has…` gates the client polls. Nothing can turn club chat off yet, so it's
 * always false; not in the reference, so if the client chokes on this it likely wants
 * the `{ error, success, value }` envelope the other club endpoints use.
 */
export const ChatDisabledResponse = z.boolean()

// ---- Request schemas -------------------------------------------------------
//
// Every write takes a form body (urlencoded or multipart — the client posts both) with
// lowercase field names; the handlers match field names case-insensitively.

/** `POST /club/create` form body. */
export const CreateClubRequest = z.object({
	name: z
		.string()
		.describe('Required; at most 40 characters, letters/digits/basic punctuation only'),
	description: z.string().optional().describe('At most 512 characters'),
	category: z.string().optional().describe('Defaults to Social when unset'),
	visibility: z.string().optional().describe('By name (`Public`/`Private`) or number'),
	joinability: z
		.string()
		.optional()
		.describe('By name (`Open`/`InviteOnly`/`AskToJoin`) or number'),
	allowJuniors: z.string().optional().describe('`True`/`false`/`1`/`yes`'),
	mainImageName: z.string().optional(),
	minLevel: z.string().optional(),
})

/** `PUT /club/:clubId/modifydetails` (and `/modify`) form body. */
export const ModifyClubRequest = z.object({
	name: z
		.string()
		.optional()
		.describe('At most 40 characters. Empty means unchanged, not "clear it"'),
	description: z.string().optional().describe('At most 512 characters. Empty means unchanged'),
	category: z.string().optional(),
	visibility: z.string().optional().describe('By name (`Public`/`Private`) or number'),
	joinability: z
		.string()
		.optional()
		.describe('By name (`Open`/`InviteOnly`/`AskToJoin`) or number'),
	allowJuniors: z.string().optional().describe('`True`/`false`/`1`/`yes`'),
	mainImageName: z.string().optional(),
	minLevel: z.string().optional(),
	customTags: z
		.array(z.string())
		.optional()
		.describe('May repeat; when present it replaces the club’s tag set wholesale'),
})

/** `PUT /club/home/me` form body. */
export const HomeClubRequest = z.object({
	clubId: z.string().describe('The club to make home; the caller must be a member of it'),
})

/** `PUT /club/:clubId/minlevel` form body. */
export const MinLevelRequest = z.object({
	minLevel: z.string().describe('The minimum player level to join; negative/NaN is 400'),
})

/** `PUT /club/:clubId/clubhouse` form body. */
export const ClubhouseRequest = z.object({
	roomId: z.string().optional().describe('The clubhouse room; omitting it clears the clubhouse'),
})

/** `PUT /club/:clubId/mainimage` and `/additionalimage/:index` form body. */
export const ImageNameRequest = z.object({
	imageName: z.string().describe('The image name the `storage` worker handed back'),
})

/** `PUT /club/:clubId/members/invite` form body. */
export const InviteMemberRequest = z.object({
	accountId: z.string().describe('The account to add to the club; a positive integer'),
	membershipType: z
		.string()
		.optional()
		.describe('The tier to grant — 10 Member, 20 Moderator, 30 Co-owner; defaults to Member'),
})

/** `POST /announcements/club/:clubId` form body. */
export const AnnouncementRequest = z.object({
	title: z.string().optional(),
	body: z.string().optional(),
	imageName: z.string().optional(),
	meta: z.string().optional(),
})
