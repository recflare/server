# Services

This is a list of every RecNet service the client discovers, taken from the
service-discovery map in [`apps/ns/src/endpoints.ts`](apps/ns/src/endpoints.ts).
Each is reached at `https://<subdomain>.<your-domain>`. Services with a worker in
`apps/` are implemented here; the rest are advertised in the endpoints document
but not yet backed by a Worker. Not all services are fully implemented.

The subdomains below are the defaults. Any of them can be redirected from `.env` via
`RECFLARE_SUBDOMAINS`, keyed by the subdomain in this table — which both moves where the
worker deploys and what `ns` advertises. Pointing one service at another merges them, e.g.
`'{"moderation":"api"}'` sends the client's Moderation calls to the `api` worker, where the
`/api/PlayerReporting/…` routes already live. See `DEPLOYING.md`.

That override is still the one to set for Moderation: the `moderation` worker deploys but
is a stub, so with no override the client's reporting calls reach it and 404 rather than
reaching the routes in `api`. Drop the override once `moderation` serves them itself.

A small `ns` worker itself serves this discovery document at the
apex/`ns` host and isn't listed within it. Each implemented worker has its own
`README.md` under `apps/<name>/` documenting its routes.

| Service               | Subdomain               | Worker                  | Notes                                                                 |
| --------------------- | ----------------------- | ----------------------- | --------------------------------------------------------------------- |
| Accounts              | `accounts`              | `accounts`              | Player accounts & profile reads/writes (D1)                           |
| AI                    | `ai`                    | `ai`                    | Game AI access check (always refuses — no model runs here)            |
| API                   | `api`                   | `api`                   | Core Game API — config, social, avatar, rooms, image uploads (D1, R2) |
| Auth                  | `auth`                  | `auth`                  | OAuth token issuance (`/connect/token`); (D1)                         |
| BugReporting          | `bugreporting`          | —                       | Not yet implemented                                                   |
| Cards                 | `cards`                 | `cards`                 | Stub — deploys and answers, no card endpoints yet                     |
| CDN                   | `cdn`                   | `cdn`                   | Binary CDN — room data (R2)                                           |
| Chat                  | `chat`                  | `chat`                  | Player chat service (not in room)                                     |
| Clubs                 | `clubs`                 | `clubs`                 | Clubs, not yet implemented                                            |
| CMS                   | `cms`                   | —                       | Not yet implemented                                                   |
| Commerce              | `commerce`              | `commerce`              | Store / purchase endpoints                                            |
| Data                  | `data`                  | —                       | Not yet implemented                                                   |
| DataCollection        | `datacollection`        | `datacollection`        | Client telemetry / analytics sink                                     |
| Discovery             | `discovery`             | `discovery`             | Discovery page layouts (static assets)                                |
| Econ                  | `econ`                  | `econ`                  | Economy & avatar endpoints (separate from `api`)                      |
| GameLogs              | `gamelogs`              | —                       | Not yet implemented                                                   |
| Geo                   | `geo`                   | —                       | Not yet implemented                                                   |
| Images                | `img`                   | `img`                   | Image storage & signed delivery (R2)                                  |
| Leaderboard           | `leaderboard`           | —                       | Not yet implemented                                                   |
| Link                  | `link`                  | —                       | Not yet implemented                                                   |
| Lists                 | `lists`                 | `lists`                 | Curated & algorithmic discovery lists (canned — nothing ranks yet)    |
| Matchmaking           | `match`                 | `match`                 | Matchmaking & per-player presence (D1, KV)                            |
| Moderation            | `moderation`            | `moderation`            | Stub — the reporting routes still live in `api`; see note below       |
| Notifications         | `notify`                | `notify`                | Real-time notifications over SignalR/WebSockets (Durable Object)      |
| PlatformNotifications | `platformnotifications` | `platformnotifications` | Stub — deploys and answers, no notification endpoints yet             |
| PlayerSettings        | `playersettings`        | `playersettings`        | Per-player settings (KV)                                              |
| RoomComments          | `roomcomments`          | —                       | Not yet implemented                                                   |
| RoomieIntegrations    | `roomieintegrations`    | —                       | Not yet implemented                                                   |
| Rooms                 | `rooms`                 | `rooms`                 | Room storage & queries; seeds the Dorm & Orientation rooms (D1)       |
| Storage               | `storage`               | —                       | Room uploader                                                         |
| Strings               | `strings`               | —                       | Not yet implemented                                                   |
| StringsCDN            | `strings-cdn`           | —                       | Not yet implemented                                                   |
| Studio                | `studio`                | —                       | Not yet implemented                                                   |
| Thorn                 | `thorn`                 | —                       | Not yet implemented                                                   |
| Videos                | `videos`                | —                       | Not yet implemented                                                   |
| WWW                   | `www`                   | —                       | Website/Panel                                                         |
