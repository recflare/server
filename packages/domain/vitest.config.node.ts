import { defineConfig } from 'vitest/config'

// Node, not the Workers pool: the libSQL adapter is exercised against an in-memory libSQL
// database through the Node client, which workerd can't host. Everything else in this
// package is covered by the workers' own integration tests, on D1.
export default defineConfig({
	test: {
		environment: 'node',
	},
})
