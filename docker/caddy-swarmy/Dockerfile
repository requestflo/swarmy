# swarmy's Caddy ingress-controller image.
#
# The stock caddy:2-alpine cannot express swarmy's protection layer — these
# capabilities are compiled-in plugins, not config:
#   - `rate_limit` (per-route rate limits)   — mholt/caddy-ratelimit
#   - `storage swarmy` (edge cert storage)   — ./certstore, swarmy's own
#     module: certificates are served from the node's own volume FIRST and
#     mirrored in the background to a replica, so no boot path waits on the
#     replica to serve TLS (QA-066: a rebooted mesh-control node deadlocked
#     when its edge's only cert store was Garage, reached over the mesh).
#   - `storage s3` (the replica)             — techknowlogick/certmagic-s3,
#     nested as `storage swarmy { replica s3 { … } }` for the edge-per-node
#     topology (geo-edge): the edges share ONE cert pool + ACME challenge
#     store through swarmy's replicated object storage (Garage bucket
#     `swarmy-edge-certs`), so HTTP-01/TLS-ALPN challenges validate on
#     whichever edge geo-DNS steers the CA to. Chosen over ss098/certmagic-s3,
#     whose Lock() is a no-op (unsafe with N edges). Credentials come from the
#     AWS SDK default chain — a Docker secret mounted as
#     AWS_SHARED_CREDENTIALS_FILE — never from the Caddyfile.
#   - `cache` (per-route response caching)   — caddyserver/cache-handler
#   - `maxmind_geolocation` (country rules)  — porech/caddy-maxmind-geolocation
#   - `dns swarmy` (ACME DNS-01, wildcards)  — ./dnsprovider, swarmy's own
#     module: the edge asks the controller to publish `_acme-challenge` TXT in
#     swarmy-dns (the org's own nameservers) — no third-party DNS API. Token
#     read from a Docker secret file, never the Caddyfile.
#   - `dns cloudflare` (BYO DNS-01 token)    — caddy-dns/cloudflare, only for a
#     wildcard in a zone swarmy DNS does not serve; token via {file.*}.
#   - `swarmy_rum` (analytics + replay tag)  — ./rum, swarmy's own module: adds
#     the same-origin `<script src="/_swarmy/rum.js">` before `</head>` on HTML
#     documents (identity upstream, gzip re-encode, CSP-aware, skips and says
#     why via a `Swarmy-Rum` header). The app itself is never changed.
# This image is the stock Caddy plus all eight, built with xcaddy.
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

# Pinned Caddy minor + every plugin, verified to compile together. `caddy:2-builder`
# floating broke the build once already (pberkel/caddy-storage-redis v1.4.0 vs
# a newer caddycmd.LoadConfig signature) — bump deliberately, rebuild, and keep
# the rate_limit/cache/geo/storage renders in packages/ingress in step.
# certmagic-s3 is pinned to the commit AFTER v1.4.1 that fixes Lock() spinning
# in a tight loop on transient S3 errors (honours ctx + LockTimeout).
FROM caddy:2.11.4-builder AS builder

COPY dnsprovider /src/dnsprovider
COPY rum /src/rum
COPY certstore /src/certstore

# The cert store's unit tests gate the image: it sits on every edge's TLS path.
RUN cd /src/certstore && go test ./...

RUN xcaddy build \
    --with github.com/requestflo/caddy-swarmy-certstore=/src/certstore \
    --with github.com/requestflo/caddy-dns-swarmy=/src/dnsprovider \
    --with github.com/requestflo/caddy-swarmy-rum=/src/rum \
    --with github.com/caddy-dns/cloudflare@v0.2.4 \
    --with github.com/mholt/caddy-ratelimit@v0.1.0 \
    --with github.com/techknowlogick/certmagic-s3@9136b2abaf525cad77c3b30f60dc6b1ba9047b69 \
    --with github.com/caddyserver/cache-handler@v0.16.0 \
    --with github.com/porech/caddy-maxmind-geolocation@v1.0.3

FROM caddy:2.11.4-alpine

COPY --from=builder /usr/bin/caddy /usr/bin/caddy
