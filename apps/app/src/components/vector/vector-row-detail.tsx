import * as React from 'react';
import { useQuery } from '@tanstack/react-query';
import type { VectorInstanceView } from '@swarmy/core';
import { CopyButton } from '@swarmy/ui';
import { useTRPC } from '@/integrations/trpc';
import { CountUp } from '@/components/count-up';
import { AttachVectorForm } from './attach-vector-form';
import { DestroyVectorDialog } from './destroy-vector-dialog';

/**
 * Expanded instance detail (row-expand under the clicked row): endpoint + key
 * secret, live collections, attached apps and the danger zone. Only mounted
 * while the row is open, so the stats poll starts on expand.
 */
export function VectorRowDetail({
  view,
  onDestroyed,
}: {
  view: VectorInstanceView;
  onDestroyed: () => void;
}): React.JSX.Element {
  const trpc = useTRPC();
  const liveStats = useQuery({
    ...trpc.vector.stats.queryOptions({ stack: view.stack, name: view.name }),
    refetchInterval: 5_000,
    retry: false,
  });
  const stats = liveStats.data ?? view.stats ?? null;

  return (
    <div className="border-border bg-muted/20 mb-3 grid gap-6 rounded-lg border p-4 lg:grid-cols-2">
      <div className="space-y-6">
        <section className="space-y-2">
          <div className="bg-muted/40 flex items-center justify-between gap-2 rounded-md px-3 py-2">
            <code className="mono-data truncate text-xs">{view.url}</code>
            <CopyButton value={view.url} />
          </div>
          <p className="text-muted-foreground text-[11px]">
            Private-only — reachable on the instance network. The API key was shown once at
            provision and lives in the Docker secret{' '}
            <code className="mono-data">{view.keySecret}</code>; attached apps read it from the
            secret file.
          </p>
        </section>

        <section className="space-y-2">
          <p className="mono-label text-muted-foreground !mb-0">Collections</p>
          <p className="mono-data text-lg">
            {stats ? <CountUp value={stats.collections} /> : '—'}
          </p>
          {stats && stats.collectionNames.length > 0 ? (
            <p className="text-muted-foreground truncate text-xs">
              {stats.collectionNames.join(', ')}
            </p>
          ) : (
            <p className="text-muted-foreground text-xs">No collections yet.</p>
          )}
        </section>
      </div>

      <div className="space-y-6">
        <section className="space-y-2">
          <p className="mono-label text-muted-foreground !mb-0">Attached apps</p>
          {view.attachments.length > 0 ? (
            <p className="text-muted-foreground text-xs">
              {view.attachments.map((a) => a.service).join(', ')}
            </p>
          ) : (
            <p className="text-muted-foreground text-xs">
              Nothing wired yet — attach a service to inject{' '}
              <code className="mono-data">QDRANT_URL</code> and the key secret.
            </p>
          )}
          <AttachVectorForm stack={view.stack} name={view.name} />
        </section>

        <section className="space-y-2">
          <p className="mono-label text-muted-foreground !mb-0">Danger zone</p>
          <DestroyVectorDialog view={view} onDestroyed={onDestroyed} />
        </section>
      </div>
    </div>
  );
}
