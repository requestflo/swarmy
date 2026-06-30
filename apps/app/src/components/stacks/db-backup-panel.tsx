import * as React from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { DatabaseBackupIcon, PlayIcon } from 'lucide-react';
import {
  Button,
  Card,
  CardContent,
  Label,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
  toast,
} from '@swarmy/ui';
import { useTRPC } from '@/integrations/trpc';
import { DbBackupList } from './db-backup-list';
import { DbBackupSchedule } from './db-backup-schedule';
import {
  useDbMutation,
  useDbQuery,
  type DbBackupEngine,
  type DbBackupView,
} from './managed-db-trpc';

interface RunInput {
  stack: string;
  cluster: string;
  engine: DbBackupEngine;
  targetId?: string;
}

const ENGINES: { value: DbBackupEngine; label: string; blurb: string }[] = [
  { value: 'pg_dump', label: 'pg_dump', blurb: 'Portable logical dump — restore anywhere.' },
  { value: 'pgbackrest', label: 'pgBackRest (PITR)', blurb: 'Physical base + WAL — point-in-time restore.' },
  { value: 'replica-snapshot', label: 'Snapshot from replica', blurb: 'Volume snapshot off a read replica — zero primary load.' },
];

/**
 * Per-cluster DB backup surface (mounts into the db-cluster panel). Pick a
 * backup engine + global destination, back up on demand, schedule recurring
 * backups, and restore any backup (clone / PITR / in-place / single-db) — all
 * via the `dbBackup.*` endpoints. Destinations are the org-wide restic targets
 * shared with volume backups.
 */
export function DbBackupPanel({
  stack,
  cluster,
}: {
  stack: string;
  cluster: string;
}): React.JSX.Element {
  const trpc = useTRPC();
  const qc = useQueryClient();
  const [engine, setEngine] = React.useState<DbBackupEngine>('pg_dump');
  const [targetId, setTargetId] = React.useState<string>('');

  const targets = useQuery(trpc.backups.listTargets.queryOptions());
  const targetRows = targets.data ?? [];

  const backups = useDbQuery<DbBackupView[]>(
    'dbBackup',
    'list',
    { stack, cluster },
    { refetchInterval: 5_000 },
  );
  const rows = backups.data ?? [];

  const run = useDbMutation<{ id: string }, RunInput>('dbBackup', 'run', {
    onSuccess: () => {
      toast.success(`Backing up ${cluster} (${engine})`);
      void qc.invalidateQueries();
    },
    onError: (e) => toast.error(e.message),
  });

  const meta = ENGINES.find((e) => e.value === engine);

  return (
    <Card className="card-pop border-0">
      <CardContent className="space-y-5 p-6">
        <div className="flex items-center gap-3">
          <span className="bg-primary/10 text-primary flex size-9 items-center justify-center rounded-lg">
            <DatabaseBackupIcon className="size-5" />
          </span>
          <div>
            <h3 className="font-semibold leading-tight">Database backups</h3>
            <p className="text-muted-foreground mono-label">{cluster} · engine + destination, restore any point</p>
          </div>
        </div>

        <div className="flex flex-wrap items-end gap-3">
          <div className="grid gap-1.5">
            <Label className="mono-label">Engine</Label>
            <Select value={engine} onValueChange={(v) => setEngine(v as DbBackupEngine)}>
              <SelectTrigger className="w-56">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {ENGINES.map((e) => (
                  <SelectItem key={e.value} value={e.value}>
                    {e.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div className="grid gap-1.5">
            <Label className="mono-label">Destination</Label>
            <Select value={targetId} onValueChange={setTargetId}>
              <SelectTrigger className="w-56">
                <SelectValue placeholder={targetRows.length ? 'Pick a destination' : 'No destinations yet'} />
              </SelectTrigger>
              <SelectContent>
                {targetRows.map((t) => (
                  <SelectItem key={t.id} value={t.id}>
                    {t.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <Button
            onClick={() => run.mutate({ stack, cluster, engine, targetId: targetId || undefined })}
            disabled={run.isPending}
          >
            <PlayIcon className="size-4" /> Back up now
          </Button>
        </div>
        {meta && <p className="text-muted-foreground -mt-2 text-sm">{meta.blurb}</p>}

        <DbBackupSchedule stack={stack} cluster={cluster} engine={engine} />

        <div className="border-border border-t pt-4">
          <p className="mono-label text-muted-foreground mb-1">Recent backups</p>
          <DbBackupList stack={stack} cluster={cluster} backups={rows} />
        </div>
      </CardContent>
    </Card>
  );
}
