# Mesh networking — "any cloud, any NAT, one encrypted network"

**Status: canonical product design (2026-07). Pairs with the `mesh-networking`
skill for the how.**

## The feeling we are building

Someone running swarmy on a flat LAN should never think about mesh at all — the
default is `none`, and swarmy provisions no network. But the moment their nodes
live in different clouds, behind NAT, at home, or on a DR box, turning on a
private encrypted network between them should be one toggle and one paste:

1. In **Networking** they see the honest default: *"None · default — swarmy
   provisions no mesh."* They pick **NetBird** ("Zero-trust WireGuard mesh. Any
   node, any cloud, behind NAT — no inbound ports") and flip **Enable mesh**.
2. They point the mesh at a control plane — **Managed by swarmy** or an
   **external** NetBird URL — and paste a service token. It is *"stored
   encrypted, used server-side only";* they never see it again.
3. They pick a node and hit **Enroll**. swarmy mints a **single-use, short-TTL
   setup key**, the agent installs the WireGuard client, and the node joins —
   *no inbound ports, no firewall edits, and the key never touches disk.*
4. The peer appears in the list: hostname, **mesh IP** (`100.92.0.x`), last
   handshake, `connected`. The headline flips to *"4 peers meshed."*
5. Later, someone needs Postgres from their laptop. On the service they hit
   **Direct connect**, get a copy-paste `netbird up` snippet scoped to *just
   that workload* with a **TTL in minutes**, and hit the database on its real
   port — no ingress, no public port, every second of it audited.

No WireGuard keys pasted by hand. No ACL file edited. No VPC, no security group,
no load balancer. It should feel like the nodes found each other privately —
because they did, and swarmy owns every piece of the plumbing behind it.

## How it works (the enrollment path)

```
Networking: driver=netbird, enabled                 control plane (NetBird)
   │  ① admin enrolls a node (adminProcedure)          managed-by-swarmy | external
   ▼                                                    /api/setup-keys · /api/peers
mesh.service.enrollNode
   │  ② provisionNode(driver) → control.createSetupKey  single-use, short-TTL key
   │     driver.render() → RenderedMesh (driver-agnostic, like RenderedConfig)
   ▼
ctx.hub.dispatch(nodeId, 'applyMesh', { rendered })   over the node's EXISTING
   │  ③ setup key rides THIS frame only, never persisted   dial-out WebSocket
   ▼
agent executor 'applyMesh'  (gated by SWARMY_ALLOW_MESH → E_MESH_DISABLED)
   │  ④ run swarmy-netbird sidecar (host net, NET_ADMIN, /dev/net/tun);
   │     key is only ever the container's env — never written to disk
   ▼
node on the WireGuard mesh (iface wt0, mesh IP 100.92.0.x)
   │  ⑤ every 20s: sampleMeshState() → conn.send('meshState', …)
   ▼
gateway 'meshState' → MeshPeer row (status / meshIp / lastSeen)  → Peers list
```

Four ideas, one story:

- **The mesh reuses the agent's dial-out; it never opens an inbound port.** There
  is no new controller→node path. `applyMesh` rides the same outbound WebSocket
  and command envelope every other capability uses, and the WireGuard client
  itself dials *out* to the control plane. A node behind NAT joins with zero
  ports open — the whole point.
- **The driver renders; the agent applies.** The controller-side driver produces
  a driver-agnostic `RenderedMesh` (the mesh analog of ingress's
  `RenderedConfig`); the agent consumes it without knowing which provider it is.
  Adding Headscale/Tailscale/raw-WireGuard is a new driver + render, never an
  agent rewrite — the same pluggable registry as ingress (see the
  `scaffold-ingress-driver` skill).
- **Secrets are single-use and never land on disk.** The service token lives
  encrypted in swarmy's vault and is resolved just-in-time; the per-node setup
  key is minted per enrollment, carried on one authenticated frame, and becomes
  the sidecar's env var only. Nothing mesh-secret is ever written to the node's
  filesystem.
- **Direct connect is the same primitive, exposed the other way.** Instead of
  joining a *node* to the mesh forever, it joins a *laptop/CI box* as an
  ephemeral peer scoped by ACL to exactly one service, with a TTL and an audit
  row. One mesh, two doors.

## Roles and where truth lives

- **Node placement and service inventory are Docker truth.** Which node runs a
  service — and therefore which mesh IP a direct route points at — is derived
  live from Docker (`resolveLiveService` → `resolveExecTarget` → the peer's
  `meshIp`), never a swarmy-kept column. There is no `Service` table; the mesh
  reads placement from live inventory like everything else. See the
  `docker-native-storage` skill for the boundary.
- **Mesh membership and access are swarmy's OWN identity/access, so they live in
  the DB.** Unlike node roles or cost (which are Docker labels), a mesh peer,
  its ACLs, and its control-plane credentials are swarmy's access-control and
  audit surface — exactly what the DB is *for*. `MeshConfig` (org-scoped 1:1,
  `driver` default `NONE`, `enabled` default `false`, encrypted control-plane
  token), `MeshPeer` (one per node, `meshIp`, `status`), `MeshRoute` +
  `MeshAcl` (direct-connect grants + rendered enforcement, `expiresAt`,
  `createdById`) are swarmy state, not swarm state.
- **The control plane is the provider's truth; swarmy is system-of-record over
  it.** NetBird holds the authoritative peer list; swarmy drives it by API with a
  service token and reconciles `MeshPeer` from `meshState` reports and (best
  effort) `listPeers`. swarmy never mirrors what it can ask the control plane.
- **The peer's live liveness is agent-pushed telemetry, not a command.** The
  agent samples `netbird status --json` / `wg show` and pushes `meshState`;
  reads never dispatch a command (same rule as list/inspect/stats).

## Mesh behaviour (what the product promise commits us to)

- **`none` is the default and does nothing.** A fresh org is `driver = none`,
  `enabled = false` — no new process, no interface, no control plane. Turning
  mesh off later renders `action: 'leave'` and tears the client down. "swarmy
  stays out of the way" is the literal `none` driver summary.
- **NetBird is the default once mesh is enabled**, with a self-hostable
  (`managed-by-swarmy`) or `external` control plane. Headscale, Tailscale, and
  raw WireGuard are first-class alternatives behind the same `MeshDriver`
  interface — pluralism for power users without complicating the default path.
- **Enrollment is admin-gated, provisioned server-side, dispatched once.**
  `enrollNode` refuses unless a driver is picked and mesh is enabled, requires
  the node online, mints the key, persists an `ENROLLING` peer, dispatches
  `applyMesh`, then settles the peer to `CONNECTED`/`ENROLLED` (or `FAILED`,
  audited).
- **The client is a privileged, pinned, off-by-default sidecar.** A long-lived
  `swarmy-netbird` / `swarmy-tailscale` container owns the WireGuard interface
  (host network, `NET_ADMIN`/`SYS_ADMIN`/`SYS_RESOURCE`, `/dev/net/tun`). Raw
  WireGuard instead writes `wg0.conf` and runs `wg-quick up`. The whole
  capability is gated by `SWARMY_ALLOW_MESH` (default on, but a node can refuse).
- **Direct connect is short-lived, ACL-scoped, and audited.** A grant renders a
  deterministic ACL (`tag:dc-<routeId>` → `tag:svc-<routeId>`), pushes it to the
  control plane (NetBird policy) or writes a file (Headscale HuJSON), mints an
  ephemeral scoped setup key, and returns a `<meshIp>:<port>` address plus a
  paste-ready join snippet. Every grant and revoke is an `adminProcedure` with an
  audit row.
- **The mesh underlies cross-region swarm.** Once nodes share one encrypted
  network, they can belong to one Docker Swarm across clouds and NAT — and the
  global edge (region-aware Caddy + geo-DNS) rides on top of that reachability.
  See `docs/product/edge-network.md` for the edge story the mesh makes possible.

## Failure modes (designed, not accidental)

| Failure | Behaviour |
|---|---|
| Control plane unreachable at enroll | The driver falls back to an opaque single-use key so a fresh/unconfigured org still enrolls; `status()` reports "control plane unreachable" instead of throwing. |
| `applyMesh` fails on the node | The `MeshPeer` is marked `FAILED` and `mesh.peer.enrollFailed` is audited; the error surfaces to the admin. No half-joined ghost. |
| Node opts out of mesh (`SWARMY_ALLOW_MESH=false`) | The executor rejects `applyMesh`/`grantDirectRoute` with `E_MESH_DISABLED`; the rest of the agent is unaffected. |
| Agent silent but control plane knows | Reconcile can fall back to `reconcileFromControlPlane` (NetBird `/api/peers`) so liveness isn't lost when the node's own reporter is quiet. |
| Direct-route policy push fails | The route row is kept, the ACL marked un-applied, and `mesh.route.pushFailed` is audited — the grant isn't silently lost. |
| Direct route TTL elapses | `expiresAt` bounds the grant; revoke tears down the control-plane policy and deletes the rows. Expiry is the default posture, not the exception. |

## Explicitly rejected

- **Requiring routable IPs / VPCs / firewall rules between nodes.** That is the
  exact ops swarmy exists to erase. The mesh is WireGuard-grade, NAT-friendly,
  and inbound-portless by construction.
- **A SaaS-only control plane in the critical path.** NetBird's control plane is
  self-hostable, so "managed by swarmy" needs no third party. Tailscale (SaaS
  coordination) is offered as a driver for teams already living there — never the
  default.
- **Writing setup keys or WireGuard secrets to node disk.** Keys ride one
  authenticated frame and become container env only; the service token is
  encrypted at rest and resolved JIT. A secret on disk is a secret that leaks.
- **Embedding the WireGuard client in the agent.** The agent is Bun/TS; the mesh
  client is a pinned, privileged, supervised sidecar — the same "write config,
  run the tool" shape as the ingress agent, not a reimplementation of NetBird.
- **A DB mirror of the provider's peer list.** The control plane is
  authoritative; swarmy reconciles from telemetry + `listPeers`, it does not
  shadow-copy state it can query.
- **One-click re-pin of an already-LAN-clustered swarm onto the mesh.**
  `--data-path-addr` can't change on a running swarm node without leave/rejoin;
  converting an in-place cluster is a guided, drain-one-at-a-time migration, not
  a toggle. Multi-location swarms initialize on the mesh from the start.

## Implementation map

The invariants and file map live in the `mesh-networking` skill
(`.claude/skills/mesh-networking/SKILL.md`) — the `MeshDriver` registry, the
`applyMesh`/`meshState` contract, and the direct-connect ACL model. Key homes:
`packages/mesh/src/*` (drivers, registry, pure ACL + reconcile), the NetBird
control-plane client (`packages/mesh/src/control-plane/netbird.ts`),
`packages/core/src/protocol/mesh.ts` (the wire/render contract),
`packages/trpc/src/services/mesh.service.ts` + `routers/mesh.ts` (orchestration),
`apps/agent/src/handlers/mesh.ts` (sidecar apply + `meshState` sampler),
`apps/api/src/gateway/protocol-handlers.ts` (`meshState` reconcile),
`packages/db/prisma/schema/mesh.prisma` (`MeshConfig`/`MeshPeer`/`MeshRoute`/
`MeshAcl`), and `apps/app/src/routes/_authed/networking.tsx` (the Networking UI).
The pluggable-driver pattern is shared with the `scaffold-ingress-driver` skill;
the agent contract with the `agent-handlers` skill.
