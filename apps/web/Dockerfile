# swarmy.dev — the marketing site + docs, prerendered to static files and
# served by Caddy. Build from the repo root:
#   docker build -f apps/web/Dockerfile -t swarmy/web .
# (swarmy builds it the same way from the repo's swarmy.yaml.)
#
# The root .dockerignore drops apps/web and every *.md for the runtime images;
# apps/web/Dockerfile.dockerignore (BuildKit's per-Dockerfile ignore file)
# replaces it for this build so the site and its Markdown docs are in context.

# ── Stage 1: prerender the site ─────────────────────────────────────────────
FROM oven/bun:1.3-alpine AS build
WORKDIR /app
COPY package.json bun.lock tsconfig.base.json ./
# bun validates the whole lockfile graph, so every workspace manifest must be
# present; only the site's source closure (web + ui + app-config + core) is copied.
COPY apps/agent/package.json apps/agent/
COPY apps/api/package.json apps/api/
COPY apps/app/package.json apps/app/
COPY apps/dns/package.json apps/dns/
COPY apps/web/package.json apps/web/
COPY packages/abac/package.json packages/abac/
COPY packages/api-rest/package.json packages/api-rest/
COPY packages/app-config/package.json packages/app-config/
COPY packages/auth/package.json packages/auth/
COPY packages/core/package.json packages/core/
COPY packages/db/package.json packages/db/
COPY packages/dns/package.json packages/dns/
COPY packages/ingress/package.json packages/ingress/
COPY packages/mesh/package.json packages/mesh/
COPY packages/templates/package.json packages/templates/
COPY packages/trpc/package.json packages/trpc/
COPY packages/ui/package.json packages/ui/
RUN bun install --filter @swarmy/web --ignore-scripts
COPY packages/ui packages/ui
COPY packages/core packages/core
COPY packages/app-config packages/app-config
COPY apps/web apps/web
# Baked into the prerendered HTML (canonical URLs, dashboard/demo links).
ARG VITE_SITE_URL=https://swarmy.dev
ARG VITE_APP_URL=https://demo.swarmy.dev
ENV VITE_SITE_URL=${VITE_SITE_URL} VITE_APP_URL=${VITE_APP_URL}
RUN cd apps/web && bun run build

# ── Stage 2: serve it ───────────────────────────────────────────────────────
FROM caddy:2-alpine
COPY apps/web/Caddyfile /etc/caddy/Caddyfile
COPY --from=build /app/apps/web/dist/client /srv
EXPOSE 8080
HEALTHCHECK --interval=30s --timeout=3s CMD wget -qO- http://127.0.0.1:8080/ >/dev/null || exit 1
