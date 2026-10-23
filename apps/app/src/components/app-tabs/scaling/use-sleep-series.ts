import * as React from 'react';
import { useQuery } from '@tanstack/react-query';
import type { InvService } from '@swarmy/core';
import { useTRPC } from '@/integrations/trpc';
import { SERIES_BUCKET_SEC, otelServiceName, toCallBuckets, yesterdayWindow } from './series-model';
import type { CallBucket } from './sleep-sim';

export type SleepSeries =
  | { status: 'pending' }
  | { status: 'disabled' | 'unreachable' }
  | { status: 'ok'; from: number; to: number; bucketMs: number; buckets: CallBucket[] };

/**
 * Yesterday's requests for one service, in 5-minute buckets, from
 * `observability.requestSeries` (stack + the service's span name). The
 * window is fixed per mount so the query key stays put between renders.
 */
export function useSleepSeries(stack: string, inv: InvService | undefined): SleepSeries {
  const trpc = useTRPC();
  const [now] = React.useState(() => Date.now());
  const w = yesterdayWindow(now);
  const q = useQuery({
    ...trpc.observability.requestSeries.queryOptions({
      stack,
      service: inv ? otelServiceName(inv) : '',
      windowMinutes: w.windowMinutes,
      bucketSeconds: SERIES_BUCKET_SEC,
    }),
    enabled: !!inv,
    staleTime: 5 * 60_000,
  });
  if (q.isError) return { status: 'unreachable' };
  if (!q.data) return { status: 'pending' };
  if (q.data.status !== 'ok') return { status: q.data.status };
  return { status: 'ok', from: w.from, to: w.to, bucketMs: SERIES_BUCKET_SEC * 1000, buckets: toCallBuckets(q.data.points) };
}
