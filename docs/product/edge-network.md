# The swarmy edge network — "swarmy is the nameserver"

**Status: canonical product design (2026-07). Supersedes the GSLB half of
`plans/geo-dns-multiregion-ha-templates.md`.**

## The feeling we are building

Someone running swarmy can rent VPSes anywhere in the world and stitch them into
one global platform with nothing but the one-line install script:

1. They buy a VPS in Johannesburg, paste the install one-liner.
2. The node joins the WireGuard mesh, joins the Docker Swarm over the mesh, and
   shows up on the Infra canvas.
3. They flip the node's **ingress** and **outlet** switches and give it a region
   (`za-johannesburg`).
4. From that moment, people near South Africa who visit `requestflo.com` are
   served **by that node** — DNS resolves to its IP, its Caddy terminates TLS,
   and the request lands on the nearest container.

No `eu.domain.com`. No registrar changes after initial setup. No anycast, no
BGP, no cloud lock-in. It should feel like magic: **anycast-style behaviour
built from commodity VPSes**, because swarmy itself answers the DNS queries.

## How it works (request path)

```
resolver near client
      │  ① NS delegation: registrar says ns1/ns2.requestflo.com (glue → node IPs)
      ▼
swarmy-dns on an ingress+outlet node          (authoritative, port 53, every
      │                                        ingress+outlet node runs one)
      │  ② per-query answer: ECS or resolver IP → GeoIP → haversine ranking of
      │     HEALTHY ingress nodes → A record(s) of the nearest node, TTL ~30s
      ▼
Caddy on that node                            (host-mode 80/443, per-node config)
      │  ③ region-aware upstreams: same-region service tasks first,
      │     other regions as automatic fallback
      ▼
container (same node / same region / any region over the swarm overlay,
           which rides the WireGuard mesh between locations)
```

Three layers, one story:

- **DNS gets the client to the right node.** Every ingress+outlet node runs
  `swarmy-dns`, our own authoritative server. The swarmy user pins 2–4 of those
  nodes as the **advertised nameservers**; the UI shows copy-paste registrar
  instructions (custom nameserver hostnames + glue IPs). Because we ARE the
  nameserver, each query is answered per-query with the nearest healthy ingress
  node — that is the entire trick that replaces anycast.
- **Caddy gets the request to the right container.** The node that DNS chose
  runs Caddy with a config rendered FOR that node: upstreams ordered
  same-region-first with cross-region fallback (`lb_policy first` + health
  checks). If the local region's tasks die, requests transparently spill to the
  next region over the mesh.
- **The mesh makes all of it one network.** Swarm's overlay (and therefore
  cross-region fallback and cert-storage coordination) rides the WireGuard mesh.
  This is why mesh linking of ALL nodes is a hard requirement, not an add-on.

## Roles and where truth lives

- `swarmy.node.ingress` + `swarmy.node.outlet` (Docker node labels) — a node
  that has BOTH accepts public traffic and serves DNS. `swarmy-dns` and the edge
  Caddy are **global-mode services constrained to these labels**: mark a node →
  the data plane appears on it; unmark → it drains. No replica math anywhere.
- `swarmy.region` (node label) — the geography used for steering and for
  region-aware upstream ordering.
- `swarmy.node.public-ip` (node label) — agent-detected public IP, cross-checked
  by the controller against the agent's connection source; manual override label
  wins. DNS answers are exactly these IPs.
- Zones + manual records (MX/TXT/…) live in the DB (`DnsZone`, `DnsRecord`) —
  they are the user's input artifact, not swarm state. Everything derivable
  (which hosts exist, which nodes are healthy, which IPs to answer) is derived
  live from Docker/hub truth. See the `docker-native-storage` skill.

## DNS behaviour (what "authoritative" commits us to)

- **Web records are automatic.** Any domain attached through ingress — service
  routes (`swarmy.ingress.routes`), status pages, inbound webhooks, AI outlets —
  plus the zone apex (and `www` unless claimed) resolves to the edge with zero
  record entry. There is deliberately **no** manual "host + region + target"
  flow; if you have to manage geo records by hand, the product has failed.
- **Everything else is manual but first-class.** Pointing NS at swarmy means
  swarmy must answer MX, TXT/SPF/DKIM, CNAME, SRV, CAA — a real records UI
  exists for these. Never NXDOMAIN a zone we own because we only thought about
  web traffic.
- **Per-query steering**: EDNS Client Subnet when the resolver sends it, else
  resolver source IP → GeoIP city DB → great-circle distance to each healthy
  ingress node → nearest 1–2 answers, short TTL (default 30s). Unhealthy regions
  are omitted; if nothing is healthy we answer with everything rather than
  nothing (degraded beats dark).
- **GeoIP is zero-config**: DB-IP Lite city database auto-downloaded by each
  DNS node (CC BY 4.0 — attribution shown in the UI), optional MaxMind GeoLite2
  license key for accuracy, file mode for air-gapped swarms. Missing DB never
  breaks resolution — answers just lose geo preference.
- **Survives the controller dying.** The controller pushes zone snapshots to
  every DNS node (agent-mediated, versioned); nodes persist the last snapshot
  and keep answering from it. DNS is a data plane, not a control plane.
- **Both hosting paths.** Users who won't move their nameservers keep the
  provider-sync mode: swarmy pushes the same steered records into Cloudflare or
  Route53 instead. One snapshot, two delivery mechanisms.

## Failure modes (designed, not accidental)

| Failure | Behaviour |
|---|---|
| A region's nodes go offline | Its IPs drop from answers within one reconcile tick (~15s) + TTL (~30s). In-flight clients with cached answers fail over at the Caddy layer only if the node is actually up but the backends died; a hard node death relies on the short TTL. |
| Local region's containers die, node fine | Caddy `lb_policy first` fails over to next-region upstreams over the mesh; DNS keeps answering with the node (degraded, not dead). |
| Controller down | DNS nodes serve the last pushed snapshot; Caddy keeps its last config. New topology changes wait; traffic does not. |
| GeoIP DB missing/stale | Deterministic (unsteered) answers; never an outage. |
| All regions unhealthy | Answer with all endpoints (spill), never empty. |

## Explicitly rejected

- **Anycast / BGP** — incompatible with "anyone with random VPSes can run this".
  A future hosted tier can layer real anycast on the same selection logic.
- **Region subdomains** (`eu.domain.com`) — leaks infrastructure into the
  product; the whole point is one apex domain that behaves.
- **CoreDNS + static zonefiles** (the v1 build) — static answers per health
  epoch can't do per-query nearest-node, and config rotation restarts the DNS
  plane. Replaced by `swarmy-dns` (Bun/TS, in-house, snapshot-fed).
- **Routing-mesh ports for the edge** — Swarm's ingress mesh would re-balance
  connections to arbitrary nodes, destroying the locality DNS just created.
  Edge services publish host-mode ports.
- **Manual geo records** — see above; automation is the product.

## Registrar onboarding (the one manual step)

The UI must hold the user's hand through the only part we can't automate:

1. Pick 2–4 pinned nodes (stable, geographically spread) → swarmy names them
   `ns1.<zone>` … and shows a table of hostname → glue IP with copy buttons.
2. At the registrar: set custom nameservers WITH glue/host records.
3. "Check delegation" button: live `NS` lookup + direct SOA query of each glue
   IP, per-NS pass/fail badges, honest "registrar changes can take hours"
   expectations.
4. Adding/removing ordinary ingress nodes never touches the registrar — only
   changing the pinned set does, and the UI warns loudly there.

Nodes running a nameserver must not fight `systemd-resolved` for port 53 — the
onboarding copy documents `DNSStubListener=no`.

## Implementation map

The operational conventions and invariants live in the
`geo-edge-routing` skill (`.claude/skills/geo-edge-routing/SKILL.md`). Key
homes: `packages/dns` (pure DNS logic: steer/compose/answer/wire),
`apps/dns` (the swarmy-dns server), `packages/core/src/protocol/dns.ts`
(snapshot push protocol), `packages/trpc/src/services/dns-*.ts` (controller),
`packages/ingress` (region-aware Caddy rendering), `apps/agent` (applyDns,
public-IP detection, local Caddy reload).
