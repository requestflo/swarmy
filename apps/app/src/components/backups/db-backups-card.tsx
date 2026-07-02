import * as React from 'react';
import { useQuery } from '@tanstack/react-query';
import { DatabaseIcon, HardDriveIcon } from 'lucide-react';
import { Badge, Card, CardContent, EmptyState, StatusBadge, type StatusTone } from '@swarmy/ui';
import type { DbBackupOverviewRow, DbBackupRunStatus } from '@swarmy/core';
import { useTRPC } from '@/integrations/trpc';
import { engineLabel, relativeTime } from '@/components/stacks/db-backup-format';

const TONE: Record<DbBackupRunStatus, StatusTone> = {
  succeeded: 'online',
  failed: 'offline',
};

function scheduleLine(r: DbBackupOverviewRow): string {
  if (!r.scheduled) return 'no schedule';
  const next = r.nextRunAt ? ` · next ${relativeTimeAhead(r.nextRunAt)}` : '';
  return `${r.cron} UTC${next}`;
}

function relativeTimeAhead(iso: string): string {
  const mins = Math.round((new Date(iso).getTime() - Date.now()) / 60_000);
  if (mins <= 1) return 'in <1m';
  if (mins < 60) return `in ${mins}m`;
  const hours = Math.round(mins / 60);
  if (hours < 24) return `in ${hours}h`;
  return `in ${Math.round(hours / 24)}d`;
}

/**
 * Global database-backup coverage on the Backups page: which managed clusters
 * are backing up, on what cadence, when last, and into which shared destination
 * — plus each PITR cluster's restorable window. Per-cluster controls (engine,
 * schedule, restore) live on the canvas; this is the org-wide read.
 */
export function DbBackupsCard(): React.JSX.Element {
  const trpc = useTRPC();
  const overview = useQuery({
    ...trpc.dbBackups.overview.queryOptions(),
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
        {overview.isPending ? (
          <div className="space-y-2 border-t px-6 py-5">
            <div className="shimmer-line h-4 w-2/3" />
            <div className="shimmer-line h-4 w-1/2" />
          </div>
        ) : overview.isError ? (
          <p className="text-status-offline border-t px-6 py-5 text-sm">{overview.error.message}</p>
        ) : rows.length === 0 ? (
          <div className="border-t px-6 py-2">
            <EmptyState
              className="border-0"
              icon={<DatabaseIcon />}
              title="No managed databases yet."
              description="Provision a managed Postgres cluster on a stack, then pick an engine and a cadence — pg_dump, wal-g / pgBackRest PITR, or a replica snapshot."
            />
          </div>
        ) : (
          <div className="divide-border divide-y border-t">
            {rows.map((r) => (
              <div
                key={`${r.stack}/${r.cluster}`}
                className="hover:bg-accent/60 flex items-center gap-4 px-6 py-4 transition-colors"
              >
                <StatusBadge tone={r.lastStatus ? TONE[r.lastStatus] : 'neutral'} label="" />
                <div className="min-w-0 flex-1">
                  <div className="flex flex-wrap items-center gap-2">
                    <p className="truncate font-medium">
                      {r.stack}/{r.cluster}
                    </p>
                    {r.engine && (
                      <Badge variant="muted" className="mono-label">
                        {engineLabel(r.engine)}
                      </Badge>
                    )}
                    {r.pitr && (
                      <Badge variant="muted" className="mono-label">
                        PITR
                      </Badge>
                    )}
                  </div>
                  <p className="text-muted-foreground mono-label truncate">
                    {scheduleLine(r)} · last {relativeTime(r.lastBackupAt)}
                    {r.pitrWindow
                      ? ` · restore window ${relativeTime(r.pitrWindow.from)} → ${relativeTime(r.pitrWindow.to)}`
                      : ''}
                  </p>
                </div>
                <div className="text-muted-foreground hidden items-center gap-1.5 sm:flex">
                  <HardDriveIcon className="size-3.5" />
                  <span className="mono-label truncate">{r.targetName ?? 'default'}</span>
                </div>
              </div>
            ))}
          </div>
        )}
      </CardContent>
    </Card>
  );
}
