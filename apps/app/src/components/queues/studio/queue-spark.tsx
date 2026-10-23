import * as React from 'react';
import { useQuery } from '@tanstack/react-query';
import { Sparkline } from '@swarmy/ui';
import { useTRPC } from '@/integrations/trpc';
import { perMinute, type StudioRef } from './studio-types';

/**
 * A queue's done/min over the last 6 h, for its row in the queue list. Same
 * query as the detail chart's default window, so the selected queue's is shared.
 * Nothing until there are two samples (no flat fake line).
 */
export function QueueSpark({ studio, queue }: { studio: StudioRef; queue: string }): React.JSX.Element | null {
  const trpc = useTRPC();
  const rates = useQuery({
    ...trpc.queues.studioRates.queryOptions({ ...studio, queue, windowMinutes: 360 }),
    refetchInterval: 60_000,
    retry: false,
  });
  if (rates.data?.status !== 'ok' || rates.data.points.length < 2) return null;
  const done = perMinute(rates.data.points).map((p) => p.throughput);
  return (
    <div className="w-16 shrink-0" aria-hidden title="done/min · last 6 h">
      <Sparkline data={done} height={22} color="var(--color-status-online)" />
    </div>
  );
}
