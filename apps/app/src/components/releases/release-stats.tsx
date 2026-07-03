import * as React from 'react';
import type { ReleasesOverview } from '@swarmy/core';
import { cn } from '@swarmy/ui';
import { CountUp } from '@/components/count-up';
import { relativeTime } from './release-status';

interface ReleaseStatsProps {
  overview: ReleasesOverview;
}

interface StatDef {
  label: string;
  value: number;
  /** Status tone applied when the value is non-zero. */
  tone?: string;
}

/** This stack's slice of the release counts — mono heroes with count-ups. */
export function ReleaseStats({ overview }: ReleaseStatsProps): React.JSX.Element {
  const stats: StatDef[] = [
    { label: 'Releases', value: overview.total },
    { label: 'In flight', value: overview.deploying, tone: 'text-status-progress' },
    { label: 'Healthy', value: overview.healthy, tone: 'text-status-online' },
    { label: 'Failed', value: overview.failed, tone: 'text-status-offline' },
  ];

  return (
    <div className="card-pop flex flex-wrap items-end gap-x-10 gap-y-4 px-6 py-5">
      {stats.map((s) => (
        <div key={s.label}>
          <p className="mono-label text-muted-foreground">{s.label}</p>
          <CountUp
            value={s.value}
            className={cn('mono-data text-2xl font-semibold', s.value > 0 && s.tone)}
          />
        </div>
      ))}
      {overview.lastDeployAt ? (
        <p className="text-muted-foreground ml-auto hidden pb-1 text-xs sm:block">
          last deploy <span className="mono-data">{relativeTime(overview.lastDeployAt)}</span>
        </p>
      ) : null}
    </div>
  );
}
