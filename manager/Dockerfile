# The ghost-docker manager image.
#
# Build from the repository root, which is the context:
#
#   docker build -f manager/Dockerfile -t ghost-docker:dev .
#
# It holds the CLI, a Docker client with Compose, and the stack's own files.
# The launchers (ghost-docker, ghost-docker.ps1) are the supported way to run
# it; see docs/ghost-cli-replacement.md §2.10 for the contract between them.

FROM docker:28-cli@sha256:625d9431a9f54c5a2bc90f24f0e1c3d55b1349fd857dd85035f98c2c9acbdd4d AS docker

FROM node:22-alpine@sha256:0a7108bf6c7bf5de370ffb1a3ed6be93d405b43ff159f681a8d18c0e2bc2e402

# setpriv drops to the caller's uid and gid with the Docker socket's group
# added, which su-exec cannot do for a uid that has no passwd entry.
RUN apk add --no-cache setpriv

# The manager runs Compose itself, with its own client, against the host's
# daemon through the mounted socket.
COPY --from=docker /usr/local/bin/docker /usr/local/bin/docker
COPY --from=docker /usr/local/libexec/docker/cli-plugins/docker-compose \
    /usr/local/libexec/docker/cli-plugins/docker-compose

WORKDIR /opt/ghost-docker/manager
COPY manager/package.json manager/package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force

# TypeScript is run directly by Node, which strips the types: there is no
# build step, and what is in the image is the source that was reviewed.
COPY manager/src ./src
COPY --chmod=0755 manager/entrypoint.sh /usr/local/bin/ghost-docker-entrypoint

# The stack. `install` writes these into a site directory; a release of the
# stack is this image.
COPY compose.yml compose.ipv6.yml .env.example ghost.env.example /opt/ghost-docker/stack/
COPY caddy /opt/ghost-docker/stack/caddy
COPY mysql-init /opt/ghost-docker/stack/mysql-init
COPY tinybird /opt/ghost-docker/stack/tinybird

ARG GD_VERSION=dev
ARG GD_COMMIT=
RUN printf '{"version":"%s","commit":"%s"}\n' "$GD_VERSION" "$GD_COMMIT" >/opt/ghost-docker/VERSION.json

ENV NODE_ENV=production \
    NODE_OPTIONS=--disable-warning=ExperimentalWarning

LABEL org.opencontainers.image.source="https://github.com/TryGhost/ghost-docker" \
      org.opencontainers.image.description="ghost-docker manager: the CLI and stack files for self-hosting Ghost with Docker Compose" \
      org.opencontainers.image.licenses="MIT"

ENTRYPOINT ["ghost-docker-entrypoint"]
CMD ["help"]
