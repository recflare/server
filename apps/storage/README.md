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
