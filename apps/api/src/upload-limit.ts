import { intVar } from '@repo/hono-helpers'

import type { App } from './context'

/** Safe fallback when the deployment does not configure an API upload ceiling. */
export const DEFAULT_MAX_API_UPLOAD_BYTES = 64 * 1024 * 1024

/**
 * Resolve the per-file ceiling shared by API-owned image uploads. A non-positive
 * setting does not disable the protection: public upload routes must always remain
 * bounded, so invalid values fall back to the safe default.
 */
export function maxApiUploadBytes(env: App['Bindings']): number {
	const configured = intVar(env.RECFLARE_MAX_API_UPLOAD_BYTES, DEFAULT_MAX_API_UPLOAD_BYTES)
	return configured > 0 ? configured : DEFAULT_MAX_API_UPLOAD_BYTES
}

/** Whether a parsed multipart file is safe to copy into memory and persist to R2. */
export function exceedsApiUploadLimit(file: File, limit: number): boolean {
	return file.size > limit
}
