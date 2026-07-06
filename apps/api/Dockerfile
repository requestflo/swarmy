# swarmy controller — API + agent WS gateway + bundled dashboard, one image.
# Build from the repo root:
#   docker build -f apps/api/Dockerfile -t swarmy/controller .
#
# The dashboard SPA (apps/app) is built in stage 1 and served same-origin by the
# controller (SWARMY_STATIC_DIR), so a self-host install ships ONE artifact.

# ── Stage 1: build the dashboard SPA ────────────────────────────────────────
FROM oven/bun:1.3-alpine AS spa
WORKDIR /app
COPY package.json bun.lock ./
# Root tsconfigs — packages/db/tsconfig.json extends ../../tsconfig.base.json, and
# Prisma 7 loads prisma.config.ts (TS) during `db:generate`, so both must be present.
COPY tsconfig.base.json tsconfig.json ./
# Whole workspace manifests + sources: the SPA pulls @swarmy/{ui,core,auth,trpc}
# and their transitive deps, and @swarmy/trpc's types reach @swarmy/db's client.
COPY packages packages
COPY apps/app/package.json apps/app/
RUN bun install || bun install --no-frozen-lockfile
COPY apps/app apps/app
ENV CHECKPOINT_DISABLE=1 PRISMA_HIDE_UPDATE_MESSAGE=1
RUN bun --filter @swarmy/db db:generate
RUN bun --filter @swarmy/app build

# ── Stage 1b: compile the agent host binaries ───────────────────────────────
# --platform=$BUILDPLATFORM: run ONCE on the build host and cross-compile both
# linux targets (bun downloads the target runtimes), instead of per-arch under
# QEMU. The controller serves these at /install/bin/<platform> so the systemd
# install backend + agent self-update work fully self-hosted.
FROM --platform=$BUILDPLATFORM oven/bun:1.3-alpine AS agentbin
WORKDIR /app
COPY package.json bun.lock ./
COPY tsconfig.base.json tsconfig.json ./
COPY packages packages
COPY apps/agent/package.json apps/agent/
RUN bun install || bun install --no-frozen-lockfile
COPY apps/agent apps/agent
COPY scripts/build-agent-binaries.ts scripts/
ARG SWARMY_COMMIT=dev
RUN SWARMY_COMMIT=${SWARMY_COMMIT} bun run scripts/build-agent-binaries.ts /app/agent-binaries

# ── Stage 2: the controller runtime ─────────────────────────────────────────
FROM oven/bun:1.3-alpine
WORKDIR /app

# Workspace manifests first for a cached install.
COPY package.json bun.lock ./
# Root tsconfigs needed by `prisma generate` (see SPA stage note).
COPY tsconfig.base.json tsconfig.json ./
COPY packages packages
COPY apps/api/package.json apps/api/
RUN bun install || bun install --no-frozen-lockfile

# Controller source (packages already copied above for the install layer).
COPY apps/api apps/api

# Generate the Prisma client into packages/db/src/generated.
ENV CHECKPOINT_DISABLE=1 PRISMA_HIDE_UPDATE_MESSAGE=1
RUN bun --filter @swarmy/db db:generate

# Bundle the built dashboard; the controller serves it same-origin.
COPY --from=spa /app/apps/app/dist /app/public
ENV SWARMY_STATIC_DIR=/app/public

# Agent host binaries + sha256 manifest, served at /install/bin/<platform> —
# the install + self-update paths never leave this controller.
COPY --from=agentbin /app/agent-binaries /app/agent-binaries
ENV SWARMY_AGENT_BIN_DIR=/app/agent-binaries

# Bake the build commit so `GET /version` reports it.
ARG SWARMY_COMMIT=dev
ENV SWARMY_COMMIT=${SWARMY_COMMIT}

ENV NODE_ENV=production PORT=3001
EXPOSE 3001

# Entrypoint expands Docker-secret *_FILE vars and composes DATABASE_URL (standard
# tier) before exec'ing CMD. CMD is overridable for the bootstrap one-shots
# (e.g. `docker run … <image> bun run apps/api/src/bootstrap/seed.ts`).
COPY apps/api/docker-entrypoint.sh /usr/local/bin/swarmy-entrypoint
RUN chmod +x /usr/local/bin/swarmy-entrypoint
ENTRYPOINT ["/usr/local/bin/swarmy-entrypoint"]
CMD ["bun", "run", "apps/api/src/index.ts"]
