---
name: managed-data-services
description: Invariants, label schemes, and file map for swarmy's managed data plane — Postgres clusters (swarmy.db.*), caches (swarmy.cache.*), search (swarmy.search.*), vectors (swarmy.vector.* + in-place pgvector), and Garage object-storage buckets. Load before touching packages/trpc/src/routers/{manageddb,cache,search,vector,buckets,bucket-rules,storage}.ts, their *.service.ts, the *-reconcile.ts workers, apps/agent/src/handlers/storage.ts, protocol/storage.ts, the StorageCluster model, or the cluster-volume (`volume.list`) path. Product rationale lives in docs/product/managed-data.md.
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
   converges. The ONLY Prisma row in this domain is `StorageCluster` (one per
   org: driver + `replicationFactor` + encrypted `adminTokenRef`). CSI cluster
   volumes are listed live from a manager (`volume.list` → `docker volume ls`);
   there is no table. Reaching for a new model to hold cluster state is the bug — see `skill("docker-native-storage")`.
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
   Prisma. The controller calls it via `container.runOnce` curl dispatched to a
   manager, attached to the `swarmy` overlay (`SWARMY_OVERLAY_NETWORK`) →
   `http://swarmy-garage:3903/v1`, admin token as container ENV — never argv,
   never disk. The store publishes NO ports (`networks` on the render ⇒ agent
   sets `ports: []`). Prisma holds only the `StorageCluster`
   pointer + token ref. A bucket's CORS and lifecycle rules have no admin-API
   endpoint, so they go through Garage's S3 API (`swarmy-garage:3900`) the
   same way: one `container.runOnce` curl on the store overlay, with a URL the
   controller presigned for that single call (platform key `swarmy-presign`,
   granted on the bucket on demand; `bucket-s3-call.ts`). CORS is written one
   rule per origin (Garage v1 joins a rule's origins with commas, which
   browsers reject) and wildcard origins need a v2 engine; lifecycle is only
   Expiration + AbortIncompleteMultipartUpload (what Garage implements), and
   rules set outside swarmy are read and kept on save.
8. **pgvector is enable-in-place, not a new instance.** On an existing managed
   Postgres, exec `CREATE EXTENSION IF NOT EXISTS vector` on the primary and
   stamp `swarmy.vector.pgvector=true`; apps reuse their existing `DATABASE_URL`.
   No separate attach, no second endpoint.
9. **DB-role services must stay warm.** Managed data members carry
   `swarmy.scaleToZero.exempt` so the idle sleeper never scales a primary/replica
   to zero. A new member type keeps the exemption.
10. **Failover never silently loses data.** The worker auto-promotes a replica
    ONLY when `decideFailover` (`@swarmy/core` `manageddb-failover.ts`) says it
    is provably caught up — replay LSN ≥ the primary's last flushed LSN sampled
    on the last healthy tick. Anything else HOLDS: stamp
    `swarmy.db.failover.pending` (target + bytes/seconds behind + reason),
    fire `db-failover-confirm` + a `db.failover.pending` incident, audit
    `db.failover.held`, and wait for `db.confirmFailover`
    (`abacProcedure('data.failover')`) to stamp `swarmy.db.failover.confirm`;
    the worker re-checks that the accepted window still covers the gap. The
    rule applies to `primary-replica`, `failover` and `geo`; `single` and
    `active-active` never promote. Never add a promotion path that skips
    `decideFailover`, and never use seconds-lag as proof. Watermark samples
    are also kept in the controller store (`OperationRun`
    `db.failoverWatermark`, `manageddb-watermark.ts`); after a restart a
    stored sample counts ONLY when taken within the in-memory envelope
    (≤ freshness gap + one tick before this process's first unhealthy
    sighting, same primary) — anything else is unknown ⇒ hold, the safe
    default. Never widen that window. Promotion is `SELECT pg_promote()`; the repoint
    redeploys every other member under a fresh `SWARMY_PG_REJOIN` epoch, and
    the boot layer moves a demoted ex-writer's PGDATA ASIDE
    (`pgdata.diverged-<utc>`) before re-cloning — never deletes it. The
    Postgres page's "Simulate `<region>` outage" imports the SAME
    `decideFailover` and runs it on the copies outside the outage, three ways
    (caught up / one byte behind / no reading), because the dashboard never
    sees LSNs (`components/pgdetail/pg-failover-sim.ts`). Never give the
    dashboard its own copy of the rule. A restore over a live cluster saves it
    first (`skill("backups-dr")` invariant 13).
12. **Official images + swarmy's boot layer, never a vendor repackaging.**
    Managed Postgres runs `pgvector/pgvector:pg17` (official `postgres:17` +
    pgvector) with `@swarmy/core` `manageddb-pg` as the service `command`
    (replication role + pg_hba on first boot, `pg_basebackup` replicas,
    rejoin/aside on failover). Env is the official `POSTGRES_*` +
    `SWARMY_PG_*` (role, replication user/password, primary host/port,
    rejoin). Every member spec goes through `applyPgMember` (storage + boot
    layer) — the live inventory carries no command, so a bare rebuild would
    fall back to the image entrypoint. Caches run `valkey/valkey` / `redis`
    official images with `sh -c` wrappers; sentinels are the engine's own
    `*-sentinel` from the same image. No `bitnami*` image anywhere.
    Every image this domain runs (engines and backup/dump/move helpers) is
    an entry in the BOM's data section (`@swarmy/core` `system-images-data.ts`,
    lookups `data-images.ts`: `dataImage`, `dataImageFor(engine, major)`);
    code names the entry, never a literal ref (`@swarmy/core`
    `data-images.literals.test.ts` greps for one), and the hub decorator deploys
    it at the release's digest, tag kept. A platform upgrade never rolls them.
11. **Cluster volumes register against an EXISTING CSI driver.** swarmy ships no
    storage driver. `register`/`removeVolume` ride `volume.provision`/
    `volume.remove` agent commands with `cluster:true`; restic backups
    (the `backups-dr` domain) layer on top — availability ≠ recoverability.
    There is no tRPC volumes router (removed 2026-09); REST
    `packages/api-rest/src/routes/volumes.ts` keeps the service.
13. **Postgres extensions are a label, converged writer-last.**
    `db.setExtension` (`stack.deploy`, audited `db.extension.enable|disable`)
    only rewrites `swarmy.db.extensions` on the primary. The boot layer writes
    `SWARMY_PG_PRELOAD` as `shared_preload_libraries` on every start, and
    `manageddb-reconcile` takes ONE signature-gated step of the pure
    `planPgExtensions` (`@swarmy/core` `manageddb-extensions-plan.ts`) per
    tick: drop, restart standbys, verify (`SHOW shared_preload_libraries`),
    restart writers in place under `swarmy.db.restart.planned` (holds the
    failover alarm; never a promotion), verify, `CREATE EXTENSION`. Never
    restart a writer before its standbys. The image is probed once for postgis
    (`pgvector/pgvector:pg17` has none) and the view says so.
14. **A rotated search key moves everyone at the same path.**
    `search.rotateKey` (`secret.delete`, as `db.rotatePassword`) mints
    `<family>__v<n>`, redeploys the engine, then each attached app, at the
    unchanged `/run/secrets/<family>` path; old versions go once nothing mounts
    them, and the key is returned once. The instance records the mounted
    version in `swarmy.search.keySecret`: attach mounts that version, detach
    and destroy match every version, and `carryManagedAttachments` takes the
    version the live app mounts. Index reads/edits/queries exec inside the
    engine container with the key on stdin and the query as `$1`, never
    spliced into the script.
15. **History is telemetry, one row per resource per 5 minutes.** Cache
    INFO counters, queue depth/workers and bucket sizes are sampled by their
    reconciles into `telemetry.db` (`CacheStatSample`/`QueueStatSample`/
    `BucketStatSample`, unique per resource × bucket, 7 days, pruned by the
    retention worker); `pg_stat_statements` deltas land in
    `PgQuerySample`/`PgQueryText` via the `pg-slow-queries` worker (5 min,
    an audited system read through the studio's bounded query path). Never
    put history in `control.db` or on a label.
16. **The studio fails closed, and its audit keeps shape, not values.**
    `classifySql` (`@swarmy/core/studio`) re-reads every statement under each
    non-default server string mode (`sql-modes.ts`): several statements under
    any mode → blocked, any other difference → at least a write. A Redis
    command starting with `-` is blocked (redis-cli has no `--`). The agent
    runs the same classifier again. `studio.query` audit rows store
    `redact.ts`'s shape (literals → `?`, ≤ 1000 chars), never the statement.
17. **Postgres memory is a label, applied from the member's own stamp.**
    `db.setMemory` only rewrites `swarmy.db.memoryMb` on the primary.
    `applyPgMember` derives the swarm memory limit and the boot layer's
    `SWARMY_PG_SHARED_BUFFERS` (25%) / `_EFFECTIVE_CACHE_SIZE` (75%) from the
    member's `swarmy.db.memoryMb.applied`, so every rebuild keeps the size the
    copy was last restarted with. The reconcile steps the pure `planPgMemory`
    only once the extensions step is idle (standbys, verify `SHOW
    shared_buffers`, then the writer in place under `swarmy.db.restart.planned`).
    A promotion carries the writer's declarations (`primaryDeclarations`:
    memory + extensions) to the new primary.

## Contracts between the layers

- **Router → service → hub dispatch.** Routers (`orgProcedure`/`adminProcedure`)
  validate with `@swarmy/core` input schemas (`ProvisionCacheInput`,
  `AttachBucketInput`, …) and call the service. Services mutate the swarm via
  `ctx.hub.dispatch(nodeId, cmd, payload)` — `service.deploy`, `network.ensure`,
  `secret.create`/`secret.remove`, and (storage/volumes) `storage.apply`,
  `volume.provision`, `volume.remove` (wire types `applyStorageNode` /
  `provisionVolume` / `removeVolume`), `container.runOnce`. Never hand-roll a wire
  frame — see `skill("agent-handlers")`.
- **Provision result carries the secret once — except Postgres.** `provision*`
  returns `{ …, password|masterKey|apiKey|secretAccessKey }` exactly once; the
  UI shows it in a copy-once panel. `db.provision` returns NO password (only
  `passwordEnv`): a person reads it via `db.revealPassword`
  (`abacProcedure('secrets.read')`, audited `db.password.reveal`); server-side
  callers that need it (blueprint tokens) use `provisionDbWithPassword`. The
  `db.inject` response masks the password in its URLs.
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
| Failover safety rule (`decideFailover`) + pending/confirm label codecs | `packages/core/src/manageddb-failover.ts` (+ `.test.ts`); confirm = `manageddb.service.ts#confirmFailover`; UI `components/stacks/db-failover-confirm.tsx` |
| Planned switchover (`db.switchover` / `db.switchoverRun`: pure plan + refusals, run decisions, `swarmy.db.switchover` request codec, run view; the promotion is the reconcile's own pass, narrowed by `plannedPromotion`) | `packages/core/src/manageddb-switchover{,-run,-view}.ts`, `packages/trpc/src/services/manageddb-switchover{.service,.run,.steps,.runs,.start}.ts` (router `routers/manageddb-switchover.ts`), `apps/api/src/workers/manageddb-switchover.ts` (planned record + stale-pause thaw) |
| Cache: `swarmy.cache.*`, sentinel, maxmemory+headroom, password secret | `packages/trpc/src/services/cache.service.ts`, `apps/api/src/workers/cache-reconcile.ts` |
| Cache when-full + persistence (`swarmy.cache.evictionPolicy|persistence` declared, `.appliedPolicy` per member; CONFIG SET live, stamp only once on disk; queue stores keep noeviction) | `packages/trpc/src/services/cache-policy{,-plan,.service}.ts`, `apps/api/src/workers/cache-policy-reconcile.ts` |
| Search: Meilisearch/Typesense, master-key secret, attach env | `packages/trpc/src/services/search.service.ts`, `apps/api/src/workers/search-reconcile.ts` |
| Vector: Qdrant instance + in-place pgvector enable | `packages/trpc/src/services/vector.service.ts`, `apps/api/src/workers/vector-reconcile.ts` |
| Buckets: Garage admin curl, keys, quotas, attach `S3_*` | `packages/trpc/src/services/buckets.service.ts` (router `routers/buckets.ts`) |
| Garage render (toml/layout/ports) | `packages/trpc/src/services/garage-render.ts` |
| Estate-wide store cluster (StorageCluster) | `packages/trpc/src/services/replicatedStore.service.ts` (router `routers/storage.ts`) |
| Swarm CSI cluster volumes | `packages/trpc/src/services/clusterVolume.service.ts` (REST `packages/api-rest/src/routes/volumes.ts`; no tRPC router) |
| Postgres memory (label codec + 25/75 sizing, rolling-restart plan, `db.setMemory`, converge step) | `packages/core/src/manageddb-memory{,-plan}.ts`, `packages/trpc/src/services/manageddb-memory.service.ts`, `apps/api/src/workers/manageddb-memory.ts` (`memorySpec` in `manageddb-reconcile`) |
| Per-standby replay LSN + lag (`db.replication`: `pg_stat_replication` via the studio's bounded read, origin `replication`) | `packages/core/src/manageddb-replication.ts`, `packages/trpc/src/services/manageddb-replication.service.ts`; UI `components/pgdetail/pg-replication*.ts(x)`; disk per copy `pg-disk.ts` (`nodes.volumeSizes` + live stats) |
| Postgres extensions (label codec, rolling-restart plan, toggle, view, converge step) | `packages/core/src/manageddb-extensions{,-plan}.ts`, `packages/trpc/src/services/manageddb-extensions{.service,-view}.ts`, `apps/api/src/workers/manageddb-extensions.ts` (called from `manageddb-reconcile`) |
| Slow queries (snapshot deltas, 24 h read) | `apps/api/src/workers/pg-slow-queries.ts`, `packages/core/src/studio/slow-queries.ts`, `packages/trpc/src/services/studio-slow.service.ts` (`studio.slowQueries`) |
| Index suggestions (unindexed foreign keys, big tables read start to finish, unused indexes; SQL to copy, never run) | `packages/core/src/studio/index-{facts,advice}.ts` (one JSON-cell statistics read + pure rules), `packages/trpc/src/services/studio-indexes.service.ts` (`studio.indexAdvice`, a `studioViewRead` under origin `indexes`); UI `components/studio/studio-index-tips.tsx` |
| Search indexes, settings, Try it, key rotation | `packages/core/src/search-{indexes,synonyms}.ts`, `packages/trpc/src/services/search-{indexes.core,indexes.parse,indexes.service,index-settings.service,key.service,gate}.ts` |
| Data history (cache hit rate, queue depth/workers, bucket growth) | `packages/core/src/data-history.ts`, `packages/trpc/src/services/data-history-{record,sample,grid}.ts`, `{cache,queue,bucket}-history.ts`; models in `packages/db/prisma/telemetry/schema.prisma` |
| Bucket CORS + lifecycle (S3 API one-shots) and the public S3 endpoint | `packages/core/src/bucket-{cors,lifecycle}.ts`, `packages/trpc/src/services/bucket-{cors,lifecycle}{.service,-xml}.ts`, `bucket-s3-call.ts`, `s3-xml.ts`, `public-s3.ts` (`S3_PUBLIC_ENDPOINT`, `presignTarget`), router `routers/bucket-rules.ts` |
| Restore as a copy (a new `<cluster>-restore-<mmdd>`) | `packages/core/src/db-restore-copy.ts`, `packages/trpc/src/services/dbRestoreCopy{.service,.into,.placement}.ts` (`skill("backups-dr")`) |
| Database studio: classifier, string modes, audit shape | `packages/core/src/studio/{classify,sql-lex,sql-modes,redact}.ts`, `packages/trpc/src/services/studio.service.ts`, agent `apps/agent/src/handlers/studio.ts` |
| Agent: applyStorageNode, provisionVolume, removeVolume | `apps/agent/src/handlers/storage.ts` |
| Storage/volume protocol messages | `packages/core/src/protocol/storage.ts` |
| Input schemas + engine/topology enums | `packages/core/src/inputs.ts`, `packages/core/src/views.ts` |
| StorageCluster model | `packages/db/prisma/schema/backups.prisma` |
| Cluster volumes (live `volume.list`, no table) | `packages/trpc/src/services/clusterVolume.service.ts` |
| Data surfaces | per stack: `apps/app/src/routes/_authed/stacks/$name.data.index.tsx` → `components/stack-data/data-tab-page.tsx` (Postgres HA choices `pg-ha-section.tsx`, `pg-choices.ts`), cache/search as blocks (`components/cache/{cache-section,cache-block,cache-settings,cache-words}.ts(x)`, `components/searchsvc/{search-section,search-block}.tsx`: the shape, "If `<server>` dies", what swarmy fixes), `components/vector/*`; buckets: `routes/_authed/data_.buckets.tsx` |
| Postgres per-database page (a layout that morphs with the mode, `db.setTopology`; where copies run; the switch-over rule simulated; connect + rotate password; pgvector) | `routes/_authed/stacks/$name.data.$cluster.tsx` → `components/pgdetail/*` (`pg-topology.ts`, `pg-failover-sim.ts`; `pg-detail.test.ts`) |
| Data by app (`/data`): each app's stores, who can reach each bucket, drag a bucket onto an app (attach preview, Undo) | `routes/_authed/data.tsx` → `components/data/*` (`data-board-model.ts`), attach plan `components/buckets/attach-plan.ts` (mirrors `ATTACH_ENV_KEYS`) |
| Bucket page: reach rings (Internal ⊂ Private network ⊂ Public), size, copies, who uses it, keys shown once, the delete rule | `routes/_authed/data_.buckets_.$name.tsx` → `components/buckets/bucket-page.tsx` (+ `reach-model.ts`, `bucket-facts.ts`); reach is `services/bucket-access.service.ts` (`buckets.setAccess`, admin-only, enforced at the edge; going Public needs the bucket name typed back, `bucket-public-confirm.ts`, except the swarmy.yaml apply); growth forecast `bucket-growth-model.ts` + `linear-fit.ts` |
| Postgres boot layer (entrypoint script, env contract, `applyPgBoot`) | `packages/core/src/manageddb-pg.ts` (+ `.test.ts`) |

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
   `garage-render.test.ts`, `manageddb-reconcile.test.ts`,
   `manageddb-failover.test.ts` in core + trpc).

## Operational gotchas

- The DB password is a Docker SECRET like every other credential:
  `<stack>_<cluster>-pg-password__v<n>` mounted at `/run/secrets/<family>`,
  named by the members' `swarmy.db.passwordSecret` label. Specs carry only
  `POSTGRES_PASSWORD_FILE` + `SWARMY_PG_REPLICATION_PASSWORD_FILE`; every
  member spec goes through `applyPgMember` → `applyPgCredential` (mounts the
  secret at the family path, strips plaintext env). Apps wired by `db.inject`
  get `DATABASE_URL`/`_RO_URL` as `-pg-url`/`-pg-ro-url` secrets delivered by
  the secret-env shim. The controller reads the value only via `exec cat` in a
  running member (`readDbPassword`); backup sidecars/one-shots get a 0600
  PGPASSFILE via `putArchive`, never env. `db.rotatePassword` mints v(n+1),
  ALTERs the roles from the new file over the local socket, then moves
  members + apps. The reconcile migrates legacy plain-env clusters
  (`migrateDbCredentials`, never restarting a writer off a persistent volume).
- The data volume mounts at `/var/lib/postgresql/data` (the image's VOLUME —
  mounting anywhere else leaves an anonymous volume on top) and PGDATA is its
  `pgdata/` subdirectory. PG18 moved the official layout, so bumping the major
  past 17 means revisiting `MANAGED_PG_ROOT`.
- Swarm memory limit for a cache = declared maxmemory + 64 MB headroom
  (`memoryLimitBytes`) so the engine isn't OOM-killed at its own cap; the
  reconcile worker treats an `appliedMemoryMb` label mismatch as drift.
- Bucket delete is refused while objects or attachments remain; `createKey`
  returns the secret access key once — there is no "reveal key" path by design.
- Garage admin calls run via a manager as overlay one-shots (never host network,
  never an agent-process `fetch` — a systemd agent can't resolve overlay names);
  never publish the admin port. `storeNeedsConverge` redeploys a store that is
  off the overlay or publishes ports. Multi-member RPC (3901) is bootstrapped
  best-effort by storage-reconcile (`tasks.swarmy-garage` probe + `/v1/connect`).
