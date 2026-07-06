# Roadmap: swarmy as a self-hosted mini-cloud

Status: **governing roadmap** (2026-07). Supersedes `plans/ROADMAP.md` (the
epic-sequencing roadmap — its P0–P2 phases are substantially built) as the
forward plan. Product-level "why" for each area lives in `docs/product/`
(start at `product-shape.md`); this doc is the delta between where the code
is today and the updated direction, and the order we close it in.

## 1. The direction (one paragraph)

swarmy is no longer positioned as "a nice UI for Docker Swarm." It is **your
own cloud, on your own hardware**: a self-hosted mini-cloud platform for
VPSs, home servers, office boxes and bare metal — Docker Swarm underneath,
with private mesh networking (NetBird), a public edge (Caddy / "Swarmy
Edge"), optional zero-firewall exposure (Cloudflare Tunnel), native object
storage (Garage), native databases (Postgres HA + PITR, Valkey), GeoDNS,
backups/DR, and a protection layer — **with no required swarmy cloud**: the
first node bootstraps everything. The defining architecture decision: **the
swarmy agent is a host-level reconciler — a Bun-compiled binary under
systemd, outside Docker — because the thing that manages Docker must not
depend on Docker being healthy.** (Container remains the fallback backend
for hosts without systemd.)

## 2. Where we actually are (code-confirmed, 2026-07)

The direction doc's v1/v1.5/v2 scoping was written greenfield; the codebase
is far past it. Verified done, no work needed beyond docs:

- **Postgres HA**: single / primary-replica / failover (etcd DCS) / geo
  topologies, streaming replication, automatic promote on primary loss,
  replication-lag telemetry, `-rw`/`-ro` endpoints + connection injection
  (`manageddb-reconcile.ts`). Master-master is explicitly *not* the default
  (matches the direction).
- **PITR + DB backups**: WAL archiving via per-cluster wal-shipper sidecar,
  wal-g/pgbackrest physical + pg_dump-family logical engines, four restore
  modes incl. point-in-time (`dbBackup.service.ts`, agent `backup.ts`).
- **Valkey/Redis**: single / replica / sentinel, persistence, BGSAVE-backed
  backups, attach injection (`cache.service.ts`).
- **Garage object storage — bucket plane**: deploy per member node, bucket/
  key CRUD, quotas, website (public) exposure, attach with `S3_*` injection,
  native `swarmy-backups` DR bucket (`replicatedStore.service.ts`,
  `buckets.service.ts`).
- **Mesh**: pluggable driver registry (none/netbird/headscale/tailscale/
  wireguard), NetBird via official client + Admin-API control plane, ACL'd
  direct-connect (`packages/mesh`). Control-plane client is coded but
  `UNVERIFIED` against a live NetBird.
- **Ingress**: six drivers, Caddy default with admin/file/edge-per-node
  apply paths, auto-HTTPS + on-demand TLS ask endpoint, HA cert storage via
  Redis, region-aware upstreams, canary, scale-to-zero (`packages/ingress`).
- **Cloudflare Tunnel**: token + locally-managed modes, CF API config push,
  DNS CNAME upsert (`tunnel.service.ts`, `drivers/cloudflared.ts`).
- **GeoDNS**: authoritative geo-DNS app (`apps/dns`), ECS, mmdb GeoIP,
  nearest-region steering, zones + manual records, reconcile worker.
- **Protection (partial)**: per-route rate-limit, IP allow/deny, bot-UA
  block, body cap, required headers (`RouteProtectionSchema`).
- **Resilience/DR**: restic backup targets (S3/node), controller self-backup
  (passphrase-encrypted bundle enabling swarm re-adoption), restore-on-
  recovery worker, 9-check resilience score, three safe drills (restore /
  failover / backup-verify).
- **Secrets/config**: Docker-secret families with versioned rotation +
  usage maps; encrypted `*Ref` columns for cluster-level credentials.
- **Governance**: org wall → ABAC (Cedar-optional) → guardrails admission →
  single audit writer.
- **Install scaffold**: two-stage checksum-pinned installer, systemd unit +
  env-file rendering, Docker auto-install, uninstall path
  (`apps/api/src/install/*`).

## 3. The gaps (what "get there" actually means)

| # | Pillar | Status today | Gap to close |
|---|---|---|---|
| WS1 | **Host-binary agent + self-update** | Scaffolded, non-functional: systemd unit + installer + sha256 verify all exist, but **no binary is ever compiled or served** (`AGENT_BINARY_SHA256='{}'`, no `/install/bin/:platform` route; agent ships only as a container). `updateAgent` exists in the protocol with **no handler**. | `bun build --compile` for linux-x64/arm64 in CI, checksummed, served by the controller; make systemd the working default backend; implement self-update (download → verify → atomic swap → restart) + `docker-recreate` for the container backend; upgrade UX in the nodes UI. |
| WS2 | **Swarm quorum & recovery** | Greenfield: zero code for quorum/autolock/unlock/rotation/promote. | Manager-count + quorum-risk resilience checks ("use 1/3/5", one-failure-from-loss); autolock + encrypted unlock-key custody (with opt-out); join-token rotation; promote/demote with quorum guard; guided manager-replacement flow. |
| WS3 | **Declared exposure modes** | Exposure is *inferred + audited* (public-port / public-domain / internal-managed / private), never *declared*. | Per-service `swarmy.expose` intent label (public / tunnel / private / mesh) + UI selector; admission enforces intent-vs-spec; classifier gains declared-vs-observed drift detection; ingress render honors the mode. |
| WS4 | **Protection layer completion** | Rate-limit/IP/bot/body/headers done. Caching, country rules, WAF absent. | Response caching, country/geo allow-deny (reuse the DNS mmdb machinery), WAF-lite (optional Coraza/CRS + a small managed ruleset) in the `docker/caddy-swarmy` build + `RouteProtectionSchema` + renderer. Honest scope: HTTP-layer; upstream (CF/provider) owns volumetric DDoS. |
| WS5 | **Garage lifecycle** | Bucket plane done; cluster lifecycle is a one-shot `enable()`. `garageNodeId` never discovered; no reconcile worker; no resync/re-layout; no key rotation; no presigned URLs. | `storage-reconcile` worker (node-id discovery, layout convergence, repair-after-change, resync progress), bucket-key rotation via the secret-family pattern, SigV4 presign endpoint. |
| WS6 | **Backup retention** | `retentionDays` stored + surfaced everywhere; **never enforced** — no `restic forget`/`prune` in the repo. | Post-backup `forget --prune` across volume/DB/cache paths, per-target retention knob, audited prunes. |
| WS7 | **Install profiles + data node roles** | Only `JoinToken.roleHint` + free-form labels; node roles stop at ingress/outlet/region/cost. | Token `profile` (default / private-mesh / edge / storage / database) resolving to label bundles + bootstrap flags; `swarmy.node.storage` / `swarmy.node.database` roles feeding Garage member selection + managed-DB placement; flip NetBird to default-when-mesh-enabled. |

Deferred (flagged, not blocking): live verification of the NetBird
control-plane client (needs a real NetBird instance); additional tunnel
providers (ngrok, tailscale-funnel — CF covers the direction); active-active
Postgres logical-replication wiring (direction explicitly prefers
single-writer); macOS/Windows agent targets beyond a darwin dev build.

Phase-A follow-ups (verifiers' findings, deliberately deferred):
- **WS3**: the exposure-audit *worker* mirrors the classifier (can't subpath-
  import trpc internals) and doesn't yet alert on declared-intent drift — the
  Exposure page does; mirror the drift check into the worker next pass. Ingress
  *render* doesn't consult `swarmy.expose` — admission blocks bad specs and the
  audit flags drift, which covers the promise; render-level refusal is belt+braces.
- **WS4**: `geoipMmdbPath` is extraConfig-only (no UI, no edge mmdb
  auto-download — reuse `apps/dns` geoip-manager later); country rules degrade
  to a validate() warning until a path is set. The `docker/caddy-swarmy` image
  (now + cache-handler + maxmind modules) must be built, pushed, and set as the
  controller image before cache/geo/rate-limit enforce on a real swarm.
- **WS5**: Garage admin layout/health API shapes written from docs — needs one
  live pass against `dxflrs/garage` on the local VMs. `swarmy-garage` still
  deploys replicated:1 (true multi-member needs per-node deployment in
  garage-render + the agent storage handler). Presigned URLs sign the in-swarm
  endpoint; a public S3 edge endpoint + endpoint knob is the follow-up.

## 4. Execution order

1. **WS1 first, serially** — it is the keystone the direction doc leads
   with, everything installer-shaped already assumes it, and self-update
   makes every later agent change cheap to ship.
2. **Phase A in parallel** (disjoint files): WS3 exposure modes, WS4
   protection, WS5 Garage lifecycle.
3. **Phase B in parallel**: WS2 swarm recovery (sole owner of the protocol
   union + agent executor in this phase), WS6 retention, WS7 profiles/roles.
4. Integration gates between phases: repo-wide typecheck + tests, product
   docs updated where behaviour changes (`compute-and-onboarding.md`,
   `ingress-and-exposure.md`), tracker below flipped.

## 5. Tracker

| Workstream | Status |
|---|---|
| WS0 docs + roadmap | done |
| WS1 host-binary agent + self-update | built — VM e2e pending |
| WS2 swarm quorum & recovery | built (pending integration) |
| WS3 declared exposure modes | built (pending integration) |
| WS4 protection completion | built (pending integration) |
| WS5 Garage lifecycle | built (pending integration) |
| WS6 retention enforcement | built (pending integration) |
| WS7 install profiles + data roles | in progress |

## 6. Supersessions

- `plans/ROADMAP.md` — superseded as the forward plan by this doc (its
  phases are largely shipped; its cross-cutting concerns section, §5,
  remains binding).
- `plans/managed-db-topology.md` — stale ("future / no code"): the managed-DB
  plane is implemented well beyond that design (Postgres-only engines,
  bitnami replication rather than Patroni/Stolon). Kept for label-schema
  history only.
