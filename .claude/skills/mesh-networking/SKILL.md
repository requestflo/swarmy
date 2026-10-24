---
name: mesh-networking
description: Invariants, contracts, and file map for swarmy's zero-trust WireGuard mesh — the pluggable MeshDriver registry (netbird/headscale/none), the applyMesh/meshState protocol, the privileged mesh-client sidecar the agent supervises, and people access. Load before touching anything under packages/mesh, protocol/mesh.ts, mesh.service.ts, routers/mesh.ts, apps/agent/src/handlers/mesh.ts, or the Networking UI. Product rationale lives in docs/product/mesh-networking.md.
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
   or a people-access grant run when `driver === 'none' || !enabled`. (The
   self-host installer's own default is `--mesh swarmy`, an explicit operator
   choice recorded as `CFG_MESH`; a re-run never springs a mesh on a live
   swarm that was installed without one.)
2. **The driver renders; the agent applies.** All provider logic lives in
   `packages/mesh` and produces a driver-agnostic `RenderedMesh`; the agent's
   `applyMesh` consumes it and never reasons about which provider it is. Adding a
   provider is a new `MeshDriver` + `render()`, never an agent change. Same rule
   as ingress drivers — render pure, apply at the edge.
3. **Control-plane calls go through `DriverControlPlane`; drivers stay pure
   apart from it.** `createSetupKey`/`listPeers`/`revokePeer`
   are the only IO a driver may do, injected by the service. `render()` and
   `validate()` are pure and golden-testable.
4. **Every command is one entry in three places** (same as any agent command):
   a Zod message in `packages/core/src/protocol/mesh.ts` added to the union in
   `messages.ts`; a `CommandName` + wire `type` in `COMMAND_PROTOCOL_TYPE`
   (`packages/trpc/src/hub/types.ts` — `applyMesh`, `mesh.accessRouter`); a
   `case` in `apps/agent/src/executor.ts`. `meshState` is the reverse direction
   (agent→controller telemetry) and does NOT go in `COMMAND_PROTOCOL_TYPE`.
5. **Mesh secrets never touch node disk.** The single-use setup key rides the
   `applyMesh` frame only and becomes the sidecar container's env var — never a
   file. The control-plane service token is stored `encryptSecret`-encrypted in
   `MeshConfig.controlPlane` and resolved just-in-time; it is never returned to
   the client (`getConfig` exposes only `tokenConfigured: boolean`).
6. **Reads are telemetry, not commands.** Live peer state is the agent's
   `meshState` push (sampled from `netbird status --json` / `tailscale status`), folded into the in-memory live peer map (`mesh-peers.ts`,
   no table — epic-docker-native-state P1). Never add a command just to read
   mesh state — surface it from the pushed snapshot / control-plane `listPeers`.
7. **The mesh client is a privileged, off-by-default sidecar.** `applyMesh` is
   gated by `SWARMY_ALLOW_MESH` (default on) and reject
   with `E_MESH_DISABLED` when a node opts out — parity with `ALLOW_EXEC`. The
   sidecar (`swarmy-netbird`/`swarmy-tailscale`, host net, `NET_ADMIN`,
   `/dev/net/tun`) has a **stable name** so re-applies reconcile one container,
   never duplicate. Widening privilege adds a gate; it never removes one.
8. **Mesh grants are swarmy's OWN state (DB); peers and placement are live.**
   `MeshConfig`/`MeshRoute` are config + access control — legitimately DB.
   Peers are derived (agent `meshState` + control-plane `listPeers`) and the
   rendered ACL is re-rendered from `MeshRoute` on demand. Likewise
   *which node runs a service* is read live from Docker inventory, never a
   swarmy column. See `skill("docker-native-storage")`.
9. **Laptop access is people access — there is no second path.** A person reaches
   an app's private services through `mesh.people.*` grants (SSO identity,
   per-port, optional `expiresAt`), shown on the app's **Access** tab. The old
   ephemeral-key "direct connect" (`mesh.routes.*`, REST `/mesh/routes`) was
   removed in 2026-09 — don't bring back a second way in.
10. **Every mesh mutation is org-scoped and audited.** `enrollNode`, `setDriver`,
    `setEnabled`, `setControlPlane`, `people.grant/revoke` all write `writeAudit`
    (`mesh.peer.join`, `mesh.setDriver`, …). Never mutate mesh
    state without an audit row. Revoking a person's grant or device
    (`mesh.people.revoke`/`revokeDevice`) is `abacProcedure('mesh.revoke')`,
    owner/admin by default.

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
  `apps/agent/src/daemon.ts` calls `sampleMeshState()` and `conn.send('meshState',
  …)`. The gateway (`protocol-handlers.ts` `case 'meshState'`) folds it into
  the live peer map via `reconcileMeshPeer` (`packages/trpc/src/services/mesh-peers.ts`;
  a no-op for an unknown node unless it reports connected with an IP). Pure mapping
  lives in `reconcilePeerState` / `reconcileFromControlPlane` (`reconcile.ts`).
- **Relayed is reported, never guessed.** `meshState.relayed` (this node
  reaches some peer through a relay; still end-to-end encrypted) rides into
  `LiveMeshPeer.relayed` and `MeshPeerView.relayed`. It is `null` until an
  agent reports it, and a report without the field (an old agent) keeps what
  was known: never read a missing value as "direct". It is per SERVER, not per
  link, so the map draws every link of a relayed server through the relay.
  Headscale's is read from `tailscale status --json` per ACTIVE peer
  (`handlers/mesh-tailscale.ts`): a direct endpoint (`CurAddr`) is
  peer-to-peer, `Relay`/`PeerRelay` without one is relayed, and with no active
  peer the field is left out (unknown) — never a blanket `true`.
- **A node that skips the mesh-first join says why.** `meshSkipReason`
  (`apps/agent/src/mesh-startup.ts`) is the one line the daemon logs when
  `SWARMY_ALLOW_MESH=false` or no setup key is configured; `doctor`'s mesh rung
  shows it (see `skill("node-recovery")`). A repair one-liner moves the mesh
  config as one unit (`apps/api/src/install/repair-env-sh.ts`).

## File map

| Concern | Where |
|---|---|
| Driver interface, config schema, `DriverControlPlane` | `packages/mesh/src/types.ts` |
| Driver registry (`defaultRegistry`, `none`+`netbird` first) | `packages/mesh/src/registry.ts` |
| Drivers (netbird/headscale/none) | `packages/mesh/src/drivers/*` |
| NetBird Admin-API client (setup-keys/peers/groups/policies) | `packages/mesh/src/control-plane/netbird.ts` |
| Pure peer reconcile mapping | `packages/mesh/src/reconcile.ts` |
| provision/preview/status orchestration (pkg-level) | `packages/mesh/src/apply.ts` |
| Wire/render protocol (`RenderedMesh`, `applyMesh`, `meshState`) | `packages/core/src/protocol/mesh.ts` (+ `messages.ts` union) |
| `CommandName` → wire `type` (`applyMesh`, `mesh.accessRouter`) | `packages/trpc/src/hub/types.ts` |
| Controller service (enroll, config, reconcile) | `packages/trpc/src/services/mesh.service.ts` |
| tRPC router (config/enroll/peers/people/control) | `packages/trpc/src/routers/mesh.ts` |
| "Servers on the mesh" check (refuses turning the mesh off under them) | `packages/trpc/src/services/mesh-onmesh.ts` |
| Encrypt/decrypt service token, random keys | `packages/core/src/crypto.ts` |
| Agent: sidecar apply, `meshState` sampler | `apps/agent/src/handlers/mesh.ts` (Headscale's relayed: `mesh-tailscale.ts`; interface MTU + overlays: `mesh-mtu.ts`) |
| Agent: executor cases + `SWARMY_ALLOW_MESH` gate + mesh-first join | `apps/agent/src/{executor,env,daemon,mesh-startup}.ts` |
| Overlay MTU (option + check) and "Networks are too big for the mesh" | `packages/core/src/overlay-mtu{,-check}.ts`, `packages/trpc/src/services/mesh-mtu.service.ts` (`mesh.mtu`) |
| Live peer map (no table) + `reconcileMeshPeer` | `packages/trpc/src/services/mesh-peers.ts` |
| Gateway `meshState` → live peer map | `apps/api/src/gateway/protocol-handlers.ts` |
| DB models | `packages/db/prisma/schema/mesh.prisma` (MeshRoute: `kind=person` grants) |
| Self-hosted control plane: config render, Litestream render, pinned images | `packages/mesh/src/control-plane/{server-config,litestream}.ts`, `packages/mesh/src/images.ts` |
| NetBird Admin API slice + the people/bootstrap diff (namespaced `swarmy:<c>:*`) | `packages/mesh/src/control-plane/{netbird-admin,people-sync}.ts` |
| People access: names, `declaredPorts`, `buildPeopleAccessPlan`, `planUserSync`, `dexSubject` | `packages/mesh/src/people.ts` |
| Agent: `swarmy-mesh-control` supervisor (tmpfs config, cold-boot copy, Litestream sidecar) | `apps/agent/src/handlers/mesh-control.ts` (+ 10 s tick in `daemon.ts`) |
| Agent: `swarmy-access-<stack>` routers (+ VIP resolve over Docker DNS) | `apps/agent/src/handlers/access-router.ts` |
| Controller: managed control plane (card, reconcile, connector, break-glass, move, edge vhost) | `packages/trpc/src/services/mesh-control.service.ts` |
| Controller: people access (intent, routers, sync, connect info, who's connected, grants) | `packages/trpc/src/services/mesh-people.service.ts` |
| 30 s reconcile worker | `apps/api/src/workers/mesh-people-reconcile.ts` |
| Relays on edges: names `relay.<a-b-c-d>.<base>`, the plan + one reconcile decision (pure) | `packages/mesh/src/control-plane/{relays,relay-plan}.ts`, `server-config.ts` (`externalRelays`) |
| Agent: `swarmy-mesh-relay` supervisor (tmpfs env, its own `SWARMY-MESH-RELAY` firewall chain) | `apps/agent/src/handlers/mesh-relay{,-spec}.ts` (+ the 10 s tick in `daemon.ts`), protocol `packages/core/src/protocol/mesh-relay.ts` |
| Controller: relay reconcile (control-plane step 4b), relay vhosts, the card's relays | `packages/trpc/src/services/mesh-relay{.service,-live}.ts` |
| People login expiry (12 h default, clamp, per-peer floor) | `packages/mesh/src/login-expiry.ts`, `control-plane/login-expiry-sync.ts` |
| Grant TTL sweeper (expired personal grants → `revokePersonGrant`, system actor) | `packages/mesh/src/grant-ttl.ts` (pure), `packages/trpc/src/services/mesh-grant-ttl.service.ts`, `apps/api/src/workers/mesh-grant-ttl.ts` |
| Installer `--mesh swarmy` (starts NetBird before `swarm init`) | `scripts/install-swarmy.sh` (`ensure_mesh_control`) |
| e2e on Lima (install, join, person connects/denied/revoked) | `scripts/e2e-mesh-people.ts` |
| Networking UI: the private network as a map (NAT'd servers behind the router, direct vs relayed links, who's joining) + per-app laptop access on the Access tab | `apps/app/src/routes/_authed/networking.tsx` → `components/networking/private-network-page.tsx` (`mesh-graph{,-model}.ts(x)` pure + tested, `use-nat-nodes.ts` reads `swarmy.node.reachability`), `routes/_authed/stacks/$name.access.tsx` |
| Mesh settings: NetBird or None (typed "turn off" confirm naming the NAT'd servers that drop off), every peer's last word, the laptop grants | `routes/_authed/networking_.settings.tsx` → `components/networking/{mesh-settings-page,mesh-driver-pick,turn-off-mesh,mesh-peers-section,direct-connect-section}.tsx`; driver labels in `mesh-format.ts` |

## Adding a mesh driver (the recipe)

1. **Driver** in `packages/mesh/src/drivers/<name>.ts` implementing `MeshDriver`:
   `validate` (pure), `provisionNode` (control-plane side — mint key via injected
   `DriverControlPlane`), `render` (pure `RenderedMesh`) and `status`. Keep the WireGuard interface name
   + client image as exported consts (see `NETBIRD_INTERFACE = 'wt0'`). Check
   with the owner first: Tailscale and raw WireGuard were removed in 2026-09.
2. **Register** it in `defaultRegistry` (`registry.ts`) and re-export from
   `packages/mesh/src/index.ts`.
3. **Controller wiring**: add the id to the `driverEnum` in `routers/mesh.ts` and
   the `DRIVER_TO_ENUM`/`ENUM_TO_DRIVER` maps + Prisma `MeshDriver` enum
   (`mesh.prisma`). If the provider has a real Admin API, teach `makeControlPlane`
   to return a real client for it; otherwise the opaque-key stub is fine.
4. **Agent apply** (only if the client is a new shape): most providers reuse the
   NetBird sidecar or the tailscale-client sidecar in `applyMesh` — don't add a provider branch to the agent unless the client is
   genuinely new, and gate any new privileged path behind `SWARMY_ALLOW_MESH`.
5. **UI**: add the id to `MeshDriverId` and `DRIVER_LABELS` in
   `components/networking/mesh-format.ts`, and a pick + copy in
   `mesh-driver-pick.tsx` (Mesh settings).

For a whole cross-stack feature (db → protocol → service → router → UI) see
`skill("add-feature-slice")`; this skill is the mesh-specific slice of it.

## Self-hosted control plane + people (plans/epic-self-hosted-mesh-and-fleets.md)

- `--mesh swarmy` (installer default): `swarmy-mesh-control` (combined
  `netbird-server`, host network, NOT a swarm service) is started by the
  installer and then supervised by the node's agent. Its config (relay secret,
  store key) lives only in the container's tmpfs, written via `docker exec`;
  the agent's 0600 copy in its state dir restores it after a restart even when
  the controller is unreachable (cold-boot deadlock otherwise).
- The combined server ignores `disableDefaultPolicy`: the bootstrap deletes the
  All↔All `Default` policy before any peer joins. `NB_DISABLE_GEOLOCATION=true`
  (not `disableGeoliteUpdate`) stops the 73 MB download. `:9000/health` is the
  relay's TLS check — liveness is a TCP connect to 33073.
- NetBird only accepts an **https** IdP issuer; private CAs go through
  `MeshControlSpec.caPem`. The connector's callback is `<mesh>/oauth2/callback`.
- Every NetBird object swarmy writes is `swarmy:<c>:*` / `swarmy-<c>-*`; the diff
  never touches anything else. People reach only declared ports on service VIPs
  through the stack's router; nothing ever targets `swarmy:<c>:nodes`.
- **Reboots (QA-059):** a worker re-derives its swarm address from the route to
  the manager at dockerd start, before wt0 exists. `swarmy-mesh-pin.service`
  (Before=docker) pins the mesh IP/prefix on dummy `swarmy-mesh0` (metric 4242);
  the agent installs/re-asserts it (`handlers/mesh-pin.ts`) and self-heals
  mis-keyed IPsec SAs with one dockerd restart. Never remove the pin.
- **Relays on edges** (`relaysOnEdges`, installer `--mesh-relay-on-edges`, needs
  `tls: edge`): NetBird's combined server runs its own relay + STUN unless
  `server.relays` is set, and then NEITHER. So `relays` and `stuns` are always
  rendered together, the switch waits for one healthy edge relay, and the list
  is identity (planned edges), not health. The control node's own relay runs
  STUN only once NetBird there runs the external config (its STUN holds UDP
  3478 until then); on the way back the relays stop BEFORE NetBird restarts.
  Relays listen plain on :33080 behind the edge vhost `relay.<a-b-c-d>.<base>`
  (health 33081 loopback, metrics 33082, firewalled).
- People's devices log in again after the org's `loginExpiryHours` (12 h,
  1 h .. 30 d): the bootstrap asserts the org's value (never a constant), and
  the people sync turns a person's peer back onto expiry. Setup-key peers
  (servers, routers) never expire.
- People access is off until an admin enables it; revoke converges at once, the
  worker every 30 s; personal grants expire by `MeshRoute.expiresAt` (left out
  of the plan at once; the `mesh-grant-ttl` worker revokes the row, audited as
  `system` with `reason: 'expired'`).

## Operational gotchas

- The sidecar needs `NET_ADMIN` + `/dev/net/tun` and runs `NetworkMode: 'host'`;
  it is privileged for a reason — never widen its caps casually. Every mesh
  image (NetBird client/server, Headscale's tailscale client, Litestream) is
  pinned by tag + digest in the SYSTEM_IMAGES BOM, the one source:
  `packages/mesh/src/images.ts` and the agent defaults derive from it
  (`pinnedTaggedRef`), and a test holds the installer's defaults to it.
- Overlay MTU is mesh-aware (`packages/core/src/overlay-mtu.ts`). Docker reads
  `com.docker.network.driver.mtu` as the LINK MTU and takes VXLAN (50) and ESP
  (26) off itself, so the option is the tunnel MTU: `wt0`/`tailscale0` 1280 →
  containers 1230 (1204 encrypted). Never pre-subtract (1230/1170 were the old,
  over-cautious values). The installer creates `swarmy`/`swarmy-control` with
  it, stack overlays get it from `overlayOptionsFor(ctx)` when the org mesh is
  on, and the agent's `ensureNetwork` makes every new overlay without an MTU
  inherit the platform overlay's. An EXISTING overlay's MTU can't change in
  place (recreate = disruptive, no safe path): agents report `interfaceMtu` +
  `overlays` in `meshState`, `mesh.mtu` runs `checkOverlayMtu`, and Mesh
  settings shows "Networks are too big for the mesh" with the manual steps.
  `scripts/verify-networking.sh` (2 MB cross-node transfer) tells you if it bites.
- The network wall (`network-policy.ts`): the controller (its store is embedded) +
  ClickHouse live only on the private `swarmy-control` overlay; user specs may
  never join it nor alias names on the shared `swarmy` overlay (admission
  refuses, not overridable; the agent strips such aliases as a floor).
- Live peers use the `reconcilePeerState` domain (`ENROLLING`/`ENROLLED`/
  `CONNECTED`/`DEGRADED`/`FAILED`). After a controller restart the map refills
  within one 20 s `meshState` tick; `listPeers` fills gaps from the control plane.
- **The swarm is born on the mesh.** With `--mesh netbird-*` the installer
  mints a one-off key, starts `swarmy-netbird` (state volume `swarmy-netbird`,
  which `applyMesh` adopts instead of recreating: a re-create is a NEW peer
  with a NEW IP) and runs `swarm init --advertise-addr/--data-path-addr <wt0>`.
  Its printed Add-a-node line carries a reusable key. Why it matters: Docker
  keys each encrypted-overlay IPsec SA on ADVERTISED addresses; a manager on
  its public IP talking to mesh-IP workers sources packets from its mesh IP,
  the SAs never match, and the `swarmy` overlay (every ingress route) goes
  dark (fix: `swarmy-agent rejoin --force` on the off-mesh manager).
- A swarm is moved on or off the mesh only by reinstalling a server (the
  dashboard migration was removed in 2026-09). `mesh.setEnabled(false)` refuses
  while any server's swarm advertise address is on the mesh
  (`mesh-onmesh.ts#nodesOnMesh`).
- The cross-region edge (region-aware Caddy + geo-DNS) rides on the reachability
  the mesh provides — coordinate boundary changes with `skill("geo-edge-routing")`.
- Verify: `bun --filter @swarmy/mesh typecheck && bun --filter @swarmy/mesh test`
  (driver + reconcile goldens), then `bun --filter @swarmy/agent typecheck`.
  Multi-node: `scripts/local-vms.sh` — enroll a second-region VM, watch its peer
  reach `CONNECTED`, then grant a person access and connect from a laptop (`scripts/e2e-mesh-people.ts`).
