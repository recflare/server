/**
 * Serving R2 objects to clients that ask for byte ranges.
 *
 * Shared because getting it wrong is silent: a downloader that asked for a slice writes
 * whatever comes back at the offset it asked for, so answering a `Range` request with a
 * whole-object 200 corrupts the reassembled file rather than failing it. Both `cdn` and
 * `img` stream R2 objects, so both need the same rule.
 *
 * Pass the request's headers straight to `get(key, { range: c.req.raw.headers })`: R2
 * parses the `Range` header itself and resolves every form (`bytes=a-b`, `bytes=a-`,
 * `bytes=-n`) to a concrete offset/length, so there is no grammar to reimplement — and a
 * hand-rolled parser is exactly where the whole-object 200 crept in, because the values it
 * failed to parse became "no range at all". Anything R2 cannot parse or satisfy resolves
 * to the whole object; `contentRange` is what keeps that honest.
 */

/**
 * Write `Content-Range` and `Content-Length` onto the response headers for a body R2 has
 * returned, and report whether the response must therefore be a 206.
 *
 * Returns true for any `bytes=` request that produced a resolved range — INCLUDING one
 * covering the whole object. R2 answers a multi-range or unsatisfiable value with every
 * byte, and the safe way to hand that back is a 206 stating which bytes are enclosed: a
 * client can act on `bytes 0-5/6`, but a bare 200 tells it nothing and it assumes the body
 * is the slice it asked for.
 *
 * Returns false — writing nothing — when the request named a unit other than `bytes` (RFC
 * 9110 says an unrecognised unit must be ignored, and answering it in bytes would be its
 * own lie), when no `Range` was sent, or when R2 returned no range.
 */
export function writeContentRange(
	headers: Headers,
	requestHeaders: Headers,
	object: R2Object
): boolean {
	if (!requestHeaders.get('range')?.startsWith('bytes=')) return false
	// R2 hands back the RESOLVED range, and the object carries all three keys with the
	// inapplicable ones set to undefined — so `'suffix' in r` is true even for an
	// offset/length range and cannot discriminate between the two forms. (It read as a
	// suffix range every time, making offset/length NaN and the header garbage.) Read the
	// values, not the keys. A `bytes=-N` request already comes back resolved to a concrete
	// offset/length; the suffix fallback is only there in case that ever stops being true.
	const r = object.range as { offset?: number; length?: number; suffix?: number } | undefined
	if (!r) return false
	const length = r.length ?? r.suffix ?? object.size - (r.offset ?? 0)
	const offset = r.offset ?? object.size - length
	headers.set('content-length', String(length))
	headers.set('content-range', `bytes ${offset}-${offset + length - 1}/${object.size}`)
	return true
}
