---
paths:
  - 'packages/mesh/**'
  - 'packages/trpc/src/services/mesh*'
  - 'apps/agent/src/handlers/mesh*'
---

# Mesh

Load `mesh-networking` before editing.

- DR-025: self-hosted NetBird run by the agent, Headscale as an option, swarmy as the OIDC
  provider; the mesh must not depend on raft.
- DR-026: people reach apps through a per-app access router and DNS zone, default deny.
- BR-004: joining the mesh needs zero inbound ports.
