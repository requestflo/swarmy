import { z } from 'zod';
import { ObservabilityLogsInput } from '@swarmy/core';
import { adminProcedure, orgProcedure, router } from '../trpc';
// ── logs (C1) service import (kept separate to stay conflict-free with C2) ──
import { logs } from '../services/observability.service';
// ── map+health (C2) imports (kept separate to stay conflict-free with C1) ──
import { ObservabilityHealthInput, ObservabilityMapInput } from '@swarmy/core';
import { serviceMap } from '../services/observability.service';
import { healthNarrative } from '../services/health-summary';
import {
  enableForStack,
  getConfig,
  getStatus,
  metricsSeries,
  metricsSummary,
  setEnabled,
  setRetention,
  stackTelemetryEnabled,
  traceDetail,
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

  /** Per-stack opt-in state, read from the live `swarmy.otel.enabled` labels. */
  stackTelemetry: orgProcedure
    .input(z.object({ stack: z.string() }))
    .query(({ ctx, input }) => ({ enabled: stackTelemetryEnabled(ctx, input.stack) })),

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

  traceDetail: orgProcedure
    .input(z.object({ traceId: z.string().min(1) }))
    .query(({ ctx, input }) => traceDetail(ctx, input)),

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

  metricsSummary: orgProcedure
    .input(
      z.object({
        metric: z.string().min(1),
        stack: z.string().optional(),
        windowMinutes: z.number().int().min(1).max(60 * 24 * 7).optional(),
        limit: z.number().int().min(1).max(200).optional(),
      }),
    )
    .query(({ ctx, input }) => metricsSummary(ctx, input)),

  // ── logs (C1) ── structured logs feed over otel_logs (org-scoped, cursored).
  logs: orgProcedure
    .input(ObservabilityLogsInput)
    .query(({ ctx, input }) => logs(ctx, input)),

  // ── map+health (C2) ── service graph from otel_traces + degraded narrative.
  map: orgProcedure
    .input(ObservabilityMapInput)
    .query(({ ctx, input }) => serviceMap(ctx, input)),

  health: orgProcedure
    .input(ObservabilityHealthInput)
    .query(({ ctx, input }) => healthNarrative(ctx, input)),
});
