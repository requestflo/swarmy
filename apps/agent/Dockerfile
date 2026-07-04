# swarmy node agent — run one per node.
#   docker run -d --name swarmy-agent --restart unless-stopped \
#     -v /var/run/docker.sock:/var/run/docker.sock \
#     -v swarmy-agent:/var/lib/swarmy \
#     -e AGENT_WS_URL=wss://controller/agent/ws \
#     -e SWARMY_JOIN_TOKEN=swt_... \
#     -e SWARMY_AGENT_STATE=/var/lib/swarmy/agent.json \
#     swarmy/agent
FROM oven/bun:1.3-alpine

WORKDIR /app

# Workspace install (run from repo root build context).
# bun validates the whole lockfile graph, so every workspace member's manifest
# must be present even though we only build the agent. We copy all package.json
# files (cheap, cache-friendly) but only the agent's source closure
# (core + mesh + agent) afterwards, keeping the image lean.
COPY package.json bun.lock ./
# apps/web and apps/e2e are excluded by .dockerignore — they're leaf apps that
# nothing in the agent's graph depends on, so bun tolerates their absence.
COPY apps/agent/package.json apps/agent/
COPY apps/api/package.json apps/api/
COPY apps/app/package.json apps/app/
COPY packages/abac/package.json packages/abac/
COPY packages/api-rest/package.json packages/api-rest/
COPY packages/auth/package.json packages/auth/
COPY packages/core/package.json packages/core/
COPY packages/db/package.json packages/db/
COPY packages/dns/package.json packages/dns/
COPY packages/ingress/package.json packages/ingress/
COPY packages/mesh/package.json packages/mesh/
COPY packages/trpc/package.json packages/trpc/
COPY packages/ui/package.json packages/ui/
RUN bun install --filter @swarmy/agent --filter @swarmy/core --filter @swarmy/mesh

COPY packages/core packages/core
COPY packages/mesh packages/mesh
COPY apps/agent apps/agent

# Bake the build commit so `swarmy-agent --version` reports it.
ARG SWARMY_COMMIT=dev
ENV SWARMY_COMMIT=${SWARMY_COMMIT}

ENV SWARMY_AGENT_STATE=/var/lib/swarmy/agent.json
VOLUME /var/lib/swarmy

ENTRYPOINT ["bun", "run", "apps/agent/src/index.ts"]
