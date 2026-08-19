from pathlib import Path

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
elif "roomId: number | null" in text and "roomInstanceId: number | null" in text:
    print("✓ OnlinePlayer already has room fields")
else:
    raise SystemExit("ERROR: Could not find OnlinePlayer interface")


old_ui = """                                                                                <div className="muted">
                                                                                        @{player.username}
                                                                                </div>
                                                                        </div>

                                                                        <span className="muted">
                                                                                #{player.accountId}
                                                                        </span>"""

new_ui = """                                                                                <div className="muted">
                                                                                        @{player.username}
                                                                                </div>
                                                                                <div className="muted">
                                                                                        Room:{' '}
                                                                                        {player.roomId === null
                                                                                                ? 'Lobby'
                                                                                                : `#${player.roomId} · Instance #${player.roomInstanceId}`}
                                                                                </div>
                                                                        </div>

                                                                        <span className="muted">
                                                                                #{player.accountId}
                                                                        </span>"""

if old_ui in text:
    text = text.replace(old_ui, new_ui, 1)
    print("✓ Added room information to Online Players UI")
elif "player.roomId" in text and "player.roomInstanceId" in text:
    print("✓ Room information already displayed")
else:
    raise SystemExit("ERROR: Could not find Online Players UI block")

p.write_text(text)

print()
print("========================================")
print("ONLINE PLAYERS ROOM UI FIXED")
print("========================================")
