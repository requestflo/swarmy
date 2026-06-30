import * as React from 'react';
import { DatabaseIcon, HardDriveIcon } from 'lucide-react';
import { Badge, Card, CardContent, EmptyState, StatusBadge, type StatusTone } from '@swarmy/ui';
import {
  useDbQuery,
  type DbBackupEngine,
  type DbBackupOverviewRow,
} from '@/components/stacks/managed-db-trpc';

const TONE: Record<string, StatusTone> = {
  SUCCEEDED: 'online',
  RUNNING: 'progress',
  FAILED: 'offline',
};

const ENGINE_LABEL: Record<DbBackupEngine, string> = {
  pg_dump: 'pg_dump',
  pgbackrest: 'pgBackRest',
  'replica-snapshot': 'replica snapshot',
};

function relativeTime(iso: string | null): string {
  if (!iso) return 'never';
  const mins = Math.round((Date.now() - new Date(iso).getTime()) / 60_000);
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.round(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  return `${Math.round(hours / 24)}d ago`;
}

/**
 * Global database-backup coverage on the Backups page: which managed clusters
 * are backing up, with what engine, when last, and into which shared
 * destination. Per-cluster controls (engine, schedule, restore) live on the
 * canvas; this is the org-wide read. Additive — sits beside the volume Targets
 * and Snapshots cards.
 */
export function DbBackupsCard(): React.JSX.Element {
  const overview = useDbQuery<DbBackupOverviewRow[]>('dbBackup', 'overview', undefined, {
    refetchInterval: 8_000,
  });
  const rows = overview.data ?? [];

  return (
    <Card className="card-pop border-0">
      <CardContent className="p-0">
        <div className="flex flex-wrap items-center justify-between gap-3 px-6 py-4">
          <span className="mono-label">Database backups</span>
          <span className="text-muted-foreground mono-label">into your shared destinations</span>
        </div>
        {rows.length === 0 ? (
          <div className="border-t px-6 py-2">
            <EmptyState
              className="border-0"
              icon={<DatabaseIcon />}
              title="No database backups yet."
              description="Open a managed cluster on the canvas, pick an engine and a destination, and turn on backups — pg_dump, pgBackRest PITR, or a replica snapshot."
            />
          </div>
        ) : (
          <div className="divide-border divide-y border-t">
            {rows.map((r) => (
              <div
                key={`${r.stack}/${r.cluster}`}
                className="hover:bg-accent/60 flex items-center gap-4 px-6 py-4 transition-colors"
              >
                <StatusBadge tone={TONE[r.lastStatus ?? ''] ?? 'neutral'} label="" />
                <div className="min-w-0 flex-1">
                  <div className="flex flex-wrap items-center gap-2">
                    <p className="truncate font-medium">
                      {r.stack}/{r.cluster}
                    </p>
                    <Badge variant="muted" className="mono-label">
                      {ENGINE_LABEL[r.engine] ?? r.engine}
                    </Badge>
                  </div>
                  <p className="text-muted-foreground mono-label truncate">
                    {r.count} backup{r.count === 1 ? '' : 's'} · last {relativeTime(r.lastBackupAt)}
                  </p>
                </div>
                <div className="text-muted-foreground hidden items-center gap-1.5 sm:flex">
                  <HardDriveIcon className="size-3.5" />
                  <span className="mono-label truncate">{r.targetName ?? 'unset'}</span>
                </div>
              </div>
            ))}
          </div>
        )}
      </CardContent>
    </Card>
  );
}
