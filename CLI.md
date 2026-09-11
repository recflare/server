# Admin CLI

Operator tools for accounts on the shared `recflare` D1 database, exposed as an
`admin` command group on the repo's `runx` CLI. Each command shells out to
`wrangler d1 execute recflare` — no running worker or auth token needed.

Run from anywhere in the repo:

```sh
bun runx admin <command> [options]
```

## Commands

### `set-password` — set (or replace) an account's login password

```sh
bun runx admin set-password --account 1
bun runx admin set-password --username alice --remote
```

The new password is taken from `--password <pw>`, else from piped stdin, else
prompted interactively.

```sh
# interactive (prompts, hidden)
bun runx admin set-password --account 1

# non-interactive / scripted
echo "s3cret-pw" | bun runx admin set-password --account 1
bun runx admin set-password --account 1 --password "s3cret-pw"
```

### `clear-password` — remove an account's password

Leaves the account with no login credential (only platform login).

```sh
bun runx admin clear-password --username alice
```

### Staff role grants — grant or revoke a role

All staff roles are off by default; operator commands grant them. Available commands are `grant-developer`, `grant-moderator`, `grant-community-team`, and `grant-volunteer-moderator`. A granted role backs its
`GET /role/<role>/:id` lookup **and** rides in the login token's `role` claim, so it
takes effect on the account's next login or token refresh.

```sh
bun runx admin grant-developer --account 1
bun runx admin grant-developer --account 1 --revoke
bun runx admin grant-moderator --username alice --remote
```

### `lookup` — print an account

```sh
bun runx admin lookup --account 1
bun runx admin lookup --username alice
```

Prints id, username, platform, platform id, created/last-login times, and whether
the account has a password, the developer role, moderator role, Community Team role, and Volunteer Moderator role.

## Options

### Selecting an account

Every command targets exactly one account, by **either**:

- `--account <id>` — numeric account id
- `--username <name>` — username (case-insensitive)

### Choosing the database

- `--local` — the local dev database (**the default**)
- `--remote` — the deployed (production) database

Passing both is an error. `--remote` requires `RECFLARE_D1` in the gitignored root
`.env` (see `.env.example`) and a wrangler login with access to the account.

## Notes

- Password hashing matches the auth worker exactly (PBKDF2-SHA256), so a password
  set here verifies at login.
- A command that matches no account exits non-zero with `no account found for …`.
- Local writes target `apps/auth`'s dev D1 state; run `bun turbo -F auth migrate -- --local`
  first if the local database hasn't been migrated yet.
