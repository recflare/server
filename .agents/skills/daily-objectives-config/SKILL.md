---
name: daily-objectives
description: Guide for parsing/writing daily objectives in /api/config/v2
---

# Daily objectives — config shape and the full type enum

Reference for authoring `dailyObjectives` in `GET /api/config/v2`. Extracted from the 20230414
client (`GameAssembly.dll` mtime 2026-07-23). See `SHAPES.md` for the method used.

> **This table survives game upgrades.** Enum *member names and values* are not obfuscated — only
> type and method names re-roll per build. So the ids below stay valid across client versions unless
> Rec Room adds or removes members. The obfuscated names in this file (`PNLFAAAPEID`,
> `LCPOOJEAMJA`, …) are the only part that will go stale.

## Where it lives

`GET api/config/v2` (service `API`) → `JAGPNOHGHBG.DownloadConfigSettings`, deserialized as a bare
`LCPOOJEAMJA` via `SendWithRequiredResponseAsync` — response required, no envelope.

Top-level keys, in declaration order (all accept three casings):

| Wire name | Type |
| --- | --- |
| `levelProgressionMaps` | array of objects |
| **`dailyObjectives`** | **jagged array** — `FCAOHDFPEAP[][]` |
| `serverMaintenance` | object |
| `autoMicMutingConfig` | object |econ
| `storefrontConfig` | object |
| `roomKeyConfig` | object |
| `roomCurrencyConfig` | object |
| `shareBaseUrl` | string |

A `Dictionary<int,int>` declared first on the type carries `[IgnoreDataMember]` — client-only, never
on the wire.

## `dailyObjectives` shape

Array of arrays. Each leaf element (`FCAOHDFPEAP`, formatter `BMBOPLBKALL`) has exactly two members:

| Wire name | Type |
| --- | --- |
| `type` | int — a value from the table below |
| `score` | int — the target / threshold |

```json
{
  "dailyObjectives": [
    [ { "type": 1,   "score": 1 },
      { "type": 6,   "score": 5 },
      { "type": 31,  "score": 3 } ],
    [ { "type": 2,   "score": 1 },
      { "type": 65,  "score": 2 },
      { "type": 300, "score": 1 } ]
  ]
}
```

**Unverified:** what the outer dimension indexes. The `updateobjective` DTO carries both `index` and
`group`, which lines up with `dailyObjectives[group][index]`, and `DailyObjective1/2/3` existing as
distinct types suggests three slots per set — but neither is confirmed against the consumer. Serve a
distinctive jagged array and watch the `group`/`index` pairs your endpoint receives.

## Numbering scheme

The ids are blocked, which tells you where new entries belong:

| Range | Meaning | Count |
| --- | --- | --- |
| `-1` – `15` | meta / rollup / social | 16 |
| `20` – `26` | onboarding (OOBE, NUX) | 5 |
| `30` – `75` | general engagement | 45 |
| `100`+ | per-activity, one block each | 67 |

Activity blocks follow a `Games` / `Wins` / `<activity-specific>` pattern. Quest (`1000`) additionally
sub-blocks by scenario in steps of 10.

**Careful with `10`–`15`.** `DailyObjective1/2/3`, `AllDailyObjectives`, `CompleteAnyDaily` and
`CompleteAnyWeekly` read as *rollup* types the reward system uses to track "you finished daily #1",
not as objective definitions themselves. Using them as leaf `type` values in `dailyObjectives` is
probably not what you want. (Inference from naming — not traced.)

## Full enum — `PNLFAAAPEID`, 133 values

| id | name |
| --- | --- |
| -1 | Default |
| 1 | FirstSessionOfDay |
| 2 | AddAFriend |
| 3 | PartyUp |
| 4 | AllOtherChallenges |
| 5 | LevelUp |
| 6 | CheerAPlayer |
| 7 | PointedAtPlayer |
| 8 | CheerARoom |
| 9 | SubscribeToPlayer |
| 10 | DailyObjective1 |
| 11 | DailyObjective2 |
| 12 | DailyObjective3 |
| 13 | AllDailyObjectives |
| 14 | CompleteAnyDaily |
| 15 | CompleteAnyWeekly |
| 20 | OOBE_GoToLockerRoom |
| 21 | OOBE_GoToActivity |
| 22 | OOBE_FinishActivity |
| 25 | NUX_PunchcardObjective |
| 26 | NUX_AllPunchcardObjectives |
| 30 | GoToRecCenter |
| 31 | FinishActivity |
| 32 | VisitACustomRoom |
| 33 | CreateACustomRoom |
| 35 | ScoreBasketInRecCenter |
| 36 | UploadPhotoToRecNet |
| 37 | UpdatePlayerBio |
| 38 | SaveOutfitSlot |
| 39 | PurchaseClothingItem |
| 40 | PurchaseNonClothingItem |
| 41 | DrinkWater |
| 42 | ColorOnWhiteboard |
| 43 | SetBasketballSkin |
| 44 | ThrowBasketball |
| 45 | PlaceInventionInDorm |
| 46 | ChangeDormRoomSkin |
| 47 | ToggleOwnedClothes |
| 48 | EquipHat |
| 49 | LoadOutfit |
| 50 | SaveNewOutfitSlot |
| 51 | SpawnCamera |
| 52 | TakeSelfie |
| 53 | PrintSelfie |
| 54 | TakePictureOfPlayer |
| 55 | PrintPictureOfPlayer |
| 56 | PublishSelfieWithPlayer |
| 57 | SpawnFoodWithOtherPlayers |
| 58 | EmoteInRecCenter |
| 59 | SendRoomChatInRecCenter |
| 60 | UseFrendotron |
| 61 | GoToDormRoom |
| 62 | VisitSpecificRoom |
| 63 | VisitPublicRRO |
| 64 | VisitPublicRoomBySource |
| 65 | FavoriteARoom |
| 66 | TakePhotoWithFilter |
| 67 | OpenYourPlayerProfile |
| 68 | OpenOnlineStatusModal |
| 69 | ChangeProfilePicture |
| 70 | ChangePlayerDisplayName |
| 71 | ChangePlayerDescriptionText |
| 72 | OpenPlayerPronounsModal |
| 73 | OpenOtherPlayersProfile |
| 74 | VisitPlayersPortfolio |
| 75 | FavoriteAFriend |
| 100 | CharadesGames |
| 101 | CharadesWinsPerformer |
| 102 | CharadesWinsGuesser |
| 200 | DiscGolfWins |
| 201 | DiscGolfGames |
| 202 | DiscGolfHolesUnderPar |
| 300 | DodgeballWins |
| 301 | DodgeballGames |
| 302 | DodgeballHits |
| 400 | PaddleballGames |
| 401 | PaddleballWins |
| 402 | PaddleballScores |
| 500 | PaintballAnyModeGames |
| 501 | PaintballAnyModeWins |
| 502 | PaintballAnyModeHits |
| 600 | PaintballCTFWins |
| 601 | PaintballCTFGames |
| 602 | PaintballCTFHits |
| 603 | PaintballFlagCaptures |
| 700 | PaintballTeamBattleWins |
| 701 | PaintballTeamBattleGames |
| 702 | PaintballTeamBattleHits |
| 710 | PaintballFreeForAllWins |
| 711 | PaintballFreeForAllGames |
| 712 | PaintballFreeForAllHits |
| 800 | SoccerWins |
| 801 | SoccerGames |
| 802 | SoccerGoals |
| 900 | BowlingGames |
| 901 | BowlingWins |
| 902 | BowlingStrike |
| 1000 | QuestGames |
| 1001 | QuestWins |
| 1002 | QuestPlayerRevives |
| 1003 | QuestEnemyKills |
| 1010 | QuestGames_Goblin1 |
| 1011 | QuestWins_Goblin1 |
| 1012 | QuestPlayerRevives_Goblin1 |
| 1013 | QuestEnemyKills_Goblin1 |
| 1020 | QuestGames_Goblin2 |
| 1021 | QuestWins_Goblin2 |
| 1022 | QuestPlayerRevives_Goblin2 |
| 1023 | QuestEnemyKills_Goblin2 |
| 1030 | QuestGames_Scifi1 |
| 1031 | QuestWins_Scifi1 |
| 1032 | QuestPlayerRevives_Scifi1 |
| 1033 | QuestEnemyKills_Scifi1 |
| 1040 | QuestGames_Pirate1 |
| 1041 | QuestWins_Pirate1 |
| 1042 | QuestPlayerRevives_Pirate1 |
| 1043 | QuestEnemyKills_Pirate1 |
| 1050 | QuestGames_Dracula1 |
| 1051 | QuestWins_Dracula1 |
| 1052 | QuestPlayerRevives_Dracula1 |
| 1053 | QuestEnemyKills_Dracula1 |
| 2000 | ArenaGames |
| 2001 | ArenaWins |
| 2002 | ArenaPlayerRevives |
| 2003 | ArenaHeroTags |
| 2004 | ArenaBotTags |
| 3000 | RecRoyaleGames |
| 3001 | RecRoyaleWins |
| 3002 | RecRoyaleTags |
| 4000 | StuntRunnerGames |
| 4001 | StuntRunnerWins |
| 5000 | RecRallyGames |
| 5001 | RecRallyWins |

## Machine-readable

```json
{"Default":-1,"FirstSessionOfDay":1,"AddAFriend":2,"PartyUp":3,"AllOtherChallenges":4,"LevelUp":5,"CheerAPlayer":6,"PointedAtPlayer":7,"CheerARoom":8,"SubscribeToPlayer":9,"DailyObjective1":10,"DailyObjective2":11,"DailyObjective3":12,"AllDailyObjectives":13,"CompleteAnyDaily":14,"CompleteAnyWeekly":15,"OOBE_GoToLockerRoom":20,"OOBE_GoToActivity":21,"OOBE_FinishActivity":22,"NUX_PunchcardObjective":25,"NUX_AllPunchcardObjectives":26,"GoToRecCenter":30,"FinishActivity":31,"VisitACustomRoom":32,"CreateACustomRoom":33,"ScoreBasketInRecCenter":35,"UploadPhotoToRecNet":36,"UpdatePlayerBio":37,"SaveOutfitSlot":38,"PurchaseClothingItem":39,"PurchaseNonClothingItem":40,"DrinkWater":41,"ColorOnWhiteboard":42,"SetBasketballSkin":43,"ThrowBasketball":44,"PlaceInventionInDorm":45,"ChangeDormRoomSkin":46,"ToggleOwnedClothes":47,"EquipHat":48,"LoadOutfit":49,"SaveNewOutfitSlot":50,"SpawnCamera":51,"TakeSelfie":52,"PrintSelfie":53,"TakePictureOfPlayer":54,"PrintPictureOfPlayer":55,"PublishSelfieWithPlayer":56,"SpawnFoodWithOtherPlayers":57,"EmoteInRecCenter":58,"SendRoomChatInRecCenter":59,"UseFrendotron":60,"GoToDormRoom":61,"VisitSpecificRoom":62,"VisitPublicRRO":63,"VisitPublicRoomBySource":64,"FavoriteARoom":65,"TakePhotoWithFilter":66,"OpenYourPlayerProfile":67,"OpenOnlineStatusModal":68,"ChangeProfilePicture":69,"ChangePlayerDisplayName":70,"ChangePlayerDescriptionText":71,"OpenPlayerPronounsModal":72,"OpenOtherPlayersProfile":73,"VisitPlayersPortfolio":74,"FavoriteAFriend":75,"CharadesGames":100,"CharadesWinsPerformer":101,"CharadesWinsGuesser":102,"DiscGolfWins":200,"DiscGolfGames":201,"DiscGolfHolesUnderPar":202,"DodgeballWins":300,"DodgeballGames":301,"DodgeballHits":302,"PaddleballGames":400,"PaddleballWins":401,"PaddleballScores":402,"PaintballAnyModeGames":500,"PaintballAnyModeWins":501,"PaintballAnyModeHits":502,"PaintballCTFWins":600,"PaintballCTFGames":601,"PaintballCTFHits":602,"PaintballFlagCaptures":603,"PaintballTeamBattleWins":700,"PaintballTeamBattleGames":701,"PaintballTeamBattleHits":702,"PaintballFreeForAllWins":710,"PaintballFreeForAllGames":711,"PaintballFreeForAllHits":712,"SoccerWins":800,"SoccerGames":801,"SoccerGoals":802,"BowlingGames":900,"BowlingWins":901,"BowlingStrike":902,"QuestGames":1000,"QuestWins":1001,"QuestPlayerRevives":1002,"QuestEnemyKills":1003,"QuestGames_Goblin1":1010,"QuestWins_Goblin1":1011,"QuestPlayerRevives_Goblin1":1012,"QuestEnemyKills_Goblin1":1013,"QuestGames_Goblin2":1020,"QuestWins_Goblin2":1021,"QuestPlayerRevives_Goblin2":1022,"QuestEnemyKills_Goblin2":1023,"QuestGames_Scifi1":1030,"QuestWins_Scifi1":1031,"QuestPlayerRevives_Scifi1":1032,"QuestEnemyKills_Scifi1":1033,"QuestGames_Pirate1":1040,"QuestWins_Pirate1":1041,"QuestPlayerRevives_Pirate1":1042,"QuestEnemyKills_Pirate1":1043,"QuestGames_Dracula1":1050,"QuestWins_Dracula1":1051,"QuestPlayerRevives_Dracula1":1052,"QuestEnemyKills_Dracula1":1053,"ArenaGames":2000,"ArenaWins":2001,"ArenaPlayerRevives":2002,"ArenaHeroTags":2003,"ArenaBotTags":2004,"RecRoyaleGames":3000,"RecRoyaleWins":3001,"RecRoyaleTags":3002,"StuntRunnerGames":4000,"StuntRunnerWins":4001,"RecRallyGames":5000,"RecRallyWins":5001}
```

## Related endpoints

| Endpoint | Purpose |
| --- | --- |
| `GET api/config/v2` | serves `dailyObjectives` (this file) |
| `GET api/objectives/v1/myprogress` | player's current progress |
| `POST api/objectives/v1/updateobjective` | one objective update — `{index, group, progress, visualProgress, isCompleted, hasClaimedReward}` → `{group, isCompleted, clearedAt}` |
| `POST api/objectives/v1/completegroup` | group completion |
| `POST api/objectives/v1/cleargroup` | group reset |

The objectives endpoints are on the **Econ** service (`econ.*`); config is on **API** (`api.*`).

## How this was extracted

```sh
# in the il2cpp scratchpad, with Il2CppDumper output in ./out/
grep -n "enum PNLFAAAPEID" out/dump.cs      # find the block
# then parse `public const PNLFAAAPEID <name> = <value>;` lines until the closing brace
```

The `dailyObjectives` wire name came from the Utf8Json formatter, not the property name — see
`SHAPES.md` §1. Formatter `.ctor` RVAs for this build: `LCPOOJEAMJA` → `0x3512E10`,
`FCAOHDFPEAP` → `0x34EE5F0`.
