import { CensorType, Profanity } from '@2toad/profanity'

/**
 * The profanity filter behind `POST /api/sanitize/v1/isPure`.
 *
 * The word list is `@2toad/profanity`'s rather than one of ours: the hard part of this is
 * not naming swears, it's not flagging ordinary text — a filter that rejects "Grape
 * Escape" or "Title Screen" as a room name is worse than no filter, because the player is
 * told their name is unacceptable and can't see why. It matches whole words, so `grape`,
 * `analysis`, `assassin`, `class` and `Scunthorpe` come out clean, while leetspeak
 * (`sh1t`, `a$$hole`) and letters spaced apart (`f u c k`) do not.
 *
 * Two knobs below adjust the list for this server; the matching itself is the library's.
 */

/**
 * Words to filter on top of the library's list — the ones it doesn't carry but a room
 * full of players will find. Matched as whole words like everything else, so `kys` here
 * doesn't flag `skyscraper`.
 */
const EXTRA_WORDS: string[] = ['kys', 'molest']

/**
 * Innocent words that the list reads a swear inside of. Empty today — the whole-word
 * matching means the usual victims (`shiitake`, `Scunthorpe`, `analysis`) already pass —
 * and this is where one goes if a player ever turns up with a name it gets wrong, rather
 * than a change to how matching works.
 */
const ALLOWED_WORDS: string[] = []

/**
 * A character that cannot appear in text a player typed, used to find where the filter
 * matched: censoring with {@link CensorType.FirstChar} replaces the first character of
 * every match with it and leaves the length alone, so the marker positions in the result
 * ARE the match offsets in the original. The library exposes no other way to ask where a
 * match is — its own censor replaces a match with a fixed string, which loses the length
 * the client's `ReplacementChar` is meant to preserve.
 *
 * Stripped from the input before use, so nothing can smuggle one in and confuse the scan.
 */
const MARKER = '\u0000'

/**
 * Built once per isolate, not per request: the constructor compiles the word list into a
 * regex, which is the whole reason a check costs microseconds at request time. Module
 * scope is where that cost belongs.
 */
const filter = new Profanity({ wholeWord: true, grawlixChar: MARKER })
filter.addWords(EXTRA_WORDS)
filter.whitelist.addWords(ALLOWED_WORDS)

/**
 * Whether `value` contains a swear. Mirrors the reference server's
 * `Sanitize.ContainsSwears`, which is the whole of what `isPure` reports.
 *
 * An empty value is clean — the client checks a field as it's being typed, and an empty
 * box is not something to refuse.
 */
export function containsSwears(value: string): boolean {
	return value !== '' && filter.exists(value)
}

/** The mask `POST /api/sanitize/v1` uses when the request names no `ReplacementChar`. */
export const DEFAULT_REPLACEMENT_CHAR = '*'

/**
 * How far past a match's start to look for the end of it. Long enough for a swear spaced
 * out letter by letter (`f u c k`), short enough that the probe below stays bounded.
 */
const MAX_SPAN = 40

/**
 * Characters that carry no text: control codes, and the format characters (zero-width
 * joiners, bidi overrides, the byte-order mark) whose whole use in a chat message is to
 * break a word up so a filter reads it as two. Removed on request — the client asks with
 * `PreRemoveBlockedCharacters`.
 */
const BLOCKED_CHARACTERS = /[\p{Cc}\p{Cf}]/gu

/** Strip the characters {@link BLOCKED_CHARACTERS} describes. */
export function removeBlockedCharacters(value: string): string {
	return value.replaceAll(BLOCKED_CHARACTERS, '')
}

/**
 * Where the match starting at `start` ends.
 *
 * The library reports where a match begins but not how far it runs, so the shortest
 * stretch from `start` that it still objects to is taken as the match — `fuck` out of
 * `fuck you`, rather than the whole line. That stretch is then extended to the end of the
 * word it sits in, so a match inside a longer word masks the word (`a$$hole` whole, not
 * `a$$h` with `ole` left showing) — which is what whole-word matching found it as.
 */
function spanEnd(text: string, start: number): number {
	let end = start + 1
	for (let k = 1; k <= MAX_SPAN && start + k <= text.length; k++) {
		if (containsSwears(text.slice(start, start + k))) {
			end = start + k
			break
		}
	}
	while (end < text.length && !/\s/.test(text[end] ?? '')) end++
	return end
}

/**
 * `value` with every swear in it masked, one `replacementChar` per character — the body
 * of `POST /api/sanitize/v1`. Text with nothing to object to comes back untouched, which
 * is the common case and costs a single regex.
 *
 * Masking per character rather than replacing the word with a fixed string keeps the
 * shape of the message: the client asked for a `ReplacementChar`, and a four-letter word
 * is expected to come back as four of them.
 */
export function censorSwears(
	value: string,
	replacementChar: string = DEFAULT_REPLACEMENT_CHAR
): string {
	const text = value.replaceAll(MARKER, '')
	if (!containsSwears(text)) return text

	// A single character, whatever the client sent — a mask is one character repeated, and
	// an empty or absent one falls back rather than deleting the word silently.
	const mask = [...replacementChar][0] ?? DEFAULT_REPLACEMENT_CHAR
	const marked = filter.censor(text, CensorType.FirstChar)

	let censored = ''
	let copied = 0
	for (let i = 0; i < marked.length; i++) {
		if (marked[i] !== MARKER) continue
		const end = spanEnd(text, i)
		censored += text.slice(copied, i) + mask.repeat(end - i)
		copied = end
		// Any further marks inside the span just masked are part of it.
		i = end - 1
	}
	return censored + text.slice(copied)
}
