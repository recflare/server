# econ

Economy Worker served on the `econ` subdomain (`econ.recflare.net`). Hosts the
avatar/economy endpoints the game client calls on the `econ` service (distinct from the
main `api` worker, which also serves many of them — the client may call either host).

Balances, inventory, consumables, saved outfits, avatars, gift boxes, weekly-challenge
progress and game-reward eligibility are D1-backed; storefront catalogs and the weekly-challenge rotation are static
assets (`static/`), the storefronts served via the ASSETS binding. Several routes are still
empty-list stubs.

## Routes

`✓` = auth-gated (validates the Bearer JWT from the `auth` worker; empty-body 401 when
missing/invalid). `~` = optional auth: served to anyone, personalised for a valid bearer.

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
| POST     | `/api/items/bulkpurchase`                            | ✓    | Buy a bag of storefront items           |
| GET      | `/api/storefronts/v1/adcarouselitems`                |      | Ad-carousel items (static)              |
| GET      | `/api/challenge/v2/getCurrent`                       | ~    | Weekly rotation + the caller's progress |
| POST     | `/api/challenge/v2/updateProgress`                   | ✓    | Report challenge progress               |
| GET      | `/api/gamerewards/v1/pending`                        |      | Pending game rewards (stub `[]`)        |
| POST     | `/api/gamerewards/v1/request`                        | ✓    | Claim a game reward → 5 XP + gift box   |
| GET      | `/api/roomkeys/v1/mine`                              |      | The player's room keys (stub `[]`)      |
| GET      | `/api/roomkeys/v1/room`                              |      | Room keys for a room (stub `[]`)        |
| POST     | `/api/CampusCard/v1/UpdateAndGetSubscription`        | ~    | Gold year for `developer`s, else `{}`   |
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
4. grants the drop — an avatar item into the `inventory` table (own-once), equipment into
   `equipment`, a consumable into `consumable` (each buy stacks a new instance), or, for a
   query drop, whatever the roll lands on (below); currency/xp drops aren't granted yet;
5. returns a **gift box** and pushes a `StorefrontBalanceUpdate` over the socket.

Two things are easy to get wrong:

- **`Balance` in the response is the _change_ applied** (the negated price), not the
  resulting total. The client reads its new total from `GET /balance/:type`.
- **Ownership is persisted at purchase**, not when the box is opened. Opening a box
  (`/gifts/consume`) just deletes it — the item was already granted. So the grant never
  waits on the cosmetic "open it" moment.

A `Gift` block routes the item (and box) to another player, but the caller always pays.
A self-buy or anonymous gift is attributed to the "Coach" system account (id 1).

### The shopping bag (`POST /api/items/bulkpurchase`)

The same purchase, many items at once. The client posts every line in the bag — an item id,
`DuplicateItemCount` copies, the unit `RequestedPrice` it rendered, an optional `Gift` — plus
the one `StorefrontType` and one `CurrencyType` they all share.

**The response is not buyItem's.** It is `{ Success, Error, error_id, Value }` — `error_id`
lowercase because the client renames that one member, the other three PascalCase — wrapping a
BalanceUpdateResponse:

```jsonc
{
  "Success": true,
  "Error": null,
  "error_id": null,
  "Value": {
    "Balance": 9500, // the RESULTING total, not buyItem's change
    "CurrencyType": 2,
    "Platform": -2, // the bucket that total belongs to — a renamed BalanceType
    "BalanceUpdates": [
      // one entry per REQUESTED item, in request order
      {
        "UpdateResponse": 0,
        "Data": { "GiftPackage": { … }, "PurchasableItemId": 2182, "CustomAvatarItem": null },
      },
    ],
  },
}
```

What is deliberate here:

- **`Value.Balance` is the resulting total**, unlike buyItem's change — `{ Balance,
CurrencyType, Platform }` is the BalanceResponse triple a `StorefrontBalance*` frame also
  carries, and the one frame this pushes reports the identical number, so body and frame
  agree instead of compounding.
- **`Platform` is `-2`, not the capture's `4`.** It is the client's `BalanceType` under a
  `[DataMember]` rename — the bucket, not a store. The reference server said `RecNetPurchased`
  because it kept a wallet per store; this server keeps ONE account-wide bucket and the client
  SUMS its buckets, so naming any other platform invents a second balance beside the real one
  — the bug that showed a player 34,100 tokens.
- **One entry per REQUESTED item, and `UpdateResponse` is where it reports.** A line that
  didn't sell comes back non-OK with a null `GiftPackage`, and `AllowPartialSuccess` is what
  lets those sit beside successful ones while `Success` stays true. Codes: 0 OK,
  1 TooManyRequests, 2 NotEnoughCredit, 3 AlreadyOwned, 4 NoItemAvailable,
  5 CouponNotApplicable, 6 RequestedPriceDoesNotMatch, 7 RequestedAmountNotAllowed,
  8 PlayerNotEligible, 9 RequestCannotBeRefunded, 10 PlayerNotApproved. This server can
  produce 0/2/4/5/6/7; the rest are rate limiting, entitlements and refunds, none of which
  exist here. `AlreadyOwned` is left unused on purpose — buyItem lets a player re-buy what
  they own, and one purchase path refusing what the other allows would be worse than either.
- **One entry per item means one box per item.** So `DuplicateItemCount` above 1 is only
  allowed for a consumable (they stack, and the count rides on the one box);
  anything owned once is refused with `RequestedAmountNotAllowed` rather than charged twice
  for a grant that would collapse into itself.
- **One catalog read and one debit for the whole bag.** Lines resolve in memory against a
  single `sf{N}.json` read (sf3 is 1161 items; the cap is 200 copies), and the total is spent
  in ONE atomic `spendCurrency`. Charging line by line would let a bag half-succeed against a
  concurrent spend and would push a balance frame per line.
- **Nothing sold ⇒ a refusal, not an empty success.** `Success: false`, the first failure's
  reason in `Error`, and a null `Value` — legal here, since the client's validator only
  cascades into a non-null one (unlike the matchmaking DTO, which throws on a null payload).
  Without `AllowPartialSuccess`, one bad line refuses the bag the same way and nothing is
  charged. `400` is reserved for a request that can't be evaluated at all (no lines, a
  non-spendable currency, more than `Econ.BulkPurchaseCap` — the same 200 the client reads
  from its game config), and even those answer the envelope.
- **`GiftPackage` is its own 20-key DTO**, not the stored box: buyItem's `Data` entry plus
  `PlayerId` / `CustomAvatarItemId` / `Signature` / `IsSignatureValid`, minus its `Level`.
  Its `Platform`/`PlatformsToSpawnOn` are the platform MASK (-1) — the balance bucket is the
  `BalanceType` beside them, which is the opposite arrangement from `Value.Platform` above.
  `Signature` is null and `IsSignatureValid` false: a box the server minted was never signed
  for peer-to-peer transfer.
- **`BypassGiftPackages` skips the boxes, not the grant.** Ownership never depended on the
  box, so the items are granted either way; `GiftPackage` is then null — exactly what the
  captured response shows.
- **Guid-keyed ids and coupons are refused.** `ItemPurchaseMethodId` is a discriminated id
  (`Type` 0 = a storefront `PurchasableItemId` in `NumberId`; a `Guid` names a UGC item no
  catalog here sells, and `Data.PurchasableItemId` is null for it), and nothing issues the
  coupon a `CouponConsumablePlayerMappingId` would spend.

## Query drops — the loot boxes (`IsQuery`)

A gift-drop with `IsQuery: true` is not an item, it is a **roll**: all of its item fields
(`AvatarItemDesc`, `EquipmentModificationGuid`, `ConsumableItemDesc`) are empty on purpose,
and what the player gets is picked at grant time. sf2's tooltip states the rule outright —
_"A random 4-star item that you don't have."_ Eight ship in the catalogs, two families of
the same ladder:

| sf2 "Star Boxes" (`ItemSetId` 44, `Unique`) | Rarity | sf3 "Random box" family |
| ------------------------------------------- | ------ | ----------------------- |
| —                                           | 0      | Common Random box       |
| 2-Star Unique Box                           | 10     | Uncommon Random box     |
| 3-Star Unique Box                           | 20     | Rare Random box         |
| 4-Star Unique Box                           | 30     | Epic Random box         |
| —                                           | 50     | Legendary Random box    |

That table is the **star ↔ rarity ladder** (`STAR_RARITY` in `econ.app.ts`): sf2's three
boxes pin 2/3/4 → 10/20/30 by carrying both their name and their `QueryRedirectRarity`, and
sf3's five-name ladder fills in the ends. It's the same tier list twice, so read a rarity
number in either dialect.

`rollQueryDrop` resolves one inside `grantGiftDrop`, so both faucets — a purchase and the
weekly gift — hand over a real item rather than an unopenable box:

- **The pool is sf3**, the general store (`ROLL_STOREFRONT_TYPE`). It's the only catalog
  with a real pool at every tier (1161 items against 8–40 in the themed ones), it's where
  the Random box family itself sells, and "a random 4-star item" means the item universe,
  not whichever seasonal shelf the box came off.
- **Filtered to what the player doesn't own**, which is the `Unique` promise and the only
  reading of "an item you don't have" that means anything.
- **Avatar items and equipment only.** Other query drops are excluded (a box that rolls a
  box), and so are consumables: they stack, so "don't have" never becomes false and they'd
  crowd out the real prizes.
- **`avatarItemsOnly` narrows it to worn items**, dropping equipment skins from the pool.
  Level-up boxes use it; storefront boxes don't, since "a random 4-star item" means both.
- **`QueryRedirectRarity` wins over `Rarity`** when present — sf2 carries both and they
  agree; sf3's boxes carry only `Rarity`.
- **An empty pool grants nothing** (logged `query gift-drop rolled nothing`) — an owner of
  every 4-star item still gets the box, just nothing in it.
- **`buyItem` answers with the ROLLED item, not the box.** The client draws the purchase
  from `BalanceUpdates[0].Data[0]`, and a query drop's own item fields are all empty — echo
  those and the player sees an empty box for a purchase that actually granted something. The
  stored box was always correct; only the response was wrong.

## Consume envelopes

Both consume routes (`/gifts/consume`, `/consumables/consume`) always answer HTTP 200
with `{ error: "", success: true, value: null }` — even for a missing or already-gone
target. A captured real consume returns this envelope, not an empty body: the client
parses it to finish the action, so a bare 200 reads as a failure and the item never
finishes unlocking. Deletes are scoped to the caller, so an unauthenticated or
mismatched call is a harmless no-op (opening _another_ player's box is a 403).

## Weekly challenge (`static/weekly-challenge.json`)

Served by `GET /api/challenge/v2/getCurrent` (with each challenge's per-player `Complete`
stamped in — see Progress below). The server never evaluates the rules: the client reads
the rule tree in each challenge's `Config`, watches its own gameplay, and posts the tree
back to `/api/challenge/v2/updateProgress` with its verdict. So this file is the entire
definition of a week's challenges — ids, display strings, matching rules and the reward
preview.

Everything below was read off reference data (one captured live rotation), not a spec.
Field meanings marked _(inferred)_ are read from how the values line up with the strings
the client renders; the rest are pinned by the data itself. The file itself is edited
freely as rotations change — the examples here are the captured week, so expect the shipped
rotation to differ.

### Top level

| Field                  | Example                        | Notes                                                                                                                        |
| ---------------------- | ------------------------------ | ---------------------------------------------------------------------------------------------------------------------------- |
| `ChallengeMapId`       | `17`                           | Id of the rotation as a whole ("map" of challenges). Echoed back on `updateProgress`; bump it when you publish a new week.   |
| `CompletedRequired`    | `false`                        | _(inferred)_ All-or-nothing: `true` makes the `Gift` need every challenge, `false` the three-of-five threshold below.        |
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
| `Complete`    | Per-player state, so always `false` in the file — `getCurrent` overwrites it per caller from `challenge_status`.                                                                |

`^Token` in `Description`/`Tooltip` is a client-side room link: the client resolves the
token to a room and renders a tappable name. Subrooms use a dotted path
(`^Paintball.Clearcut`). It is optional decoration, not markup the client requires — the
same rotation writes both `"Complete 10 games in ^Paintball"` and, plainly,
`"Complete 3 games of Paintball: Clear Cut"`.

### The `Config` rule tree

An escaped JSON string holding a tree of nodes, each with a numeric type in `ct`: a
**Match** (`ct: 0`, `wc` is a list of predicates that must all hold for one game result) or
a **Counter** (`ct: 1`, `ctc` is the child node to count and `t` the target). Leaves match a
scene allow-list (`ct: 7`, subroom `UnitySceneId`s) or a session variable (`ct: 9`, e.g.
`won`). The server never evaluates any of it — the client does, and posts the tree back with
its own count written in.

**Reading or writing one? See `.agents/weekly-challenge-config/SKILL.md`** — the full
grammar, the two idioms the file uses, how to resolve a scene guid to a room, the shared
scenes that make a challenge complete in more rooms than you meant (`Soccer` and `Stadium`
are one scene), and an authoring checklist.

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
`sf3.json` as `2121` ("Camera Skin (Comic)").

**Granted when the set is finished** — see below. The grant path is `buyItem`'s, so the
block is translated into a storefront gift-drop first (`toChallengeGiftDrop`); the renamed
`GiftContext`/`GiftRarity` are exactly what that translation is for.

The block carries no display strings and a `GiftRarity` of `0` for an item that sells at
rarity `5`, so both are taken from the catalog entry selling the same item (matched on
equipment guid / avatar desc) — the reward reads as "Camera Skin (Comic)", not as the box it
might have arrived in. An explicit `FriendlyName`/`Tooltip` on the block wins over the
catalog if a rotation we publish sets them; neither is present in the captured one.

**`FallbackGiftName` is the other half of the reward, not just a label.** "4-Star Box" is
what the player gets _instead_ when they already own the item — the real game phrased it
"…or a 4-Star Box!" — so it is granted as a query drop (a roll) at the tier its star count
names, via the ladder in the query-drop section. Renaming it to `3-Star Box` retunes the
consolation tier with no code change; a name that doesn't parse falls back to 4 stars.

### Winning the gift (`challenge_gift`)

There is no claim endpoint and the client never asks: the reward is handed out from the
`updateProgress` call that reaches the threshold. Every completing report on the **live**
rotation re-reads the caller's completions and, once enough of `weekly-challenge.json`'s
challenges are there, grants the `Gift` the way a purchase grants a drop — the item into
`inventory`/`equipment`/`consumable`, plus a gift box (message
`Weekly challenge complete!`) the player finds in `GET /api/avatar/v2/gifts`.

**Three of five, not five of five** (`CHALLENGES_REQUIRED_FOR_GIFT`). A week publishes five
challenges and the gift is for playing most of them, so the two a player can't reach — a
quest they don't own, a mode they don't like — don't sink the whole week. The count is of
challenges the rotation still **publishes**: a live client can report an id an edited
rotation no longer lists, and three of those shouldn't buy a gift nobody worked for. A
rotation publishing fewer than three can only ask for what it has.

**The item, or a roll.** If the player already owns the `Gift`'s item — likely, since the
rotation's reward is one fixed item that sells in the store — they get the
`FallbackGiftName` box instead, rolled at its star tier. Finishing the week can't be worth
nothing. A `Gift` block carrying no ownable item at all (no avatar desc, no equipment guid)
counts as "already owned", so a rotation whose reward is _only_ a box is written by leaving
the block empty and naming the tier.

- **`challenge_gift` makes it happen once.** One row per (account, rotation); the row's
  existence _is_ the grant. The client keeps reporting after the set is finished, so the
  insert is the gate: `ON CONFLICT … DO NOTHING … RETURNING` claims it in one statement, and
  a second report returns no row and grants nothing.
- **Claim first, grant second** — at-most-once. If the grant then fails the reward is lost
  rather than doubled; it's logged (`failed to grant weekly challenge gift`) and re-granted
  by hand if it ever happens. A faucet that sticks is easier to spot than one that leaks.
- **The response is unchanged; the socket carries the news.** `updateProgress` answers the
  same four fields whether or not a gift was won, and a `GiftPackageReceivedImmediate` (31)
  frame goes out over the hub with the box — that's what pops the reward panel the moment
  the set is finished, instead of the player finding it on the next read of the gifts list.
  The payload is the reference server's field-for-field (`Id`, `FromGiftDropId: 0`,
  `FromPlayerId`, the item fields, `Platform`/`PlatformsToSpawnOn: -1`, `BalanceType: -2`,
  `Message`), and it names the **rolled** item when the fallback box is what was granted.
  `Immediate` (31) rather than `GiftPackageReceived` (30) is what the reference sends for a
  box the server hands over unasked; the sender is Coach (1). Best-effort — a hub failure is
  logged and swallowed, since the gift is already granted and stored.
- **`CompletedRequired: true` makes the rotation all-or-nothing** — the threshold becomes
  every published challenge. That reading of the flag is still _inferred_ (it is `false` in
  the captured rotation, which is the partial default), but it's the one its name and the
  three-of-five rule agree on.
- **`Xp`/`Level` on the block are ignored**, as on a purchase — same gap, and both are `0`
  in the captured rotation.
- **A report against an old rotation never wins anything**, and an empty `Challenges` array
  earns nothing (its threshold clamps to zero, which every player would otherwise meet
  without playing).
- **Players already past the threshold when this shipped still get it**: the client
  re-reports completed challenges, and the first such report is a completing report.

### Progress (`challenge_status`)

`POST /api/challenge/v2/updateProgress` (auth-gated) upserts one row per (account,
challenge) into `challenge_status`, and `getCurrent` reads them back to stamp `Complete`.
The body is `{ ChallengeMapId, ChallengeId, Config, Complete }` with the ids as **strings**
and `Complete` as .NET's `"True"`/`"False"` — capitalized, so `Boolean(body.Complete)` reads
"not complete" as complete (`parseBool` handles both spellings and a real JSON `true`).

Only the completion is stored. `Config` is the catalog's own rule tree plus the client's
running count, so a per-player copy would just be a staler duplicate of static data — it is
echoed back untouched but never persisted. The response is the four posted fields, except
`Complete` is the **stored** value rather than the posted one, because:

- **Completion latches within a rotation.** The client reports repeatedly, and a later
  report saying "not complete" (a fresh session, a retry arriving out of order) must not
  un-finish something already finished.
- **A new rotation resets the row.** Challenge ids are only unique within a rotation, so
  the same id in a later week would otherwise start out already complete. A report whose
  `ChallengeMapId` differs from the stored one replaces the row instead of latching; reads
  are scoped to the rotation for the same reason.

`getCurrent`'s auth is **optional** — an unauthenticated caller gets the static rotation
with every `Complete` false rather than a 401, since the rotation is public and a failure
on this route can stall the client's load. The overlay rebuilds the response object rather
than stamping the imported JSON in place: that import is module state shared across every
request an isolate serves, so mutating it would leak one player's completions to the next
caller.

## Game rewards (`reward_status`)

The client asks for a reward whenever it thinks one is due, posting a form body of the type
and the message to show for it:

```
rewardType=FirstActivityOfDay&Message=First%20Game%20of%20the%20Day
rewardType=PostGameActivity&Message=Activity%20completed%21&giftContext=Soccer
```

Since the client asks rather than the server offering, whether a reward is actually **owed**
is decided here, from `reward_status` — one row per (account, reward type, gift context)
holding the last claim and a count. One claim per type per activity per hour
(`REWARD_COOLDOWN_MS`), flat for every type despite what a name like `FirstActivityOfDay`
suggests; per-type windows would be a map keyed by type.

- **The claim is one SQL statement** (`ON CONFLICT … DO UPDATE … WHERE`). The client fires
  these off right after a match, so two can land together; a read-then-write would let both
  see the same stale `granted_at` and pay out twice.
- **A rejected claim leaves `granted_at` alone.** If an on-cooldown ask pushed the timestamp
  forward, a client that retries in a loop would never become eligible.
- **`giftContext` (the activity, e.g. `Soccer`) is part of the key** — the "first activity of
  the day" is per activity, so a player who moves from Soccer to Paintball is owed another
  reward while a second Soccer match inside the hour is not.
- **A contextless ask keys on `''`, not NULL.** SQLite allows — and does not dedupe — NULLs
  in a non-INTEGER primary key, so a NULL context would insert a fresh row on every ask
  instead of hitting the conflict, and the cooldown would never apply. Migration
  `0013_reward_status_gift_context.sql` rebuilds the table (SQLite can't add a column to a
  primary key) and lands the pre-existing rows on that same `''` bucket, so cooldowns from
  before it keep counting.

**What a claim pays: 5 XP, in a gift box.** The XP (`GAME_REWARD_XP`) is banked in
`progression` and the box is the wrapper the client shows for it — no item, every item field
empty, `GiftContext` 50 (`GameRewards`). The box wears the `Message` the client posted
(`First Game of the Day`), and a `GiftPackageReceivedImmediate` frame goes out with it, the
same push the weekly-challenge gift uses. XP is banked **before** the box is created, so a
failure can't leave a box promising XP nobody was credited.

- **One flat amount for every reward type**, matching the one flat cooldown they share.
  Pricing `FirstActivityOfDay` differently from `PostGameActivity` is a map keyed by type,
  the same shape the per-type cooldown would take.
- **Deliberately smaller than a level.** The first level costs 10 XP, so a single action
  can't be a level-up — it takes two rewards to reach level 2, and the early levels are paced
  by the hourly cooldown rather than cleared in one match.
- **The response stays `[]`.** It's what the client already accepts, and the reward is
  delivered as a box, so there's nothing to put in the body. The reference answers its own
  (different) flow with `{ error, success, value: null }`, not a list of rewards.
- **An on-cooldown ask pays nothing** — no XP, no box, no frame. That's the whole point of
  getting eligibility right first: a client that retries in a loop must not mint boxes.

**Progression (`progression`) is shared.** `econ` writes it here; `api` reads it back for
`GET /api/players/v{1,2}/progression/…`. It lives in `@repo/domain` for that reason, the
same split as gift boxes. A player with no row reads as level 1 / 0 XP, so a GET never
inserts.

**Levelling spends the XP.** `xp` is progress into the current level, not a lifetime total:
`addXp` adds the grant, then walks the ladder in `LEVEL_REQUIRED_XP`, subtracting each
level's cost while it's covered — so a big enough grant can cross several levels at once.
The ladder steps 10 → 20 → 45 → 115 → 360 → 1080 every ten levels and stops at 50, so the
first level costs 10 XP and the last costs a hundred times that.

That table is copied from the `LevelProgressionMaps` the client is served in
`apps/api/static/api-config-v2.json`, and **both sides have to agree** or the bar fills to a
different mark than the level-up fires at; an `api` test asserts they stay identical.

It is also the real game's curve, checked against Rec Room's own published level chart —
cumulative XP to finish a level: 170 by 10, 620 by 20, 1,770 by 30, 5,370 by 40, 16,170 by 50. Nearly flat to level 20, then a knee at 30–40 and a steep climb to the cap; a third of
the whole grind sits in the last ten levels. A test pins those milestones, since per-level
costs are easy to edit one at a time and hard to eyeball as a curve.

**Every level pays out a reward**, from Rec Room's published level-reward table
(`LEVEL_REWARDS` in `@repo/domain`) — per level, not per band:

| Levels           | Reward                                     |
| ---------------- | ------------------------------------------ |
| 1, 3, 5, 6, 7, 9 | Consumable                                 |
| 2, 4, 8, 10 – 21 | 2-Star Clothing (rarity 10)                |
| 22 – 30          | 3-Star on even levels, 2-Star between      |
| 31 – 39          | 3-Star, with 4-Star at 31 and 35           |
| 40 – 49          | 4-Star Clothing (rarity 30)                |
| 50               | 5-Star Clothing (rarity 50) — the only one |

**One reward per level crossed** — a grant spanning several levels pays each of them. In
practice a 5 XP game reward crosses at most one, so the second reward a fresh player claims
hands over two boxes: the XP reward itself and the 2-Star Clothing for reaching level 2. Each
arrives as a gift box announced like any other (`Level 2!`).

- **"Clothing" is why the roll passes `avatarItemsOnly`** — the prize has to be something the
  player can wear and be seen in, never an equipment skin for a weapon they may not own.
- **Consumable levels don't roll a rarity.** The table names no star tier for them, and
  consumables stack, so there's no ownership filter either — a second Confetti Cannon is a
  fine prize. It's picked as a concrete drop rather than through the query path.
- **This table is not the served config's `GiftRarity`.** That one is a coarse per-band tier
  (flat 10 to level 14, 20 to 39, 30 to 49, 50 at the cap) with no notion of consumables, and
  the two disagree — level 15 is 2-Star in the published table and 20 in the config. We grant
  from the published table; the config is left as captured, so the drift test asserts only
  the XP costs. If the client previews an upcoming reward from `GiftRarity`, aligning the two
  is an edit to the static config.
- The reference server carries the config data and never reads it: granting anything for a
  level is ours.

**The client is told, or it shows nothing.** A grant pushes `PlayerProgressionLevelUpdate`
(`{ PlayerId, Level, XP }`) — without it the bar sits still until something else refreshes
it, which is what "levelling does nothing" looks like from the game. `api`'s
`GET /api/players/v1/progression/:id` pushes the same frame on read, as the reference does,
so a client that just connected gets its bar right.

**Not ported:** the reference's `request` doesn't grant at all — it offers **three** drops,
pushes a `RewardSelectionReceived` frame and waits for `POST /api/gamerewards/v1/select` to
grant the one the player picked. We grant on request instead, so there is no selection state
and no `/select`. It also caps activity XP per day (`daily_xp_ledgers`); the hourly cooldown
is our cap.

`GET /api/gamerewards/v1/pending` stays `[]`: with rewards claimed on request, nothing sits
waiting to be collected.

## Bindings

| Binding                      | Type           | Notes                                                      |
| ---------------------------- | -------------- | ---------------------------------------------------------- |
| `DB`                         | D1             | Shared `recflare` database — balances, inventory, XP, etc. |
| `JWT_SECRET`                 | Secrets Store  | Shared HS256 signing key (see the `auth` README)           |
| `ASSETS`                     | static assets  | Serves `sf{N}.json` storefront catalogs                    |
| `RECFLARE_NOTIFICATIONS_HUB` | Durable Object | Cross-worker RPC to the `notify` worker's hub              |
| `STARTING_TOKENS`            | var            | Optional; new-player token grant (default in balance-db)   |

Add a storefront by dropping a new `sfN.json` in `static/storefronts` — no code change.

## Known gaps

- Gifting to another player grants the item and box but does not notify the recipient — the
  reference sends `GiftPackageReceivedImmediate` there too (`buy.go`, when the body carries
  a `Gift`), and `pushGiftReceived` is now sitting right there to do it.
- `buyItem` grants avatar-item, equipment, consumable and query (box) drops; currency/xp
  drops aren't granted.
- A query drop rolls uniformly across the tier and can't run at a rarity sf3 doesn't
  publish; per-item weighting and a multi-catalog pool would both need a manifest of the
  storefronts, which the ASSETS binding can't enumerate.
- Consumables are granted and listed but never spent by gameplay, so `Count` only grows.
- Several routes (room keys, wishlist, equipment, room consumables/currencies) are
  empty-list stubs pending their own stores.
- Game rewards pay a flat 5 XP; there is no daily XP cap beyond the hourly cooldown (the
  reference caps activity XP per day in `daily_xp_ledgers`).
- The level-reward table and the served config's `GiftRarity` disagree in places (see the
  level section); we grant from the table and leave the config as captured, so a client that
  previews an upcoming reward would preview the config's answer, not ours.
