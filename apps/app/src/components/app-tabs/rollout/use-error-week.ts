import * as React from 'react';
import { useQuery } from '@tanstack/react-query';
import { ERROR_RATE_MIN_CALLS, ERROR_RATE_STEP_SECONDS, errorRateValues, gridEndingAt, type BacktestGrid } from '@/components/alerts/rule-backtest';
import { useTRPC } from '@/integrations/trpc';
import { shippedVersions, type Shipped } from './catch-model';

export type ErrorWeek =
  | { state: 'pending' }
  | { state: 'empty'; why: string }
  | { state: 'ready'; grid: BacktestGrid; values: Array<number | null>; shipped: Shipped[]; tech: string };

const WEEK_MIN = 7 * 24 * 60;
const STALE = 5 * 60_000;

/**
 * A week of one part's requests (`observability.requestSeries`, 5-minute
 * buckets, the alert evaluator's 20-call floor) and the app's releases
 * (`releases.list`) — what the canary's error ceiling is replayed over.
 */
export function useErrorWeek(stack: string, part: string): ErrorWeek {
  const trpc = useTRPC();
  const service = `${stack}_${part}`;
  const series = useQuery({
    ...trpc.observability.requestSeries.queryOptions({ stack, service, windowMinutes: WEEK_MIN, bucketSeconds: ERROR_RATE_STEP_SECONDS }),
    staleTime: STALE,
    refetchInterval: STALE,
  });
  const releases = useQuery({ ...trpc.releases.list.queryOptions({ stackName: stack, limit: 100 }), refetchInterval: 30_000 });
  const data = series.data;
  const grid = React.useMemo(() => gridEndingAt(series.dataUpdatedAt || Date.now(), ERROR_RATE_STEP_SECONDS), [series.dataUpdatedAt]);
  const values = React.useMemo(() => (data?.status === 'ok' ? errorRateValues(data.points, grid) : null), [data, grid]);
  const shipped = React.useMemo(() => (releases.data ? shippedVersions(releases.data, part) : null), [releases.data, part]);

  if (series.isPending || releases.isPending) return { state: 'pending' };
  if (data?.status === 'disabled') return { state: 'empty', why: `Logs & traces are off for ${stack}, so there are no requests to replay the ceiling over.` };
  if (series.isError || data?.status === 'unreachable') return { state: 'empty', why: 'The telemetry store isn’t answering, so there’s nothing to replay right now.' };
  if (!values || !values.some((v) => v !== null)) {
    return { state: 'empty', why: `${part} never had ${ERROR_RATE_MIN_CALLS}+ traced requests in 5 minutes this week, so there’s nothing to replay.` };
  }
  return {
    state: 'ready',
    grid,
    values,
    shipped: shipped ?? [],
    tech: `observability.requestSeries · ${service} · entry spans in 5-minute buckets, ${ERROR_RATE_MIN_CALLS}+ calls · releases.list · the canary itself checks its own copy over 15 min`,
  };
}
