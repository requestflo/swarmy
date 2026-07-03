import * as React from 'react';
import { useQuery } from '@tanstack/react-query';
import type { SearchInstanceView } from '@swarmy/core';
import { CopyButton } from '@swarmy/ui';
import { useTRPC } from '@/integrations/trpc';
import { CountUp } from '@/components/count-up';
import { bytes } from '@/lib/format';
import { DestroySearchDialog } from './destroy-search-dialog';
import { SearchAttachSection } from './search-attach-section';
import { SearchBackupsSection } from './search-backups-section';

/**
 * Expanded instance detail (row-expand under the clicked row): endpoint + key
 * secret, live stats (docs, indexes, size/memory), attached apps, snapshots
 * and the danger zone. Only mounted while the row is open, so the stats poll
 * starts on expand and stops on collapse.
 */
export function SearchRowDetail({
  view,
  onDestroyed,
}: {
  view: SearchInstanceView;
  onDestroyed: () => void;
}): React.JSX.Element {
  const trpc = useTRPC();
  const liveStats = useQuery({
    ...trpc.search.stats.queryOptions({ stack: view.stack, name: view.name }),
    refetchInterval: 5_000,
    retry: false,
  });
  const stats = liveStats.data ?? view.stats ?? null;
  const size = stats?.dbSizeBytes ?? stats?.memoryBytes ?? null;

  return (
    <div className="border-border bg-muted/20 mb-3 grid gap-6 rounded-lg border p-4 lg:grid-cols-2">
      <div className="space-y-6">
        <section className="space-y-2">
          <div className="bg-muted/40 flex items-center justify-between gap-2 rounded-md px-3 py-2">
            <code className="mono-data truncate text-xs">{view.url}</code>
            <CopyButton value={view.url} />
          </div>
          <p className="text-muted-foreground text-[11px]">
            Private-only — reachable on the instance network. The master key was shown once at
            provision and lives in the Docker secret{' '}
            <code className="mono-data">{view.keySecret}</code>; attached apps read it from the
            secret file.
          </p>
        </section>

        <section className="space-y-3">
          <div className="grid grid-cols-3 gap-2">
            {(
              [
                ['Documents', stats?.docs],
                [view.engine === 'typesense' ? 'Collections' : 'Indexes', stats?.indexes],
              ] as const
            ).map(([label, value]) => (
              <div key={label}>
                <p className="mono-label text-muted-foreground !mb-0 !text-[10px]">{label}</p>
                <p className="mono-data text-sm">
                  {typeof value === 'number' ? <CountUp value={value} /> : '—'}
                </p>
              </div>
            ))}
            <div>
              <p className="mono-label text-muted-foreground !mb-0 !text-[10px]">
                {view.engine === 'typesense' ? 'Memory' : 'DB size'}
              </p>
              <p className="mono-data text-sm">{size !== null ? bytes(size) : '—'}</p>
            </div>
          </div>
          {stats ? (
            <p className="text-muted-foreground text-[11px]">
              Sampled {new Date(stats.at).toLocaleTimeString()}
            </p>
          ) : (
            <p className="text-muted-foreground text-[11px]">Awaiting first stats sample.</p>
          )}
        </section>
      </div>

      <div className="space-y-6">
        <SearchAttachSection view={view} />
        <SearchBackupsSection view={view} />
        <section className="space-y-2">
          <p className="mono-label text-muted-foreground !mb-0">Danger zone</p>
          <DestroySearchDialog view={view} onDestroyed={onDestroyed} />
        </section>
      </div>
    </div>
  );
}
