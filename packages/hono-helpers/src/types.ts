import { z } from 'zod'

export type WorkersEnvironment = z.infer<typeof WorkersEnvironment>
export const WorkersEnvironment = z.enum(['VITEST', 'development', 'staging', 'production'])

/** Global bindings */
export type SharedHonoEnv = {
	/**
	 * Name of the worker used in logging/etc.
	 * Automatically pulled from package.json
	 */
	NAME: string
	/**
	 * Environment of the worker.
	 * All workers should specify env in wrangler.jsonc vars
	 */
	ENVIRONMENT: WorkersEnvironment
	/**
	 * Release version of the Worker (based on the current git commit).
	 * Useful for logs, Sentry, etc.
	 */
	SENTRY_RELEASE: string
	/**
	 * A libSQL server (Turso) to use INSTEAD of the D1 binding, e.g. `libsql://<db>-<org>.turso.io`.
	 * Set by `just deploy` from `RECFLARE_LIBSQL_DB_URL`; unset means D1. Read only by
	 * `withDatabase` in @repo/domain, which swaps `DB` for the matching adapter.
	 */
	LIBSQL_DB_URL?: string
	/** That server's auth token — a worker SECRET `just deploy` sets, never a var. */
	LIBSQL_DB_AUTH_TOKEN?: string
}
/** Global Hono variables */
export type SharedHonoVariables = {
	// Things like Sentry, etc. that should be present on all Workers
}

/** Top-level Hono app */
export interface HonoApp {
	Variables: SharedHonoVariables
	Bindings: SharedHonoEnv
}

/** Context used for non-Hono things like Durable Objects */
export type SharedAppContext = {
	var: SharedHonoVariables
	env: SharedHonoEnv
	executionCtx: Pick<ExecutionContext, 'waitUntil'>
}
