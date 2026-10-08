# playersettings

Player-settings worker served on the `playersettings` subdomain.

- `GET /` — service status `{ "service": "playersettings", "status": "ok" }`.
- `GET /playersettings` — `[Authorize]`. The player's settings as
  `{ PlayerId, Key, Value }`, read from the player's stored map. On a player's
  first read it seeds (and persists) the default settings.
- `PUT /playersettings` — `[Authorize]`. Accepts a form-urlencoded
  `key=…&value=…` (or a JSON `{key,value}` / array) and **upserts** it into the
  player's settings, keyed by the `sub` claim of the Bearer JWT. Returns `200`.
  Persisted in the `player_settings` D1 table (one JSON row per player).
- `DELETE /playersettings` — `[Authorize]`. Removes a setting from the player's
  map. The client sends a bare form-urlencoded `key=PlayerShoppingBagId` (no
  `value`); a JSON body and a `?key=` query param are also read. Deleting a key
  that isn't stored is a no-op `200`, not a `404`.

> A full settings PUT would replace the player's _entire_ settings set on each
> call; we merge instead, so a single-key PUT (e.g. `key=PlayerSessionCount`)
> doesn't wipe the others.

> Emptying the map with DELETE puts the player back to a first read: the next
> `GET` re-seeds the defaults.

## Storage

Settings live in the `player_settings` table on the shared `recflare` D1: one row per
player, `account_id` plus `data`, the whole map as a JSON object of strings
(`{"Recroom.OOBE":"77","TUTORIAL_COMPLETE_MASK":"11"}`). This worker owns the table
(`migrations/0001_player_settings.sql`, applied under its own `d1_migrations_playersettings`
ledger); the `api`, `match` and `chat` workers each keep a key of their own in the same map
through `@repo/domain`'s `player-settings-db`, which is why every writer merges rather than
replaces. A write that changes nothing is skipped.

```sh
just migrate -F playersettings          # create the table (add -- --local for the dev db)
```

They used to live in a Workers KV namespace (`RECFLARE_PLAYER_SETTINGS`, key `player:<id>`).
A deployment from then copies it across once with `just settings-import-kv --remote` —
see CLI.md — after which the namespace can be deleted.

## Development

### Run in dev mode

```sh
pnpm dev
```

### Run tests

```sh
pnpm test
```

### Deploy

```sh
pnpm turbo deploy
```
