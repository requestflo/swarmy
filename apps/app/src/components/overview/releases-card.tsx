import * as React from 'react';
import { RocketIcon } from 'lucide-react';
import { relTime } from '@/lib/format';
import { CardSkeleton } from '@/components/states';

function Stat({ n, label, tone }: { n: number; label: string; tone: string }): React.JSX.Element {
  return (
    <div>
      <div className="mono-data text-2xl font-bold" style={{ color: `var(--status-${tone})` }}>
        {n}
      </div>
      <div className="text-muted-foreground text-xs">{label}</div>
    </div>
  );
}

interface ReleasesCardProps {
  deploying: number;
  healthy: number;
  failed: number;
  lastDeployAt: string | null;
  /** First fetch still in flight — draw a skeleton, not three zeros. */
  loading?: boolean;
}

/** Deployment pulse for the whole estate — in flight / healthy / failed. */
export function ReleasesCard({
  deploying,
  healthy,
  failed,
  lastDeployAt,
  loading = false,
}: ReleasesCardProps): React.JSX.Element {
  if (loading) return <CardSkeleton lines={2} />;
  return (
    <div className="card-pop p-5">
      <div className="mb-3 flex items-center justify-between">
        <h2 className="font-display text-lg font-bold">Deployments</h2>
        <RocketIcon className="text-muted-foreground size-4" />
      </div>
      <div className="flex items-center gap-4 text-sm">
        <Stat n={deploying} label="in flight" tone="progress" />
        <Stat n={healthy} label="healthy" tone="online" />
        <Stat n={failed} label="failed" tone="offline" />
      </div>
      <p className="text-muted-foreground mt-3 text-xs">
        {lastDeployAt ? `Last deploy ${relTime(lastDeployAt)}` : 'No deploys yet.'}
        {' Per-stack history lives in each stack workspace below.'}
      </p>
    </div>
  );
}
