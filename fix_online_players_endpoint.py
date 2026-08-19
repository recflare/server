from pathlib import Path

p = Path("apps/www/src/www.app.ts")
text = p.read_text()

start_marker = "        .get('/api/admin/online-players', async (c) => {"
start = text.find(start_marker)

if start == -1:
    raise SystemExit("ERROR: Could not find /api/admin/online-players")

# The endpoint currently ends immediately before the next blank line
# followed by another route or the end of the route chain.
# Find the endpoint's closing `        })` after the return block.
needle = """                })
        })"""

end = text.find(needle, start)

if end == -1:
    raise SystemExit("ERROR: Could not find the end of the online players endpoint")

end += len(needle)

new_endpoint = """        .get('/api/admin/online-players', async (c) => {
                const presence = await getOnlinePlayerPresence(c.env.DB)
                const ids = presence.map((p) => p.accountId)
                const accounts = await getAccountsByIds(c.env.DB, ids)

                const byId = new Map(accounts.map((a) => [a.accountId, a]))

                return c.json({
                        players: presence.map((p) => {
                                const account = byId.get(p.accountId)

                                return {
                                        accountId: p.accountId,
                                        username: account?.username ?? `Player${p.accountId}`,
                                        displayName:
                                                account?.displayName ??
                                                account?.username ??
                                                `Player${p.accountId}`,
                                        roomId: p.roomId,
                                        roomInstanceId: p.roomInstanceId,
                                }
                        }),
                })
        })"""

text = text[:start] + new_endpoint + text[end:]
p.write_text(text)

print("✓ Replaced online players endpoint")
