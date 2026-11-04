import type { HonoApp } from '@repo/hono-helpers'
import type { SharedHonoEnv, SharedHonoVariables } from '@repo/hono-helpers/src/types'

export type Env = SharedHonoEnv & {
	DOMAIN: string
	DB: D1Database
	ATTACHMENTS: R2Bucket
	JWT_SECRET: SecretsStoreSecret
}
export interface App extends HonoApp {
	Bindings: Env
	Variables: SharedHonoVariables & { reportAccountId: number }
}
