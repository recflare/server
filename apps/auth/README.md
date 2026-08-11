# auth

Auth Worker served on the `auth` subdomain (`auth.recflare.net`) — a Hono app that
authenticates players and issues the JWTs every other worker verifies.

## Routes

| Method | Path                                       | Description                                            |
| ------ | ------------------------------------------ | ------------------------------------------------------ |
| GET    | `/eac/challenge`                           | EAC handshake; a constant, JSON-quoted, as text        |
| GET    | `/cachedlogin/forplatformid/:platform/:id` | Accounts linked to a platform id, for the login screen |
| POST   | `/cachedlogin/forplatformids`              | Bulk cached-login lookup (friends resolution)          |
| POST   | `/connect/token`                           | OAuth token endpoint; issues a JWT + refresh token     |
| POST   | `/account/me/changepassword`               | Change the caller's password (auth-gated)              |
| GET    | `/role/developer/:id`                      | Developer role lookup; a bare JSON boolean             |
| GET    | `/role/moderator/:id`                      | Moderator role lookup; a bare JSON boolean             |
| GET    | `/openapi.json`                            | Generated OpenAPI 3.1 spec (see below)                 |

## API documentation

`GET /openapi.json` serves a spec generated from `describeRoute` blocks that sit
alongside each handler, with the schemas in `src/openapi.ts`.

**The spec is descriptive, not enforced.** Nothing validates requests against it. That
is deliberate: this worker serves a protocol reverse-engineered from the Rec Room
client, and the handlers are intentionally lenient — every field is read as
`typeof body.x === 'string' ? body.x : ''`, and missing or malformed input generally
falls through to a graceful path rather than a 400. Which parts of that tolerance the
client actually depends on isn't fully known, so enforcing a schema would risk
rejecting requests that work today. Read a "required" field as _the client always
sends it_, not _the server rejects it if absent_.

A test asserts that every route the worker serves appears in the spec, so adding a
route without documenting it fails rather than silently shipping an incomplete spec.

## Grants

`POST /connect/token` selects behavior from `grant_type`:

- **`create_account`** — mints an account with an auto-assigned random username and
  places the player in the Orientation room (RoomId 13), which the client enters
  without matchmaking. A posted `password` becomes the login credential.
- **`cached_login`** — logs into an already-linked account using platform ownership as
  the credential; no password. The posted `account_id` must be linked to exactly the
  identity `platform_auth` proves.
- **`refresh_token`** — redeems a stored single-use refresh token, rotating it.
  30-day TTL; platform and platform id come from what was stored at issue time.
- **`password`** — the fallback for any unrecognised or absent `grant_type`. Identifies
  the account by `username` or numeric `account_id` and requires the matching password
  (PBKDF2-SHA256, `salt:hash`). An account with no stored hash cannot be logged into at
  all, which is what closes id/username-only takeover. When it also carries a verifying
  `platform_auth`, that identity is **linked** to the account (see below).

Access tokens live for 1 hour (`TOKEN_TTL_SECONDS` in `@repo/jwt`) and carry a `role`
claim, so developer/moderator powers refresh on every login and every refresh grant.
Grant those flags with `runx admin grant-developer` / `grant-moderator`.

### Verifiable platforms: Steam and Meta

Only an identity we can _prove_ is ever bound to an account, so any grant that
authenticates _by platform identity_ (`cached_login`, and `create_account` when it
asserts a platform) must be a platform we can verify. Two are:

- **Steam (`0`)** — `src/steam-ticket.ts` parses the `platform_auth` ticket and checks
  Steam's signature against Steam's system public key. Verified **offline**: no
  publisher Web API key, no network call. The SteamID64 the ticket carries replaces the
  client-supplied `platform_id`.
- **Meta / Oculus (`1`)** — `src/meta-nonce.ts` posts the nonce in `platform_auth` to
  `graph.oculus.com/user_nonce_validate`, authenticated as the app with
  `META_APP_SECRET`. Meta's nonce proves nothing by itself; validation is what binds it
  to a user id, so here the posted `platform_id` is an _input_ to the check and a
  spoofed one fails. This means an outbound request on every Meta login, and no Meta
  login at all without the app secret — an unset `META_APP_SECRET` answers 500 rather
  than falling back to trusting the client.

Everything else is refused. Whichever platform, the identity that gets bound or linked
is the verified one, never the raw `platform_id` field.

### One account, many platform identities

An account can be reached from several platform identities — a player's PC and their
headset both open the same account, with no password after the first time. The links
live in the `platform_account` table (`src/platform-db.ts`, migration 0007), one row per
(platform, platform id, account).

That table is the **one source of truth** for both halves of a cached login: the picker
(`/cachedlogin/forplatformid`) lists the accounts an identity links to, and the
`cached_login` grant asks it whether the account it was handed is linked to the identity
just proven. They used to be two separate checks over the account blob's single
`platformId`, which could disagree — the client would be offered an account that then
answered "no linked account" forever.

A second device is linked by **logging in with a password there**: the client posts its
`platform_auth` alongside the password, and a proof that verifies becomes a link. Only a
verified identity is ever linked, since a link is a password-free way into the account.
A proof that doesn't verify never fails the login — it just leaves that device without a
cached login.

The account blob keeps `platform`/`platformId` as the account's **primary** identity
(the first one linked). It feeds the account DTO and a refreshed token's claims, and
nothing authorizes off it. It is no longer indexed: migration 0008 drops the
`account.platform_id` generated column that 0004 added, since leaving a queryable copy
of one identity per account invites exactly the picker/grant disagreement above. Look
identities up in `platform_account`.

## Signup caps

`create_account` is capped on two independent arms, per verified platform identity and
per signup IP. The platform arm can't be spoofed or reset by changing networks; the IP
arm is coarse and will produce false positives behind NAT, shared campus and mobile
networks. Both default to 3.

The platform arm also caps **linking**, or it wouldn't be a cap: an identity at the
limit could otherwise have accounts created for it with a password and link its way into
all of them. Hitting it never fails a password login — the account just doesn't get a
cached login on that device.

Override per environment via the root `.env` (`RECFLARE_MAX_ACCOUNTS_PER_PLATFORM_ID`,
`RECFLARE_MAX_ACCOUNTS_PER_IP`), injected at deploy time so tuning them never means
editing a versioned file. Setting an arm to `0` disables it — worth reaching for on a
small private server, or when a shared network is being locked out.

## Bindings

| Binding              | Type          | Notes                                                                                           |
| -------------------- | ------------- | ----------------------------------------------------------------------------------------------- |
| `DB`                 | D1            | Shared `recflare` database; this worker owns `account`, `refresh_tokens` and `platform_account` |
| `JWT_SECRET`         | Secrets Store | Shared HS256 signing key                                                                        |
| `META_APP_SECRET`    | Secrets Store | Meta app secret; only used to validate a login nonce                                            |
| `MAX_ACCOUNTS_PER_*` | vars          | Optional signup caps; read via `intVar`                                                         |

Migrations live in `migrations/` and are tracked in their own `d1_migrations_auth`
table, so they stay independent of the `rooms` worker's migrations on the same
database. Run them with `pnpm -F auth migrate`.

## Signing key

Tokens are signed HS256 with the `JWT_SECRET` binding (see `@repo/jwt`), resolved at
request time via `await c.env.JWT_SECRET.get()`. The key lives in a single shared
**Cloudflare Secrets Store** that every worker binds, so `auth`-signed tokens verify in
`rooms`, `api`, `match`, etc. The store id is kept out of source in the root `.env` as
`RECFLARE_SECRETS_STORE` and spliced into `wrangler.jsonc`'s `"local"` `store_id`
placeholder at deploy time (see `packages/tools/bin/run-wrangler-deploy`).

If the secret resolves empty, the worker refuses to issue a token at all rather than
sign one with an empty key — every worker validates against that same key, so an
empty-key token would be forgeable by anyone.

One-time setup (needs Cloudflare auth):

```sh
# Create the store, then put the returned id in .env as RECFLARE_SECRETS_STORE
wrangler secrets-store store create recflare --scopes workers

# Set the shared signing key (prompted for the value)
wrangler secrets-store secret create <store-id> --name JWT_SECRET --scopes workers --remote

# Set the Meta app secret. Required for the deploy to succeed even with no Meta app —
# a binding to a missing secret is a deploy error. Any placeholder will do; Meta
# sign-ins then answer 500 until it holds the real value.
wrangler secrets-store secret create <store-id> --name META_APP_SECRET --scopes workers --remote
```

For local `wrangler dev`, seed local values (omit `--remote`) so `.get()` resolves:

```sh
wrangler secrets-store secret create local --name JWT_SECRET --value <dev-key> --scopes workers
wrangler secrets-store secret create local --name META_APP_SECRET --value <app-secret> --scopes workers
```

Rotating the signing key invalidates all existing tokens (clients re-authenticate).
The Meta secret is read per request, so updating it takes effect without a redeploy.
