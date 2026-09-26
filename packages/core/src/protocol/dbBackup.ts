/**
 * DB-aware backup/restore wire types (epic: data-plane, richer engines).
 *
 * Counterpart to `backup.ts` (volume-level restic) but for *logical* and
 * *physical* Postgres backups. The agent runs the chosen engine as a short-lived
 * sidecar container attached to the cluster's overlay network; the DB password
 * and S3/restic credentials ride the already-authenticated WS and are only ever
 * process env inside that container — never written to disk or baked into an
 * image (the same one-shot-secret contract as the restic handler).
 *
 * Subpath: `@swarmy/core/protocol` (re-exported from `index.ts`).
 */
import { z } from 'zod';
import { CommandId } from './primitives';
import { DbName, DockerVolumeName, IsoTimestamp, ResticRepo, SnapshotRef } from './backup';
import { ResticSnapshotInfo, RetentionOutcome } from './backup';

/** Reusable command preamble (every controller→agent command carries these). */
const cmd = { commandId: CommandId, timeoutMs: z.number().int().positive().optional() };

/**
 * Managed-Postgres engine image — the ONE place the default lives.
 *
 * `pgvector/pgvector:pg17`: the OFFICIAL `postgres:17` (Debian) image plus the
 * pgvector extension, built FROM the upstream image and rebuilt on every
 * upstream release by the pgvector project (github.com/pgvector/pgvector,
 * Docker Hub `pgvector/pgvector`). Why this and not plain `postgres:17`:
 * templates (Chatwoot, Activepieces, AI apps) and `vector.enablePgvector` need
 * `CREATE EXTENSION vector` on the managed cluster, and the official image
 * ships no pgvector. Why not a swarmy-built image: it would add a build +
 * sign + mirror pipeline for a one-line `apt install`, and every node would
 * pull from swarmy's registry instead of Docker Hub's library mirror network.
 * The pgvector image keeps the official image's entire contract
 * (`docker-entrypoint.sh`, `POSTGRES_*`, `PGDATA`, the `postgres` user), so
 * swarmy's own boot layer (`@swarmy/core` manageddb-pg: replication role,
 * pg_basebackup replicas, failover rejoin) runs unchanged on plain
 * `postgres:17` too — an operator can override to it (or a private mirror)
 * with `provisionDb({ image })` and lose only pgvector.
 *
 * 17 rather than 18: PG18's official image moved PGDATA/VOLUME to
 * `/var/lib/postgresql/18/docker` (per-major directories); 17 keeps the
 * `/var/lib/postgresql/data` layout the boot layer mounts. Per-cluster
 * override: `provisionDb({ image | imageTag })` (`imageTag: "16"` →
 * `pgvector/pgvector:pg16`); the reconcile worker clones new members from the
 * live primary's image, so the service image IS the Docker-truth per-cluster
 * setting.
 */
export const MANAGED_PG_IMAGE_REPO = 'pgvector/pgvector';
export const MANAGED_PG_DEFAULT_TAG = 'pg17';
export const DEFAULT_MANAGED_PG_IMAGE = `${MANAGED_PG_IMAGE_REPO}:${MANAGED_PG_DEFAULT_TAG}`;

/** `imageTag` → the managed repo's tag: a bare major ("16") maps to "pg16". */
export function managedPgTag(tag: string): string {
  const t = tag.trim();
  return /^\d+$/.test(t) ? `pg${t}` : t;
}

/** Pinned default images for the DB engines. */
export const DEFAULT_PG_CLIENT_IMAGE = DEFAULT_MANAGED_PG_IMAGE;
/** swarmy's own wal-g build (docker/walg): there is no upstream wal-g image. Same ref as the `walg` system image. */
export const DEFAULT_WALG_IMAGE = 'ghcr.io/requestflo/swarmy-walg:latest';
export const DEFAULT_PGBACKREST_IMAGE = 'pgbackrest/pgbackrest:2.51';

/**
 * Supported backup engines.
 *  - `pg_dump`  — logical dump of a single database (custom format, restorable
 *                 selectively with pg_restore).
 *  - `pg_dumpall` — logical dump of the whole cluster incl. globals/roles (plain SQL).
 *  - `snapshot-from-replica` — a `pg_dump` run against a read-replica host so the
 *                 primary takes zero load; identical artefact, different `conn.host`.
 *  - `wal-g` / `pgbackrest` — physical base backup + WAL archiving for
 *                 point-in-time recovery (PITR). Operate on the primary's PGDATA.
 */
export const DbBackupEngine = z.enum([
  'pg_dump',
  'pg_dumpall',
  'snapshot-from-replica',
  'wal-g',
  'pgbackrest',
]);
export type DbBackupEngine = z.infer<typeof DbBackupEngine>;

export function isPhysicalEngine(e: DbBackupEngine): boolean {
  return e === 'wal-g' || e === 'pgbackrest';
}

/**
 * A one-shot Postgres connection. The password is resolved just-in-time by the
 * controller (read from the cluster's Docker secret inside a running member)
 * and becomes a 0600 PGPASSFILE put into the sidecar before it starts — never
 * the sidecar's env.
 */
export const DbConnection = z.object({
  host: z.string(),
  port: z.number().int().positive().default(5432),
  user: z.string().default('postgres'),
  password: z.string(),
  database: DbName.default('app'),
});
export type DbConnection = z.infer<typeof DbConnection>;

/** Common image/network knobs shared by db.backup and db.restore. */
const engineEnv = {
  /** Overlay network to attach the sidecar to so it can resolve `conn.host`. */
  network: z.string().optional(),
  /**
   * Overlay the restic leg joins so an in-cluster repo (`swarmy-garage`)
   * resolves — distinct from `network` (the cluster net the DB client needs).
   * Additive: older agents ignore it.
   */
  resticNetwork: z.string().optional(),
  /** postgres-client image (pg_dump/pg_dumpall/snapshot/pg_restore/psql). */
  clientImage: z.string().optional(),
  /** physical-engine image (wal-g / pgbackrest). */
  engineImage: z.string().optional(),
  /** restic image for the logical dump→repo store leg. */
  resticImage: z.string().optional(),
  /** physical engines: the primary's PGDATA Docker volume (base backup source). */
  dataVolume: DockerVolumeName.optional(),
};

// ── db.backup ────────────────────────────────────────────────────────────────

export const DbBackupPayload = z.object({
  ...cmd,
  /** Correlates the resulting DbBackup row controller-side. */
  jobId: z.string(),
  engine: DbBackupEngine,
  conn: DbConnection,
  /** restic target (logical engines store the dump here; physical engines use it
   *  as the S3 prefix for wal-g/pgbackrest). */
  repo: ResticRepo,
  /** restic tags, e.g. [`org:<id>`, `cluster:<name>`, `engine:<engine>`]. */
  tags: z.array(z.string()).default([]),
  /**
   * Retention window from the `swarmy.db.backup.schedule` label: after a
   * SUCCESSFUL logical backup the agent runs `restic forget --keep-within <N>d
   * --prune` scoped to this backup's tags/host. Physical engines (wal-g /
   * pgbackrest) manage their own base-backup chains and are not pruned via
   * restic. Absent = keep forever. Additive — older agents ignore it.
   */
  retentionDays: z.number().int().min(1).max(3650).optional(),
  ...engineEnv,
});
export const DbBackupMsg = z.object({
  type: z.literal('dbBackup'),
  payload: DbBackupPayload,
});
export type DbBackupMsg = z.infer<typeof DbBackupMsg>;
export type DbBackupPayload = z.infer<typeof DbBackupPayload>;

// ── db.restore ───────────────────────────────────────────────────────────────

/**
 * Restore modes:
 *  - `clone-to-new-cluster` — restore the logical dump into a fresh, empty target
 *    (conn points at the new cluster); safe, non-destructive.
 *  - `in-place` — restore into the existing primary (clean+recreate objects).
 *  - `single-database` — restore just one database from a cluster dump.
 *  - `pitr` — physical point-in-time recovery to `targetTime` (wal-g/pgbackrest).
 */
export const DbRestoreMode = z.enum(['clone-to-new-cluster', 'in-place', 'pitr', 'single-database']);
export type DbRestoreMode = z.infer<typeof DbRestoreMode>;

/** A pitr aside suffix: letters, digits and dashes (it becomes a path segment). */
export const PITR_STAMP_RE = /^[0-9A-Za-z-]{1,40}$/;

export const DbRestorePayload = z.object({
  ...cmd,
  engine: DbBackupEngine,
  mode: DbRestoreMode,
  conn: DbConnection,
  repo: ResticRepo,
  /** restic snapshot id (logical) or physical backup name; `latest` by default. */
  snapshotId: SnapshotRef.default('latest'),
  /** pitr: ISO-8601 recovery target time. */
  targetTime: IsoTimestamp.optional(),
  /** single-database: which database to extract/restore. */
  database: DbName.optional(),
  tags: z.array(z.string()).default([]),
  /**
   * pitr (additive, slice A2): `restore_command` the agent stages into
   * `postgresql.auto.conf` alongside the recovery target, so the restarted
   * server replays archived WAL from the same wal-g prefix the per-cluster
   * wal-shipper pushed segments to (see {@link PITR_RESTORE_COMMAND}). Older
   * agents ignore it (zod strips unknown keys) — the base backup still restores.
   */
  restoreCommand: z.string().optional(),
  /**
   * pitr (additive, QA-087): the suffix of the pre-restore copy. The agent
   * moves the target's PGDATA ASIDE to `<PGDATA>.pre-pitr-<stamp>` (kept,
   * never deleted) before the fetch. The controller picks the stamp, so it can
   * ask for a rollback later.
   */
  pitrStamp: z.string().regex(PITR_STAMP_RE, 'invalid pitr stamp').optional(),
  /**
   * pitr (additive, QA-087): `restore` (the default) stages the recovery.
   * `rollback` puts `<PGDATA>.pre-pitr-<stamp>` back in place of a restore
   * that did not recover. The target must be stopped for both.
   */
  pitrAction: z.enum(['restore', 'rollback']).optional(),
  ...engineEnv,
});
export const DbRestoreMsg = z.object({
  type: z.literal('dbRestore'),
  payload: DbRestorePayload,
});
export type DbRestoreMsg = z.infer<typeof DbRestoreMsg>;
export type DbRestorePayload = z.infer<typeof DbRestorePayload>;

// ── result shapes (carried in CommandResultPayload.result) ────────────────────

export const DbBackupResult = z.object({
  /** restic snapshot id (logical) or the engine's backup name (physical). */
  snapshotId: z.string(),
  engine: DbBackupEngine,
  sizeBytes: z.number().int().nonnegative().default(0),
  /** databases captured (pg_dumpall lists all; pg_dump lists the one). */
  databases: z.array(z.string()).default([]),
  durationMs: z.number().int().nonnegative().optional(),
  /** Present only when the payload carried `retentionDays` (logical engines). */
  retention: RetentionOutcome.optional(),
});
export type DbBackupResult = z.infer<typeof DbBackupResult>;

export const DbRestoreResult = z.object({
  mode: DbRestoreMode,
  engine: DbBackupEngine,
  database: z.string().optional(),
  bytesRestored: z.number().int().nonnegative().default(0),
  /** pitr: the recovery target actually applied. */
  recoveredTo: z.string().optional(),
  /** pitr: the base backup that was fetched. */
  backupName: z.string().optional(),
  /** pitr: where the pre-restore PGDATA was kept (absent when there was none). */
  asidePath: z.string().optional(),
  durationMs: z.number().int().nonnegative().optional(),
});
export type DbRestoreResult = z.infer<typeof DbRestoreResult>;

export const DbBackupListResult = z.object({
  snapshots: z.array(ResticSnapshotInfo).default([]),
});
export type DbBackupListResult = z.infer<typeof DbBackupListResult>;

// ── PITR / WAL-archiving wire constants (slice A2 — appended, additive only) ──
// Shared by the controller (manageddb.service), the manageddb-reconcile worker
// and the agent so archive/ship/restore all agree on paths and commands.

/** Where the WAL-archive Docker volume mounts inside the primary + wal-shipper. */
export const WAL_ARCHIVE_MOUNT = '/wal-archive';

/**
 * Postgres `archive_command` staged onto a PITR-enabled primary: copy each
 * finished WAL segment into the archive volume (idempotent: never overwrite).
 * The per-cluster wal-shipper sidecar then `wal-g wal-push`es and deletes it.
 *
 * The copy is ATOMIC: it goes to a hidden `.<seg>.tmp` and is renamed into
 * place (same directory, so rename(2)). The shipper's `*` glob skips dotfiles,
 * so it can never push, and then delete, a half-copied segment. A plain `cp`
 * to the final name could, and that left a truncated segment in S3 that breaks
 * recovery without any error. A leftover `.tmp` from a crash is overwritten on
 * the retry.
 */
export const PITR_ARCHIVE_COMMAND =
  `test ! -f ${WAL_ARCHIVE_MOUNT}/%f && cp %p ${WAL_ARCHIVE_MOUNT}/.%f.tmp && mv ${WAL_ARCHIVE_MOUNT}/.%f.tmp ${WAL_ARCHIVE_MOUNT}/%f`;

/**
 * Canonical `restore_command` for a PITR restore: fetch replayed WAL back out
 * of the wal-g S3 prefix (the wal-shipper's push target). Rides
 * `DbRestorePayload.restoreCommand` so recovery actually replays WAL up to
 * `targetTime` instead of stopping at the base backup.
 */
export const PITR_RESTORE_COMMAND = 'wal-g wal-fetch "%f" "%p"';

/** Extended Postgres conf a PITR-enabled primary mounts (Docker config). */
export function pitrExtraConf(): string {
  return `archive_mode = on\narchive_command = '${PITR_ARCHIVE_COMMAND}'\n`;
}

/** Where the extended conf mounts in a managed member (included by swarmy's boot layer). */
export { MANAGED_PG_PITR_CONF_TARGET, MANAGED_PG_PGDATA_SUBDIR } from '../manageddb-pg';
