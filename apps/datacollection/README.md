# datacollection

Client telemetry sink, served on the `datacollection` subdomain. Nothing here stores or
forwards what it receives — there is no analytics backend behind this server — so both
routes are acknowledgements, and neither is auth-gated (the client posts before a session
is fully established, and treats a failure as a reason to retry).

- `POST /data/event` — a single gameplay/analytics event. Discarded; answers `{}`. The
  client only checks that the call succeeded and never reads the body.
- `POST /data/events` — the same for a batch of them. Answers `[]` — an array, mirroring
  the request's, not the singular path's object.
- `GET /sampling?sessionId=<guid>` — sampling configuration, asked for once per session.
  `{}` carries no per-event overrides, which the client reads as "sample at the built-in
  default rates". The `sessionId` is not read.

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
