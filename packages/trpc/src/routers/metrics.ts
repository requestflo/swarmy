import { z } from 'zod';
import { MetricKind, TimeRange } from '@swarmy/core';
import { orgProcedure, router } from '../trpc';
import {
  getOverview,
  getTimeseries,
  getTopConsumers,
} from '../services/metrics.service';

export const metricsRouter = router({
  overview: orgProcedure.query(({ ctx }) => getOverview(ctx)),

  timeseries: orgProcedure
    .input(
      z.object({
        nodeId: z.string().optional(),
        serviceId: z.string().optional(),
        containerId: z.string().optional(),
        metric: MetricKind.default('cpu'),
        range: TimeRange.default('1h'),
      }),
    )
    .query(({ ctx, input }) => getTimeseries(ctx, input)),

  topConsumers: orgProcedure
    .input(
      z.object({
        metric: MetricKind.default('cpu'),
        limit: z.number().int().min(1).max(50).default(5),
      }),
    )
    .query(({ ctx, input }) => getTopConsumers(ctx, input)),

  overviewLive: orgProcedure.subscription(async function* ({ ctx, signal }) {
    const ac = signal ?? new AbortController().signal;
    while (!ac.aborted) {
      yield await getOverview(ctx);
      await new Promise((r) => setTimeout(r, 2000));
    }
  }),
});
