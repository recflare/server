# econ

Economy Worker served on the `econ` subdomain (`econ.recflare.net`). Hosts the
avatar/economy endpoints the game client calls on the `econ` service (distinct from the
main `api` worker, which also serves many of them — the client may call either host).

Balances, inventory, consumables, saved outfits, avatars and gift boxes are D1-backed;
storefront catalogs are static assets (`static/storefronts/sf{N}.json`) served via the
ASSETS binding. Several routes are still empty-list stubs.

## Routes

`✓` = auth-gated (validates the Bearer JWT from the `auth` worker; empty-body 401 when
missing/invalid).

| Method   | Path                                                 | Auth | Description                             |
| -------- | ---------------------------------------------------- | ---- | --------------------------------------- |
| GET      | `/api/avatar/v1/defaultunlocked`                     |      | Default-unlocked avatar items (static)  |
| GET      | `/api/avatar/v1/defaultbaseavataritems`              |      | Default base avatar items (stub `[]`)   |
| GET      | `/api/avatar/v4/items`                               | ✓    | Owned items + the default catalog       |
| GET      | `/econ/customAvatarItems/v1/owned`                   | ✓    | Owned custom avatar items (stub)        |
| GET      | `/api/objectives/v1/myprogress`                      |      | Objectives progress (static)            |
| GET/POST | `/api/objectives/v1/cleargroup`                      |      | Clear an objectives group (no-op `[]`)  |
| GET      | `/api/avatar/v2`                                     | ✓    | The player's own avatar                 |
| POST     | `/api/avatar/v2/set`                                 | ✓    | Save the player's avatar                |
| GET      | `/api/checklist/v1/current`                          | ✓    | NUX checklist (stub `[]`)               |
| GET      | `/api/itemWishlists/v1/wishlist/me`                  | ✓    | Item wishlist (stub `[]`)               |
| GET      | `/api/avatar/v3/saved`                               | ✓    | Saved outfits                           |
| POST     | `/api/avatar/v3/saved/set`                           | ✓    | Save an outfit into a slot              |
| GET      | `/api/avatar/v2/gifts`                               | ✓    | Pending (unopened) gift boxes           |
| POST     | `/api/avatar/v2/gifts/consume`                       |      | Open a gift box → success envelope      |
| GET      | `/api/avatar/v2/:id`                                 |      | Another player's avatar (render subset) |
| GET      | `/api/equipment/v2/getUnlocked`                      |      | Unlocked equipment (stub `[]`)          |
| GET      | `/api/roomconsumables/v1/roomConsumable/room/:id`    |      | Room consumables (stub `[]`)            |
| GET      | `/api/roomconsumables/v1/roomConsumable/room/:id/me` |      | Caller's room consumables (stub `[]`)   |
| GET      | `/api/roomcurrencies/v1/currencies`                  |      | Room currencies (stub `[]`)             |
| GET      | `/api/roomcurrencies/v1/getAllBalances`              |      | Room balances (stub `[]`)               |
| POST     | `/api/settings/v2/set`                               | ✓    | Persist settings (accept-and-ack)       |
| GET      | `/api/consumables/v2/getUnlocked`                    | ✓    | Unlocked consumables                    |
| POST     | `/api/consumables/v1/consume`                        | ✓    | Consume an owned consumable             |
| GET      | `/api/storefronts/v4/balance/:currencyType`          | ✓    | Currency balance                        |
| GET      | `/api/storefronts/v3/giftdropstore/:id`              |      | Gift-drop storefront catalog            |
| POST     | `/api/storefronts/v2/buyItem`                        | ✓    | Buy a storefront item                   |
| GET      | `/api/storefronts/v1/adcarouselitems`                |      | Ad-carousel items (static)              |
| GET      | `/api/challenge/v2/getCurrent`                       |      | Current weekly challenge (static)       |
| POST     | `/api/challenge/v2/updateProgress`                   |      | Report challenge progress (stub)        |
| GET      | `/api/gamerewards/v1/pending`                        |      | Pending game rewards (stub `[]`)        |
| POST     | `/api/gamerewards/v1/request`                        |      | Request a game reward (stub `[]`)       |
| GET      | `/api/roomkeys/v1/mine`                              |      | The player's room keys (stub `[]`)      |
| GET      | `/api/roomkeys/v1/room`                              |      | Room keys for a room (stub `[]`)        |
| POST     | `/api/CampusCard/v1/UpdateAndGetSubscription`        |      | Subscription lookup (both null)         |
| GET      | `/openapi.json`                                      |      | Generated OpenAPI 3.1 spec (see below)  |

The app runs with `strict: false`, so trailing-slash variants match (the client posts
`/gifts/consume/` with a trailing slash).

## API documentation

`GET /openapi.json` serves a spec generated from `describeRoute` blocks alongside each
handler, with the schemas in `src/openapi.ts`. **Descriptive, not enforced** — same
rationale as the `auth`/`accounts`/`match` workers. A test asserts every route appears
in the spec, so adding one without documenting it fails.

## Purchases (`buyItem`)

The core flow. The client posts the storefront/item ids, the currency, and the
`RequestedPrice` it rendered; the handler:

1. looks the item up in `static/storefronts/sf{StorefrontType}.json`;
2. rejects a stale price (`409`) — this stops a stale or tampered client buying at a
   price the catalog no longer offers;
3. debits the buyer **atomically** (`400` on insufficient balance);
4. grants the drop — an avatar item into the `inventory` table (own-once), a consumable
   into the `consumable` table (each buy stacks a new instance); currency/xp drops
   aren't granted yet;
5. returns a **gift box** and pushes a `StorefrontBalanceUpdate` over the socket.

Two things are easy to get wrong:

- **`Balance` in the response is the _change_ applied** (the negated price), not the
  resulting total. The client reads its new total from `GET /balance/:type`.
- **Ownership is persisted at purchase**, not when the box is opened. Opening a box
  (`/gifts/consume`) just deletes it — the item was already granted. So the grant never
  waits on the cosmetic "open it" moment.

A `Gift` block routes the item (and box) to another player, but the caller always pays.
A self-buy or anonymous gift is attributed to the "Coach" system account (id 1).

## Consume envelopes

Both consume routes (`/gifts/consume`, `/consumables/consume`) always answer HTTP 200
with `{ error: "", success: true, value: null }` — even for a missing or already-gone
target. A captured real consume returns this envelope, not an empty body: the client
parses it to finish the action, so a bare 200 reads as a failure and the item never
finishes unlocking. Deletes are scoped to the caller, so an unauthenticated or
mismatched call is a harmless no-op (opening _another_ player's box is a 403).

## Weekly challenge (`static/weekly-challenge.json`)

Served verbatim by `GET /api/challenge/v2/getCurrent`. The server never evaluates it: the
client reads the rule tree in each challenge's `Config`, watches its own gameplay, and
posts the tree back to `/api/challenge/v2/updateProgress` with its verdict. So this file
is the entire definition of a week's challenges — ids, display strings, matching rules and
the reward preview.

Everything below was read off reference data (one captured live rotation), not a spec.
Field meanings marked _(inferred)_ are read from how the values line up with the strings
the client renders; the rest are pinned by the data itself.

### Top level

| Field                  | Example                        | Notes                                                                                                                        |
| ---------------------- | ------------------------------ | ---------------------------------------------------------------------------------------------------------------------------- |
| `ChallengeMapId`       | `17`                           | Id of the rotation as a whole ("map" of challenges). Echoed back on `updateProgress`; bump it when you publish a new week.   |
| `CompletedRequired`    | `false`                        | _(inferred)_ Whether every challenge must be finished before the `Gift` is claimable.                                        |
| `StartAt` / `EndAt`    | `2026-03-25T21:00:00`          | The window, 7 days apart, **no timezone suffix** — unlike `ServerTime`. Treat as UTC.                                        |
| `ServerTime`           | `2026-03-31T14:42:54.2754728Z` | .NET round-trip timestamp (7-digit fraction, `Z`). The client dates the countdown off this, so it is **frozen** — see below. |
| `Challenges`           | array                          | The week's challenges, rendered in order.                                                                                    |
| `Gift`                 | object                         | The reward preview for finishing the set.                                                                                    |
| `FallbackGiftName`     | `"4-Star Box"`                 | Shown when the client can't resolve `Gift` into a name.                                                                      |
| `ChallengeThemeString` | a designer quote               | Free text carried through from the captured rotation; a theme note, not a rendered UI string as far as we can tell.          |

**The frozen clock:** `ServerTime` (Mar 31) sits _inside_ `StartAt`…`EndAt` (Mar 25 → Apr 1),
about a day before the end, and the file is static — so the client always sees an active
rotation with a ~1-day countdown rather than an expired one. If you edit the window, move
`ServerTime` inside the new one too, or the challenges may render as already over.

### A challenge entry

| Field         | Notes                                                                                                                                                                           |
| ------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `ChallengeId` | Unique within the rotation, not sequential (`37, 38, 44, 49, 63`). Posted back on `updateProgress`.                                                                             |
| `Name`        | Internal slug, never displayed — and **not authoritative**: `63` is named `Complete3SpillwayGames` but its `Config` and description are Clearcut. Trust `Config`, not the name. |
| `Config`      | The rule tree, as an **escaped JSON string** (not a nested object). See below.                                                                                                  |
| `Description` | The one-line goal, e.g. `"Complete 10 games in ^Paintball"`.                                                                                                                    |
| `Tooltip`     | The longer hint under it.                                                                                                                                                       |
| `Complete`    | Per-player state, so meaningless in a static catalog: always `false` here, and `updateProgress` is stubbed and never flips it.                                                  |

`^Token` in `Description`/`Tooltip` is a client-side room link: the client resolves the
token to a room and renders a tappable name. Subrooms use a dotted path
(`^Paintball.Clearcut`). It is optional decoration, not markup the client requires — the
same rotation writes both `"Complete 10 games in ^Paintball"` and, plainly,
`"Complete 3 games of Paintball: Clear Cut"`.

### The `Config` rule tree

A tree of nodes, each with a numeric type in `ct`. Two node kinds appear:

- **Match** (`ct: 0`) — `wc` is a list of predicates that must _all_ hold for one game
  result (AND).
- **Counter** (`ct: 1`) — `ctc` holds the child node to count and `t` is the target count.

Which slot a node uses (`wc` vs `ctc`) tells you what its children are; a node never has
both. `ipc` is `false` on every composite node in the reference data — purpose unknown, but
the client echoes it back, so keep emitting it.

Predicate leaves carry `vs`, a list of accepted values matched as OR:

| `ct` | Shape                            | Meaning                                                                                                                                                                                     |
| ---- | -------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `6`  | `{"ct":6,"vs":[2]}`              | _(inferred)_ The kind of event being matched — a finished game/session. Present in **every** leaf group and always `[2]`; nothing observed varying it, so treat it as required boilerplate. |
| `7`  | `{"ct":7,"vs":[{"l":"<guid>"}]}` | Scene allow-list: each `l` is a subroom's `UnitySceneId` (see `apps/rooms`). Matches if the game happened in any of them.                                                                   |
| `9`  | `{"ct":9,"vs":[true],"v":"won"}` | A named session variable (`v`) equals one of `vs` — here, the player won.                                                                                                                   |

The two idioms in the file, unescaped:

```jsonc
// "Complete ^TheRiseOfJumbotron quest" — one winning session in one scene
{ "ct": 0, "ipc": false, "wc": [
  { "ct": 6, "vs": [2] },
  { "ct": 9, "vs": [true], "v": "won" },
  { "ct": 7, "vs": [{ "l": "acc06e66-…" }] }   // TheRiseofJumbotron / Home
]}

// "Complete 5 Charades games" — count matching sessions to a target
{ "ct": 1, "ipc": false, "t": 5, "ctc": [
  { "ct": 0, "ipc": false, "wc": [
    { "ct": 6, "vs": [2] },
    { "ct": 7, "vs": [{ "l": "a673712c-…" }, { "l": "4078dfed-…" }] }   // 3DCharades + Legacy3DCharades
  ]}
]}
```

Note the quest challenges have **no `t`** (one qualifying session is the whole goal) and
the counted ones have **no `won` predicate** (finishing counts, winning is irrelevant).

On `updateProgress` the client posts the same tree back with **`cc`** added to the counter
node — its current count (`…,"t":5,"cc":1`). `cc` never appears in this file; it is
progress, not definition. Since the server persists nothing, that count lives only in the
client.

**Scene ids, not room ids.** Because `ct: 7` matches `UnitySceneId`, a screens room and its
VR twin share ids and both count — the six Paintball scenes listed for challenge `44` are
the subrooms of _both_ `Paintball` and `PaintballVR`, and each also exists as a standalone
base room (`River`, `Clearcut`, …). One list covers every way in. How the rotation's five
challenges resolve:

| Challenge | Scenes                                                            |
| --------- | ----------------------------------------------------------------- |
| `37`      | TheRiseofJumbotron / Home                                         |
| `38`      | Crescendo / Home                                                  |
| `44`      | Paintball: River, Homestead, Quarry, Clearcut, Spillway, Drive-in |
| `49`      | 3DCharades / InkSpaceHome + Legacy3DCharades / Home               |
| `63`      | Clearcut only                                                     |

### The `Gift` block

Same item vocabulary as a storefront `GiftDrop` (`AvatarItemDesc` — a comma-separated list
of avatar-item guids, `AvatarItemType`, `ConsumableItemDesc`, `EquipmentPrefabName`,
`EquipmentModificationGuid`) plus `Xp`, `Level` and `StorefrontType`, but two fields are
**renamed**: a storefront's `Context`/`Rarity` are `GiftContext`/`GiftRarity` here. Don't
feed one shape to the other's reader.

`EquipmentModificationGuid` is the Rec Room packed guid — 22-char URL-safe base64 of the 16
guid bytes in .NET little-endian order, padding stripped (`g5u0weNLmkCLeUXFUVn74Q` →
`c1b49b83-4be3-409a-8b79-45c55159fbe1`). The reward is identified by prefab + that guid,
_not_ by `GiftDropId`: this block's `GiftDropId` is `3994`, while the same skin sells in
`sf3.json` as `2121` ("Camera Skin (Comic)"). Nothing grants it — the reward is preview
only (see Known gaps).

## Bindings

| Binding                      | Type           | Notes                                                    |
| ---------------------------- | -------------- | -------------------------------------------------------- |
| `DB`                         | D1             | Shared `recflare` database — balances, inventory, etc.   |
| `JWT_SECRET`                 | Secrets Store  | Shared HS256 signing key (see the `auth` README)         |
| `ASSETS`                     | static assets  | Serves `sf{N}.json` storefront catalogs                  |
| `RECFLARE_NOTIFICATIONS_HUB` | Durable Object | Cross-worker RPC to the `notify` worker's hub            |
| `STARTING_TOKENS`            | var            | Optional; new-player token grant (default in balance-db) |

Add a storefront by dropping a new `sfN.json` in `static/storefronts` — no code change.

## Known gaps

- Gifting to another player grants the item and box but does not notify the recipient.
- `buyItem` grants avatar-item and consumable drops; currency/xp drops aren't granted.
- Consumables are granted and listed but never spent by gameplay, so `Count` only grows.
- Several routes (room keys, wishlist, equipment, room consumables/currencies, game
  rewards) are empty-list stubs pending their own stores.
- Weekly-challenge progress is never persisted and the rotation's `Gift` is never granted:
  `updateProgress` echoes `Complete: false`, so nothing ever completes.
