# rooms

Room Worker served on the `rooms` subdomain (`rooms.recflare.net`) — a Hono app owning
room storage, the browse/search feeds, per-player cheers and favorites, the owner's room
settings, and subrooms.

Rooms live in the shared `recflare` D1 as one JSON blob per room (queryable fields are
SQLite generated columns); reads serve that blob verbatim, which is why every shape is
the client's PascalCase one. Subrooms are their own table — their ids come from a single
global sequence, not per room — and are re-attached to each room on read. The seed rooms,
including the dorm, come from `static/ImportRooms.json`.

## API documentation

`GET /openapi.json` serves a spec generated from `describeRoute` blocks that sit
alongside each handler, with the schemas in `src/openapi.ts`. It's also aggregated into
the docs page www serves at `/docs`.

**The spec is descriptive, not enforced** — same rationale as the `auth`/`match`/`clubs`
workers: a reverse-engineered protocol, lenient handlers, no runtime validation. A test
asserts every route appears in the spec, so adding one without documenting it fails.

## Response envelopes

Two envelopes appear side by side, and which one a route uses is dictated by the client's
deserializer for that call — not a choice, and not something to unify:

- `{ Success, Value, ErrorId, Error }` (PascalCase) — a bare result with a message.
- `{ success, error, value }` (lowercase) — carries the updated room, which the client
  re-renders from.

Both answer HTTP 200 even for a rejection: the client reads the flag, not the status.
Only a missing or invalid token is a real 401, and only the owner/co-owner gate is a 403.

Reads are the exception: they carry no envelope at all. A paged read (the save history at
`…/subrooms/{subRoomId}/saves` and its lighter `…/saves/no_unity_assets` twin) is a bare
`{ Results, TotalResults, TotalCount }` wrapper — `TotalResults` and `TotalCount` are the
same number, because the client's paged DTO and the reference disagree on the name.
`GET /rooms/{roomId}` puts a Studio build's main bundles on `CurrentSave.UnitySubAssets`
(target 0 Windows, 2 Android/Quest). `unityAssetTarget` keeps only that target. Maker-pen
saves keep the arrays empty. `GET …/unityasset?unityAssetId=` is the bare metadata for
those files; the bytes are on the CDN.

## Cron

A `*/5 * * * *` cron (`scheduled`) sweeps two short-lived tables on the shared database,
neither of them this worker's own:

- `room_vote` (the `api` worker's) — vote-to-kick ballots older than 5 minutes. The table
  is append-only; a vote stays open for 60 seconds and the caller cooldown looks back 5
  minutes, so nothing reads an older ballot.
- `room_invite` (the `match` worker's) — game invites older than 5 minutes
  (`ROOM_INVITE_TTL_SECONDS`). Expiry IS the deletion: a redeem that misses the row answers
  `RoomInviteExpired`, so the invite prompt goes stale rather than becoming a permanent
  key into wherever the inviter is later.

The `mono` facade fires this sweep from its own trigger alongside `match`'s presence sweep.

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
