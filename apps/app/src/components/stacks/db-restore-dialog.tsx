import * as React from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { RotateCcwIcon } from 'lucide-react';
import {
  AlertDialog,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
  Button,
  Label,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
  toast,
} from '@swarmy/ui';
import type { DbBackupSnapshotView } from '@swarmy/core';
import type { DbRestoreMode } from '@swarmy/core/protocol';
import { useTRPC } from '@/integrations/trpc';
import { DbRestoreFields } from './db-restore-fields';
import { DB_RESTORE_MODES, engineLabel, isPhysical } from './db-backup-format';

/**
 * Restore a single DB backup — a destructive confirm with a mode-specific
 * form, so it uses the one sanctioned modal (AlertDialog) around
 * `DbRestoreFields`.
 */
export function DbRestoreDialog({
  stack,
  cluster,
  targetId,
  backup,
}: {
  stack: string;
  cluster: string;
  /** Destination the backup was listed from; defaults server-side when omitted. */
  targetId?: string;
  backup: DbBackupSnapshotView;
}): React.JSX.Element {
  const trpc = useTRPC();
  const qc = useQueryClient();
  const [open, setOpen] = React.useState(false);
  const [mode, setMode] = React.useState<DbRestoreMode>('clone-to-new-cluster');
  const [targetCluster, setTargetCluster] = React.useState(`${cluster}-restore`);
  const [pitrTarget, setPitrTarget] = React.useState('');
  const [database, setDatabase] = React.useState('app');
  const [dataVolume, setDataVolume] = React.useState('');

  const engine = backup.engine ?? 'pg_dump';

  const restore = useMutation(
    trpc.dbBackups.restore.mutationOptions({
      onSuccess: () => {
        toast.success(`Restore started from ${engineLabel(engine)} backup`);
        setOpen(false);
        void qc.invalidateQueries();
      },
      onError: (e) => toast.error(e.message),
    }),
  );

  const meta = DB_RESTORE_MODES.find((m) => m.value === mode);
  const pitrBlocked = mode === 'pitr' && (!isPhysical(engine) || !dataVolume.trim());
  const submit = (): void =>
    restore.mutate({
      stack,
      cluster,
      engine,
      mode,
      targetId,
      snapshotId: backup.id,
      targetCluster: mode === 'clone-to-new-cluster' ? targetCluster.trim() || undefined : undefined,
      targetTime: mode === 'pitr' ? pitrTarget.trim() || undefined : undefined,
      database: mode === 'single-database' ? database.trim() || undefined : undefined,
      dataVolume: mode === 'pitr' ? dataVolume.trim() || undefined : undefined,
    });

  return (
    <AlertDialog open={open} onOpenChange={setOpen}>
      <AlertDialogTrigger asChild>
        <Button variant="outline" size="sm" className="rounded-full">
          <RotateCcwIcon className="size-4" /> Restore
        </Button>
      </AlertDialogTrigger>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>Restore backup</AlertDialogTitle>
          <AlertDialogDescription>
            {engineLabel(backup.engine)} · {new Date(backup.time).toLocaleString()}
          </AlertDialogDescription>
        </AlertDialogHeader>

        <div className="space-y-4">
          <div className="grid gap-1.5">
            <Label className="mono-label">Mode</Label>
            <Select value={mode} onValueChange={(v) => setMode(v as DbRestoreMode)}>
              <SelectTrigger>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {DB_RESTORE_MODES.map((m) => (
                  <SelectItem key={m.value} value={m.value}>
                    {m.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            {meta && <p className="text-muted-foreground text-sm">{meta.blurb}</p>}
            {mode === 'pitr' && !isPhysical(engine) && (
              <p className="text-status-warning text-sm">
                Point-in-time needs a wal-g / pgBackRest backup — this one is {engineLabel(engine)}.
              </p>
            )}
          </div>

          <DbRestoreFields
            mode={mode}
            cluster={cluster}
            targetCluster={targetCluster}
            onTargetCluster={setTargetCluster}
            pitrTarget={pitrTarget}
            onPitrTarget={setPitrTarget}
            database={database}
            onDatabase={setDatabase}
            dataVolume={dataVolume}
            onDataVolume={setDataVolume}
          />
        </div>

        <AlertDialogFooter>
          <AlertDialogCancel>Cancel</AlertDialogCancel>
          <Button
            variant={mode === 'in-place' ? 'destructive' : 'default'}
            onClick={submit}
            disabled={restore.isPending || pitrBlocked}
          >
            <RotateCcwIcon className="size-4" />
            {restore.isPending ? 'Restoring…' : 'Start restore'}
          </Button>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
