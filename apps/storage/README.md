# storage

A Cloudflare Workers application using Hono

## Development

### Run in dev mode

```sh
pnpm dev
```

### Run tests

```sh
pnpm test
```

### Deploy

```sh
pnpm turbo deploy
```

## Studio uploads

`POST /upload/unityassets` accepts authenticated repeated multipart file parts,
including the gzip-compressed multipart requests sent by Studio. It returns one
`{ Filename, Hash }` per part in request order. `Hash` is base64 SHA-256;
`Filename` matches the SDK's content-addressed source manifest: unsigned
little-endian SHA-256 encoded as base36, padded to 50 characters and truncated to
its first 40. Retrying identical content therefore returns the same names.
Source bytes are stored under `unityasset/<Filename>` for CDN GET/HEAD readback.

`POST /upload` also decodes gzip multipart bodies for Studio manifests and room
saves. Malformed compression/forms return 400; unsupported encodings return 415.
Expanded request bodies are bounded before form parsing (with 64 KiB for the
multipart envelope), then the configured file-size limit is checked. Existing
staff size exemptions on the single-file route are preserved.

## Developer video uploads

`POST /upload/video` (developer tokens only) takes `{ "filename": "intro.mp4" }` and answers
`{ uploadUrl, key, contentType, expiresIn }`: a presigned `PUT` for the `recflare-cdn` bucket,
valid for 15 minutes, that the browser sends the file to directly, so a large video never passes
through the worker. The `Content-Type` is chosen from the extension (`.mp4`, `.m4v`, `.webm`,
`.mov`) and bound into the signature, so the `PUT` must send exactly `contentType`. The key is
`video/<name>-<8 hex>.<ext>`; reusing a filename never replaces another upload. The `cdn` worker
serves it at `/video/<name>`.

Signing needs an R2 API token (the `R2_ACCESS_KEY_ID` and `R2_SECRET_ACCESS_KEY` Secrets Store
bindings) and the account id (`RECFLARE_R2_ACCOUNT_ID`), and the bucket needs a CORS rule allowing
`PUT` with a `Content-Type` header from the website's origin. Until they are set the route
answers 503. There is no audit table here, so each issued URL is a log line with the account and
key.
