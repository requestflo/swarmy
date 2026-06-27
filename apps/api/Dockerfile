# swarmy controller (API + agent WS gateway). Build from the repo root:
#   docker build -f apps/api/Dockerfile -t swarmy/controller .
FROM oven/bun:1.3-alpine

WORKDIR /app

# Workspace manifests first for cached installs.
COPY package.json bun.lock ./
COPY packages/core/package.json packages/core/
COPY packages/db/package.json packages/db/
COPY packages/auth/package.json packages/auth/
COPY packages/ingress/package.json packages/ingress/
COPY packages/trpc/package.json packages/trpc/
COPY apps/api/package.json apps/api/
RUN bun install || bun install --no-frozen-lockfile

# Source.
COPY packages/core packages/core
COPY packages/db packages/db
COPY packages/auth packages/auth
COPY packages/ingress packages/ingress
COPY packages/trpc packages/trpc
COPY apps/api apps/api

# Generate the Prisma client into packages/db/src/generated.
ENV CHECKPOINT_DISABLE=1 PRISMA_HIDE_UPDATE_MESSAGE=1
RUN bun --filter @swarmy/db db:generate

ENV NODE_ENV=production PORT=3001
EXPOSE 3001
ENTRYPOINT ["bun", "run", "apps/api/src/index.ts"]
