/**
 * Game-reward selections — the three-choice reward the client shows after a
 * challenge/level-up. `/api/gamerewards/v1/request` mints a selection and pushes it
 * to the player over the notifications hub (the HTTP response carries nothing); the
 * player then picks one with `/api/gamerewards/v1/select`, which consumes it.
 *
 * The three offered drops are recorded so `select` can verify the player is claiming
 * a drop they were actually offered, and `consumed` makes a selection single-use — a
 * player can't redeem the same reward twice.
 *
 * There's no reward-drop catalog (avatar items, consumables) yet, so every offered
 * drop is a token choice. That's the reference's own fallback path when it runs out
 * of drops: a token drop's id is the negative of its amount, which is how `select`
 * reconstructs it without a catalog lookup.
 */

/** Schema DDL (mirror of migrations/0014_reward_selection.sql). */
export const SCHEMA_DDL: string[] = [
	`CREATE TABLE IF NOT EXISTS reward_selection (
		reward_selection_id INTEGER PRIMARY KEY AUTOINCREMENT,
		account_id INTEGER NOT NULL,
		message TEXT NOT NULL DEFAULT '',
		gift_context INTEGER NOT NULL DEFAULT 0,
		reward_type INTEGER NOT NULL DEFAULT 0,
		gift_drop_1_id INTEGER NOT NULL,
		gift_drop_2_id INTEGER NOT NULL,
		gift_drop_3_id INTEGER NOT NULL,
		consumed INTEGER NOT NULL DEFAULT 0,
		created_at TEXT
	)`,
	`CREATE INDEX IF NOT EXISTS idx_reward_selection_account ON reward_selection (account_id)`,
]

/** One of the three rewards a player is offered (Rec Room's `GiftDrop` wire shape). */
export interface GameRewardDrop {
	GiftDropId: number
	FriendlyName: string
	Tooltip: string
	ConsumableItemDesc: string
	AvatarItemDesc: string
	AvatarItemType: number
	EquipmentPrefabName: string
	EquipmentModificationGuid: string
	IsQuery: boolean
	Unique: boolean
	SubscribersOnly: boolean
	Rarity: number
	CurrencyType: number
	Currency: number
	Context: number
	ItemSetId: number
	ItemSetFriendlyName: string
}

/** The token amounts a reward choice can be worth. */
const TOKEN_AMOUNTS = [10, 25, 50, 100, 250, 500]

/**
 * A token reward choice. The drop id is the *negative* of the amount, which is how a
 * token drop is told apart from a catalog drop (positive id) and how `select` rebuilds
 * it — the reference does the same.
 */
export function tokenRewardDrop(amount: number, context: number): GameRewardDrop {
	return {
		GiftDropId: -amount,
		FriendlyName: `${amount} Tokens!`,
		Tooltip: 'Winner!',
		ConsumableItemDesc: '',
		AvatarItemDesc: '',
		AvatarItemType: 0,
		EquipmentPrefabName: '',
		EquipmentModificationGuid: '',
		IsQuery: false,
		Unique: false,
		SubscribersOnly: false,
		Rarity: 0,
		CurrencyType: 2, // RecCenterTokens
		Currency: amount,
		Context: context,
		ItemSetId: 1,
		ItemSetFriendlyName: '',
	}
}

/** Three distinct token choices for a reward selection. */
export function rollRewardDrops(context: number): GameRewardDrop[] {
	const amounts = [...TOKEN_AMOUNTS]
	const picked: number[] = []
	for (let i = 0; i < 3; i++) {
		const [amount] = amounts.splice(Math.floor(Math.random() * amounts.length), 1)
		picked.push(amount)
	}
	return picked.map((amount) => tokenRewardDrop(amount, context))
}

/** A stored reward selection — the three drops offered to a player, and whether they picked. */
export interface RewardSelection {
	RewardSelectionId: number
	AccountId: number
	Message: string
	GiftContext: number
	RewardType: number
	GiftDropIds: number[]
	Consumed: boolean
	CreatedAt: string
}

/** Record a reward selection (the three drops a player was offered). */
export async function createRewardSelection(
	db: D1Database,
	accountId: number,
	input: { message: string; giftContext: number; rewardType: number; dropIds: number[] }
): Promise<RewardSelection> {
	const createdAt = new Date().toISOString()
	const row = await db
		.prepare(
			`INSERT INTO reward_selection
			   (account_id, message, gift_context, reward_type,
			    gift_drop_1_id, gift_drop_2_id, gift_drop_3_id, created_at)
			 VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)
			 RETURNING reward_selection_id`
		)
		.bind(
			accountId,
			input.message,
			input.giftContext,
			input.rewardType,
			input.dropIds[0],
			input.dropIds[1],
			input.dropIds[2],
			createdAt
		)
		.first<{ reward_selection_id: number }>()

	return {
		RewardSelectionId: row?.reward_selection_id ?? 0,
		AccountId: accountId,
		Message: input.message,
		GiftContext: input.giftContext,
		RewardType: input.rewardType,
		GiftDropIds: input.dropIds,
		Consumed: false,
		CreatedAt: createdAt,
	}
}

/** Look up a reward selection by id, or null when there's no such row. */
export async function getRewardSelection(
	db: D1Database,
	rewardSelectionId: number
): Promise<RewardSelection | null> {
	const row = await db
		.prepare(
			`SELECT reward_selection_id, account_id, message, gift_context, reward_type,
			        gift_drop_1_id, gift_drop_2_id, gift_drop_3_id, consumed, created_at
			 FROM reward_selection WHERE reward_selection_id = ?1`
		)
		.bind(rewardSelectionId)
		.first<{
			reward_selection_id: number
			account_id: number
			message: string
			gift_context: number
			reward_type: number
			gift_drop_1_id: number
			gift_drop_2_id: number
			gift_drop_3_id: number
			consumed: number
			created_at: string | null
		}>()
	if (row === null) return null

	return {
		RewardSelectionId: row.reward_selection_id,
		AccountId: row.account_id,
		Message: row.message,
		GiftContext: row.gift_context,
		RewardType: row.reward_type,
		GiftDropIds: [row.gift_drop_1_id, row.gift_drop_2_id, row.gift_drop_3_id],
		Consumed: row.consumed === 1,
		CreatedAt: row.created_at ?? '',
	}
}

/**
 * Mark a selection consumed. Returns false when it was already consumed — the
 * conditional update is what makes a reward single-use even if the client sends the
 * same claim twice.
 */
export async function consumeRewardSelection(
	db: D1Database,
	rewardSelectionId: number
): Promise<boolean> {
	const result = await db
		.prepare(
			'UPDATE reward_selection SET consumed = 1 WHERE reward_selection_id = ?1 AND consumed = 0'
		)
		.bind(rewardSelectionId)
		.run()
	return (result.meta.changes ?? 0) > 0
}
