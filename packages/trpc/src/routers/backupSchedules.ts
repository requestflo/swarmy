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
  setScheduleSecondary,
} from '../services/backupSchedule.service';

const unit = z.enum(['minutes', 'hours', 'days']);

/** Optional stack scope: volumes belong to a stack by `<stack>_` name prefix. */
const stackScope = z.object({ stack: z.string().optional() }).optional();

export const backupSchedulesRouter = router({
  list: orgProcedure.input(stackScope).query(({ ctx, input }) => listSchedules(ctx, input)),
  listRestores: orgProcedure
    .input(stackScope)
    .query(({ ctx, input }) => listRestoreOperations(ctx, input)),

  create: adminProcedure
    .input(
      z.object({
        targetId: z.string(),
        /** Optional second destination every run also copies to. */
        secondaryTargetId: z.string().nullish(),
        volume: z.string().min(1),
        nodeId: z.string().optional(),
        every: z.number().int().positive(),
        unit,
      }),
    )
    .mutation(({ ctx, input }) => createSchedule(ctx, input)),

  setSecondary: adminProcedure
    .input(z.object({ id: z.string(), secondaryTargetId: z.string().nullable() }))
    .mutation(({ ctx, input }) => setScheduleSecondary(ctx, input)),

  setPaused: adminProcedure
    .input(z.object({ id: z.string(), paused: z.boolean() }))
    .mutation(({ ctx, input }) => setSchedulePaused(ctx, input)),

  remove: adminProcedure
    .input(z.object({ id: z.string() }))
    .mutation(({ ctx, input }) => removeSchedule(ctx, input.id)),
});
