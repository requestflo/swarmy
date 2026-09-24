# Resilience & DR — "prove your recovery story on a schedule, not during an outage"

**Status: canonical product design (2026-07). Pairs with the `backups-dr` skill
for the how.**

## The feeling we are building

Someone running a real workload on swarmy should be able to answer, at any
moment, one uncomfortable question — *"if this node died right now, what would I
lose, and can I actually get it back?"* — without waiting for the outage to find
out:

1. They open a stack's **Backups** tab and see it in plain words: "storefront is
   **covered**. 42 snapshots in the catalog, encrypted and deduplicated." Last
   backup, next schedule, destination.
2. They glance at the **Resilience** score — one number, "98, Grade A" — with the
   weakening factors listed underneath ("checkout runs a single replica",
   "controller backups are off") and a one-click fix on each.
3. They hit **Run the restore drill**. swarmy clones the latest database backup
   into a throwaway cluster, runs `SELECT 1` against it, and destroys the clone —
   proving the backup is restorable, with an RPO and RTO to show for it. Every
   run lands in the audit log.
4. Weeks later the box actually dies. A new node joins, DR reconciliation restores
   the stranded volume's latest snapshot onto it, and the service comes back. Or
   the *controller* dies — they stand a new one up, paste their restore passphrase,
   and it **re-adopts the existing swarm** because every agent's reconnect
   credential was in the backed-up brain.

No untested backups sitting in a bucket you hope works. No "restore runbook" that
was last exercised at install time. It should feel like your recovery story is a
thing you *rehearse* — a drill you can fire on a quiet Tuesday — not a thing you
discover is broken at 3am. **An unrestored backup is a hope, not a plan.**

## How it works (the backup + drill path)

```
scheduled / one-click backup
      │  ① controller decrypts target creds in-memory, dispatches over the WS
      ▼
agent runs restic as a short-lived SIDECAR container         (no daemon)
      │  ② volume bind-mounted ro → `restic backup --json`; DB engines dump
      │     first (pg_dump / wal-g) then restic-store the dump. Repo password +
      │     S3 creds are ONLY ever process env — never written to disk on the node
      ▼
encrypted + deduplicated snapshot in a BackupTarget          (Backblaze B2 / R2 /
      │                                                       MinIO / bundled Garage)
      │  ③ swarmy records the Snapshot row (catalog + history); Docker-truth
      │     labels carry the schedule and lastRun on the cluster itself
      ▼
SAFE DRILL proves it (container.runOnce, admin-only, audited)
         restore drill  → clone latest DB backup → throwaway `drill-<ts>` cluster
                          → SELECT 1 → destroy the clone   (RPO/RTO measured)
         failover drill → pg_promote a standby → verify it left recovery → rejoin
         backup-verify  → `restic check` on the destination
```

Four ideas, one story:

- **restic is the whole backup primitive.** Encrypted-at-source, deduplicated,
  incremental, a plain repo any operator can restore by hand with the restic
  binary and the password — *with or without swarmy running*. Volume backups, DB
  dumps, and the controller's own brain all land in the same restic catalog with
  different sources. One mechanism, not three.
- **Retention is enforced, not just displayed.** A retention window (per-stack
  `swarmy.backup.retentionDays` label for volumes; the DB backup schedule's own
  `retentionDays`) makes each *successful* backup run `restic forget
  --keep-within <N>d --prune`, scoped to that source's tags so one cluster's
  prune can never eat another's snapshots. A retention failure never fails the
  backup that just succeeded — it is reported separately — and every prune that
  removes snapshots writes an audit row with counts. No window set = keep
  forever, stated plainly in the UI.
- **Backups run where the data is; the controller only orchestrates.** The agent
  launches the sidecar against its local Docker socket (see the `agent-handlers`
  skill); the controller decrypts credentials just-in-time and dispatches. The one
  exception is the *controller's own* backup, which must never leave the
  controller and must work before any agent exists — so it runs controller-side.
- **Resilience is a graded posture, not a checklist.** Pure checks over live
  Docker-truth signals produce a 0–100 score (`100 − Σ weights`), a letter grade,
  and a ranked list of weakening factors — each with a fix link. Turn a factor
  green and the score moves.
- **Drills are the product.** A backup you have never restored is untested. swarmy
  makes restoring *safe to rehearse*: throwaway clusters, promote-and-rejoin,
  integrity checks — all confirmed in the UI, admin-only, and every outcome
  written to the audit log so "last tested" means something.

## Roles and where truth lives

- **The backup schedule and last-run live on the cluster, in Docker.** A managed
  DB cluster's recurring backup is the `swarmy.db.backup.schedule` JSON label on
  its primary service; `swarmy.db.backup.lastRun` and `swarmy.db.backup.pitr`
  record the last outcome and whether WAL archiving is on. The schedule survives
  swarmy — the stack carries its own protection intent. See the
  `docker-native-storage` skill.
- **Config lives in the swarm; the DB owns the catalog and the history.**
  `BackupTarget` (a destination + encrypted `*Ref` credentials), `BackupSchedule`
  (volume schedules the worker reads) and `ControllerBackupConfig` are swarm-kv
  documents (`backups.repo.ts`), so they survive with the swarm. The DB keeps
  swarmy's queryable record: `Snapshot` / `BackupJob` (restic run catalog),
  `RestoreOperation` (DR restore history) and `ControllerSnapshot`.
- **Destinations are estate-wide.** A `BackupTarget` is org-scoped and shared
  across stacks — "Destinations are managed estate-wide." The native destination
  is the in-swarm Garage object store (`swarmy-object-storage` → the
  `swarmy-backups` bucket); external S3 (Backblaze B2, R2, MinIO) is a URL +
  encrypted key away.
- **Every secret is a `*Ref`, encrypted with `SWARMY_SECRET_KEY`, decrypted only
  in memory.** Restic repo passwords and S3 creds never sit in plaintext at rest
  and never touch a node's disk — they arrive over the authenticated WS as command
  env and die with the sidecar.
- **Drill outcomes are NOT a new model.** Each run writes one `resilience.drill`
  audit row whose metadata *is* the drill result view; "last tested" reads those
  rows back (with a small in-memory cache so a lost write never blanks the page).

## Resilience & DR behaviour (what the promise commits us to)

- **The score is honest and derived.** Checks over live signals: single-
  replica services, cache/DB with no standby, object-store replication factor,
  backup recency (crit at >7 days or none), *restore never tested*, ingress on one
  node, geo-DNS single-region on a multi-region estate, controller-backup recency.
  Weights are crit 15 / warn 7 / info 2; the headline reads "Production readiness:
  NN%". No score is a green checkmark you can't explain.
- **Backups are encrypted, deduplicated, and portable.** restic at source means
  the target — even another operator's node over the mesh — only ever sees
  ciphertext. A bucket full of restic is recoverable by hand; swarmy is a
  convenience over it, never a lock-in.
- **DB backups match the engine.** Logical (`pg_dump` / `pg_dumpall` /
  `snapshot-from-replica` — a dump pointed at a read replica, zero primary load)
  land in the same restic catalog; physical (`wal-g` / `pgbackrest`) push base
  backups + WAL for **point-in-time recovery**. Restore modes: clone-to-new-cluster,
  in-place, single-database, and pitr-to-a-timestamp.
- **The controller's store is two embedded SQLite files.** `control.db` holds
  every control-plane model; `telemetry.db` holds only `MetricSample` (no foreign
  keys into `control.db`). Both live in `SWARMY_DATA_DIR`
  (`/var/lib/swarmy/data` on the `swarmy-data` volume in prod). There is no
  database service, port or password. The controller migrates both files on boot
  (`ensureSchema`).
- **`control.db` streams to object storage, continuously.** Once replication is
  on (Settings → Platform → Backups), Litestream ships every write to a dedicated
  Garage bucket (`swarmy-control`), or to any S3 backup target, about once a
  second. `telemetry.db` is never replicated. The replica target lives in a
  Docker secret (`swarmy_control_store.<ts>`) and not in the database, because a
  controller that lands on an empty volume must read it before any database
  exists. Garage's own off-site mirror carries the bucket further. Without a
  replica, the nightly bundle below is the only off-box copy, and the dashboard
  says so.
- **The controller can move to any manager.** With the store replicated, the
  controller's placement floats from `node.hostname == <bootstrap host>` to
  `node.role == manager`. Volumes stay node-local. A controller that starts on a
  new node restores from the replica before the database opens. The boot
  decision is **keep the local file** (when it is the replica's current
  lineage), **restore the replica**, **restore the latest controller bundle**,
  or **start fresh**. A stale file left on a node the controller used before is
  kept as `control.db.stale-<ts>` and replaced. Boot never starts empty while a
  replica it can't reach may hold the data, and never starts empty in a swarm
  that already had a controller unless `SWARMY_ALLOW_FRESH=1` is set.
  "Move controller to…" is a controlled version of the same thing: the
  controller ships its last writes, releases its lease and starts on the manager
  you pick.
- **Exactly one controller writes: a lease in raft, fenced by epoch.** The
  controller holds `swarmy.controller.lease = {holder, epoch, …}` on its own
  service's labels and renews it every 10 s. Each renewal is a version-checked
  `service update` through a manager agent, so it is an atomic compare-and-swap
  that needs raft quorum. A challenger takes over only after it has watched the
  same lease write sit unchanged for 30 s on its own clock (no clock
  comparison). The holder stops writing earlier than that: 22 s after its last
  successful renewal it kills Litestream WITHOUT a final sync and exits. Every
  takeover bumps the epoch, and a superseded holder can't renew. Workers and
  Litestream start only while the lease is held. Before it replicates, a new
  holder checks that the replica is exactly what it restored: the same writer
  marker and no newer transactions. If not, it restarts and restores again.
- **The loss window is about 1 second.** Litestream ships every second. A node
  that dies loses at most the writes of that last second (the e2e measures
  0–1 s). A clean move or stop (SIGTERM, drain, "Move controller to…") ships the
  tail first and loses nothing. When the old node dies, a failover takes about
  40 s: Swarm reschedules, then the new controller waits out the 30 s lease.
  After a clean stop the new controller takes the lease at once. Without a
  replica, the loss window is everything since the last controller bundle.
- **The controller can back up its own brain.** A single encrypted bundle —
  a `VACUUM INTO` hot snapshot of `control.db` + the controller's secrets
  (`SWARMY_SECRET_KEY`, `BETTER_AUTH_SECRET`) + a compatibility manifest — sealed
  with a **user-held restore passphrase** (zero-knowledge; shown once, "write this
  down"). `telemetry.db` is never in the bundle, so metric history does not survive a restore.
  Because every agent's reconnect credential is a *hashed* session secret in that
  snapshot, **a controller restored on a fresh box re-adopts the existing swarm** —
  agents dial back out and reconnect, no re-enrollment.
- **DR reconciliation is automatic but bounded.** When a node that hosted a
  volume's snapshots has been offline past a grace window (~5 min), the
  `dr-reconcile` worker restores the latest snapshot onto a healthy node — RPO is
  the backup interval, RTO is the restore time, and swarmy shows both rather than
  over-promising "HA".
- **Drills are safe by construction and gated.** The restore drill only ever
  touches a throwaway `drill-<ts>` cluster and cleans it up on success *or*
  failure; the failover drill refuses anything but a fully-healthy failover/
  primary-replica cluster and always tries to rejoin the replica even if a step
  fails; backup-verify is read-only. All are admin-only, confirmed in the UI, and
  audited.
- **Database backups are on by default; everything else is opt-in.** Once a
  destination exists, databases get a nightly backup with zero clicks
  (`autoBackup.ts`, 7-day retention): managed Postgres a logical `pg_dump`
  (a `swarmy.db.backup.schedule` label with `"auto": true`), compose/blueprint
  databases a crash-consistent volume backup (an `auto` `BackupSchedule` row) —
  engines that replay a WAL/redo log recover from it, but it is not a
  transaction-consistent dump. So compose MySQL/MariaDB/Postgres/MongoDB/Redis/Valkey
  also get a logical dump on the same schedule (`mysqldump
  --single-transaction` / `mariadb-dump`, `pg_dump -Fc` per database,
  `mongodump --archive`, Redis
  `BGSAVE` + the finished RDB) into the same restic repo, with one-click
  restore — as a copy by default, in place behind a typed confirm and a
  safety dump. The volume copy stays (belt and braces: `dr-reconcile` restores
  volumes, and it covers a DB whose credentials swarmy can't resolve — the
  Backups tab says "volume snapshot only" and why). Credentials are read the
  way a human would, inside the running task (env, `_FILE` secrets, redis
  `--requirepass`), and never leave the node. An existing user schedule is never overridden,
  and removing an auto schedule leaves an opt-out marker so it is never
  re-created. No controller backups until you set a passphrase; no drills run
  themselves.

## Failure modes (designed, not accidental)

| Failure | Behaviour |
|---|---|
| A backup target is down when a scheduled backup fires | The `Snapshot` row is marked `FAILED` with the error; the schedule's `nextRunAt` still advances; backup recency turns the Resilience score red until a good run lands. |
| Node holding a `local` volume dies | Past the grace window, `dr-reconcile` restores the volume's latest snapshot (by `Snapshot.hostNodeId`) onto a healthy manager and writes a `RestoreOperation` — recovery to the last backup, not zero-RPO. |
| The controller's node dies (replicated store) | Swarm starts the controller on another manager. Its empty volume is restored from the replica before the DB opens, it takes the lease once the old one has been silent for 30 s, and agents re-adopt. Up to about 1 s of writes is lost. |
| The controller is partitioned from the managers | It can't renew (no raft quorum on its side), so it stops writing and exits within 22 s, without a final sync. The majority side's new controller can take over only after 30 s. If the old side still shipped after the new one's restore, the new one's pre-replication check sees it and restores again. No two lineages are ever interleaved. |
| The replica (Garage) is down at boot | With a local file: keep it, start without replicating, and retry the check every 15 s. With an empty volume: exit and let Swarm retry. Never start empty. |
| Controller (the brain) is lost entirely | Stand up a new controller, stop the controller and run the standalone `restore` entrypoint with the target coords + user-held passphrase; it puts the snapshot in place as `control.db` (the old file kept as `control.db.pre-restore-<ts>`), applies newer migrations, and the agents re-adopt via their hashed session secrets. Disaster recovery uses the CLI (the dashboard is down); in-place rollback uses the UI. |
| Restore passphrase is lost | The controller-state bundle is unreadable — by design (zero-knowledge). swarmy cannot recover it; the setup flow gates on "I've stored it" for exactly this reason. |
| Restore drill fails midway | The throwaway `drill-<ts>` cluster is destroyed regardless; the drill is recorded `failed` with the step that broke; nothing on the real cluster was touched (preconditions throw before anything is created). |
| Failover drill on a half-healthy cluster | Refused up front (needs a running primary + ≥1 running replica); the promoted replica is force-restarted back through its entrypoint to rejoin even on error. |
| DB backup of a live Postgres | For managed Postgres, logical engines dump a transactionally-consistent point-in-time; `snapshot-from-replica` takes it off a read replica for zero primary load. A compose MySQL/MariaDB/Postgres/Mongo/Redis/Valkey also gets a logical dump; only a compose DB whose credentials can't be resolved (e.g. a random root password and no app user) is volume-only. |
| Logical dump of a compose DB fails | Audited as a failed `appdb.backup`, shown on the stack's Databases card; the volume copy from the same schedule still ran. An in-place restore whose safety dump fails changes nothing. |

## Explicitly rejected

- **A backup you never restore.** The whole reason drills are first-class: an
  untested backup is a liability dressed as insurance. We would rather you prove it
  on a schedule than trust a bucket.
- **A parallel backup subsystem per data type.** Volumes, DBs, and the controller
  all collapse onto one restic + one `BackupTarget` abstraction. Three mechanisms
  would drift and triple the surface to secure.
- **Escrowing the controller passphrase with `SWARMY_SECRET_KEY` by default.** The
  key and the backup colocated is not disaster recovery — it is one loss away from
  both. Zero-knowledge is the default; escrow is an opt-in for users who accept the
  weaker guarantee.
- **A Postgres service (or external Postgres) for the controller.** Removed with
  the `--standard` tier and the "upgrade to managed Postgres" path. A database
  service is one more thing to run, secure, back up and pin to a host.
- **kopia / borg instead of restic.** kopia's repository server duplicates the
  scheduling and RBAC swarmy already has; borg has no native S3 backend. restic
  is one static binary, S3-first, and restorable by hand.
- **Running the controller's own backup on an agent.** It contains the
  controller's secrets and must work before any agent exists — so it runs
  controller-side, the one deliberate exception to "backups run where the data is".
- **Claiming "HA" for scheduled backups.** restic gives *recoverability* (RPO =
  interval, RTO = restore time), CSI gives *availability*, Garage gives *off-node
  durability* — three distinct guarantees. We show the real numbers, not a green
  "highly available" badge.
- **A drill that mutates production.** The restore drill never restores over a
  live cluster; it clones. Safe-to-rehearse is the point — a drill you are afraid
  to run is not a drill.

## Reversed decisions

- **SQLite as the controller store (reversed 2026-09-24).** We once rejected
  SQLite/libSQL because the schema was Postgres-shaped (enums, jsonb, BigInt ids,
  timestamptz) with many concurrent writers, and ran embedded Postgres (PGlite)
  instead. Checked against the code (`plans/epic-docker-native-state.md` §1),
  those reasons did not hold:
  - *Concurrent writers:* PGlite was already single-connection; its adapter ran
    every transaction one at a time. SQLite in WAL mode (one writer, many
    readers) is the same model or better.
  - *Dialect:* Prisma's SQLite provider supports `Json`, `enum` and `BigInt`.
    Two `String[]` columns became `Json`, the `@db.*` annotations were dropped,
    and 5 raw-SQL call sites were ported.
  - *What PGlite cost:* at least 128 MiB of WASM memory, an initdb peak near
    1 GiB (worked around with an image-baked template), a 597-line in-repo
    Prisma adapter, and only logical `INSERT` dumps. No continuous replication
    meant the controller was pinned to one host.
  - *What SQLite gives:* a few MB of memory, `VACUUM INTO` hot snapshots for the
    bundle, and Litestream WAL shipping to Garage, which is what lets the
    controller move between managers (shipped in P3).

## Implementation map

The operational conventions and invariants live in the `backups-dr` skill
(`.claude/skills/backups-dr/SKILL.md`) — the restic sidecar contract, the drill
safety gates, and where every model lives. Key homes: `packages/db/prisma/schema/
backups.prisma` (targets, snapshots, controller backup, schedules, restore ops),
`apps/agent/src/handlers/backup.ts` (the restic + DB-engine sidecars),
`packages/trpc/src/services/backups.service.ts` and `dbBackup.service.ts` (volume
+ DB backup/restore), `packages/trpc/src/services/controllerBackup.service.ts`
(the controller brain bundle; `controllerBackup.snapshot.ts` takes and loads the
`control.db` snapshot) with `apps/api/src/restore.ts` (the standalone
disaster-restore entrypoint), `packages/trpc/src/services/resilience.service.ts`
(the checks, the score, and the three drills), `autoBackup{,.service}.ts`
(default-on DB backups), the controller store (`apps/api/src/controller-store/*`:
boot restore, lease, Litestream supervisor; the agent's
`handlers/controller-service.ts`; `controllerStore.service.ts` for status /
replication / move), the workers
`apps/api/src/workers/{backup-scheduler,dr-reconcile,controller-backup-scheduler}.ts`,
and the UI: estate destinations at `apps/app/src/routes/_authed/backups.tsx`,
controller backup at `settings_.backup.tsx`, and each stack's Backups tab
(`stacks/$name.backups.tsx` → `components/backups/*` + the resilience score in
`components/resilience/*`).
