import * as React from 'react';
import { DatabaseBackupIcon } from 'lucide-react';
import { EmptyState } from '@swarmy/ui';
import type { DbBackupSnapshotView } from '@swarmy/core';
import { DbRestoreDialog } from './db-restore-dialog';
import { engineLabel, fmtBytes, relativeTime } from './db-backup-format';

/** Flat backup rows for a cluster, each with a restore affordance. */
export function DbBackupList({
  stack,
  cluster,
  targetId,
  backups,
}: {
  stack: string;
  cluster: string;
  targetId?: string;
  backups: DbBackupSnapshotView[];
}): React.JSX.Element {
  if (backups.length === 0) {
    return (
      <EmptyState
        className="border-0"
        icon={<DatabaseBackupIcon />}
        title="No database backups yet."
        description="Pick an engine and hit Back up now — every backup lands in your chosen destination, encrypted."
      />
    );
  }

  return (
    <div className="divide-border divide-y">
      {backups.map((b) => (
        <div
          key={b.id}
          className="hover:bg-accent/60 flex items-center gap-4 py-3 transition-colors"
        >
          <div className="min-w-0 flex-1">
            <div className="flex flex-wrap items-center gap-2">
              <span className="font-medium">{engineLabel(b.engine)}</span>
              <span className="mono-label text-muted-foreground">{fmtBytes(b.sizeBytes)}</span>
              <span className="mono-label text-muted-foreground">{b.id.slice(0, 8)}</span>
            </div>
            <p className="text-muted-foreground mono-label truncate">
              {relativeTime(b.time)} · {new Date(b.time).toLocaleString()}
            </p>
          </div>
          <DbRestoreDialog stack={stack} cluster={cluster} targetId={targetId} backup={b} />
        </div>
      ))}
    </div>
  );
}
