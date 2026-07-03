import * as React from 'react';
import { useQuery } from '@tanstack/react-query';
import type { CacheClusterView } from '@swarmy/core';
import { CopyButton } from '@swarmy/ui';
import { useTRPC } from '@/integrations/trpc';
import { CountUp } from '@/components/count-up';
import { CacheAttachSection } from './cache-attach-section';
import { CacheBackupsSection } from './cache-backups-section';
import { CacheMembersList } from './cache-members-list';
import { CacheTuningControls } from './cache-tuning-controls';
import { DestroyCacheDialog } from './destroy-cache-dialog';
import { MemoryGauge } from './memory-gauge';

/**
 * Expanded cluster detail (row-expand under the clicked row): endpoint,
 * memory gauge + live stats, tuning, members, attached apps, snapshots and
 * the danger zone. Only mounted while the row is open, so the stats poll
 * starts on expand and stops on collapse.
 */
export function CacheRowDetail({
  view,
  onDestroyed,
}: {
  view: CacheClusterView;
  onDestroyed: () => void;
}): React.JSX.Element {
  const trpc = useTRPC();
  const liveStats = useQuery({
    ...trpc.cache.stats.queryOptions({ stack: view.stack, cluster: view.name }),
    refetchInterval: 5_000,
    retry: false,
  });
  const stats = liveStats.data ?? view.stats ?? null;

  return (
    <div className="border-border bg-muted/20 mb-3 grid gap-6 rounded-lg border p-4 lg:grid-cols-2">
      <div className="space-y-6">
        <section className="space-y-2">
          <div className="bg-muted/40 flex items-center justify-between gap-2 rounded-md px-3 py-2">
            <code className="mono-data truncate text-xs">
              redis://{view.host}:{view.port}
            </code>
            <CopyButton value={`redis://${view.host}:${view.port}`} />
          </div>
          <p className="text-muted-foreground text-[11px]">
            Private-only — reachable on the cluster network. Password lives in the Docker secret{' '}
            <code className="mono-data">{view.passwordSecret}</code>.
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
      </div>

      <div className="space-y-6">
        <CacheAttachSection view={view} />
        <CacheBackupsSection view={view} />
        <section className="space-y-2">
          <p className="mono-label text-muted-foreground !mb-0">Danger zone</p>
          <DestroyCacheDialog view={view} onDestroyed={onDestroyed} />
        </section>
      </div>
    </div>
  );
}
