# Design: managed database topology at the stack level

> **Superseded (2026-07).** The managed-DB plane is implemented well beyond
> this design — Postgres-only engines via bitnami streaming replication (not
> Patroni/Stolon), automatic promote, PITR, geo topologies — see
> `packages/trpc/src/services/manageddb.service.ts` +
> `apps/api/src/workers/manageddb-reconcile.ts` and
> `docs/product/managed-data.md`. Kept for `swarmy.db.*` label-schema history.

Status: future / design-only (roadmap #8). No code. This anchors how swarmy will
let an operator declare a managed datastore — Postgres, MySQL, Redis — as part of a
stack, and have swarmy provision, wire, and keep it healthy. It builds on the
redesign's core invariant: **Docker is the source of truth, config lives in labels,
and a reconciler reads live topology from the in-memory hub.** There is no swarmy
DB row for any of this.

## The shift this inherits

`scaleService` / `setScaleToZero` / `wakeService` already prove the shape: desired
state is a set of `swarmy.*` labels on the service, the controller writes them via
the `service.updateLabels` dispatch (`{ service, add, removeKeys }`), and everything
is read back by `buildInventory(ctx.hub.liveInventory(orgId))`. A managed DB is the
same trick applied to a *group* of services that together form one logical cluster,
plus a small reconciler that keeps the group matching its declaration. We do **not**
reinvent consensus — we encode topology + placement + connection wiring, and delegate
election/failover to the proven engine (Patroni/Stolon for Postgres, group replication
for MySQL, Sentinel for Redis), exactly as `geo-dns-multiregion-ha-templates.md` lands.

## Declaring topology — `swarmy.db.*` labels (Docker truth)

A cluster is declared by labels on its **anchor service** (the primary), all within a
stack (`com.docker.stack.namespace`). A "cluster" is a sub-namespace inside the stack,
keyed by `swarmy.db.cluster`, the same way a stack is a sub-namespace of the org.

```
swarmy.db.cluster      = main            # logical cluster name (unique within stack)
swarmy.db.engine       = postgres        # postgres | mysql | redis
swarmy.db.topology     = primary-replica # primary-replica | multi-primary
swarmy.db.replicas     = 2               # desired READ replicas (primary-replica)
swarmy.db.primaries    = 3               # write members (multi-primary only)
swarmy.db.version      = 16              # image tag the reconciler pins
swarmy.db.storage      = 20Gi            # volume size per member
swarmy.db.region.home  = eu-west         # where the primary is pinned (geo)
swarmy.db.replicas.us-east = 1           # per-region read replicas (optional, geo)
```

WHY anchor on labels: the **exact same stack runs under plain `docker stack deploy`**
with these labels as inert metadata — swarmy adds reconciliation and wiring on top but
is never required for the stack to exist. That's the unopinionated guarantee.

App services in the same stack opt into a connection by labelling themselves:

```
swarmy.db.inject       = main            # which cluster to wire me to
swarmy.db.inject.var   = DATABASE_URL    # env var name (default DATABASE_URL)
```

## Provision + wire

A `db-reconcile` worker (mirrors the scale-to-zero sleeper in
`apps/api/src/workers/index.ts`) loops per org: read `ctx.hub.liveInventory(orgId)`,
`buildInventory`, group services by stack, find anchors carrying `swarmy.db.cluster`,
compute the **desired** member set from the labels, diff against live, and dispatch
Docker-direct via `resolveManagerNode(ctx)`. Steps for `engine=postgres`,
`topology=primary-replica`, `replicas=2`:

1. **Network.** Ensure an attachable overlay `<stack>_<cluster>-net` joining all
   members + any app service with `swarmy.db.inject=<cluster>`. (The inventory's
   existing network-edge inference then auto-draws app↔db links on the canvas — free.)
2. **Members.** `service.deploy` (idempotent create+update) one primary + N replica
   services, each stamped `swarmy.db.role = primary|replica`, `swarmy.db.cluster`,
   `swarmy.managed=true`, plus `placement.constraints`/`preferences` for anti-affinity
   (spread by node; pin by `swarmy.region` when geo labels are present).
3. **Stable endpoints.** Deploy a thin proxy member `swarmy.db.role=proxy` that always
   points at the elected primary, published on two network aliases:
   `<cluster>-rw` (writes → current primary) and `<cluster>-ro`
   (reads → replicas, primary as fallback). WHY a proxy alias rather than re-aliasing
   the primary on every failover: the **app's connection target never changes** — only
   the proxy's upstream does — so no app redeploy on promotion.
4. **Inject.** For each app service labelled `swarmy.db.inject=<cluster>`, the
   reconciler patches its env via `service.deploy` (env is spec, not a label) with a
   computed, stable connection string:
   `DATABASE_URL = postgres://app:${secret}@<stack>_<cluster>-rw:5432/app` and an
   optional `DATABASE_URL_RO` → `<cluster>-ro`. Secrets ride Docker secrets, never
   labels. The hostname is a Docker DNS name, so it survives failover unchanged.

`multi-primary` differs only in shape: `primaries=N` write members behind a load
balancing `-rw` alias, the engine handling write conflict/quorum (MySQL group
replication / Postgres+BDR-style). Same labels, same reconcile loop.

## Failover / promotion sketch

swarmy provisions the cluster's own election substrate (a 3-member DCS — etcd for
Patroni, or Stolon's store) one-per-failure-domain with anti-affinity, then **observes**
rather than decides. The engine elects; the proxy follows. swarmy's reconciler reflects
the observed leader back as a *status* label on the cluster anchor via
`service.updateLabels` — `swarmy.db.leader = <task-id>`, `swarmy.db.lag.<replica> = <ms>`
— so leader, replica health, and replication lag all surface through `buildInventory`
into the canvas and detail sheet with no new read path. swarmy's active jobs are narrow:
keep the member count at desired (re-`service.deploy` a replacement when one dies),
keep anti-affinity, and surface state. Cross-engine promotion logic stays in the engine
where it's correct. RPO/RTO is documented per engine; we do **not** oversell zero data
loss (async streaming has a loss window — same honesty as the geo epic).

## Composition

**Scale-to-zero — DBs must never sleep.** Any service carrying `swarmy.db.role`
(primary/replica/proxy/dcs) is ineligible for scale-to-zero: the reconciler refuses to
write `swarmy.scaleToZero.enabled` on it, and the sleeper skips it. The healthy pairing
is a stack whose *app* tier sleeps while the DB tier stays warm — wake-on-request scales
the app back up (`apps/api/src/activator.ts`), and because the connection endpoint is a
stable alias, the woken app reconnects with zero coordination. The DB was never gone.

**Geo per-region read replicas.** Reuse the geo substrate verbatim: regions are the
`swarmy.region` node label. The primary pins to `swarmy.db.region.home`; each
`swarmy.db.replicas.<region>=N` produces N replicas constrained to
`node.labels.swarmy.region==<region>`. The `-ro` read alias resolves region-local first
(Swarm prefers local tasks; or a per-region read alias `<cluster>-ro-<region>` for
strict locality), so an app in `us-east` reads from a nearby replica while writes still
cross to the home-region primary over the cluster overlay. Cross-region promotion is
guarded/manual (the async-loss window is real); DNS/mesh failover (geo epic) biases new
clients but is not relied on for in-flight data correctness.

## Net new surface (when built)

- `swarmy.db.*` label constants in `packages/core/src/inventory.ts` (next to
  `SCALE_TO_ZERO_*`), and a `DbCluster` view derived in `buildInventory` (members,
  leader, lag, endpoints) — read-only, no DB.
- A `db-reconcile` worker + a `db.service.ts` in trpc dispatching only the existing
  `service.deploy` / `service.updateLabels` / `service.scale` commands — no new agent
  command needed for the MVP (provision = deploy; promote = observed; status = labels).
- Engine bundles (`postgres`/`mysql`/`redis`) live alongside `@swarmy/templates`,
  rendering the member `ServiceSpec`s + a portable `composeSource`.
