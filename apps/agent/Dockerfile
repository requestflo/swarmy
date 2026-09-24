# swarmy node agent — run one per node.
#   docker run -d --name swarmy-agent --restart unless-stopped \
#     -v /var/run/docker.sock:/var/run/docker.sock \
#     -v swarmy-agent:/var/lib/swarmy \
#     -e AGENT_WS_URL=wss://controller/agent/ws \
#     -e SWARMY_JOIN_TOKEN=swt_... \
#     -e SWARMY_AGENT_STATE=/var/lib/swarmy/agent.json \
#     swarmy/agent
FROM oven/bun:1.3-alpine AS base

# iptables: the registry firewall floor runs in a one-shot host-network
# sidecar of this image (handlers/registry-firewall.ts). Both backends, so
# the script can match whichever one the host's dockerd uses.
RUN apk add --no-cache iptables && (apk add --no-cache iptables-legacy 2>/dev/null || true)

WORKDIR /app

# Workspace install (run from repo root build context).
# bun validates the whole lockfile graph, so every workspace member's manifest
# must be present even though we only build the agent. A throwaway stage
# collects every apps/*/ and packages/*/ package.json (so a NEW workspace
# package can't break this build), then only the agent's source closure
# (core + mesh + agent) is copied afterwards, keeping the image lean. The
# collected layer is content-addressed, so the install stays cached until a
# manifest actually changes. apps/web and apps/e2e are excluded by
# .dockerignore — leaf apps nothing in the agent's graph depends on.
FROM oven/bun:1.3-alpine AS manifests
COPY apps /src/apps
COPY packages /src/packages
RUN cd /src && for f in apps/*/package.json packages/*/package.json; do \
      mkdir -p "/out/$(dirname "$f")" && cp "$f" "/out/$f"; \
    done

FROM base
COPY package.json bun.lock ./
COPY --from=manifests /out/ ./
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
