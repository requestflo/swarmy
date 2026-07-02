import * as React from 'react';
import { useQuery } from '@tanstack/react-query';
import { ZapIcon } from 'lucide-react';
import {
  CopyButton,
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
  StatusBadge,
} from '@swarmy/ui';
import { useTRPC } from '@/integrations/trpc';
import { CountUp } from '@/components/count-up';
import { clusterTone } from './cache-cluster-card';
import { CacheAttachSection } from './cache-attach-section';
import { CacheBackupsSection } from './cache-backups-section';
import { CacheMembersList } from './cache-members-list';
import { CacheTuningControls } from './cache-tuning-controls';
import { DestroyCacheDialog } from './destroy-cache-dialog';
import { MemoryGauge } from './memory-gauge';

/**
 * Cluster detail panel: members with roles, memory gauge, live stats, attached
 * apps, snapshots and the danger zone. Opens from a cluster card.
 */
export function CacheClusterPanel({
  stack,
  cluster,
  onOpenChange,
}: {
  stack: string | null;
  cluster: string | null;
  onOpenChange: (open: boolean) => void;
}): React.JSX.Element {
  const trpc = useTRPC();
  const open = Boolean(stack && cluster);
  const ref = { stack: stack ?? '', cluster: cluster ?? '' };

  const detail = useQuery({
    ...trpc.cache.get.queryOptions(ref),
    enabled: open,
    refetchInterval: 4_000,
  });
  const liveStats = useQuery({
    ...trpc.cache.stats.queryOptions(ref),
    enabled: open,
    refetchInterval: 5_000,
    retry: false,
  });

  const view = detail.data ?? null;
  const stats = liveStats.data ?? view?.stats ?? null;
  const tone = view ? clusterTone(view) : null;

  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent className="w-full gap-0 overflow-y-auto p-0 sm:max-w-md">
        <SheetHeader className="border-border border-b p-6">
          <div className="flex items-center gap-3">
            <span className="bg-primary/10 text-primary flex size-9 items-center justify-center rounded-lg">
              <ZapIcon className="size-5" />
            </span>
            <div className="min-w-0">
              <SheetTitle className="truncate">{cluster ?? 'Cache'}</SheetTitle>
              <SheetDescription className="mono-label !mb-0">
                {view ? `${view.engine} · ${view.topology}` : '…'} · {stack}
              </SheetDescription>
            </div>
            {tone ? <StatusBadge tone={tone.tone} label={tone.label} className="ml-auto shrink-0" /> : null}
          </div>
        </SheetHeader>

        {!view ? (
          <div className="space-y-3 p-6">
            <div className="shimmer-line h-10 rounded-lg" />
            <div className="shimmer-line h-24 rounded-lg" />
            <div className="shimmer-line h-24 rounded-lg" />
          </div>
        ) : (
          <div className="space-y-6 p-6">
            <section className="space-y-2">
              <div className="bg-muted/40 flex items-center justify-between gap-2 rounded-md px-3 py-2">
                <code className="mono-data truncate text-xs">
                  redis://{view.host}:{view.port}
                </code>
                <CopyButton value={`redis://${view.host}:${view.port}`} />
              </div>
              <p className="text-muted-foreground text-[11px]">
                Private-only — reachable on the cluster network. Password lives in the Docker
                secret <code className="mono-data">{view.passwordSecret}</code>.
              </p>
            </section>

            <section className="space-y-3">
              <MemoryGauge stats={stats} memoryMb={view.memoryMb} />
              <div className="grid grid-cols-3 gap-2">
                {(
                  [
                    ['Clients', stats?.connectedClients],
                    ['Ops/s', stats?.opsPerSec],
                    ['Keys', stats?.keys],
                  ] as const
                ).map(([label, value]) => (
                  <div key={label}>
                    <p className="mono-label text-muted-foreground !mb-0 !text-[10px]">{label}</p>
                    <p className="mono-data text-sm">
                      {typeof value === 'number' ? <CountUp value={value} /> : '—'}
                    </p>
                  </div>
                ))}
              </div>
              {stats?.hitRatePct != null ? (
                <p className="text-muted-foreground text-[11px]">
                  Hit rate {stats.hitRatePct}% · sampled {new Date(stats.at).toLocaleTimeString()}
                </p>
              ) : null}
            </section>

            <CacheTuningControls view={view} />

            <section className="space-y-2">
              <p className="mono-label text-muted-foreground !mb-0">Members</p>
              <CacheMembersList members={view.members} />
            </section>

            <CacheAttachSection view={view} />
            <CacheBackupsSection view={view} />

            <section className="space-y-2">
              <p className="mono-label text-muted-foreground !mb-0">Danger zone</p>
              <DestroyCacheDialog view={view} onDestroyed={() => onOpenChange(false)} />
            </section>
          </div>
        )}
      </SheetContent>
    </Sheet>
  );
}
