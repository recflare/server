import { resolver } from 'hono-openapi'
import { z } from 'zod'

import {
	isValidBio,
	isValidEmail,
	MAX_DISPLAY_NAME_LENGTH,
	MAX_USERNAME_LENGTH,
	nameRejection,
} from '@repo/domain'

import type { OpenAPIV3_1 } from 'openapi-types'

/**
 * OpenAPI schemas for the accounts worker.
 *
 * Most of these are DESCRIPTIVE ONLY: they are passed to `describeRoute` to generate the
 * spec, and the handler stays lenient. That is deliberate — the Rec Room client is the
 * real consumer, form fields are read as `typeof value === 'string' ? value : ''`, and
 * missing or malformed input falls through to a graceful path (or a synthesized default
 * account) rather than a hard error. A schema that rejected what the client actually
 * sends would break the game, not protect it.
 *
 * The EXCEPTION is the profile mutations a player types into a box — displayName,
 * username, email, phone, bio. Those carry real rules (see `@repo/domain`), and each is
 * wired into `hono-openapi`'s `validator()` per route, with tests, exactly as the older
 * version of this note prescribed. Wiring one up means the schema both validates the
 * request and generates the spec, so a limit can't be changed in one and not the other —
 * which is precisely how the documented email limit came to disagree with the real one.
 *
 * A validated route drops `requestBody: form(...)` from its `describeRoute`: the
 * validator registers the body itself, and declaring it twice would emit it twice.
 */

/** Emit a zod schema as an `application/json` response body. */
export function json(schema: z.ZodType, description: string) {
	return { description, content: { 'application/json': { schema: resolver(schema) } } }
}

/**
 * Emit a zod schema as a form request body. `describeRoute`'s `requestBody` takes a
 * plain OpenAPI schema (not a `resolver()`), so convert here. zod's `$schema` key and
 * `additionalProperties: false` are dropped — these handlers read the fields they know
 * and ignore the rest, so claiming a closed object would misreport them as stricter
 * than they are. The client posts both urlencoded and multipart, hence the wildcard.
 */
export function form(schema: z.ZodType, description: string): OpenAPIV3_1.RequestBodyObject {
	const { $schema: _$schema, additionalProperties: _extra, ...jsonSchema } = z.toJSONSchema(schema)
	return {
		description,
		content: {
			// zod's JSONSchema type is far wider than OpenAPI's SchemaObject; cast at the
			// boundary (the emitted value is valid OpenAPI 3.1).
			'application/x-www-form-urlencoded': { schema: jsonSchema as OpenAPIV3_1.SchemaObject },
			'multipart/form-data': { schema: jsonSchema as OpenAPIV3_1.SchemaObject },
		},
	}
}

/**
 * The public account DTO (`toAccountDto`) — the camelCase shape returned for any
 * account, with private fields (email, birthday) excluded. Fields the client parses
 * as enums are numbers here.
 */
export const AccountDto = z.object({
	accountId: z.int(),
	username: z.string(),
	displayName: z.string(),
	profileImage: z.string().describe('Avatar object key'),
	bannerImage: z.string().describe('Profile banner key — always "" (nothing sets it yet)'),
	displayEmoji: z
		.string()
		.describe('Emoji beside the display name — always "" (nothing sets it yet)'),
	isJunior: z.boolean(),
	platforms: z.int().describe('PlatformType bitmask of linked platforms'),
	personalPronouns: z.int().describe('Pronoun flags bitmask'),
	identityFlags: z.int().describe('Identity flags bitmask'),
	createdAt: z.iso.datetime(),
})

/**
 * The private self DTO (`toSelfAccountDto`, the `/account/me` shape) — the public DTO
 * plus owner-only fields. `juniorState`/`parentAccountId` are omitted entirely when
 * unset (emitting `null` makes the client's enum parser throw).
 */
export const SelfAccountDto = AccountDto.extend({
	email: z
		.string()
		.describe(
			'"" when unset — never null: the client reads it as a string, and the hub frame this ' +
				'DTO also rides drops null values outright'
		),
	birthday: z.iso.datetime().describe('A fixed placeholder — birthdays are not stored'),
	availableUsernameChanges: z.int().describe('Remaining username changes'),
})

/** Player bio, from `GET /account/:id/bio`. */
export const BioResponse = z.object({
	accountId: z.int(),
	bio: z.string().describe('"" when unset'),
})

/** A bare `{ success: true }` ack, returned by most profile mutations. */
export const SuccessResponse = z.object({ success: z.literal(true) })

/** The RecNet result envelope `{ success, value }` used by create + username change. */
export function envelope(value: z.ZodType) {
	return z.object({
		success: z.boolean(),
		value,
		error: z.string().optional().describe('Present (with success:false) on failure'),
	})
}

/**
 * The username-change envelope. Always HTTP 200 even on failure: `success:false` with
 * a message in `error` and `value` an empty string; on success `value` is the updated
 * public account.
 */
export const UsernameResult = envelope(z.union([AccountDto, z.literal('')])).describe(
	'value is the updated account on success, "" on failure'
)

/** `POST /account/create` response. */
export const CreateAccountResult = envelope(AccountDto)

/** `GET /parentalcontrol/me` response. */
export const ParentalControl = z.object({ accountId: z.int(), disallowInAppPurchases: z.boolean() })

/**
 * `GET /accountprivacysettings/:id` response. A bare `{}` fails the client's
 * deserializer, so the id is echoed back and recent history reported visible; nothing
 * stores per-player privacy yet.
 */
export const PrivacySettings = z.object({ accountId: z.int(), isRecentHistoryVisible: z.boolean() })

/** Root health check. */
export const HealthResponse = z.object({ service: z.literal('accounts'), status: z.literal('ok') })

// ---- Request bodies --------------------------------------------------------

/** `POST /account/create` form body. Both fields are parsed but not yet persisted. */
export const CreateAccountRequest = z.object({
	platform: z.string().optional().describe('PlatformType integer string; defaults to 0'),
	platformId: z.string().optional().describe('Parsed for fidelity; currently unused'),
})

/**
 * Single-string form bodies, one per profile mutation.
 *
 * These are ENFORCED, not just described: each is handed to hono-openapi's `validator`,
 * so the same schema both validates the request and generates the spec. Before this they
 * were documentation only, and the real rule lived in the handler — which meant every
 * limit had to be edited in two places and nothing caught them disagreeing.
 *
 * The rules themselves come from `@repo/domain` so `rooms` and `clubs` can't drift from
 * `accounts`; `superRefine` is used where the message matters, because `nameRejection`
 * writes the player-facing sentence and there's no reason to write it twice.
 */

/** Zod check that defers to the shared name rule, message and all. */
const nameCheck = (label: string, max: number) =>
	z
		.string()
		.trim()
		.superRefine((value, ctx) => {
			const rejection = nameRejection(value, label, max)
			if (rejection !== null) ctx.addIssue({ code: 'custom', message: rejection })
		})

export const DisplayNameRequest = z.object({
	displayName: nameCheck('display name', MAX_DISPLAY_NAME_LENGTH)
		.min(1)
		.describe('Trimmed; letters and digits only, max 15. Empty or invalid is rejected (400)'),
})

export const UsernameRequest = z.object({
	username: nameCheck('username', MAX_USERNAME_LENGTH)
		.min(1, 'You must enter a username.')
		.describe('Trimmed; letters and digits only, max 50. Must be unique and changes must remain'),
})

export const EmailRequest = z.object({
	email: z
		.string()
		.trim()
		.refine(isValidEmail, 'That email address looks wrong.')
		.describe('A syntactically valid address (RFC 5321/5322, so at most 254); otherwise 400'),
})

export const PhoneRequest = z.object({
	// No shape rule on purpose: the client sends E.164 (`+15552223333`), which the name
	// rule above would reject outright by eating the leading `+`.
	phone: z.string().trim().min(1).describe('Trimmed; empty is rejected (400)'),
})

export const IdentityFlagsRequest = z.object({
	identityFlags: z.string().describe('Integer string bitmask; non-numeric is 400'),
})

export const PronounsRequest = z.object({
	pronounFlags: z.string().describe('Integer string bitmask; non-numeric is 400'),
})

export const BioRequest = z.object({
	// Not trimmed — a bio is free text, and leading whitespace is the player's business.
	bio: z.string().refine(isValidBio).describe('Free text, max 255; empty is allowed'),
})

export const ProfileImageRequest = z.object({
	imageName: z.string().describe('Avatar object key; empty is rejected (400)'),
})

/**
 * `PUT /account/me/bannerimage` form body. The key of an image the player already
 * uploaded — the client posts a `sharecamera/<date>/<uuid>.jpg` key, i.e. one of their own
 * photos — so this only names an image, it never carries one.
 */
export const BannerImageRequest = z.object({
	imageName: z.string().describe('Banner object key; empty is rejected (400)'),
})
