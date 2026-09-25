import * as React from 'react';
import { DatabaseBackupIcon } from 'lucide-react';
import { EmptyState } from '@swarmy/ui';
import { CalmRow, RowList, type Tone } from '@/components/calm';
import { fmtBytes, relativeTime } from './backup-format';
import { RestoreSnapshotConfirm } from './restore-snapshot-confirm';
import { SnapshotFailureReason } from './snapshot-failure-reason';

export interface SnapshotItem {
  id: string;
  volume: string;
  status: string;
  targetName: string;
  sizeBytes: string | null;
  startedAt: string;
  /** Captured agent/restic error when `status === 'FAILED'` (already on the wire). */
  error?: string | null;
}

interface SnapshotRowsProps {
  rows: SnapshotItem[];
  emptyTitle: string;
  emptyDescription: string;
}

const STATUS: Record<string, { tone: Tone; word: string }> = {
  SUCCEEDED: { tone: 'ok', word: 'Saved' },
  RUNNING: { tone: 'info', word: 'Saving' },
  FAILED: { tone: 'bad', word: 'Failed' },
  PRUNED: { tone: 'idle', word: 'Expired' },
};

function when(iso: string): string {
  return new Date(iso).toLocaleString([], { weekday: 'short', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });
}

/** Restore points as flat rows: when, how big, where it's kept, and Restore. */
export function SnapshotRows({ rows, emptyTitle, emptyDescription }: SnapshotRowsProps): React.JSX.Element {
  if (rows.length === 0) {
    return <EmptyState className="border-0" icon={<DatabaseBackupIcon />} title={emptyTitle} description={emptyDescription} />;
  }
  return (
    <RowList label="Restore points">
      {rows.map((snap) => {
        const s = STATUS[snap.status] ?? { tone: 'idle' as Tone, word: snap.status.toLowerCase() };
        return (
          <CalmRow
            key={snap.id}
            tone={s.tone}
            name={snap.volume}
            sub={when(snap.startedAt)}
            say={
              snap.status === 'FAILED' ? (
                <SnapshotFailureReason error={snap.error} />
              ) : (
                `${fmtBytes(snap.sizeBytes)} · in ${snap.targetName || 'an unknown destination'} · ${relativeTime(snap.startedAt)}`
              )
            }
            tech={`snapshot ${snap.id.slice(0, 8)}`}
            word={s.word}
            trailing={<RestoreSnapshotConfirm snapshotId={snap.id} volume={snap.volume} disabled={snap.status !== 'SUCCEEDED'} />}
          />
        );
      })}
    </RowList>
  );
}
