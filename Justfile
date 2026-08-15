# This Justfile isn't strictly necessary, but it's
# a convenient way to run commands in the repo
# without needing to remember all commands.

[private]
@help:
  just --list

# Aliases
alias new-pkg := new-package
alias new-worker := gen
alias up := update
alias i := install

# =============================== #
#         DEV COMMANDS            #
# =============================== #

# Install dependencies
[group('1. dev')]
install:
  pnpm install --child-concurrency=10

# Check for issues with deps, lint, types, format, etc.
[group('1. dev')]
[positional-arguments]
[no-cd]
check *args:
  bun runx check "$@"

# Fix issues with deps, lint, format, etc.
[group('1. dev')]
[positional-arguments]
[no-cd]
fix *args:
  bun runx fix "$@"

[group('1. dev')]
[positional-arguments]
[no-cd]
test *args:
  bun vitest "$@"

[group('1. dev')]
[positional-arguments]
[no-cd]
build *args:
  bun turbo build "$@"

# =============================== #
#       LOCAL DEV COMMANDS        #
# =============================== #

# Run dev script. Runs turbo dev if not in a specific project directory.
[group('2. local dev')]
[positional-arguments]
[no-cd]
dev *args:
  bun runx dev "$@"

# Run Workers in preview mode (if available)
[group('2. local dev')]
[no-cd]
preview:
  bun run preview

# Deploy Workers
[group('2. local dev')]
[positional-arguments]
[no-cd]
deploy *args:
  bun turbo deploy "$@"

# Deploy the combined `mono` worker: every service in ONE Worker, routed on the first
# path segment (https://<domain>/rooms). It's an alternative to the split deployment
# above — for debugging, or for running the whole server as a single service — so it has
# its own command and `just deploy` leaves it alone. Put it on the apex of your domain
# with RECFLARE_SUBDOMAINS='{"mono":"@"}'; see .env.example.
[group('2. local dev')]
[positional-arguments]
[no-cd]
deploy-mono *args:
  bun turbo -F mono deploy:mono "$@"

# Apply D1 migrations (rooms + auth own them). Defaults to --remote; pass `-- --local`
# for the dev db. Scope with -F, e.g. `just migrate -F rooms`.
[group('2. local dev')]
[positional-arguments]
[no-cd]
migrate *args:
  bun turbo migrate "$@"

# =============================== #
#       GENERATOR COMMANDS        #
# =============================== #

[group('3. generator')]
[positional-arguments]
gen *args:
  bun turbo gen "$@"

[group('3. generator')]
[positional-arguments]
new-package *args:
  bun turbo gen new-package "$@"

# =============================== #
#        UTILITY COMMANDS         #
# =============================== #

# CLI in packages/tools for updating deps, pnpm, etc.
[group('4. utility')]
[positional-arguments]
update *args:
  bun runx update "$@"

# CLI in packages/tools for running commands in the repo.
[group('4. utility')]
[positional-arguments]
runx *args:
  bun runx "$@"

# Admin account tools (set-password, clear-password, grant-developer, lookup).
# Run `just admin --help` for usage and examples. See CLI.md.
[group('4. utility')]
[positional-arguments]
[no-cd]
admin *args:
  bun runx admin "$@"
