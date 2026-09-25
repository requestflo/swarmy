# demo.swarmy.dev: the public "Live demo". This is the dashboard built in demo
# mode (VITE_SWARMY_DEMO=1). It runs on in-memory fake data with no controller,
# no database and no sign-in, and is served as static files by Caddy. Build from
# the repo root:
#   docker build -f apps/app/demo.Dockerfile -t swarmy/demo .
# (swarmy builds it the same way from apps/app/demo.swarmy.yaml.)
#
# apps/app/demo.Dockerfile.dockerignore (BuildKit's per-Dockerfile ignore file)
# replaces the root .dockerignore for this build, to keep the context small.

# ── Stage 1: build the static demo ──────────────────────────────────────────
# The output is plain static files, so build once on the build host's arch.
FROM --platform=$BUILDPLATFORM oven/bun:1.3.14-alpine AS build
WORKDIR /app
COPY package.json bun.lock tsconfig.base.json ./
# bun checks the whole lockfile graph, so every workspace manifest must be
# present. Only the dashboard's source closure is copied below.
COPY apps/agent/package.json apps/agent/
COPY apps/api/package.json apps/api/
COPY apps/app/package.json apps/app/
COPY apps/cli/package.json apps/cli/
COPY apps/dns/package.json apps/dns/
COPY apps/web/package.json apps/web/
COPY packages/abac/package.json packages/abac/
COPY packages/api-rest/package.json packages/api-rest/
COPY packages/app-auth/package.json packages/app-auth/
COPY packages/app-config/package.json packages/app-config/
COPY packages/auth/package.json packages/auth/
COPY packages/core/package.json packages/core/
COPY packages/db/package.json packages/db/
COPY packages/devkit/package.json packages/devkit/
COPY packages/dns/package.json packages/dns/
COPY packages/ingress/package.json packages/ingress/
COPY packages/mesh/package.json packages/mesh/
COPY packages/rum/package.json packages/rum/
COPY packages/templates/package.json packages/templates/
COPY packages/trpc/package.json packages/trpc/
COPY packages/ui/package.json packages/ui/
RUN bun install --filter @swarmy/app --ignore-scripts
# @swarmy/trpc is imported for its AppRouter type only, which Vite erases, so
# its source (and the Prisma client behind it) isn't needed.
COPY packages/abac packages/abac
COPY packages/app-config packages/app-config
COPY packages/auth packages/auth
COPY packages/core packages/core
COPY packages/templates packages/templates
COPY packages/ui packages/ui
COPY apps/app apps/app
# Where the demo banner links back to (the marketing site + its install docs).
ARG VITE_SWARMY_SITE_URL=https://swarmy.dev
ENV VITE_SWARMY_SITE_URL=${VITE_SWARMY_SITE_URL}
RUN cd apps/app && bun run build:demo

# ── Stage 2: serve it ───────────────────────────────────────────────────────
FROM caddy:2-alpine
COPY apps/app/demo.Caddyfile /etc/caddy/Caddyfile
COPY --from=build /app/apps/app/dist/demo /srv
EXPOSE 8080
HEALTHCHECK --interval=30s --timeout=3s CMD wget -qO- http://127.0.0.1:8080/ >/dev/null || exit 1
