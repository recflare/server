import { Hono } from 'hono'
import { describeRoute, openAPIRouteHandler } from 'hono-openapi'
import { useWorkersLogger } from 'workers-tagged-logger'

import {
	clearHomeClub,
	ClubJoinability,
	ClubMembershipType,
	ClubVisibility,
	countClubsByCreator,
	createClub,
	createClubAnnouncement,
	deleteClub,
	getClub,
	getClubAnnouncements,
	getClubDetails,
	getClubMembers,
	getClubsByCreator,
	getClubsByMember,
	getHomeClub,
	getMembership,
	glyphLength,
	joinClub,
	leaveClub,
	MAX_ADDITIONAL_IMAGES,
	MAX_CLUB_DESCRIPTION_LENGTH,
	MAX_CLUB_NAME_LENGTH,
	requestToJoinClub,
	searchClubs,
	setClubAdditionalImage,
	setHomeClub,
	setMemberType,
	updateClub,
} from '@repo/domain'
import { intVar, logger, withCleanSpec, withNotFound, withOnError } from '@repo/hono-helpers'
import { validateAndGetAccountId } from '@repo/jwt'

import {
	AnnouncementIdEnvelope,
	AnnouncementRequest,
	AUTHED,
	CategoryTags,
	ChatDisabledResponse,
	ClubAnnouncementsEnvelope,
	ClubDetailsDto,
	ClubDetailsEnvelope,
	ClubDto,
	ClubEnvelope,
	ClubhouseRequest,
	ClubMembersEnvelope,
	ClubSearchResponse,
	CreateClubRequest,
	EmptyObject,
	ErrorEnvelope,
	form,
	HomeClubRequest,
	ImageNameRequest,
	InviteMemberRequest,
	json,
	JsonArray,
	MinLevelRequest,
	ModifyClubRequest,
	NullEnvelope,
	SubscriberCountResponse,
	SubscriptionDetailsResponse,
	UNAUTHORIZED_RESPONSE,
} from './openapi'

import type { Context } from 'hono'
import type { App } from './context'

/**
 * Clubs Worker. Hosts the club endpoints the game client calls on the `clubs` host:
 * club creation and editing, membership (join / ask-to-join / leave / ban tiers),
 * search, announcements, the club gallery, a club's clubhouse room, and each player's
 * home club. Everything is D1-backed (the shared `recflare` database); the
 * `/subscription/*` routes are stubs, since there are no subscription clubs yet.
 *
 * Auth-gated routes validate the Bearer JWT issued by the `auth` worker.
 */

/** The `clubId` path parameter, shared by every per-club route. */
const CLUB_ID_PARAM = {
	name: 'clubId',
	in: 'path',
	required: true,
	description: 'The club’s id (digits only — a non-numeric id doesn’t match the route)',
	schema: { type: 'string' },
} as const

/**
 * Resolve the account id from a Bearer token. Returns `null` when the header is
 * missing, the token is invalid, or the `sub` claim isn't an integer.
 */
async function authedId(c: Context<App>): Promise<number | null> {
	return validateAndGetAccountId(c.req.raw, await c.env.JWT_SECRET.get())
}

/**
 * How many clubs one account may create, when the `MAX_CLUBS_PER_ACCOUNT` var is
 * unset. Counts the clubs the account created (subscription clubs excluded — those
 * aren't made by hand). Setting the var to 0 lifts the cap entirely. Existing clubs
 * are never touched: lowering the cap just stops new ones.
 */
const DEFAULT_MAX_CLUBS_PER_ACCOUNT = 10


/**
 * The tiers `members/invite` may grant — the real member roles only. Creator (100) is
 * excluded so an invite can't mint a second owner, and the pending/none/banned states
 * aren't something you "invite" someone to.
 */
const INVITABLE_TIERS: ReadonlySet<number> = new Set([
	ClubMembershipType.Member,
	ClubMembershipType.Moderator,
	ClubMembershipType.Coowner,
])

/** The punctuation a club name may use, on top of letters and digits. */
const ALLOWED_NAME_PUNCTUATION = new Set(` .,'!?-_&()#@:+`)

/**
 * Club names are letters (any Latin script), digits, and basic punctuation — the
 * reference's IsValidName. Anything else (emoji, other scripts, control chars) is
 * rejected rather than stored.
 */
function isValidClubName(name: string): boolean {
	return [...name.normalize('NFC')].every(
		(ch) => /\p{Script=Latin}|\p{Nd}/u.test(ch) || ALLOWED_NAME_PUNCTUATION.has(ch)
	)
}

/** A rejected club action: the same envelope as success, carrying the message. */
function clubError(c: Context<App>, message: string) {
	return c.json({ error: message, success: false, value: null }, 400)
}

/**
 * The client sends enums by *name* (`visibility=Public`, `joinability=Open`), not by
 * number — though the numbers are accepted too. An unrecognized value is undefined,
 * and leaves the field unchanged rather than resetting it.
 */
function parseVisibility(value: string | undefined): number | undefined {
	switch (value?.trim().toLowerCase()) {
		case 'private':
		case '0':
			return ClubVisibility.Private
		case 'public':
		case '1':
			return ClubVisibility.Public
		default:
			return undefined
	}
}

function parseJoinability(value: string | undefined): number | undefined {
	switch (value?.trim().toLowerCase().replace(/_/g, '')) {
		case 'open':
		case '0':
			return ClubJoinability.Open
		case 'inviteonly':
		case '1':
			return ClubJoinability.InviteOnly
		// The client calls this AskToJoin; the reference parses it as RequestToJoin.
		case 'asktojoin':
		case 'requesttojoin':
		case '2':
			return ClubJoinability.AskToJoin
		default:
			return undefined
	}
}

/** Form booleans arrive as `True`/`false`/`1`/`yes`. */
function parseFormBool(value: string | undefined): boolean | undefined {
	switch (value?.trim().toLowerCase()) {
		case 'true':
		case '1':
		case 'yes':
			return true
		case 'false':
		case '0':
		case 'no':
			return false
		default:
			return undefined
	}
}

const app = new Hono<App>()
	.use(
		'*',
		// middleware
		(c, next) =>
			useWorkersLogger(c.env.NAME, {
				environment: c.env.ENVIRONMENT,
				release: c.env.SENTRY_RELEASE,
			})(c, next)
	)

	.onError(withOnError())
	.notFound(withNotFound())

	// The player's home club — the one whose clubhouse they spawn into, stored on their
	// account. Auth-gated. 404 when they have no home club, the club is gone, or it has
	// no clubhouse room: the client expects a 404 for "no home club" and errors on an
	// empty object. Returns the bare club (not the envelope), as the reference does.
	.get(
		'/club/home/me',
		describeRoute({
			tags: ['Home club'],
			summary: 'The player’s home club',
			description: [
				'The club whose clubhouse the player spawns into (a field on their account row).',
				'404 when they have no home club, the club is gone, or it has no clubhouse room —',
				'the client expects a 404 for “no home club” and errors on an empty object. Returns',
				'the bare club, not the envelope, as the reference does.',
			].join(' '),
			security: AUTHED,
			responses: {
				200: json(ClubDto, 'The player’s home club'),
				401: UNAUTHORIZED_RESPONSE,
				404: { description: 'No home club, or it has no clubhouse room' },
			},
		}),
		async (c) => {
			const id = await authedId(c)
			if (id === null) return c.body(null, 401)
			const club = await getHomeClub(c.env.DB, id)
			return club === null ? c.notFound() : c.json(club)
		}
	)

	// Set the player's home club (`clubId` form field). They must be a member of it —
	// you can't make a club you don't belong to your home. Answers the envelope.
	.put(
		'/club/home/me',
		describeRoute({
			tags: ['Home club'],
			summary: 'Set the player’s home club',
			description: [
				'Points the player’s home club at the posted `clubId`. They must already be a member',
				'of it — you can’t make a club you don’t belong to your home. Answers the envelope',
				'carrying the bare club.',
			].join(' '),
			security: AUTHED,
			requestBody: form(HomeClubRequest, 'The club to make home'),
			responses: {
				200: json(ClubEnvelope, 'The envelope carrying the new home club'),
				400: json(ErrorEnvelope, 'Missing, non-numeric or zero clubId'),
				401: UNAUTHORIZED_RESPONSE,
				403: json(ErrorEnvelope, 'The caller isn’t a member of that club'),
				404: { description: 'No such club' },
			},
		}),
		async (c) => {
			const id = await authedId(c)
			if (id === null) return c.body(null, 401)

			const body = (await c.req.parseBody().catch(() => ({}))) as Record<string, unknown>
			const key = Object.keys(body).find((k) => k.toLowerCase() === 'clubid')
			const clubId = Number.parseInt(
				typeof body[key ?? ''] === 'string' ? String(body[key ?? '']) : '',
				10
			)
			if (Number.isNaN(clubId) || clubId === 0) return clubError(c, 'Invalid clubId.')

			const club = await getClub(c.env.DB, clubId)
			if (club === null) return c.notFound()

			const membership = await getMembership(c.env.DB, clubId, id)
			if (membership < ClubMembershipType.Member) {
				return c.json(
					{ error: 'You are not a member of that club.', success: false, value: null },
					403
				)
			}

			await setHomeClub(c.env.DB, id, clubId)
			return c.json({ error: '', success: true, value: club })
		}
	)

	// Clear the player's home club — they spawn into the default hub again instead of a
	// clubhouse. No body, idempotent (clearing when there's none set is a no-op, not a
	// 404), and it doesn't touch their membership of the club. The envelope's value is
	// null because there's no home club left to describe; GET goes back to 404ing.
	.delete(
		'/club/home/me',
		describeRoute({
			tags: ['Home club'],
			summary: 'Clear the player’s home club',
			description: [
				'The player spawns into the default hub again instead of a clubhouse. No body,',
				'idempotent (clearing when none is set is a no-op, not a 404), and it doesn’t touch',
				'their membership of the club. The envelope’s `value` is null because there’s no home',
				'club left to describe; GET goes back to 404ing.',
			].join(' '),
			security: AUTHED,
			responses: {
				200: json(NullEnvelope, 'Cleared (value null)'),
				401: UNAUTHORIZED_RESPONSE,
			},
		}),
		async (c) => {
			const id = await authedId(c)
			if (id === null) return c.body(null, 401)
			await clearHomeClub(c.env.DB, id)
			return c.json({ error: '', success: true, value: null })
		}
	)

	// A real Rec Room client endpoint with no backing implementation yet. The
	// client calls it on the clubs host at /subscription/mine/member (no /club
	// prefix) and sends no auth header, so it isn't gated. Returns an empty
	// array = no club subscription memberships (the client chokes on null).
	.get(
		'/subscription/mine/member',
		describeRoute({
			tags: ['Subscriptions'],
			summary: 'The caller’s club-subscription memberships',
			description: [
				'A real client endpoint with no backing implementation yet. The client calls it on',
				'the clubs host at `/subscription/mine/member` (no `/club` prefix) and sends no auth',
				'header, so it isn’t gated. Always `[]` — no subscription memberships (the client',
				'chokes on null).',
			].join(' '),
			responses: { 200: json(JsonArray, 'Always empty for now') },
		}),
		(c) => c.json([])
	)

	// Subscription details for an account (numeric id) — simulated: no club, no subs.
	.get(
		'/subscription/details/:accountId{[0-9]+}',
		describeRoute({
			tags: ['Subscriptions'],
			summary: 'Subscription details for an account',
			description: 'Simulated — no subscription club, no subscribers.',
			parameters: [
				{
					name: 'accountId',
					in: 'path',
					required: true,
					description: 'Account id (digits only)',
					schema: { type: 'string' },
				},
			],
			responses: { 200: json(SubscriptionDetailsResponse, 'Zeroed subscription details') },
		}),
		(c) =>
			c.json({
				accountId: Number.parseInt(c.req.param('accountId'), 10),
				clubId: 0,
				subscriberCount: 0,
			})
	)

	// Details for a named subscription (e.g. `rrplus`). The client deserializes this
	// into an object, so it must return `{}` (not `[]`).
	.get(
		'/subscription/details/:subscription',
		describeRoute({
			tags: ['Subscriptions'],
			summary: 'Details for a named subscription',
			description: [
				'A named subscription (e.g. `rrplus`). The client deserializes this into an object,',
				'so it must return `{}` — not `[]`.',
			].join(' '),
			parameters: [
				{
					name: 'subscription',
					in: 'path',
					required: true,
					description: 'The subscription name, e.g. `rrplus`',
					schema: { type: 'string' },
				},
			],
			responses: { 200: json(EmptyObject, 'Always an empty object') },
		}),
		(c) => c.json({})
	)

	// Subscriber count for an account. No club subscriptions yet → 0.
	.get(
		'/subscription/subscriberCount/:accountId{[0-9]+}',
		describeRoute({
			tags: ['Subscriptions'],
			summary: 'Subscriber count for an account',
			description: 'No club subscriptions yet, so this is always 0. A bare JSON integer.',
			parameters: [
				{
					name: 'accountId',
					in: 'path',
					required: true,
					description: 'Account id (digits only)',
					schema: { type: 'string' },
				},
			],
			responses: { 200: json(SubscriberCountResponse, 'Always 0') },
		}),
		(c) => c.json(0)
	)

	// The player's clubs that have unread announcements (MyClubsWithUnread-
	// Announcements). Nothing tracks what a player has read yet → nothing is unread.
	.get(
		'/announcements/v2/mine/unread',
		describeRoute({
			tags: ['Announcements'],
			summary: 'The player’s clubs with unread announcements',
			description: [
				'MyClubsWithUnreadAnnouncements. Nothing tracks what a player has read yet, so',
				'nothing is unread → always `[]`.',
			].join(' '),
			responses: { 200: json(JsonArray, 'Always empty for now') },
		}),
		(c) => c.json([])
	)

	// The same unread lookup over the clubs the player SUBSCRIBES to, rather than the ones
	// they belong to. `sendAnnouncements=true` asks for the announcement bodies alongside
	// the clubs; nothing tracks read state yet, so nothing is unread either way and the
	// flag makes no difference to what we serve.
	.get(
		'/announcements/v2/subscription/mine/unread',
		describeRoute({
			tags: ['Announcements'],
			summary: 'The player’s subscribed clubs with unread announcements',
			description: [
				'The subscription-side counterpart of `/announcements/v2/mine/unread`. Nothing tracks',
				'what a player has read yet, so nothing is unread → always `[]`, whatever',
				'`sendAnnouncements` says.',
			].join(' '),
			parameters: [
				{
					name: 'sendAnnouncements',
					in: 'query',
					required: false,
					description: 'Whether to include the announcement bodies. Ignored — the list is empty.',
					schema: { type: 'boolean' },
				},
			],
			responses: { 200: json(JsonArray, 'Always empty for now') },
		}),
		(c) => c.json([])
	)

	// A club's announcements — its noticeboard, newest first. Public. Answers the
	// envelope, with `LastAnnouncementId` the newest one (null when there are none)
	// and `LastReadAnnouncementId` 0: nothing tracks read state yet.
	.get(
		'/announcements/club/:clubId{[0-9]+}',
		describeRoute({
			tags: ['Announcements'],
			summary: 'A club’s announcements',
			description: [
				'The club’s noticeboard, newest first. Public. Answers the envelope, with',
				'`LastAnnouncementId` the newest one (null when there are none) and',
				'`LastReadAnnouncementId` 0 — nothing tracks read state yet. An unknown club simply',
				'has no announcements.',
			].join(' '),
			parameters: [CLUB_ID_PARAM],
			responses: { 200: json(ClubAnnouncementsEnvelope, 'The club’s noticeboard') },
		}),
		async (c) => {
			const clubId = Number.parseInt(c.req.param('clubId'), 10)
			const announcements = await getClubAnnouncements(c.env.DB, clubId)
			return c.json({
				error: '',
				success: true,
				value: {
					Announcements: announcements,
					ClubId: clubId,
					LastAnnouncementId: announcements[0]?.AnnouncementId ?? null,
					LastReadAnnouncementId: 0,
				},
			})
		}
	)

	// Post an announcement to a club. Co-owner or above only. The envelope's value is
	// the new announcement's id.
	.post(
		'/announcements/club/:clubId{[0-9]+}',
		describeRoute({
			tags: ['Announcements'],
			summary: 'Post an announcement to a club',
			description: 'Co-owner or above only. The envelope’s `value` is the new announcement’s id.',
			security: AUTHED,
			parameters: [CLUB_ID_PARAM],
			requestBody: form(AnnouncementRequest, 'The announcement fields'),
			responses: {
				200: json(AnnouncementIdEnvelope, 'The new announcement’s id'),
				401: UNAUTHORIZED_RESPONSE,
				403: json(ErrorEnvelope, 'Below co-owner'),
				404: { description: 'No such club' },
			},
		}),
		async (c) => {
			const id = await authedId(c)
			if (id === null) return c.body(null, 401)

			const clubId = Number.parseInt(c.req.param('clubId'), 10)
			const club = await getClub(c.env.DB, clubId)
			if (club === null) return c.notFound()

			const membership = await getMembership(c.env.DB, clubId, id)
			if (membership < ClubMembershipType.Coowner) {
				return c.json({ error: 'Insufficient permissions.', success: false, value: null }, 403)
			}

			const body = (await c.req.parseBody().catch(() => ({}))) as Record<string, unknown>
			const field = (name: string): string | undefined => {
				const key = Object.keys(body).find((k) => k.toLowerCase() === name.toLowerCase())
				const v = key === undefined ? undefined : body[key]
				return typeof v === 'string' ? v : undefined
			}

			const announcementId = await createClubAnnouncement(c.env.DB, clubId, id, {
				title: field('title'),
				body: field('body'),
				imageName: field('imageName'),
				meta: field('meta'),
			})
			return c.json({ error: '', success: true, value: announcementId })
		}
	)

	// The clubs the player is a member of (GetMyMembershipClubs). Reads the caller's
	// memberships from `club_member`. A caller with no valid token has no clubs, so
	// this answers an empty list rather than 401ing — the client shows the "my clubs"
	// shelf either way, and an error there breaks the screen.
	.get(
		'/club/mine/member',
		describeRoute({
			tags: ['Clubs'],
			summary: 'The clubs the player is a member of',
			description: [
				'GetMyMembershipClubs — the caller’s memberships from `club_member`, oldest club',
				'first (pending/denied/banned rows excluded). A caller with no valid token has no',
				'clubs, so this answers `[]` rather than 401ing: the client shows the “my clubs”',
				'shelf either way, and an error there breaks the screen.',
			].join(' '),
			security: AUTHED,
			responses: { 200: json(ClubDto.array(), 'The caller’s clubs (empty when signed out)') },
		}),
		async (c) => {
			const id = await authedId(c)
			if (id === null) return c.json([])
			return c.json(await getClubsByMember(c.env.DB, id))
		}
	)

	// The clubs the player created (GetMyCreatedClubs). Empty list when signed out,
	// like mine/member.
	.get(
		'/club/mine/created',
		describeRoute({
			tags: ['Clubs'],
			summary: 'The clubs the player created',
			description: 'GetMyCreatedClubs, oldest first. Empty list when signed out, like mine/member.',
			security: AUTHED,
			responses: { 200: json(ClubDto.array(), 'The clubs the caller created') },
		}),
		async (c) => {
			const id = await authedId(c)
			if (id === null) return c.json([])
			return c.json(await getClubsByCreator(c.env.DB, id))
		}
	)

	// Club search / browse. Public, non-subscription clubs; `category` filters to that
	// category, `query` matches the name or description, `sort` picks the order (1 =
	// newest, 2 = by name, default = most members first), and `count` caps the page
	// (out of range → 30). Public. Answers `{ Clubs, ContinuationToken, TotalClubs }`.
	.get(
		'/club/search',
		describeRoute({
			tags: ['Clubs'],
			summary: 'Club search / browse',
			description: [
				'Public, non-subscription clubs. Public (no auth). `TotalClubs` is the full match',
				'count, not the page size.',
			].join(' '),
			parameters: [
				{
					name: 'category',
					in: 'query',
					required: false,
					description: 'Filter to one category (exact, case-insensitive)',
					schema: { type: 'string' },
				},
				{
					name: 'query',
					in: 'query',
					required: false,
					description: 'Substring of the club name or description',
					schema: { type: 'string' },
				},
				{
					name: 'sort',
					in: 'query',
					required: false,
					description: '1 = newest first, 2 = by name, anything else = most members first',
					schema: { type: 'string' },
				},
				{
					name: 'count',
					in: 'query',
					required: false,
					description: 'Page size; out of range (or absent) falls back to 30',
					schema: { type: 'string' },
				},
			],
			responses: { 200: json(ClubSearchResponse, 'The matching page of clubs') },
		}),
		async (c) => {
			const count = Number.parseInt(c.req.query('count') ?? '', 10)
			return c.json(
				await searchClubs(
					c.env.DB,
					c.req.query('category') ?? '',
					c.req.query('query') ?? '',
					c.req.query('sort'),
					Number.isNaN(count) || count <= 0 || count > 100 ? 30 : count
				)
			)
		}
	)

	// The set of club category tags a club can be filed under — a fixed list.
	.get(
		'/club/categoryTags',
		describeRoute({
			tags: ['Clubs'],
			summary: 'Club category tags',
			description: 'The fixed set of categories a club can be filed under.',
			responses: { 200: json(CategoryTags, 'The category list') },
		}),
		(c) => c.json(['Social', 'Creative', 'Competitive', 'Casual', 'Entertainment'])
	)

	// Create a club. The client posts a form to `/club/create` with lowercase fields
	// (`name`, `description`, `category`). Auth-gated. Answers the `{ error, success,
	// value }` envelope carrying the new club's details — not a bare club.
	.post(
		'/club/create',
		describeRoute({
			tags: ['Clubs'],
			summary: 'Create a club',
			description: [
				'The client posts a form with lowercase fields (`name`, `description`, `category`);',
				'either casing is accepted. Enums arrive by name (`visibility=Public`,',
				'`joinability=Open`). `ClubType` is never taken from the client — a player-created',
				'club is always a regular one, since letting the client pick would let it mint a',
				'subscription club (type 1), which is excluded from every listing. The caller becomes',
				'the club’s Creator. Answers the `{ error, success, value }` envelope carrying the new',
				'club’s full details — not a bare club.',
			].join(' '),
			security: AUTHED,
			requestBody: form(CreateClubRequest, 'The new club’s fields'),
			responses: {
				200: json(ClubDetailsEnvelope, 'The new club’s details'),
				400: json(
					ErrorEnvelope,
					'Missing/invalid/too-long name, or the per-account club limit is reached'
				),
				401: UNAUTHORIZED_RESPONSE,
			},
		}),
		async (c) => {
			const id = await authedId(c)
			if (id === null) return c.body(null, 401)

			const body = (await c.req.parseBody().catch(() => ({}))) as Record<string, unknown>
			// The client sends lowercase field names; accept either casing.
			const field = (name: string): string | undefined => {
				const key = Object.keys(body).find((k) => k.toLowerCase() === name.toLowerCase())
				const v = key === undefined ? undefined : body[key]
				return typeof v === 'string' ? v : undefined
			}
			const int = (v: string | undefined): number | undefined => {
				const n = v === undefined ? Number.NaN : Number.parseInt(v, 10)
				return Number.isNaN(n) ? undefined : n
			}

			const name = field('name')?.trim() ?? ''
			const description = field('description') ?? ''
			if (name === '') return clubError(c, 'You must enter a name for your club.')
			if (!isValidClubName(name)) {
				return clubError(c, 'Club names can only use letters, numbers, and basic punctuation.')
			}
			if ([...name].length > MAX_CLUB_NAME_LENGTH) {
				return clubError(c, `Club names can be at most ${MAX_CLUB_NAME_LENGTH} characters.`)
			}
			// Counted in code points like the name above, so an emoji-heavy description is
			// measured the way a player sees it rather than by UTF-16 units.
			if (glyphLength(description) > MAX_CLUB_DESCRIPTION_LENGTH) {
				return clubError(
					c,
					`Club descriptions can be at most ${MAX_CLUB_DESCRIPTION_LENGTH} characters.`
				)
			}
			// The per-account cap, checked after the cheap validations so a rejected name
			// costs no extra D1 read.
			const maxClubs = intVar(c.env.MAX_CLUBS_PER_ACCOUNT, DEFAULT_MAX_CLUBS_PER_ACCOUNT)
			if (maxClubs > 0 && (await countClubsByCreator(c.env.DB, id)) >= maxClubs) {
				logger.info('club create rejected: per-account club limit', { accountId: id })
				return clubError(c, `You can only have ${maxClubs} clubs.`)
			}

			const club = await createClub(c.env.DB, id, {
				name,
				description,
				// An unset category files the club under Social, as the reference does.
				category: field('category')?.trim() || 'Social',
				visibility: parseVisibility(field('visibility')),
				joinability: parseJoinability(field('joinability')),
				allowJuniors: parseFormBool(field('allowJuniors')),
				mainImageName: field('mainImageName'),
				// ClubType is deliberately not taken from the client: a player-created club
				// is always a regular one. Letting the client pick would let it mint a
				// subscription club (type 1), which is excluded from every club listing.
				minLevel: int(field('minLevel')),
			})
			return c.json({
				error: '',
				success: true,
				value: await getClubDetails(c.env.DB, club, id),
			})
		}
	)

	// Edit a club's details. The client PUTs a form of the fields it's changing —
	// enums by name (`visibility=Public`, `joinability=Open`, `allowJuniors=True`) —
	// and absent fields keep their stored value. `customTags` may repeat; when present
	// it replaces the club's tag set wholesale. Co-owner or above only. Answers the
	// same `{ error, success, value }` envelope create does.
	//
	// `/modify` is the same endpoint under the shorter name the client also PUTs to
	// (`name=…&description=…&category=…`); one handler, so the two can't drift.
	.on(
		'PUT',
		['/club/:clubId{[0-9]+}/modifydetails', '/club/:clubId{[0-9]+}/modify'],
		describeRoute({
			tags: ['Clubs'],
			summary: 'Edit a club’s details',
			description: [
				'The client PUTs a form of just the fields it’s changing — enums by name',
				'(`visibility=Public`, `joinability=Open`, `allowJuniors=True`) — and absent fields',
				'keep their stored value (an empty `name`/`description` means “unchanged”, not',
				'“clear it”). `customTags` may repeat; when present it replaces the club’s tag set',
				'wholesale. Co-owner or above only. `/modify` is the same endpoint under the shorter',
				'name the client also PUTs to — one handler, so the two can’t drift. Answers the same',
				'details envelope create does, since the client re-renders the club screen from it.',
			].join(' '),
			security: AUTHED,
			parameters: [CLUB_ID_PARAM],
			requestBody: form(ModifyClubRequest, 'The fields to change'),
			responses: {
				200: json(ClubDetailsEnvelope, 'The updated club’s details'),
				400: json(ErrorEnvelope, 'Invalid or too-long name'),
				401: UNAUTHORIZED_RESPONSE,
				403: json(ErrorEnvelope, 'Below co-owner'),
				404: { description: 'No such club' },
			},
		}),
		async (c) => {
			const id = await authedId(c)
			if (id === null) return c.body(null, 401)

			const clubId = Number.parseInt(c.req.param('clubId'), 10)
			const club = await getClub(c.env.DB, clubId)
			if (club === null) return c.notFound()

			// Editing details is a co-owner power — plain members and moderators can't.
			const membership = await getMembership(c.env.DB, clubId, id)
			if (membership < ClubMembershipType.Coowner) {
				return c.json({ error: 'Insufficient permissions.', success: false, value: null }, 403)
			}

			// `all: true` so a repeated `customTags` field arrives as a list.
			const body = (await c.req.parseBody({ all: true }).catch(() => ({}))) as Record<
				string,
				unknown
			>
			const field = (name: string): string | undefined => {
				const key = Object.keys(body).find((k) => k.toLowerCase() === name.toLowerCase())
				const v = key === undefined ? undefined : body[key]
				const first = Array.isArray(v) ? v[0] : v
				return typeof first === 'string' ? first : undefined
			}
			const list = (name: string): string[] | undefined => {
				const key = Object.keys(body).find((k) => k.toLowerCase() === name.toLowerCase())
				if (key === undefined) return undefined
				const v = body[key]
				const values = Array.isArray(v) ? v : [v]
				return values.filter((t): t is string => typeof t === 'string')
			}
			const int = (v: string | undefined): number | undefined => {
				const n = v === undefined ? Number.NaN : Number.parseInt(v, 10)
				return Number.isNaN(n) ? undefined : n
			}

			// An empty name/description means "unchanged", not "clear it" — the reference
			// only applies these when non-empty.
			const name = field('name')?.trim() || undefined
			if (name !== undefined) {
				if (!isValidClubName(name)) {
					return clubError(c, 'Club names can only use letters, numbers, and basic punctuation.')
				}
				if ([...name].length > MAX_CLUB_NAME_LENGTH) {
					return clubError(c, `Club names can be at most ${MAX_CLUB_NAME_LENGTH} characters.`)
				}
			}

			// Same absent-means-unchanged rule as the name, so a club with no description
			// isn't forced to grow one just to be edited.
			const description = field('description') || undefined
			if (description !== undefined && glyphLength(description) > MAX_CLUB_DESCRIPTION_LENGTH) {
				return clubError(
					c,
					`Club descriptions can be at most ${MAX_CLUB_DESCRIPTION_LENGTH} characters.`
				)
			}

			const updated = await updateClub(c.env.DB, clubId, {
				name,
				description,
				category: field('category')?.trim() || undefined,
				visibility: parseVisibility(field('visibility')),
				joinability: parseJoinability(field('joinability')),
				allowJuniors: parseFormBool(field('allowJuniors')),
				mainImageName: field('mainImageName') || undefined,
				minLevel: int(field('minLevel')),
				customTags: list('customTags'),
			})
			if (updated === null) return c.notFound()

			return c.json({
				error: '',
				success: true,
				value: await getClubDetails(c.env.DB, updated, id),
			})
		}
	)

	// A club's full details — the club plus its tags, the per-tier permissions, and the
	// caller's own membership. Public (a signed-out viewer just gets MyMembershipType
	// 0). Unlike create/modifydetails this one is *not* enveloped: the reference writes
	// the details object straight out.
	.get(
		'/club/:clubId{[0-9]+}/details',
		describeRoute({
			tags: ['Clubs'],
			summary: 'A club’s full details',
			description: [
				'The club plus its custom tags, the per-tier permissions, its gallery, and the',
				'caller’s own membership. Public — a signed-out viewer just gets `MyMembershipType` 0.',
				'Unlike create/modifydetails this one is NOT enveloped: the details object is written',
				'straight out, as the reference does.',
			].join(' '),
			parameters: [CLUB_ID_PARAM],
			responses: {
				200: json(ClubDetailsDto, 'The club’s details (not enveloped)'),
				404: { description: 'No such club' },
			},
		}),
		async (c) => {
			const clubId = Number.parseInt(c.req.param('clubId'), 10)
			const club = await getClub(c.env.DB, clubId)
			if (club === null) return c.notFound()
			const id = await authedId(c)
			return c.json(await getClubDetails(c.env.DB, club, id))
		}
	)

	// Whether a club has turned its club chat off. Nothing can disable club chat yet
	// (no setting, no storage), so chat is always on → `false`. A bare JSON boolean,
	// like the other `is…`/`has…` gates the client polls; not in the reference, so if
	// the client chokes on this it likely wants the `{ error, success, value }`
	// envelope the other club endpoints use.
	.get(
		'/club/:clubId{[0-9]+}/hasDisabledClubChat',
		describeRoute({
			tags: ['Clubs'],
			summary: 'Whether the club has turned club chat off',
			description: [
				'Nothing can disable club chat yet (no setting, no storage), so chat is always on →',
				'`false`. A bare JSON boolean, like the other `is…`/`has…` gates the client polls; not',
				'in the reference, so if the client chokes on this it likely wants the',
				'`{ error, success, value }` envelope the other club endpoints use.',
			].join(' '),
			parameters: [CLUB_ID_PARAM],
			responses: { 200: json(ChatDisabledResponse, 'Always false') },
		}),
		(c) => c.json(false)
	)

	// A club's members. `membershipType` filters to exactly that tier (an exact match,
	// not a threshold — `30` lists co-owners only, not the creator above them), and
	// `sortBy` picks the order (1 = account id, 2 = oldest first, default = highest
	// tier first). Public, and an unknown club is an empty list. Answers the envelope.
	.get(
		'/club/:clubId{[0-9]+}/members',
		describeRoute({
			tags: ['Membership'],
			summary: 'A club’s members',
			description:
				'Public, and an unknown club is an empty list rather than a 404. Answers the envelope.',
			parameters: [
				CLUB_ID_PARAM,
				{
					name: 'membershipType',
					in: 'query',
					required: false,
					description: [
						'Filter to exactly that tier — an exact match, not a threshold, so `30` lists',
						'co-owners only, not the creator above them',
					].join(' '),
					schema: { type: 'string' },
				},
				{
					name: 'sortBy',
					in: 'query',
					required: false,
					description: '1 = account id, 2 = oldest first, anything else = highest tier first',
					schema: { type: 'string' },
				},
			],
			responses: { 200: json(ClubMembersEnvelope, 'The club’s membership rows') },
		}),
		async (c) => {
			const clubId = Number.parseInt(c.req.param('clubId'), 10)
			const raw = c.req.query('membershipType')
			const membershipType = raw === undefined ? Number.NaN : Number.parseInt(raw, 10)

			const members = await getClubMembers(
				c.env.DB,
				clubId,
				Number.isNaN(membershipType) ? undefined : membershipType,
				c.req.query('sortBy')
			)
			return c.json({ error: '', success: true, value: members })
		}
	)

	// Set the minimum player level required to join the club. The reference has no such
	// route (it only takes `minLevel` on modifydetails), but the client PUTs it here.
	// Same rules as the other club edits: co-owner or above, and the details envelope.
	.put(
		'/club/:clubId{[0-9]+}/minlevel',
		describeRoute({
			tags: ['Clubs'],
			summary: 'Set the club’s minimum join level',
			description: [
				'The reference has no such route (it only takes `minLevel` on modifydetails), but the',
				'client PUTs it here. Same rules as the other club edits: co-owner or above, and the',
				'details envelope back.',
			].join(' '),
			security: AUTHED,
			parameters: [CLUB_ID_PARAM],
			requestBody: form(MinLevelRequest, 'The new minimum level'),
			responses: {
				200: json(ClubDetailsEnvelope, 'The updated club’s details'),
				400: json(ErrorEnvelope, 'Missing, non-numeric or negative minLevel'),
				401: UNAUTHORIZED_RESPONSE,
				403: json(ErrorEnvelope, 'Below co-owner'),
				404: { description: 'No such club' },
			},
		}),
		async (c) => {
			const id = await authedId(c)
			if (id === null) return c.body(null, 401)

			const clubId = Number.parseInt(c.req.param('clubId'), 10)
			const club = await getClub(c.env.DB, clubId)
			if (club === null) return c.notFound()

			const membership = await getMembership(c.env.DB, clubId, id)
			if (membership < ClubMembershipType.Coowner) {
				return c.json({ error: 'Insufficient permissions.', success: false, value: null }, 403)
			}

			const body = (await c.req.parseBody().catch(() => ({}))) as Record<string, unknown>
			const key = Object.keys(body).find((k) => k.toLowerCase() === 'minlevel')
			const minLevel = Number.parseInt(
				typeof body[key ?? ''] === 'string' ? String(body[key ?? '']) : '',
				10
			)
			if (Number.isNaN(minLevel) || minLevel < 0) return clubError(c, 'Invalid minLevel.')

			const updated = await updateClub(c.env.DB, clubId, { minLevel })
			if (updated === null) return c.notFound()
			return c.json({
				error: '',
				success: true,
				value: await getClubDetails(c.env.DB, updated, id),
			})
		}
	)

	// Set (or clear) the club's clubhouse room — the room players spawn into when the
	// club is their home. `roomId` sets it; omitting it clears the clubhouse. Co-owner
	// or above only. Answers the details envelope (the reference returns a null value
	// here, but the client re-renders from the response and leaves the old clubhouse
	// on screen unless it gets the updated club back).
	//
	// DELETE is the same thing with the clearing spelled out — it ignores any body and
	// always unsets the room, so "remove the clubhouse" doesn't depend on the client
	// remembering to send an empty PUT.
	.on(
		['PUT', 'DELETE'],
		'/club/:clubId{[0-9]+}/clubhouse',
		describeRoute({
			tags: ['Clubs'],
			summary: 'Set or clear the club’s clubhouse room',
			description: [
				'The clubhouse is the room players spawn into when the club is their home. PUT with',
				'`roomId` sets it; omitting `roomId` clears it. DELETE is the same thing with the',
				'clearing spelled out — it ignores any body and always unsets the room, so “remove the',
				'clubhouse” doesn’t depend on the client remembering to send an empty PUT. Co-owner or',
				'above only. Answers the full details envelope: the reference returns a null value',
				'here, but the client re-renders from the response and leaves the old clubhouse on',
				'screen unless it gets the updated club back.',
			].join(' '),
			security: AUTHED,
			parameters: [CLUB_ID_PARAM],
			requestBody: form(ClubhouseRequest, 'The clubhouse room (PUT only; DELETE ignores the body)'),
			responses: {
				200: json(ClubDetailsEnvelope, 'The updated club’s details'),
				400: json(ErrorEnvelope, 'Non-numeric roomId'),
				401: UNAUTHORIZED_RESPONSE,
				403: json(ErrorEnvelope, 'Below co-owner'),
				404: { description: 'No such club' },
			},
		}),
		async (c) => {
			const id = await authedId(c)
			if (id === null) return c.body(null, 401)

			const clubId = Number.parseInt(c.req.param('clubId'), 10)
			const club = await getClub(c.env.DB, clubId)
			if (club === null) return c.notFound()

			const membership = await getMembership(c.env.DB, clubId, id)
			if (membership < ClubMembershipType.Coowner) {
				return c.json({ error: 'Insufficient permissions.', success: false, value: null }, 403)
			}

			let roomId: number | null = null
			if (c.req.method !== 'DELETE') {
				const body = (await c.req.parseBody().catch(() => ({}))) as Record<string, unknown>
				const key = Object.keys(body).find((k) => k.toLowerCase() === 'roomid')
				const raw = typeof body[key ?? ''] === 'string' ? String(body[key ?? '']).trim() : ''
				if (raw !== '' && Number.isNaN(Number.parseInt(raw, 10))) {
					return clubError(c, 'Invalid roomId.')
				}
				roomId = raw === '' ? null : Number.parseInt(raw, 10)
			}

			const updated = await updateClub(c.env.DB, clubId, { clubhouseRoomId: roomId })
			if (updated === null) return c.notFound()
			return c.json({
				error: '',
				success: true,
				value: await getClubDetails(c.env.DB, updated, id),
			})
		}
	)

	// The club's main image. PUT sets it from an uploaded image's `imageName` (the
	// name the `storage` worker handed back); co-owner or above only. GET reads it —
	// the reference has no GET here (it 404s), but the client asks for it, so this
	// answers the same details envelope rather than erroring; the image name is on
	// `value.Club.MainImageName`.
	.get(
		'/club/:clubId{[0-9]+}/mainimage',
		describeRoute({
			tags: ['Images'],
			summary: 'Read the club’s main image',
			description: [
				'The reference has no GET here (it 404s), but the client asks for it, so this answers',
				'the same details envelope rather than erroring; the image name is on',
				'`value.Club.MainImageName`. Public.',
			].join(' '),
			parameters: [CLUB_ID_PARAM],
			responses: {
				200: json(ClubDetailsEnvelope, 'The club’s details, carrying MainImageName'),
				404: { description: 'No such club' },
			},
		}),
		async (c) => {
			const clubId = Number.parseInt(c.req.param('clubId'), 10)
			const club = await getClub(c.env.DB, clubId)
			if (club === null) return c.notFound()
			const id = await authedId(c)
			return c.json({
				error: '',
				success: true,
				value: await getClubDetails(c.env.DB, club, id),
			})
		}
	)
	.put(
		'/club/:clubId{[0-9]+}/mainimage',
		describeRoute({
			tags: ['Images'],
			summary: 'Set the club’s main image',
			description: [
				'Sets the main image from an uploaded image’s `imageName` (the name the `storage`',
				'worker handed back). Co-owner or above only. Answers the details envelope.',
			].join(' '),
			security: AUTHED,
			parameters: [CLUB_ID_PARAM],
			requestBody: form(ImageNameRequest, 'The uploaded image’s name'),
			responses: {
				200: json(ClubDetailsEnvelope, 'The updated club’s details'),
				400: json(ErrorEnvelope, 'Missing imageName'),
				401: UNAUTHORIZED_RESPONSE,
				403: json(ErrorEnvelope, 'Below co-owner'),
				404: { description: 'No such club' },
			},
		}),
		async (c) => {
			const id = await authedId(c)
			if (id === null) return c.body(null, 401)

			const clubId = Number.parseInt(c.req.param('clubId'), 10)
			const club = await getClub(c.env.DB, clubId)
			if (club === null) return c.notFound()

			const membership = await getMembership(c.env.DB, clubId, id)
			if (membership < ClubMembershipType.Coowner) {
				return c.json({ error: 'Insufficient permissions.', success: false, value: null }, 403)
			}

			const body = (await c.req.parseBody().catch(() => ({}))) as Record<string, unknown>
			const key = Object.keys(body).find((k) => k.toLowerCase() === 'imagename')
			const imageName =
				typeof body[key ?? ''] === 'string' ? (body[key ?? ''] as string).trim() : ''
			if (imageName === '') return clubError(c, 'imageName is required.')

			const updated = await updateClub(c.env.DB, clubId, { mainImageName: imageName })
			if (updated === null) return c.notFound()
			return c.json({
				error: '',
				success: true,
				value: await getClubDetails(c.env.DB, updated, id),
			})
		}
	)

	// One of the club's gallery images, by position (`/additionalimage/{index}`, 0-based
	// — the client PUTs the first image to 0, the second to 1). Takes the same
	// `imageName` the `storage` worker handed back. Co-owner or above, like the main
	// image. The list is packed: a PUT past the end appends rather than leaving a gap,
	// and the images come back in order on `value.AdditionalImages`.
	//
	// DELETE removes that position's image and shifts the rest up, so there's never a
	// blank slot in the gallery. It ignores any body, so it can't accidentally set an
	// image instead, and deleting a position that holds nothing is a no-op.
	.on(
		['PUT', 'DELETE'],
		'/club/:clubId{[0-9]+}/additionalimage/:index{[0-9]+}',
		describeRoute({
			tags: ['Images'],
			summary: 'Set or remove one of the club’s gallery images',
			description: [
				'One gallery image by position (0-based — the client PUTs the first image to 0, the',
				'second to 1), taking the same `imageName` the `storage` worker handed back. Co-owner',
				'or above, like the main image. The list is PACKED, never sparse: a PUT past the end',
				'appends rather than leaving a gap, and DELETE removes that position and shifts the',
				'rest up, so there’s never a blank slot. DELETE ignores any body (so it can’t',
				'accidentally set an image instead) and deleting an empty position is a no-op. The',
				'images come back on `value.AdditionalImages` as whole image records, in order — a',
				'bare array of names fails the client’s parser.',
			].join(' '),
			security: AUTHED,
			parameters: [
				CLUB_ID_PARAM,
				{
					name: 'index',
					in: 'path',
					required: true,
					description: 'The 0-based gallery slot; a club has 3 slots (0–2)',
					schema: { type: 'string' },
				},
			],
			requestBody: form(ImageNameRequest, 'The uploaded image’s name (PUT only)'),
			responses: {
				200: json(ClubDetailsEnvelope, 'The updated club’s details'),
				400: json(ErrorEnvelope, 'The index is past the club’s gallery slots'),
				401: UNAUTHORIZED_RESPONSE,
				403: json(ErrorEnvelope, 'Below co-owner'),
				404: { description: 'No such club' },
			},
		}),
		async (c) => {
			const id = await authedId(c)
			if (id === null) return c.body(null, 401)

			const clubId = Number.parseInt(c.req.param('clubId'), 10)
			const club = await getClub(c.env.DB, clubId)
			if (club === null) return c.notFound()

			const membership = await getMembership(c.env.DB, clubId, id)
			if (membership < ClubMembershipType.Coowner) {
				return c.json({ error: 'Insufficient permissions.', success: false, value: null }, 403)
			}

			const index = Number.parseInt(c.req.param('index'), 10)
			if (index >= MAX_ADDITIONAL_IMAGES) {
				return clubError(c, `A club has ${MAX_ADDITIONAL_IMAGES} additional image slots (0-based).`)
			}

			let imageName = ''
			if (c.req.method !== 'DELETE') {
				const body = (await c.req.parseBody().catch(() => ({}))) as Record<string, unknown>
				const key = Object.keys(body).find((k) => k.toLowerCase() === 'imagename')
				imageName = typeof body[key ?? ''] === 'string' ? (body[key ?? ''] as string).trim() : ''
			}

			const updated = await setClubAdditionalImage(c.env.DB, clubId, index, imageName)
			if (updated === null) return c.notFound()
			return c.json({
				error: '',
				success: true,
				value: await getClubDetails(c.env.DB, updated, id),
			})
		}
	)

	// A single club by id. 404 when the club isn't in the DB. Public.
	.get(
		'/club/:clubId{[0-9]+}',
		describeRoute({
			tags: ['Clubs'],
			summary: 'A single club by id',
			description: 'The bare club (not the details view, not enveloped). Public.',
			parameters: [CLUB_ID_PARAM],
			responses: {
				200: json(ClubDto, 'The club'),
				404: { description: 'No such club' },
			},
		}),
		async (c) => {
			const club = await getClub(c.env.DB, Number.parseInt(c.req.param('clubId'), 10))
			return club ? c.json(club) : c.notFound()
		}
	)

	// Delete a club, along with its memberships and announcements. The creator only —
	// not co-owners, who can edit a club but can't destroy one — which is also the way
	// out for a creator, since they aren't allowed to leave (see /members/leave).
	// Answers the envelope with a null value; the club is gone, so there are no details
	// left to return.
	.delete(
		'/club/:clubId{[0-9]+}',
		describeRoute({
			tags: ['Clubs'],
			summary: 'Delete a club',
			description: [
				'Deletes the club along with its memberships and announcements, and clears it from the',
				'home club of anyone who’d set it. The creator only — not co-owners, who can edit a',
				'club but can’t destroy one — which is also the way out for a creator, since they',
				'aren’t allowed to leave. The envelope’s `value` is null: the club is gone, so there',
				'are no details left to return.',
			].join(' '),
			security: AUTHED,
			parameters: [CLUB_ID_PARAM],
			responses: {
				200: json(NullEnvelope, 'Deleted (value null)'),
				401: UNAUTHORIZED_RESPONSE,
				403: json(ErrorEnvelope, 'Not the club’s creator'),
				404: { description: 'No such club' },
			},
		}),
		async (c) => {
			const id = await authedId(c)
			if (id === null) return c.body(null, 401)

			const clubId = Number.parseInt(c.req.param('clubId'), 10)
			const club = await getClub(c.env.DB, clubId)
			if (club === null) return c.notFound()

			const membership = await getMembership(c.env.DB, clubId, id)
			if (membership < ClubMembershipType.Creator) {
				return c.json({ error: 'Insufficient permissions.', success: false, value: null }, 403)
			}

			await deleteClub(c.env.DB, clubId)
			return c.json({ error: '', success: true, value: null })
		}
	)

	// Ask to join a club. No body — the club id and the Bearer token are the whole
	// request. What it does depends on the club's Joinability: an Open club takes the
	// caller straight in as a Member, an AskToJoin club records a PendingRequested row
	// for a co-owner to approve, and an InviteOnly club refuses (you can only get in
	// through an invite). Repeats are idempotent; a banned account stays out. Answers
	// the details envelope so the client can read its new `MyMembershipType`.
	.put(
		'/club/:clubId{[0-9]+}/members/requesttojoin',
		describeRoute({
			tags: ['Membership'],
			summary: 'Ask to join a club',
			description: [
				'No body — the club id and the Bearer token are the whole request. What it does',
				'depends on the club’s Joinability: an Open club takes the caller straight in as a',
				'Member, an AskToJoin club records a PendingRequested row for a co-owner to approve,',
				'and an InviteOnly club refuses (you can only get in through an invite). Repeats are',
				'idempotent; a banned account stays out. Answers the details envelope so the client',
				'can read its new `MyMembershipType`.',
			].join(' '),
			security: AUTHED,
			parameters: [CLUB_ID_PARAM],
			responses: {
				200: json(ClubDetailsEnvelope, 'The club’s details, with the caller’s new membership'),
				400: json(ErrorEnvelope, 'The club is invite only'),
				401: UNAUTHORIZED_RESPONSE,
				403: json(ErrorEnvelope, 'The caller is banned from the club'),
				404: { description: 'No such club' },
			},
		}),
		async (c) => {
			const id = await authedId(c)
			if (id === null) return c.body(null, 401)

			const clubId = Number.parseInt(c.req.param('clubId'), 10)
			const outcome = await requestToJoinClub(c.env.DB, clubId, id)
			if (outcome === null) return c.notFound()

			if (outcome.result === 'inviteOnly') {
				return clubError(c, 'This club is invite only.')
			}
			if (outcome.result === 'banned') {
				return c.json({ error: 'You are banned from this club.', success: false, value: null }, 403)
			}

			return c.json({
				error: '',
				success: true,
				value: await getClubDetails(c.env.DB, outcome.club, id),
			})
		}
	)

	// Invite an account into the club at a given tier — the co-owner's "add member" /
	// role-assignment write. `accountId` is who to add and `membershipType` the tier they
	// get (10 Member, 20 Moderator, 30 Co-owner); the client sends both as form fields.
	// Co-owner or above only. The membership is upserted, so this also promotes/demotes an
	// existing member and overrides a ban — but it can't mint another Creator (100) and it
	// can't touch the club's own Creator. Answers the details envelope, like the other
	// membership writes.
	.put(
		'/club/:clubId{[0-9]+}/members/invite',
		describeRoute({
			tags: ['Membership'],
			summary: 'Invite an account into the club',
			description: [
				'Adds `accountId` to the club at `membershipType` (10 Member, 20 Moderator, 30',
				'Co-owner) — the co-owner’s “add member” / role-assignment write; both arrive as form',
				'fields, and an absent `membershipType` defaults to Member. Co-owner or above only. The',
				'membership is upserted, so this also promotes/demotes an existing member and overrides',
				'a ban; it can’t mint another Creator (100) or change the club’s own Creator. Answers the',
				'details envelope, like the other membership writes.',
			].join(' '),
			security: AUTHED,
			parameters: [CLUB_ID_PARAM],
			requestBody: form(InviteMemberRequest, 'The account to add and the tier to grant'),
			responses: {
				200: json(ClubDetailsEnvelope, 'The club’s details after the invite'),
				400: json(
					ErrorEnvelope,
					'Missing/invalid accountId, a tier outside Member/Moderator/Co-owner, or targeting the creator'
				),
				401: UNAUTHORIZED_RESPONSE,
				403: json(ErrorEnvelope, 'Below co-owner'),
				404: { description: 'No such club' },
			},
		}),
		async (c) => {
			const id = await authedId(c)
			if (id === null) return c.body(null, 401)

			const clubId = Number.parseInt(c.req.param('clubId'), 10)
			const club = await getClub(c.env.DB, clubId)
			if (club === null) return c.notFound()

			const membership = await getMembership(c.env.DB, clubId, id)
			if (membership < ClubMembershipType.Coowner) {
				return c.json({ error: 'Insufficient permissions.', success: false, value: null }, 403)
			}

			const body = (await c.req.parseBody().catch(() => ({}))) as Record<string, unknown>
			const field = (name: string): string | undefined => {
				const key = Object.keys(body).find((k) => k.toLowerCase() === name.toLowerCase())
				const v = key === undefined ? undefined : body[key]
				return typeof v === 'string' ? v : undefined
			}

			const accountId = Number.parseInt(field('accountId') ?? '', 10)
			if (Number.isNaN(accountId) || accountId <= 0) return clubError(c, 'Invalid accountId.')

			// An absent tier means "add as a plain Member"; anything present must be one of the
			// grantable roles (in particular not Creator), so an invite can't mint a second owner.
			const rawType = field('membershipType')
			const membershipType =
				rawType === undefined || rawType.trim() === ''
					? ClubMembershipType.Member
					: Number.parseInt(rawType, 10)
			if (!INVITABLE_TIERS.has(membershipType)) return clubError(c, 'Invalid membershipType.')

			// The Creator is fixed — you can't demote them or promote someone over them.
			if (accountId === club.CreatorAccountId) {
				return clubError(c, 'You can’t change the club’s creator.')
			}

			const updated = await setMemberType(c.env.DB, clubId, accountId, membershipType)
			if (updated === null) return c.notFound()
			return c.json({
				error: '',
				success: true,
				value: await getClubDetails(c.env.DB, updated, id),
			})
		}
	)

	// Leave a club. No body, like requesttojoin — the club id and the Bearer token are
	// the whole request. Idempotent (leaving a club you're not in is a no-op), and it
	// also withdraws a pending request; a ban is preserved, since you can't clear one
	// by leaving. The creator is refused — they'd leave the club ownerless, so they
	// have to delete it instead. Answers the details envelope so the client sees
	// `MyMembershipType` drop to 0 (or stay at -1 for a banned account).
	.post(
		'/club/:clubId{[0-9]+}/members/leave',
		describeRoute({
			tags: ['Membership'],
			summary: 'Leave a club',
			description: [
				'No body, like requesttojoin. Idempotent (leaving a club you’re not in is a no-op),',
				'and it also withdraws a pending request; a ban is preserved, since you can’t clear',
				'one by leaving. The creator is refused — they’d leave the club ownerless, so they',
				'have to delete it instead. Answers the details envelope so the client sees',
				'`MyMembershipType` drop to 0 (or stay at -1 for a banned account).',
			].join(' '),
			security: AUTHED,
			parameters: [CLUB_ID_PARAM],
			responses: {
				200: json(ClubDetailsEnvelope, 'The club’s details, with the caller’s membership gone'),
				401: UNAUTHORIZED_RESPONSE,
				403: json(ErrorEnvelope, 'The creator can’t leave — delete the club instead'),
				404: { description: 'No such club' },
			},
		}),
		async (c) => {
			const id = await authedId(c)
			if (id === null) return c.body(null, 401)

			const clubId = Number.parseInt(c.req.param('clubId'), 10)
			const outcome = await leaveClub(c.env.DB, clubId, id)
			if (outcome === null) return c.notFound()
			if (outcome.result === 'creator') {
				return c.json(
					{
						error: 'You created this club — delete it instead of leaving.',
						success: false,
						value: null,
					},
					403
				)
			}

			return c.json({
				error: '',
				success: true,
				value: await getClubDetails(c.env.DB, outcome.club, id),
			})
		}
	)

	// Join / leave a club (auth-gated, idempotent). Both return the club with its
	// refreshed MemberCount; 404 when the club doesn't exist.
	.post(
		'/club/:clubId{[0-9]+}/join',
		describeRoute({
			tags: ['Membership'],
			summary: 'Join a club',
			description: [
				'Auth-gated and idempotent. On an Open club the caller becomes a Member immediately;',
				'on an InviteOnly/AskToJoin club the join is recorded as PendingRequested, and a ban',
				'can’t be shed by re-joining. Returns the bare club with its refreshed MemberCount',
				'(not the details envelope — see members/requesttojoin for that).',
			].join(' '),
			security: AUTHED,
			parameters: [CLUB_ID_PARAM],
			responses: {
				200: json(ClubDto, 'The club, with its refreshed MemberCount'),
				401: UNAUTHORIZED_RESPONSE,
				404: { description: 'No such club' },
			},
		}),
		async (c) => {
			const id = await authedId(c)
			if (id === null) return c.body(null, 401)
			const club = await joinClub(c.env.DB, Number.parseInt(c.req.param('clubId'), 10), id)
			return club ? c.json(club) : c.notFound()
		}
	)
	// Leaving is refused for the creator here too (see /members/leave), so the two
	// routes can't disagree about who's still in the club.
	.post(
		'/club/:clubId{[0-9]+}/leave',
		describeRoute({
			tags: ['Membership'],
			summary: 'Leave a club (bare-club form)',
			description: [
				'The counterpart to `/join`: returns the bare club with its refreshed MemberCount',
				'rather than the details envelope. Leaving is refused for the creator here too (see',
				'`/members/leave`), so the two routes can’t disagree about who’s still in the club.',
			].join(' '),
			security: AUTHED,
			parameters: [CLUB_ID_PARAM],
			responses: {
				200: json(ClubDto, 'The club, with its refreshed MemberCount'),
				401: UNAUTHORIZED_RESPONSE,
				403: json(ErrorEnvelope, 'The creator can’t leave — delete the club instead'),
				404: { description: 'No such club' },
			},
		}),
		async (c) => {
			const id = await authedId(c)
			if (id === null) return c.body(null, 401)
			const outcome = await leaveClub(c.env.DB, Number.parseInt(c.req.param('clubId'), 10), id)
			if (outcome === null) return c.notFound()
			if (outcome.result === 'creator') {
				return c.json(
					{
						error: 'You created this club — delete it instead of leaving.',
						success: false,
						value: null,
					},
					403
				)
			}
			return c.json(outcome.club)
		}
	)

// The generated spec. Documentation only — no request is validated against it (see
// openapi.ts). `hide: true` keeps this route out of its own output.
app.get(
	'/openapi.json',
	describeRoute({ hide: true }),
	withCleanSpec(
		openAPIRouteHandler(app, {
			documentation: {
				info: {
					title: 'recflare clubs',
					version: '1.0.0',
					description: [
						'Club endpoints for recflare, a private-server reimplementation of the Rec Room',
						'backend. The client calls these on the `clubs` host: club creation and editing,',
						'membership (join / ask-to-join / leave, with the ban and pending tiers),',
						'search, announcements, the club gallery and clubhouse room, and each player’s home',
						'club. Everything is D1-backed on the shared `recflare` database; the',
						'`/subscription/*` routes are stubs, since there are no subscription clubs yet.',
						'',
						'Most writes answer the `{ error, success, value }` envelope with HTTP 200, and the',
						'ones the client re-renders a club screen from carry the club’s FULL details as',
						'`value` rather than null.',
					].join('\n'),
				},
				servers: [{ url: 'https://clubs.recflare.net', description: 'Production' }],
				components: {
					securitySchemes: {
						bearerAuth: {
							type: 'http',
							scheme: 'bearer',
							bearerFormat: 'JWT',
							description: 'An `access_token` from the auth worker’s `POST /connect/token`.',
						},
					},
				},
			},
		})
	)
)

export default app
