# Epic: Controller data store strategy (Postgres vs SQLite vs self-bootstrapped) + controller backup/restore

> Status: plan / implementation-ready. Targets the existing swarmy scaffold (Bun + Turborepo, tRPC v11/Hono, **Prisma 7 + Postgres via `@prisma/adapter-pg`**, agent dial-out WS, pluggable driver registries, `@swarmy/storage` + restic from the volumes-DR epic). Do not redesign the scaffold; this epic plugs into it. **Flagged VERY IMPORTANT.**

## Problem

Two coupled questions, one epic.

**1. What backs the controller?** Today the controller is hard-wired to Postgres: `datasource db { provider = "postgresql" }`, `@prisma/adapter-pg`, and the schema leans on Postgres-only features — native `enum` types (9 of them), `Json`/jsonb columns everywhere (`labels`, `latestMetrics`, `env`, `ports`, `settings`, …), `BigInt` autoincrement ids (`MetricSample`, `AuditLog`), and `@db.Timestamptz(3)` time-series columns. The local dev story is "`bun docker:up` to get Postgres on :5678." That is a real dependency to stand up, operate, and *back up* — and it sits at odds with "anyone can just deploy — it has to be that simple." A user evaluating swarmy on one box should not have to think about a database server.

The user's literal question: **do we even need Postgres, or can we run "lite" (SQLite / embedded)?** We must answer with a concrete default and an upgrade path, evaluating:
- (a) **Keep Postgres**, but have swarmy *bootstrap its own Postgres as a managed Swarm service* so it's still one command.
- (b) **SQLite "lite mode"** for single-node / getting-started — and honestly enumerate what breaks (enums, jsonb, concurrency, BigInt, timestamptz) and how we'd abstract it.
- (c) **Embedded** options: libSQL/Turso (embedded SQLite-superset), PGlite (Postgres compiled to WASM, in-process).

**2. The "if something goes completely wrong, restore" requirement.** The controller's database *is* swarmy's brain — orgs, nodes, join-token hashes, per-node session secrets, services, stacks, deployments, ingress config, audit log. Lose it and every agent's reconnect credential, every domain, every deployment record is gone, and a rebuilt controller cannot re-adopt the existing swarm. So we need **controller-state backup/restore**: what to back up (db **+ secrets + config**), to where (S3 / mesh / another node — *reuse the volumes-DR mechanism*), encryption, scheduling, and a **one-click restore that rebuilds the controller** from scratch. This is the disaster-recovery floor for the control plane itself, distinct from the volume DR epic (which protects *workload* data).

Constraints: stay unopinionated, one-command/zero-config, org-scoped + audited, pluggable/disableable, and — critically for restore — recoverable *by hand without swarmy running*, the same promise restic gives us for volumes.

Non-goals: multi-controller HA / active-active control plane (separate epic); zero-RPO synchronous replication of controller state; sharding. Target: small/medium swarms (1–9 nodes), one controller (optionally warm-standby later).

## Recommended approach

**Default: ship single-binary "lite mode" on embedded Postgres via PGlite. Auto-upgrade to a swarmy-bootstrapped, managed Postgres Swarm service the moment the user adds a second node (or opts in).** One database *dialect* (Postgres) end-to-end, so the schema never forks; only the *driver* changes. Backup/restore is the *same restic mechanism* the volumes-DR epic already builds, pointed at a new "controller-state" bundle.

This is the decisive call, so here is the reasoning in full, with alternatives weighed.

### Why not just "SQLite lite mode" (option b)

SQLite is the obvious "lite" answer and it's wrong for swarmy, because our schema is *Postgres-shaped* and moving to SQLite forks it permanently:

- **Native enums** (9 of them) don't exist in SQLite. Prisma emulates them as `TEXT`, but the generated migrations/types diverge and you lose DB-level validation.
- **`Json`/jsonb** → SQLite stores JSON as `TEXT`; no `jsonb` operators, no indexing into JSON, and Prisma's JSON filtering (`path`, `array_contains`) behaves differently or is unsupported. We use `Json` columns *pervasively*.
- **`BigInt @id @default(autoincrement())`** (MetricSample, AuditLog) → SQLite's `INTEGER PRIMARY KEY` is 64-bit but the Prisma `BigInt` mapping + adapter differ; autoincrement semantics and `Timestamptz` are emulated, losing tz fidelity on the time-series tables.
- **Concurrency**: SQLite is single-writer (one writer at a time, `SQLITE_BUSY`). The controller has *concurrent writers* — the agent WS gateway (heartbeats, metrics, container/service state from N agents), the metrics sampler worker, the retention worker, and tRPC mutations — all hammering the DB at once. WAL mode helps reads but you still serialize writes; under a busy swarm this becomes the bottleneck and a source of `database is locked` errors. This is the single biggest reason SQLite is a poor controller store even at "lite" scale.

Maintaining **two Prisma schemas / two dialects** (the abstraction tax to support both Postgres and SQLite) is exactly the kind of forked complexity that rots. We reject it.

### Why PGlite (option c) is the right "lite" — it's *still Postgres*

**[PGlite](https://pglite.dev) is real Postgres compiled to WASM, running in-process** — no separate server, no port, no `docker:up`, a single file directory (or in-memory) for storage. The killer property: **it is the same Postgres dialect.** enums, jsonb, `BigInt`, `timestamptz`, `gen_random_uuid`, window functions, `ON CONFLICT` — all work, because it *is* Postgres (currently PG 16.x core). So **the existing `schema.prisma` runs unchanged**: same migrations, same generated client, same query code. Lite mode and full mode differ only in *which adapter* we hand Prisma:

- Lite: `@prisma/adapter-pglite` (or PGlite behind a thin pg-compatible shim) → embedded, file-backed, zero external process.
- Full: `@prisma/adapter-pg` → real Postgres over TCP (today's path).

Prisma 7's **driver-adapter architecture is purpose-built for this** — the client is engine-less and talks to whatever adapter you inject (we already use `PrismaPg` in `packages/db/src/client.ts`). Swapping adapters by env is a few lines. No schema fork, no second migration history, no dual dialect.

Why PGlite over **libSQL/Turso** (the other embedded option): libSQL is a SQLite fork. It's excellent, embeds beautifully, and Turso gives a slick sync-to-cloud story — but it inherits SQLite's dialect, so it hits *every one of the enum/jsonb/BigInt/concurrency problems above*. Choosing libSQL = choosing the SQLite fork = forking the schema. PGlite keeps us on one dialect, which is worth more than libSQL's sync features (we get sync/DR from restic anyway).

PGlite's honest limits, and why they're acceptable for *lite*:
- **Single-connection / single-process.** PGlite is an in-process Postgres serving *one* connection; it is not built for many concurrent client connections. That's fine because lite mode is **single-node, single controller-process** — exactly the getting-started / homelab case. The moment concurrency matters (more nodes, more agents), we upgrade to real Postgres. PGlite is the on-ramp, not the destination.
- **No network access / no second reader.** Acceptable: lite = one box.
- **Durability**: file-backed (`PGDATA` dir) with fsync; we additionally lean on the backup system (below) for real DR. A WASM Postgres crash is recoverable from the restic bundle.
- **Newer / smaller ecosystem** than server Postgres. Mitigated by it being literal Postgres core under the hood and by the trivial upgrade path off it.

### Why a swarmy-bootstrapped managed Postgres (option a) is the *upgrade target*, not the default

When the user is past "kicking the tires" — second node joins, or they flip "production mode" — swarmy stands up **its own Postgres as a managed Swarm service** (`postgres:17-alpine`, pinned), on a manager node, with a `local` volume that is itself protected by the volumes-DR restic backups. The controller's `DATABASE_URL` is repointed at it (service DNS on the swarmy overlay), data is migrated from the PGlite file with a one-shot `pg_dump`-style copy, and from then on it's "real Postgres" with full concurrency. This is still *one command / zero manual DB ops*: swarmy provisions, configures, credentials, and backs it up. The user never runs `apt install postgresql`.

We do **not** make managed-Postgres the day-one default because that reintroduces "there's a database service to stand up" on first run — the exact friction we're killing. PGlite-first means `bun create swarmy` / one binary boots with *no dependencies at all*.

**Net recommendation:**
- **Default (lite):** PGlite, embedded, zero-config, single-node. Same schema, same Postgres dialect.
- **Upgrade (full):** swarmy-managed Postgres Swarm service, auto-suggested on 2nd node / opt-in, one-click migrate, no manual DB ops.
- **Escape hatch:** `DATABASE_URL` to a **bring-your-own/external Postgres** (RDS, Neon, a user's HA cluster) is always honored — power users and the hosted-cloud product use this. Three modes, one dialect, one schema.

This directly answers the user: **No, you don't need to *stand up* Postgres — but yes, you stay on the Postgres dialect.** "Lite" = embedded Postgres (PGlite), not SQLite.

## Architecture & integration

### Data store abstraction (`packages/db`)

Today `client.ts` hard-codes `PrismaPg`. Introduce a tiny adapter selector — **the only structural change to `@swarmy/db`**:

```ts
// packages/db/src/client.ts (sketch)
const mode = process.env.SWARMY_DB_MODE ?? inferMode(); // 'lite' | 'managed' | 'external'
const adapter =
  mode === 'lite'
    ? new PrismaPGlite({ dataDir: process.env.SWARMY_DATA_DIR ?? '~/.swarmy/data/pg' })
    : new PrismaPg({ connectionString: process.env.DATABASE_URL });
export const prisma = new PrismaClient({ adapter });
```

- `schema.prisma` is **unchanged** (still `provider = "postgresql"`). One migration history serves all three modes.
- Add `@prisma/adapter-pglite` (or a thin shim wrapping `@electric-sql/pglite` in the `DriverAdapter` interface if a first-party Prisma adapter isn't yet stable — track this; it's the main external dependency risk). Keep the existing `globalForPrisma` hot-reload guard.
- New env in `apps/api/src/env.ts`: `SWARMY_DB_MODE`, `SWARMY_DATA_DIR`. `DATABASE_URL` becomes **optional** (only required for `managed`/`external`). Update `.env.example` to make clear lite needs *nothing*.
- **Migrations on lite:** run `prisma migrate deploy` against the PGlite instance at controller boot (PGlite can be driven programmatically), so a fresh box self-migrates with no `bun db:push`. Gate behind a boot-time `ensureSchema()`.

> Note: lite mode uses PGlite *embedded in the controller process*, so there is one writer (the controller) — which is exactly PGlite's supported model. The agents never touch the DB; they talk WS to the controller, which is the sole DB client. This is why PGlite's single-connection limit is a non-issue in lite mode.

### Reuse, don't rebuild: backup/restore rides `@swarmy/storage` (volumes-DR epic)

The volumes-DR epic already builds the entire backup primitive we need: **restic** (encrypted + deduplicated + incremental), the `BackupTarget` S3-shaped abstraction (cloud S3 / R2 / B2 / MinIO / bundled Garage / `MESH_NODE` over the dial-out mesh), the `runBackup`/`runRestore`/`pruneRepo`/`checkRepo` protocol commands, the `backup-scheduler` worker, and the `SWARMY_SECRET_KEY` controller crypto for encrypting credentials at rest. **Controller-state backup is a special instance of that system, with a different source.** We add a thin "controller-state" backup type rather than a parallel mechanism. This is the same "collapse onto one abstraction" move the DR epic makes.

The crucial difference: **controller-state backup must NOT run on an agent**, because (a) it includes the controller's own secrets, which must never leave the controller, and (b) it must work *before any agent exists* (you can back up a brand-new single-node lite controller). So we run restic **in the controller process / controller host context**, reusing `@swarmy/storage`'s restic `BackupDriver` and the `BackupTarget` model, but invoked by a **new controller-side service**, not dispatched over the hub.

### What gets backed up — the "controller-state bundle"

A single restic snapshot (tag `swarmy.controller-state`) containing a consistent, self-describing bundle:

1. **Database.** Mode-aware, always producing a **logical dump** (portable across lite↔managed↔external, and across PG minor versions — never a raw datadir copy):
   - lite (PGlite): export via PGlite's dump API → `db.sql` (or `pg_dump`-compatible). PGlite supports `pg_dump`-style logical export.
   - managed/external (server Postgres): `pg_dump --format=custom` against `DATABASE_URL` (run a pinned `postgres`-client container via the agent on the DB's node *or* `pg_dump` from the controller host). Logical dump = restore into *any* mode = our upgrade/downgrade path falls out for free.
2. **Secrets / crypto material.** The `SWARMY_SECRET_KEY` (controller AES-GCM key — without it, every encrypted `*Ref` in the DB is unreadable), `BETTER_AUTH_SECRET`, and any controller-held keys (restic repo passwords are derived/stored encrypted in the DB, so they ride in the dump, but the *master* key must be backed up *separately and loudly*). **Escrow concern: if the bundle is encrypted with a restic password derived from `SWARMY_SECRET_KEY`, you can't bootstrap restore without the key.** So the controller-state repo uses a **standalone, user-held restore passphrase** (zero-knowledge) — surfaced once at setup ("write this down / store in a password manager; without it your controller cannot be restored"). This mirrors restic's key model and the DR epic's "back up the keys themselves" warning, made mandatory here because it's the root of trust.
3. **Config.** Non-secret controller config needed to rebuild: `SWARMY_DB_MODE`, `CONTROLLER_PUBLIC_URL`, ingress driver selection, pinned image versions, and a `manifest.json` (schema/migration version, swarmy version, db mode, timestamp, org count) so restore can validate compatibility before clobbering anything.

**Consistency:** take the logical dump first (transactionally consistent snapshot via `pg_dump`/PGlite export), write it + secrets + config to a staging dir, then `restic backup` that dir. No torn state because the dump is a point-in-time logical export, not a live-file copy.

### Wire protocol

**No new agent commands for the common case** — controller-state backup runs controller-side. We *reuse* the volumes-DR `runBackup`/`runRestore` protocol only for the *managed-Postgres* variant where the `pg_dump` must run on the node hosting the DB volume (the controller dispatches a scoped `runBackup` with a pre-hook that execs `pg_dump` into a sidecar path, exactly the DR epic's `command`-mode hook). So: zero new protocol messages; controller-state backup is (a) direct restic in the controller for lite, or (b) the existing `runBackup` with a pg-dump hook for managed. This keeps the transport untouched, consistent with the DR epic's "no new transport" principle.

### DB models (`packages/db/prisma/schema.prisma`)

Reuse `BackupTarget` from the volumes-DR epic (do not duplicate). Add:

- New enum value or scope flag distinguishing **controller-state** snapshots. Cleanest: a new model rather than overloading the workload `Snapshot`, because controller-state is *org-independent* (it spans all orgs — it's the whole controller). 
- **`ControllerBackupConfig`** — singleton (not org-scoped): `{ id, targetId (FK BackupTarget), enabled, schedule (cron), retention Json, restorePassphraseHint, lastRunAt, nextRunAt, createdAt, updatedAt }`. Mirrors `IngressConfig`'s shape but global.
- **`ControllerSnapshot`** — `{ id, targetId, resticSnapshotId, sizeBytes, durationMs, manifestJson Json, status (RUNNING|SUCCEEDED|FAILED), startedAt, finishedAt, error? }`. The restore catalog for the control plane.
- A new audit `action` namespace (`controller.backup.*`, `controller.restore.*`) in the existing `AuditLog`.

Because these reference the DR epic's `BackupTarget`, this epic **depends on** that model existing (see Dependencies); if sequenced first, define a minimal `BackupTarget` here and let the DR epic extend it.

### Controller: tRPC router + service + worker

- New router `packages/trpc/src/routers/controller-backup.ts` — **super-admin scoped, not org-scoped** (this is platform-level): `getConfig`, `setTarget`, `enable`, `setSchedule`, `runNow`, `listSnapshots`, `getSnapshot`, `pruneNow`, `checkNow`, `testTarget`, and `restorePreview(snapshotId)` (validates manifest compatibility, returns a dry-run diff: schema version, db mode, org/node counts). Restore *execution* is deliberately **out-of-band** (see one-click restore below), but `restorePreview` lives here.
- New service `packages/trpc/src/services/controller-backup.service.ts` — orchestrates: pick `BackupTarget`, build the bundle (dump + secrets + config + manifest), invoke restic via `@swarmy/storage`'s `BackupDriver` directly (controller-side `Bun.spawn` of the pinned restic binary/image), record `ControllerSnapshot`, advance `nextRunAt`. Decrypt creds in-memory via the `SWARMY_SECRET_KEY` helper.
- New worker `apps/api/src/workers/controller-backup-scheduler.ts`, registered in `workers/index.ts` alongside `metrics-sampler`/`retention`. Same pattern as the DR `backup-scheduler`: every minute, if `ControllerBackupConfig.nextRunAt <= now && enabled && !paused`, run a controller-state backup, advance the cron. Default schedule when enabled: **daily**, retention "keep 7 daily / 4 weekly / 3 monthly."

### The one-click restore (rebuild the controller)

This is the load-bearing UX and must work *with swarmy not yet running* (you're recovering from total loss). Design it as a **standalone restore command in the controller binary**, not (only) a dashboard button — because in a real disaster the dashboard is down.

`swarmy restore` (a subcommand of `apps/api`, or a tiny `apps/api/src/restore.ts` entrypoint) prompts for / takes:
1. The **`BackupTarget`** coordinates (S3 endpoint+bucket+creds, or a mesh node, or a local restic repo path) — supplied via flags/env or an interactive prompt.
2. The **user-held restore passphrase** (the zero-knowledge key from setup).

It then: `restic snapshots` (list controller-state snapshots) → pick latest or a chosen id → `restic restore` the bundle to a staging dir → read `manifest.json`, validate swarmy/schema version compatibility → restore `SWARMY_SECRET_KEY`/`BETTER_AUTH_SECRET`/config → spin up the DB (PGlite file or a fresh managed Postgres) → load the logical dump (`psql`/PGlite import) → `prisma migrate deploy` to reconcile schema if the restore is to a newer swarmy → start the controller. 

The decisive payoff: **because every agent's reconnect credential is a *hashed* per-node session secret + version in the DB (`Node.sessionSecretHash`/`sessionVersion`), and join-token hashes are in the DB, a restored controller re-adopts the existing swarm automatically** — agents dialing out reconnect against the restored hashes, no re-enrollment. The restore brings back the *brain* and the agents re-attach. (If a restore is older than an agent's current session version, that agent re-auths via its join token — already supported by the rotating-secret design.) This is why backing up the controller DB is sufficient to recover the whole control plane.

Also expose restore in the dashboard for the *non-total-loss* case (e.g. "roll back controller state to last night"): `Settings → Controller → Backups → Restore` → `restorePreview` diff → confirm → the service performs the same flow against the running controller (with a maintenance lock). Total-loss recovery uses the CLI; in-place rollback uses the UI.

### UI surfaces (`apps/app`)

- **Settings → Controller → Data store**: a badge showing current mode (Lite / Managed Postgres / External), a one-click **"Upgrade to managed Postgres"** (with the migrate step + progress), and an explainer of what lite is. Auto-prompt: a non-blocking banner when a 2nd node joins ("You're now multi-node — upgrade the controller database for reliability").
- **Settings → Controller → Backups**: target picker (reuses the DR `BackupTarget` UI components), enable toggle, schedule + retention, snapshot history with sizes, "Back up now," "Test target," and a **prominent, scary, one-time "Save your restore passphrase"** flow with a "I've stored it" gate. "Verify backup" (test-restore to a throwaway dir + checksum) to prove it's real — same honesty mechanism as the DR epic.
- **Restore** affordances as above (UI for rollback, CLI for disaster).

## MVP vs later

**Phase 0 (foundational, do first):** PGlite lite mode. Adapter selector in `@swarmy/db`, `SWARMY_DB_MODE`/`SWARMY_DATA_DIR` env, boot-time `ensureSchema()`/migrate-deploy, `.env.example` update so first run needs **zero** external services. Verify the *unchanged* schema runs on PGlite (enums/jsonb/BigInt/timestamptz/indices). This alone delivers "one binary, no database to install" and is the answer to the user's question. **Ship this first.**

**Phase 1 (the VERY IMPORTANT bit): controller backup/restore.** `ControllerBackupConfig`/`ControllerSnapshot` models; `controller-backup.service.ts` (bundle = logical dump + secrets + config + manifest) using restic from `@swarmy/storage`; `controller-backup-scheduler` worker; the `controller-backup` tRPC router; the standalone `swarmy restore` CLI entrypoint + UI rollback; the zero-knowledge restore-passphrase flow; targets = cloud S3/R2/B2/MinIO. Depends on the DR epic's `BackupTarget` + restic driver (or a minimal vendored subset).

**Phase 2: managed-Postgres upgrade path.** Swarmy-bootstrapped `postgres:17-alpine` Swarm service (via existing `deployService`), credentials generated + stored encrypted, `DATABASE_URL` repoint, **one-click lite→managed migration** (PGlite dump → load into managed PG → flip `SWARMY_DB_MODE`), and the managed-PG `pg_dump`-hook variant of controller backup. Auto-suggest on 2nd node.

**Phase 3: hardening + reach.** `MESH_NODE` controller-state target (off-site over the dial-out mesh, reusing DR's mesh path); scheduled **test-restores** with checksum proof; restore-to-new-version migration validation; documented warm-standby controller (periodic restore into a second controller for faster RTO) — explicitly *not* active-active HA. Optional: external-PG-only mode docs for the hosted-cloud product.

## Dependencies

- **On the volumes-DR epic (hard):** reuses `@swarmy/storage`'s restic `BackupDriver`, the `BackupTarget` model, `SWARMY_SECRET_KEY` controller crypto, and the `MESH_NODE` target path. Sequence DR's Phase 1 first, or define a minimal `BackupTarget` + restic invocation here and let DR extend it. This is the primary cross-epic coupling and should be coordinated.
- **On the deployment/scheduling epic:** Phase 2's managed-Postgres provisioning goes through the existing `deployService` path and needs a manager-node placement + a protected `local` volume (which itself is backed up by DR).
- **On the node-lifecycle epic:** the auto-upgrade trigger ("2nd node joined") hooks the same node ONLINE event the DR reconcile uses.
- **Infra / new code:** `@prisma/adapter-pglite` (or a `@electric-sql/pglite` `DriverAdapter` shim) — **track adapter maturity, the main external risk**; a pinned `restic` binary/image available to the *controller* (not just the agent image); pinned `postgres`/`pg_dump` client for managed mode; new env (`SWARMY_DB_MODE`, `SWARMY_DATA_DIR`, optional `SWARMY_CONTROLLER_BACKUP_*`); the standalone restore entrypoint in `apps/api`.
- **No schema fork, no new migration history, no new transport.** That's the whole point.

## Risks & open questions

- **PGlite Prisma adapter maturity.** Prisma 7's driver-adapter API is the right seam, but a stable first-party PGlite adapter may lag. Mitigation: a thin in-repo `DriverAdapter` over `@electric-sql/pglite` (PGlite exposes a query interface; the adapter surface is small). Pin versions. If it proves flaky, fall back to **a swarmy-managed single-node Postgres container as the lite default** — still "one command" via `docker run`, slightly less "zero-dependency" but same dialect/schema. (We keep Postgres-dialect either way; that decision is robust.)
- **PGlite scale ceiling.** Single-connection, single-process. Fine for getting-started, *will* bottleneck under load. Mitigation: make the upgrade prompt prominent and the migration genuinely one-click; document lite as "single-node / evaluation / homelab." Don't let users accidentally run a busy 9-node swarm on PGlite.
- **The restore passphrase is the root of trust.** Zero-knowledge means *we can't recover it for them*. If they lose it, the controller-state backups are unreadable. Mitigation: mandatory write-it-down gate at setup, repeated reminders, optional (clearly weaker) escrow-with-`SWARMY_SECRET_KEY` mode for users who accept that the key+backup colocated is less safe. Open question: how hard to push zero-knowledge vs escrow by default.
- **Chicken-and-egg in disaster restore.** To restore you need: target coords + passphrase. Both are *outside* the dead controller (good — that's the design), but we must make capturing them at setup foolproof (downloadable "recovery card" with target ref + passphrase prompt). Open: do we let the recovery card optionally include encrypted target creds so restore needs only the passphrase?
- **Logical-dump size/time at the high end.** `MetricSample`/`AuditLog` are the big tables. For controller-state we likely **exclude raw `metricSample` rows from the dump** (they're regenerated time-series, not control-plane truth) to keep the bundle small and restore fast — back up structure + control-plane tables, treat metrics history as best-effort/separate retention. Open: confirm what's "control-plane truth" vs "rebuildable telemetry" (proposal: exclude `metricSample`, keep `auditLog`).
- **Managed-PG version skew on restore.** Logical dumps (`pg_dump`) restore across PG minor/major versions far better than datadir copies — this is *why* we mandate logical dumps. Still validate the target PG major version in the manifest preflight.
- **External-PG users** (BYO/RDS/Neon) own their own DB backups; swarmy's controller-backup should still capture **secrets + config + a logical dump** so a one-click restore works even when the DB is external (we dump *their* DB via `DATABASE_URL`). Confirm we never assume we manage the DB lifecycle in external mode.

## Simplicity note

The default path requires **zero choices and zero dependencies**: first run boots on embedded PGlite — no Postgres to install, no `docker:up`, no `DATABASE_URL` to set, one binary. The user never types "PGlite" or "Postgres"; they just deploy. That is the strongest possible expression of "anyone can just deploy — it has to be that simple."

The upgrade to real Postgres is a **single button that swarmy performs for them** (provision + migrate + repoint), surfaced only when they actually need it (2nd node). And because it's the *same Postgres dialect* the whole way, there is **one schema, one migration history, one mental model** — "lite" is not a different product, it's the same swarmy with the database tucked inside the binary.

Backup/restore stays simple by **reusing the volumes-DR machinery** (one backup subsystem, one `BackupTarget` abstraction, one restic) and by making protection a single toggle with sane daily defaults. And critically, restore degrades all the way down to **`restic restore` by hand**: the controller-state bundle is a plain encrypted restic repo containing a portable SQL dump + your secrets + a manifest — a user can recover their entire control plane with the restic binary and their passphrase, **with or without swarmy running**. The unopinionated promise holds even for total disaster recovery of swarmy itself.
