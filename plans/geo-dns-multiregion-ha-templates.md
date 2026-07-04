# Epic: Geo-DNS multi-region routing + HA database templates

> **⚠️ Part A (Geo-DNS/GSLB) is SUPERSEDED (2026-07).** The canonical design is now
> [`docs/product/edge-network.md`](../docs/product/edge-network.md) ("swarmy is the
> nameserver"): our own Bun/TS authoritative server (`swarmy-dns`, replacing the
> CoreDNS approach below) runs on every ingress+outlet node (global service,
> host-mode :53), users delegate NS records directly to pinned swarmy nodes, web
> records are fully derived from ingress (no manual host+region records), and
> answers are per-query steered node public IPs. Operational invariants live in the
> `geo-edge-routing` skill. Part B (HA templates) below remains current.

> Two capabilities, one epic, because they share a substrate (regions as first-class metadata) and a goal (a stack that survives a region going dark). Part A makes traffic find the nearest healthy ingress. Part B makes stateful services (Postgres, Redis) survive node/region loss. Both must stay one-command-easy and must run **with or without swarmy** (unopinionated).

---

## Problem

swarmy today is single-cluster, single-region in spirit: ingress (caddy/traefik) renders a config that points a domain at a service, and `DriverDispatch.resolveTargetNodes` defaults to "all online managers." There is no notion of *region*, no notion of *which ingress endpoint a given user should hit*, and no way to deploy a stateful service that tolerates losing a node — let alone a whole region.

Two concrete gaps:

1. **Routing (Geo-DNS / GSLB).** When an org runs ingress on nodes in `us-east`, `eu-west`, `ap-south`, a single A-record can only point at one of them. We need authoritative DNS that, per query, returns the *closest healthy* ingress endpoint, drains traffic away from a failed region, and learns endpoint health from swarmy's existing agent telemetry. This must integrate with the ingress epic (the things DNS points *at*) and the mesh (how cross-region service traffic actually flows).

2. **Stateful HA.** Docker Swarm gives you stateless service HA for free (replicas reschedule). It gives you *nothing* for stateful data — a Postgres with a single volume is a single point of failure pinned to one node. Kubernetes has Patroni/Stolon/CloudNativePG; Swarm has no equivalent. We need ready-made, geo/HA-aware templates (Postgres primary+replica+autofailover, Redis sentinel/cluster) that encode region placement and anti-affinity, and surface as one-click entries in the GUI template gallery / stack builder.

The unifying primitive both halves need: **regions as first-class, org-scoped metadata on nodes**, plus **region-aware health** the controller already has via heartbeats and `applyIngress` status.

---

## Recommended approach

### Region as a node label (no new placement engine)

Do **not** invent a region model that competes with Swarm scheduling. Swarm already schedules by node labels and supports `placement.constraints` + `placement.preferences` (spread). swarmy already stores `Node.labels Json` and can push labels to the engine via the existing `updateSwarmNode` command (`labels` field). So:

- Region is the node label **`swarmy.region`** (and optional `swarmy.zone`). It is set in the GUI (or auto-detected, see Simplicity) and pushed to the Swarm engine as the Docker node label `swarmy.region=<r>` via `updateSwarmNode`. This makes region usable by *plain* `docker stack deploy` placement constraints too — so stacks remain portable off swarmy. **WHY:** reuses an existing command and an existing column; zero new scheduling logic; keeps stacks unopinionated.

### Part A — Geo-DNS: DNS-based GSLB, not anycast. Authoritative server = **CoreDNS with a custom swarmy plugin**.

**Decision 1: DNS-based GSLB over anycast.**
Anycast (announce one IP from every region via BGP) gives the lowest-latency, instant-failover routing and is what hyperscalers use — but it requires BGP sessions, an ASN, provider support, and IP transit. That is categorically incompatible with "anyone can just deploy" and with the typical swarmy user (a few VPS/bare-metal boxes across regions). **Go DNS-based GSLB**: one authoritative DNS service, GeoIP + EDNS Client Subnet (ECS) to estimate requester location, health-aware record selection, short TTLs for failover. Anycast can be a *later* enterprise add-on for the hosted cloud (swarmy-team-operated), layered on top of the same record-selection logic.

**Decision 2: CoreDNS + a custom Go plugin, over PowerDNS or a from-scratch server.**
Options weighed:
- **CoreDNS + custom plugin (CHOSEN).** CoreDNS is a single static Go binary, plugin-chain architecture, trivially containerized, already has `geoip` (MaxMind) and `metadata` plugins to lean on for ECS/GeoIP, and a `health`/`ready` plugin. We write one plugin, `swarmy_gslb`, that, on each query, picks the answer from an in-memory zone snapshot the controller pushes. **WHY:** ships as a normal swarmy service (it's just an image + a Corefile we render — exactly the `RenderedConfig` pattern), needs no external DB, and the GeoIP/ECS heavy lifting is reusable upstream code. Failover logic lives in *our* plugin where we control it.
- **PowerDNS (Authoritative + `lua-records` / geoip backend).** Powerful, battle-tested geo backends. But it wants a SQL/zone backend, a heavier operational surface, and its geo logic is config-language-driven (lua-records) which is harder to make health-aware from live swarmy telemetry without an extra sync daemon. Rejected for MVP; keep as an alternative for users who already run PowerDNS.
- **Custom DNS server (e.g. miekg/dns directly).** Maximum control, but we'd reimplement EDNS0/ECS handling, zone serving, AXFR, DNSSEC, caching — months of nuance and a security surface. CoreDNS *is* miekg/dns with all that already done. Rejected.

**Decision 3: how records are chosen per query.**
On a query for `app.example.com`, `swarmy_gslb` does:
1. Determine requester location: prefer **EDNS Client Subnet** (the resolver's hint about the real client subnet); fall back to the resolver's own source IP. Map to lat/long + region via MaxMind GeoLite2 (bundled; updatable).
2. From the zone snapshot, take the set of **healthy** ingress endpoints (each tagged with its region's lat/long, weight, and a `healthy` bit).
3. Rank by great-circle distance to the requester; apply weights; drop unhealthy. Return the top *N* A/AAAA records (N small, e.g. 1–2 for failover spread) with a short TTL.
4. If *all* endpoints in the nearest region are unhealthy, spill to the next-nearest. If *every* endpoint is unhealthy, return all of them (better to send traffic somewhere than NXDOMAIN) and flag it.

**Decision 4: TTL & failover.** Default TTL **30s** for geo records (tunable 10–120s). DNS failover is inherently soft (caching resolvers ignore TTLs, browsers pin), so we **do not rely on DNS alone for failover**: the records bias *new* clients toward healthy regions, while the mesh/ingress epic handles in-flight cross-region failover (an ingress that receives traffic for a dead local backend can proxy to a healthy region). Document this honestly. SOA `minimum`/negative-TTL kept low too.

**Decision 5: how the DNS service learns endpoints + health — reuse, don't rebuild.**
The controller already knows: which nodes are online (heartbeat / `AgentHub.isOnline`), each node's region label, and ingress health per node (the ingress driver's `status()` / `IngressStatus.healthy`). The controller composes these into a **zone snapshot** and pushes it to CoreDNS. Two transport choices, mirroring the ingress driver's own `adminApi` vs `files` split:
- **Snapshot push to the plugin's admin endpoint** (preferred): `swarmy_gslb` exposes a tiny authenticated HTTP endpoint; the controller POSTs the full zone snapshot whenever endpoints/health change (debounced). In-memory, instant, no file reloads. This is exactly analogous to ingress `adminApi`.
- **Rendered zone file + reload** (fallback / for PowerDNS-style drivers): render a zonefile/Corefile fragment as `RenderedFile`s and have the agent write+reload. Reuses the existing `applyIngress` mechanics verbatim.

This is the key insight: **Geo-DNS is "just another pluggable driver"** in the same shape as ingress — a registry of `gslb` drivers (`coredns`, `external` (Cloudflare/Route53 via API), `none`), each producing a `RenderedDns` artifact the agent (or an API client) applies. New providers = new drivers, not core rewrites.

### Part B — HA database templates: Swarm-native operators-as-templates

**Decision 6: Postgres HA = Patroni image + a swarmy-rendered template, not a custom operator.**
Patroni (Postgres + a DCS for leader election + automatic failover) is the de-facto standard and the engine inside Spilo/Zalando, CloudNativePG-adjacent designs, etc. On Swarm we deploy it as a **3-node Patroni cluster of `global`/replicated services pinned one-per-region** using placement constraints on `swarmy.region`, plus a small DCS.
- **DCS choice: etcd** (3-node, one per region) — Patroni's best-supported DCS, simple, and we already understand quorum placement. Alternative: Consul (heavier, service-mesh-y), or Kubernetes API (n/a here). Stolon is the main alternative to Patroni (no external DCS dependency beyond its own store, proxy-based connection routing) — attractive because its **stolon-proxy gives a stable single connection endpoint that always points at the primary**, which is exactly what app services want. We will ship **two Postgres templates**: `postgres-ha-patroni` (familiar, etcd-backed) and `postgres-ha-stolon` (proxy endpoint, fewer moving parts for the connect story). Default the gallery to **Stolon** for the connect-string simplicity, mark Patroni "advanced/etcd."
- CloudNativePG is Kubernetes-only (CRD/operator); we borrow its *placement philosophy* (spread replicas across failure domains, one sync replica) but not its runtime.

**Decision 7: Redis HA = two templates — Sentinel (default) and Cluster (sharded, later).**
- `redis-ha-sentinel`: 1 primary + 2 replicas + 3 sentinels, sentinels and replicas spread across regions. Apps talk to a sentinel-aware client *or* to a thin TCP proxy that follows the primary. WHY default: simplest correct HA for the common "I want a resilient cache/queue" case.
- `redis-cluster` (later): 6 nodes (3 shards × 2), region-spread, for users who outgrow a single primary's write capacity. More client/topology complexity, so it's phase 2.

**Decision 8: templates are declarative bundles, rendered to swarmy service specs + a compose source.**
A template is a versioned, parameterized **bundle** (`@swarmy/templates`) that, given user params (name, regions, replica count, password/secret refs, storage size), renders:
- N `ServiceSpec`s (the existing `core` `ServiceSpec`) with `placement` constraints/preferences on `swarmy.region` + anti-affinity (spread by node), wired into a stack.
- A `composeSource` string stored on the `Stack` row — so the **exact same thing runs with `docker stack deploy` and no swarmy** (unopinionated guarantee). swarmy adds the controller-side niceties (failover visibility, region awareness) but is never required for the stack to run.
- Optional: a Domain/GSLB hint (e.g. expose the stolon-proxy/sentinel endpoint) so Part A and Part B compose.

**Decision 9: encoding placement/anti-affinity across regions.**
Swarm primitives, surfaced as template params, not a new DSL:
- **Anti-affinity (don't co-locate replicas):** `placement.preferences: spread by node.labels.swarmy.region` + a max-replicas-per-node constraint where supported, and constraints `node.labels.swarmy.region == <r>` for the pinned members of a quorum (etcd/sentinel must be exactly one-per-region for clean quorum).
- This requires `ServiceSpec` to gain a `placement` field (see Architecture). Until then templates can't express constraints — so the `ServiceSpec.placement` extension is the **first concrete dependency/task** of this epic.

---

## Architecture & integration

### New/changed protocol messages (`packages/core/src/protocol`)

1. **Extend `ServiceSpec` (commands.ts) with `placement`** — prerequisite for *all* HA templates and region pinning:
   ```ts
   placement: z.object({
     constraints: z.array(z.string()).default([]),      // e.g. "node.labels.swarmy.region==eu-west"
     preferences: z.array(z.object({ spread: z.string() })).default([]), // spread: "node.labels.swarmy.region"
     maxReplicasPerNode: z.number().int().positive().optional(),
   }).optional()
   ```
   The agent's dockerode `createService`/`update` already supports `TaskTemplate.Placement` — this is a thin pass-through, not an agent rewrite.

2. **New `protocol/dns.ts`** mirroring `protocol/ingress.ts`:
   - `RenderedDns` (analogous to `RenderedConfig`): `{ driver, files: RenderedFile[], reloadCommand?, adminApi?, snapshot?: DnsZoneSnapshot, summary }`.
   - `DnsZoneSnapshot`: `{ zone, records: Array<{ name; type:'A'|'AAAA'|'CNAME'; ttl; endpoints: Array<{ ip; region; lat; lon; weight; healthy }> }>, soa, updatedAt }`.
   - `ApplyDnsMsg` (`type:'applyDns'`) — controller→agent, carried in `ControllerToAgentMessage` union, for the **self-hosted CoreDNS-on-an-agent-node** case (write Corefile/zonefile + reload, or POST snapshot to local admin API). Same dispatch path as `applyIngress`.
   - `DnsStatusMsg` reuse: agent reports CoreDNS health back the same way ingress status is queried.
   Wire both into `messages.ts` discriminated unions and `COMMAND_PROTOCOL_TYPE` (`gslb.apply` → `applyDns`).

3. **Heartbeat already suffices for health** — no new health message needed for MVP. Optionally extend `IngressStatus` consumption so per-node ingress health feeds the zone snapshot's `healthy` bit. A later `dns.synthetic-check` (active HTTP probe of an endpoint from the controller) can sharpen health beyond "agent is connected."

### New package: `@swarmy/gslb` (twin of `@swarmy/ingress`)

Same registry/driver/dispatch shape so it's familiar and individually disableable:
- `GslbDriver` interface: `validate`, `render(config) -> RenderedDns` (pure), `apply(rendered, dispatch, config)`, `status`.
- Drivers: `coredns` (self-hosted; renders Corefile + pushes `DnsZoneSnapshot` via admin API or file+reload), `external` (no self-hosted server; reconciles records into **Cloudflare / Route53** via their APIs — for users who already delegate DNS there), `none`.
- `DnsDispatch` (twin of `DriverDispatch`): `resolveDnsNodes`, `pushSnapshot(nodeId|external, snapshot)`, `queryStatus`. Implemented in `apps/api` over the agent gateway / provider SDKs.
- A **`buildZoneSnapshot(orgId)`** composer in the trpc services layer that joins: nodes (region label, online), ingress domains/endpoints, ingress health → `DnsZoneSnapshot`.

### New package: `@swarmy/templates`

- `Template` type: `{ id, version, kind:'database'|'cache'|..., engine:'postgres'|'redis'|..., params: ZodSchema, render(params, ctx): { services: ServiceSpec[]; composeSource: string; domains?: DomainRoute[]; gslb?: ... } }`.
- Built-ins: `postgres-ha-stolon`, `postgres-ha-patroni`, `redis-ha-sentinel`, (`redis-cluster` later). Each is region/anti-affinity aware via the new `ServiceSpec.placement`.
- Pure render (no IO) so it powers a GUI **preview** the same way `ingress.previewConfig` does.
- Registry mirrors `IngressRegistry` so third-party templates can register.

### DB models (`packages/db/prisma/schema.prisma`)

- **Region** is the node label `swarmy.region` in existing `Node.labels` — *no new table required for MVP*. Add an optional `region String?` denormalized column on `Node` for cheap querying/indexing (`@@index([orgId, region])`), kept in sync with the label.
- New `enum GslbDriver { COREDNS EXTERNAL NONE }` + `model GslbConfig` (twin of `IngressConfig`): `orgId @unique, driver, enabled, zone, settings Json`.
- New `model GslbEndpoint` (optional; can be derived live instead) for pinned/manual endpoints + weights.
- `model Template` is **not** needed for built-ins (they're code); add `model TemplateInstance { id, orgId, templateId, version, params Json, stackId }` to record what a stack was generated from (for upgrades/re-render).
- Reuse `Stack.composeSource` for the rendered output. Audit everything via existing `AuditLog`.

### tRPC routers/services

- New `gslbRouter` (twin of `ingressRouter`): `getConfig`, `setDriver`, `setEnabled`, `setZone`, `previewZone` (returns `DnsZoneSnapshot`), `listEndpoints`, `applyNow`. Service layer `gslb.service.ts` builds the snapshot and calls `@swarmy/gslb` `applyDns` via a `DnsDispatch` over `ctx.hub`.
- New `templatesRouter`: `list`, `getSchema(id)`, `preview(id, params)` (pure render → services+compose for the builder), `deploy(id, params)` (creates a `Stack` + `TemplateInstance`, deploys via existing deployment pipeline).
- Extend `nodesRouter`: `setRegion(nodeId, region, zone?)` → updates `Node.region`/labels and pushes the Docker label via existing `updateSwarmNode`; triggers a GSLB snapshot rebuild.
- Mount both in `root.ts` alongside `ingress`.

### Agent capabilities (`apps/agent`)

- Handle `applyDns` exactly like `applyIngress`: write `RenderedFile`s, run `reloadCommand`, or POST `snapshot` to a local admin API. **No bespoke DNS logic in the agent** — it applies generic intent, preserving the architecture principle.
- Placement pass-through in the dockerode service translator (from the new `ServiceSpec.placement`).
- CoreDNS itself runs as a normal swarm service the agent deploys; the agent only manages its config, not its query path.

### UI surfaces (`apps/app`)

- **Regions:** a column/badge on the Nodes table; a "Set region" action (or auto-detected chip). A small map/region summary on the dashboard.
- **Geo-DNS page** (mirrors the Ingress page): driver picker (coredns/external/none), zone, live endpoint table with health dots + region + weight, "preview zone" (shows the `DnsZoneSnapshot`), TTL control, a globe/latency-bias visualization (later).
- **Template gallery / builder:** the existing service/stack builder gets a "Templates" tab. Cards for Postgres-HA, Redis-HA. Selecting one opens a param form (auto-generated from the template's Zod schema via the existing react-hook-form + Zod resolver), with a **region multiselect** (which regions to spread across) and a **live preview** of the rendered services + a "what survives a region outage" diagram. Deploy → normal stack deployment flow + deployment progress UI that already exists.

---

## MVP vs later

**MVP (phase 1):**
1. `ServiceSpec.placement` + agent pass-through (unblocks everything).
2. Region as `Node.region` + `swarmy.region` label; `nodes.setRegion`; Nodes UI badge.
3. `@swarmy/templates` with **`postgres-ha-stolon`** and **`redis-ha-sentinel`**, region/anti-affinity aware, rendering services + `composeSource`. Template gallery + param form + preview + deploy.
4. `@swarmy/gslb` with the **`coredns`** driver (snapshot-push admin API), `gslbRouter`, zone snapshot composer fed by online-nodes + ingress health, 30s TTL, distance ranking with MaxMind GeoLite2, ECS-aware. Geo-DNS UI page. CoreDNS deployed as a managed swarmy service.

**Phase 2:**
- `external` GSLB driver (Cloudflare/Route53) for users who don't want to self-host authoritative DNS.
- `postgres-ha-patroni` (etcd) and `redis-cluster` templates.
- Active synthetic health checks (HTTP probe per endpoint) feeding the `healthy` bit, beyond agent-connected.
- Template upgrade/re-render via `TemplateInstance`; backup/restore hooks for the DB templates (snapshot to object storage).
- DNSSEC signing in CoreDNS; AXFR to secondaries.

**Phase 3 / enterprise / hosted cloud:**
- Anycast frontend (swarmy-team-operated) layered on the same record-selection logic.
- Cross-region mesh-assisted in-flight failover (ingress proxies to remote healthy region) — co-owned with the mesh epic.
- Managed connection pooler (pgbouncer/pgcat) in front of the Postgres template.

---

## Dependencies

- **Ingress epic (hard):** GSLB points DNS at ingress endpoints and reads ingress health (`IngressStatus.healthy`) to populate the snapshot. The `RenderedDns`/driver pattern is deliberately copied from ingress; build GSLB *after* ingress stabilizes.
- **Mesh epic (soft but important):** DNS failover is soft; true in-flight failover needs the mesh/ingress to proxy cross-region. Geo-DNS is useful standalone (biases new clients) but the "survives a region" story is only complete with mesh.
- **`ServiceSpec.placement` (internal, hard):** must land first; it's small but everything in Part B needs it.
- **Infra/runtime:** MaxMind GeoLite2 DB (license key for updates; bundle a snapshot for zero-config). CoreDNS image. Stolon/Patroni/etcd/Redis/sentinel images (pin digests). Outbound API creds for the `external` driver (phase 2).
- **Deployment pipeline:** templates deploy through the **existing** stack/deployment flow — no new orchestration.

---

## Risks & open questions

- **DNS failover is fundamentally soft** (resolver caching, browser pinning, glue/NS TTLs). Risk: users expect instant failover from "Geo-DNS." Mitigate with honest UI copy + low TTLs + leaning on mesh for in-flight. Open: do we ship a default secondary/anycast for the hosted product to harden it?
- **ECS coverage is partial** (not all resolvers send it; some strip it). Fallback to resolver IP is coarse (resolver may be far from client). Acceptable for VPS-scale users; note it.
- **GeoLite2 accuracy & licensing.** Bundled snapshot drifts; auto-update needs a license key. Keep updates optional/zero-config-default.
- **Stateful HA is genuinely hard.** Split-brain (etcd/sentinel quorum), `synchronous_commit` vs availability tradeoffs, storage: Swarm volumes are node-local, so a region/node loss means the replica in another region must already have the data (streaming replication handles Postgres; for Redis it's async = possible small data loss on failover). We must **not oversell "zero data loss."** Document RPO/RTO per template. Open: do we require/recommend networked or replicated storage, or rely purely on engine-level replication (Postgres streaming, Redis async)? Recommend engine-level replication for portability; flag the async-loss window.
- **Quorum needs ≥3 regions/failure domains** for clean automatic failover; a 2-region setup can't safely auto-failover (no tiebreaker). UI must warn when regions < 3 and offer a "witness/arbiter" small node.
- **Who runs authoritative DNS on port 53?** Needs a public IP + UDP/TCP 53 reachable; some hosts block it. The `external` driver sidesteps this. Open: detect/health-check 53 reachability and warn.
- **Cross-region Swarm overlay networks** can be slow/latency-sensitive and need the right ports open (mesh epic territory). DB replication traffic across regions costs latency → affects `synchronous_commit`. Surface region RTT in the UI.
- **Open question:** delegation UX — do we manage the apex zone (requires the user to delegate NS to swarmy's CoreDNS) or only a sub-zone (`*.geo.example.com` CNAME target)? Sub-zone/CNAME target is the lower-friction default; full delegation is opt-in.

---

## Simplicity note (one-command / zero-config)

- **Region auto-detection:** on agent register, best-effort geo-locate the node's public IP (bundled GeoLite2) and propose `swarmy.region`; user confirms with one click (or accepts the default). No manual lat/long entry — the template/zone gets coordinates from the region automatically.
- **Geo-DNS is one toggle + one CNAME.** Enable Geo-DNS → swarmy deploys CoreDNS as a managed service, builds the zone snapshot from what it already knows (online nodes, ingress health, regions), and shows the **single CNAME/NS record** to paste at the registrar. No zone files, no per-record editing. Health and endpoint membership are automatic from existing telemetry.
- **HA templates are one form + Deploy.** Pick "Postgres (HA)", name it, choose regions from a multiselect (pre-filled with detected regions), Deploy. swarmy fills in placement/anti-affinity, quorum sizing, secrets, and prints **one connection string** (the stolon-proxy / sentinel-aware endpoint) — the user never sees Patroni/etcd internals. A clear "survives N-1 regions" badge sets expectations.
- **Unopinionated, always:** every template stores its `composeSource` so the exact stack runs with `docker stack deploy` and no swarmy; Geo-DNS can be `external` (point at Cloudflare/Route53) or `none`. Both halves are individually disableable, consistent with swarmy's pluggable-everything principle.
- **Defaults that just work:** TTL 30s, 3-member quorum when ≥3 regions exist (warn + offer witness otherwise), GeoLite2 bundled, snapshot-push transport — all sane out of the box, all overridable for experts.
