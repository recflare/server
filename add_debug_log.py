#!/usr/bin/env python3
import sys
from pathlib import Path

TARGET = Path("apps/auth/src/auth.app.ts")

ANCHOR = "const grantType = typeof body.grant_type === 'string' ? body.grant_type : ''"

INSERT = """
	logger.info('DEBUG token grant', {
		grantType,
		hasAccountId: typeof body.account_id === 'string' && body.account_id !== '',
		hasUsername: typeof body.username === 'string' && body.username !== '',
		hasPassword: typeof body.password === 'string' && body.password !== '',
		platform: typeof body.platform === 'string' ? body.platform : null,
		platformIdLen: typeof body.platform_id === 'string' ? body.platform_id.length : 0,
	})"""

def main():
    if not TARGET.exists():
        print(f"ERROR: {TARGET} not found. Run this from the repo root (~/rug-room-server).")
        sys.exit(1)

    text = TARGET.read_text()

    if "DEBUG token grant" in text:
        print("Already applied — no changes made.")
        sys.exit(0)

    if ANCHOR not in text:
        print("ERROR: anchor line not found. The file may have changed — paste it and I'll adjust.")
        sys.exit(1)

    new_text = text.replace(ANCHOR, ANCHOR + INSERT, 1)

    backup = TARGET.with_suffix(".ts.bak")
    backup.write_text(text)
    TARGET.write_text(new_text)

    print(f"Backup saved to {backup}")
    print(f"Inserted debug log into {TARGET}")
    print("Next: cd apps/auth && just deploy")

if __name__ == "__main__":
    main()

