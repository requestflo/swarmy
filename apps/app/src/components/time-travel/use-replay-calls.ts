import * as React from 'react';
import { useQuery } from '@tanstack/react-query';
import type { ServiceMapEdgeView } from '@swarmy/core';
import { useTRPC } from '@/integrations/trpc';

/** The traces' look-back for the replay's lines. */
export const CALLS_WINDOW_MIN = 15;

export interface ReplayCallsData {
  edges: readonly ServiceMapEdgeView[];
  /** The window's end (ms): the head, to the minute. Null while the head moves or before an answer. */
  until: number | null;
}

/** The value once it has stayed put for `ms` (a dragged head asks once, where it stops). */
function useSettled<T>(value: T, ms: number): T {
  const [settled, setSettled] = React.useState(value);
  React.useEffect(() => {
    const t = setTimeout(() => setSettled(value), ms);
    return () => clearTimeout(t);
  }, [value, ms]);
  return settled;
}

/**
 * Who called whom in the minutes before the head (`observability.map` with
 * `until`; the live map when the head is now). Empty while telemetry is off,
 * the store can't be reached, or the traces of that moment have aged out.
 */
export function useReplayCalls(at: number, live: boolean): ReplayCallsData {
  const trpc = useTRPC();
  const minute = useSettled(live ? null : Math.floor(at / 60_000) * 60_000, 400);
  const map = useQuery({
    ...trpc.observability.map.queryOptions({
      windowMinutes: CALLS_WINDOW_MIN,
      ...(minute !== null ? { until: new Date(minute).toISOString() } : {}),
    }),
    staleTime: live ? 15_000 : 5 * 60_000,
    refetchInterval: live ? 30_000 : false,
  });
  const ok = map.data?.status === 'ok' && (live || minute !== null);
  return { edges: ok ? map.data!.edges : [], until: ok ? (minute ?? Date.now()) : null };
}
