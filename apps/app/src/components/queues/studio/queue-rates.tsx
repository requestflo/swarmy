import * as React from 'react';
import { useQuery } from '@tanstack/react-query';
import { useTRPC } from '@/integrations/trpc';
import { AreaTrend } from '@/components/charts';
import { Segmented } from '@/components/domains/segmented';
import { perMinute, type StudioRef } from './studio-types';

const WINDOWS = [
  { value: '60', label: '1 h' },
  { value: '360', label: '6 h' },
  { value: '1440', label: '24 h' },
] as const;
type Window = (typeof WINDOWS)[number]['value'];

/** Done/failed per minute over the last 1, 6 or 24 hours (needs Observability for history). */
export function QueueRates({ studio, queue }: { studio: StudioRef; queue: string }): React.JSX.Element | null {
  const trpc = useTRPC();
  const [win, setWin] = React.useState<Window>('360');
  const rates = useQuery({
    ...trpc.queues.studioRates.queryOptions({ ...studio, queue, windowMinutes: Number(win) }),
    refetchInterval: 30_000,
    retry: false,
  });
  const series = perMinute(rates.data?.points ?? []);
  const label = WINDOWS.find((w) => w.value === win)?.label ?? '';
  if (rates.data?.status === 'disabled') {
    return <p className="text-muted-foreground text-[11px]">Turn on Observability to keep throughput and failure-rate history.</p>;
  }
  if (rates.data?.status !== 'ok' || series.length < 2) return null;
  return (
    <div>
      <div className="mb-1 flex flex-wrap items-center justify-between gap-2">
        <p className="mono-label text-muted-foreground !mb-0">Last {label} · jobs/min</p>
        <Segmented mono label="Rate window" value={win} onChange={setWin} options={[...WINDOWS]} />
      </div>
      <AreaTrend
        data={series}
        height={140}
        series={[
          { key: 'throughput', label: 'done/min', color: 'var(--color-status-online)' },
          { key: 'failures', label: 'failed/min', color: 'var(--color-status-offline)' },
        ]}
      />
    </div>
  );
}
