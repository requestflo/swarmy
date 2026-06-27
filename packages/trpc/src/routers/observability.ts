import { z } from 'zod';
import { adminProcedure, orgProcedure, router } from '../trpc';
import {
  enableForStack,
  getConfig,
  getStatus,
  metricsSeries,
  setEnabled,
  setRetention,
  traces,
} from '../services/observability.service';

export const observabilityRouter = router({
  getConfig: orgProcedure.query(({ ctx }) => getConfig(ctx)),

  status: orgProcedure.query(({ ctx }) => getStatus(ctx)),

  setEnabled: adminProcedure
    .input(z.object({ enabled: z.boolean() }))
    .mutation(({ ctx, input }) => setEnabled(ctx, input.enabled)),

  setRetention: adminProcedure
    .input(z.object({ retentionDays: z.number().int().min(1).max(365) }))
    .mutation(({ ctx, input }) => setRetention(ctx, input.retentionDays)),

  enableForStack: adminProcedure
    .input(z.object({ stackId: z.string(), enabled: z.boolean() }))
    .mutation(({ ctx, input }) => enableForStack(ctx, input)),

  traces: orgProcedure
    .input(
      z.object({
        service: z.string().optional(),
        stack: z.string().optional(),
        minDurationMs: z.number().nonnegative().optional(),
        errorsOnly: z.boolean().optional(),
        windowMinutes: z.number().int().min(1).max(60 * 24 * 7).optional(),
        limit: z.number().int().min(1).max(500).optional(),
      }),
    )
    .query(({ ctx, input }) => traces(ctx, input)),

  metricsSeries: orgProcedure
    .input(
      z.object({
        metric: z.string().min(1),
        service: z.string().optional(),
        stack: z.string().optional(),
        windowMinutes: z.number().int().min(1).max(60 * 24 * 7).optional(),
        bucketSeconds: z.number().int().min(5).max(3600).optional(),
      }),
    )
    .query(({ ctx, input }) => metricsSeries(ctx, input)),
});
