# swarmy — Founder Recommendations (decisions, not menus)

> Companion to `plans/ROADMAP.md`. Crisp answers to the open questions. Each is a final call with the one reason that decides it and the escape hatch.

## DATA STORE — Postgres dialect, lite by default via PGlite. Not SQLite.

**Decision:** Default to **PGlite** (Postgres-in-WASM, in-process, zero dependencies). Stay on the Postgres *dialect* in all three modes — lite (PGlite), swarmy-bootstrapped managed Postgres, and external BYO Postgres — with **one schema and one migration history**.

**Why:** The controller has many concurrent writers (WS gateway + metrics/retention workers + tRPC), and `schema.prisma` already leans on native enums, `jsonb`, `BigInt`, and `timestamptz`. SQLite/libSQL would permanently fork the schema (no native enums, no jsonb operators, single-writer contention) — a tax paid forever to avoid running one process now. PGlite gives the zero-dependency single-binary feel *without* leaving the dialect, so the only thing that changes between modes is the Prisma 7 driver adapter (`@prisma/adapter-pglite` vs `PrismaPg`).

**Upgrade path:** Lite by default; auto-suggest the swarmy-managed `postgres` swarm service on the 2nd node; one-click migrate via logical dump (same dialect → trivial). External Postgres always honored.

**Watch:** PGlite's Prisma-7 adapter maturity is the one risk — keep a managed single-node Postgres container as the documented fallback (still same dialect, so no schema change if we have to fall back).

## NETWORKING — NetBird (self-hosted control plane), pluggable.

**Decision:** **NetBird** is the default `MeshDriver`. Tailscale, Headscale, and raw WireGuard ship as alternative drivers.

**Why:** It's the only option whose entire control plane (management + signal + relay, now a single unified server binary) is open source and self-hostable next to `apps/api` — which is mandatory for a source-available, self-hostable product and for off-cloud DR where you can't depend on a vendor SaaS in the critical path. The data plane is kernel WireGuard either way, so self-hosting costs nothing on throughput. Decisively, NetBird's setup-keys-with-auto-groups + Admin API make the one-command, API-driven enroll/ACL flow possible; Headscale's file-based ACLs are awkward to drive from a dashboard, and Tailscale's coordination plane is proprietary.

**Escape hatch:** Tailscale driver for shops already living in it (supply an auth key); Headscale for GitOps/config-as-code ACL teams; raw WireGuard for air-gapped flat networks. Default org config is `driver = none` — mesh is an opt-in toggle.

## INGRESS — Caddy default + Cloudflare Tunnel. Keep Traefik, demote it.

**Decision:** **Caddy** is the default ingress driver (automatic HTTPS / on-demand TLS is the product). **Cloudflare Tunnel** is the first-class option for the no-public-IP majority. **Keep Traefik** but demote it to "advanced / bring-your-own" with no swarmy-owned HA investment. `none` stays the literal default.

**Why:** Caddy's auto-HTTPS makes "deployed = reachable over TLS" zero-config. Traefik is powerful but its HA/cert story is work we shouldn't fund when Caddy gives it for free; we keep it for users who already run it. Cloudflare Tunnel solves the single biggest self-hoster blocker (no public IP / NAT) without us building anything custom — provision token tunnels via the API and run the connector as a swarm service through the existing `deployService` path.

**HA cert approach:** Shared cert/ACME state across all Caddy instances via `pberkel/caddy-storage-redis` pointed at a swarmy-managed Redis (manager-pinned, off the request hot path). Every Caddy instance shares one ACME account + cert pool, so the existing per-node fan-out *becomes* the HA cluster — a pure render change (`storage redis {…}` + `on_demand_tls { ask … }`), with the controller as the `ask` endpoint to gate custom domains. Back up the Redis cert-state volume via the volumes-DR mechanism.

## OBSERVABILITY — One ClickHouse store; build the UI native; don't bundle SigNoz.

**Decision:** A single **ClickHouse** store for traces + metrics + logs, fed by the **OpenTelemetry Collector** (node agent + gateway topology mapped to Swarm services). Build a **thin native trace UI** querying ClickHouse via tRPC inside swarmy's org-scoped shell; keep embedded Jaeger as an off-by-default escape hatch.

**Why:** One stateful service instead of the four-service Grafana LGTM stack, with correlation by SQL join. Take the proven open pieces (ClickHouse + the Collector's ClickHouse schema, both MIT) but **do not bundle SigNoz/Uptrace** — they ship their own auth/multi-tenancy/UI that would fork Better Auth and give users two login systems (same "use the tool, own the UX" move volumes-DR makes with restic). Per-stack opt-in via env/label injection at deploy time keeps it unopinionated and respects user-set `OTEL_*` vars.

**Note:** ClickHouse is stateful — it depends on volumes-DR for its volume + backup, and retention moves to ClickHouse TTLs (killing the `MetricSample` write-amplification the code already flags). Fail open: if the store is down, the live in-memory metrics ring still works.

## REPLICATED STORE (volumes/DR) — Garage, with restic as the backup spine.

**Decision:** **Garage** (single Rust binary, replication-not-erasure-coding, built for geo-spread non-datacenter nodes) for the bundled replicated S3 store. **restic** is the backup/restore engine (encrypt-at-source, single static binary, S3-everywhere backend). MinIO supported as BYO/single-node.

**Why:** The killer insight is that the object store, off-node replication, and off-site DR all collapse onto one `BackupTarget` S3 abstraction — one mental model, not three subsystems. Garage beats MinIO/Ceph/SeaweedFS for swarmy's actual topology (small, geo-spread, heterogeneous nodes) and is one binary. restic's encrypt-at-source is decisive for pushing backups off-site over the mesh to an untrusted target. Vanilla `local` volumes remain the default; backup/restore works on them with zero new infra, and opt-in Swarm CSI cluster volumes (we orchestrate existing plugins, don't write one) add availability on top.

## LICENSE — FSL-1.1, SPDX id `FSL-1.1-ALv2`.

**Decision:** **Functional Source License 1.1 with Apache-2.0 future grant**, declared under the registered SPDX id **`FSL-1.1-ALv2`** (not the made-up `FSL-1.1-Apache-2.0`, which breaks GitHub detection and scanners).

**Rationale:** FSL maps 1:1 onto the monetization spec — commercial self-host and client work are allowed, the Competing Use clause blocks others from selling "managed swarmy," and the fixed 2-year auto-conversion to Apache-2.0 satisfies "eventually becomes true OSS." It's BSL with the foot-guns removed (no hand-drafted Additional Use Grant, fixed clock), and avoids SSPL's reputational baggage and Elastic v2's never-converts problem. Describe the project publicly as "Fair Source"; license it under FSL. Reserve `ee/` paths under a non-converting Elastic-v2-style license + runtime key gate for enterprise features, and use a DCO (not a full CLA) for contributions.

## Biggest risks / where this could go wrong

1. **Privileged-everywhere attack surface.** A mesh client (NET_ADMIN/SYS_ADMIN), buildkit (arbitrary repo code exec), node-shell, and direct-Postgres routes all run on customer nodes. A compromised controller could weaponize any of them. Mitigate hard: every privileged path off-by-default behind an explicit agent flag, TTL'd, audited, and — open question worth funding — an agent-side independent second factor so the controller alone can't silently root a box.
2. **`curl | sh` + bootstrapping trust.** The headline install path is the thing security-conscious orgs forbid and the thing most likely to silently break (CDN swap, Docker's transitive `get.docker.com` pipe, multi-NIC swarm advertise-addr ambiguity). The two-stage checksum-pinned loader + `.deb`/`.rpm` + cosign signatures must not slip past P1/P2 — and the e2e test must exercise the real one-liner, not a mock.
3. **Stateful-service sprawl undermining "zero-config."** Registry, ClickHouse, Redis (certs), Garage, managed Postgres are each "one more swarm service" — but together they're an ops burden and a pile of SPOFs/data-loss risks on single-node hobby setups. Discipline required: each stays behind an enable toggle, each is either rebuildable-from-source-of-truth or backed up by the volumes-DR spine, and we never make the default install depend on any of them.
4. **The soft dependency cycle (data-store ↔ volumes-DR ↔ observability) stalling foundations.** Controller-backup needs the restic primitive; ClickHouse needs volumes; both sit "above" the foundation. If we sequence these wrong, P0/P1 deadlocks. Mitigation is in the roadmap: ship the restic+`BackupTarget`+`SWARMY_SECRET_KEY` primitive as the *first slice* of volumes-DR in P1, before anything consumes it.
5. **Scope gravity pulling effort to the long tail before the promise lands.** geo-dns, public API/Terraform, full observability, and a polished compose round-trip are all seductive and all P2/P3. The single biggest failure mode is shipping breadth before the P1 demo (one-command → cross-cloud → live HTTPS) is genuinely flawless. Protect P1; resist `ServiceSpec` minutiae and provider pluralism until the default path is undeniable.
