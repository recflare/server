# Deploying

These are the instructions for deploying the RecFlare infrastructure to Cloudflare.

## Why Cloudflare?

- **Makes it easy to mirror RecNet**
  Rec Room's backend is (was) a set of independent microservices, not one big monolith.
  Modeling each service as its own isolated Worker keeps RecFlare's structure close to
  the real thing — services scale,
  fail, and deploy independently — instead of collapsing everything into a single
  giant server.
- **It's free/cheap to run a lot of service.**
  Cloudflare Workers' free tier is keyed
  to usage, not to the number of Workers — so whether you deploy 1 service or all
  36, the baseline cost is the same. You only start paying once usage crosses the
  free-tier limits. Additionally for development or maybe a private instance, the cost
  is near zero when not in use.
- **Bundled Cloud CDN/Storage/SQL**
  Cloudflare offers several cloud services we can rely on so the microservices can remain
  stateless (effectively read-only). They are also scalable by default so we don't need to worry
  about adding more disk space or upgrading services. If we start outgrowing the limits of these,
  well, we'll cross that bridge when we get to it.
  - D1 (a SQLite-compatible distributed database)
  - R2 (service like S3 for mass file hosting)
  - KV (service to distributed offer key/value stores)
  - Durable Objects (for a notifications hub)

## Do I have to use Cloudflare?

Short answer, no. The services are plain [Hono](https://hono.dev) apps, so the request-handling
code isn't tied to Cloudflare and can be deployed to other hosting providers —
AWS, Vercel, Netlify, Fly.io, a plain Node/Bun server, and so on.

Long answer: the catch is everything _around_ the code. RecFlare leans on Cloudflare for the
deployment (Wrangler) and infrastructure layer — custom-domain routing per service, plus the
storage bindings (D1, KV, R2, Durable Objects) the workers use. On another
provider you'll need to provide equivalents (per-service routing, databases,
object storage, a pub/sub or WebSocket layer) and wire up the deployment yourself.

So for example if you wanted to run on Vercel, you'd have to swap out KV for Redis, which are very similar
services but would require small code changes.

## Prerequisites

**You must have all these requirements or RecFlare deployment will fail!**

- node 24 (https://nodejs.org)
- pnpm (install with `npm install -g pnpm`)
- bun (https://bun.sh)
- jq/awk/sed (on Windows try `winget jq` etc.)
- A Cloudflare account with a zone (domain) you control, for deploying.

Cloudflare's free plan is good enough for testing (100k worker requests/day) but the
Rec Room client is very chatty. Frequent testing may exhaust that quota. The $5/month
Worker plan includes 10M requests/month.

See https://developers.cloudflare.com/workers/platform/pricing/#workers

## Getting Started

**Install dependencies:**

We use [Just](https://github.com/casey/just) for convenience. This will install all dependencies across the microservices.

```bash
just install
```

You do not have to use `just` but you will have to run things manually with `pnpm`/`bun`.

**Configure your custom domain:**

Create a new .env file from the template:

```bash
cp .env.example .env
```

Edit `.env` and set `RECFLARE_DOMAIN` to your domain (or declare it with `export RECFLARE_DOMAIN=rec.example.com`)

(Optional) - per-service subdomain overrides come from `RECFLARE_SUBDOMAINS`, a JSON
object keyed by each service's default subdomain (see `SERVICES.md`), e.g.
`'{"playersettings":"settings"}'`. A single entry both decides which host `just deploy`
puts that worker on and which host the `ns` discovery document advertises to the client,
so the two can't drift apart.

This is also how you merge two services together: `'{"moderation":"api"}'` points the
client's Moderation calls at the `api` worker (which is where the `/api/PlayerReporting/…`
routes already live) without deploying anything on `moderation.<domain>`. Redeploy `ns`
after changing it — `just deploy -F ns`.

**Create the storage resources:**

The workers bind Cloudflare storage primitives. Create them once against your
Cloudflare account, then record the IDs in `.env`. The committed `wrangler.jsonc`
files carry `"local"` placeholders; the real IDs are spliced in at deploy time, so
nothing in version control needs editing. Authenticate wrangler first
(`wrangler login`).

```bash
wrangler d1 create recflare
wrangler kv namespace create RECFLARE_MATCH_PRESENCE
wrangler kv namespace create RECFLARE_PLAYER_SETTINGS
wrangler secrets-store store create recflare --scopes workers
```

Take the IDs output from the commands and put them into `.env`. (or with CI: `RECFLARE_KV='{"RECFLARE_MATCH_PRESENCE":"<id>","RECFLARE_PLAYER_SETTINGS":"<id>"}'`)

The secrets store holds the shared `JWT_SECRET` HS256 signing key — every worker
binds it so tokens signed by `auth` verify everywhere. Record its id in `.env` as
`RECFLARE_SECRETS_STORE`, then set the key value once (all workers share it):

```bash
wrangler secrets-store secret create <store-id> --name JWT_SECRET --scopes workers --remote
```

The same store also holds `META_APP_SECRET`, the app secret from your app's page in
the Meta developer dashboard (developers.meta.com). Only the `auth` worker binds it,
and only to authenticate itself to Meta when validating a headset login's nonce —
unlike Steam's ticket, which verifies offline, a Meta login cannot be checked without
it. Create it too:

```bash
wrangler secrets-store secret create <store-id> --name META_APP_SECRET --scopes workers --remote
```

> ⚠️ Both secrets must **exist** in the store or `just deploy` fails on the `auth`
> worker — a binding to a missing secret is a deploy error. If you have no Meta app,
> create `META_APP_SECRET` with any placeholder value: Meta sign-ins then fail with a
> 500 ("Meta platform verification is not configured") and nothing else is affected.
> Steam and password sign-ins are unaffected either way. Put the real value in later
> with `wrangler secrets-store secret update` — no redeploy needed, the worker reads
> the secret per request.

Then apply the schema. `just migrate` will set up the database and populate it with data. This runs non-interactively, so be careful!

```bash
just migrate                 # migrate every worker that owns migrations
just migrate -F rooms        # or scope to one worker
```

### R2 and Durable Objects

You only have to create the buckets:

```bash
wrangler r2 bucket create recflare-cdn
wrangler r2 bucket create recflare-img
```

### Durable Objects

Nothing manual to do here. The object is created manually.

**Run the development microservices:**

> ⚠️ **Note:** This runs, but the name-server document still advertises the deployed
> hosts, not your local instances — so service discovery won't resolve locally.
> You can still call each service directly; each Wrangler instance runs on its own
> port. Maybe we can get this working somehow. @todo

```bash
just dev
```

## Deploy or upgrade all workers

This will deploy or upgrade all workers to respective endpoints (*.example.com)

It will additionally run any necessary DB migrations.

Deploying requires `wrangler` to be authenticated against your Cloudflare
account (`wrangler login`, or `CLOUDFLARE_API_TOKEN` / `CLOUDFLARE_ACCOUNT_ID`
in the environment).

It requires the storage to be set up above, otherwise, deployments may fail.

You can always re-run it as often as you wish. DB migrations will only run once.

```bash
just install # Makes sure dependencies are up to date
just migrate # Runs DB migrations
just deploy # Deploy code
```

Optionally if you know there was only a change to a single service, you can use `just [migrate|deploy] -F econ` for example to only deploy the `econ` microservice.

## Tuning your server

A few gameplay/policy values are knobs rather than hardcoded constants, and they live in
the same `.env` you already created. `.env.example` carries each one commented out, set to
its built-in default: copy the lines you want to change into your `.env`, uncomment them,
edit the value, then re-deploy the worker that reads them.

| `.env` variable                         | Read by | Default | What it does                                                   |
| --------------------------------------- | ------- | ------- | -------------------------------------------------------------- |
| `RECFLARE_MAX_ACCOUNTS_PER_PLATFORM_ID` | `auth`  | `3`     | Accounts one Steam-verified identity may create. `0` disables. |
| `RECFLARE_MAX_ACCOUNTS_PER_IP`          | `auth`  | `3`     | Accounts one signup IP may create. `0` disables.               |
| `RECFLARE_STARTING_TOKENS`              | `econ`  | `10000` | RecCenterTokens a new player is granted.                       |
| `RECFLARE_ROOM_REDIRECTS`               | `match` | unset   | Rooms to switch out on matchmake, e.g. `2=MyHub`.              |

Then deploy just the worker that reads it:

```bash
just deploy -F auth
```

A line you leave out of `.env` keeps its default, so only copy over what you actually want
to change — and deleting a line you'd set restores the default on the next deploy. The same
`.env` feeds `just dev`, so a knob is configured once and behaves the same locally as it
does deployed.

Adding a knob of your own takes no changes to the deploy tooling. Every `RECFLARE_*` in
`.env` is handed to the workers as a variable under its unprefixed name — `RECFLARE_STARTING_TOKENS`
arrives as `STARTING_TOKENS` — so a new one only needs declaring in that worker's
`src/context.ts` and reading in its code. Every worker receives every knob and ignores the
ones it doesn't read, which is also how two services can share a value. (The domain and the
resource ids above are the exception: those configure the deploy itself and are never
passed to a worker.)

Both account caps are enforced on signup only, never on login — an existing account always
stays reachable no matter how many its owner has accumulated. The per-IP cap is the coarse
one: households, NAT and shared campus/mobile networks put many legitimate players behind a
single address, so raise it (or set it to `0`) if real players report being locked out.

> **Don't set these as Worker variables in the Cloudflare dashboard.** A deploy replaces a
> worker's variables wholesale, so a dashboard-set value is wiped by your next
> `just deploy`. `.env` is the durable place. Real secrets don't belong there either — they
> go in the Cloudflare Secrets Store, like the shared `JWT_SECRET` above.

### Signing up on the website (Turnstile)

Players get an account by launching the game, which needs no setup. The website can create
one too — that path has no platform identity behind it, so it runs behind a
[Turnstile](https://developers.cloudflare.com/turnstile/) bot check and is **closed until
you configure one**. Two steps, both one-time:

1. Create the widget: Cloudflare dashboard → **Turnstile** → **Add widget**, mode
   **Managed**, hostnames your domain (add `localhost` if you want it in `just dev` against
   real keys). It gives you a **site key** and a **secret key**.
2. Put both in the same Secrets Store the shared `JWT_SECRET` lives in — they're the switch
   that opens signup, and store values survive deploys:

   ```bash
   wrangler secrets-store secret create <store-id> --name TURNSTILE_SITE_KEY \
     --scopes workers --remote
   wrangler secrets-store secret create <store-id> --name TURNSTILE_SECRET_KEY \
     --scopes workers --remote
   ```

Then `just deploy -F www`. The site key is public — the browser needs it to render the
widget, and gets it from `GET /api/config` — but it lives next to its secret so signup is
configured in one place. The secret key never leaves the worker: `/api/signup` verifies the
token against Turnstile server-side before it calls `auth`.

Signup opens only when **both** resolve. With either missing, `/api/config` reports signup
closed (the site shows sign-in only) and `POST /api/signup` refuses — a missed step costs
you the signup form, never an unprotected one. That is also how you turn signup back off:
`wrangler secrets-store secret delete <store-id> --name TURNSTILE_SECRET_KEY --remote`,
then redeploy `www` (values are cached per isolate, so a warm worker keeps the old one
until fresh isolates start). For local dev, seed the same two names into the local store
from `apps/www` — Turnstile's documented always-passes test keypair
(`1x00000000000000000000AA` / `1x0000000000000000000000000000000AA`) works there without a
widget:

```bash
cd apps/www
printf '1x00000000000000000000AA' |
  wrangler secrets-store secret create local --name TURNSTILE_SITE_KEY --scopes workers
printf '1x0000000000000000000000000000000AA' |
  wrangler secrets-store secret create local --name TURNSTILE_SECRET_KEY --scopes workers
```

Both `auth` account caps above still apply on top of the bot check, and the per-IP one is
the only cap that can see a web signup.

`www` reaches `auth` through a **service binding**, not over `auth.<DOMAIN>`, so that the
player's real IP survives the hop: a Worker subrequest to the public hostname re-enters
the Cloudflare edge, which rewrites `CF-Connecting-IP` to Cloudflare's own address, and
`auth` would then record one shared `signupIp` for every web account and cap the whole
internet at three. Two consequences: **deploy `auth` before `www`** on a fresh account
(the binding refuses to resolve otherwise), and web accounts created before this change
carry that shared address as their permanent `signupIp` — harmless, but they are not
counted against any real network.

## Repository Structure

- `apps/` - The service workers, one deployable Worker per subdirectory. Each has
  its own `README.md`, `wrangler.jsonc`, `src/`, and tests.
- `packages/` - Shared libraries and configuration used across the workers.
  - `@repo/hono-helpers` - Hono framework utilities (logging, error handling).
  - `@repo/tools` - The `runx` CLI and the `bin/` scripts each worker's
    package.json delegates to, so build/test/deploy stays consistent.
  - `@repo/typescript-config`, `@repo/oxlint-config` - Shared TS and lint config.
- `turbo/generators/` - `turbo gen` templates for scaffolding new workers/packages.
- `Justfile` - Convenient aliases for common development tasks.

## Available Commands

This repository uses a `Justfile`. Run `just` (or `just --list`) to see every
command. Some key ones:

- `just install` - Install all dependencies.
- `just dev` - Start the dev server (context-aware: runs `bun runx dev`).
- `just build` - Build all workers.
- `just test` - Run tests (vitest).
- `just check` - Check code quality: deps, lint, types, format.
- `just fix` - Fix code issues: deps, lint, format, workers-types.
- `just deploy` - Deploy all workers to your domain.
- `just new-worker` (alias: `just gen`) - Scaffold a new service worker.
- `just new-package` - Scaffold a new shared package.
- `just update deps` - Update dependencies across the monorepo with syncpack.

For a single worker, scope with -F, e.g. `just deploy -F playersettings`.
