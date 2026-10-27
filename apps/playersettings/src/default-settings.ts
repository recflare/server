/**
 * Default player settings seeded on a player's first read, ported verbatim from
 * the reference's `PlayerSettingsController.GetPlayerSettings`. Ordered; written to KV the
 * first time a player has no stored settings.
 */
export const DEFAULT_SETTINGS: Array<{ Key: string; Value: string }> = [
	{ Key: 'Recroom.OOBE', Value: '77' },
	{ Key: 'TUTORIAL_COMPLETE_MASK', Value: '11' },
	{ Key: 'FIRST_TIME_IN_FLAGS', Value: '0' },
]

/**
 * Setting-key prefixes the server DROPS on write. The client posts its Year-In-Review
 * telemetry (`Growth.YIR.UGC.TubeDistance`, `Growth.YIR.DistanceTraveled`, …) through this
 * endpoint as the player plays, and the values change every time, so they can never be
 * deduplicated — measured at ~500 CCU they were about half of all settings writes. Nothing
 * server-side reads them and the client works without them (a new player has none), so a
 * PUT naming one is answered 200 and nothing is stored.
 */
export const IGNORED_SETTING_PREFIXES: readonly string[] = ['Growth.YIR.']

/** Whether a posted setting is one the server drops rather than stores. */
export function isIgnoredSetting(key: string): boolean {
	return IGNORED_SETTING_PREFIXES.some((prefix) => key.startsWith(prefix))
}
