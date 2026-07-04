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
2. **Edge data planes publish HOST-MODE ports, never routing-mesh.**
   swarmy-dns (:53 udp+tcp, :53535 admin) and edge Caddy (80/443) must terminate
   on the exact node DNS steered to. Routing mesh re-balances and breaks
   locality.
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
   worker (`apps/api/src/workers/geodns-reconcile.ts` drift was the v1 bug this
   killed). Same rule as ingress drivers: render pure, apply at the edge.
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
- **DNS → ACME (phase 2)**: swarmy-dns can answer `_acme-challenge` TXT for
  DNS-01 — controller endpoint stages TXT into the snapshot; enables wildcards.
- **Edge Caddy spec**: `caddyEdgeSpec(opts)` exported from
  `ingress-controller.ts` is THE spec; the swarmy-stack composition must
  consume it, never hand-roll (topology/ports/mounts single-sourced).
- **Agent ↔ local Caddy**: agent writes `/var/lib/swarmy/ingress/Caddyfile` on
  the host (bind-mounted ro into Caddy at `/etc/caddy`) and execs
  `caddy reload` in the local task (found via
  `com.docker.swarm.service.name` label on the docker socket). Admin port 2019
  is never published.

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
| Edge Caddy service spec / topology | `packages/trpc/src/services/ingress-controller.ts` |
| DNS UI (zones, NS onboarding, preview, records) | `apps/app/src/components/geo/*`, Edge & ingress route |

## Operational gotchas

- Port 53 collides with `systemd-resolved` stub listener on many distros —
  onboarding copy must mention `DNSStubListener=no`.
- Host-mode published ports bind 0.0.0.0 → the DNS admin API MUST stay
  bearer-token-gated; never add an unauthenticated mutating route to it.
- DB-IP attribution ("IP geolocation by DB-IP, CC BY 4.0") is a license
  requirement — keep it in the UI when geoip source is dbip.
- `dig` verification: `dig @<node> -p 53 <host> +subnet=196.25.0.0/16` (ZA),
  `+tcp` for TCP framing, `NS`/`SOA`/`MX` for zone completeness. Local server:
  run `apps/dns` with `SWARMY_DNS_PORT=5300` and POST a fixture bundle.
- Multi-node verification: `scripts/local-vms.sh` multipass swarm (see
  LOCAL-SWARM.md + memory notes) — two VMs, two regions, kill one agent and
  watch its IP leave the answers.
