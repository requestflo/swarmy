# swarmy-dns — authoritative geo-DNS, one per ingress+outlet node (global service).
# Deployed/converged by the controller (dns-deploy.service.ts); never run by hand:
#   HOST network, no published ports: binds :53 udp+tcp on each non-loopback
#   host address individually (never 0.0.0.0 — systemd-resolved's stub owns
#   127.0.0.53:53) and the 53535 admin API on 127.0.0.1 + docker0 only,
#   volume swarmy-dns-data at /var/lib/swarmy-dns (snapshots + geoip db),
#   secret swarmy-dns-admin (bearer token for snapshot pushes).

# ── GeoIP floor: DB-IP "IP to Country Lite" (CC BY 4.0) baked into the image, so
# a fresh edge node with no egress still steers by country. The online refresh
# (SWARMY_DNS_GEOIP=dbip city / maxmind) stays an optional upgrade on top.
# DBIP_MONTH=YYYY-MM pins an edition; default = this month, else last month.
# A build with neither reachable FAILS rather than silently shipping without
# the floor; SWARMY_DNS_BUNDLE_GEOIP=0 opts out explicitly (local dev builds).
# The fetch is shared with swarmy's Caddy edge image (same edition + NOTICE).
FROM alpine:3.20 AS geoip
ARG DBIP_MONTH=
ARG SWARMY_DNS_BUNDLE_GEOIP=1
COPY docker/caddy-swarmy/geoip/bundle-dbip-country.sh /usr/local/bin/bundle-dbip-country
RUN DBIP_MONTH="$DBIP_MONTH" BUNDLE="$SWARMY_DNS_BUNDLE_GEOIP" sh /usr/local/bin/bundle-dbip-country /out \
  'swarmy-dns maps each country to a representative coordinate for steering.'

FROM oven/bun:1.3.14-alpine

LABEL org.opencontainers.image.licenses.geoip="CC-BY-4.0" \
      dev.swarmy.geoip.attribution="IP Geolocation by DB-IP (https://db-ip.com), CC BY 4.0"

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
COPY apps/cli/package.json apps/cli/
COPY packages/app-auth/package.json packages/app-auth/
COPY packages/devkit/package.json packages/devkit/
COPY packages/rum/package.json packages/rum/
RUN bun install --filter @swarmy/dns-server --filter @swarmy/core --filter @swarmy/dns

COPY packages/core packages/core
COPY packages/dns packages/dns
COPY apps/dns apps/dns

ARG SWARMY_COMMIT=dev
ENV SWARMY_COMMIT=${SWARMY_COMMIT}

COPY --from=geoip /out/ /usr/share/swarmy-dns/geoip/

ENV SWARMY_DNS_DATA_DIR=/var/lib/swarmy-dns
VOLUME /var/lib/swarmy-dns

# 53 dns (udp+tcp), 53535 admin — documentation only; the service runs on the
# host network (dns-deploy.service.ts) so nothing is published.
EXPOSE 53/udp 53/tcp 53535/tcp

ENTRYPOINT ["bun", "run", "apps/dns/src/index.ts"]
