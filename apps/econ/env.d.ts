// oxlint-disable @typescript-eslint/consistent-type-imports
type LocalEnv = import('./src/context').Env
type MainModule = typeof import('./src/econ.app')

// Add Env to Cloudflare namespace so that we can access it via
// import { env } from 'cloudflare:workers'
declare namespace Cloudflare {
	interface Env extends LocalEnv {}
	interface GlobalProps {
		mainModule: MainModule
	}
}

// Vite serves a `?raw` import as the file's text. Used by the tests to read the generated
// catalog migration as a STRING and diff it against the captures it was generated from —
// it is counted, never executed.
declare module '*.sql?raw' {
	const content: string
	export default content
}
