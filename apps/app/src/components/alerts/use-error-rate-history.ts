import * as React from 'react';
import { useQueries, useQuery } from '@tanstack/react-query';
import { UNGROUPED, type AlertSelector } from '@swarmy/core';
import { useTRPC } from '@/integrations/trpc';
import { ERROR_RATE_MIN_CALLS, ERROR_RATE_STEP_SECONDS, errorRateValues, gridEndingAt } from './rule-backtest';
import type { BacktestSource } from './use-rule-backtest';

/** More parts than this and an any-app rule asks for one app instead of a dozen week-long reads. */
const MAX_PARTS = 12;
const WEEK_MIN = 7 * 24 * 60;
const STALE = 5 * 60_000;

interface Part {
  app: string;
  /** The Docker service (= OTEL service) name, `<app>_<part>`. */
  service: string;
  label: string;
}

/**
 * The parts an error-rate rule watches, each with a week of requests in
 * 5-minute buckets (`observability.requestSeries`). The evaluator checks every
 * part on its own, so the replay does too.
 */
export function useErrorRateHistory(on: boolean, selector: AlertSelector): BacktestSource {
  const trpc = useTRPC();
  const inventory = useQuery({ ...trpc.inventory.get.queryOptions(), enabled: on });
  const parts = React.useMemo<Part[]>(() => {
    const { app, service } = selector;
    if (app && service) return [{ app, service: `${app}_${service}`, label: `${app} / ${service}` }];
    return (inventory.data?.services ?? [])
      .filter((s) => s.stack && s.stack !== UNGROUPED && s.stack !== 'swarmy-system' && (!app || s.stack === app))
      .map((s) => {
        const part = s.name.startsWith(`${s.stack}_`) ? s.name.slice(s.stack.length + 1) : s.name;
        return { app: s.stack, service: `${s.stack}_${part}`, label: `${s.stack} / ${part}` };
      });
  }, [inventory.data, selector]);
  const over = parts.length > MAX_PARTS;
  const results = useQueries({
    queries: (on && !over ? parts : []).map((p) => ({
      ...trpc.observability.requestSeries.queryOptions({ stack: p.app, service: p.service, windowMinutes: WEEK_MIN, bucketSeconds: ERROR_RATE_STEP_SECONDS }),
      staleTime: STALE,
      refetchInterval: STALE,
    })),
  });
  const target = selector.app ? (selector.service ? `${selector.app} / ${selector.service}` : selector.app) : 'your apps';

  if (!on) return { state: 'none', why: '' };
  if (over) return { state: 'empty', why: `Pick an app to replay this rule: any app means ${parts.length} parts, more than swarmy replays at once.` };
  if ((!(selector.app && selector.service) && inventory.isPending) || results.some((r) => r.isPending)) return { state: 'pending' };
  if (parts.length === 0) return { state: 'empty', why: `Nothing of ${target} is running, so there are no requests to replay.` };
  if (results.some((r) => r.data?.status === 'disabled')) return { state: 'empty', why: `Logs & traces are off for ${target}, so swarmy has no requests to replay.` };
  if (results.some((r) => r.data?.status === 'unreachable' || r.isError)) return { state: 'empty', why: 'The telemetry store isn’t answering, so there’s nothing to replay right now.' };

  const grid = gridEndingAt(Math.max(...results.map((r) => r.dataUpdatedAt)), ERROR_RATE_STEP_SECONDS);
  const subjects = parts.map((p, i) => ({ name: p.label, values: errorRateValues(results[i]?.data?.points ?? [], grid) }));
  if (!subjects.some((s) => s.values.some((v) => v !== null))) {
    return { state: 'empty', why: `${target} never had ${ERROR_RATE_MIN_CALLS}+ traced requests in 5 minutes this week, so there’s nothing to replay.` };
  }
  return {
    state: 'ready',
    grid,
    subjects,
    tech: `observability.requestSeries · ${parts.length === 1 ? parts[0]!.service : `${parts.length} parts`} · entry spans in 5-minute buckets, ${ERROR_RATE_MIN_CALLS}+ calls · the live check counts every span`,
  };
}
