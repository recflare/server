import isEmail from 'isemail'

/**
 * Limits on the free text a player can put into their account and their rooms.
 *
 * Shared by `accounts` and `rooms` so one rule can't drift from the other — a username
 * and a room name are held to nearly the same shape (a room name also takes underscores),
 * and both are typed into the same client.
 *
 * These check only what a player SUPPLIES. Names the server generates go around them:
 * a dorm is called `@<username>'s Dorm` (see `rooms-db.ts`), which the name rule below
 * would reject, and auto-assigned usernames (`SwiftFox4821`, `Player42`) happen to
 * satisfy it. So validate at the request handler, never inside the db helpers.
 *
 * Emptiness is deliberately NOT checked here. Every caller already rejects an empty
 * value in its own words, and those sentences reach players through response envelopes
 * the client renders verbatim — see the client-contract notes in CLAUDE.md.
 */

/**
 * Name lengths. All three come from what the CLIENT will accept in the matching input
 * box, not from a round number: accepting more here would store a name the game can't
 * re-enter or edit, so the server matches the box rather than being generous.
 */
export const MAX_USERNAME_LENGTH = 50
export const MAX_DISPLAY_NAME_LENGTH = 15
export const MAX_ROOM_NAME_LENGTH = 32

/**
 * Club and event limits. Longer than the name limits above because these aren't
 * identifiers — a club name and an event name are titles, and both allow the
 * punctuation and spaces a title needs (clubs enforce their own charset rule; events
 * enforce none at all, since an event is called things like "Building a Better Room
 * Using Trigonometry").
 */
export const MAX_CLUB_NAME_LENGTH = 40
export const MAX_CLUB_DESCRIPTION_LENGTH = 512
export const MAX_EVENT_NAME_LENGTH = 64
export const MAX_EVENT_DESCRIPTION_LENGTH = 512

/**
 * The longest a player event may run — a day, inclusive, so a full 24-hour event is
 * allowed and anything past it is refused. An event is a scheduled get-together in one
 * room, not a season: a window of weeks would sit in the browse feed's "upcoming" and
 * "happening now" rows indefinitely, crowding out everything real.
 *
 * Applied to the window a write RESOLVES to, not to the fields it carries — an edit that
 * moves one bound is checked against the stored other one. See `eventInputRejection` in
 * the api worker.
 */
export const MAX_EVENT_DURATION_MS = 24 * 60 * 60 * 1000

/**
 * Invention limits. A name is a title a player types into the invention-save box and
 * reads back in a browse tile, so it allows the punctuation a title needs — but
 * nothing else, since it is also what invention search matches on. The minimum is real:
 * one- and two-character names are unsearchable and unreadable in a tile, and the client
 * offers `Untitled` rather than an empty box.
 */
export const MIN_INVENTION_NAME_LENGTH = 3
export const MAX_INVENTION_NAME_LENGTH = 24
export const MAX_INVENTION_DESCRIPTION_LENGTH = 512

/**
 * The long description — the blurb on an invention's detail page, as opposed to the one
 * line that fits under a browse tile. The client sends it on `v9/save` and edits it
 * through `v2/metadata`, and how long it lets one get has not been pinned down, so the cap
 * here is this server's own: generous enough that no real blurb hits it, small enough that
 * a record stays a record. It is checked only when a caller actually sends one.
 */
export const MAX_INVENTION_LONG_DESCRIPTION_LENGTH = 4096

/**
 * One invention tag. Short and letters-only because tags are a controlled vocabulary the
 * browse chips are derived from (see `getInventionTagFilters`) — a tag with digits,
 * punctuation or spaces makes a chip nobody else will ever type again. Tags are stored
 * lowercased, so the rule is checked against the normalized form, not what was typed.
 */
export const MAX_INVENTION_TAG_LENGTH = 15

/**
 * Length in code points rather than UTF-16 units, so an emoji or other astral character
 * counts once instead of twice — the way a player counts what they typed.
 */
export const glyphLength = (value: string): number => Array.from(value).length

/** Max length of a profile bio. */
export const MAX_BIO_LENGTH = 255

/**
 * Letters and digits only — no spaces, punctuation, or accents.
 *
 * Deliberately narrow: these names are shown to other players, used to search, and (for
 * usernames) typed into a sign-in box, so anything that can be confused for another name
 * is worth refusing. It also rules out the homoglyph and right-to-left tricks that come
 * with allowing arbitrary Unicode.
 */
const NAME_PATTERN = /^[A-Za-z0-9]+$/

/**
 * Why a player-supplied name is unacceptable, or `null` when it's fine.
 *
 * `label` names the thing in the returned sentence ('username', 'room name'), so the
 * message reads correctly wherever it's surfaced. `max` is required rather than
 * defaulted: the three limits differ, and a caller that forgets which one it wants
 * should have to say so instead of silently taking someone else's.
 */
export function nameRejection(value: string, label: string, max: number): string | null {
	if (value.length > max) {
		return `Your ${label} can be at most ${max} characters.`
	}
	if (!NAME_PATTERN.test(value)) {
		return `Your ${label} can only contain letters and numbers.`
	}
	return null
}

/**
 * Letters, digits and underscores — `NAME_PATTERN` plus the one separator a room name is
 * allowed. A room name is a label other players read in a browse tile rather than
 * something typed into a sign-in box, and the underscore is how players write the space
 * the rule still refuses (`Laser_Tag`). It carries none of the homoglyph or
 * right-to-left risk that widening to arbitrary Unicode would.
 */
const ROOM_NAME_PATTERN = /^[A-Za-z0-9_]+$/

/**
 * Why a player-supplied room or subroom name is unacceptable, or `null` when it's fine.
 *
 * Separate from `nameRejection` rather than a flag on it: usernames are held to the
 * narrower rule, and the two limits differ. `label` names the thing in the returned
 * sentence ('room name', 'subroom name'), which the client renders verbatim.
 */
export function roomNameRejection(value: string, label: string): string | null {
	if (value.length > MAX_ROOM_NAME_LENGTH) {
		return `Your ${label} can be at most ${MAX_ROOM_NAME_LENGTH} characters.`
	}
	if (!ROOM_NAME_PATTERN.test(value)) {
		return `Your ${label} can only contain letters, numbers and underscores.`
	}
	return null
}

/**
 * Letters, digits, spaces, dashes and colons — the title charset. Wider than
 * `NAME_PATTERN` because an invention is a thing with a name ("Grappling Hook v2",
 * "Speed-Boost Pad"), not an identifier someone types into a sign-in box. Still no
 * arbitrary Unicode, for the same homoglyph reasons.
 *
 * The colon is not decorative: an invention the player never named is called after the
 * moment it was saved (`071126 13:10:50`), generated by the CLIENT, so a rule without it
 * would refuse every unnamed save the game makes. The dash stays last in the class so it
 * reads as a literal rather than a range.
 */
const INVENTION_NAME_PATTERN = /^[A-Za-z0-9 :-]+$/

/** Lowercase letters only — the normalized form a tag is stored in. */
const INVENTION_TAG_PATTERN = /^[a-z]+$/

/**
 * Why a player-supplied invention name is unacceptable, or `null` when it's fine.
 *
 * Callers pass the TRIMMED name: leading and trailing spaces are the player's typing,
 * not part of what they named the thing, and counting them toward the minimum would let
 * `"  a  "` through.
 */
export function inventionNameRejection(value: string): string | null {
	if (glyphLength(value) < MIN_INVENTION_NAME_LENGTH) {
		return `Invention names must be at least ${MIN_INVENTION_NAME_LENGTH} characters.`
	}
	if (glyphLength(value) > MAX_INVENTION_NAME_LENGTH) {
		return `Invention names can be at most ${MAX_INVENTION_NAME_LENGTH} characters.`
	}
	if (!INVENTION_NAME_PATTERN.test(value)) {
		return 'Invention names can only contain letters, numbers, spaces, dashes and colons.'
	}
	return null
}

/**
 * Why an invention description is unacceptable, or `null` when it's fine. Length only —
 * a description is prose, so nothing is refused for the characters it's made of, and an
 * empty one is fine (it's how a creator clears the field).
 */
export function inventionDescriptionRejection(value: string): string | null {
	if (glyphLength(value) > MAX_INVENTION_DESCRIPTION_LENGTH) {
		return `Invention descriptions can be at most ${MAX_INVENTION_DESCRIPTION_LENGTH} characters.`
	}
	return null
}

/** Why a long description can't be stored, or null when it can. */
export function inventionLongDescriptionRejection(value: string): string | null {
	if (glyphLength(value) > MAX_INVENTION_LONG_DESCRIPTION_LENGTH) {
		return `Invention long descriptions can be at most ${MAX_INVENTION_LONG_DESCRIPTION_LENGTH} characters.`
	}
	return null
}

/**
 * Why an invention tag is unacceptable, or `null` when it's fine. Pass the NORMALIZED
 * tag (trimmed and lowercased, as `setInventionTags` stores it) — checking what was typed
 * instead would refuse `Racing` for a capital that never reaches the database.
 */
export function inventionTagRejection(value: string): string | null {
	if (value.length > MAX_INVENTION_TAG_LENGTH) {
		return `Invention tags can be at most ${MAX_INVENTION_TAG_LENGTH} characters.`
	}
	if (!INVENTION_TAG_PATTERN.test(value)) {
		return 'Invention tags can only contain letters.'
	}
	return null
}

/**
 * Whether a supplied email is one worth storing — RFC 5321/5322 syntax, via `isemail`.
 *
 * A hand-rolled pattern is the wrong shape of work here: this is a contact address
 * nothing is ever sent to in order to prove it, so the only thing a stricter regex buys
 * is more edge cases to get wrong. Note it also enforces the RFC's 254-character maximum
 * itself, which is why there's no separate length cap.
 *
 * It accepts a dotless domain (`someone@localhost`), which a dotted-domain rule would
 * refuse. That's the RFC being right and the shortcut being wrong, and an undeliverable
 * address costs nothing here.
 */
export function isValidEmail(value: string): boolean {
	return isEmail.validate(value)
}

/** Whether a supplied bio is within the stored length. */
export function isValidBio(value: string): boolean {
	return value.length <= MAX_BIO_LENGTH
}
