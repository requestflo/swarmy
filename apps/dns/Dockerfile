# swarmy-dns — authoritative geo-DNS, one per ingress+outlet node (global service).
# Deployed/converged by the controller (dns-deploy.service.ts); never run by hand:
#   ports 53/udp+tcp + 53535 (admin) published in HOST mode,
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

# 53 dns (udp+tcp), 53535 admin — host-mode published by the service spec.
EXPOSE 53/udp 53/tcp 53535/tcp

ENTRYPOINT ["bun", "run", "apps/dns/src/index.ts"]
