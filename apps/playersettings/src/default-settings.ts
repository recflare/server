/**
 * Default player settings seeded on a player's first read, ported verbatim from
 * the reference's `PlayerSettingsController.GetPlayerSettings`. Ordered; written to the player’s row the
 * first time a player has no stored settings.
 */
export const DEFAULT_SETTINGS: Array<{ Key: string; Value: string }> = [
	{ Key: 'Recroom.OOBE', Value: '77' },
	{ Key: 'TUTORIAL_COMPLETE_MASK', Value: '11' },
	{ Key: 'FIRST_TIME_IN_FLAGS', Value: '0' },
]
