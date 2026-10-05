# Admin CLI

Operator tools for accounts on the shared `recflare` D1 database, exposed as an
`admin` command group on the repo's `runx` CLI. Each command shells out to
`wrangler d1 execute recflare` — no running worker or auth token needed.

Run from anywhere in the repo:

```sh
bun runx admin <command> [options]
```

## Commands

### `set-password` — set (or replace) an account's login password

```sh
bun runx admin set-password --account 1
bun runx admin set-password --username alice --remote
```

The new password is taken from `--password <pw>`, else from piped stdin, else
prompted interactively.

```sh
# interactive (prompts, hidden)
bun runx admin set-password --account 1

# non-interactive / scripted
echo "s3cret-pw" | bun runx admin set-password --account 1
bun runx admin set-password --account 1 --password "s3cret-pw"
```

### `clear-password` — remove an account's password

Leaves the account with no login credential (only platform login).

```sh
bun runx admin clear-password --username alice
```

### `grant-developer` / `grant-moderator` — grant or revoke a role

Both are off by default; only these commands set them. A granted role backs its
`GET /role/<role>/:id` lookup **and** rides in the login token's `role` claim, so it
takes effect on the account's next login or token refresh.

```sh
bun runx admin grant-developer --account 1
bun runx admin grant-developer --account 1 --revoke
bun runx admin grant-moderator --username alice --remote
```

### `grant-studio` — grant or revoke Rec Room Studio upload access

Sets the account's `hasStudio` flag, which `auth` stamps into the token as the
`betastudio` role — the claim RecFlare Studio reads as permission to upload. Staff
normally manage this from the website (`/settings/recroomstudio`); this is the
operator's way in. Takes effect on the player's next Studio sign-in or refresh.

```sh
bun runx admin grant-studio --username alice
bun runx admin grant-studio --account 42 --revoke
```

### `reload-plus` — credit every Plus subscriber's tokens

Also exposed directly as `just reload-plus`.

```sh
just reload-plus 1000 --dry-run     # list subscribers and their balances, change nothing
just reload-plus 1000 --remote      # +1000 RecCenterTokens to each subscriber, production
```

Adds `<amount>` RecCenterTokens (currency type 2) to the `balance` row of every account
whose `hasPlus` flag is set — the flag `grant-plus` and the website's Discord claim write.
Subscribers are found through the indexed `has_plus` column on `account` (auth migration
0009), so the reload is one statement however many accounts there are. Nothing schedules
it: run it when the subscription's tokens are due, and note that running it twice credits
twice.

A subscriber who has never loaded the game has no balance row yet. They get one holding
their signup grant **plus** the reload, so the grant is not lost — the grant amount is
`RECFLARE_STARTING_TOKENS` from the environment or `.env`, falling back to econ's default
of 10000. Prints every credited account with its resulting balance.

This command targets the `balance` table, so it runs under `apps/econ`'s wrangler config;
with `--local` that is econ's dev D1 state, which needs both `balance` and a migrated
`account` table in it.

### `cai-load` — load the first-party custom avatar items

```sh
bun runx admin cai-load                      # apps/econ/static/db/2025-1-cai.json → local
bun runx admin cai-load --remote
bun runx admin cai-load --file path/to/export.json --dry-run
just cai-load --remote                       # the same, as a recipe
```

Loads an export of `CustomAvatarItem` records (a JSON array, a `{ Results }` page, or one
record) into the `custom_avatar_item` table, each stored as the row's JSON with its
`CreatorAccountId` forced to 1, the Coach account, whatever the export said: that is what
files it as stock content (the storefront tab searches by creator) and what a purchase
pays. Each save's `ThumbnailFileName` is put under `avatar/`, where this server serves
those images from (a name already prefixed is left alone). It MERGES: an id already in the table has its row replaced, and nothing is deleted, so the
players' own shirts, which share the table, are untouched. Re-running is safe. The load is
verified by counting rows and probing ids from across the export; it fails loudly rather
than report a partial load. `--dry-run` reads and validates the export and prints the
statement count without writing.

The saves in an export name their assetbundles by bare filename; the load stores the
names only.

A record's `Price` is what a purchase charges, and the official export mostly says 0. The
prices come from a storefront dump instead, `apps/econ/static/db/Watch_EnumValue_3.json`
(a `{ StoreItems }` page with price and rarity, joined on
`GiftDrop.AvatarItemInfo.DownloadableAvatarItemId` = `CustomAvatarItemId`). Before loading
a fresh export, write those prices into it:

```sh
bun apps/api/scripts/price-custom-avatar-items.ts \
  apps/econ/static/db/2025-1-cai.json apps/econ/static/db/Watch_EnumValue_3.json
just cai-load --remote
```

The script rewrites the export in place with the base token price (`CurrencyType` 2),
ignoring any sale. It warns about every price it changes that wasn't 0 before. The
storefront only prices items already in the export; nothing is added from it. An item the
storefront doesn't list keeps its old price, unless that price is 0, which would make it
free to buy. Those items (the Cryptid Creek event rewards and the Evergrown Hip Pack) get the
catalog's rarity-50 price, `PRICE_BY_RARITY[50]` in `apps/econ/src/catalog-load.ts`. The
script names every item the storefront doesn't list. The
committed `2025-1-cai.json` is already priced. Rarity isn't carried over, since the record
has no field for it.

### `settings-import-kv` — copy the old player-settings KV namespace into D1

```sh
bun runx admin settings-import-kv --dry-run --remote    # count what the namespace holds
bun runx admin settings-import-kv --remote
bun runx admin settings-import-kv --remote --namespace-id <id> --overwrite
just settings-import-kv --remote                        # the same, as a recipe
```

Player settings used to live in a Workers KV namespace (`RECFLARE_PLAYER_SETTINGS`, one
`player:<id>` key per player holding their map as JSON); they now live in the
`player_settings` table on the shared D1, one JSON row per player. This copies the namespace
across for a deployment that predates the move. The namespace id comes from
`RECFLARE_PLAYER_SETTINGS` in `RECFLARE_KV` in `.env` (which the deploys used to read it from)
or from `--namespace-id`.

Upgrade in this order: `just migrate -F playersettings` (creates the table), then this
import, then `just deploy`. The import MERGES: a row that already exists keeps every key it
has and gains the ones only KV knew, so running it after the cut-over — or again — never
undoes something a player has toggled since. `--overwrite` makes the KV value win instead.
Nothing is deleted on either side. Keys that aren't a `player:<id>` holding a JSON object of
strings are reported and skipped. Once it has run, the namespace (and the `RECFLARE_KV` line)
can be deleted.

### `lookup` — print an account

```sh
bun runx admin lookup --account 1
bun runx admin lookup --username alice
```

Prints id, username, platform, platform id, created/last-login times, and whether
the account has a password, the developer role, and the moderator role.

## Options

### Selecting an account

Every command except `reload-plus`, `cai-load` and `settings-import-kv` targets exactly one account, by **either**:

- `--account <id>` — numeric account id
- `--username <name>` — username (case-insensitive)

### Choosing the database

- `--local` — the local dev database (**the default**)
- `--remote` — the deployed (production) database

Passing both is an error. `--remote` requires `RECFLARE_D1` in the gitignored root
`.env` (see `.env.example`) and a wrangler login with access to the account.

## Notes

- Password hashing matches the auth worker exactly (PBKDF2-SHA256), so a password
  set here verifies at login.
- A command that matches no account exits non-zero with `no account found for …`.
- Local writes target `apps/auth`'s dev D1 state; run `bun turbo -F auth migrate -- --local`
  first if the local database hasn't been migrated yet.
