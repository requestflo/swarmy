/**
 * Backup schedules + DR restore-ops router (epic: volumes-dr, P2).
 */
import { z } from 'zod';
import { adminProcedure, orgProcedure, router } from '../trpc';
import {
  createSchedule,
  listRestoreOperations,
  listSchedules,
  removeSchedule,
  setSchedulePaused,
} from '../services/backupSchedule.service';

const unit = z.enum(['minutes', 'hours', 'days']);

export const schedulesRouter = router({
  list: orgProcedure.query(({ ctx }) => listSchedules(ctx)),
  listRestores: orgProcedure.query(({ ctx }) => listRestoreOperations(ctx)),

  create: adminProcedure
    .input(
      z.object({
        targetId: z.string(),
        volume: z.string().min(1),
        nodeId: z.string().optional(),
        every: z.number().int().positive(),
        unit,
      }),
    )
    .mutation(({ ctx, input }) => createSchedule(ctx, input)),

  setPaused: adminProcedure
    .input(z.object({ id: z.string(), paused: z.boolean() }))
    .mutation(({ ctx, input }) => setSchedulePaused(ctx, input)),

  remove: adminProcedure
    .input(z.object({ id: z.string() }))
    .mutation(({ ctx, input }) => removeSchedule(ctx, input.id)),
});
