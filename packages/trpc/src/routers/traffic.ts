import { TrafficSeriesInput } from '@swarmy/core';
import { orgProcedure, router } from '../trpc';
import { trafficNow } from '../services/traffic.service';
import { trafficSeries } from '../services/traffic-series';

/**
 * Per-edge request counting (Q4). Numbers and units only (requests/min);
 * plain-words phrasing is the UI's. "No data yet" is null + a state, never 0.
 */
export const trafficRouter = router({
  /** Per region (with its edges), per app, per host and totals over the last 5 minutes, with p50/p95 and blocked a minute. */
  now: orgProcedure.query(({ ctx }) => trafficNow(ctx)),
  /** Sparkline buckets (req/min, 5xx, blocked, p50/p95) for an app, region, address or edge over 6h / 24h / 7d. */
  series: orgProcedure.input(TrafficSeriesInput).query(({ ctx, input }) => trafficSeries(ctx, input)),
});
