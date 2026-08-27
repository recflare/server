---
name: weekly-challenge-config
description: Read and author the `Config` rule tree a weekly challenge carries — the full node-type enum, event types, event variables, named scene constants, the shared-scene traps, and where the generator in apps/econ/src/challenge-rotation.ts emits them from
---

# The weekly-challenge `Config` rule tree

Reference for reading and writing the `Config` field of a weekly challenge (served by
`GET /api/challenge/v2/getCurrent`).

**Rotations are generated, so there are two places a tree comes from.** Normally
`apps/econ/src/challenge-rotation.ts` emits it: a week is five (room, kind) pairs drawn from
`CHALLENGE_ROOMS` with the week's seed, and the tree is built by `configFor` from one of the
three idioms below. Adding variety means adding a room or a kind there, not hand-writing a
tree. The other place is `apps/econ/static/weekly-challenge.json`: a non-empty `Challenges`
array in that file PINS the week to a hand-authored rotation and skips generation, which is
how a one-off debug or event week gets served. Both end up as the same `Config` string on
the wire, and everything below applies to both.

**The server never evaluates these rules.** The client reads the tree, watches its own
gameplay, and posts the tree back to `/api/challenge/v2/updateProgress` with its verdict.
So the tree is a _specification handed to the client_, and a malformed one fails silently —
the challenge just never completes. Nothing server-side will tell you.

## Provenance

Two independent sources, and it matters which one a fact came from:

- **`CoffeeMan240/RecRoom.ChallengeLib`** — https://github.com/CoffeeMan240/RecRoom.ChallengeLib,
  a .NET builder library reverse-engineered from the 20200306 client with data types from
  20210813. It names every node type, field and enum below. Facts from it are marked **(lib)**
  and are *names*, not observations: the library is a reimplementation, so a name can be right
  about intent and still diverge from what the 20230414 client this server targets actually
  reads. See "Where the lib and the live data disagree".
- **One captured live rotation** — the shipped `ChallengeMapId: 17`. Facts from it are marked
  **(captured)** and are pinned by data actually served to a real client.

Where both agree the fact is solid. Where only the lib has it, treat the name as a strong
hypothesis and test in-game before shipping a rotation that depends on it.

## `Config` is an escaped JSON string

Not a nested object. In the file it looks like:

```json
"Config": "{\"ct\":0,\"ipc\":false,\"wc\":[...]}"
```

Author the tree as an object and stringify it into the field — don't hand-escape:

```sh
bun -e 'const t={ct:0,ipc:false,wc:[{ct:6,vs:[2]}]}; console.log(JSON.stringify(JSON.stringify(t)))'
```

To read this week's back (the generated rotation, or the pinned file if one is in place):

```sh
bun -e 'const {buildRotation}=await import("./apps/econ/src/challenge-rotation.ts");
for (const x of buildRotation(new Date()).Challenges)
  console.log(x.ChallengeId, x.Description, "\n ", JSON.parse(x.Config))'
```

Pass a date to look at any other week — the rotation is a pure function of which week it is.

## Node types (`ct`) — the full enum

**(lib)** `ChallengeTypes`. Every node carries one. Bold rows are the ones the captured
rotation actually uses.

| `ct` | Name | Kind | Extra fields |
| ---- | ---- | ---- | ------------ |
| **`0`** | `Challenge` | Composite — the plain AND node | `wc`, `rc` |
| **`1`** | `ChallengeCountChallenge` | Composite — count to a target | `ctc`, `t`, + `wc`/`rc` |
| **`2`** | `TimedBufferChallenge` | Composite — count within a rolling window | `ccc`, `t`, `i`, `pm`, `n`, `pb`, `m`, + `wc`/`rc` |
| `3` | `DynamicFloatArithmeticChallenge` | Leaf — compare two float resolvers | `op`, `rA`, `rB` |
| `4` | `DynamicIntArithmeticChallenge` | Leaf — compare two int resolvers | `op`, `rA`, `rB` |
| `5` | `RequiredToolChallenge` | Leaf — **removed** mid-2020; see note | `vs` |
| **`6`** | `RequiredEventTypeChallenge` | Leaf — which gameplay event | `vs` (ChallengeEventTypes) |
| **`7`** | `RequiredRoomSceneLocationChallenge` | Leaf — scene allow-list | `vs` (`[{"l": guid}]`) |
| `8` | `RequiredEnemyTypeChallenge` | Leaf — which enemy | `vs` (EnemyTypes) |
| **`9`** | `BoolVarEqualsChallenge` | Leaf — a bool session var equals | `v`, `vs` |
| `10` | — | **unnamed in the enum**; do not use | — |
| `11` | `DiscGolfFinishUnderParChallenge` | Leaf — no fields at all | — |
| `12` | `RequiredGameModeActivityChallenge` | Leaf — legacy game mode | `vs` (LegacyGameModeType) |
| `13` | `CompleteGameWithoutChallenge` | Macro over `ct:2` | as `ct:2` |
| `14` | `RequiredGestureChallenge` | Leaf — a gesture var (`v: "hg"`) | `v`, `vs` (PlayerGesture) |
| `15` | `HitstreakChallenge` | Macro over `ct:1` | as `ct:1` |
| `16` | `HitstreakCountChallenge` | Macro over `ct:2` | as `ct:2` |

`ct: 5` is obsolete — the lib marks it `LEGACYRequiredToolChallenge`, removed from the game
around mid-late 2020. Post-2020 clients express "used tool X" as a `ct:0` with a
`PickedUpTool` event predicate plus a `ct:4` comparing the `t_t` var. Its value enum
(`SpawnableToolTypes`) **re-rolls every game build**, so any tool-typed challenge is
build-specific.

The macros (`13`, `15`, `16`) serialize as their base type plus preset children — they are
authoring conveniences, not distinct client behavior. But they emit their own `ct`, so the
client must know the id: don't invent macro ids.

## Fields

| Field | Meaning |
| ----- | ------- |
| `ct` | Node type, above. **(lib + captured)** |
| `ipc` | `IgnorePreviousCompletions` **(lib)** — the captured data sets it `false` on every composite. Keep emitting it. |
| `wc` | `WithConditions` — predicates that must **all** hold (AND). **(lib + captured)** |
| `rc` | `ResetConditions` — matching any of these **resets progress to zero**. This is what makes streaks. **(lib)** |
| `ctc` | `ChallengesToCount` — `ct:1`'s children; each match increments toward `t`. **(lib + captured)** |
| `ccc` | `ChallengesToCount` for `ct:2` — same idea, different slot name. **(lib)** |
| `t` | Target count. **(lib + captured)** |
| `vs` | Accepted values, matched as OR. **(lib + captured)** |
| `v` | Var key for `ct:9`/`ct:14`. **(lib + captured)** |
| `in` | `Inclusive` — omitted when false. **(lib)**; the captured `won` predicate omits it. |
| `ex` | `ExcludesIncludesNull` — omitted when false. **(lib)** |
| `i` | `ct:2` window length in seconds, as a **2-dp string** (`"-1.00"`). `-1` = no window. **(lib)** |
| `pm` | `ct:2` progress mode: `0` Complete, `1` Count. **(lib)** |
| `n` | `ct:2` notification counts — milestones the client announces en route to `t`. **(lib)** |
| `pb` | `ct:2` `PersistBuffer` — carry the buffer across games. **(lib)** |
| `m` | `ct:2` count method, omitted when `0`. **(lib)** |
| `op` | `ct:3`/`ct:4` comparison: `0` GT, `1` LT, `2` EQ, `3` GTE, `4` LTE. **(lib)** |
| `rA`, `rB` | `ct:3`/`ct:4` operands, each a num resolver. **(lib)** |
| `cc`, `c` | **Client-side progress — never author these.** See below. **(captured)** |

A num resolver (`rA`/`rB`) is `{"t":0,"c":<const>}` for a constant or `{"t":1,"vk":"<var>"}`
for a session variable. Note `t` means *resolver type* here, not target.

`m` values **(lib)**: `0` Count, `1` UniqueToolCount, `2` UniqueAttackerCount,
`3` UniqueDefenderCount, `4` GroupedToolMaxCount, `5` UniqueGameCount.

## Event types — `ct: 6` `vs` values

**(lib)** `ChallengeEventTypes`. The captured rotation only ever used `2`, which the old
version of this doc guessed was opaque boilerplate. It is not — it is `GameEnd`:

| id | Name | | id | Name |
| -- | ---- | - | -- | ---- |
| `0` | `None` | | `7` | `Score` |
| `1` | `GameStart` | | `8` | `ShieldBlock` |
| **`2`** | **`GameEnd`** | | `9` | `ActivityLoad` |
| `3` | `LocalPlayerEliminated` | | `10` | `FlagCaptured` |
| `4` | `ElminatedOtherPlayer` _(sic)_ | | `11` | `FlagReturned` |
| `5` | `EliminatedAI` | | `12` | `Gesture` |
| `6` | `PickedUpTool` | | `13` | `PlayerJoined` |

`{"ct":6,"vs":[2]}` appears in every captured leaf group because every captured challenge
counts *finished games*, not because the field is fixed. Counting anything else — hits,
scores, revives — means changing this value.

## Session variables (`v`, `vk`)

**(lib)** The vars an event publishes, keyed by the event that carries them.

| Key | Type | On | Meaning |
| --- | ---- | -- | ------- |
| `gid` | string | any game event | Game id |
| `gameMode` | int | any game event | `LegacyGameModeType` |
| `numTeammates` | int | any game event | Size of your team |
| `t_score` | float | any game event | Your team's score |
| `jip` | bool | GameStart | Joined in progress |
| `isSpectator` | bool | GameStart | Spectating |
| `te` | float | GameEnd | Time elapsed |
| **`won`** | bool | GameEnd | Did the player win (used in quests) |
| `ev_score` | float | Score | Current score |
| `e_vid` | int | enemy events | Enemy photon view id |
| `e_t` | int | enemy events | `EnemyTypes` |
| `dp_vid` / `dp_pid` | int | player events | Defender photon view id / RecNet id |
| `ap_vid` / `ap_pid` | int | player events | Attacker photon view id / RecNet id |
| `bodyPart` | int | ElminatedOtherPlayer | `BodyPart`: `-1` None, `0` Head, `1` Torso, `2` LeftHand, `3` RightHand, `4` Mouth |
| `t_vid` / `t_t` | int | tool events | Tool photon view id / `SpawnableToolTypes` |
| `strokeCount` / `par` | int | DiscGolf Score | Strokes taken / hole par |

So the captured `{"ct":9,"vs":[true],"v":"won"}` is `GameEnded.Won` — a quest win.

## Named scene constants — `ct: 7` `vs` values

**(lib)** `RoomSceneLocations`, cross-checked against `apps/rooms/static/ImportRooms.json`.
`ct:7` matches `UnitySceneId`, so **one guid can name several rooms**. Bolded rooms share
their scene — a challenge naming that guid completes in every room listed.

The lib names every scene present in our room data (36 of its 40 resolve; the other four are
marked below), so this table is a complete index in both directions.

| Constant | Scene id | Rooms in `ImportRooms.json` |
| -------- | -------- | --------------------------- |
| `DORM_ROOM` | `76d98498-60a1-430c-ab76-b54a29b7a163` | DormRoom/Home |
| `REC_CENTER` | `cbad71af-0831-44d8-b8ef-69edafa841f6` | RecCenter/Home |
| `LEGACY_CHARADES` | `4078dfed-24bb-4db7-863f-578ba48d726b` | Legacy3DCharades/Home |
| `LAKE` | `f6f7256c-e438-4299-b99e-d20bef8cf7e0` | **DiscGolfLake/Home**, **Lake/Home** |
| `PROPULSION` | `d9378c9f-80bc-46fb-ad1e-1bed8a674f55` | **DiscGolfPropulsion/Home**, **PropulsionTestRange/Home** |
| `DODGEBALL` | `3d474b26-26f7-45e9-9a36-9b02847d5e6f` | **Dodgeball/Home**, **Gym/Home**, **DodgeballVR/Home** |
| `THE_LOUNGE` | `a067557f-ca32-43e6-b6e5-daaec60b4f5a` | Lounge/Home |
| `PADDLEBALL` | `d89f74fa-d51e-477a-a425-025a891dd499` | Paddleball/Home |
| `RIVER` | `e122fe98-e7db-49e8-a1b1-105424b6e1f0` | **Paintball/River**, **PaintballVR/River**, **River/Home** |
| `HOMESTEAD` | `a785267d-c579-42ea-be43-fec1992d1ca7` | **Paintball/Homestead**, **PaintballVR/Homestead**, **Homestead/Home** |
| `QUARRY` | `ff4c6427-7079-4f59-b22a-69b089420827` | **Paintball/Quarry**, **PaintballVR/Quarry**, **Quarry/Home** |
| `CLEAR_CUT` | `380d18b5-de9c-49f3-80f7-f4a95c1de161` | **Paintball/Clearcut**, **PaintballVR/Clearcut**, **Clearcut/Home** |
| `SPILLWAY` | `58763055-2dfb-4814-80b8-16fac5c85709` | **Paintball/Spillway**, **PaintballVR/Spillway**, **Spillway/Home** |
| `QUEST_FOR_THE_GOLDEN_TROPHY` | `91e16e35-f48f-4700-ab8a-a1b79e50e51b` | GoldenTrophy/Home |
| `ORIENTATION` | `c79709d8-a31b-48aa-9eb8-cc31ba9505e8` | Orientation/Home |
| `THE_RISE_OF_JUMBOTRON` | `acc06e66-c2d0-4361-b0cd-46246a4c455c` | TheRiseofJumbotron/Home |
| `CURSE_OF_THE_CRIMSON_CAULDRON` | `949fa41f-4347-45c0-b7ac-489129174045` | CrimsonCauldron/Home |
| `THE_ISLE_OF_LOST_SKULLS` | `7e01cfe0-820a-406f-b1b3-0a5bf575235c` | IsleOfLostSkulls/Home |
| `SOCCER` | `6d5eea4b-f069-4ed0-9916-0e2f07df0d03` | **Soccer/Home**, **Stadium/Home** |
| `PERFORMANCE_HALL` | `9932f88f-3929-43a0-a012-a40b5128e346` | PerformanceHall/Home |
| `PSVR_ROOM_CALIBRATION` | `f5fbd9c9-e853-4036-9d48-5f68e861af04` | _not in ImportRooms.json_ |
| `PARK` | `0a864c86-5a71-4e18-8041-8124e4dc9d98` | Park/Home |
| `WAREHOUSE` | `239e676c-f12f-489f-bf3a-d4c383d692c3` | **LaserTag/Hangar**, **Hangar/Home** |
| `CYBERJUNK_CITY` | `9d6456ce-6264-48b4-808d-2d96b3d91038` | **LaserTag/CyberJunkCity**, **LaserTagCyberJunk/Home**, **CyberJunkCity/Home** |
| `MAKER_ROOM` | `a75f7547-79eb-47c6-8986-6767abcb4f92` | MakerRoom/Home |
| `FRONTIER_SOLOS` | `b010171f-4875-4e89-baba-61e878cd41e1` | RecRoyaleSolos/Home |
| `FRONTIER_SQUADS` | `253fa009-6e65-4c90-91a1-7137a56a267f` | RecRoyaleSquads/Home |
| `CRESCENDO_OF_THE_BLOOD_MOON` | `49cb8993-a956-43e2-86f4-1318f279b22a` | Crescendo/Home |
| `BOWLING_ALLEY` | `ae929543-9a07-41d5-8ee9-dbbee8c36800` | **Bowling/Home**, **BowlingAlley/Home** |
| `ANIMATION_RECORDING_STUDIO` | `a95c349c-0f96-4c2d-a4c8-4969ffa8ea44` | _not in ImportRooms.json_ |
| `STUNTRUNNER` | `b7281665-a715-4051-826b-8e08e69c6172` | StuntRunner/StuntRunner |
| `STUNTRUNNER_THE_MAIN_EVENT` | `3a636bd2-f896-424c-9225-c184522c0d87` | StuntRunner/TheMainEvent |
| `STUNTRUNNER_BASE_ROOM` | `882e9b96-7115-4b03-86f6-c0c9d8e22e00` | StuntRunnerBaseRoom/Home |
| `REGISTRATION` | `cf61556d-68fd-4288-9ae5-7a512621e569` | Registration/Home |
| `AR_ROOM` | `bf268f5f-b55b-41af-8628-32fa4b5d70b6` | ARRoom/Home |
| `DRIVEIN` | `65ddbb48-5a01-4e3e-972d-e5c7419e2bc3` | **Paintball/Drive-in**, **PaintballVR/Drive-in**, **DriveIn/Home** |
| `CHARADES_THE_INK_SPACE` | `a673712c-877f-4749-b69a-4a4c6310d545` | 3DCharades/InkSpaceHome |
| `THE_INK_SPACE_BASE_ROOM` | `1fa06e3c-c307-4c11-a91b-1fabcddb8a96` | TheInkSpace/Home |
| `FRONTIER_UGC` | `a16bfd31-ffb9-46ac-a199-362c163130c0` | _not in ImportRooms.json_ |

The lib also defines `INVALID`, which serializes as `Guid.Empty` and is not a real scene.

Two shared scenes are genuine surprises rather than a deliberate screens/VR/base-room trio:
**`Soccer/Home` and `Stadium/Home` are the same scene**, and **`Dodgeball` shares its scene
with the plain `Gym`**. Decide whether the extra rooms are acceptable before shipping.

Regenerate the room column from the repo root:

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

With no arguments it dumps every scene, which is how you go the other way.

## The idioms

### One-shot quest **(captured)**

No `t` — one qualifying session is the whole goal.

```jsonc
// "Complete ^TheRiseOfJumbotron quest"
{ "ct": 0, "ipc": false, "wc": [
  { "ct": 6, "vs": [2] },                      // GameEnd
  { "ct": 9, "vs": [true], "v": "won" },       // …and won
  { "ct": 7, "vs": [{ "l": "acc06e66-…" }] }   // THE_RISE_OF_JUMBOTRON
]}
```

### Counted sessions **(captured)**

No `won` predicate — finishing counts, winning is irrelevant. A "one map only" challenge is
this with a single-entry scene list.

```jsonc
// "Complete 5 Charades games"
{ "ct": 1, "ipc": false, "ctc": [
  { "ct": 0, "ipc": false, "wc": [
    { "ct": 6, "vs": [2] },
    { "ct": 7, "vs": [{ "l": "a673712c-…" }, { "l": "4078dfed-…" }] }  // both Charades scenes
  ]}
], "t": 5 }
```

### Streaks and buffers **(lib)**

`rc` resets the count, which is how "N in a row without dying" is expressed. Wrapping that
in a `ct:2` counts how many streaks you land:

```jsonc
// "Get 20 three-kill streaks in the Golden Trophy quest", announced at 5/10/15
{ "ct": 2, "ipc": false,
  "wc":  [{ "ct": 7, "ipc": false, "vs": [{ "l": "91e16e35-…" }] }],  // GOLDEN_TROPHY
  "ccc": [{ "ct": 1, "ipc": false, "t": 3,
            "ctc": [{ "ct": 6, "ipc": false, "vs": [5] }],   // EliminatedAI
            "rc":  [{ "ct": 6, "ipc": false, "vs": [3] }] }],// …reset on your own death
  "i": "-1.00",        // no time window
  "t": 20, "pm": 1,    // count mode, target 20
  "n": [5, 10, 15],    // milestone notifications
  "pb": true }         // buffer survives across games
```

`pm: 1` (Count) is what makes `t` a tally; `pm: 0` (Complete) treats the buffer as a
one-shot. `i: "-1.00"` disables the time window — a positive value makes it "N within
X seconds".

## Progress fields (`cc`, `c`) — client-side only

On `updateProgress` the client posts the same tree back with its own progress written into
it: **`cc`** on a counter is the current count (`…,"t":5,"cc":1`), and **`c`** (`"c":true`)
marks a node it now considers satisfied.

Neither belongs in an authored tree — they are progress, not definition. The server
stores the posted tree per player (`challenge_status.config`; see
`apps/econ/src/challenge-db.ts`) and `getCurrent` serves it back in place of the authored
tree, which is how a half-finished challenge survives a session — but it still evaluates
none of it: the counting is the client's. Don't author `cc`/`c`, and don't try to read
progress out of the tree you author.

This is also the cheapest way to decode an unfamiliar tree: serve it, play the activity, and
watch which node grows a `cc`.

## Where the lib and the live data disagree

The library is a 2020/2021 reimplementation, not the 20230414 client. Known divergences,
all worth checking before trusting a lib-only field:

- **`BoolVarEqualsChallenge` and `RequiredGestureChallenge` serialize `ct: 0` in the lib.**
  `RequiredObjectChallenge` declares `ChallengeType` as a getter-only auto-property with no
  initializer and the `VarEquals` subclasses never override it, so it defaults to `0`. The
  captured rotation proves the real value is `9` for the `won` predicate. Don't take a
  lib-generated `ct` for those two at face value.
- **`in` is emitted where the captured data omits it.** `BoolVarEqualsChallenge`'s
  constructor forces `Inclusive = true`, so the lib would write
  `{"ct":9,"in":true,"vs":[true],"v":"won"}` where the live rotation sent no `in`.
- **`ipc` is written twice when true** — `ChallengeBase.Serialize` adds it, then
  `Challenge.Serialize` adds it again, which throws on the duplicate dictionary key. The lib
  only works with `IgnorePreviousCompletions = false`, which is all the captured data uses.
- **`ChallengeCountChallengeBuilder.ResetCondition` adds the node to itself** — its parameter
  shadows the `challenge` field. Set `ResetConditions` directly instead.
- **`SpawnableToolTypes` re-rolls per build**, so `ct:5` and any `t_t` comparison is pinned
  to one client version.

## Adding to the generator

This is the usual way a new challenge ships: the week picks from `CHALLENGE_ROOMS` in
`apps/econ/src/challenge-rotation.ts`, so a room added there starts appearing in rotations
on its own.

1. **A new room** — add an entry with its `UnitySceneId`(s) from
   `apps/rooms/static/ImportRooms.json`. A scene no room on this server hosts can never be
   completed and nothing will tell you. Check the shared-scene table above and record the
   extra rooms in `shares`. Set `kinds` conservatively: `win` reads the `won` variable, so
   only rooms where winning is a real outcome; `ai` is quests. **Append, never insert** —
   `ChallengeId` is the candidate's index, so inserting renumbers every challenge after it.
2. **A new kind** — add it to `ChallengeKind` and give it a branch in all three of
   `configFor` (the tree), `copyFor` (the strings) and `nameFor` (the slug). The compiler
   will point at the two you forget. Build the tree from an idiom below; the copy is
   generated from the same inputs so it can't drift out of step with the tree.
3. Keep the target constants (`GAMES_TARGET`, `AI_TARGET`) as the single source for both the
   tree and the copy.

## Authoring a pinned rotation

For a one-off week: put challenges in `apps/econ/static/weekly-challenge.json` and the file
takes over completely — generation is skipped, and its `Gift`, window and `ChallengeMapId`
are served as written.

1. Pick the idiom: one-shot (`ct:0` root, add the `won` predicate if winning is required),
   counted (`ct:1` root with `t`), or buffered/streak (`ct:2` root, `rc` on the child).
2. Resolve the scenes from the table above, and check the bolded shared rooms — decide
   whether the extra rooms it lets in are acceptable.
3. Pick the right event type for `ct:6` — `2` (GameEnd) only if you really are counting
   finished games.
4. Build the tree as an object, stringify it twice into `Config`.
5. Give the entry a `ChallengeId` unique **within the rotation** (they aren't sequential),
   and write the real goal in `Description` — `Name` is an internal slug that is not
   authoritative (captured id `63` is named `Complete3SpillwayGames` but its `Config` and
   description are Clearcut). **Keep `Description`/`Tooltip` in step with `Config`:** the
   client renders the strings and evaluates the tree independently, so a mismatch ships a
   challenge that advances somewhere the text never mentions.
6. Leave `Complete: false`; `getCurrent` stamps it per caller.
7. Set a `ChallengeMapId` that no recent week has used — a new map id is what resets stored
   completions, and generated weeks are `1000 + weekIndex`, so stay well clear of that range.
8. Keep `ServerTime` inside `StartAt`…`EndAt`, or the client renders the rotation as expired.
   A pinned file is static, so its clock has to be frozen there; a generated week doesn't,
   because its window is really the current one.

Sanity check that every tree in this week's rotation parses, pinned or generated:

```sh
bun -e 'const {buildRotation}=await import("./apps/econ/src/challenge-rotation.ts");
const c=buildRotation(new Date());
c.Challenges.forEach(x => JSON.parse(x.Config)); console.log("ok", c.ChallengeMapId, c.Challenges.length)'
```

Then `bun vitest run apps/econ` — `src/test/integration/api.test.ts` builds the same rotation
and asserts `getCurrent` against it, and walks two years of generated weeks checking every
tree. Note the gift threshold follows the rotation size (`CHALLENGES_REQUIRED_FOR_GIFT`
clamps to what you publish), so a pinned rotation of three or fewer asks for all of them.

## Credits

The node-type, event-type, field, variable and scene-constant tables above are derived from
**[CoffeeMan240/RecRoom.ChallengeLib](https://github.com/CoffeeMan240/RecRoom.ChallengeLib)**,
a .NET challenge-builder library that reverse-engineered this format from the 20200306 client
(data types from 20210813). Without it the `ct` values were opaque integers. Thanks to
CoffeeMan240 for publishing it.

## Related

- `apps/econ/README.md` — the rest of the weekly-challenge file (top level, `Gift`, progress)
- `.agents/skills/daily-objectives-config/SKILL.md` — the other objective system, on
  `GET api/config/v2`. Different grammar entirely: a flat `{type, score}` enum, not a tree.
