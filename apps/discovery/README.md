# discovery

Discovery Worker served on the `discovery` subdomain (`discovery.recflare.net`) — a Hono
app that tells the client which carousels each of its discovery pages shows, and in what
order.

`GET /sections/pagesource/{type}` serves one page's sections verbatim from
`static/<type>.json`. `{type}` IS the filename — it is passed through unchanged and matched
exactly, case included — so the page sources that exist are whichever files are published:
`WatchHome`, `PlayHighlight`, `CommunityBoard`, `PlayMenuTabs`, `PlayCategories`,
`StoreFeatured`, `StoreClothing`, `StoreConsumables` and `bulk` at the time of writing.
Adding one is dropping in a file; nothing in `src/` enumerates them.

That works because `static/` is uploaded as Workers static assets rather than bundled into
the script (a bundled `import` can't do it — the bundler has to see every path at build
time), and the handler reads them through the ASSETS binding. `run_worker_first` is set so
the runtime never serves a layout directly at `/WatchHome.json`: the files are reachable
only through the documented route. Names that could climb out of `static/` are refused
before they reach the binding, and the asset response is passed through whole, so
`If-None-Match` gets a 304 for free.

The body is a bare ARRAY of sections with camelCase fields (`id`, `sectionType`,
`sectionSubType`, `source`, `sourceMetadata`, `displayMetadata`), the last two nullable and
`displayMetadata` an embedded JSON _string_ the client parses itself. This replaces the
`Discovery.DiscoveryPageContent.*` game configs (see
`apps/api/static/gameconfigs-v1-all.json`), which the client reads instead when
`Discovery.UseNewDiscoveryServerAPI` is off — note they are NOT the same shape: the configs
wrap the list in `{ pageSource, sections }` with PascalCase fields.

A section only _names_ a feed — `source`/`sourceMetadata`, e.g. `Hot`, `Recent`,
`PlaylistById` + an id, `CarouselEndpoint` + a slug — which the client resolves against the
`rooms`/`api` workers itself. Nothing here is player-specific, so the routes are
unauthenticated and every client gets the same layout.

## API documentation

`GET /openapi.json` serves a spec generated from `describeRoute` blocks that sit alongside
each handler, with the schemas in `src/openapi.ts`. It's also aggregated into the docs page
www serves at `/docs`.

**The spec is descriptive, not enforced** — same rationale as the other workers: a
reverse-engineered protocol, lenient handlers, no runtime validation.

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
