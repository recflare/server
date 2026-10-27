# accounts

Accounts Worker served on the `accounts` subdomain (`accounts.recflare.net`) — a Hono
app for account reads, profile mutations and lookups. Accounts live in the shared
`recflare` D1 database, whose `account` schema and migrations are owned by the `auth`
worker; this worker binds it read/write.

## Routes

| Method | Path                           | Auth | Description                                      |
| ------ | ------------------------------ | ---- | ------------------------------------------------ |
| GET    | `/`                            |      | Health check                                     |
| GET    | `/account/me`                  | ✓    | The caller's own account (private self DTO)      |
| GET    | `/account/search?name=`        |      | Prefix-search accounts by username               |
| GET    | `/account/bulk?id=1&id=2,3`    |      | Look up many accounts by id                      |
| GET    | `/account/:id`                 |      | A single public account                          |
| GET    | `/account/:id/bio`             |      | A player's bio                                   |
| POST   | `/account/create`              |      | Create an account → `{ success, value }`         |
| GET    | `/parentalcontrol/me`          | ✓    | The caller's parental-control flags              |
| GET    | `/accountprivacysettings/:id`  |      | An account's privacy settings                    |
| PUT    | `/account/me/displayname`      | ✓    | Set display name                                 |
| PUT    | `/account/me/username`         | ✓    | Change username (unique + change remaining)      |
| POST   | `/account/me/email`            | ✓    | Change email: stages it; codes to old, then new  |
| GET    | `/account/me/email/pending`    | ✓    | The email change awaiting a code, and which      |
| POST   | `/account/me/email/confirm`    | ✓    | Spend a code; the new address's one applies it   |
| POST   | `/account/me/phone`            | ✓    | Set phone number                                 |
| PUT    | `/account/me/identityflags`    | ✓    | Set identity flags bitmask                       |
| PUT    | `/account/me/personalpronouns` | ✓    | Set personal pronouns (posted as `pronounFlags`) |
| PUT    | `/account/me/bio`              | ✓    | Set bio                                          |
| PUT    | `/account/me/profileimage`     | ✓    | Set avatar object key                            |
| GET    | `/openapi.json`                |      | Generated OpenAPI 3.1 spec (see below)           |

Auth-gated routes validate the Bearer JWT issued by the `auth` worker and return an
empty-body 401 when it's missing or invalid.

## API documentation

`GET /openapi.json` serves a spec generated from `describeRoute` blocks that sit
alongside each handler, with the schemas in `src/openapi.ts`.

**The spec is descriptive, not enforced.** Nothing validates requests against it — same
rationale as the `auth` worker: this serves a protocol reverse-engineered from the Rec
Room client, the handlers are lenient (form fields are read as
`typeof value === 'string' ? value : ''`), and reads fall back to a synthesized default
account rather than 404. Read a "required" field as _the client always sends it_, not
_the server rejects it if absent_.

A test asserts that every route the worker serves appears in the spec, so adding a
route without documenting it fails rather than silently shipping an incomplete spec.

## Account shapes

Two DTOs, both camelCase:

- **Public** (`toAccountDto`) — returned for any account. Excludes private fields.
- **Self** (`toSelfAccountDto`, the `/account/me` shape) — the public DTO plus
  owner-only `email`, `birthday` and `availableUsernameChanges`.

Two client-deserializer quirks are load-bearing and deliberate:

- `juniorState` / `parentAccountId` are **omitted entirely** when unset — emitting
  `null` makes the client's enum parser throw. `email` / `birthday` aren't enums, so
  they're kept as `null`.
- `GET /accountprivacysettings/:id` never returns a bare `{}` — that fails the client's
  deserializer ("Deserialization returned null"), so the id is echoed back with recent
  history reported visible. Nothing stores per-player privacy yet.

## Missing rows fall back to defaults

Account reads (`/account/me`, `/account/:id`, `/account/bulk`) never 404 on an unknown
id — they synthesize a default account (`defaultAccount`) so every requested id is
present in the response. `bulk` in particular guarantees one entry per requested id.

## Notifications

Profile mutations persist to the account row and then push through the shared
notifications hub (a single global Durable Object owned by the `notify` worker): the
owner receives `SelfAccountUpdate` + `AccountUpdate`, and every connected client
receives an `AccountUpdate` broadcast. Hub failures are logged and swallowed — the
write has already committed, so a hub hiccup must not fail the request.

This matters most for the mutations whose HTTP response carries no account body
(`personalpronouns`, `identityflags`): the client only learns the new value from the
pushed update, and since those fields are in the _public_ DTO, every other client needs
the broadcast too. `email` and `phone` are private, so they persist without a push.

## Bindings

| Binding                      | Type           | Notes                                                        |
| ---------------------------- | -------------- | ------------------------------------------------------------ |
| `DB`                         | D1             | Shared `recflare` database; `account` schema owned by `auth` |
| `JWT_SECRET`                 | Secrets Store  | Shared HS256 signing key (see the `auth` README)             |
| `RECFLARE_NOTIFICATIONS_HUB` | Durable Object | Cross-worker RPC to the `notify` worker's hub                |

This worker has no migrations of its own — the `account` table is created and migrated
by `auth` (`apps/auth/migrations/`).

## Known gaps

- `POST /account/create` parses `platformId` but doesn't yet persist it, and doesn't
  create the dorm Room/SubRoom a new account should get.
