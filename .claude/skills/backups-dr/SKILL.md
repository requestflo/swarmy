---
name: backups-dr
description: Invariants, contracts, and file map for swarmy's backups, DR, and the resilience score — restic volume/DB backups, estate-wide BackupTargets, the controller self-backup bundle, restore-on-recovery, and the safe drills (restore/failover/backup-verify). Load before touching anything under backups.service, dbBackup.service, controllerBackup.*, resilience.service, apps/agent/src/handlers/backup.ts, backups.prisma, or the backup/dr/controller-backup workers. Product rationale lives in docs/product/resilience-and-dr.md.
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
4. **The DB is swarmy's catalog + history + config; Docker owns the schedule.** DB
   holds `BackupTarget`, `Snapshot`, `BackupJob`, `BackupSchedule`,
   `RestoreOperation`, `ControllerBackupConfig`, `ControllerSnapshot`. A managed
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
   `pg_dump`.
6. **The controller bundle is zero-knowledge and re-adopts the swarm.** The bundle
   = control-plane dump + secrets (`SWARMY_SECRET_KEY`, `BETTER_AUTH_SECRET`) +
   config + manifest, sealed with a USER-HELD restore passphrase (not the vault
   key). A restore works because agent reconnect creds are *hashed*
   (`Node.sessionSecretHash`/`sessionVersion`) inside the dump — restoring the DB
   lets agents dial back out and re-adopt. Never hot-swap `SWARMY_SECRET_KEY` in a
   running process; a key mismatch is a surfaced warning, not a silent overwrite.
7. **Drills are safe-by-construction, admin-only, confirmed, audited.** The
   restore drill only ever touches a throwaway `drill-<ts>` cluster and cleans up
   on success AND failure; the failover drill refuses anything but a fully-healthy
   failover/primary-replica cluster and force-restarts the replica to rejoin even
   on error; backup-verify (`restic check`) is read-only. All three are
   `adminProcedure`. Preconditions THROW (nothing touched → not a drill outcome);
   only post-mutation failures record a `failed` drill.
8. **A drill outcome is one audit row, not a model.** Each run writes a single
   `resilience.drill` (`DRILL_AUDIT_ACTION`) audit row whose metadata IS the
   `ResilienceDrillResultView`; "last tested" reads those rows back, plus a small
   in-memory `recentDrills` cache so a lost audit write never blanks the page.
   Don't add a `Drill` table.
9. **The resilience score is a pure function of a snapshot.** `runChecks(snap)` →
   problems, `scoreProblems` → `100 − Σ weight` (crit 15 / warn 7 / info 2,
   floored at 0) → grade + "Production readiness: NN%". The classifiers never
   touch `ctx` — gather live signals into `ResilienceSnapshot` first, then
   classify. `CHECKS_RUN` must equal the number of checks. Every problem carries a
   `fixPath`/`fixLabel`.
10. **DR restore-on-recovery is bounded and Docker-independent in its trigger.**
    `dr-reconcile` reads node liveness from the hub (not DB Node rows) and which
    volumes lived where from `Snapshot.hostNodeId` (the only Docker-independent
    record), restoring only after a grace window. RPO = backup interval, RTO =
    restore time — never claim zero-RPO/HA for a scheduled-backup path.

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
  for `restic check`; `psqlScript` runs psql against localhost in a bitnami PG
  container.

## File map

| Concern | Where |
|---|---|
| Prisma models (targets/snapshots/schedules/restore ops/controller backup) | `packages/db/prisma/schema/backups.prisma` |
| Agent restic + DB-engine sidecars (backup/restore/list, logical+physical) | `apps/agent/src/handlers/backup.ts` |
| Backup wire types (`ResticRepo`, payloads, default images) | `packages/core/src/protocol/backup.ts` |
| Volume backups: targets CRUD, native Garage target, backup/restore/list | `packages/trpc/src/services/backups.service.ts` (+ `routers/backups.ts`) |
| Volume backup schedules + restore-op history | `packages/trpc/src/services/backupSchedule.service.ts` |
| DB backups: engines, `swarmy.db.backup.*` labels, schedule, PITR, restore | `packages/trpc/src/services/dbBackup.service.ts` (+ `routers/dbBackup.ts`) |
| Controller brain: config, passphrase, bundle build/restore, re-adopt | `packages/trpc/src/services/controllerBackup.{service,bundle,dump}.ts` (+ `routers/controllerBackup.ts`) |
| Standalone disaster-restore entrypoint (dashboard is down) | `apps/api/src/restore.ts` |
| Resilience: 9 checks, score math, 3 drills, drill history | `packages/trpc/src/services/resilience.service.ts` (+ `routers/resilience.ts`) |
| Workers: scheduled backups / restore-on-recovery / controller schedule | `apps/api/src/workers/{backup-scheduler,dr-reconcile,controller-backup-scheduler}.ts` |
| UI: estate backups, resilience score, controller-backup settings, per-stack | `apps/app/src/routes/_authed/{backups,backups.schedules,resilience,settings.backup}.tsx`, `stacks/$name.backups.tsx` |
| Crypto: `encryptSecret`/`decryptSecret`, passphrase gen + fingerprint | `packages/core/src/crypto.ts` |

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
- **The controller passphrase is shown once.** `generatePassphrase` returns it
  without storing; `setPassphrase` stores only `encryptSecret` + a
  `passphraseFingerprint` hint. Zero-knowledge disaster restore supplies it via
  the CLI; the stored copy is for in-place operational rollback only.
- Verify: `bun --filter @swarmy/trpc typecheck` and the pure suites
  (`resilience.service.test.ts`, `dbBackup.service.test.ts`,
  `controllerBackup.bundle.test.ts`, `controllerBackup.schedule.test.ts`). Agent
  side: `bun --filter @swarmy/agent typecheck`. Multi-node restore-on-recovery:
  `scripts/local-vms.sh` (see `skill("run-local")`) — back up a volume, kill the
  host agent, watch `dr-reconcile` restore it onto a survivor.
