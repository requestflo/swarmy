import * as React from 'react';
import { useQuery } from '@tanstack/react-query';
import { StatusBadge } from '@swarmy/ui';
import { useTRPC } from '@/integrations/trpc';
import { SnapshotFailureReason } from '@/components/backups/snapshot-failure-reason';
import { relativeTime } from './db-backup-format';

interface DbBackupLastRunProps {
  stack: string;
  cluster: string;
}

/**
 * The cluster's most recent backup run (the `swarmy.db.backup.lastRun` label,
 * via the org-wide overview so ad-hoc runs count too): a status badge + when,
 * and — when it failed — the captured error, so a bad password or unreachable
 * primary is readable right here instead of only in the agent log. Renders
 * nothing until a run has happened.
 */
export function DbBackupLastRun({
  stack,
  cluster,
}: DbBackupLastRunProps): React.JSX.Element | null {
  const trpc = useTRPC();
  const overview = useQuery({
    ...trpc.dbBackups.overview.queryOptions(),
    refetchInterval: 15_000,
  });
  const run = (overview.data ?? []).find((r) => r.stack === stack && r.cluster === cluster);
  if (!run?.lastBackupAt || !run.lastStatus) return null;
  const failed = run.lastStatus === 'failed';
  return (
    <div className="border-border border-t pt-4">
      <p className="mono-label text-muted-foreground mb-1">Last run</p>
      <div className="flex flex-wrap items-center gap-2">
        <StatusBadge tone={failed ? 'offline' : 'online'} label={run.lastStatus} />
        <span className="text-muted-foreground mono-label">{relativeTime(run.lastBackupAt)}</span>
      </div>
      {failed ? <SnapshotFailureReason error={run.lastError} /> : null}
    </div>
  );
}
