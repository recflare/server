# match

Matchmaking Worker served on the `match` subdomain (`match.recflare.net`) — a Hono app
that handles player presence and places players into room instances. Rooms, room
instances and presence all live in the shared `recflare` D1 database.

## Routes

| Method | Path                                 | Auth | Description                                           |
| ------ | ------------------------------------ | ---- | ----------------------------------------------------- |
| POST   | `/player/login`                      |      | Login ack (no-op; must not touch presence)            |
| POST   | `/player/exclusivelogin`             |      | Exclusive-login ack (no-op) → `{ errorCode: 0 }`      |
| POST   | `/player/logout`                     | ✓\*  | Clear presence (except the Orientation seed)          |
| POST   | `/player/notifydisconnect`           |      | Disconnect notification (no-op ack)                   |
| GET    | `/player?id=1&id=2,3`                |      | Batch player presence lookup                          |
| POST   | `/player/heartbeat`                  | ✓    | Presence heartbeat (JSON body)                        |
| PUT    | `/player/statusvisibility`           | ✓\*  | Set status visibility                                 |
| GET    | `/player/avoidjuniors`               | ✓    | The player's "avoid juniors" setting → `true`/`false` |
| PUT    | `/player/avoidjuniors`               | ✓    | Set it (`avoidJuniors=True`) → the resulting value    |
| POST   | `/goto/room/:room`                   | ✓    | Go to a room (`dormroom` → personal dorm)             |
| POST   | `/matchmake/none`                    |      | Preserve current instance, else dorm                  |
| POST   | `/matchmake/room/:roomId/:subRoomId` | ✓    | Matchmake into a specific subroom                     |
| POST   | `/matchmake/room/:roomId`            | ✓    | Matchmake into a room (default subroom)               |
| POST   | `/matchmake/:room`                   | ✓    | Matchmake by id or name (`dorm` → personal dorm)      |
| POST   | `/goto/none`                         |      | Go to the dorm                                        |
| PUT    | `/player/photonregionpings`          |      | Region ping report (no-op ack)                        |
| PUT    | `/player/gameserverregionpings`      |      | Region ping report (no-op ack)                        |
| POST   | `/roominstance/:id/reportjoinresult` |      | Report join result (no-op ack)                        |
| PUT    | `/roominstance/:id/inprogress`       | ✓    | Set the instance's in-progress flag                   |
| GET    | `/room/:roomId/instances`            | ✓    | A room's live instances (owner/co-owner only)         |
| GET    | `/rooms/requiring/developer`         |      | Rooms requiring a developer → `[]`                    |
| GET    | `/rooms/requiring/rrplus`            |      | Rooms requiring RR+ → `[]`                            |
| GET    | `/openapi.json`                      |      | Generated OpenAPI 3.1 spec (see below)                |

\* `logout` and `statusvisibility` read the token when present but never 401 — an
unauthenticated call is a no-op ack. The other ✓ routes return an empty-body 401 when
the Bearer JWT (issued by the `auth` worker) is missing or invalid.

## API documentation

`GET /openapi.json` serves a spec generated from `describeRoute` blocks that sit
alongside each handler, with the schemas in `src/openapi.ts`.

**The spec is descriptive, not enforced** — same rationale as the `auth`/`accounts`
workers: a reverse-engineered protocol, lenient handlers, no runtime validation. A test
asserts every route appears in the spec, so adding one without documenting it fails.

## Presence

Presence is a per-player row in the shared `presence` table recording the room instance
that player is currently in, plus status fields (visibility, device class, VR movement
mode, platform, app version). It's written by matchmake/goto and refreshed by the
heartbeat, and read by the heartbeat and the batch `GET /player`.

- **`isOnline` means "has a live presence row"**, not "is in a room". Rows expire on a
  TTL, so a player who stops heartbeating drops offline; a player can be online in the
  lobby with `roomInstance` null.
- **The heartbeat is write-thrifty.** An unchanged heartbeat re-writes the row (to
  extend its TTL) only once the TTL is within `PRESENCE_REFRESH_THRESHOLD` seconds of
  lapsing — a still player is refreshed periodically rather than on every beat.
- **A cron sweep** (`scheduled`) clears presence past its TTL and, crucially,
  recomputes the fullness of the instances those rows pointed at. Nothing else notices
  a player who crashed or hard-quit, so without the sweep their instance can stay
  flagged full — and unjoinable — with nobody in it.

The heartbeat also accepts a non-JSON (LoginLock form) body, which it reads and ignores;
only a JSON body carries status fields.

## Matchmaking and room instances

A matchmake resolves the room (by numeric id or name) from D1, then finds a joinable
public instance of the requested subroom or creates a new `room_instance`. The result
is persisted as the player's presence so the heartbeat can replay it — keeping the
client's local presence in sync. `errorCode` 0 with a `roomInstance` is success; an
unknown room returns `errorCode` 20 (NoSuchRoom) with `roomInstance: null`.

Several behaviours are load-bearing and reverse-engineered from the client:

- **Instance names are `^`-prefixed** so the client resolves the new scene; personal
  dorms are the exception (`@owner's Dorm`, no `^`). An empty `location` (the SubRoom's
  Unity scene id) makes the client reject the session.
- **Never re-place a player into their current instance.** The client keys the room
  transition off a _changing_ `roomInstanceId`; returning the same id hangs it mid-join,
  so the join search excludes the caller's current instance.
- **Subrooms are separate places.** Joining one must never land you in an instance of
  another, so instance reuse is scoped to the exact `(roomId, subRoomId)`.
- **The dorm is a single stable instance** with a constant Photon room id, returned
  identically by every dorm entry point and the heartbeat, so the client's whole-instance
  presence check never reads out-of-sync.
- **Two dorm keywords:** `goto/room/dormroom` and `matchmake/dorm` — different spellings
  the 2023 client uses for the same destination.
- **`matchmake/none` preserves existing presence** (it's how the client establishes the
  solo Orientation room) and only falls back to the dorm when the player has none.
  `goto/none` always goes to the dorm.

### Switching a room out (`ROOM_REDIRECTS`)

An operator can substitute one room for another at matchmake time — the way to replace a
stock RRO room, typically the Rec Center (room 2), with a room of their own without
touching the client. The knob is `RECFLARE_ROOM_REDIRECTS` in the root `.env` (see
`.env.example`), comma-separated `<fromRoomId>=<to>` pairs where `<to>` is a room id or
name: `2=MyHub`, or `2=100,3=MyHub`.

Substitution happens where a matchmake resolves a named room, so it covers every route
that names one — the two- and three-segment room matchmakes and a club's clubhouse — and
everything downstream (the ban check, presence, the visit count) sees only the room
actually entered. Matching is on the resolved room id, so asking by name (`RecCenter`)
substitutes the same as asking by id.

- **A requested subroom is dropped** when a substitution fires: the id addresses a subroom
  of the room the client asked for, so entry falls back to the substitute's default one.
- **One hop only** — `2=3,3=2` swaps the two rooms rather than looping.
- **An unresolvable target leaves the original room in place** (logged), so a typo doesn't
  make a room unreachable.
- **Following a friend and joining a specific instance are unaffected** — those enter a
  live instance, which is already in whichever room it was created in.

## Bindings

| Binding                    | Type          | Notes                                                        |
| -------------------------- | ------------- | ------------------------------------------------------------ |
| `DB`                       | D1            | Shared `recflare` database — rooms, room instances, presence |
| `JWT_SECRET`               | Secrets Store | Shared HS256 signing key (see the `auth` README)             |
| `RECFLARE_PLAYER_SETTINGS` | KV            | The `playersettings` map — `/player/avoidjuniors`            |

The `presence` and `room_instance` tables are owned/migrated by the `rooms` worker. This
worker owns one table of its own, `room_invite` (`migrations/0001_room_invite.sql`, applied
under its own `d1_migrations_match` table so it doesn't clash with the other workers
sharing the database): a row per game invite `POST /invite` sends, which is what gives the
invite the `RoomInviteId` the response carries. Its `created_at` is epoch seconds, so old
invites can be swept later.

The settings KV is owned by the `playersettings` worker; this worker touches exactly one
key in it, the "avoid juniors" preference, and its write merges (as that worker's own PUT
does) so the rest of the player's settings survive.

## Known gaps

- `/rooms/requiring/developer` and `/rooms/requiring/rrplus` always return `[]` — no
  such gating queue exists yet.
