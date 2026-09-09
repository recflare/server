# playersettings

Player-settings worker served on the `playersettings` subdomain.

- `GET /` — service status `{ "service": "playersettings", "status": "ok" }`.
- `GET /playersettings` — `[Authorize]`. The player's settings as
  `{ PlayerId, Key, Value }`, read from the per-player KV map. On a player's
  first read it seeds (and persists) the default settings.
- `PUT /playersettings` — `[Authorize]`. Accepts a form-urlencoded
  `key=…&value=…` (or a JSON `{key,value}` / array) and **upserts** it into the
  player's settings, keyed by the `sub` claim of the Bearer JWT. Returns `200`.
  Persisted in Workers KV (`RECFLARE_PLAYER_SETTINGS`, key `player:<id>`).
- `DELETE /playersettings` — `[Authorize]`. Removes a setting from the player's
  map. The client sends a bare form-urlencoded `key=PlayerShoppingBagId` (no
  `value`); a JSON body and a `?key=` query param are also read. Deleting a key
  that isn't stored is a no-op `200`, not a `404`.

> A full settings PUT would replace the player's _entire_ settings set on each
> call; we merge instead, so a single-key PUT (e.g. `key=PlayerSessionCount`)
> doesn't wipe the others.

> Emptying the map with DELETE puts the player back to a first read: the next
> `GET` re-seeds the defaults.

## KV namespace

```sh
wrangler kv namespace create RECFLARE_PLAYER_SETTINGS   # then put the id in .env under RECFLARE_KV (see .env.example)
```

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
