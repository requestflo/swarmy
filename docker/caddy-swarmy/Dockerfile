# swarmy's Caddy ingress-controller image.
#
# The stock caddy:2-alpine cannot express swarmy's protection layer — these
# capabilities are compiled-in plugins, not config:
#   - `rate_limit` (per-route rate limits)   — mholt/caddy-ratelimit
#   - `storage redis` (shared cert storage)  — pberkel/caddy-storage-redis,
#     REQUIRED for the edge-per-node topology (geo-edge) so N per-node Caddys
#     coordinate ACME through one store instead of racing
#   - `cache` (per-route response caching)   — caddyserver/cache-handler
#   - `maxmind_geolocation` (country rules)  — porech/caddy-maxmind-geolocation
# This image is the stock Caddy plus all four, built with xcaddy.
#
# Country rules also need a GeoIP country mmdb visible INSIDE the container:
# mount one and point `extraConfig.geoipMmdbPath` at it. swarmy does not
# auto-download an mmdb for the edge in this pass — the DNS plane already
# manages GeoIP downloads (apps/dns/src/geoip-manager.ts) and wiring that
# into ingress is a follow-up; until then the path is operator-provided.
#
# Build + push (any registry the swarm can pull from):
#   docker build -t <registry>/caddy-swarmy:2 docker/caddy-swarmy
#   docker push <registry>/caddy-swarmy:2
#
# Then point swarmy at it: Edge & ingress → Controller image (persisted in
# IngressConfig.settings.controllerImage; `ensureController` deploys it).

FROM caddy:2-builder AS builder

# Pinned: the plugins' Caddyfile directives changed across versions — bump
# deliberately alongside the rate_limit/cache/geo renders in packages/ingress.
RUN xcaddy build \
    --with github.com/mholt/caddy-ratelimit@v0.1.0 \
    --with github.com/pberkel/caddy-storage-redis@v1.4.0 \
    --with github.com/caddyserver/cache-handler@v0.16.0 \
    --with github.com/porech/caddy-maxmind-geolocation@v1.0.3

FROM caddy:2-alpine

COPY --from=builder /usr/bin/caddy /usr/bin/caddy
