import * as React from 'react';
import { ZapIcon } from 'lucide-react';
import type { CacheClusterView } from '@swarmy/core';
import { StatusBadge, type StatusTone } from '@swarmy/ui';
import { CountUp } from '@/components/count-up';
import { MemoryGauge } from './memory-gauge';

/** Cluster health → status token (mirrors the db-cluster panel semantics). */
export function clusterTone(view: CacheClusterView): { tone: StatusTone; label: string } {
  if (view.primary.status === 'absent') return { tone: 'offline', label: 'absent' };
  if (view.primary.status === 'stopped') return { tone: 'offline', label: 'down' };
  if (view.primary.status === 'deploying') return { tone: 'progress', label: 'deploying' };
  const replicasOk = view.replicas.running >= view.replicas.desired;
  if (view.primary.status === 'running' && replicasOk) return { tone: 'online', label: 'healthy' };
  return { tone: 'warning', label: 'degraded' };
}

/** One managed cache cluster in the list grid. Click opens the detail panel. */
export function CacheClusterCard({
  view,
  onOpen,
}: {
  view: CacheClusterView;
  onOpen: () => void;
}): React.JSX.Element {
  const { tone, label } = clusterTone(view);
  return (
    <button
      type="button"
      onClick={onOpen}
      className="card-pop card-pop-hover w-full p-5 text-left"
      aria-label={`Open cache cluster ${view.name}`}
    >
      <div className="flex items-start justify-between gap-3">
        <div className="flex min-w-0 items-center gap-3">
          <span className="bg-primary/10 text-primary flex size-9 shrink-0 items-center justify-center rounded-lg">
            <ZapIcon className="size-5" />
          </span>
          <div className="min-w-0">
            <p className="truncate font-semibold">{view.name}</p>
            <p className="mono-label text-muted-foreground !mb-0">
              {view.engine} · {view.topology} · {view.stack}
            </p>
          </div>
        </div>
        <StatusBadge tone={tone} label={label} className="shrink-0" />
      </div>

      <MemoryGauge stats={view.stats} memoryMb={view.memoryMb} className="mt-4" />

      <div className="mt-4 grid grid-cols-3 gap-2">
        <div>
          <p className="mono-label text-muted-foreground !mb-0 !text-[10px]">Replicas</p>
          <p className="mono-data text-sm">
            <CountUp value={view.replicas.running} />
            <span className="text-muted-foreground"> / {view.replicas.desired}</span>
          </p>
        </div>
        <div>
          <p className="mono-label text-muted-foreground !mb-0 !text-[10px]">Clients</p>
          <p className="mono-data text-sm">
            {view.stats ? <CountUp value={view.stats.connectedClients} /> : '—'}
          </p>
        </div>
        <div>
          <p className="mono-label text-muted-foreground !mb-0 !text-[10px]">Ops/s</p>
          <p className="mono-data text-sm">
            {view.stats ? <CountUp value={view.stats.opsPerSec} /> : '—'}
          </p>
        </div>
      </div>

      {view.attachments.length > 0 ? (
        <p className="text-muted-foreground mt-3 truncate text-xs">
          Attached: {view.attachments.map((a) => a.service).join(', ')}
        </p>
      ) : (
        <p className="text-muted-foreground mt-3 text-xs">No apps attached yet.</p>
      )}
    </button>
  );
}
