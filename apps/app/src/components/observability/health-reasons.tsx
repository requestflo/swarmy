import * as React from 'react';
import { useQuery } from '@tanstack/react-query';
import { HeartPulseIcon } from 'lucide-react';
import {
  Button,
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
  EmptyState,
  Skeleton,
  StatusBadge,
  type StatusTone,
} from '@swarmy/ui';
import type { HealthEntryView, HealthStatusView } from '@swarmy/core';
import { useTRPC } from '@/integrations/trpc';

const TONE: Record<HealthStatusView, StatusTone> = {
  healthy: 'online',
  degraded: 'warning',
  down: 'offline',
  unknown: 'neutral',
};

const LABEL: Record<HealthStatusView, string> = {
  healthy: 'All green',
  degraded: 'Needs attention',
  down: 'Down',
  unknown: 'No signals yet',
};

/** Status token CSS var per health status (dynamic classes don't survive JIT). */
const DOT: Record<HealthStatusView, string> = {
  healthy: 'var(--status-online)',
  degraded: 'var(--status-warning)',
  down: 'var(--status-offline)',
  unknown: 'var(--status-idle)',
};

function StackChip({ entry }: { entry: HealthEntryView }): React.JSX.Element {
  return (
    <span
      title={entry.reasons.join('\n') || 'healthy'}
      className="bg-accent/60 inline-flex items-center gap-1.5 rounded-full px-2.5 py-1 text-xs font-medium"
    >
      <span className="size-1.5 rounded-full" style={{ background: DOT[entry.status] }} />
      {entry.name}
    </span>
  );
}

/**
 * The health narrative: one status + the ordered human reasons behind it
 * ("p95 latency 1.8s (target <1.5s)", "database replica lag 12s", …), plus a
 * per-stack chip row so you can see WHERE the trouble is at a glance.
 */
export function HealthReasonsPanel(): React.JSX.Element {
  const trpc = useTRPC();
  const health = useQuery({
    ...trpc.observability.health.queryOptions({}),
    refetchInterval: 10_000,
  });

  const status: HealthStatusView = health.data?.status ?? 'unknown';
  const reasons = health.data?.reasons ?? [];
  const entries = health.data?.entries ?? [];

  return (
    <Card className="card-pop mb-4 border-0">
      <CardHeader>
        <CardTitle className="flex items-center justify-between gap-3 text-base">
          <span className="flex items-center gap-2">
            <HeartPulseIcon className="size-4" /> Health
          </span>
          {health.data ? <StatusBadge tone={TONE[status]} label={LABEL[status]} /> : null}
        </CardTitle>
        <CardDescription>
          Why anything is degraded, in plain words — composed from live tasks, replica lag, queue
          depth and RED metrics.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        {health.isLoading ? (
          <div className="space-y-2">
            <Skeleton className="h-5 w-2/3 rounded-lg" />
            <Skeleton className="h-5 w-1/2 rounded-lg" />
          </div>
        ) : health.isError ? (
          <EmptyState
            icon={<HeartPulseIcon />}
            title="Couldn't read health"
            description={health.error.message}
            action={
              <Button variant="outline" size="sm" onClick={() => void health.refetch()}>
                Retry
              </Button>
            }
          />
        ) : reasons.length === 0 ? (
          <p className="text-sm font-medium">
            {status === 'unknown'
              ? 'Quiet so far — deploy something and health lands here.'
              : 'Everything is running at its desired scale. Nothing needs you.'}
          </p>
        ) : (
          <ul className="space-y-1.5">
            {reasons.map((reason) => (
              <li key={reason} className="flex items-start gap-2 text-sm">
                <span
                  className="mt-1.5 size-1.5 shrink-0 rounded-full"
                  style={{
                    background: reason.startsWith('telemetry') ? 'var(--status-idle)' : DOT[status],
                  }}
                />
                <span className="min-w-0 break-words">{reason}</span>
              </li>
            ))}
          </ul>
        )}
        {entries.length > 0 ? (
          <div className="flex flex-wrap gap-1.5">
            {entries.map((e) => (
              <StackChip key={`${e.kind}:${e.name}`} entry={e} />
            ))}
          </div>
        ) : null}
      </CardContent>
    </Card>
  );
}
