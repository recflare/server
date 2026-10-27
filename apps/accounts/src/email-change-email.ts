/**
 * The email that confirms a change of address, as the message builder Cloudflare Email
 * Sending takes (`env.EMAIL.send(...)`). A pure function of its inputs, so the message can
 * be read in a test without a mail service in the way.
 *
 * Two different letters, one per step of the change (see `/account/me/email`):
 *
 *  - To the CURRENT address, when the account has one: "someone signed in to your account
 *    wants to change its email to X". The point of confirming at all — a stolen session
 *    can't move the address, and with it the password recovery, somewhere else.
 *  - To the NEW address, once the current one has approved (or at once, when there is none):
 *    "confirm this is yours". Proves the address being added is reachable before it is
 *    stored, so a typo never becomes the recovery address.
 *
 * Either way the code is printed and prefilled into a link to the website's confirm page,
 * which needs the account's own session to post it: the code approves the change, the
 * session says whose.
 */

import { escapeHtml } from '@repo/domain'

/** The website's confirm page, which reads `code` off the query and wants a session. */
export const CONFIRM_EMAIL_PATH = '/confirm-email'

export interface EmailChangeEmailInput {
	/** Where the email goes: the current address when there is one, else the new one. */
	to: string
	/** The address it comes from; must be on a domain enabled for Email Sending. */
	from: string
	/** The server's base domain, named as the sender and in the copy. */
	domain: string
	/** The website's origin (`https://www.<domain>`), which the confirm link is built on. */
	www: string
	/** The six-digit code, in plaintext — the only place it is written down. */
	code: string
	/** The address the account would change to. */
	newEmail: string
	/** The address this letter asks to give up, or null for the letter to the new address. */
	currentEmail: string | null
	/** How long the code is good for, in minutes, for the copy. */
	validMinutes: number
}

/** The confirm link: the website's page with the code already filled in. */
export function confirmEmailUrl(www: string, code: string): string {
	const url = new URL(CONFIRM_EMAIL_PATH, www)
	url.searchParams.set('code', code)
	return url.toString()
}

export function emailChangeEmail(input: EmailChangeEmailInput) {
	const link = confirmEmailUrl(input.www, input.code)
	const changing = input.currentEmail !== null
	const subject = changing
		? `Confirm the new email address on your ${input.domain} account`
		: `Confirm your ${input.domain} email address`
	const opening = changing
		? `Someone signed in to your ${input.domain} account asked to change its email address from this one to ${input.newEmail}.`
		: `This address is being set on a ${input.domain} account. Confirm it to finish.`
	const closing = changing
		? `The code works once and for ${input.validMinutes} minutes. If you didn't ask for this, don't enter it — nothing changes without it, and this address stays on the account. Someone else may have your password: sign in and change it, or use "Forgot password".`
		: `The code works once and for ${input.validMinutes} minutes. If you didn't set this address on an account, ignore this email — nothing changes without the code.`
	const text = [
		opening,
		'',
		`Your code is: ${input.code}`,
		'',
		'Confirm it here (you will need to sign in):',
		link,
		'',
		closing,
	].join('\n')
	const html = [
		`<p>${escapeHtml(opening)}</p>`,
		`<p>Your code is: <strong style="font-size:1.5em;letter-spacing:0.15em">${input.code}</strong></p>`,
		`<p><a href="${escapeHtml(link)}">Confirm it here</a> (you will need to sign in).</p>`,
		`<p>${escapeHtml(closing)}</p>`,
	].join('\n')
	return {
		to: input.to,
		from: { email: input.from, name: input.domain },
		subject,
		text,
		html,
	}
}
