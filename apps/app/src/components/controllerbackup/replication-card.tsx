import * as React from 'react';
import { useQuery } from '@tanstack/react-query';
import { RadioTowerIcon } from 'lucide-react';
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
  StatusBadge,
} from '@swarmy/ui';
import { useTRPC } from '@/integrations/trpc';
import { CardSkeleton, ErrorState } from '@/components/states';
import { ReplicationTargetForm } from './replication-target-form';
import { MoveControllerDialog } from './move-controller-dialog';

/**
 * Controller store replication (resilience P3): where control.db is streamed
 * (Litestream to Garage or an S3 target), how far behind the replica is, and
 * "Move controller to…".
 */
export function ReplicationCard(): React.JSX.Element {
  const trpc = useTRPC();
  const status = useQuery({ ...trpc.controllerStore.status.queryOptions(), refetchInterval: 5_000 });

  if (status.isPending) return <CardSkeleton lines={4} />;
  if (status.isError) return <ErrorState title="Couldn’t read the controller store." error={status.error} retry={() => status.refetch()} />;
  const s = status.data;
  const tone = s.problem ? 'warning' : s.mode === 'replicated' ? 'online' : 'neutral';
  const label = s.problem ? 'needs a look' : s.mode === 'replicated' ? 'replicated' : 'local only';

  return (
    <Card className="calm-card">
      <CardHeader className="flex-row items-start justify-between gap-4 space-y-0">
        <div className="min-w-0">
          <CardTitle className="flex items-center gap-2 text-base">
            <RadioTowerIcon className="size-4" /> Continuous replication
          </CardTitle>
          <CardDescription>
            Every write to the controller store streams to object storage within about a second.
            The controller can then move to any manager and pick up where it left off.
          </CardDescription>
        </div>
        <StatusBadge tone={tone} label={label} />
      </CardHeader>
      <CardContent className="grid gap-5">
        <dl className="grid grid-cols-2 gap-4 lg:grid-cols-4">
          <Stat label="Target" value={s.target ? s.target.label : 'This node only'} sub={s.target ? `${s.target.bucket}/${s.target.prefix}` : undefined} />
          <Stat label="Last replicated" value={s.lastReplicatedAt ? ago(s.lastReplicatedAt) : '—'} />
          <Stat label="Lag" value={s.lagSeconds == null ? '—' : `${s.lagSeconds}s`} sub={s.pendingBytes ? `${fmtBytes(s.pendingBytes)} pending` : undefined} />
          <Stat label="Runs on" value={s.hostname} sub={s.epoch != null ? `lease epoch ${s.epoch}` : s.role} />
        </dl>
        {s.problem ? <p className="text-tone-warn text-sm">{s.problem}</p> : null}
        <p className="text-muted-foreground text-sm">
          If this node died now you would lose {s.lossWindow}.
          {s.boot ? ` Last boot: ${s.boot.outcome}.` : ''}
        </p>
        <div className="flex flex-wrap items-center gap-3">
          <ReplicationTargetForm replicated={s.mode === 'replicated'} currentTargetId={s.target?.targetId ?? (s.target ? 'garage' : null)} />
          <MoveControllerDialog managers={s.managers} disabled={!s.replicating} disabledReason={s.replicating ? null : 'Turn on replication first'} />
        </div>
      </CardContent>
    </Card>
  );
}

function Stat({ label, value, sub }: { label: string; value: string; sub?: string }): React.JSX.Element {
  return (
    <div className="min-w-0">
      <dt className="mono-label text-muted-foreground">{label}</dt>
      <dd className="mono-data truncate text-lg">{value}</dd>
      {sub ? <dd className="text-muted-foreground hidden truncate text-xs sm:block">{sub}</dd> : null}
    </div>
  );
}

function ago(iso: string): string {
  const s = Math.max(0, Math.round((Date.now() - Date.parse(iso)) / 1000));
  if (s < 60) return `${s}s ago`;
  if (s < 3600) return `${Math.round(s / 60)}m ago`;
  return `${Math.round(s / 3600)}h ago`;
}

function fmtBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 ** 2) return `${(n / 1024).toFixed(1)} KiB`;
  return `${(n / 1024 ** 2).toFixed(1)} MiB`;
}
