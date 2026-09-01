# www

The public web frontend — the repo's first browser-facing worker (every other
app is a backend service). A React SPA (built with Vite) for creating an account
and setting/resetting its email and password, served by a Hono worker.

## Architecture

www is a **backend-for-frontend (BFF)**. The browser only ever talks to www; www
forwards to the `auth` and `accounts` workers server-side. This keeps the account
JWT off other origins and sidesteps CORS (those workers set no CORS headers).

- **React SPA** (`src/client/`, entry `index.html` → `src/client/main.tsx`) is
  built by Vite into `dist/client` and served via the `ASSETS` binding, with
  `not_found_handling: single-page-application` for client-side routes.
- **Worker** (`src/www.app.ts`) exposes the `/api/*` BFF routes and falls back to
  the static assets for everything else.

Upstream hosts are derived from the shared base domain (`auth.<DOMAIN>`,
`accounts.<DOMAIN>`), where `DOMAIN` is injected at deploy time (see
`run-wrangler-deploy`). For local dev/preview, point the `DOMAIN` var in
`wrangler.jsonc` at a deployed domain so the BFF can reach those workers.

### BFF endpoints

| Method | Path            | Upstream                                                 |
| ------ | --------------- | -------------------------------------------------------- |
| GET    | `/api/config`   | none — whether signup is open, plus the Turnstile key    |
| POST   | `/api/signup`   | auth `POST /connect/token` (`grant_type=create_account`) |
| POST   | `/api/login`    | auth `POST /connect/token` (username + password)         |
| POST   | `/api/logout`   | clears the session cookie                                |
| GET    | `/api/me`       | accounts `GET /account/me`                               |
| POST   | `/api/email`    | accounts `POST /account/me/email`                        |
| POST   | `/api/password` | auth `POST /account/me/changepassword`                   |

On signup/login the access token returned by `auth` is stored in an httpOnly
`rf_token` cookie; the other routes read it and forward it as a Bearer token.

`/api/signup` also takes an optional `email`, saved with a second call to accounts
`POST /account/me/email` once the session exists — `create_account` has no email
field, the accounts worker owns it. The address is format-checked before the
account is created, since a rejection afterwards would leave a player with an
account whose email silently didn't save; a failure of the save itself is logged
and does not fail the signup, because by then the account is real and a retry
would spend another slot against auth's per-IP cap.

### Signup and Turnstile

`POST /api/signup` creates an account with no platform identity (a password
account), so it's the one BFF route a bot could farm — `auth` binds no Steam id to
it and only its coarse per-IP cap applies. It therefore runs behind a
[Turnstile](https://developers.cloudflare.com/turnstile/) check: the browser posts
the widget's token, and the worker verifies it against Turnstile's `siteverify`
server-side before calling `auth`. The secret key never leaves the worker, and the
browser never talks to `siteverify` itself.

Two Secrets Store secrets configure it, `TURNSTILE_SITE_KEY` and
`TURNSTILE_SECRET_KEY`, bound from the same account-level store every worker uses
for `JWT_SECRET` (see `wrangler.jsonc` and `src/turnstile.ts`) — the site key is
public, but keeping it with its secret makes the pair the single switch. Creating
both is what opens signup; if either fails to resolve, `/api/config` reports
`signupEnabled: false` (so the SPA shows sign-in only) and `/api/signup` returns
403, so an unconfigured worker serves no signup rather than an unprotected one.
A store read that throws is treated the same as a missing key — `/api/config` is on
the homepage's critical path and must not 500 when signup isn't set up.

Because `.get()` caches per isolate, changing either value in the store needs a
`www` redeploy before a warm worker picks it up.

For local dev, seed the two names into the **local** store (miniflare's, keyed by
the literal `local` store id — it is per-directory, so run these in `apps/www`)
with Turnstile's documented always-passes test keypair, which needs no widget and
no account:

```sh
printf '1x00000000000000000000AA' |
  wrangler secrets-store secret create local --name TURNSTILE_SITE_KEY --scopes workers
printf '1x0000000000000000000000000000000AA' |
  wrangler secrets-store secret create local --name TURNSTILE_SECRET_KEY --scopes workers
```

The tests seed the same pair into their own local store in `beforeAll`.

### Benefits claim and Discord

The **Claim benefits** tab on the account page lets a player prove they hold one of
the qualifying roles in the community Discord and, if they do, gives their account Rec
Room Plus (`account.hasPlus`). The same panel also renders at `/claim`, which is the
app's registered `redirect_uri` — Discord sends the browser back there mid-flow, so
that route has to keep working on a cold load even though nothing links to it. It runs a standard
OAuth2 **authorization code** flow:

1. The tab sends the browser to Discord's consent screen, using the URL `www`
   assembles in `/api/config` plus a `state` nonce the page mints and stashes in
   `sessionStorage`.
2. Discord redirects back to `/claim?code=…&state=…`. The page checks the nonce is
   the one it minted, strips the query, and posts only the `code` to
   `POST /api/benefits/claim` with the player's bearer token.
3. The worker swaps the code for an access token with the client secret, reads
   `GET /users/@me/guilds/{guild}/member` to get the player's roles, revokes the
   token, and — if any one of the configured roles is there — writes `hasPlus` onto
   the account and links the Discord id.

**A claim takes effect on the player's next sign-in, not immediately.** `auth` stamps
`hasPlus` into every token it mints as the `rn.plus` claim, and `econ` decides the
CampusCard and the subscriber discount from that claim alone — no database read on
either path. The token the player's game is holding was minted before they claimed, it
lasts a day, and the client never refreshes it, so they have to restart Rec Room and
sign in again. The claim page says so.

The browser never holds a Discord access token: the client secret can't ship to a
page, which is why this is the second feature (after signup) with a server side.
The scopes are `identify` and `guilds.members.read`, which let the token's owner
read **their own** membership in one guild — so no bot is needed and this worker
holds no credential that could read anyone else's roles.

The verified Discord id is stored as a link in `platform_account` (the `auth`
worker's table of account ↔ external identities, migration 0007) under
`PlatformType.Discord` (101) — the same place a Steam or Meta identity lives,
because that is what it is. Only `hasPlus` goes on the account itself.

Nobody logs in with it. `auth`'s `verifyPlatformProof` can prove exactly two
platforms (Steam and Meta), so a `cached_login` naming 101 is refused outright, and
the login picker filters to those same platforms (`CACHED_LOGIN_PLATFORMS`). That
filter matters for privacy as well as correctness: the picker is public and
unauthenticated, so without it `GET /cachedlogin/forplatformid/101/<snowflake>`
would tell anyone which RecFlare account a given Discord user owns.

Storing the link there is what makes the claim once-only **per Discord user**, not
per account: a second claim from the same Discord member on a different account is
refused (409), answered from the table's index rather than a scan of every account
blob. Re-claiming on the same account is idempotent — the link is `INSERT OR
IGNORE`, so `linkedAt` keeps the first claim's time — so the page is safe to
reload. Nothing revokes Plus: losing the role later leaves the flag set, so it
records "held the role once", not "holds it today".

Four settings configure it, and **all four** are required or the claim stays
closed (`/api/config` reports `benefitsEnabled: false`, so the SPA hides the tab,
and `/api/benefits/claim` returns 403). A half-configured app is
treated as unconfigured on purpose: a client id and secret with no guild/roles
would authenticate a player and have no question left to ask about them.

- `DISCORD_CLIENT_ID` / `DISCORD_CLIENT_SECRET` — Secrets Store, same account-level
  store as `JWT_SECRET` and the Turnstile pair. The id is public (it ships to the
  browser inside the authorize URL) but lives beside its secret so one place
  configures the feature.
- `DISCORD_GUILD_ID` / `DISCORD_BENEFITS_ROLE_IDS` — plain vars in `wrangler.jsonc`,
  not credentials. Both hold Discord **snowflakes: all digits, no letters**. Turn on
  Developer Mode in Discord (Settings → Advanced), then right-click the server or the
  role and Copy ID. These are ids, not names — `Supporter` is what the role is
  _called_, `1077000000000000002` is what goes in the var — and they're quoted as
  strings because a snowflake is too large to survive as a JSON number.

`DISCORD_BENEFITS_ROLE_IDS` is a **list**, separated by commas and/or whitespace, so
several tiers can qualify for the same benefit. **Any one** of them is enough — they
are alternatives, not requirements:

```jsonc
"DISCORD_BENEFITS_ROLE_IDS": "1077000000000000001,1077000000000000002"
```

Blank entries are dropped, so a trailing comma is harmless. A value that parses to no
ids at all counts as unset and closes the claim, rather than opening it with nothing
to check against.

```sh
printf '<client id>' |
  wrangler secrets-store secret create <store-id> --name DISCORD_CLIENT_ID --scopes workers --remote
printf '<client secret>' |
  wrangler secrets-store secret create <store-id> --name DISCORD_CLIENT_SECRET --scopes workers --remote
```

The two ids are **not secrets**, and setting only the secrets is the usual reason the
page never appears. Put them in the root `.env` as operator knobs, where they ride
along as `--var` on deploy (see `recflare_vars`), rather than editing `wrangler.jsonc`
— that keeps your server's ids out of the repo:

```sh
RECFLARE_DISCORD_GUILD_ID=1077000000000000000
RECFLARE_DISCORD_BENEFITS_ROLE_IDS=1077000000000000001,1077000000000000002
```

Use **commas with no spaces** there. Those knobs become `--var` flags that the deploy
script word-splits, so a value containing a space breaks it. (`parseRoleIds` also
accepts whitespace, which is fine in `wrangler.jsonc` but not via `.env`.)

Then redeploy `www` — the Secrets Store `.get()` caches per isolate, so a warm worker
won't pick up newly created secrets until it restarts.

**Diagnosing a claim that won't appear:** fetch `/api/config`. If `benefitsEnabled` is
`false`, the gate is closed and it isn't a UI problem — `www` logs
`discord is half-configured, so benefit claims are closed` with a flag per input
(`hasClientId`, `hasClientSecret`, `hasGuildId`, `roleIdCount`), which names exactly
which one is missing. `wrangler tail www` shows it.

In the [Discord developer portal](https://discord.com/developers/applications),
add `https://<your domain>/claim` to the app's **Redirects**. It has to match byte
for byte: `www` derives the redirect URI from the incoming request's own origin
(never from the request body, which would turn the client secret into a redemption
oracle for someone else's app), so add `http://localhost:5173/claim` too if you
want the flow to work under `pnpm turbo dev`.

## Development

### Run in dev mode

```sh
pnpm turbo dev
```

### Run in preview mode

```sh
pnpm turbo preview
```

### Run tests

```sh
pnpm test
```

### Deploy

```sh
pnpm turbo deploy
```
