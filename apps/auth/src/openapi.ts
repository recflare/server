import { resolver } from 'hono-openapi'
import { z } from 'zod'

import type { OpenAPIV3_1 } from 'openapi-types'

/**
 * OpenAPI schemas for the auth worker.
 *
 * IMPORTANT: these are DESCRIPTIVE ONLY. They are passed to `describeRoute` to
 * generate the spec and are never wired into `hono-openapi`'s `validator()`.
 *
 * That is deliberate, not an oversight. This worker serves a reverse-engineered
 * protocol: the Rec Room client is the only real consumer, and the handlers are
 * intentionally lenient — every field is read as
 * `typeof body.x === 'string' ? body.x : ''` and missing/malformed input falls
 * through to a graceful path rather than a 400. Which parts of that tolerance the
 * client actually depends on is not fully known, so enforcing a schema would risk
 * rejecting requests that work today, for a client that is hard to debug against.
 *
 * So: these schemas record what the client is *observed* to send and what we send
 * back. If you want to enforce one, do it per-route and land a test with it.
 */

/** Emit a zod schema as an `application/json` response body. */
export function json(schema: z.ZodType, description: string) {
	return { description, content: { 'application/json': { schema: resolver(schema) } } }
}

/**
 * Emit a zod schema as an `application/x-www-form-urlencoded` request body.
 *
 * Unlike `responses`, `describeRoute`'s `requestBody` takes a plain OpenAPI schema
 * and won't accept a `resolver()`, so convert here. zod's `$schema` key is dropped
 * (not meaningful in an OpenAPI schema position), as is `additionalProperties: false`
 * — these handlers read the fields they know and ignore the rest, so claiming a
 * closed object would misreport the server as stricter than it is.
 */
export function form(schema: z.ZodType, description: string): OpenAPIV3_1.RequestBodyObject {
	const { $schema: _$schema, additionalProperties: _extra, ...jsonSchema } = z.toJSONSchema(schema)
	return {
		description,
		content: {
			// zod's JSONSchema type is far wider than OpenAPI's SchemaObject (it carries
			// `~standard` and every draft keyword), so the two never match structurally
			// even though the emitted value is valid OpenAPI 3.1. Cast at the boundary.
			'application/x-www-form-urlencoded': { schema: jsonSchema as OpenAPIV3_1.SchemaObject },
		},
	}
}

/**
 * PlatformType, the client's platform enum. Declaration order is wire order, and is
 * the single source for the schema and description below. The `platform` form field
 * is posted as the integer; the token's `platform` claim carries the name.
 */
export const PlatformType = {
	All: -1,
	Steam: 0,
	Oculus: 1,
	PlayStation: 2,
	Xbox: 3,
	RecNet: 4,
	IOS: 5,
	GooglePlay: 6,
	Standalone: 7,
	Pico: 8,
} as const

export type PlatformType = (typeof PlatformType)[keyof typeof PlatformType]

/**
 * A PlatformType by value. Only Steam and Oculus (Meta) can actually be verified —
 * see the platform-auth notes on `POST /connect/token`.
 */
export const PlatformTypeSchema = z
	.union([
		z.literal(-1),
		z
			.int()
			.min(0)
			.max(Math.max(...Object.values(PlatformType))),
	])
	.describe(
		Object.entries(PlatformType)
			.map(([name, value]) => `${value} ${name}`)
			.join(', ')
	)

/**
 * One entry on the client's login screen, from `toCachedLogin` — an account ↔ platform
 * identity LINK, not an account. An account linked to two platforms yields one entry in
 * each of their pickers, each reporting the identity that picker was asked about.
 */
export const CachedLogin = z.object({
	platform: PlatformTypeSchema,
	platformId: z
		.string()
		.describe('The linked platform-native id — a SteamID64 for Steam, a user id for Meta'),
	accountId: z.int().describe('Post this back as `account_id` on a cached_login grant'),
	lastLoginTime: z.iso.datetime().describe("Falls back to the account's createdAt"),
	requirePassword: z
		.literal(false)
		.describe('Always false — platform ownership is the credential for a cached login'),
})

/**
 * The stubbed Oculus cached login served to sideloaded APKs. Same shape as `CachedLogin`,
 * but `requirePassword` is true — with no Meta SDK there is nothing to prove platform
 * ownership with, so the client falls through to username/password.
 */
export const FakeCachedLogin = CachedLogin.extend({
	requirePassword: z.literal(true).describe('Always true — the entry is not platform-backed'),
})

/** OAuth-shaped error body. Always HTTP 400 except `server_error` (500). */
export const OAuthError = z.object({
	error: z.enum(['invalid_grant', 'invalid_request', 'server_error']),
	error_description: z.string(),
})

/** Successful `POST /connect/token` body. */
export const TokenResponse = z.object({
	access_token: z.string().describe('Signed JWT; `sub` is the account id'),
	expires_in: z.int().describe('Access-token lifetime in seconds (TOKEN_TTL_SECONDS)'),
	token_type: z.literal('Bearer'),
	refresh_token: z
		.string()
		.describe('Single-use; redeem via grant_type=refresh_token, which rotates it'),
	scope: z.string().describe('Space-separated granted scopes'),
	key: z.string().describe('@kludge Constant the client appears to require. Purpose unknown.'),
})

/**
 * `POST /connect/token` form body — the union of every grant's fields, since
 * OpenAPI cannot express "these fields iff grant_type=X" without splitting the
 * endpoint. Per-grant requirements are spelled out in the route description.
 */
export const TokenRequest = z.object({
	grant_type: z
		.enum(['create_account', 'cached_login', 'refresh_token', 'password'])
		.describe('Anything unrecognised (including absent) is treated as a password grant'),
	account_id: z.string().optional().describe('Numeric account id, as a string'),
	username: z
		.string()
		.optional()
		.describe('Password grant alternative to account_id; case-insensitive, trimmed'),
	password: z
		.string()
		.optional()
		.describe('Required on a password grant. On create_account, sets the initial password'),
	platform: z.string().optional().describe('PlatformType as an integer string'),
	platform_id: z
		.string()
		.optional()
		.describe(
			'On Steam, unverified and ignored in favour of the id the ticket carries. On Meta it is ' +
				'the id the nonce is validated against, so it must be the real (numeric) user id'
		),
	platform_auth: z
		.string()
		.optional()
		.describe(
			'Platform proof, required for cached_login and platform create_account, and used to ' +
				'link the identity on a password grant. Steam: `{"Ticket":"<hex>","AppId":…}`. ' +
				'Meta: `{"Nonce":…,"AppId":…,"Source":…}`'
		),
	refresh_token: z.string().optional().describe('Required on a refresh_token grant'),
	device_id: z
		.string()
		.optional()
		.describe('Client-chosen, unverified. Recorded on the account, never trusted'),
	device_class: z.string().optional().describe('Integer string; defaults to 0'),
	ver: z
		.string()
		.optional()
		.describe(
			'The client’s build, e.g. `20250718.01`. Stamped into the token’s `rn.ver` claim and ' +
				'read back by `match` when it writes presence, so a player reports the build they ' +
				'are running. Absent (or empty) falls back to the server’s GAME_VERSION'
		),
})

/** `POST /account/me/changepassword` form body. */
export const ChangePasswordRequest = z.object({
	newPassword: z.string().describe('Required; empty is rejected'),
	oldPassword: z
		.string()
		.optional()
		.describe('Must match when the account already has a password; empty when first setting it'),
})

/** `POST /account/me/changepassword` response body. */
export const ChangePasswordResponse = z.object({
	success: z.boolean(),
	error: z.string().optional(),
})

/**
 * Spec for the `/role/:role/:id` lookups, which are identical apart from the role.
 * Both return a BARE JSON boolean rather than an object — the client reads the whole
 * body as a bool — and 404 an unknown player, mirroring the reference API.
 */
export function roleLookup(role: 'developer' | 'moderator') {
	return {
		tags: ['Roles'],
		summary: `Whether a player has the ${role} role`,
		description:
			`Returns a bare JSON boolean (\`true\`/\`false\`), not an object. Off by default and ` +
			`granted only by an operator via \`runx admin grant-${role}\`. The same flag also rides ` +
			`in the access token's \`role\` claim, so the client rarely needs this route.`,
		parameters: [
			{
				name: 'id',
				in: 'path' as const,
				required: true,
				description: 'Account id. A non-numeric value is treated as unknown (404).',
				schema: { type: 'string' as const },
			},
		],
		responses: {
			200: json(z.boolean(), `\`true\` if the player has the ${role} role`),
			404: { description: 'No such player (empty body)' },
		},
	}
}

/** Bulk cached-login lookup form body: repeated `id=` fields. */
export const PlatformIdsRequest = z.object({
	id: z.union([z.string(), z.array(z.string())]).describe('Repeated `id=` form fields'),
})
