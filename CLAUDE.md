<cloudflare-workers-monorepo>

<title>Cloudflare Workers Monorepo Guidelines for Claude Code</title>

<commands>
- `just install` - Install dependencies
- `just dev` - Run development servers (uses `bun runx dev` - context-aware)
- `just test` - Run tests with vitest (uses `bun vitest`)
- `just build` - Build all workers (uses `bun turbo build`)
- `just check` - Check code quality - deps, lint, types, format (uses `bun runx check`)
- `just fix` - Fix code issues - deps, lint, format, workers-types (uses `bun runx fix`)
- `just deploy` - Deploy all workers (uses `bun turbo deploy`)
- `just preview` - Run Workers in preview mode
- `just new-worker` (alias: `just gen`) - Create a new Cloudflare Worker
- `just new-package` - Create a new shared package
- `just update deps` (alias: `just up deps`) - Update dependencies across the monorepo
- `just update pnpm` - Update pnpm version
- `just update turbo` - Update turbo version
- `bun turbo -F worker-name dev` - Start specific worker
- `bun turbo -F worker-name test` - Test specific worker
- `bun turbo -F worker-name deploy` - Deploy specific worker
- `bun vitest path/to/test.test.ts` - Run a single test file
- `pnpm -F @repo/package-name add dependency` - Add dependency to specific package
</commands>

<architecture>
- Cloudflare Workers monorepo using pnpm workspaces and Turborepo
- `apps/` - Individual Cloudflare Worker applications
- `packages/` - Shared libraries and configurations
  - `@repo/oxlint-config` - Shared oxlint configuration
  - `@repo/typescript-config` - Shared TypeScript configuration
  - `@repo/hono-helpers` - Hono framework utilities
  - `@repo/tools` - Development tools and scripts
- Worker apps delegate scripts to `@repo/tools` for consistency
- Hono web framework with helpers in `@repo/hono-helpers`
- Vitest with `@cloudflare/vitest-pool-workers` for testing
- Syncpack ensures dependency version consistency
- Turborepo enables parallel task execution and caching
- Workers configured via `wrangler.jsonc` with environment variables
- Each worker has `context.ts` for typed environment bindings
- Integration tests in `src/test/integration/`
- Workers use `nodejs_compat` compatibility flag
- GitHub Actions deploy automatically on merge to main
- Changesets manage versions and changelogs
</architecture>

<game-clients>
Supported client builds live in `SUPPORTED_GAME_VERSIONS`
(`packages/domain/src/presence-db.ts`); `GAME_VERSION` is the default the stack targets.

- `20230414` — default, official. Manifest `7859140924515540835` (2023).
- `20250718.01` — beta, official. Manifest `1151455856673601091`; reaches this server via
  the [patch-2025](https://github.com/recflare/patch-2025) patch.
- `20250424.01`, `20231207`, `20230616` — alpha.

Builds are date-stamped (`YYYYMMDD[.NN]`) so they order as plain strings; several
surfaces gate on "newer than `20230414`" (econ storefront catalog, `api` event tags,
`rooms` featured rooms) rather than on an explicit list.
</game-clients>

<code-style>
- Use tabs for indentation, spaces for alignment
- Type imports use `import type`
- Workspace imports use `@repo/` prefix
- Import order: Built-ins → Third-party → `@repo/` → Relative
- Prefix unused variables with `_`
- Prefer `const` over `let`
- Use `array-simple` notation
- Explicit function return types are optional
</code-style>

<client-contract-notes>
Response shapes the Rec Room client depends on. These were found by watching the live
client, not by reading a spec: when one is wrong the client renders nothing or hangs
rather than erroring, so tests won't catch a regression. Don't "clean up" an
inconsistency here without checking the client first.

- Player image lists (`api`: `/api/images/v5|v4/player/:id`, `/api/images/v3/feed/player/:id`)
  must use the `toImagesPlayer` projection — `Id` → `SavedImageId`, `Type` →
  `SavedImageType`, no `TaggedPlayerIds`. Serving the raw `SavedImage` renders blank
  thumbnails.
- The room photo feed (`api`: `/api/images/v4/room/:roomId`) serves the raw `SavedImage`
  and displays correctly. It is deliberately NOT projected — do not unify these two.
- A club's `AdditionalImages` (`clubs`) is an array of whole `SavedImage` records, not
  image names — a bare string array fails the client's parser ("expected '{'"). The list
  is packed: removing an image shifts the rest up, never leaving a blank slot.
- A room's `LoadScreens` (`rooms`: `PUT /rooms/:id/loadscreen`) is an array — the
  client's parser wants one — but the client renders only the FIRST entry and only ever
  posts one. So the endpoint REPLACES the list rather than appending: an appended screen
  sits unreachable behind the old one and setting a load screen looks like it did
  nothing. Keep the array shape for eventual multi-screen support.
- Endpoints the client re-renders from must return the updated entity, not
  `{ error, success, value: null }` — e.g. `clubs` `PUT /club/:id/clubhouse` left the old
  clubhouse on screen until it answered the full details envelope.
- Every subroom mutation (`rooms`: create, delete, `/subrooms/:sid/clone`,
  `/subrooms/:sid/accessibility`, `/subrooms/:sid/publish_save`) answers
  `{ success, error, value }` with the whole updated ROOM — the client re-renders the room
  from `value`. Notably `value` is the room even for `clone`, whose product is a new
  SUBROOM; only the room-level `POST /rooms/:id/clone` returns the thing it created.
- The room save (`rooms`: `POST /subrooms/:sid/data`) is the ONE exception to that shape:
  `value` is `{ room, subRoomDataSave }`, and `error` is NULL rather than `""`. The
  `subRoomDataSave` is camelCase with a different field set from the PascalCase
  `CurrentSave` embedded in the room (no persistence/OM/UGC versions, no moderation state,
  no asset arrays; but `unityAsset`/`unityAssetHash`). Don't unify the two projections.
- A subroom's saved scene loads from `CurrentSave.DataBlob` (`rooms`: `GET /rooms/:id`),
  NOT the flat `DataBlob` on the subroom — a subroom with no `CurrentSave` silently loads
  nothing. The key must be present (null before the first publish); read it via
  `subRoomDataBlob()` so `match`/`auth` instance payloads resolve it the same way.
- A room save (`rooms`: `POST …/subrooms/:sid/data`) publishes only when the body says
  `AutoPublish: true`; otherwise it STAGES onto `StagedSubRoomDataSaveId` and leaves
  `CurrentSave` alone, so players keep loading the last published version until the owner
  posts `…/subrooms/:sid/publish_save` with `subRoomDataSaveId=<id>`. DORMS always
  publish: no publish step exists in the client for them. Saves live in the
  `subroom_save` table with globally-unique ids (a bare id has to resolve —
  `StagedSubRoomDataSaveId` carries no subroom context), and nothing is overwritten, so
  `…/saves` is real history and `publish_save` doubles as restore-a-save. There
  is no `GET …/subrooms/:sid/data`; only the POST (the room save) exists on that path.
  `GET …/saves/:saveId` is the detail behind a list row, under the same gate, but in the
  CAMELCASE projection the room save's response uses — not the PascalCase rows the list
  serves. Three shapes of one save; keep them straight.
- Both save reads (`rooms`: `…/saves` and `…/saves/:saveId`) are auth-gated and readable by
  the room's CREATOR or by anyone whose live `presence` row puts them in that room — not by
  co-owners as such (a co-owner passes only by standing there). They list unpublished
  staged saves, so they aren't public; but a visitor resolves which version an instance is
  running from this list, so creator-only locks them out of loading the room. The grant
  expires with the presence row.
- A room save writes ONLY to the subroom and its save row — never to the room. Everything
  the body carries describes that one revision: `Description` is the save comment shown in
  `…/saves`, and `PersistenceVersion`/`InventionUsage` describe the scene just saved (the
  latter lives on the SUBROOM). The room's public description is `PUT /rooms/:id/description`'s
  alone; copying the save comment onto `room.Description` (as this once did) silently
  replaces the room's description every time someone saves.
- Matchmaking (`match`: `/matchmake/room/:roomId/:subRoomId`) always serves the PUBLISHED
  `CurrentSave` blob, creator included. Joining a private instance, the client itself asks
  the owner whether to load the latest or the published version and resolves it from the
  `/subrooms/:sid/saves` list — the matchmake call is identical either way. Don't make
  this server-side: it would put two people in one instance on different versions.
- A balance lives in a `(CurrencyType, Platform)` BUCKET and the client shows the SUM of the
  buckets, so `Platform` is a balance's identity, not a label. This server uses exactly one
  bucket per currency — `ALL_PLATFORMS`, -2 `NonPurchasedNotUsableInP2P` — and every surface
  must name it: the balance DTO (`econ`: `GET /api/storefronts/v4/balance/:type`), the
  `BalanceType` the storefront bodies echo, and the `Platform` on every `StorefrontBalance*`
  socket frame. Two traps, which produced two "balance doubling" bugs that both looked like
  the frames being additive when they are not:
  - Each frame SETS the bucket it names to an absolute value — `Balance` is the RESULTING
    TOTAL, never the change (`StorefrontBalancePurchase`'s `Delta`/`BalanceAddType` are
    display-only; the client logs them and stores `Balance` outright). Send a change and the
    balance becomes that change. Being absolute, a frame is idempotent: re-sending one, or
    racing a `GET /balance`, cannot drift the total, so the player reading the HTTP response
    for the same change gets a frame too.
  - The bucket key on the wire is `Platform`. The client's property is named `BalanceType`
    but carries a `[DataMember]` rename, and its decoder drops unknown members silently, so
    a frame saying `BalanceType` lands in `Platform` 0 (`SteamPurchased`) and adds a phantom
    balance to the real one — 10,000 tokens + a 250 reward read 20,250. Sending a real-but-
    different platform does the same: `Platform: RecNet` on a buy showed 34,100 to a player
    who spent 900 of 17,500, then 33,200 once the body's -900 reached the true bucket.
  The payload shapes are recovered from the client's own decoder in
  `apps/notify/src/notification-payloads.ts` — build frames against those interfaces (econ
  does) so a renamed key fails the build instead of silently vanishing on the wire.
- Every matchmake response (`match`: `/matchmake/*`, refusals and the ban middleware's
  included) must echo the request's `CorrelationId` back as `correlationId` — the client
  tags each attempt with a GUID and fails with "Unable to connect to game session" if it
  can't match the response to the attempt. A request that names none gets the all-zero
  `Guid.Empty` rather than null: the client's field is a non-nullable Guid. The code is
  served under TWO names, `result` (what the client reads) and `errorCode` (what this
  server has always sent); they are the same number and must never disagree, which is why
  everything answers through `matchmakeResult` rather than building the envelope by hand.
- What PLAYS a cheer on the cheered player's client is a `MessageReceived` frame carrying a
  Message of type 50 `PlayerCheer` (51 `PlayerCheerAnonymous`, `FromPlayerId` 0, when the
  body says `Anonymous`) with `Data` = the category as a string — the same frame every
  reference server (meownet-api, DorkNet, E12354) sends. `ReputationUpdate` alone refreshes
  the counters and shows nothing: the cheer "worked" server-side and nobody saw it. The
  `ReputationUpdate` frames the cheer (`api`: `POST /api/PlayerCheer/v1/create`) sends are
  the RECORD, trimmed — `IsCheerful` (a profile flag, always true) and `SelectedCheer` (the
  cheer pinned via `POST /api/PlayerCheer/v1/SetSelectedCheer`, stored on `reputation`) come
  off the row exactly as the DTO serves them. This server once overrode both per frame to
  "play" the cheer; no reference does, and it played nothing.
- A cheer is a thing that happens in FRONT of people, so the `ReputationUpdate` naming the
  cheered player goes to everyone in the room instance, not just the two players. The
  cheered player gets it durably (their counters moved); the rest of the room gets it
  ephemerally. The audience comes from the giver's live `presence` row, NOT the body's
  `RoomId`, which is accepted and unused. Neither `RoomId` nor `Anonymous` is stored.
- The cheer's reply is `{ Success, Message }` — PascalCase, with `Message` NULL on success.
  That is NOT the lowercase `{ success, error: "" }` envelope the reports and warnings use;
  the two live side by side in the same worker and must not be unified.
- A Message's `Data` (every `MessageReceived` frame) is a STRING on the wire, so a payload
  with structure to it goes in ESCAPED — `"Data": "{\"PlayerId\":\"205\"}"`, never a nested
  object. An object there does not degrade: the client's decoder rejects it outright
  (`expected:'String Begin Token', actual:'{'`) and loses the whole notification, not just
  the field. Bites the vote-to-kick message (`api`: `POST /api/PlayerReporting/v3/voteToKick`,
  whose `Data` carries `{ PlayerId, Response, GameSessionId }` — `PlayerId` a string inside
  it, as the reference relays it) and, the same way, a chat message's `Contents`.
- Leaderboard `Rank` (`leaderboard`: `GetRanks`, `GetNearbyScores`, `GetPlayerRank`) is
  0-BASED — the client adds one before it draws, so a `Rank` of 1 shows in game as second
  place and the top of a board must be 0. Its own slice says the same: it asks for the first
  ten rows as `RankStart` 0, `RankEnd` 9, both inclusive, so reading them as 1-based also
  serves nine rows starting at the runner-up. The unranked sentinel stays a big number
  (99999) precisely because 0 is now a real rank, first place.
- Accessibility is sent as the `RoomAccessibility` enum NAME on
  `rooms` `PUT /rooms/:id/subrooms/:sid/accessibility` (`accessibility=Private`), not the
  ordinal the room-level `/rooms/:id/accessibility` takes. The enum has five members
  (Private, Public, Unlisted, Dev_only, Dev_Unlisted); parse via `parseAccessibility`,
  which accepts either form.
</client-contract-notes>

<critical-notes>
- TypeScript configs MUST use fully qualified paths: `@repo/typescript-config/base.json` not `./base.json`
- Do NOT add 'WebWorker' to TypeScript config - types are in worker-configuration.d.ts or @cloudflare/workers-types
- For lint checking: First `cd` to the package directory, then run `bun turbo check:types check:lint`
- Use `workspace:*` protocol for internal dependencies
- Use `bun turbo -F` for build/test/deploy tasks
- Use `pnpm -F` for dependency management (pnpm is still used for package management)
- Commands delegate to `bun runx` which provides context-aware behavior
- Test commands use `bun vitest` directly, not through turbo
- NEVER create files unless absolutely necessary
- ALWAYS prefer editing existing files over creating new ones
- NEVER proactively create documentation files unless explicitly requested
</critical-notes>

</cloudflare-workers-monorepo>
