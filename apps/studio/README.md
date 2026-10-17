# studio

The RecFlare Studio host (`https://studio.<domain>`).

Device login stays on Auth, `GET /account/me` stays on Accounts, and the approval
page is WWW `/device`. This worker queues cloud builds, accepts completed bundles,
and serves build status and co-owner presence. Rooms exposes playable bundles in
`CurrentSave.UnitySubAssets`; their bytes are served by the CDN at `/room/{filename}`.
The Rooms `GET /rooms/{roomId}/subrooms/{subRoomId}/unityasset` route separately
returns the editable source manifest and available build metadata.

| Method | Path                                     | Purpose                                                                                                                                                                                                                                                                                                                                    |
| ------ | ---------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `GET`  | `/cloud-builds/for-room`                 | Cloud builds for that room and subroom, newest first (`results`, `totalResults`). Query: `roomId`, `subRoomId`, `skip`, `take`. A bad query is an empty page.                                                                                                                                                                              |
| `GET`  | `/cloud-builds/get-build-count-for-user` | Authenticated user's Studio build totals for the current UTC-hour rate-limit window.                                                                                                                                                                                                                                                       |
| `POST` | `/cloud-builds/from-editor`              | Multipart Windows bundle (`windows`) and Android bundle (`android`), optional `windowsStripped` and `androidStripped`. Stores a finished build on the subroom's current published save and sets `BecameRRStudioRoomAt` the first time. Bearer required, and the token must include `betastudio`. Caller must be the creator or a co-owner. |
| `GET`  | `/collaboration/owners-in-room`          | Account ids of the room's co-owners (creator, or a Creator/CoOwner role) whose live presence is in that `roomId` and `subRoomId`. Body: `{ success: true, error: null, value: number[] }`. Bearer required.                                                                                                                                |

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

### Migrate

This worker owns `studio_cloud_build` on the shared `recflare` database (`migrations/`,
tracked in its own `d1_migrations_studio` table). The bundles themselves are rows of the
rooms worker's `unity_asset` (one per platform and kind: target 0 Windows / 2 Android,
`studio/<roomId>/<name>.assetbundle` as `filename` — the bytes sit at `room/<filename>` in
the bucket, the prefix the client adds — base64 SHA-256 as `hash`), so a stored build needs
the rooms migrations too. Deploying does not apply either.

```sh
just migrate -F studio             # remote
just migrate -F studio -- --local  # dev db
```

## Editor build limits

`GET /cloud-builds/get-rate-limit-config` returns the editor's
`CloudBuildRateLimitConfigDTO` directly: `buildThrottleIntervalHours` (1),
`warnAfterBuildsPerInterval` (90), and `maxBuildsPerInterval` (100). These names
matter: unknown keys leave the DTO's maximum at zero and block even a first build.
The authenticated `get-build-count-for-user` route provides the user's counts.

## Queued Studio builds

`POST /cloud-builds/create` accepts the SDK's room, subroom, save, auto-publish,
and optional target fields. It requires Studio authorization and room management
rights, validates the uploaded source manifest, and returns a numeric string
build ID with a null completion time. Repeated requests for an in-progress save
reuse its job. `GET /cloud-builds?cloudBuildId=...` reads the status;
`PUT /cloud-builds/cancel` cancels a queued or running job.

Apply migration `0003_studio_cloud_build_job.sql`. Configure a private
`CLOUD_BUILD_KEY` and run the outbound worker from `recflare/cloud-building` with
the matching credential. Without a key, creation returns an explicit unavailable
response. `CLOUD_BUILD_TARGETS` defaults to `0,2` (Windows and Android), and
`CLOUD_BUILD_TEMPLATE_VERSION` defaults to 169. Match installed editor modules to
the enabled targets.

The private `/internal/cloud-builds/claim`, `/:id/heartbeat`, and `/:id/finish`
routes lease jobs to that worker. Only validated UnityFS artifacts for the
allocated asset IDs and requested platforms are accepted. SDK bundle version 5
is retained. Completion links the submitted save; auto-publish does not replace
a newer draft. Failed, cancelled, or expired jobs never become successful builds.
Claims include a signed, short-lived SDK validation token with no account subject
or roles. Deploy the paired API support: only bulk component-text validation
accepts this credential. It cannot authenticate as an account or publish a room.
