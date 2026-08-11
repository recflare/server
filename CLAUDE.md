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
