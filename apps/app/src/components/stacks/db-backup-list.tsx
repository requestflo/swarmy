import * as React from 'react';
import { DatabaseBackupIcon } from 'lucide-react';
import { EmptyState, StatusBadge, type StatusTone } from '@swarmy/ui';
import { DbRestoreDialog } from './db-restore-dialog';
import type { DbBackupEngine, DbBackupView } from './managed-db-trpc';

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
  const mins = Math.round((Date.now() - new Date(iso).getTime()) / 60_000);
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

const ENGINE_LABEL: Record<DbBackupEngine, string> = {
  pg_dump: 'pg_dump',
  pgbackrest: 'pgBackRest',
  'replica-snapshot': 'replica snapshot',
};

/** Flat backup rows for a cluster, each with a restore affordance. */
export function DbBackupList({
  stack,
  cluster,
  backups,
}: {
  stack: string;
  cluster: string;
  backups: DbBackupView[];
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
          <StatusBadge tone={TONE[b.status] ?? 'neutral'} label="" />
          <div className="min-w-0 flex-1">
            <div className="flex flex-wrap items-center gap-2">
              <span className="font-medium">{ENGINE_LABEL[b.engine] ?? b.engine}</span>
              <span className="mono-label text-muted-foreground">{fmtBytes(b.sizeBytes)}</span>
              {b.lsn && <span className="mono-label text-muted-foreground">LSN {b.lsn}</span>}
            </div>
            <p className="text-muted-foreground mono-label truncate">
              {relativeTime(b.startedAt)}
              {b.targetName ? ` · ${b.targetName}` : ''}
              {b.error ? ` · ${b.error}` : ''}
            </p>
          </div>
          {b.status === 'SUCCEEDED' && (
            <DbRestoreDialog stack={stack} cluster={cluster} backup={b} />
          )}
        </div>
      ))}
    </div>
  );
}
