# Managed Postgres is completely broken out of the box: the hardcoded `bitnami/postgresql:16` image no longer exists on Docker Hub, and no product surface lets you override it

**Status:** Fixed (2026-09) — default switched to the still-published `bitnamilegacy/postgresql:16` (stopgap; see below). Primary→replica streaming replication verified live.
**Severity:** Critical — blocks 100% of the "managed database" feature area, which the governing
`/goal` directive explicitly named as a must-test feature ("the kind of database stuff, everything").

## Symptom

Deployed the "Node API" blueprint (stack `apitest`) via the real Deploy → Blueprints flow, which
includes a managed Postgres primary + read replica. The stack UI shows a persistent, vague
"Something is down" / "0/2 replicas" with no actionable detail anywhere in the dashboard.

Direct node inspection tells the real story:

```
$ docker service ps apitest_db-primary --no-trunc
... Rejected  "No such image: bitnami/postgresql:16"
```

The task crash-loops indefinitely — a new `Rejected` task appears roughly every 5 seconds, forever.
Same failure on `apitest_db-replica`.

## Root cause

Confirmed directly against the registry:

```
$ docker pull bitnami/postgresql:16
Error response from daemon: failed to resolve reference "docker.io/bitnami/postgresql:16":
docker.io/bitnami/postgresql:16: not found
```

Cross-checked against Docker Hub's public tag-listing API: for the `bitnami/postgresql` repo, only
`latest` and opaque SHA256-digest tags resolve. Simple version tags (`16`, `17`, `17.2.0`, etc.) all
404. This matches Bitnami's known policy change moving most versioned image tags behind a paid
"Bitnami Secure Images" subscription — the free-tier `bitnami/postgresql` repo on Docker Hub no
longer publishes them.

The hardcoded default lives at `packages/trpc/src/services/manageddb.service.ts:312`:

```js
const image = `bitnami/postgresql:${input.imageTag ?? '16'}`;
```

`imageTag` is a real, typed input field (doc comment at `manageddb.service.ts:270`: `/** bitnami/postgresql
image tag (default "16"). */`) — but it is only reachable if some caller actually passes it. Neither
the blueprint deploy flow ("Node API") nor the stack's own "Data" tab UI (the in-product surface for
managing a stack's databases — "Managed databases" panel, "Topology & backups" expander, and the
"Add another database" provisioning form) expose any field for it. Confirmed by driving all three
through the real UI: the existing `db` entry's "Topology & backups" panel only offers an HA-shape
dropdown ("Primary + replicas") and a backup engine/destination selector (`pg_dump` / no destinations
yet) — no image or version field anywhere. The "Add another database" form only has `NAME` and `READ
REPLICAS` fields before its "Provision" button. **There is no product-surface path to override the
dead tag.**

A second, distinct hardcoded reference exists at `packages/trpc/src/services/templates.ts:121`:
`const POSTGRES_IMAGE = 'bitnami/postgresql-repmgr:16';` — a different image variant (repmgr-based),
used by a different/unconfirmed code path. Not yet verified whether this specific tag is also dead,
but it's the same vintage and likely the same problem.

Related constants tied to the same broken image family (relevant once this is unblocked and backup
testing resumes): `packages/core/src/protocol/dbBackup.ts:22`
(`DEFAULT_PG_CLIENT_IMAGE = 'bitnami/postgresql:16'`), `dbBackup.ts:211-216` (Bitnami path convention
constants: PITR conf target, `pg_ctl` path, `PGDATA` path), `apps/api/src/workers/manageddb-reconcile.ts:492`
(mount target `/bitnami/postgresql`).

## Why this matters

This isn't a config or environment problem a user can route around — it's a dead upstream image
reference baked into swarmy's own default, with zero in-product override. Every blueprint that
includes a managed Postgres database (confirmed: Node API; likely also n8n, Directus, and any other
blueprint tagged with managed Postgres, and the standalone "provision a database" flow on any stack's
Data tab) is broken today, unconditionally, for every new user, with no error surfaced anywhere
except by dropping to `docker service ps` on the node directly — something the product explicitly
exists to make unnecessary.

## Suggested fix direction

- Update the default tag away from `16` to something that still resolves — `latest` is confirmed
  live, but pinning to `latest` reintroduces its own version-drift risk; a specific still-published
  digest or a non-Bitnami Postgres image (e.g. the official `postgres` image, if the primary/replica
  streaming-replication tooling can be adapted) would be more stable long-term.
- Regardless of the default chosen, expose the `imageTag` field somewhere on the product surface
  (the Data tab's "Add another database" form and/or the existing database's settings) so a stuck
  deployment isn't a hard, unrecoverable dead end when an upstream image inevitably moves again.
- Check `packages/trpc/src/services/templates.ts:121`'s `bitnami/postgresql-repmgr:16` for the same
  problem before considering this fully scoped.
- Surface the actual `docker service ps` rejection reason (or at least "image pull failed") on the
  stack's dashboard card instead of the generic "Something is down" — this class of failure is
  currently invisible without direct node/Docker access, which the product exists to avoid.

## Not yet tested

Whether `bitnami/postgresql-repmgr:16` (the `templates.ts` variant) is also dead, and whether any
other blueprint's managed-database wiring differs from `manageddb.service.ts`'s path. Also not yet
reached: backups/PITR testing for managed Postgres (blocked entirely by this issue, since no primary
ever comes up), and cache provisioning (Valkey/Redis, visible on the same Data tab but not yet
exercised this segment).

## Fix applied (2026-09)

**Decision: `bitnamilegacy/*` stopgap, not a port to official `postgres`.** The managed-DB plane
depends on the Bitnami contract far beyond the replication env vars: `/bitnami/postgresql`
persistence root (manageddb-reconcile.ts:494), the conf.d PITR mount
(`BITNAMI_PITR_CONF_TARGET`), `pg_ctl promote` at `/opt/bitnami/postgresql/bin/pg_ctl` for
failover, the `bitnami` psql client used by backups/drills, plus redis/sentinel/etcd/repmgr.
Porting all of that is a separate epic. `bitnamilegacy/*` is the same image, frozen by Bitnami
when versioned tags were pulled from the free `bitnami/*` namespace (Aug 2025) — all tags used
below were verified 200 on Docker Hub's tag API, multi-arch. Caveat: `bitnamilegacy` gets no
further updates; the long-term fix (official `postgres` + init-script replication +
`pg_basebackup` entrypoint) is noted on the constant.

Live verification: `bitnamilegacy/postgresql:16` primary + replica with the exact env
`provisionDb` emits → `pg_stat_replication` shows the replica `streaming`, a row inserted on the
primary is readable on the replica, `pg_is_in_recovery()=t`, and the Bitnami `pg_ctl` /
PGDATA paths exist.

Changes:
- `packages/core/src/protocol/dbBackup.ts:21-52` — single source of truth:
  `MANAGED_PG_IMAGE_REPO`, `MANAGED_PG_DEFAULT_TAG`, `DEFAULT_MANAGED_PG_IMAGE`
  (`bitnamilegacy/postgresql:16`), `migrateDeadBitnamiImage()`; `DEFAULT_PG_CLIENT_IMAGE` now
  aliases the managed image (was dead `bitnami/postgresql:16`).
- `packages/trpc/src/services/manageddb.service.ts:295` — `resolveManagedPgImage()`: explicit
  `image` → `imageTag` (of the managed repo) → the live primary's image (so a per-cluster
  override survives re-provision; digest stripped) → default. Dead `bitnami/*` refs are rewritten to
  `bitnamilegacy/*`, so **re-provisioning an already-broken cluster heals it**. Used at :357.
  Per-cluster override is Docker-truth: the service image itself (the reconcile worker already
  clones new members from `primary.image`) — no new label/column.
- `packages/trpc/src/routers/manageddb.ts:58` — `provision` accepts an optional full `image` ref
  (validated) alongside `imageTag`. (UI exposure of the field is not done — out of scope here.)
- Other dead Bitnami refs (all verified 404 on `bitnami/`, 200 on `bitnamilegacy/`):
  `apps/api/src/workers/manageddb-reconcile.ts:127` etcd → `bitnamilegacy/etcd:3.5` (`:3` is
  amd64-only); `apps/api/src/workers/cache-reconcile.ts:51,53` and
  `packages/trpc/src/services/cache.service.ts:90,92` redis/sentinel → `bitnamilegacy/*:7.4`;
  `packages/trpc/src/services/templates.ts:123` → `bitnamilegacy/postgresql-repmgr:16`,
  `:182-183` redis-sentinel/redis `:7` (no such legacy tag) → `bitnamilegacy/*:7.4`.
- Tests: `packages/trpc/src/services/manageddb.service.test.ts:64` (default, dead-ref rewrite,
  tag/image precedence, live-override + digest strip); fixture in `dbBackup.service.test.ts:181`.

Still open (separate work): surfacing the swarm task rejection reason on the stack card, and an
image field in the Data tab UI.
