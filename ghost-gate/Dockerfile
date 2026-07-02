# Tinybird datafiles must stay in sync with Ghost — bump GHOST_VERSION when upgrading Ghost.
ARG GHOST_VERSION=6-alpine
FROM ghost:${GHOST_VERSION} AS ghost-tinybird
USER root
RUN mkdir -p /export/tinybird && \
  cp -a /var/lib/ghost/current/core/server/data/tinybird/. /export/tinybird/

FROM node:22-bookworm-slim

# wget is used at runtime by the Docker healthcheck (lightest option already present on
# most base images).  curl is required transiently because the Tinybird install script
# shells out to `curl` — it is purged after the install so it does not ship in the final
# image layer.
RUN apt-get update && apt-get install -y --no-install-recommends \
    bash \
    wget \
    curl \
    jq \
    ca-certificates \
    && curl -sSf https://tinybird.co | sh \
    && apt-get purge -y curl \
    && apt-get autoremove -y \
    && rm -rf /var/lib/apt/lists/*
ENV PATH="/root/.local/bin:${PATH}"

WORKDIR /data/tinybird
COPY --from=ghost-tinybird /export/tinybird ./
WORKDIR /app

COPY tinybird/tb-wrapper /usr/local/bin/tb-wrapper
COPY tinybird/getTokens.sh /usr/local/bin/get-tokens
RUN chmod +x /usr/local/bin/tb-wrapper /usr/local/bin/get-tokens

COPY ghost-gate/package.json ghost-gate/package-lock.json ./
RUN npm ci --omit=dev

COPY ghost-gate/server.js ./
COPY ghost-gate/entrypoint.sh /app/entrypoint.sh
RUN chmod +x /app/entrypoint.sh

ENV PORT=3989
EXPOSE 3989

ENTRYPOINT ["/app/entrypoint.sh"]
