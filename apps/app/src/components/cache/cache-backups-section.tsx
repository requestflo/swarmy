import * as React from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { ArchiveIcon, RotateCcwIcon } from 'lucide-react';
import type { CacheClusterView } from '@swarmy/core';
import { Button, toast } from '@swarmy/ui';
import { useTRPC } from '@/integrations/trpc';
import { bytes, relTime } from '@/lib/format';

/**
 * Snapshots: BGSAVE + restic backup of the data volume (tag `cache:<cluster>`),
 * list from the restic catalog, and restore (stop → restore volume → start).
 */
export function CacheBackupsSection({ view }: { view: CacheClusterView }): React.JSX.Element {
  const trpc = useTRPC();
  const qc = useQueryClient();
  const ref = { stack: view.stack, cluster: view.name };

  const backups = useQuery({
    ...trpc.cache.listBackups.queryOptions(ref),
    retry: false,
  });
  const backup = useMutation(
    trpc.cache.backup.mutationOptions({
      onSuccess: (r) => {
        toast.success(`Snapshot ${r.resticId.slice(0, 8)} saved (${bytes(Number(r.sizeBytes))})`);
        void qc.invalidateQueries();
      },
      onError: (e) => toast.error(e.message),
    }),
  );
  const restore = useMutation(
    trpc.cache.restore.mutationOptions({
      onSuccess: () => {
        toast.success('Restore complete — the cache reloaded the snapshot');
        void qc.invalidateQueries();
      },
      onError: (e) => toast.error(e.message),
    }),
  );

  const rows = backups.data ?? [];
  return (
    <section className="space-y-2">
      <div className="flex items-center justify-between gap-2">
        <p className="mono-label text-muted-foreground !mb-0">Backups</p>
        <Button
          size="sm"
          variant="outline"
          disabled={backup.isPending}
          onClick={() => backup.mutate(ref)}
        >
          <ArchiveIcon className="size-3.5" /> {backup.isPending ? 'Backing up…' : 'Back up now'}
        </Button>
      </div>

      {backups.isError ? (
        <p className="text-muted-foreground text-xs">{backups.error.message}</p>
      ) : backups.isLoading ? (
        <div className="shimmer-line h-10 rounded-lg" />
      ) : rows.length === 0 ? (
        <p className="text-muted-foreground text-xs">
          No snapshots yet. &ldquo;Back up now&rdquo; runs BGSAVE, then snapshots the data volume
          to your backup destination. Recurring schedules live on the Backups page.
        </p>
      ) : (
        <div className="border-border divide-border divide-y rounded-lg border">
          {rows.slice(0, 5).map((b) => (
            <div key={b.id} className="flex items-center justify-between gap-2 p-3">
              <div className="min-w-0">
                <code className="mono-data block truncate text-xs">{b.id.slice(0, 12)}</code>
                <p className="text-muted-foreground text-[11px]">
                  {relTime(b.time)}
                  {b.sizeBytes ? ` · ${bytes(Number(b.sizeBytes))}` : ''}
                </p>
              </div>
              <Button
                size="sm"
                variant="outline"
                disabled={restore.isPending}
                onClick={() => {
                  if (
                    window.confirm(
                      `Restore snapshot ${b.id.slice(0, 8)}? The cache restarts and current data is replaced.`,
                    )
                  ) {
                    restore.mutate({ ...ref, snapshotId: b.id });
                  }
                }}
              >
                <RotateCcwIcon className="size-3.5" /> Restore
              </Button>
            </div>
          ))}
        </div>
      )}
    </section>
  );
}
