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
COPY package.json bun.lock ./
COPY packages/core/package.json packages/core/
COPY apps/agent/package.json apps/agent/
RUN bun install --filter @swarmy/agent --filter @swarmy/core || bun install

COPY packages/core packages/core
COPY apps/agent apps/agent

# Bake the build commit so `swarmy-agent --version` reports it.
ARG SWARMY_COMMIT=dev
ENV SWARMY_COMMIT=${SWARMY_COMMIT}

ENV SWARMY_AGENT_STATE=/var/lib/swarmy/agent.json
VOLUME /var/lib/swarmy

ENTRYPOINT ["bun", "run", "apps/agent/src/index.ts"]
