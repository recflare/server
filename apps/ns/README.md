# ns

Name-server / service-discovery worker served on the `ns` subdomain.

`GET /` returns the endpoints document the game client fetches on startup to
discover every service host (Accounts, API, Auth, Econ, Matchmaking,
Notifications, …).

Each host is built at runtime from the `DOMAIN` var (the base domain) plus the
service → subdomain map in `src/endpoints.ts`, with the `SUBDOMAINS` var applied
on top. Both vars are injected at deploy time from `RECFLARE_DOMAIN` and
`RECFLARE_SUBDOMAINS` (see `run-wrangler-deploy`) and default to
`rec.example.com` / `{}` in `wrangler.jsonc` for local dev.

## Updating endpoints

- To change the base domain, set `RECFLARE_DOMAIN` (in `.env`) and redeploy.
- To point one service at a different host, add it to `RECFLARE_SUBDOMAINS` (in
  `.env`) and redeploy. It's keyed by the service's _default_ subdomain — the
  same object `run-wrangler-deploy` reads to pick a worker's host, so an entry
  moves the deployed worker and the advertised host together. An entry for a
  service with no worker (e.g. `{"moderation":"api"}`) is a pure client-side
  redirect onto a host another worker already serves.
- To add or rename a service, edit the map in `src/endpoints.ts`.
