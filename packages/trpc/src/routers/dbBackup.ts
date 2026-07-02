import { z } from 'zod';
import { RunDbBackupInput, SetDbBackupScheduleInput } from '@swarmy/core';
import { DbBackupEngine, DbRestoreMode } from '@swarmy/core/protocol';
import { orgProcedure, router } from '../trpc';
import {
  backupDb,
  dbBackupOverview,
  getDbBackupSchedule,
  listDbBackups,
  restoreDb,
  runDbBackup,
  setDbBackupSchedule,
} from '../services/dbBackup.service';

/**
 * DB-aware backups (slice A1): logical (pg_dump / pg_dumpall /
 * snapshot-from-replica) and physical (wal-g / pgbackrest) backups of a managed
 * Postgres cluster, the recurring schedule (Docker truth — the
 * `swarmy.db.backup.schedule` label on the cluster primary), the org-wide
 * coverage overview, and the richer restore modes (clone / in-place /
 * single-database / pitr). Destinations are the same org-scoped `BackupTarget`s
 * used by volume backups.
 */
export const dbBackupRouter = router({
  /** Org-wide coverage: every managed cluster with schedule + last backup + PITR window. */
  overview: orgProcedure.query(({ ctx }) => dbBackupOverview(ctx)),

  /** The cluster's recurring-backup schedule, or null when none is set. */
  getSchedule: orgProcedure
    .input(z.object({ stack: z.string().min(1), cluster: z.string().min(1) }))
    .query(({ ctx, input }) => getDbBackupSchedule(ctx, input)),

  /** Enable/replace (or, with enabled:false, clear) the cluster's schedule label. */
  setSchedule: orgProcedure
    .input(SetDbBackupScheduleInput)
    .mutation(({ ctx, input }) => setDbBackupSchedule(ctx, input)),

  /** "Back up now" — omitted fields default from the cluster's schedule label. */
  run: orgProcedure.input(RunDbBackupInput).mutation(({ ctx, input }) => runDbBackup(ctx, input)),

  backup: orgProcedure
    .input(
      z.object({
        stack: z.string().min(1),
        cluster: z.string().min(1),
        engine: DbBackupEngine,
        targetId: z.string().min(1),
        database: z.string().optional(),
        dataVolume: z.string().optional(),
      }),
    )
    .mutation(({ ctx, input }) => backupDb(ctx, input)),

  /** Catalog of DB backups; destination defaults from the schedule / first target. */
  list: orgProcedure
    .input(
      z.object({
        targetId: z.string().optional(),
        stack: z.string().optional(),
        cluster: z.string().optional(),
      }),
    )
    .query(({ ctx, input }) => listDbBackups(ctx, input)),

  restore: orgProcedure
    .input(
      z.object({
        stack: z.string().min(1),
        cluster: z.string().min(1),
        engine: DbBackupEngine,
        mode: DbRestoreMode,
        targetId: z.string().optional(),
        snapshotId: z.string().optional(),
        targetTime: z.string().optional(),
        database: z.string().optional(),
        targetStack: z.string().optional(),
        targetCluster: z.string().optional(),
        dataVolume: z.string().optional(),
      }),
    )
    .mutation(({ ctx, input }) => restoreDb(ctx, input)),
});
