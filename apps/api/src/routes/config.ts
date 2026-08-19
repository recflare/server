import { Hono } from 'hono'
import { describeRoute } from 'hono-openapi'

import { GAME_VERSION, isSupportedGameVersion } from '@repo/domain'
import { validateAndGetVersion } from '@repo/jwt'

import apiConfigV2 from '../../static/api-config-v2.json'
import gameConfigsV1All2025 from '../../static/gameconfigs-v1-all-2025.json'
import gameConfigsV1All from '../../static/gameconfigs-v1-all.json'
import {
	AmplitudeConfig,
	ApiConfigV2,
	AzureSpeechConfig,
	BacktraceConfig,
	IslandedVersions,
	json,
	JsonObject,
	StatsigUserProperties,
	VersionCheck,
} from '../openapi'

import type { App } from '../context'

// ---- Config / version ------------------------------------------------------
export const configRoutes = new Hono<App>({ strict: false })
	.get(
		'/api/config/v1/amplitude',
		describeRoute({
			tags: ['Config'],
			summary: 'Analytics keys',
			description:
				'The Amplitude / StatSig / RudderStack keys the client initialises its analytics ' +
				'with. This server collects nothing, so the keys are placeholders and RudderStack ' +
				'is off — but the client needs the object to finish loading.',
			responses: { 200: json(AmplitudeConfig, 'Placeholder analytics keys') },
		}),
		(c) =>
			c.json({
				AmplitudeKey: 'a',
				StatSigKey: 'a',
				RudderStackKey: 'a',
				UseRudderStack: false,
			})
	)
	.get(
		'/api/config/v1/azurespeech',
		describeRoute({
			tags: ['Config'],
			summary: 'Speech-to-text config',
			description:
				'Azure Speech credentials for the client’s voice transcription. `Enabled` is false ' +
				'here, so the key and region are never used.',
			responses: { 200: json(AzureSpeechConfig, 'Speech config, disabled') },
		}),
		(c) =>
			c.json({
				Key: 'dce8de5b297747d9b5bddcc7f19e8c5b',
				Region: 'eastus',
				Enabled: false,
			})
	)
	.get(
		'/api/config/v1/backtrace',
		describeRoute({
			tags: ['Config'],
			summary: 'Crash reporter config',
			description:
				'Budget, sampling and log-capture settings for the client’s Backtrace crash ' +
				'reporter. Nothing on this server receives the reports.',
			responses: { 200: json(BacktraceConfig, 'Crash reporter settings') },
		}),
		(c) =>
			c.json({
				ReportBudget: 125,
				FilterType: 0,
				SampleRate: 1,
				LogLineCount: 50,
				CaptureNativeCrashes: 1,
				AMRThresholdMS: 0,
				MessageCount: 1000,
				MessageRegex: '^.*$',
				VersionRegex: '.*',
			})
	)
	// ShareBaseUrl is derived from the deploy-time base domain; the rest of the
	// config is static.
	.get(
		'/api/config/v2',
		describeRoute({
			tags: ['Config'],
			summary: 'The main client config blob',
			description:
				'The large feature-switch / endpoint config the client reads at startup. Served ' +
				'from a static asset, except `ShareBaseUrl`, which is templated from the ' +
				'deploy-time base domain so share links point at this deployment.',
			responses: { 200: json(ApiConfigV2, 'The client config') },
		}),
		(c) => c.json({ ...apiConfigV2, ShareBaseUrl: `https://www.${c.env.DOMAIN}/{0}` })
	)
	.get(
		'/api/versioncheck/v4',
		describeRoute({
			tags: ['Config'],
			summary: 'Client version check',
			description:
				'Whether the client build is current. Compares the client’s `?v=` build against ' +
				'the builds we serve (`SUPPORTED_GAME_VERSIONS`): `VersionStatus` is 0 when the ' +
				'client is on one of them, 1 when it is on some other build.',
			responses: { 200: json(VersionCheck, 'Version status') },
		}),
		(c) =>
			c.json({
				VersionStatus: isSupportedGameVersion(c.req.query('v')) ? 0 : 1,
				UpdateNotificationStage: 0,
				IsVersionIslanded: false,
				IsCrossPlayDisabled: false,
			})
	)
	// Islanding splits players onto version-specific matchmaking pools. We serve every
	// supported build from one pool, so the list is empty — the client reads it as
	// "nobody is islanded" and matchmakes normally.
	.get(
		'/api/versioncheck/islandedversions',
		describeRoute({
			tags: ['Config'],
			summary: 'Islanded client builds',
			description:
				'The builds that are islanded off into their own matchmaking pool. This server ' +
				'never islands a build, so the list is always empty.',
			responses: { 200: json(IslandedVersions, 'Always an empty list') },
		}),
		(c) => c.json([])
	)
	// Two catalogs, one per client generation: the 2023 build and the 2025 build read
	// different keys out of this, and the 2025 one carries entries (`Screens.*`, the
	// creative-door queries) the older catalog never had.
	//
	// Which one a caller gets is decided by the token's `rn.ver` claim — the build the
	// client posted at login — since the request itself carries no version. Anything NEWER
	// than `GAME_VERSION` (20230414) gets the 2025 catalog; that build and anything older
	// get the 2023 one. Builds are date-stamped (`20230414`, `20250718.01`), so they order
	// as strings, the same comparison `match` makes for cross-build joins.
	//
	// A request with no readable token version gets the 2023 catalog, the same body this
	// route has always served: unauthenticated is not evidence of a newer client, and this
	// stack targets `GAME_VERSION`. Like the version gate on `featuredrooms`, the claim is
	// unverified — a client that lies about its build only misconfigures itself.
	.get(
		'/api/gameconfigs/v1/all',
		describeRoute({
			tags: ['Config'],
			summary: 'Per-game configuration',
			description:
				'An opaque static catalog of per-game settings, served verbatim. There are two: a ' +
				'build NEWER than `20230414` gets the 2025 catalog, which carries keys the older one ' +
				'never had; that build and anything older get the 2023 catalog. Builds are ' +
				'date-stamped, so they compare as strings. The build is read from the token’s ' +
				'`rn.ver` claim — the request carries no version of its own — so auth is optional ' +
				'here and only selects the catalog; a request without a readable token version gets ' +
				'the 2023 one.',
			responses: { 200: json(JsonObject, 'The game config catalog for the caller’s build') },
		}),
		async (c) => {
			const version = await validateAndGetVersion(c.req.raw, await c.env.JWT_SECRET.get())
			const newerThanTarget = version !== null && version > GAME_VERSION
			return c.json(newerThanTarget ? gameConfigsV1All2025 : gameConfigsV1All)
		}
	)

	// The property bag the client would attach to its Statsig user. The reference server
	// doesn't send properties at all here — it answers a lone `success` carrying its
	// `StatsigEnabled` config value, as a bool — so that is what this mirrors. This server
	// runs no experiments and collects no analytics (see the placeholder keys
	// `/api/config/v1/amplitude` serves), so the value is fixed and the same for everyone.
	.post(
		'/statsigUserProperties',
		describeRoute({
			tags: ['Config'],
			summary: 'Statsig user properties',
			description:
				'Despite the name, the reference server returns no properties here — just ' +
				'`success`, its `StatsigEnabled` config value as a bool. This server mirrors that ' +
				'with a fixed `true`; it runs no experiments and collects no analytics, so nothing ' +
				'here is per-account and it is not auth-gated.',
			responses: { 200: json(StatsigUserProperties, 'The fixed `StatsigEnabled` flag') },
		}),
		(c) => c.json({ success: true })
	)

	// Voice chat config. The client fetches it to set up voice.
	// No reference shape, so return an empty object until the client needs fields.
	.get(
		'/voice/config',
		describeRoute({
			tags: ['Config'],
			summary: 'Voice chat config',
			description:
				'Fetched by the client while setting up voice. We have no reference shape for it, ' +
				'so it stays an empty object until the client is observed needing a field.',
			responses: { 200: json(JsonObject, 'An empty object') },
		}),
		(c) => c.json({})
	)
