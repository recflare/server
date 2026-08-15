# ai

AI worker served on the `ai` subdomain (`ai.recflare.net`). The client checks here before
offering any of its AI features.

- `GET /` — service status `{ "service": "ai", "status": "ok" }`. No auth.
- `GET /gameai/user/access?roomId=<id>` — `[Authorize]`. Whether the caller may use Game AI
  in a room. Always refused:

  ```json
  {
    "success": false,
    "error_id": "AI.RoomDoesNotSupportGameAI",
    "error": "This room does not support Rec Room Game AI"
  }
  ```

  No model runs behind this worker, so every room gets that answer. Two things about it
  are deliberate: **it is a 200, not a 4xx** (the client branches on `success` in the body;
  an error status would surface as a failed request rather than the "not available here"
  state this is), and **`roomId` is ignored** while the token is still validated first, as
  the reference server does — so an unauthenticated caller gets a 401 rather than the
  refusal.

- `GET /roomieai/user/access` — `[Authorize]`. Roomie AI's energy budget, granted in full:

  ```json
  {
    "success": true,
    "error_id": null,
    "error": null,
    "value": {
      "MaxEnergyFromSubscriptions": 2147483647,
      "EnergyLeft": 2147483647,
      "NextSubscriptionEnergyRechargeAt": null,
      "OutputAudioEnabled": true
    }
  }
  ```

  Granted rather than refused because Roomie runs on the CLIENT and only asks this service
  how much energy it may spend — so for a server that meters nothing, "as much as you can
  count" is the honest answer. That number is `int.MaxValue`: the client's field is a
  signed 32-bit int, and anything larger overflows on the way in and reads as negative,
  i.e. no energy at all. Nothing depletes, so nothing recharges — hence the null
  `NextSubscriptionEnergyRechargeAt`.

  Note the envelope: `{ success, error_id, error, value }`, not the flat body the Game AI
  check answers with. The two shapes are different on purpose; don't unify them.

The worker exists so the client gets a definite answer on the host its endpoints document
already names (`AI` → `ai`, see `apps/ns`), instead of a failed request to a host with
nothing behind it.

## API documentation

`GET /openapi.json` serves a spec generated from `describeRoute` blocks that sit alongside
each handler, with the schemas in `src/openapi.ts`. It's also aggregated into the docs page
www serves at `/docs`. A test asserts every route appears in it.

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
