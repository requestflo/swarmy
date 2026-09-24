---
name: backups-dr
description: Invariants, contracts, and file map for swarmy's backups, DR, and the resilience checks — restic volume/DB backups, estate-wide BackupTargets, the controller self-backup bundle, restore-on-recovery, and the safe drills (restore/backup-verify). Load before touching anything under backups.service, dbBackup.service, controllerBackup.*, resilience.service, apps/agent/src/handlers/backup.ts, backups.prisma, or the backup/dr/controller-backup workers. Product rationale lives in docs/product/resilience-and-dr.md.
---

# Backups & DR: restic sidecars, the controller brain, and safe drills

Read `docs/product/resilience-and-dr.md` for WHY recovery is something you
rehearse. This skill is the HOW: the invariants every backup/DR change must keep,
and where everything lives. Backups are dispatched to the agent as commands — see
`skill("agent-handlers")` for the dial-out/command contract this builds on.

## Invariants (violating any of these is a bug, not a style choice)

1. **restic is the one backup primitive; secrets are never on node disk.** Volume
   backups, DB dumps, and the controller bundle all land in the same restic
   repo. The agent runs restic as a short-lived SIDECAR container (no daemon):
   the repo password + S3 creds arrive over the authenticated WS and exist ONLY
   as container `env` — never written to a file, never baked into an image, never
   logged. See `apps/agent/src/handlers/backup.ts` (`repoEnv`/`runSidecar`).
   The controller-driven path is the norm; the **operator CLI can also run
   backups with the controller DARK** (`swarmy-agent backup export|restore|push`
   in `apps/agent/src/cli/backup.ts`), reusing the same exported sidecar
   internals (`runSidecar`/`repoEnv`/`ensureRepo`/`parseSummary`). There the
   operator supplies credentials by env/prompt (never argv); local export needs
   none at all. That rescue path is owned by `skill("node-recovery")`; keep those
   restic helpers exported for it.
2. **Every credential at rest is a `*Ref` ciphertext.** `BackupTarget.
   resticPasswordRef` / `credentialRef` / `secretKeyRef` and
   `ControllerBackupConfig.restorePassphraseRef` are `encryptSecret(...)` under
   `SWARMY_SECRET_KEY`, decrypted in-memory only when building a command. Never
   add a plaintext credential column; never return a decrypted secret to a client.
3. **Backups run where the data is — EXCEPT the controller's own.** Volume/DB
   backups dispatch to the node hosting the volume (or an online manager) via
   `ctx.hub.dispatch`. The controller-state backup runs controller-side
   (`controllerBackup.service.ts`), because it contains the controller's secrets
   and must work before any agent exists. Do not push the controller bundle to an
   agent, and do not run a volume backup on the controller.
4. **Config lives in the swarm; the DB is catalog + history; Docker owns DB
   schedules.** `BackupTarget`, `BackupSchedule` and `ControllerBackupConfig`
   are swarm-kv documents (`backups.repo.ts`: `bkp-target/`, `bkp-sched/`,
   `ctl-backup/`). The DB holds `Snapshot`, `BackupJob`, `RestoreOperation` and
   `ControllerSnapshot`. A managed
   DB cluster's recurring-backup intent lives on Docker: the
   `swarmy.db.backup.schedule` JSON label on the primary (+ `.lastRun`, `.pitr`).
   If you're about to add a column that mirrors a service label, stop — see
   `skill("docker-native-storage")`.
5. **DB backup engine ↔ restore mode must match.** Logical (`pg_dump` /
   `pg_dumpall` / `snapshot-from-replica`) restore via clone / in-place /
   single-database; physical (`wal-g` / `pgbackrest`) is PITR-only. The handlers
   enforce this (`restoreDbLogical` throws for physical engines; `restoreDbPitr`
   throws for logical) — keep both guards. `snapshot-from-replica` is a `pg_dump`
   whose `conn.host` the controller pointed at a read replica; it restores as
   `pg_dump`. Compose-DB dumps (`appdb.*`, MySQL/MariaDB/Postgres/Mongo/Redis/Valkey)
   are a separate path: never a `DbBackupEngine` and never a `Snapshot` row
   (dr-reconcile would restore a dump file into a volume). Their catalog is
   restic tags `appdb:<stack>/<service>`, their history `appdb.backup`/
   `appdb.restore` audit rows; credentials ride as a RECIPE (env/`_FILE`
   names) the agent resolves in-task — no value crosses the WS; an in-place
   restore always takes a `reason:pre-restore` dump first.
6. **The controller bundle is zero-knowledge and re-adopts the swarm.** The bundle
   = `manifest.json` (`dbDriver: 'sqlite'`) + `control.db` (a `VACUUM INTO` hot
   snapshot of the controller's SQLite store) + `secrets.json` (`SWARMY_SECRET_KEY`,
   `BETTER_AUTH_SECRET`), sealed with a USER-HELD restore passphrase (not the vault
   key). A restore works because agent reconnect creds are *hashed*
   (`Node.sessionSecretHash`/`sessionVersion`) inside the snapshot — restoring the DB
   lets agents dial back out and re-adopt. Never hot-swap `SWARMY_SECRET_KEY` in a
   running process; a key mismatch is a surfaced warning, not a silent overwrite.
   `telemetry.db` (`MetricSample`) is never in the bundle. Two restore paths,
   both in `controllerBackup.snapshot.ts`: disaster restore (`bun run restore`,
   controller STOPPED) uses `installSnapshotFile()` — the snapshot becomes
   `control.db`, the old file is kept as `control.db.pre-restore-<ts>` (its
   `-wal`/`-shm` moved with it, Litestream's `.control.db-litestream` sidecar
   removed), then `ensureSchema` applies newer migrations. In-place restore
   (tRPC `controllerBackup.restore`) uses `loadControlPlane()` — ATTACH the
   snapshot, FKs off, delete + refill every table present in both (columns
   matched by name) in one transaction, `PRAGMA foreign_key_check` before
   COMMIT. A Postgres-era bundle (`db.sql`) is refused. The bundle is a
   passphrase-encrypted `bundle.swcb` inside restic, so a by-hand restore needs
   swarmy's decrypt as well as restic. There is no Postgres controller tier and
   no "upgrade to managed Postgres" path.
7. **Drills are safe-by-construction, admin-only, confirmed, audited.** The
   restore drill only ever touches a throwaway `drill-<ts>` cluster and cleans up
   on success AND failure; backup-verify (`restic check`) is read-only. Both are
   `adminProcedure`. Preconditions THROW (nothing touched → not a drill outcome);
   only post-mutation failures record a `failed` drill.
8. **A drill outcome is one audit row, not a model.** Each run writes a single
   `resilience.drill` (`DRILL_AUDIT_ACTION`) audit row whose metadata IS the
   `ResilienceDrillResultView`; "last tested" reads those rows back, plus a small
   in-memory `recentDrills` cache so a lost audit write never blanks the page.
   Don't add a `Drill` table.
9. **"What isn't protected yet" is a pure function of a snapshot.**
   `runChecks(snap)` → severity-sorted problems, shown as a plain list (no score,
   no grade — removed 2026-09). The classifiers never touch `ctx` — gather live
   signals into `ResilienceSnapshot` first, then classify. Every problem carries
   a `fixPath`/`fixLabel`.
10. **DR restore-on-recovery is bounded and Docker-independent in its trigger.**
    `dr-reconcile` reads node liveness from the hub (not DB Node rows) and which
    volumes lived where from `Snapshot.hostNodeId` (the only Docker-independent
    record), restoring only after a grace window. RPO = backup interval, RTO =
    restore time — never claim zero-RPO/HA for a scheduled-backup path.
11. **One controller writes `control.db`, fenced by an epoch lease in raft.**
    The lease is the `swarmy.controller.lease` JSON label on the controller's
    own service (`protocol/controllerService.ts`). The agent writes it only
    with a version-checked `service update` (`handlers/controller-service.ts`;
    `decideLeaseWrite` is the pure rule). Expiry is judged by the challenger's
    OWN observation (the same write unchanged for a TTL), never by comparing
    clocks. The holder fences first (TTL − margin, timed from when its last
    renewal was SENT). Workers and Litestream run only while the lease is held
    (`controller-store/supervisor.ts`). On lease loss: `query_only`, SIGKILL
    Litestream (no final sync), exit 70. On SIGTERM: stop writes, SIGTERM
    Litestream (final sync), release, exit 0. Never run Litestream through
    `-exec` (it can't tell those two apart), and never start it before the
    pre-replication check passes.
12. **Restore-on-boot runs before the DB opens and follows lineage, not
    timestamps.** `controller-store/boot.ts`, run from the entrypoint, reads
    the replica target from the mounted `control_store` Docker secret (never
    from the DB, which may not exist yet). It compares the local writer marker
    (`.control.db-swarmy.json`) with the replica's `<prefix>/writer.json`: equal
    = keep the local file, different = the file is stale, so move it aside and
    restore. Priority is replica, then bundle, then fresh. Never start empty
    while the replica is unreachable, or in a swarm that already had a
    controller (`SWARMY_ALLOW_FRESH=1` overrides). Whatever puts a different
    control.db in place must clear `-wal`/`-shm`/`.control.db-litestream`/the
    marker (`clearSidecarFiles`). Litestream v0.5 takes ONE replica per DB, so an
    off-site controller copy means pointing the replica at an external S3
    target (the nightly bundle is the other off-box copy).

## Contracts between the layers

- **Controller → agent dispatch**: `ctx.hub.dispatch(nodeId, cmd, payload)` with a
  `CommandName` mapped to its wire type in `COMMAND_PROTOCOL_TYPE`
  (`packages/trpc/src/hub/types.ts`): `backup.run`→`backupVolume`,
  `backup.restore`→`restoreVolume`, `backup.list`→`listSnapshots`,
  `db.backup`→`dbBackup`, `db.restore`→`dbRestore`, and `container.runOnce`
  →`runOnce` (drills). Adding a backup command is the three-place recipe in
  `skill("agent-handlers")`.
- **ResticRepo wire shape**: services build it from a target row
  (`toResticRepo`): `{ kind:'s3'|'node', repo, password, endpoint?, region?,
  accessKeyId?, secretAccessKey? }`. S3 repo URL is `s3:<endpoint>/<bucket>/
  <prefix>`; node repo is a local path. In-cluster endpoints (`swarmy-garage`)
  need the `swarmy` overlay network — `resticNetworkFor(endpoint)` decides.
- **Snapshot lifecycle**: create `Snapshot { status:'RUNNING', hostNodeId }` →
  dispatch → on success `SUCCEEDED` + `resticId`/`sizeBytes`; on throw `FAILED` +
  `error`. Same RUNNING→SUCCEEDED/FAILED shape for `ControllerSnapshot`.
- **Resilience snapshot inputs**: live services from `ctx.hub.liveInventory` →
  `buildInventory`; regions from `ctx.hub.nodesByRegion`; backup recency from
  `Snapshot` rows + the `swarmy.db.backup.lastRun` labels; ingress/storage/geo/
  controller-backup configs from their services. All gathered in `buildSnapshot`.
- **Drill exec contract**: drills exec inside a running container via the `exec`
  command (`execInService` → `resolveExecTarget`) and dispatch `container.runOnce`
  for `restic check`; `psqlScript` runs psql against localhost in a managed PG
  member (official image, `$POSTGRES_PASSWORD`).

## File map

| Concern | Where |
|---|---|
| Prisma models (targets/snapshots/schedules/restore ops/controller backup) | `packages/db/prisma/schema/backups.prisma` |
| Agent restic + DB-engine sidecars (backup/restore/list, logical+physical) | `apps/agent/src/handlers/backup.ts` |
| Controller-dark operator rescue backups (export/restore/push/list) | `apps/agent/src/cli/backup.ts` (see `skill("node-recovery")`) |
| Backup wire types (`ResticRepo`, payloads, default images) | `packages/core/src/protocol/backup.ts` |
| Volume backups: targets CRUD, native Garage target, backup/restore/list | `packages/trpc/src/services/backups.service.ts` (+ `routers/backups.ts`) |
| Volume backup schedules + restore-op history | `packages/trpc/src/services/backupSchedule.service.ts` |
| Two destinations per schedule (primary + `secondaryTargetId` "also copy to") | `backupSchedule.service.ts` (`setScheduleSecondary`), worker `apps/api/src/workers/backup-scheduler.ts` (`backupToTarget`), UI `components/backups/schedule-secondary-select.tsx` |
| DB backups: engines, `swarmy.db.backup.*` labels, schedule, PITR, restore | `packages/trpc/src/services/dbBackup.service.ts` (+ `routers/dbBackup.ts`) |
| Controller brain: config, passphrase, bundle build/restore, re-adopt | `packages/trpc/src/services/controllerBackup.{service,bundle,snapshot}.ts` (+ `routers/controllerBackup.ts`) |
| Standalone disaster-restore entrypoint (dashboard is down) | `apps/api/src/restore.ts` |
| Controller store runtime: boot restore, restore selection, lease rules, Litestream supervisor, replica markers | `apps/api/src/controller-store/{boot,restore-select,lease,supervisor,litestream,replica,config}.ts` (entrypoint: `apps/api/docker-entrypoint.sh`) |
| Lease/placement wire + agent handler (acquire/renew/release, configure, move) | `packages/core/src/protocol/controllerService.ts`, `apps/agent/src/handlers/controller-service.ts` |
| Replication status / on-off / "Move controller to…" (ABAC `data.failover`) | `packages/trpc/src/services/controllerStore.service.ts` (+ `routers/controllerStore.ts`), UI `components/controllerbackup/{replication-card,replication-target-form,move-controller-dialog}.tsx` |
| Failover e2e (Garage + Litestream crash/move/stale/fence; lease + move on a 2-manager dind Swarm) | `scripts/e2e/controller-store/run.sh` |
| Resilience: checks, 2 drills (restore, backup-verify), drill history | `packages/trpc/src/services/resilience.service.ts` (+ `routers/resilience.ts`) |
| Default-on DB backups (nightly `pg_dump` for managed PG, crash-consistent volume backup for compose DBs, opt-out markers) | `packages/trpc/src/services/autoBackup{,.service}.ts` |
| Compose-DB logical dumps + restore (MySQL/MariaDB/Postgres/Mongo/Redis/Valkey: credential recipe, `appdb.*` commands, scheduler hook, drill leg) | `packages/trpc/src/services/appDbBackup.service.ts` (router `routers/appDbBackup.ts` → `backups.appDb`), wire + pure scripts `packages/core/src/protocol/appDb{,Scripts}.ts`, agent `apps/agent/src/handlers/appdb.ts`, UI `components/backups/{appdb-dumps,restore-appdb-confirm}.tsx` |
| Controller datastore (embedded SQLite: `control.db` + `telemetry.db`, bun:sqlite adapter, `ensureSchema`) | `packages/db/src/{client,bun-sqlite-adapter,ensure-schema}.ts` |
| Workers: scheduled backups / restore-on-recovery / controller schedule | `apps/api/src/workers/{backup-scheduler,dr-reconcile,controller-backup-scheduler}.ts` |
| UI: estate destinations, controller backup | `apps/app/src/routes/_authed/{backups,settings_.backup}.tsx`, `components/controllerbackup/*` |
| UI: per-stack Backups tab (schedules, what isn't protected yet, drills) | `routes/_authed/stacks/$name.backups.tsx` → `components/backups/{stack-backups,stack-schedules-card,…}.tsx`, `components/resilience/*`; overview card `components/overview/resilience-card.tsx` |
| Crypto: `encryptSecret`/`decryptSecret`, `generateRestorePassphrase` + fingerprint | `packages/core/src/crypto.ts` |

## Adding a check or a drill (the recipe)

**A resilience check**: add a classifier branch in `runChecks` that pushes a
`problem(check, severity, { title, detail, fixHint, fixPath, fixLabel, resource })`
off the pure `ResilienceSnapshot`; if the signal isn't in the snapshot yet, add
the field and populate it in `buildSnapshot` (never read `ctx` from a classifier);
bump `CHECKS_RUN`; add the `ResilienceCheckId` to `@swarmy/core` views; add a
fixture case to `resilience.service.test.ts`.

**A drill**: add a `ResilienceDrillKind` + input schema in `@swarmy/core`; write
`run<Name>Drill(ctx, input)` that (1) validates preconditions and THROWS if unmet,
(2) uses a `stepRecorder()` so every step is timed and captured, (3) mutates only
safe/throwaway resources and cleans up in both the success and catch paths, (4)
ends with `finishDrill(...)` (which `recordDrill`s the audit row); wire it as an
`adminProcedure` mutation in `routers/resilience.ts`; surface a drill card in
`buildDrillCards` with an `available`/`unavailableReason`.

## Operational gotchas

- **In-cluster targets need the overlay.** The native Garage destination
  (`http://swarmy-garage:3900`) only resolves on the `swarmy` overlay — pass
  `resticNetworkFor(endpoint)` to every dispatch or the sidecar can't reach it.
  Node-path and external S3 targets need no network.
- **`ensureRepo` is idempotent** (`restic init` no-ops on an existing repo) — call
  it before backup/list; a fresh target has no repo yet.
- **Physical backups require an S3 target + the primary's PGDATA volume.**
  `backupDbPhysical`/`restoreDbPitr` throw without `dataVolume`; wal-g/pgbackrest
  cannot use a node-path repo.
- **Never let a preflight touch prod.** The restore drill's snapshot lookup +
  engine check run *before* it creates the `drill-<ts>` cluster; keep new
  validation there, not after.
- **The controller passphrase is shown once.** The `generatePassphrase`
  procedure (→ `generateRestorePassphrase`) returns it
  without storing; `setPassphrase` stores only `encryptSecret` + a
  `passphraseFingerprint` hint. Zero-knowledge disaster restore supplies it via
  the CLI; the stored copy is for in-place operational rollback only.
- The controller floats only when the store is replicated: `configure`
  switches `node.hostname == X` ↔ `node.role == manager` and repoints the
  `control_store` secret (one controller restart). The installer keeps whichever
  placement, secret and lease label are live on a re-run. Node-label changes
  EVICT running tasks (Swarm's constraint enforcer), and that is how "move"
  works. So never put `swarmy.controller.avoid=true` on every manager.
- Verify: `bun --filter @swarmy/trpc typecheck` and the pure suites
  (`resilience.service.test.ts`, `dbBackup.service.test.ts`,
  `controllerBackup.bundle.test.ts`, `controllerBackup.snapshot.test.ts`,
  `controllerBackup.schedule.test.ts`). Agent
  side: `bun --filter @swarmy/agent typecheck`. Multi-node restore-on-recovery:
  `scripts/local-vms.sh` (see `skill("run-local")`) — back up a volume, kill the
  host agent, watch `dr-reconcile` restore it onto a survivor.
