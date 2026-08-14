# commerce

A Cloudflare Workers application using Hono

## Endpoints

- `GET /purchase/v1/hasspentmoney` — whether the player has ever spent money;
  `false`.
- `POST /purchase/v1/initiatepurchase` — begins a purchase, answering
  `{ "transactionId": 1234567890 }`. Nothing is charged and no transaction is
  recorded, so the id is a fixed placeholder and the posted body is ignored.
- `GET /api/catalog/v1/all` — the purchasable SKU catalog (token packs, special
  offers), served from the bundled `static/catalog-v1-all.json`. The client's
  `?onlyAvailableSkus=true` is accepted and ignored: the bundled catalog already
  contains only available SKUs.
- `GET /purchasecampaign/allcurrent/v2` — current purchase campaigns
  (limited-time offers/promos); `[]` (none active).
- `GET /reminder/currentTokenBundles/v2` — token-bundle purchase reminders (the
  "buy more tokens" nudge); `[]` (none to show).
- `GET /openapi.json` — the generated OpenAPI 3.1 spec for the routes above.
  Descriptive only; nothing is validated against it. Also aggregated into the
  docs UI on `www` at `/docs`.

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
