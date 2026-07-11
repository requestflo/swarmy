---
name: managed-data-services
description: Invariants, label schemes, and file map for swarmy's managed data plane — Postgres clusters (swarmy.db.*), caches (swarmy.cache.*), search (swarmy.search.*), vectors (swarmy.vector.* + in-place pgvector), and Garage object-storage buckets. Load before touching packages/trpc/src/routers/{manageddb,cache,search,vector,buckets,storage,volumes}.ts, their *.service.ts, the *-reconcile.ts workers, apps/agent/src/handlers/storage.ts, protocol/storage.ts, or the StorageCluster/ClusterVolume models. Product rationale lives in docs/product/managed-data.md.
---

# Managed data services: declare on labels, reconcile, attach by env

Read `docs/product/managed-data.md` for WHY managed data is provisioned + wired
automatically and why credentials are shown once. This skill is the HOW: the
invariants every change must keep, and where everything lives. For the whole
db→protocol→service→router→UI shape see `skill("add-feature-slice")`; for where
state belongs see `skill("docker-native-storage")`.

## Invariants (violating any of these is a bug, not a style choice)

1. **A cluster IS its labels — never a Prisma row.** Postgres uses
   `swarmy.db.*`, cache `swarmy.cache.*`, search `swarmy.search.*`, vector
   `swarmy.vector.*` on the swarm services. The view is read off labels every
   time; scaling/topology/memory rewrites a label and a reconcile worker
   converges. The ONLY Prisma rows in this domain are `StorageCluster` (one per
   org: driver + `replicationFactor` + encrypted `adminTokenRef`) and
   `ClusterVolume` (CSI registration). Reaching for a new model to hold cluster
   state is the bug — see `skill("docker-native-storage")`.
2. **Secrets live in Docker secrets, shown exactly once.** Generated DB
   passwords, cache passwords, search master keys, vector API keys, and bucket
   secret-access-keys are returned once in the mutation result and thereafter
   only mounted as a FILE (`/run/secrets/…`). Never persist a plaintext
   credential in the DB; never add a query that re-lists a secret.
3. **Managed data is private-only.** No published ports on any managed service —
   apps reach them over a per-cluster attachable overlay network by swarm DNS. A
   published port on managed data is an exposure violation surfaced elsewhere,
   never something you add here.
4. **Endpoints are swarm DNS, not a proxy.** Postgres RW host =
   `<stack>_<cluster>-primary`; RO host = `<stack>_<cluster>-replica` (DNS
   round-robins replica tasks). Cache/search/vector = the service name on the
   cluster network. Do not add a Pgpool/HAProxy rw/ro proxy in the base slice.
5. **Wiring is env injection + a secret file + a network + inject labels, then a
   redeploy.** `injectConnection`/`attachTo…` merge the connection env
   (`DATABASE_URL`+`DATABASE_RO_URL`, `REDIS_URL`+`REDIS_PASSWORD_FILE`,
   `MEILI_HOST`/`TYPESENSE_HOST`+`*_API_KEY_FILE`, `QDRANT_URL`+`*_API_KEY_FILE`,
   `S3_*`), mount the secret file, join the cluster network, stamp
   `swarmy.<domain>.inject`/`.inject.var` labels, and re-`service.deploy` the app
   (env changes need a redeploy). Detach removes exactly those keys and labels.
6. **Reconcile is per-domain, declared→actual, and idempotent.** The
   `{manageddb,cache,search,vector}-reconcile` workers read declared labels vs
   live tasks each tick, converge replicas/memory/topology, and stamp observed
   state back as `swarmy.<domain>.stats`. Keep pure convergence logic in a
   `.core` module (`manageddb-reconcile.core.ts`) — the same discipline as the
   DNS worker in `skill("geo-edge-routing")`.
7. **Object-storage state is Garage's, reached by one-shot curl.** Every bucket,
   key, quota, and grant lives in the Garage admin API (source of truth), NOT in
   Prisma. The controller calls it via `container.runOnce` curl on a storage
   member node (host network → `127.0.0.1:${GARAGE_ADMIN_PORT}`), admin token as
   container ENV — never argv, never disk. Prisma holds only the `StorageCluster`
   pointer + token ref.
8. **pgvector is enable-in-place, not a new instance.** On an existing managed
   Postgres, exec `CREATE EXTENSION IF NOT EXISTS vector` on the primary and
   stamp `swarmy.vector.pgvector=true`; apps reuse their existing `DATABASE_URL`.
   No separate attach, no second endpoint.
9. **DB-role services must stay warm.** Managed data members carry
   `swarmy.scaleToZero.exempt` so the idle sleeper never scales a primary/replica
   to zero. A new member type keeps the exemption.
10. **Cluster volumes register against an EXISTING CSI driver.** swarmy ships no
    storage driver. `register`/`removeVolume` ride `volume.provision`/
    `volume.remove` agent commands with `cluster:true`; restic backups
    (the `backups-dr` domain) layer on top — availability ≠ recoverability.

## Contracts between the layers

- **Router → service → hub dispatch.** Routers (`orgProcedure`/`adminProcedure`)
  validate with `@swarmy/core` input schemas (`ProvisionCacheInput`,
  `AttachBucketInput`, …) and call the service. Services mutate the swarm via
  `ctx.hub.dispatch(nodeId, cmd, payload)` — `service.deploy`, `network.ensure`,
  `secret.create`/`secret.remove`, and (storage/volumes) `applyStorageNode`,
  `provisionVolume`, `removeVolume`, `container.runOnce`. Never hand-roll a wire
  frame — see `skill("agent-handlers")`.
- **Provision result carries the secret once.** `provision*` returns
  `{ …, password|masterKey|apiKey|secretAccessKey }` exactly once; the router
  comment says so and the UI shows it in a copy-once panel.
- **Garage render is pure.** `renderGarageDeployment(input)` →
  `RenderedStoreDeployment` (toml + volumes + GLOBAL placement under the
  `swarmy-system` stack); the agent's `applyStorageNode` applies it. Ports:
  S3 `3900`, RPC `3901`, admin `3903`; region `swarmy`; a member per node, each
  its own Garage zone.
- **Attach env is owned + reversible.** Each domain exports its env keys
  (buckets: `ATTACH_ENV_KEYS`) so detach removes precisely what attach added.

## File map

| Concern | Where |
|---|---|
| Postgres: topologies, primary/replica names, injectConnection, region replicas | `packages/trpc/src/services/manageddb.service.ts` (router `routers/manageddb.ts`) |
| Postgres reconcile (failover/lag/PITR) + pure core | `apps/api/src/workers/manageddb-reconcile.ts`, `…-reconcile.core.ts` |
| Cache: `swarmy.cache.*`, sentinel, maxmemory+headroom, password secret | `packages/trpc/src/services/cache.service.ts`, `apps/api/src/workers/cache-reconcile.ts` |
| Search: Meilisearch/Typesense, master-key secret, attach env | `packages/trpc/src/services/search.service.ts`, `apps/api/src/workers/search-reconcile.ts` |
| Vector: Qdrant instance + in-place pgvector enable | `packages/trpc/src/services/vector.service.ts`, `apps/api/src/workers/vector-reconcile.ts` |
| Buckets: Garage admin curl, keys, quotas, attach `S3_*` | `packages/trpc/src/services/buckets.service.ts` (router `routers/buckets.ts`) |
| Garage render (toml/layout/ports) | `packages/trpc/src/services/garage-render.ts` |
| Estate-wide store cluster (StorageCluster) | `packages/trpc/src/services/replicatedStore.service.ts` (router `routers/storage.ts`) |
| Swarm CSI cluster volumes | `packages/trpc/src/services/clusterVolume.service.ts` (router `routers/volumes.ts`) |
| Agent: applyStorageNode, provisionVolume, removeVolume | `apps/agent/src/handlers/storage.ts` |
| Storage/volume protocol messages | `packages/core/src/protocol/storage.ts` |
| Input schemas + engine/topology enums | `packages/core/src/inputs.ts`, `packages/core/src/views.ts` |
| StorageCluster / ClusterVolume models | `packages/db/prisma/schema/backups.prisma` |
| Data surfaces (DB/cache/search/vector/buckets) | `apps/app/src/routes/_authed/data*.tsx` |

## Adding a managed-data type (the recipe)

1. **Labels first.** Define `swarmy.<domain>.*` label keys (engine, replicas,
   topology, `.inject`/`.inject.var`, `.stats`) in the service module. The
   cluster's identity is these labels — no Prisma model.
2. **Service.** `provision*` generates the credential → `secret.create`, ensures
   the per-cluster network (`network.ensure`), deploys members
   (`service.deploy`) with the labels; returns the secret ONCE.
3. **Attach.** Merge connection env + secret-file var, join the app to the
   cluster network, stamp inject labels, redeploy. Export the env-key list so
   detach is exact.
4. **Reconcile worker.** Read declared vs live each tick, converge, stamp
   `swarmy.<domain>.stats`. Keep pure logic in a `.core` module with tests.
5. **Router + UI.** `orgProcedure` (mutations that touch the whole store =
   `adminProcedure`), a `data_.<domain>.tsx` route in Hot Signal
   (`skill("hot-signal-design")`).
6. **Verify:** `bun --filter @swarmy/trpc typecheck` and the service tests
   (`{cache,search,vector,buckets,manageddb}.service.test.ts`,
   `garage-render.test.ts`, `manageddb-reconcile.test.ts`).

## Operational gotchas

- The DB password is the one env exception: bitnami reads `POSTGRESQL_PASSWORD`
  from env, so a managed Postgres primary carries it as env (documented tradeoff)
  while cache/search/vector keep the credential in a mounted secret file only.
- Swarm memory limit for a cache = declared maxmemory + 64 MB headroom
  (`memoryLimitBytes`) so the engine isn't OOM-killed at its own cap; the
  reconcile worker treats an `appliedMemoryMb` label mismatch as drift.
- Bucket delete is refused while objects or attachments remain; `createKey`
  returns the secret access key once — there is no "reveal key" path by design.
- Garage admin calls prefer an ONLINE store member (the admin port is published
  on host network there) and fall back to a manager; never expose the admin port
  publicly — same node-local-admin bearer discipline as `skill("geo-edge-routing")`.
