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
   throws for logical) — keep both guards. `restoreDb` checks the pairing
   controller-side too, before any safety copy is taken (invariant 13).
   `snapshot-from-replica` is a `pg_dump`
   whose `conn.host` the controller pointed at a read replica; it restores as
   `pg_dump`. PITR starts from the newest base backup that finished at or
   before the target (`pickBaseBackup`, `apps/agent/src/handlers/pitr-restore.ts`);
   a target before every base backup is refused with the recoverable window
   (it starts when the oldest base backup finished). The controller checks
   that FIRST: `restoreDb`'s PITR path runs `pitrPreflight`
   (`dbPitrWindow.service.ts` → read-only `db.pitrWindow` → agent
   `handlers/pitr-window.ts`, a `wal-g backup-list` sidecar) before the safety
   copy and the stop, and refuses a target outside the window in plain words.
   It is skipped, and logged, for pgbackrest and for an agent that does not
   advertise the `dbPitrWindow` capability (today's behaviour then). Compose-DB dumps (`appdb.*`, MySQL/MariaDB/Postgres/Mongo/Redis/Valkey)
   are a separate path: never a `DbBackupEngine` and never a `Snapshot` row
   (dr-reconcile would restore a dump file into a volume). Their catalog is
   restic tags `appdb:<stack>/<service>`, their history `appdb.backup`/
   `appdb.restore` audit rows; credentials ride as a RECIPE (env/`_FILE`
   names) the agent resolves in-task — no value crosses the WS; an in-place
   restore always takes a `reason:pre-restore` dump first. A password never
   reaches argv: Mongo tools get a 0600 tmpfs `--config`, else their own
   password prompt fed on stdin (`printf`), and the scripts' tests use stub
   tools that record argv/stdin (`protocol/appDbScripts.ts`).
6. **The controller bundle is zero-knowledge and re-adopts the swarm.** The bundle
   = `manifest.json` (`dbDriver: 'sqlite'`) + `control.db` (a `VACUUM INTO` hot
   snapshot of the controller's SQLite store) + `secrets.json` (`SWARMY_SECRET_KEY`,
   `BETTER_AUTH_SECRET`), sealed with a USER-HELD restore passphrase (not the vault
   key). A restore works because agent reconnect creds are *hashed*
   (`Node.sessionSecretHash`/`sessionVersion`) inside the snapshot — restoring the DB
   lets agents dial back out and re-adopt. Never hot-swap `SWARMY_SECRET_KEY` in a
   running process; a key mismatch is a surfaced warning, not a silent overwrite.
   `telemetry.db` (history only: metric samples, edge traffic, data and query
   history) is never in the bundle. Two restore paths,
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
   only post-mutation failures record a `failed` drill. Live steps are run
   state, never stored: `stepRecorder` publishes each step's start/end to the
   in-memory relay (`drill-progress.ts`), and `resilience.drillProgress`
   replays the org's runs in flight, then tails them (each event is the whole
   run so far; a finished run lingers a minute).
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
13. **A managed-Postgres restore that writes over its source saves the source
    first.** In-place, single-database, PITR, or a clone pointed back at the
    same cluster (`overwritesSource`) first takes a LOGICAL backup through the
    normal `backupDb` path: `pg_dumpall` for a PITR or a whole-cluster load,
    otherwise a `pg_dump` of the one database (`safetyBackupPlan`). It is tagged
    `reason:pre-restore` (the snapshot view's `reason`) and never stamps
    `swarmy.db.backup.lastRun`. If it fails, the restore is refused and nothing
    is touched. The only way past is `skipSafetyBackup: true`, audited as
    `db.restore.safety.skip` before the restore starts. A logical `latest` is
    pinned to a real save BEFORE the safety copy exists (`latestRestorable`);
    otherwise the restore would put back the data it was meant to replace. The
    result carries `safetySnapshotId`, and restoring that snapshot undoes the
    restore. The logic lives in `dbRestoreSafety.service.ts`. Never add a
    restore-over-live-data path that skips `ensureSafetyCopy`.
14. **Restore as a copy creates its own cluster.** `dbBackups.restoreAsCopy`
    (`dbRestoreCopy.service.ts`; `data.restore` + `stack.deploy`, audited
    `db.restore.copy`) provisions `<cluster>-restore-<mmdd>` beside the source
    (same image and database, one copy, `single`, the source's region by the
    usual pin rules; the name rule is `@swarmy/core` `db-restore-copy.ts`, so
    the dashboard shows it up front), waits for Postgres, then runs the
    ordinary `restoreDb` into it. Nothing is wired into an app. Preconditions
    (no source, name taken, nothing to restore) throw before anything exists;
    a later failure removes the copy's services and keeps its volume. A copy
    is a different cluster, so it takes no safety backup.

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
- **runOnce binds are allowlisted on the agent** (`@swarmy/core/protocol`
  `run-once-binds.ts`, refused with `E_BIND_REFUSED` before any pull): a named
  volume at a safe container path, the Docker socket identity-mapped for the
  docker-CLI system image only, or a node restic repo identity-mapped for the
  restic image only and never under a system path. A new one-shot that needs
  another bind shape changes that rule (and its controller contract test),
  never the payload.

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
| Pre-restore safety copy (`overwritesSource`, `safetyBackupPlan`, `latestRestorable`, `ensureSafetyCopy`) | `packages/trpc/src/services/dbRestoreSafety.service.ts` (+ `.test.ts`) |
| PITR window check before a restore (preflight, last read per cluster, the dashboard's `dbBackups.pitrWindow`) | `packages/trpc/src/services/dbPitrWindow.{service,judge}.ts`, wire `packages/core/src/protocol/pitrWindow.ts`, agent `apps/agent/src/handlers/pitr-window.ts` |
| Restore as a copy (name rule, placement, into-copy restore) | `packages/core/src/db-restore-copy.ts`, `packages/trpc/src/services/dbRestoreCopy{.service,.into,.placement}.ts` |
| Live drill steps (relay + `resilience.drillProgress`) | `packages/trpc/src/services/drill-progress.ts`; UI `components/backups/{dr-drill-card,drill-steps}.tsx` |
| runOnce bind allowlist (agent-enforced, pure) | `packages/core/src/protocol/run-once-binds.ts` |
| PITR orchestration (stop, aside + fetch, start, promote) + base-backup pick | `packages/trpc/src/services/dbPitrRestore.service.ts`, agent `apps/agent/src/handlers/pitr-restore.ts` (`pickBaseBackup`) |
| Controller brain: config, passphrase, bundle build/restore, re-adopt | `packages/trpc/src/services/controllerBackup.{service,bundle,snapshot}.ts` (+ `routers/controllerBackup.ts`) |
| Standalone disaster-restore entrypoint (dashboard is down); its target comes from swarm-kv (`ctl-backup` → `bkp-target`, read over a manager's Docker socket with SWARMY_SECRET_KEY) with flags as per-field overrides | `apps/api/src/restore.ts` (+ `restore-args.ts`, `restore-swarm.ts`), reader `packages/trpc/src/services/controllerBackup.kv-target.ts` |
| Controller store runtime: boot restore, restore selection, lease rules, Litestream supervisor, replica markers | `apps/api/src/controller-store/{boot,restore-select,lease,supervisor,litestream,replica,config}.ts` (entrypoint: `apps/api/docker-entrypoint.sh`) |
| Lease/placement wire + agent handler (acquire/renew/release, configure, move) | `packages/core/src/protocol/controllerService.ts`, `apps/agent/src/handlers/controller-service.ts` |
| Replication lag, MEASURED (local TXID over Litestream's socket vs the replica's head TXID from the bucket listing; v0.5's socket has no lag field, and `last_sync_at` stalls when idle too) | `apps/api/src/controller-store/{lag,lag-monitor}.ts` (pure + tested). Every socket read is time-boxed: v0.5 holds `/list` open while the replica is unreachable |
| Replication status / on-off / "Move controller to…" (ABAC `data.failover`) | `packages/trpc/src/services/controllerStore.service.ts` (+ `routers/controllerStore.ts`); the pure view + the "controller store: local only / replicated (lag Ns)" line in `controllerStore.view.ts`; UI `components/controllerbackup/{replication-card,replication-target-form,move-controller-dialog,store-words}.tsx`, the line on Backups in `components/backups/controller-line.tsx` |
| Failover e2e (Garage + Litestream lag/crash/move/stale/fence; lease + move on a 2-manager dind Swarm) | `scripts/e2e/controller-store/run.sh` |
| P3 drills on a real swarm (drain the controller's node; partition it and judge the self-fence) — opt-in, `--enable controller-drain,controller-partition` | `apps/e2e/cluster/steps/controller-drills.ts` (+ `lib/controller.ts`), verdict `apps/api/src/controller-store/fence-drill.ts` (pinned to `lease.ts` by its test) |
| Resilience: checks (incl. `controller-store`: local only / replication needs a look; `swarm-kv-size`: a swarm-kv document or the footprint past 75% of its limit), 2 drills (restore, backup-verify), drill history | `packages/trpc/src/services/resilience.service.ts` (+ `resilience.controller-store.ts`, `resilience.swarm-kv.ts`, `routers/resilience.ts`) |
| Default-on backups (nightly `pg_dump` for managed PG, crash-consistent volume backup for compose DBs AND every other named volume, native Garage + "also copy to" an external S3, opt-outs: tombstone, `swarmy.backup.auto=off`, `swarmy.backup.auto.exclude`) | `packages/trpc/src/services/autoBackup{,.service}.ts` |
| Compose-DB logical dumps + restore (MySQL/MariaDB/Postgres/Mongo/Redis/Valkey: credential recipe, `appdb.*` commands, scheduler hook, drill leg) | `packages/trpc/src/services/appDbBackup.service.ts` (router `routers/appDbBackup.ts` → `backups.appDb`), wire + pure scripts `packages/core/src/protocol/appDb{,Scripts}.ts`, agent `apps/agent/src/handlers/appdb.ts`, UI `components/backups/{appdb-dumps,restore-appdb-confirm}.tsx` |
| Controller datastore (embedded SQLite: `control.db` + `telemetry.db`, bun:sqlite adapter, `ensureSchema`) | `packages/db/src/{client,bun-sqlite-adapter,ensure-schema}.ts` |
| Workers: scheduled backups / restore-on-recovery / controller schedule | `apps/api/src/workers/{backup-scheduler,dr-reconcile,controller-backup-scheduler}.ts` |
| UI: one Backups page — destinations, the restore-point grid, the DR drill, Verify all, "swarmy itself" (controller replica + bundle) | `apps/app/src/routes/_authed/backups.tsx` → `components/backups/backups-page.tsx` (+ `restore-grid-{card,model,lanes}`, `restore-point-detail`, `dr-drill-card`, `drill-steps`, `verify-all`, `controller-line`), `components/controllerbackup/*` |
| UI: per-stack Backups tab (schedules, what isn't protected yet, drills) | `routes/_authed/stacks/$name.backups.tsx` → `components/backups/{stack-backups,stack-schedules-card,…}.tsx`, `components/resilience/*` |
| UI: Postgres backups on that tab (schedule, retention preview, point-in-time scrubber, restore) | `components/pgbackups/*` (`pitr-scrub.ts`, `retention-preview.ts` pure + tested) |
| UI: Time travel — an app's week of releases, incidents and saves; a read-only replay; restore to the nearest save | `routes/_authed/stacks/$name_.time-travel.tsx` → `components/time-travel/*` (`time-travel-model.ts`, `time-travel-replay.ts` pure + tested) |
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
  `dbRestoreSafety.service.test.ts`, `controllerBackup.bundle.test.ts`,
  `controllerBackup.snapshot.test.ts`, `controllerBackup.schedule.test.ts`).
  Agent side: `bun --filter @swarmy/agent typecheck` and
  `handlers/pitr-restore.test.ts`. Multi-node restore-on-recovery:
  `scripts/local-vms.sh` (see `skill("run-local")`) — back up a volume, kill the
  host agent, watch `dr-reconcile` restore it onto a survivor.
