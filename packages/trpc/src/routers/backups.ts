import { z } from 'zod';
import { adminProcedure, orgProcedure, router } from '../trpc';
import {
  addTarget,
  backupVolume,
  ensureNativeTarget,
  listRemoteSnapshots,
  listSnapshots,
  listTargets,
  removeTarget,
  restoreSnapshot,
} from '../services/backups.service';

const targetKind = z.enum(['s3', 'node']);

export const backupsRouter = router({
  listTargets: orgProcedure.query(({ ctx }) => listTargets(ctx)),

  addTarget: adminProcedure
    .input(
      z.object({
        name: z.string().min(1),
        kind: targetKind,
        endpoint: z.string().optional(),
        bucket: z.string().min(1),
        prefix: z.string().optional(),
        region: z.string().optional(),
        accessKeyId: z.string().optional(),
        secretAccessKey: z.string().optional(),
        resticPassword: z.string().optional(),
      }),
    )
    .mutation(({ ctx, input }) => addTarget(ctx, input)),

  removeTarget: adminProcedure
    .input(z.object({ id: z.string() }))
    .mutation(({ ctx, input }) => removeTarget(ctx, input.id)),

  /** Find-or-create the managed destination on the in-swarm Garage store. */
  ensureNativeTarget: adminProcedure.mutation(({ ctx }) => ensureNativeTarget(ctx)),

  backupVolume: orgProcedure
    .input(z.object({ targetId: z.string(), volume: z.string().min(1), nodeId: z.string().optional() }))
    .mutation(({ ctx, input }) => backupVolume(ctx, input)),

  listSnapshots: orgProcedure
    .input(
      z
        .object({
          volume: z.string().optional(),
          targetId: z.string().optional(),
          /** Scope to one stack's volumes (`<stack>_*`). No input = estate-wide. */
          stack: z.string().optional(),
        })
        .optional(),
    )
    .query(({ ctx, input }) => listSnapshots(ctx, input)),

  listRemoteSnapshots: orgProcedure
    .input(z.object({ targetId: z.string(), volume: z.string().optional() }))
    .query(({ ctx, input }) => listRemoteSnapshots(ctx, input)),

  restoreSnapshot: orgProcedure
    .input(
      z.object({
        snapshotId: z.string(),
        targetVolume: z.string().optional(),
        nodeId: z.string().optional(),
      }),
    )
    .mutation(({ ctx, input }) => restoreSnapshot(ctx, input)),
});
