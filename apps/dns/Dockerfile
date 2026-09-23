# swarmy-dns — authoritative geo-DNS, one per ingress+outlet node (global service).
# Deployed/converged by the controller (dns-deploy.service.ts); never run by hand:
#   HOST network, no published ports: binds :53 udp+tcp on each non-loopback
#   host address individually (never 0.0.0.0 — systemd-resolved's stub owns
#   127.0.0.53:53) and the 53535 admin API on 127.0.0.1 + docker0 only,
#   volume swarmy-dns-data at /var/lib/swarmy-dns (snapshots + geoip db),
#   secret swarmy-dns-admin (bearer token for snapshot pushes).
FROM oven/bun:1.3-alpine

WORKDIR /app

# Workspace install (run from repo root build context). Same shape as the agent
# image: every non-dockerignored workspace manifest, then only this app's
# source closure (core + dns + apps/dns).
COPY package.json bun.lock ./
COPY apps/agent/package.json apps/agent/
COPY apps/api/package.json apps/api/
COPY apps/app/package.json apps/app/
COPY apps/dns/package.json apps/dns/
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
RUN bun install --filter @swarmy/dns-server --filter @swarmy/core --filter @swarmy/dns

COPY packages/core packages/core
COPY packages/dns packages/dns
COPY apps/dns apps/dns

ARG SWARMY_COMMIT=dev
ENV SWARMY_COMMIT=${SWARMY_COMMIT}

ENV SWARMY_DNS_DATA_DIR=/var/lib/swarmy-dns
VOLUME /var/lib/swarmy-dns

# 53 dns (udp+tcp), 53535 admin — documentation only; the service runs on the
# host network (dns-deploy.service.ts) so nothing is published.
EXPOSE 53/udp 53/tcp 53535/tcp

ENTRYPOINT ["bun", "run", "apps/dns/src/index.ts"]
