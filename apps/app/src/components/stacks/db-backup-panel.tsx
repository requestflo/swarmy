import * as React from 'react';
import { useQuery } from '@tanstack/react-query';
import { DatabaseBackupIcon } from 'lucide-react';
import { Button, Card, CardContent } from '@swarmy/ui';
import type { DbBackupEngine } from '@swarmy/core/protocol';
import { useTRPC } from '@/integrations/trpc';
import { DbBackupList } from './db-backup-list';
import { DbBackupRunForm } from './db-backup-run-form';
import { DbBackupSchedule } from './db-backup-schedule';

/**
 * Per-cluster DB backup surface (mounts into the db-cluster panel). Pick a
 * backup engine + destination, back up on demand, schedule recurring backups
 * (a cron label on the cluster primary), and restore any backup (clone /
 * single-database / PITR / in-place) — all via the typed `dbBackups.*` router.
 * Destinations are the org-wide restic targets shared with volume backups.
 */
export function DbBackupPanel({
  stack,
  cluster,
}: {
  stack: string;
  cluster: string;
}): React.JSX.Element {
  const trpc = useTRPC();
  const [engine, setEngine] = React.useState<DbBackupEngine>('pg_dump');
  const [targetId, setTargetId] = React.useState('');
  const [dataVolume, setDataVolume] = React.useState('');

  const targets = useQuery(trpc.backups.listTargets.queryOptions());
  const targetRows = targets.data ?? [];
  const firstTargetId = targetRows[0]?.id ?? '';
  React.useEffect(() => {
    // Default the destination to the org's first target once loaded.
    setTargetId((cur) => cur || firstTargetId);
  }, [firstTargetId]);

  const backups = useQuery({
    ...trpc.dbBackups.list.queryOptions({ stack, cluster, targetId: targetId || undefined }),
    enabled: targetRows.length > 0,
    refetchInterval: 30_000,
  });

  return (
    <Card className="card-pop border-0">
      <CardContent className="space-y-5 p-6">
        <div className="flex items-center gap-3">
          <span className="bg-primary/10 text-primary flex size-9 items-center justify-center rounded-lg">
            <DatabaseBackupIcon className="size-5" />
          </span>
          <div>
            <h3 className="font-semibold leading-tight">Database backups</h3>
            <p className="text-muted-foreground mono-label">
              {cluster} · engine + destination, restore any point
            </p>
          </div>
        </div>

        <DbBackupRunForm
          stack={stack}
          cluster={cluster}
          engine={engine}
          onEngine={setEngine}
          targetId={targetId}
          onTargetId={setTargetId}
          dataVolume={dataVolume}
          onDataVolume={setDataVolume}
          targets={targetRows.map((t) => ({ id: t.id, name: t.name }))}
        />

        <DbBackupSchedule
          stack={stack}
          cluster={cluster}
          engine={engine}
          targetId={targetId}
          dataVolume={dataVolume}
        />

        <div className="border-border border-t pt-4">
          <p className="mono-label text-muted-foreground mb-1">Recent backups</p>
          {targetRows.length === 0 ? (
            <p className="text-muted-foreground py-2 text-sm">
              Add a backup destination on the Backups page first — every backup lands there,
              encrypted.
            </p>
          ) : backups.isPending ? (
            <div className="space-y-2 py-2">
              <div className="shimmer-line h-4 w-2/3" />
              <div className="shimmer-line h-4 w-1/2" />
            </div>
          ) : backups.isError ? (
            <div className="flex items-center gap-3 py-2">
              <p className="text-status-offline text-sm">{backups.error.message}</p>
              <Button variant="outline" size="sm" className="rounded-full" onClick={() => void backups.refetch()}>
                Retry
              </Button>
            </div>
          ) : (
            <DbBackupList
              stack={stack}
              cluster={cluster}
              targetId={targetId || undefined}
              backups={backups.data}
            />
          )}
        </div>
      </CardContent>
    </Card>
  );
}
