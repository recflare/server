---
name: weekly-challenge-config
description: Read and author the `Config` rule tree in apps/econ/static/weekly-challenge.json — node types, scene-id predicates, and the shared-scene traps
---

# The weekly-challenge `Config` rule tree

Reference for reading and writing the `Config` field of a challenge in
`apps/econ/static/weekly-challenge.json` (served by `GET /api/challenge/v2/getCurrent`).

**The server never evaluates these rules.** The client reads the tree, watches its own
gameplay, and posts the tree back to `/api/challenge/v2/updateProgress` with its verdict.
So the tree is a _specification handed to the client_, and a malformed one fails silently —
the challenge just never completes. Nothing server-side will tell you.

Everything here was read off one captured live rotation, not a spec. Meanings marked
_(inferred)_ are read from how values line up with the strings the client renders; the rest
are pinned by the data.

## `Config` is an escaped JSON string

Not a nested object. In the file it looks like:

```json
"Config": "{\"ct\":0,\"ipc\":false,\"wc\":[...]}"
```

Author the tree as an object and stringify it into the field — don't hand-escape:

```sh
bun -e 'const t={ct:0,ipc:false,wc:[{ct:6,vs:[2]}]}; console.log(JSON.stringify(JSON.stringify(t)))'
```

To read one back:

```sh
bun -e 'const c=require("./apps/econ/static/weekly-challenge.json");
for (const x of c.Challenges) console.log(x.ChallengeId, x.Description, "\n ", JSON.parse(x.Config))'
```

## Node types

Each node carries a numeric type in `ct`. Two composite kinds appear:

- **Match** (`ct: 0`) — `wc` is a list of predicates that must _all_ hold for one game
  result (AND).
- **Counter** (`ct: 1`) — `ctc` holds the child node to count, `t` is the target count.

Which slot a node uses (`wc` vs `ctc`) tells you what its children are; a node never has
both. `ipc` is `false` on every composite node in the reference data — purpose unknown, but
the client echoes it back, so keep emitting it.

## Predicate leaves

Leaves carry `vs`, a list of accepted values matched as OR.

| `ct` | Shape                            | Meaning                                                                                                                                                                                     |
| ---- | -------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `6`  | `{"ct":6,"vs":[2]}`              | _(inferred)_ The kind of event being matched — a finished game/session. Present in **every** leaf group and always `[2]`; nothing observed varying it, so treat it as required boilerplate. |
| `7`  | `{"ct":7,"vs":[{"l":"<guid>"}]}` | Scene allow-list: each `l` is a subroom's `UnitySceneId` (see `apps/rooms`). Matches if the game happened in any of them.                                                                   |
| `9`  | `{"ct":9,"vs":[true],"v":"won"}` | A named session variable (`v`) equals one of `vs` — here, the player won.                                                                                                                   |

## The two idioms

Every challenge in the captured rotation is one of these.

```jsonc
// "Complete ^TheRiseOfJumbotron quest" — one winning session in one scene
{ "ct": 0, "ipc": false, "wc": [
  { "ct": 6, "vs": [2] },
  { "ct": 9, "vs": [true], "v": "won" },
  { "ct": 7, "vs": [{ "l": "acc06e66-…" }] }   // TheRiseofJumbotron / Home
]}

// "Complete 5 Charades games" — count matching sessions to a target
{ "ct": 1, "ipc": false, "t": 5, "ctc": [
  { "ct": 0, "ipc": false, "wc": [
    { "ct": 6, "vs": [2] },
    { "ct": 7, "vs": [{ "l": "a673712c-…" }, { "l": "4078dfed-…" }] }   // 3DCharades + Legacy3DCharades
  ]}
]}
```

The quest challenges have **no `t`** (one qualifying session is the whole goal) and the
counted ones have **no `won` predicate** (finishing counts, winning is irrelevant). A "one
map only" challenge is the counted shape with a single-entry scene list.

## Scene ids, not room ids

`ct: 7` matches `UnitySceneId`, so one guid can name several rooms — a screens room, its VR
twin, and the standalone base room all share a scene. The captured "Complete 10 games in
^Paintball" lists six guids, which are the subrooms of _both_ `Paintball` and `PaintballVR`,
each of which is also a standalone base room (`River`, `Clearcut`, …). One list covers every
way in.

Resolve a guid against `SubRooms[].UnitySceneId` in `apps/rooms/static/ImportRooms.json`
(same data as `apps/rooms/migrations/0002_import_rooms.sql`). Run from the repo root:

```sh
cat > /tmp/scene.ts <<'EOF'
// path is resolved against the cwd, so run this from the repo root
const rooms = await Bun.file('apps/rooms/static/ImportRooms.json').json()
const want = new Set(process.argv.slice(2))
const byScene = new Map<string, string[]>()
for (const r of rooms as any[])
	for (const s of r.SubRooms ?? [])
		byScene.set(s.UnitySceneId, [...(byScene.get(s.UnitySceneId) ?? []), `${r.Name}/${s.Name}`])
for (const [id, names] of byScene) if (!want.size || want.has(id)) console.log(id, names.join(', '))
EOF
bun run /tmp/scene.ts 380d18b5-de9c-49f3-80f7-f4a95c1de161
# → 380d18b5-… Paintball/Clearcut, PaintballVR/Clearcut, Clearcut/Home
```

With no arguments it dumps every scene, which is how you go the other way — from a room name
to the guid to put in `vs`.

### Shared scenes to watch for

These guids resolve to more than one room, so a challenge naming one also completes in the
others. Most are a deliberate screens/VR/base-room trio, but two are genuine surprises:
**`Soccer/Home` and `Stadium/Home` are the same scene**, so a soccer challenge also completes
in the Stadium, and `Dodgeball` shares its scene with the plain `Gym`.

| Scene id    | Rooms                                                              |
| ----------- | ------------------------------------------------------------------ |
| `6d5eea4b…` | Soccer/Home, **Stadium/Home**                                      |
| `3d474b26…` | Dodgeball/Home, **Gym/Home**, DodgeballVR/Home                     |
| `ae929543…` | Bowling/Home, BowlingAlley/Home                                    |
| `f6f7256c…` | DiscGolfLake/Home, Lake/Home                                       |
| `d9378c9f…` | DiscGolfPropulsion/Home, PropulsionTestRange/Home                  |
| `239e676c…` | LaserTag/Hangar, Hangar/Home                                       |
| `9d6456ce…` | LaserTag/CyberJunkCity, LaserTagCyberJunk/Home, CyberJunkCity/Home |
| `e122fe98…` | Paintball/River, PaintballVR/River, River/Home                     |
| `a785267d…` | Paintball/Homestead, PaintballVR/Homestead, Homestead/Home         |
| `ff4c6427…` | Paintball/Quarry, PaintballVR/Quarry, Quarry/Home                  |
| `380d18b5…` | Paintball/Clearcut, PaintballVR/Clearcut, Clearcut/Home            |
| `58763055…` | Paintball/Spillway, PaintballVR/Spillway, Spillway/Home            |
| `65ddbb48…` | Paintball/Drive-in, PaintballVR/Drive-in, DriveIn/Home             |

Regenerate this list with the script above and no arguments.

## Progress fields (`cc`, `c`) — client-side only

On `updateProgress` the client posts the same tree back with its own progress written into
it: **`cc`** on the counter node is the current count (`…,"t":5,"cc":1`), and **`c`**
(`"c":true`) marks a node it now considers satisfied.

Neither belongs in `weekly-challenge.json` — they are progress, not definition. The server
echoes the posted `Config` back untouched and never persists it (`challenge_status` stores
only the completion flag; see `apps/econ/src/challenge-db.ts`), so the running count lives
only in the client. Don't add `cc`/`c` to an authored tree, and don't try to read progress
out of one.

## Authoring a new challenge

1. Pick the idiom: one-shot (`ct: 0` root, add the `won` predicate if winning is required)
   or counted (`ct: 1` root with `t`).
2. Resolve the scenes with the script above, and check the shared-scene table — decide
   whether the extra rooms it lets in are acceptable.
3. Build the tree as an object, stringify it twice into `Config`.
4. Give the entry a `ChallengeId` unique **within the rotation** (they aren't sequential),
   and write the real goal in `Description` — `Name` is an internal slug that is not
   authoritative (captured id `63` is named `Complete3SpillwayGames` but its `Config` and
   description are Clearcut).
5. Leave `Complete: false`; `getCurrent` stamps it per caller.
6. Bump `ChallengeMapId` if this is a new rotation — ids only need to be unique within one,
   and a new map id is what resets stored completions.
7. Keep `ServerTime` inside `StartAt`…`EndAt`, or the client renders the rotation as expired.

Sanity check the file parses and every tree parses:

```sh
bun -e 'const c=require("./apps/econ/static/weekly-challenge.json");
c.Challenges.forEach(x => JSON.parse(x.Config)); console.log("ok", c.Challenges.length)'
```

Then `bun turbo -F econ test` — `src/test/integration/api.test.ts` imports the file and
asserts `getCurrent` against it.

## Related

- `apps/econ/README.md` — the rest of the weekly-challenge file (top level, `Gift`, progress)
- `.agents/daily-objectives/SKILL.md` — the other objective system, on `GET api/config/v2`
