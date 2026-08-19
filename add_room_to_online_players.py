from pathlib import Path

# ============================================================
# 1. Add getOnlinePlayerPresence() to presence-db.ts
# ============================================================

p = Path("packages/domain/src/presence-db.ts")
text = p.read_text()

if "export interface OnlinePlayerPresence" not in text:
    marker = """export async function getOnlinePlayerIds(
        db: D1Database,
        now = nowSeconds()
): Promise<number[]> {
"""

    addition = """export interface OnlinePlayerPresence {
        accountId: number
        roomId: number | null
        roomInstanceId: number | null
}

/**
 * Return all currently online players together with the room/instance
 * they are currently standing in. Lobby players have null room values.
 */
export async function getOnlinePlayerPresence(
        db: D1Database,
        now = nowSeconds()
): Promise<OnlinePlayerPresence[]> {
        const { results } = await db
                .prepare(
                        `SELECT
                                account_id AS accountId,
                                room_id AS roomId,
                                room_instance_id AS roomInstanceId
                         FROM presence
                         WHERE expires_at > ?1
                         ORDER BY account_id`
                )
                .bind(now)
                .all<OnlinePlayerPresence>()

        return results
}

"""

    if marker not in text:
        raise SystemExit("ERROR: Could not find getOnlinePlayerIds()")

    text = text.replace(marker, addition + marker)
    p.write_text(text)
    print("✓ Added getOnlinePlayerPresence()")
else:
    print("✓ getOnlinePlayerPresence() already exists")


# ============================================================
# 2. Update www.app.ts import
# ============================================================

p = Path("apps/www/src/www.app.ts")
text = p.read_text()

old_import = """import { countOnlinePlayers, getOnlinePlayerIds } from '@repo/domain/src/presence-db'"""

new_import = """import {
        countOnlinePlayers,
        getOnlinePlayerIds,
        getOnlinePlayerPresence,
} from '@repo/domain/src/presence-db'"""

if "getOnlinePlayerPresence" not in text:
    if old_import not in text:
        raise SystemExit("ERROR: Could not find presence-db import in www.app.ts")

    text = text.replace(old_import, new_import)
    print("✓ Updated www.app.ts presence import")
else:
    print("✓ www.app.ts already imports getOnlinePlayerPresence()")


# ============================================================
# 3. Replace online players endpoint
# ============================================================

start = """        .get('/api/admin/online-players', async (c) => {"""

start_index = text.find(start)

if start_index == -1:
    raise SystemExit("ERROR: Could not find /api/admin/online-players endpoint")

# Find the closing }) by locating the next signup route.
end_marker = """        .post('/api/signup', async (c) => {"""
end_index = text.find(end_marker, start_index)

if end_index == -1:
    raise SystemExit("ERROR: Could not find endpoint boundary before /api/signup")

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
        })

"""

text = text[:start_index] + new_endpoint + text[end_index:]
p.write_text(text)

print("✓ Updated /api/admin/online-players endpoint")


# ============================================================
# 4. Update OnlinePlayer interface in App.tsx
# ============================================================

p = Path("apps/www/src/client/App.tsx")
text = p.read_text()

old_interface = """interface OnlinePlayer {
        accountId: number
        username: string
        displayName: string
}"""

new_interface = """interface OnlinePlayer {
        accountId: number
        username: string
        displayName: string
        roomId: number | null
        roomInstanceId: number | null
}"""

if old_interface in text:
    text = text.replace(old_interface, new_interface)
    print("✓ Added room fields to OnlinePlayer")
elif "roomInstanceId: number | null" in text:
    print("✓ OnlinePlayer already has room fields")
else:
    raise SystemExit("ERROR: Could not find OnlinePlayer interface")


# ============================================================
# 5. Add room information to the UI
# ============================================================

old_ui = """                                                                                <div className="muted">
                                                                                        @{player.username}
                                                                                </div>"""

new_ui = """                                                                                <div className="muted">
                                                                                        @{player.username}
                                                                                </div>
                                                                                <div className="muted">
                                                                                        Room:{' '}
                                                                                        {player.roomId === null
                                                                                                ? 'Lobby'
                                                                                                : `#${player.roomId} · Instance #${player.roomInstanceId}`}
                                                                                </div>"""

if old_ui in text:
    text = text.replace(old_ui, new_ui, 1)
    print("✓ Added room information to Online Players UI")
elif "player.roomInstanceId" in text:
    print("✓ Online Players UI already displays room information")
else:
    raise SystemExit("ERROR: Could not find Online Players UI")


p.write_text(text)


print()
print("========================================")
print("ONLINE PLAYERS ROOM INFO COMPLETE")
print("========================================")
print()
print("Online Players now shows:")
print("  - Username")
print("  - Account ID")
print("  - Room ID")
print("  - Room Instance ID")
print("  - Lobby when not inside a room")
print()
print("Next:")
print("  pnpm exec tsc --noEmit")
print("  pnpm --filter www build")
