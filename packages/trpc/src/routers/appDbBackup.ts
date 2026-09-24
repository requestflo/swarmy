import { z } from 'zod';
import { AppDbRestoreMode } from '@swarmy/core/protocol';
import { orgProcedure, router } from '../trpc';
import { abacProcedure } from '../abac';
import { listAppDbBackups, restoreAppDb, runAppDbBackup } from '../services/appDbBackup.service';

const ref = { stack: z.string().min(1), service: z.string().min(1) };

/**
 * Logical backups of compose databases (MySQL/MariaDB/Mongo/Redis/Valkey),
 * mounted as `backups.appDb`. Listing and "back up now" are ordinary org
 * operations (non-destructive); restore is `data.restore` on the policy gate
 * in BOTH modes, and in-place additionally needs the service name typed back.
 */
export const appDbBackupRouter = router({
  list: orgProcedure
    .input(z.object({ ...ref, targetId: z.string().optional() }))
    .query(({ ctx, input }) => listAppDbBackups(ctx, input)),

  backupNow: orgProcedure
    .input(z.object({ ...ref, targetId: z.string().optional() }))
    .mutation(({ ctx, input }) => runAppDbBackup(ctx, { ...input, reason: 'manual' })),

  restore: abacProcedure('data.restore')
    .input(
      z.object({
        ...ref,
        snapshotId: z.string().min(1).max(128).regex(/^[A-Za-z0-9]+$/),
        mode: AppDbRestoreMode.default('copy'),
        confirm: z.string().optional(),
        targetId: z.string().optional(),
      }),
    )
    .mutation(({ ctx, input }) => restoreAppDb(ctx, input)),
});
