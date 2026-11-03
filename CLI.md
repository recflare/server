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
operator's way in. Takes effect on the player's next Studio sign-in or refresh. To open
Studio to a whole Discord role instead, name it in `RECFLARE_STUDIO_ROLLOUT` (`.env`).

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

### `catalog load` — reload the item catalog

```sh
just catalog-load                 # sf3-2025.json → local (merge)
just catalog-load --remote        # production
just catalog-load --replace       # also drop rows the file no longer lists
just catalog-load --dry-run       # build and validate, write nothing
bun runx catalog check            # validate the store file without touching a database
```

Fills econ's `catalog` table from `apps/econ/static/storefronts/sf3-2025.json`, the 2025
store as the game is served it, and nothing else. Re-run it whenever that file changes (after
`runx storefront build`). Each row's `catalog_id` is its listing's `PurchasableItemId` and its
`listing` column the listing verbatim, which is what
`POST /api/storefronts/v1/purchasableitems` serves. Avatar items, consumables, skins and
first-party custom avatar items all load; loot boxes, token bundles and consumable packs do
not. A merge leaves rows the file no longer lists in place with no `catalog_id` or `listing`;
`--replace` deletes them. The inventory does not read this table, so either is safe.

### `cai-load` — load the first-party custom avatar items

```sh
bun runx admin cai-load                      # 2025-1-cai.json + studio87-extras.json → local
bun runx admin cai-load --remote
bun runx admin cai-load --file path/to/export.json --dry-run   # --file takes one or more
just cai-load --remote                       # the same, as a recipe
```

Loads exports of `CustomAvatarItem` records (each a JSON array, a `{ Results }` page, or one
record) into the `custom_avatar_item` table. With no `--file` it reads
`apps/econ/static/db/2025-1-cai.json`, then `studio87-extras.json` — the official-store items
the 2025 export lacks, fetched from another server's `customAvatarItems/v1/bulk` and priced
from the storefront dump (an item it lists with no price is free). A later export only ADDS:
an id an earlier one already holds is skipped, so the extras never overwrite a 2025 item. A
duplicate within one export is refused. Each record is stored as the row's JSON with its
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

**Ticket rewards.** The load also reads every storefront dump in
`apps/econ/static/storefronts/`. An item they sell ONLY for a game's own currency — the Laser
Tag store's tickets (`sf1`, currency 1), Lost Skulls gold (`sf100`, 100), Dracula silver
(`sf101`, 101) — is stored with that listing's `Price` and that currency as a server-side
`PurchaseCurrencyType`; every other item is stored with `PurchaseCurrencyType` 2 (tokens),
and so is an item with a token price on any listing. The token store shows only 2: the
custom-item search and the featured/hot feeds leave a ticket reward out, `econ`'s bag refuses
to sell it as a custom line, and `purchaseInfos` prices it in its own currency. It still
resolves by id (`bulk`, owned), so a player who earns it in its game can wear it. Only the ROW
changes: the export files are never rewritten, and a reload after the storefronts change
re-derives it. (Player-made items are given 2 when they are created; `api` migration 0036
backfilled the rows from before.)

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
ignoring any sale. It warns about every price it changes that wasn't 0 before. It also
replaces each item's `Name` with the storefront's `GiftDrop.FriendlyName`, because the
export often has the asset's machine name (`AnimeFiendHunter_Shirt` instead of
"Fiend Hunter Trench Coat (Gothic)"). The
storefront only prices items already in the export; nothing is added from it. An item the
storefront doesn't list keeps its old price, unless that price is 0, which would make it
free to buy. Those items (the Cryptid Creek event rewards and the Evergrown Hip Pack) get the
catalog's rarity-50 price, `PRICE_BY_RARITY[50]` in `apps/econ/src/catalog-load.ts`. The
script names every item the storefront doesn't list. The
committed `2025-1-cai.json` is already priced. Rarity isn't carried over, since the record
has no field for it.

### `cai-grant-legacy` — grant the custom items that replaced owned legacy items

```sh
bun runx admin cai-grant-legacy              # local
bun runx admin cai-grant-legacy --remote
just cai-grant-legacy --remote --dry-run     # the same, as a recipe
just cai-grant-legacy --remote --dry-run --username alice   # what alice would get
```

The storefront dumps (`apps/econ/static/storefronts/sf*.json`) pair a baked avatar item with
the custom avatar item that replaced it: `GiftDrop.AvatarItemInfo.LegacyAvatarItemDesc` beside
`DownloadableAvatarItemId`. Every player whose `inventory` holds a legacy descriptor (matched
ignoring trailing commas) is granted that custom item in `inventory_custom` — provided
`custom_avatar_item` holds it, so run `cai-load` first. The pairs are read from the dumps on
every run. Re-run it whenever you like: what a player already owns is skipped, nothing is
removed, and no gift box is sent. It prints how many items it granted.

`--dry-run` writes nothing and lists the players who would get items, most first, with the
total, the largest and the median (`--limit <n>`, default 50). With `--account <id>` or
`--username <name>` it lists that player's missing items instead: name, custom avatar item
id, and the inventory row that earns each one.

### `lookup` — print an account

```sh
bun runx admin lookup --account 1
bun runx admin lookup --username alice
```

Prints id, username, platform, platform id, created/last-login times, and whether
the account has a password, the developer role, and the moderator role.

## Options

### Selecting an account

Every command except `reload-plus`, `cai-load` and `cai-grant-legacy` targets exactly one account, by **either**:

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
