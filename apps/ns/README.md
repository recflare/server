# ns

Name-server / service-discovery worker served on the `ns` subdomain.

`GET /` returns the endpoints document the game client fetches on startup to
discover every service host (Accounts, API, Auth, Econ, Matchmaking,
Notifications, …).

Each host is built at runtime from the `DOMAIN` var (the base domain) plus the
service → subdomain map in `src/endpoints.ts`. `DOMAIN` is injected from
`RECFLARE_DOMAIN` by both `run-wrangler-dev` and `run-wrangler-deploy`, and
defaults to `rec.example.com` in `wrangler.jsonc` when that isn't set.

## Updating endpoints

- To change the base domain, set `RECFLARE_DOMAIN` (in `.env`) and redeploy.
- To add or rename a service host, edit the map in `src/endpoints.ts`.

## ENDPOINT_STYLE

With `ENDPOINT_STYLE=path`, every service is advertised as `https://<domain>/<slug>`
instead of `https://<slug>.<domain>`. That's for the combined `mono` worker alone —
it's a single Worker that routes on the first path segment, so one host serves the
lot. Unset (the split deployment, where each service is its own Worker on its own
host) gives the subdomain document.
