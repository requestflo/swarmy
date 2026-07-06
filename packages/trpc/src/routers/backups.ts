import { z } from 'zod';
import { adminProcedure, orgProcedure, router } from '../trpc';
import {
  addTarget,
  backupVolume,
  ensureNativeTarget,
  getStackRetention,
  listRemoteSnapshots,
  listSnapshots,
  listTargets,
  removeTarget,
  restoreSnapshot,
  setStackRetention,
} from '../services/backups.service';

const retentionDays = z.number().int().min(1).max(3650);

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
    .input(
      z.object({
        targetId: z.string(),
        volume: z.string().min(1),
        nodeId: z.string().optional(),
        /** Override the stack's retention label for this one run. */
        retentionDays: retentionDays.optional(),
      }),
    )
    .mutation(({ ctx, input }) => backupVolume(ctx, input)),

  /** The stack's volume-backup retention window (`swarmy.backup.retentionDays`). */
  stackRetention: orgProcedure
    .input(z.object({ stack: z.string().min(1) }))
    .query(({ ctx, input }) => ({
      stack: input.stack,
      retentionDays: getStackRetention(ctx, input.stack),
    })),

  /** Set (or clear with null) the stack's retention window — prunes are audited. */
  setStackRetention: adminProcedure
    .input(z.object({ stack: z.string().min(1), retentionDays: retentionDays.nullable() }))
    .mutation(({ ctx, input }) => setStackRetention(ctx, input)),

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
