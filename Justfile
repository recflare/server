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

# Apply D1 migrations (every worker with a `migrate` script). Defaults to --remote; pass `-- --local`
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

# Admin account tools (set-password, clear-password, grant-developer, grant-plus, lookup).
# Run `just admin --help` for usage and examples. See CLI.md.
[group('4. utility')]
[positional-arguments]
[no-cd]
admin *args:
  bun runx admin "$@"

# Credit every Rec Room Plus subscriber's RecCenterTokens balance by <amount>. Defaults to
# --local; pass --remote for production, --dry-run to only list who'd be credited. See CLI.md.
[group('4. utility')]
[positional-arguments]
[no-cd]
reload-plus *args:
  bun runx admin reload-plus "$@"

# Load the first-party custom avatar items (apps/econ/static/db/2025-1-cai.json by default)
# into the custom_avatar_item table. Merges: existing ids are replaced, nothing is deleted.
# Defaults to --local; pass --remote for production, --dry-run to only validate. Prices come
# from the storefront dump via apps/api/scripts/price-custom-avatar-items.ts. See CLI.md.
[group('4. utility')]
[positional-arguments]
[no-cd]
cai-load *args:
  bun runx admin cai-load "$@"

# Copy the old RECFLARE_PLAYER_SETTINGS KV namespace into the player_settings D1 table (one-time
# upgrade for deployments that predate the move). Merges; existing rows keep what they have.
# Defaults to --local; pass --remote for production, --dry-run to only count. See CLI.md.
[group('4. utility')]
[positional-arguments]
[no-cd]
settings-import-kv *args:
  bun runx admin settings-import-kv "$@"
