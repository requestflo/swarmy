import * as React from 'react';
import { useQuery } from '@tanstack/react-query';
import { useTRPC } from '@/integrations/trpc';
import { AreaTrend } from '@/components/charts';
import type { StudioRef } from './studio-types';

/** The last hour's done/failed per minute (needs Observability for history). */
export function QueueRates({ studio, queue }: { studio: StudioRef; queue: string }): React.JSX.Element | null {
  const trpc = useTRPC();
  const rates = useQuery({
    ...trpc.queues.studioRates.queryOptions({ ...studio, queue, windowMinutes: 60 }),
    refetchInterval: 30_000,
    retry: false,
  });
  const series = (rates.data?.points ?? []).map((p) => ({
    t: p.bucket,
    throughput: p.seconds > 0 ? Math.round((p.completed / p.seconds) * 60 * 10) / 10 : 0,
    failures: p.seconds > 0 ? Math.round((p.failed / p.seconds) * 60 * 10) / 10 : 0,
  }));
  return (
    <>
      {rates.data?.status === 'ok' && series.length > 1 ? (
        <div>
          <p className="mono-label text-muted-foreground !mb-1">Last hour · jobs/min</p>
          <AreaTrend
            data={series}
            height={140}
            series={[
              { key: 'throughput', label: 'done/min', color: 'var(--color-status-online)' },
              { key: 'failures', label: 'failed/min', color: 'var(--color-status-offline)' },
            ]}
          />
        </div>
      ) : rates.data?.status === 'disabled' ? (
        <p className="text-muted-foreground text-[11px]">
          Turn on Observability to keep throughput and failure-rate history.
        </p>
      ) : null}
    </>
  );
}
