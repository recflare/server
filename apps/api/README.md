# api

Game API Worker served on the `api` subdomain. A Hono app serving the game's
API surface. Database-backed queries and on-disk JSON files are stubbed for now
— no real bindings yet.

## Behavior

- **Auth-gated routes** validate the Bearer JWT issued by the `auth` worker
  (same dev secret, see `src/jwt.ts`) and 401 when it's missing/invalid.
- **API-owned uploads** enforce `RECFLARE_MAX_API_UPLOAD_BYTES` per file (64 MiB
  by default) before copying a parsed file into an `ArrayBuffer` or writing it to R2.
- **Static data** is served verbatim:
  - `src/default-avatar-items.ts` → `GET /api/avatar/v4/items`
  - `src/default-settings.ts` → `GET /api/settings/v2`
- **DB-backed reads** return empty collections / not-found.
- **File-backed reads** return empty placeholders, each marked `TODO: hydrate`
  in `src/api.app.ts` (Workers have no filesystem — these will move to a binding
  or inline JSON later).

## TODO before production

- Wire a DB binding (D1/DO) for rooms, avatars, settings, gifts, balances, etc.
- Hydrate the `TODO: hydrate` endpoints with real config/JSON.
- Move the JWT secret to a shared secret binding (shared with `auth`).
- Persist uploads from `POST /api/images/v4/uploadsaved` (e.g. R2).
