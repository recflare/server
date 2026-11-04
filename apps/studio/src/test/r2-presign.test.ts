import { expect, it } from 'vitest'

import { presignUrl } from '@repo/hono-helpers'

// Shared with PR #153; multipart adds operation query parameters to that same signer.
it('signs multipart identifiers, encoded values and exact part headers', async () => {
	const options = {
		method: 'PUT' as const,
		host: 'acct.r2.cloudflarestorage.com',
		path: '/bucket/build/part',
		region: 'auto',
		accessKeyId: 'key',
		secretAccessKey: 'secret',
		expiresIn: 120,
		now: new Date('2026-11-03T12:00:00Z'),
		headers: { 'content-type': 'application/octet-stream', 'content-length': '16777216' },
		query: { uploadId: 'id+/=with spaces', partNumber: '1' },
	}
	const signed = new URL(await presignUrl(options))
	expect(signed.searchParams.get('uploadId')).toBe(options.query.uploadId)
	expect(signed.searchParams.get('X-Amz-SignedHeaders')).toBe('content-length;content-type;host')
	const changed = new URL(
		await presignUrl({ ...options, query: { ...options.query, partNumber: '2' } })
	)
	expect(changed.searchParams.get('X-Amz-Signature')).not.toBe(
		signed.searchParams.get('X-Amz-Signature')
	)
	await expect(presignUrl({ ...options, query: { 'X-Amz-Date': 'override' } })).rejects.toThrow(
		'Reserved'
	)
})

// The worked example from AWS's own SigV4 documentation ("Authenticating Requests: Using Query
// Parameters"): a GET of /test.txt in `examplebucket`, signed with the documentation's example
// key at the documentation's example time. Matching its published signature byte for byte is
// what shows this implementation agrees with a real S3 signer, not just with itself.
it('reproduces the AWS documentation presigned URL signature', async () => {
	const url = await presignUrl({
		method: 'GET',
		host: 'examplebucket.s3.amazonaws.com',
		path: '/test.txt',
		region: 'us-east-1',
		accessKeyId: 'AKIAIOSFODNN7EXAMPLE',
		secretAccessKey: 'wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY',
		expiresIn: 86400,
		now: new Date('2013-05-24T00:00:00Z'),
	})
	expect(url).toBe(
		'https://examplebucket.s3.amazonaws.com/test.txt?' +
			'X-Amz-Algorithm=AWS4-HMAC-SHA256' +
			'&X-Amz-Credential=AKIAIOSFODNN7EXAMPLE%2F20130524%2Fus-east-1%2Fs3%2Faws4_request' +
			'&X-Amz-Date=20130524T000000Z' +
			'&X-Amz-Expires=86400' +
			'&X-Amz-SignedHeaders=host' +
			'&X-Amz-Signature=aeeed9bbccd4d02ee5c0109b86d86835f995330da4c265957d157751f604d404'
	)
})

it('binds extra headers into the signature and encodes the path per segment', async () => {
	const base = {
		method: 'PUT' as const,
		host: 'acct.r2.cloudflarestorage.com',
		path: '/bucket/video/a b(1).mp4',
		region: 'auto',
		accessKeyId: 'key',
		secretAccessKey: 'secret',
		expiresIn: 900,
		now: new Date('2026-11-02T12:00:00Z'),
	}
	const plain = new URL(await presignUrl(base))
	const pinned = new URL(await presignUrl({ ...base, headers: { 'content-type': 'video/mp4' } }))

	// Slashes between segments stay; everything else in a segment is percent-encoded.
	expect(plain.pathname).toBe('/bucket/video/a%20b%281%29.mp4')
	expect(plain.searchParams.get('X-Amz-SignedHeaders')).toBe('host')
	expect(pinned.searchParams.get('X-Amz-SignedHeaders')).toBe('content-type;host')
	// A different set of signed headers is a different signature.
	expect(pinned.searchParams.get('X-Amz-Signature')).not.toBe(
		plain.searchParams.get('X-Amz-Signature')
	)
})
