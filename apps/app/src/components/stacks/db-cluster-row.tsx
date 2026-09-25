import * as React from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { MinusIcon, PlusIcon } from 'lucide-react';
import { Button, CopyButton, toast } from '@swarmy/ui';
import type { DbTopologyMode } from '@swarmy/core';
import { useTRPC } from '@/integrations/trpc';
import { StatusWord, Tech, toneFromStatus } from '@/components/calm';
import { DbClusterRowDetail } from './db-cluster-row-detail';
import type { DbStorageView } from './db-storage-warning';
import type { DbPendingFailoverView } from './db-failover-confirm';

export type ClusterStatus = 'running' | 'degraded' | 'deploying' | 'failing' | 'idle' | 'stopped' | 'absent';

export interface DbClusterRowView {
  name: string;
  engine: string;
  rwHost: string;
  roHost: string;
  primary: { status: ClusterStatus };
  replicas: { desired: number; running: number };
  topology?: DbTopologyMode;
  /** Where the primary's data lives (`unmounted` = legacy anonymous volume). */
  storage?: DbStorageView;
  /** A failover swarmy HELD because it could lose writes (admin confirms). */
  pendingFailover?: DbPendingFailoverView;
}

function toneFor(status: ClusterStatus): 'online' | 'warning' | 'offline' | 'neutral' | 'progress' {
  if (status === 'running') return 'online';
  if (status === 'degraded') return 'warning';
  if (status === 'deploying') return 'progress';
  if (status === 'absent' || status === 'failing') return 'offline';
  return 'neutral';
}

/** A connection host with a copy affordance (Controls depth). */
function HostRow({ env, host, kind }: { env: string; host: string; kind: string }): React.JSX.Element {
  return (
    <div className="border-border flex min-h-11 items-center gap-3 border-b py-1.5 last:border-b-0">
      <span className="w-40 shrink-0 font-mono text-[12px] font-semibold">{env}</span>
      <code className="min-w-0 flex-1 truncate font-mono text-[12px]">{host}:5432</code>
      <span className="text-muted-foreground hidden text-xs sm:inline">{kind}</span>
      <CopyButton value={`${host}:5432`} aria-label={`Copy ${env} host`} className="size-9" />
    </div>
  );
}

/**
 * The Controls depth of a managed-Postgres cluster: the standby-copy scaler,
 * the injected connection hosts, and the topology + backup controls.
 */
export function DbClusterRow({ stack, cluster }: { stack: string; cluster: DbClusterRowView }): React.JSX.Element {
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
    <div className="border-border flex min-w-0 flex-col gap-4 border-t pt-4">
      <div className="flex flex-wrap items-center gap-3">
        <span className="text-[13.5px] font-semibold">Standby copies</span>
        <Button variant="outline" size="icon" aria-label="Remove a standby copy" className="size-9 pointer-coarse:size-11" disabled={pending || c.replicas.desired <= 0} onClick={() => set(c.replicas.desired - 1)}>
          <MinusIcon className="size-4" />
        </Button>
        <span className="font-mono text-base tabular-nums">
          {c.replicas.running}
          <span className="text-muted-foreground"> / {c.replicas.desired}</span>
        </span>
        <Button variant="outline" size="icon" aria-label="Add a standby copy" className="size-9 pointer-coarse:size-11" disabled={pending} onClick={() => set(c.replicas.desired + 1)}>
          <PlusIcon className="size-4" />
        </Button>
        <span className="text-muted-foreground text-xs">running / wanted</span>
        <StatusWord tone={toneFromStatus(toneFor(c.primary.status))} word={`main copy ${c.primary.status}`} className="ml-auto" />
      </div>
      <Tech>{c.engine} · swarmy.db.replicas={c.replicas.desired} · replicas stream from the primary over the cluster overlay</Tech>
      <div className="flex flex-col">
        <span className="mb-1 text-[13.5px] font-semibold">Connect</span>
        <HostRow env="DATABASE_URL" host={c.rwHost} kind="read-write" />
        <HostRow env="DATABASE_RO_URL" host={c.roHost} kind="copies" />
        <Tech>password in a Docker secret, shown once at create · private network only, no published port</Tech>
      </div>
      <DbClusterRowDetail stack={stack} cluster={c.name} topology={c.topology} />
    </div>
  );
}
