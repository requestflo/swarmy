# swarmy-app-auth — the per-app Better Auth service swarmy deploys for `auth:`
# in swarmy.yaml (dev-platform §2B). Built from THIS directory alone
# (context docker/app-auth), no monorepo install.
#   port 3000, routed at /auth/* on the app's domains
#   /data            its own SQLite file (volume) unless DATABASE_URL is set
#   /run/secrets     auth-<provider>-client-id / -client-secret, optional auth-secret
FROM oven/bun:1.3-alpine
WORKDIR /app
COPY package.json bun.lock ./
RUN bun install --frozen-lockfile --production
COPY src ./src
ENV NODE_ENV=production PORT=3000
EXPOSE 3000
RUN mkdir -p /data && chown bun:bun /data
VOLUME /data
USER bun
HEALTHCHECK --interval=15s --timeout=5s --start-period=20s CMD wget -qO- http://127.0.0.1:3000/auth/ok >/dev/null || exit 1
ENTRYPOINT ["bun", "src/server.ts"]
