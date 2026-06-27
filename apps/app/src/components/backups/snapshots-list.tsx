import * as React from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { DatabaseBackupIcon, RotateCcwIcon } from 'lucide-react';
import {
  Button,
  Card,
  CardContent,
  EmptyState,
  StatusBadge,
  type StatusTone,
  toast,
} from '@swarmy/ui';
import { useTRPC } from '@/integrations/trpc';

function fmtBytes(n: string | null): string {
  if (!n) return '—';
  let v = Number(n);
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let i = 0;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i++;
  }
  return `${v.toFixed(i === 0 ? 0 : 1)} ${units[i]}`;
}

function relativeTime(iso: string): string {
  const diff = Date.now() - new Date(iso).getTime();
  const mins = Math.round(diff / 60_000);
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.round(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  return `${Math.round(hours / 24)}d ago`;
}

const TONE: Record<string, StatusTone> = {
  SUCCEEDED: 'online',
  RUNNING: 'progress',
  FAILED: 'offline',
  PRUNED: 'neutral',
};

/** Flat snapshot rows inside one card-pop, divided by hairlines. Live (5s poll). */
export function SnapshotsList(): React.JSX.Element {
  const trpc = useTRPC();
  const qc = useQueryClient();
  const snapshots = useQuery({
    ...trpc.backups.listSnapshots.queryOptions({}),
    refetchInterval: 5_000,
  });

  const restore = useMutation(
    trpc.backups.restoreSnapshot.mutationOptions({
      onSuccess: (r) => {
        toast.success(`Restored to ${r.targetVolume}`);
        void qc.invalidateQueries();
      },
      onError: (e) => toast.error(e.message),
    }),
  );

  const rows = snapshots.data ?? [];

  return (
    <Card className="card-pop border-0">
      <CardContent className="p-0">
        <div className="flex items-center justify-between gap-3 px-6 py-4">
          <span className="mono-label">Snapshots</span>
          <span className="text-muted-foreground mono-label">{rows.length} in catalog</span>
        </div>
        {rows.length === 0 ? (
          <div className="border-t px-6 py-2">
            <EmptyState
              className="border-0"
              icon={<DatabaseBackupIcon />}
              title="No snapshots yet."
              description="Back up a volume to start your recovery catalog — restore points show up here the moment they finish."
            />
          </div>
        ) : (
          <div className="divide-border divide-y border-t">
            {rows.map((snap) => {
              const tone = TONE[snap.status] ?? 'neutral';
              return (
                <div
                  key={snap.id}
                  className="hover:bg-accent/60 flex items-center gap-4 px-6 py-4 transition-colors"
                >
                  <StatusBadge tone={tone} label="" />
                  <div className="min-w-0 flex-1">
                    <p className="mono-data truncate font-medium">{snap.volume}</p>
                    <p className="text-muted-foreground mono-label truncate">
                      {snap.status.toLowerCase()} · {snap.targetName || 'unknown target'} ·{' '}
                      {relativeTime(snap.startedAt)}
                    </p>
                  </div>
                  <div className="hidden w-24 text-right sm:block">
                    <p className="mono-data text-sm">{fmtBytes(snap.sizeBytes)}</p>
                    <p className="text-muted-foreground mono-label">size</p>
                  </div>
                  <Button
                    variant="ghost"
                    size="sm"
                    className="rounded-full"
                    disabled={snap.status !== 'SUCCEEDED' || restore.isPending}
                    onClick={() => restore.mutate({ snapshotId: snap.id })}
                  >
                    <RotateCcwIcon className="size-4" /> Restore
                  </Button>
                </div>
              );
            })}
          </div>
        )}
      </CardContent>
    </Card>
  );
}
