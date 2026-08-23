import { SELF } from 'cloudflare:test'
import { expect, it } from 'vitest'

it('response with hello world', async () => {
	const res = await SELF.fetch('https://example.com')
	expect(res.status).toBe(200)
	expect(await res.text()).toMatchInlineSnapshot(`"hello, world!"`)
})

it('answers GetNearbyScores with an empty row list', async () => {
	const res = await SELF.fetch('https://example.com/leaderboard/GetNearbyScores', {
		method: 'POST',
		body: JSON.stringify({}),
	})
	expect(res.status).toBe(200)
	expect(await res.json()).toEqual({ Rows: [] })
})

it('answers GetRanks with an empty row list', async () => {
	const res = await SELF.fetch('https://example.com/leaderboard/GetRanks', {
		method: 'POST',
		body: JSON.stringify({
			RankStart: 0,
			RankEnd: 9,
			PlayerId: 2,
			StatChannel: 1,
			RoomId: 6,
			FilterType: 0,
			SortAscending: false,
		}),
	})
	expect(res.status).toBe(200)
	expect(await res.json()).toEqual({ Rows: [] })
})

it('serves an openapi spec with no dangling refs', async () => {
	const res = await SELF.fetch('https://example.com/openapi.json')
	expect(res.status).toBe(200)
	const spec = (await res.json()) as Record<string, unknown>
	expect(Object.keys(spec.paths as object).sort()).toEqual([
		'/',
		'/leaderboard/GetNearbyScores',
		'/leaderboard/GetRanks',
	])
	expect(JSON.stringify(spec).match(/\$ref/g)).toBeNull()
})
