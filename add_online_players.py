from pathlib import Path

ROOT = Path(".")

# ============================================================
# 1. Add getOnlinePlayerIds() to presence-db.ts
# ============================================================

presence = ROOT / "packages/domain/src/presence-db.ts"
text = presence.read_text()

if "export async function getOnlinePlayerIds" not in text:
    marker = "export async function countOnlinePlayers"

    idx = text.find(marker)
    if idx == -1:
        raise SystemExit("ERROR: Could not find countOnlinePlayers in presence-db.ts")

    # Find the end of countOnlinePlayers().
    brace = text.find("{", idx)
    if brace == -1:
        raise SystemExit("ERROR: Could not find countOnlinePlayers body")

    depth = 0
    end = None

    for i in range(brace, len(text)):
        if text[i] == "{":
            depth += 1
        elif text[i] == "}":
            depth -= 1
            if depth == 0:
                end = i + 1
                break

    if end is None:
        raise SystemExit("ERROR: Could not find end of countOnlinePlayers")

    addition = r'''

/**
 * Return the account IDs of every currently-online player.
 *
 * Presence is the source of truth for online state. Expired rows are ignored,
 * and players sitting in the lobby are included because their room_instance_id
 * is allowed to be NULL.
 */
export async function getOnlinePlayerIds(
        db: D1Database,
        now = nowSeconds()
): Promise<number[]> {
        const { results } = await db
                .prepare(
                        `SELECT account_id AS accountId
                         FROM presence
                         WHERE expires_at > ?1
                         ORDER BY account_id`
                )
                .bind(now)
                .all<{ accountId: number }>()

        return results.map((r) => r.accountId)
}
'''

    text = text[:end] + addition + text[end:]
    presence.write_text(text)
    print("✓ Added getOnlinePlayerIds()")
else:
    print("✓ getOnlinePlayerIds() already exists")


# ============================================================
# 2. Add admin API route to www.app.ts
# ============================================================

www = ROOT / "apps/www/src/www.app.ts"
text = www.read_text()

# Add imports.
old_import = "import { countOnlinePlayers } from '@repo/domain/src/presence-db'"

new_import = """import {
        countOnlinePlayers,
        getOnlinePlayerIds,
} from '@repo/domain/src/presence-db'
import { getAccountsByIds } from '@repo/domain/src/accounts-db'"""

if old_import in text and "getOnlinePlayerIds" not in text:
    text = text.replace(old_import, new_import, 1)
    print("✓ Updated www.app.ts imports")
elif "getOnlinePlayerIds" in text:
    print("✓ www.app.ts already imports online-player helpers")
else:
    raise SystemExit("ERROR: Could not find presence-db import in www.app.ts")


# Find /server-status and insert the new route immediately after it.
if ".get('/api/admin/online-players'" not in text:
    marker = "        // ---- Signup -------------------------------------------------------------"

    if marker not in text:
        raise SystemExit("ERROR: Could not find Signup section in www.app.ts")

    route = r'''        // ---- Admin: online players --------------------------------------------

        // Returns the accounts that currently have a live presence row.
        // Authentication is performed by the existing admin/session middleware
        // used by the other admin endpoints in the website.
        .get('/api/admin/online-players', async (c) => {
                const ids = await getOnlinePlayerIds(c.env.DB)
                const accounts = await getAccountsByIds(c.env.DB, ids)

                const byId = new Map(accounts.map((a) => [a.accountId, a]))

                return c.json({
                        players: ids.map((id) => {
                                const account = byId.get(id)

                                return {
                                        accountId: id,
                                        username: account?.username ?? `Player${id}`,
                                        displayName: account?.displayName ?? account?.username ?? `Player${id}`,
                                }
                        }),
                })
        })

'''

    text = text.replace(marker, route + marker, 1)
    print("✓ Added /api/admin/online-players route")
else:
    print("✓ Online players API route already exists")

www.write_text(text)


# ============================================================
# 3. Add client API helper
# ============================================================

api = ROOT / "apps/www/src/client/lib/api.ts"

if api.exists():
    text = api.read_text()

    if "getOnlinePlayers" not in text:
        addition = r'''

export interface OnlinePlayer {
        accountId: number
        username: string
        displayName: string
}

export async function getOnlinePlayers(): Promise<OnlinePlayer[]> {
        const res = await fetch('/api/admin/online-players')

        if (!res.ok) {
                const body = await res.text().catch(() => '')
                throw new Error(body || `HTTP ${res.status}`)
        }

        const body = (await res.json()) as { players?: OnlinePlayer[] }
        return body.players ?? []
}
'''
        text += addition
        api.write_text(text)
        print("✓ Added getOnlinePlayers() client helper")
    else:
        print("✓ getOnlinePlayers() client helper already exists")
else:
    print("WARNING: apps/www/src/client/lib/api.ts not found")


# ============================================================
# 4. Add Online Players dashboard component
# ============================================================

app = ROOT / "apps/www/src/client/App.tsx"
text = app.read_text()

if "function OnlinePlayersForm()" not in text:
    # Put component before Dashboard.
    marker = "function Dashboard({"

    if marker not in text:
        raise SystemExit("ERROR: Could not find Dashboard component in App.tsx")

    component = r'''function OnlinePlayersForm() {
        const [players, setPlayers] = useState<
                Array<{
                        accountId: number
                        username: string
                        displayName: string
                }>
        >([])
        const [loading, setLoading] = useState(true)
        const [error, setError] = useState('')

        const load = async () => {
                setLoading(true)
                setError('')

                try {
                        const res = await fetch('/api/admin/online-players')

                        if (!res.ok) {
                                throw new Error(`HTTP ${res.status}`)
                        }

                        const body = (await res.json()) as {
                                players?: Array<{
                                        accountId: number
                                        username: string
                                        displayName: string
                                }>
                        }

                        setPlayers(body.players ?? [])
                } catch (err) {
                        setError(err instanceof Error ? err.message : 'Failed to load online players.')
                } finally {
                        setLoading(false)
                }
        }

        useEffect(() => {
                void load()

                const timer = window.setInterval(() => {
                        void load()
                }, 10000)

                return () => window.clearInterval(timer)
        }, [])

        return (
                <section className="card">
                        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                                <div>
                                        <h2>Online Players</h2>
                                        <p className="muted">
                                                {loading
                                                        ? 'Loading…'
                                                        : `${players.length} player${players.length === 1 ? '' : 's'} online`}
                                        </p>
                                </div>

                                <button type="button" onClick={() => void load()} disabled={loading}>
                                        Refresh
                                </button>
                        </div>

                        {error && <p className="error">{error}</p>}

                        {!loading && !error && players.length === 0 && (
                                <p className="muted">No players are currently online.</p>
                        )}

                        {players.length > 0 && (
                                <div>
                                        {players.map((player) => (
                                                <div
                                                        key={player.accountId}
                                                        style={{
                                                                display: 'flex',
                                                                justifyContent: 'space-between',
                                                                alignItems: 'center',
                                                                padding: '10px 0',
                                                                borderBottom: '1px solid rgba(255,255,255,0.08)',
                                                        }}
                                                >
                                                        <div>
                                                                <div className="big">
                                                                        {player.displayName || player.username}
                                                                </div>
                                                                <div className="muted">
                                                                        @{player.username}
                                                                </div>
                                                        </div>

                                                        <div className="muted">
                                                                #{player.accountId}
                                                        </div>
                                                </div>
                                        ))}
                                </div>
                        )}
                </section>
        )
}

'''

    text = text.replace(marker, component + marker, 1)
    print("✓ Added OnlinePlayersForm()")
else:
    print("✓ OnlinePlayersForm() already exists")


# ============================================================
# 5. Add dashboard tab
# ============================================================

if "id: 'online-players'" not in text:
    marker = """...(isAdmin()
                        ? ["""

    if marker not in text:
        raise SystemExit("ERROR: Could not find admin dashboard sections")

    replacement = """...(isAdmin()
                        ? [
                                        {
                                                id: 'online-players',
                                                label: 'Online Players',
                                                render: () => <OnlinePlayersForm />,
                                        },"""

    text = text.replace(marker, replacement, 1)
    print("✓ Added Online Players dashboard tab")
else:
    print("✓ Online Players dashboard tab already exists")

app.write_text(text)

print()
print("========================================")
print("ONLINE PLAYERS BUILD CHANGES COMPLETE")
print("========================================")
print()
print("Next:")
print("  pnpm exec tsc --noEmit")
print()
print("Then build www:")
print("  pnpm --filter www build")
print()
print("Do NOT deploy yet if TypeScript reports errors.")
