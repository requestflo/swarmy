import * as React from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { MinusIcon, PlusIcon, ServerIcon } from 'lucide-react';
import { Button, CopyButton, StatusBadge, type StatusTone, toast } from '@swarmy/ui';
import { useTRPC } from '@/integrations/trpc';
import { CountUp } from '@/components/count-up';

export type ClusterStatus = 'running' | 'degraded' | 'deploying' | 'idle' | 'stopped' | 'absent';

export interface DbClusterRowView {
  name: string;
  engine: string;
  rwHost: string;
  roHost: string;
  primary: { status: ClusterStatus };
  replicas: { desired: number; running: number };
}

function toneFor(status: ClusterStatus): StatusTone {
  if (status === 'running') return 'online';
  if (status === 'degraded') return 'warning';
  if (status === 'deploying') return 'progress';
  if (status === 'absent') return 'offline';
  return 'neutral';
}

/** Read-only host pill with a copy affordance. */
function HostRow({ kind, host }: { kind: 'RW' | 'RO'; host: string }): React.JSX.Element {
  return (
    <div className="bg-muted/40 flex items-center justify-between gap-2 rounded-md px-3 py-2">
      <div className="flex min-w-0 items-center gap-2">
        <span className="mono-label text-muted-foreground w-7 shrink-0">{kind}</span>
        <code className="mono-data truncate text-xs">{host}</code>
      </div>
      <CopyButton value={host} />
    </div>
  );
}

/** One managed-database cluster: status, replica +/- and rw/ro hosts. */
export function DbClusterRow({
  stack,
  cluster,
}: {
  stack: string;
  cluster: DbClusterRowView;
}): React.JSX.Element {
  const trpc = useTRPC();
  const qc = useQueryClient();
  const c = cluster;

  const scale = useMutation(
    trpc.db.setReplicas.mutationOptions({
      onSuccess: (res) => {
        toast.success(`${res.cluster} → ${res.replicas} replicas`);
        void qc.invalidateQueries();
      },
      onError: (e) => toast.error(e.message),
    }),
  );

  const pending = scale.isPending && scale.variables?.cluster === c.name;
  const set = (n: number): void => scale.mutate({ stack, cluster: c.name, replicas: Math.max(0, n) });

  return (
    <div className="border-border rounded-lg border p-4">
      <div className="flex items-center justify-between gap-3">
        <div className="flex items-center gap-2">
          <ServerIcon className="text-muted-foreground size-4" />
          <span className="font-medium">{c.name}</span>
          <span className="mono-label text-muted-foreground">{c.engine}</span>
        </div>
        <StatusBadge tone={toneFor(c.primary.status)} label={c.primary.status} />
      </div>

      <div className="mt-4 grid gap-4 sm:grid-cols-2">
        <div className="space-y-1">
          <p className="mono-label text-muted-foreground">Replicas</p>
          <div className="flex items-center gap-2">
            <Button
              variant="outline"
              size="icon"
              aria-label="Remove a replica"
              disabled={pending || c.replicas.desired <= 0}
              onClick={() => set(c.replicas.desired - 1)}
            >
              <MinusIcon className="size-4" />
            </Button>
            <span className="mono-data w-16 text-center text-lg">
              <CountUp value={c.replicas.running} />
              <span className="text-muted-foreground"> / {c.replicas.desired}</span>
            </span>
            <Button
              variant="outline"
              size="icon"
              aria-label="Add a replica"
              disabled={pending}
              onClick={() => set(c.replicas.desired + 1)}
            >
              <PlusIcon className="size-4" />
            </Button>
            <span className="mono-label text-muted-foreground ml-1">running / desired</span>
          </div>
        </div>

        <div className="space-y-2">
          <HostRow kind="RW" host={c.rwHost} />
          <HostRow kind="RO" host={c.roHost} />
        </div>
      </div>
    </div>
  );
}
