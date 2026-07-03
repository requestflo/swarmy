# swarmy's Caddy ingress-controller image.
#
# The stock caddy:2-alpine cannot enforce per-route rate limits — `rate_limit`
# comes from the mholt/caddy-ratelimit plugin, which must be compiled in. This
# image is the stock controller plus that plugin, built with xcaddy.
#
# Build + push (any registry the swarm can pull from):
#   docker build -t <registry>/caddy-swarmy:2 docker/caddy-swarmy
#   docker push <registry>/caddy-swarmy:2
#
# Then point swarmy at it: Edge & ingress → Controller image (persisted in
# IngressConfig.settings.controllerImage; `ensureController` deploys it).

FROM caddy:2-builder AS builder

# Pinned: the plugin's Caddyfile directives changed across versions — bump
# deliberately alongside the rate_limit render in packages/ingress.
RUN xcaddy build \
    --with github.com/mholt/caddy-ratelimit@v0.1.0

FROM caddy:2-alpine

COPY --from=builder /usr/bin/caddy /usr/bin/caddy
