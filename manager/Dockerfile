# The ghost-docker manager image.
#
# Build from the repository root, which is the context:
#
#   docker build -f manager/Dockerfile -t ghost-docker:dev .
#
# It holds the CLI, Compose, and the stack's own files.
# The launcher (ghost-docker) is the supported way to run it; see
# docs/ghost-cli-replacement.md §2.10 for the contract between them.

FROM docker:28-cli@sha256:625d9431a9f54c5a2bc90f24f0e1c3d55b1349fd857dd85035f98c2c9acbdd4d AS docker

# Production dependencies, installed by the pnpm version pinned in
# package.json (`packageManager`). Node 26 no longer bundles corepack, so it
# is installed first, pinned too. Only node_modules, without
# type declarations, source maps or docs, and the node binary leave this stage.
FROM node:26-alpine@sha256:0b36e8c136b94cd4fcf02188228e76c31ad5872eef3fec8cbd2eee500cfd9e80 AS deps
WORKDIR /opt/ghost-docker/manager
COPY manager/package.json manager/pnpm-lock.yaml ./
RUN npm install -g corepack@0.36.0 \
    && corepack enable \
    && corepack install \
    && pnpm install --frozen-lockfile --prod \
    && find node_modules/.pnpm \( -name '*.d.ts' -o -name '*.d.cts' -o -name '*.d.mts' -o -name '*.map' -o -name '*.md' \) -delete

# The integration tests' image (manager/test/integration/run.sh), never
# shipped: `docker build` without --target stops at the last stage. Node and
# the production dependencies above, Compose from the same release, and this
# repository's own layout under /opt/ghost-docker, so the tests find
# compose.yml and the stack files where the unit tests do. The manager joins
# its own container to a site's network, so the tests have to run in one.
FROM deps AS integration
COPY --from=docker /usr/local/libexec/docker/cli-plugins/docker-compose \
    /usr/local/bin/docker-compose
WORKDIR /opt/ghost-docker
COPY compose.yml compose.ipv6.yml .env.example ghost.env.example ./
COPY caddy ./caddy
COPY mysql-init ./mysql-init
WORKDIR /opt/ghost-docker/manager
COPY manager/src ./src
COPY manager/templates ./templates
COPY manager/test/integration ./test/integration
COPY manager/test/dotenv.ts ./test/dotenv.ts
ENTRYPOINT ["node", "--test", "--test-timeout=900000", "test/integration/*.test.ts"]

# Plain Alpine with Node's binary copied in: the image only runs node, and the
# Node image's npm, npx and C headers would be dead weight. Keep this Alpine on
# the release the Node image above is built on, for its libstdc++.
FROM alpine:3.24@sha256:294b683cb724975bec92580e1e685676bd4b50bda910ddb8c51d4cabeaec77e6

RUN apk add --no-cache libstdc++ libgcc
COPY --from=deps /usr/local/bin/node /usr/local/bin/node

# setpriv drops to the caller's uid and gid with the Docker socket's group
# added, which su-exec cannot do for a uid that has no passwd entry.
RUN apk add --no-cache setpriv

# In a site that is a checkout of the repository, a backup records the commit
# checked out, and a restore over it checks it is the same one.
RUN apk add --no-cache git

# The manager talks to the daemon over the Engine API on the mounted socket.
# Compose has no API and is run as a program: the plugin binary also runs on
# its own as `docker-compose`, so the Docker CLI itself is not needed.
COPY --from=docker /usr/local/libexec/docker/cli-plugins/docker-compose \
    /usr/local/bin/docker-compose

WORKDIR /opt/ghost-docker/manager
COPY manager/package.json ./
COPY --from=deps /opt/ghost-docker/manager/node_modules ./node_modules

# TypeScript is run directly by Node, which strips the types: there is no
# build step, and what is in the image is the source that was reviewed.
COPY manager/src ./src
COPY manager/templates ./templates
COPY --chmod=0755 manager/entrypoint.sh /usr/local/bin/ghost-docker-entrypoint

# The stack. `install` writes these into a site directory; a release of the
# stack is this image.
COPY compose.yml compose.ipv6.yml .env.example ghost.env.example /opt/ghost-docker/stack/
COPY caddy /opt/ghost-docker/stack/caddy
COPY mysql-init /opt/ghost-docker/stack/mysql-init
COPY tinybird /opt/ghost-docker/stack/tinybird
# The launcher, which install copies into an image-mode site pinned to this
# image's digest.
COPY --chmod=0755 ghost-docker /opt/ghost-docker/launcher/ghost-docker

ARG GD_VERSION=dev
ARG GD_COMMIT=
RUN printf '{"version":"%s","commit":"%s"}\n' "$GD_VERSION" "$GD_COMMIT" >/opt/ghost-docker/VERSION.json

ENV NODE_ENV=production

LABEL org.opencontainers.image.source="https://github.com/TryGhost/ghost-docker" \
      org.opencontainers.image.description="ghost-docker manager: the CLI and stack files for self-hosting Ghost with Docker Compose" \
      org.opencontainers.image.licenses="MIT"

ENTRYPOINT ["ghost-docker-entrypoint"]
CMD ["help"]
