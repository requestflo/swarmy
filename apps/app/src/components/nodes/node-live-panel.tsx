import * as React from 'react';
import { ActivityIcon } from 'lucide-react';
import { Card, CardContent, CardHeader, CardTitle } from '@swarmy/ui';
import type { NodeStatsSnapshot } from '@swarmy/core';
import { AreaTrend } from '@/components/charts';
import { CountUp } from '@/components/count-up';

type TrendPoint = {
  t: string;
  cpu: number;
  mem: number;
};

interface NodeLivePanelProps {
  live: NodeStatsSnapshot | null | undefined;
  trend: TrendPoint[];
}

/** Live utilization hero: big mono CPU/Memory now + a coral/teal rolling trend. */
export function NodeLivePanel({ live, trend }: NodeLivePanelProps): React.JSX.Element {
  const memPercent = live?.memTotalBytes ? (live.memUsedBytes / live.memTotalBytes) * 100 : 0;
  return (
    <Card className="card-pop border-0">
      <CardHeader>
        <CardTitle className="flex items-center gap-2 text-base">
          <ActivityIcon className="text-primary size-4" /> Live utilization
        </CardTitle>
      </CardHeader>
      <CardContent>
        <div className="mb-5 flex flex-wrap items-end gap-x-10 gap-y-4">
          <div>
            <p className="mono-label text-muted-foreground">CPU now</p>
            <CountUp
              className="mono-data text-3xl font-bold sm:text-4xl"
              value={live?.cpuPercent ?? 0}
              format={(v) => `${v.toFixed(0)}%`}
            />
          </div>
          <div>
            <p className="mono-label text-muted-foreground">Memory</p>
            <CountUp
              className="mono-data text-3xl font-bold sm:text-4xl"
              value={memPercent}
              format={(v) => `${v.toFixed(0)}%`}
            />
          </div>
        </div>
        {trend.length > 1 ? (
          <AreaTrend
            data={trend}
            yMax={100}
            unit="%"
            series={[
              { key: 'cpu', color: 'var(--color-chart-1)', label: 'CPU' },
              { key: 'mem', color: 'var(--color-chart-3)', label: 'Memory' },
            ]}
          />
        ) : (
          <div className="text-muted-foreground flex h-[220px] items-center justify-center text-sm">
            {live ? 'Collecting samples…' : 'Node offline — no live data.'}
          </div>
        )}
      </CardContent>
    </Card>
  );
}
