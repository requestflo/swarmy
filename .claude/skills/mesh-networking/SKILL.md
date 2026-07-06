---
name: mesh-networking
description: Invariants, contracts, and file map for swarmy's zero-trust WireGuard mesh — the pluggable MeshDriver registry (netbird/headscale/tailscale/wireguard/none), the applyMesh/meshState protocol, the privileged mesh-client sidecar the agent supervises, and direct-stack-connect ACLs. Load before touching anything under packages/mesh, protocol/mesh.ts, mesh.service.ts, routers/mesh.ts, apps/agent/src/handlers/mesh.ts, or the Networking UI. Product rationale lives in docs/product/mesh-networking.md.
---

# Mesh networking: driver → render → sidecar → meshState

Read `docs/product/mesh-networking.md` for WHY the mesh is off by default, dials
out, and never writes a key to disk. This skill is the HOW: the invariants every
change must keep, and where everything lives. The mesh is a pluggable subsystem
that mirrors ingress exactly — the `MeshDriver` registry is the ingress
`IngressDriver` registry, `RenderedMesh`/`applyMesh` are `RenderedConfig`/
`applyIngress`. See `skill("scaffold-ingress-driver")` for the shared pattern and
`skill("agent-handlers")` for the command/handler third of this.

## Invariants (violating any of these is a bug, not a style choice)

1. **`none` is the default; NetBird is the default once mesh is enabled.**
   `MeshConfig.driver` defaults `NONE`, `enabled` defaults `false`. A fresh org
   provisions nothing. Never make mesh implicitly on, and never let `enrollNode`
   or `grantDirectRoute` run when `driver === 'none' || !enabled`.
2. **The driver renders; the agent applies.** All provider logic lives in
   `packages/mesh` and produces a driver-agnostic `RenderedMesh`; the agent's
   `applyMesh` consumes it and never reasons about which provider it is. Adding a
   provider is a new `MeshDriver` + `render()`, never an agent change. Same rule
   as ingress drivers — render pure, apply at the edge.
3. **Control-plane calls go through `DriverControlPlane`; drivers stay pure
   apart from it.** `createSetupKey`/`listPeers`/`revokePeer`/`applyPolicyPlan`
   are the only IO a driver may do, injected by the service. `render()`,
   `validate()`, and `applyAccess()` are pure and golden-testable.
4. **Every command is one entry in three places** (same as any agent command):
   a Zod message in `packages/core/src/protocol/mesh.ts` added to the union in
   `messages.ts`; a `CommandName` + wire `type` in `COMMAND_PROTOCOL_TYPE`
   (`packages/trpc/src/hub/types.ts` — `applyMesh`, `mesh.grantDirectRoute`); a
   `case` in `apps/agent/src/executor.ts`. `meshState` is the reverse direction
   (agent→controller telemetry) and does NOT go in `COMMAND_PROTOCOL_TYPE`.
5. **Mesh secrets never touch node disk.** The single-use setup key rides the
   `applyMesh` frame only and becomes the sidecar container's env var — never a
   file. The control-plane service token is stored `encryptSecret`-encrypted in
   `MeshConfig.controlPlane` and resolved just-in-time; it is never returned to
   the client (`getConfig` exposes only `tokenConfigured: boolean`).
6. **Reads are telemetry, not commands.** Live peer state is the agent's
   `meshState` push (sampled from `netbird status --json` / `tailscale status`
   / `wg show`), reconciled onto `MeshPeer`. Never add a command just to read
   mesh state — surface it from the pushed snapshot / control-plane `listPeers`.
7. **The mesh client is a privileged, off-by-default sidecar.** `applyMesh` and
   `grantDirectRoute` are gated by `SWARMY_ALLOW_MESH` (default on) and reject
   with `E_MESH_DISABLED` when a node opts out — parity with `ALLOW_EXEC`. The
   sidecar (`swarmy-netbird`/`swarmy-tailscale`, host net, `NET_ADMIN`,
   `/dev/net/tun`) has a **stable name** so re-applies reconcile one container,
   never duplicate. Widening privilege adds a gate; it never removes one.
8. **Mesh membership + ACLs are swarmy's OWN state (DB), placement is Docker
   truth.** `MeshConfig`/`MeshPeer`/`MeshRoute`/`MeshAcl` are access-control +
   audit — legitimately DB, unlike node roles/cost which are Docker labels. But
   *which node runs a service* (and thus a direct route's target `meshIp`) is
   read live from Docker inventory (`resolveLiveService`/`resolveExecTarget`),
   never a swarmy column. See `skill("docker-native-storage")`.
9. **Direct connect is admin-only, ACL-scoped, TTL'd, and audited.**
   `routes.grant`/`routes.revoke` are `adminProcedure`. Tags are deterministic
   (`principalTagForRoute` = `tag:dc-<routeId>`, `targetTagForRoute` =
   `tag:svc-<routeId>`) so ACL renders are stable and golden-diffable. `expiresAt`
   bounds every grant; every grant/revoke/pushFailed writes `AuditLog`.
10. **Every mesh mutation is org-scoped and audited.** `enrollNode`, `setDriver`,
    `setEnabled`, `setControlPlane`, `routes.grant/revoke` all write `writeAudit`
    (`mesh.peer.join`, `mesh.setDriver`, `mesh.route.grant`, …). Never mutate mesh
    state without an audit row.

## Contracts between the layers

- **Service → agent dispatch**: `mesh.service.enrollNode` calls
  `provisionNode(config, opts, control)` (`@swarmy/mesh`) → `{ enrollment,
  rendered }`, then `ctx.hub.dispatch(nodeId, 'applyMesh', { rendered })`. The
  hub maps the `CommandName` to wire `type` via `COMMAND_PROTOCOL_TYPE`; the
  service never hand-rolls the frame. Result is `ApplyMeshResult { driver,
  joined, meshIp?, peerId? }`.
- **Driver ↔ control plane**: `DriverControlPlane` (impl in `mesh.service.ts`
  `makeControlPlane`) is the real `NetbirdControlPlane` HTTP client when driver
  is netbird/headscale AND url+token are present, else an opaque-key stub. This
  is the mesh analog of ingress's `DriverDispatch`.
- **Agent → controller telemetry**: the 20s `reportMeshState` loop in
  `apps/agent/src/index.ts` calls `sampleMeshState()` and `conn.send('meshState',
  …)`. The gateway (`protocol-handlers.ts` `case 'meshState'`) persists it onto
  `MeshPeer` via `updateMany` (safe no-op for un-enrolled nodes). Pure mapping
  lives in `reconcilePeerState` / `reconcileFromControlPlane` (`reconcile.ts`).
- **Access render**: `driver.applyAccess(config, intent)` returns
  `{ kind:'control-plane', plan }` (NetBird → `applyPolicyPlan`),
  `{ kind:'file', path, contents }` (Headscale HuJSON), or `{ kind:'none' }`
  (none/wireguard node-local). `buildNetbirdPolicyPlan`/`buildHeadscaleAcl` are
  pure and sorted-by-id for stable goldens.

## File map

| Concern | Where |
|---|---|
| Driver interface, config schema, `DriverControlPlane` | `packages/mesh/src/types.ts` |
| Driver registry (`defaultRegistry`, `none`+`netbird` first) | `packages/mesh/src/registry.ts` |
| Drivers (netbird/headscale/tailscale/wireguard/none) | `packages/mesh/src/drivers/*` |
| NetBird Admin-API client (setup-keys/peers/groups/policies) | `packages/mesh/src/control-plane/netbird.ts` |
| Pure ACL / policy render (tags, HuJSON, NetBird plan) | `packages/mesh/src/acl.ts` |
| Pure peer reconcile mapping | `packages/mesh/src/reconcile.ts` |
| Raw-WireGuard config render + keygen | `packages/mesh/src/render/{wireguard,keygen}.ts` |
| provision/preview/status orchestration (pkg-level) | `packages/mesh/src/apply.ts` |
| Wire/render protocol (`RenderedMesh`, `applyMesh`, `meshState`) | `packages/core/src/protocol/mesh.ts` (+ `messages.ts` union) |
| `CommandName` → wire `type` (`applyMesh`, `mesh.grantDirectRoute`) | `packages/trpc/src/hub/types.ts` |
| Controller service (enroll, direct-connect, reconcile) | `packages/trpc/src/services/mesh.service.ts` |
| tRPC router (config/enroll/peers/routes) | `packages/trpc/src/routers/mesh.ts` |
| Encrypt/decrypt service token, random keys | `packages/core/src/crypto.ts` |
| Agent: sidecar apply, `meshState` sampler, WG grant | `apps/agent/src/handlers/mesh.ts` |
| Agent: executor cases + `SWARMY_ALLOW_MESH` gate | `apps/agent/src/{executor,env,index}.ts` |
| Gateway `meshState` → `MeshPeer` reconcile | `apps/api/src/gateway/protocol-handlers.ts` |
| DB models | `packages/db/prisma/schema/mesh.prisma` |
| Networking UI (driver/enroll/control-plane/peers/direct-connect) | `apps/app/src/routes/_authed/networking.tsx`, `apps/app/src/components/networking/*` |

## Adding a mesh driver (the recipe)

1. **Driver** in `packages/mesh/src/drivers/<name>.ts` implementing `MeshDriver`:
   `validate` (pure), `provisionNode` (control-plane side — mint key via injected
   `DriverControlPlane`), `render` (pure `RenderedMesh`), `status`, and optional
   `applyAccess`. Keep the WireGuard interface name + client image as exported
   consts (see `NETBIRD_INTERFACE = 'wt0'`, `WIREGUARD_CONFIG_PATH`).
2. **Register** it in `defaultRegistry` (`registry.ts`) and re-export from
   `packages/mesh/src/index.ts`.
3. **Controller wiring**: add the id to the `driverEnum` in `routers/mesh.ts` and
   the `DRIVER_TO_ENUM`/`ENUM_TO_DRIVER` maps + Prisma `MeshDriver` enum
   (`mesh.prisma`). If the provider has a real Admin API, teach `makeControlPlane`
   to return a real client for it; otherwise the opaque-key stub is fine.
4. **Agent apply** (only if the client is a new shape): most providers reuse the
   NetBird/Tailscale sidecar or the raw-WireGuard `files + reloadCommand` path in
   `applyMesh` — don't add a provider branch to the agent unless the client is
   genuinely new, and gate any new privileged path behind `SWARMY_ALLOW_MESH`.
5. **UI**: the driver appears in `mesh-driver-card.tsx` via `DRIVER_LABELS`; add a
   label + copy. Direct-connect join snippets live in `buildConnectInfo`.

For a whole cross-stack feature (db → protocol → service → router → UI) see
`skill("add-feature-slice")`; this skill is the mesh-specific slice of it.

## Operational gotchas

- The sidecar needs `NET_ADMIN` + `/dev/net/tun` and runs `NetworkMode: 'host'`;
  it is pinned and off-by-default for a reason — never widen its caps casually.
- `meshState` in the gateway currently writes coarse `ONLINE`/`OFFLINE`, while
  `reconcilePeerState` models the fuller `ENROLLING`/`ENROLLED`/`CONNECTED`/
  `DEGRADED`/`FAILED` domain — prefer the pure mapping when unifying them.
- Re-pinning an existing LAN swarm onto the mesh data-path is a guided
  drain-one-at-a-time migration, not a toggle (`--data-path-addr` can't change
  on a running node). Initialize multi-location swarms on the mesh from the
  start; the swarm-over-mesh join command is future work, not yet wired.
- The cross-region edge (region-aware Caddy + geo-DNS) rides on the reachability
  the mesh provides — coordinate boundary changes with `skill("geo-edge-routing")`.
- Verify: `bun --filter @swarmy/mesh typecheck && bun --filter @swarmy/mesh test`
  (driver + ACL + reconcile goldens), then `bun --filter @swarmy/agent typecheck`.
  Multi-node: `scripts/local-vms.sh` — enroll a second-region VM, watch its peer
  reach `CONNECTED`, then grant a direct route and hit the service on its mesh IP.
