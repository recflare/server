/**
 * The weekly challenge rotation, generated from the calendar week rather than authored.
 *
 * A week's rotation is a pure function of which week it is: the same five challenges, the
 * same window and the same gift for every player, recomputed identically by every isolate
 * and every request. That is not a nicety — `challenge_status` rows are scoped by
 * `ChallengeMapId` and the gift threshold counts completions against `Challenges`, so two
 * callers who disagreed about what this week holds would disagree about who has finished it.
 * Everything here therefore hangs off {@link rotationIndex} and a seeded PRNG; nothing calls
 * `Math.random()` or reads the clock except to work out which week it is.
 *
 * The client evaluates the rule trees and the server never does (see
 * .agents/skills/weekly-challenge-config/SKILL.md), so a generated tree is a specification
 * handed to a client that fails SILENTLY when it's malformed. Everything emitted here is
 * therefore built from the three idioms that are pinned by captured live data or by a
 * rotation this server has already served — no lib-only node types, no invented fields.
 *
 * `static/weekly-challenge.json` still ships, and still wins: a non-empty `Challenges` array
 * there PINS the week to that hand-authored rotation and skips generation entirely, which is
 * how a debug or event rotation gets served without a code change. When it is empty the file
 * supplies only the parts generation doesn't own — the fallback gift name, the theme string,
 * and `CompletedRequired`.
 */

import weeklyChallenge from '../static/weekly-challenge.json'

/** Rec Room's weekly reset: Wednesday 21:00 UTC, the boundary both captured rotations sit on. */
const ROTATION_EPOCH_MS = Date.UTC(2020, 0, 1, 21, 0, 0)
const WEEK_MS = 7 * 24 * 60 * 60 * 1000

/**
 * Where generated `ChallengeMapId`s start. Hand-authored rotations have used small ids (the
 * captured 17, this repo's 19), and a generated id that collided with one would let a
 * player's stored rows from that rotation read as progress against a completely different
 * set of challenges. A four-digit floor keeps the two id spaces from ever meeting.
 */
const CHALLENGE_MAP_ID_BASE = 1000

/** How many challenges a week publishes. Five is the captured rotation's size, and what the three-of-five gift threshold is written against. */
const CHALLENGES_PER_ROTATION = 5

/**
 * How many challenges of one kind a week may hold. Five slots over three kinds with a cap of
 * two guarantees every kind appears, so no week is five variations of "finish some games".
 */
const MAX_PER_KIND = 2

/** `ct:6` event ids — `ChallengeEventTypes`. Only the two the captured/served trees use. */
const EVENT_GAME_END = 2
const EVENT_ELIMINATED_AI = 5

/** The targets each kind counts to. Fixed rather than rolled: a week should vary in WHAT it asks, not in how much. */
const GAMES_TARGET = 5
const AI_TARGET = 10

/** What a challenge asks for. Each maps to one proven `Config` idiom and one line of copy. */
type ChallengeKind = 'games' | 'win' | 'ai'

/**
 * A room the generator may name, keyed by the scene(s) its games run in.
 *
 * `scenes` is what `ct:7` matches, and one scene can belong to several rooms (Soccer and
 * Stadium are one scene; Dodgeball, Gym and DodgeballVR are another) — `shares` records the
 * rooms a challenge naming this one also completes in, which is a property of the game data,
 * not something the tree can narrow. Entries are one per scene, so picking by room key also
 * keeps a week from naming one scene twice.
 *
 * `link` is the `^Token` the client resolves into a tappable room name; `null` where the room
 * name would make a doubtful token (Charades spans two scenes and starts with a digit) and
 * the copy falls back to plain text, which the captured rotation also does.
 */
interface ChallengeRoom {
	/** Stable key — also the slug fragment in a generated `Name`. */
	key: string
	/** Plain display name, used when `link` is null. */
	name: string
	/** The `^Token` room link, or null to write the name plainly. */
	link: string | null
	/** `UnitySceneId`s this room's games run in, straight from apps/rooms/static/ImportRooms.json. */
	scenes: string[]
	/** The kinds this room can be asked for — quests have enemies to defeat, hangouts have no games at all. */
	kinds: ChallengeKind[]
	/** True for the quest rooms, whose "win" is completing the quest rather than beating other players. */
	quest?: boolean
	/** Other rooms on the same scene, which a challenge naming this one also completes in. */
	shares?: string
}

/**
 * The rooms in play. Every scene id here resolves in `apps/rooms/static/ImportRooms.json` —
 * a challenge naming a scene this server hosts no room for can never be completed by anyone,
 * and nothing server-side would report that.
 *
 * `kinds` is deliberately conservative. `win` reads the `won` session variable, which is
 * pinned by the captured rotation for quests and is meaningful in a head-to-head game, so
 * rooms where "winning" is vague (bowling, disc golf, charades, Stunt Runner) only ever ask
 * for completed games. `ai` is quests only: they are the rooms with enemies in them.
 */
const CHALLENGE_ROOMS: ChallengeRoom[] = [
	// Quests — win the quest, or thin out its enemies.
	{
		key: 'GoldenTrophy',
		name: 'Quest for the Golden Trophy',
		link: '^GoldenTrophy',
		scenes: ['91e16e35-f48f-4700-ab8a-a1b79e50e51b'],
		kinds: ['win', 'ai'],
		quest: true,
	},
	{
		key: 'Jumbotron',
		name: 'The Rise of Jumbotron',
		link: '^TheRiseofJumbotron',
		scenes: ['acc06e66-c2d0-4361-b0cd-46246a4c455c'],
		kinds: ['win', 'ai'],
		quest: true,
	},
	{
		key: 'CrimsonCauldron',
		name: 'Curse of the Crimson Cauldron',
		link: '^CrimsonCauldron',
		scenes: ['949fa41f-4347-45c0-b7ac-489129174045'],
		kinds: ['win', 'ai'],
		quest: true,
	},
	{
		key: 'IsleOfLostSkulls',
		name: 'The Isle of Lost Skulls',
		link: '^IsleOfLostSkulls',
		scenes: ['7e01cfe0-820a-406f-b1b3-0a5bf575235c'],
		kinds: ['win', 'ai'],
		quest: true,
	},
	{
		key: 'Crescendo',
		name: 'Crescendo of the Blood Moon',
		link: '^Crescendo',
		scenes: ['49cb8993-a956-43e2-86f4-1318f279b22a'],
		kinds: ['win', 'ai'],
		quest: true,
	},

	// Head-to-head rooms — finish games, or win one.
	{
		key: 'Clearcut',
		name: 'Paintball: Clear Cut',
		link: '^Paintball.Clearcut',
		scenes: ['380d18b5-de9c-49f3-80f7-f4a95c1de161'],
		kinds: ['games', 'win'],
		shares: 'PaintballVR/Clearcut, Clearcut/Home',
	},
	{
		key: 'River',
		name: 'Paintball: River',
		link: '^Paintball.River',
		scenes: ['e122fe98-e7db-49e8-a1b1-105424b6e1f0'],
		kinds: ['games', 'win'],
		shares: 'PaintballVR/River, River/Home',
	},
	{
		key: 'Homestead',
		name: 'Paintball: Homestead',
		link: '^Paintball.Homestead',
		scenes: ['a785267d-c579-42ea-be43-fec1992d1ca7'],
		kinds: ['games', 'win'],
		shares: 'PaintballVR/Homestead, Homestead/Home',
	},
	{
		key: 'Quarry',
		name: 'Paintball: Quarry',
		link: '^Paintball.Quarry',
		scenes: ['ff4c6427-7079-4f59-b22a-69b089420827'],
		kinds: ['games', 'win'],
		shares: 'PaintballVR/Quarry, Quarry/Home',
	},
	{
		key: 'Spillway',
		name: 'Paintball: Spillway',
		link: '^Paintball.Spillway',
		scenes: ['58763055-2dfb-4814-80b8-16fac5c85709'],
		kinds: ['games', 'win'],
		shares: 'PaintballVR/Spillway, Spillway/Home',
	},
	{
		key: 'Dodgeball',
		name: 'Dodgeball',
		link: '^Dodgeball',
		scenes: ['3d474b26-26f7-45e9-9a36-9b02847d5e6f'],
		kinds: ['games', 'win'],
		shares: 'Gym/Home, DodgeballVR/Home',
	},
	{
		key: 'Soccer',
		name: 'Soccer',
		link: '^Soccer',
		scenes: ['6d5eea4b-f069-4ed0-9916-0e2f07df0d03'],
		kinds: ['games', 'win'],
		shares: 'Stadium/Home',
	},
	{
		key: 'Hangar',
		name: 'Laser Tag: Hangar',
		link: '^LaserTag.Hangar',
		scenes: ['239e676c-f12f-489f-bf3a-d4c383d692c3'],
		kinds: ['games', 'win'],
		shares: 'Hangar/Home',
	},
	{
		key: 'CyberJunkCity',
		name: 'Laser Tag: CyberJunk City',
		link: '^LaserTag.CyberJunkCity',
		scenes: ['9d6456ce-6264-48b4-808d-2d96b3d91038'],
		kinds: ['games', 'win'],
		shares: 'LaserTagCyberJunk/Home, CyberJunkCity/Home',
	},
	{
		key: 'Paddleball',
		name: 'Paddleball',
		link: '^Paddleball',
		scenes: ['d89f74fa-d51e-477a-a425-025a891dd499'],
		kinds: ['games', 'win'],
	},
	{
		key: 'FrontierSolos',
		name: 'Rec Royale: Solos',
		link: '^RecRoyaleSolos',
		scenes: ['b010171f-4875-4e89-baba-61e878cd41e1'],
		kinds: ['games', 'win'],
	},
	{
		key: 'FrontierSquads',
		name: 'Rec Royale: Squads',
		link: '^RecRoyaleSquads',
		scenes: ['253fa009-6e65-4c90-91a1-7137a56a267f'],
		kinds: ['games', 'win'],
	},

	// Rooms where finishing is the whole ask — "winning" one of these isn't a thing the
	// `won` variable is known to report.
	{
		key: 'Bowling',
		name: 'Bowling',
		link: '^Bowling',
		scenes: ['ae929543-9a07-41d5-8ee9-dbbee8c36800'],
		kinds: ['games'],
		shares: 'BowlingAlley/Home',
	},
	{
		key: 'DiscGolfLake',
		name: 'Disc Golf: Lake',
		link: '^DiscGolfLake',
		scenes: ['f6f7256c-e438-4299-b99e-d20bef8cf7e0'],
		kinds: ['games'],
		shares: 'Lake/Home',
	},
	{
		key: 'DiscGolfPropulsion',
		name: 'Disc Golf: Propulsion',
		link: '^DiscGolfPropulsion',
		scenes: ['d9378c9f-80bc-46fb-ad1e-1bed8a674f55'],
		kinds: ['games'],
		shares: 'PropulsionTestRange/Home',
	},
	{
		key: 'Charades',
		name: 'Charades',
		link: null,
		// Both charades scenes, as the captured rotation's own charades challenge does.
		scenes: ['a673712c-877f-4749-b69a-4a4c6310d545', '4078dfed-24bb-4db7-863f-578ba48d726b'],
		kinds: ['games'],
		shares: '3DCharades/InkSpaceHome, Legacy3DCharades/Home',
	},
	{
		key: 'StuntRunner',
		name: 'Stunt Runner',
		link: '^StuntRunner',
		scenes: ['b7281665-a715-4051-826b-8e08e69c6172'],
		kinds: ['games'],
	},
]

/** One challenge as the rotation serves it — `Complete` is stamped per caller by `getCurrent`. */
export interface RotationChallenge {
	ChallengeId: number
	Name: string
	Config: string
	Description: string
	Tooltip: string
	Complete: boolean
}

/**
 * The rotation's reward block. Same item vocabulary as a storefront gift drop, but with
 * `Context`/`Rarity` spelled `GiftContext`/`GiftRarity` — the two shapes are not
 * interchangeable, see `toChallengeGiftDrop` in econ.app.ts.
 */
export interface ChallengeGiftBlock {
	GiftDropId: number
	AvatarItemDesc: string
	AvatarItemType: number
	ConsumableItemDesc: string
	EquipmentPrefabName: string
	EquipmentModificationGuid: string
	StorefrontType: number
	Xp: number
	Level: number
	GiftContext: number
	GiftRarity: number
	/**
	 * Display strings, OPTIONAL because neither the captured rotation nor a generated block
	 * carries them — the reward's name is resolved from the catalog entry selling the same
	 * item, falling back to `FallbackGiftName`. A pinned rotation can set them to name its
	 * reward outright.
	 */
	FriendlyName?: string
	Tooltip?: string
}

/** A week's whole rotation — the body `GET /api/challenge/v2/getCurrent` serves. */
export interface WeeklyChallengeRotation {
	ChallengeMapId: number
	CompletedRequired: boolean
	StartAt: string
	EndAt: string
	ServerTime: string
	Challenges: RotationChallenge[]
	Gift: ChallengeGiftBlock
	FallbackGiftName: string
	/**
	 * What the week is themed on — the FriendlyName of the item its `Gift` hands over, set
	 * by {@link withWeeklyGift} once the catalog has named the roll. The static file's value
	 * is only a placeholder: a generated week's reward isn't known until it is rolled. A
	 * PINNED rotation keeps whatever string it ships.
	 */
	ChallengeThemeString: string
}

/** An equipment item the weekly gift can be drawn from — one sf3 entry, trimmed to what a gift needs. */
export interface EquipmentGift {
	GiftDropId: number
	EquipmentPrefabName: string
	EquipmentModificationGuid: string
	Rarity: number
	/** The catalog's display name for the item — what the week is themed on. */
	FriendlyName: string
}

/** Whether the shipped file pins the week, in which case nothing here is generated. */
function pinnedRotation(): WeeklyChallengeRotation | null {
	return weeklyChallenge.Challenges.length > 0 ? (weeklyChallenge as WeeklyChallengeRotation) : null
}

/**
 * Which week it is: whole weeks since the epoch, so the value ticks over at Wednesday 21:00
 * UTC and every caller in the same week gets the same number.
 */
export function rotationIndex(now: Date): number {
	return Math.floor((now.getTime() - ROTATION_EPOCH_MS) / WEEK_MS)
}

/**
 * This week's `ChallengeMapId` — the identity of the rotation, and what makes a stored
 * completion belong to one week rather than another. Cheap on purpose: `updateProgress` asks
 * only this to decide whether a report is against the live week.
 */
export function rotationMapId(now: Date): number {
	return pinnedRotation()?.ChallengeMapId ?? CHALLENGE_MAP_ID_BASE + rotationIndex(now)
}

/** The week's window, as the client's `StartAt`/`EndAt` want it: UTC, but written without a zone. */
function rotationWindow(index: number): { StartAt: string; EndAt: string } {
	const start = ROTATION_EPOCH_MS + index * WEEK_MS
	return {
		StartAt: toLocalIsoString(new Date(start)),
		EndAt: toLocalIsoString(new Date(start + WEEK_MS)),
	}
}

/** `2026-08-19T21:00:00` — ISO 8601 with the milliseconds and the `Z` cut off, which is the shape the client's window fields take. */
function toLocalIsoString(at: Date): string {
	return at.toISOString().slice(0, 19)
}

/**
 * `2026-08-25T14:42:54.2754728Z` — .NET's round-trip format, seven fractional digits. The
 * client dates its countdown off this, and because a generated window is genuinely the
 * current one, this is the real clock rather than the frozen timestamp a static file needs.
 */
function toDotNetString(at: Date): string {
	return `${at.toISOString().slice(0, -1)}0000Z`
}

/** mulberry32 — a small deterministic PRNG. Same seed, same week, same rotation, everywhere. */
function mulberry32(seed: number): () => number {
	let a = seed >>> 0
	return () => {
		a = (a + 0x6d2b79f5) >>> 0
		let t = a
		t = Math.imul(t ^ (t >>> 15), t | 1)
		t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
		return ((t ^ (t >>> 14)) >>> 0) / 4294967296
	}
}

/**
 * Spread a week index into a seed. Adjacent weeks are adjacent integers, and feeding those
 * straight in makes consecutive rotations correlate; a multiply by a large odd constant
 * (Knuth's) scatters them.
 */
function seedFor(mapId: number, salt: number): number {
	return Math.imul(mapId ^ salt, 2654435761) >>> 0
}

/** In-place Fisher-Yates against a seeded stream — the only place ordering comes from. */
function shuffle<T>(items: T[], random: () => number): T[] {
	const out = [...items]
	for (let i = out.length - 1; i > 0; i--) {
		const j = Math.floor(random() * (i + 1))
		const a = out[i] as T
		const b = out[j] as T
		out[i] = b
		out[j] = a
	}
	return out
}

/** A `ct:7` scene allow-list node. */
function sceneNode(scenes: string[]) {
	return { ct: 7, vs: scenes.map((l) => ({ l })) }
}

/**
 * The rule tree for one (kind, room), as an object — stringified into `Config` by the caller.
 * Each branch is one of the three idioms in the skill doc, with the field order the captured
 * trees use:
 *
 * - `games` — a counter over finished games in the room (`ct:1` + `GameEnd` + scene).
 * - `win` — one finished game in the room that the player won (`ct:0` + `GameEnd` + `won` + scene).
 * - `ai` — a counter over enemies defeated in the room (`ct:1` + `EliminatedAI` + scene).
 */
function configFor(kind: ChallengeKind, room: ChallengeRoom): unknown {
	const scene = sceneNode(room.scenes)
	switch (kind) {
		case 'games':
			return {
				ct: 1,
				ipc: false,
				ctc: [{ ct: 0, ipc: false, wc: [{ ct: 6, vs: [EVENT_GAME_END] }, scene] }],
				t: GAMES_TARGET,
			}
		case 'win':
			return {
				ct: 0,
				ipc: false,
				wc: [{ ct: 6, vs: [EVENT_GAME_END] }, { ct: 9, vs: [true], v: 'won' }, scene],
			}
		case 'ai':
			return {
				ct: 1,
				ipc: false,
				ctc: [{ ct: 0, ipc: false, wc: [{ ct: 6, vs: [EVENT_ELIMINATED_AI] }, scene] }],
				t: AI_TARGET,
			}
	}
}

/**
 * The copy for one (kind, room). Generated from the same two inputs as the tree, which is
 * the point: the client renders these strings and evaluates the tree independently, so
 * hand-written copy is free to drift into describing a challenge that doesn't exist.
 */
function copyFor(
	kind: ChallengeKind,
	room: ChallengeRoom
): { Description: string; Tooltip: string } {
	const where = room.link ?? room.name
	switch (kind) {
		case 'games':
			return {
				Description: `Complete ${GAMES_TARGET} games in ${where}`,
				Tooltip: `Play ${GAMES_TARGET} games of ${room.name} through to the end. Winning is optional.`,
			}
		case 'win':
			return room.quest === true
				? {
						Description: `Complete the ${where} quest`,
						Tooltip: `See ${room.name} through to a win.`,
					}
				: {
						Description: `Win a game in ${where}`,
						Tooltip: `Come out on top of a game of ${room.name}.`,
					}
		case 'ai':
			return {
				Description: `Defeat ${AI_TARGET} enemies in ${where}`,
				Tooltip: `Take out ${AI_TARGET} enemies in ${room.name}. They don't have to be in one run.`,
			}
	}
}

/** The internal slug — never displayed, but it's what a log line or a D1 row is read against. */
function nameFor(kind: ChallengeKind, room: ChallengeRoom): string {
	switch (kind) {
		case 'games':
			return `Complete${GAMES_TARGET}Games${room.key}`
		case 'win':
			return `Win${room.key}`
		case 'ai':
			return `Defeat${AI_TARGET}AI${room.key}`
	}
}

/** One thing the generator may publish: a room crossed with a kind that room supports. */
interface Candidate {
	challengeId: number
	kind: ChallengeKind
	room: ChallengeRoom
}

/**
 * Every (room, kind) pair, in a fixed order — the index in this list IS the challenge id.
 *
 * Deriving the id from the pair rather than from the position in a week keeps ids meaningful
 * across weeks: id 12 is always "win in Dodgeball", so a `challenge_status` row that outlives
 * its rotation is at worst stale, never a different challenge wearing the same id. Ids are
 * only required to be unique within a rotation, which distinct pairs trivially are.
 *
 * Appending to `CHALLENGE_ROOMS` is safe; INSERTING into the middle renumbers everything
 * after it, so add rooms at the end.
 */
const CANDIDATES: Candidate[] = CHALLENGE_ROOMS.flatMap((room) =>
	room.kinds.map((kind) => ({ challengeId: 0, kind, room }))
).map((candidate, index) => ({ ...candidate, challengeId: index + 1 }))

/**
 * Pick the week's challenges: shuffle every candidate, then take the first five that keep
 * one room out of two slots and one kind out of three. The relaxation pass exists so the
 * constraints can never under-deliver a rotation — a short week would quietly lower the gift
 * threshold, since it clamps to what's published.
 */
function pickChallenges(random: () => number): RotationChallenge[] {
	const shuffled = shuffle(CANDIDATES, random)
	const picked: Candidate[] = []
	const rooms = new Set<string>()
	const kinds = new Map<ChallengeKind, number>()
	for (const pass of [0, 1]) {
		for (const candidate of shuffled) {
			if (picked.length === CHALLENGES_PER_ROTATION) break
			if (rooms.has(candidate.room.key)) continue
			if (pass === 0 && (kinds.get(candidate.kind) ?? 0) >= MAX_PER_KIND) continue
			picked.push(candidate)
			rooms.add(candidate.room.key)
			kinds.set(candidate.kind, (kinds.get(candidate.kind) ?? 0) + 1)
		}
	}
	return picked.map(({ challengeId, kind, room }) => ({
		ChallengeId: challengeId,
		Name: nameFor(kind, room),
		Config: JSON.stringify(configFor(kind, room)),
		...copyFor(kind, room),
		Complete: false,
	}))
}

/**
 * The week's gift: one equipment item, drawn from the pool with the week's own seed.
 *
 * Weekly rewards are equipment — the captured rotation's is a camera skin — so the pool is
 * every sf3 item carrying an `EquipmentModificationGuid`. Drawing from the live catalog
 * rather than a copied list is what lets `toChallengeGiftDrop` resolve the pick back to the
 * entry selling it and hand the player a properly named item.
 *
 * Null when the pool is empty (the catalog didn't load), and the caller keeps the static
 * file's block so the reward preview is still something rather than nothing.
 */
function pickWeeklyGift(
	mapId: number,
	pool: EquipmentGift[]
): { gift: ChallengeGiftBlock; friendlyName: string } | null {
	if (pool.length === 0) return null
	const random = mulberry32(seedFor(mapId, 0x9e3779b9))
	const gift = pool[Math.floor(random() * pool.length)] as EquipmentGift
	// The name comes back alongside rather than on the block: the block is the wire shape,
	// whose display strings are optional and left unset here so `toChallengeGiftDrop` keeps
	// resolving them from the catalog entry that sells the item.
	return {
		friendlyName: gift.FriendlyName,
		gift: {
			GiftDropId: gift.GiftDropId,
			AvatarItemDesc: '',
			AvatarItemType: 0,
			ConsumableItemDesc: '',
			EquipmentPrefabName: gift.EquipmentPrefabName,
			EquipmentModificationGuid: gift.EquipmentModificationGuid,
			StorefrontType: 0,
			Xp: 0,
			Level: 0,
			GiftContext: 0,
			GiftRarity: gift.Rarity,
		},
	}
}

/**
 * Memoised generation. The rotation is identical for every caller in a week, so it is built
 * once per isolate per week rather than per request; `ServerTime` is the one field that
 * moves, and it is written fresh on the way out.
 *
 * The cached object is never handed out directly for that reason, and callers that
 * personalise it (`getCurrent` stamping per-player state) rebuild rather than mutate.
 */
let cached: WeeklyChallengeRotation | null = null

/**
 * This week's rotation, with the static file's `Gift` as a placeholder — callers that can
 * read the catalog replace it with {@link pickWeeklyGift}. Pure apart from `now`: same week
 * in, same rotation out.
 */
export function buildRotation(now: Date): WeeklyChallengeRotation {
	const pinned = pinnedRotation()
	if (pinned !== null) return pinned
	const index = rotationIndex(now)
	const mapId = CHALLENGE_MAP_ID_BASE + index
	if (cached === null || cached.ChallengeMapId !== mapId) {
		cached = {
			ChallengeMapId: mapId,
			CompletedRequired: weeklyChallenge.CompletedRequired,
			...rotationWindow(index),
			ServerTime: '',
			Challenges: pickChallenges(mulberry32(seedFor(mapId, 0))),
			Gift: weeklyChallenge.Gift as ChallengeGiftBlock,
			FallbackGiftName: weeklyChallenge.FallbackGiftName,
			ChallengeThemeString: weeklyChallenge.ChallengeThemeString,
		}
	}
	return { ...cached, ServerTime: toDotNetString(now) }
}

/**
 * Put the week's own reward on a rotation. Separate from {@link buildRotation} because the
 * pool comes from the storefront catalog, which is an async read the cheap paths
 * (`updateProgress` deciding whether a report is against the live week) have no reason to pay.
 *
 * A PINNED rotation is returned untouched: it ships its own `Gift`, and overwriting that with
 * a rolled one would make the pin a half-pin.
 */
export function withWeeklyGift(
	rotation: WeeklyChallengeRotation,
	pool: EquipmentGift[]
): WeeklyChallengeRotation {
	if (pinnedRotation() !== null) return rotation
	const picked = pickWeeklyGift(rotation.ChallengeMapId, pool)
	if (picked === null) return rotation
	// The week is themed on its reward: `ChallengeThemeString` is the item's catalog name,
	// which is the same string `toChallengeGiftDrop` resolves for the grant, so the heading
	// and the thing handed over read as one. The static file's value is a placeholder — it
	// can't name an item that is rolled per week.
	return { ...rotation, Gift: picked.gift, ChallengeThemeString: picked.friendlyName }
}
