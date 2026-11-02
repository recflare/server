/**
 * Query-string (presigned) AWS Signature V4 for R2's S3-compatible endpoint, on WebCrypto.
 *
 * Written out rather than pulled from an SDK: signing one `PUT` is a page of code, and the
 * Workers runtime has no AWS client. Only what R2 needs is here — path-style URLs, `UNSIGNED-PAYLOAD`
 * and `host` plus any headers the caller binds into the signature. The test pins the output against
 * the worked example in AWS's own SigV4 documentation, so a mistake here fails loudly.
 *
 * The R2 binding (`env.CDN_ASSETS`) cannot sign: a presigned URL needs an S3 API token, which is
 * why the www worker carries one (see wrangler.jsonc).
 */

const encoder = new TextEncoder()

export interface PresignOptions {
	method: 'GET' | 'PUT'
	/** The endpoint host, e.g. `<account id>.r2.cloudflarestorage.com`. */
	host: string
	/** The absolute, UNENCODED path — path-style, so `/<bucket>/<key>`. Encoded per segment here. */
	path: string
	/** `auto` for R2. */
	region: string
	accessKeyId: string
	secretAccessKey: string
	/** Seconds the URL stays valid (R2 allows 1 to 604800). */
	expiresIn: number
	/**
	 * Headers bound into the signature besides `host`, lower-cased names. The browser must then
	 * send exactly these values with the request, which is how a content type is pinned.
	 */
	headers?: Record<string, string>
	/** Signing time; defaults to now. Only a test needs to set it. */
	now?: Date
}

/** RFC 3986 percent-encoding, which `encodeURIComponent` leaves short of by `!'()*`. */
const uriEncode = (value: string): string =>
	encodeURIComponent(value).replace(
		/[!'()*]/g,
		(ch) => `%${ch.charCodeAt(0).toString(16).toUpperCase()}`
	)

const toHex = (bytes: ArrayBuffer): string =>
	[...new Uint8Array(bytes)].map((b) => b.toString(16).padStart(2, '0')).join('')

async function hmac(
	key: ArrayBuffer | Uint8Array<ArrayBuffer>,
	data: string
): Promise<ArrayBuffer> {
	const imported = await crypto.subtle.importKey(
		'raw',
		key,
		{ name: 'HMAC', hash: 'SHA-256' },
		false,
		['sign']
	)
	return crypto.subtle.sign('HMAC', imported, encoder.encode(data))
}

/** A presigned URL: the request it names is valid until `expiresIn` seconds from signing. */
export async function presignUrl(options: PresignOptions): Promise<string> {
	const { method, host, path, region, accessKeyId, secretAccessKey, expiresIn } = options
	const stamp = (options.now ?? new Date()).toISOString().replace(/[:-]|\.\d{3}/g, '')
	const date = stamp.slice(0, 8)
	const scope = `${date}/${region}/s3/aws4_request`

	const headers: Record<string, string> = { host, ...options.headers }
	const names = Object.keys(headers).sort()
	const canonicalHeaders = names.map((n) => `${n}:${headers[n]!.trim()}\n`).join('')
	const signedHeaders = names.join(';')

	const query: Array<[string, string]> = [
		['X-Amz-Algorithm', 'AWS4-HMAC-SHA256'],
		['X-Amz-Credential', `${accessKeyId}/${scope}`],
		['X-Amz-Date', stamp],
		['X-Amz-Expires', String(expiresIn)],
		['X-Amz-SignedHeaders', signedHeaders],
	]
	const canonicalQuery = query
		.map(([k, v]) => `${uriEncode(k)}=${uriEncode(v)}`)
		.sort()
		.join('&')
	const canonicalPath = path.split('/').map(uriEncode).join('/')

	const canonicalRequest = [
		method,
		canonicalPath,
		canonicalQuery,
		canonicalHeaders,
		signedHeaders,
		'UNSIGNED-PAYLOAD',
	].join('\n')
	const stringToSign = [
		'AWS4-HMAC-SHA256',
		stamp,
		scope,
		toHex(await crypto.subtle.digest('SHA-256', encoder.encode(canonicalRequest))),
	].join('\n')

	let key: ArrayBuffer = await hmac(new Uint8Array(encoder.encode(`AWS4${secretAccessKey}`)), date)
	for (const part of [region, 's3', 'aws4_request']) key = await hmac(key, part)
	const signature = toHex(await hmac(key, stringToSign))

	return `https://${host}${canonicalPath}?${canonicalQuery}&X-Amz-Signature=${signature}`
}
