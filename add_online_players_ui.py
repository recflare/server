from pathlib import Path

path = Path("apps/www/src/client/App.tsx")
text = path.read_text()

# ============================================================
# 1. Add fetchOnlinePlayers() immediately after coachMessageAll
# ============================================================

if "const fetchOnlinePlayers" in text:
    print("✓ fetchOnlinePlayers() already exists")
else:
    start = text.find("const coachMessageAll")

    if start == -1:
        raise SystemExit("ERROR: Could not find coachMessageAll in App.tsx")

    # Find the end of the coachMessageAll declaration.
    end = text.find("\n\n", start)

    if end == -1:
        raise SystemExit("ERROR: Could not find end of coachMessageAll")

    addition = """

interface OnlinePlayer {
        accountId: number
        username: string
        displayName: string
}

const fetchOnlinePlayers = (): Promise<{ players: OnlinePlayer[] }> =>
        call<{ players: OnlinePlayer[] }>('/api/admin/online-players', {
                authed: true,
        })
"""

    text = text[:end] + addition + text[end:]
    print("✓ Added fetchOnlinePlayers()")


# ============================================================
# 2. Add OnlinePlayersForm
# ============================================================

if "function OnlinePlayersForm()" in text:
    print("✓ OnlinePlayersForm() already exists")
else:
    marker = "function CoachMessageForm()"

    pos = text.find(marker)

    if pos == -1:
        raise SystemExit("ERROR: Could not find CoachMessageForm()")

    component = """function OnlinePlayersForm() {
        const [players, setPlayers] = useState<OnlinePlayer[]>([])
        const [loading, setLoading] = useState(true)
        const [error, setError] = useState('')

        const load = useCallback(async () => {
                setLoading(true)
                setError('')

                try {
                        const result = await fetchOnlinePlayers()
                        setPlayers(result.players ?? [])
                } catch (e) {
                        setError(e instanceof Error ? e.message : 'Failed to load online players.')
                } finally {
                        setLoading(false)
                }
        }, [])

        useEffect(() => {
                void load()
        }, [load])

        return (
                <section className="card">
                        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: '1rem' }}>
                                <div>
                                        <h2>Online Players</h2>
                                        <p className="muted">
                                                Players with an active presence right now.
                                        </p>
                                </div>

                                <button type="button" onClick={() => void load()} disabled={loading}>
                                        {loading ? 'Refreshing…' : 'Refresh'}
                                </button>
                        </div>

                        {error && <p className="error">{error}</p>}

                        {!loading && !error && (
                                <>
                                        <p className="big">
                                                {players.length} online player{players.length === 1 ? '' : 's'}
                                        </p>

                                        {players.length === 0 ? (
                                                <p className="muted">Nobody is currently online.</p>
                                        ) : (
                                                <div>
                                                        {players.map((player) => (
                                                                <div
                                                                        key={player.accountId}
                                                                        style={{
                                                                                display: 'flex',
                                                                                justifyContent: 'space-between',
                                                                                alignItems: 'center',
                                                                                padding: '0.75rem 0',
                                                                                borderBottom: '1px solid rgba(255,255,255,0.08)',
                                                                        }}
                                                                >
                                                                        <div>
                                                                                <strong>
                                                                                        {player.displayName || player.username}
                                                                                </strong>
                                                                                <div className="muted">
                                                                                        @{player.username}
                                                                                </div>
                                                                        </div>

                                                                        <span className="muted">
                                                                                #{player.accountId}
                                                                        </span>
                                                                </div>
                                                        ))}
                                                </div>
                                        )}
                                </>
                        )}
                </section>
        )
}

"""

    text = text[:pos] + component + text[pos:]
    print("✓ Added OnlinePlayersForm()")


# ============================================================
# 3. Add the tab inside My Account
# ============================================================

if "id: 'online-players'" in text:
    print("✓ Online Players tab already exists")
else:
    # Locate the Password tab without relying on whitespace.
    needle = "id: 'password'"

    pos = text.find(needle)

    if pos == -1:
        raise SystemExit("ERROR: Could not find Password tab")

    # Find the end of that object.
    line_end = text.find("\n", pos)

    if line_end == -1:
        raise SystemExit("ERROR: Could not find Password tab line")

    # Find the beginning of the next line and insert there.
    insertion = """                                        { id: 'online-players', label: 'Online Players', render: () => <OnlinePlayersForm /> },
"""

    text = text[:line_end + 1] + insertion + text[line_end + 1:]
    print("✓ Added Online Players tab to My Account")


path.write_text(text)

print()
print("========================================")
print("ONLINE PLAYERS UI COMPLETE")
print("========================================")
print()
print("The tab is inside My Account.")
print("It is alongside Username / Email / Password.")
print()
print("Next:")
print("  pnpm exec tsc --noEmit")
