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
  removes the legacy replicated controller (seconds of blip).
- Edge-per-node certificates are shared through swarmy's own object storage
  (Garage bucket `swarmy-edge-certs`, `storage s3` via
  techknowlogick/certmagic-s3) with zero setup: `setTopology('edge-per-node')`
  mints a bucket-scoped key, stores it as an AWS shared-credentials Docker
  secret mounted on the edge (`AWS_SHARED_CREDENTIALS_FILE`), and renders a
  credential-free `storage s3` block. Object storage off ⇒ the switch is
  refused with a one-click "turn on object storage" in the topology card; an
  org already on edge-per-node is adopted by ingress-reconcile once it's on.
  The single controller keeps Caddy's local file storage. The Redis
  (`caddy-storage-redis` / `setHaStorage`) path is removed — the plugin no
  longer compiles against current Caddy, and object storage replaces it.
- swarmy's Caddy build (`ghcr.io/requestflo/caddy-swarmy:latest`) is the
  default image for both topologies; `docker/caddy-swarmy` now pins
  `caddy:2.11.4-builder` and every plugin to versions verified to compile together.
- Migration: certificates a single controller issued live on its node's
  `swarmy-ingress-caddy-data` volume; after the switch each host's certificate
  is issued ONCE more into the shared store on first use (a handful of hosts is
  far inside Let's Encrypt's limits). Switching back to the controller keeps the
  bucket + key; the controller serves from its local volume again.

## Phase 2 (designed, not yet built)

- **DNS-01 via swarmy-dns**: a small libdns provider compiled into
  caddy-swarmy posting `_acme-challenge` TXT records to the controller
  (`/dns/zones/{id}/records` already accepts TXT; the missing piece is the Go
  provider + an instant-push path). Enables wildcards and removes the
  inbound-80 ACME dependency.
- Active upstream health probes per region (today: passive Caddy health +
  agent task-liveness telemetry).
