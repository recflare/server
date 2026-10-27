/**
 * The password-recovery email, as the message builder Cloudflare Email Sending takes
 * (`env.EMAIL.send(...)`). A pure function of its inputs, so the message can be read in a
 * test without a mail service in the way.
 *
 * The email carries the code twice: typed out, for someone reading it on a headset or a
 * phone, and prefilled into a link to the website's reset page, where the new password is
 * actually chosen. The game only ASKS for the recovery (`POST /account/recoverpassword`);
 * it has no screen to finish one on.
 */

import { escapeHtml } from '@repo/domain'

/** The website's reset page, which reads `email` and `code` off the query. */
export const RESET_PASSWORD_PATH = '/reset-password'

export interface RecoveryEmailInput {
	/** Where the email goes — the address on the account, exactly as stored. */
	to: string
	/** The address it comes from; must be on a domain enabled for Email Sending. */
	from: string
	/** The server's base domain, named as the sender and in the copy. */
	domain: string
	/** The website's origin (`https://www.<domain>`), which the reset link is built on. */
	www: string
	/** The six-digit code, in plaintext — the only place it is written down. */
	code: string
	/** How long the code is good for, in minutes, for the copy. */
	validMinutes: number
}

/** The reset link: the website's page with the address and the code already filled in. */
export function resetPasswordUrl(www: string, email: string, code: string): string {
	const url = new URL(RESET_PASSWORD_PATH, www)
	url.searchParams.set('email', email)
	url.searchParams.set('code', code)
	return url.toString()
}

export function recoveryEmail(input: RecoveryEmailInput) {
	const link = resetPasswordUrl(input.www, input.to, input.code)
	const subject = `Your ${input.domain} password reset code`
	const text = [
		`Someone asked to reset the password of the ${input.domain} account under this email address.`,
		'',
		`Your code is: ${input.code}`,
		'',
		'Choose a new password here:',
		link,
		'',
		`The code works once and for ${input.validMinutes} minutes. If you didn't ask for this, you can ignore this email — your password hasn't changed.`,
	].join('\n')
	const html = [
		`<p>Someone asked to reset the password of the <strong>${escapeHtml(input.domain)}</strong> account under this email address.</p>`,
		`<p>Your code is: <strong style="font-size:1.5em;letter-spacing:0.15em">${input.code}</strong></p>`,
		`<p><a href="${escapeHtml(link)}">Choose a new password</a></p>`,
		`<p>The code works once and for ${input.validMinutes} minutes. If you didn't ask for this, you can ignore this email — your password hasn't changed.</p>`,
	].join('\n')
	return {
		to: input.to,
		from: { email: input.from, name: input.domain },
		subject,
		text,
		html,
	}
}
