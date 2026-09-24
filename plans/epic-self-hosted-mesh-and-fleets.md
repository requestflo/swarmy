# Epic: self-hosted mesh, people on the mesh, and fleets of clusters

Status: **M0 spike done, M1/M2 building, 2026-09-24** (spike results in §11,
main's picks on §9 recorded there). Owner decisions taken: the mesh control plane
runs **inside swarmy** (self-hosted NetBird). NetBird Cloud is optional at
most. **People** join the mesh too, not just servers. Owning skills:
`mesh-networking` (mesh), `geo-edge-routing` (edge/DNS), `auth-abac`
(grants), `backups-dr` (state restore). This plan supersedes B1 in
[`self-reliance.md`](./self-reliance.md), which proposed Headscale. It aligns
with [`epic-docker-native-state.md`](./epic-docker-native-state.md) (SQLite +
Litestream to Garage) and the environments phase of
[`epic-git-apps.md`](./epic-git-apps.md).

The questions this answers:

1. Can swarmy host NetBird itself? **Yes.** One ~105 MiB container on node #1's
   host network, started before the swarm exists. Swarmy is its identity
   provider.
2. How do people reach apps? They run the NetBird client and sign in with
   their swarmy account (including SSO). A small router per stack lets them
   reach only the services and ports of the stacks they are granted. Default
   is deny.
3. Multiple clusters and controllers? At launch: **independent clusters with a
   fleet switcher**, each with its own controller and mesh. Later: **a fleet
   hub** that federates read views and promotes releases between clusters.
   Never one controller for many swarms. A few identifiers must be designed in
   now (§8).

---

## 1. Facts, checked 2026-09-24

Sources: docs.netbird.io (quickstart, combined container, configuration
files, external reverse proxy, automated setup, identity providers, HA,
custom zones, networks) and Better Auth v1.6.23 docs. Numbers are from a local
run of the real images (Docker 29.6, arm64 Docker Desktop).

| Fact | Detail |
|---|---|
| Current release | NetBird **v0.79.0** (2026-09-18). Headscale **v0.29.4**. |
| Shape | Since v0.65 the **combined** `netbirdio/netbird-server` runs management, signal, relay and an embedded STUN server in **one process**. `netbirdio/dashboard` is a separate, optional web UI. The old coturn/TURN server is gone: relay runs over WebSocket (`rels://<host>:443`). |
| Ports | **TCP 443** (HTTPS: REST `/api`, IdP `/oauth2`, relay `/relay`, and gRPC for management and signal) and **UDP 3478** (STUN, "cannot be proxied"). TCP 80 only for ACME HTTP-01. |
| Reverse proxy | gRPC needs **h2c** to the backend. NetBird's own Caddy example: `@grpc header Content-Type application/grpc*` goes to `h2c://netbird-server:80`; `/relay* /ws-proxy/* /api/* /oauth2/*` go to `netbird-server:80`. Proxies need day-long stream timeouts. |
| TLS | Off by default ("using reverse proxy"). The binary also has `tls.certFile/keyFile` and `tls.letsencrypt` config, so it can terminate TLS itself. |
| Identity | Since v0.62 an **embedded Dex IdP** is built in and cannot be turned off in the combined server. External OIDC providers are added as connectors (`POST /api/identity-providers` with `type: oidc`, `issuer`, `client_id`, `client_secret`). They need a **confidential** client. The callback is `https://<host>/oauth2/callback/<connector-id>`. `server.auth.localAuthDisabled` hides local password login. |
| Bootstrap | With `NB_SETUP_PAT_ENABLED=true`, `POST /api/setup {email,name,password,create_pat:true}` creates the owner and returns a one-time `nbp_…` PAT. This only works while setup is required. **Verified locally**: the call returned a PAT, and the PAT minted a one-off setup key. |
| Storage | `server.store.engine`: `sqlite` (default), `postgres`, `mysql`. The data dir holds `store.db`, `idp.db`, `events.db`, all SQLite (about 0.9 MB fresh), plus downloaded GeoLite files (about 73 MB). `server.store.encryptionKey` encrypts sensitive columns. |
| Phone-home | On first boot it **downloads GeoLite2 + geonames (about 73 MB)** from NetBird's CDN. It sends anonymous metrics by default. Both have switches in the binary (`disableGeoliteUpdate`, `disableAnonymousMetrics`). `disableDefaultPolicy` also exists, which skips the permissive "All → All" policy. |
| Resources | Docs: 1 vCPU / 2 GB for the quickstart; "~1 GB vs 2–4 GB" for the combined setup. **Measured idle, 0 peers: netbird-server 105 MiB, dashboard 26 MiB, headscale 15 MiB.** |
| HA | Active-active management and signal need the **NetBird Enterprise commercial licence** (stateless replicas on Postgres + Redis). The open-source build is one active instance. Relays can be split out and multiplied (`server.relays`). |
| Tunnels without the control plane | Established WireGuard tunnels are peer-to-peer and keep working. **New** connections need signal (offer/answer), so while the control plane is down no new peer joins, a restarted peer cannot re-handshake, and relayed pairs lose their relay. There is a known client bug (netbird#7430, v0.77.1) where the signal stream does not retry after a long outage. |
| People features | **Networks** (routing peers + resources: IP, CIDR, domain), policies with **ports and protocols**, **Custom DNS Zones** (v0.63: A/AAAA/CNAME records handed out only to chosen peer groups), user `auto_groups`, and peer login expiry. All are in the REST API. |
| Better Auth as IdP | `oidcProvider` was deprecated in 1.6 and **removed in 1.7**. Use **`@better-auth/oauth-provider`** (OAuth 2.1 + OIDC, needs the `jwt` plugin). `auth.api.adminCreateOAuthClient({ skip_consent: true, … })` creates a trusted first-party client. `customIdTokenClaims` adds claims. We are on `better-auth ^1.6.19`. |
| Swarm raft | swarmkit defaults: tick 1 s, `HeartbeatTick` 1, `ElectionTick` 10. So there is a heartbeat every second and an election after about 10 s of silence. |

---

## 2. Part 1: the mesh control plane inside swarmy

### 2.1 What runs where

```
node #1 (public IP, manager)                         any node, anywhere (NAT ok)
┌──────────────────────────────────────────┐        ┌──────────────────────────┐
│ swarmy-mesh-control  (host net, agent-   │  443   │ swarmy-netbird (client)  │
│   supervised, NOT a swarm service)       │◀──────▶│ wt0 100.x — swarm rides  │
│   netbird-server: mgmt+signal+relay+STUN │ 3478/u │ this; dials out only     │
│   sqlite on volume swarmy-mesh-control   │        └──────────────────────────┘
│ swarmy-netbird (joins its own mesh)      │
│ docker swarm init --advertise/data-path  │        people's laptops
│   = wt0 IP                               │◀────── netbird up → swarmy login
│ edge Caddy (later) fronts :443           │
└──────────────────────────────────────────┘
```

- **One container, `swarmy-mesh-control`.** It runs the pinned
  `netbirdio/netbird-server` image and is supervised by the **agent**, like
  the `swarmy-netbird` client sidecar: a stable name, adopted on re-apply, and
  independent of raft. It is **not** a swarm service. If the mesh breaks and
  raft loses quorum, swarm could not reschedule a service, so the thing the
  swarm depends on must not depend on the swarm.
- **No NetBird dashboard.** Swarmy is the UI. The login pages people see are
  swarmy's, because Dex sends them straight to swarmy (§3.1). Skipping the
  dashboard saves 26 MiB and one surface.
- Config written: `disableDefaultPolicy: true`, `disableGeoliteUpdate: true`,
  `disableAnonymousMetrics: true`, `store.engine: sqlite`, and
  `localAuthDisabled: true` once the swarmy connector exists.
  `authSecret`, `encryptionKey` and the owner password come from swarmy's vault.
  They ride the `applyMeshControl` frame and are written to a **tmpfs** inside
  the container, never to host disk (same rule as setup keys, invariant 5).
  **Spike (§11.1): confirmed**, with a wait-for-file entrypoint; there is no
  env-override fallback in the combined server. `disableDefaultPolicy` and
  `disableGeoliteUpdate` do not do what their names say there (§11.3), so the
  bootstrap deletes the Default policy and the container sets
  `NB_DISABLE_GEOLOCATION=true`.
- **The one exception to "no mesh state on node disk":** the control-plane
  node holds NetBird's SQLite files, because they *are* the control plane.
  Sensitive columns are encrypted with the vault-held `encryptionKey`. Peers'
  WireGuard private keys never leave the peers.

### 2.2 Does it fit on a 1 GB node?

**Yes, but only after Postgres goes.**

| Process (idle) | RSS |
|---|---|
| netbird-server, measured, 0 peers, GeoLite disabled | about 80–105 MiB (105 measured with GeoLite mapped) |
| NetBird client sidecar (per node) | about 30–50 MiB (estimate) |
| swarmy controller (Bun) + agent + edge Caddy | about 250–350 MiB (estimate) |
| Postgres (today's standard tier) | 100–200 MiB, and **removed** by `epic-docker-native-state.md` P0/P2 |
| dockerd + containerd + OS | about 250 MiB |

With SQLite in the controller, node #1 sits around 650–750 MiB of 1 GB. That
is tight but workable, and a 2 GB node is comfortable. Growth per peer is
small: peer rows and one gRPC stream each. Relay bandwidth, not memory, is
what scales, because relayed pairs push traffic through this node. Guard:
the installer warns under 1 GB, and `GOMEMLIMIT=192MiB` goes on the
container. Re-measure on a 1 GB droplet in the DO launch sweep.

### 2.3 Bootstrap order: the swarm forms over the mesh

The swarm is born on the mesh (invariant in the `mesh-networking` skill), so
the mesh control plane must exist **before** `swarm init` and must not live
on the overlay. `install-swarmy.sh --mesh swarmy` on node #1:

1. **Preflight.** A public IPv4 on this host. TCP 80/443 and UDP 3478 free.
   Resolve the mesh name `MESH_DOMAIN`: `--mesh-domain`, else
   `mesh.<DASHBOARD_DOMAIN>`, else `mesh-<a-b-c-d>.sslip.io`. That last one
   is a convenience name that cannot fail over (§2.5).
2. **Secrets.** Generate `authSecret`, `encryptionKey` and the owner password
   into the installer's secret store (`secret_put`, like `mesh_service_token`
   today).
3. **Start `swarmy-mesh-control`** (`docker run --network host --restart
   unless-stopped`, volume `swarmy-mesh-control`, `NB_SETUP_PAT_ENABLED=true`
   for this boot only). **TLS at this moment is NetBird's own**
   (`tls.letsencrypt` on :443, HTTP-01 on :80), because nothing else is bound
   yet. Wait for `:9000` health.
4. **Claim it.** `POST /api/setup` returns the owner and a PAT. Then: create
   service user `swarmy-controller`, mint its token (this becomes
   `mesh_service_token`), and throw away the setup PAT. Restart without
   `NB_SETUP_PAT_ENABLED`. The bootstrap policy set: group `swarmy:<c>:nodes`
   plus policy nodes ↔ nodes on all ports. Nothing else is allowed.
5. **Join itself.** Mint a one-off setup key with `auto_groups:
   [swarmy:<c>:nodes]` and start `swarmy-netbird` against
   `https://$MESH_DOMAIN`. Its hairpin to its own public IP works. Wait for
   the `wt0` IP.
6. **`docker swarm init --advertise-addr <wt0> --data-path-addr <wt0>
   --default-addr-pool 10.201.0.0/16`.** The unusual pool keeps stack
   overlays clear of the `10.0.x` home and office LANs that people's laptops
   sit on (§3.3). It can only be set at init.
7. Deploy the controller as today. Its bootstrap persists `MeshConfig{mode:
   managed-by-swarmy, managementUrl, controlPlaneNodeId}`.
8. **TLS handover** (only when the edge is Caddy). Once edge Caddy runs on
   node #1, the controller:
   - adds the route `$MESH_DOMAIN` with NetBird's h2c/grpc matchers. The
     upstream is the docker_gwbridge gateway IP on port 8081, the same
     binding trick as swarmy-dns's admin API on docker0.
   - re-applies `swarmy-mesh-control` with TLS off, listening only on the
     gateway IP.

   The cert moves into the shared Garage CertMagic store, so any edge node can
   serve the name. The handover takes one short control-plane blip, and
   established tunnels ride through it. With no Caddy edge (ingress `none` or
   `cloudflared`), NetBird keeps its own TLS on :443.

**Later nodes**, including a NAT'd home Mac, change nothing on their side. The
join line carries a setup key and `SWARMY_MESH_MANAGEMENT_URL=https://$MESH_DOMAIN`.
They dial out on 443 and 3478/udp. They get a direct path where hole-punching
works, and fall back to the relay over wss:443 where it doesn't.

**Where TLS comes from**, in short: NetBird's own ACME for the first minutes,
then swarmy's edge Caddy for life. People's laptops need a **publicly
trusted** certificate. A swarmy-internal CA would work for servers (we control
the sidecar's CA bundle), but it would make every person install a root CA.
That is rejected.

### 2.4 Swarmy is the OIDC provider (no Zitadel, no Auth0)

- Add `jwt()` + `oauthProvider()` from `@better-auth/oauth-provider` to
  `packages/auth/src/server.ts`. Follow the JWT plugin's OAuth-provider
  guidance: disable `/token` and the `set-auth-jwt` header, so the dashboard's
  session model is unchanged. Before this, check the move to Better Auth 1.7,
  which removes `oidcProvider`. We never used it, so the move is just keeping
  up.
- The controller creates one confidential, `skip_consent` client,
  `swarmy-mesh`, via `ensureOidcClient` (swarmy's own table, no HTTP
  registration). Its redirect is `https://$MESH_DOMAIN/oauth2/callback`
  (spike: Dex uses one callback for every connector, with PKCE S256). The controller then
  registers it in NetBird with `POST /api/identity-providers {type:'oidc',
  issuer:<swarmy issuer>, client_id, client_secret}`. After that it sets
  `localAuthDisabled`. Dex then has one connector and goes straight to
  swarmy's login page.
- **SSO chains through for free.** Swarmy's login already offers email,
  passkey, and enterprise OIDC via `genericOAuth` (Microsoft, Google,
  generic). Whoever can sign in to swarmy can sign in to the mesh. NetBird
  never learns about Microsoft.
- Claims: `sub` (swarmy user id), `email`, `name`, plus
  `https://swarmy.dev/org` and `https://swarmy.dev/groups` through
  `customIdTokenClaims`. The groups claim is informational only (§3.2).
- The embedded Dex owner from step 4 stays as a **break-glass** local account.
  Its random password is in the vault. It is re-enabled only by
  `swarmy-agent mesh break-glass` on the control-plane node.

### 2.5 Failure and restore

| Failure | What happens | Recovery |
|---|---|---|
| The control-plane container crashes | The agent restarts it (stable name). Tunnels ride through. | Automatic, seconds. |
| The control-plane **node** dies | Existing peer-to-peer tunnels keep working, **so the swarm keeps running**. No enrolment, no ACL change, no people logins. A peer that restarts, or a pair that needs relay, stays down. | **Move** (below). The target is under 5 minutes. |
| The controller is dark, the mesh control plane is fine | The mesh is unaffected. It is a separate container. | n/a |
| Both are dark (same node) | Tunnels persist. `swarmy-agent` rescue on another manager restores the controller (docker-native-state P3) and then moves the mesh. | Runbook. |

**State backup.** Litestream ships inside a swarmy-built image
`swarmy/netbird-server` (upstream binary + litestream, pinned by digest per
`epic-platform-upgrades.md`). It replicates `store.db`, `idp.db` and
`events.db` into the Garage bucket `swarmy-mesh`, with its own
vault-encrypted key. This is exactly the controller-store pattern from
`epic-docker-native-state.md` §2c, so it has the same tooling and the same
Resilience card. It is backed up nightly in the controller bundle as well
(`VACUUM INTO`).

Chicken and egg: Garage is reached over the overlay, which rides the mesh.
That works during a move because the data plane is still up. If Garage is
unreachable too, the controller bundle is the fallback.

**Move = `mesh.moveControlPlane(targetNodeId)`** (admin, audited):

1. Fence the old container: dispatch a stop if its agent is alive. Otherwise
   hold a lease the way the controller store does: a raft-backed
   `swarmy.mesh.control.lease` on a service spec, and a container that can't
   renew stops itself.
2. `applyMeshControl{restore:true}` on the target. It runs `litestream
   restore` and starts the container.
3. Re-point `$MESH_DOMAIN`:
   - served by swarmy-dns: automatic, same reconcile as edge records.
   - behind the Caddy edge: nothing to change when the target is an edge node,
     because the DNS answers are already all edge IPs and Caddy's upstream
     moves.
   - external DNS: the UI shows the one record to change.
4. Peers reconnect by themselves. Their keys are unchanged and their config
   only holds the URL.

**The name must be one you control for a move to be automatic.** A
`mesh-<ip>.sslip.io` name pins the IP. Moving means a new name, a new issuer,
and a re-login for every person. Swarmy offers to re-point every node's
sidecar (`netbird up --management-url`) over the agent WebSocket, which
doesn't ride the mesh. The UI states this limit plainly. This is B2 in
`self-reliance.md` (a cluster zone served by swarmy-dns) paying off.

**HA.** Not at launch: real active-active is NetBird Enterprise-only. The
honest design is **one active instance plus a warm restore**: about 1 s RPO
through Litestream and minutes of RTO. Because the data plane survives, that
RTO is "no changes for a few minutes", not an outage. Two cheap HA wins:

- **Relays on every edge node** (`server.relays`, the standalone relay
  binary), so relayed pairs survive a control-plane loss.
- A **drill** in the Resilience suite: move the control plane and check that
  tunnels stay up.

Offer the Enterprise licence path later as "bring your NetBird licence"
(Postgres + Redis stateless pool). It would be opt-in and is not planned
work.

### 2.6 Alternatives, and why NetBird stays the default

| | **NetBird, self-hosted in swarmy** (default) | Headscale, self-hosted | Plain WireGuard (controller coordinates keys) | NetBird Cloud |
|---|---|---|---|---|
| Idle RAM | 105 MiB | **15 MiB** | 0 | 0 (SaaS) |
| NAT traversal / relay | STUN + relay over wss:443 | Embedded DERP (TCP 443 + STUN) | **none**: needs a routable endpoint on one side | yes |
| People sign in with SSO | Client `netbird up` → Dex → **swarmy OIDC** | Tailscale client with a custom login server + OIDC | no | Its own accounts / IdP |
| Per-stack groups and port policies by API | **REST objects**: groups, policies with ports, Networks + routing peers, **Custom DNS Zones** per group, user `auto_groups`, login expiry | One HuJSON policy document (API or DB mode), subnet routers, MagicDNS. Workable, but per-group DNS scoping and routing-peer resources aren't first-class | We'd build all of it | Same as self-hosted |
| Already built here | Driver, API client, installer, sidecar | Driver + ACL render (`buildHeadscaleAcl`) | Driver + keygen/render | Driver + installer |
| HA | Enterprise licence | none | n/a | Vendor's |
| Third-party dependency | none (after the switches in §2.1) | none | none | **yes** |

Why NetBird, per the owner's call: people access is the product. It needs
per-stack group scoping of **both** reachability and DNS, driven object by
object from swarmy's grants. NetBird exposes exactly those objects over REST.
It also takes an external OIDC provider as a plain connector, and swarmy
already has the NetBird client and API code.

Headscale's 90 MiB saving is real. It remains a supported driver for the
smallest nodes and ACL-as-code teams, but it isn't worth rebuilding people
access around one policy document. Plain WireGuard stays the flat-LAN power
option. It fails the NAT'd home-lab case by construction. **NetBird Cloud
stays as an opt-in "external control plane"** for people who want zero ops.
It is never the default, and the installer lists it under "external".

### 2.7 Installer and UI changes

- **Installer.** `--mesh` becomes `none | swarmy | netbird-external |
  netbird-cloud | headscale-external`. **`swarmy` is the default** whenever
  a mesh is chosen. New flags: `--mesh-domain`, `--mesh-relay-on-edges`.
  New steps 1–6 from §2.3. The `NB_SERVICE_TOKEN` prompt disappears for
  `swarmy`, because the installer mints the token. The printed Add-a-node
  line is unchanged.
- **Mesh settings** (Networking → Mesh):
  - **Control-plane card**: "Runs in swarmy on `lon-1` · NetBird v0.79.0 ·
    backed up 1 s ago · 14 peers · relay on 3 edges" with the actions
    **Move to another manager**, **Upgrade** (platform-upgrades manifest) and
    **Download state**.
  - The mode picker offers Swarmy (default), External NetBird, NetBird Cloud
    and Headscale (advanced). A token is only asked for with an external
    mode.
  - A **People access card** (§3.4).

### 2.8 Phases and effort (Part 1)

| Phase | Scope | Size |
|---|---|---|
| **M0 spike** (2–3 d) | On Lima, check each of these: combined server config on tmpfs; h2c through edge Caddy to the gwbridge IP; `disableDefaultPolicy`; `localAuthDisabled` + OIDC connector against Better Auth `oauth-provider`; a routing peer on an attachable stack overlay; Custom Zone + search domain; client profiles (§5.2) | S |
| **M1 control plane in swarmy** | `applyMeshControl` command (protocol + hub `CommandName` + executor case, gated by `SWARMY_ALLOW_MESH`). Agent handler supervising `swarmy-mesh-control`. `mode: managed-by-swarmy` becomes real in `makeControlPlane`. Installer `--mesh swarmy`. TLS handover. Litestream to `swarmy-mesh`. `moveControlPlane`. Resilience card + drill. Control-plane card | L (1.5–2 wk) |
| **M2 people access** (§3) | Better Auth `oauth-provider`, IdP registration, user sync + revocation, pure renderers in `packages/mesh` (groups, Networks, policies, zones), access routers, ABAC `mesh.connect`, the "Connect from your laptop" UI, who's connected | L (2 wk) |
| **M3 hardening** | Relays on edges, TTL sweeper (closes the roadmap gap), peer login expiry defaults, client download mirror, NetBird Cloud/External kept as modes, 1 GB re-measure on DO | M |

---

## 3. People access: SSO onto the mesh, scoped per stack

Goal: *"Members of `devs` can connect to staging apps"* is one ABAC rule. It
turns into NetBird groups, policies and DNS automatically. A developer runs
`netbird up`, signs in with the same Microsoft account they use for swarmy,
and runs `psql -h db.storefront…`. They reach nothing else.

### 3.1 Identity

- People are **only** OIDC users (§2.4). **Servers are only setup-key peers**
  in `swarmy:<c>:nodes`. Nodes still enrol with single-use setup keys through
  `applyMesh`, exactly as today. The two populations never share a group.
- **User sync worker** (`mesh-people-reconcile`, 30 s, the dns-reconcile
  shape). NetBird creates the user on first login. The worker lists
  `/api/users`, matches on the connector subject or email to the swarmy user,
  and:
  - sets `auto_groups` to that user's effective access groups (§3.2), with
    account group propagation on, so the user's existing peers follow the
    change.
  - **blocks the user and deletes their peers** when the swarmy member is
    removed or disabled. This closes the "removing a member doesn't revoke
    their mesh peers" gap in `docs/product/mesh-networking.md`.
- People's peers get **login expiry** (default 12 h, org setting). Re-auth
  goes back through swarmy, so a disabled account or lost SSO group drops off
  at the next expiry at the latest. The worker does it within 30 s anyway.
- We deliberately **don't rely on JWT group sync**. Token claims only change
  at login. API-driven `auto_groups` changes at grant time and is the
  auditable path.

### 3.2 Grants are ABAC, rendered deterministically

- New ABAC action **`mesh.connect`** on resource `stack` (attributes `env`,
  `app`, `cluster`, labels). The rules engine and SSO-group → swarmy-group
  mapping are being built by another agent. Example rule: `principal.group ==
  devs ∧ resource.env == staging → allow mesh.connect`.
- **Effective set.** For each (user, stack), evaluate `mesh.connect`. Users ×
  stacks is small per org. Recompute when a rule, a membership, a stack, or
  an SSO group change happens, and every 5 min as a backstop.
- **Explicit grants** reuse direct-connect's `routes.grant/revoke` model: a
  `MeshRoute` of kind `person`, with principal (user or group), stack, ports,
  `expiresAt`, and an audit row. The TTL sweeper from M3 finally enforces
  `expiresAt` for both kinds.
- **Deterministic names.** These are pure functions in
  `packages/mesh/src/acl.ts`, next to `principalTagForRoute`, and
  golden-tested. `<c>` is the cluster slug (§8):

| Object | Name |
|---|---|
| Server peers | group `swarmy:<c>:nodes` |
| People allowed on a stack | group `swarmy:<c>:access:<stackId>` |
| A TTL'd personal grant | group `swarmy:<c>:grant:<routeId>` (the `tag:dc-<routeId>` analogue) |
| The stack's router peers | group `swarmy:<c>:router:<stackId>` |
| The stack's Network | `swarmy-<c>-<stackId>` (routing peers = router group, masquerade on) |
| Resources | one host resource per service **VIP** `/32`, named `<svc>` |
| Policy | `swarmy-<c>-<stackId>-<svc>`: source access group (+ grant groups) → resource, **ports = the service's declared ports**, TCP/UDP as declared |
| DNS | Custom Zone `<stack>.<c>.swarmy.internal`, distributed **only** to that stack's access and grant groups |

- **Default deny** holds by construction. There is no All → All
  (`disableDefaultPolicy`, and the bootstrap deletes it on adopted
  instances). There is no policy from any people group to `nodes`, so a
  person can never reach a node's mesh IP, dockerd, or swarm ports. Only
  services with declared ports are resources, so undeclared ports are
  unreachable.
- Rendering follows the mesh skill: a pure `buildPeopleAccessPlan(intent) →
  { groups, networks, resources, policies, zones }`, sorted by id. It is
  applied through `DriverControlPlane` (new methods `applyAccessPlan`,
  `listUsers`, `setUserGroups`, `blockUser`). The plan is a diff against
  NetBird: create, update, delete only `swarmy:<c>:*` objects, and never
  touch anything else. Every change writes `mesh.access.*` audit rows.

### 3.3 How a laptop reaches `db.storefront:5432`

**Chosen: a per-stack access router plus a Custom DNS Zone.**

- The agent runs **`swarmy-access-<stackId>`**: the NetBird client container
  (the same image as the node sidecar, `NET_ADMIN` + `/dev/net/tun`, stable
  name) attached **only to that stack's overlay**. It enrols with a setup key
  whose `auto_groups` is `swarmy:<c>:router:<stackId>`. It is the NetBird
  Network's **routing peer**, so traffic from a permitted laptop exits it
  onto the stack overlay and reaches the service VIP. Swarm load-balances
  from there.
  - Placement: any healthy node, preferring one in the requester's region.
    A second replica on another node makes it an HA routing-peer pair.
  - It is created when the first `mesh.connect` grant for the stack appears
    and removed when the last one goes, so it costs nothing unused. Its
    footprint is about 30–50 MiB (the client), only for stacks with grants.
- The controller keeps the zone current: the record
  `db.storefront.lon.swarmy.internal` points at the VIP of `storefront_db` on
  the stack overlay. The VIP is read live from Docker inventory, never stored
  (invariant 8). The zone gets search domain `<c>.swarmy.internal`, so
  `db.storefront` resolves as the owner wrote it. `.internal` is
  ICANN-reserved for private use. A redeploy that changes a VIP updates the
  record within one reconcile tick.

Why this and not the alternatives:

- **Keeps the network wall.** The router joins exactly one stack overlay, so
  it is inside that stack's blast radius and no other. It can never join
  `swarmy-control` (admission refuses it, same as user specs).
- **Per-port least privilege.** Per-service `/32` resources with port-scoped
  policies. Routing the whole overlay subnet would expose every port of every
  service.
- **DNS scoped with access.** People without the grant can't even resolve
  the names.
- Rejected: publishing services on node mesh IPs (every mesh peer could
  reach them, and it breaks the wall). Rejected: NetBird *domain* resources
  resolved by Docker DNS on the router (Docker answers `storefront_db`, not
  our FQDN, so we'd need a rewriting forwarder). Rejected: one router joined
  to every overlay (joining a network restarts the router for all stacks, and
  it bridges walls).
- **Constraints the spike settled (§11.5).**
  - The router is a container attached to an overlay, so the stack overlay
    must be `attachable`. Swarmy-created overlays are. For compose stacks we
    set it at creation. An existing non-attachable overlay needs a recreate,
    or a fallback router as a swarm service in NetBird's userspace/netstack
    mode, because swarm services can't take `/dev/net/tun`.
  - Laptop LANs overlap `10.0.0.0/8` pools. The new default pool (§2.3) fixes
    new clusters. For old clusters the UI warns when a person's routes would
    shadow their LAN.
  - Masquerading means services see the router's IP. Attribution comes from
    the grant audit plus NetBird's per-peer connection state, not from
    service logs.

### 3.4 UI

- **App → Network tab → "Connect from your laptop"**:
  1. Download the NetBird client (macOS / Windows / Linux / iOS / Android).
     M3 mirrors the desktop installers through the controller, like agent
     binaries, so this doesn't depend on GitHub.
  2. `netbird up --management-url https://mesh.example.com` (copy button).
     A browser opens swarmy's own sign-in, with SSO and passkeys.
  3. Done: *"You can reach 3 services in storefront (staging):
     `db.storefront:5432`, `cache.storefront:6379`, `api.storefront:8080`."*
     They appear as a copyable list, with `psql`/`redis-cli` snippets per
     engine for managed data services.

  When the viewer has no grant, the tab shows who can grant access. The rule
  that would allow them is found by the ABAC explain API.
- **Who's connected right now**: people peers in this stack's groups, with
  user, device, connected/idle, since, and grant (rule or TTL, with its
  expiry). Admins get **Revoke**. Backed by `listPeers` + the user map. This
  is telemetry, not a DB mirror.
- **Networking → Mesh → People access card**: on/off (off by default,
  admin), login expiry, default-deny statement, identity "Signed in through
  swarmy (Microsoft Entra via SSO)", count of people online.
- **Access → Policies**: `mesh.connect` appears as an action, with a preview
  ("this rule lets 7 people reach 4 stacks").

---

## 4. Part 2: Swarm raft across regions

Today one swarm spans London + NYC droplets + a home Mac, and one swarmy
controller runs it.

- **Latency is not the problem.** Every raft write waits for a majority round
  trip. London↔NYC is about 70–80 ms RTT plus WireGuard, so each write takes
  about 100 ms. That is fine at swarm's write rate (service updates, not
  data). Elections trigger after about 10 s of silence (§1), far above WAN
  jitter. Gossip and overlay control traffic are fine over the mesh.
- **Quorum geometry is the problem.**
  - With 3 managers as 2 London + 1 NYC, a transatlantic split leaves NYC
    **read-only**: no deploys, no rescheduling, no scaling. Running tasks
    keep running. London carries on.
  - Losing London itself (region outage) loses quorum everywhere. Two
    regions can never survive losing the majority region. Surviving a region
    loss needs managers in **≥ 3 failure domains** (for example LON, NYC,
    AMS), each within about 100–150 ms RTT of the others.
- **The home Mac must never be a manager.** It sleeps, runs Docker Desktop in
  a VM, and sits behind residential NAT. Workers are fine anywhere.
  (Enforce: the promote action refuses nodes labelled
  `swarmy.node.class=edge-home` or on Docker Desktop, unless forced.)
- **Every manager holds everything.** Raft replicates all specs, configs and
  (encrypted) secrets to every manager. An EU-only service's secrets live on
  the US managers too.

**When a separate cluster is the right answer**:

1. **Blast radius**: a bad swarm upgrade, raft corruption, a runaway stack
   exhausting managers, or a mis-scoped network change hits everything in the
   swarm.
2. **Prod vs staging**, when staging is where you test *platform* changes
   (Docker, swarmy and NetBird upgrades, network policy). App-level staging
   doesn't need it (§6).
3. **Compliance and residency**: data or secrets must not be replicated
   outside a jurisdiction.
4. **Customers / tenants** needing hard isolation, separate admins, or
   separate billing.
5. **Geography you can't give 3 failure domains**: two independent regional
   clusters beat one swarm that loses quorum with its majority region.
6. **Scale**: past a few hundred nodes, or when one team's churn makes raft
   noisy for everyone.

One swarm across regions stays the right answer for **one environment of one
team** that wants cross-region failover with a single control plane. That is
what swarmy's geo edge and region-aware Caddy are built for.

## 5. Part 2: options for many clusters

### 5.1 The three shapes

| | (a) Independent controllers + fleet switcher | (b) Fleet hub | (c) One controller, many swarms |
|---|---|---|---|
| What | Each cluster is a full swarmy (controller, store, mesh, edge). The dashboard can switch between them. Identity is shared through OIDC. | (a), plus a small hub with federated read views (status, alerts, costs, audit across clusters), release promotion by digest across clusters, and cross-cluster geo-DNS/edges | One controller process holds hubs to N swarms |
| Blast radius | Per cluster | Per cluster. The hub going down loses the overview, never the clusters | **One controller for everything** |
| Fits today's code | Yes. Nothing assumes it's the only swarmy | Yes, as a new app on top of (a)'s REST API | **No.** It assumes one hub per swarm, a controller that runs *inside* the swarm it manages, the self-backup bundle, the raft lease fence, and org-scoped Docker truth read from "the" swarm |
| Effort | S–M | L | XL + a rewrite of every "live Docker truth" read |

**Launch: (a). Later: (b). Reject (c).** It contradicts "Docker is the source
of truth, the controller lives in the swarm". Its availability is worse than
the swarms it manages.

### 5.2 (a) at launch

- **Cluster identity.** `clusterId` = the swarm's cluster ID (`docker info →
  Swarm.Cluster.ID`). `cluster.slug` is a short, human, DNS-safe name
  (`lon-prod`), set at install (`--cluster-name`), editable, and unique per
  fleet. It lives in `swarm-kv` (docker-native-state §2b), so it survives the
  controller's volume.
- **Fleet switcher.** The dashboard header gets a cluster menu listing the
  clusters this person has signed into: the URL, slug, and a health dot from
  each cluster's public `/api/v1/meta`. Each cluster is a separate origin and
  a separate session. Nothing is shared server-side.
- **Shared identity through OIDC, no new service.**
  - One cluster, or the customer's own IdP, is the identity home.
  - Every other cluster adds it as an SSO provider (`genericOAuth`, which
    exists). Where it's a swarmy cluster, it acts as an OIDC provider through
    the same `oauth-provider` plugin as §2.4.
  - Switching clusters is then a silent SSO redirect. Memberships and roles
    stay **per cluster**, because they are that cluster's access control.
- **Mesh across clusters.** Default: **one NetBird per cluster**. That is the
  isolation people want from a separate cluster. A person using two clusters
  uses two NetBird client **profiles**, one per management URL. The M0 spike
  confirms the profile UX. Optionally a cluster can **join an existing mesh**
  (mode `external` pointed at another cluster's control plane). That only
  works because every NetBird object is namespaced `swarmy:<slug>:*`, and
  there is no policy between two clusters' `nodes` groups unless asked for.

### 5.3 (b) later: the fleet hub

- A separate small app (`apps/fleet`) with its own SQLite store. It could be
  deployed on any cluster or standalone. It holds a cluster registry
  (`clusterId`, slug, URL, and a **scoped API key** per cluster through the
  existing REST API keys) and nothing else of the clusters' state. It reads
  live and caches briefly.
- **Federated views**: status, incidents, alerts, cost and audit fan out over
  each cluster's `/api/v1`, merged in the UI.
- **Promotion**: `promote(app, from: {cluster, env}, to: {cluster, env},
  digest)`. The target cluster **pulls** the signed digest from the source
  registry, or through a mirror, re-verifies cosign, and deploys through its
  own admission pipeline. The hub never writes to a cluster's Docker. It
  calls the target's REST API as a principal that the target's ABAC must
  allow (`release.promote`).
- **Cross-cluster edge**: swarmy-dns zones can list edge endpoints from
  several clusters. A hub-pushed snapshot adds "remote region" endpoints. So
  `app.example.com` can steer between LON-prod and NYC-prod clusters with the
  same health contract (`ingressRegionSnapshot` over REST).

## 6. Staging: an environment in the cluster, or its own cluster?

**Default: an environment in the same cluster.** This is `epic-git-apps.md`
phase 6: the `staging` branch deploys a second stack.

- Make **environment first-class** now: a stack label `swarmy.env=<name>`
  (Docker truth), unique per app. It is an ABAC resource attribute
  (`resource.env`), and people-access zones and groups key off it (§3.2).
- Staging stacks get their own overlays (they already do per stack), optional
  placement on nodes labelled `swarmy.node.env=staging`, and their own
  resource limits.
- Promotion inside a cluster is "same digest, next env", with no registry
  copy.

**Use a separate staging cluster** when §4's reasons apply: you test platform
upgrades there, compliance needs it, or staging load must never share
managers with prod. The promotion API is written as `{cluster?, env}` from day
one. `cluster` defaults to "this one", so the jump to (b) is a new transport,
not a new model.

## 7. Aligning with the other plans

- **`epic-docker-native-state.md`.** The mesh control plane copies its storage
  pattern exactly:
  - SQLite files, Litestream to a dedicated Garage bucket (`swarmy-mesh` next
    to `swarmy-control`), restore-on-start, and a lease fence for moves.
  - `MeshConfig` goes to `swarm-kv` (class b). It gains `controlPlaneNodeId`,
    `meshDomain` and `peopleAccess`. `MeshPeer` status is derived (class a).
  - `MeshRoute` (now including `person` grants) stays in SQLite (class c,
    access control).
  - The cluster slug and id live in `swarm-kv`. Each cluster's store is its
    own. **There is never a cross-cluster database.** The hub's registry is
    the hub's own file.
- **`self-reliance.md` B1** is replaced by this plan: self-hosted NetBird, not
  Headscale. The GeoLite, metrics and client-download points are handled in
  §2.1 and §3.4.
- **`epic-platform-upgrades.md`** pins and upgrades `swarmy/netbird-server`
  and the client image by digest. The control plane is upgraded **before**
  clients (NetBird's compatibility direction), health-gated on `:9000` + peer
  count.

## 8. Design now, so we don't paint ourselves into a corner

1. **`cluster.slug` + `clusterId`** exist from install:
   - they are in `/api/v1/meta`, every audit row, outbound webhook payloads,
     alert and incident notifications, OTel resource attrs (`swarmy.cluster`),
     backup object prefixes (`<bucket>/<clusterId>/…`), and release manifests.
   - the Terraform provider and SDKs take a per-cluster endpoint (provider
     aliases). There is no hidden "the cluster".
2. **No same-origin assumption in the app's API client.** The tRPC/REST base
   URL is a per-cluster value, so a switcher or hub can talk to several.
   Dashboard routes stay unprefixed (host = cluster). We don't put
   `/clusters/<id>/` in every URL now. The hub gets its own routes.
3. **Every NetBird object swarmy creates is namespaced `swarmy:<slug>:`** and
   swarmy only ever diffs its own namespace. This keeps a shared mesh
   possible and makes adopting an existing NetBird safe.
4. **Mesh DNS names carry the cluster**: `<svc>.<stack>.<slug>.swarmy.internal`.
5. **`swarmy.env` on stacks and `resource.env` in ABAC**, and promotion
   modelled as `{cluster?, env}`.
6. **The mesh control-plane name is a zone we control** (`mesh.<zone>`),
   never an IP-derived name where the operator has a domain.
7. **`--default-addr-pool` at `swarm init`**, uncommon and distinct per
   cluster (the installer derives it from `clusterId`), so meshes and people's
   routes never collide across clusters.

## 9. Open decisions for the owner

1. **The TLS handover.** Accept the one-time move of TLS from NetBird's ACME
   to edge Caddy (§2.3 step 8). The alternative is to always run NetBird's
   own TLS on a dedicated node that isn't an edge.
2. **Break-glass local NetBird owner.** Keep it (recommended, vault-held,
   CLI-only), or go pure OIDC and accept that a broken swarmy login locks the
   mesh admin API. Tunnels and the service-user token are unaffected either
   way.
3. **Default login expiry for people's peers**: 12 h proposed. And whether
   people access is off by default (proposed: off; an admin turns it on).
4. **Headscale's place**: keep it as an advanced driver (proposed), or deprecate
   it now that people access is NetBird-shaped.
5. **Staging default**: same-cluster environment (proposed), with separate
   clusters as the documented upgrade path.
6. **The home Mac rule**: hard-refuse promoting Docker Desktop / home nodes
   to manager, or warn only.
7. **Enterprise NetBird HA**: out of scope (proposed), or a "bring your
   licence" mode on the roadmap.
8. **Fleet identity home**: one swarmy cluster as the OIDC home for the
   others, or always recommend the customer's own IdP.

## 10. Risks

- **Combined-server config on tmpfs, and h2c through our Caddy** are
  unverified until M0. Fallbacks: env overrides; NetBird's own TLS on a
  non-edge manager.
- **Client signal-retry bug** (netbird#7430). Pin a fixed client version.
  The agent's `meshState` sampler restarts the sidecar when signal has been
  down more than 5 minutes while management is up.
- **Relay bandwidth concentrates on node #1** until M3 puts relays on edges.
- **Routing peers need attachable overlays.** Existing non-attachable stack
  overlays need a recreate or the netstack fallback (§3.3).
- **Better Auth 1.7** removes `oidcProvider`. We must take `oauth-provider`
  plus `jwt` without disturbing session cookies, the passkey or 2FA flows,
  or the REST API key auth. `auth-abac` owns that review.

## 11. M0 spike results (2026-09-24)

Run on NetBird **v0.79.0** (`netbirdio/netbird-server@sha256:d1da0c01…`,
`netbirdio/netbird@sha256:9d8480d8…`), locally on Docker 29.6 and on a Lima
Ubuntu 24.04 VM (Docker 29.8, one-node swarm). Scripts were throwaway; what
they proved is below. "Pass" means seen working, not read in the docs.

### 11.1 Config from tmpfs: pass, with a wait-for-file entrypoint

- The combined server reads **only** `--config <file>`. There is no general env
  override. Only a few `NB_*` switches exist (`NB_SETUP_PAT_ENABLED`,
  `NB_DISABLE_GEOLOCATION`, the SQLite file paths). So "env overrides as a
  fallback" is not available.
- It works with the container started as
  `sh -c 'while [ ! -s /run/swarmy-mesh/config.yaml ]; do sleep 0.2; done; exec netbird-server --config /run/swarmy-mesh/config.yaml'`
  on `--tmpfs /run/swarmy-mesh:mode=0700`. The supervisor then writes the
  file with `docker exec -i … cat >`. The config never touches the image, the
  container spec or `docker inspect`.
- **The catch is cold boot.** A tmpfs is empty after a restart. If the node
  that hosts the control plane reboots, its agent must write the config again
  before NetBird starts. The agent reaches the controller over the overlay,
  and the overlay rides the mesh. When the controller runs on another node,
  that is a deadlock. **Decision:** the agent keeps the rendered config in its
  own state dir (`/var/lib/swarmy/mesh-control/config.yaml`, 0600, next to the
  agent's session secret) and rewrites the tmpfs from it on every start. It is
  never in the NetBird volume, so `store.db` and its `encryptionKey` don't
  sit together. The controller re-sends it on every reconcile.
- The server does not re-read its config. A change is a container restart,
  which is a few seconds of control-plane blip; tunnels ride through.

### 11.2 gRPC through our Caddy: pass

- Caddy 2 in front of the server: `@grpc header Content-Type application/grpc*`
  → `reverse_proxy h2c://<upstream>` with `flush_interval -1` and 24 h
  read/write timeouts. Plus a **named** matcher
  `@nb path /relay* /ws-proxy/* /api/* /oauth2/*` → plain `reverse_proxy`.
  Watch out: `reverse_proxy /a* /b* up:80` is **not** a multi-path matcher. It
  takes the extra paths as upstreams and silently answers 200 with an empty
  body.
- Two clients enrolled through Caddy (`tls internal`, CA via `SSL_CERT_FILE`)
  got Management + Signal "Connected", relayed over `rels://mesh:443`, then
  went P2P and pinged each other.
- On a swarm node, a container on a stack overlay reaches a host-network
  NetBird bound on the `docker_gwbridge` gateway (`172.18.0.1:8081`). So the
  TLS handover upstream works as planned. The gwbridge bind exposes nothing
  that public :443 doesn't already expose (API needs a token, gRPC needs peer
  keys).
- **`server.listenAddress` ignores its host part.** The combined server
  only takes the port (`net.SplitHostPort` → port), so `172.17.0.1:8081`
  still listens on `*:8081`. Seen in the lab e2e. Behind the edge, the
  plain listener is therefore reachable on every interface. It serves the
  same content as :443 (the API needs a token, gRPC needs peer keys), but
  unencrypted. Hardening (M3): a host firewall rule that allows 8081 only
  from docker bridges and loopback.
- STUN (3478/udp) can't go through Caddy, as documented. On the real host it
  is bound on the host network directly.
- Not checked here: NetBird's own `tls.letsencrypt` (it needs a public name).
  The code path is built; the DO launch sweep checks it.
- The server also always opens the legacy gRPC port **33073** on all
  interfaces, plus **9090** (metrics) and **9000** (health). There is no
  switch in the combined config to close 33073. The preflight must not treat
  it as a conflict, and host firewalls should keep 33073/9090/9000 closed.
- **`:9000/health` is the relay's TLS check, not a liveness probe.** It
  answers 503 `{"certificate_valid":false}` forever on a plain-HTTP listener
  (behind the edge, or in a lab). Liveness is therefore a TCP connect to
  33073, the always-plain legacy gRPC port (installer and agent).

### 11.3 `disableDefaultPolicy`: fail. It is not reachable in the combined server

- The field exists only on the internal management struct, which the
  combined config fills with `yaml:"-"`. `server.disableDefaultPolicy` is
  ignored. After `POST /api/setup` the account has group **All** and policy
  **Default** (All ↔ All, bidirectional, all protocols).
- **Fix, verified:** the bootstrap deletes every policy right after setup,
  **before** any peer joins, then creates only `swarmy:<c>:nodes ↔ nodes`. An
  adopted instance gets the same treatment on first reconcile: it deletes
  `Default` by name, and only if it is exactly All ↔ All.
- Related: `disableGeoliteUpdate: true` still downloads the 73 MB GeoLite and
  geonames databases on first boot (it only stops updates).
  **`NB_DISABLE_GEOLOCATION=true`** skips geolocation entirely (no download,
  no geo posture checks). We set it.
- Useful defaults found in account settings: `groups_propagation_enabled:
  true`, `peer_login_expiration: 86400` (we set 43200 = 12 h),
  `extra.user_approval_required: true` (we set false; access is gated by
  groups, and a user with no groups reaches nothing).
- The setup PAT belongs to the owner. An **admin** service user cannot list
  or delete the owner's tokens (403). The bootstrap deletes the setup PAT
  **with the PAT itself** (`DELETE /api/users/<owner>/tokens/<id>`), verified
  by a 404 on the next call. Service-user tokens have a max lifetime of 365
  days, so M3 adds rotation (see the risks).

### 11.4 Hiding the local login behind the swarmy connector: pass

- `POST /api/identity-providers {type:'oidc', name, issuer, client_id,
  client_secret}` registers a Dex connector. The issuer's discovery must be
  reachable from the server.
- With the connector present and `auth.localAuthDisabled: true` (restart), the
  CLI's `GET /oauth2/auth?client_id=netbird-cli…` is a **302 to
  `/oauth2/auth/<connector-id>`**, then a 302 to the external IdP's authorize
  URL. There is no NetBird page in between. Dex requests `openid profile
  email` with PKCE S256, and its redirect is **`https://<mesh>/oauth2/callback`**
  (not `/callback/<id>`).
- Startup **fails** with `localAuthDisabled: true` and no other connector. So
  the order is fixed: connector first, then the flag. On disable, NetBird
  **deletes** the local connector. The owner row stays (`idp_id: local`) and
  comes back when the flag is off. **Break-glass** is therefore "re-render with
  `localAuthDisabled: false`, restart" (`swarmy-agent mesh break-glass` on the
  control-plane node), and the owner password is in the vault.
- **NetBird only accepts an `https` issuer** for an external IdP
  (`identity provider issuer must be a valid URL` for `http://…`, found when
  the first lab install tried to register). A swarmy on plain HTTP can't be
  NetBird's IdP. Real installs have https (the Caddy edge, or NetBird's own
  ACME next to it). For a lab or an intranet on a private CA, the mesh
  control plane takes an **extra CA** (`MeshControlSpec.caPem`, installer
  `SWARMY_MESH_EXTRA_CA`). It joins the system roots for that process only,
  through `SSL_CERT_FILE` set in the entrypoint.
- `netbird up --no-browser` uses Dex's **device flow**
  (`<mesh>/oauth2/device?user_code=XXXX-XXXX`). That is what the e2e drives,
  with a plain HTTP client holding the person's swarmy session. Dex passes
  `insecureSkipEmailVerified` and `insecureEnableGroups` to the connector, so
  unverified swarmy emails sign in.
- Dex names a user `base64(proto{1: sub, 2: connector})`. For people who
  come through swarmy, `sub` is the swarmy user id, so user sync matches on
  it before email (username-only accounts have no email claim).
- The end-to-end login through Better Auth is covered by the e2e
  (`scripts/e2e-mesh-people.ts`), not the spike.

### 11.5 Routers on existing stack overlays: pass, attachable only

- A NetBird client container on the stack overlay (`--network <stack>_default`,
  `NET_ADMIN`, `/dev/net/tun`), enrolled with a key whose `auto_groups` is the
  router group, works as the routing peer of a NetBird **Network**. It has
  `wt0` plus overlay `eth0` plus gwbridge `eth1`, and resolves `<svc>` through
  Docker DNS.
- Resource `db` = the service **VIP** `/32`. Router = `peer_groups:[router
  group]`, `masquerade: true`. Policy = source access group → destination
  resource `{id, type:'host'}`, `protocol: tcp`, `ports: ['5432']`. From a
  person peer: **:5432 on the VIP answered; :6000 on the same VIP timed out.**
  Per-port least privilege holds.
- **Revocation**: removing the person's peer from the access group cut new
  connections in **~2 s**.
- A non-attachable overlay refuses the container
  (`network st_locked not manually attachable`). The router needs
  `attachable: true`. Swarmy creates its overlays attachable. For a stack whose
  overlay isn't, people access for that stack says so and offers the recreate;
  the netstack fallback stays unbuilt.
- The new pool works: `swarm init --default-addr-pool 10.201.0.0/16` put the
  ingress network on `10.201.0.0/24` and stack overlays on `10.201.x.0/24`.

### 11.6 DNS: zones work, short names don't (portably)

- A Custom Zone `<stack>.<c>.swarmy.internal` with an A record for
  `db.<stack>.<c>.swarmy.internal` → VIP, distributed only to the access
  group, resolves on the person peer and not elsewhere.
- **Short names are unreliable, so the UI leads with the FQDN.**
  - `db.st` resolved to a public IP. `st` is a real TLD with a wildcard, and
    resolvers try a dotted name as-is first. `app`, `dev`, `shop` and `cloud`
    are TLDs too.
  - musl (Alpine) never applies search domains to a dotted name.
    `db.<stack>` fails there even with a search domain.
  - glibc falls back to the search list and resolves it. macOS: not tested.
  - A per-stack search domain would make bare `db` work, but two stacks would
    collide.
  - So: one zone per stack, `enable_search_domain: false`, and the UI hands out
    `db.<stack>.<c>.swarmy.internal`. `<c>.swarmy.internal` as a cluster-wide
    search zone (it needs one record before NetBird distributes it) is an
    optional nicety, not relied on.
- A zone created while a peer was connected reached it only after the peer
  reconnected, once. Record changes in an existing zone were live. The access
  reconcile therefore creates a stack's zone together with its first grant
  (before anyone connects), and only edits records after that.

### 11.7 Client profiles: pass, but only one active at a time

- `netbird profile add <name>` then `netbird up --profile <name>
  --management-url <url>` makes a separate profile: its own key, peer and
  mesh IP. `netbird profile select` switches. The daemon connects **one
  profile at a time**. The owner's own Mac shows the same thing: a
  `Gomacrae` profile active, `default` idle.
- So "Connect from your laptop" uses a named profile per cluster
  (`swarmy-<slug>`). It never clobbers someone's existing NetBird (a work
  NetBird Cloud account stays in its own profile). The UI says that switching
  clusters disconnects the other one.
- Docker Desktop containers on macOS can't reach Lima vzNAT addresses
  (192.168.64.x), though the Mac itself can. The e2e's laptop is the
  `swarmy-mac` Lima VM, not a Docker Desktop container, and not the owner's
  real NetBird.

### 11.8 Main's picks on §9 (standing unless the owner overrides)

1. One-time TLS handover NetBird ACME → edge Caddy: **yes**.
2. Break-glass local owner: **keep**, CLI-only, vault-held.
3. People logins expire after **12 h**. People access is **off** until an
   admin enables it.
4. Headscale stays as an **advanced** driver.
5. Staging is an **environment in the same cluster**.
6. Promoting a home / Docker Desktop node to manager is **hard-refused**.
7. NetBird Enterprise HA goes on the roadmap **after launch**.
8. Fleets use the **customer's own IdP**.
