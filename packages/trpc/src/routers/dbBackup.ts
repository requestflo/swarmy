import { z } from 'zod';
import { DbBackupEngine, DbRestoreMode } from '@swarmy/core/protocol';
import { orgProcedure, router } from '../trpc';
import { backupDb, listDbBackups, restoreDb } from '../services/dbBackup.service';

/**
 * DB-aware backups: logical (pg_dump / pg_dumpall / snapshot-from-replica) and
 * physical (wal-g / pgbackrest) backups of a managed Postgres cluster, plus the
 * richer restore modes (clone / in-place / single-database / pitr). Targets are
 * the same org-scoped `BackupTarget`s used by volume backups.
 */
export const dbBackupRouter = router({
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

  list: orgProcedure
    .input(
      z.object({
        targetId: z.string().min(1),
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
        targetId: z.string().min(1),
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
