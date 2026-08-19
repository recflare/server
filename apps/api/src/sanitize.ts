import { Profanity } from '@2toad/profanity'

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
 * Built once per isolate, not per request: the constructor compiles the word list into a
 * regex, which is the whole reason a check costs microseconds at request time. Module
 * scope is where that cost belongs.
 */
const filter = new Profanity({ wholeWord: true })
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
