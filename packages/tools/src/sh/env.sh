#!/bin/sh
# Shared by the run-wrangler-* scripts. Source it, don't run it:
#
#   . "$(git rev-parse --show-toplevel)/packages/tools/src/sh/env.sh"
#
# It lives outside bin/ on purpose — package.json sets directories.bin to bin/, so anything
# in there becomes a runnable command in node_modules/.bin.
#
# RecFlare keeps a single gitignored .env at the repo root (see .env.example) holding
# everything an operator has to supply: their domain, the ids of the storage resources they
# created, and any tuning knobs they want to change. That one file feeds both `just deploy`
# and `just dev`, so a value is never configured twice.

# Names the deploy scripts consume themselves — the domain and the ids of the operator's
# Cloudflare resources. Everything else in .env is worker config; see recflare_vars.
RECFLARE_RESERVED="DOMAIN SUBDOMAINS D1 KV SECRETS_STORE ENV_LOADED"

# Load the root .env, letting anything already in the environment win. The file is a local
# convenience; CI exports the same names as secrets and must not be clobbered by a stray
# .env in a checkout. Safe to call more than once.
recflare_load_env() {
	[ -z "${RECFLARE_ENV_LOADED:-}" ] || return 0
	RECFLARE_ENV_LOADED=1

	_env_file="$(git rev-parse --show-toplevel)/.env"
	[ -f "$_env_file" ] || return 0

	# `export -p` re-emits the already-exported values as quoted assignments, so we can put
	# them back after the file has had its say.
	_preset=$(export -p | grep -E '(^|[[:space:]])RECFLARE_[A-Za-z0-9_]+=' || true)
	set -a
	. "$_env_file"
	set +a
	eval "$_preset"

	unset _env_file _preset
}

# Echo the `--var` flags carrying the operator's tuning knobs, e.g.
# " --var MAX_ACCOUNTS_PER_IP:10 --var STARTING_TOKENS:250".
#
# This is a convention, not a list kept here: every RECFLARE_<VAR> in the environment that
# isn't one of the RECFLARE_RESERVED deploy inputs above is handed to the worker as
# `--var <VAR>:<value>`. So RECFLARE_MAX_ACCOUNTS_PER_IP=10 gives every worker
# MAX_ACCOUNTS_PER_IP=10 — the workers that don't read it simply ignore it, and two workers
# that read the same knob agree on it for free. Adding a knob means declaring it in the
# worker's context.ts, reading it there, and documenting it in .env.example; these scripts
# never need to change and stay free of any knowledge of specific app names.
#
# Every knob is optional: unset means no `--var` at all, so the worker falls back to the
# default constant in its own source, and deleting a line from .env really does restore that
# default on the next deploy. (Vars are replaced wholesale by a deploy — which is exactly
# why a value set in the Cloudflare dashboard doesn't survive one.)
#
# Values must not contain whitespace: the result is a flag list the caller word-splits.
# Knobs are numbers and short unquoted strings (`2=MyHub`), and real secrets belong in the
# Secrets Store (which is bound in wrangler.jsonc, not passed through here), so this hasn't
# been worth the ceremony of an array. Vars also arrive in the Worker as strings (`--var
# X:3` is "3", not 3), which is why a numeric knob is parsed through `intVar` rather than
# read as a number.
recflare_vars() {
	# The sed only ever yields [A-Z0-9_] names, so the eval below can't expand anything else.
	for _name in $(env | sed -n 's/^RECFLARE_\([A-Z0-9_][A-Z0-9_]*\)=.*/\1/p'); do
		case " $RECFLARE_RESERVED " in
		*" $_name "*) continue ;;
		esac

		eval "_value=\${RECFLARE_${_name}}"
		[ -n "$_value" ] || continue
		printf ' --var %s:%s' "$_name" "$_value"
	done

	unset _name _value
}
