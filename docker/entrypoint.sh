#!/usr/bin/env bash
set -e

if [[ -z "$RECFALRE_DOMAIN" ]]; then
    echo "Error: RECFALRE_DOMAIN is required"
    exit 1
fi

if [[ -z "$RECFALRE_SSL_CRT" ]]; then
    echo "Error: RECFALRE_SSL_CRT is required"
    exit 1
fi

if [[ -z "$RECFALRE_SSL_KEY" ]]; then
    echo "Error: RECFALRE_SSL_KEY is required"
    exit 1
fi

pushd apps/mono > /dev/null

# Setup JWT_SECRET for workers, ignoring errors as that may mean the secret was already created
pnpm wrangler secrets-store secret create local --name JWT_SECRET --scopes workers --value "$(openssl rand -base64 32)" || true

popd > /dev/null

# Apply migrations to local instance, must be run sequentially as wrangler locks the database file
pnpm -r --filter=\!www run --sequential migrate --local

# Configure nginx site from the template
envsubst '$RECFALRE_DOMAIN $RECFALRE_PORT $RECFALRE_SSL_CRT $RECFALRE_SSL_KEY $RECFLARE_MONO_APP_PORT $RECFLARE_ECON_APP_PORT $RECFLARE_IMG_APP_PORT' < docker/nginx.template > docker/nginx.conf

# Start the mono, econ and img workers in parallel as well as the nginx reverse proxy
# due to using wrangler dev scheduled items don't run, curl the schedule endpoint periodically to run the scheduled items
exec concurrently --raw --kill-others-on-fail \
    'nginx -c "$(pwd)/docker/nginx.conf" -g "daemon off;"' \
    'cd apps/mono && pnpm wrangler dev --var NAME:"mono" --port "$RECFLARE_MONO_APP_PORT" --inspector-port "$RECFLARE_MONO_INSPECT_PORT" --var DOMAIN:"$RECFALRE_DOMAIN" --var SUBDOMAINS:"{\"moderation\":\"api\"}" $@' \
    'cd apps/econ && pnpm wrangler dev --var NAME:"econ" --port "$RECFLARE_ECON_APP_PORT" --inspector-port "$RECFLARE_ECON_INSPECT_PORT" --var DOMAIN:"$RECFALRE_DOMAIN" $@' \
    'cd apps/img && pnpm wrangler dev --var NAME:"img" --port "$RECFLARE_IMG_APP_PORT" --inspector-port "$RECFLARE_IMG_INSPECT_PORT" --var DOMAIN:"$RECFALRE_DOMAIN" $@' \
    'sleep 30; while true; do curl --silent "http://localhost:$RECFLARE_MONO_APP_PORT/cdn-cgi/handler/scheduled"; sleep 300; done'
