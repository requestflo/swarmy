# Managed data — "databases, caches, search, vectors & buckets, wired automatically"

**Status: canonical product design (2026-07). Pairs with the
`managed-data-services` skill for the how.**

## The feeling we are building

Someone building an app on swarmy should be able to give it a Postgres, a cache,
a search index, a vector store, and an S3 bucket without ever touching a
connection string, a password, or a `docker service create`. They open the stack
they're operating and click **Data**.

1. They declare a database cluster — a name, `read-replicas: 2`, **Provision** —
   and watch swarmy stand up `storefront_checkout-primary` and
   `storefront_checkout-replica` on the swarm, wired for streaming replication,
   with a live RW and RO endpoint. "Provisioned + wired automatically."
2. They pick a service and hit **Attach**. The app redeploys with a
   `DATABASE_URL` pointing at the primary and a `DATABASE_RO_URL` at the
   replicas — no string typed, no password seen.
3. They add a cache: Valkey, `sentinel` topology, 512 MB. "Private by default ·
   password in a Docker secret." The password is generated, shown **once**, and
   after that lives only in a Docker secret the app reads as a file.
4. Search (Meilisearch), a vector store (Qdrant) — or, on a Postgres cluster
   they already have, **Enable pgvector** in place, and the apps that already
   hold that `DATABASE_URL` can query embeddings with no second endpoint.
5. Under **Data → Buckets**: "62.0 GB in 3 buckets." S3-compatible object
   storage on their own nodes. They create a bucket, mint an access key — "shown
   once at creation, never again" — and wire an app with one click.

No managed-database vendor. No connection string in a `.env`. No password in a
git repo. It should feel like the data service *introduced itself* to the app —
because swarmy declared the topology on Docker, put the secret in a Docker
secret, and injected the wiring by env.

## How it works (declare → reconcile → attach)

```
dashboard: stack → Data                         one form: name + replicas + Provision
   │  ① provision → stamp swarmy.db.* / cache.* / search.* / vector.* LABELS
   │     on the swarm services; generate password/key → Docker SECRET (once)
   ▼
Docker Swarm services (bitnami/valkey/meili/qdrant/garage) = the real workload
   │  ② reconcile worker (per domain, ~tick) reads declared labels vs live tasks,
   │     converges replicas/memory/topology, stamps swarmy.*.stats back on labels
   ▼
attach an app service                           injectConnection / attachTo…
   │  ③ merge env (DATABASE_URL / REDIS_URL / MEILI_HOST / QDRANT_URL / S3_*),
   │     mount the secret as a FILE, join the cluster network, stamp
   │     swarmy.<domain>.inject labels → re-deploy the app service
   ▼
app runs, wired — swarmy can vanish and the cluster + app keep talking
```

Four ideas, one story:

- **Topology is declared on Docker, not in a database.** A cluster *is* its
  `swarmy.db.*` / `swarmy.cache.*` / `swarmy.search.*` / `swarmy.vector.*`
  service labels. There is no per-cluster Prisma row. The view is read off the
  labels every time; scaling replicas or changing maxmemory rewrites a label and
  the reconcile worker makes it so. See the `docker-native-storage` skill.
- **Secrets live in Docker secrets, and you see them once.** Generated
  passwords, master keys, API keys, and bucket secret-access-keys are minted,
  returned exactly once at creation, and thereafter mounted into the workload as
  a file (`/run/secrets/…`) — never re-listed, never stored in swarmy's DB.
- **Wiring is env injection, and it survives swarmy.** `injectConnection` /
  `attachToService` merge the connection env, mount the secret file, join the
  app to the cluster's overlay network, and re-deploy. The env is on the Docker
  service; the app keeps its `DATABASE_URL` whether or not swarmy is up.
- **pgvector is a capability, not a new box.** Enabling vectors on an existing
  managed Postgres runs `CREATE EXTENSION IF NOT EXISTS vector` on the primary
  and stamps `swarmy.vector.pgvector=true`. Apps reuse the `DATABASE_URL` they
  already have — the cheapest possible vector store.

## Roles and where truth lives

- **Cluster topology is Docker truth.** Which cluster exists, its engine, its
  role split, its replica count, its declared memory — all `swarmy.db.*` /
  `swarmy.cache.*` / `swarmy.search.*` / `swarmy.vector.*` service labels read
  live off the swarm. The reconcile workers stamp observed state back as
  `swarmy.<domain>.stats` labels. No DB column shadows any of it.
- **Endpoints are swarm DNS, not a proxy.** A managed Postgres cluster's RW host
  is its `-primary` service name; its RO host is the `-replica` service name and
  swarm DNS round-robins across replica tasks. Caches/search/vector are reached
  at their service name on the cluster's private overlay. No Pgpool/HAProxy in
  the first slice — swarm DNS does the work.
- **Secrets are Docker secrets.** Passwords and keys live in Docker secrets
  (`swarmy-search-<stack>_<name>-key`, cache password secret, per-attach bucket
  key secret), mounted as files. The `REDIS_URL` gets a `REDIS_PASSWORD_FILE`
  companion; the DB password is the one env exception bitnami forces
  (`POSTGRESQL_PASSWORD`), a documented tradeoff.
- **Bucket/key state is Garage's, not ours.** For object storage the Garage
  admin API is the source of truth for every bucket, key, quota, and grant.
  swarmy reaches it by running a one-shot `container.runOnce` curl on a storage
  member node (host network → `127.0.0.1:3903`, token as container env, never
  argv, never disk).
- **What the DB owns is only swarmy's own pointers and access records.** The
  `StorageCluster` row (one per org: driver, `replicationFactor`, `enabled`,
  encrypted `adminTokenRef`) and the `ClusterVolume` row (CSI registration) —
  swarmy's identity/handle for the estate-wide store, not the data. Backup
  catalog rows (`Snapshot`, `BackupTarget`) belong to the `backups-dr` domain.
  See the `docker-native-storage` skill.

## Managed-data behaviour (what the promise commits us to)

- **One provision form per data type, and swarmy fills the rest.** Postgres
  clusters ship topologies `single`, `primary-replica` (default), `failover`
  (adds an etcd consensus member), `geo` (write-region primary + per-region read
  replicas via `swarmy.db.region.<region>.replicas`), and `active-active`.
  Caches ship `single` / `replica` / `sentinel` (primary + replicas + 3 sentinel
  members, quorum 2). Search is single-node Meilisearch or Typesense; vectors
  are Qdrant or in-place pgvector.
- **Private by default; managed data never faces the internet.** No published
  ports on any managed cluster — apps reach them over the cluster's overlay. A
  published port on a managed service is an *exposure violation* swarmy alerts on
  (it never rips the port out itself; the fix is yours — see the exposure
  surface).
- **Attach and detach are symmetric.** Attach stamps env + secret + network +
  `swarmy.<domain>.inject` labels and redeploys; detach removes exactly those
  keys (`ATTACH_ENV_KEYS`) and the inject labels, and redeploys. Env changes
  require a redeploy, so both go through `service.deploy`.
- **Secrets are shown once, by design.** Provision returns the generated
  credential in the mutation result and never again; the buckets page says it
  out loud ("Secrets are shown once at creation, never again"). Losing it means
  rotating or re-provisioning, not recovering.
- **Object storage is Garage on your nodes.** `swarmy-garage` is a swarm-native
  S3 endpoint (`swarmy-garage:3900`, region `swarmy`), one member per selected
  node, each in its own Garage zone so replication (default factor 3) spreads
  across machines. It's grouped under the `swarmy-system` stack — platform
  plumbing, not a tenant app. Node replacement and resync now converge
  automatically via the `storage-reconcile` worker (member discovery, two-step
  layout stage+apply, partition-sync progress surfaced on the cluster status).
- **DR is layered, not assumed.** Cluster volumes register against an *existing*
  CSI plugin (swarmy ships no driver) so swarm republishes the volume on
  reschedule — live failover. restic backups still layer on top: availability is
  not recoverability. The backup/restore/drill story lives in the `backups-dr`
  domain.

## Failure modes (designed, not accidental)

| Failure | Behaviour |
|---|---|
| Controller down while apps run | Clusters and apps keep talking — topology is on Docker, wiring is on the app's service env. Reconcile resumes converging when the controller returns. |
| Declared replicas ≠ live tasks | The per-domain reconcile worker converges each tick (scales members, applies memory, re-stamps `swarmy.*.stats`); a transient scheduling gap self-heals. |
| Credential lost (shown once) | Not recoverable by design — rotate the secret / re-provision. swarmy never stored the plaintext, so there is nothing to leak or hand back. |
| App attached, DB not yet healthy | The app holds a valid `DATABASE_URL`; swarm DNS resolves the primary once its task is up. No wiring rewrite is needed when the DB comes healthy. |
| Managed cluster gets a published port | Surfaced as an exposure violation and alerted; swarmy never removes the port itself (v1) — the operator fixes it. Private-by-design is enforced by advice, not force. |
| Bucket delete with objects/attachments | Refused. Delete is blocked while the bucket holds objects or is attached to a service — no silent data loss. |
| Garage member node offline | S3 stays served from surviving members (replication factor ≥ 2); admin calls prefer an online member and fall back to a manager. |

## Explicitly rejected

- **A Prisma model per cluster.** A row mirroring replica count / memory / engine
  drifts from the swarm the instant Docker reschedules. Topology is labels; the
  view is derived. See the `docker-native-storage` skill.
- **Storing passwords or keys in swarmy's DB.** Every credential is a Docker
  secret mounted as a file and shown once. swarmy's DB holds pointers
  (`adminTokenRef`, encrypted) and access records, never data-plane secrets in
  plaintext.
- **A managed rw/ro proxy (Pgpool/HAProxy) in the first slice.** Swarm DNS gives
  a single-writer primary host and a round-robining replica host for free; a
  proxy is added weight for the split we already get.
- **Automatic failover/promotion on day one.** Provision + scale + inject +
  health now; promotion needs a DCS and a promote command. The `failover`
  topology adds the etcd consensus member as the deliberate next step, not a
  hidden default.
- **Shipping our own CSI driver.** Cluster volumes register against an operator's
  *existing* CSI plugin. swarmy orchestrates the registration and mount; it does
  not become a storage driver vendor.
- **A separate vector database when Postgres will do.** pgvector enables in place
  and reuses the app's existing `DATABASE_URL`. A standalone Qdrant is there when
  you want it, not imposed when you don't.
- **Public-by-default anything.** Managed data is private-only; buckets default
  private and go public only on an explicit website flag.

## Implementation map

The invariants, label schemes, and file map live in the `managed-data-services`
skill (`.claude/skills/managed-data-services/SKILL.md`) — how a cluster is
declared, reconciled, and attached. Key homes: the per-domain routers
(`packages/trpc/src/routers/{manageddb,cache,search,vector,buckets,storage,volumes}.ts`),
their services
(`packages/trpc/src/services/{manageddb,cache,search,vector,buckets}.service.ts`,
plus `garage-render.ts`, `replicatedStore.service.ts`, `clusterVolume.service.ts`),
the reconcile workers
(`apps/api/src/workers/{manageddb,cache,search,vector}-reconcile.ts`), the agent
storage/volume handler (`apps/agent/src/handlers/storage.ts`) and its protocol
(`packages/core/src/protocol/storage.ts`), the `StorageCluster` / `ClusterVolume`
models (`packages/db/prisma/schema/backups.prisma`), and the Data surfaces
(`apps/app/src/routes/_authed/data*.tsx`).
