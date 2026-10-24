---
name: geo-edge-routing
description: Invariants, contracts, and file map for swarmy's global edge — swarmy-dns (authoritative geo-DNS on ingress+outlet nodes), region-aware Caddy rendering, node public IPs, and the snapshot/health contracts between them. Load before touching anything under packages/dns, apps/dns, protocol/dns.ts, dns-*.service.ts, geo/DNS UI, or region-aware ingress rendering. Product rationale lives in docs/product/edge-network.md.
---

# Geo edge routing: DNS → Caddy → container

Read `docs/product/edge-network.md` for WHY. This skill is the HOW: the
invariants that must survive every change, and where everything lives.

## Invariants (violating any of these is a bug, not a style choice)

1. **DNS answers are node PUBLIC IPs, never VIPs, never service names.**
   Source: node label `swarmy.node.public-ip` (agent-detected, controller
   cross-checked); override label `swarmy.node.public-ip.override` wins.
2. **Edge data planes terminate on the node itself, never routing-mesh.**
   Edge Caddy (80/443) publishes HOST-MODE ports. swarmy-dns runs on swarm's
   predefined `host` network with NO published ports and binds :53 udp+tcp on
   each non-loopback host address individually (`apps/dns/src/listen.ts`,
   30s re-scan, `SWARMY_DNS_LISTEN` override) — a wildcard 0.0.0.0:53 bind
   collides with systemd-resolved's stub (127.0.0.53/54:53) on every stock
   Ubuntu/Debian. The :53535 admin API binds only 127.0.0.1 + docker0.
   Routing mesh re-balances and breaks locality.
3. **Edge data planes are GLOBAL-mode services constrained to
   `node.labels.swarmy.node.ingress == true && node.labels.swarmy.node.outlet == true`.**
   Marking a node creates the plane there; no replica management.
4. **Zone data reaches DNS nodes by SNAPSHOT PUSH, never config rotation.**
   Docker configs are immutable → rotation restarts the DNS plane on every
   health flip. The agent POSTs the versioned `DnsSnapshotBundle` to the local
   admin API (`http://127.0.0.1:53535/v1/snapshot`, bearer
   `HMAC(SWARMY_SECRET, 'dns-admin:'+orgId)`); swarmy-dns persists it and
   serves through controller outages. Versions are monotonic; stale pushes are
   rejected.
5. **Web records are DERIVED, never stored.** Hostnames come from ingress truth
   (service label `swarmy.ingress.routes`, status pages, webhooks, AI outlets)
   + zone apex/www. The DB holds only `DnsZone` (zone identity, mode, pinned
   advertised nodes, serial) and `DnsRecord` (manual MX/TXT/CNAME/SRV/CAA
   only). If you're adding a column that mirrors swarm state, stop — see the
   `docker-native-storage` skill.
6. **Pure core, thin IO.** All DNS logic (steering, zone composition, query
   answering, wire encode/decode, signatures) lives in `packages/dns` and is
   imported by controller, worker, AND server. Never inline a copy into a
   worker (the deleted v1 `geodns-reconcile.ts` drifted — the bug this
   killed; `dns-reconcile.ts` now only schedules `reconcileDnsOrg`). Same rule as ingress drivers: render pure, apply at the edge.
7. **Never answer empty because of health.** Unhealthy regions are omitted;
   zero healthy endpoints → answer ALL (degraded spill). Missing GeoIP DB →
   deterministic unsteered answers. NXDOMAIN only for names that don't exist.
8. **Caddy upstream ordering is per-receiving-node.** Renderers take
   `localRegion` as DATA (`IngressConfig.localRegion`) and stay pure; the
   driver renders once per target node. Region siblings come from the
   region-reconcile worker's services (`swarmy.region.parent` /
   `swarmy.region.of` labels, `${parent}-${region}` names). No siblings →
   output must stay byte-identical to the plain VIP render (golden-tested).
9. **Precedence in the Caddy renderer: cold (scale-to-zero) > canary >
   regionUpstreams > plain VIP.** Canary and region ordering cannot combine
   (weighted vs first lb policies) — validate() warns.
10. **SOA serial bumps only when composed zone content changes**
    (`bundleSignature`), so pushes are idempotent and delegation checks mean
    something.

## Contracts between the layers

- **Ingress → DNS health**: `ingressRegionSnapshot(ctx)` (ingress.service) is
  the one source: per region, ingress nodes with `{nodeId, publicIp,
  caddyRunning, lastStatusAt}` + `localUpstreamsHealthy`. DNS healthiness =
  node online AND caddy running; local-upstreams-down = DEPRIORITISE, don't
  drop (Caddy can still proxy cross-region).
- **DNS → ACME (DNS-01, built)**: edge Caddy's `dns swarmy` module
  (`docker/caddy-swarmy/dnsprovider`) POSTs `/ingress/acme-dns/<orgId>/
  {present,cleanup}` (bearer = `HMAC(SWARMY_SECRET_KEY,'acme-dns:'+orgId)`,
  Docker secret `swarmy-acme-dns-<hash>` read from file per call). The
  controller (`acme-dns.service.ts`) refuses anything but
  `_acme-challenge.<routed host>` inside an org swarmy zone
  (`checkChallengeName`), stages the TXT IN MEMORY (`acme-challenges.ts` —
  ephemeral zone content, never the DB), `composeZone` folds it in, and it
  force-pushes to every DNS node before answering. Only wildcards use DNS-01
  (`planDnsChallenges`); BYO Cloudflare token is the secondary for zones
  swarmy doesn't serve. `answerQuery` does RFC 4592 wildcard synthesis
  (closest encloser only) — keep it, wildcard routes and their
  `swarmy-dns-check.<base>` verification depend on it.
- **Auto addresses on the org's zone**: a swarmy-ns zone flagged
  `settings.autoAddresses` (set only while delegated) replaces the sslip.io
  base (`auto-address.service` `autoAddressBase`); own-zone auto hosts go
  through the DNS gate.
- **Cluster zone** (self-reliance B2b, `cluster-zone.ts`): one swarmy-ns zone
  per org flagged `settings.clusterZone` (installer `--zone` →
  `SWARMY_CLUSTER_ZONE` → bootstrap seed, or `geodns.setClusterZone`, which
  needs live delegation). Its snapshot carries `synth.ips` (the cluster's own
  public IPv4s, additive field) and `answerQuery` synthesises
  `<a-b-c-d>.<zone>` + names under it (`@swarmy/dns` synth.ts): allow-listed
  IPs only, private/reserved refused, A only (AAAA NODATA), real records win,
  and it fills an otherwise empty A answer. It is the wildcard base
  `wildcardBaseFrom` returns first, so apps get `<svc>-<stack>.<ip>.<zone>`
  (DNS-gated); sslip.io is only the fallback with no cluster zone.
- **Auto-address base precedence** (`autoAddressBaseInfo` in
  `auto-address.service.ts`): a delegated own zone (`<svc>-<stack>.<zone>`) ›
  the cluster zone › the org's `autoAddressBase` (swarm-kv ingress settings,
  `ingress.setAutoAddressBase`) › `SWARMY_AUTO_ADDRESS_BASE` (controller-wide,
  `auto-address-base.service.ts`) › sslip.io (`DEFAULT_AUTO_ADDRESS_BASE`; the
  dashboard's "public convenience name"). The pure halves are
  `wildcardBaseFrom` and `@swarmy/ingress` `autoAddressBaseFor`
  (`auto-address-base.ts`). Only own-zone and cluster-zone hosts go through the
  DNS gate; a custom wildcard base never does. Changing the base re-hosts
  existing automatic addresses on the next domain-verify tick.
- **Which driver carries a route** is one pure rule, `routeChannel`
  (`packages/ingress/src/route-channel.ts`): the service's declared exposure
  (`swarmy.expose`, copied onto each route by the controller) first — private
  and mesh are withheld from every driver, tunnel never renders on the Caddy
  edge — then `route.driver` (`cloudflared` moves it to the tunnel, `none`
  leaves it, `caddy` or a removed driver stays on the org's). A Caddy org with
  a tunnel renders both halves (`tunnelSideConfig`). Withheld routes are
  `validate()` warnings, never errors.
- **Edge country DB**: the edge image bundles DB-IP Country Lite at
  `/usr/share/swarmy/geoip/dbip-country-lite.mmdb` (fetched by
  `docker/caddy-swarmy/geoip/bundle-dbip-country.sh`, the script the
  swarmy-dns image uses too: one edition, one NOTICE). The org setting
  `settings.geoip` (bundled | path | off) resolves through the pure
  `resolveEdgeGeoip` (`packages/ingress/src/edge-geoip.ts`) into
  `extraConfig.geoipMmdbPath`; with none, country rules render as nothing.
- **Edge traffic → latency and blocked**: the edge agent
  (`apps/agent/src/handlers/edge-traffic.ts`) scrapes Caddy's
  `caddy_http_request_duration_seconds` per host (`metrics { per_host }`):
  per-bucket duration deltas plus 403/429 counts off the histogram's `code`
  label (`@swarmy/core` `edge-traffic-caddy.ts`), as optional fields on
  `metrics.edge` (older controllers drop them, older agents omit them). The
  controller keeps BUCKET COUNTS in the hub's 1-minute ring and the 5-minute
  `EdgeTrafficRollup` rows (`telemetry.db`, 7 days; the coverage row carries
  each edge's whole histogram). p50/p95 come only from merged buckets
  (`edge-latency.ts` `mergeLatency`), never an average of percentiles.
  `traffic.now` / `traffic.series` (`traffic.service.ts`, `traffic-series.ts`,
  narrowable to one `host` or `nodeId`) serve them. Requests a protection
  `abort`s never reach Caddy's metrics and are not counted.
- **Edge Caddy spec**: `caddyEdgeSpec(opts)` exported from
  `ingress-controller.ts` is THE spec; the swarmy-stack composition must
  consume it, never hand-roll (topology/ports/mounts single-sourced).
- **Agent ↔ local Caddy**: NO host files. The agent on each node running a
  Caddy task writes that node's render INSIDE the task at
  `/etc/caddy/Caddyfile` (`localReload.file`, exec over the docker socket —
  works for container agents too) and execs `caddy reload` there (task found
  via the `com.docker.swarm.service.name` label). Both topologies use it
  (`applyVia` 'exec' controller / 'local' edge-per-node); edge-per-node targets
  EVERY node with a running edge task. Admin port 2019 is never published.
- **Topology swap**: controller (replicated) ↔ edge-per-node (global) share
  the service name `swarmy-ingress-caddy` and its named cert volumes. Swarm
  can't change mode in place → `deployWithModeSwap` removes + recreates;
  `setTopology` persists the setting only after the deploy succeeds, and
  ingress-reconcile converges a live mode that disagrees with the setting.
- **Certs across edge nodes**: edge-per-node REQUIRES one shared CertMagic
  store — per-node storage under geo-DNS breaks HTTP-01/TLS-ALPN-01 (the CA's
  vantage points reach edges that don't hold the token). The store is swarmy
  object storage: `ingress-certs.ts` `ensureEdgeCertStorage` (bucket
  `swarmy-edge-certs`, bucket-scoped key via `buckets.service`
  `provisionSystemBucketKey`, AWS shared-credentials INI in a Docker secret
  mounted on the edge as `AWS_SHARED_CREDENTIALS_FILE`) → the renderer emits a
  credential-free `storage swarmy { replica s3 { … } }` block. Garage is a
  REPLICA, never a boot dependency (QA-066: the mesh-control node's edge had
  no certs until Garage answered, Garage needed the mesh, the mesh needed that
  edge → reboot deadlocked forever). `storage swarmy`
  (docker/caddy-swarmy/certstore, Go, unit-tested in the image build) serves
  every read from the node's data volume, fills local misses from the replica
  (5 s timeout + 30 s circuit breaker; a dead replica reads as "not found" so
  certmagic goes to ACME), writes local-then-replica, takes the replica lock
  only while it answers (else the local lock alone), and runs a newer-wins
  sync both ways every 5 min (30 s while work is pending). OCSP staples never
  leave the node. An S3 HeadObject 404 is a miss, not an outage. The local copy is
  plain 0600 files on the root-only volume; the replica copy stays NaCl-sealed
  (certmagic-s3 `encryption_key`). Never make a TLS boot path wait on Garage
  or anything reached over the mesh. NEVER render a credential into the
  Caddyfile — it lands in the admin-API JSON and Caddy's autosave. `setTopology` refuses
  edge-per-node while object storage is off; ingress-reconcile adopts orgs
  already on edge-per-node. The controller topology keeps local file storage.

## File map

| Concern | Where |
|---|---|
| Pure DNS core (steer/compose/answer/wire/signature) | `packages/dns/src/*` |
| swarmy-dns server (UDP/TCP/admin/store/geoip) | `apps/dns/src/*` |
| Snapshot protocol types + applyDns | `packages/core/src/protocol/dns.ts` (+ `messages.ts`, hub `types.ts` `'dns.apply'`) |
| Controller: snapshot build / deploy / push / zones / records | `packages/trpc/src/services/dns-*.ts` |
| Provider sync (Cloudflare/Route53 mode) | `packages/trpc/src/services/geodns-provider.ts` |
| Reconcile worker (15s compose→signature→push) | `apps/api/src/workers/dns-reconcile.ts` |
| Node roles / region / public-ip labels | `packages/trpc/src/services/node.service.ts` |
| Agent: applyDns, public-ip detect | `apps/agent/src/handlers/dns.ts`, `apps/agent/src/public-ip.ts` |
| Region-aware Caddy render | `packages/ingress/src/render/caddyfile.ts` (+ `types.ts` RegionUpstream/localRegion) |
| Region sibling discovery | `packages/trpc/src/services/ingress-regions.ts` |
| Cluster zone: synthesis, lifecycle, install-time seed | `packages/dns/src/synth.ts` (+ `answer-records.ts`), `packages/trpc/src/services/cluster-zone{,.service}.ts`, `apps/api/src/bootstrap/cluster-zone.ts`; UI `apps/app/src/components/geo/cluster-zone-card.tsx` |
| Auto-address base (configured / env / sslip.io) | `packages/ingress/src/auto-address-base.ts`, `packages/trpc/src/services/{auto-address,auto-address-base}.service.ts` |
| Route channel (declared exposure + per-route driver) | `packages/ingress/src/route-channel.ts` |
| Edge country DB setting | `packages/ingress/src/edge-geoip.ts`, `packages/trpc/src/services/edge-geoip.service.ts` |
| Edge traffic: scrape, latency buckets, ring/rollups, reads | `apps/agent/src/handlers/edge-traffic.ts`, `packages/core/src/edge-{traffic,traffic-caddy,traffic-hosts,traffic-extras,latency}.ts`, `packages/trpc/src/services/{traffic.service,traffic-series}.ts`, worker `apps/api/src/workers/edge-traffic.ts` |
| Edge Caddy service spec / topology | `packages/trpc/src/services/ingress-controller.ts` |
| DNS UI: Network › Geo-DNS (ask from anywhere, one records table, delegation, steering; zones, nameserver picks and server regions at Controls) | `routes/_authed/network_.geo-dns.tsx` → `apps/app/src/components/geo/geodns-page.tsx` (`ask-model.ts`: the continents `regionCoord` places, so `geodns.previewResolution` steers from the point the map draws; `zone-records-model.ts`; `delegation-section.tsx`; `steering-section.tsx`). `components/geo/*` also serves Network › Domains (`components/network/*`) and the app Domains tab |

## Operational gotchas

- Never bind swarmy-dns to 0.0.0.0:53 (or publish :53 host-mode): it collides
  with the `systemd-resolved` stub. Per-address binds coexist with it — do not
  tell operators to disable `DNSStubListener`.
- The DNS admin API stays loopback/docker0-only AND bearer-token-gated; never
  add an unauthenticated mutating route to it. Container-backend agents reach
  it via their bridge gateway (docker0) — see `apps/agent/src/handlers/dns.ts`.
- Serving truth for the UI is `geodns.getConfig().runtime`
  (`dns-runtime.ts`: task error + per-node push outcome), never `enabled`.
- DB-IP attribution ("IP geolocation by DB-IP, CC BY 4.0") is a license
  requirement — keep it in the UI when geoip source is dbip, and on the
  Countries protection card for the edge's bundled copy.
- `dig` verification: `dig @<node> -p 53 <host> +subnet=196.25.0.0/16` (ZA),
  `+tcp` for TCP framing, `NS`/`SOA`/`MX` for zone completeness. Local server:
  run `apps/dns` with `SWARMY_DNS_PORT=5300 SWARMY_DNS_LISTEN=127.0.0.1` (auto
  mode skips loopback) and POST a fixture bundle.
- Multi-node verification: `scripts/local-vms.sh` Lima swarm (see
  LOCAL-SWARM.md + memory notes) — two VMs, two regions, kill one agent and
  watch its IP leave the answers.
