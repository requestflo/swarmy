---
paths:
  - 'packages/ingress/**'
  - 'packages/dns/**'
  - 'apps/dns/**'
---

# Edge, ingress and DNS

Load `geo-edge-routing`; for a new proxy or tunnel, `scaffold-ingress-driver`.

- BR-099: ingress is a driver; Caddy is the default (DR-021), plus none and cloudflared.
- DR-019: swarmy-dns answers authoritatively per query, and never with an empty answer.
- DR-020: edge ports use host mode, not the routing mesh.
- DR-022: certificates are node-local first, with one shared ACME account.
- DR-023: exposure violations alert and block the next deploy; a live port is never removed.
- DR-024: Cloudflare Tunnel is a pasted token.
