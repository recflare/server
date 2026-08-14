/**
 * Outbound links shared by the React client and the Worker-rendered pages.
 *
 * The privacy policy (`privacy.ts`) is rendered server-side while the rest of the site
 * is a React SPA, so both need the same Discord/GitHub URLs. They live here so a moved
 * invite or a renamed repo is one edit, not two that can silently drift — the policy
 * naming a dead contact channel is exactly what VRC.Privacy.4 fails on.
 */

/** The community Discord — the join instructions and the build both live there. */
export const DISCORD_INVITE = 'https://discord.gg/HhmMAKhrz'

/** Where the stage's "Download for PC" button goes: the client's release listing. */
export const DOWNLOAD_URL = 'https://github.com/djdevin/recflare-client/releases'

/** The stage's "Download for Quest" button: the build's listing on the Meta store. */
export const QUEST_DOWNLOAD_URL = 'https://www.meta.com/s/6lL20Fnhz'

/** The public source repo, linked from the homepage and footer. */
export const SOURCE_REPO = 'https://github.com/djdevin/recflare'

/** The repo's licence, behind the footer's "MIT licensed". */
export const LICENSE_URL = `${SOURCE_REPO}/blob/main/LICENSE`

/** Where a data-deletion or privacy request can be opened without a Discord account. */
export const ISSUES_URL = `${SOURCE_REPO}/issues/new`

/**
 * Mailbox for privacy and data-deletion requests, or '' when there isn't one.
 *
 * Empty by default on purpose: an address printed here that nobody reads is worse than
 * no address at all, and Meta re-validates the policy after approval. While it's empty
 * the policy routes deletion requests through Discord and GitHub issues, both of which
 * are free and open to anyone in any region — which is what VRC.Privacy.4 asks for. Set
 * it to a real, monitored mailbox and the policy adds it as the preferred contact.
 */
export const PRIVACY_EMAIL: string = 'privacy@recflare.net'
