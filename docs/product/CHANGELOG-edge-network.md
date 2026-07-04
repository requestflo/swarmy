# Edge network rework — breaking changes & migration notes (2026-07)

The geo-DNS layer was rebuilt around "swarmy is the nameserver"
(see [`edge-network.md`](./edge-network.md)). What breaks and what to do:

## REST API (breaking)

- `GET/POST /dns/records` and the old `DnsRecord` DTO (`host`, `region`,
  `target_ingress`, `healthy`) are **gone**. Web DNS answers are now derived
  from ingress — there is nothing to CRUD for them.
- New surface: `GET/POST /dns/zones`, `DELETE /dns/zones/{id}`,
  `GET /dns/zones/{id}/delegation`, `GET/POST /dns/zones/{id}/records`
  (manual records: `{name, type, value, ttl?, priority?}` — MX/TXT/CNAME/SRV/
  CAA/NS), `DELETE /dns/records/{id}`. Regenerate SDKs from `openapi.json`.

## Database

Migration `0003_swarmy_nameserver`:

- New `dns_zone` table; rows are seeded from the old `geo_dns_config.zone`
  (`provider` `coredns` → mode `swarmy-ns`).
- `dns_record` is repurposed to manual static records. **Old manual geo
  records are intentionally dropped** — the automatic derivation supersedes
  them. If a host must resolve somewhere swarmy doesn't route, use a manual
  `A`/`CNAME` record (it overrides the derived answer, with a UI warning).
- `geo_dns_config` loses `zone`/`ttl`/`provider` (moved to `dns_zone`) and
  keeps org-level settings (`geoipSource` etc.).

## Behaviour

- CoreDNS is no longer deployed. The `swarmy-dns` image
  (`ghcr.io/requestflo/swarmy-dns`) runs as a **global service on
  ingress+outlet nodes** with host-mode port 53; enable via the Edge & ingress
  page master switch.
- GeoIP works out of the box (DB-IP Lite, CC BY 4.0 — attribution shown in the
  dashboard). MaxMind remains an opt-in upgrade via license-key secret; the
  GeoLite init-service machinery is removed.
- Cloudflare/Route53 provider sync is unchanged in spirit but now per-zone
  (`DnsZone.mode`), fed from the same composed snapshot as swarmy-ns zones.
- Ingress gains an opt-in `edge-per-node` topology (`ingress.setTopology`):
  global host-mode Caddy per ingress node, per-node region-aware upstreams,
  config via agent-local reload (admin port never published). Switching
  removes the legacy replicated controller (seconds of blip). The
  `docker/caddy-swarmy` image is now required for edge topology with shared
  cert storage (adds `caddy-storage-redis` alongside `caddy-ratelimit`).

## Phase 2 (designed, not yet built)

- **DNS-01 via swarmy-dns**: a small libdns provider compiled into
  caddy-swarmy posting `_acme-challenge` TXT records to the controller
  (`/dns/zones/{id}/records` already accepts TXT; the missing piece is the Go
  provider + an instant-push path). Enables wildcards and removes the
  inbound-80 ACME dependency.
- Active upstream health probes per region (today: passive Caddy health +
  agent task-liveness telemetry).
