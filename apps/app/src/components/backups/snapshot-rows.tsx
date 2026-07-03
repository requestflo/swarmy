import * as React from 'react';
import { DatabaseBackupIcon } from 'lucide-react';
import { EmptyState, StatusBadge } from '@swarmy/ui';
import { fmtBytes, relativeTime, SNAPSHOT_TONE } from './backup-format';
import { RestoreSnapshotConfirm } from './restore-snapshot-confirm';

export interface SnapshotItem {
  id: string;
  volume: string;
  status: string;
  targetName: string;
  sizeBytes: string | null;
  startedAt: string;
}

interface SnapshotRowsProps {
  rows: SnapshotItem[];
  emptyTitle: string;
  emptyDescription: string;
}

/** Flat snapshot rows with hairline dividers — restore confirms via AlertDialog. */
export function SnapshotRows({
  rows,
  emptyTitle,
  emptyDescription,
}: SnapshotRowsProps): React.JSX.Element {
  if (rows.length === 0) {
    return (
      <div className="border-t px-6 py-2">
        <EmptyState
          className="border-0"
          icon={<DatabaseBackupIcon />}
          title={emptyTitle}
          description={emptyDescription}
        />
      </div>
    );
  }
  return (
    <div className="divide-border divide-y border-t">
      {rows.map((snap) => (
        <div
          key={snap.id}
          className="hover:bg-accent/60 flex items-center gap-4 px-6 py-4 transition-colors"
        >
          <StatusBadge tone={SNAPSHOT_TONE[snap.status] ?? 'neutral'} label="" />
          <div className="min-w-0 flex-1">
            <p className="mono-data truncate font-medium">{snap.volume}</p>
            <p className="text-muted-foreground mono-label truncate">
              {snap.status.toLowerCase()} · {snap.targetName || 'unknown destination'} ·{' '}
              {relativeTime(snap.startedAt)}
            </p>
          </div>
          <div className="hidden w-20 text-right sm:block">
            <p className="mono-data text-sm">{fmtBytes(snap.sizeBytes)}</p>
            <p className="text-muted-foreground mono-label">size</p>
          </div>
          <RestoreSnapshotConfirm
            snapshotId={snap.id}
            volume={snap.volume}
            disabled={snap.status !== 'SUCCEEDED'}
          />
        </div>
      ))}
    </div>
  );
}
