#!/usr/bin/env python3
"""
Inserts a diagnostic log line right after the password hash comparison in
apps/auth/src/auth.app.ts, so we can see whether username resolution, stored
hash presence, or the actual password comparison is what's failing.

Usage (from your repo root, e.g. ~/rug-room-server):
    python3 add_password_debug.py
"""
import sys
from pathlib import Path

TARGET = Path("apps/auth/src/auth.app.ts")

OLD_BLOCK = """\t\t\t\tconst storedHash = await getPasswordHash(c.env.DB, resolvedId)
\t\t\t\tconst password = typeof body.password === 'string' ? body.password : ''
\t\t\t\tif (!storedHash || !(await verifyPassword(password, storedHash))) {"""

NEW_BLOCK = """\t\t\t\tconst storedHash = await getPasswordHash(c.env.DB, resolvedId)
\t\t\t\tconst password = typeof body.password === 'string' ? body.password : ''
\t\t\t\tconst passwordMatches = storedHash ? await verifyPassword(password, storedHash) : false
\t\t\t\tlogger.info('DEBUG password check', {
\t\t\t\t\tresolvedId,
\t\t\t\t\thasStoredHash: !!storedHash,
\t\t\t\t\tpasswordMatches,
\t\t\t\t})
\t\t\t\tif (!storedHash || !passwordMatches) {"""

def main():
    if not TARGET.exists():
        print(f"ERROR: {TARGET} not found. Run this from the repo root (~/rug-room-server).")
        sys.exit(1)

    text = TARGET.read_text()

    if "DEBUG password check" in text:
        print("Already applied — no changes made.")
        sys.exit(0)

    if OLD_BLOCK not in text:
        print("ERROR: anchor block not found (file may have changed). Paste the")
        print("current lines around 'getPasswordHash' and I'll adjust the script.")
        sys.exit(1)

    new_text = text.replace(OLD_BLOCK, NEW_BLOCK, 1)

    backup = TARGET.with_suffix(".ts.bak2")
    backup.write_text(text)
    TARGET.write_text(new_text)

    print(f"Backup saved to {backup}")
    print(f"Inserted password-check debug log into {TARGET}")
    print("Next: cd apps/auth && just deploy")

if __name__ == "__main__":
    main()
