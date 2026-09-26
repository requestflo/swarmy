import { TrafficSeriesInput } from '@swarmy/core';
import { orgProcedure, router } from '../trpc';
import { trafficNow, trafficSeries } from '../services/traffic.service';

/**
 * Per-edge request counting (Q4). Numbers and units only (requests/min);
 * plain-words phrasing is the UI's. "No data yet" is null + a state, never 0.
 */
export const trafficRouter = router({
  /** Per region (with its edges), per app and totals over the last 5 minutes. */
  now: orgProcedure.query(({ ctx }) => trafficNow(ctx)),
  /** Sparkline buckets for an app and/or region over 6h / 24h / 7d. */
  series: orgProcedure.input(TrafficSeriesInput).query(({ ctx, input }) => trafficSeries(ctx, input)),
});
