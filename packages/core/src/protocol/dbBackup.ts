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
import { ResticRepo } from './backup';
import { ResticSnapshotInfo } from './backup';

/** Reusable command preamble (every controller→agent command carries these). */
const cmd = { commandId: CommandId, timeoutMs: z.number().int().positive().optional() };

/** Pinned default images for the DB engines. */
export const DEFAULT_PG_CLIENT_IMAGE = 'bitnami/postgresql:16';
export const DEFAULT_WALG_IMAGE = 'ghcr.io/wal-g/wal-g:v3.0.3';
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

export function isLogicalEngine(e: DbBackupEngine): boolean {
  return e === 'pg_dump' || e === 'pg_dumpall' || e === 'snapshot-from-replica';
}
export function isPhysicalEngine(e: DbBackupEngine): boolean {
  return e === 'wal-g' || e === 'pgbackrest';
}

/**
 * A one-shot Postgres connection. The password is resolved just-in-time by the
 * controller (read from live Docker service env) and only becomes `PGPASSWORD`
 * inside the sidecar container.
 */
export const DbConnection = z.object({
  host: z.string(),
  port: z.number().int().positive().default(5432),
  user: z.string().default('postgres'),
  password: z.string(),
  database: z.string().default('app'),
});
export type DbConnection = z.infer<typeof DbConnection>;

/** Common image/network knobs shared by db.backup and db.restore. */
const engineEnv = {
  /** Overlay network to attach the sidecar to so it can resolve `conn.host`. */
  network: z.string().optional(),
  /** postgres-client image (pg_dump/pg_dumpall/snapshot/pg_restore/psql). */
  clientImage: z.string().optional(),
  /** physical-engine image (wal-g / pgbackrest). */
  engineImage: z.string().optional(),
  /** restic image for the logical dump→repo store leg. */
  resticImage: z.string().optional(),
  /** physical engines: the primary's PGDATA Docker volume (base backup source). */
  dataVolume: z.string().optional(),
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

export const DbRestorePayload = z.object({
  ...cmd,
  engine: DbBackupEngine,
  mode: DbRestoreMode,
  conn: DbConnection,
  repo: ResticRepo,
  /** restic snapshot id (logical) or physical backup name; `latest` by default. */
  snapshotId: z.string().default('latest'),
  /** pitr: ISO-8601 recovery target time. */
  targetTime: z.string().optional(),
  /** single-database: which database to extract/restore. */
  database: z.string().optional(),
  tags: z.array(z.string()).default([]),
  /**
   * pitr (additive, slice A2): `restore_command` the agent stages into
   * `postgresql.auto.conf` alongside the recovery target, so the restarted
   * server replays archived WAL from the same wal-g prefix the per-cluster
   * wal-shipper pushed segments to (see {@link PITR_RESTORE_COMMAND}). Older
   * agents ignore it (zod strips unknown keys) — the base backup still restores.
   */
  restoreCommand: z.string().optional(),
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
});
export type DbBackupResult = z.infer<typeof DbBackupResult>;

export const DbRestoreResult = z.object({
  mode: DbRestoreMode,
  engine: DbBackupEngine,
  database: z.string().optional(),
  bytesRestored: z.number().int().nonnegative().default(0),
  /** pitr: the recovery target actually applied. */
  recoveredTo: z.string().optional(),
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
 * finished WAL segment into the archive volume (idempotent — never overwrite).
 * The per-cluster wal-shipper sidecar then `wal-g wal-push`es and deletes it.
 */
export const PITR_ARCHIVE_COMMAND = `test ! -f ${WAL_ARCHIVE_MOUNT}/%f && cp %p ${WAL_ARCHIVE_MOUNT}/%f`;

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

/** Where the extended conf mounts in a bitnami/postgresql container. */
export const BITNAMI_PITR_CONF_TARGET = '/bitnami/postgresql/conf/conf.d/swarmy-pitr.conf';

/** bitnami paths for a replica→primary promotion (`pg_ctl promote`). */
export const BITNAMI_PG_CTL = '/opt/bitnami/postgresql/bin/pg_ctl';
export const BITNAMI_PGDATA = '/bitnami/postgresql/data';
