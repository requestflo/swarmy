import * as React from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { RotateCcwIcon } from 'lucide-react';
import {
  Button,
  StatusBadge,
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
  toast,
} from '@swarmy/ui';
import type { StatusTone } from '@swarmy/ui';
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

const TONE: Record<string, StatusTone> = {
  SUCCEEDED: 'online',
  RUNNING: 'progress',
  FAILED: 'offline',
  PRUNED: 'neutral',
};

export function SnapshotsTable(): React.JSX.Element {
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
        qc.invalidateQueries();
      },
      onError: (e) => toast.error(e.message),
    }),
  );

  const rows = snapshots.data ?? [];
  if (rows.length === 0) {
    return (
      <div className="text-muted-foreground px-6 py-12 text-center text-sm">
        No snapshots yet. Back up a volume to start your recovery catalog.
      </div>
    );
  }

  return (
    <Table>
      <TableHeader>
        <TableRow>
          <TableHead>Volume</TableHead>
          <TableHead className="hidden sm:table-cell">Target</TableHead>
          <TableHead>Status</TableHead>
          <TableHead className="hidden sm:table-cell">Size</TableHead>
          <TableHead className="hidden md:table-cell">Started</TableHead>
          <TableHead className="text-right">Restore</TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {rows.map((s) => (
          <TableRow key={s.id}>
            <TableCell className="mono-data font-medium">{s.volume}</TableCell>
            <TableCell className="hidden sm:table-cell">{s.targetName}</TableCell>
            <TableCell>
              <StatusBadge tone={TONE[s.status] ?? 'neutral'} label={s.status.toLowerCase()} />
            </TableCell>
            <TableCell className="mono-data hidden sm:table-cell">{fmtBytes(s.sizeBytes)}</TableCell>
            <TableCell className="mono-data hidden md:table-cell text-xs">
              {new Date(s.startedAt).toLocaleString()}
            </TableCell>
            <TableCell className="text-right">
              <Button
                variant="ghost"
                size="sm"
                disabled={s.status !== 'SUCCEEDED' || restore.isPending}
                onClick={() => restore.mutate({ snapshotId: s.id })}
              >
                <RotateCcwIcon className="size-4" /> Restore
              </Button>
            </TableCell>
          </TableRow>
        ))}
      </TableBody>
    </Table>
  );
}
