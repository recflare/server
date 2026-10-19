FROM node:24-trixie

ENV RECFLARE_MONO_APP_PORT=8787
ENV RECFLARE_MONO_INSPECT_PORT=9229
ENV RECFLARE_ECON_APP_PORT=8788
ENV RECFLARE_ECON_INSPECT_PORT=9230
ENV RECFLARE_IMG_APP_PORT=8789
ENV RECFLARE_IMG_INSPECT_PORT=9231
ENV RECFALRE_PORT=443

# Install project system dependencies + concurrently for running the applications in parallel
RUN apt update && \
    apt install -y --no-install-recommends curl git jq nginx gettext-base && \
    rm -rf /var/lib/apt/lists/* && \
    npm install -g pnpm@11.19.0 && \
    npm install -g concurrently

# All runtime data (D1, R2, KV...) is stored under /var/lib/recflare
RUN mkdir -p /var/lib/recflare && chown -R node:node /var/lib/recflare
VOLUME /var/lib/recflare

WORKDIR /build

# Copy and own the project files
COPY . .
RUN chown -R node:node .

USER node:node

# Install project dependencies and link all projects data dir (.wrangler) to point to /var/lib/recflare
# Note: Due to www use of Turnstile, this docker container can not deploy it automatically 
RUN pnpm install --filter=\!www && \
    for dir in ./apps/*/; do ln -s /var/lib/recflare "$dir/.wrangler"; done

ENTRYPOINT [ "/build/docker/entrypoint.sh" ]
