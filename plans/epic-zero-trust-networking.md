## Plan Doc — Epic: Zero-trust mesh networking + direct stack connect

## Problem

swarmy nodes today must reach each other and the controller over routable IPs. That breaks the headline promise ("anyone can just deploy") the moment nodes live in different clouds, behind NAT, or at home/on-prem: Docker Swarm's overlay (VXLAN 4789 + gossip 7946 + manager 2377) needs flat, mutually-reachable addresses, which means VPCs, firewall rules, public IPs, and load balancers — exactly the ops swarmy is meant to erase. Two distinct needs fall out of this:

1. **Secure multi-location clustering.** Let any node (any cloud, on-prem, home, a DR box) join one swarm securely, with swarm control/data-plane and agent↔controller traffic riding an encrypted overlay — no inbound ports, NAT-friendly, WireGuard-grade.
2. **Direct stack connect.** Let an operator (or a CI box, or a teammate's laptop) get a *direct, authorized, point-to-point* route to a specific stack/service — e.g. hit Postgres on its real port, attach a debugger, run migrations — without publishing it to the internet or terminating at an ingress. This is "more control": the user bypasses swarmy's ingress and talks straight to the workload over the mesh, gated by ACLs.

Both are the same primitive — a zero-trust WireGuard mesh, provisioned per node by the agent, with identity tied to swarmy orgs and access expressed as ACLs/tags — exposed two ways.

## Recommended approach

**Default: NetBird. Pluggable via a `MeshDriver` registry so Headscale, Tailscale, and raw WireGuard are first-class alternatives.** This mirrors the existing `@swarmy/ingress` `IngressDriver` pattern exactly, which keeps swarmy unopinionated.

**Why NetBird as default:**
- **Open all the way down + self-hostable control plane.** Management, Signal, and Relay are open source and (since v0.65, Feb 2026) ship as a *single unified server binary/container* — swarmy can run the whole control plane next to `apps/api` with one extra compose service. Tailscale's coordination server is proprietary (you'd depend on a vendor SaaS for the control plane); Headscale is self-hostable but is an unofficial reimplementation of Tailscale's control protocol with no official support contract.
- **Programmable for zero-config onboarding.** NetBird's model is *setup keys with auto-assign groups* + an Admin API for keys/groups/policies/routes, plus a bootstrap PAT (`NB_SETUP_PAT_ENABLED` → `POST /api/setup`). swarmy can mint a one-time setup key server-side, embed it in the install one-liner, and the node joins the right groups automatically — the entire "tag this node, grant this route" flow is API-driven, which is what makes the UX one-command. Headscale's ACLs are a JSON/HuJSON file (great for GitOps, awkward to drive from a dashboard CRUD UI). Tailscale's API is good but gates the control plane behind SaaS.
- **WireGuard data plane = identical raw performance** to Tailscale/Headscale (all three are WireGuard under the hood), so we lose nothing on throughput by self-hosting; direct P2P is the same kernel WireGuard tunnel. The only differentiator is the control/relay plane, where NetBird's self-hostability wins.
- **Identity tie-in.** NetBird does OIDC/SSO and groups; swarmy orgs map to NetBird "accounts"/groups, and Better Auth identities can later federate via OIDC. Until then, swarmy is the system-of-record and drives NetBird purely via its API with a service token.

**Alternatives weighed:**
- **Tailscale (SaaS control plane).** Best "just works" and best NAT traversal/DERP fleet. But the coordination plane is proprietary and hosted by a third party — a hard conflict with swarmy's self-hostable, source-available positioning and with "off-cloud DR" where you may not want a SaaS dependency in the critical path. Offered as a `MeshDriver` for users who already live in Tailscale and supply an auth key + (optionally) an OAuth client + tailnet.
- **Headscale (self-hosted Tailscale control).** Reuses the polished official Tailscale clients and DERP. Excellent for GitOps shops. Downsides: unofficial, file-based ACLs (clunky to expose as dashboard CRUD), and you still lean on Tailscale's DERP relays unless you run your own. Offered as a `MeshDriver`; recommended toggle for teams who prefer config-as-code ACLs.
- **Raw WireGuard.** Maximum control, zero extra moving parts, no control plane to run. But *we'd* have to build key exchange, NAT traversal/hole-punching, relay fallback, and ACL enforcement — i.e. reimplement what NetBird already is. Offered as a minimal `MeshDriver` (`wireguard`) for advanced/air-gapped users on a flat private network who just want swarmy to template `wg0` configs and apply them via the agent — explicitly "you own routing/NAT" like the `none` ingress driver.

**Client install:** use NetBird's official Docker client (`netbirdio/netbird`, env `NB_SETUP_KEY` / `NB_MANAGEMENT_URL`, caps `NET_ADMIN`/`SYS_ADMIN`/`SYS_RESOURCE`) rather than embedding NetBird as a Go library (embedding is still an open issue upstream, and swarmy's agent is Bun/TS, not Go). The agent shells out to / supervises the NetBird client container or the host `netbird` CLI — consistent with how the ingress agent code writes config and runs reload commands today.

## Architecture & integration

The mesh plugs in as a **new pluggable subsystem mirroring `@swarmy/ingress`**: a `@swarmy/mesh` package with a `MeshDriver` registry (`netbird` | `headscale` | `tailscale` | `wireguard` | `none`), a controller-side service layer that drives the chosen control plane's API, new protocol commands so the agent installs/joins the mesh, new DB models, a tRPC router, and dashboard surfaces. Generic-intent principle is preserved: the agent receives a driver-agnostic "apply this mesh membership" payload (analogous to `RenderedConfig`), so adding a mesh provider is a new driver + render, never an agent rewrite.

### New package: `@swarmy/mesh`
- `MeshDriver` interface (transport-agnostic, like `IngressDriver`):
  - `validate(config)`, `provisionNode(node, opts) → MeshEnrollment` (control-plane side: mint setup key / pre-auth key / generate WG keypair, assign groups/tags), `renderAgentConfig(enrollment) → RenderedMesh` (pure; what the agent applies), `applyAccess(intent, dispatch) → MeshAccessState` (push ACL/policy to control plane), `status(dispatch) → MeshStatus`, `deprovisionNode(node)`.
  - `DriverControlPlane` interface (impl in `apps/api`) abstracts the provider Admin API: `createSetupKey`, `upsertGroup`, `upsertPolicy`, `listPeers`, `revokePeer`, `routes`. NetBird/Headscale/Tailscale each implement it; `wireguard` does keypair gen + peer-list rendering; `none` is a no-op recorder (parity with the `none` ingress driver — record intent, write nothing).
- `defaultRegistry = new MeshRegistry().register(new NetbirdDriver())...` exactly like `ingress/registry.ts`.

### New core protocol (`packages/core/src/protocol/mesh.ts`, added to both discriminated unions in `messages.ts`)
Controller→agent commands:
- **`applyMesh`** — carries a `RenderedMesh` (the mesh analog of `RenderedConfig`): `{ driver, action: 'join'|'leave'|'reconfigure', client: { kind:'netbird'|'tailscale'|'wireguard', image?, managementUrl?, setupKey?(secret), preAuthKey?(secret), wgConfig?(RenderedFile), interface:'wt0'|'wg0' }, advertiseRoutes?: string[], acceptRoutes?: boolean, summary }`. Agent installs/launches the client container (or writes `wg0` + `wg-quick up`), joins, and reports back. Secrets are single-use and short-TTL.
- **`configureSwarmDataPath`** — `{ commandId, meshIp, mode:'init'|'join', advertiseAddr, listenAddr, dataPathAddr, joinToken?, managerAddrs? }`. Re-pins swarm's control/data plane onto the mesh interface using `--advertise-addr/--listen-addr/--data-path-addr = <meshIp>` (the documented WireGuard-over-swarm pattern). For existing single-host clusters this is informational; for multi-location joins the agent runs `docker swarm join` against a manager's *mesh* IP.
- **`grantDirectRoute`** / **`revokeDirectRoute`** — `{ commandId, target:{ stackId?|serviceId?|host:port }, principal:{ meshPeerId | groupTag }, ttl? }`. Drives an ACL/policy change for "direct stack connect." (Most enforcement is control-plane-side via `applyAccess`; the agent command exists so node-local WireGuard driver can also gate via `iptables`/peer allowed-IPs when there's no control plane.)

Agent→controller messages:
- **`meshState`** — `{ nodeId, driver, interface, meshIp, peerId, connected, lastHandshakeAt, relayed:boolean, advertisedRoutes, error? }` (mirrors `IngressStatus`/`ServiceStateMsg`; feeds the in-memory snapshot store + DB).

`CommandResult`/`Ack`/`AgentError` reuse existing result types. New `E_MESH_*` error codes alongside `E_DOCKER`/`E_EXEC_DISABLED`.

### New DB models (`packages/db/prisma/schema.prisma`)
- `enum MeshDriver { NETBIRD HEADSCALE TAILSCALE WIREGUARD NONE }`
- `MeshConfig` — org-scoped 1:1 like `IngressConfig`: `{ orgId @unique, driver MeshDriver @default(NONE), enabled, controlPlane Json (mode: 'managed-by-swarmy'|'external'|'saas', url, encrypted service token ref), settings Json, createdAt, updatedAt }`. Control-plane secrets stored encrypted (KMS/`BETTER_AUTH_SECRET`-derived envelope), never returned to client.
- `MeshPeer` — one per node's mesh membership: `{ id, orgId, nodeId (unique), driver, peerId (provider id), meshIp, publicKey?, interface, connected, relayed, lastHandshakeAt, advertisedRoutes Json, groups Json, status, createdAt, updatedAt }`. Add `Node.meshPeer MeshPeer?` relation and a nullable `Node.meshIp` for quick display.
- `MeshRoute` — direct-connect grants + advertised subnets: `{ id, orgId, kind:'direct'|'subnet', targetServiceId?/targetStackId?/cidr?, port?, principalType:'peer'|'group'|'member', principalId, policyRef (provider policy id), expiresAt?, createdById, createdAt }`. Audited.
- `MeshGroup` (optional, phase 2) — caches provider group/tag ids for org/stack/service tags so policy diffs are cheap.
- Every mesh mutation writes `AuditLog` (`mesh.peer.join`, `mesh.route.grant`, etc.), reusing the existing audit model.

### New service layer + tRPC router
- `packages/trpc/src/services/mesh.service.ts` — orchestrates: pick driver from registry, call `provisionNode` (mint setup key via `DriverControlPlane`), persist `MeshPeer`, dispatch `applyMesh` over the existing `AgentHub` (same `dispatch.service.ts` + commandId correlation used by ingress/deploys), reconcile `meshState` reports. Direct-connect: `grantDirectRoute` → `applyAccess` (control-plane policy) + persist `MeshRoute` + optional agent `grantDirectRoute`.
- `packages/trpc/src/routers/mesh.ts` (`meshRouter`) — `orgProcedure`/`adminProcedure` parity with `nodes.ts`/`ingress.ts`:
  - `getConfig`, `setDriver`, `enable`/`disable`, `previewAccess` (renders ACL diff for inspection, like ingress `previewConfig`).
  - `enrollNode(nodeId)` → returns install snippet; `peers.list`, `peer.status` (live via `ctx.hub` snapshot + subscription, mirroring `liveStats`), `peer.remove`.
  - `routes.list`, `routes.grant({ target, principal, ttl })` (`adminProcedure`), `routes.revoke`.
  - `directConnect({ serviceId|stackId })` → returns the mesh IP:port + a one-time setup key + ready-to-paste `netbird up`/`wg` snippet so a laptop/CI joins as an ephemeral peer scoped (via auto-group) to just that target.
- Control-plane lifecycle: when `driver=netbird` and `mode=managed-by-swarmy`, `apps/api` brings up the unified NetBird server (compose/`docker/netbird/`), bootstraps via `POST /api/setup` PAT, stores a service token; a metrics-style worker polls peer status to reconcile `MeshPeer.connected`.

### Agent capabilities (`apps/agent/src/`)
- New `mesh.ts` executor module + cases in `executor.ts` for `applyMesh`, `configureSwarmDataPath`, `grantDirectRoute`/`revokeDirectRoute` — same `run()` wrapper + `commandResult` reporting as today. `applyMesh` supervises the NetBird client container via dockerode (or writes `wg0` + runs `wg-quick`/`netbird up` via the existing `execShell` helper). Reuses the file-write + reload-command machinery already in `applyIngress`.
- New `meshState` reporter loop (alongside `sendContainerList`/`collectMetrics`), reading `netbird status --json` / `wg show` and emitting `meshState`. Reuses the `RenderedFile` write helper for `wg` configs.
- Gating: like `ALLOW_EXEC`, an agent env `SWARMY_ALLOW_MESH` (default on, but disableable) so a node can refuse mesh provisioning.

### UI surfaces (`apps/app`)
- **Settings → Networking (Mesh)**: driver picker (netbird/headscale/tailscale/wireguard/none) with enable toggle + control-plane mode (managed-by-swarmy / point at external URL / Tailscale SaaS key) — same shape as the Ingress settings page.
- **Nodes**: per-node mesh badge (mesh IP, connected/relayed, last handshake) on the node detail; "Enroll in mesh" action surfacing the one-line installer; off-cloud/DR nodes show provider relay vs direct.
- **Service/Stack detail → "Connect" tab**: a "Direct connect" button → modal with the mesh address (`<svc>.mesh:<port>` / mesh IP), a copy-paste join snippet (`netbird up --setup-key …`), the ACL it will create, and a TTL. Lists/revokes existing direct routes.
- **Mesh overview**: peer map (nodes + transient direct-connect peers), route/policy list, audit trail.

## MVP vs later

**MVP (phase 1) — "secure multi-location swarm, NetBird default, one command":**
- `@swarmy/mesh` with `NetbirdDriver` + `NoneDriver`; registry.
- Protocol: `applyMesh`, `configureSwarmDataPath`, `meshState`. DB: `MeshConfig`, `MeshPeer`, `Node.meshIp`.
- Control plane: NetBird unified server as an optional swarmy-managed compose service + bootstrap PAT; service token stored encrypted. (Also support pointing at an *external/existing* NetBird via URL+token — lower lift, ship both.)
- Agent: launch NetBird client, join via setup key, re-pin swarm to mesh IP, report `meshState`.
- tRPC: `meshRouter` config + enroll + peers; install one-liner includes the setup key.
- UI: Settings → Mesh, node mesh badges, enroll action.
- Outcome: mint token in dashboard → run one command on a node in any cloud/home → it joins the swarm over WireGuard with no inbound ports.

**Phase 2 — "direct stack connect" + ACLs:**
- `grantDirectRoute`/`revokeDirectRoute`, `MeshRoute`, `applyAccess` driving NetBird groups/policies; auto-group per stack/service.
- Service/Stack "Connect" tab + ephemeral peer setup keys (laptop/CI direct connect).
- DR flow: tag a node `dr`, advertise subnet routes, document failover.

**Phase 3 — pluralism + polish:**
- `HeadscaleDriver`, `TailscaleDriver`, `WireGuardDriver`.
- OIDC federation: Better Auth org/user → NetBird IdP (SSO instead of pure service-token control).
- Posture checks (require agent version / OS), mesh peer map UI, relay metrics, key rotation automation.

## Dependencies
- **Nodes/agent epic (existing):** reuses join-token enrollment, session-secret reconnect, `AgentHub` dispatch, snapshot store, command-result correlation — all already built. No changes needed beyond new message types.
- **Ingress epic (existing):** structural template (driver registry, `RenderedConfig`→`applyMesh`, `previewConfig`→`previewAccess`, `DriverDispatch`→`DriverControlPlane`). Mesh and ingress are independent and individually disableable.
- **Secrets/encryption:** need an envelope-encryption helper for control-plane tokens & setup keys (derive from `BETTER_AUTH_SECRET` or add a `SWARMY_MASTER_KEY`). Coordinate with auth/db.
- **Infra:** if `managed-by-swarmy`, the controller host must be able to run the NetBird server container and expose Signal/Relay ports (the one inbound surface — a single relay endpoint, not per-node). Coturn/STUN optional for better NAT traversal.
- **Deploy epic:** `configureSwarmDataPath` must coordinate with how swarm is bootstrapped so re-pinning the data path doesn't fight the deploy flow.

## Risks & open questions
- **Re-pinning an existing swarm to a new (mesh) data-path is disruptive** — `--data-path-addr` can't be changed on a running node without leaving/rejoining the swarm (known moby behavior/bugs). MVP should *initialize* multi-location swarms on the mesh from the start; converting an in-place cluster is a guided, drain-one-node-at-a-time migration, not a one-click. Open question: detect "already-swarmed-on-LAN" and gate migration behind a confirm flow.
- **MTU.** WireGuard (~1420) under VXLAN (50B) under the mesh can fragment/blackhole. Need to set overlay/`docker_gwbridge` MTU and document; consider auto-detecting and lowering MTU on mesh-attached overlays.
- **NetBird relay reach for global DR.** Self-hosted relay in one region is a latency/availability SPOF for far-flung nodes; multi-region relays are extra ops. Mitigation: default to swarmy-managed relay but expose "bring your own relays" and document Tailscale/DERP as the escape hatch.
- **Embedding vs supervising the client.** Running the NetBird client as a privileged container (SYS_ADMIN/eBPF) on every node is a larger attack surface than the agent today; gate with `SWARMY_ALLOW_MESH`, pin image digest, document caps. Open question: host `netbird` package vs sidecar container per node — sidecar is more portable, host install is lighter.
- **Identity model gap.** MVP uses a swarmy service token as NetBird account owner (swarmy is system-of-record). True per-user SSO/OIDC federation (so revoking a Better Auth member revokes mesh access) is phase 3 — interim risk that mesh ACLs and org membership can drift; mitigate by reconciling on member changes.
- **Direct-connect security.** A direct route to Postgres bypasses ingress and any app-layer auth — ACL + TTL + audit are the only guardrails. Default direct routes to short TTL, require `adminProcedure`, and always audit.
- **Licensing/commercial.** NetBird, Headscale, Tailscale clients have distinct licenses; confirm "self-host the control plane + redistribute installer" is clean for the source-available commercial model (NetBird is BSD-3 client / AGPL-ish server components — verify before bundling vs install-on-demand).

## Simplicity note
The whole point is that mesh stays **invisible and optional**, exactly like ingress. Default org config is `driver = none` — swarmy works on a flat LAN with zero mesh, no new processes. Turning it on is one dashboard toggle ("Networking → enable mesh, driver NetBird, managed by swarmy"), after which the existing node-join one-liner simply *also* carries a single-use NetBird setup key; the agent installs the client, joins the WireGuard mesh, and re-pins swarm automatically — the operator runs the same one command and gets a cross-cloud, NAT-free, encrypted cluster with no firewall edits, no public IPs, no VPC. Direct stack connect is one button on a service that returns a copy-paste `netbird up` snippet scoped to just that workload. swarmy owns the control plane and all the API plumbing; the user never sees a WireGuard key, an ACL file, or a port-forward. Everything is org-scoped, audited, and individually disableable — pluralism (Headscale/Tailscale/raw WG) is there for power users without complicating the default path.

---

Plan doc complete. Key integration anchors verified against the live scaffold: the `MeshDriver` registry mirrors `/home/user/swarmy/packages/ingress/src/registry.ts`; `applyMesh`/`RenderedMesh` mirror `RenderedConfig`/`applyIngress` in `/home/user/swarmy/packages/core/src/protocol/ingress.ts` and `/home/user/swarmy/apps/agent/src/executor.ts`; new protocol messages slot into both discriminated unions in `/home/user/swarmy/packages/core/src/protocol/messages.ts`; DB models follow the `IngressConfig`/`Domain`/`Node` shapes in `/home/user/swarmy/packages/db/prisma/schema.prisma`; the `meshRouter` follows `/home/user/swarmy/packages/trpc/src/routers/nodes.ts` (org/admin procedures, `ctx.hub` live subscriptions); the agent join one-liner extends `/home/user/swarmy/README.md`'s `SWARMY_JOIN_TOKEN` flow.
